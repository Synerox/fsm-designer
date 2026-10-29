// Where the MCP tools read and write diagrams. Tool handlers only talk to this
// interface; bridge.ts wraps it so the web editor sees every save live.

import { access, chmod, chown, constants, link, lstat, mkdir, readdir, readFile, realpath, rm, writeFile, rename, open, stat, unlink, utimes } from "node:fs/promises";
import { readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseDiagram } from "@fsm/core";
import type { FsmDiagram } from "@fsm/core";

export interface DiagramStore {
  /** Human-readable description of where diagrams live, shown to agents. */
  readonly location: string;
  list(): Promise<string[]>;
  exists(name: string): Promise<boolean>;
  load(name: string): Promise<FsmDiagram>;
  save(d: FsmDiagram): Promise<void>;
  remove(name: string): Promise<void>;
  /**
   * Run `fn` while no other load-modify-save of the same diagram can interleave
   * with it (other tool calls in this process, and other processes on the same
   * workspace). Every tool that changes a diagram wraps its work in this.
   */
  lock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** lock() for several diagrams at once, taken in one fixed order (names that are one file are locked once). */
  lockAll?<T>(names: string[], fn: () => Promise<T>): Promise<T>;
  /** The file a diagram is saved in, when it lives on disk . */
  fileOf?(name: string): string;
  /** Resolve a user-supplied export path (relative paths go into the workspace). */
  resolvePath(p: string): string;
  /** Entries that look like diagrams but cannot be used, each with the reason (shown by list_fsms). */
  ignored?(): Promise<string[]>;
  /** Whether anything (even a broken link) sits where the diagram would be, so delete_fsm can clear it. */
  hasEntry?(name: string): Promise<boolean>;
  /** Whether the diagram's file name is a symbolic link. */
  isLink?(name: string): Promise<boolean>;
}

const FILE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_NAME = 64;
/** Windows device names: CON.fsm.json opens the console, not a file. */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Check an FSM name before it becomes part of a file name. */
export function checkName(name: string): string {
  if (!FILE_RE.test(name)) throw new Error(`Invalid FSM name "${name}" (use letters, digits and _, starting with a letter or _)`);
  if (name.length > MAX_NAME) throw new Error(`FSM name is ${name.length} characters long; use at most ${MAX_NAME}`);
  if (DEVICE.test(name)) throw new Error(`"${name}" is a reserved device name on Windows and cannot be a file name; pick another FSM name`);
  return name;
}

/** Serialise async work per key within this process. */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive for the next caller, but never reject it.
    const settled = next.then(() => undefined, () => undefined);
    this.tails.set(key, settled);
    settled.then(() => { if (this.tails.get(key) === settled) this.tails.delete(key); });
    return next;
  }
}

/** How long a tool call waits for another live process before giving up. */
const LOCK_WAIT_MS = 30_000;
/** A lock from another computer (shared folder) whose owner cannot be checked is abandoned after this long. */
const FOREIGN_STALE_MS = 10 * 60_000;
/** A lock file that is still empty or unreadable this long after it was created is abandoned. */
const BROKEN_STALE_MS = 30_000;
/** A wait ticket not renewed for this long is ignored (its waiter stalled or is gone). */
const TICKET_LEASE_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOST = hostname();
/**
 * Processes in another PID namespace (containers sharing a hostname) cannot be
 * checked with kill(pid, 0); their locks are treated like another computer's.
 */
const PID_NS = (() => {
  try {
    return process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : "";
  } catch {
    return "";
  }
})();

interface LockInfo { pid: number; host: string; ns?: string; token: string; time: number }
type Seen = { info?: LockInfo; mtime: number };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/** Read a lock or guard file (only its first few KB: a lock is a short JSON line). */
async function readLock(path: string): Promise<Seen | undefined> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const s = await fh.stat();
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    let info: LockInfo | undefined;
    try {
      const j = JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
      if (j && typeof j.pid === "number" && typeof j.token === "string" && typeof j.host === "string") info = j;
    } catch { /* still being written, or not ours */ }
    return { info, mtime: s.mtimeMs };
  } finally {
    await fh.close();
  }
}

