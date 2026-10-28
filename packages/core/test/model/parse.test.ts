// parseDiagram and the add/update functions: malformed fields are refused with
// an FsmError that names the field, instead of being kept and breaking the
// renderer later. Diagrams come from hand-written and agent-written JSON too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, addTransition, createDiagram, FsmError, parseDiagram, renderSvg, updateState, updateTransition } from "../../src/index.ts";

const base = { version: 1, name: "m", type: "moore", inputs: ["a"], outputs: ["z"] };
const parse = (extra: object) => parseDiagram({ ...base, ...extra });
const refused = (fn: () => unknown, msg: RegExp) => assert.throws(fn, (e: unknown) => e instanceof FsmError && msg.test(e.message));

test("names must be strings: a missing, null, true or array name is refused, not stringified", () => {
  refused(() => parse({ states: [{ id: "s0" }] }), /^states\[0\]: State name undefined must be a valid Verilog identifier/);
  refused(() => parse({ states: [{ name: "A" }, { name: null }] }), /^states\[1\]: State name null/);
  refused(() => parse({ states: [{ name: true }] }), /State name true/);
  refused(() => parse({ states: [{ name: ["IDLE"] }] }), /State name \["IDLE"\]/);
  refused(() => parse({ inputs: [{}], states: [] }), /^inputs\[0\]: Signal name undefined/);
  refused(() => parse({ outputs: [null], states: [] }), /^outputs\[0\]: A signal must be a name/);
  refused(() => parse({ name: 5, states: [] }), /Diagram name 5/);
  refused(() => parse({ clock: { name: ["clk"] }, states: [] }), /Clock\/reset name \["clk"\]/);
  const d = parse({ states: [{ name: "A" }] });
  refused(() => updateState(d, "A", { name: null as unknown as string }), /State name null must be a valid Verilog identifier/);
});

test("a null clock or reset name keeps the default, like any other null field", () => {
  const d = parse({ clock: { name: null }, reset: { name: "rst", activeLow: null }, states: [] });
  assert.deepEqual(d.clock, { name: "clk" });
  assert.deepEqual(d.reset, { name: "rst", activeLow: true, async: true });
});

test("createDiagram: reset fields given as undefined keep their defaults", () => {
  assert.deepEqual(createDiagram({ reset: { activeLow: undefined } }).reset, { name: "rst_n", activeLow: true, async: true });
  refused(() => createDiagram({ reset: { activeLow: "yes" as unknown as boolean } }), /reset.activeLow must be true or false/);
});

test("a clock given as a string is refused instead of spread into its characters", () => {
  refused(() => parse({ clock: "clk", states: [] }), /clock must be an object/);
});

test("label: null means no label; any other non-text label is refused", () => {
  const d = parse({ states: [{ name: "A", label: null, x: 50, y: 50 }] });
  assert.equal("label" in d.states[0], false);
  refused(() => parse({ states: [{ name: "A", label: 5 }] }), /^states\[0\]: State "A": label must be text, got 5/);
  refused(() => updateState(d, "A", { label: {} as unknown as string }), /label must be text/);
  renderSvg(d); // draws, no TypeError
});

test("geometry fields must be finite numbers in range; null means not given", () => {
  const d = parse({ states: [{ name: "A", x: null, y: null }] });
  assert.equal("x" in d.states[0] || "y" in d.states[0], false, "x:null is unplaced, not placed at 0");
  refused(() => parse({ states: [{ name: "A", x: "100", y: 0 }] }), /State "A": x must be a finite number, got "100"/);
  refused(() => parse({ states: [{ name: "A", radius: -10 }] }), /radius must be a positive number, got -10/);
  refused(() => parse({ states: [{ name: "A", fontSize: 0 }] }), /fontSize must be a positive number/);
  refused(() => parse({ states: [{ name: "A", initialAngle: "left" }] }), /initialAngle must be a finite number/);
  refused(() => parse({ states: [{ name: "A", color: 5 }] }), /color must be text/);
  const two = { states: [{ id: "s0", name: "A" }, { id: "s1", name: "B" }] };
  refused(() => parse({ ...two, transitions: [{ from: "s0", to: "s0", loopAngle: "1.5" }] }), /^transitions\[0\]: Transition A -> A: loopAngle must be a finite number/);
  refused(() => parse({ ...two, transitions: [{ from: "s0", to: "s1", curve: "20" }] }), /curve must be a finite number/);
  refused(() => parse({ ...two, transitions: [{ from: "s0", to: "s1", gap: -1 }] }), /gap must be a non-negative number/);
  refused(() => parse({ ...two, transitions: [{ from: "s0", to: "s1", fontSize: "13" }] }), /fontSize must be a positive number/);
});

