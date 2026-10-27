// End-to-end: start the real server over stdio and drive it like an agent would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fsm-mcp-"));
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--dir", dir], stderr: "ignore" }));
});
after(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("lists the expected tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ["create_fsm", "list_fsms", "get_fsm", "delete_fsm", "set_signals", "add_state", "update_state", "remove_state",
    "add_transition", "update_transition", "remove_transition", "validate_fsm", "auto_layout", "export_fsm", "import_verilog",
    "set_line_style", "open_in_app"])
    assert.ok(names.includes(n), `missing ${n}`);
});

test("create_fsm builds, lays out and saves a Moore machine", async () => {
  const r = await call("create_fsm", {
    name: "seq101", type: "moore", inputs: ["x"], outputs: ["z"],
    states: [
      { name: "S0", outputs: { z: 0 } }, { name: "S1", outputs: { z: 0 } },
      { name: "S2", outputs: { z: 0 } }, { name: "S3", outputs: { z: 1 }, isAccepting: true },
    ],
    transitions: [
      { from: "S0", to: "S1", condition: "x" }, { from: "S0", to: "S0", condition: "!x" },
      { from: "S1", to: "S1", condition: "x" }, { from: "S1", to: "S2", condition: "!x" },
      { from: "S2", to: "S3", condition: "x" }, { from: "S2", to: "S0", condition: "!x" },
      { from: "S3", to: "S1", condition: "x" }, { from: "S3", to: "S2", condition: "!x" },
    ],
  });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /Validation: OK/);
  const saved = JSON.parse(await readFile(join(dir, "seq101.fsm.json"), "utf8"));
  assert.equal(saved.states.length, 4);
  assert.ok(saved.states.every((s: { x?: number }) => typeof s.x === "number"));
  assert.equal(saved.states[0].isInitial, true);
});

test("create_fsm grows states so long names and outputs fit inside", async () => {
  const outs = (r: number, y: number, g: number) => ({ red: r, yellow: y, green: g });
  const r = await call("create_fsm", {
    name: "traffic3", type: "moore", inputs: ["tick"], outputs: ["red", "yellow", "green"],
    states: [{ name: "RED", outputs: outs(1, 0, 0) }, { name: "GREEN", outputs: outs(0, 0, 1) }, { name: "YELLOW", outputs: outs(0, 1, 0) }],
    transitions: [{ from: "RED", to: "GREEN", condition: "tick" }, { from: "GREEN", to: "YELLOW", condition: "tick" }, { from: "YELLOW", to: "RED", condition: "tick" }],
  });
  assert.ok(!r.isError, textOf(r));
  const saved = JSON.parse(await readFile(join(dir, "traffic3.fsm.json"), "utf8"));
  const radii = saved.states.map((s: { radius?: number }) => s.radius);
  assert.ok(radii.every((v: number | undefined) => typeof v === "number" && v > 30), `radii ${radii}`);
  assert.equal(new Set(radii).size, 1, "one size for every state");
});

test("refuses to overwrite without overwrite: true", async () => {
  const r = await call("create_fsm", { name: "seq101", states: [{ name: "A" }] });
  assert.ok(r.isError);
  assert.match(textOf(r), /already exists/);
});

test("incremental edits", async () => {
  assert.ok(!(await call("add_state", { fsm: "seq101", name: "ERR", color: "#fee2e2" })).isError);
  const t = await call("add_transition", { fsm: "seq101", from: "S3", to: "ERR", condition: "x && y" });
  assert.ok(!t.isError, textOf(t));
  const v = await call("validate_fsm", { name: "seq101" });
  assert.match(textOf(v), /y/); // y is not a declared input
  assert.ok(!(await call("set_signals", { name: "seq101", inputs: ["x", "y"] })).isError);
  assert.ok(!(await call("update_state", { fsm: "seq101", state: "ERR", outputs: { z: 0 } })).isError);
  const id = /Added transition (t\d+)/.exec(textOf(t))![1];
  assert.ok(!(await call("update_transition", { fsm: "seq101", id, priority: 0 })).isError);
  assert.ok(!(await call("auto_layout", { name: "seq101" })).isError);
  const g = await call("get_fsm", { name: "seq101", json: true });
  assert.match(textOf(g), /ERR/);
  const bad = await call("add_transition", { fsm: "seq101", from: "S3", to: "NOPE" });
  assert.ok(bad.isError);
  assert.match(textOf(bad), /No state/);
});

