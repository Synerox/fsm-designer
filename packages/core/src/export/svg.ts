// SVG renderer. Produces a standalone SVG string; the PNG exporter rasterises
// this same output, so both look identical.
//
// Geometry is computed by planDiagram() so other renderers (e.g. the editor
// canvas) can reuse the same edge routing and label placement.

import { outgoing, isUnconditional, unreachableStates } from "../model.ts";
import type { FsmDiagram, State, Transition } from "../model.ts";
import { stateDisplay } from "../text.ts";
import { SMALL_SIZE, SUB_LINE_H, formatOutputs, stateFontSize, stateRadius, stateSubLines, textWidth, transitionFontSize } from "../metrics.ts";

export { formatOutputs, stateRadius } from "../metrics.ts";

export interface SvgOptions extends PlanOptions {
  background?: string; // CSS colour or "none"; default white
  fontFamily?: string;
  stroke?: string;
  fill?: string; // default state fill
  accent?: string; // initial-arrow colour
}

const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const lineHeight = (size: number) => size * 1.3;

interface Pt { x: number; y: number }
interface Rect { x: number; y: number; w: number; h: number } // centre + size

export interface EdgePlan {
  transitions: Transition[]; // parallel transitions merged into one arc
  path: string; // SVG path data
  curve: number; // apex offset actually used (see Transition.curve)
  /** A straight edge with a straight opposite edge is drawn shifted sideways by this vector, so the two run side by side. */
  offset?: Pt;
  loopAngle?: number; // self loops: direction of the loop, radians, screen coords
  lines: string[]; // label lines
  fontSize: number; // px, from the first transition
  label?: Rect;
  /** Points sampled along the drawn line, start to end (used to score layouts). */
  points: Pt[];
}

export interface StatePlan { state: State; r: number }

