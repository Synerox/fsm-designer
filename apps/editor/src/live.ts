// Live link to an AI agent's FSM MCP server on this computer.
//
// The server's open_in_editor tool opens the editor with
// #live=<port>&code=<one-time code>&fsm=<name>. The page connects to
// ws://127.0.0.1:<port>/live, trades the code for the workspace's token (kept
// in this tab only, to reconnect after the server restarts) and shows that
// workspace diagram: the agent's edits arrive as they are saved, and the
// user's edits are sent back (a short moment after the last change) and saved
// into the same .fsm.json. The server refuses an edit made on an older version
// than the file's and sends the current one; that version then replaces the
// page's, and Ctrl+Z brings the user's back. Opening, importing or starting
// another diagram unlinks the page from the workspace diagram; picking one in
// the status bar links it again.

import { create } from "zustand";
import type { FsmDiagram } from "@fsm/core";
import { readyToDraw } from "./actions.ts";
import { edgeTransitions, keepSelection, useEditor } from "./store.ts";
import { confirmDialog } from "./platform.ts";
import { tr } from "./i18n.ts";

export type LiveStatus = "off" | "connecting" | "connected" | "lost" | "denied";

interface LiveState {
  status: LiveStatus;
  /** The workspace diagram this page shows (and keeps in step), if any. */
  name: string | null;
  /** Diagrams in the agent's workspace. */
  names: string[];
  workspace: string | null;
  /** A short note for the status bar (what just happened, or what went wrong). */
  note: string | null;
}

export const useLive = create<LiveState>(() => ({ status: "off", name: null, names: [], workspace: null, note: null }));

const KEY = "fsm-designer.live";
const SECRET = /^[A-Za-z0-9_-]{20,128}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** How long after the last change an edit is sent. */
const SEND_MS = 300;

interface Session {
  port: number;
  /** The workspace's token, once paired. */
  token?: string;
  /** The link's one-time code, until it has been traded for the token. */
  code?: string;
  name: string | null;
  /** The workspace first paired with: a server for another one is never used. */
  workspace?: string;
}

/** The link's #live=..., or this tab's earlier session (a reload); the # part is removed from the address bar. */
function readSession(): Session | null {
  if (typeof location === "undefined") return null;
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has("live")) {
    const port = Number(h.get("live"));
    const code = h.get("code") ?? "";
    const name = h.get("fsm");
    // Keep the code out of the address bar, history and bookmarks.
    try { history.replaceState(history.state, "", location.pathname + location.search); } catch { /* sandboxed */ }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !SECRET.test(code)) return null;
    const s: Session = { port, code, name: name && NAME.test(name) ? name : null };
    save(s);
    return s;
  }
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (s && Number.isInteger(s.port) && (SECRET.test(s.token ?? "") || SECRET.test(s.code ?? "")))
      return {
        port: s.port, token: SECRET.test(s.token ?? "") ? s.token : undefined, code: SECRET.test(s.code ?? "") ? s.code : undefined,
        name: typeof s.name === "string" && NAME.test(s.name) ? s.name : null, workspace: typeof s.workspace === "string" ? s.workspace : undefined,
      };
  } catch { /* storage off */ }
  return null;
}

function save(s: Session | null): void {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch { /* storage off: a reload forgets the link */ }
}

let session: Session | null = readSession();

/** True when this tab was opened for (or reloaded during) a live session: it then neither restores nor writes the autosave. */
export const liveTab = session !== null;

let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
/** Linked to `session.name`: the editor's doc is that workspace diagram. */
let bound = false;
/** loadSeq of the editor when it was linked; a different one means the user loaded something else. */
let boundSeq = -1;
/** The version the server has (its hash), and the doc object it matches. */
let base = "";
let synced: FsmDiagram | null = null;
/** Saves on their way, by seq. A save sent while another is on its way builds on it ("@chain"). */
const inflight = new Map<number, { doc: FsmDiagram; auto: boolean }>();
/** The doc last sent, so it is not sent twice. */
let lastSent: FsmDiagram | null = null;
/** A doc the server refused (invalid, or a rename onto a taken name): not sent again until it changes. */
let refused: FsmDiagram | null = null;
/** The next save only stores where new states were placed: the user did not edit anything. */
let autoNext = false;
/** The doc with the agent's new states placed here, before it was saved back. */
let placedDoc: FsmDiagram | null = null;
/** The server has this tab's diagram open (after a (re)connect, from its reply to open): saves may go out. */
let ready = false;
let seq = 0;
let sendTimer: ReturnType<typeof setTimeout> | undefined;
let selTimer: ReturnType<typeof setTimeout> | undefined;
let noteTimer: ReturnType<typeof setTimeout> | undefined;
/** Set while this module itself changes the editor, so the change is not sent back. */
let applying = false;