/** Why a lock (or break guard) may be taken over, or undefined while its owner may still be working. */
function staleReason(l: Seen): string | undefined {
  // abs: a clock that was set back must not keep a broken file alive for hours.
  const age = Math.abs(Date.now() - l.mtime);
  if (!l.info) return age > BROKEN_STALE_MS ? "unreadable lock file" : undefined;
  // ns is missing only in locks from older versions of this server.
  if (l.info.host === HOST && (l.info.ns === undefined || l.info.ns === PID_NS)) {
    // Our own pid on a lock we do not hold: left by an earlier process that had the same pid.
    if (l.info.pid === process.pid) return ours.has(l.info.token) ? undefined : "left by an earlier process with this process id";
    return alive(l.info.pid) ? undefined : `process ${l.info.pid} has exited`;
  }
  return age > FOREIGN_STALE_MS ? `lock from ${l.info.host} is ${Math.round(age / 60000)} minutes old` : undefined;
}

/** Lock and guard files this process holds (path -> token), removed if the process exits while holding them. */
const held = new Map<string, string>();
/** Tokens of this process's lock and guard files, including ones being created. */
const ours = new Set<string>();
/** Temp files of saves in progress, removed if the process exits mid-save. */
const temps = new Set<string>();
process.on("exit", () => {
  for (const [path, token] of held) {
    try {
      // Empty: we were stopped between creating it and writing our identity.
      const text = readFileSync(path, "utf8");
      if (text === "" || text.includes(token)) unlinkSync(path);
    } catch { /* already gone */ }
  }
  for (const t of temps) {
    try { unlinkSync(t); } catch { /* already gone */ }
  }
});

const permission = (e: unknown) => ["EACCES", "EPERM", "EROFS"].includes((e as NodeJS.ErrnoException).code ?? "");

/** Create `path` with O_EXCL holding our identity; false if it already exists. */
async function claim(path: string, token: string): Promise<boolean> {
  ours.add(token);
  const body = JSON.stringify({ pid: process.pid, host: HOST, ns: PID_NS, token, time: Date.now() }) + "\n";
  const fail = (e: unknown): never => {
    ours.delete(token);
    if (permission(e)) throw new Error(`Cannot create ${path}: the folder ${dirname(path)} is not writable (${(e as NodeJS.ErrnoException).code})`);
    throw e;
  };
  // Write our identity to a file of our own, then hard-link it into place: the
  // link either fails (taken) or appears complete, so a process killed half-way
  // never leaves an empty lock behind for others to wait out.
  const dir = dirname(path);
  const prefix = `${basename(path)}.new-${TMP_HOST}-`;
  await clearTemps(dir, prefix);
  const tmp = join(dir, `${prefix}${process.pid}-${RUN}-${++tmpCounter}`);
  temps.add(tmp);
  try {
    await writeFile(tmp, body, { flag: "wx" });
    try {
      await link(tmp, path);
      held.set(path, token);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      // ENOENT: our temp file was removed under us (another tool cleaning up); try again.
      if (code === "EEXIST" || code === "ENOENT") {
        ours.delete(token);
        return false;
      }
      // Any other failure: this file system has no hard links (FAT and exFAT report
      // EISDIR on Windows, some shares EINVAL or EPERM); use O_EXCL create below.
    }
  } catch (e) {
    fail(e);
  } finally {
    await unlink(tmp).catch(() => {});
    temps.delete(tmp);
  }
  let fh;
  try {
    fh = await open(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      ours.delete(token);
      return false;
    }
    fail(e);
  }
  held.set(path, token);
  try {
    await fh!.writeFile(body);
  } finally {
    await fh!.close();
  }
  return true;
}

/** Remove `path` if it still holds `token`. */
async function release(path: string, token: string): Promise<void> {
  held.delete(path);
  const cur = await readLock(path).catch(() => undefined);
  if (cur?.info?.token === token) await unlink(path).catch(() => {});
  ours.delete(token);
}

