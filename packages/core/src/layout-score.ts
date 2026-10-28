// How readable a laid-out diagram is: one number, lower is better, made of
// weighted counts (crossings, lines through states, overlapping labels, long
// or slanted lines, shape...). tidy.ts lays out each candidate and keeps the
// one with the lowest total.
//
// The weights below were tuned against the user's own picks between pairs of
// layouts of the same machine (test/layout/fixtures/preferences.json, see
// docs/auto-layout.md); the tests fail if a change makes the score disagree
// with any of those picks.

import type { FsmDiagram } from "./model.ts";
import { planDiagram } from "./export/svg.ts";
import type { DiagramPlan } from "./export/svg.ts";
import { stateRadius } from "./metrics.ts";

/** Centres snap to this grid (px). */
export const GRID = 20;

export interface Pt { x: number; y: number }

export interface LayoutScore {
  total: number;
  /** Lines crossing each other, or cutting across the start arrow. */
  crossings: number;
  throughStates: number;
  labelOverlaps: number;
  labelOnEdges: number;
  tooClose: number;
  /** Lines against the main flow (left to right, or top to bottom, whichever fits better). */
  backward: number;
  /** Lines neither level nor upright. */
  slanted: number;
  /** States to the left of the reset state (it should start the reading, at the left). */
  leftOfStart: number;
  /** States lined up with no other state, in a row or a column. */
  floating: number;
  /** Triangles of linked states, two of them linked both ways, that are not about equilateral (not counting the slices round a state centred in an equilateral triangle of the three states it links to, and to nothing else). */
  uneven: number;
  /** How far lines between states run past one and a half times the shortest line (or the grid step, if shorter), summed (in those units). */
  long: number;
  asymmetry: number;
  length: number;
  aspect: number;
  area: number;
}

/** Width over height the drawing aims for: a little wider than tall, like a screen. */
export const SCREEN = 1.6;

/** What each count in LayoutScore costs; the total is their weighted sum. */
export const WEIGHTS = {
  // Must-fix problems.
  crossings: 100,
  throughStates: 80,
  labelOverlaps: 50,
  tooClose: 200,
  // Shape of the drawing.
  uneven: 25,
  floating: 20,
  long: 15,
  leftOfStart: 15,
  aspect: 10,
  labelOnEdges: 8,
  backward: 4,
  asymmetry: 3,
  slanted: 1,
  length: 1,
  area: 0.4,
};

export function emptyScore(): LayoutScore {
  return { total: 0, crossings: 0, throughStates: 0, labelOverlaps: 0, labelOnEdges: 0, tooClose: 0, backward: 0, slanted: 0, floating: 0, uneven: 0, long: 0, leftOfStart: 0, asymmetry: 0, length: 0, aspect: 0, area: 0 };
}

