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
  async invoke(cmd: string, args: Record<string, unknown>) {
    switch (cmd) {
      case "launch_file": return shell.launchPath;
      case "read_text_file": {
        const path = args.path as string;
        if (shell.readError) throw `${path}: ${shell.readError}`;
        if (!shell.files.has(path)) throw `${path}: No such file or directory (os error 2)`;
        return shell.files.get(path);
      }
      case "write_file":
        if (shell.writeError) throw `${args.path}: ${shell.writeError}`;
        shell.files.set(args.path as string, new TextDecoder().decode(Uint8Array.from(args.contents as number[])));
        return null;
      case "plugin:dialog|message":
        return new Promise((res) => shell.asks.push({ message: args.message as string, answer: (yes) => res(yes ? "Yes" : "No") }));
      case "plugin:event|listen": shell.listeners.set(args.event as string, callbacks.get(args.handler as number)!); return nextId++;
      case "plugin:event|unlisten": return null;
      case "plugin:window|destroy": shell.destroyed++; return null;
      default: throw `unknown command ${cmd}`;
    }
  },
};

const { saveDoc } = await import("../src/actions.ts");
const { isDesktop } = await import("../src/platform.ts");
const { createState, newDiagram, useEditor } = await import("../src/store.ts");


test("the stand-in shell is taken for the desktop app", () => assert.ok(isDesktop));

test("a failed write names the file and says the save failed", async () => {
  useEditor.getState().load(newDiagram(), "/home/u/new.fsm.json");
  useEditor.getState().edit((d) => { createState(d, 0, 0); });
  shell.writeError = "Permission denied (os error 13)";
  await assert.rejects(saveDoc(), /^Error: Could not save new\.fsm\.json: permission denied$/);
  assert.equal(useEditor.getState().dirty, true);
  shell.writeError = null;
});
