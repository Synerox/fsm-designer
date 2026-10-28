// Count sentences in the status bar, the inspector and notices: English nouns
// are singular for 1, and zh/ja keep their own wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createState, createTransition, newDiagram } from "../src/store.ts";
import { useLang } from "../src/i18n.ts";
import { count, diagramSizeText, drewText, selectionSizeText, statusText } from "../src/summary.ts";

test("count picks the singular for exactly 1", () => {
  assert.deepEqual([0, 1, 2].map((n) => count(n, "line")), ["0 lines", "1 line", "2 lines"]);
});

test("multiple selections and diagram sizes say '1 state', not '1 states'", () => {
  useLang.getState().setLang("en");
  const d = newDiagram();
  const a = createState(d, 0, 0), b = createState(d, 100, 0);
  createTransition(d, a.id, b.id);
  const one = { kind: "multi" as const, states: [a.id], edges: [{ from: a.id, to: b.id }], initial: false };
  assert.equal(statusText(d, one), "1 state and 1 line selected");
  assert.equal(statusText(d, { ...one, states: [a.id, b.id], initial: true }), "2 states and 2 lines selected");
  assert.equal(selectionSizeText(one), "1 state, 1 line");
  assert.equal(selectionSizeText({ ...one, edges: [] }), "1 state, 0 lines");
  assert.equal(diagramSizeText(d), "2 states, 1 transition");
  assert.equal(statusText(d, null), "2 states · 1 transition");
  assert.equal(drewText(d), "Drew 2 states and 1 transition from Verilog");
  d.states.pop();
  assert.equal(diagramSizeText(d), "1 state, 1 transition", "the inspector agrees with the status bar");
});

test("zh and ja count text is unchanged", () => {
  const d = newDiagram();
  const a = createState(d, 0, 0);
  const one = { kind: "multi" as const, states: [a.id], edges: [], initial: true };
  try {
    useLang.getState().setLang("zh");
    assert.equal(statusText(d, one), "已選取 1 個狀態、1 條線");
    assert.equal(diagramSizeText(d), "1 個狀態，0 條轉移");
    useLang.getState().setLang("ja");
    assert.equal(selectionSizeText(one), "状態 1 個、線 1 本");
  } finally {
    useLang.getState().setLang("en");
  }
});
