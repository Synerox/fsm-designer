// The auto layout on awkward input: a preset start-arrow side, diagrams built
// by hand, states on top of each other, dense graphs, islands. Each test
// pins a problem found in an audit of the layout code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, addTransition, createDiagram, FsmError, layoutCandidates, layoutScore, planDiagram, stateRadius, tidyLayout } from "../../src/index.ts";
import type { DiagramPlan, FsmDiagram } from "../../src/index.ts";
import { importVerilog } from "../../src/import/index.ts";
import { fixture } from "../import/helpers.ts";

const machine = (n: number, edges: Array<[number, number]>) => {
  const d = createDiagram({ name: "m" });
  for (let i = 0; i < n; i++) addState(d, { name: `S${i}`, isInitial: i === 0 });
  for (const [a, b] of edges) addTransition(d, { from: `S${a}`, to: `S${b}`, condition: `x${a}${b}` });
  return d;
};
/** n states linked into one piece, plus m random lines (a fixed seed). */
const random = (n: number, m: number, seed: number) => {
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const e: Array<[number, number]> = [];
  for (let i = 1; i < n; i++) e.push([Math.floor(r() * i), i]);
  for (let k = 0; k < m; k++) e.push([Math.floor(r() * n), Math.floor(r() * n)]);
  return machine(n, e);
};
const K = (n: number) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => [i, j] as [number, number])).flat().filter(([a, b]) => a !== b);
/** Pairs of states drawn on top of each other (closer than their two radii). */
const overlapping = (d: FsmDiagram) => {
  const out: string[] = [];
  for (let i = 0; i < d.states.length; i++)
    for (let j = i + 1; j < d.states.length; j++) {
      const a = d.states[i], b = d.states[j];
      if (Math.hypot(a.x! - b.x!, a.y! - b.y!) < stateRadius(d, a) + stateRadius(d, b)) out.push(`${a.name}@${a.x},${a.y} ~ ${b.name}@${b.x},${b.y}`);
    }
  return out;
};
const layoutOf = (d: FsmDiagram) => JSON.stringify([d.states.map((s) => [s.x, s.y, s.initialAngle]), d.transitions.map((t) => [t.curve, t.loopAngle])]);

test("a start-arrow side left on the diagram changes nothing: the arrow comes from the side the layout was checked with", () => {
  // A small random machine whose winner is polished, with a self loop on the reset state.
  const plain = random(4, 4, 4);
  const s0 = plain.states[0].id;
  addTransition(plain, { from: s0, to: s0, condition: "a" });
  const preset = structuredClone(plain);
  preset.states[0].initialAngle = Math.PI / 2; // an earlier layout (or the user) brought the arrow in from below
  tidyLayout(plain);
  const r = tidyLayout(preset);
  assert.equal(layoutOf(preset), layoutOf(plain), `${r.arrangement}: the preset side changed the layout`);
  // The arrow and the reset state's loop are not on the same side.
  const arrow = preset.states[0].initialAngle ?? Math.PI;
  const loop = preset.transitions.find((t) => t.from === s0 && t.to === s0)!.loopAngle!;
  assert.ok(Math.abs(Math.atan2(Math.sin(loop - arrow), Math.cos(loop - arrow))) >= Math.PI / 4 - 0.01, `${r.arrangement}: loop at ${loop}, arrow from ${arrow}`);
  // The same for every polished winner of a few machines that have one.
  for (const f of ["arbiter_casez.v", "pattern_one_block.v"]) {
    const a = importVerilog(fixture(f)).diagram, b = structuredClone(a);
    for (const s of b.states) if (s.isInitial) s.initialAngle = -Math.PI / 2;
    tidyLayout(a);
    tidyLayout(b);
    assert.equal(layoutOf(b), layoutOf(a), f);
  }
});

test("every candidate's step scores it again to the same total", () => {
  // cle_locked with labels has spread copies of candidates from the wide spacing; the islands are packed from parts laid out at different steps.
  const cases: Array<[string, FsmDiagram]> = [
    ["cle_locked", importVerilog(fixture("cle_locked.v")).diagram],
    ["vending", importVerilog(fixture("vending_if_else.v")).diagram],
    ["islands", machine(7, [[0, 1], [1, 2], [2, 0], [3, 4], [4, 3], [5, 6], [6, 5], [5, 5]])],
  ];
  for (const [name, d] of cases) {
    const cs = layoutCandidates(d);
    assert.ok(cs.length > 0);
    for (const c of cs) {
      const again = layoutScore(c.diagram, planDiagram(c.diagram), c.step).total;
      assert.ok(Math.abs(again - c.score.total) < 1e-6, `${name} ${c.arrangement} at step ${c.step}: ${c.score.total} vs ${again}`);
    }
  }
});

