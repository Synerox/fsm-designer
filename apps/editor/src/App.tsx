import { useEffect, useId, useState } from "react";
import { expandShortcut, planDiagram } from "@fsm/core";
import { Canvas, MAX_ZOOM, zoomAround } from "./Canvas.tsx";
import type { GridOptions, GridStyle, View } from "./Canvas.tsx";
import { Hints } from "./Hints.tsx";
import { Inspector } from "./Inspector.tsx";
import { Menu } from "./Menu.tsx";
import { ImportReport, VerilogImportDialog } from "./VerilogImport.tsx";
import { discardMessage, discardUnsaved, exportLatex, exportPng, exportSvg, latexText, newFile, openFile, restoreSession, saveDoc, startAutosave, tidyUp } from "./actions.ts";
import { baseName, copyText, guardWindowClose, isDesktop, setWindowTitle } from "./platform.ts";
import { deleteCopied, deletesSelection, keyPressesButton, typedText } from "./keys.ts";
import { modalOpen, useModal } from "./dialog.ts";
import { drawOptions, selectionParts, copySelection, deleteSelection, edgeTransitions, getStateText, hasClipboard, pasteClipboard, selectAll, setEdgeText, setStateText, useEditor } from "./store.ts";
import type { Selection } from "./store.ts";
import type { ImportResult, LayoutIssue } from "@fsm/core";
import { drewText, statusText } from "./summary.ts";
import type { LabelMode } from "./store.ts";
import { MOD, tr, useLang } from "./i18n.ts";
import type { Lang } from "./i18n.ts";

const LABEL_MODES = (): Array<[LabelMode, string, string]> => [
  ["all", tr("All", "全部"), tr("Show every transition condition and state output", "顯示所有轉移條件與狀態輸出")],
  ["none", tr("Hidden", "隱藏"), tr("Hide transition conditions and state outputs (a selected line or state still shows its own)", "隱藏轉移條件與狀態輸出（選取的線或狀態仍會顯示）")],
];
/** What the auto layout could not fix, in the current language. */
const issueText = (issues: LayoutIssue[]) => issues.map(({ kind, count: n }) => ({
  crossings: tr(`${n} crossing${n > 1 ? "s" : ""}`, `${n} 處線條交叉`, `交差 ${n} か所`),
  throughStates: tr(`${n} line${n > 1 ? "s" : ""} through a state`, `${n} 條線穿過狀態`, `状態を通る線 ${n} 本`),
  labelOverlaps: tr(`${n} overlapping label${n > 1 ? "s" : ""}`, `${n} 個標籤重疊`, `重なるラベル ${n} 個`),
  tooClose: tr(`${n} pair${n > 1 ? "s" : ""} of states too close`, `${n} 對狀態太近`, `近すぎる状態 ${n} 組`),
})[kind]).join(tr(", ", "、", "、"));

const LANGS: Array<[Lang, string]> = [["en", "English"], ["zh", "中文"], ["ja", "日本語"]];
/** BCP 47 tag for the page and for each language's own name in the menu. */
const langTag = (l: Lang) => (l === "zh" ? "zh-Hant" : l);

