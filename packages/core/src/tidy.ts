// Automatic layout: one rule for every diagram, chosen by the graph's shape,
// never by how many states it has.
//
// 1. Analysis. Islands (states not linked to the rest) are laid out on
//    their own and packed side by side, the reset state's island first.
//    Within an island: the reset state, loops (a depth-first walk from the
//    reset state; a line back to a state still on the walk closes a loop),
//    and triangles of states all linked to each other.
// 2. Candidates, all scored the same way:
//    - grid: a grid about as tall as it is wide (or a little wider), the
//      reset state in the left column, states moved between cells to reduce
//      crossings, lines through states, diagonal and long lines (simulated
//      annealing on a cost kept up to date move by move, single states and
//      whole rows or columns at a time; of a grid and the same grid turned
//      over its diagonal, the one whose flow leaves the reset state to the right);
//    - layers, left to right and top to bottom (Sugiyama style): loops set
//      aside, each state one layer past its furthest predecessor, the reset
//      state in the first layer, each layer ordered to reduce crossings and
//      centred on one axis.
//    - snake: the same layers in rows, every other row right to left, so a
//      long flow folds into a square;
//    - ring: the largest piece that stays linked when any one state is taken
//      away drawn as a loop round a rectangle, the flow clockwise from the
//      top left; each piece hanging off it (a short side loop, a lone line)
//      as its own small shape, an equilateral triangle, square or rectangle,
//      pointing away from the state it hangs off.
//    - hub: a state linked to every other state, in the middle of the others
//      when they make a loop round it (a wheel; four states all linked
//      become an equilateral triangle round the fourth), or, being the reset
//      state, on the left with the others above, right of and below it (a fan).
//      Drawn as shaped (no local shapes); a shape that is the same drawing
//      as one already made from another hub, the states only named
//      differently, is made once.
//    Each at two line lengths: room for the spacing, and room for the
//    widest label.
// 3. Local shapes. A triangle of linked states (each candidate also tried
//    with only those where two states link both ways) becomes equilateral
//    (the state at the right angle moves to the apex over the level side);
//    two sharing a side become a level diamond. In a ring, rows stay level:
//    the triangle's states slide sideways instead.
// 4. Finishing. Centres on a 20 px grid; a line that would cross a state
//    becomes an arc (back edges bow below a row, forward jumps above),
//    opposite edges become two parallel straight lines; a line that crosses
//    another bows round it when some arc clears every state and crosses
//    fewer lines (the most tangled lines first, a few passes; the start
//    arrow counts as a line, so an arc bows round it); each self loop points
//    to its state's emptiest side, kept clear of lines (a pair drawn as two
//    parallel lines is wider than its centre line); the start arrow comes in
//    from a side free of states and lines (lines first bow round it, and
//    only if one still cuts it does it move).
// 5. Scoring (see layout-score.ts): crossings (the start arrow counts as a
//    line) weigh most, then lines through states
//    and overlapping labels, then triangles that are not equilateral,
//    states lined up with nothing, lines much longer than the shortest,
//    states left of the reset state, lines against the main flow, symmetry,
//    slanted lines, total line length, shape (aiming a little wider than
//    tall, like a screen) and area. The weights were tuned against the
//    user's own picks between pairs of layouts (test/layout/fixtures/
//    preferences.json). Between equal scores, the drawing whose flow leaves
//    the reset state further to the right wins (a loop clockwise from the
//    top left).
// 6. Repair. Candidates that still have crossings, overlaps or lines
//    through states, and would lead with those gone (at most five), are tried
//    spread out a little; whatever cannot be fixed is reported in
//    TidyResult.issues.
// 7. Polish. In the best two, if within half again of the best score, a
//    state with a long line tries the three free grid spots nearest its
//    neighbours and moves to the one that improves the score most (the
//    reset state never moves right of another).

import type { FsmDiagram } from "./model.ts";
import { PARALLEL_GAP, labelLines, planDiagram, transitionLabel } from "./export/svg.ts";
import type { PlanOptions } from "./export/svg.ts";
import { LABEL_SIZE, stateRadius, textWidth } from "./metrics.ts";

import { GRID, WEIGHTS, crossCount, emptyScore, intersect, score, segDist } from "./layout-score.ts";
import type { LayoutScore, Pt } from "./layout-score.ts";

export { GRID, score };
export type { LayoutScore };

type Pos = Map<string, Pt>;

interface Graph {
  ids: string[]; // initial state first, then file order
  init: string;
  out: Map<string, string[]>; // successors, without self loops
  nb: Map<string, Set<string>>; // neighbours either way
}

export interface TidyOptions {
  spacing?: number; // px between state edges, default 90
  margin?: number; // px around the drawing, default 60
  /** How the diagram will be drawn (e.g. labels hidden), so spacing and scoring match. */
  plan?: PlanOptions;
}

/** A problem the layout could not fix: how many line crossings, lines through states, overlapping labels, states too close. */
export interface LayoutIssue {
  kind: "crossings" | "throughStates" | "labelOverlaps" | "tooClose";
  count: number;
}

export interface TidyResult {
  score: LayoutScore;
  /** The winning arrangement: grid, layers-right, layers-down, snake-k, ring-cxr, hub-triangle, hub-square, hub-wheel, hub-fan, or islands (several packed side by side). */
  arrangement: string;
  /** Triangles made equilateral, as their state ids. */
  triangles: string[][];
  /** Every candidate's score, best first (for tests and tuning). */
  candidates: LayoutScore[];
  /** What is still wrong after repair; empty when the drawing is clean. */
  issues: LayoutIssue[];
}

/** One finished arrangement: the laid-out copy, its score, and the grid step its distances are measured in. */
interface Tried { score: LayoutScore; arrangement: string; d: FsmDiagram; sx: number; sy: number }
interface Laid { score: LayoutScore; arrangement: string; triangles: string[][]; candidates: LayoutScore[]; d: FsmDiagram; tried: Tried[] }

/** A ranked candidate layout, as returned by layoutCandidates(). */
export interface LayoutCandidate {
  arrangement: string;
  score: LayoutScore;
  /** A laid-out copy of the diagram. */
  diagram: FsmDiagram;
  /** The grid step (px) the score's distances were measured in; pass it to score() to score the copy again. */
  step: number;
}

/** Lay out d in place: positions, arcs (Transition.curve), self-loop sides (Transition.loopAngle) and, if blocked, the start arrow's side. */
export function tidyLayout(d: FsmDiagram, opts: TidyOptions = {}): TidyResult {
  const margin = opts.margin ?? 60;
  for (const t of d.transitions) { delete t.curve; delete t.loopAngle; }
  if (d.states.length === 0) return { score: emptyScore(), arrangement: "empty", triangles: [], candidates: [], issues: [] };

  const islands = islandsOf(d);
  const laid = islands.length > 1 ? packIslands(d, islands, opts) : layoutIsland(d, opts);
  const best = laid.d;
  // Move the drawing to the top-left corner, keeping it on the grid.
  const b = planDiagram(best, opts.plan ?? {}).bounds;
  const pad = Math.max(GRID, margin - 20);
  const dx = Math.round((pad - b.minX) / GRID) * GRID, dy = Math.round((pad - b.minY) / GRID) * GRID;
  copyLayout(best, d, dx, dy);
  const { score: sc, arrangement, triangles, candidates } = laid;
  const issues: LayoutIssue[] = (["crossings", "throughStates", "labelOverlaps", "tooClose"] as const).filter((k) => sc[k] > 0).map((kind) => ({ kind, count: sc[kind] }));
  return { score: sc, arrangement, triangles, candidates, issues };
}

/**
 * Every arrangement tidyLayout() tried, best first, each as a laid-out copy
 * (d itself is not changed). For tuning the score: show people pairs of
 * these and check the score prefers the ones they pick (docs/auto-layout.md).
 * A diagram made of several islands gives just the packed result.
 */
export function layoutCandidates(d: FsmDiagram, opts: TidyOptions = {}): LayoutCandidate[] {
  const c = structuredClone(d);
  for (const t of c.transitions) { delete t.curve; delete t.loopAngle; }
  if (c.states.length === 0) return [];
  const islands = islandsOf(c);
  const laid = islands.length > 1 ? packIslands(c, islands, opts) : layoutIsland(c, opts);
  return laid.tried.map((t) => ({ arrangement: t.arrangement, score: t.score, diagram: t.d, step: t.sx }));
}

/** Positions, arcs, loop sides and start-arrow side from `from` onto `to`, shifted by (dx, dy). */
function copyLayout(from: FsmDiagram, to: FsmDiagram, dx = 0, dy = 0) {
  const byId = new Map(from.states.map((s) => [s.id, s]));
  for (const s of to.states) {
    const t = byId.get(s.id);
    if (!t) continue;
    s.x = t.x! + dx; s.y = t.y! + dy;
    if (t.initialAngle !== undefined) s.initialAngle = t.initialAngle;
  }
  const tr = new Map(from.transitions.map((t) => [t.id, t]));
  for (const t of to.transitions) {
    const u = tr.get(t.id);
    if (!u) continue;
    if (u.curve !== undefined) t.curve = u.curve;
    if (u.loopAngle !== undefined) t.loopAngle = u.loopAngle;
  }
}

