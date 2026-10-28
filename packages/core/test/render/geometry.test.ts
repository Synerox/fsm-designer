// Edge cases of planDiagram/renderSvg geometry: what labels avoid, odd
// positions and sizes from hand-edited files, and output that must stay
// well-formed whatever the labels contain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, addTransition, createDiagram, planDiagram } from "../../src/index.ts";

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
