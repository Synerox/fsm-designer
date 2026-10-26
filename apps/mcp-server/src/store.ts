// Where the MCP tools read and write diagrams. Tool handlers only talk to this
// interface, so a "live document" backend (the desktop app over its local
// WebSocket) can replace the file store without touching the tools.

import { mkdir, readdir, readFile, rm, writeFile, rename, open, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
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
}

const FILE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Check an FSM name before it becomes part of a file name. */
export function checkName(name: string): string {
  if (!FILE_RE.test(name)) throw new Error(`Invalid FSM name "${name}" (use letters, digits and _, starting with a letter or _)`);
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

/** A lock held by another process is considered abandoned after this long. */
const LOCK_STALE_MS = 15_000;
/** How long to wait for another process before giving up. */
const LOCK_WAIT_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-process advisory lock: `<file>.lock` is created with O_EXCL, so two MCP
 * servers (say Claude Desktop and Claude Code) sharing one workspace do not
 * overwrite each other's edits. Stale locks (a crashed server) are removed.
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) { await unlink(lockPath).catch(() => {}); continue; }
      } catch { continue; /* it was released in between */ }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`Another process is editing this diagram (lock file ${lockPath}). Try again in a moment.`);
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

let tmpCounter = 0;

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
  private file(name: string) {
    return join(this.dir, `${checkName(name)}.fsm.json`);
  }
  fileOf(name: string) {
    return this.file(name);
  }
  async list() {
    try {
      return (await readdir(this.dir)).filter((f) => f.endsWith(".fsm.json")).map((f) => f.slice(0, -".fsm.json".length)).sort();
    } catch {
      return [];
    }
  }
  async exists(name: string) {
    return (await this.list()).includes(name);
  }
  async load(name: string) {
    const file = this.file(name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      const all = await this.list();
      throw new Error(`No FSM named "${name}". Existing: ${all.join(", ") || "(none)"}. Create one with create_fsm.`);
    }
    try {
      return parseDiagram(JSON.parse(text));
    } catch (e) {
      throw new Error(`${file} is not a valid FSM diagram: ${(e as Error).message}`);
    }
  }
  async save(d: FsmDiagram) {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(d.name);
    // Write then rename so a watching editor never sees a half-written file.
    // The temp name is unique per write, so overlapping saves cannot share it.
    const tmp = `${target}.tmp-${process.pid}-${++tmpCounter}`;
    try {
      await writeFile(tmp, JSON.stringify(d, null, 2) + "\n");
      await rename(tmp, target);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  async remove(name: string) {
    await rm(this.file(name));
  }
  async lock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const file = this.file(name);
    return this.queue.run(file, async () => {
      await mkdir(this.dir, { recursive: true });
      return withFileLock(`${file}.lock`, fn);
    });
  }
  resolvePath(p: string) {
    return resolve(this.dir, p);
  }
}