/** One connected diagram: every candidate arrangement, scored, the best repaired. */
function layoutIsland(d: FsmDiagram, opts: TidyOptions): Laid {
  const spacing = opts.spacing ?? 90;
  const g = graphOf(d);
  const R = Math.max(...d.states.map((s) => stateRadius(d, s)));
  // Room for the widest label on a line between two states.
  const popts = opts.plan ?? {};
  const labelW = popts.labels === "none" ? 0 : Math.max(0, ...groupsOf(d).filter((ts) => ts[0].from !== ts[0].to).map((ts) => Math.max(...ts.flatMap((t) => labelLines(transitionLabel(d, t, popts))).map((l) => textWidth(l, LABEL_SIZE))) + 30));
  // What is drawn from a to b (a self loop when a = b): whether there is a line, and its labels if shown.
  const groupText = new Map(groupsOf(d).map((ts) => [`${ts[0].from}\u0000${ts[0].to}`, popts.labels === "none" ? "+" : ts.map((t) => transitionLabel(d, t, popts)).join("\n")]));
  const drawn = (a: string, b: string) => groupText.get(`${a}\u0000${b}`) ?? "-";
  const up40 = (v: number) => Math.ceil(v / 40) * 40; // half steps stay on the grid
  const scales = new Map<string, [number, number]>();
  scales.set(`${up40(2 * R + spacing)}`, [up40(2 * R + spacing), up40(2 * R + spacing)]);
  const wide = up40(2 * R + Math.min(Math.max(spacing, labelW), 320));
  scales.set(`${wide}`, [wide, up40(2 * R + spacing)]);
  // Big machines: one spacing only, to keep within the time budget (each candidate costs more to draw and score).
  if (d.states.length > 16 && scales.size > 1) scales.delete([...scales.keys()][0]);

  const triangles = trianglesOf(g);
  const tried: Tried[] = [];
  const finish = (c: FsmDiagram, sx: number) => {
    clearStartArrow(c, sx);
    clearStartArrow(c, sx, routeEdges(c));
    placeLoops(c);
    return score(c, planDiagram(c, popts), sx);
  };
  // Triangles with two states linked both ways must come out equilateral;
  // the others, and any three in a row, may also stay as placed if that scores better.
  const mutual = triangles.filter((t) => [[0, 1], [1, 2], [0, 2]].some(([i, j]) => {
    const a = g.ids[t[i]], b = g.ids[t[j]];
    return g.out.get(a)!.includes(b) && g.out.get(b)!.includes(a);
  }));
  // Arrangements that land every state in the same place are drawn and scored once (the first name is kept).
  const seen = new Set<string>();
  // asIs: drawn exactly as given (hub shapes), not reshaped round its triangles.
  const consider = (arrangement: string, given: Pos, sx: number, sy: number, keepRows = false, asIs = false) => {
    for (const tris of asIs ? [[]] : [triangles, mutual]) {
      const pos = equilateral(g, given, tris, 2 * R + 60, Math.min(sx, sy), keepRows, keepRows || tris === mutual);
      const key = `${sx} ` + g.ids.map((id) => { const p = pos.get(id)!; return `${Math.round(p.x / GRID)},${Math.round(p.y / GRID)}`; }).join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      const c = structuredClone(d);
      for (const s of c.states) {
        const p = pos.get(s.id)!;
        s.x = Math.round(p.x / GRID) * GRID;
        s.y = Math.round(p.y / GRID) * GRID;
      }
      tried.push({ score: finish(c, sx), arrangement, d: c, sx, sy });
    }
  };
  // Best first. Equal scores (but for rounding): the drawing whose flow leaves
  // the reset state further to the right, its successors taken in file order
  // (so a loop runs clockwise from the top left and the first state follows
  // the reset state along the top); then the order they were tried in (a grid
  // before its runner-up), not whichever rounding favours.
  const rightward = new WeakMap<Tried, number[]>();
  const flow = (t: Tried) => {
    let v = rightward.get(t);
    if (!v) {
      const at = new Map(t.d.states.map((s) => [s.id, s]));
      const o = at.get(g.init)!;
      v = g.out.get(g.init)!.map((id) => { const p = at.get(id)!; return (p.x! - o.x!) / (Math.hypot(p.x! - o.x!, p.y! - o.y!) || 1); });
      rightward.set(t, v);
    }
    return v;
  };
  const byScore = (a: Tried, b: Tried) => {
    const d = Math.round(a.score.total * 1e6) - Math.round(b.score.total * 1e6);
    if (d) return d;
    const fa = flow(a), fb = flow(b);
    for (let i = 0; i < fa.length; i++) if (Math.abs(fa[i] - fb[i]) > 1e-6) return fb[i] - fa[i];
    return 0;
  };
  const layers = flowLayers(g);
  for (const [sx, sy] of scales.values()) {
    for (const grid of grids(g, sx, sy, R)) consider("grid", grid, sx, sy);
    if (g.ids.length > 1) {
      consider("layers-right", centred(layers, sx, sy, false), sx, sy);
      consider("layers-down", centred(layers, sx, sy, true), sx, sy);
      // A long flow folded like a snake, so it reads in order and keeps a screen's shape.
      for (const k of wrapWidths(layers, sx, sy)) consider(`snake-${k}`, snake(layers, k, sx, sy), sx, sy);
      // The main loop round a rectangle, side loops as small shapes beside the state they leave from.
      for (const [name, pos] of rings(g, sx, sy)) consider(name, pos, sx, sy, true);
      // A state linked to all the others in their middle (or, being the reset state, on their left), drawn as shaped.
      for (const [name, pos] of hubs(g, sx, sy, R, drawn)) consider(name, pos, sx, sy, false, true);
    }
  }
  tried.sort(byScore);

  // Repair: spread the leading candidates out a little where that clears crossings, overlaps or lines through states.
  const bad = (sc: LayoutScore) => sc.crossings + sc.throughStates + sc.labelOverlaps + sc.tooClose;
  const step = Math.min(...[...scales.values()].map(([sx]) => sx));
  // Only candidates that would lead with their problems gone are worth it (at most five).
  const must = (sc: LayoutScore) => WEIGHTS.crossings * sc.crossings + WEIGHTS.throughStates * sc.throughStates + WEIGHTS.labelOverlaps * sc.labelOverlaps + WEIGHTS.tooClose * sc.tooClose;
  const lead = tried[0].score.total;
  for (const cand of tried.filter((t) => bad(t.score) && t.score.total - must(t.score) < lead + 10).slice(0, 5)) {
    let cur = cand;
    for (const k of [1.25, 1.5]) {
      if (!bad(cur.score)) break;
      const c = structuredClone(cand.d);
      for (const t of c.transitions) { delete t.curve; delete t.loopAngle; }
      for (const s of c.states) { s.x = Math.round((s.x! * k) / GRID) * GRID; s.y = Math.round((s.y! * k) / GRID) * GRID; }
      const sc = finish(c, step * k);
      if (bad(sc) < bad(cur.score)) cur = { score: sc, arrangement: `${cand.arrangement} (spread)`, d: c, sx: cand.sx * k, sy: cand.sy * k };
    }
    if (cur !== cand) tried.push(cur);
  }
  tried.sort(byScore);

  // Polish: a state with a long line moves to a free spot on the grid nearer
  // its neighbours, wherever that improves the score (a fixed number of
  // tries, so big machines stay quick). Of the three nearest spots the best
  // is taken, not the first that helps. Only the best two are polished, and
  // only those near the best: polish fixes a drawing, it should not make a
  // new one. (Polishing the best four turned traffic_three_block, labels
  // shown, from the clockwise square into new shapes with the reset state
  // at the bottom left or a state below the middle.)
  let budget = Math.min(48, Math.round(4e4 / Math.max(1, edgePairs(g).length) ** 2));
  for (const cand of tried.slice(0, 2).filter((c) => c.score.total <= 1.5 * tried[0].score.total)) {
    let cur = cand;
    const gap = 2 * R + 40;
    for (let round = 0; round < 3 && budget > 0; round++) {
      let next: Tried | undefined;
      const at = new Map(cur.d.states.map((s) => [s.id, { x: s.x!, y: s.y! }]));
      const reach = (id: string, p: Pt) => [...g.nb.get(id)!].reduce((sum, v) => sum + Math.hypot((p.x - at.get(v)!.x) / cur.sx, (p.y - at.get(v)!.y) / cur.sy), 0);
      const longest = new Map(g.ids.map((id) => [id, Math.max(0, ...[...g.nb.get(id)!].map((v) => Math.hypot((at.get(id)!.x - at.get(v)!.x) / cur.sx, (at.get(id)!.y - at.get(v)!.y) / cur.sy)))]));
      const movers = g.ids.filter((id) => longest.get(id)! > 1.5).sort((a, b) => longest.get(b)! - longest.get(a)!);
      const o = at.get(g.init)!;
      for (const id of movers) {
        if (budget <= 0) break;
        const here = at.get(id)!;
        const ns = [...g.nb.get(id)!].map((v) => at.get(v)!);
        const mx = ns.reduce((s, p) => s + p.x, 0) / ns.length, my = ns.reduce((s, p) => s + p.y, 0) / ns.length;
        const now = reach(id, here);
        // The reset state does not move right of another state (unless it is already).
        const left = Math.min(...[...at].filter(([v]) => v !== id).map(([, q]) => q.x));
        const ok = (p: Pt) => id !== g.init || p.x <= Math.max(here.x, left + GRID);
        const spots: Array<{ p: Pt; r: number }> = []; // free grid spots near the neighbours' centre, with the line length they give
        for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
          const p = { x: o.x + (Math.round((mx - o.x) / cur.sx) + i) * cur.sx, y: o.y + (Math.round((my - o.y) / cur.sy) + j) * cur.sy };
          const r = reach(id, p);
          if (r < now - 0.3 && ok(p) && [...at].every(([v, q]) => v === id || Math.hypot(p.x - q.x, p.y - q.y) >= gap)) spots.push({ p, r });
        }
        for (const { p } of spots.sort((a, b) => a.r - b.r).slice(0, 3)) {
          if (budget-- <= 0) break;
          const c = structuredClone(cur.d);
          for (const t of c.transitions) { delete t.curve; delete t.loopAngle; }
          for (const s of c.states) delete s.initialAngle;
          const s = c.states.find((x) => x.id === id)!;
          s.x = Math.round(p.x / GRID) * GRID; s.y = Math.round(p.y / GRID) * GRID;
          const sc = finish(c, cur.sx);
          if (sc.total < (next ?? cur).score.total - 1e-6) next = { ...cur, score: sc, d: c, arrangement: cand.arrangement.endsWith("(polished)") ? cand.arrangement : `${cand.arrangement} (polished)` };
        }
        if (next) break;
      }
      if (!next) break;
      cur = next;
    }
    if (cur !== cand) tried.push(cur);
  }
  tried.sort(byScore);
  const best = tried[0];
  return { score: best.score, arrangement: best.arrangement, triangles: triangles.map((c) => c.map((i) => g.ids[i])), candidates: tried.map((t) => t.score), d: best.d, tried };
}

// ---- islands --------------------------------------------------------------------

/** States linked to each other (either way), the reset state's island first, then in file order. */
function islandsOf(d: FsmDiagram): string[][] {
  const nb = new Map(d.states.map((s) => [s.id, new Set<string>()]));
  for (const t of d.transitions) { nb.get(t.from)?.add(t.to); nb.get(t.to)?.add(t.from); }
  const init = d.states.find((s) => s.isInitial);
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const s of init ? [init, ...d.states] : d.states) {
    if (seen.has(s.id)) continue;
    const island = [s.id];
    seen.add(s.id);
    for (let i = 0; i < island.length; i++) for (const v of nb.get(island[i])!) if (!seen.has(v)) { seen.add(v); island.push(v); }
    out.push(island);
  }
  return out;
}

/** Lay out each island on its own, then pack them in rows about as wide as the whole is tall. */
function packIslands(d: FsmDiagram, islands: string[][], opts: TidyOptions): Laid {
  const popts = opts.plan ?? {};
  const parts = islands.map((ids) => {
    const keep = new Set(ids);
    const sub = structuredClone(d);
    sub.states = sub.states.filter((s) => keep.has(s.id));
    sub.transitions = sub.transitions.filter((t) => keep.has(t.from) && keep.has(t.to));
    const laid = layoutIsland(sub, opts);
    return { laid, b: planDiagram(laid.d, popts).bounds };
  });
  const gap = 6 * GRID;
  const area = parts.reduce((s, { b }) => s + (b.maxX - b.minX + gap) * (b.maxY - b.minY + gap), 0);
  const rowWidth = Math.max(...parts.map(({ b }) => b.maxX - b.minX), Math.sqrt(area) * 1.2);
  const out = structuredClone(d);
  let x = 0, y = 0, rowH = 0;
  for (const { laid, b } of parts) {
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    if (x > 0 && x + w > rowWidth) { x = 0; y += rowH + gap; rowH = 0; }
    copyLayout(laid.d, out, Math.round((x - b.minX) / GRID) * GRID, Math.round((y - b.minY) / GRID) * GRID);
    x += w + gap;
    rowH = Math.max(rowH, h);
  }
  const sc = score(out, planDiagram(out, popts));
  const step = Math.min(...parts.map((p) => p.laid.tried[0]?.sx ?? 200));
  return { score: sc, arrangement: "islands", triangles: parts.flatMap((p) => p.laid.triangles), candidates: [sc], d: out, tried: [{ score: sc, arrangement: "islands", d: out, sx: step, sy: step }] };
}

