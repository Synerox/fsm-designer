// Make a round of the layout taste test: for each machine, the winning
// layout and up to two clearly different runners-up (no crossings), as pairs.
//
//   node tools/layout-taste-test/make-pairs.ts [out-dir]
//
// Writes <out-dir>/index.html (the page to open or publish) and
// <out-dir>/pairs.json (the layouts behind it, for apply-picks.ts).
// Default out-dir: tools/layout-taste-test/out.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { layoutCandidates, renderSvg } from "../../packages/core/src/index.ts";
import type { FsmDiagram, LayoutCandidate } from "../../packages/core/src/index.ts";
import { machines } from "./machines.ts";

// fileURLToPath, not URL.pathname: the pathname stays percent-encoded (a checkout
// under "my dir" would write to a new "my%20dir" folder) and is "/D:/..." on Windows.
const out = process.argv[2] ?? fileURLToPath(new URL("./out/", import.meta.url));
mkdirSync(out, { recursive: true });

const family = (a: string) => a.split(/[- (]/)[0];
// Positions relative to the first state, in units of the smallest offset, so a shifted or scaled copy counts as the same.
function shape(d: FsmDiagram): number[][] {
  const o = d.states[0];
  const xs = d.states.map((s) => s.x! - o.x!), ys = d.states.map((s) => s.y! - o.y!);
  const k = Math.max(1, Math.min(...[...xs, ...ys].map(Math.abs).filter((v) => v > 0)));
  return d.states.map((_, i) => [xs[i] / k, ys[i] / k]);
}
function differs(a: FsmDiagram, b: FsmDiagram): boolean {
  const p = shape(a), q = shape(b);
  const moved = p.filter((v, i) => Math.hypot(v[0] - q[i][0], v[1] - q[i][1]) > 0.4).length;
  return moved >= Math.max(2, p.length * 0.25);
}
function svg(c: LayoutCandidate): string {
  return renderSvg(c.diagram, { labels: "none", background: "none" });
}
function viewBox(s: string): [number, number] {
  const [, , w, h] = s.match(/viewBox="([^"]+)"/)![1].split(/\s+/).map(Number);
  return [w, h];
}
// Both drawings of a pair at one scale: size each by its share of the larger.
function sized(s: string, W: number, H: number): string {
  const [w, h] = viewBox(s);
  return s.replace(/<\?xml[^>]*\?>/, "").replace(/\swidth="[^"]*"/, "").replace(/\sheight="[^"]*"/, "")
    .replace("<svg ", `<svg preserveAspectRatio="xMidYMid meet" style="width:${((100 * w) / W).toFixed(1)}%;height:${((100 * h) / H).toFixed(1)}%" `);
}

const pairs: Array<{ id: string; machine: string; states: number; a: LayoutCandidate; b: LayoutCandidate }> = [];
for (const [name, d] of machines()) {
  const clean = layoutCandidates(d, { plan: { labels: "none" } }).filter((c) => c.score.crossings + c.score.throughStates + c.score.tooClose === 0);
  if (!clean.length) continue;
  const used = [clean[0]];
  for (const c of clean.slice(1)) {
    if (used.length >= (d.states.length >= 6 ? 3 : 2)) break;
    if (used.every((u) => differs(u.diagram, c.diagram)) && !used.some((u) => u.arrangement === c.arrangement && family(u.arrangement) === "ring")) used.push(c);
  }
  for (const alt of used.slice(1)) {
    const n = pairs.length + 1;
    // Mix up which side shows the current winner, so the side is no hint.
    const [a, b] = n % 3 === 1 ? [alt, clean[0]] : [clean[0], alt];
    pairs.push({ id: `p${String(n).padStart(2, "0")}`, machine: name, states: d.states.length, a, b });
  }
}

const page = pairs.map((p) => {
  const sa = svg(p.a), sb = svg(p.b);
  const [wa, ha] = viewBox(sa), [wb, hb] = viewBox(sb);
  const W = Math.max(wa, wb), H = Math.max(ha, hb);
  return { id: p.id, machine: p.machine, states: p.states, a: sized(sa, W, H), b: sized(sb, W, H) };
});
const tpl = readFileSync(new URL("./page.html", import.meta.url), "utf8");
// Replace the script's placeholder only (the template's header comment names it
// too), and through a function, so "$&" or "$'" in the data is not read as a
// replacement pattern.
const filled = tpl.replace("const PAIRS = __PAIRS__;", () => `const PAIRS = ${JSON.stringify(page).replace(/<\//g, "<\\/")};`);
if (filled === tpl) throw new Error("page.html has no `const PAIRS = __PAIRS__;` line to fill in");
writeFileSync(`${out}/index.html`, filled);
writeFileSync(`${out}/pairs.json`, JSON.stringify(pairs.map((p) => ({ id: p.id, machine: p.machine, a: { arrangement: p.a.arrangement, step: p.a.step, diagram: p.a.diagram }, b: { arrangement: p.b.arrangement, step: p.b.step, diagram: p.b.diagram } }))));
console.log(`${pairs.length} pairs from ${new Set(pairs.map((p) => p.machine)).size} machines -> ${out}`);
