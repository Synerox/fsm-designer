// TikZ export details: node names, edge geometry, label fonts, loop angles and label text (Greek, symbols, CJK).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, addTransition, asciiText, createDiagram, latexText, parseDiagram, prettyText, renderLatex } from "../../src/index.ts";
import type { Transition } from "../../src/index.ts";

/** Every `\node[state...] (name) at (x, y)` of the output, by name. */
function stateNodes(tex: string): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const m of tex.matchAll(/\\node\[state[^\]]*\] \(([^)]*)\) at \((-?[\d.]+), (-?[\d.]+)\)/g)) out.set(m[1], { x: Number(m[2]), y: Number(m[3]) });
  return out;
}

test("latex node names stay distinct when ids differ only in punctuation or script", () => {
  const d = parseDiagram({
    name: "ids",
    states: [
      { id: "a-1", name: "A", x: 0, y: 0, isInitial: true },
      { id: "a1", name: "B", x: 200, y: 0 },
      { id: "---", name: "C", x: 400, y: 0 },
      { id: "空闲", name: "D", x: 600, y: 0 },
      { id: "s4", name: "E", x: 800, y: 0 },
    ],
    transitions: [
      { from: "a-1", to: "a1" },
      { from: "---", to: "空闲" },
    ],
  });
  const tex = renderLatex(d);
  const nodes = stateNodes(tex);
  assert.equal(nodes.size, 5, `one node name per state: ${[...nodes.keys()].join(" ")}`);
  assert.ok(![...nodes.keys()].includes(""), "no empty node name");
  assert.equal(nodes.get("a1")?.x, 5, "a plain alphanumeric id keeps its own name");
  assert.ok(nodes.has("s4"), "editor-style ids are kept as they are");
  // Each edge joins the two circles it was drawn between.
  const at = (x: number) => [...nodes].find(([, p]) => p.x === x)![0];
  assert.match(tex, new RegExp(`\\(${at(0)}\\) edge\\[\\] \\(${at(5)}\\)`));
  assert.match(tex, new RegExp(`\\(${at(10)}\\) edge\\[\\] \\(${at(15)}\\)`));
});

test("latex reports a transition with non-numeric geometry instead of crashing", () => {
  const d = createDiagram({ name: "m" });
  addState(d, { name: "A", x: 0, y: 0, isInitial: true });
  addState(d, { name: "B", x: 200, y: 0 });
  const t = addTransition(d, { from: "A", to: "B" });
  (t as Transition & { curve: unknown }).curve = "abc"; // as a hand-edited .fsm.json can hold
  assert.throws(() => renderLatex(d), /A -> B has no valid geometry/);
});
