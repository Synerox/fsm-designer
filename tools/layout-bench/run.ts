// Lay out every benchmark machine (labels shown and hidden) and measure how
// messy each drawing is.
//
//   node tools/layout-bench/run.ts [--out <dir>] [--core <packages/core of another checkout>] [--filter <regex>] [--svg]
//
// Writes <dir>/results.json (one row per machine and label setting: the
// measures of metrics.ts, the time taken, the laid-out diagram) and, with
// --svg, each drawing as <dir>/<machine>.<labels>.svg. --core lays out with
// another checkout's code (say, main in a second worktree) while this
// checkout still builds the machines and measures the result, so two
// versions are compared with one ruler: see compare.ts.
// Default dir: tools/layout-bench/out.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderSvg } from "../../packages/core/src/index.ts";
import type { FsmDiagram } from "../../packages/core/src/index.ts";
import { machines } from "./machines.ts";
import { measure } from "./metrics.ts";
import type { Mess } from "./metrics.ts";

export interface Row extends Mess { name: string; group: string; labels: "all" | "none"; states: number; lines: number; arrangement: string; ms: number; diagram: FsmDiagram }

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const out = resolve(arg("--out") ?? fileURLToPath(new URL("./out/", import.meta.url)));
const coreDir = resolve(arg("--core") ?? fileURLToPath(new URL("../../packages/core/", import.meta.url)));
const filter = arg("--filter") ? new RegExp(arg("--filter")!) : undefined;
const engine = (await import(pathToFileURL(resolve(coreDir, "src/index.ts")).href)) as typeof import("../../packages/core/src/index.ts");
mkdirSync(out, { recursive: true });

const rows: Row[] = [];
for (const m of machines()) {
  if (filter && !filter.test(m.name)) continue;
  for (const labels of ["all", "none"] as const) {
    const d = structuredClone(m.d);
    const t0 = performance.now();
    const r = await engine.autoLayout(d, { draw: { labels } });
    const ms = Math.round(performance.now() - t0);
    const lines = new Set(d.transitions.map((t) => `${t.from}\u0000${t.to}`)).size;
    rows.push({ name: m.name, group: m.group, labels, states: d.states.length, lines, arrangement: r?.arrangement ?? "", ms, ...measure(d, { labels }), diagram: d });
    if (process.argv.includes("--svg")) writeFileSync(resolve(out, `${m.name}.${labels}.svg`), renderSvg(d, { labels }));
  }
}
writeFileSync(resolve(out, "results.json"), JSON.stringify(rows));

const sum = (rs: Row[], k: keyof Mess | "ms") => rs.reduce((a, r) => a + r[k], 0);
for (const labels of ["all", "none"] as const) {
  const rs = rows.filter((r) => r.labels === labels);
  console.log(`labels ${labels}: ${rs.length} machines, crossings ${sum(rs, "crossings")}, through states ${sum(rs, "throughStates")}, label overlaps ${sum(rs, "labelOverlaps")}, tight angles ${sum(rs, "tightAngles")}, big arcs ${sum(rs, "bigArcs")}, near misses ${sum(rs, "nearMisses")}, mess index ${sum(rs, "index")}, ${sum(rs, "ms")} ms`);
}
console.log(`wrote ${resolve(out, "results.json")}`);