// ---- graph ----------------------------------------------------------------------

function graphOf(d: FsmDiagram): Graph {
  const init = (d.states.find((s) => s.isInitial) ?? d.states[0]).id;
  const ids = [init, ...d.states.map((s) => s.id).filter((id) => id !== init)];
  const out = new Map(ids.map((id) => [id, [] as string[]]));
  const nb = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const t of d.transitions) {
    if (t.from === t.to) continue;
    if (!out.get(t.from)!.includes(t.to)) out.get(t.from)!.push(t.to);
    nb.get(t.from)!.add(t.to);
    nb.get(t.to)!.add(t.from);
  }
  return { ids, init, out, nb };
}

function groupsOf(d: FsmDiagram) {
  const groups = new Map<string, FsmDiagram["transitions"]>();
  for (const t of d.transitions) {
    const k = `${t.from}\u0000${t.to}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  return [...groups.values()];
}

/** Longest simple path from start, or the longest cycle back to start (depth-first, with a work limit). */
function longest(g: Graph, start: string, cycle: boolean): string[] {
  let best: string[] = cycle ? [] : [start];
  let budget = 40000;
  const path = [start];
  const seen = new Set(path);
  const dfs = (u: string) => {
    if (--budget < 0) return;
    for (const v of g.out.get(u)!) {
      if (cycle && v === start && path.length >= 3 && path.length > best.length) best = [...path];
      if (seen.has(v)) continue;
      seen.add(v); path.push(v);
      if (!cycle && path.length > best.length) best = [...path];
      dfs(v);
      path.pop(); seen.delete(v);
    }
  };
  dfs(start);
  return best;
}

/** Three states all linked to each other, by index into g.ids. */
function trianglesOf(g: Graph): number[][] {
  const at = new Map(g.ids.map((id, i) => [id, i]));
  const adj = g.ids.map((id) => new Set([...g.nb.get(id)!].map((v) => at.get(v)!)));
  const out: number[][] = [];
  for (let a = 0; a < adj.length; a++)
    for (const b of adj[a]) if (b > a)
      for (const c of adj[b]) if (c > b && adj[a].has(c)) out.push([a, b, c]);
  return out;
}

// ---- grid -----------------------------------------------------------------------

/**
 * States in a grid about as tall as it is wide, the reset state in the left
 * column, arranged by moving states between cells to reduce crossings, lines
 * through states, diagonal and long lines. Tries a few grid widths (about
 * square and one column wider; a small machine also two wider, for a
 * screen-shaped drawing) and starting orders. For each width the cheapest
 * grid is a candidate, and up to 16 states the runner-up too: the full score
 * sees arcs, loops and symmetry the grid's own cost does not.
 */
function* grids(g: Graph, sx: number, sy: number, R: number): Generator<Pos> {
  const n = g.ids.length;
  const base = Math.max(1, Math.round(Math.sqrt((n * sy) / sx)));
  const starts: Array<[string[], boolean]> = [[bfsLayers(g).flat(), false], [snakeOrder(g), false]];
  // A long loop through the reset state: walk it around the grid and back.
  const ring = longest(g, g.init, true);
  if (ring.length >= Math.max(4, n / 2)) starts.push([[...ring, ...bfsLayers(g).flat().filter((id) => !ring.includes(id))], true]);
  const widths = new Set([base, base + 1]);
  // The third, wider grid only up to 12 states. This limit also keeps
  // cle_locked (16 states) drawn as the ring the user picked (p08, p09): a
  // 5- or 6-column grid scores better than that ring today, so the score, not
  // only this limit, should learn the ring before the limit is raised.
  if (n <= 12 && Math.ceil(n / (base + 2)) >= 2) widths.add(base + 2);
  for (const cols of widths) {
    const found = improveGrid(g, starts, cols, sx, sy, R);
    yield found[0][0];
    if (n <= 16 && found.length > 1) yield found[1][0];
  }
}

/** Longest path from the reset state, then the others in breadth-first order. */
function snakeOrder(g: Graph): string[] {
  const path = longest(g, g.init, false);
  return [...path, ...bfsLayers(g).flat().filter((id) => !path.includes(id))];
}

/** Layers by distance from the reset state, ordered to reduce crossings (barycentre sweeps). */
function bfsLayers(g: Graph): string[][] {
  const depth = new Map<string, number>([[g.init, 0]]);
  const queue = [g.init];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of g.out.get(u)!) if (!depth.has(v)) { depth.set(v, depth.get(u)! + 1); queue.push(v); }
  }
  // Unreachable states: next to a neighbour if they have one, else after everything.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of g.ids) {
      if (depth.has(id)) continue;
      const ds = [...g.nb.get(id)!].filter((v) => depth.has(v)).map((v) => depth.get(v)!);
      if (ds.length) { depth.set(id, Math.min(...ds) + 1); changed = true; }
    }
  }
  const last = Math.max(...depth.values()) + 1;
  for (const id of g.ids) if (!depth.has(id)) depth.set(id, last);
  const layers: string[][] = [];
  for (const id of g.ids) (layers[depth.get(id)!] ??= []).push(id);
  return order(g, layers.filter(Boolean));
}

function order(g: Graph, layers: string[][]): string[][] {
  const idx = () => new Map(layers.flatMap((l) => l.map((id, i) => [id, i - (l.length - 1) / 2] as const)));
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0;
    const range = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
    for (const li of range) {
      const ref = new Set(layers[down ? li - 1 : li + 1]);
      const at = idx();
      const key = new Map(layers[li].map((id) => {
        const ns = [...g.nb.get(id)!].filter((v) => ref.has(v));
        return [id, ns.length ? ns.reduce((s, v) => s + at.get(v)!, 0) / ns.length : at.get(id)!] as const;
      }));
      layers[li] = [...layers[li]].sort((a, b) => key.get(a)! - key.get(b)!);
    }
  }
  return layers;
}

/**
 * Layers for a left-to-right (or top-to-bottom) flow: a depth-first walk
 * from the reset state sets aside lines back to a state still on the walk
 * (they close loops) and lines into the reset state; every other line goes
 * forward, each state one layer past its furthest predecessor. Each layer is
 * then ordered to reduce crossings.
 */
function flowLayers(g: Graph): string[][] {
  const mark = new Map<string, 1 | 2>(); // 1 on the walk, 2 done
  const post: string[] = [];
  const ahead = new Map(g.ids.map((id) => [id, [] as string[]]));
  const visit = (u: string) => {
    mark.set(u, 1);
    for (const v of g.out.get(u)!) {
      if (mark.get(v) === 1 || v === g.init) continue;
      ahead.get(u)!.push(v);
      if (!mark.has(v)) visit(v);
    }
    mark.set(u, 2);
    post.push(u);
  };
  for (const id of g.ids) if (!mark.has(id)) visit(id);
  const layer = new Map(g.ids.map((id) => [id, 0]));
  for (const u of post.reverse()) for (const v of ahead.get(u)!) layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
  const layers: string[][] = [];
  for (const id of g.ids) (layers[layer.get(id)!] ??= []).push(id);
  return order(g, layers.filter(Boolean));
}

/** Each layer centred on one axis, evenly spaced. */
function centred(layers: string[][], sx: number, sy: number, down: boolean): Pos {
  const pos: Pos = new Map();
  layers.forEach((l, li) => l.forEach((id, j) => {
    const off = j - (l.length - 1) / 2;
    pos.set(id, down ? { x: off * sx, y: li * sy } : { x: li * sx, y: off * sy });
  }));
  return pos;
}

/** Layers per row worth trying for a snake: those near a square drawing. */
function wrapWidths(layers: string[][], sx: number, sy: number): number[] {
  const L = layers.length;
  if (L < 4) return [];
  const tall = Math.max(...layers.map((l) => l.length));
  const out = new Set<number>();
  // Rows of k layers, each row as tall as its tallest layer: aim for width close to height.
  for (let k = 2; k < L; k++) {
    const rows = Math.ceil(L / k);
    const h = rows * (tall * sy + sy * 0.5), w = k * sx;
    if (w / h > 0.6 && w / h < 1.8) out.add(k);
  }
  return [...out].slice(0, 3);
}

/**
 * The layers in rows of k, every other row right to left, so the flow snakes
 * down the page and each step from one row to the next is a short drop.
 * A layer's states are stacked within its row.
 */
function snake(layers: string[][], k: number, sx: number, sy: number): Pos {
  const pos: Pos = new Map();
  let top = 0;
  for (let r = 0; r * k < layers.length; r++) {
    const row = layers.slice(r * k, r * k + k);
    const tall = Math.max(...row.map((l) => l.length));
    row.forEach((l, c) => {
      const col = r % 2 ? k - 1 - c : c;
      l.forEach((id, j) => pos.set(id, { x: col * sx, y: top + (j + (tall - l.length) / 2) * sy }));
    });
    top += tall * sy;
  }
  return pos;
}

// ---- rings and satellites -----------------------------------------------------

/**
 * Pieces of the diagram that stay linked when any one state is taken away
 * (biconnected components; a single line is a piece of two). A state shared
 * by two pieces is where one hangs off the other.
 */
function blocksOf(g: Graph): string[][] {
  const disc = new Map<string, number>(), low = new Map<string, number>();
  const stack: Array<[string, string]> = [];
  const out: string[][] = [];
  const visit = (u: string, parent?: string) => {
    disc.set(u, disc.size); low.set(u, disc.get(u)!);
    for (const v of g.nb.get(u)!) {
      if (!disc.has(v)) {
        stack.push([u, v]);
        visit(v, u);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
        if (low.get(v)! >= disc.get(u)!) {
          const set = new Set<string>();
          let e: [string, string];
          do { e = stack.pop()!; set.add(e[0]); set.add(e[1]); } while (e[0] !== u || e[1] !== v);
          out.push(g.ids.filter((id) => set.has(id)));
        }
      } else if (v !== parent && disc.get(v)! < disc.get(u)!) {
        stack.push([u, v]);
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  };
  for (const id of g.ids) if (!disc.has(id)) visit(id);
  return out;
}

/** A loop through every state of the piece, starting at `start`: along the lines' directions if possible, else either way. */
function ringOf(g: Graph, block: string[], start: string): string[] | undefined {
  if (block.length <= 2) return start === block[0] ? block : [...block].reverse();
  const inside = new Set(block);
  for (const next of [(u: string) => g.out.get(u)!, (u: string) => [...g.nb.get(u)!]]) {
    const path = [start], seen = new Set(path);
    let found: string[] | undefined, budget = 20000;
    const dfs = (u: string) => {
      for (const v of next(u)) {
        if (found || --budget < 0) return;
        if (!inside.has(v)) continue;
        if (v === start && path.length === block.length) { found = [...path]; return; }
        if (seen.has(v)) continue;
        seen.add(v); path.push(v); dfs(v); path.pop(); seen.delete(v);
      }
    };
    dfs(start);
    if (found) return found;
  }
  return undefined;
}

/** Cells (in steps) for a loop of m states, clockwise from the first: a line, an apex-down triangle, a square, or the edge of a c × r rectangle. */
function ringShape(m: number, c: number, r: number): Pt[] {
  if (m === 2) return [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  if (m === 3) return [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: -0.5, y: 1 }];
  const cells: Pt[] = [];
  for (let x = 0; x < c; x++) cells.push({ x, y: 0 });
  for (let y = 1; y < r; y++) cells.push({ x: c - 1, y });
  for (let x = c - 2; x >= 0; x--) cells.push({ x, y: r - 1 });
  for (let y = r - 2; y >= 1; y--) cells.push({ x: 0, y });
  // One cell more than states: leave out the bottom-left corner.
  if (cells.length > m) cells.splice(cells.length - r + 1, 1);
  return cells;
}

/** Rectangles whose edge holds a loop of m states, squarest first. */
function ringSizes(m: number): Array<[number, number]> {
  if (m <= 4) return [[2, 2]];
  const half = Math.ceil((m + 4) / 2);
  const out: Array<[number, number]> = [];
  for (let r = 2; r <= half - 2; r++) out.push([half - r, r]);
  return out.sort((a, b) => Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]));
}

/**
 * The largest piece drawn as a loop round the edge of a rectangle (the reset
 * state's way in at the top left, the flow clockwise), and every piece
 * hanging off it as its own small shape, a triangle, square or rectangle,
 * turned to point away from the piece it hangs off, so short side loops sit
 * next to the state they leave from. Only for diagrams whose every piece has
 * such a loop. Triangles come out equilateral. One result per rectangle size tried.
 */
function rings(g: Graph, sx: number, sy: number): Array<[string, Pos]> {
  const blocks = blocksOf(g);
  if (!blocks.length) return [];
  const rootIdx = blocks.reduce((best, b, i) => (b.length > blocks[best].length ? i : best), 0);
  const holders = new Map(g.ids.map((id) => [id, [] as number[]]));
  blocks.forEach((b, i) => b.forEach((id) => holders.get(id)!.push(i)));
  // Tree of pieces from the root: each piece's parent and the state they share.
  const via = new Map<number, string>(), parent = new Map<number, number>();
  const queue = [rootIdx];
  const seenB = new Set(queue);
  while (queue.length) {
    const b = queue.shift()!;
    for (const id of blocks[b]) for (const c of holders.get(id)!) if (!seenB.has(c)) { seenB.add(c); parent.set(c, b); via.set(c, id); queue.push(c); }
  }
  // The root's loop starts where the way to the reset state leaves it.
  let start = g.init, bi = holders.get(g.init)![0];
  if (!blocks[rootIdx].includes(g.init)) {
    while (parent.get(bi) !== rootIdx) bi = parent.get(bi)!;
    start = via.get(bi)!;
  }
  const loops = new Map<number, string[]>();
  for (const [i, b] of blocks.entries()) {
    const loop = ringOf(g, b, i === rootIdx ? start : via.get(i)!);
    if (!loop) return [];
    loops.set(i, loop);
  }
  const turns = [0, 1, 2, 3].flatMap((k) => [false, true].map((flip) => (p: Pt) => {
    let { x, y } = flip ? { x: -p.x, y: p.y } : p;
    for (let i = 0; i < k; i++) [x, y] = [-y, x];
    return { x, y };
  }));
  const centroid = (ps: Pt[]) => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });
  const out: Array<[string, Pos]> = [];
  for (const [c, r] of ringSizes(blocks[rootIdx].length).slice(0, 3)) {
    const pos: Pos = new Map();
    const rootLoop = loops.get(rootIdx)!;
    const side = Math.min(sx, sy);
    const px = (p: Pt, tri: boolean) => (tri ? { x: p.x * side, y: p.y * side * 0.866 } : { x: p.x * sx, y: p.y * sy });
    ringShape(rootLoop.length, c, r).forEach((p, i) => pos.set(rootLoop[i], px(p, rootLoop.length === 3)));
    const centre = new Map([[rootIdx, centroid(rootLoop.map((id) => pos.get(id)!))]]);
    const todo = [rootIdx];
    while (todo.length) {
      const b = todo.shift()!;
      for (const id of loops.get(b)!) for (const k of holders.get(id)!) {
        if (parent.get(k) !== b || via.get(k) !== id || centre.has(k)) continue;
        const loop = loops.get(k)!;
        const [kc, kr] = ringSizes(loop.length)[0];
        const shape = ringShape(loop.length, kc, kr);
        const at = pos.get(id)!, from = centre.get(b)!;
        let u = { x: at.x - from.x, y: at.y - from.y };
        const l = Math.hypot(u.x, u.y);
        u = l > 1e-9 ? { x: u.x / l, y: u.y / l } : { x: 0, y: -1 };
        let best: Pt[] = [], bestCost = Infinity;
        for (const turn of turns) {
          // Rectangles turn on the grid; a triangle turns as drawn, so it stays equilateral.
          const ps = shape.map((p) => { const q = loop.length === 3 ? turn(px(p, true)) : px(turn(p), false); return { x: at.x + q.x, y: at.y + q.y }; });
          const m = centroid(ps);
          let cost = (-2 * ((m.x - at.x) * u.x + (m.y - at.y) * u.y)) / side;
          for (const p of ps.slice(1)) for (const q of pos.values()) if (Math.hypot(p.x - q.x, p.y - q.y) < 0.9 * side) cost += 10;
          const home = loop.indexOf(g.init);
          if (home > 0) cost += (0.3 * (ps[home].x - at.x)) / side; // the reset state towards the left
          if (cost < bestCost - 1e-9) { bestCost = cost; best = ps; }
        }
        loop.forEach((s, i) => { if (i > 0) pos.set(s, best[i]); });
        centre.set(k, centroid(best));
        todo.push(k);
      }
    }
    out.push([`ring-${c}x${r}`, pos]);
  }
  return out;
}

// ---- hubs -----------------------------------------------------------------------

/**
 * A state linked to every other state (a star, a wheel, four states all
 * linked to each other) drawn in the middle of the others, so its lines are
 * short and stay clear of the lines between the others: the others go round
 * it in the order of their own loop, on the eight cells around it (the four
 * level and upright ones first) or, for three, as an equilateral triangle
 * with the hub at its centre. A hub that is the reset state, which should be
 * the leftmost, is also tried as a fan: on the left, the others above, right
 * of and below it. Each shape is turned so the lines between the others and
 * the reset state's place cost least (a quick measure, as for the grid); the
 * score then decides between these and every other arrangement.
 */
function hubs(g: Graph, sx: number, sy: number, R: number, drawn: (a: string, b: string) => string): Array<[string, Pos]> {
  const n = g.ids.length;
  if (n < 4 || n > 9) return [];
  const edges = edgePairs(g);
  const quick = (pos: Pos) => {
    let c = 0;
    const segs = edges.map(([a, b]) => [pos.get(a)!, pos.get(b)!, a, b] as const);
    for (let i = 0; i < segs.length; i++) {
      const [p, q, a, b] = segs[i];
      const dx = Math.abs(p.x - q.x) / sx, dy = Math.abs(p.y - q.y) / sy, len = Math.hypot(dx, dy);
      c += len + (dx > 0.1 && dy > 0.1 ? 0.4 : 0) + 4 * Math.max(0, len - 1.5);
      for (const [id, s] of pos) if (id !== a && id !== b && segDist(s, p, q) < R + 10) c += 15;
      for (let j = i + 1; j < segs.length; j++) {
        const [r, s2, e, f] = segs[j];
        if (e !== a && e !== b && f !== a && f !== b && intersect(p, q, r, s2)) c += 10;
      }
    }
    const o = pos.get(g.init)!;
    for (const p of pos.values()) if (p.x < o.x - GRID) c += 15; // nothing left of the reset state
    return c;
  };
  // Cells round the hub, clockwise from the left (y grows downwards).
  const L = { x: -1, y: 0 }, UL = { x: -1, y: -1 }, U = { x: 0, y: -1 }, UR = { x: 1, y: -1 }, Rt = { x: 1, y: 0 }, DR = { x: 1, y: 1 }, D = { x: 0, y: 1 }, DL = { x: -1, y: 1 };
  const subsets = <T,>(xs: T[], k: number): T[][] => (k === 0 ? [[]] : xs.length < k ? [] : [...subsets(xs.slice(1), k - 1).map((s) => [xs[0], ...s]), ...subsets(xs.slice(1), k)]);
  const clockwise = (cs: Pt[]) => [...cs].sort((a, b) => Math.atan2(-a.y, a.x) - Math.atan2(-b.y, b.x)).reverse();
  const out: Array<[string, Pos]> = [];
  const shapes = new Set<string>();
  for (const hub of g.ids.filter((id) => g.nb.get(id)!.size === n - 1).slice(0, 4)) {
    const rim = g.ids.filter((id) => id !== hub);
    const m = rim.length;
    const loop = ringOf(g, rim, rim[0]);
    const order = loop ?? walkOrder(g, rim);
    const families: Array<[string, Pt[][]]> = []; // name, the cell sets (px) to choose from
    const step = (sx + sy) / 2;
    // In the middle only when the others make a loop round it (a wheel), so
    // the spokes stay inside the loop; a plain star the grid already draws as a plus.
    if (loop && m === 3) {
      // An equilateral triangle, the hub at its centre, one step from each corner; pointing left, right, up or down.
      const tri = [0, 1, 2, 3].map((k) => [0, 1, 2].map((i) => {
        const a = (k * Math.PI) / 2 + Math.PI + (i * 2 * Math.PI) / 3;
        return { x: Math.cos(a) * step, y: Math.sin(a) * step };
      }));
      for (const t of tri) families.push(["hub-triangle", [t]]); // each way round: the score weighs their shapes
    } else if (loop && m <= 8) {
      const cells = (cs: Pt[]) => clockwise(cs).map((c) => ({ x: c.x * sx, y: c.y * sy }));
      if (m === 4) families.push(["hub-square", [cells([UL, UR, DR, DL])]]);
      families.push(["hub-wheel", subsets([UL, UR, DR, DL], m - 4).map((cs) => cells([L, U, Rt, D, ...cs]))]);
    }
    if (hub === g.init && m >= 3 && m <= 5) families.push(["hub-fan", subsets([UR, Rt, DR], m - 2).map((cs) => [U, ...cs, D].map((c) => ({ x: c.x * sx, y: c.y * sy })))]);
    for (const [name, sets] of families) {
      let best: Pos | undefined, bestCost = Infinity;
      for (const cs of sets) for (let k = 0; k < m; k++) for (const dir of [1, -1]) {
        const pos: Pos = new Map([[hub, { x: 0, y: 0 }]]);
        order.forEach((id, i) => pos.set(id, cs[(((k + dir * i) % m) + m) % m]));
        const c = quick(pos);
        if (c < bestCost - 1e-9) { bestCost = c; best = pos; }
      }
      if (!best) continue;
      // Symmetric machines (four states all linked) give the same drawing from
      // several hubs, the states only named differently: draw it once.
      const x0 = Math.min(...[...best.values()].map((p) => p.x)), y0 = Math.min(...[...best.values()].map((p) => p.y));
      const cell = (id: string) => { const p = best!.get(id)!; return `${Math.round((p.x - x0) / GRID)},${Math.round((p.y - y0) / GRID)}`; };
      const sig = `${name} ${cell(g.init)} ` + g.ids.flatMap((a) => [a, ...g.out.get(a)!].map((b) => `${cell(a)}>${cell(b)}:${drawn(a, b)}`)).sort().join(" ");
      if (!shapes.has(sig)) { shapes.add(sig); out.push([name, best]); }
    }
  }
  return out;
}

/** The states in `ids` in the order of a walk along their lines, jumping to the next unvisited one when stuck. */
function walkOrder(g: Graph, ids: string[]): string[] {
  const inside = new Set(ids), seen = new Set<string>(), out: string[] = [];
  for (const s of ids) {
    let u: string | undefined = s;
    while (u && !seen.has(u)) {
      seen.add(u); out.push(u);
      u = [...g.nb.get(u)!].find((v) => inside.has(v) && !seen.has(v));
    }
  }
  return out;
}

/** Undirected edges between different states, each once. */
function edgePairs(g: Graph): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const a of g.ids) for (const b of g.nb.get(a)!) if (a < b) out.push([a, b]);
  return out;
}

/** A cost rounded to a multiple of 2^-20, so sums of costs are exact whatever order they are added in. */
const exact = (v: number) => Math.round(v * 1048576) / 1048576;

/**
 * The grid annealer's cost, kept up to date as states move instead of
 * recomputed from scratch: one entry per line (its length cost and how many
 * states it runs through) and one per pair of lines (whether they cross).
 * A move changes only the lines of the states that moved, plus, when a state
 * moves into or out of an empty cell, which lines run through that cell; so
 * a step costs about (lines of the moved states) × lines instead of
 * lines × (states + lines).
 * Geometry that depends only on the cells (a line's cost between two cells,
 * which cells a line between two cells runs through) is tabled once.
 * Every term is a multiple of 2^-20, so the running total is exact: the same
 * number a full recount gives, and ties between moves are real ties.
 */
export class GridCost { // exported for test/layout/grid-cost.test.ts (running total vs a full recount); not re-exported from index.ts
  readonly C: number; // cells
  readonly E: number; // lines
  readonly slot: Int32Array; // cell of each state
  readonly owner: Int32Array; // state in each cell, -1 when empty
  readonly ea: Int32Array; readonly eb: Int32Array; // the two states of each line
  readonly inc: number[][]; // lines at each state
  private readonly cx: Float64Array; private readonly cy: Float64Array; // cell centres
  private readonly home: Float64Array; // the reset state's cost in each cell: on the left and near the top
  private readonly lineCost: Float64Array; // [a * C + b]: cost of a line between cells a and b
  private readonly through: Uint8Array; // [(a * C + b) * C + c]: a line from cell a to cell b runs through cell c
  private readonly onStart: Int32Array; private readonly onCells: Int32Array; // the same as lists: cells on the line a * C + b are onCells[onStart[k] .. onStart[k + 1])
  private readonly at: Float64Array; // per line: its ends' coordinates, x0 y0 x1 y1
  private readonly eLen: Float64Array; // per line: its length cost
  private readonly eThru: Int32Array; // per line: occupied cells it runs through (its own two ends included)
  private readonly X: Uint8Array; // [e * E + f]: lines e and f cross
  private readonly stamp: Int32Array; private tick = 0; // marks the lines touched by the current move
  // Undo log of the last move: moved states and their old cells, old per-line entries, old pair entries.
  private readonly mvS: number[] = []; private readonly mvFrom: number[] = [];
  private readonly logE: number[] = []; private readonly logLen: number[] = []; private readonly logThru: number[] = [];
  private readonly logX: number[] = []; private readonly logXv: number[] = [];
  private readonly freed: number[] = []; private readonly filled: number[] = []; // cells a move emptied or filled
  private prev = 0;
  total = 0;

  constructor(cells: Pt[], n: number, pairs: Array<[number, number]>, sx: number, sy: number, R: number) {
    const C = (this.C = cells.length), E = (this.E = pairs.length);
    this.slot = new Int32Array(n).fill(-1); this.owner = new Int32Array(C).fill(-1);
    this.ea = Int32Array.from(pairs, (p) => p[0]); this.eb = Int32Array.from(pairs, (p) => p[1]);
    this.inc = Array.from({ length: n }, () => []);
    pairs.forEach(([a, b], e) => { this.inc[a].push(e); this.inc[b].push(e); });
    this.cx = Float64Array.from(cells, (p) => p.x); this.cy = Float64Array.from(cells, (p) => p.y);
    this.home = Float64Array.from(cells, (p) => exact((p.x !== 0 ? 50 : 0) + (0.2 * p.y) / sy));
    this.lineCost = new Float64Array(C * C); this.through = new Uint8Array(C * C * C);
    for (let a = 0; a < C; a++) for (let b = a + 1; b < C; b++) {
      const p = cells[a], q = cells[b];
      const dx = Math.abs(p.x - q.x) / sx, dy = Math.abs(p.y - q.y) / sy, l = Math.hypot(dx, dy);
      this.lineCost[a * C + b] = this.lineCost[b * C + a] = exact(l + (dx && dy ? 0.4 : 0) + 4 * Math.max(0, l - 1.5));
      for (let c = 0; c < C; c++) this.through[(a * C + b) * C + c] = this.through[(b * C + a) * C + c] = segDist(cells[c], p, q) < R + 10 ? 1 : 0;
    }
    this.onStart = new Int32Array(C * C + 1);
    const on: number[] = [];
    for (let k = 0; k < C * C; k++) {
      this.onStart[k] = on.length;
      if (Math.floor(k / C) !== k % C) for (let c = 0; c < C; c++) if (this.through[k * C + c]) on.push(c);
    }
    this.onStart[C * C] = on.length;
    this.onCells = Int32Array.from(on);
    this.at = new Float64Array(4 * E);
    this.eLen = new Float64Array(E); this.eThru = new Int32Array(E); this.X = new Uint8Array(E * E); this.stamp = new Int32Array(E);
  }

  /** Put every state in its cell and compute everything from scratch. */
  reset(slot: ArrayLike<number>): number {
    this.owner.fill(-1);
    for (let s = 0; s < this.slot.length; s++) { this.slot[s] = slot[s]; this.owner[slot[s]] = s; }
    const { E, X } = this;
    for (let e = 0; e < E; e++) this.place(e);
    let total = this.home[this.slot[0]];
    for (let e = 0; e < E; e++) {
      total += this.eLen[e] = this.lineCost[this.slot[this.ea[e]] * this.C + this.slot[this.eb[e]]];
      total += 15 * ((this.eThru[e] = this.thruOf(e)) - 2);
      for (let f = e + 1; f < E; f++) total += 10 * (X[e * E + f] = X[f * E + e] = this.crossOf(e, f));
    }
    return (this.total = total);
  }

  /** The same, from scratch, without touching the tables (to check the running total). */
  full(): number {
    let total = this.home[this.slot[0]];
    for (let e = 0; e < this.E; e++) {
      total += this.lineCost[this.slot[this.ea[e]] * this.C + this.slot[this.eb[e]]] + 15 * (this.thruOf(e) - 2);
      for (let f = e + 1; f < this.E; f++) total += 10 * this.crossOf(e, f);
    }
    return total;
  }

  /** Line e's ends, from its states' cells. */
  private place(e: number) {
    const a = this.slot[this.ea[e]], b = this.slot[this.eb[e]], at = this.at;
    at[4 * e] = this.cx[a]; at[4 * e + 1] = this.cy[a]; at[4 * e + 2] = this.cx[b]; at[4 * e + 3] = this.cy[b];
  }
  /** Occupied cells line e runs through, its ends included. */
  private thruOf(e: number): number {
    const k = this.slot[this.ea[e]] * this.C + this.slot[this.eb[e]], owner = this.owner, on = this.onCells;
    let n = 0;
    for (let i = this.onStart[k]; i < this.onStart[k + 1]; i++) if (owner[on[i]] >= 0) n++;
    return n;
  }
  /** Whether lines e and f cross (the test intersect() makes); lines that share a state never do. */
  private crossOf(e: number, f: number): number {
    const a = this.ea[e], b = this.eb[e], c = this.ea[f], d = this.eb[f];
    if (a === c || a === d || b === c || b === d) return 0;
    const at = this.at;
    return cross(at[4 * e], at[4 * e + 1], at[4 * e + 2], at[4 * e + 3], at[4 * f], at[4 * f + 1], at[4 * f + 2], at[4 * f + 3]);
  }

  /** Move states[i] to cell to[i] (all at once, so two may swap) and return the new total; undo() takes it back. */
  move(states: ArrayLike<number>, to: ArrayLike<number>): number {
    const { slot, owner, stamp, inc, E, C, X, ea, eb, at } = this;
    const tick = ++this.tick;
    this.mvS.length = this.mvFrom.length = this.logE.length = this.logLen.length = this.logThru.length = this.logX.length = this.logXv.length = 0;
    this.prev = this.total;
    let total = this.total - this.home[slot[0]];
    for (let i = 0; i < states.length; i++) { this.mvS.push(states[i]); this.mvFrom.push(slot[states[i]]); owner[slot[states[i]]] = -1; }
    for (let i = 0; i < states.length; i++) { slot[states[i]] = to[i]; owner[to[i]] = states[i]; }
    total += this.home[slot[0]];
    for (let i = 0; i < states.length; i++) for (const e of inc[states[i]]) this.place(e);
    // Lines of the moved states: everything about them is recomputed.
    for (let i = 0; i < states.length; i++) for (const e of inc[states[i]]) {
      if (stamp[e] === tick) continue;
      stamp[e] = tick;
      this.logE.push(e); this.logLen.push(this.eLen[e]); this.logThru.push(this.eThru[e]);
      const len = this.lineCost[slot[ea[e]] * C + slot[eb[e]]], thru = this.thruOf(e);
      total += len - this.eLen[e] + 15 * (thru - this.eThru[e]);
      this.eLen[e] = len; this.eThru[e] = thru;
      // Its crossings with every other line (a pair of two moved lines comes up twice; the second time nothing changes).
      const a = ea[e], b = eb[e], eE = e * E;
      const ax = at[4 * e], ay = at[4 * e + 1], bx = at[4 * e + 2], by = at[4 * e + 3];
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      for (let f = 0; f < E; f++) {
        let x = 0;
        const c = ea[f], d = eb[f], qx = at[4 * f], qy = at[4 * f + 1], ex = at[4 * f + 2], ey = at[4 * f + 3];
        // Lines that share a state never cross; lines whose boxes are apart (most, on a grid) need no arithmetic.
        if (a !== c && a !== d && b !== c && b !== d && !((qx < x0 && ex < x0) || (qx > x1 && ex > x1) || (qy < y0 && ey < y0) || (qy > y1 && ey > y1)))
          x = cross(ax, ay, bx, by, qx, qy, ex, ey);
        const k = eE + f;
        if (x === X[k]) continue;
        this.logX.push(k); this.logXv.push(X[k]);
        total += 10 * (x - X[k]);
        X[k] = X[f * E + e] = x;
      }
    }
    // Other lines: a state moved into or out of their way (never in a plain swap).
    const freed = this.freed, filled = this.filled;
    freed.length = filled.length = 0;
    for (let i = 0; i < states.length; i++) {
      if (owner[this.mvFrom[i]] < 0) freed.push(this.mvFrom[i]);
      if (this.mvFrom.indexOf(to[i]) < 0) filled.push(to[i]);
    }
    if (freed.length || filled.length) for (let f = 0; f < E; f++) {
      if (stamp[f] === tick) continue;
      const base = (slot[ea[f]] * C + slot[eb[f]]) * C;
      let d = 0;
      for (const c of filled) d += this.through[base + c];
      for (const c of freed) d -= this.through[base + c];
      if (!d) continue;
      this.logE.push(f); this.logLen.push(this.eLen[f]); this.logThru.push(this.eThru[f]);
      this.eThru[f] += d; total += 15 * d;
    }
    return (this.total = total);
  }

  /** Take the last move back. */
  undo() {
    const { slot, owner, E, X } = this;
    for (let i = 0; i < this.mvS.length; i++) owner[slot[this.mvS[i]]] = -1;
    for (let i = 0; i < this.mvS.length; i++) { slot[this.mvS[i]] = this.mvFrom[i]; owner[this.mvFrom[i]] = this.mvS[i]; }
    for (const s of this.mvS) for (const e of this.inc[s]) this.place(e);
    for (let i = 0; i < this.logE.length; i++) { this.eLen[this.logE[i]] = this.logLen[i]; this.eThru[this.logE[i]] = this.logThru[i]; }
    for (let i = 0; i < this.logX.length; i++) { const k = this.logX[i], e = Math.floor(k / E), f = k % E; X[k] = X[f * E + e] = this.logXv[i]; }
    this.total = this.prev;
  }
}

/** Whether segment a-b crosses segment q-e: the test intersect() makes, without making the point. */
function cross(ax: number, ay: number, bx: number, by: number, qx: number, qy: number, ex: number, ey: number): number {
  const d = (bx - ax) * (ey - qy) - (by - ay) * (ex - qx);
  if (Math.abs(d) < 1e-9) return 0;
  const t = ((qx - ax) * (ey - qy) - (qy - ay) * (ex - qx)) / d;
  const u = ((qx - ax) * (by - ay) - (qy - ay) * (bx - ax)) / d;
  return t >= 0 && t < 1 && u >= 0 && u < 1 ? 1 : 0;
}

/**
 * States in a grid of `cols` columns, moved between cells by simulated
 * annealing to cut crossings, lines through states, diagonal and long lines
 * (the cost in GridCost, kept up to date move by move). A step moves one
 * state to another cell (swapping with the state there) or, now and then, a
 * whole row or column: two neighbouring rows or columns trade places, or one
 * is mirrored, which state by state would mean climbing out of a valley
 * first. Each starting order is annealed, and the best grid it reached
 * settled: every single and row or column move tried until none helps. A
 * fixed seed and a work limit (not a clock), so the result is the same on
 * every machine. Returns the different results, cheapest first.
 */
function improveGrid(g: Graph, starts: Array<[string[], boolean]>, cols: number, sx: number, sy: number, R: number): Array<[Pos, number]> {
  const n = g.ids.length;
  const rows = Math.ceil(n / cols);
  const cells: Pt[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: c * sx, y: r * sy });
  const C = cells.length;
  const index = new Map(g.ids.map((id, i) => [id, i]));
  const pairs = edgePairs(g).map(([a, b]) => [index.get(a)!, index.get(b)!] as [number, number]);
  const E = pairs.length;
  const gc = new GridCost(cells, n, pairs, sx, sy, R);
  // Work limit per run: a step moves about two states, each with 2E/n lines on
  // average, and checks each moved line against every other line: about (4E/n) × E.
  const iters = Math.min(3000, Math.max(300, Math.round(3e6 / (((4 * E) / n) * E + 1))));
  let seed = 7;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  // One state to cell k, swapping with the state there.
  const one = [0], oneTo = [0], two = [0, 0], twoTo = [0, 0];
  const single = (a: number, k: number) => {
    const from = gc.slot[a], other = gc.owner[k];
    if (other < 0) { one[0] = a; oneTo[0] = k; return gc.move(one, oneTo); }
    two[0] = a; two[1] = other; twoTo[0] = k; twoTo[1] = from;
    return gc.move(two, twoTo);
  };
  // A whole row or column: rows i and i+1 swapped (kind 0), columns i and i+1 (1), row i mirrored (2), column i mirrored (3).
  const span = [rows - 1, cols - 1, cols > 1 ? rows : 0, rows > 1 ? cols : 0];
  const ms: number[] = [], mt: number[] = [];
  const block = (kind: number, i: number) => {
    ms.length = mt.length = 0;
    const put = (from: number, to: number) => { if (from !== to && gc.owner[from] >= 0) { ms.push(gc.owner[from]); mt.push(to); } };
    if (kind === 0) for (let c = 0; c < cols; c++) { put(i * cols + c, (i + 1) * cols + c); put((i + 1) * cols + c, i * cols + c); }
    else if (kind === 1) for (let r = 0; r < rows; r++) { put(r * cols + i, r * cols + i + 1); put(r * cols + i + 1, r * cols + i); }
    else if (kind === 2) for (let c = 0; c < cols; c++) put(i * cols + c, i * cols + cols - 1 - c);
    else for (let r = 0; r < rows; r++) put(r * cols + i, (rows - 1 - r) * cols + i);
    return ms.length > 0;
  };
  // Settle: take every move that helps until none does (a few sweeps at most).
  const settle = (cur: number) => {
    for (let sweep = 0; sweep < 4 && (sweep === 0 || (sweep + 1) * n * C <= iters); sweep++) { // costing no more than the annealing, after the first
      const before = cur;
      for (let a = 0; a < n; a++) for (let k = 0; k < C; k++) {
        if (k === gc.slot[a]) continue;
        const c = single(a, k);
        if (c < cur) cur = c; else gc.undo();
      }
      for (let kind = 0; kind < 4; kind++) for (let i = 0; i < span[kind]; i++) {
        if (!block(kind, i)) continue;
        const c = gc.move(ms, mt);
        if (c < cur) cur = c; else gc.undo();
      }
      if (cur >= before) break;
    }
    return cur;
  };
  // How far right the reset state's lines leave it, its successors in file order: compared first to last.
  const succ = g.out.get(g.init)!.map((id) => index.get(id)!);
  const rightward = (slot: ArrayLike<number>) => succ.map((t) => { const o = cells[slot[0]], p = cells[slot[t]]; return (p.x - o.x) / (Math.hypot(p.x - o.x, p.y - o.y) || 1); });
  const further = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return a[i] > b[i]; return false; };
  const found = new Map<string, [Int32Array, number]>();
  for (const [start, loop] of starts) {
    // Fill row by row, every other row right to left, so a path snakes through the grid.
    let order = cells.map((_, i) => { const r = Math.floor(i / cols), c = i % cols; return r * cols + (r % 2 ? cols - 1 - c : c); });
    if (loop && rows >= 2 && cols >= 2) {
      // A loop: along the top row, snaking down through the other columns, then
      // back up the left column, so the last state comes home in a straight line.
      const at = (r: number, c: number) => r * cols + c;
      order = Array.from({ length: cols }, (_, c) => at(0, c));
      for (let r = 1; r < rows; r++) for (let k = 0; k < cols - 1; k++) order.push(at(r, r % 2 ? cols - 1 - k : k + 1));
      for (let r = rows - 1; r >= 1; r--) order.push(at(r, 0));
    }
    const first = new Int32Array(n);
    start.forEach((id, i) => { first[index.get(id)!] = order[i]; });
    let cur = gc.reset(first), bestCost = cur;
    const best = new Int32Array(first);
    for (let it = 0; it < iters; it++) {
      const temp = 3 * Math.pow(0.02 / 3, it / iters);
      let c: number;
      if (rnd() < 0.1) {
        const kind = Math.floor(rnd() * 4);
        if (span[kind] <= 0 || !block(kind, Math.floor(rnd() * span[kind]))) continue;
        c = gc.move(ms, mt);
      } else {
        const a = Math.floor(rnd() * n), k = Math.floor(rnd() * C);
        if (k === gc.slot[a]) continue;
        c = single(a, k);
      }
      if (c <= cur || rnd() < Math.exp((cur - c) / temp)) {
        cur = c;
        if (c < bestCost) { bestCost = c; best.set(gc.slot); }
      } else gc.undo();
    }
    gc.reset(best);
    let cost = settle(bestCost);
    // The grid turned over its diagonal (rows for columns), when it still
    // fits, costs the same if the reset state is in the top left corner;
    // keep the way round whose flow leaves the reset state further to the
    // right (its successors in file order), so a loop runs clockwise along the top.
    if (gc.slot[0] === 0 && Array.from(gc.slot).every((k) => k % cols < rows && Math.floor(k / cols) < cols)) {
      const turned = Int32Array.from(gc.slot, (k) => (k % cols) * cols + Math.floor(k / cols));
      if (further(rightward(turned), rightward(gc.slot))) {
        const was = Int32Array.from(gc.slot);
        const c = gc.reset(turned);
        if (c <= cost) cost = c; else gc.reset(was);
      }
    }
    const key = gc.slot.join();
    if (!found.has(key)) found.set(key, [Int32Array.from(gc.slot), cost]);
  }
  return [...found.values()].sort((p, q) => p[1] - q[1]).map(([slot, cost]) => [new Map(g.ids.map((id, i) => [id, cells[slot[i]]])), cost]);
}

// ---- local shapes ---------------------------------------------------------------

/**
 * Make each triangle of mutually linked states equilateral: keep its
 * shortest level (or upright) side where the grid put it and move the third
 * state to the apex on the side it was on. A state already moved for another
 * triangle stays put, and an apex that would land on another state is skipped.
 */
function equilateral(g: Graph, grid: Pos, triangles: number[][], gap: number, step: number, keepRows = false, keepLines = keepRows): Pos {
  const pos: Pos = new Map(grid);
  const moved = new Set<string>();
  // Three in a row can stay: the line skipping the middle one becomes an arc instead.
  if (keepLines) triangles = triangles.filter((tri) => {
    const [P, Q, T] = tri.map((i) => pos.get(g.ids[i])!);
    return Math.abs((Q.x - P.x) * (T.y - P.y) - (Q.y - P.y) * (T.x - P.x)) >= 1;
  });
  if (keepRows) triangles = triangles.filter((tri) => {
    // Two on one row, the third on the next row up or down: make it
    // equilateral at the same height, so every row stays level. A state with
    // a line straight up or down to a state outside the triangle keeps its
    // place: the other two slide sideways around it. If that cannot be done
    // the triangle is left as it is.
    const ids = tri.map((i) => g.ids[i]);
    const k = [0, 1, 2].find((i) => { const [p, q] = ids.filter((_, j) => j !== i).map((id) => pos.get(id)!); return Math.abs(p.y - q.y) < 1; });
    if (k === undefined || ids.some((id) => moved.has(id))) return true;
    const apex = pos.get(ids[k])!;
    const base = ids.filter((_, j) => j !== k).sort((p, q) => pos.get(p)!.x - pos.get(q)!.x);
    const by = pos.get(base[0])!.y, h = Math.abs(by - apex.y);
    if (h < 1 || h > 1.5 * step) return true;
    const half = h / Math.sqrt(3);
    const pinned = ids.filter((id) => [...g.nb.get(id)!].some((v) => !ids.includes(v) && Math.abs(pos.get(v)!.x - pos.get(id)!.x) < 1));
    const next: Pos = new Map(pos);
    if (pinned.length > 1) return false;
    if (pinned.length === 0 || pinned[0] === ids[k]) {
      next.set(base[0], { x: apex.x - half, y: by });
      next.set(base[1], { x: apex.x + half, y: by });
    } else {
      const keep = pos.get(pinned[0])!, side = pinned[0] === base[0] ? 1 : -1;
      next.set(ids[k], { x: keep.x + side * half, y: apex.y });
      next.set(base.find((id) => id !== pinned[0])!, { x: keep.x + side * 2 * half, y: by });
    }
    const ok = [...next].every(([a, p]) => [...next].every(([b, q]) => a === b || Math.hypot(p.x - q.x, p.y - q.y) >= gap));
    if (!ok) return false;
    for (const [id, p] of next) pos.set(id, p);
    ids.forEach((id) => moved.add(id));
    return false;
  });
  for (const tri of triangles) {
    const ids = tri.map((i) => g.ids[i]);
    // Candidate bases: level or upright sides first, then shorter ones.
    const sides = [[0, 1, 2], [1, 2, 0], [0, 2, 1]].map(([i, j, k]) => {
      const a = pos.get(ids[i])!, b = pos.get(ids[j])!;
      const aligned = Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1;
      return { a: ids[i], b: ids[j], apex: ids[k], len: Math.hypot(a.x - b.x, a.y - b.y), aligned };
    }).filter((e) => !moved.has(e.apex)).sort((p, q) => Number(q.aligned) - Number(p.aligned) || p.len - q.len);
    for (const { a, b, apex, len } of sides) {
      const A = pos.get(a)!, B = pos.get(b)!, C = pos.get(apex)!;
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      const nx = -(B.y - A.y) / len, ny = (B.x - A.x) / len;
      const side = (C.x - mx) * nx + (C.y - my) * ny;
      const h = (Math.sqrt(3) / 2) * len;
      const tries = side > 1e-6 ? [1] : side < -1e-6 ? [-1] : [-1, 1];
      const spot = tries.map((k) => ({ x: mx + k * nx * h, y: my + k * ny * h }))
        .find((p) => [...pos].every(([id, q]) => id === apex || Math.hypot(p.x - q.x, p.y - q.y) >= gap));
      if (!spot) continue;
      pos.set(apex, spot);
      moved.add(apex); moved.add(a); moved.add(b);
      break;
    }
  }
  levelClusters(g, pos, triangles, gap, step);
  return pos;
}

/**
 * Triangles that share states form a cluster (two make a diamond). When the
 * apex moves left a cluster tilted or stretched, turn it about its centre so
 * its sides lie level or upright (a side two triangles share counts most, so
 * a diamond stands symmetric) and bring its sides back to one grid step, as
 * far as that keeps it clear of the other states.
 */
function levelClusters(g: Graph, pos: Pos, triangles: number[][], gap: number, step: number) {
  const parent = g.ids.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b, c] of triangles) { parent[find(b)] = find(a); parent[find(c)] = find(a); }
  const clusters = new Map<number, number[][]>();
  for (const tri of triangles) { const k = find(tri[0]); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k)!.push(tri); }
  for (const tris of clusters.values()) {
    const ids = [...new Set(tris.flat())].map((i) => g.ids[i]);
    const shared = new Map<string, number>();
    for (const [a, b, c] of tris) for (const [i, j] of [[a, b], [b, c], [a, c]]) { const k = `${g.ids[i]}\u0000${g.ids[j]}`; shared.set(k, (shared.get(k) ?? 0) + 1); }
    const sides = [...shared.keys()].map((k) => k.split("\u0000"));
    const pts = ids.map((id) => pos.get(id)!);
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const mean = sides.reduce((sum, [a, b]) => sum + Math.hypot(pos.get(a)!.x - pos.get(b)!.x, pos.get(a)!.y - pos.get(b)!.y), 0) / sides.length;
    const turn = (a: number) => new Map(ids.map((id) => {
      const p = pos.get(id)!, c = Math.cos(a), s = Math.sin(a);
      return [id, { x: cx + (p.x - cx) * c - (p.y - cy) * s, y: cy + (p.x - cx) * s + (p.y - cy) * c }];
    }));
    const level = (m: Map<string, Pt>) => sides.reduce((n, [a, b]) => {
      const p = m.get(a)!, q = m.get(b)!;
      return n + (Math.abs(p.x - q.x) < 2 || Math.abs(p.y - q.y) < 2 ? 3 ** (shared.get(`${a}\u0000${b}`)! - 1) : 0);
    }, 0);
    const clear = (m: Map<string, Pt>) => [...m.values()].every((p) => [...pos].every(([id, q]) => m.has(id) || Math.hypot(p.x - q.x, p.y - q.y) >= gap));
    let best = new Map(ids.map((id) => [id, pos.get(id)!])), bestLevel = level(best), bestTurn = 0;
    for (const [a, b] of sides) {
      const p = pos.get(a)!, q = pos.get(b)!;
      const phi = Math.atan2(q.y - p.y, q.x - p.x);
      for (const k of [0, 1, 2, 3]) {
        let ang = (k * Math.PI) / 2 - phi;
        ang = Math.atan2(Math.sin(ang), Math.cos(ang));
        const m = turn(ang);
        const n = level(m);
        if ((n > bestLevel || (n === bestLevel && n > 0 && Math.abs(ang) < Math.abs(bestTurn) - 1e-9)) && clear(m)) { best = m; bestLevel = n; bestTurn = ang; }
      }
    }
    // Shrink back towards one grid step per side, as far as it stays clear.
    for (const k of [step / mean, (1 + step / mean) / 2]) {
      if (k >= 1) break;
      const m = new Map([...best].map(([id, p]) => [id, { x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }]));
      if (clear(m)) { best = m; break; }
    }
    for (const [id, p] of best) pos.set(id, p);
  }
}

/**
 * If a state sits where the start arrow comes in, bring it in from a free
 * side instead: left, top, bottom, right, then the corners. Given the lines
 * as drawn, a side where the arrow would cut across a line (or run along one
 * leaving the state) is not free either.
 */
function clearStartArrow(d: FsmDiagram, L: number, lines: Pt[][] = []) {
  const init = d.states.find((s) => s.isInitial);
  if (!init) return;
  const r = stateRadius(d, init);
  const circles = d.states.map((s) => ({ x: s.x!, y: s.y!, r: stateRadius(d, s) }));
  lines = lines.filter((pts) => pts.some((p) => Math.hypot(p.x - init.x!, p.y - init.y!) < r + 60)); // only lines near the state can be in the way
  const memo = new Map<number, number>();
  const room = (a: number) => memo.get(a) ?? memo.set(a, roomAt(a)).get(a)!;
  const roomAt = (a: number) => {
    const ux = Math.cos(a), uy = Math.sin(a);
    let near = Infinity;
    for (const s of d.states) {
      if (s === init) continue;
      const dx = s.x! - init.x!, dy = s.y! - init.y!;
      const along = dx * ux + dy * uy, across = Math.abs(dx * uy - dy * ux);
      if (along > 0 && across < r + stateRadius(d, s) + 10) near = Math.min(near, along);
    }
    const p = { x: init.x! + ux * (r + 1), y: init.y! + uy * (r + 1) }, q = { x: init.x! + ux * (r + 40), y: init.y! + uy * (r + 40) };
    const cut = lines.some((pts) => crossCount([p, q], pts, circles) > 0 || pts.some((o) => Math.hypot(o.x - init.x!, o.y - init.y!) > r + 4 && segDist(o, p, q) < 8));
    return cut ? 0 : near;
  };
  const current = init.initialAngle ?? Math.PI;
  if (room(current) > 2 * L) return;
  let best = current, bestRoom = room(current);
  for (const a of [Math.PI, -Math.PI / 2, Math.PI / 2, 0, (-3 * Math.PI) / 4, (3 * Math.PI) / 4, -Math.PI / 4, Math.PI / 4]) {
    if (bestRoom > 2 * L) break;
    if (room(a) > bestRoom + 1e-9) { best = a; bestRoom = room(a); }
  }
  if (best !== current) init.initialAngle = best;
}

// ---- finishing ------------------------------------------------------------------

const unit = (v: Pt) => { const l = Math.hypot(v.x, v.y) || 1e-9; return { x: v.x / l, y: v.y / l }; };

/** Same curve as planDiagram: control point 2*curve to the left of travel. */
function arc(a: Pt, b: Pt, curve: number): Pt[] {
  const dir = unit({ x: b.x - a.x, y: b.y - a.y });
  const n = { x: dir.y, y: -dir.x };
  const c = { x: (a.x + b.x) / 2 + n.x * curve * 2, y: (a.y + b.y) / 2 + n.y * curve * 2 };
  return Array.from({ length: 21 }, (_, i) => {
    const t = i / 20, u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  });
}

/**
 * Lines that would cross a state become arcs, the smallest that clear every
 * state; "left of travel" first (a back edge along a row bows below it, a
 * forward jump above), the other side when that crosses fewer lines. Shorter
 * jumps go first so longer ones nest around them. Opposite edges that both
 * stay straight are drawn as two parallel lines. The start arrow counts as a
 * line to keep clear of, so an arc bows round it rather than through it.
 */
function routeEdges(d: FsmDiagram): Pt[][] {
  const at = new Map(d.states.map((s) => [s.id, { x: s.x!, y: s.y!, r: stateRadius(d, s), id: s.id }]));
  const arrow = startArrow(d);
  const groups = groupsOf(d).filter((ts) => ts[0].from !== ts[0].to);
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  const has = new Set(groups.map((ts) => key(ts[0].from, ts[0].to)));
  const circles = [...at.values()];
  const clear = (pts: Pt[], a: string, b: string) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    // A state outside the line's box (by its radius) cannot be on it.
    return circles.every((s) => s.id === a || s.id === b || s.x < x0 - s.r - 12 || s.x > x1 + s.r + 12 || s.y < y0 - s.r - 12 || s.y > y1 + s.r + 12 || pts.every((p) => Math.hypot(p.x - s.x, p.y - s.y) > s.r + 12));
  };
  const lines = new Map<string, Pt[]>();
  const blocked: typeof groups = [];
  for (const ts of groups) {
    const { from, to } = ts[0];
    const pts = arc(at.get(from)!, at.get(to)!, 0);
    if (clear(pts, from, to)) lines.set(key(from, to), pts);
    else blocked.push(ts);
  }
  for (const ts of groups) {
    const { from, to } = ts[0];
    if (lines.has(key(from, to)) && has.has(key(to, from))) for (const t of ts) t.curve = 0;
  }
  const len = (ts: (typeof groups)[0]) => Math.hypot(at.get(ts[0].to)!.x - at.get(ts[0].from)!.x, at.get(ts[0].to)!.y - at.get(ts[0].from)!.y);
  blocked.sort((a, b) => len(a) - len(b));
  for (const ts of blocked) {
    const { from, to } = ts[0];
    const a = at.get(from)!, b = at.get(to)!;
    // Opposite edges both bending: same sign puts them on opposite sides.
    const sides = has.has(key(to, from)) && !lines.has(key(to, from)) ? [1] : [1, -1];
    let best: { curve: number; pts: Pt[]; cost: number } | undefined;
    for (const side of sides) {
      for (const m of [30, 45, 60, 80, 100, 130, 160, 200, 250, 300, 360, 440]) {
        const pts = arc(a, b, side * m);
        if (!clear(pts, from, to)) continue;
        const crossings = [...lines.values()].reduce((s, o) => s + crossCount(pts, o, circles), arrow ? crossCount(pts, arrow, circles) : 0);
        const cost = crossings * 10 + m / 100 + (side < 0 ? 0.5 : 0);
        if (!best || cost < best.cost) best = { curve: side * m, pts, cost };
        break;
      }
    }
    if (!best) continue; // leave it to planDiagram
    for (const t of ts) t.curve = best.curve;
    lines.set(key(from, to), best.pts);
  }
  uncross(groups, at, lines, has, clear, arrow);
  return [...lines.values()];
}

/** The start arrow as drawn (planDiagram): from 38 px out to the reset state's edge. */
function startArrow(d: FsmDiagram): Pt[] | undefined {
  const init = d.states.find((s) => s.isInitial);
  if (!init) return undefined;
  const r = stateRadius(d, init), a = init.initialAngle ?? Math.PI, ux = Math.cos(a), uy = Math.sin(a);
  return [{ x: init.x! + ux * (r + 38), y: init.y! + uy * (r + 38) }, { x: init.x! + ux * (r + 1), y: init.y! + uy * (r + 1) }];
}

/**
 * Lines that cross other lines bow around them when an arc that clears every
 * state crosses fewer: the edge closing a loop drawn round a rectangle swings
 * round the outside instead of cutting across, and a diagonal of a square
 * bends round its corner. Greedy, a few passes, the line with most crossings
 * first; a line is only bent while that lowers its crossings, so a drawing
 * that cannot be untangled keeps its straight lines. Cutting across the
 * start arrow counts as a crossing.
 */
function uncross(
  groups: FsmDiagram["transitions"][],
  at: Map<string, { x: number; y: number; r: number; id: string }>,
  lines: Map<string, Pt[]>,
  has: Set<string>,
  clear: (pts: Pt[], a: string, b: string) => boolean,
  arrow?: Pt[],
) {
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  const routed = groups.filter((ts) => lines.has(key(ts[0].from, ts[0].to)));
  const circles = [...at.values()];
  const curveOf = (ts: (typeof groups)[0]) => ts[0].curve ?? 0;
  const crossings = (ts: (typeof groups)[0], pts: Pt[]) =>
    routed.reduce((n, o) => (o === ts ? n : n + crossCount(pts, lines.get(key(o[0].from, o[0].to))!, circles)), arrow ? crossCount(pts, arrow, circles) : 0);
  const cost = (c: number, curve: number) => c * 10 + Math.abs(curve) / 100 + (curve < 0 ? 0.5 : 0);
  for (let pass = 0; pass < 4; pass++) {
    // Each line's crossings, each pair worked out once (crossCount is symmetric). A dense tangle
    // (more crossings than lines) will not come apart with a few bends: not worth the time, so
    // stop counting as soon as it shows.
    const pts = routed.map((ts) => lines.get(key(ts[0].from, ts[0].to))!);
    const count = routed.map((_, i) => (arrow ? crossCount(pts[i], arrow, circles) : 0));
    let sum = count.reduce((a, b) => a + b, 0);
    for (let i = 0; i < routed.length; i++)
      for (let j = i + 1; j < routed.length; j++) {
        const c = crossCount(pts[i], pts[j], circles);
        if (!c) continue;
        count[i] += c; count[j] += c; sum += 2 * c;
        if (sum > 2 * routed.length) return;
      }
    const tangled = routed.map((ts, i) => ({ ts, n: count[i] })).filter((e) => e.n > 0).sort((p, q) => q.n - p.n);
    if (!tangled.length) return;
    let changed = false;
    for (const { ts } of tangled) {
      const { from, to } = ts[0];
      const a = at.get(from)!, b = at.get(to)!;
      const cur = lines.get(key(from, to))!;
      const now = cost(crossings(ts, cur), curveOf(ts));
      if (now < 10) continue; // untangled by an earlier bend this pass
      // Opposite edges stay on opposite sides: same sign as the other, or left of travel while the other is straight.
      const back = groups.find((o) => o[0].from === to && o[0].to === from);
      const sides = !back ? [1, -1] : (back[0].curve ?? 0) < 0 ? [-1] : [1];
      const chord = Math.hypot(b.x - a.x, b.y - a.y);
      let best: { curve: number; pts: Pt[]; cost: number } | undefined;
      for (const side of sides) {
        for (const m of [30, 45, 60, 80, 100, 130, 160, 200, 250, 300, 360, 440]) {
          if (m > Math.max(220, chord * 0.6)) break;
          const pts = arc(a, b, side * m);
          if (!clear(pts, from, to)) continue;
          const c = cost(crossings(ts, pts), side * m);
          if (!best || c < best.cost) best = { curve: side * m, pts, cost: c };
          if (c < 10) break; // no crossings left on this side; a bigger bow only costs more
        }
      }
      if (!best || best.cost >= now - 1e-9) continue;
      for (const t of ts) t.curve = best.curve;
      lines.set(key(from, to), best.pts);
      changed = true;
    }
    if (!changed) return;
  }
}

/** Each self loop points to its state's widest free side, preferring outward and straight up/down/left/right. */
function placeLoops(d: FsmDiagram) {
  const at = new Map(d.states.map((s) => [s.id, { x: s.x!, y: s.y!, r: stateRadius(d, s) }]));
  const cx = d.states.reduce((s, p) => s + p.x!, 0) / d.states.length;
  const cy = d.states.reduce((s, p) => s + p.y!, 0) / d.states.length;
  const groups = groupsOf(d);
  // Each line with its bounding box, and how far it is drawn off its centre line (half the gap of a pair drawn as two parallel lines).
  const lines: Array<{ pts: Pt[]; x0: number; y0: number; x1: number; y1: number; pad: number }> = [];
  const straight = new Set(groups.filter((ts) => ts[0].from !== ts[0].to && ts[0].curve === 0).map((ts) => `${ts[0].from}\u0000${ts[0].to}`));
  const busy = new Map(d.states.map((s) => [s.id, [] as number[]]));
  const init = d.states.find((s) => s.isInitial);
  if (init) busy.get(init.id)!.push(init.initialAngle ?? Math.PI);
  for (const ts of groups) {
    const { from, to } = ts[0];
    if (from === to) continue;
    const a = at.get(from)!, b = at.get(to)!;
    const pts = arc(a, b, ts[0].curve ?? 0);
    const pad = straight.has(`${from}\u0000${to}`) && straight.has(`${to}\u0000${from}`) ? PARALLEL_GAP / 2 : 0;
    lines.push({ pts, x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)), pad });
    // Direction the line leaves each end.
    busy.get(from)!.push(Math.atan2(pts[2].y - a.y, pts[2].x - a.x));
    busy.get(to)!.push(Math.atan2(pts[18].y - b.y, pts[18].x - b.x));
  }
  const loops: Pt[] = [];
  for (const ts of groups) {
    const id = ts[0].from;
    if (id !== ts[0].to) continue;
    const s = at.get(id)!;
    const out = Math.hypot(s.x - cx, s.y - cy) > 20 ? Math.atan2(s.y - cy, s.x - cx) : undefined;
    const rl = 0.75 * s.r;
    // Only lines that come near the state can touch a loop on it (the loop's centre is 1.5 r away, its radius rl).
    const reach = 1.5 * s.r + rl + 9 + PARALLEL_GAP / 2;
    const near = lines.filter((l) => s.x + reach > l.x0 && s.x - reach < l.x1 && s.y + reach > l.y0 && s.y - reach < l.y1);
    let best = -Math.PI / 2, bestScore = -Infinity;
    for (let k = 0; k < 8; k++) {
      const ang = -Math.PI / 2 + (k * Math.PI) / 4;
      const c = { x: s.x + 1.5 * s.r * Math.cos(ang), y: s.y + 1.5 * s.r * Math.sin(ang) };
      const used = busy.get(id)!;
      // A right angle to the nearest line is room enough; past that, direction matters more.
      let sc = Math.min(Math.PI / 2, ...used.map((u) => Math.abs(Math.atan2(Math.sin(ang - u), Math.cos(ang - u)))));
      if (out !== undefined) sc += 0.5 * Math.cos(ang - out);
      if (k % 2 === 0) sc += 0.6; // straight up, down, left or right
      // Ties: up in the top half, down in the bottom half, so a row's loops match.
      if (k === 0) sc += s.y < cy - 20 ? 0.15 : 0.05;
      if (k === 4 && s.y > cy + 20) sc += 0.15;
      for (const [oid, o] of at) if (oid !== id && Math.hypot(c.x - o.x, c.y - o.y) < rl + o.r + 16) sc -= 5;
      for (const l of loops) if (Math.hypot(c.x - l.x, c.y - l.y) < 2 * rl + 30) sc -= 5;
      for (const l of near) {
        const m = rl + 8 + l.pad;
        if (c.x + m > l.x0 && c.x - m < l.x1 && c.y + m > l.y0 && c.y - m < l.y1 && l.pts.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < m)) sc -= 1.5;
      }
      if (sc > bestScore + 1e-9) { bestScore = sc; best = ang; }
    }
    loops.push({ x: s.x + 1.5 * s.r * Math.cos(best), y: s.y + 1.5 * s.r * Math.sin(best) });
    for (const t of ts) t.loopAngle = best;
  }
}