export interface DiagramPlan {
  states: StatePlan[];
  edges: EdgePlan[];
  initialArrow?: { from: Pt; to: Pt; state: State; angle: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface PlanOptions {
  /**
   * Label an unconditional transition "else" when its state has other
   * transitions (default true). The editor turns it off to draw exactly
   * what the user typed.
   */
  elseLabels?: boolean;
  /** Which transition labels to draw: all (default), all but self loops' ("noLoops"), or none. */
  labels?: "all" | "noLoops" | "none";
  /** One edge (from -> to) whose labels are drawn even when `labels` hides them. */
  shownEdge?: { from: string; to: string };
}

function edgeLines(d: FsmDiagram, ts: Transition[], opts: PlanOptions, hidden: boolean): string[] {
  const shown = opts.shownEdge?.from === ts[0].from && opts.shownEdge.to === ts[0].to;
  return hidden && !shown ? [] : ts.flatMap((t) => labelLines(transitionLabel(d, t, opts)));
}

/** Text drawn on a transition: "cond" (Moore) or "cond / z=1" (Mealy). */
export function transitionLabel(d: FsmDiagram, t: Transition, opts: PlanOptions = {}): string {
  let cond = t.condition;
  if (isUnconditional(t) && (opts.elseLabels ?? true)) cond = outgoing(d, t.from).length > 1 ? "else" : "";
  const outs = d.type === "mealy" ? formatOutputs(t.outputs) : "";
  if (outs) return cond ? `${cond} / ${outs}` : `/ ${outs}`;
  return cond;
}

/** Labels longer than this many characters are wrapped. */
export const WRAP_CHARS = 36;

/**
 * Lines of a transition label: a long label is broken after `||` (and, if a
 * line is still long, after `&&` outside or one level inside parentheses),
 * with Mealy outputs on a line of their own.
 */
export function labelLines(text: string, max = WRAP_CHARS): string[] {
  if (text.length <= max) return text ? [text] : [];
  const slash = splitAfter(text, " / ", 0);
  if (slash.length > 1) {
    const cond = slash.slice(0, -1).join("").replace(/ \/ $/, "");
    return [...(cond ? labelLines(cond, max) : []), `/ ${slash[slash.length - 1]}`];
  }
  return pack(splitAfter(text, " || ", 0), max).flatMap((l) => (l.length > max ? pack(splitAfter(l, " && ", 1), max) : [l]));
}

/** Pieces of text, each ending just after a top-level (depth <= maxDepth) occurrence of op. */
function splitAfter(text: string, op: string, maxDepth: number): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth <= maxDepth && text.startsWith(op, i)) {
      out.push(text.slice(start, i + op.length));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function pack(pieces: string[], max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && (cur + p).trimEnd().length > max) { lines.push(cur.trimEnd()); cur = p; }
    else cur += p;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

const sub = (a: Pt, b: Pt) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Pt) => Math.hypot(v.x, v.y) || 1e-9;
const unit = (v: Pt) => { const l = len(v); return { x: v.x / l, y: v.y / l }; };
const P = (s: State): Pt => ({ x: s.x!, y: s.y! });

function rectsOverlap(a: Rect, b: Rect, gap = 2) {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + gap * 2;
}
function rectCircleOverlap(r: Rect, c: Pt, rad: number) {
  const dx = Math.max(Math.abs(c.x - r.x) - r.w / 2, 0);
  const dy = Math.max(Math.abs(c.y - r.y) - r.h / 2, 0);
  return dx * dx + dy * dy < (rad + 3) ** 2;
}
function rectSegmentHits(r: Rect, pts: Pt[]) {
  return pts.some((p) => Math.abs(p.x - r.x) < r.w / 2 + 1 && Math.abs(p.y - r.y) < r.h / 2 + 1);
}

/** Point and tangent on a quadratic Bézier. */
function quad(p0: Pt, c: Pt, p1: Pt, t: number) {
  const u = 1 - t;
  return {
    p: { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y },
    d: { x: 2 * u * (c.x - p0.x) + 2 * t * (p1.x - c.x), y: 2 * u * (c.y - p0.y) + 2 * t * (p1.y - c.y) },
  };
}
/**
 * A self loop as a circular arc (like Evan Wallace's FSM designer): a circle
 * of radius 0.75r centred 1.5r out from the state in direction `angle`,
 * drawn the long way round between the two points where it meets the state.
 */
export function loopGeometry(c: Pt, r: number, angle: number) {
  const dist = 1.5 * r, rl = 0.75 * r;
  const center = { x: c.x + dist * Math.cos(angle), y: c.y + dist * Math.sin(angle) };
  // Angle, seen from the loop's centre, between the state's centre and each meeting point.
  const theta = Math.acos((dist * dist + rl * rl - r * r) / (2 * dist * rl));
  const start = angle + Math.PI + theta, sweep = 2 * Math.PI - 2 * theta;
  const on = (phi: number) => ({ x: center.x + rl * Math.cos(phi), y: center.y + rl * Math.sin(phi) });
  const p0 = on(start);
  // End a pixel outside the state so the arrowhead tip touches its border.
  const p1 = on(start + sweep - 1 / rl);
  const samples = Array.from({ length: 25 }, (_, i) => on(start + (sweep * i) / 24));
  return {
    center,
    apex: on(angle),
    samples,
    path: `M ${f(p0.x)} ${f(p0.y)} A ${f(rl)} ${f(rl)} 0 1 1 ${f(p1.x)} ${f(p1.y)}`,
  };
}

/** Default distance between two straight lines running both ways between the same states. */
export const PARALLEL_GAP = 16;

/** A state's output lines as drawn: hidden along with the transition labels when labels are "none". */
export function drawnSubLines(d: FsmDiagram, s: State, opts: PlanOptions = {}): string[] {
  return opts.labels === "none" ? [] : stateSubLines(d, s);
}

export function planDiagram(d: FsmDiagram, opts: PlanOptions = {}): DiagramPlan {
  const missing = d.states.filter((s) => s.x === undefined || s.y === undefined);
  if (missing.length) throw new Error(`States without positions: ${missing.map((s) => s.name).join(", ")}. Run auto layout first.`);
  const byId = new Map(d.states.map((s) => [s.id, s]));
  const R = new Map(d.states.map((s) => [s.id, stateRadius(d, s)]));

  // Merge parallel transitions (same from/to) into one arc with stacked labels.
  const groups = new Map<string, Transition[]>();
  for (const t of d.transitions) {
    const k = `${t.from}\u0000${t.to}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }

  // Directions in which edges leave each state, used to pick free sides for
  // self loops and the initial arrow.
  const busy = new Map<string, number[]>(d.states.map((s) => [s.id, []]));
  const initial = d.states.find((s) => s.isInitial);
  const initialAngle = initial?.initialAngle ?? Math.PI; // initial arrow comes from the left by default
  if (initial) busy.get(initial.id)!.push(initialAngle);

  // Sampled polylines of every edge drawn so far, for label collision checks.
  const drawn: Pt[][] = [];
  const edges: EdgePlan[] = [];
  const pending: Array<{ plan: EdgePlan; own: Pt[]; candidates: Array<{ at: Pt; n: Pt }> }> = [];

  const clearOfStates = (pts: Pt[], skip: Set<string>) =>
    d.states.every((s) => skip.has(s.id) || pts.every((p) => Math.hypot(p.x - s.x!, p.y - s.y!) > R.get(s.id)! + 10));

  for (const ts of groups.values()) {
    const a = byId.get(ts[0].from)!, b = byId.get(ts[0].to)!;
    if (a === b) continue;
    const ra = R.get(a.id)!, rb = R.get(b.id)!;
    const A = P(a), B = P(b);
    const dir = unit(sub(B, A));
    const n = { x: dir.y, y: -dir.x }; // left of travel (screen)
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const reverse = groups.has(`${b.id}\u0000${a.id}`);
    const manual = ts.find((t) => t.curve !== undefined)?.curve;

    // Straight lines both ways would sit on top of each other: shift each to
    // the left of its own travel, which puts them on opposite sides.
    const back = groups.get(`${b.id}\u0000${a.id}`);
    const reverseStraight = back?.some((t) => t.curve === 0) ?? false;
    // Half the distance between the two lines (either direction may carry it), kept inside the smaller circle.
    const gap = ts.find((t) => t.gap !== undefined)?.gap ?? back?.find((t) => t.gap !== undefined)?.gap ?? PARALLEL_GAP;
    const half = Math.min(gap / 2, Math.min(ra, rb) * 0.8);
    const straightPair = (curve: number) => curve === 0 && reverseStraight;
    const build = (curve: number) => {
      if (straightPair(curve)) {
        const o = half;
        const along = (r: number) => Math.sqrt(Math.max(r * r - o * o, 0));
        const p0 = { x: A.x + dir.x * along(ra) + n.x * o, y: A.y + dir.y * along(ra) + n.y * o };
        const p1 = { x: B.x - dir.x * along(rb + 1) + n.x * o, y: B.y - dir.y * along(rb + 1) + n.y * o };
        const ctrl = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        const samples = Array.from({ length: 21 }, (_, i) => ({ x: p0.x + ((p1.x - p0.x) * i) / 20, y: p0.y + ((p1.y - p0.y) * i) / 20 }));
        return { curve, ctrl, p0, p1, samples };
      }
      const ctrl = { x: mid.x + n.x * curve * 2, y: mid.y + n.y * curve * 2 };
      const ua = unit(sub(ctrl, A)), ub = unit(sub(ctrl, B));
      const p0 = { x: A.x + ua.x * ra, y: A.y + ua.y * ra };
      const p1 = { x: B.x + ub.x * (rb + 1), y: B.y + ub.y * (rb + 1) };
      const samples = Array.from({ length: 21 }, (_, i) => quad(p0, ctrl, p1, i / 20).p);
      return { curve, ctrl, p0, p1, samples };
    };
    let route = build(manual ?? (reverse ? 28 : 0));
    if (manual === undefined) {
      // Bow around any state the straight/default arc would pass through.
      const skip = new Set([a.id, b.id]);
      const base = route.curve;
      for (const c of [base, base + 40, base - 40, base + 80, base - 80, base + 130, base - 130, base + 190]) {
        if (reverse && c <= 0) continue; // keep opposite edges on opposite sides
        const r = build(c);
        if (clearOfStates(r.samples, skip)) { route = r; break; }
      }
    }
    const { curve, ctrl, p0, p1, samples } = route;
    drawn.push(samples);
    const path = curve === 0
      ? `M ${f(p0.x)} ${f(p0.y)} L ${f(p1.x)} ${f(p1.y)}`
      : `M ${f(p0.x)} ${f(p0.y)} Q ${f(ctrl.x)} ${f(ctrl.y)} ${f(p1.x)} ${f(p1.y)}`;
    const plan: EdgePlan = { transitions: ts, path, curve, points: samples, lines: edgeLines(d, ts, opts, opts.labels === "none"), fontSize: transitionFontSize(ts[0]) };
    if (straightPair(curve)) plan.offset = { x: n.x * half, y: n.y * half };
    edges.push(plan);
    // Label candidates: convex side of a curve; either side of a straight line
    // (upper side first, so text reads above the arrow).
    const candidates: Array<{ at: Pt; n: Pt }> = [];
    for (const t of [0.5, 0.38, 0.62, 0.28, 0.72]) {
      const q = quad(p0, ctrl, p1, t);
      const tn = unit({ x: q.d.y, y: -q.d.x });
      if (curve !== 0) {
        const side = Math.sign(curve);
        candidates.push({ at: q.p, n: { x: tn.x * side, y: tn.y * side } });
      } else {
        const up = tn.y < 0 || (tn.y === 0 && tn.x < 0) ? tn : { x: -tn.x, y: -tn.y };
        candidates.push({ at: q.p, n: up }, { at: q.p, n: { x: -up.x, y: -up.y } });
      }
    }
    pending.push({ plan, own: samples, candidates });
  }

  // Any edge passing close to a state occupies that direction around it.
  for (const s of d.states) {
    const lim = R.get(s.id)! + 70;
    for (const pts of drawn)
      for (const p of pts) {
        const dist = Math.hypot(p.x - s.x!, p.y - s.y!);
        if (dist < lim && dist > 1) busy.get(s.id)!.push(Math.atan2(p.y - s.y!, p.x - s.x!));
      }
  }

  // Self loops go on the side with the widest gap between existing edges.
  for (const ts of groups.values()) {
    const a = byId.get(ts[0].from)!;
    if (a.id !== ts[0].to) continue;
    const ra = R.get(a.id)!;
    const used = busy.get(a.id)!;
    const manual = ts.find((t) => t.loopAngle !== undefined)?.loopAngle;
    let best = manual ?? -Math.PI / 2, bestGap = -1;
    for (let k = 0; k < 16 && manual === undefined; k++) {
      // Prefer straight up/down/left/right on ties.
      const ang = -Math.PI / 2 + (k * Math.PI) / 8;
      const gap = used.length ? Math.min(...used.map((u) => Math.abs(Math.atan2(Math.sin(ang - u), Math.cos(ang - u))))) : Math.PI;
      const score = gap + (k % 4 === 0 ? 0.15 : 0);
      if (score > bestGap + 1e-6) { bestGap = score; best = ang; }
    }
    used.push(best);
    const g = loopGeometry({ x: a.x!, y: a.y! }, ra, best);
    drawn.push(g.samples);
    const plan: EdgePlan = {
      transitions: ts,
      curve: 0,
      loopAngle: best,
      path: g.path,
      points: g.samples,
      lines: edgeLines(d, ts, opts, opts.labels === "none" || opts.labels === "noLoops"),
      fontSize: transitionFontSize(ts[0]),
    };
    edges.push(plan);
    const out = { x: Math.cos(best), y: Math.sin(best) };
    const at = (i: number) => g.samples[Math.round(i * (g.samples.length - 1))];
    const side = (i: number) => { const q = at(i); return { at: q, n: unit(sub(q, g.center)) }; };
    pending.push({ plan, own: g.samples, candidates: [{ at: g.apex, n: out }, side(0.35), side(0.65), side(0.2), side(0.8)] });
  }

  // Place labels greedily, avoiding states, other labels and other edges.
  const placed: Rect[] = [];
  for (const { plan, own, candidates } of pending) {
    if (!plan.lines.length) continue;
    const w = Math.max(...plan.lines.map((l) => textWidth(l, plan.fontSize))) + 6;
    const h = plan.lines.length * lineHeight(plan.fontSize) + 2;
    let best: Rect | undefined, bestScore = Infinity;
    const tries = [0, 12, 26].flatMap((extra, j) => candidates.map((c, i) => ({ ...c, extra, rank: j * 0.5 + i * 0.01 })));
    tries.forEach(({ at, n, extra, rank }) => {
      const reach = Math.abs(n.x) * (w / 2) + Math.abs(n.y) * (h / 2) + 5 + extra;
      const rect = { x: at.x + n.x * reach, y: at.y + n.y * reach, w, h };
      let score = rank;
      for (const s of d.states) if (rectCircleOverlap(rect, P(s), R.get(s.id)!)) score += 10;
      for (const p of placed) if (rectsOverlap(rect, p)) score += 10;
      for (const pts of drawn) if (pts !== own && rectSegmentHits(rect, pts)) score += 3;
      if (score < bestScore) { bestScore = score; best = rect; }
    });
    plan.label = best;
    placed.push(best!);
  }

  // Initial arrow from the left.
  let initialArrow: DiagramPlan["initialArrow"];
  if (initial) {
    const r = R.get(initial.id)!;
    const c = Math.cos(initialAngle), s = Math.sin(initialAngle);
    initialArrow = {
      from: { x: initial.x! + c * (r + 38), y: initial.y! + s * (r + 38) },
      to: { x: initial.x! + c * (r + 1), y: initial.y! + s * (r + 1) },
      state: initial,
      angle: initialAngle,
    };
  }

  // Bounds.
  const bx = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x: number, y: number, w = 0, h = 0) => {
    bx.minX = Math.min(bx.minX, x - w / 2); bx.maxX = Math.max(bx.maxX, x + w / 2);
    bx.minY = Math.min(bx.minY, y - h / 2); bx.maxY = Math.max(bx.maxY, y + h / 2);
  };
  for (const s of d.states) {
    grow(s.x!, s.y!, 2 * R.get(s.id)! + 4, 2 * R.get(s.id)! + 4);
    // Text may be wider than its circle; keep it inside the picture.
    grow(s.x!, s.y!, textWidth(stateDisplay(s), stateFontSize(s), true) + 8, stateFontSize(s));
    for (const l of drawnSubLines(d, s, opts)) grow(s.x!, s.y!, textWidth(l, SMALL_SIZE) + 8, 0);
  }
  for (const pts of drawn) for (const p of pts) grow(p.x, p.y, 4, 4);
  for (const r of placed) grow(r.x, r.y, r.w, r.h);
  if (initialArrow) grow(initialArrow.from.x, initialArrow.from.y, 4, 4);
  if (!isFinite(bx.minX)) Object.assign(bx, { minX: 0, minY: 0, maxX: 100, maxY: 100 });

  return { states: d.states.map((s) => ({ state: s, r: R.get(s.id)! })), edges, initialArrow, bounds: bx };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (n: number) => (Math.round(n * 10) / 10).toString();

export function renderSvg(d: FsmDiagram, opts: SvgOptions = {}): string {
  const plan = planDiagram(d, opts);
  const bg = opts.background ?? "#ffffff";
  const transparent = bg === "none" || bg === "transparent";
  const stroke = opts.stroke ?? "#1f2937";
  const fill = opts.fill ?? "#ffffff";
  const accent = opts.accent ?? "#2563eb";
  const halo = transparent ? "#ffffff" : bg;

  const out: string[] = [];
  for (const e of plan.edges) {
    const ids = e.transitions.map((t) => t.id).join(" ");
    out.push(`<path class="edge" data-transitions="${esc(ids)}" d="${e.path}" fill="none" stroke="${stroke}" stroke-width="1.6" marker-end="url(#arrow)"/>`);
  }
  if (plan.initialArrow) {
    const { from: a, to: b } = plan.initialArrow;
    out.push(`<path class="initial" d="M ${f(a.x)} ${f(a.y)} L ${f(b.x)} ${f(b.y)}" stroke="${accent}" stroke-width="2" marker-end="url(#arrow-accent)"/>`);
  }
  // States the initial state never leads to get a dashed outline.
  const lost = unreachableStates(d);
  for (const { state: s, r } of plan.states) {
    const subLines = drawnSubLines(d, s, opts);
    const dash = lost.has(s.id) ? ` stroke-dasharray="6 4"` : "";
    const g: string[] = [`<circle cx="${f(s.x!)}" cy="${f(s.y!)}" r="${f(r)}" fill="${esc(s.color ?? fill)}" stroke="${stroke}" stroke-width="2"${dash}/>`];
    if (s.isAccepting) g.push(`<circle cx="${f(s.x!)}" cy="${f(s.y!)}" r="${f(r - 5)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
    const text = (y: number, size: number, body: string, weight = "") =>
      `<text x="${f(s.x!)}" y="${f(y)}" font-size="${size}"${weight} text-anchor="middle" dominant-baseline="central" fill="${stroke}">${esc(body)}</text>`;
    const fs = stateFontSize(s);
    if (subLines.length) {
      const total = fs + 6 + subLines.length * SUB_LINE_H;
      const top = s.y! - total / 2;
      const rule = top + fs + 3;
      const half = Math.sqrt(Math.max(0, r * r - (rule - s.y!) ** 2)) * 0.8;
      g.push(text(top + fs / 2, fs, stateDisplay(s), ` font-weight="600"`));
      g.push(`<line x1="${f(s.x! - half)}" y1="${f(rule)}" x2="${f(s.x! + half)}" y2="${f(rule)}" stroke="${stroke}" stroke-width="0.8" opacity="0.45"/>`);
      subLines.forEach((l, i) => g.push(text(rule + 3 + SUB_LINE_H * (i + 0.5), SMALL_SIZE, l)));
    } else {
      g.push(text(s.y!, fs, stateDisplay(s), ` font-weight="600"`));
    }
    out.push(`<g class="state" id="state-${esc(s.id)}">${g.join("")}</g>`);
  }
  for (const e of plan.edges) {
    if (!e.label) continue;
    const lh = lineHeight(e.fontSize);
    const top = e.label.y - (e.lines.length * lh) / 2 + lh / 2;
    for (const [i, l] of e.lines.entries())
      out.push(`<text x="${f(e.label.x)}" y="${f(top + i * lh)}" font-size="${e.fontSize}" text-anchor="middle" dominant-baseline="central" fill="${stroke}" stroke="${esc(halo)}" stroke-width="4" stroke-linejoin="round" paint-order="stroke">${esc(l)}</text>`);
  }

  const pad = 16;
  const { minX, minY, maxX, maxY } = plan.bounds;
  const vx = minX - pad, vy = minY - pad, w = maxX - minX + 2 * pad, h = maxY - minY + 2 * pad;
  const marker = (id: string, color: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${f(vx)} ${f(vy)} ${f(w)} ${f(h)}" font-family="${esc(opts.fontFamily ?? FONT)}">`,
    `<title>${esc(d.name)}</title>`,
    `<defs>${marker("arrow", stroke)}${marker("arrow-accent", accent)}</defs>`,
    transparent ? "" : `<rect x="${f(vx)}" y="${f(vy)}" width="${f(w)}" height="${f(h)}" fill="${esc(bg)}"/>`,
    ...out,
    `</svg>`,
    "",
  ].filter((x, i, arr) => x !== "" || i === arr.length - 1).join("\n");
}
