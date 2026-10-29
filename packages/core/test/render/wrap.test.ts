// Wrapping long transition labels: a division in a condition is not the
// " / " that puts Mealy outputs on a line of their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, addTransition, createDiagram, labelLines, planDiagram } from "../../src/index.ts";

const COND = "cnt / 2 == 3 && data_valid && ready_in && a";

function linesOf(type: "moore" | "mealy", condition: string, outputs: Record<string, number> = {}) {
  const d = createDiagram({ name: "m", type, outputs: Object.keys(outputs).map((name) => ({ name, width: 4 })) });
  addState(d, { name: "A", x: 0, y: 0 });
  addState(d, { name: "B", x: 300, y: 0 });
  addTransition(d, { from: "A", to: "B", condition, outputs });
  return planDiagram(d).edges[0].lines;
}

test("a long Moore condition with a division is wrapped at && only", () => {
  assert.deepEqual(linesOf("moore", COND), ["cnt / 2 == 3 && data_valid &&", "ready_in && a"]);
});

test("a long Mealy label puts only its outputs after the slash line", () => {
  assert.deepEqual(linesOf("mealy", COND, { z: 1 }), ["cnt / 2 == 3 && data_valid &&", "ready_in && a", "/ z=1"]);
  assert.deepEqual(linesOf("mealy", COND), ["cnt / 2 == 3 && data_valid &&", "ready_in && a"], "Mealy without outputs");
  assert.deepEqual(labelLines(`${COND} / z=1`), ["cnt / 2 == 3 && data_valid &&", "ready_in && a", "/ z=1"], "the joined form too");
});

test("short labels and plain long ones wrap as before", () => {
  assert.deepEqual(linesOf("mealy", "x", { z: 0 }), ["x / z=0"]);
  assert.deepEqual(linesOf("mealy", "(aaaaaaaa && bbbbbbbbbb) || (cccccccccc && dddddddd)", { z: 1 }), ["(aaaaaaaa && bbbbbbbbbb) ||", "(cccccccccc && dddddddd)", "/ z=1"]);
  assert.deepEqual(linesOf("mealy", "", { zzzzzzzzzz: 1, yyyyyyyyyy: 2, xxxxxxxxxx: 3 }), ["/ zzzzzzzzzz=1, yyyyyyyyyy=2, xxxxxxxxxx=3"]);
});

test("transitionLines gives each transition's drawn lines, a division in a long Moore condition kept on one line", async () => {
  const { transitionLines } = await import("../../src/index.ts");
  const d = createDiagram({ name: "m", type: "moore" });
  addState(d, { name: "A", x: 0, y: 0 });
  addState(d, { name: "B", x: 300, y: 0 });
  const long = addTransition(d, { from: "A", to: "B", condition: "counter_value == LIMIT / 2 + OFFSET_VALUE" });
  const go = addTransition(d, { from: "A", to: "B", condition: "go" });
  assert.deepEqual(transitionLines(d, long), ["counter_value == LIMIT / 2 + OFFSET_VALUE"], "no || or && to break at");
  assert.deepEqual(planDiagram(d).edges[0].lines, [...transitionLines(d, long), ...transitionLines(d, go)]);
  assert.notDeepEqual(labelLines("counter_value == LIMIT / 2 + OFFSET_VALUE"), transitionLines(d, long), "the joined form cannot tell");
});
