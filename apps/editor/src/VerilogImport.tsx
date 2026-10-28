// File > Import Verilog: paste or open Verilog / SystemVerilog code, and the
// FSM in it is extracted (by @fsm/core's importer, no guessing) and drawn as a
// new diagram. A small report says what was found.

import { useEffect, useId, useMemo, useState } from "react";
import { listStateMachines } from "@fsm/core";
import type { ImportResult } from "@fsm/core";
import { importVerilogText } from "./actions.ts";
import { useModal } from "./dialog.ts";
import { VERILOG_FILTER, openTextFile } from "./platform.ts";
import { tr, useLang } from "./i18n.ts";

const SAMPLE = `// Example: Mealy machine detecting the sequence 1011 (two always blocks)
module seq_detector_1011 (
  input  wire clk,
  input  wire rst_n,
  input  wire x,
  output reg  z
);
  localparam IDLE = 2'd0, GOT_1 = 2'd1, GOT_10 = 2'd2, GOT_101 = 2'd3;
  reg [1:0] state, next_state;

  always @(posedge clk or negedge rst_n)
    if (!rst_n) state <= IDLE;
    else        state <= next_state;

  always @(*) begin
    next_state = state;
    z = 1'b0;
    case (state)
      IDLE:    if (x) next_state = GOT_1;
      GOT_1:   if (!x) next_state = GOT_10;
      GOT_10:  next_state = x ? GOT_101 : IDLE;
      GOT_101: if (x) begin next_state = GOT_1; z = 1'b1; end
               else next_state = GOT_10;
    endcase
  end
endmodule
`;

const DRAFT_KEY = "fsm-designer:verilog-draft";

