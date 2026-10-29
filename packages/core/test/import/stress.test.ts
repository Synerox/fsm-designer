// Harder inputs: a big module with two FSMs, a FIFO and a datapath; two FSMs
// in one module; an FSM in a submodule; a parity of 16 inputs; one-hot with
// case (1'b1); and 32-state machines. Behaviour is checked against Icarus
// Verilog where the original can be simulated (skipped without iverilog).
import { test } from "node:test";
import assert from "node:assert/strict";
import { importVerilog, importVerilogLaidOut, listStateMachines } from "../../src/import/index.ts";
import type { ImportOptions } from "../../src/import/index.ts";
import { labelLines, layoutScore, planDiagram } from "../../src/index.ts";
import { evaluate, fixture, HAS_IVERILOG, randomInputs, runIcarus, simulate } from "./helpers.ts";

const names = (r: { diagram: { states: Array<{ name: string }> } }) => r.diagram.states.map((s) => s.name);

test("big module: the FSM is found among a FIFO, a baud counter, a second FSM and a submodule", () => {
  const src = fixture("uart_big.v");
  assert.deepEqual(listStateMachines(src), [{ module: "uart_top", stateVar: "tx_state" }, { module: "uart_top", stateVar: "rx_state" }]);
  const tx = importVerilog(src);
  assert.equal(tx.stateVar, "tx_state");
  assert.equal(tx.machine, "moore");
  assert.deepEqual(names(tx), ["TX_IDLE", "TX_START", "TX_DATA", "TX_PAR", "TX_STOP"]);
  assert.deepEqual(tx.diagram.outputs.map((o) => o.name), ["tx_pin", "tx_busy"], "the receiver's outputs are left out");
  assert.deepEqual(tx.diagram.states[2].outputs, { tx_pin: "shreg[0]", tx_busy: 1 }, "a data output is shown as written, not split into cases");
  assert.ok(tx.diagram.transitions.some((t) => t.condition === "!empty && tick"), "wires that do not depend on the state keep their names");
  assert.ok(tx.warnings.some((w) => /Output "rx_data" does not depend on "tx_state"/.test(w)));
  const rx = importVerilog(src, { stateVar: "rx_state" });
  assert.deepEqual(names(rx), ["RX_IDLE", "RX_DATA", "RX_STOP", "RX_ERR"]);
  assert.ok(!rx.diagram.outputs.some((o) => o.name.startsWith("tx_")));
});

test("two FSMs in one module: each imports on its own", () => {
  const src = fixture("two_fsm_handshake.sv");
  assert.deepEqual(listStateMachines(src).map((m) => m.stateVar), ["p", "c"]);
  const p = importVerilog(src);
  assert.deepEqual(names(p), ["P_IDLE", "P_REQ", "P_WAIT", "P_DONE"]);
  assert.deepEqual(p.diagram.outputs.map((o) => o.name), ["req", "done"]);
  const c = importVerilog(src, { stateVar: "c" });
  assert.deepEqual(names(c), ["C_IDLE", "C_WORK", "C_ACK"]);
  assert.deepEqual(c.diagram.outputs.map((o) => o.name), ["busy"]);
  assert.ok(c.diagram.transitions.some((t) => t.condition === "p == P_REQ"), "the other FSM's state shows up as an input");
});

test("FSM in a submodule: the module without one is passed over", () => {
  const r = importVerilog(fixture("hier.v"));
  assert.equal(r.module, "ctrl");
  assert.deepEqual(listStateMachines(fixture("hier.v")), [{ module: "ctrl", stateVar: "st" }]);
});

test("a parity of 16 inputs stays one condition instead of 65536 cases", () => {
  const r = importVerilog(fixture("wide_inputs.v"));
  assert.deepEqual(names(r), ["A", "B", "C"]);
  assert.ok(r.diagram.transitions.length <= 8);
});

test("32 states: import and layout stay quick and clean", async () => {
  for (const f of ["chain_32.v", "random_32.v"]) {
    // CPU time, not wall time: node --test runs the test files side by side, and
    // `pnpm test` builds and tests the other packages too, so on a 4-core machine
    // random_32.v (about 6 s of CPU) took anything from 6 to 30 s of wall time.
    // The limit leaves room for a slow CI runner and still catches a blow-up.
    const c0 = process.cpuUsage();
    const r = await importVerilogLaidOut(fixture(f));
    const c = process.cpuUsage(c0);
    const ms = (c.user + c.system) / 1000;
    assert.equal(r.diagram.states.length, 32, f);
    assert.ok(ms < 20000, `${f}: took ${Math.round(ms)} ms of CPU time`);
    const sc = layoutScore(r.diagram);
    assert.equal(sc.tooClose, 0, f);
    if (f === "chain_32.v") assert.equal(sc.crossings, 0);
  }
});

const SIM: Array<[string, ImportOptions?]> = [
  ["two_fsm_handshake.sv"], ["two_fsm_handshake.sv", { stateVar: "c" }], ["hier.v"], ["wide_inputs.v"],
  ["onehot_reverse_case.v"], ["chain_32.v"], ["random_32.v"],
]; // (uart_big.v is left out: its outputs show internal data such as rx_sh, which the test bench cannot drive)
for (const [f, opts] of SIM) {
  test(`${f}${opts ? ` (${opts.stateVar})` : ""}: the diagram behaves like the Verilog`, { skip: !HAS_IVERILOG && "iverilog not installed" }, () => {
    const src = fixture(f);
    const r = importVerilog(src, opts);
    const seq = randomInputs(r.diagram, 300, 5);
    const consts = Object.fromEntries(Object.entries(r.constants).map(([k, v]) => [k, evaluate(v, {})]));
    const want = runIcarus(src, f, r, seq);
    const got = simulate(r.diagram, seq, consts);
    assert.equal(want.length, seq.length);
    for (let i = 0; i < seq.length; i++) assert.deepEqual(got[i], want[i], `cycle ${i}`);
  });
}

test("logic-locked CLE core behind a pad-ring wrapper: 16 states, long conditions wrapped", async () => {
  const r = await importVerilogLaidOut(fixture("cle_locked.v"));
  assert.equal(r.module, "CLE_core");
  assert.equal(r.stateVar, "cs");
  assert.equal(r.diagram.states.length, 16);
  assert.equal(layoutScore(r.diagram).tooClose, 0);
  const plan = planDiagram(r.diagram);
  assert.ok(plan.edges.every((e) => e.lines.every((l) => l.length <= 48)), "labels are wrapped");
});

test("labelLines breaks after || and &&, outputs on their own line", () => {
  assert.deepEqual(labelLines("x / z=0"), ["x / z=0"]);
  assert.deepEqual(labelLines("(aaaaaaaa && bbbbbbbbbb) || (cccccccccc && dddddddd) / z=1"), ["(aaaaaaaa && bbbbbbbbbb) ||", "(cccccccccc && dddddddd)", "/ z=1"]);
});
