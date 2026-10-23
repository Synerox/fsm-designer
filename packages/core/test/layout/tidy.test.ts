// The auto layout: every imported example lands on the grid, with nothing
// drawn through a state, hardly any crossings, nothing in the way of the
// reset state's start arrow, triangles drawn equilateral and the whole
// drawing about square.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, addTransition, autoLayout, createDiagram, GRID, layoutScore, planDiagram, renderLatex, renderSvg, tidyLayout } from "../../src/index.ts";
import type { FsmDiagram } from "../../src/index.ts";
import { importVerilog } from "../../src/import/index.ts";
import { fixture } from "../import/helpers.ts";

const FIXTURES = ["seq_1011_two_block.v", "traffic_three_block.v", "pattern_one_block.v", "handshake_enum.sv", "onehot_index.v", "arbiter_casez.v", "vending_if_else.v"];

function checkTidy(d: FsmDiagram, what: string) {
  for (const s of d.states) assert.ok(s.x! % GRID === 0 && s.y! % GRID === 0, `${what}: ${s.name} at ${s.x},${s.y} is off the grid`);
  const sc = layoutScore(d);
  assert.equal(sc.tooClose, 0, `${what}: states too close`);
  assert.equal(sc.throughStates, 0, `${what}: a line runs through a state`);
  const init = d.states.find((s) => s.isInitial)!;
  const rr = init.radius ?? 30, a = init.initialAngle ?? Math.PI;
  const blocked = d.states.filter((s) => {
    const dx = s.x! - init.x!, dy = s.y! - init.y!;
    return s !== init && dx * Math.cos(a) + dy * Math.sin(a) > 0 && dx * Math.cos(a) + dy * Math.sin(a) < 4 * rr && Math.abs(dx * Math.sin(a) - dy * Math.cos(a)) < 2 * rr;
  });
  assert.equal(blocked.length, 0, `${what}: a state sits in the way of the start arrow`);
  const b = planDiagram(d).bounds;
  assert.ok(b.minX >= 0 && b.minY >= 0, `${what}: drawing starts off the page`);
  return sc;
}

for (const f of FIXTURES) {
  test(`${f}: layout is on the grid with at most one crossing`, async () => {
    const d = importVerilog(fixture(f)).diagram;
    await autoLayout(d);
    const sc = checkTidy(d, f);
    assert.ok(sc.crossings <= 1, `${f}: ${sc.crossings} crossings`);
  });
}

const dist = (d: FsmDiagram, i: number, j: number) => Math.hypot(d.states[i].x! - d.states[j].x!, d.states[i].y! - d.states[j].y!);

const machine = (n: number, edges: Array<[number, number]>) => {
  const d = createDiagram({ name: "m" });
  for (let i = 0; i < n; i++) addState(d, { name: `S${i}`, isInitial: i === 0 });
  for (const [a, b] of edges) addTransition(d, { from: `S${a}`, to: `S${b}`, condition: `x${a}${b}` });
  return d;
};

test("a loop of four becomes a level square with the reset state at the top left", async () => {
  const d = machine(4, [[0, 1], [1, 2], [2, 3], [3, 0], [0, 0], [2, 2]]);
  await autoLayout(d);
  checkTidy(d, "4-cycle");
  const [s0, s1, s2, s3] = d.states;
  assert.ok(s0.y === s1.y && s2.y === s3.y && s0.x === s3.x && s1.x === s2.x && s0.y! < s3.y!, "level square, walked clockwise");
  assert.equal(dist(d, 0, 1), dist(d, 1, 2), "sides equal");
});

test("three states linked to each other, two of them both ways, become an equilateral triangle; two sharing such a side, a level diamond", async () => {
  const tri = machine(3, [[0, 1], [1, 0], [1, 2], [2, 1], [2, 0], [0, 2]]);
  await autoLayout(tri);
  checkTidy(tri, "triangle");
  const sides = [dist(tri, 0, 1), dist(tri, 1, 2), dist(tri, 2, 0)];
  assert.ok(Math.max(...sides) / Math.min(...sides) < 1.05, `sides ${sides.map(Math.round)}`);
  assert.ok(tri.states.some((a) => tri.states.some((b) => a !== b && (a.y === b.y || a.x === b.x))), "one side level or upright");
  const dia = machine(4, [[0, 1], [1, 2], [2, 1], [2, 0], [1, 3], [3, 2]]);
  const r = tidyLayout(dia);
  assert.equal(r.triangles.length, 2);
  checkTidy(dia, "diamond");
  const all = [dist(dia, 0, 1), dist(dia, 1, 2), dist(dia, 2, 0), dist(dia, 1, 3), dist(dia, 3, 2)];
  assert.ok(Math.max(...all) / Math.min(...all) < 1.05, `sides ${all.map(Math.round)}`);
  const [, s1, s2] = dia.states;
  assert.ok(s1.x === s2.x || s1.y === s2.y, "shared side level or upright");
});

