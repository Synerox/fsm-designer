// File and export commands shared by the toolbar and keyboard shortcuts.

import { autoLayout, ensureLayout, fitStateSizes, importVerilogLaidOut, parseDiagram, prettyText, renderLatex, renderSvg, stateRadius } from "@fsm/core";
import type { FsmDiagram, ImportOptions, ImportResult, LayoutIssue } from "@fsm/core";
import { FSM_FILTER, baseName, confirmDialog, fileError, launchFile, openTextFile, saveFile } from "./platform.ts";
import { DEFAULT_NAME, drawOptions, newDiagram, useEditor } from "./store.ts";

import { tr } from "./i18n.ts";

const AUTOSAVE_KEY = "fsm-designer:autosave";

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
  // the circles, and re-lay out if they now crowd.
  if (d.states.some((s) => s.x === undefined || s.y === undefined)) {
    const before = d.states.map((s) => s.radius);
    fitStateSizes(d);
    const grown = d.states.some((s, i) => s.radius !== before[i]);
    if (grown && crowded(d)) await autoLayout(d, { draw: drawOptions() });
    else await ensureLayout(d);
  }
  useEditor.getState().load(d, path);
}

/** Two placed states closer than their radii plus room for a line between them. */
function crowded(d: FsmDiagram): boolean {
  const placed = d.states.filter((s) => s.x !== undefined && s.y !== undefined);
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

export async function exportLatex(): Promise<void> {
  await saveFile(latexText(), { suggestedName: `${stem()}.tex`, filters: [{ name: "LaTeX", extensions: ["tex"] }], mime: "application/x-tex" });
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

export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsub = useEditor.subscribe((s, prev) => {
    // dirty counts too: an import or restore sets it in a second update after
    // load(), and a save to the same path changes nothing else.
    if (s.doc === prev.doc && s.filePath === prev.filePath && s.dirty === prev.dirty) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Write the state as it is now, not as it was when the timer started.
      const { doc, filePath, dirty } = useEditor.getState();
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ doc, filePath, dirty }));
      } catch { /* storage full or unavailable */ }
    }, 300);
  });
  return () => { clearTimeout(timer); unsub(); };
}

export async function restoreSession(): Promise<void> {
  const launched = await launchFile().catch(() => null);
  if (launched) return loadText(launched.text, launched.path);
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    // First visit: keep the blank diagram the store starts with.
    if (!raw) return;
    const saved = JSON.parse(raw) as { doc: unknown; filePath: string | null; dirty: boolean };
    const d = upgradeLabels(parseDiagram(saved.doc));
    // Older versions opened an example under its own name; an unsaved copy takes the default.
    if (!saved.filePath && d.name === "seq_detector_1011") d.name = DEFAULT_NAME;
    await ensureLayout(d);
    useEditor.getState().load(d, saved.filePath);
    if (saved.dirty) useEditor.setState({ dirty: true, savedDoc: null });
  } catch { /* ignore a corrupt autosave */ }
}
