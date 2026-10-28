// File and export commands shared by the toolbar and keyboard shortcuts.

import { create } from "zustand";
import { autoLayout, ensureLayout, fitStateSizes, importVerilogLaidOut, parseDiagram, planDiagram, prettyText, renderLatex, renderSvg, stateRadius } from "@fsm/core";
import type { FsmDiagram, ImportOptions, ImportResult, LayoutIssue } from "@fsm/core";
import { FSM_FILTER, baseName, confirmDialog, fileError, launchFile, openTextFile, saveFile } from "./platform.ts";
import type { OpenedFile } from "./platform.ts";
import { DEFAULT_NAME, drawOptions, newDiagram, useEditor } from "./store.ts";

import { tr } from "./i18n.ts";

const AUTOSAVE_KEY = "fsm-designer:autosave";
/** Where an autosave that could not be restored is kept, so the next edit does not destroy it. */
const SET_ASIDE_KEY = "fsm-designer:autosave.bad";

export function serialize(d: FsmDiagram): string {
  return JSON.stringify(d, null, 2) + "\n";
}

function stem(): string {
  const { filePath, doc } = useEditor.getState();
  return filePath ? baseName(filePath).replace(/\.fsm\.json$|\.json$/i, "") : doc.name;
}

export const discardMessage = () => tr("This diagram has unsaved changes. Discard them?", "目前的圖還沒有存檔，要放棄變更嗎？");

async function confirmDiscard(): Promise<boolean> {
  return !useEditor.getState().dirty || confirmDialog(discardMessage());
}

/**
 * Earlier versions stored labels as "S_0" / "\beta" and drew them converted;
 * labels now hold the characters themselves, so convert old ones on load.
 * Conditions only get greek converted (data_0 is a Verilog name).
 */
function upgradeLabels(d: FsmDiagram): FsmDiagram {
  for (const s of d.states) if (s.label !== undefined) s.label = prettyText(s.label);
  for (const t of d.transitions) t.condition = t.condition.replace(/\\[A-Za-z]+/g, (m) => prettyText(m));
  return d;
}

/**
 * Throws, in words, if the diagram cannot be drawn: a throw while rendering
 * would blank the whole page. A safety net: parseDiagram once let through docs
 * the drawing code chokes on (a state without a name), and checks this strict
 * are easy to loosen again.
 */
function checkDrawable(d: FsmDiagram): void {
  try {
    planDiagram(d, drawOptions());
  } catch (e) {
    throw new Error(tr(`the diagram cannot be drawn (${errorText(e)})`, `無法畫出這張圖（${errorText(e)}）`, `図を描画できません（${errorText(e)}）`));
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadText(text: string, path: string | null): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(tr("it is not a valid JSON file", "不是有效的 JSON 檔案", "有効な JSON ファイルではありません"));
  }
  const d = upgradeLabels(parseDiagram(json));
  // A file whose states are all placed (everything the editor saves) opens as
  // it was saved: in the editor text never resizes a state, so its circles and
  // positions are the user's. Files made elsewhere (agents) can come without
  // coordinates and with names and outputs too big for their circles: grow
  // the circles, and re-lay out if they now crowd. A hand-edited null or NaN
  // coordinate counts as missing too: drawing would refuse it and blank the app.
  if (!d.states.every(isPlaced)) {
    const before = d.states.map((s) => s.radius);
    fitStateSizes(d);
    const grown = d.states.some((s, i) => s.radius !== before[i]);
    if (grown && crowded(d)) await autoLayout(d, { draw: drawOptions() });
    else await ensureLayout(d);
  }
  checkDrawable(d);
  useEditor.getState().load(d, path);
}

const isPlaced = (s: FsmDiagram["states"][number]) => Number.isFinite(s.x) && Number.isFinite(s.y);

