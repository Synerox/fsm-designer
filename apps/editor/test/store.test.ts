// Editor model helpers: text editing rules, transitions, deletion and undo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createState, createTransition, deleteSelection, newDiagram, setInitial, setStateText, useEditor } from "../src/store.ts";

test("typed text becomes the name when it is a plain identifier, else a label", () => {
  const d = newDiagram();
  const s = createState(d, 10, 20);
  assert.equal(s.name, "S0");
  assert.equal(s.label, "", "new states start empty, like Evan's editor");
  setStateText(d, s.id, "IDLE");
  assert.equal(d.states[0].name, "IDLE");
  assert.equal(d.states[0].label, undefined);
  setStateText(d, s.id, "S₁");
  assert.deepEqual([d.states[0].name, d.states[0].label], ["S_1", "S₁"], "Unicode stays a label; the identifier is its ASCII spelling");
  setStateText(d, s.id, "S_1");
  assert.deepEqual([d.states[0].name, d.states[0].label], ["S_1", undefined], "unconverted text is a plain identifier");
  setStateText(d, s.id, "β 2");
  assert.deepEqual([d.states[0].name, d.states[0].label], ["S_1", "β 2"]);
  const t = createState(d, 100, 20);
  setStateText(d, t.id, "S₁");
  assert.deepEqual([d.states[1].name, d.states[1].label], ["S0", "S₁"], "a duplicate identifier is not taken");
});

test("one transition per ordered pair, self loops keep their angle", () => {
  const d = newDiagram();
  const a = createState(d, 0, 0), b = createState(d, 100, 0);
  createTransition(d, a.id, b.id);
  createTransition(d, a.id, b.id);
  createTransition(d, b.id, b.id, 1.5);
  assert.equal(d.transitions.length, 2);
  assert.equal(d.transitions[1].loopAngle, 1.5);
  deleteSelection(d, { kind: "state", id: b.id });
  assert.equal(d.transitions.length, 0);
});

test("start arrow moves to the chosen state", () => {
  const d = newDiagram();
  const a = createState(d, 0, 0), b = createState(d, 100, 0);
  setInitial(d, a.id, Math.PI);
  setInitial(d, b.id, -Math.PI / 2);
  assert.deepEqual(d.states.map((s) => s.isInitial), [false, true]);
  assert.equal(d.states[1].initialAngle, -Math.PI / 2);
  deleteSelection(d, { kind: "initial" });
  assert.ok(d.states.every((s) => !s.isInitial));
});

test("edits are undoable and a coalesced gesture is one step", () => {
  const { edit, undo, redo } = useEditor.getState();
  edit((d) => { createState(d, 0, 0); });
  edit((d) => { d.states[0].x = 5; }, "drag1");
  edit((d) => { d.states[0].x = 9; }, "drag1");
  assert.equal(useEditor.getState().doc.states[0].x, 9);
  undo();
  assert.equal(useEditor.getState().doc.states[0].x, 0);
  redo();
  assert.equal(useEditor.getState().doc.states[0].x, 9);
  undo(); undo();
  assert.equal(useEditor.getState().doc.states.length, 0);
});

test("multi selection: collapse, toggle, select all and delete", async () => {
  const { selectAll, toggleInSelection, multiSelection } = await import("../src/store.ts");
  const d = newDiagram();
  const a = createState(d, 0, 0), b = createState(d, 100, 0), c = createState(d, 200, 0);
  createTransition(d, a.id, b.id);
  createTransition(d, b.id, c.id);
  setInitial(d, a.id, Math.PI);
  assert.deepEqual(multiSelection([a.id], [], false), { kind: "state", id: a.id });
  const all = selectAll(d);
  assert.equal(all?.kind, "multi");
  let sel = toggleInSelection({ kind: "state", id: a.id }, { kind: "edge", from: b.id, to: c.id });
  assert.equal(sel?.kind, "multi");
  sel = toggleInSelection(sel, { kind: "state", id: a.id });
  assert.deepEqual(sel, { kind: "edge", from: b.id, to: c.id });
  deleteSelection(d, multiSelection([b.id], [{ from: a.id, to: b.id }], true));
  assert.deepEqual(d.states.map((s) => s.id), [a.id, c.id]);
  assert.equal(d.transitions.length, 0);
  assert.ok(!d.states.some((s) => s.isInitial));
  deleteSelection(d, all);
  assert.equal(d.states.length, 0);
});

test("copy and paste: states with the transitions between them, fresh names, offset", async () => {
  const { copySelection, pasteClipboard, multiSelection } = await import("../src/store.ts");
  const d = newDiagram();
  const a = createState(d, 0, 0), b = createState(d, 100, 0), c = createState(d, 200, 0);
  setStateText(d, a.id, "IDLE");
  createTransition(d, a.id, b.id);
  createTransition(d, b.id, b.id, 0);
  createTransition(d, b.id, c.id);
  setInitial(d, a.id, Math.PI);
  assert.equal(copySelection(d, { kind: "edge", from: a.id, to: b.id }), 0, "a lone transition is not copied");
  assert.equal(copySelection(d, multiSelection([a.id, b.id], [], false)), 4, "2 states + 2 transitions among them");
  const sel = pasteClipboard(d);
  assert.equal(d.states.length, 5);
  assert.equal(d.transitions.length, 5);
  const [pa, pb] = d.states.slice(3);
  assert.deepEqual([pa.name, pa.x, pa.y, pa.isInitial], ["IDLE_1", 40, 40, false]);
  assert.notEqual(pb.id, b.id);
  assert.ok(d.transitions.some((t) => t.from === pa.id && t.to === pb.id));
  assert.ok(d.transitions.some((t) => t.from === pb.id && t.to === pb.id && t.loopAngle === 0));
  assert.equal(sel?.kind, "multi");
  pasteClipboard(d);
  assert.deepEqual([d.states[5].name, d.states[5].x], ["IDLE_2", 80], "each paste lands further down-right");
  assert.equal(new Set(d.states.map((s) => s.id)).size, d.states.length, "ids stay unique");
});