const sameLock = (a: Seen, b: Seen) => (a.info ? b.info?.token === a.info.token : !b.info && b.mtime === a.mtime);

/**
 * Remove a stale lock, but only the very lock that was judged stale. Waiters
 * first claim `<lock>.break` (O_EXCL, holding their pid like a lock), so two of
 * them never both remove a lock and one never removes a fresh lock another has
 * just taken. A guard is only taken over when its owner is gone, never by age
 * alone, so a breaker that stalls (a long layout, a debugger) keeps it.
 */
async function breakStale(lockPath: string, seen: Seen, why: string): Promise<void> {
  const guard = `${lockPath}.break`;
  const token = randomUUID();
  if (!(await claim(guard, token))) {
    const g = await readLock(guard);
    if (g && staleReason(g)) {
      const again = await readLock(guard);
      if (again && sameLock(g, again)) await unlink(guard).catch(() => {});
    }
    return;
  }
  try {
    const now = await readLock(lockPath);
    if (!now || !sameLock(seen, now) || !staleReason(now)) return;
    // Still ours? Only a dead or very old guard is ever taken over, but check anyway.
    if ((await readLock(guard))?.info?.token !== token) return;
    try {
      await unlink(lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`A stale lock (${why}) could not be removed: ${lockPath} (${(e as NodeJS.ErrnoException).code}). Delete it by hand.`);
    }
  } finally {
    await release(guard, token);
  }
}

/**
 * Cross-process advisory lock: `<file>.lock` is created with O_EXCL, so two MCP
 * servers (say Claude Desktop and Claude Code) sharing one workspace do not
 * overwrite each other's edits. A lock is only taken over when its owner is
 * gone (same computer: the process has exited), never because a long layout
 * is still running; and it is only removed by the process that holds it.
 * Gives up at `deadline` (ms since the epoch).
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, deadline: number): Promise<T> {
  const token = randomUUID();
  // Fairness: a waiter holds `<lock>.wait`, and nobody else takes the lock while
  // it is there, so a server whose calls follow each other back to back cannot
  // keep the lock from another server's waiting call.
  const waitPath = `${lockPath}.wait`;
  // Its own token: the lock's token must stay ours while the lock is held.
  const ticket = randomUUID();
  let waiting = false;
  let last: LockInfo | undefined;
  try {
    for (let attempt = 0; ; attempt++) {
      if (!(await queuedBehind(waitPath, ticket)) && (await claim(lockPath, token))) break;
      if (waiting) waiting = await renewTicket(waitPath, ticket);
      else waiting = await claim(waitPath, ticket);
      const cur = await readLock(lockPath);
      if (cur) {
        last = cur.info ?? last;
        const why = staleReason(cur);
        if (why) await breakStale(lockPath, cur, why);
      }
      if (Date.now() > deadline) {
        const first = cur ? undefined : (await readLock(waitPath))?.info;
        if (first && first.token !== ticket)
          throw new Error(`The diagram ${lockPath.replace(/\.lock$/, "")} is free, but a call of process ${first.pid} on ${first.host} has been waiting for it first and has not taken it; waited ${Math.round(LOCK_WAIT_MS / 1000)} s. Try again.`);
        const who = last ? `process ${last.pid} on ${last.host}` : "another process";
        throw new Error(`The diagram is locked by ${who} (${lockPath}); waited ${Math.round((Date.now() - deadline + LOCK_WAIT_MS) / 1000)} s. ` +
          "Another FSM server may be busy with a long auto_layout or many edits of this diagram; try again later, or delete the lock file if that server is gone.");
      }
      // The ticket holder is the only one allowed to take a free lock, so it looks often.
      await sleep(waiting ? 15 : Math.min(200, 20 + attempt * 10) * (0.5 + Math.random()));
    }
  } finally {
    if (waiting) await release(waitPath, ticket);
  }
  try {
    return await fn();
  } finally {
    await release(lockPath, token);
  }
}

/** Renew our wait ticket; false when it is no longer ours (it lapsed and was cleared). */
async function renewTicket(waitPath: string, token: string): Promise<boolean> {
  const w = await readLock(waitPath);
  if (w?.info?.token !== token) {
    held.delete(waitPath);
    ours.delete(token);
    return false;
  }
  const now = new Date();
  await utimes(waitPath, now, now).catch(() => {});
  return true;
}