/** Readability of a drawn diagram; lower is better. `step` is the grid step used for distances. */
export function score(d: FsmDiagram, plan: DiagramPlan = planDiagram(d), step = 200): LayoutScore {
  if (d.states.length === 0) return emptyScore();
  const at = new Map(d.states.map((s) => [s.id, { x: s.x!, y: s.y!, r: stateRadius(d, s) }]));
  const st = [...at.values()];
  const edges = plan.edges;
  const s = emptyScore();
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) s.crossings += crossCount(edges[i].points, edges[j].points, st);
  // The start arrow counts as a line: nothing should cut across it.
  const arrow = plan.initialArrow;
  if (arrow) for (const e of edges) s.crossings += crossCount([arrow.from, arrow.to], e.points, st);
  for (const e of edges) {
    const ends = new Set([e.transitions[0].from, e.transitions[0].to]);
    const b = box(e.points); // a state outside the line's box (by its radius) is not on it
    for (const [id, c] of at) if (!ends.has(id) && c.x > b.x0 - c.r - 2 && c.x < b.x1 + c.r + 2 && c.y > b.y0 - c.r - 2 && c.y < b.y1 + c.r + 2 && e.points.some((p) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 < (c.r + 2) ** 2)) s.throughStates++;
  }
  const labels = edges.filter((e) => e.label);
  for (const [i, e] of labels.entries()) {
    const r = e.label!;
    for (const c of st) {
      const dx = Math.max(Math.abs(c.x - r.x) - r.w / 2, 0), dy = Math.max(Math.abs(c.y - r.y) - r.h / 2, 0);
      if (dx * dx + dy * dy < (c.r + 2) ** 2) s.labelOverlaps++;
    }
    for (const f of labels.slice(i + 1)) {
      const q = f.label!;
      if (Math.abs(r.x - q.x) * 2 < r.w + q.w && Math.abs(r.y - q.y) * 2 < r.h + q.h) s.labelOverlaps++;
    }
    for (const f of edges) {
      if (f === e) continue;
      const b = box(f.points); // a line whose box misses the label is not under it
      const x0 = r.x - r.w / 2, x1 = r.x + r.w / 2, y0 = r.y - r.h / 2, y1 = r.y + r.h / 2;
      // Any piece of the line through the label, not only its sample points (on a long arc they are further apart than a label is tall).
      if (b.x1 > x0 && b.x0 < x1 && b.y1 > y0 && b.y0 < y1 && f.points.some((p, k) => k > 0 && segInBox(f.points[k - 1], p, x0, y0, x1, y1))) s.labelOnEdges++;
    }
  }
  for (let i = 0; i < st.length; i++)
    for (let j = i + 1; j < st.length; j++) if ((st[i].x - st[j].x) ** 2 + (st[i].y - st[j].y) ** 2 < (st[i].r + st[j].r + 40) ** 2) s.tooClose++;
  // Main flow: whichever of left-to-right and top-to-bottom fewer lines go against.
  let left = 0, up = 0;
  for (const e of edges) {
    const a = at.get(e.transitions[0].from)!, b = at.get(e.transitions[0].to)!;
    if (a === b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx < -GRID) left++;
    if (dy < -GRID) up++;
    if (Math.abs(dx) > GRID && Math.abs(dy) > GRID) s.slanted++;
  }
  s.backward = Math.min(left, up);
  const start = at.get((d.states.find((x) => x.isInitial) ?? d.states[0]).id)!;
  s.leftOfStart = st.filter((p) => p.x < start.x - GRID).length;
  const linked = new Map(d.states.map((x) => [x.id, new Set<string>()]));
  const both = new Set<string>();
  for (const t of d.transitions) if (t.from !== t.to) {
    linked.get(t.from)!.add(t.to); linked.get(t.to)!.add(t.from);
    if (d.transitions.some((u) => u.from === t.to && u.to === t.from)) both.add(`${t.from}\u0000${t.to}`);
  }
  // Long lines: measured against the shortest line in the drawing, or the
  // grid step if that is shorter (at least one grid cell, so two linked
  // states on the same spot do not make every line infinitely long).
  const span = (a: string, b: string) => Math.hypot(at.get(a)!.x - at.get(b)!.x, at.get(a)!.y - at.get(b)!.y);
  const unitLen = Math.max(GRID, Math.min(step, ...[...linked].flatMap(([a, na]) => [...na].map((b) => span(a, b)))));
  for (const [a, na] of linked) for (const b of na) if (a < b) {
    s.long += Math.max(0, span(a, b) / unitLen - 1.5);
    // Three states linked to each other, two of them both ways: should be
    // equilateral. Three in a row may stay (the outer line is an arc), unless
    // all three are linked both ways.
    for (const c of linked.get(b)!) if (b < c && na.has(c)) {
      const twoWay = [[a, b], [b, c], [a, c]].filter(([x, y]) => both.has(`${x}\u0000${y}`)).length;
      if (!twoWay) continue;
      const [p, q, r] = [a, b, c].map((id) => at.get(id)!);
      if (twoWay < 3 && Math.abs((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) < 1) continue;
      // A slice of a centred hub: one corner at the centre of an equilateral
      // triangle that the other two make with a fourth state linked to all
      // three (four states all linked, drawn as a triangle round its centre).
      // Only the outer triangle can be equilateral then. The centre must have
      // no other lines: one leaving the triangle (k5 drawn as a grid) makes
      // the drawing no cleaner than an uneven one.
      if ([a, b, c].some((h) => linked.get(h)!.size === 3 && [...linked.get(h)!].some((e) => e !== a && e !== b && e !== c && [a, b, c].every((x) => x === h || linked.get(e)!.has(x)) && centred(at.get(h)!, [a, b, c, e].filter((x) => x !== h).map((x) => at.get(x)!))))) continue;
      const sides = [Math.hypot(p.x - q.x, p.y - q.y), Math.hypot(q.x - r.x, q.y - r.y), Math.hypot(r.x - p.x, r.y - p.y)];
      if (Math.max(...sides) > 1.15 * Math.min(...sides)) s.uneven++;
    }
  }
  if (st.length > 2) s.floating = st.filter((p) => !st.some((q) => q !== p && (Math.abs(q.x - p.x) < 1 || Math.abs(q.y - p.y) < 1))).length;
  // Mirror symmetry about the vertical or horizontal centre line, whichever fits better.
  const xs = st.map((p) => p.x), ys = st.map((p) => p.y);
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
  const misfit = (f: (p: Pt) => Pt) => st.reduce((sum, p) => {
    const m = f(p);
    return sum + Math.min(1, Math.min(...st.map((q) => Math.hypot(q.x - m.x, q.y - m.y))) / step);
  }, 0);
  s.asymmetry = Math.min(misfit((p) => ({ x: 2 * mx - p.x, y: p.y })), misfit((p) => ({ x: p.x, y: 2 * my - p.y })));
  for (const e of edges) for (let i = 1; i < e.points.length; i++) s.length += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].y - e.points[i - 1].y) / step;
  const b = plan.bounds;
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const skew = Math.abs(Math.log(w / h / SCREEN)); // a landscape picture, like a screen, reads best
  s.aspect = skew + 2 * Math.max(0, skew - 0.5) + 6 * Math.max(0, skew - 0.9); // much wider or taller than a screen shrinks when fitted
  s.area = (w * h) / (step * step);
  s.total = (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).reduce((sum, k) => sum + WEIGHTS[k] * s[k], 0);
  return s;
}