/** Two placed states closer than their radii plus room for a line between them. */
function crowded(d: FsmDiagram): boolean {
  const placed = d.states.filter(isPlaced);
  return placed.some((a, i) => placed.slice(i + 1).some((b) =>
    Math.hypot(a.x! - b.x!, a.y! - b.y!) < stateRadius(d, a) + stateRadius(d, b) + 60));
}

export async function newFile(): Promise<void> {
  if (!(await confirmDiscard())) return;
  useEditor.getState().load(newDiagram(), null);
}

export async function openFile(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const f = await openTextFile([FSM_FILTER]);
  if (!f) return;
  try {
    await loadText(f.text, f.path);
  } catch (e) {
    throw fileError("open", f.path, e);
  }
}

/**
 * Resolves once the browser has painted. The layout is synchronous and can
 * hold the page for seconds on a big machine, so callers wait for this first
 * to let their busy state show. (Outside a browser it resolves at once.)
 */
export function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((done) => {
    const fallback = setTimeout(done, 100); // a hidden tab gets no frames
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(fallback); done(); }, 0));
  });
}

/**
 * Draw the FSM found in Verilog source as a new, unsaved diagram.
 * Returns null if the user kept the current unsaved diagram.
 */
export async function importVerilogText(source: string, opts: ImportOptions = {}): Promise<ImportResult | null> {
  await afterPaint();
  const r = await importVerilogLaidOut(source, { ...opts, layout: { draw: drawOptions() } }); // throws before anything is replaced
  if (!(await confirmDiscard())) return null;
  useEditor.getState().load(r.diagram, null);
  useEditor.setState({ dirty: true, savedDoc: null }); // never saved: undoing back to it is not clean either
  return r;
}

/** Re-place every state with the auto layout, as one undoable edit. moved is false if nothing moved; issues are what the layout could not fix. */
export async function tidyUp(): Promise<{ moved: boolean; issues: LayoutIssue[] }> {
  await afterPaint();
  const { doc } = useEditor.getState();
  if (!doc.states.length) return { moved: false, issues: [] };
  const d = structuredClone(doc);
  const issues = (await autoLayout(d, { draw: drawOptions() }))?.issues ?? [];
  const pos = new Map(d.states.map((s) => [s.id, s]));
  const tr = new Map(d.transitions.map((t) => [t.id, t]));
  // The layout also picks the start arrow's side (away from the lines), so it comes back too.
  const same = doc.states.every((s) => s.x === pos.get(s.id)!.x && s.y === pos.get(s.id)!.y && s.initialAngle === pos.get(s.id)!.initialAngle)
    && doc.transitions.every((t) => t.curve === tr.get(t.id)!.curve && t.loopAngle === tr.get(t.id)!.loopAngle);
  if (same) return { moved: false, issues };
  useEditor.getState().edit((draft) => {
    for (const s of draft.states) {
      const u = pos.get(s.id)!;
      s.x = u.x; s.y = u.y;
      delete s.initialAngle;
      if (u.initialAngle !== undefined) s.initialAngle = u.initialAngle;
    }
    for (const t of draft.transitions) {
      const u = tr.get(t.id)!;
      delete t.curve; delete t.loopAngle;
      if (u.curve !== undefined) t.curve = u.curve;
      if (u.loopAngle !== undefined) t.loopAngle = u.loopAngle;
    }
  });
  return { moved: true, issues };
}

export async function saveDoc(saveAs = false): Promise<void> {
  const { doc, filePath, markSaved } = useEditor.getState();
  const path = await saveFile(serialize(doc), {
    path: saveAs ? null : filePath,
    suggestedName: `${stem()}.fsm.json`,
    filters: [FSM_FILTER],
    mime: "application/json",
  });
  if (path) markSaved(path, doc);
}

export function svgText(): string {
  return renderSvg(useEditor.getState().doc, drawOptions());
}

export function latexText(): string {
  return renderLatex(useEditor.getState().doc, drawOptions());
}

export async function exportSvg(): Promise<void> {
  await saveFile(svgText(), { suggestedName: `${stem()}.svg`, filters: [{ name: tr("SVG image", "SVG 圖片", "SVG 画像"), extensions: ["svg"] }], mime: "image/svg+xml" });
}