/** Whether another live waiter holds the wait ticket, so this call must let it go first. A dead or overdue ticket is cleared. */
async function queuedBehind(waitPath: string, token: string): Promise<boolean> {
  const w = await readLock(waitPath);
  if (!w || w.info?.token === token) return false;
  // The ticket is a lease its waiter renews on every try (at least every ~0.3 s);
  // one not renewed for TICKET_LEASE_MS belongs to a waiter that stalled or is gone.
  if (staleReason(w) || Math.abs(Date.now() - w.mtime) > TICKET_LEASE_MS) {
    const again = await readLock(waitPath);
    if (again && sameLock(w, again)) await unlink(waitPath).catch(() => {});
    return false;
  }
  return true;
}

/** Windows: a virus scanner or sync client briefly holding the target makes rename fail; try again. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || i >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw e;
      await sleep(20 + i * 20);
    }
  }
}

let tmpCounter = 0;
/** Tells this process's temp files from those of an earlier process that had the same pid. */
const RUN = randomUUID().slice(0, 8);
/** Whether file names are usually case-insensitive here. */
const CASE_FOLDS = process.platform === "win32" || process.platform === "darwin";
/** Host name as it appears in temp file names, so only this computer's leftovers are cleared. */
const TMP_HOST = `${HOST.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}${PID_NS.replace(/\D/g, "") ? `_${PID_NS.replace(/\D/g, "")}` : ""}`;

/** Remove temp files named `<prefix><pid>-<n>` left by processes on this computer that have exited (killed mid-write). */
async function clearTemps(dir: string, prefix: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const [pidText, run] = n.slice(prefix.length).split("-");
    const pid = Number(pidText);
    if (!Number.isInteger(pid)) continue;
    // Our own pid but not this run: left by an earlier process that had the same pid.
    const gone = pid === process.pid ? run !== RUN && !temps.has(join(dir, n)) : !alive(pid);
    if (gone) await unlink(join(dir, n)).catch(() => {});
  }
}
const EXT = ".fsm.json";

