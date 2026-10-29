// The Japanese table (ja.ts) against every tr() call in the editor: each
// two-argument call has an entry, and each entry is reached by one, so an
// edit to the table is never an edit to text nobody sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { JA } from "../src/ja.ts";

const dir = new URL("../src/", import.meta.url);
const calls: Array<{ file: string; en: string | null; args: number }> = [];
for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
  const src = ts.createSourceFile(file, readFileSync(new URL(file, dir), "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "tr") {
      const a = n.arguments[0];
      calls.push({ file, en: a && ts.isStringLiteralLike(a) ? a.text : null, args: n.arguments.length });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}

test("every two-argument tr() call has a Japanese entry", () => {
  assert.ok(calls.length > 100, "the scan finds the tr() calls");
  const missing = calls.filter((c) => c.args < 3 && (c.en === null || !(c.en in JA)));
  assert.deepEqual(missing, [], "text built at run time passes its Japanese as the third argument; literals need a JA entry");
});

test("every JA entry is used by a tr() call without its own Japanese", () => {
  const used = new Set(calls.filter((c) => c.args < 3).map((c) => c.en));
  assert.deepEqual(Object.keys(JA).filter((k) => !used.has(k)), []);
});