test("no two candidates are the same drawing (repair and polish add a drawing only once)", () => {
  for (const f of ["vending_if_else.v", "cle_locked.v"]) {
    const cs = layoutCandidates(importVerilog(fixture(f)).diagram);
    const keys = cs.map((c) => `${c.step} ` + c.diagram.states.map((s) => `${s.x},${s.y}`).join(" "));
    assert.equal(new Set(keys).size, keys.length, `${f}: ${cs.map((c) => c.arrangement).join(", ")}`);
  }
});

test("layoutScore: an empty diagram scores 0, linked states on the same spot score a finite total", () => {
  const empty = createDiagram({ name: "e" });
  assert.equal(layoutScore(empty).total, 0);
  const d = machine(3, [[0, 1], [1, 2]]);
  for (const s of d.states) { s.x = 100; s.y = 100; }
  d.states[2].x = 400;
  const sc = layoutScore(d);
  assert.ok(Number.isFinite(sc.total) && Number.isFinite(sc.long), `total ${sc.total}, long ${sc.long}`);
  assert.ok(sc.tooClose > 0);
});

test("a line through a label counts even when none of its sample points falls inside the label", () => {
  const d = machine(4, [[0, 1], [2, 3]]);
  [[0, 0], [300, 0], [-20, 100], [980, 100]].forEach(([x, y], i) => { d.states[i].x = x; d.states[i].y = y; });
  const plan = planDiagram(d);
  const [e, f] = plan.edges;
  // S2 -> S3: a level line sampled every 50 px, at x = -20, 30, 80, 130...; the S0 -> S1 label put across it at x 85..115.
  f.points = Array.from({ length: 21 }, (_, i) => ({ x: -20 + 50 * i, y: 100 }));
  e.label = { x: 100, y: 100, w: 30, h: 19 };
  const fake: DiagramPlan = { ...plan, edges: [e, { ...f, label: undefined }] };
  assert.ok(!f.points.some((p) => Math.abs(p.x - 100) < 15 && Math.abs(p.y - 100) < 9.5), "no sample point inside the label");
  assert.equal(layoutScore(d, fake).labelOnEdges, 1);
});

test("a transition to a state that does not exist: a clear error, not a TypeError from inside", () => {
  for (const [from, to] of [[0, "nope"], ["nope", 1]]) {
    const d = machine(2, [[0, 1]]);
    const end = (e: number | string) => (typeof e === "number" ? d.states[e].id : e);
    d.transitions.push({ ...d.transitions[0], id: "bad", from: end(from), to: end(to) });
    assert.throws(() => tidyLayout(d), (e: unknown) => e instanceof FsmError && /nope/.test((e as Error).message));
    assert.throws(() => layoutCandidates(d), FsmError);
  }
});

test("no candidate draws two states on top of each other (triangle clusters shrunk too far, ring pieces stacked on one spot)", () => {
  const cases: Array<[string, FsmDiagram]> = [
    ["K6", machine(6, K(6))],
    ["rand20-4", random(20, 20, 4)],
    ["star8-out", machine(9, [1, 2, 3, 4, 5, 6, 7, 8].map((i) => [0, i] as [number, number]))],
    ["star8-both", machine(9, [1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => [[0, i], [i, 0]] as Array<[number, number]>))],
    ["cle_locked", importVerilog(fixture("cle_locked.v")).diagram],
  ];
  for (const [name, d] of cases)
    for (const c of layoutCandidates(d, { plan: { labels: "none" } })) assert.deepEqual(overlapping(c.diagram), [], `${name} ${c.arrangement}`);
});

test("a dense machine finishes only its 8 straightest candidates and spreads out at most two; one of 32 lines, every candidate", () => {
  // random_32: 86 lines between states. Finishing all of its 20 arrangements took most of its 3-8 s.
  const dense = layoutCandidates(importVerilog(fixture("random_32.v")).diagram);
  const spread = dense.filter((c) => c.arrangement.endsWith("(spread)")).length;
  assert.ok(dense.length <= 8 + 2 + 4, `${dense.length} candidates: ${dense.map((c) => c.arrangement).join(", ")}`);
  assert.ok(spread <= 2, `${spread} spread copies`);
  assert.equal(dense[0].score.tooClose, 0);
  // chain_32: 32 lines, not dense: every arrangement is finished, as for any example machine.
  const chain = layoutCandidates(importVerilog(fixture("chain_32.v")).diagram);
  assert.ok(chain.length >= 10, `${chain.length} candidates`);
  assert.equal(chain[0].score.crossings, 0);
});