function note(text: string | null, ms = 8000): void {
  clearTimeout(noteTimer);
  useLive.setState({ note: text });
  if (text) noteTimer = setTimeout(() => useLive.setState({ note: null }), ms);
}

function send(m: Record<string, unknown>): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(m));
  return true;
}

/** Change the editor without the change being sent back. */
function apply(fn: () => void): void {
  applying = true;
  try { fn(); } finally { applying = false; }
}

/** Start the link if this tab has one. Called once at startup. */
export function startLive(): void {
  if (!session || ws) return;
  useEditor.subscribe(onEditor);
  globalThis.addEventListener?.("pagehide", flushNow);
  connect();
}

function connect(): void {
  if (!session) return;
  clearTimeout(retry);
  useLive.setState({ status: retries ? "lost" : "connecting" });
  let sock: WebSocket;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${session.port}/live`);
  } catch {
    return scheduleRetry();
  }
  ws = sock;
  sock.onopen = () => {
    const s = session;
    if (s) sock.send(JSON.stringify(s.token ? { t: "hello", token: s.token, v: 1 } : { t: "hello", code: s.code, v: 1 }));
  };
  // One message at a time: placing a new state (onDoc) is async, and a later message must not overtake it.
  let chain = Promise.resolve();
  sock.onmessage = (e) => {
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    chain = chain.then(() => (sock === ws ? onMessage(m) : undefined)).catch((err: unknown) => note(String((err as Error)?.message ?? err)));
  };
  sock.onclose = (e) => {
    if (sock !== ws) return;
    ws = null;
    ready = false;
    inflight.clear();
    lastSent = null;
    if (e.code === 4403) {
      // A used or expired code, or a token from another workspace's server.
      useLive.setState({ status: "denied" });
      return;
    }
    scheduleRetry();
  };
}

function scheduleRetry(): void {
  useLive.setState({ status: "lost" });
  retries++;
  retry = setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(retries, 5)));
}

/** Stop the link (the user's choice); the diagram stays on screen as an ordinary unsaved one. */
export function disconnect(): void {
  flushNow();
  const sock = ws;
  ws = null;
  clearTimeout(retry);
  sock?.close(1000);
  session = null;
  save(null);
  bound = false;
  inflight.clear();
  useLive.setState({ status: "off", name: null, names: [], workspace: null, note: null });
  // From here the diagram is an ordinary one that is not saved anywhere.
  useEditor.setState({ filePath: null, dirty: true, savedDoc: null });
}

/** Whether everything on screen is in the workspace file (so leaving the page loses nothing). */
export function liveLinked(): boolean {
  return bound && useLive.getState().status === "connected" && !inflight.size && sendTimer === undefined && useEditor.getState().doc === synced;
}

/** Show workspace diagram `name` here (from the status bar's list, or asked by the agent). */
export function openLive(name: string): void {
  if (!session) return;
  // Sent first, so the server saves it under the diagram it belongs to.
  flushNow();
  send({ t: "open", name });
}

async function onMessage(m: Record<string, unknown>): Promise<void> {
  if (!session) return;
  switch (m.t) {
    case "welcome": {
      retries = 0;
      const workspace = typeof m.workspace === "string" ? m.workspace : undefined;
      if (session.workspace && workspace !== session.workspace) {
        // Another server took the port after a restart: never mix its diagrams up with ours.
        unbind();
        const s = ws;
        ws = null;
        s?.close(1000);
        useLive.setState({ status: "denied" });
        note(tr("The AI server now on this port uses another workspace; ask the AI to open the editor again.", "這個埠上現在是另一個工作資料夾的 AI server；請讓 AI 重新開啟編輯器。", "このポートの AI サーバーは別のワークスペースです。AI にもう一度開いてもらってください。"), 60000);
        return;
      }
      if (typeof m.token === "string" && SECRET.test(m.token)) session.token = m.token;
      session.code = undefined;
      session.workspace = workspace;
      save(session);
      useLive.setState({ status: "connected", names: strings(m.names), workspace: workspace ?? null });
      if (session.name) send({ t: "open", name: session.name });
      return;
    }
    case "list":
      useLive.setState({ names: strings(m.names) });
      return;
    case "doc":
      return onDoc(String(m.name), String(m.hash), m.doc, m.why === "open");
    case "switch":
      if (typeof m.name === "string" && NAME.test(m.name)) openLive(m.name);
      return;
    case "saved":
      return onSaved(m);
    case "conflict": {
      const mine = inflight.get(Number(m.seq));
      inflight.clear();
      lastSent = null;
      if (same(String(m.name))) {
        await onDoc(String(m.name), String(m.hash), m.doc, false, true);
        if (mine && !mine.auto)
          note(tr("The AI changed this diagram at the same time; its version is shown. Ctrl+Z brings yours back.",
            "AI 同時修改了這張圖，已改為顯示它的版本；按 Ctrl+Z 可以找回你的修改。",
            "AI が同時にこの図を変更したため、その版を表示しています。Ctrl+Z で自分の変更に戻せます。"));
      }
      return;
    }
    case "rejected": {
      const mine = inflight.get(Number(m.seq));
      inflight.clear();
      lastSent = null;
      if (m.stale) {
        // Sent before the server had the diagram open again (a reconnect): it goes out again once it has.
        if (mine && ready) schedule(SEND_MS);
        return;
      }
      if (mine) refused = mine.doc;
      note(tr(`Not saved to the workspace: ${m.message}`, `沒有存到工作資料夾：${m.message}`, `ワークスペースに保存されませんでした：${m.message}`), 15000);
      return;
    }
    case "renamed":
      // Another page renamed the diagram this one shows.
      if (bound && session.name === m.from && typeof m.name === "string" && NAME.test(m.name)) {
        const name = m.name;
        session.name = name;
        save(session);
        useLive.setState({ name });
        apply(() => useEditor.setState({ filePath: `${name}.fsm.json` }));
      }
      return;
    case "deleted":
      if (session.name === m.name) {
        unbind();
        note(tr(`${m.name} was deleted from the workspace; this copy is no longer linked.`, `${m.name} 已從工作資料夾刪除；畫面上這份不再連動。`, `${m.name} はワークスペースから削除されました。この図は連動しなくなりました。`), 15000);
      }
      return;
    case "focus":
      globalThis.focus?.();
      return;
    case "error":
      // The diagram this tab showed cannot be opened any more (say, after a reconnect): it is not saved there now.
      if (m.name !== undefined && m.name === session.name) unbind();
      note(String(m.message ?? "error"), 15000);
      return;
  }
}

function same(name: string): boolean {
  return bound && session?.name === name && useEditor.getState().loadSeq === boundSeq;
}

function unbind(): void {
  bound = false;
  placedDoc = null;
  inflight.clear();
  lastSent = null;
  clearTimeout(sendTimer);
  sendTimer = undefined;
  if (session) { session.name = null; save(session); }
  useLive.setState({ name: null });
}

async function onDoc(name: string, hash: string, raw: unknown, opened: boolean, conflict = false): Promise<void> {
  if (!session) return;
  // Already this version (a reconnect, or an echo): just send what changed here meanwhile.
  if (same(name) && hash === base) {
    ready = true;
    if (useEditor.getState().doc !== synced) schedule(0);
    return;
  }
  if (!opened && !same(name)) return; // a late push for a diagram no longer shown
  let doc: FsmDiagram;
  try {
    // States the agent added without a position are placed here; that is then saved back.
    doc = await readyToDraw(raw, { keepPlaced: same(name) });
  } catch (e) {
    note(tr(`Could not show ${name}: ${(e as Error).message}`, `無法顯示 ${name}：${(e as Error).message}`, `${name} を表示できません：${(e as Error).message}`), 15000);
    return;
  }
  // Whether placing changed anything, so the positions have to be saved.
  const placed = JSON.stringify(doc) !== JSON.stringify(raw);
  const ed = useEditor.getState();
  if (same(name)) {
    ready = true;
    const unsent = !conflict && ed.doc !== synced && ed.doc !== refused && ed.doc !== placedDoc;
    clearTimeout(sendTimer);
    sendTimer = undefined;
    base = hash;
    synced = placed ? null : doc;
    refused = null;
    // New states may be off screen: the view fits the diagram again (a new loadSeq does that).
    const grew = doc.states.some((s) => !ed.doc.states.some((o) => o.id === s.id));
    apply(() => {
      // One undo step, so the user can take the AI's change back.
      useEditor.setState({
        doc, past: [...ed.past.slice(-499), ed.doc], future: [], selection: keepSelection(doc, ed.selection),
        dirty: placed, savedDoc: placed ? null : doc, coalesce: null, caret: null,
        ...(grew ? { loadSeq: ed.loadSeq + 1 } : {}),
      });
      boundSeq = useEditor.getState().loadSeq;
    });
    placedDoc = placed ? doc : null;
    if (placed) { autoNext = true; schedule(SEND_MS); }
    if (unsent)
      note(tr("The AI changed this diagram; your last change was replaced (Ctrl+Z brings it back).", "AI 修改了這張圖，你剛才的變更被取代了（按 Ctrl+Z 可以找回）。", "AI がこの図を変更し、直前の変更は置き換えられました（Ctrl+Z で戻せます）。"));
    return;
  }
  // Another diagram (or the first): it replaces what is on screen. Work not in the workspace is asked about.
  const unsaved = bound ? ed.doc !== synced && ed.doc !== placedDoc : ed.dirty;
  if (unsaved && !(await confirmDialog(tr(
    `Show ${name} from the AI's workspace? The diagram on screen has unsaved changes, which will be discarded.`,
    `要顯示 AI 工作資料夾中的 ${name} 嗎？目前畫面上的圖有尚未儲存的變更，將會被捨棄。`,
    `AI のワークスペースの ${name} を表示しますか？画面の図の未保存の変更は破棄されます。`)))) {
    send({ t: "close" });
    return;
  }
  apply(() => {
    useEditor.getState().load(doc, `${name}.fsm.json`);
    if (placed) useEditor.setState({ dirty: true, savedDoc: null });
  });
  bound = true;
  ready = true;
  boundSeq = useEditor.getState().loadSeq;
  base = hash;
  synced = placed ? null : doc;
  placedDoc = placed ? doc : null;
  refused = null;
  inflight.clear();
  lastSent = null;
  session.name = name;
  save(session);
  useLive.setState({ name });
  if (placed) { autoNext = true; schedule(SEND_MS); }
}

