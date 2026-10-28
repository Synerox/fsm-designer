// The desktop file paths (platform.ts with the Tauri shell), against a stand-in
// for the shell's IPC. isDesktop is read when platform.ts loads, so the fake
// window goes in before the editor's modules are imported.
import { test } from "node:test";
import assert from "node:assert/strict";

type Call = { cmd: string; args: unknown; options?: { headers?: Record<string, string> } };
const calls: Call[] = [];
let answer: (c: Call) => unknown = () => null;
(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: unknown, options?: Call["options"]) => {
      const c = { cmd, args, options };
      calls.push(c);
      return answer(c);
    },
  },
};
const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
};

const { isDesktop } = await import("../src/platform.ts");
const { loadText, serialize } = await import("../src/actions.ts");
const { createState, newDiagram, useEditor } = await import("../src/store.ts");

test("the fake shell is seen as the desktop app", () => {
  assert.equal(isDesktop, true);
});

test("a .fsm.json with a byte order mark opens", async () => {
  const d = newDiagram();
  createState(d, 100, 100);
  await loadText("\uFEFF" + serialize(d), "bom.fsm.json");
  assert.equal(useEditor.getState().doc.states.length, 1);
});
