// fitStateSizes: circles grow so names and state outputs fit, never shrink.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitStateSizes, parseDiagram, STATE_RADIUS } from "../../src/index.ts";

const diagram = (states: unknown[]) => parseDiagram({ name: "t", type: "moore", inputs: [], outputs: [{ name: "red" }, { name: "yellow" }, { name: "green" }], states, transitions: [] });

test("short names keep the default size", () => {
  const d = diagram([{ name: "S0" }, { name: "S1" }]);
  fitStateSizes(d);
  assert.ok(d.states.every((s) => s.radius === undefined));
});

test("long names and three outputs grow every state to one size", () => {
  const o = (r: number, y: number, g: number) => ({ red: r, yellow: y, green: g });
  const d = diagram([{ name: "RED", outputs: o(1, 0, 0) }, { name: "YELLOW", outputs: o(0, 1, 0) }]);
  fitStateSizes(d);
  const [a, b] = d.states.map((s) => s.radius);
  assert.ok(a !== undefined && a > STATE_RADIUS);
  assert.equal(a, b);
});

test("a state already bigger than needed is left alone", () => {
  const d = diagram([{ name: "GOT_101" }, { name: "S0", radius: 80 }]);
  fitStateSizes(d);
  assert.equal(d.states[1].radius, 80);
  assert.ok(d.states[0].radius! > STATE_RADIUS);
});
