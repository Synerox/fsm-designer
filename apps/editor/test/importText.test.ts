// The Verilog importer's warnings and errors as the import report and dialog
// show them: no API wording in English, and no English left in zh/ja.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importVerilog } from "@fsm/core";
import { useLang } from "../src/i18n.ts";
import type { Lang } from "../src/i18n.ts";
import { importErrorText, warningText } from "../src/importText.ts";

const SRC = `
module top (input clk, output y);
  assign y = clk;
endmodule
module m (input clk, input rst, input x, output reg [1:0] o);
  localparam A = 2'd0, B = 2'd1, C = 2'd2;
  reg [1:0] st;
  function f; input a; f = a; endfunction
  sync2 u0 (.a(x));
  assign = ;
  always @(posedge clk) if (rst) st <= A; else case (st) A: if (x) st <= B; B: st <= C; C: st <= A; endcase
  always @(posedge clk) begin o <= st; o[1] <= x; end
endmodule`;

const inLang = <T>(lang: Lang, f: () => T): T => {
  useLang.getState().setLang(lang);
  try { return f(); } finally { useLang.getState().setLang("en"); }
};

test("English warnings do not tell the user to pass API options", () => {
  const warnings = importVerilog(SRC).warnings;
  const en = inLang("en", () => warnings.map(warningText));
  assert.ok(warnings.some((w) => /module: "<name>"/.test(w)), "the core still words it for API callers");
  assert.equal(en[0], "Imported module m; the file also has top (modules without a state machine are skipped)");
  assert.equal(inLang("en", () => warningText('Register "q" also looks like a state register; import it with stateVar: "q"')),
    'Register "q" also looks like a state register; this import used another one (pick it in the Import dialog)');
  for (const w of en) assert.doesNotMatch(w, /module:|stateVar:/);
});

test("zh and ja import reports translate skips, partial assignments and left-out signals", () => {
  const warnings = [
    ...importVerilog(SRC).warnings,
    'Output "o" left out: "o" is already an input',
    'Signal "n" left out: "n" is already an output',
  ];
  const zh = inLang("zh", () => warnings.map(warningText));
  const ja = inLang("ja", () => warnings.map(warningText));
  assert.deepEqual(zh.slice(1, 5), [
    "已略過第 8 行的 function",
    "已略過第 9 行的 sync2 實例",
    '已略過第 10 行（語法錯誤：expected a name but found "="）',
    "無法追蹤對 o[1] 的部分位元指定，該值視為未知",
  ]);
  assert.equal(ja[1], "8 行目の function を省略しました");
  assert.equal(ja[2], "9 行目の sync2 のインスタンスを省略しました");
  // Only names, Verilog keywords and the parser's own detail may stay in English.
  for (const w of [...zh, ...ja]) assert.doesNotMatch(w, /\b(Skipped|line|instance of|left out|Could not|Output|Signal)\b/, w);
});

test("errors the editor can hit are translated", () => {
  const errors = ['Could not determine any state values for "st"', 'More than 256 states reached from "st"; is it really a state register?'];
  assert.deepEqual(inLang("zh", () => errors.map(importErrorText)), ["無法判斷 st 有哪些狀態值。", "從 st 走到的狀態超過 256 個，它真的是狀態暫存器嗎？"]);
  for (const e of inLang("ja", () => errors.map(importErrorText))) assert.doesNotMatch(e, /Could not|More than/);
  assert.deepEqual(inLang("en", () => errors.map(importErrorText)), errors);
});

