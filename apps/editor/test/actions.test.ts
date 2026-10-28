// File commands: autosave, opening files, auto layout.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { autoLayout } from "@fsm/core";
import { importVerilogText, loadText, restoreSession, serialize, startAutosave, tidyUp } from "../src/actions.ts";
import { createState, createTransition, drawOptions, newDiagram, setInitial, useEditor } from "../src/store.ts";

// Node has no localStorage; a Map stands in for the browser's.
const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
};
const autosaved = () => JSON.parse(storage.get("fsm-designer:autosave") ?? "null") as { dirty: boolean; filePath: string | null } | null;

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

test("an autosave that cannot be loaded is reported and kept, not silently replaced", async () => {
  const bad = JSON.stringify({ doc: { name: "m", type: "moore", outputs: [], states: [{ id: "s0", name: "A", isInitial: true, outputs: { light: 2 } }] }, filePath: null, dirty: true });
  storage.set("fsm-designer:autosave", bad);
  await assert.rejects(restoreSession(), /could not be restored.*Unknown output "light"/);
  assert.equal(storage.get("fsm-designer:autosave:unreadable"), bad, "a copy survives the next autosave");
});
