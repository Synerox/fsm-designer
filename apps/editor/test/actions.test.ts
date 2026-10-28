// File commands: autosave, opening files, auto layout.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { autoLayout, renderSvg } from "@fsm/core";
import { MAX_DRAFT, autosaveLost, discardUnsaved, importVerilogText, loadText, loadVerilogDraft, restoreSession, saveVerilogDraft, serialize, startAutosave, tidyUp, useAutosave } from "../src/actions.ts";
import { createState, createTransition, drawOptions, newDiagram, setInitial, useEditor } from "../src/store.ts";
import { useLang } from "../src/i18n.ts";

// Node has no localStorage; a Map stands in for the browser's.
const storage = new Map<string, string>();
let storageFull = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (storageFull) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    storage.set(k, String(v));
  },
  removeItem: (k: string) => { storage.delete(k); },
};
// ...and no window to hear other tabs' "storage" events on.
const events = new EventTarget();
Object.assign(globalThis, { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
const autosaved = () => JSON.parse(storage.get("fsm-designer:autosave") ?? "null") as { doc: { states: Array<{ label?: string }> }; dirty: boolean; filePath: string | null } | null;

const SEQ = `module m (input clk, input rst, input x, output reg z);
  localparam A = 1'b0, B = 1'b1;
  reg state, next_state;
  always @(posedge clk) if (rst) state <= A; else state <= next_state;
  always @(*) begin
    next_state = state; z = 0;
    case (state)
      A: if (x) next_state = B;
      B: begin z = 1; if (!x) next_state = A; end
    endcase
  end
endmodule
`;

test("autosave keeps the unsaved flag of an import, and clears it after a save to the same path", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const stop = startAutosave();
  try {
    useEditor.getState().load(newDiagram(), null);
    mock.timers.tick(300);
    assert.equal(autosaved()?.dirty, false);

    // load() then setState({ dirty: true }): only the second update carries the flag.
    assert.ok(await importVerilogText(SEQ));
    assert.equal(useEditor.getState().dirty, true);
    mock.timers.tick(300);
    assert.equal(autosaved()?.dirty, true, "a reload must not see a never-saved import as clean");
    // Undo back to the import as loaded: still never saved.
    useEditor.getState().edit((d) => { createState(d, 0, 0); });
    useEditor.getState().undo();
    assert.equal(useEditor.getState().dirty, true, "an import undone to its start is still unsaved");

    useEditor.getState().markSaved("m.fsm.json");
    mock.timers.tick(300);
    assert.deepEqual([autosaved()?.dirty, autosaved()?.filePath], [false, "m.fsm.json"]);
    useEditor.getState().edit((d) => { createState(d, 0, 0); });
    mock.timers.tick(300);
    assert.equal(autosaved()?.dirty, true);
    // Second save under the same name: only dirty changes.
    useEditor.getState().markSaved("m.fsm.json");
    mock.timers.tick(300);
    assert.equal(autosaved()?.dirty, false, "a saved diagram must not reload with the unsaved dot");
  } finally {
    stop();
    mock.timers.reset();
  }
});

test("opening a file the editor saved gives back the same diagram", async () => {
  // Drawn in the editor: default circles 120 px apart, one long name, one radius set by hand.
  const d = newDiagram();
  for (const [i, name] of ["IDLE", "WAIT_FOR_ACKNOWLEDGE", "SEND", "DONE"].entries()) {
    const s = createState(d, 200 + 120 * i, 300);
    s.name = name;
    delete s.label;
  }
  d.states[0].radius = 24;
  d.states[0].isInitial = true;
  const text = serialize(d);
  await loadText(text, "drawn.fsm.json");
  assert.equal(serialize(useEditor.getState().doc), text, "no circle grows, no font shrinks, nothing moves");
  assert.equal(useEditor.getState().dirty, false);
});

test("a file without coordinates still gets circles that fit its names, and a layout", async () => {
  const d = newDiagram();
  for (const name of ["IDLE", "WAIT_FOR_ACKNOWLEDGE"]) {
    const s = createState(d, 0, 0);
    s.name = name;
    delete s.label;
    delete s.x; delete s.y;
  }
  await loadText(serialize(d), null);
  const st = useEditor.getState().doc.states;
  assert.ok(st.every((s) => s.radius !== undefined && s.radius > 30), "circles grow to fit the long name");
  assert.ok(st.every((s) => s.x !== undefined && s.y !== undefined));
});

test("a hand-edited file with a null or NaN coordinate opens with every state placed", async () => {
  // JSON has no NaN; a script writing one gives null. A null coordinate means
  // "not placed" (parseDiagram), so opening must place such a state.
  const text = JSON.stringify({ name: "m", states: [
    { id: "s0", name: "A", x: 100, y: 100 },
    { id: "s1", name: "B", x: 300, y: 100 },
    { id: "s2", name: "C", x: null, y: 200 },
  ], transitions: [{ id: "t0", from: "s0", to: "s2", condition: "" }] });
  await loadText(text, "hand.fsm.json");
  const st = useEditor.getState().doc.states;
  assert.ok(st.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y)), JSON.stringify(st));
  assert.deepEqual(st.slice(0, 2).map((s) => [s.x, s.y]), [[100, 100], [300, 100]], "placed states stay where they were");
  assert.ok(renderSvg(useEditor.getState().doc).includes("<svg"), "the canvas can draw it");
});

