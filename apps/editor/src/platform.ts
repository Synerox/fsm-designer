// File access. In the Tauri desktop app this uses native dialogs and writes
// files directly; in a plain browser it falls back to <input type=file> and
// downloads so the editor still works for development and a future web build.

import { modalKeys } from "./dialog.ts";
import { tr } from "./i18n.ts";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const FSM_FILTER: FileFilter = { name: "FSM diagram", extensions: ["fsm.json", "json"] };
export const VERILOG_FILTER: FileFilter = { name: "Verilog", extensions: ["v", "sv", "vh", "svh", "txt"] };

export interface OpenedFile {
  path: string;
  text: string;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// Desktop file I/O goes through the shell's own commands (apps/desktop/src-tauri/src/lib.rs).
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export async function openTextFile(filters: FileFilter[]): Promise<OpenedFile | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: false, filters });
    if (typeof path !== "string") return null;
    return { path, text: await invoke<string>("read_text_file", { path }) };
  }
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

/** Desktop: read a file passed on the command line (double-clicking a .fsm.json). */
export async function launchFile(): Promise<OpenedFile | null> {
  if (!isDesktop) return null;
  const path = await invoke<string | null>("launch_file");
  if (!path) return null;
  return { path, text: await invoke<string>("read_text_file", { path }) };
}

/**
 * Save data. With `path` (desktop only) it overwrites that file silently;
 * otherwise it asks where to save. Returns the path written, or null if cancelled.
 */
export async function saveFile(data: string | Uint8Array, opts: { path?: string | null; suggestedName: string; filters: FileFilter[]; mime: string }): Promise<string | null> {
  if (isDesktop) {
    let path = opts.path ?? null;
    if (!path) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      path = await save({ defaultPath: opts.suggestedName, filters: opts.filters });
      if (!path) return null;
    }
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await invoke("write_file", { path, contents: Array.from(bytes) });
    return path;
  }
  const name = opts.path ? baseName(opts.path) : opts.suggestedName;
  const host = await hostDownloads();
  if (host) return saveViaHost(host, name, data);
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

function hostDownloads(): Promise<HostDownloads | null> {
  const claude = (window as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
  if (!claude?.use) return Promise.resolve(null);
  downloadsPromise ??= claude.use("downloads").then((d) => (d as HostDownloads | null) ?? null, () => null);
  return downloadsPromise;
}

async function saveViaHost(host: HostDownloads, filename: string, data: string | Uint8Array): Promise<string | null> {
  const attempt = async (name: string) => { await host.save({ filename: name, data }); return name; };
  try {
    return await attempt(filename);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "declined") return null;
    // Only common extensions are allowed (e.g. not .tex): save as plain text instead.
    if (code === "rejected_extension") {
      try { return await attempt(`${filename}.txt`); } catch (e2) { if ((e2 as { code?: string }).code === "declined") return null; throw saveError(e2); }
    }
    throw saveError(e);
  }
}

function saveError(e: unknown): Error {
  const code = (e as { code?: string }).code;
  return new Error(code === "rate_limited"
    ? tr("The previous save dialog is still open; answer it and try again.", "上一個儲存視窗還開著，請先回應它再試一次。")
    : tr(`This page can't save files right now (${code ?? String(e)}).`, `這個頁面目前無法儲存檔案（${code ?? String(e)}）。`, `このページは現在ファイルを保存できません（${code ?? String(e)}）。`));
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

export async function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  if (!isDesktop) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTitle(title);
}

export async function confirmDialog(message: string): Promise<boolean> {
  if (!isDesktop) return pageConfirm(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title: "FSM Designer", kind: "warning" });
}

/** Desktop: ask before closing the window while `isDirty()` is true. */
export async function guardWindowClose(isDirty: () => boolean, message: () => string): Promise<() => void> {
  if (!isDesktop) return () => {}; // the browser build keeps work in localStorage instead
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onCloseRequested(async (e) => {
    if (isDirty() && !(await confirmDialog(message()))) e.preventDefault();
  });
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
