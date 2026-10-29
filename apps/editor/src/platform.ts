// File access in the browser: <input type=file> to open, downloads to save
// (or the viewer's `downloads` capability on a published claude.ai page).

import { modalKeys } from "./dialog.ts";
import { tr } from "./i18n.ts";

export interface FileFilter {
  name: string;
  extensions: string[];
}

// A getter, so the file picker shows the name in the language of the moment.
export const FSM_FILTER: FileFilter = { get name() { return tr("FSM diagram", "FSM 狀態圖", "FSM 図"); }, extensions: ["fsm.json", "json"] };
export const VERILOG_FILTER: FileFilter = { name: "Verilog", extensions: ["v", "sv", "vh", "svh", "txt"] };

export interface OpenedFile {
  path: string;
  text: string;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** A failed open or save in the UI language: which file, which of the two, and why. */
export function fileError(action: "open" | "save", path: string, e: unknown): Error {
  const why = e instanceof Error ? e.message : String(e);
  const name = baseName(path);
  return new Error(action === "open"
    ? tr(`Could not open ${name}: ${why}`, `無法開啟 ${name}：${why}`, `${name} を開けませんでした：${why}`)
    : tr(`Could not save ${name}: ${why}`, `無法儲存 ${name}：${why}`, `${name} を保存できませんでした：${why}`));
}

export function openTextFile(filters: FileFilter[]): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(",");
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { path: file.name, text: await file.text() } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Save data as a download named after `path` (the file it was opened as) or
 * `suggestedName`. Returns the name saved under, or null if cancelled. The
 * data can also be a function that makes the bytes (a PNG takes up to a
 * second to render).
 */
export async function saveFile(make: string | Uint8Array | (() => Promise<Uint8Array>), opts: { path?: string | null; suggestedName: string; filters: FileFilter[]; mime: string }): Promise<string | null> {
  const data = typeof make === "function" ? await make() : make;
  const name = opts.path ? baseName(opts.path) : opts.suggestedName;
  const host = await hostDownloads();
  if (host) return saveViaHost(host, name, data);
  // A published page whose viewer cannot run `downloads` (not declared, not
  // granted, or no answer in 10 s): its frame blocks <a download> as well, so
  // the link below would save nothing while Save marked the diagram saved.
  // (A plain page in a sandbox without allow-downloads cannot be told apart.)
  if (onHostPage()) throw new Error(cantSave());
  const blob = new Blob([data as BlobPart], { type: opts.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return a.download;
}

// ---- Running as a published claude.ai page ----
// The page's frame blocks <a download>, so files go through the viewer's
// `downloads` capability, which asks the viewer to confirm each save.

interface HostDownloads {
  save(req: { filename: string; data: string | Uint8Array }): Promise<{ status: string }>;
}

let downloadsPromise: Promise<HostDownloads | null> | undefined;

const hostClaude = () => (window as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
const onHostPage = () => typeof hostClaude()?.use === "function";

function hostDownloads(): Promise<HostDownloads | null> {
  const claude = hostClaude();
  if (!claude?.use) return Promise.resolve(null);
  downloadsPromise ??= claude.use("downloads").then((d) => (d as HostDownloads | null) ?? null, () => null);
  return downloadsPromise;
}

const cantSave = () => tr("This page can't save files.", "這個頁面無法儲存檔案。", "このページはファイルを保存できません。");

async function saveViaHost(host: HostDownloads, filename: string, data: string | Uint8Array): Promise<string | null> {
  const attempt = async (name: string) => { await host.save({ filename: name, data }); return name; };
  try {
    return await attempt(filename);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "declined") return null;
    // Only common extensions are allowed (e.g. not .tex): save as plain text instead.
    if (code === "rejected_extension") {
      const txt = `${filename}.txt`;
      try { return await attempt(txt); } catch (e2) { if ((e2 as { code?: string }).code === "declined") return null; throw saveError(e2, txt); }
    }
    throw saveError(e, filename);
  }
}

/** The host's error codes (see its downloads contract) as sentences; the raw code is kept only for the ones that mean a bug here. */
function saveError(e: unknown, filename: string): Error {
  const code = (e as { code?: unknown } | null)?.code;
  const ext = filename.slice(filename.lastIndexOf(".") + 1);
  switch (code) {
    case "rate_limited":
      return new Error(tr("The previous save dialog is still open; answer it and try again.", "上一個儲存視窗還開著，請先回應它再試一次。"));
    case "extension_not_enabled":
      return new Error(tr(`This page can't save .${ext} files.`, `這個頁面無法儲存 .${ext} 檔案。`, `このページでは .${ext} ファイルを保存できません。`));
    case "too_large":
      return new Error(tr("The file is too large to save from this page.", "檔案太大，無法從這個頁面儲存。", "ファイルが大きすぎるため、このページから保存できません。"));
    case "bad_request": case "transform_error": case "request_unknown": case "not_signed": case undefined: {
      const detail = typeof code === "string" ? code : String(e);
      return new Error(tr(`This page can't save files right now (${detail}).`, `這個頁面目前無法儲存檔案（${detail}）。`, `このページは現在ファイルを保存できません（${detail}）。`));
    }
    default: // unavailable, not_granted, capability_disabled/removed, and codes added later
      return new Error(cantSave());
  }
}

let confirmCount = 0; // gives each confirm's text a unique id for aria-labelledby

/**
 * Yes/no question drawn inside the page (embedded pages can't show
 * window.confirm). It is modal for the keyboard too: Escape cancels, Tab
 * stays in it, and the editor's shortcuts wait until it is answered.
 */
function pageConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const box = document.createElement("div");
    box.className = "modal confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    const text = document.createElement("p");
    text.id = `confirm-text-${++confirmCount}`;
    box.setAttribute("aria-labelledby", text.id);
    text.textContent = message;
    const row = document.createElement("div");
    row.className = "row";
    const no = document.createElement("button");
    no.textContent = tr("Cancel", "取消");
    const yes = document.createElement("button");
    yes.textContent = tr("Discard changes", "放棄變更");
    yes.className = "danger";
    let release = () => {};
    const done = (v: boolean) => { backdrop.remove(); release(); resolve(v); };
    no.onclick = () => done(false);
    yes.onclick = () => done(true);
    backdrop.onclick = (e) => { if (e.target === backdrop) done(false); };
    row.append(no, yes);
    box.append(text, row);
    backdrop.append(box);
    document.body.append(backdrop);
    release = modalKeys(box, () => done(false)); // focuses Cancel, the first button
  });
}

export function setWindowTitle(title: string): void {
  document.title = title;
}

export function confirmDialog(message: string): Promise<boolean> {
  return pageConfirm(message);
}

/**
 * Ask before the tab goes while `isDirty()` is true. A browser can only show
 * its own "Leave site?" prompt, so the caller says dirty only when the
 * autosave does not hold the work. Returns the function that stops asking.
 */
export function guardWindowClose(isDirty: () => boolean): () => void {
  const onUnload = (e: BeforeUnloadEvent) => { if (isDirty()) e.preventDefault(); };
  window.addEventListener("beforeunload", onUnload);
  return () => window.removeEventListener("beforeunload", onUnload);
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