test("exports every format", async () => {
  const png = await call("export_fsm", { name: "seq101", format: "png", path: "out/seq101.png" });
  assert.ok(!png.isError, textOf(png));
  const img = png.content.find((c) => c.type === "image")!;
  assert.equal(img.mimeType, "image/png");
  assert.equal(Buffer.from(img.data!, "base64").subarray(1, 4).toString(), "PNG");
  assert.equal((await readFile(join(dir, "out/seq101.png"))).subarray(1, 4).toString(), "PNG");

  const svg = await call("export_fsm", { name: "seq101", format: "svg", path: "out/seq101.svg" });
  assert.match(textOf(svg), /^Wrote .*seq101\.svg/);
  assert.doesNotMatch(textOf(svg), /<svg/, "with a path the text is not returned unless inline: true");
  assert.match(await readFile(join(dir, "out/seq101.svg"), "utf8"), /<svg[\s\S]*<\/svg>/);
  const both = await call("export_fsm", { name: "seq101", format: "svg", path: "out/seq101.svg", inline: true });
  assert.match(textOf(both), /^Overwrote [\s\S]*<svg[\s\S]*<\/svg>/);
  const tex = await call("export_fsm", { name: "seq101", format: "latex" });
  assert.match(textOf(tex), /\\begin\{tikzpicture\}[\s\S]*\\end\{document\}/);
  const j = await call("export_fsm", { name: "seq101", format: "json" });
  assert.equal(JSON.parse(textOf(j)).name, "seq101");
});

test("verilog export is gone", async () => {
  const r = await call("export_fsm", { name: "seq101", format: "verilog" });
  assert.ok(r.isError);
});

test("import_verilog draws the FSM in a Verilog file and saves it", async () => {
  const code = `module det(input clk, input rst_n, input x, output reg z);
  localparam A = 2'd0, B = 2'd1, C = 2'd2;
  reg [1:0] state, next;
  always @(posedge clk or negedge rst_n) if (!rst_n) state <= A; else state <= next;
  always @(*) begin
    next = state; z = 0;
    case (state)
      A: if (x) next = B;
      B: if (!x) next = C;
      C: begin next = x ? B : A; z = x; end
    endcase
  end
endmodule`;
  const r = await call("import_verilog", { code, name: "det_from_v" });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /Mealy machine/);
  assert.match(textOf(r), /C -> B when x \/ z=1/);
  assert.ok(r.content.some((c) => c.type === "image" && c.mimeType === "image/png"));
  const saved = JSON.parse(await readFile(join(dir, "det_from_v.fsm.json"), "utf8"));
  assert.equal(saved.type, "mealy");
  assert.deepEqual(saved.states.map((s: { name: string }) => s.name), ["A", "B", "C"]);
  const bad = await call("import_verilog", { code: "module m(input a, output b); assign b = a; endmodule" });
  assert.ok(bad.isError);
  assert.match(textOf(bad), /No state machine found/);
});

test("mealy machine, list, resources and delete", async () => {
  const r = await call("create_fsm", {
    name: "edge", type: "mealy", inputs: ["d"], outputs: ["rise"], layout: true,
    states: [{ name: "LOW" }, { name: "HIGH" }],
    transitions: [
      { from: "LOW", to: "HIGH", condition: "d", outputs: { rise: 1 } }, { from: "LOW", to: "LOW", condition: "!d", outputs: { rise: 0 } },
      { from: "HIGH", to: "LOW", condition: "!d", outputs: { rise: 0 } }, { from: "HIGH", to: "HIGH", condition: "d", outputs: { rise: 0 } },
    ],
  });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(await call("list_fsms", {})), /edge \(mealy, 2 states, 4 transitions\)/);
  const res = await client.listResources();
  assert.ok(res.resources.some((x) => x.uri === "fsm://edge"));
  const read = await client.readResource({ uri: "fsm://edge" });
  assert.equal(JSON.parse((read.contents[0] as { text: string }).text).type, "mealy");
  assert.ok(!(await call("delete_fsm", { name: "edge" })).isError);
  assert.doesNotMatch(textOf(await call("list_fsms", {})), /edge/);
});

test("styling fields: labels, sizes, start arrow and loop sides", async () => {
  const r = await call("create_fsm", {
    name: "styled", inputs: ["a"],
    states: [{ name: "S0", label: "S₀", radius: 40, fontSize: 18, initialFrom: "above", color: "#dbeafe" }, { name: "S1" }],
    transitions: [
      { from: "S0", to: "S1", condition: "a", fontSize: 16 }, { from: "S1", to: "S0", condition: "!a" },
      { from: "S1", to: "S1", condition: "a", loopSide: "right" },
    ],
  });
  assert.ok(!r.isError, textOf(r));
  const saved = JSON.parse(await readFile(join(dir, "styled.fsm.json"), "utf8"));
  const s0 = saved.states[0];
  assert.equal(s0.label, "S₀");
  assert.equal(s0.radius, 40);
  assert.equal(s0.fontSize, 18);
  assert.equal(s0.initialAngle, -Math.PI / 2);
  assert.equal(saved.transitions[0].fontSize, 16);
  assert.equal(saved.transitions[2].loopAngle, 0);
  assert.match(textOf(await call("export_fsm", { name: "styled", format: "svg" })), /S₀/);
  assert.ok(!(await call("update_state", { fsm: "styled", state: "S0", label: "" })).isError);
  const after = JSON.parse(await readFile(join(dir, "styled.fsm.json"), "utf8"));
  assert.equal(after.states[0].label, undefined);
});