test("Auto Layout applies the start-arrow side the layout chose", async () => {
  // The user turned the start arrow to the right, where the line to S1 will run.
  const d = newDiagram();
  const a = createState(d, 100, 100), b = createState(d, 400, 300);
  createTransition(d, a.id, b.id);
  createTransition(d, b.id, a.id);
  setInitial(d, a.id, 0);
  useEditor.getState().load(d, null);
  const expected = structuredClone(d);
  await autoLayout(expected, { draw: drawOptions() });
  assert.notEqual(expected.states[0].initialAngle, 0, "the layout moves the arrow off the line");
  const { moved } = await tidyUp();
  assert.ok(moved);
  const got = useEditor.getState().doc;
  assert.deepEqual(got.states.map((s) => [s.x, s.y, s.initialAngle]), expected.states.map((s) => [s.x, s.y, s.initialAngle]));
  assert.equal((await tidyUp()).moved, false, "a second run changes nothing");
});

test("a restored unsaved session stays unsaved after an edit and its undo", async () => {
  const d = newDiagram();
  createState(d, 100, 100);
  storage.set("fsm-designer:autosave", JSON.stringify({ doc: JSON.parse(serialize(d)), filePath: "m.fsm.json", dirty: true }));
  await restoreSession();
  assert.equal(useEditor.getState().dirty, true);
  useEditor.getState().edit((d) => { d.states[0].x = 140; });
  useEditor.getState().undo();
  assert.equal(useEditor.getState().dirty, true, "the restored doc was never written to m.fsm.json");
});

/** A drawn one-state diagram as the editor would autosave it, with `patch` applied to the stored object. */
function storeSession(patch: (s: { doc: { states: Array<Record<string, unknown>> }; filePath: unknown; dirty: unknown }) => void) {
  const d = newDiagram();
  createState(d, 100, 100);
  const s = { doc: JSON.parse(serialize(d)), filePath: "m.fsm.json" as unknown, dirty: false as unknown };
  patch(s);
  storage.set("fsm-designer:autosave", JSON.stringify(s));
}

test("a restored session with a file path that is not a string comes back without it", async () => {
  storeSession((s) => { s.filePath = 123; });
  await restoreSession();
  assert.equal(useEditor.getState().doc.states.length, 1);
  assert.equal(useEditor.getState().filePath, null, "a number here blanked the page (baseName called .split on it)");
});

test("an autosave that cannot be drawn is set aside with a message, not loaded", async () => {
  useEditor.getState().load(newDiagram(), null);
  storeSession((s) => { delete s.doc.states[0].name; delete s.doc.states[0].label; });
  const raw = storage.get("fsm-designer:autosave");
  // parseDiagram now refuses the nameless state itself; before that, checkDrawable caught it.
  await assert.rejects(restoreSession(), /^Error: Could not restore the last session: /);
  assert.equal(useEditor.getState().doc.states.length, 0, "rendering it threw and left an empty page on every reload");
  assert.equal(storage.get("fsm-designer:autosave.bad"), raw, "kept where the next edit cannot overwrite it");
  assert.equal(storage.has("fsm-designer:autosave"), false);
});

test("an autosave that is not JSON is set aside with a message", async () => {
  storage.set("fsm-designer:autosave", '{"doc": {"states": [');
  await assert.rejects(restoreSession(), /Could not restore the last session/);
  assert.equal(storage.get("fsm-designer:autosave.bad"), '{"doc": {"states": [');
  storage.set("fsm-designer:autosave", "null");
  await assert.rejects(restoreSession(), /Could not restore the last session: not a saved diagram/);
});

