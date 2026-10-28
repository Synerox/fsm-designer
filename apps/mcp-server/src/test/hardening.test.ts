// Agent mistakes and edge cases found by driving the server with real MCP
// clients: typos, ids, exports that would clobber diagrams, odd inputs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
let dir: string;
let client: Client;

type Out = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
async function call(name: string, args: Record<string, unknown>): Promise<Out> {
  return (await client.callTool({ name, arguments: args })) as Out;
}
const textOf = (r: Out) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const load = async (n: string) => JSON.parse(await readFile(join(dir, `${n}.fsm.json`), "utf8"));
async function ok(name: string, args: Record<string, unknown>) {
  const r = await call(name, args);
  assert.ok(!r.isError, `${name}: ${textOf(r)}`);
  return textOf(r);
}
async function fails(name: string, args: Record<string, unknown>, re: RegExp) {
  const r = await call(name, args);
  assert.ok(r.isError, `${name} should fail: ${textOf(r)}`);
  assert.match(textOf(r), re);
}

const TRI = {
  inputs: ["x", "y"], outputs: ["z", "w"],
  states: [{ name: "A", outputs: { z: 1 } }, { name: "B" }, { name: "C" }],
  transitions: [{ from: "A", to: "B", condition: "x" }, { from: "B", to: "C", condition: "x" }, { from: "C", to: "A", condition: "!x" }],
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fsm-mcp-h-"));
  client = new Client({ name: "hardening", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--dir", dir], stderr: "ignore" }));
});
after(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("schemas: no $ref, unknown keys are errors instead of being dropped", async () => {
  const { tools } = await client.listTools();
  assert.doesNotMatch(JSON.stringify(tools), /\$ref/);
  for (const t of tools) assert.equal((t.inputSchema as { additionalProperties?: boolean }).additionalProperties, false, t.name);
  for (const t of tools) assert.ok(t.annotations && Object.keys(t.annotations).length, `${t.name} has annotations`);
  await fails("create_fsm", { name: "typo", states: [{ name: "A" }, { name: "B", isInital: true }], transitions: [{ from: "A", to: "B", cond: "x" }] },
    /'isInital' at states\[1\][\s\S]*'cond' at transitions\[0\]/);
  await fails("add_state", { fsm: "typo", name: "A", colour: "red" }, /'colour'/);
});

test("names: length, Windows device names and case-only clashes are refused up front", async () => {
  await fails("create_fsm", { name: "n".repeat(65), states: [{ name: "A" }] }, /at most 64/);
  await fails("create_fsm", { name: "CON", states: [{ name: "A" }] }, /reserved device name/);
  await ok("create_fsm", { name: "seq", states: [{ name: "A" }] });
  await fails("create_fsm", { name: "Seq", states: [{ name: "A" }] }, /only in case/);
});

test("create_fsm: initial state rules, start arrow kept through layout, empty label ignored, x and y together", async () => {
  await fails("create_fsm", { name: "i0", states: [{ name: "A", isInitial: false }, { name: "B", isInitial: false }] }, /mark the reset state/);
  assert.match(await ok("create_fsm", { name: "i1", states: [{ name: "A", isInitial: false }, { name: "B" }] }), /B is the initial state/);
  assert.equal((await load("i1")).states[1].isInitial, true);
  const t = await ok("create_fsm", { name: "tri", ...TRI, states: [{ ...TRI.states[0], initialFrom: "right" }, { name: "B", label: "  " }, { name: "C" }] });
  assert.match(t, /Layout: /);
  const saved = await load("tri");
  assert.equal(saved.states[0].initialAngle, 0, "initialFrom right survives the layout");
  assert.equal(saved.states[1].label, undefined, "blank label means no label");
  await fails("create_fsm", { name: "xy", states: [{ name: "A", x: 5 }] }, /x and y together/);
  await fails("create_fsm", { name: "col", states: [{ name: "A", color: "not a colour" }] }, /is not a colour/);
});

test("get_fsm JSON goes back into create_fsm unchanged, keeping angles", async () => {
  await ok("create_fsm", {
    name: "rt", inputs: ["go"],
    states: [{ name: "IDLE", initialFrom: "above" }, { name: "RUN" }],
    transitions: [{ from: "IDLE", to: "RUN", condition: "go" }, { from: "RUN", to: "RUN", condition: "go", loopSide: "below-right" }, { from: "RUN", to: "IDLE", condition: "!go" }],
  });
  const before = await load("rt");
  await ok("create_fsm", { ...before, overwrite: true });
  const after = await load("rt");
  assert.deepEqual(after, before);
});

test("ids: a state named like another state's id is never edited by mistake", async () => {
  await ok("create_fsm", { name: "ids", states: [{ name: "s1" }, { name: "s0" }], transitions: [{ from: "s0", to: "s1", condition: "go" }] });
  const t = await ok("add_transition", { fsm: "ids", from: "s0", to: "s0", condition: "stay" });
  assert.match(t, /s0 -> s0 when stay/);
  await ok("create_fsm", { name: "m", states: [{ name: "A" }, { name: "B" }] });
  const aId = (await load("m")).states[0].id;
  assert.match(await ok("add_state", { fsm: "m", name: aId }), new RegExp(`State A had the id ${aId}; its id is now s\\d+`));
  assert.match(await ok("remove_state", { fsm: "m", state: aId }), new RegExp(`Removed state ${aId} \\(id`));
  assert.deepEqual((await load("m")).states.map((s: { name: string }) => s.name), ["A", "B"], "A is kept");
  await fails("create_fsm", { name: "dup", states: [{ name: "A", id: "k" }, { name: "B", id: "k" }] }, /Duplicate state id "k"/);
});

test("set_signals: clock clash is refused before saving; a signal can move from outputs to inputs; type change explains stranded outputs", async () => {
  await fails("set_signals", { name: "tri", clock: { name: "x" } }, /"x" is the clock/);
  assert.equal((await load("tri")).clock.name, "clk", "file untouched and still loadable");
  await ok("get_fsm", { name: "tri" });
  await ok("set_signals", { name: "tri", inputs: ["x", "y", "z"], outputs: ["w"] });
  const s = await load("tri");
  assert.deepEqual(s.inputs.map((i: { name: string }) => i.name), ["x", "y", "z"]);
  assert.deepEqual(s.states[0].outputs, {}, "z is no longer an output");
  await ok("set_signals", { name: "tri", outputs: ["w"], type: "mealy" });
  await ok("update_state", { fsm: "tri", state: "A", outputs: { w: 1 } });
  assert.match(await ok("set_signals", { name: "tri", type: "moore" }), /^Updated "tri"\./);
  assert.match(await ok("set_signals", { name: "tri", type: "mealy" }), /1 state still carry outputs/);
  await ok("set_signals", { name: "tri", type: "moore" });
});

test("update_state / update_transition: null removes an output or goes back to the default", async () => {
  await ok("update_state", { fsm: "tri", state: "A", outputs: { w: 1 }, radius: 50, fontSize: 20 });
  await ok("update_state", { fsm: "tri", state: "A", outputs: { w: null }, radius: null, fontSize: null });
  let a = (await load("tri")).states[0];
  assert.deepEqual(a.outputs, {});
  assert.equal(a.radius, undefined);
  assert.equal(a.fontSize, undefined);
  // A placed state may move along one axis; an unplaced one needs both.
  const y = a.y;
  await ok("update_state", { fsm: "tri", state: "A", x: 999 });
  assert.deepEqual([(await load("tri")).states[0].x, (await load("tri")).states[0].y], [999, y]);
  await ok("add_state", { fsm: "tri", name: "LOOSE" });
  await fails("update_state", { fsm: "tri", state: "LOOSE", x: 5 }, /no position yet; give x and y together/);
  await ok("remove_state", { fsm: "tri", state: "LOOSE" });
  await ok("set_signals", { name: "tri", type: "mealy" });
  await ok("update_transition", { fsm: "tri", id: "t0", outputs: { w: 1 }, curve: 40, priority: 2, gap: 10, fontSize: 18 });
  await ok("update_transition", { fsm: "tri", id: "t0", outputs: { w: null }, curve: null, priority: null, gap: null, fontSize: null });
  const t = (await load("tri")).transitions[0];
  assert.deepEqual(t.outputs, {});
  for (const k of ["curve", "priority", "gap", "fontSize"]) assert.equal(t[k], undefined, k);
  assert.match(await ok("update_state", { fsm: "tri", state: "A", isInitial: false }), /no initial \(reset\) state now/);
  await ok("update_state", { fsm: "tri", state: "A", isInitial: true });
  a = (await load("tri")).states[0];
  assert.equal(a.isInitial, true);
});

test("export_fsm never overwrites diagrams, handles folders, checks colours and caps huge PNGs", async () => {
  await fails("export_fsm", { name: "tri", format: "svg", path: "seq.fsm.json" }, /Refusing to write svg/);
  await fails("export_fsm", { name: "tri", format: "json", path: "seq.fsm.json" }, /Refusing to write/);
  assert.equal((await load("seq")).name, "seq", "seq untouched");
  assert.match(await ok("export_fsm", { name: "tri", format: "svg", path: "sub/" }), /Wrote .*sub[\\/]tri\.svg/);
  assert.match(await ok("export_fsm", { name: "tri", format: "svg", path: "sub" }), /Overwrote .*sub[\\/]tri\.svg/);
  assert.match(await ok("export_fsm", { name: "tri", format: "png", path: "wrong.svg" }), /does not end in \.png/);
  await writeFile(join(dir, "afile"), "x");
  await fails("export_fsm", { name: "tri", format: "svg", path: "afile/x.svg" }, /part of that path is a file/);
  await fails("export_fsm", { name: "tri", format: "svg", background: "#zzz" }, /is not a colour/);
  await fails("export_fsm", { name: "tri", format: "png", background: "red;" }, /is not a colour/);
  const svg = await ok("export_fsm", { name: "tri", format: "svg", background: "rgb(10, 20, 30)" });
  assert.match(svg, /fill="rgb\(10, 20, 30\)"/);
  // 30 states far apart at scale 8 would be far above 40 megapixels.
  const states = Array.from({ length: 30 }, (_, i) => ({ name: `Q${i}` }));
  const transitions = states.map((s, i) => ({ from: s.name, to: states[(i + 1) % 30].name, condition: "x" }));
  await ok("create_fsm", { name: "big", inputs: ["x"], states, transitions });
  await ok("auto_layout", { name: "big", spacing: 400 });
  const r = await call("export_fsm", { name: "big", format: "png", scale: 8, path: "big.png" });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /lowered from 8/);
  const png = await readFile(join(dir, "big.png"));
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  assert.ok(w * h <= 40_000_000 && w <= 16384 && h <= 16384, `${w}x${h}`);
});

test("export_fsm says which states it placed", async () => {
  await ok("create_fsm", { name: "part", inputs: ["go"], states: [{ name: "A", x: 100, y: 100 }, { name: "B", x: 300, y: 100 }], transitions: [{ from: "A", to: "B", condition: "go" }] });
  await ok("add_state", { fsm: "part", name: "C" });
  await ok("add_transition", { fsm: "part", from: "B", to: "C", condition: "go" });
  assert.match(await ok("set_line_style", { fsm: "part", from: "A", to: "B", style: "straight" }), /now straight/);
  await fails("set_line_style", { fsm: "part", from: "B", to: "C", style: "straight" }, /C has no position yet/);
  assert.match(await ok("export_fsm", { name: "part", format: "latex" }), /^Placed C, which had no position/);
  assert.ok((await load("part")).states[2].x !== undefined);
});

test("set_line_style: gap is cleared by auto and auto_layout, ignored options are named, the drawn gap limit is reported", async () => {
  await ok("create_fsm", { name: "two", inputs: ["a"], states: [{ name: "P" }, { name: "Q" }], transitions: [{ from: "P", to: "Q", condition: "a" }, { from: "Q", to: "P", condition: "!a" }] });
  assert.match(await ok("set_line_style", { fsm: "two", from: "P", to: "Q", style: "straight", gap: 150 }), /at most \d+ px apart/);
  assert.match(await ok("set_line_style", { fsm: "two", from: "P", to: "Q", style: "curved", gap: 10 }), /gap applies to straight lines only/);
  for (const t of (await load("two")).transitions) assert.equal(t.gap, undefined);
  await ok("set_line_style", { fsm: "two", from: "P", to: "Q", style: "straight", gap: 30 });
  assert.match(await ok("auto_layout", { name: "two" }), /Laid out 2 states/);
  for (const t of (await load("two")).transitions) assert.equal(t.gap, undefined);
  await ok("create_fsm", { name: "one", states: [{ name: "ONLY" }] });
  assert.match(await ok("auto_layout", { name: "one" }), /Laid out 1 state \(/);
});

test("import_verilog: code or path, constants are reported and not flagged, PNG optional, UTF-16 files", async () => {
  const src = `module det(input clk, input rst_n, input go, input [3:0] cnt, output reg hit);
  localparam IDLE = 1'd0, RUN = 1'd1;
  localparam MAX = 4'd9;
  reg state, next;
  always @(posedge clk or negedge rst_n) if (!rst_n) state <= IDLE; else state <= next;
  always @(*) begin
    next = state; hit = 0;
    case (state)
      IDLE: if (go) next = RUN;
      RUN: if (cnt == MAX) begin next = IDLE; hit = 1; end
    endcase
  end
endmodule`;
  await writeFile(join(dir, "det.v"), src);
  await fails("import_verilog", { code: "module a; endmodule", path: "det.v" }, /either code or path/);
  const r = await call("import_verilog", { code: "", path: "det.v", png: false });
  assert.ok(!r.isError, textOf(r));
  assert.ok(!r.content.some((c) => c.type === "image"));
  assert.match(textOf(r), /saved .*det\.fsm\.json/);
  assert.match(textOf(r), /Constants in conditions\/outputs: MAX=4'd9/);
  assert.doesNotMatch(textOf(r), /uses "MAX"/);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(src.replace("module det", "module det16"), "utf16le")]);
  await writeFile(join(dir, "det16.v"), utf16);
  const u = await call("import_verilog", { path: "det16.v", scale: 1 });
  assert.ok(!u.isError, textOf(u));
  assert.match(textOf(u), /Imported module det16/);
  assert.ok(u.content.some((c) => c.type === "image"));
  const bad = src.replace("IDLE: if (go) next = RUN;", "IDLE: if (go) next = RUN").replace("module det", "module det_bad");
  await fails("import_verilog", { code: bad }, /did not parse.*line \d+/s);
});

test("validation: literals and hex-looking names, grouped Moore warnings", async () => {
  await ok("create_fsm", {
    name: "lits", inputs: [{ name: "cnt", width: 8 }], outputs: ["a", "b"],
    states: [{ name: "S0" }, { name: "S1" }, { name: "S2" }],
    transitions: [{ from: "S0", to: "S1", condition: "cnt == 8'h FF" }, { from: "S1", to: "S2", condition: "$signed(cnt) > 1_000" }, { from: "S2", to: "S0", condition: "bad" }],
  });
  const v = await ok("validate_fsm", { name: "lits" });
  assert.doesNotMatch(v, /uses "(h|FF|signed|_000)"/);
  assert.match(v, /uses "bad"/);
  assert.match(v, /Moore output "a" is not set in states S0, S1, S2/);
  assert.equal((v.match(/Moore output/g) ?? []).length, 2);
});

test("leftover files: a failed edit leaves no temp or lock files", async () => {
  await fails("add_transition", { fsm: "tri", from: "A", to: "NOPE" }, /No state/);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(dir)).filter((f) => /\.(tmp-|lock)/.test(f)), []);
  await stat(join(dir, "tri.fsm.json"));
});