/**
 * Returns the name written, or null if cancelled. A published page cannot save
 * .tex, so there it is the name with .txt added, which the user must be told.
 */
export async function exportLatex(): Promise<string | null> {
  return saveFile(latexText(), { suggestedName: `${stem()}.tex`, filters: [{ name: "LaTeX", extensions: ["tex"] }], mime: "application/x-tex" });
}

/** Rasterise the exported SVG in the webview, so PNG matches SVG exactly. */
export async function pngBytes(scale = 2): Promise<Uint8Array> {
  const svg = svgText();
  const w = Number(svg.match(/width="(\d+)"/)![1]);
  const h = Number(svg.match(/height="(\d+)"/)![1]);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error(tr("PNG encoding failed", "PNG 編碼失敗", "PNG のエンコードに失敗しました")))), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function exportPng(scale = 2): Promise<void> {
  await saveFile(await pngBytes(scale), { suggestedName: `${stem()}.png`, filters: [{ name: tr("PNG image", "PNG 圖片", "PNG 画像"), extensions: ["png"] }], mime: "image/png" });
}

// ---- Autosave: the open diagram survives a reload or crash, like Evan's editor ----

/**
 * Whether the autosave still holds this tab's diagram. failed: the last write
 * threw (storage full, blocked, or an opaque sandbox). otherTab: another tab
 * of this origin writes the same slot, so a reload brings back whichever tab
 * wrote last. overwritten: it did so after this tab's last write.
 */
export const useAutosave = create<{ failed: boolean; otherTab: boolean; overwritten: boolean }>(() => ({ failed: false, otherTab: false, overwritten: false }));

/** True when a reload or close would lose this tab's unsaved changes even though the browser build autosaves. */
export const autosaveLost = () => { const a = useAutosave.getState(); return a.failed || a.overwritten; };

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

function writeAutosave(): void {
  const { doc, filePath, dirty } = useEditor.getState();
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ doc, filePath, dirty }));
    useAutosave.setState({ failed: false, overwritten: false });
  } catch {
    useAutosave.setState({ failed: true });
  }
}

export function startAutosave(): () => void {
  const unsub = useEditor.subscribe((s, prev) => {
    // dirty counts too: an import or restore sets it in a second update after
    // load(), and a save to the same path changes nothing else.
    if (s.doc === prev.doc && s.filePath === prev.filePath && s.dirty === prev.dirty) return;
    clearTimeout(autosaveTimer);
    // Write the state as it is when the timer fires, not as it was when it started.
    autosaveTimer = setTimeout(writeAutosave, 300);
  });
  // Fired only by other tabs (key null: they cleared storage).
  const onStorage = (e: StorageEvent) => {
    if (e.key === AUTOSAVE_KEY || e.key === null) useAutosave.setState({ otherTab: true, overwritten: true });
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => { clearTimeout(autosaveTimer); unsub(); globalThis.removeEventListener?.("storage", onStorage); };
}

/**
 * The user closed the window and chose to discard the unsaved changes, so the
 * next launch must not bring them back: it opens what was last saved.
 */
export function discardUnsaved(): void {
  clearTimeout(autosaveTimer);
  const { savedDoc, filePath } = useEditor.getState();
  try {
    // No savedDoc: an import or restored session that was never written anywhere.
    if (savedDoc) localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ doc: savedDoc, filePath, dirty: false }));
    else localStorage.removeItem(AUTOSAVE_KEY);
  } catch { /* storage off: nothing kept anyway */ }
}

/**
 * Move the autosave out of the way (kept under SET_ASIDE_KEY, which holds only
 * the latest one), so the next start is a blank diagram. The slot is emptied
 * first: with storage full the copy can fail, and a bad autosave left in place
 * would fail again on every start.
 */
