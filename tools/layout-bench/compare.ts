// Compare two benchmark runs, machine by machine.
//
//   node tools/layout-bench/compare.ts <before-dir> <after-dir> [--html <file>] [--all]
//
// Prints the machines whose measures changed (--all: every machine) and the
// totals. --html also writes a page with each changed machine's two drawings
// side by side, to look at: the numbers do not see everything.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderSvg } from "../../packages/core/src/index.ts";
import type { Mess } from "./metrics.ts";
import type { Row } from "./run.ts";

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) { console.error("usage: node tools/layout-bench/compare.ts <before-dir> <after-dir> [--html <file>] [--all]"); process.exit(2); }
const load = (dir: string) => JSON.parse(readFileSync(resolve(dir, "results.json"), "utf8")) as Row[];
const before = new Map(load(beforeDir).map((r) => [`${r.name} ${r.labels}`, r]));
const after = load(afterDir).filter((r) => before.has(`${r.name} ${r.labels}`));
const all = process.argv.includes("--all");
const htmlAt = process.argv.indexOf("--html");

const COLS: Array<[keyof Mess | "ms", string]> = [["crossings", "cross"], ["throughStates", "thru"], ["labelOverlaps", "lblOv"], ["tightAngles", "tight"], ["bigArcs", "arcs"], ["nearMisses", "near"], ["longLines", "long"], ["areaPerState", "area/st"], ["index", "index"], ["ms", "ms"]];
const cell = (b: number, a: number) => (b === a ? `${a}` : `${b}>${a}`).padStart(9);
console.log(`${"machine".padEnd(22)} ${"labels".padEnd(5)}` + COLS.map(([, h]) => h.padStart(9)).join("") + "  arrangement");
const changed: Array<[Row, Row]> = [];
for (const a of after) {
  const b = before.get(`${a.name} ${a.labels}`)!;
  const same = JSON.stringify(b.diagram.states.map((s) => [s.x, s.y])) === JSON.stringify(a.diagram.states.map((s) => [s.x, s.y])) && JSON.stringify(b.diagram.transitions.map((t) => [t.curve, t.loopAngle])) === JSON.stringify(a.diagram.transitions.map((t) => [t.curve, t.loopAngle]));
  if (!same) changed.push([b, a]);
  if (!same || all) console.log(`${a.name.padEnd(22)} ${a.labels.padEnd(5)}` + COLS.map(([k]) => cell(b[k], a[k])).join("") + `  ${b.arrangement === a.arrangement ? a.arrangement : `${b.arrangement} > ${a.arrangement}`}`);
}
const total = (rs: Row[], k: keyof Mess | "ms") => +rs.reduce((s, r) => s + r[k], 0).toFixed(1);
for (const labels of ["all", "none"] as const) {
  const as = after.filter((r) => r.labels === labels), bs = as.map((r) => before.get(`${r.name} ${r.labels}`)!);
  console.log(`${"TOTAL".padEnd(22)} ${labels.padEnd(5)}` + COLS.map(([k]) => cell(total(bs, k), total(as, k))).join(""));
  const better = as.filter((a, i) => a.index < bs[i].index).length, worse = as.filter((a, i) => a.index > bs[i].index).length;
  console.log(`  mess index: ${better} machines better, ${worse} worse, ${as.length - better - worse} the same`);
}

if (htmlAt >= 0) {
  const svg = (r: Row) => renderSvg(r.diagram, { labels: r.labels }).replace(/<\?xml[^>]*\?>/, "").replace(/\swidth="[^"]*"/, "").replace(/\sheight="[^"]*"/, "");
  const note = (r: Row) => `${r.arrangement} · ${r.crossings} crossings · ${r.tightAngles} tight angles · ${r.bigArcs} big arcs · ${r.width}×${r.height}`;
  const cards = changed.map(([b, a]) => `<section><h2>${a.name} <small>${a.states} states, ${a.lines} lines, labels ${a.labels}</small></h2><div class="pair"><figure>${svg(b)}<figcaption>before: ${note(b)}</figcaption></figure><figure>${svg(a)}<figcaption>after: ${note(a)}</figcaption></figure></div></section>`);
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Layout before and after</title><style>body{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#111}h2{font-size:16px;margin:24px 0 8px}small{font-weight:400;color:#666}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0;border:1px solid #ccc;border-radius:6px;padding:8px}svg{width:100%;height:auto;max-height:70vh}figcaption{color:#444;margin-top:6px}@media(max-width:700px){.pair{grid-template-columns:1fr}}</style></head><body><h1>Layout before and after: ${changed.length} drawings changed</h1>${cards.join("")}</body></html>`;
  writeFileSync(resolve(process.argv[htmlAt + 1]), page);
  console.log(`wrote ${resolve(process.argv[htmlAt + 1])}`);
}
