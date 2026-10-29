// The live link between the server and the web editor (bridge.ts): pairing,
// who may connect, pushing tool edits to the page, and saving the page's edits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createDiagram, addState } from "@fsm/core";
import { FileStore } from "../store.ts";
import { LiveBridge, liveStore, hashOf } from "../bridge.ts";

let dir: string;
let store: FileStore;
let bridge: LiveBridge;
let token: string;
let opened: string[] = [];
const edits: string[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fsm-live-"));
  store = new FileStore(join(dir, "ws"));
  await store.prepare();
  const editor = join(dir, "editor");
  await mkdir(join(editor, "assets"), { recursive: true });
  await writeFile(join(editor, "index.html"), "<!doctype html><title>FSM</title>");
  await writeFile(join(editor, "assets", "app.js"), "console.log(1)");
  await writeFile(join(dir, "secret.txt"), "secret");
  bridge = new LiveBridge(store, {
    port: 0, editorDir: editor, tokenFile: join(dir, "token"),
    openUrl: async (u) => { opened.push(u); },
    onUserEdit: (n) => edits.push(n),
  });
  await bridge.start();
  assert.ok(bridge.running, bridge.error);
  token = (await readFile(join(dir, "token"), "utf8")).trim();
});
after(async () => {
  await bridge.close();
  await rm(dir, { recursive: true, force: true });
});

function diagram(name: string, states = ["A", "B"]) {
  const d = createDiagram({ name });
  states.forEach((s, i) => addState(d, { name: s, x: 100 + 150 * i, y: 100, isInitial: i === 0 }));
  return d;
}

/** A page: connects, and collects what the server sends. */
async function page(opts: { origin?: string; host?: string; hello?: string | null } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/live`, {
    headers: { Origin: opts.origin ?? `http://127.0.0.1:${bridge.port}`, ...(opts.host ? { Host: opts.host } : {}) },
  });
  const inbox: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (m) => { inbox.push(JSON.parse(m.toString())); waiters.splice(0).forEach((w) => w()); });
  const closed = new Promise<number>((r) => ws.on("close", (code) => { r(code); waiters.splice(0).forEach((w) => w()); }));
  await new Promise<void>((ok, fail) => { ws.once("open", () => ok()); ws.once("error", fail); ws.once("unexpected-response", (_q, res) => fail(new Error(`HTTP ${res.statusCode}`))); });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  async function next(t: string, ms = 3000): Promise<Record<string, unknown>> {
    const end = Date.now() + ms;
    for (;;) {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() > end || ws.readyState === ws.CLOSED) throw new Error(`no ${t} message (got ${JSON.stringify(inbox)})`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  }
  if (opts.hello !== null) {
    send({ t: "hello", token: opts.hello ?? token, v: 1 });
    if (opts.hello === undefined) await next("welcome");
  }
  return { ws, send, next, inbox, closed };
}

function get(path: string, host = `127.0.0.1:${bridge.port}`): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port: bridge.port, path, headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", fail);
    r.end();
  });
}

test("serves the editor, nothing outside it, and only to the loopback host name", async () => {
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/assets/app.js")).status, 200);
  assert.equal((await get("/../secret.txt")).status, 404);
  assert.notEqual((await get("/%2e%2e/secret.txt")).status, 200);
  assert.equal((await get("/", "evil.example:80")).status, 403);
  assert.equal((await get("/", `localhost:${bridge.port}`)).status, 200);
});

test("refuses other origins, rebinding host names and wrong tokens", async () => {
  await assert.rejects(page({ origin: "https://evil.example" }), /403/);
  await assert.rejects(page({ host: `evil.example:${bridge.port}` }), /403/);
  const p = await page({ hello: "x".repeat(32) });
  assert.equal(await p.closed, 4403);
  const q = await page({ hello: null });
  q.send({ t: "open", name: "nope" });
  assert.equal(await q.closed, 4403);
  // The published editor may connect.
  const ok = await page({ origin: "https://synerox.github.io" });
  ok.ws.close();
});

test("the link carries port and token after the # only", () => {
  const u = new URL(bridge.link("traffic"));
  assert.equal(u.origin, `http://127.0.0.1:${bridge.port}`);
  const h = new URLSearchParams(u.hash.slice(1));
  assert.equal(h.get("live"), String(bridge.port));
  assert.equal(h.get("token"), token);
  assert.equal(h.get("fsm"), "traffic");
  assert.equal(u.search, "");
});

