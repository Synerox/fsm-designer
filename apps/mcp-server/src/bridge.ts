// Live link between the MCP server and the FSM Designer web editor.
//
// The server listens on 127.0.0.1 only. It serves the built web editor (when
// apps/editor/dist is there) and a WebSocket at /live. An editor page that
// knows the port and the pairing token (both come in the link that
// open_in_editor opens, after the #, so they never reach a web server) shows
// one workspace diagram and stays in step with it both ways:
//
//   - every save of that diagram (a tool call, another MCP server on the same
//     workspace, an edit of the file by hand) is pushed to the page;
//   - the page sends the user's edits back, and the server saves them into the
//     same .fsm.json, under the same lock the tools use. An edit made on an
//     older version than the file's (the agent changed it meanwhile) is refused
//     and the page gets the current version instead, so the agent's change is
//     never lost to a stale page.
//
// Who may connect: the WebSocket upgrade must come from an allowed Origin (this
// server's own page, the published editor, the dev server) with a Host header
// naming the loopback address (against DNS rebinding), and the first message
// must carry the token. The token is kept in a file only the user can read, so
// a page reconnects by itself after the MCP host restarts the server.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { parseDiagram } from "@fsm/core";
import type { FsmDiagram } from "@fsm/core";
import { checkName } from "./store.ts";
import type { DiagramStore } from "./store.ts";

/** The published web editor, used when no local build is there to serve. */
export const PUBLIC_EDITOR = "https://synerox.github.io/fsm-designer/";
export const DEFAULT_PORT = 47400;
/** Ports tried after the default when it is taken (say, a second MCP host on the same computer). */
const PORT_TRIES = 10;
/** Largest message a page may send: a diagram with 1000 states is well under 1 MB. */
const MAX_MESSAGE = 8 * 1024 * 1024;
/** A page that has not sent its token this long after connecting is dropped. */
const HELLO_MS = 5_000;
export const PROTOCOL = 1;

export interface BridgeOptions {
  /** 0 = any free port. Default DEFAULT_PORT (or the next free one). */
  port?: number;
  /** Folder holding the built editor (index.html); null = do not serve one. Default: apps/editor/dist next to this package. */
  editorDir?: string | null;
  /** Editor page to open instead of the one served here, e.g. the published one or a dev server. */
  editorUrl?: string;
  /** Where the pairing token is kept. Default ~/.fsm-designer/live-token. */
  tokenFile?: string;
  /** Called after the user changed a diagram from the editor. */
  onUserEdit?: (name: string) => void;
  /** Called when the set of diagrams changed through the editor (a rename). */
  onListChanged?: () => void;
  /** For tests: what opens a URL in the browser. */
  openUrl?: (url: string) => Promise<void>;
}

/** What one connected editor page shows. */
export interface EditorInfo {
  id: number;
  origin: string;
  /** The diagram the page shows, if it is one from this workspace. */
  name?: string;
  /** What the user has selected there: state names, and transitions by id. */
  selection?: { states: string[]; transitions: string[] };
  connectedAt: number;
  /** When the user last changed the diagram from this page (ms since the epoch). */
  lastEditAt?: number;
}

interface Client extends EditorInfo {
  ws: WebSocket;
  authed: boolean;
  /** Hash of the version of `name` the page has. */
  hash?: string;
}

type Incoming =
  | { t: "hello"; token: string; v?: number }
  | { t: "open"; name: string }
  | { t: "close" }
  | { t: "list" }
  | { t: "save"; name: string; base: string; doc: unknown; seq?: number }
  | { t: "select"; name: string; states?: unknown; transitions?: unknown };

/** Stable fingerprint of a diagram's content. */
export function hashOf(d: FsmDiagram): string {
  return createHash("sha256").update(JSON.stringify(d)).digest("hex").slice(0, 32);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function defaultEditorDir(): string {
  // dist/bridge.js -> apps/mcp-server/dist -> apps/editor/dist
  return fileURLToPath(new URL("../../editor/dist/", import.meta.url));
}

/** Open a URL in the default browser without a shell (the URL's & and # must not be read as shell syntax). */
export async function openInBrowser(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  await new Promise<void>((done, fail) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", (e) => fail(new Error(`Could not start ${cmd} to open the browser: ${e.message}`)));
    child.once("spawn", () => { child.unref(); done(); });
  });
}

