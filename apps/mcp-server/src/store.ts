// Where the MCP tools read and write diagrams. Tool handlers only talk to this
// interface, so a "live document" backend (the desktop app over its local
// WebSocket) can replace the file store without touching the tools.

import { mkdir, readdir, readFile, rm, writeFile, rename } from "node:fs/promises";
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
  /** The file a diagram is saved in, when it lives on disk (used to open it in the desktop app). */
  fileOf?(name: string): string;
  /** Resolve a user-supplied export path (relative paths go into the workspace). */
  resolvePath(p: string): string;
}

const FILE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Headless mode: each diagram is <dir>/<name>.fsm.json. */
export class FileStore implements DiagramStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = resolve(dir);
  }
  get location() {
    return this.dir;
  }
  private file(name: string) {
    if (!FILE_RE.test(name)) throw new Error(`Invalid FSM name "${name}" (use letters, digits and _)`);
    return join(this.dir, `${name}.fsm.json`);
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
    let text: string;
    try {
      text = await readFile(this.file(name), "utf8");
    } catch {
      const all = await this.list();
      throw new Error(`No FSM named "${name}". Existing: ${all.join(", ") || "(none)"}. Create one with create_fsm.`);
    }
    return parseDiagram(JSON.parse(text));
  }
  async save(d: FsmDiagram) {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(d.name);
    // Write then rename so a watching editor never sees a half-written file.
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(d, null, 2) + "\n");
    await rename(tmp, target);
  }
  async remove(name: string) {
    await rm(this.file(name));
  }
  resolvePath(p: string) {
    return resolve(this.dir, p);
  }
}