function onSaved(m: Record<string, unknown>): void {
  const sent = inflight.get(Number(m.seq));
  if (!sent || !session) return;
  inflight.delete(Number(m.seq));
  base = String(m.hash);
  synced = sent.doc;
  const name = String(m.name);
  if (name !== session.name) {
    // The module was renamed, and the file with it.
    session.name = name;
    save(session);
    useLive.setState({ name });
  }
  if (inflight.size) return; // a later save is on its way
  lastSent = null;
  apply(() => useEditor.getState().markSaved(`${name}.fsm.json`, sent.doc));
  if (useEditor.getState().doc !== synced && sendTimer === undefined) schedule(SEND_MS);
}

function onEditor(s: ReturnType<typeof useEditor.getState>, prev: ReturnType<typeof useEditor.getState>): void {
  if (applying || !bound) return;
  if (s.loadSeq !== boundSeq) {
    // The user opened, imported or started another diagram: it is not the workspace one.
    send({ t: "close" });
    unbind();
    return;
  }
  if (s.doc !== prev.doc && s.doc !== synced) {
    autoNext = false;
    schedule(SEND_MS);
  }
  if (s.selection !== prev.selection) {
    clearTimeout(selTimer);
    selTimer = setTimeout(sendSelection, 150);
  }
}