export function VerilogImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (r: ImportResult) => void }) {
  const [code, setCode] = useState(() => { try { return localStorage.getItem(DRAFT_KEY) ?? ""; } catch { return ""; } });
  const [selfLoops, setSelfLoops] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(0);
  // Every FSM in the code (several modules, or several state registers in one).
  const machines = useMemo(() => listStateMachines(code), [code]);
  const choice = machines[Math.min(picked, machines.length - 1)];
  // Focus starts in the code box (the dialog's first control). Escape, Tab and
  // focus return are handled by useModal, so they keep working after a
  // cancelled "Discard changes?" confirm.
  const box = useModal<HTMLDivElement>(onClose);
  const titleId = useId();
  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, code); } catch { /* storage off */ } }, [code]);

  const openFile = async () => {
    const f = await openTextFile([VERILOG_FILTER]);
    if (f) { setCode(f.text); setError(null); }
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await importVerilogText(code, { selfLoops, ...(machines.length > 1 && choice ? choice : {}) });
      if (r) onImported(r);
    } catch (e) {
      setError(importErrorText(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal verilog-import" ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void run(); }}>
        <h3 id={titleId}>{tr("Import Verilog", "匯入 Verilog")}</h3>
        <p className="hint">
          {tr("Paste or open Verilog / SystemVerilog code with a state machine. The state register, reset state, and each transition's condition and outputs are found and drawn as a state diagram. ", "貼上或開啟含有狀態機的 Verilog / SystemVerilog 程式碼，會自動找出狀態暫存器、reset 狀態、每條轉移的條件與輸出並畫成狀態圖。")}
          {tr("Outputs that depend only on the state are drawn in the states (Moore); outputs that also depend on inputs go on the transitions (Mealy).", "只跟狀態有關的輸出畫在狀態裡（Moore），跟輸入也有關的輸出畫在轉移上（Mealy）。")}
        </p>
        <textarea
          value={code}
          spellCheck={false}
          placeholder={"module my_fsm (input clk, input rst_n, ...);\n  ...\nendmodule"}
          onChange={(e) => { setCode(e.target.value); setError(null); }}
          data-testid="verilog-source"
        />
        {error && <p className="import-error" role="alert">{error}</p>}
        {machines.length > 1 && (
          <label className="machine-pick">
            {tr(`This code has ${machines.length} state machines. Import:`, `這段程式碼有 ${machines.length} 個狀態機，要匯入：`, `このコードには ${machines.length} 個のステートマシンがあります。読み込むもの：`)}
            <select value={Math.min(picked, machines.length - 1)} onChange={(e) => { setPicked(Number(e.target.value)); setError(null); }} data-testid="verilog-machine">
              {machines.map((m, i) => <option key={`${m.module}.${m.stateVar}`} value={i}>{tr(`${m.stateVar} in ${m.module}`, `${m.module} 的 ${m.stateVar}`, `${m.module} の ${m.stateVar}`)}</option>)}
            </select>
          </label>
        )}
        <div className="row">
          <label className="check-inline">
            <input type="checkbox" checked={selfLoops} onChange={(e) => setSelfLoops(e.target.checked)} />
            {tr("Draw self loops for staying in a state", "畫出停在原狀態的自迴圈")}
          </label>
          <span className="spacer" />
          <button onClick={() => { setCode(SAMPLE); setError(null); }}>{tr("Example", "範例")}</button>
          <button onClick={() => void openFile()}>{tr("Open file…", "開啟檔案…")}</button>
          <button onClick={onClose}>{tr("Cancel", "取消")}</button>
          <button className="primary" disabled={!code.trim() || busy} onClick={() => void run()} title="Ctrl+Enter" data-testid="verilog-import">{tr("Import", "匯入")}</button>
        </div>
      </div>
    </div>
  );
}

/** What was found, shown after an import until dismissed. */
export function ImportReport({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const d = result.diagram;
  const kind = result.machine === "mealy" ? "Mealy" : "Moore";
  return (
    <div className="import-report" role="status" data-testid="import-report">
      <div className="head">
        <strong>{tr(`Imported ${kind} machine ${result.module}`, `已匯入 ${kind} 機 ${result.module}`, `${kind} マシン ${result.module} を読み込みました`)}</strong>
        <button className="icon ghost" onClick={onClose} aria-label={tr("Close", "關閉")}>×</button>
      </div>
      <dl>
        <dt>{tr("Style", "寫法")}</dt><dd>{useLang.getState().lang === "en" ? result.style : result.style.replace(/always blocks?/, tr("", "個 always", " 個の always")).replace(/assigns?/, tr("", "個 assign", " 個の assign"))}</dd>
        <dt>{tr("State register", "狀態暫存器")}</dt><dd><code>{result.stateVar}</code>{result.nextVar && <> → <code>{result.nextVar}</code></>}</dd>
        <dt>{tr("States", "狀態")}</dt><dd>{d.states.map((s) => `${s.name}=${result.stateCodes[s.name]}`).join(tr(", ", "、"))}</dd>
        <dt>Reset</dt><dd><code>{d.reset.name}</code>{tr(` (active ${d.reset.activeLow ? "low" : "high"}, ${d.reset.async ? "async" : "sync"})`, `（${d.reset.activeLow ? "低電位" : "高電位"}、${d.reset.async ? "非同步" : "同步"}）`, `（${d.reset.activeLow ? "ローアクティブ" : "ハイアクティブ"}、${d.reset.async ? "非同期" : "同期"}）`)}</dd>
        {result.mooreOutputs.length > 0 && <><dt>{tr("Moore outputs", "Moore 輸出")}</dt><dd>{result.mooreOutputs.join(tr(", ", "、"))}{tr(" (in the states)", "（畫在狀態裡）")}</dd></>}
        {result.mealyOutputs.length > 0 && <><dt>{tr("Mealy outputs", "Mealy 輸出")}</dt><dd>{result.mealyOutputs.join(tr(", ", "、"))}{tr(" (on the transitions)", "（畫在轉移上）")}</dd></>}
      </dl>
      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((w) => <li key={w}>{warningText(w)}</li>)}
        </ul>
      )}
    </div>
  );
}

