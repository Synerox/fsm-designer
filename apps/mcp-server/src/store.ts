// Where the MCP tools read and write diagrams. Tool handlers only talk to this
// interface, so a "live document" backend (the desktop app over its local
// WebSocket) can replace the file store without touching the tools.

import { access, constants, lstat, mkdir, readdir, readFile, realpath, rm, writeFile, rename, open, stat, unlink } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  /** The file a diagram is saved in, when it lives on disk (used to open it in the desktop app). */
  fileOf?(name: string): string;
  /** Resolve a user-supplied export path (relative paths go into the workspace). */
  resolvePath(p: string): string;
  /** Entries that look like diagrams but cannot be used (shown by list_fsms). */
  ignored?(): Promise<string[]>;
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

/** How long to wait for another live process before giving up. */
const LOCK_WAIT_MS = 30_000;
/** A lock from another computer (shared folder) whose owner cannot be checked is abandoned after this long. */
const FOREIGN_STALE_MS = 10 * 60_000;
/** A lock file that is still empty or unreadable this long after it was created is abandoned. */
const BROKEN_STALE_MS = 30_000;
/** A `.break` guard (see breakStale) older than this was left by a crash. */
const BREAK_STALE_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOST = hostname();

interface LockInfo { pid: number; host: string; token: string; time: number }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