test("a hub's branches sit next to it on the grid", async () => {
  const d = machine(5, [[0, 1], [1, 0], [0, 2], [2, 0], [0, 3], [3, 0], [0, 4], [4, 0]]);
  tidyLayout(d);
  checkTidy(d, "hub");
  const near = d.states.slice(1).map((_, i) => dist(d, 0, i + 1));
  assert.ok(Math.max(...near) <= Math.min(...near) * Math.SQRT2 + 1, `branch lengths ${near.map(Math.round)}`);
  assert.ok(d.transitions.every((t) => t.curve === 0), "both directions of each branch are parallel straight lines");
});

test("a chain with jumps back stays on one line; arcs clear the states between", () => {
  const d = machine(5, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [3, 1]]);
  tidyLayout(d);
  const sc = checkTidy(d, "chain");
  assert.equal(sc.crossings, 0);
});

test("layout is deterministic", async () => {
  const a = importVerilog(fixture("pattern_one_block.v")).diagram, b = structuredClone(a);
  await autoLayout(a);
  await autoLayout(b);
  assert.deepEqual(a, b);
});

test("big machines come out about screen-shaped (a little wider than tall), long chains folded up", async () => {
  for (const f of ["cle_locked.v", "chain_32.v", "random_32.v"]) {
    const d = importVerilog(fixture(f)).diagram;
    await autoLayout(d);
    if (f !== "random_32.v") checkTidy(d, f); // every state linked to most others: lines through states can't all be avoided
    const b = planDiagram(d).bounds;
    const ratio = (b.maxX - b.minX) / (b.maxY - b.minY);
    assert.ok(ratio > 0.8 && ratio < 2.2, `${f}: aspect ${ratio}`);
  }
});

test("hidden labels draw no text", async () => {
  const d = importVerilog(fixture("cle_locked.v")).diagram;
  await autoLayout(d, { draw: { labels: "none" } });
  const b = planDiagram(d, { labels: "none" });
  assert.ok(b.edges.every((e) => e.lines.length === 0));
  const loops = planDiagram(d, { labels: "noLoops" });
  assert.ok(loops.edges.every((e) => e.loopAngle === undefined || e.lines.length === 0));
  assert.ok(loops.edges.some((e) => e.lines.length > 0));
});

test("islands are laid out on their own and packed; unreachable states are drawn dashed", () => {
  const d = machine(7, [[0, 1], [1, 2], [2, 0], [3, 4], [4, 3], [5, 5]]);
  const r = tidyLayout(d);
  assert.equal(r.arrangement, "islands");
  checkTidy(d, "islands");
  const b = planDiagram(d).bounds;
  const ratio = (b.maxX - b.minX) / (b.maxY - b.minY);
  assert.ok(ratio > 0.5 && ratio < 2, `aspect ${ratio}`);
  assert.equal((renderSvg(d).match(/stroke-dasharray/g) ?? []).length, 4, "S3..S6 cannot be reached from S0");
  assert.equal((renderLatex(d).match(/, dashed,/g) ?? []).length, 4);
});

test("a branching flow can win as layers; what cannot be fixed is reported", async () => {
  const flow = machine(7, [[0, 1], [0, 2], [0, 3], [1, 4], [2, 4], [3, 5], [4, 6], [5, 6], [6, 0]]);
  const r = tidyLayout(flow);
  checkTidy(flow, "branching");
  assert.equal(r.issues.length, 0, "clean drawing, nothing to report");
  assert.ok(r.candidates.length >= 4, "grid and layered candidates were compared");
  const dense = importVerilog(fixture("random_32.v")).diagram;
  const res = (await autoLayout(dense))!;
  assert.ok(res.issues.some((i) => i.kind === "crossings" && i.count === res.score.crossings));
});

test("side loops sit beside the state they leave from; the main loop goes round a rectangle", () => {
  const d = importVerilog(fixture("cle_locked.v")).diagram;
  const res = tidyLayout(d, { plan: { labels: "none" } });
  assert.match(res.arrangement, /^ring/);
  assert.equal(res.score.crossings, 0);
  const at = (name: string) => d.states.find((s) => s.name === name)!;
  // SCAN's side loop through WAIT_1 and READ_ROM_2 is an equilateral triangle next to SCAN.
  const [a, b, c] = ["SCAN", "WAIT_1", "READ_ROM_2"].map(at);
  const sides = [[a, b], [b, c], [c, a]].map(([p, q]) => Math.hypot(p.x! - q.x!, p.y! - q.y!));
  assert.ok(Math.max(...sides) - Math.min(...sides) <= 2 * GRID, `${sides}`);
  // The main flow reads left to right along the top.
  const top = ["KEY_IN", "IDLE", "READ_ROM_1", "SCAN", "MERGE"].map(at);
  for (let i = 1; i < top.length; i++) { assert.equal(top[i].y, top[0].y); assert.ok(top[i].x! > top[i - 1].x!); }
});

