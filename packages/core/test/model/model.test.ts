// Document model edge cases found by driving the MCP server: ids versus names,
// duplicate ids, validation of conditions and outputs, escaping in exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addSignal, addState, addTransition, createDiagram, describe, ensureLayout, findState, importVerilog,
  parseDiagram, removeState, removeTransition, renderSvg, texEscape, validate,
} from "../../src/index.ts";

test("auto ids never equal a state name, so names keep meaning one state", () => {
  const d = parseDiagram({ name: "m", states: [{ name: "s1" }, { name: "s0" }], transitions: [{ from: "s0", to: "s1" }] });
  for (const s of d.states) assert.ok(!d.states.some((o) => o !== s && o.name === s.id), JSON.stringify(d.states));
  assert.equal(findState(d, "s0").name, "s0");
  const t = d.transitions[0];
  assert.equal(findState(d, t.from).name, "s0");
  assert.equal(findState(d, t.to).name, "s1");
});

test("a reference that is one state's name and another's id is an error, not a guess", () => {
  const d = parseDiagram({ name: "m", states: [{ name: "A" }, { name: "B" }] });
  const a = findState(d, "A");
  addState(d, { name: a.id }); // e.g. a new state named "s0" while A has id s0
  assert.throws(() => findState(d, a.id), /ambiguous.*Use/);
});

test("older files whose ids cross state names still load, with the same edges", () => {
  // Written by an earlier version: the state named s1 has id s0 and the other way round.
  const d = parseDiagram({
    name: "old",
    states: [{ id: "s0", name: "s1", isInitial: true }, { id: "s1", name: "s0" }],
    transitions: [{ id: "t0", from: "s0", to: "s1", condition: "go" }],
  });
  const t = d.transitions[0];
  const nm = (id: string) => d.states.find((s) => s.id === id)!.name;
  assert.equal(nm(t.from), "s1");
  assert.equal(nm(t.to), "s0");
  assert.doesNotThrow(() => findState(d, "s0"));
});

test("duplicate explicit ids are rejected; given ids win over auto ids", () => {
  assert.throws(() => parseDiagram({ name: "m", states: [{ name: "A", id: "k" }, { name: "B", id: "k" }] }), /Duplicate state id "k"/);
  assert.throws(() => parseDiagram({
    name: "m", states: [{ name: "A" }],
    transitions: [{ id: "t1", from: "A", to: "A" }, { id: "t1", from: "A", to: "A", condition: "x" }],
  }), /Duplicate transition id "t1"/);
  const d = parseDiagram({ name: "m", states: [{ name: "A" }, { name: "B", id: "s0" }, { name: "C" }], transitions: [{ from: "s0", to: "C" }] });
  assert.equal(findState(d, "s0").name, "B");
  assert.equal(new Set(d.states.map((s) => s.id)).size, 3);
  assert.equal(d.states.find((s) => s.id === d.transitions[0].from)!.name, "B");
});

test("ids of deleted states and transitions are not handed out again at once", () => {
  const d = parseDiagram({ name: "m", states: [{ name: "A" }, { name: "B" }, { name: "C" }], transitions: [{ from: "A", to: "B" }, { from: "B", to: "C" }, { from: "C", to: "A" }] });
  const bId = findState(d, "B").id;
  const t1 = d.transitions[1].id;
  removeTransition(d, t1);
  assert.notEqual(addTransition(d, { from: "A", to: "A" }).id, t1);
  removeState(d, "A");
  assert.notEqual(addState(d, { name: "D" }).id, bId);
});

test("condition names: literals and system functions are not inputs, hex-looking names are", () => {
  const d = createDiagram({ name: "v", inputs: ["x", { name: "cnt", width: 4 }] });
  addState(d, { name: "A" });
  for (const c of ["cnt == 8'h FF", "cnt == 2'sd3", "cnt == 1_000", "$signed(cnt) > 3", "cnt == 4 'b10_10", "bad && dead", "x && fe"])
    addTransition(d, { from: "A", to: "A", condition: c });
  const flagged = validate(d).filter((i) => /not a declared input/.test(i.message)).map((i) => /uses "(\w+)"/.exec(i.message)![1]);
  assert.deepEqual(flagged.sort(), ["bad", "dead", "fe"]);
});

test("Moore output warnings: one line per output, none for outputs with a default, and transition outputs are flagged", () => {
  const d = createDiagram({ name: "m", type: "moore", outputs: ["a", "b", { name: "c", default: 1 }] });
  for (const n of ["S0", "S1", "S2"]) addState(d, { name: n });
  addTransition(d, { from: "S0", to: "S1", outputs: { a: 1 } });
  const msgs = validate(d).map((i) => i.message);
  assert.ok(msgs.includes('Moore output "a" is not set in states S0, S1, S2 (uses default 0)'), msgs.join("\n"));
  assert.ok(msgs.some((m) => /Moore output "b"/.test(m)));
  assert.ok(!msgs.some((m) => /"c"/.test(m)), "c has an explicit default");
  assert.ok(msgs.some((m) => /Transition t\d+ set outputs, but this is a Moore machine/.test(m)), msgs.join("\n"));
});

test("signal names: clock and reset are explained, and cannot share a name", () => {
  const d = createDiagram({ name: "m", reset: { name: "rst", activeLow: false } });
  assert.throws(() => addSignal(d, "inputs", "rst"), /"rst" is the reset; it is declared with reset/);
  assert.throws(() => addSignal(d, "inputs", "clk"), /"clk" is the clock/);
  assert.throws(() => addSignal(d, "outputs", "state"), /reserved for the state register/);
  assert.throws(() => createDiagram({ name: "m", clock: { name: "sig" }, reset: { name: "sig" } }), /cannot both be named "sig"/);
});

test("describe prints booleans as the drawing does", () => {
  const d = createDiagram({ name: "m", outputs: ["z"] });
  addState(d, { name: "A", outputs: { z: false } });
  assert.match(describe(d), /outputs: z=0/);
});

test("background text is escaped in the label halos too", () => {
  const d = parseDiagram({ name: "m", inputs: ["x"], states: [{ name: "A", x: 0, y: 0 }, { name: "B", x: 200, y: 0 }], transitions: [{ from: "A", to: "B", condition: "x" }] });
  const svg = renderSvg(d, { background: 'red" onload="alert(1)' });
  assert.doesNotMatch(svg, /onload="/);
  assert.doesNotMatch(renderSvg(d, { background: "<x>" }), /="<x>"/);
});

test("LaTeX text escapes < > | (OT1 would print them as other glyphs)", () => {
  assert.equal(texEscape("a<b|c>"), "a\\textless{}b\\textbar{}c\\textgreater{}");
});

test("rows of new states are spaced by the fitted radius", async () => {
  const d = parseDiagram({ name: "m", states: [{ name: "A", x: 100, y: 100, radius: 64 }, { name: "B", radius: 64 }, { name: "C", radius: 64 }] });
  await ensureLayout(d);
  const [, b, c] = d.states;
  assert.ok(c.x! - b.x! >= 2 * 64 + 60, `${b.x} ${c.x}`);
  assert.ok(b.y! - 100 >= 2 * 64 + 60, `${b.y}`);
});

test("a statement that does not parse is named when no state machine is found", () => {
  const code = `module se(input clk, input rst_n, input x);
  localparam A = 1'd0, B = 1'd1;
  reg s, n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= A; else s <= n;
  always @(*) begin
    n = s;
    case (s)
      A: if (x) n = B
      B: n = A;
    endcase
  end
endmodule`;
  assert.throws(() => importVerilog(code), /No state machine found.*did not parse.*line \d+/s);
});