// ---- workspace files, locks, command line and resources -----------------------

test("a file whose stored name differs from its file name is loaded under the file name", async () => {
  await ok("create_fsm", { name: "orig", states: [{ name: "A" }] });
  const d = await load("orig");
  d.name = "something_else";
  await writeFile(join(dir, "copied.fsm.json"), "﻿" + JSON.stringify(d));
  assert.match(await ok("get_fsm", { name: "copied" }), /copied/);
  await ok("add_state", { fsm: "copied", name: "B" });
  assert.equal((await load("copied")).name, "copied");
  // A newer file version is refused instead of being silently rewritten.
  await writeFile(join(dir, "future.fsm.json"), JSON.stringify({ ...d, name: "future", version: 2 }));
  await fails("get_fsm", { name: "future" }, /newer FSM Designer/);
});

test("locks: a lock left by an exited process or an old broken lock is taken over; nothing is left behind", async () => {
  const { spawnSync } = await import("node:child_process");
  const { hostname } = await import("node:os");
  const { readdir, utimes } = await import("node:fs/promises");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  await ok("create_fsm", { name: "locked", states: [{ name: "A" }] });
  const lock = join(dir, "locked.fsm.json.lock");
  await writeFile(lock, JSON.stringify({ pid: dead, host: hostname(), token: "old", time: Date.now() }));
  const t0 = Date.now();
  await ok("add_state", { fsm: "locked", name: "B" });
  assert.ok(Date.now() - t0 < 5000, "a dead owner's lock is not waited out");
  await writeFile(lock, "garbage");
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  await ok("add_state", { fsm: "locked", name: "C" });
  assert.deepEqual((await load("locked")).states.map((s: { name: string }) => s.name), ["A", "B", "C"]);
  assert.deepEqual((await readdir(dir)).filter((f) => /\.(lock|stale-)/.test(f)), []);
});

