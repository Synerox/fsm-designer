// What makes a laid-out diagram look messy, counted from the drawing itself
// (planDiagram's lines and labels), not from the layout's own score: the
// benchmark measures every version of the layout code with this one ruler.

import { planDiagram, stateRadius } from "../../packages/core/src/index.ts";
import type { FsmDiagram, PlanOptions } from "../../packages/core/src/index.ts";

interface Pt { x: number; y: number }

export interface Mess {
  /** Lines crossing each other or the start arrow (outside the states). */
  crossings: number;
  /** Lines drawn through a state they do not belong to. */
  throughStates: number;
  /** Labels on top of each other or of a state. */
  labelOverlaps: number;
  /** Labels with another line running through them. */
  labelOnEdges: number;
  /** Pairs of states closer than 40 px edge to edge. */
  tooClose: number;
  /** Pairs of lines leaving one state less than 15 degrees apart (they read as one thick line). */
  tightAngles: number;
  /** Lines bowed 100 px or more: arcs that sweep round the drawing. */
  bigArcs: number;
  /** Lines passing a state they do not belong to within 24 px of its edge. */
  nearMisses: number;
  /** Lines neither level nor upright. */
  slanted: number;
  /** Lines more than three times as long as the shortest. */
  longLines: number;
  /** Drawing size, px. */
  width: number; height: number;
  /** Area per state, in units of 100 x 100 px. */
  areaPerState: number;
  /** Mean and longest line between two states, centre to centre, px. */
  meanLen: number; maxLen: number;
  /** One number for sorting: the counts above, weighted (crossings and lines through states most). */
  index: number;
}

const INDEX: Partial<Record<keyof Mess, number>> = { crossings: 10, throughStates: 10, labelOverlaps: 6, tooClose: 10, tightAngles: 3, bigArcs: 3, nearMisses: 2, labelOnEdges: 1, longLines: 1 };

function intersect(a: Pt, b: Pt, c: Pt, e: Pt): Pt | null {
  const d = (b.x - a.x) * (e.y - c.y) - (b.y - a.y) * (e.x - c.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((c.x - a.x) * (e.y - c.y) - (c.y - a.y) * (e.x - c.x)) / d;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / d;
  return t >= 0 && t < 1 && u >= 0 && u < 1 ? { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } : null;
}

/** Times two drawn lines cross, not counting where they meet at a state. */
function crossCount(p: Pt[], q: Pt[], states: Array<Pt & { r: number }>): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) {
    const x = intersect(p[i - 1], p[i], q[j - 1], q[j]);
    if (x && states.every((s) => (x.x - s.x) ** 2 + (x.y - s.y) ** 2 > (s.r + 6) ** 2)) n++;
  }
  return n;
}

function segInBox(a: Pt, b: Pt, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]]) {
    if (p === 0) { if (q <= 0) return false; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p.x - a.x - t * vx, p.y - a.y - t * vy);
}

/** Measure a laid-out diagram as it is drawn with these options. */
export function measure(d: FsmDiagram, opts: PlanOptions = {}): Mess {
  const plan = planDiagram(d, opts);
  const at = new Map(d.states.map((s) => [s.id, { x: s.x!, y: s.y!, r: stateRadius(d, s) }]));
  const st = [...at.values()];
  const edges = plan.edges.filter((e) => e.transitions[0].from !== e.transitions[0].to);
  const m: Mess = { crossings: 0, throughStates: 0, labelOverlaps: 0, labelOnEdges: 0, tooClose: 0, tightAngles: 0, bigArcs: 0, nearMisses: 0, slanted: 0, longLines: 0, width: 0, height: 0, areaPerState: 0, meanLen: 0, maxLen: 0, index: 0 };

  for (let i = 0; i < plan.edges.length; i++) for (let j = i + 1; j < plan.edges.length; j++) m.crossings += crossCount(plan.edges[i].points, plan.edges[j].points, st);
  const arrow = plan.initialArrow;
  if (arrow) for (const e of plan.edges) m.crossings += crossCount([arrow.from, arrow.to], e.points, st);

  // How near each line comes to each state it does not belong to.
  for (const e of plan.edges) {
    const ends = new Set([e.transitions[0].from, e.transitions[0].to]);
    for (const [id, c] of at) {
      if (ends.has(id)) continue;
      let near = Infinity;
      for (let k = 1; k < e.points.length; k++) near = Math.min(near, segDist(c, e.points[k - 1], e.points[k]));
      if (near < c.r + 2) m.throughStates++;
      else if (near < c.r + 24) m.nearMisses++;
    }
  }

  const labels = plan.edges.filter((e) => e.label);
  for (const [i, e] of labels.entries()) {
    const r = e.label!;
    for (const c of st) {
      const dx = Math.max(Math.abs(c.x - r.x) - r.w / 2, 0), dy = Math.max(Math.abs(c.y - r.y) - r.h / 2, 0);
      if (dx * dx + dy * dy < (c.r + 2) ** 2) m.labelOverlaps++;
    }
    for (const f of labels.slice(i + 1)) {
      const q = f.label!;
      if (Math.abs(r.x - q.x) * 2 < r.w + q.w && Math.abs(r.y - q.y) * 2 < r.h + q.h) m.labelOverlaps++;
    }
    const x0 = r.x - r.w / 2, x1 = r.x + r.w / 2, y0 = r.y - r.h / 2, y1 = r.y + r.h / 2;
    for (const f of plan.edges) if (f !== e && f.points.some((p, k) => k > 0 && segInBox(f.points[k - 1], p, x0, y0, x1, y1))) m.labelOnEdges++;
  }

  for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) if (Math.hypot(st[i].x - st[j].x, st[i].y - st[j].y) < st[i].r + st[j].r + 40) m.tooClose++;

  // Directions lines leave each state in; the two lines of a pair drawn both ways count once.
  const leaving = new Map(d.states.map((s) => [s.id, new Map<string, number>()]));
  const lens: number[] = [];
  for (const e of edges) {
    const { from, to } = e.transitions[0];
    const a = at.get(from)!, b = at.get(to)!, p = e.points, k = Math.min(2, p.length - 1);
    if (!leaving.get(from)!.has(to)) leaving.get(from)!.set(to, Math.atan2(p[k].y - a.y, p[k].x - a.x));
    if (!leaving.get(to)!.has(from)) leaving.get(to)!.set(from, Math.atan2(p[p.length - 1 - k].y - b.y, p[p.length - 1 - k].x - b.x));
    if (Math.abs(e.curve) >= 100) m.bigArcs++;
    if (Math.abs(b.x - a.x) > 20 && Math.abs(b.y - a.y) > 20) m.slanted++;
    lens.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  for (const dirs of leaving.values()) {
    const a = [...dirs.values()];
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      const diff = Math.abs(Math.atan2(Math.sin(a[i] - a[j]), Math.cos(a[i] - a[j])));
      if (diff < (15 * Math.PI) / 180) m.tightAngles++;
    }
  }
  if (lens.length) {
    const shortest = Math.max(20, Math.min(...lens));
    m.longLines = lens.filter((l) => l > 3 * shortest).length;
    m.meanLen = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
    m.maxLen = Math.round(Math.max(...lens));
  }
  const b = plan.bounds;
  m.width = Math.round(b.maxX - b.minX); m.height = Math.round(b.maxY - b.minY);
  m.areaPerState = +((m.width * m.height) / 1e4 / Math.max(1, d.states.length)).toFixed(2);
  m.index = (Object.keys(INDEX) as Array<keyof Mess>).reduce((s, k) => s + INDEX[k]! * m[k], 0);
  return m;
}
