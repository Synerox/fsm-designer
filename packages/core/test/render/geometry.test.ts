// Edge cases of planDiagram/renderSvg geometry: what labels avoid, odd
// positions and sizes from hand-edited files, and output that must stay
// well-formed whatever the labels contain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, addTransition, createDiagram, planDiagram, renderSvg } from "../../src/index.ts";

type Pt = { x: number; y: number };
/** Does the segment a-b pass through the label rect (centre + size)? */
function segmentInRect(r: { x: number; y: number; w: number; h: number }, a: Pt, b: Pt): boolean {
  for (let i = 0; i <= 50; i++) {
    const x = a.x + ((b.x - a.x) * i) / 50, y = a.y + ((b.y - a.y) * i) / 50;
    if (Math.abs(x - r.x) < r.w / 2 && Math.abs(y - r.y) < r.h / 2) return true;
  }
  return false;
}

test("a label is not placed on the initial arrow", () => {
  // The edge leaves A on the side its start arrow comes from, so the label's
  // first choice (above the line, at its middle) sits on the arrow.
  for (const [bx, by, angle] of [[-120, 40, undefined], [-140, 20, undefined], [20, -140, -Math.PI / 2], [120, 40, 0]] as const) {
    const d = createDiagram({ name: "m" });
    addState(d, { name: "A", x: 0, y: 0, isInitial: true, initialAngle: angle });
    addState(d, { name: "B", x: bx, y: by });
    addTransition(d, { from: "A", to: "B", condition: "go" });
    const plan = planDiagram(d);
    const { from, to } = plan.initialArrow!;
    assert.ok(!segmentInRect(plan.edges[0].label!, from, to), `B at (${bx}, ${by})`);
  }
});

test("an edge between touching or overlapping states still points from A to B", () => {
  for (const bx of [110, 140, 159, 161, 175]) {
    const d = createDiagram({ name: "m" });
    addState(d, { name: "A", x: 100, y: 100 });
    addState(d, { name: "B", x: bx, y: 100 });
    addTransition(d, { from: "A", to: "B" });
    const [x0, , x1] = planDiagram(d).edges[0].path.match(/-?[\d.]+/g)!.map(Number);
    assert.ok(x1 - x0 >= 10, `B at x=${bx}: ${planDiagram(d).edges[0].path}`);
    assert.equal(x1, bx - 31, "the arrow still ends at B's border");
  }
  // A straight line each way, drawn side by side.
  const d = createDiagram({ name: "m" });
  addState(d, { name: "A", x: 100, y: 100 });
  addState(d, { name: "B", x: 130, y: 100 });
  addTransition(d, { from: "A", to: "B", curve: 0 });
  addTransition(d, { from: "B", to: "A", curve: 0 });
  const [ab, ba] = planDiagram(d).edges.map((e) => e.path.match(/-?[\d.]+/g)!.map(Number));
  assert.ok(ab[2] - ab[0] >= 10 && ba[0] - ba[2] >= 10, "both point the right way");
});

test("control characters pasted into labels do not break the SVG", () => {
  const d = createDiagram({ name: "m" });
  d.name = "m\u0007"; // reaches the <title>
  addState(d, { name: "A", label: "ctrl\u0001\u0007\u001f chars", x: 0, y: 0 });
  addState(d, { name: "B", x: 200, y: 0 });
  addTransition(d, { from: "A", to: "B", condition: "a\u000Bb￾" });
  const svg = renderSvg(d);
  assert.doesNotMatch(svg, /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/);
  assert.ok(svg.includes(">ctrl chars<") && svg.includes(">ab<") && svg.includes("<title>m</title>"));
});