test("list_fsms names entries it cannot use; resources announce new and deleted diagrams; a missing resource is -32002", async () => {
  const { mkdir } = await import("node:fs/promises");
  await writeFile(join(dir, "has space.fsm.json"), "{}");
  await mkdir(join(dir, "folder.fsm.json"), { recursive: true });
  const listed = await ok("list_fsms", {});
  assert.match(listed, /Ignored[^\n]*folder\.fsm\.json/);
  assert.match(listed, /Ignored[^\n]*has space\.fsm\.json/);
  assert.doesNotMatch(listed.split("Ignored")[0], /has space|folder/);

  const { ResourceListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  let changed = 0;
  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => { changed++; });
  await ok("create_fsm", { name: "announced", states: [{ name: "A" }] });
  await ok("create_fsm", { name: "announced", states: [{ name: "A" }], overwrite: true });
  await ok("delete_fsm", { name: "announced" });
  for (let i = 0; i < 50 && changed < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(changed, 2, "created and deleted, not replaced");

  await assert.rejects(client.readResource({ uri: "fsm://announced" }), (e: { code?: number }) => e.code === -32002);
});

test("positions are bounded, add_state says which state stopped being initial, backslash paths work on POSIX", async () => {
  await fails("add_state", { fsm: "locked", name: "FAR", x: 1e9, y: 0 }, /x/);
  assert.match(await ok("add_state", { fsm: "locked", name: "NEW0", isInitial: true }), /as the initial state \(was A\)/);
  if (process.platform !== "win32") {
    await ok("export_fsm", { name: "locked", format: "svg", path: "bs\\sub\\locked.svg" });
    await stat(join(dir, "bs", "sub", "locked.svg"));
  }
});

test("command line: --dir must be a folder; options are checked", async () => {
  const { execFile } = await import("node:child_process");
  const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; err: string }>((res) =>
    execFile(process.execPath, [entry, ...args], { env: { ...process.env, ...env } }, (e, _out, err) => res({ code: (e as { code?: number } | null)?.code ?? 0, err })));
  const file = join(dir, "not-a-folder.txt");
  await writeFile(file, "x");
  const r = await run(["--dir", file]);
  assert.equal(r.code, 2);
  assert.match(r.err, /not a folder|not a directory/i);
  for (const [args, re] of [
    [["--dir", dir, "--dir", dir], /--dir given twice/],
    [["--dir", "--app"], /--dir needs a value/],
    [["--dir", dir, "extra"], /unexpected argument extra/],
    [["--dir", ""], /--dir needs a value/],
  ] as const) {
    const out = await run([...args]);
    assert.equal(out.code, 2, args.join(" "));
    assert.match(out.err, re);
  }
});

