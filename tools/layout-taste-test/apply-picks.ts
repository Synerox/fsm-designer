// Add a round of picks to the score's regression fixture and report how
// many the current score agrees with.
//
//   node tools/layout-taste-test/apply-picks.ts <pairs.json> <picks.json> [round-name]
//
// picks.json maps pair ids to "a", "b" or "same" (the page's "copy picks"
// button gives exactly this). "same" picks are skipped. The pairs are
// appended to packages/core/test/layout/fixtures/preferences.json, which a
// test checks: the picked layout must score lower than the other.
//
// Fixture ids are <round>-<pair id>, and every round numbers its pairs from
// p01, so running a round name again replaces that round's pairs (it says so).
// Give each round its own name: the default, today's date, is the same for a
// second round on one day.

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
const added: Array<{ id: string; machine: string; choice: "a" | "b"; stepA: number; stepB: number; a: FsmDiagram; b: FsmDiagram }> = [];
// Say what gets left out, so a typo in picks.json or the wrong pairs.json does not just shrink the round.
const known = new Set(pairs.map((p) => p.id));
for (const [id, raw] of Object.entries(picks)) {
  const choice = typeof raw === "string" ? raw : raw?.choice;
  if (!known.has(id)) console.warn(`skipped: ${id} is not a pair in ${pairsPath}`);
  else if (choice !== "a" && choice !== "b" && choice !== "same") console.warn(`skipped: ${id} has pick ${JSON.stringify(choice)}, not "a", "b" or "same"`);
}
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
const ids = new Set(added.map((a) => a.id));
const rest = kept.filter((k) => !ids.has(k.id as string));
if (rest.length < kept.length) console.warn(`replaced ${kept.length - rest.length} pairs already in the fixture under round "${round}" (use another round name to keep both)`);
const next = [...rest, ...added];
writeFileSync(fixture, JSON.stringify(next));
console.log(`score agrees with ${agree} of ${added.length} picks; fixture now holds ${next.length} pairs`);
