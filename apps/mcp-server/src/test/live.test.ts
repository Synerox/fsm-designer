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

test("a link carries a one-time code (never the token), after the # only", async () => {
  const u = new URL(bridge.link("traffic"));
  assert.equal(u.origin, `http://127.0.0.1:${bridge.port}`);
  const h = new URLSearchParams(u.hash.slice(1));
  assert.equal(h.get("live"), String(bridge.port));
  assert.equal(h.get("token"), null);
  assert.ok(!u.href.includes(token));
  assert.equal(h.get("fsm"), "traffic");
  assert.equal(u.search, "");
  const code = h.get("code")!;
  // The code pairs once and hands over the token; a second use is refused.
  const p = await page({ hello: null });
  p.send({ t: "hello", code });
  assert.equal((await p.next("welcome")).token, token);
  p.ws.close();
  const again = await page({ hello: null });
  again.send({ t: "hello", code });
  assert.equal(await again.closed, 4403);
});

test("a malformed request target cannot take the server down", async () => {
  const { connect } = await import("node:net");
  for (const target of ["http://[", "//[::1", "%", "*"]) {
    await new Promise<void>((done) => {
      const s = connect(bridge.port, "127.0.0.1", () => {
        s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nOrigin: http://127.0.0.1:${bridge.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      });
      s.on("data", () => s.destroy());
      s.on("close", () => done());
      s.on("error", () => done());
      setTimeout(() => s.destroy(), 500);
    });
    assert.equal((await get(target === "*" ? "/" : "/")).status, 200, `still serving after ${target}`);
  }
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
  assert.match(String((await p.next("rejected")).message), /already has a diagram with that name/);
  // Only the letter case: refused at once (no hang), and the diagram stays usable.
  doc.name = "Old_name";
  p.send({ t: "save", name: "old_name", base: got.hash, doc });
  assert.match(String((await p.next("rejected")).message), /only in letter case/);
  await store.lock("old_name", async () => {});
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
  // The page is asked to switch; like the editor, it then opens the diagram itself.
  const pending = bridge.show("shown");
  const sw = await p.next("switch");
  assert.equal(sw.name, "shown");
  p.send({ t: "open", name: "shown" });
  assert.equal((await pending).how, "switched");
  assert.equal(((await p.next("doc")).name), "shown");
  // Already showing it: just brought forward.
  assert.equal((await bridge.show("shown")).how, "switched");
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

test("two renames the other way round both finish", async () => {
  await store.save(diagram("aa"));
  await store.save(diagram("bb"));
  const p1 = await page(), p2 = await page();
  p1.send({ t: "open", name: "aa" });
  p2.send({ t: "open", name: "bb" });
  const d1 = await p1.next("doc"), d2 = await p2.next("doc");
  p1.send({ t: "save", name: "aa", base: d1.hash, doc: { ...(d1.doc as object), name: "bb" } });
  p2.send({ t: "save", name: "bb", base: d2.hash, doc: { ...(d2.doc as object), name: "aa" } });
  assert.equal((await p1.next("rejected")).t, "rejected");
  assert.equal((await p2.next("rejected")).t, "rejected");
  p1.ws.close(); p2.ws.close();
});

test("other pages follow a rename; the same content from two pages is no conflict", async () => {
  await store.save(diagram("ren"));
  const p1 = await page(), p2 = await page();
  p1.send({ t: "open", name: "ren" });
  p2.send({ t: "open", name: "ren" });
  const d1 = await p1.next("doc"), d2 = await p2.next("doc");
  const moved = structuredClone(d1.doc) as ReturnType<typeof diagram>;
  moved.states[0].x = 321;
  p1.send({ t: "save", name: "ren", base: d1.hash, doc: moved, seq: 1, auto: true });
  p2.send({ t: "save", name: "ren", base: d2.hash, doc: moved, seq: 1, auto: true });
  const s1 = await p1.next("saved"), s2 = await p2.next("saved");
  assert.equal(s1.hash, s2.hash);
  moved.name = "ren2";
  p1.send({ t: "save", name: "ren", base: s1.hash, doc: moved, seq: 2 });
  assert.equal((await p1.next("saved")).name, "ren2");
  const r = await p2.next("renamed");
  assert.deepEqual([r.from, r.name], ["ren", "ren2"]);
  assert.ok(!p2.inbox.some((m) => m.t === "deleted"));
  p1.ws.close(); p2.ws.close();
});

test("a save sent before the last one was answered builds on it, but never over the agent's change", async () => {
  const live = liveStore(store, () => bridge);
  await store.save(diagram("chain"));
  const p = await page();
  p.send({ t: "open", name: "chain" });
  const got = await p.next("doc");
  const doc = structuredClone(got.doc) as ReturnType<typeof diagram>;
  doc.states[0].x = 1;
  p.send({ t: "save", name: "chain", base: got.hash, doc, seq: 1 });
  const doc2 = structuredClone(doc);
  doc2.states[0].x = 2;
  p.send({ t: "save", name: "chain", base: "@chain", doc: doc2, seq: 2 });
  await p.next("saved");
  assert.equal((await p.next("saved")).seq, 2);
  assert.equal((await store.load("chain")).states[0].x, 2);
  // The agent changes it; a chained save that missed that is refused.
  const s3 = structuredClone(doc2);
  s3.states[0].x = 3;
  p.send({ t: "save", name: "chain", base: hashOf(await store.load("chain")), doc: s3, seq: 3 });
  await p.next("saved");
  await live.lock("chain", async () => { const d = await live.load("chain"); d.states[1].x = 777; await live.save(d); });
  const s4 = structuredClone(s3);
  s4.states[0].x = 4;
  p.send({ t: "save", name: "chain", base: "@chain", doc: s4, seq: 4 });
  assert.equal((await p.next("conflict")).seq, 4);
  assert.equal((await store.load("chain")).states[1].x, 777);
  p.ws.close();
});

test("a port the user asked for is that port or an error", async () => {
  const b2 = new LiveBridge(store, { port: bridge.port, editorDir: null, tokenFile: join(dir, "token") });
  await b2.start();
  assert.ok(!b2.running);
  assert.match(b2.error ?? "", /EADDRINUSE/);
  await b2.close();
});

test("a save that builds on a rename still reaches the renamed file", async () => {
  await store.save(diagram("before_rename"));
  const p = await page();
  p.send({ t: "open", name: "before_rename" });
  const got = await p.next("doc");
  const doc = structuredClone(got.doc) as ReturnType<typeof diagram>;
  doc.name = "after_rename";
  p.send({ t: "save", name: "before_rename", base: got.hash, doc, seq: 1 });
  const doc2 = structuredClone(doc);
  doc2.states[0].x = 4242;
  p.send({ t: "save", name: "before_rename", base: "@chain", doc: doc2, seq: 2 });
  assert.equal((await p.next("saved")).name, "after_rename");
  const s2 = await p.next("saved");
  assert.deepEqual([s2.seq, s2.name], [2, "after_rename"]);
  assert.equal((await store.load("after_rename")).states[0].x, 4242);
  p.ws.close();
});

test("renames of a linked diagram and its target onto one name never wait on each other", { skip: process.platform === "win32" }, async () => {
  const { symlink } = await import("node:fs/promises");
  await store.save(diagram("zz_target"));
  await symlink(join(store.dir, "zz_target.fsm.json"), join(store.dir, "aa_link.fsm.json"));
  const p1 = await page(), p2 = await page();
  p1.send({ t: "open", name: "aa_link" });
  p2.send({ t: "open", name: "zz_target" });
  const d1 = await p1.next("doc"), d2 = await p2.next("doc");
  p1.send({ t: "save", name: "aa_link", base: d1.hash, doc: { ...(d1.doc as object), name: "mm_new" } });
  p2.send({ t: "save", name: "zz_target", base: d2.hash, doc: { ...(d2.doc as object), name: "mm_new" } });
  const a = await Promise.race([p1.next("saved", 5000).catch(() => null), p1.next("rejected", 5000).catch(() => null), p1.next("conflict", 5000).catch(() => null)]);
  const b = await Promise.race([p2.next("saved", 5000).catch(() => null), p2.next("rejected", 5000).catch(() => null), p2.next("conflict", 5000).catch(() => null)]);
  assert.ok(a && b, "both renames answered");
  await store.lock("zz_target", async () => {});
  p1.ws.close(); p2.ws.close();
});