test("with storage full, a bad autosave is still cleared out of the slot", async () => {
  storage.set("fsm-designer:autosave", "null");
  storageFull = true;
  try {
    await assert.rejects(restoreSession(), /Could not restore the last session/);
  } finally {
    storageFull = false;
  }
  assert.equal(storage.has("fsm-designer:autosave"), false, "copying it aside threw first, so every start failed on it again");
});

test("opening a file with a state the editor cannot draw fails instead of blanking the page", async () => {
  useEditor.getState().load(newDiagram(), null);
  const text = JSON.stringify({ name: "agent_made", states: [{ id: "s0", x: 100, y: 100, isInitial: true }], transitions: [] });
  await assert.rejects(loadText(text, "agent.fsm.json"));
  assert.equal(useEditor.getState().doc.states.length, 0);
  await assert.rejects(loadText("{ not json", "bad.fsm.json"), /^Error: it is not a valid JSON file$/);
});

test("opening the wrong file, or one from a newer version, says why in the UI language", async () => {
  const files = ['{"name":"x","version":"1.0.0"}', '{"foo":1}', "[1, 2]", '{"version":2,"states":[]}'];
  const why = async () => {
    const out: string[] = [];
    for (const f of files) await loadText(f, "f.json").catch((e: Error) => out.push(e.message));
    return out;
  };
  try {
    assert.deepEqual(await why(), [
      "it is not an FSM Designer diagram", "it is not an FSM Designer diagram", "it is not an FSM Designer diagram",
      "it was saved by a newer FSM Designer (format version 2); update this one to open it",
    ]);
    useLang.getState().setLang("zh");
    assert.deepEqual(await why(), ["不是 FSM Designer 的圖檔", "不是 FSM Designer 的圖檔", "不是 FSM Designer 的圖檔", "它是較新版的 FSM Designer 存的（格式第 2 版），請更新後再開啟"]);
    useLang.getState().setLang("ja");
    assert.deepEqual(await why(), ["FSM Designer の図ではありません", "FSM Designer の図ではありません", "FSM Designer の図ではありません", "新しい FSM Designer で保存された図です（形式バージョン 2）。更新してから開いてください"]);
    // A restore that is not JSON at all: the engine's English message stayed in the toast.
    storage.set("fsm-designer:autosave", "{bad");
    await assert.rejects(restoreSession(), /^Error: 前回のセッションを復元できませんでした：有効な JSON ではありません$/);
    useLang.getState().setLang("zh");
    storage.set("fsm-designer:autosave", "{bad");
    await assert.rejects(restoreSession(), /^Error: 無法還原上次的工作：不是有效的 JSON$/);
    storage.set("fsm-designer:autosave", JSON.stringify({ doc: { version: 3, states: [] }, filePath: null, dirty: true }));
    await assert.rejects(restoreSession(), /^Error: 無法還原上次的工作：它是較新版的 FSM Designer 存的（格式第 3 版）/);
    // A refusal of one field stays as the core words it: technical detail.
    await assert.rejects(loadText('{"version":1,"states":[{"id":"s0","name":"A","x":"left","y":0}]}', "f.json"), /states\[0\]/);
  } finally {
    useLang.getState().setLang("en");
  }
});

test("discarding on close leaves the last saved diagram in the autosave, not the discarded changes", () => {
  const d = newDiagram();
  createState(d, 100, 100);
  useEditor.getState().load(d, "m.fsm.json");
  useEditor.getState().edit((d) => { createState(d, 300, 100); });
  storage.set("fsm-designer:autosave", JSON.stringify({ doc: useEditor.getState().doc, filePath: "m.fsm.json", dirty: true }));
  discardUnsaved();
  const kept = JSON.parse(storage.get("fsm-designer:autosave")!);
  assert.deepEqual([kept.doc.states.length, kept.filePath, kept.dirty], [1, "m.fsm.json", false]);
  // An import was never saved anywhere: nothing to go back to.
  useEditor.setState({ savedDoc: null });
  discardUnsaved();
  assert.equal(storage.has("fsm-designer:autosave"), false);
});

