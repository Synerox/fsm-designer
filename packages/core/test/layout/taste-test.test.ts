// The layout taste test tools (tools/layout-taste-test): make-pairs.ts writes
// a working page. Each
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