test("a loop with a triangle on it: two level rows, the triangle equilateral, nothing floating", () => {
  const d = createDiagram({ name: "sort" });
  const names = ["READ", "OUTPUT_CNT", "SORT_EVEN", "SORT_ODD", "MERGE", "FINISH"];
  for (const name of names) addState(d, { name, isInitial: name === "READ", radius: 56 });
  const id = (n: string) => d.states.find((s) => s.name === n)!.id;
  for (const [a, b] of [["READ", "READ"], ["READ", "OUTPUT_CNT"], ["OUTPUT_CNT", "SORT_EVEN"], ["SORT_EVEN", "SORT_ODD"], ["SORT_ODD", "SORT_EVEN"], ["SORT_ODD", "MERGE"], ["MERGE", "SORT_EVEN"], ["MERGE", "FINISH"], ["FINISH", "READ"]])
    addTransition(d, { from: id(a), to: id(b), condition: "" });
  const res = tidyLayout(d, { plan: { labels: "none" } });
  checkTidy(d, "sort");
  assert.equal(res.score.floating, 0);
  assert.equal(res.score.uneven, 0);
  const at = (n: string) => d.states.find((s) => s.name === n)!;
  const rows = new Set(d.states.map((s) => s.y));
  assert.equal(rows.size, 2, "two rows");
  assert.equal(at("READ").y, at("OUTPUT_CNT").y);
  assert.equal(at("FINISH").x, at("READ").x, "FINISH straight under READ");
  const [a, b, c] = ["SORT_EVEN", "SORT_ODD", "MERGE"].map(at);
  const sides = [[a, b], [b, c], [c, a]].map(([p, q]) => Math.hypot(p.x! - q.x!, p.y! - q.y!));
  assert.ok(Math.max(...sides) - Math.min(...sides) <= 2 * GRID, `${sides}`);
});

test("no long arrows: a state with far neighbours moves in between them", () => {
  const d = createDiagram({ name: "calc" });
  for (const name of ["IDLE", "DECIDE", "REQ", "RECEIVE", "CALC", "RESULT", "WRITE", "FINISH"]) addState(d, { name, isInitial: name === "IDLE", radius: 44 });
  const id = (n: string) => d.states.find((s) => s.name === n)!.id;
  for (const [a, b] of [["IDLE", "DECIDE"], ["DECIDE", "REQ"], ["REQ", "RECEIVE"], ["RECEIVE", "REQ"], ["RECEIVE", "WRITE"], ["RECEIVE", "RESULT"], ["RECEIVE", "CALC"], ["CALC", "CALC"], ["CALC", "RESULT"], ["CALC", "REQ"], ["RESULT", "RESULT"], ["RESULT", "WRITE"], ["WRITE", "DECIDE"], ["WRITE", "FINISH"], ["FINISH", "IDLE"]])
    addTransition(d, { from: id(a), to: id(b), condition: "" });
  const res = tidyLayout(d, { plan: { labels: "none" } });
  checkTidy(d, "calc");
  assert.equal(res.score.crossings, 0);
  const at = (n: string) => d.states.find((s) => s.name === n)!;
  // WRITE sits in the middle, a step from RECEIVE, RESULT, DECIDE and FINISH.
  const step = at("DECIDE").x! - at("IDLE").x!;
  for (const n of ["RECEIVE", "RESULT", "DECIDE", "FINISH"]) {
    const dd = Math.hypot(at(n).x! - at("WRITE").x!, at(n).y! - at("WRITE").y!);
    assert.ok(Math.abs(dd - step) < 1, `WRITE to ${n}: ${dd}`);
  }
});

// Pairs of layouts of the same machine, and which one the user preferred
// when shown both side by side (labels hidden). The score must agree.
test("the score agrees with the user's picks between pairs of layouts", () => {
  const pairs = JSON.parse(readFileSync(new URL("./fixtures/preferences.json", import.meta.url), "utf8")) as Array<{ id: string; machine: string; choice: "a" | "b"; stepA: number; stepB: number; a: FsmDiagram; b: FsmDiagram }>;
  assert.ok(pairs.length >= 20);
  for (const p of pairs) {
    const sa = layoutScore(p.a, planDiagram(p.a, { labels: "none" }), p.stepA).total;
    const sb = layoutScore(p.b, planDiagram(p.b, { labels: "none" }), p.stepB).total;
    const [picked, other] = p.choice === "a" ? [sa, sb] : [sb, sa];
    assert.ok(picked < other, `${p.id} ${p.machine}: picked ${picked.toFixed(1)}, other ${other.toFixed(1)}`);
  }
});
