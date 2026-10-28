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

const { isDesktop, launchFile, saveFile } = await import("../src/platform.ts");
const { loadText, restoreSession, serialize } = await import("../src/actions.ts");
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

test("one page load asks the shell for the launch file once, and every caller gets it", async () => {
  calls.length = 0;
  const d = newDiagram();
  createState(d, 100, 100);
  createState(d, 300, 100);
  answer = (c) => c.cmd === "launch_file" ? "/home/u/t.fsm.json" : c.cmd === "read_text_file" ? serialize(d) : null;
  // React's dev mode runs the restoring effect twice. The shell hands the path
  // out once, so a second ask would get nothing and load the autosave over it.
  const [a, b] = await Promise.all([launchFile(), launchFile()]);
  assert.equal(a?.path, "/home/u/t.fsm.json");
  assert.equal(b, a);
  await restoreSession();
  assert.equal(calls.filter((c) => c.cmd === "launch_file").length, 1);
  assert.equal(useEditor.getState().filePath, "/home/u/t.fsm.json");
  assert.equal(useEditor.getState().doc.states.length, 2);
});

test("bytes are written as the raw body, with the path in a header", async () => {
  calls.length = 0;
  answer = () => null;
  const path = "C:\\Users\\王\\a b%.png";
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
  assert.equal(await saveFile(bytes, { path, suggestedName: "x.png", filters: [], mime: "image/png" }), path);
  const w = calls.find((c) => c.cmd === "write_file")!;
  assert.ok(w.args instanceof Uint8Array, "not a JSON array of numbers, 3.5 times the size");
  assert.deepEqual([...(w.args as Uint8Array)], [...bytes]);
  assert.equal(decodeURIComponent(w.options!.headers!["file-path"]), path);
  // Text goes the same way, as UTF-8.
  await saveFile("é", { path: "/t.tex", suggestedName: "t.tex", filters: [], mime: "application/x-tex" });
  assert.deepEqual([...(calls.at(-1)!.args as Uint8Array)], [0xc3, 0xa9]);
});

test("a PNG is rendered after the save dialog, and not at all when it is cancelled", async () => {
  calls.length = 0;
  let rendered = 0;
  const render = async () => { rendered++; calls.push({ cmd: "render", args: null }); return new Uint8Array([1, 2, 3]); };
  answer = () => null; // the dialog is cancelled
  assert.equal(await saveFile(render, { suggestedName: "m.png", filters: [], mime: "image/png" }), null);
  assert.equal(rendered, 0);
  answer = (c) => c.cmd === "plugin:dialog|save" ? "/home/u/m.png" : null;
  assert.equal(await saveFile(render, { suggestedName: "m.png", filters: [], mime: "image/png" }), "/home/u/m.png");
  assert.deepEqual(calls.map((c) => c.cmd), ["plugin:dialog|save", "plugin:dialog|save", "render", "write_file"]);
  assert.deepEqual([...(calls.at(-1)!.args as Uint8Array)], [1, 2, 3]);
});