test("a page gets the diagram, then every tool edit of it", async () => {
  const live = liveStore(store, () => bridge);
  await live.save(diagram("traffic"));
  const p = await page();
  p.send({ t: "open", name: "traffic" });
  const first = await p.next("doc");
  assert.equal((first.doc as { states: unknown[] }).states.length, 2);
  await live.lock("traffic", async () => {
    const d = await live.load("traffic");
    addState(d, { name: "C", x: 400, y: 100 });
    await live.save(d);
  });
  const pushed = await p.next("doc");
  assert.equal((pushed.doc as { states: unknown[] }).states.length, 3);
  assert.notEqual(pushed.hash, first.hash);
  p.ws.close();
});

test("the page's edits are saved; an edit of an older version gets the current one back", async () => {
  await store.save(diagram("edit"));
  const p = await page();
  p.send({ t: "open", name: "edit" });
  const got = await p.next("doc");
  const doc = got.doc as ReturnType<typeof diagram>;
  doc.states[0].x = 999;
  p.send({ t: "save", name: "edit", base: got.hash, doc, seq: 1 });
  const saved = await p.next("saved");
  assert.equal(saved.seq, 1);
  assert.equal((await store.load("edit")).states[0].x, 999);
  assert.equal(saved.hash, hashOf(await store.load("edit")));
  assert.deepEqual(edits.slice(-1), ["edit"]);
  // Stale base: refused, and the page is handed the file's version.
  doc.states[0].x = 1;
  p.send({ t: "save", name: "edit", base: got.hash, doc, seq: 2 });
  const c = await p.next("conflict");
  assert.equal((c.doc as typeof doc).states[0].x, 999);
  assert.equal((await store.load("edit")).states[0].x, 999);
  // Garbage is refused without touching the file.
  p.send({ t: "save", name: "edit", base: saved.hash, doc: { states: "no" }, seq: 3 });
  assert.equal((await p.next("rejected")).seq, 3);
  assert.equal((await store.load("edit")).states[0].x, 999);
  p.ws.close();
});

test("renaming the module in the editor renames the file, never over another diagram", async () => {
  await store.save(diagram("old_name"));
  await store.save(diagram("taken"));
  const p = await page();
  p.send({ t: "open", name: "old_name" });
  const got = await p.next("doc");
  const doc = got.doc as ReturnType<typeof diagram>;
  doc.name = "taken";
  p.send({ t: "save", name: "old_name", base: got.hash, doc });
  assert.match(String((await p.next("rejected")).message), /already has taken/);
  doc.name = "new_name";
  p.send({ t: "save", name: "old_name", base: got.hash, doc });
  const s = await p.next("saved");
  assert.equal(s.name, "new_name");
  assert.ok(await store.exists("new_name"));
  assert.ok(!(await store.exists("old_name")));
  p.ws.close();
});

test("show switches a connected page, or opens the browser when none is", async () => {
  await store.save(diagram("shown"));
  opened = [];
  const r = await bridge.show("shown");
  assert.equal(r.how, "opened");
  assert.equal(opened.length, 1);
  const p = await page();
  const r2 = await bridge.show("shown");
  assert.equal(r2.how, "switched");
  assert.equal(((await p.next("doc")).name), "shown");
  await p.next("focus");
  p.send({ t: "select", name: "shown", states: ["A"], transitions: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(bridge.editors()[0].selection, { states: ["A"], transitions: [] });
  assert.equal(opened.length, 1);
  p.ws.close();
});

test("deleting a diagram tells the pages showing it", async () => {
  const live = liveStore(store, () => bridge);
  await live.save(diagram("gone"));
  const p = await page();
  p.send({ t: "open", name: "gone" });
  await p.next("doc");
  await live.remove("gone");
  assert.equal((await p.next("deleted")).name, "gone");
  p.ws.close();
});

test("a change made outside the server (another process) reaches the page", async () => {
  await store.save(diagram("outside"));
  const p = await page();
  p.send({ t: "open", name: "outside" });
  await p.next("doc");
  const other = new FileStore(join(dir, "ws"));
  await other.save(diagram("outside", ["A", "B", "C", "D"]));
  const d = await p.next("doc", 5000);
  assert.equal((d.doc as { states: unknown[] }).states.length, 4);
  p.ws.close();
});