export function App() {
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  useEffect(() => { document.documentElement.lang = langTag(lang); }, [lang]);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [grid, setGrid] = useState<GridOptions>(loadGridOptions);
  useEffect(() => { try { localStorage.setItem(GRID_KEY, JSON.stringify(grid)); } catch { /* storage off */ } }, [grid]);
  const [hints, setHints] = useState(() => { try { return localStorage.getItem(HINTS_KEY) === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(HINTS_KEY, hints ? "1" : "0"); } catch { /* storage off */ } }, [hints]);
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const [latex, setLatex] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [layingOut, setLayingOut] = useState(false);
  const [report, setReport] = useState<{ result: ImportResult; seq: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A notice stays while the pointer is on it, and longer messages stay longer.
  const [holdNotice, setHoldNotice] = useState(false);
  useEffect(() => {
    if (!notice) { setHoldNotice(false); return; }
    if (holdNotice) return;
    // Clear only this notice: after a long layout an expired timer can run
    // after the next notice was set but before this effect is cleaned up.
    const t = setTimeout(() => setNotice((n) => (n === notice ? null : n)), 2500 + 50 * notice.length);
    return () => clearTimeout(t);
  }, [notice, holdNotice]);
  const filePath = useEditor((s) => s.filePath);
  const dirty = useEditor((s) => s.dirty);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const loadSeq = useEditor((s) => s.loadSeq);
  const hasStates = useEditor((s) => s.doc.states.length > 0);
  const labels = useEditor((s) => s.labels);
  const setLabels = useEditor((s) => s.setLabels);
  const { undo, redo } = useEditor.getState();

  // Fit the drawing in the window (zooming in at most to 200%).
  const fit = () => {
    const el = document.querySelector<SVGSVGElement>("[data-testid=canvas]");
    const { doc } = useEditor.getState();
    if (!el || !doc.states.length) return setView({ x: 0, y: 0, k: 1 });
    const { minX, minY, maxX, maxY } = planDiagram(doc, drawOptions()).bounds;
    const pad = 40, w = el.clientWidth, h = el.clientHeight;
    const k = Math.min(2, MAX_ZOOM, (w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxY - minY));
    setView({ k, x: (w - (maxX - minX) * k) / 2 - minX * k, y: (h - (maxY - minY) * k) / 2 - minY * k });
  };
  useEffect(() => { if (loadSeq) fit(); }, [loadSeq]);
  // The import report belongs to the diagram it describes.
  useEffect(() => { if (report && loadSeq !== report.seq) setReport(null); }, [loadSeq]);
  // Toolbar zoom buttons: 10% steps around the middle of the canvas.
  const zoomBy = (factor: number) => {
    const el = document.querySelector<SVGSVGElement>("[data-testid=canvas]");
    setView((v) => zoomAround(v, factor, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2));
  };

  const run = (fn: () => Promise<void> | void) => () => {
    Promise.resolve().then(fn).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    restoreSession().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    const stopAutosave = startAutosave();
    const unguard = guardWindowClose(() => useEditor.getState().dirty, discardMessage, discardUnsaved);
    return () => { stopAutosave(); void unguard.then((f) => f()); };
  }, []);

  useEffect(() => {
    void setWindowTitle(`${dirty ? "● " : ""}${filePath ? baseName(filePath) : tr("Untitled", "未命名")} — FSM Designer`);
  }, [filePath, dirty, lang]);

  // Selecting in the diagram drops any text selected on the page (the canvas
  // is user-select: none, so clicking it does not), so Ctrl+C copies whichever
  // of the two the user picked last.
  useEffect(() => useEditor.subscribe((s, prev) => {
    if (s.selection && s.selection !== prev.selection && pageText()) window.getSelection()?.removeAllRanges();
  }), []);

  useEffect(() => {
    // The last button clicked with the mouse: Chromium leaves focus on it, and
    // Space after that is typing, not pressing it again (see keyPressesButton).
    // Forgotten once focus moves anywhere else, so a button reached again by
    // Tab/Shift+Tab is pressed by Space like any keyboard-focused one.
    let clicked: Element | null = null;
    const onPointer = (e: PointerEvent) => { clicked = (e.target as Element).closest?.("button") ?? null; };
    const onFocus = (e: FocusEvent) => { if (e.target !== clicked) clicked = null; };
    const onKey = (e: KeyboardEvent) => {
      // A menu that handled the key itself (arrow keys) already prevented it.
      if (e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target instanceof Element ? e.target : document.body;
      const inField = target.closest("input, textarea, select, [role=menu]");
      const k = e.key.toLowerCase();
      if (mod && k === "s") { e.preventDefault(); run(() => saveDoc(e.shiftKey))(); return; }
      // An open dialog (LaTeX, Import, Discard changes?) owns the keyboard; it
      // handles Escape and Tab itself, and nothing may change the diagram behind it.
      if (inField || modalOpen()) return;
      if (mod && k === "o") { e.preventDefault(); run(openFile)(); return; }
      if (mod && k === "n") { e.preventDefault(); run(newFile)(); return; }
      if (mod && k === "i") { e.preventDefault(); setImporting(true); return; }
      if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (mod && k === "z") { e.preventDefault(); undo(); return; }
      if (mod && (k === "c" || k === "x")) {
        // Text selected on the page (the import report, the status bar) is
        // copied the normal way.
        if (pageText()) return;
        e.preventDefault();
        const st = useEditor.getState();
        const n = copySelection(st.doc, st.selection);
        if (!n) {
          if (st.selection) setNotice(tr("Select a line together with the states at both ends to copy it", "線條要連同兩端的狀態一起選取才能複製"));
          return;
        }
        if (k === "x") {
          // Only what was copied is deleted; lone lines and the start arrow stay selected.
          let kept: Selection = null;
          st.edit((d) => { kept = deleteCopied(d, st.selection); });
          st.select(kept);
        }
        setNotice(k === "x" ? tr(`Cut ${n} item${n === 1 ? "" : "s"}`, `已剪下 ${n} 個物件`, `${n} 個を切り取りました`) : tr(`Copied ${n} item${n === 1 ? "" : "s"}`, `已複製 ${n} 個物件`, `${n} 個をコピーしました`));
        return;
      }
      if (mod && k === "v") {
        e.preventDefault();
        if (!hasClipboard()) return;
        const st = useEditor.getState();
        let pasted: Selection = null;
        st.edit((d) => { pasted = pasteClipboard(d); });
        st.select(pasted);
        return;
      }
      if (mod && k === "a") {
        e.preventDefault();
        const st = useEditor.getState();
        st.select(selectAll(st.doc));
        return;
      }
      const typed = typedText(e);
      if ((mod || e.altKey) && typed === null) return;
      if (keyPressesButton(e.key, target, clicked)) return;

      const { selection, doc, edit, select } = useEditor.getState();
      if (e.key === "Escape") { select(null); return; }
      // F fits the window, unless a state or line is selected (then it is typed).
      if (k === "f" && selection?.kind !== "state" && selection?.kind !== "edge") { e.preventDefault(); fit(); return; }
      if (!selection) return;
      if (deletesSelection(e.key, selection)) {
        e.preventDefault();
        edit((d) => deleteSelection(d, selection));
        select(null);
        return;
      }
      // Typing edits the selected state's or transition's text at the caret.
      if (selection.kind === "initial" || selection.kind === "multi") return;
      let cur: string, apply: (text: string) => void;
      if (selection.kind === "state") {
        const s = doc.states.find((v) => v.id === selection.id);
        if (!s) return;
        cur = getStateText(s);
        apply = (text) => edit((d) => setStateText(d, s.id, text), `text:${s.id}`);
      } else {
        const [t] = edgeTransitions(doc, selection.from, selection.to);
        if (!t) return;
        cur = t.condition;
        apply = (text) => edit((d) => setEdgeText(d, selection.from, selection.to, text), `text:${t.id}`);
      }
      const { caret: stored, setCaret } = useEditor.getState();
      const caret = Math.min(stored ?? cur.length, cur.length);
      const put = (text: string, at: number) => { apply(text); setCaret(at); };
      switch (e.key) {
        case "ArrowLeft": e.preventDefault(); setCaret(Math.max(0, caret - 1)); return;
        case "ArrowRight": e.preventDefault(); setCaret(Math.min(cur.length, caret + 1)); return;
        case "ArrowUp": case "Home": e.preventDefault(); setCaret(0); return;
        case "ArrowDown": case "End": e.preventDefault(); setCaret(cur.length); return;
        case "Backspace":
          e.preventDefault();
          if (caret > 0) put(cur.slice(0, caret - 1) + cur.slice(caret), caret - 1);
          return;
        case " ": {
          e.preventDefault();
          // "_0" + space -> ₀ and "\beta" + space -> β. Transitions only expand
          // greek, since Verilog conditions use names like data_0.
          const x = expandShortcut(cur, caret, { subscripts: selection.kind === "state" });
          if (x) put(x.text, x.caret);
          else put(cur.slice(0, caret) + " " + cur.slice(caret), caret + 1);
          return;
        }
      }
      if (typed === null) return;
      e.preventDefault();
      put(cur.slice(0, caret) + typed + cur.slice(caret), caret + 1);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("focusin", onFocus, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [undo, redo]);

  return (
    <div className="app">
      <header className="menubar">
        <span className="brand"><span className="logo" aria-hidden="true" />FSM Designer</span>
        <Menu
          label={tr("File", "檔案")}
          items={[
            { label: tr("New Project", "新專案"), shortcut: `${MOD}+N`, onSelect: run(newFile) },
            { label: tr("Open Project", "開啟專案"), shortcut: `${MOD}+O`, onSelect: run(openFile) },
            { label: tr("Save", "儲存"), shortcut: `${MOD}+S`, onSelect: run(() => saveDoc()) },
            { label: tr("Save As", "另存新檔"), shortcut: `${MOD}+Shift+S`, onSelect: run(() => saveDoc(true)) },
            { label: tr("Import Verilog…", "匯入 Verilog…"), shortcut: `${MOD}+I`, onSelect: () => setImporting(true) },
            {
              label: tr("Export", "匯出"),
              submenu: [
                { label: "PNG", onSelect: run(() => exportPng()) },
                { label: "SVG", onSelect: run(exportSvg) },
                { label: "LaTeX", onSelect: run(() => setLatex(latexText())) },
              ],
            },
          ]}
        />
        <div className="menu">
          <button
            className="menu-trigger"
            disabled={!hasStates || layingOut}
            aria-busy={layingOut}
            data-testid="tidy"
            onClick={run(async () => {
              setLayingOut(true); // tidyUp lets this paint before the layout holds the page
              const { moved, issues } = await tidyUp().finally(() => setLayingOut(false));
              if (issues.length) setNotice(tr(`Laid out; could not fix: ${issueText(issues)}`, `已排版，仍無法解決：${issueText(issues)}`, `レイアウト済み。解決できなかった問題：${issueText(issues)}`));
              else if (!moved) setNotice(tr("Already laid out", "目前已經是自動排版的結果"));
              fit();
            })}
          >
            {layingOut ? tr("Laying out…", "排版中…", "レイアウト中…") : tr("Auto Layout", "自動排版")}
          </button>
        </div>
        <span className="sep" />
        <nav className="group" aria-label={tr("Edit", "編輯")}>
          <button className="ghost with-icon" onClick={undo} disabled={!canUndo} title={`${MOD}+Z`}>{tr("Undo", "復原")}<Icon d={UNDO} /></button>
          <button className="ghost with-icon" onClick={redo} disabled={!canRedo} title={`${MOD}+Shift+Z`}>{tr("Redo", "重做")}<Icon d={REDO} /></button>
        </nav>
        <span className="file" title={filePath ?? undefined}>{dirty && <span className="dot" title={tr("Unsaved changes", "尚未儲存")} />}{filePath ? baseName(filePath) : tr("Untitled", "未命名")}</span>
        <Menu
          icon
          label={<Globe />}
          // Names itself in English and in the other UI languages, so it can be
          // found by someone who cannot read the current one (English is the default).
          title={tr("Language / 語言 / 言語", "Language / 語言", "Language / 言語")}
          testId="lang"
          items={LANGS.map(([l, name]) => ({ label: name, lang: langTag(l), checked: lang === l, onSelect: () => setLang(l) }))}
        />
      </header>
      <main className="main">
        <div className="canvas-wrap">
          <Canvas view={view} setView={setView} grid={grid} />
          {hints && <Hints onClose={() => setHints(false)} />}
          {report && <ImportReport result={report.result} onClose={() => setReport(null)} />}
        </div>
        <Inspector snap={grid.snap} />
      </main>
      <footer className="statusbar">
        <p className="status" data-testid="status">{statusText(doc, selection)}{!isDesktop && <span className="muted"> · {tr("Saving and exporting download the file", "存檔與匯出會以下載方式儲存")}</span>}</p>
        <div className="view-controls">
          <span className="seg" role="group" aria-label={tr("Grid style", "格線樣式")} title={tr("Grid style", "格線樣式")}>
            {GRID_STYLES().map(([style, name]) => (
              <button key={style} className={grid.style === style ? "on" : ""} aria-pressed={grid.style === style} onClick={() => setGrid((g) => ({ ...g, style }))}>{name}</button>
            ))}
          </span>
          <span className="seg" role="group" aria-label={tr("Text on lines", "線上文字")} title={tr("Text on lines (conditions / outputs); exports follow this too", "線上文字（條件 / 輸出）；匯出也會照這個設定")}>
            {LABEL_MODES().map(([mode, name, tip]) => (
              <button key={mode} className={labels === mode ? "on" : ""} aria-pressed={labels === mode} title={tip} onClick={() => setLabels(mode)} data-testid={`labels-${mode}`}>{name}</button>
            ))}
          </span>
          <button className="chip" aria-pressed={grid.snap} onClick={() => setGrid((g) => ({ ...g, snap: !g.snap }))} title={tr("Snap to the grid while dragging (hold Alt to turn off for a moment)", "拖曳時吸附到格線（按住 Alt 暫時不吸附）")}>{tr("Snap", "吸附")}</button>
          <button className="chip" aria-pressed={hints} data-testid="hints-toggle" onClick={() => setHints((h) => !h)} title={hints ? tr("Hide shortcut hints", "隱藏快捷鍵提示") : tr("Show shortcut hints", "顯示快捷鍵提示")}>{tr("Hints", "提示")}</button>
          <span className="zoom-controls" role="group" aria-label={tr("Zoom", "縮放")}>
            <button className="icon" onClick={() => zoomBy(1 / 1.1)} title={tr(`Zoom out (${MOD}+wheel)`, `縮小（${MOD}+滾輪）`, `縮小（${MOD}+ホイール）`)} aria-label={tr("Zoom out", "縮小")}><Icon d={ZOOM_OUT} /></button>
            <button className="zoom" data-testid="zoom" onClick={() => zoomBy(1 / view.k)} title={tr("Zoom level; click for 100%", "縮放比例；點一下回到 100%")}>{Math.round(view.k * 100)}%</button>
            <button className="icon" onClick={() => zoomBy(1.1)} title={tr(`Zoom in (${MOD}+wheel)`, `放大（${MOD}+滾輪）`, `拡大（${MOD}+ホイール）`)} aria-label={tr("Zoom in", "放大")}><Icon d={ZOOM_IN} /></button>
            <button className="icon" data-testid="fit" onClick={fit} title={tr("Fit to window (F)", "符合視窗（F）")} aria-label={tr("Fit to window", "符合視窗")}><Icon d={FIT} /></button>
          </span>
        </div>
      </footer>
      {latex !== null && <LatexDialog latex={latex} onClose={() => setLatex(null)} onSave={run(async () => {
        const name = await exportLatex();
        // A published page saves .tex only as text (see saveViaHost).
        if (name && !isDesktop && name.endsWith(".tex.txt")) setNotice(tr(`Saved as ${name}: this page can't save .tex files, so rename it to .tex`, `已存成 ${name}：這個頁面無法儲存 .tex 檔，請把副檔名改回 .tex`, `${name} として保存しました。このページは .tex を保存できないため、拡張子を .tex に変更してください`));
      })} setNotice={setNotice} />}
      {importing && (
        <VerilogImportDialog
          onClose={() => setImporting(false)}
          onImported={(result) => {
            setImporting(false);
            setReport({ result, seq: useEditor.getState().loadSeq });
            setNotice(drewText(result.diagram));
          }}
        />
      )}
      {/* Always in the page so screen readers announce what appears in them. */}
      <div role="alert">
        {error && (
          <div className="toast" onClick={() => setError(null)}>
            {error}
            <button className="toast-close" onClick={() => setError(null)} aria-label={tr("Close", "關閉")}>×</button>
          </div>
        )}
      </div>
      <div role="status">
        {notice && (
          <div className="toast ok" onClick={() => setNotice(null)} onPointerEnter={() => setHoldNotice(true)} onPointerLeave={() => setHoldNotice(false)}>{notice}</div>
        )}
      </div>
    </div>
  );
}

/** File > Export > LaTeX: the TikZ code, to copy or save. */
function LatexDialog({ latex, onClose, onSave, setNotice }: { latex: string; onClose: () => void; onSave: () => void; setNotice: (s: string) => void }) {
  const box = useModal<HTMLDivElement>(onClose);
  const titleId = useId();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId}>LaTeX (TikZ)</h3>
        <textarea readOnly value={latex} spellCheck={false} aria-labelledby={titleId} />
        <div className="row">
          <button
            onClick={() => {
              const area = box.current!.querySelector("textarea")!;
              copyText(latex).then(
                () => setNotice(tr("LaTeX copied", "已複製 LaTeX")),
                () => { area.focus(); area.select(); setNotice(tr(`All text selected; press ${MOD}+C to copy`, `已選取全部文字，請按 ${MOD}+C 複製`, `全テキストを選択しました。${MOD}+C でコピー`)); },
              );
            }}
          >
            {tr("Copy", "複製")}
          </button>
          <button onClick={onSave}>{tr("Save as .tex", "存成 .tex")}</button>
          <button onClick={onClose}>{tr("Close", "關閉")}</button>
        </div>
      </div>
    </div>
  );
}

/** Whether the user has selected text on the page (outside the text fields). */
function pageText(): boolean {
  if (document.activeElement?.closest("input, textarea")) return false;
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== "";
}
const GRID_KEY = "fsm-designer.grid.v2";
const HINTS_KEY = "fsm-designer.hints.v1";

const GRID_STYLE_IDS: GridStyle[] = ["line", "dot", "none"];
const GRID_STYLES = (): Array<[GridStyle, string]> => [["line", tr("Line", "線")], ["dot", tr("Dot", "點")], ["none", tr("None", "無")]];

function loadGridOptions(): GridOptions {
  try {
    const v = JSON.parse(localStorage.getItem(GRID_KEY) ?? "null") as Partial<GridOptions> | null;
    const style = GRID_STYLE_IDS.some((s) => s === v?.style) ? v!.style! : "line";
    return { style, snap: v?.snap ?? true };
  } catch {
    return { style: "line", snap: true };
  }
}

// 16px stroke icons for the zoom controls.
const ZOOM_OUT = "M7 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9ZM10.3 10.3L14 14M5 7h4";
const ZOOM_IN = ZOOM_OUT + "M7 5v4";
const UNDO = "M6 3L3 6l3 3M3 6h6.5a3.5 3.5 0 0 1 0 7H8";
const REDO = "M10 3l3 3-3 3M13 6H6.5a3.5 3.5 0 0 0 0 7H8";
const FIT = "M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5M5.5 5.5h5v5h-5Z";

function Globe() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" strokeWidth="2" aria-hidden="true">
      <ellipse cx="12" cy="12" rx="4.5" ry="10" stroke="var(--accent)" />
      <path d="M2.8 8h18.4M2.8 16h18.4" stroke="var(--accent)" />
      <circle cx="12" cy="12" r="10" stroke="currentColor" />
    </svg>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