/** Whether p sits at the centre of the about equilateral triangle t (within a fifth of a side, for the grid). */
function centred(p: Pt, t: Pt[]): boolean {
  const sides = t.map((q, i) => Math.hypot(q.x - t[(i + 1) % 3].x, q.y - t[(i + 1) % 3].y));
  const cx = (t[0].x + t[1].x + t[2].x) / 3, cy = (t[0].y + t[1].y + t[2].y) / 3;
  return Math.max(...sides) <= 1.15 * Math.min(...sides) && Math.hypot(p.x - cx, p.y - cy) < 0.2 * Math.min(...sides);
}

/** Whether segment a-b runs through the inside of the box x0..x1 × y0..y1 (Liang-Barsky clipping). */
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

export function segDist(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p.x - a.x - t * vx, p.y - a.y - t * vy);
}

export interface Circle { x: number; y: number; r: number }

/**
 * Times two polylines cross, not counting where they meet at a state.
 * `states` is the circles to ignore crossings inside of (a map's values or an array).
 * A sampled straight line is compared as its one segment, so two straight
 * lines cost one intersection test instead of four hundred.
 */
export function crossCount(p: Pt[], q: Pt[], states: Iterable<Circle>): number {
  const bp = box(p), bq = box(q);
  if (bp.x1 < bq.x0 || bq.x1 < bp.x0 || bp.y1 < bq.y0 || bq.y1 < bp.y0) return 0;
  const sp = bp.straight ? [p[0], p[p.length - 1]] : p, sq = bq.straight ? [q[0], q[q.length - 1]] : q;
  let n = 0;
  let circles: Circle[] | undefined;
  for (let i = 1; i < sp.length; i++) {
    // Only pieces whose boxes meet can cross (most pairs of pieces on two arcs that pass near each other do not).
    const a = sp[i - 1], b = sp[i];
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (x1 < bq.x0 || x0 > bq.x1 || y1 < bq.y0 || y0 > bq.y1) continue;
    for (let j = 1; j < sq.length; j++) {
      const c = sq[j - 1], e = sq[j];
      if ((c.x < x0 && e.x < x0) || (c.x > x1 && e.x > x1) || (c.y < y0 && e.y < y0) || (c.y > y1 && e.y > y1)) continue;
      const x = intersect(a, b, c, e);
      if (!x) continue;
      circles ??= Array.isArray(states) ? states : [...states];
      if (circles.every((s) => (x.x - s.x) ** 2 + (x.y - s.y) ** 2 > (s.r + 6) ** 2)) n++;
    }
  }
  return n;
}

const boxes = new WeakMap<Pt[], { x0: number; y0: number; x1: number; y1: number; straight: boolean }>();
function box(p: Pt[]) {
  let b = boxes.get(p);
  if (!b) {
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, straight: false };
    for (const q of p) { b.x0 = Math.min(b.x0, q.x); b.y0 = Math.min(b.y0, q.y); b.x1 = Math.max(b.x1, q.x); b.y1 = Math.max(b.y1, q.y); }
    // Every sample on the chord between the ends: a straight line.
    const a = p[0], z = p[p.length - 1];
    b.straight = p.length > 2 && p.every((q) => Math.abs((q.x - a.x) * (z.y - a.y) - (q.y - a.y) * (z.x - a.x)) <= 1e-6 * Math.max(1, Math.abs(z.x - a.x) + Math.abs(z.y - a.y)));
    boxes.set(p, b);
  }
  return b;
}

export function intersect(a: Pt, b: Pt, c: Pt, e: Pt): Pt | null {
  const d = (b.x - a.x) * (e.y - c.y) - (b.y - a.y) * (e.x - c.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((c.x - a.x) * (e.y - c.y) - (c.y - a.y) * (e.x - c.x)) / d;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / d;
  return t >= 0 && t < 1 && u >= 0 && u < 1 ? { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } : null;
}