const WARNINGS: Array<[RegExp, (...m: string[]) => string, (...m: string[]) => string]> = [
  [/^Skipped (.+) on line (\d+); its effect is not in the diagram$/, (_, what, line) => `第 ${line} 行的 ${what} 無法分析，已略過，圖中不含它的效果`, (_, what, line) => `${line} 行目の ${what} は解析できないため省略しました。図にはその効果が含まれません`],
  [/^Skipped (.+)$/, (_, what) => `已略過 ${what}`, (_, what) => `${what} を省略しました`],
  [/^Internal signal "(.+)" is used in transition conditions/, (_, n) => `內部訊號 ${n} 出現在轉移條件中，已列為輸入`, (_, n) => `内部信号 ${n} が遷移条件に使われているため、入力として扱いました`],
  [/^Registered output "(.+)" changes with the transition taken/, (_, n) => `暫存器輸出 ${n} 依走哪條轉移而不同，所以畫在轉移上（實際在轉移後的下一個時脈才更新）`, (_, n) => `レジスタ出力 ${n} は通る遷移によって変わるため遷移上に描きました（実際には遷移後の次のクロックで更新）`],
  [/^No reset found/, () => "找不到狀態暫存器的 reset，圖中使用預設的 reset 訊號", () => "状態レジスタのリセットが見つからないため、既定のリセット信号を使います"],
  [/^Could not find the reset state of "(.+)"; using (.+) as the initial state$/, (_, r, s) => `找不到 ${r} 的 reset 狀態，改用 ${s} 當起始狀態`, (_, r, s) => `${r} のリセット状態が見つからないため、${s} を初期状態にしました`],
  [/^Register "(.+)" also looks like a state register/, (_, n) => `暫存器 ${n} 看起來也像狀態暫存器，這次匯入的是另一個（可在匯入視窗切換）`, (_, n) => `レジスタ ${n} も状態レジスタのようです。今回読み込んだのは別のものです（読み込み画面で切り替えられます）`],
  [/^Output "(.+)" does not depend on "(.+)"; it is left out$/, (_, o, r) => `輸出 ${o} 跟 ${r} 無關（屬於其他電路），沒有畫進這張圖`, (_, o, r) => `出力 ${o} は ${r} と無関係（別の回路）なので図に含めていません`],
  [/^Conditions in state (.+) have too many parts to simplify/, (_, st) => `狀態 ${st} 的條件組合太多，條件照原本的寫法顯示、沒有化簡`, (_, st) => `状態 ${st} の条件の組み合わせが多すぎるため、簡略化せず元の書き方のまま表示します`],
  [/^Imported module (\w+); the file also has (.+) \(pick/, (_, m, others) => `匯入的是 module ${m}；檔案裡還有 ${others}（沒有狀態機的 module 會略過）`, (_, m, others) => `読み込んだのは module ${m} です。ファイルにはほかに ${others} があります（ステートマシンのない module は省略）`],
  [/^"(.+)" is not assigned on every path of state (.+); assumed to stay$/, (_, n, s) => `狀態 ${s} 有些情況沒有指定 ${n}，視為停在原狀態`, (_, n, s) => `状態 ${s} で ${n} が代入されない場合があり、同じ状態にとどまるとみなしました`],
  [/^Next state of (.+) is not a constant \((.+)\); that case is left out$/, (_, s, e) => `狀態 ${s} 的下一狀態不是常數（${e}），這種情況沒有畫出`, (_, s, e) => `状態 ${s} の次状態が定数ではない（${e}）ため、その場合は描いていません`],
];

function warningText(w: string): string {
  const lang = useLang.getState().lang;
  if (lang === "en") return w;
  for (const [re, zh, ja] of WARNINGS) { const m = w.match(re); if (m) return (lang === "ja" ? ja : zh)(...m); }
  return w;
}

function importErrorText(msg: string): string {
  if (useLang.getState().lang === "ja") {
    if (/^No module found/.test(msg)) return "コードに module が見つかりません。";
    if (/No state machine found/.test(msg)) return `ステートマシンが見つかりません。クロック付き always ブロックで 2 つ以上の定数状態が代入されるレジスタが必要です。\n（${msg}）`;
    if (/^line \d+:/.test(msg)) return `構文エラー、${msg.replace(/^line (\d+): /, "$1 行目：")}`;
    if (/Too many cases/.test(msg)) return "条件の組み合わせが多すぎて、このステートマシンを展開できません。";
    return msg;
  }
  if (useLang.getState().lang !== "zh") {
    if (/No state machine found/.test(msg)) return `No state machine found: it needs a register assigned two or more constant states in a clocked always block.\n(${msg})`;
    if (/^line \d+:/.test(msg)) return `Syntax error, ${msg}`;
    return msg;
  }
  if (/^No module found/.test(msg)) return "程式碼裡找不到 module。";
  if (/No state machine found/.test(msg)) return `找不到狀態機：需要一個在時脈 always block 裡被指定成兩個以上常數狀態的暫存器。\n（${msg}）`;
  if (/^line \d+:/.test(msg)) return `語法錯誤，${msg.replace(/^line (\d+): /, "第 $1 行：")}`;
  if (/Too many cases/.test(msg)) return "條件組合太多，無法完整展開這個狀態機。";
  return msg;
}