export function setAsideAutosave(raw?: string): void {
  try {
    raw ??= localStorage.getItem(AUTOSAVE_KEY) ?? undefined;
    localStorage.removeItem(AUTOSAVE_KEY);
    if (raw !== undefined) localStorage.setItem(SET_ASIDE_KEY, raw);
  } catch { /* storage off or full: no copy, but the slot is clear */ }
}

interface Session { doc: FsmDiagram; filePath: string | null; dirty: boolean }

/** The stored session as a drawable diagram; throws if it is not one. */
async function parseSession(raw: string): Promise<Session> {
  const saved = JSON.parse(raw) as { doc?: unknown; filePath?: unknown; dirty?: unknown } | null;
  if (typeof saved !== "object" || saved === null) throw new Error(tr("not a saved diagram", "不是存下來的圖", "保存された図ではありません"));
  const d = upgradeLabels(parseDiagram(saved.doc));
  // Only this editor writes the slot, but an older build, or a hand edit, can leave anything in it.
  const filePath = typeof saved.filePath === "string" ? saved.filePath : null;
  // Older versions opened an example under its own name; an unsaved copy takes the default.
  if (!filePath && d.name === "seq_detector_1011") d.name = DEFAULT_NAME;
  await ensureLayout(d);
  checkDrawable(d);
  return { doc: d, filePath, dirty: saved.dirty === true };
}

/**
 * Start-up: open the file the desktop app was launched with, else bring back
 * the autosaved session. Throws (after doing what it could) to say what failed.
 */
export async function restoreSession(): Promise<void> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(AUTOSAVE_KEY); } catch { /* storage off: nothing to restore */ }
  let session: Session | null = null;
  let problem: Error | null = null;
  // null on a first visit: keep the blank diagram the store starts with.
  if (raw !== null) {
    try {
      session = await parseSession(raw);
    } catch (e) {
      // Kept for repair by hand: the first edit overwrites the autosave slot.
      setAsideAutosave(raw);
      problem = new Error(tr(`Could not restore the last session: ${errorText(e)}`, `無法還原上次的工作：${errorText(e)}`, `前回のセッションを復元できませんでした：${errorText(e)}`));
    }
  }
  let launched: OpenedFile | null = null;
  try {
    launched = await launchFile();
  } catch (e) {
    // Read errors already say which file (fileError); the session comes back instead.
    problem = e instanceof Error ? e : new Error(String(e));
  }
  // The autosave is the only copy of work that a crash or kill left unsaved,
  // and opening the file replaces it 300 ms later: ask first.
  if (launched && (!session?.dirty || await confirmDialog(tr(
    `The last session has unsaved changes. Discard them and open ${baseName(launched.path)}?`,
    `上次的工作有尚未儲存的變更。要放棄這些變更並開啟 ${baseName(launched.path)} 嗎？`,
    `前回のセッションに保存されていない変更があります。破棄して ${baseName(launched.path)} を開きますか？`)))) {
    try {
      await loadText(launched.text, launched.path);
      session = null;
    } catch (e) {
      problem = fileError("open", launched.path, e);
    }
  }
  if (session) {
    useEditor.getState().load(session.doc, session.filePath);
    if (session.dirty) useEditor.setState({ dirty: true, savedDoc: null });
  }
  if (problem) throw problem;
}

// ---- Import Verilog dialog's draft ----

const DRAFT_KEY = "fsm-designer:verilog-draft";
/**
 * Larger drafts are not kept: they share the origin's ~5 MB of storage with
 * the autosave, and one near that size made every autosave fail. Real FSM
 * sources are a few KB.
 */
export const MAX_DRAFT = 200_000;

export function loadVerilogDraft(): string {
  try { return localStorage.getItem(DRAFT_KEY) ?? ""; } catch { return ""; }
}

/** A draft too big to store is dropped rather than leaving an older one to come back next time. */
export function saveVerilogDraft(code: string): void {
  try {
    if (code.length > MAX_DRAFT) throw new RangeError("draft too large");
    localStorage.setItem(DRAFT_KEY, code);
  } catch {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage off */ }
  }
}
