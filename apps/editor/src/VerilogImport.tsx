// File > Import Verilog: paste or open Verilog / SystemVerilog code, and the
// FSM in it is extracted (by @fsm/core's importer, no guessing) and drawn as a
// new diagram. A small report says what was found.

import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { listStateMachines } from "@fsm/core";
import type { ImportResult } from "@fsm/core";
import { importVerilogText, loadVerilogDraft, saveVerilogDraft as saveDraft } from "./actions.ts";
import { useModal } from "./dialog.ts";
import { VERILOG_FILTER, openTextFile } from "./platform.ts";
import { MOD, tr, useLang } from "./i18n.ts";
import { importErrorText, warningText } from "./importText.ts";

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

export function VerilogImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (r: ImportResult) => void }) {
  const [code, setCode] = useState(loadVerilogDraft);
  const [selfLoops, setSelfLoops] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(0);
  // Every FSM in the code (several modules, or several state registers in one).
  // Parsed from a deferred copy, so typing in a long source stays responsive.
  const parsed = useDeferredValue(code);
  const machines = useMemo(() => listStateMachines(parsed), [parsed]);
  // Focus starts in the code box (the dialog's first control). Escape, Tab and
  // focus return are handled by useModal, so they keep working after a
  // cancelled "Discard changes?" confirm.
  const box = useModal<HTMLDivElement>(onClose);
  const titleId = useId();
  // The draft is saved once typing pauses, and when the dialog closes.
  const latest = useRef(code);
  latest.current = code;
  useEffect(() => {
    const t = setTimeout(() => saveDraft(code), 300);
    return () => clearTimeout(t);
  }, [code]);
  useEffect(() => () => saveDraft(latest.current), []);

  const openFile = async () => {
    try {
      const f = await openTextFile([VERILOG_FILTER]);
      if (f) { setCode(f.text); setError(null); }
    } catch (e) {
      // A read error (permission, not UTF-8) already names the file.
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // The machine list may still be catching up with the last keystroke.
      const list = parsed === code ? machines : listStateMachines(code);
      const pick = list[Math.min(picked, list.length - 1)];
      const r = await importVerilogText(code, { selfLoops, ...(list.length > 1 && pick ? pick : {}) });
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
          aria-label={tr("Verilog source", "Verilog 程式碼", "Verilog ソース")}
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
          <button className="primary" disabled={!code.trim() || busy} onClick={() => void run()} title={`${MOD}+Enter`} data-testid="verilog-import" aria-busy={busy}>{busy ? tr("Importing…", "匯入中…", "読み込み中…") : tr("Import", "匯入")}</button>
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
        <dt>{tr("Reset", "Reset", "リセット")}</dt><dd><code>{d.reset.name}</code>{tr(` (active ${d.reset.activeLow ? "low" : "high"}, ${d.reset.async ? "async" : "sync"})`, `（${d.reset.activeLow ? "低電位" : "高電位"}、${d.reset.async ? "非同步" : "同步"}）`, `（${d.reset.activeLow ? "ローアクティブ" : "ハイアクティブ"}、${d.reset.async ? "非同期" : "同期"}）`)}</dd>
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
