// Layout and exporter smoke tests over the shared examples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autoLayout, ensureLayout, parseDiagram, planDiagram, renderLatex, renderPng, renderSvg } from "../../src/index.ts";

const examples = join(import.meta.dirname, "..", "fixtures");
const load = (n: string) => parseDiagram(JSON.parse(readFileSync(join(examples, `${n}.fsm.json`), "utf8")));
const NAMES = ["arbiter", "seq_detector_1011", "traffic_light"];

for (const name of NAMES) {
  test(`${name}: layout places every state without overlap`, async () => {
    const d = load(name);
    await autoLayout(d);
    const plan = planDiagram(d);
    for (const a of plan.states) for (const b of plan.states) {
      if (a === b) continue;
      const dist = Math.hypot(a.state.x! - b.state.x!, a.state.y! - b.state.y!);
      assert.ok(dist > a.r + b.r, `${a.state.name} overlaps ${b.state.name}`);
    }
  });

  test(`${name}: svg, png and latex export`, async () => {
    const d = load(name);
    await ensureLayout(d);
    const svg = renderSvg(d);
    assert.match(svg, /^<svg[^>]+viewBox=/);
    for (const s of d.states) assert.ok(svg.includes(`>${s.name}<`), `svg missing ${s.name}`);
    const plan = planDiagram(d);
    assert.equal(plan.edges.filter((e) => e.lines.length && !e.label).length, 0, "every labelled edge gets a label position");
    const png = await renderPng(d, { scale: 1 });
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    const tex = renderLatex(d);
    assert.match(tex, /\\documentclass/);
    assert.equal((tex.match(/\\node\[state/g) ?? []).length, d.states.length);
    assert.doesNotMatch(renderLatex(d, { standalone: false }), /documentclass/);
  });
}

test("ensureLayout keeps manual positions and places new states", async () => {
  const d = load("traffic_light");
  await ensureLayout(d);
  const before = d.states.map((s) => [s.x, s.y]);
  d.states.push({ id: "extra", name: "EXTRA", isInitial: false, isAccepting: false, outputs: {} });
  await ensureLayout(d);
  assert.deepEqual(d.states.slice(0, -1).map((s) => [s.x, s.y]), before);
  assert.equal(typeof d.states.at(-1)!.x, "number");
});

test("hidden labels also hide state outputs in svg and latex", async () => {
  const d = load("traffic_light");
  await ensureLayout(d);
  assert.ok((renderSvg(d).match(/<text/g) ?? []).length > d.states.length, "outputs drawn when labels show");
  assert.match(renderLatex(d), /\\rule/);
  const svg = renderSvg(d, { labels: "none" });
  assert.equal((svg.match(/<text/g) ?? []).length, d.states.length, "only state names are drawn");
  assert.doesNotMatch(renderLatex(d, { labels: "none" }), /\\rule/);
});

test("hidden labels: only the shown edge keeps its text", async () => {
  const d = load("seq_detector_1011");
  await ensureLayout(d);
  const { from, to } = d.transitions.find((t) => t.from !== t.to)!;
  const plan = planDiagram(d, { labels: "none", shownEdge: { from, to } });
  const withText = plan.edges.filter((e) => e.lines.length);
  assert.equal(withText.length, 1);
  assert.deepEqual([withText[0].transitions[0].from, withText[0].transitions[0].to], [from, to]);
});

test("renderers refuse unplaced states", () => {
  const d = load("arbiter");
  assert.throws(() => renderSvg(d), /auto layout/);
});

test("latex draws curved edges as the SVG's Bézier, not TikZ bend (which overflows on long edges)", async () => {
  const d = load("seq_detector_1011");
  await ensureLayout(d);
  for (const t of d.transitions) t.curve = 3000; // far beyond TikZ's bend limits
  const curved = planDiagram(d).edges.filter((e) => e.curve !== 0 && e.loopAngle === undefined).length;
  const tex = renderLatex(d);
  assert.ok(curved > 0);
  assert.doesNotMatch(tex, /bend (left|right)/);
  assert.equal((tex.match(/\\draw\[->\] \(.+\) \.\. controls/g) ?? []).length, curved);
  assert.match(tex, /initial text=,/);
});