test("updates refuse NaN and Infinity (they would save as null) and leave the object unchanged", () => {
  const d = parse({ states: [{ name: "A", x: 10, y: 20 }, { name: "B" }], transitions: [{ from: "A", to: "B" }] });
  refused(() => updateState(d, "A", { y: 5, x: NaN }), /x must be a finite number, got NaN/);
  assert.equal(d.states[0].y, 20, "nothing applied from a refused patch");
  refused(() => updateTransition(d, d.transitions[0].id, { condition: "a", priority: Infinity }), /priority must be a finite number/);
  assert.equal(d.transitions[0].condition, "");
  // null removes a field, back to its default.
  updateState(d, "A", { radius: 40 });
  updateState(d, "A", { radius: null as unknown as number, x: null as unknown as number });
  assert.equal("radius" in d.states[0] || "x" in d.states[0], false);
  updateState(d, "A", { color: "" });
  assert.equal("color" in d.states[0], false, "no color key left holding undefined");
});

test("malformed shapes give an FsmError that says where, not a TypeError", () => {
  refused(() => parse({ states: { A: {} } }), /"states" must be a list/);
  refused(() => parse({ states: [null] }), /^states\[0\] must be an object, got null/);
  refused(() => parse({ states: [{ name: "A" }], transitions: [5] }), /^transitions\[0\] must be an object/);
  refused(() => parse({ states: [{ name: "A" }], transitions: [{ from: "A", to: "A", condition: 5 }] }), /condition must be text, got 5/);
  refused(() => parse({ inputs: "a", states: [] }), /"inputs" must be a list/);
  refused(() => parseDiagram([]), /must be an object/);
  refused(() => parseDiagram("hello"), /not valid JSON/);
  refused(() => parse({ states: [{ name: "A", outputs: [1] }] }), /Outputs must be an object/);
});

test("JSON that is not a diagram is refused instead of opening as an empty one", () => {
  refused(() => parseDiagram({}), /Not an FSM Designer diagram/);
  refused(() => parseDiagram({ name: "fsm-designer", version: "0.1.0", private: true }), /Not an FSM Designer diagram \(version "0.1.0"\)/);
  refused(() => parseDiagram({ version: 3, states: [] }), /version 3, from a newer FSM Designer/);
  assert.equal(parseDiagram({ version: 1 }).states.length, 0, "a saved empty diagram still opens");
  assert.equal(parseDiagram({ states: [] }).states.length, 0, "and so does an agent-made one without a version");
});

test("two initial states are refused; boolean flags must be booleans", () => {
  refused(() => parse({ states: [{ name: "A", isInitial: true }, { name: "B", isInitial: true }] }), /States "A", "B" are all marked initial/);
  refused(() => parse({ states: [{ name: "A", isInitial: true }, { name: "B", isInitial: "false" }] }), /isInitial must be true or false, got "false"/);
  refused(() => parse({ states: [{ name: "A", isAccepting: "no" }] }), /isAccepting must be true or false/);
  const d = parse({ states: [{ name: "A" }, { name: "B", isInitial: true }] });
  assert.deepEqual(d.states.map((s) => s.isInitial), [false, true]);
});

test("output values must be numbers, text or booleans; null in an update removes the output", () => {
  refused(() => parse({ states: [{ name: "A", outputs: { z: { v: 1 } } }] }), /Output "z" must be a number, text or true\/false/);
  refused(() => parse({ states: [{ name: "A", outputs: { z: [1, 0] } }] }), /Output "z"/);
  refused(() => parse({ outputs: [{ name: "z", default: {} }], states: [] }), /Signal "z" default must be/);
  const d = parse({ states: [{ name: "A", outputs: { z: null } }, { name: "B", outputs: { z: 1 } }] });
  assert.deepEqual(d.states[0].outputs, {});
  for (const off of [undefined, null]) {
    updateState(d, "B", { outputs: { z: 1 } });
    updateState(d, "B", { outputs: { z: off as unknown as number } });
    assert.equal("z" in d.states[1].outputs, false);
  }
  d.states.forEach((s, i) => { s.x = i * 100; s.y = 0; });
  assert.doesNotMatch(renderSvg(d), /z=(undefined|null)/);
  const m = createDiagram({ type: "mealy", inputs: ["a"], outputs: ["y"] });
  addState(m, { name: "A" });
  const t = addTransition(m, { from: "A", to: "A", outputs: { y: 1 } });
  updateTransition(m, t.id, { outputs: { y: null as unknown as number } });
  assert.deepEqual(t.outputs, {});
});