test("auto_layout has one rule; labels and spacing still apply", async () => {
  const r = await call("auto_layout", { name: "seq101" });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /Laid out \d+ states/);
  assert.ok(!(await call("auto_layout", { name: "seq101", labels: "none", spacing: 60 })).isError);
});

test("set_line_style makes two-way lines straight and parallel, curved, or automatic", async () => {
  const load = async () => JSON.parse(await readFile(join(dir, "styled.fsm.json"), "utf8")).transitions.slice(0, 2);
  let r = await call("set_line_style", { fsm: "styled", from: "S0", to: "S1", style: "straight", gap: 30 });
  assert.ok(!r.isError, textOf(r));
  for (const t of await load()) { assert.equal(t.curve, 0); assert.equal(t.gap, 30); }
  const svg = textOf(await call("export_fsm", { name: "styled", format: "svg" }));
  assert.match(svg, /<svg/);
  r = await call("set_line_style", { fsm: "styled", from: "S1", to: "S0", style: "curved" });
  assert.ok(!r.isError, textOf(r));
  const [c0, c1] = await load();
  assert.ok(c0.curve !== 0 && c0.curve === c1.curve, JSON.stringify([c0, c1]));
  assert.ok(!(await call("set_line_style", { fsm: "styled", from: "S0", to: "S1", style: "auto" })).isError);
  for (const t of await load()) assert.equal(t.curve, undefined);
  assert.ok((await call("set_line_style", { fsm: "styled", from: "S0", to: "S0", style: "straight" })).isError);
});

test("export can hide line labels", async () => {
  const count = (s: string) => (s.match(/<text/g) ?? []).length;
  const all = textOf(await call("export_fsm", { name: "styled", format: "svg" }));
  const none = textOf(await call("export_fsm", { name: "styled", format: "svg", labels: "none" }));
  const noLoops = textOf(await call("export_fsm", { name: "styled", format: "svg", labels: "noLoops" }));
  assert.ok(count(none) < count(noLoops) && count(noLoops) < count(all), `${count(none)} ${count(noLoops)} ${count(all)}`);
  assert.doesNotMatch(none, />!a</);
  const tex = textOf(await call("export_fsm", { name: "styled", format: "latex", labels: "none" }));
  assert.doesNotMatch(tex, /ttfamily/);
  const png = await call("export_fsm", { name: "styled", format: "png", labels: "none" });
  assert.ok(!png.isError, textOf(png));
});

test("create_fsm rejects more than one initial state", async () => {
  const r = await call("create_fsm", { name: "twoinit", states: [{ name: "P", isInitial: true }, { name: "Q", isInitial: true }] });
  assert.ok(r.isError);
  assert.match(textOf(r), /Only one state can be the initial state.*P, Q/);
});

test("conditions that are not Verilog expressions are flagged, not rejected", async () => {
  const t = await call("add_transition", { fsm: "styled", from: "S0", to: "S1", condition: "a &&" });
  assert.ok(!t.isError, textOf(t));
  assert.match(textOf(t), /not a valid Verilog expression/);
  assert.match(textOf(await call("validate_fsm", { name: "styled" })), /warning Transition t\d+ \(S0 -> S1\): condition "a &&"/);
  const id = /Added transition (t\d+)/.exec(textOf(t))![1];
  const u = await call("update_transition", { fsm: "styled", id, condition: "a && !a" });
  assert.doesNotMatch(textOf(u), /not a valid/);
  assert.ok(!(await call("remove_transition", { fsm: "styled", id })).isError);
});

test("import_verilog needs overwrite to replace an FSM and explains missing files", async () => {
  const code = `module det2(input clk, input rst_n, input x, output reg z);
  localparam A = 1'd0, B = 1'd1;
  reg state;
  always @(posedge clk or negedge rst_n) if (!rst_n) state <= A; else case (state) A: if (x) state <= B; B: if (!x) state <= A; endcase
  always @(*) z = state == B;
endmodule`;
  const first = await call("import_verilog", { code, name: "det_from_v" });
  assert.ok(first.isError, textOf(first));
  assert.match(textOf(first), /already exists.*overwrite: true/);
  assert.ok(!(await call("import_verilog", { code, name: "det_from_v", overwrite: true })).isError);
  const bad = await call("import_verilog", { code, name: "my fsm" });
  assert.ok(bad.isError);
  assert.match(textOf(bad), /letters, digits and _/);
  const missing = await call("import_verilog", { path: "missing.v" });
  assert.ok(missing.isError);
  assert.match(textOf(missing), /File not found: .*missing\.v/);
  const folder = await call("import_verilog", { path: "." });
  assert.ok(folder.isError);
  assert.match(textOf(folder), /is a folder/);
});

