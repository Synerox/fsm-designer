// The Verilog importer's warnings and errors as the import report and dialog
// show them: no API wording in English, and no English left in zh/ja.
import { test } from "node:test";
import assert from "node:assert/strict";
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
