// The desktop app's start-up, save and close paths, against a stand-in for
// the Tauri shell (the same IPC the real app uses, answered here).
import { test } from "node:test";
import assert from "node:assert/strict";

const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
};

const shell = {
  launchPath: null as string | null,
  files: new Map<string, string>(),
  readError: null as string | null,
  writeError: null as string | null,
  asks: [] as Array<{ message: string; answer: (yes: boolean) => void }>,
  destroyed: 0,
  listeners: new Map<string, (e: unknown) => void>(),
};
const callbacks = new Map<number, (e: unknown) => void>();
let nextId = 1;
// Before the editor's modules load: platform.ts decides isDesktop from this.
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  transformCallback(cb: (e: unknown) => void) { const id = nextId++; callbacks.set(id, cb); return id; },
  unregisterCallback(id: number) { callbacks.delete(id); },
  async invoke(cmd: string, args: Record<string, unknown>, options?: { headers?: Record<string, string> }) {
    switch (cmd) {
      case "launch_file": return shell.launchPath;
      case "read_text_file": {
        const path = args.path as string;
        if (shell.readError) throw `${path}: ${shell.readError}`;
        if (!shell.files.has(path)) throw `${path}: No such file or directory (os error 2)`;
        return shell.files.get(path);
      }
      case "write_file":
      {
        // The bytes are the raw body and the path an encoded header (platform.ts saveFile).
        const path = decodeURIComponent(options!.headers!["file-path"]);
        if (shell.writeError) throw `${path}: ${shell.writeError}`;
        shell.files.set(path, new TextDecoder().decode(args as unknown as Uint8Array));
        return null;
      }
      case "plugin:dialog|message":
        return new Promise((res) => shell.asks.push({ message: args.message as string, answer: (yes) => res(yes ? "Yes" : "No") }));
      case "plugin:event|listen": shell.listeners.set(args.event as string, callbacks.get(args.handler as number)!); return nextId++;
      case "plugin:event|unlisten": return null;
      case "plugin:window|destroy": shell.destroyed++; return null;
      default: throw `unknown command ${cmd}`;
    }
  },
};

const { discardUnsaved, restoreSession, saveDoc, serialize } = await import("../src/actions.ts");
const { forgetLaunchFile, guardWindowClose, isDesktop } = await import("../src/platform.ts");
const { createState, newDiagram, useEditor } = await import("../src/store.ts");

const tick = () => new Promise((r) => setTimeout(r, 10));
const fileWith = (n: number) => { const d = newDiagram(); for (let i = 0; i < n; i++) createState(d, 100 + 150 * i, 100); return serialize(d); };
/** Autosave of an unsaved two-state session, as a crash or kill leaves it. */
const crashedSession = () => storage.set("fsm-designer:autosave", JSON.stringify({ doc: JSON.parse(fileWith(2)), filePath: null, dirty: true }));

test("the stand-in shell is taken for the desktop app", () => assert.ok(isDesktop));

test("a launch file asks before replacing unsaved work kept from the last session", async () => {
  shell.files.set("/home/u/t.fsm.json", fileWith(4));
  forgetLaunchFile();
  shell.launchPath = "/home/u/t.fsm.json";
  crashedSession();
  // No: the last session comes back, and the autosave keeps it.
  let done = restoreSession();
  await tick();
  assert.equal(shell.asks.length, 1, "the crash copy was overwritten without a word");
  assert.match(shell.asks[0].message, /unsaved changes.*open t\.fsm\.json\?/);
  shell.asks.shift()!.answer(false);
  await done;
  assert.deepEqual([useEditor.getState().doc.states.length, useEditor.getState().filePath, useEditor.getState().dirty], [2, null, true]);
  // Yes: the file opens.
  done = restoreSession();
  await tick();
  shell.asks.shift()!.answer(true);
  await done;
  assert.deepEqual([useEditor.getState().doc.states.length, useEditor.getState().filePath], [4, "/home/u/t.fsm.json"]);
  // Nothing unsaved: no question.
  storage.set("fsm-designer:autosave", JSON.stringify({ doc: JSON.parse(fileWith(2)), filePath: null, dirty: false }));
  await restoreSession();
  assert.equal(shell.asks.length, 0);
  assert.equal(useEditor.getState().doc.states.length, 4);
  shell.launchPath = null;
  forgetLaunchFile();
});

test("a launch file that cannot be read or parsed says so, and the last session comes back", async () => {
  storage.set("fsm-designer:autosave", JSON.stringify({ doc: JSON.parse(fileWith(2)), filePath: "/home/u/old.fsm.json", dirty: false }));
  forgetLaunchFile();
  shell.launchPath = "/home/u/locked.fsm.json";
  shell.files.set("/home/u/locked.fsm.json", fileWith(1));
  shell.readError = "Permission denied (os error 13)";
  useEditor.getState().load(newDiagram(), null);
  await assert.rejects(restoreSession(), /^Error: Could not open locked\.fsm\.json: permission denied$/);
  assert.equal(useEditor.getState().filePath, "/home/u/old.fsm.json", "titled as the old file with no word of the failure");
  shell.readError = null;

  forgetLaunchFile();
  shell.launchPath = "/home/u/bad.fsm.json";
  shell.files.set("/home/u/bad.fsm.json", "{ not json");
  useEditor.getState().load(newDiagram(), null);
  await assert.rejects(restoreSession(), /^Error: Could not open bad\.fsm\.json: it is not a valid JSON file$/);
  assert.equal(useEditor.getState().doc.states.length, 2, "stayed blank, and the next edit overwrote the autosave");
  shell.launchPath = null;
  forgetLaunchFile();
});

test("a failed write names the file and says the save failed", async () => {
  useEditor.getState().load(newDiagram(), "/home/u/new.fsm.json");
  useEditor.getState().edit((d) => { createState(d, 0, 0); });
  shell.writeError = "Permission denied (os error 13)";
  await assert.rejects(saveDoc(), /^Error: Could not save new\.fsm\.json: permission denied$/);
  assert.equal(useEditor.getState().dirty, true);
  shell.writeError = null;
});

test("closing: one question at a time, and Yes discards the changes for the next launch too", async () => {
  const d = newDiagram();
  createState(d, 100, 100);
  useEditor.getState().load(d, "/home/u/m.fsm.json");
  useEditor.getState().edit((d) => { createState(d, 300, 100); });
  storage.set("fsm-designer:autosave", JSON.stringify({ doc: useEditor.getState().doc, filePath: "/home/u/m.fsm.json", dirty: true }));
  const stop = await guardWindowClose(() => useEditor.getState().dirty, () => "Discard?", discardUnsaved);
  const close = () => shell.listeners.get("tauri://close-requested")!({ event: "tauri://close-requested", id: 1, payload: null });
  close();
  await tick();
  close(); // a second click on X while the first question is open
  await tick();
  assert.equal(shell.asks.length, 1, "each request stacked another dialog, and any Yes closed the window");
  assert.equal(shell.destroyed, 0);
  shell.asks.shift()!.answer(true);
  await tick();
  assert.equal(shell.destroyed, 1);
  const kept = JSON.parse(storage.get("fsm-designer:autosave")!);
  assert.deepEqual([kept.doc.states.length, kept.dirty], [1, false], "the discarded changes came back, marked unsaved, at the next launch");
  stop();
});