test("locks: many servers breaking the same stale lock never lose an edit", async () => {
  const { spawnSync } = await import("node:child_process");
  const { hostname } = await import("node:os");
  const extra = await Promise.all([0, 1].map(async (i) => {
    const c = new Client({ name: `stale-${i}`, version: "0" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--dir", dir], stderr: "ignore" }));
    return c;
  }));
  try {
    await ok("create_fsm", { name: "stale", states: [{ name: "A" }] });
    const clients = [client, ...extra];
    let expected = 1;
    for (let round = 0; round < 12; round++) {
      const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
      await writeFile(join(dir, "stale.fsm.json.lock"), JSON.stringify({ pid: dead, host: hostname(), token: `dead${round}`, time: Date.now() }));
      const rs = await Promise.all(clients.flatMap((c, ci) => [0, 1].map((k) =>
        c.callTool({ name: "add_state", arguments: { fsm: "stale", name: `R${round}_${ci}_${k}` } }) as Promise<Out>)));
      for (const r of rs) assert.ok(!r.isError, textOf(r));
      expected += rs.length;
      assert.equal((await load("stale")).states.length, expected, `round ${round}`);
    }
  } finally {
    await Promise.all(extra.map((c) => c.close()));
  }
});

test("links: a linked diagram is edited in place; a broken link is named; a linked workspace path cannot overwrite a diagram", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp: tmp, symlink, readdir } = await import("node:fs/promises");
  const outside = await tmp(join(tmpdir(), "fsm-mcp-out-"));
  try {
    await ok("create_fsm", { name: "linked", states: [{ name: "A" }] });
    await writeFile(join(outside, "linked.fsm.json"), await readFile(join(dir, "linked.fsm.json")));
    await rm(join(dir, "linked.fsm.json"));
    await symlink(join(outside, "linked.fsm.json"), join(dir, "linked.fsm.json"));
    await ok("add_state", { fsm: "linked", name: "NEW" });
    const { lstat } = await import("node:fs/promises");
    assert.ok((await lstat(join(dir, "linked.fsm.json"))).isSymbolicLink());
    assert.match(await readFile(join(outside, "linked.fsm.json"), "utf8"), /"NEW"/);
    assert.deepEqual((await readdir(outside)).filter((f) => f.includes("tmp-")), []);

    await symlink(join(outside, "gone.fsm.json"), join(dir, "dangling.fsm.json"));
    await fails("get_fsm", { name: "dangling" }, /link to a file that does not exist/);
    assert.match(await ok("list_fsms", {}), /Ignored[^\n]*dangling\.fsm\.json/);

    const alias = join(outside, "ws-alias");
    await symlink(dir, alias);
    await fails("export_fsm", { name: "linked", format: "json", path: join(alias, "tri.fsm.json") }, /Refusing/);
    await fails("export_fsm", { name: "linked", format: "svg", path: "\\\\server\\share\\x.svg" }, /Windows path/);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("import_verilog: states named s0, s1, s2 import", async () => {
  const code = `module lower(input clk, input rst, input x, output reg z);
  localparam s0 = 2'd0, s1 = 2'd1, s2 = 2'd2;
  reg [1:0] state;
  always @(posedge clk) if (rst) state <= s0; else case (state)
    s0: if (x) state <= s1;
    s1: if (x) state <= s2; else state <= s0;
    default: state <= s0;
  endcase
  always @* z = (state == s2);
endmodule`;
  assert.match(await ok("import_verilog", { code, png: false }), /Imported module lower/);
  assert.deepEqual((await load("lower")).states.map((s: { name: string }) => s.name).sort(), ["s0", "s1", "s2"]);
});

test("locks: a live breaker's guard is never taken over; a dead one's is", { skip: process.platform === "win32" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { hostname } = await import("node:os");
  await ok("create_fsm", { name: "guarded", states: [{ name: "A" }] });
  const lock = join(dir, "guarded.fsm.json.lock");
  const guard = `${lock}.break`;
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  await writeFile(lock, JSON.stringify({ pid: dead, host: hostname(), token: "deadlock", time: Date.now() }));
  // This test process is alive: its guard must be waited for, however old it is.
  await writeFile(guard, JSON.stringify({ pid: process.pid, host: hostname(), token: "liveguard", time: 0 }));
  const { utimes } = await import("node:fs/promises");
  const old = new Date(Date.now() - 3_600_000);
  await utimes(guard, old, old);
  const t0 = Date.now();
  const pending = call("add_state", { fsm: "guarded", name: "B" });
  setTimeout(() => { rm(guard, { force: true }); }, 1500);
  const r = await pending;
  assert.ok(!r.isError, textOf(r));
  assert.ok(Date.now() - t0 >= 1400, "waited for the live guard");
  await writeFile(lock, JSON.stringify({ pid: dead, host: hostname(), token: "deadlock2", time: Date.now() }));
  await writeFile(guard, JSON.stringify({ pid: dead, host: hostname(), token: "deadguard", time: Date.now() }));
  const t1 = Date.now();
  await ok("add_state", { fsm: "guarded", name: "C" });
  assert.ok(Date.now() - t1 < 5000, "a dead breaker's guard is cleared");
  assert.equal((await load("guarded")).states.length, 3);
});

test("files: linked names share one lock, devices and pipes are refused, hard links and file modes are kept, odd entries are explained", { skip: process.platform === "win32" }, async () => {
  const { symlink, link, chmod, mkdir, readdir } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  await ok("create_fsm", { name: "real", states: [{ name: "S" }] });
  await symlink(join(dir, "real.fsm.json"), join(dir, "alias.fsm.json"));
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => call("add_state", { fsm: i % 2 ? "alias" : "real", name: `X${i}` })));
  for (const r of rs) assert.ok(!r.isError, textOf(r));
  assert.equal((await load("real")).states.length, 17);

  await fails("import_verilog", { path: "/dev/zero" }, /not a regular file/);
  await fails("export_fsm", { name: "real", format: "svg", path: "/dev/null" }, /not a regular file/);

  const other = join(dir, "elsewhere");
  await mkdir(other, { recursive: true });
  await link(join(dir, "real.fsm.json"), join(other, "copy.fsm.json"));
  await chmod(join(dir, "real.fsm.json"), 0o600);
  await ok("add_state", { fsm: "real", name: "HARD" });
  assert.match(await readFile(join(other, "copy.fsm.json"), "utf8"), /"HARD"/);
  await rm(join(other, "copy.fsm.json"));
  await ok("add_state", { fsm: "real", name: "MODE" });
  assert.equal((await stat(join(dir, "real.fsm.json"))).mode & 0o777, 0o600);

  execFileSync("mkfifo", [join(dir, "pipe.fsm.json")]);
  await symlink(join(dir, "loopb.fsm.json"), join(dir, "loopa.fsm.json"));
  await symlink(join(dir, "loopa.fsm.json"), join(dir, "loopb.fsm.json"));
  const listed = await ok("list_fsms", {});
  assert.match(listed, /pipe\.fsm\.json \(not a regular file\)/);
  assert.match(listed, /loopa\.fsm\.json \(link loop\)/);
  await fails("get_fsm", { name: "pipe" }, /not a regular file/);
  await fails("get_fsm", { name: "loopa" }, /link loop/);
  await ok("delete_fsm", { name: "loopa" });
  await fails("delete_fsm", { name: "folder" }, /folder, not a diagram/);
  assert.ok(!(await readdir(dir)).includes("loopa.fsm.json"));
  for (const f of ["pipe.fsm.json", "loopb.fsm.json", "alias.fsm.json"]) await rm(join(dir, f), { force: true });
});

test("locks are fair: a server editing back to back does not starve another server's call", async () => {
  const other = new Client({ name: "fair", version: "0" });
  await other.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--dir", dir], stderr: "ignore" }));
  try {
    await ok("create_fsm", { name: "busy", states: Array.from({ length: 200 }, (_, i) => ({ name: `S${i}`, x: (i % 20) * 120, y: Math.floor(i / 20) * 120 })) });
    let stop = false;
    const loops = [0, 1].map(async (w) => {
      for (let i = 0; !stop; i++) await call("update_state", { fsm: "busy", state: "S0", label: `w${w}_${i}` });
    });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const r = (await other.callTool({ name: "add_state", arguments: { fsm: "busy", name: "FromOther" } })) as Out;
    const took = Date.now() - t0;
    stop = true;
    await Promise.all(loops);
    assert.ok(!r.isError, textOf(r));
    assert.ok(took < 10_000, `took ${took} ms`);
  } finally {
    await other.close();
  }
});

test("files: hard-linked names share one lock; saving into a pipe is refused; lock files cannot be export targets; temp files of killed servers are cleared", { skip: process.platform === "win32" }, async () => {
  const { link, symlink, readdir } = await import("node:fs/promises");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { hostname } = await import("node:os");
  await ok("create_fsm", { name: "hl", states: [{ name: "A" }] });
  await link(join(dir, "hl.fsm.json"), join(dir, "hl2.fsm.json"));
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => call("add_state", { fsm: i % 2 ? "hl2" : "hl", name: `H${i}` })));
  for (const r of rs) assert.ok(!r.isError, textOf(r));
  assert.equal((await load("hl")).states.length, 17);
  await rm(join(dir, "hl2.fsm.json"));

  const out = await mkdtemp(join(tmpdir(), "fsm-mcp-fifo-"));
  try {
    execFileSync("mkfifo", [join(out, "fifo")]);
    await symlink(join(out, "fifo"), join(dir, "piped.fsm.json"));
    await fails("create_fsm", { name: "piped", states: [{ name: "A" }] }, /not a regular file/);
    await rm(join(dir, "piped.fsm.json"));
  } finally {
    await rm(out, { recursive: true, force: true });
  }

  await fails("export_fsm", { name: "hl", format: "svg", path: "hl.fsm.json.lock" }, /coordinate edits/);

  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  const leftover = `.hl.fsm.json.tmp-${hostname().replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}-${dead}-1`;
  await writeFile(join(dir, leftover), "{}");
  await ok("add_state", { fsm: "hl", name: "AFTER" });
  assert.ok(!(await readdir(dir)).includes(leftover));
});
