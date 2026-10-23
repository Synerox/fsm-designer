// Add a round of picks to the score's regression fixture and report how
// many the current score agrees with.
//
//   node tools/layout-taste-test/apply-picks.ts <pairs.json> <picks.json> [round-name]
//
// picks.json maps pair ids to "a", "b" or "same" (the page's "copy picks"
// button gives exactly this). "same" picks are skipped. The pairs are
// appended to packages/core/test/layout/fixtures/preferences.json, which a
// test checks: the picked layout must score lower than the other.

import { readFileSync, writeFileSync } from "node:fs";
import { layoutScore, planDiagram } from "../../packages/core/src/index.ts";
import type { FsmDiagram } from "../../packages/core/src/index.ts";

const [pairsPath, picksPath, round = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
if (!pairsPath || !picksPath) { console.error("usage: apply-picks.ts <pairs.json> <picks.json> [round-name]"); process.exit(1); }
type Side = { arrangement: string; step: number; diagram: FsmDiagram };
const pairs = JSON.parse(readFileSync(pairsPath, "utf8")) as Array<{ id: string; machine: string; a: Side; b: Side }>;
const picks = JSON.parse(readFileSync(picksPath, "utf8")) as Record<string, string | { choice: string }>;
const fixture = new URL("../../packages/core/test/layout/fixtures/preferences.json", import.meta.url);
const kept = JSON.parse(readFileSync(fixture, "utf8")) as Array<Record<string, unknown>>;

const total = (s: Side) => layoutScore(s.diagram, planDiagram(s.diagram, { labels: "none" }), s.step).total;
let agree = 0;
const added = [];
for (const p of pairs) {
  const raw = picks[p.id];
  const choice = typeof raw === "string" ? raw : raw?.choice;
  if (choice !== "a" && choice !== "b") continue;
  const [mine, other] = choice === "a" ? [p.a, p.b] : [p.b, p.a];
  const ok = total(mine) < total(other);
  if (ok) agree++;
  else console.log(`disagrees: ${p.id} ${p.machine} picked ${mine.arrangement} (${total(mine).toFixed(1)}) over ${other.arrangement} (${total(other).toFixed(1)})`);
  added.push({ id: `${round}-${p.id}`, machine: p.machine, choice, stepA: p.a.step, stepB: p.b.step, a: p.a.diagram, b: p.b.diagram });
}
writeFileSync(fixture, JSON.stringify([...kept.filter((k) => !added.some((a) => a.id === k.id)), ...added]));
console.log(`score agrees with ${agree} of ${added.length} picks; fixture now holds ${kept.length + added.length} pairs`);