test("the synchronous-reset and declared-range warnings are translated", () => {
  const syncgo = importVerilog(`module syncgo(input clk, input go, input a, output reg y);
    localparam A=0,B=1,C=2; reg [1:0] state, nxt;
    always @(posedge clk) if (go) state <= A; else state <= nxt;
    always @(*) begin nxt = state; case (state) A: if (a) nxt = B; B: nxt = C; C: nxt = A; endcase end
    always @(*) y = state == C;
  endmodule`).warnings;
  const bits = importVerilog(`module bits(input clk, input rst_n, input [4:1] a, output reg y);
    localparam A=0,B=1,C=2; reg [1:0] state;
    always @(posedge clk or negedge rst_n) if (!rst_n) state <= A; else case (state) A: if (a[3]) state <= B; B: if (a[1]) state <= C; C: state <= A; endcase
    always @(*) y = state == C;
  endmodule`).warnings;
  assert.ok(syncgo.includes('Taking "go" for a synchronous reset because it sets "state" to a constant'), syncgo.join("\n"));
  assert.ok(bits.includes('"a" is declared [4:1]; its bit selects are shown as positions from the LSB (a[4] reads a[3])'), bits.join("\n"));
  const both = [...syncgo, ...bits].filter((w) => /^Taking|is declared/.test(w));
  assert.deepEqual(inLang("zh", () => both.map(warningText)), [
    "把 go 視為同步 reset（它會把 state 設成常數）",
    "a 宣告為 [4:1]，它的位元選取改以從 LSB 起算的位置顯示（a[4] 顯示為 a[3]）",
  ]);
  assert.deepEqual(inLang("ja", () => both.map(warningText)), [
    "go は state を定数にするため、同期リセットとみなしました",
    "a は [4:1] と宣言されているため、ビット選択は LSB から数えた位置で表示します（a[4] は a[3] と表示）",
  ]);
});

/** The text of the template or string literal at src[i] (a ` or "), with each ${...} filled in as "3", and the index after it. */
function literalAt(src: string, i: number): [string, number] {
  if (src[i] === '"') { const end = src.indexOf('"', i + 1); return [src.slice(i + 1, end), end + 1]; }
  let out = "", j = i + 1;
  while (src[j] !== "`") {
    if (!src.startsWith("${", j)) { out += src[j++]; continue; }
    let depth = 1;
    j += 2;
    while (depth) {
      if (src[j] === "`") { j = literalAt(src, j)[1]; continue; }
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    out += "3";
  }
  return [out, j + 1];
}

test("every warning the importer can give has zh and ja text", () => {
  const dir = new URL("../../../packages/core/src/import/", import.meta.url);
  const warnings: string[] = [];
  for (const file of ["extract.ts", "index.ts"]) {
    const src = readFileSync(new URL(file, dir), "utf8");
    for (const m of src.matchAll(/\bc\.warn\(|warnings\.unshift\(/g)) warnings.push(literalAt(src, m.index + m[0].length)[0]);
  }
  assert.ok(warnings.length >= 15, `found only ${warnings.length} warnings: has the core changed how it warns?`);
  for (const lang of ["zh", "ja"] as const) {
    for (const w of warnings) assert.notEqual(inLang(lang, () => warningText(w)), w, `no ${lang} text for: ${w}`);
  }
});

test("the nesting and engine-failure import errors are translated", () => {
  const nested = "The Verilog is nested too deeply to import";
  const other = "Could not import the Verilog: Invalid array length";
  assert.deepEqual(inLang("zh", () => [nested, other].map(importErrorText)), ["程式碼巢狀層數太深，無法匯入。", "無法匯入：Invalid array length"]);
  assert.deepEqual(inLang("ja", () => [nested, other].map(importErrorText)), ["コードの入れ子が深すぎて読み込めません。", "読み込めませんでした：Invalid array length"]);
  assert.deepEqual(inLang("en", () => [nested, other].map(importErrorText)), [nested, other]);
  // The real error, from code nested deeper than the stack allows.
  const deep = `module d(input clk, input a); reg s; always @(posedge clk) ${"begin ".repeat(20000)} s <= a; ${"end ".repeat(20000)} endmodule`;
  assert.throws(() => importVerilog(deep), (e: Error) => e.message === nested);
});