async function readLock(path: string): Promise<{ info?: LockInfo; mtime: number } | undefined> {
  try {
    const [text, s] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    let info: LockInfo | undefined;
    try { info = JSON.parse(text); } catch { /* still being written, or not ours */ }
    return { info, mtime: s.mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Why a lock may be taken over, or undefined while its owner may still be working. */
function staleReason(l: { info?: LockInfo; mtime: number }): string | undefined {
  const age = Date.now() - l.mtime;
  if (!l.info || typeof l.info.pid !== "number") return age > BROKEN_STALE_MS ? "unreadable lock file" : undefined;
  if (l.info.host === HOST) {
    // Our own pid on a lock we do not hold: left by an earlier process that had the same pid.
    if (l.info.pid === process.pid) return [...held.values()].includes(l.info.token) ? undefined : "left by an earlier process with this process id";
    return alive(l.info.pid) ? undefined : `process ${l.info.pid} has exited`;
  }
  return age > FOREIGN_STALE_MS ? `lock from ${l.info.host} is ${Math.round(age / 60000)} minutes old` : undefined;
}

/** Locks this process holds, removed if the process exits while holding them. */
const held = new Map<string, string>();
process.on("exit", () => {
  for (const [path, token] of held) {
    try {
      if (readFileSync(path, "utf8").includes(token)) unlinkSync(path);
    } catch { /* already gone */ }
  }
});

const permission = (e: unknown) => ["EACCES", "EPERM", "EROFS"].includes((e as NodeJS.ErrnoException).code ?? "");

/**
 * Remove a stale lock, but only the very lock that was judged stale: waiters take
 * `<lock>.break` with O_EXCL first, so two of them can never both remove a lock,
 * and one of them can never remove a fresh lock another waiter has just taken.
 */
async function breakStale(lockPath: string, seen: { info?: LockInfo; mtime: number }, why: string): Promise<void> {
  const guard = `${lockPath}.break`;
  try {
    await (await open(guard, "wx")).close();
  } catch (e) {
    if (permission(e)) throw new Error(`Cannot create ${guard}: the workspace folder is not writable (${(e as NodeJS.ErrnoException).code})`);
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // Someone else is breaking it; a guard left by a crash is cleared after a while.
    const g = await stat(guard).catch(() => undefined);
    if (g && Date.now() - g.mtimeMs > BREAK_STALE_MS) await unlink(guard).catch(() => {});
    else await sleep(10);
    return;
  }
  try {
    const now = await readLock(lockPath);
    if (!now) return;
    const same = seen.info?.token !== undefined ? now.info?.token === seen.info.token : !now.info && now.mtime === seen.mtime;
    if (!same || !staleReason(now)) return;
    try {
      await unlink(lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`A stale lock (${why}) could not be removed: ${lockPath} (${(e as NodeJS.ErrnoException).code}). Delete it by hand.`);
    }
  } finally {
    await unlink(guard).catch(() => {});
  }
}

/**
 * Cross-process advisory lock: `<file>.lock` is created with O_EXCL, so two MCP
 * servers (say Claude Desktop and Claude Code) sharing one workspace do not
 * overwrite each other's edits. A lock is only taken over when its owner is
 * gone (same computer: the process has exited), never because a long layout
 * is still running; and it is only removed by the process that holds it.
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const token = randomUUID();
  let last: LockInfo | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, host: HOST, token, time: Date.now() }) + "\n");
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      if (permission(e)) throw new Error(`Cannot create ${lockPath}: the workspace folder is not writable (${(e as NodeJS.ErrnoException).code})`);
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const cur = await readLock(lockPath);
    if (!cur) continue; // released in between
    last = cur.info;
    const why = staleReason(cur);
    if (why) {
      await breakStale(lockPath, cur, why);
      continue;
    }
    const waited = Date.now() - start;
    if (waited > LOCK_WAIT_MS) {
      const who = last ? `process ${last.pid} on ${last.host}` : "another process";
      throw new Error(`The diagram is locked by ${who} (${lockPath}); waited ${Math.round(waited / 1000)} s. ` +
        "Another FSM server may be running a long auto_layout; try again later, or delete the lock file if that server is gone.");
    }
    await sleep(Math.min(200, 20 + attempt * 10) * (0.5 + Math.random()));
  }
  held.set(lockPath, token);
  try {
    return await fn();
  } finally {
    held.delete(lockPath);
    const cur = await readLock(lockPath).catch(() => undefined);
    if (cur?.info?.token === token) await unlink(lockPath).catch(() => {});
  }
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
      return (await readdir(this.dir, { withFileTypes: true })).filter((e) => e.name.endsWith(EXT));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Cannot read the workspace folder ${this.dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  private static usable(stem: string) {
    try { checkName(stem); return true; } catch { return false; }
  }
  /** Split the entries into diagrams and the rest; a symlink counts when it leads to a file. */
  private async sorted() {
    const good: string[] = [];
    const bad: string[] = [];
    for (const e of await this.entries()) {
      const isFile = e.isFile() || (e.isSymbolicLink() && (await stat(join(this.dir, e.name)).then((s) => s.isFile(), () => false)));
      (isFile && FileStore.usable(e.name.slice(0, -EXT.length)) ? good : bad).push(e.name);
    }
    return { good: good.map((n) => n.slice(0, -EXT.length)).sort(), bad: bad.sort() };
  }
  async list() {
    return (await this.sorted()).good;
  }
  /** .fsm.json entries that cannot be used as diagrams (folders, broken links, names that are not FSM names), for list_fsms. */
  async ignored() {
    return (await this.sorted()).bad;
  }
  async exists(name: string) {
    return (await this.list()).includes(name);
  }
  async load(name: string) {
    const file = this.file(name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new Error(`Cannot read ${file}: ${code ?? (e as Error).message}`);
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
      } catch {
        throw new Error(`${target} is a link to a file that does not exist; fix or delete the link`);
      }
    }
    // Write then rename so a watching editor never sees a half-written file.
    // The temp name is unique per write, so overlapping saves cannot share it.
    const tmp = join(dirname(target), `.${d.name}${EXT}.tmp-${process.pid}-${++tmpCounter}`);
    try {
      await writeFile(tmp, JSON.stringify(d, null, 2) + "\n");
      await renameRetry(tmp, target);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      if (permission(e)) throw new Error(`Cannot save ${target}: ${(e as NodeJS.ErrnoException).code} (is the workspace folder read-only, or the file open in another program?)`);
      if ((e as NodeJS.ErrnoException).code === "EISDIR") throw new Error(`Cannot save ${target}: a folder has that name; rename or remove the folder, or pick another FSM name`);
      throw e;
    }
  }
  async remove(name: string) {
    await rm(this.file(name));
  }
  async lock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const file = this.file(name);
    // Lower-cased: on Windows and macOS "Seq" and "seq" are the same file.
    return this.queue.run(file.toLowerCase(), async () => {
      await mkdir(this.dir, { recursive: true });
      return withFileLock(`${file}.lock`, fn);
    });
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