test("a reload, closed tab or hidden page writes a pending autosave at once", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  // Node has no document either: a stand-in that can hide.
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  (globalThis as { document?: unknown }).document = doc;
  const stop = startAutosave();
  try {
    useEditor.getState().load(newDiagram(), null);
    mock.timers.tick(300);
    // An edit, then the page goes before the 300 ms are up.
    useEditor.getState().edit((d) => { createState(d, 0, 0).label = "IDLE"; });
    events.dispatchEvent(new Event("pagehide"));
    assert.deepEqual(autosaved()?.doc.states.map((s) => s.label), ["IDLE"], "the edit is in the autosave");
    // A save, then a reload: it comes back saved, under its name.
    useEditor.getState().markSaved("m.fsm.json");
    events.dispatchEvent(new Event("pagehide"));
    assert.deepEqual([autosaved()?.dirty, autosaved()?.filePath], [false, "m.fsm.json"]);
    // New (after Discard), then the tab is hidden and killed.
    useEditor.getState().load(newDiagram(), null);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.deepEqual([autosaved()?.doc.states.length, autosaved()?.filePath], [0, null]);
    doc.visibilityState = "visible";
    // Nothing due: a pagehide writes nothing (another tab may hold the slot).
    storage.set("fsm-designer:autosave", "other tab");
    events.dispatchEvent(new Event("pagehide"));
    assert.equal(storage.get("fsm-designer:autosave"), "other tab");
    // Discarded on close: the pending write held the discarded changes, so it stays cancelled.
    useEditor.getState().load(newDiagram(), "m.fsm.json");
    useEditor.getState().edit((d) => { createState(d, 0, 0); });
    discardUnsaved();
    events.dispatchEvent(new Event("pagehide"));
    mock.timers.tick(300);
    assert.equal(autosaved()?.doc.states.length, 0, "the discarded state does not come back");
  } finally {
    stop();
    delete (globalThis as { document?: unknown }).document;
    mock.timers.reset();
  }
});

test("a failed autosave write is reported until a write works again", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const stop = startAutosave();
  try {
    useEditor.getState().load(newDiagram(), null);
    mock.timers.tick(300);
    assert.equal(useAutosave.getState().failed, false);
    storageFull = true;
    useEditor.getState().edit((d) => { createState(d, 0, 0); });
    mock.timers.tick(300);
    assert.equal(useAutosave.getState().failed, true, "the status bar warns and a reload asks first");
    assert.ok(autosaveLost());
    storageFull = false;
    useEditor.getState().edit((d) => { createState(d, 100, 0); });
    mock.timers.tick(300);
    assert.equal(useAutosave.getState().failed, false);
    assert.equal(autosaveLost(), false);
  } finally {
    storageFull = false;
    stop();
    mock.timers.reset();
  }
});

test("another tab writing the autosave is noticed, and this tab's next write takes the slot back", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  useAutosave.setState({ failed: false, otherTab: false, overwritten: false });
  const stop = startAutosave();
  try {
    useEditor.getState().load(newDiagram(), null);
    mock.timers.tick(300);
    events.dispatchEvent(Object.assign(new Event("storage"), { key: "fsm-designer:labels" }));
    assert.equal(useAutosave.getState().otherTab, false, "other keys do not count");
    events.dispatchEvent(Object.assign(new Event("storage"), { key: "fsm-designer:autosave" }));
    assert.deepEqual(useAutosave.getState(), { failed: false, otherTab: true, overwritten: true });
    assert.ok(autosaveLost(), "a reload now brings back the other tab's diagram");
    useEditor.getState().edit((d) => { createState(d, 0, 0); });
    mock.timers.tick(300);
    assert.equal(autosaveLost(), false);
    assert.equal(useAutosave.getState().otherTab, true, "the warning stays: the other tab can write again");
  } finally {
    stop();
    mock.timers.reset();
    useAutosave.setState({ failed: false, otherTab: false, overwritten: false });
  }
});

test("an import draft too big to share storage with the autosave is not kept", () => {
  saveVerilogDraft("module m; endmodule");
  assert.equal(loadVerilogDraft(), "module m; endmodule");
  saveVerilogDraft("/*" + "x".repeat(MAX_DRAFT) + "*/");
  assert.equal(loadVerilogDraft(), "", "a 5 MB draft made every later autosave fail");
});

test("an autosave with an output the diagram does not declare is set aside with a message", async () => {
  const bad = JSON.stringify({ doc: { name: "m", type: "moore", outputs: [], states: [{ id: "s0", name: "A", isInitial: true, outputs: { light: 2 } }] }, filePath: null, dirty: true });
  storage.set("fsm-designer:autosave", bad);
  await assert.rejects(restoreSession(), /Could not restore the last session: .*Unknown output "light"/);
  assert.equal(storage.get("fsm-designer:autosave.bad"), bad, "a copy survives the next autosave");
});