function schedule(ms: number): void {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(flush, ms);
}

/** Send the editor's doc if the server does not have it yet. */
function flush(): void {
  sendTimer = undefined;
  // Not yet reopened after a reconnect: the reply to open sends it (onDoc).
  if (!bound || !session?.name || !ready) return;
  const { doc } = useEditor.getState();
  if (doc === synced || doc === refused || doc === lastSent) return;
  const s = ++seq;
  const auto = autoNext;
  // While a save is on its way this one builds on it; the server checks that nothing else came in between.
  if (send({ t: "save", name: session.name, base: inflight.size ? "@chain" : base, doc, seq: s, ...(auto ? { auto } : {}) })) {
    inflight.set(s, { doc, auto });
    lastSent = doc;
    autoNext = false;
  }
}

/** Send a pending change at once (closing the tab, switching diagrams, Ctrl+S). */
export function flushNow(): void {
  if (sendTimer === undefined) return;
  clearTimeout(sendTimer);
  flush();
}

/** Ctrl+S while linked: the workspace file is saved already (or about to be). Returns false when not linked. */
export function liveSave(): boolean {
  if (!bound) return false;
  flushNow();
  if (useLive.getState().status === "connected")
    note(tr("Saved to the AI's workspace automatically.", "已自動存到 AI 的工作資料夾。", "AI のワークスペースに自動保存されています。"), 3000);
  else
    note(tr("Not connected to the AI right now; changes are saved when the connection is back. Save As downloads a copy.",
      "目前沒有連上 AI；連線恢復後會自動存檔。要先留一份可以用「另存新檔」下載。",
      "現在 AI に接続されていません。接続が戻ると保存されます。「名前を付けて保存」でコピーをダウンロードできます。"), 8000);
  return true;
}

function sendSelection(): void {
  if (!bound || !session?.name) return;
  const { doc, selection: sel } = useEditor.getState();
  const name = (id: string) => doc.states.find((s) => s.id === id)?.name ?? id;
  let states: string[] = [];
  let transitions: string[] = [];
  if (sel?.kind === "state") states = [name(sel.id)];
  else if (sel?.kind === "edge") transitions = edgeTransitions(doc, sel.from, sel.to).map((t) => t.id);
  else if (sel?.kind === "multi") {
    states = sel.states.map(name);
    transitions = sel.edges.flatMap((e) => edgeTransitions(doc, e.from, e.to).map((t) => t.id));
  }
  send({ t: "select", name: session.name, states, transitions });
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