/** Headless mode: each diagram is <dir>/<name>.fsm.json. */
export class FileStore implements DiagramStore {
  readonly dir: string;
  private queue = new KeyedQueue();
  constructor(dir: string) {
    this.dir = resolve(dir);
  }
  get location() {
    return this.dir;
  }
  /** Create the folder if needed and make sure it is a writable folder; throws a readable error otherwise. */
  async prepare() {
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (e) {
      throw new Error(`Cannot use ${this.dir} as the workspace: ${(e as NodeJS.ErrnoException).code === "EEXIST" || (e as NodeJS.ErrnoException).code === "ENOTDIR" ? "it is a file, not a folder" : (e as Error).message}`);
    }
    if (!(await stat(this.dir)).isDirectory()) throw new Error(`Cannot use ${this.dir} as the workspace: it is a file, not a folder`);
    try {
      await access(this.dir, constants.W_OK);
    } catch {
      throw new Error(`Cannot use ${this.dir} as the workspace: the folder is not writable`);
    }
  }
  private file(name: string) {
    return join(this.dir, `${checkName(name)}${EXT}`);
  }
  fileOf(name: string) {
    return this.file(name);
  }
  private async entries() {
    try {
      return (await readdir(this.dir, { withFileTypes: true })).filter((e) => e.name.toLowerCase().endsWith(EXT));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Cannot read the workspace folder ${this.dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  private static usable(stem: string) {
    try { checkName(stem); return true; } catch { return false; }
  }
  /** Split the entries into diagrams and the rest (with the reason); a symlink counts when it leads to a file. */
  private async sorted() {
    const good: string[] = [];
    const bad: string[] = [];
    for (const e of await this.entries()) {
      let why = "";
      // Seq.FSM.JSON is the file Seq.fsm.json where case is ignored (Windows, macOS); elsewhere it is another file.
      if (!e.name.endsWith(EXT) && !CASE_FOLDS) why = `the extension must be written ${EXT}`;
      else if (!FileStore.usable(e.name.slice(0, -EXT.length))) why = "not a valid FSM name";
      else if (!e.isFile()) {
        const s = await stat(join(this.dir, e.name)).catch((err: NodeJS.ErrnoException) => err.code ?? "error");
        if (typeof s === "string") why = s === "ENOENT" ? "link to a missing file" : s === "ELOOP" ? "link loop" : `unreadable (${s})`;
        else if (s.isDirectory()) why = e.isSymbolicLink() ? "link to a folder" : "a folder";
        else if (!s.isFile()) why = "not a regular file";
      }
      if (why) bad.push(`${e.name} (${why})`);
      else good.push(e.name.slice(0, -EXT.length));
    }
    return { good: good.sort(), bad: bad.sort() };
  }
  async list() {
    return (await this.sorted()).good;
  }
  /** .fsm.json entries that cannot be used as diagrams (folders, broken links, names that are not FSM names), for list_fsms. */
  async ignored() {
    return (await this.sorted()).bad;
  }
  async exists(name: string) {
    // Also anything the OS opens under this name (a case variant where case is ignored).
    return (await this.list()).includes(name) || (await stat(this.file(name)).then((s) => s.isFile(), () => false));
  }
  /** Whether the diagram's file name is a symbolic link. */
  async isLink(name: string) {
    return lstat(this.file(name)).then((l) => l.isSymbolicLink(), () => false);
  }
  /** Whether anything at all (even a broken link) sits at the diagram's file name. */
  async hasEntry(name: string) {
    return lstat(this.file(name)).then(() => true, () => false);
  }
  async load(name: string) {
    const file = this.file(name);
    let text: string;
    try {
      // A pipe or device would block or never end; only regular files are diagrams.
      const s = await stat(file);
      if (!s.isFile()) throw new Error(`${file} is ${s.isDirectory() ? "a folder" : "not a regular file"}`);
      text = await readFile(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code) throw e;
      if (code === "ELOOP") throw new Error(`${file} is a link loop; fix or delete the link`);
      if (code !== "ENOENT") throw new Error(`Cannot read ${file}: ${code}`);
      if (await lstat(file).then((l) => l.isSymbolicLink(), () => false))
        throw new Error(`${file} is a link to a file that does not exist; fix or delete the link`);
      const all = await this.list();
      throw new Error(`No FSM named "${name}". Existing: ${all.join(", ") || "(none)"}. Create one with create_fsm.`);
    }
    let d: FsmDiagram;
    try {
      const raw = JSON.parse(text.replace(/^﻿/, ""));
      if (typeof raw?.version === "number" && raw.version > 1)
        throw new Error(`it was written by a newer FSM Designer (file version ${raw.version}, this server reads version 1); update the MCP server`);
      d = parseDiagram(raw);
    } catch (e) {
      throw new Error(`${file} is not a valid FSM diagram: ${(e as Error).message}`);
    }
    // The file name is the diagram's identity: the editor's Save As or a copied
    // file can leave another name inside, and saving under that would write elsewhere.
    d.name = name;
    return d;
  }
  async save(d: FsmDiagram) {
    await mkdir(this.dir, { recursive: true });
    let target = this.file(d.name);
    // A linked diagram is saved into the file it links to, so the link and the original stay one diagram.
    if (await lstat(target).then((l) => l.isSymbolicLink(), () => false)) {
      try {
        target = await realpath(target);
      } catch (e) {
        throw new Error(`${target} is ${(e as NodeJS.ErrnoException).code === "ELOOP" ? "a link loop" : "a link to a file that does not exist"}; fix or delete the link`);
      }
    }
    const text = JSON.stringify(d, null, 2) + "\n";
    const old = await stat(target).catch(() => undefined);
    // Write then rename so a watching editor never sees a half-written file.
    // The temp name is unique per write, so overlapping saves cannot share it.
    if (old && !old.isFile()) throw new Error(`Cannot save ${target}: it is ${old.isDirectory() ? "a folder" : "not a regular file"}`);
    // A hard link makes one file appear under several names (maybe in several
    // folders); edits through different names could not be kept in step, and
    // saving would split them. Symbolic links work instead.
    if (old && old.nlink > 1)
      throw new Error(`Cannot save ${target}: the file is hard-linked under ${old.nlink} names. Use a symbolic link or a separate copy instead; nothing was changed`);
    const tmp = join(dirname(target), `.${d.name}${EXT}.tmp-${TMP_HOST}-${process.pid}-${RUN}-${++tmpCounter}`);
    await clearTemps(dirname(target), `.${d.name}${EXT}.tmp-${TMP_HOST}-`);
    temps.add(tmp);
    try {
      await writeFile(tmp, text, old ? { mode: old.mode & 0o7777 } : {});
      if (old) {
        await chmod(tmp, old.mode & 0o7777).catch(() => {});
        if (process.getuid?.() === 0) await chown(tmp, old.uid, old.gid).catch(() => {});
      }
      await renameRetry(tmp, target);
      temps.delete(tmp);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      temps.delete(tmp);
      if (permission(e)) throw new Error(`Cannot save ${target}: ${(e as NodeJS.ErrnoException).code} (is the workspace folder read-only, or the file open in another program?)`);
      if ((e as NodeJS.ErrnoException).code === "EISDIR") throw new Error(`Cannot save ${target}: a folder has that name; rename or remove the folder, or pick another FSM name`);
      throw e;
    }
  }
  async remove(name: string) {
    const file = this.file(name);
    if (await lstat(file).then((l) => l.isDirectory(), () => false)) throw new Error(`${file} is a folder, not a diagram; it was not deleted`);
    await rm(file);
  }
  async lock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.lockAll([name], fn);
  }
  async lockAll<T>(names: string[], fn: () => Promise<T>): Promise<T> {
    // The wait counts from the call, not from the turn in this process's queue.
    const deadline = Date.now() + LOCK_WAIT_MS;
    await mkdir(this.dir, { recursive: true });
    // Lock the real file, so names that symlink to one diagram share one lock.
    // (Hard-linked diagrams are refused when saving; see save.)
    const reals = await Promise.all(names.map((name) =>
      realpath(this.file(name)).catch(async () => join(await realpath(this.dir).catch(() => this.dir), basename(this.file(name))))));
    // Keyed lower-cased (on Windows and macOS "Seq" and "seq" are the same file), and taken in
    // the order of those keys, so two calls locking the same pair never wait on each other.
    const byKey = new Map(reals.map((r) => [r.toLowerCase(), r]));
    const keys = [...byKey.keys()].sort();
    const take = (i: number): Promise<T> => i === keys.length ? fn()
      : this.queue.run(keys[i], () => withFileLock(`${byKey.get(keys[i])}.lock`, () => take(i + 1), deadline));
    return take(0);
  }
  resolvePath(p: string) {
    return resolve(this.dir, userPath(p));
  }
}

/**
 * A path as an agent wrote it: `~` is the home folder, and on macOS/Linux a
 * Windows path (backslashes, drive letter) is turned into / or refused instead
 * of becoming a file literally named "out\seq.svg".
 */
export function userPath(p: string): string {
  let q = p.replace(/^~(?=$|[\\/])/, homedir());
  if (process.platform !== "win32") {
    if (/^[A-Za-z]:/.test(q) || /^\\\\/.test(q))
      throw new Error(`"${p}" is a Windows path, but this server runs on ${process.platform}; give a path on this computer`);
    q = q.replace(/\\/g, "/");
  }
  return q;
}
