// The layout taste test tools (tools/layout-taste-test): make-pairs.ts writes
// a working page, and apply-picks.ts reports what it did to the fixture. Each
// test runs the real script from a copy under a folder with a space in its
// name, next to a link to the core source, so the repo's own out/ folder and
// preferences.json are never touched.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FsmDiagram } from "../../src/index.ts";

const TOOLS = fileURLToPath(new URL("../../../../tools/layout-taste-test/", import.meta.url));
const CORE_SRC = fileURLToPath(new URL("../../src/", import.meta.url));

// <tmp>/taste test/{tools/layout-taste-test/<files>, packages/core/src -> the real src}
function sandbox(files: string[]): { root: string; tool: string; done: () => void } {
  const base = mkdtempSync(join(tmpdir(), "fsm-taste-"));
  const root = join(base, "taste test");
  const tool = join(root, "tools", "layout-taste-test");
  mkdirSync(tool, { recursive: true });
  mkdirSync(join(root, "packages", "core", "test", "layout", "fixtures"), { recursive: true });
  symlinkSync(CORE_SRC, join(root, "packages", "core", "src"), "junction");
  for (const f of files) copyFileSync(join(TOOLS, f), join(tool, f));
  return { root, tool, done: () => rmSync(base, { recursive: true, force: true }) };
}
// Runs a script of the sandbox from its root, the way the docs run them from the repo root.
function node(box: { root: string; tool: string }, script: string, args: string[] = []): { stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(box.tool, script), ...args], { cwd: box.root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, stderr: r.stderr };
}

test("make-pairs: the page gets the pair data in its script, as UTF-8, in tools/layout-taste-test/out", () => {
  const box = sandbox(["make-pairs.ts", "page.html"]);
  try {
    // One small machine, named with $& and $' (replacement patterns in String.replace).
    writeFileSync(join(box.tool, "machines.ts"), `
import { addState, addTransition, createDiagram, fitStateSizes } from "../../packages/core/src/index.ts";
import type { FsmDiagram } from "../../packages/core/src/index.ts";
export function machines(): Array<[string, FsmDiagram]> {
  const d = createDiagram({ name: "m" });
  for (let i = 0; i < 6; i++) addState(d, { name: "S" + i, isInitial: i === 0 });
  for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 4]]) addTransition(d, { from: d.states[a].id, to: d.states[b].id, condition: "" });
  fitStateSizes(d);
  return [["dollar $& $' domino", d]];
}
`);
    node(box, "make-pairs.ts");
    // The default out dir is the real path, not URL.pathname's "taste%20test".
    assert.deepEqual(readdirSync(join(box.root, "..")), ["taste test"]);
    const html = readFileSync(join(box.tool, "out", "index.html"), "utf8");
    assert.ok(!html.includes("__PAIRS__"), "the placeholder is filled in everywhere");
    assert.match(Buffer.from(html).subarray(0, 1024).toString("latin1"), /<meta charset="utf-8">/, "the charset is declared in the first 1024 bytes");
    const m = html.match(/const PAIRS = (\[.*\]);\n/);
    assert.ok(m, "the script defines PAIRS");
    const pairs = JSON.parse(m[1]) as Array<{ id: string; machine: string; a: string; b: string }>;
    assert.ok(pairs.length >= 1);
    assert.equal(pairs[0].machine, "dollar $& $' domino");
    assert.match(pairs[0].a, /^<svg /);
    assert.ok(existsSync(join(box.tool, "out", "pairs.json")));
  } finally { box.done(); }
});

test("apply-picks: re-running a round replaces its pairs, says so, and counts what it wrote; bad picks are reported", () => {
  const box = sandbox(["apply-picks.ts"]);
  try {
    const prefs = JSON.parse(readFileSync(new URL("./fixtures/preferences.json", import.meta.url), "utf8")) as Array<{ id: string; machine: string; stepA: number; stepB: number; a: FsmDiagram; b: FsmDiagram }>;
    const side = (diagram: FsmDiagram, step: number) => ({ arrangement: "x", step, diagram });
    const pairs = prefs.slice(0, 3).map((p, i) => ({ id: `p0${i + 1}`, machine: p.machine, a: side(p.a, p.stepA), b: side(p.b, p.stepB) }));
    const fixture = join(box.root, "packages", "core", "test", "layout", "fixtures", "preferences.json");
    writeFileSync(fixture, JSON.stringify(prefs.slice(0, 5)));
    writeFileSync(join(box.root, "pairs.json"), JSON.stringify(pairs));
    writeFileSync(join(box.root, "picks.json"), JSON.stringify({ p01: "a", p02: { choice: "b" }, p03: "same", p99: "a", p04: "x" }));
    const first = node(box, "apply-picks.ts", ["pairs.json", "picks.json", "r-test"]);
    assert.match(first.stdout, /of 2 picks; fixture now holds 7 pairs/);
    assert.equal(JSON.parse(readFileSync(fixture, "utf8")).length, 7);
    assert.doesNotMatch(first.stderr, /replaced/);
    // The same round again: its 2 pairs are replaced, not added.
    const r = node(box, "apply-picks.ts", ["pairs.json", "picks.json", "r-test"]);
    assert.match(r.stdout, /of 2 picks; fixture now holds 7 pairs/);
    assert.equal(JSON.parse(readFileSync(fixture, "utf8")).length, 7);
    assert.match(r.stderr, /replaced 2 pairs already in the fixture under round "r-test"/);
    assert.match(r.stderr, /p99 is not a pair/);
    assert.match(r.stderr, /p04 is not a pair/);
    writeFileSync(join(box.root, "picks.json"), JSON.stringify({ p01: "x" }));
    assert.match(node(box, "apply-picks.ts", ["pairs.json", "picks.json", "r-test2"]).stderr, /p01 has pick "x"/);
  } finally { box.done(); }
});

