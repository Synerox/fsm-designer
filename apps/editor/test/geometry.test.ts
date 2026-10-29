// Canvas geometry read from planned SVG paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathMidpoint, pathNumbers } from "../src/geometry.ts";

test("path numbers are read with their exponents, and a broken path does not throw", () => {
  // Read as 2 and 300 before, which put the label and hit area in the wrong place.
  assert.deepEqual(pathNumbers("M 100 70 Q 200 -2e+30 300 69"), [100, 70, 200, -2e30, 300, 69]);
  assert.deepEqual(pathMidpoint("M 0 0 Q 50 4e+22 100 0"), { x: 50, y: 2e22 });
  assert.deepEqual(pathNumbers("M.5,-1.5L1e-3 2"), [0.5, -1.5, 0.001, 2]);
  // A plan from a huge hand-edited coordinate: match() found no digits and the canvas crashed.
  assert.deepEqual(pathNumbers("M NaN NaN L Infinity -Infinity"), [NaN, NaN, Infinity, -Infinity]);
  assert.doesNotThrow(() => pathMidpoint("M NaN NaN L NaN NaN"));
});
