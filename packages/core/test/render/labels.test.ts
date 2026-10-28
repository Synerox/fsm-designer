// Label text (Unicode subscripts and greek, typed via shortcuts) and the
// editor's manual loop / start-arrow angles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, addTransition, asciiText, createDiagram, expandShortcut, latexText, planDiagram, prettyText, renderLatex, renderSvg } from "../../src/index.ts";

test("space after a shortcut expands it and is swallowed", () => {
  assert.deepEqual(expandShortcut("S_0", 3), { text: "S₀", caret: 2 });
  assert.deepEqual(expandShortcut("q_{12}x", 6), { text: "q₁₂x", caret: 3 }, "works mid-text");
  assert.deepEqual(expandShortcut("a\\beta", 6), { text: "aβ", caret: 2 });
  assert.deepEqual(expandShortcut("\\Sigma", 6), { text: "Σ", caret: 1 });
  assert.equal(expandShortcut("ab", 2), null, "no shortcut: caller types a space");
  assert.equal(expandShortcut("\\notgreek", 9), null);
  assert.equal(expandShortcut("x_Q", 3), null, "no Unicode subscript for Q");
  assert.equal(expandShortcut("in_1", 4, { subscripts: false }), null);
});

test("asciiText and prettyText convert between forms", () => {
  assert.equal(asciiText("S₀"), "S_0");
  assert.equal(asciiText("q₁₂β"), "q_12beta");
  assert.equal(prettyText("S_0 \\beta"), "S₀ β");
});

test("latexText writes Unicode as TeX and keeps typed text literal", () => {
  assert.equal(latexText("S₀"), "S$_{0}$");
  assert.equal(latexText("β & x"), "$\\beta$ \\& x");
  assert.equal(latexText("in_1"), "in\\_1", "unconverted shortcuts stay as typed");
});

test("labels, loop angle and start-arrow angle reach the exports", () => {
  const d = createDiagram({ name: "m" });
  const a = addState(d, { name: "S0", label: "q₀", x: 100, y: 100, initialAngle: -Math.PI / 2 });
  addState(d, { name: "S1", label: "", x: 250, y: 100, isAccepting: true });
  addTransition(d, { from: "S0", to: "S0", condition: "α", loopAngle: Math.PI / 2 });
  addTransition(d, { from: "S0", to: "S1", condition: "b" });
  const plan = planDiagram(d);
  const loop = plan.edges.find((e) => e.loopAngle !== undefined)!;
  assert.equal(loop.loopAngle, Math.PI / 2);
  assert.deepEqual(loop.lines, ["α"]);
  const arrow = plan.initialArrow!;
  assert.ok(arrow.from.y < a.y! && Math.abs(arrow.from.x - a.x!) < 1e-6, "start arrow comes from above");
  const svg = renderSvg(d);
  assert.ok(svg.includes(">q₀<") && svg.includes(">α<"));
  const tex = renderLatex(d);
  assert.match(tex, /initial where=above/);
  assert.match(tex, /\{q\$_\{0\}\$\}/);
  assert.match(tex, /\{\$\\alpha\$\}/);
});

test("state size ignores text; radius and font sizes are per object", () => {
  const d = createDiagram({ name: "m" });
  addState(d, { name: "A", x: 100, y: 100 });
  addState(d, { name: "A_MUCH_LONGER_NAME", x: 300, y: 100, radius: 45, fontSize: 20 });
  addTransition(d, { from: "A", to: "A", condition: "go", fontSize: 18 });
  const plan = planDiagram(d);
  assert.equal(plan.states[0].r, 30, "long names elsewhere don't grow other states");
  assert.equal(plan.states[1].r, 45);
  assert.match(plan.edges[0].path, / A /, "self loops are circular arcs");
  assert.equal(plan.edges[0].fontSize, 18);
  const svg = renderSvg(d);
  assert.match(svg, /font-size="20" font-weight="600"[^>]*>A_MUCH_LONGER_NAME</);
  assert.match(svg, /font-size="18"[^>]*>go</);
  const tex = renderLatex(d);
  assert.match(tex, /minimum size=2\.25cm, font=\\fontsize\{10\.7pt\}/);
});

test("elseLabels: false draws transitions exactly as typed", () => {
  const d = createDiagram({ name: "m" });
  const a = addState(d, { name: "A", x: 0, y: 0 }), b = addState(d, { name: "B", x: 200, y: 0 }), c = addState(d, { name: "C", x: 0, y: 200 });
  addTransition(d, { from: a.id, to: b.id, condition: "x" });
  addTransition(d, { from: a.id, to: c.id });
  const label = (opts?: { elseLabels?: boolean }) => planDiagram(d, opts).edges.find((e) => e.transitions[0].to === c.id)!.lines;
  assert.deepEqual(label(), ["else"], "default keeps the Verilog-style else");
  assert.deepEqual(label({ elseLabels: false }), []);
  assert.ok(!renderLatex(d, { elseLabels: false }).includes("else"));
});

test("straight lines both ways run side by side instead of overlapping", () => {
  const d = createDiagram({ name: "m" });
  const a = addState(d, { name: "A", x: 0, y: 0 }), b = addState(d, { name: "B", x: 200, y: 0 });
  addTransition(d, { from: a.id, to: b.id, curve: 0 });
  addTransition(d, { from: b.id, to: a.id, curve: 0 });
  const [ab, ba] = planDiagram(d).edges;
  assert.ok(ab.path.includes(" L ") && ba.path.includes(" L "), "both stay straight");
  assert.deepEqual([ab.offset!.y, ba.offset!.y], [-8, 8], "one above, one below");
  assert.equal((renderLatex(d).match(/\\draw\[->\] \(\w+\.-?[\d.]+\) -- /g) ?? []).length, 2, "latex draws the two shifted segments");
  addTransition(d, { from: a.id, to: a.id });
  d.transitions[1].curve = 20;
  assert.equal(planDiagram(d).edges[0].offset, undefined, "only when both are straight");
});

test("the gap between two straight lines can be set on either one", () => {
  const d = createDiagram({ name: "m" });
  const a = addState(d, { name: "A", x: 0, y: 0 }), b = addState(d, { name: "B", x: 200, y: 0 });
  addTransition(d, { from: a.id, to: b.id, curve: 0 });
  addTransition(d, { from: b.id, to: a.id, curve: 0, gap: 30 });
  const [ab, ba] = planDiagram(d).edges;
  assert.deepEqual([ab.offset!.y, ba.offset!.y], [-15, 15]);
  d.transitions[1].gap = 500;
  assert.equal(planDiagram(d).edges[1].offset!.y, 24, "kept inside the circles (0.8 r)");
});