test("concurrent edits from one and from two server processes are all kept", async () => {
  assert.ok(!(await call("create_fsm", { name: "race", states: [{ name: "S" }] })).isError);
  const other = new Client({ name: "e2e-2", version: "0" });
  await other.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--dir", dir], stderr: "ignore" }));
  try {
    const results = await Promise.all([
      ...Array.from({ length: 12 }, (_, i) => call("add_state", { fsm: "race", name: `A${i}` })),
      ...Array.from({ length: 12 }, (_, i) => other.callTool({ name: "add_state", arguments: { fsm: "race", name: `B${i}` } }) as Promise<Out>),
      ...Array.from({ length: 6 }, (_, i) => other.callTool({ name: "add_transition", arguments: { fsm: "race", from: "S", to: "S", condition: `c${i}` } }) as Promise<Out>),
    ]);
    for (const r of results) assert.ok(!r.isError, textOf(r));
  } finally {
    await other.close();
  }
  const saved = JSON.parse(await readFile(join(dir, "race.fsm.json"), "utf8"));
  assert.equal(saved.states.length, 25);
  assert.equal(saved.transitions.length, 6);
  const leftovers = (await readdir(dir)).filter((f) => f.startsWith("race.fsm.json."));
  assert.deepEqual(leftovers, [], "no temp or lock files left behind");
});

test("a corrupt diagram file is reported, not fatal", async () => {
  await writeFile(join(dir, "broken.fsm.json"), "{ not json");
  await writeFile(join(dir, "halfbroken.fsm.json"), JSON.stringify({ name: "halfbroken", states: [{ name: "A" }], transitions: [{ from: "A", to: "ZZ" }] }));
  const list = textOf(await call("list_fsms", {}));
  assert.match(list, /broken \(unreadable: .*not a valid FSM diagram/);
  assert.match(list, /halfbroken \(unreadable: .*ZZ/);
  const r = await call("get_fsm", { name: "broken" });
  assert.ok(r.isError);
  assert.match(textOf(r), /broken\.fsm\.json is not a valid FSM diagram/);
  // A corrupt file can still be deleted by name.
  assert.ok(!(await call("delete_fsm", { name: "broken" })).isError);
  assert.ok(!(await call("delete_fsm", { name: "halfbroken" })).isError);
  assert.doesNotMatch(textOf(await call("list_fsms", {})), /broken/);
});

test("command line: --help, --version and bad options", async () => {
  const { execFile } = await import("node:child_process");
  const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((res) =>
    execFile(process.execPath, [entry, ...args], (e, out, err) => res({ code: (e as { code?: number } | null)?.code ?? 0, out, err })));
  assert.match((await run(["--help"])).out, /Usage: fsm-mcp-server/);
  assert.match((await run(["--version"])).out, /^\d+\.\d+\.\d+/);
  const noValue = await run(["--dir"]);
  assert.equal(noValue.code, 2);
  assert.match(noValue.err, /--dir needs a value/);
  const unknown = await run(["--bogus"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown option --bogus/);
});

test("open_in_app starts the desktop app on the diagram file", { skip: process.platform === "win32" }, async () => {
  const fake = join(dir, "fake-app.sh");
  const log = join(dir, "opened.txt");
  await writeFile(fake, `#!/bin/sh\necho "$1" > "${log}"\n`);
  await chmod(fake, 0o755);
  const c = new Client({ name: "e2e-app", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--dir", dir, "--app", fake], stderr: "ignore" }));
  try {
    const r = (await c.callTool({ name: "open_in_app", arguments: { name: "styled" } })) as Out;
    assert.ok(!r.isError, textOf(r));
    for (let i = 0; i < 50; i++) {
      try { if ((await readFile(log, "utf8")).trim()) break; } catch { /* not yet */ }
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal((await readFile(log, "utf8")).trim(), join(dir, "styled.fsm.json"));
    const missing = (await c.callTool({ name: "open_in_app", arguments: { name: "nope" } })) as Out;
    assert.ok(missing.isError);
  } finally {
    await c.close();
  }
  const r = await call("open_in_app", { name: "styled" }); // default server: no app installed here
  if (r.isError) assert.match(textOf(r), /--app/);
});
