// Small geometry helpers for canvas gestures.

import { loopGeometry } from "@fsm/core";
import type { DiagramPlan, EdgePlan } from "@fsm/core";

export interface Pt {
  x: number;
  y: number;
}

export const GRID = 20; // grid spacing in diagram units (a major line every 5)
export const SNAP_PX = 8; // screen pixels within which a dragged state lines up with another
const ANGLE_SNAP = 0.12; // radians

/**
 * The numbers in SVG path data, in order. Numbers print with an exponent
 * past 1e21 ("2e+300"), and a broken plan prints NaN or Infinity: those come
 * back as such for the caller to check (see checkDrawable), not as a throw.
 */
export function pathNumbers(path: string): number[] {
  return (path.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|[-+]?(?:NaN|Infinity)/gi) ?? []).map(Number);
}

/** Point at the middle of a path from planDiagram ("M .. L ..", "M .. Q ..", "M .. C .."). */
export function pathMidpoint(path: string): Pt {
  const n = pathNumbers(path);
  const P = (i: number) => ({ x: n[i], y: n[i + 1] });
  if (path.includes("C")) {
    const [p0, c1, c2, p1] = [P(0), P(2), P(4), P(6)];
    return { x: (p0.x + 3 * c1.x + 3 * c2.x + p1.x) / 8, y: (p0.y + 3 * c1.y + 3 * c2.y + p1.y) / 8 };
  }
  if (path.includes("Q")) {
    const [p0, c, p1] = [P(0), P(2), P(4)];
    return { x: (p0.x + 2 * c.x + p1.x) / 4, y: (p0.y + 2 * c.y + p1.y) / 4 };
  }
  return { x: (n[0] + n[2]) / 2, y: (n[1] + n[3]) / 2 };
}

/** Topmost state under a point. */
export function stateAt(plan: DiagramPlan, p: Pt): string | null {
  for (let i = plan.states.length - 1; i >= 0; i--) {
    const { state: s, r } = plan.states[i];
    if (Math.hypot(p.x - s.x!, p.y - s.y!) <= r) return s.id;
  }
  return null;
}

export function angleOf(center: Pt, p: Pt): number {
  return Math.atan2(p.y - center.y, p.x - center.x);
}

/** Snap an angle to the nearest multiple of 90 degrees when close to it. */
export function snapAngle(a: number): number {
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  return Math.abs(a - q) < ANGLE_SNAP ? q : a;
}

/**
 * Curve value for dragging an edge between A and B through point p: the
 * perpendicular offset of p from the chord midpoint (positive = left of
 * travel), matching Transition.curve. Near-straight snaps to 0.
 */
export function curveThrough(A: Pt, B: Pt, p: Pt): number {
  const dx = B.x - A.x, dy = B.y - A.y;
  const L = Math.hypot(dx, dy) || 1;
  const n = { x: dy / L, y: -dx / L };
  const c = (p.x - (A.x + B.x) / 2) * n.x + (p.y - (A.y + B.y) / 2) * n.y;
  return Math.abs(c) < 8 ? 0 : Math.round(c);
}

export function borderPoint(c: Pt, r: number, toward: Pt): Pt {
  const a = angleOf(c, toward);
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

/** Self-loop preview path, the same arc planDiagram draws. */
export function loopPath(c: Pt, r: number, angle: number): string {
  return loopGeometry(c, r, angle).path;
}

/** Middle of a planned edge: the far point of a self loop, else the middle of its curve. */
export function edgeMidpoint(plan: DiagramPlan, e: EdgePlan): Pt {
  if (e.loopAngle === undefined) return pathMidpoint(e.path);
  const s = plan.states.find((p) => p.state.id === e.transitions[0].from)!;
  return loopGeometry({ x: s.state.x!, y: s.state.y! }, s.r, e.loopAngle).apex;
}

/** A dashed alignment line shown while dragging: `axis` "x" is vertical at x = at. */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

export function snapToGrid(v: number, grid = GRID): number {
  return Math.round(v / grid) * grid;
}

/**
 * Where a dragged state centre lands. On each axis it lines up with the
 * nearest other state centre within `tol` (and reports a guide through all
 * centres on that line); otherwise it snaps to the grid when `grid` is on.
 */
export function snapPoint(p: Pt, others: Pt[], tol: number, grid: boolean): { p: Pt; guides: Guide[] } {
  const near = (a: "x" | "y"): number | null => {
    let best: number | null = null;
    for (const o of others) if (Math.abs(o[a] - p[a]) < tol && (best === null || Math.abs(o[a] - p[a]) < Math.abs(best - p[a]))) best = o[a];
    return best;
  };
  const ax = near("x"), ay = near("y");
  const free = (v: number) => (grid ? snapToGrid(v) : Math.round(v));
  const q = { x: ax ?? free(p.x), y: ay ?? free(p.y) };
  const guides: Guide[] = [];
  if (ax !== null) {
    const ys = others.filter((o) => o.x === ax).map((o) => o.y);
    guides.push({ axis: "x", at: ax, from: Math.min(q.y, ...ys), to: Math.max(q.y, ...ys) });
  }
  if (ay !== null) {
    const xs = others.filter((o) => o.y === ay).map((o) => o.x);
    guides.push({ axis: "y", at: ay, from: Math.min(q.x, ...xs), to: Math.max(q.x, ...xs) });
  }
  return { p: q, guides };
}

/** Points along a planned edge (a self loop's arc, or its line / curve). */
export function edgePoints(plan: DiagramPlan, e: EdgePlan, n = 40): Pt[] {
  if (e.loopAngle !== undefined) {
    const s = plan.states.find((p) => p.state.id === e.transitions[0].from)!;
    return loopGeometry({ x: s.state.x!, y: s.state.y! }, s.r, e.loopAngle).samples;
  }
  const v = pathNumbers(e.path);
  const p0 = { x: v[0], y: v[1] };
  const [c, p1] = e.path.includes("Q") ? [{ x: v[2], y: v[3] }, { x: v[4], y: v[5] }] : [null, { x: v[2], y: v[3] }];
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    if (!c) return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
  });
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boxOf(a: Pt, b: Pt): Box {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

export const inBox = (b: Box, p: Pt) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

/** Does the segment p-q cross or touch the box? */
export function segmentHitsBox(b: Box, p: Pt, q: Pt): boolean {
  if (inBox(b, p) || inBox(b, q)) return true;
  // Clip the segment to the box (Liang-Barsky).
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  for (const [num, den] of [[p.x - b.x0, -dx], [b.x1 - p.x, dx], [p.y - b.y0, -dy], [b.y1 - p.y, dy]]) {
    if (den === 0) { if (num < 0) return false; continue; }
    const t = num / den;
    if (den < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

export function circleHitsBox(b: Box, c: Pt, r: number): boolean {
  const x = Math.max(b.x0, Math.min(c.x, b.x1)), y = Math.max(b.y0, Math.min(c.y, b.y1));
  return Math.hypot(c.x - x, c.y - y) <= r;
}