/** The token from `file`, creating it (readable by this user only) when it is missing or malformed. */
async function loadToken(file: string): Promise<string> {
  try {
    const t = (await readFile(file, "utf8")).trim();
    if (/^[A-Za-z0-9_-]{32,128}$/.test(t)) return t;
  } catch { /* first run */ }
  const t = randomBytes(24).toString("base64url");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, t + "\n", { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return t;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class LiveBridge {
  private http?: HttpServer;
  private wss?: WebSocketServer;
  private watcher?: FSWatcher;
  private clients = new Set<Client>();
  private nextId = 1;
  private token = "";
  private editorDir: string | null;
  private pending = new Map<string, NodeJS.Timeout>();
  /** Why the bridge is not running, when start() failed. */
  error?: string;
  port = 0;

  private store: DiagramStore;
  private opts: BridgeOptions;

  constructor(store: DiagramStore, opts: BridgeOptions = {}) {
    this.store = store;
    this.opts = opts;
    this.editorDir = opts.editorDir === undefined ? defaultEditorDir() : opts.editorDir;
  }

  get running(): boolean {
    return !!this.http?.listening;
  }

  /** Start listening. Never throws: a bridge that cannot start leaves the tools working and says why in `error`. */
  async start(): Promise<void> {
    try {
      this.token = await loadToken(this.opts.tokenFile ?? join(homedir(), ".fsm-designer", "live-token"));
      if (this.editorDir && !(await stat(join(this.editorDir, "index.html")).then((s) => s.isFile(), () => false))) this.editorDir = null;
      const http = createHttpServer((req, res) => void this.serve(req, res));
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
      http.on("upgrade", (req, socket, head) => {
        const why = this.refuse(req);
        if (why || new URL(req.url ?? "/", "http://x").pathname !== "/live") {
          socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${why ?? "not found"}\n`);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, String(req.headers.origin)));
      });
      const first = this.opts.port ?? DEFAULT_PORT;
      const tries = first === 0 ? 1 : PORT_TRIES;
      for (let i = 0; ; i++) {
        try {
          await new Promise<void>((done, fail) => {
            http.once("error", fail);
            http.listen(first === 0 ? 0 : first + i, "127.0.0.1", () => { http.off("error", fail); done(); });
          });
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i + 1 >= tries) throw e;
        }
      }
      this.port = (http.address() as { port: number }).port;
      this.http = http;
      this.wss = wss;
      this.watchWorkspace();
      this.error = undefined;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async close(): Promise<void> {
    this.watcher?.close();
    for (const t of this.pending.values()) clearTimeout(t);
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
    await new Promise<void>((done) => (this.http ? this.http.close(() => done()) : done()));
  }

  /** Where the editor page lives: the one served here, or the configured/published one. */
  editorBase(): string {
    if (this.opts.editorUrl) return this.opts.editorUrl;
    if (this.editorDir && this.running) return `http://127.0.0.1:${this.port}/`;
    return PUBLIC_EDITOR;
  }

  /** The link that opens the editor on `name`, connected to this server. */
  link(name?: string): string {
    const u = new URL(this.editorBase());
    const p = new URLSearchParams({ live: String(this.port), token: this.token });
    if (name) p.set("fsm", name);
    u.hash = p.toString();
    return u.href;
  }

  /** Origins whose pages may connect: this server's own, the published editor, the configured one, and the Vite dev server. */
  private origins(): Set<string> {
    const s = new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`, new URL(PUBLIC_EDITOR).origin,
      "http://localhost:5173", "http://127.0.0.1:5173"]);
    if (this.opts.editorUrl) s.add(new URL(this.opts.editorUrl).origin);
    return s;
  }

  /** Why a request must be refused, or undefined. */
  private refuse(req: IncomingMessage): string | undefined {
    const host = String(req.headers.host ?? "").toLowerCase();
    // A page on another site whose name was re-pointed at 127.0.0.1 still sends its own name here.
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return "bad host";
    if (req.headers.upgrade) {
      const origin = req.headers.origin;
      if (!origin || !this.origins().has(origin)) return `origin ${origin ?? "(none)"} is not allowed`;
    }
    return undefined;
  }

  /** Serve the built editor (GET only, files inside editorDir only). */
  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: string | Buffer, type = "text/plain; charset=utf-8") => {
      res.writeHead(code, {
        "Content-Type": type, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer", "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (this.refuse(req)) return send(403, "Forbidden\n");
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed\n");
    if (!this.editorDir)
      return send(404, `FSM Designer live link. No editor build is installed here; open ${PUBLIC_EDITOR} instead (or run pnpm -r build).\n`);
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return send(400, "Bad request\n");
    }
    if (path.endsWith("/")) path += "index.html";
    const root = resolve(this.editorDir);
    const file = resolve(root, "." + path);
    if (path.includes("\0") || (file !== root && !file.startsWith(root + sep))) return send(403, "Forbidden\n");
    try {
      const s = await stat(file);
      if (!s.isFile()) return send(404, "Not found\n");
      send(200, await readFile(file), MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
    } catch {
      send(404, "Not found\n");
    }
  }

  private accept(ws: WebSocket, origin: string): void {
    const c: Client = { id: this.nextId++, origin, ws, authed: false, connectedAt: Date.now() };
    this.clients.add(c);
    const timer = setTimeout(() => { if (!c.authed) ws.close(4401, "no token"); }, HELLO_MS);
    ws.on("close", () => { clearTimeout(timer); this.clients.delete(c); });
    ws.on("error", () => ws.terminate());
    // One message at a time per page, so a save and the next open cannot overtake each other.
    let chain = Promise.resolve();
    ws.on("message", (data, binary) => {
      chain = chain.then(() => this.handle(c, binary ? "" : data.toString())).catch((e) => this.send(c, { t: "error", message: (e as Error).message }));
    });
  }

  private send(c: Client, msg: Record<string, unknown>): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private async handle(c: Client, raw: string): Promise<void> {
    let m: Incoming;
    try {
      m = JSON.parse(raw);
      if (!m || typeof m !== "object" || typeof m.t !== "string") throw new Error();
    } catch {
      return this.send(c, { t: "error", message: "not a JSON message" });
    }
    if (!c.authed) {
      if (m.t !== "hello" || typeof m.token !== "string" || !sameToken(m.token, this.token)) {
        c.ws.close(4403, "bad token");
        return;
      }
      c.authed = true;
      return this.send(c, { t: "welcome", v: PROTOCOL, workspace: this.store.location, names: await this.store.list() });
    }
    switch (m.t) {
      case "list":
        return this.send(c, { t: "list", names: await this.store.list() });
      case "open":
        return this.open(c, String(m.name));
      case "close":
        c.name = c.hash = c.selection = undefined;
        return;
      case "select":
        if (m.name === c.name) c.selection = { states: strings(m.states), transitions: strings(m.transitions) };
        return;
      case "save":
        return this.save(c, m);
      default:
        return this.send(c, { t: "error", message: `unknown message ${m.t}` });
    }
  }

  private async open(c: Client, name: string): Promise<void> {
    try {
      checkName(name);
      const d = await this.store.load(name);
      c.name = name;
      c.hash = hashOf(d);
      c.selection = undefined;
      this.send(c, { t: "doc", name, hash: c.hash, doc: d, why: "open" });
    } catch (e) {
      this.send(c, { t: "error", name, message: (e as Error).message });
    }
  }

  private async save(c: Client, m: Extract<Incoming, { t: "save" }>): Promise<void> {
    const name = String(m.name);
    const seq = typeof m.seq === "number" ? m.seq : undefined;
    if (name !== c.name) return this.send(c, { t: "error", name, seq, message: `this page does not have ${name} open` });
    let d: FsmDiagram;
    try {
      d = parseDiagram(JSON.parse(JSON.stringify(m.doc ?? null)));
    } catch (e) {
      return this.send(c, { t: "rejected", name, seq, message: `not a valid diagram: ${(e as Error).message}` });
    }
    // The diagram's name is its file name. A changed name (the user renamed the module) is a rename.
    const to = d.name;
    if (to !== name) {
      try {
        checkName(to);
      } catch (e) {
        return this.send(c, { t: "rejected", name, seq, message: (e as Error).message });
      }
    }
    const result = await this.store.lock(name, async () => {
      let cur: FsmDiagram;
      try {
        cur = await this.store.load(name);
      } catch (e) {
        return { t: "rejected", name, seq, message: (e as Error).message } as Record<string, unknown>;
      }
      const curHash = hashOf(cur);
      if (curHash !== m.base) return { t: "conflict", name, seq, hash: curHash, doc: cur };
      if (to === name) {
        await this.store.save(d);
        const saved = await this.store.load(name);
        return { t: "saved", name, seq, hash: hashOf(saved), changed: false };
      }
      // Rename: the new name must be free (also in another case: on Windows and macOS that is the same file).
      return this.store.lock(to, async () => {
        const clash = (await this.store.list()).find((n) => n.toLowerCase() === to.toLowerCase() && n !== name);
        if (clash || (await this.store.hasEntry?.(to)))
          return { t: "rejected", name, seq, message: `cannot rename to ${to}: the workspace already has ${clash ?? to}` };
        await this.store.save(d);
        await this.store.remove(name);
        const saved = await this.store.load(to);
        return { t: "saved", name: to, from: name, seq, hash: hashOf(saved), changed: true };
      });
    }).catch((e) => ({ t: "rejected", name, seq, message: (e as Error).message }) as Record<string, unknown>);
    if (result.t === "saved") {
      c.name = String(result.name);
      c.hash = String(result.hash);
      c.lastEditAt = Date.now();
      this.send(c, result);
      // Other pages showing the same diagram follow along.
      this.changed(c.name);
      if (result.changed) {
        this.removed(name);
        this.opts.onListChanged?.();
      }
      this.opts.onUserEdit?.(c.name);
      return;
    }
    if (result.t === "conflict") c.hash = String(result.hash);
    this.send(c, result);
  }

  /**
   * A diagram may have changed: send the current version to every page that
   * shows an older one. Cheap when nothing changed (one file read).
   */
  async changed(name: string): Promise<void> {
    const watching = [...this.clients].filter((c) => c.authed && c.name === name);
    if (!watching.length) return;
    let d: FsmDiagram;
    try {
      d = await this.store.load(name);
    } catch {
      return; // deleted or half-written; a later event follows
    }
    const hash = hashOf(d);
    for (const c of watching) {
      if (c.name !== name || c.hash === hash) continue;
      c.hash = hash;
      this.send(c, { t: "doc", name, hash, doc: d, why: "changed" });
    }
  }

  /** A diagram was deleted: pages showing it keep their copy but are told it is gone. */
  removed(name: string): void {
    for (const c of this.clients) {
      if (!c.authed || c.name !== name) continue;
      c.name = c.hash = c.selection = undefined;
      this.send(c, { t: "deleted", name });
    }
  }

  /** The workspace's diagram list changed (created, deleted, renamed). */
  async listChanged(): Promise<void> {
    if (![...this.clients].some((c) => c.authed)) return;
    const names = await this.store.list().catch(() => undefined);
    if (!names) return;
    for (const c of this.clients) if (c.authed) this.send(c, { t: "list", names });
  }

  /** Changes made outside this process (another MCP server, a text editor) show up too. */
  private watchWorkspace(): void {
    const dir = (this.store as { dir?: string }).dir;
    if (!dir) return;
    try {
      this.watcher = watch(dir, (_event, file) => {
        const f = file?.toString() ?? "";
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\.fsm\.json$/i.exec(f);
        if (!m) return;
        const name = m[1];
        clearTimeout(this.pending.get(name));
        this.pending.set(name, setTimeout(() => {
          this.pending.delete(name);
          void this.store.exists(name).then((there) => {
            if (there) return this.changed(name);
            this.removed(name);
          }).catch(() => {});
          void this.listChanged();
        }, 80));
      });
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
    } catch { /* no watching on this file system: tool changes are still pushed */ }
  }

  /** Connected, paired pages, most recent first. */
  editors(): EditorInfo[] {
    return [...this.clients].filter((c) => c.authed).reverse()
      .map(({ id, origin, name, selection, connectedAt, lastEditAt }) => ({ id, origin, name, selection, connectedAt, lastEditAt }));
  }

  /**
   * Show `name` to the user: switch the most recently connected page to it, or
   * open a new page in the browser. Returns what happened, for the tool reply.
   */
  async show(name: string, opts: { newWindow?: boolean } = {}): Promise<{ how: "switched" | "opened"; url: string }> {
    if (!this.running) throw new Error(`The live editor link is not running${this.error ? ` (${this.error})` : ""}.`);
    const url = this.link(name);
    const page = opts.newWindow ? undefined : [...this.clients].filter((c) => c.authed).pop();
    if (page) {
      if (page.name === name) await this.changed(name);
      else await this.open(page, name);
      this.send(page, { t: "focus" });
      return { how: "switched", url };
    }
    await (this.opts.openUrl ?? openInBrowser)(url);
    return { how: "opened", url };
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5000) : [];
}

/** Wrap a store so every save or delete made through it reaches the open editor pages at once. */
export function liveStore(store: DiagramStore, bridge: () => LiveBridge | undefined): DiagramStore {
  const s: DiagramStore = Object.create(store);
  s.save = async (d) => {
    await store.save(d);
    void bridge()?.changed(d.name);
    void bridge()?.listChanged();
  };
  s.remove = async (name) => {
    await store.remove(name);
    bridge()?.removed(name);
    void bridge()?.listChanged();
  };
  return s;
}