test("align and spread states", async () => {
  const { alignStates } = await import("../src/store.ts");
  const d = newDiagram();
  const a = createState(d, 0, 10), b = createState(d, 50, 30), c = createState(d, 300, 50);
  const ids = [a.id, b.id, c.id];
  alignStates(d, ids, "row");
  assert.deepEqual(d.states.map((s) => s.y), [30, 30, 30]);
  alignStates(d, ids, "spreadX");
  assert.deepEqual(d.states.map((s) => s.x), [0, 150, 300]);
  alignStates(d, [a.id, b.id], "column", (v) => Math.round(v / 20) * 20);
  assert.deepEqual([d.states[0].x, d.states[1].x], [80, 80], "75 rounded to the grid");
});

test("dragging snaps to other centres first, then the grid", async () => {
  const { snapPoint } = await import("../src/geometry.ts");
  const others = [{ x: 100, y: 0 }, { x: 100, y: 200 }];
  const r = snapPoint({ x: 104, y: 93 }, others, 8, true);
  assert.deepEqual(r.p, { x: 100, y: 100 }, "x lines up with the column, y snaps to the grid");
  assert.deepEqual(r.guides, [{ axis: "x", at: 100, from: 0, to: 200 }]);
  assert.deepEqual(snapPoint({ x: 47, y: 93 }, others, 8, false).p, { x: 47, y: 93 }, "no grid: free");
});

test("line shape: straight, curve and reset", async () => {
  const { setEdgeShape } = await import("../src/store.ts");
  const d = newDiagram();
  const a = createState(d, 0, 0), b = createState(d, 200, 0);
  createTransition(d, a.id, b.id);
  const t = () => d.transitions[0].curve;
  setEdgeShape(d, a.id, b.id, "curve");
  assert.equal(t(), 40, "a lone line gets a default bend (20% of 200)");
  setEdgeShape(d, a.id, b.id, "straight");
  assert.equal(t(), 0);
  createTransition(d, b.id, a.id);
  useEditor.getState().load(d, null);
  useEditor.getState().edit((x) => setEdgeShape(x, a.id, b.id, "curve"));
  assert.ok(useEditor.getState().doc.transitions[0].curve! !== 0, "with an opposite line it takes the automatic bend (inside an edit)");
});

test("box geometry helpers", async () => {
  const { boxOf, segmentHitsBox, circleHitsBox } = await import("../src/geometry.ts");
  const b = boxOf({ x: 10, y: 10 }, { x: 0, y: 0 });
  assert.deepEqual(b, { x0: 0, y0: 0, x1: 10, y1: 10 }, "any drag direction gives the same box");
  assert.ok(segmentHitsBox(b, { x: -5, y: 5 }, { x: 15, y: 5 }), "a line passing through");
  assert.ok(!segmentHitsBox(b, { x: -5, y: 20 }, { x: 15, y: 20 }));
  assert.ok(circleHitsBox(b, { x: 15, y: 5 }, 6) && !circleHitsBox(b, { x: 20, y: 20 }, 6));
});

test("box select adds to the existing selection", async () => {
  const { mergeSelections } = await import("../src/store.ts");
  const sel = mergeSelections({ kind: "state", id: "a" }, { kind: "multi", states: ["a", "b"], edges: [{ from: "a", to: "b" }], initial: false });
  assert.deepEqual(sel, { kind: "multi", states: ["a", "b"], edges: [{ from: "a", to: "b" }], initial: false });
  assert.deepEqual(mergeSelections({ kind: "state", id: "a" }, null), { kind: "state", id: "a" }, "an empty box keeps the selection");
});

test("undo back to the saved document is clean again; redo away from it is not", () => {
  const { load, edit, undo, redo, markSaved } = useEditor.getState();
  load(newDiagram(), null);
  edit((d) => { createState(d, 0, 0); });
  markSaved("a.fsm.json");
  edit((d) => { d.states[0].x = 40; });
  assert.equal(useEditor.getState().dirty, true);
  undo();
  assert.equal(useEditor.getState().dirty, false, "the doc equals the saved file");
  redo();
  assert.equal(useEditor.getState().dirty, true);
  undo(); undo();
  assert.equal(useEditor.getState().dirty, true, "before the save is unsaved too");
  // A diagram that was never saved (an import) stays unsaved even back at its start.
  load(newDiagram(), null);
  useEditor.setState({ dirty: true, savedDoc: null });
  edit((d) => { createState(d, 0, 0); });
  undo();
  assert.equal(useEditor.getState().dirty, true);
});

test("an edit made while a save is in flight stays unsaved", () => {
  const { load, edit, undo, markSaved } = useEditor.getState();
  load(newDiagram(), null);
  edit((d) => { createState(d, 0, 0); });
  const written = useEditor.getState().doc;
  edit((d) => { d.states[0].x = 40; }); // lands before the save returns
  markSaved("a.fsm.json", written);
  assert.equal(useEditor.getState().dirty, true, "the file does not have the move");
  undo();
  assert.equal(useEditor.getState().dirty, false, "back to what was written");
});
