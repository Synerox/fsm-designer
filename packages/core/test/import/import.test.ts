// Verilog import: structure of the diagrams extracted from hand-written FSMs
// in different coding styles, and behaviour checked cycle by cycle against
// Icarus Verilog running the original source (skipped without iverilog).
import { test } from "node:test";
import assert from "node:assert/strict";
import { importVerilog, importVerilogLaidOut, VerilogImportError } from "../../src/import/index.ts";
import type { ImportResult } from "../../src/import/index.ts";
import { validate } from "../../src/model.ts";
import type { FsmDiagram } from "../../src/model.ts";
import { evaluate, fixture, HAS_IVERILOG, randomInputs, runIcarus, simulate } from "./helpers.ts";

const edges = (d: FsmDiagram) => {
  const n = (id: string) => d.states.find((s) => s.id === id)!.name;
  return d.transitions.map((t) => `${n(t.from)}->${n(t.to)}: ${t.condition}${Object.keys(t.outputs).length ? ` / ${Object.entries(t.outputs).map(([k, v]) => `${k}=${v}`).join(",")}` : ""}`);
};
const stateOutputs = (d: FsmDiagram) => Object.fromEntries(d.states.map((s) => [s.name, s.outputs]));
const constants = (r: ImportResult) => Object.fromEntries(Object.entries(r.constants).map(([k, v]) => [k, evaluate(v, {})]));

test("two always blocks, Mealy output in the next-state block", () => {
  const r = importVerilog(fixture("seq_1011_two_block.v"));
  assert.equal(r.machine, "mealy");
  assert.equal(r.stateVar, "state");
  assert.equal(r.nextVar, "next_state");
  assert.deepEqual(r.mealyOutputs, ["z"]);
  assert.deepEqual(r.diagram.reset, { name: "rst_n", activeLow: true, async: true });
  assert.deepEqual(r.diagram.states.map((s) => s.name), ["IDLE", "GOT_1", "GOT_10", "GOT_101"]);
  assert.ok(r.diagram.states[0].isInitial);
  assert.deepEqual(edges(r.diagram), [
    "IDLE->GOT_1: x / z=0",
    "IDLE->IDLE: !x / z=0",
    "GOT_1->GOT_1: x / z=0",
    "GOT_1->GOT_10: !x / z=0",
    "GOT_10->GOT_101: x / z=0",
    "GOT_10->IDLE: !x / z=0",
    "GOT_101->GOT_1: x / z=1",
    "GOT_101->GOT_10: !x / z=0",
  ]);
  assert.deepEqual(r.warnings, []);
});

test("three always blocks with `define codes and a synchronous active-high reset is Moore", () => {
  const r = importVerilog(fixture("traffic_three_block.v"));
  assert.equal(r.machine, "moore");
  assert.equal(r.style, "3 always blocks");
  assert.deepEqual(r.diagram.reset, { name: "rst", activeLow: false, async: false });
  assert.deepEqual(r.diagram.states.map((s) => s.name), ["S_MAIN_GREEN", "S_MAIN_YELLOW", "S_SIDE_GREEN", "S_SIDE_YELLOW"]);
  assert.deepEqual(stateOutputs(r.diagram).S_MAIN_YELLOW, { main_light: 1, side_light: 0, timer_start: 1 });
  assert.ok(edges(r.diagram).includes("S_MAIN_GREEN->S_MAIN_YELLOW: car && timer_done"));
  assert.ok(edges(r.diagram).includes("S_SIDE_GREEN->S_SIDE_YELLOW: timer_done || !car"));
  assert.ok(r.diagram.transitions.every((t) => !Object.keys(t.outputs).length));
});

test("one always block: registered outputs become Moore outputs of the state they lead to", () => {
  const r = importVerilog(fixture("pattern_one_block.v"));
  assert.equal(r.machine, "moore");
  assert.equal(r.nextVar, undefined);
  assert.equal(r.style, "1 always block");
  assert.deepEqual(r.diagram.reset, { name: "reset_n", activeLow: true, async: true });
  assert.deepEqual(stateOutputs(r.diagram), {
    IDLE: { busy: 0, done: 0 },
    LOAD: { busy: 1, done: 0 },
    RUN: { busy: 1, done: 0 },
    WAIT_B: { busy: 1, done: 0 },
    FINISH: { busy: 0, done: 1 },
  });
  assert.ok(edges(r.diagram).includes("RUN->WAIT_B: a && !b"));
  assert.ok(edges(r.diagram).includes("LOAD->RUN: "), "unconditional transition has an empty condition");
});

test("SystemVerilog enum, always_ff / always_comb and assign outputs", () => {
  const r = importVerilog(fixture("handshake_enum.sv"));
  assert.equal(r.machine, "moore");
  assert.deepEqual(r.stateCodes, { IDLE: "2'b00", REQUEST: "2'b01", WAIT_ACK: "2'b10", DONE: "2'b11" });
  assert.deepEqual(stateOutputs(r.diagram).WAIT_ACK, { valid: 1, ready: 0 });
  assert.ok(edges(r.diagram).includes("WAIT_ACK->IDLE: !ack && !req"));
});

test("one-hot register written with bit indices", () => {
  const r = importVerilog(fixture("onehot_index.v"));
  assert.deepEqual(r.stateCodes, { IDLE: "4'b0001", START: "4'b0010", RUN: "4'b0100", STOP: "4'b1000" });
  assert.deepEqual(edges(r.diagram), ["IDLE->START: go", "IDLE->IDLE: !go", "START->RUN: ", "RUN->STOP: stop", "RUN->RUN: !stop", "STOP->IDLE: "]);
});

test("casez with wildcards turns into bit tests; mixed Moore and Mealy outputs", () => {
  const r = importVerilog(fixture("arbiter_casez.v"));
  assert.equal(r.machine, "mealy");
  assert.deepEqual(r.mooreOutputs, ["busy"]);
  assert.deepEqual(r.mealyOutputs, ["grant"]);
  assert.deepEqual(stateOutputs(r.diagram).G1, { busy: 1 });
  assert.ok(edges(r.diagram).includes("IDLE->G1: !req[0] && req[1] / grant=3'b010"));
  assert.ok(edges(r.diagram).includes("IDLE->IDLE: !req[0] && !req[1] && !req[2] / grant=3'b000"));
});

test("if/else on the state, header parameters, an enable that holds the state", () => {
  const r = importVerilog(fixture("vending_if_else.v"));
  assert.equal(r.machine, "mealy");
  assert.deepEqual(r.diagram.reset, { name: "rst", activeLow: false, async: true });
  assert.deepEqual(r.diagram.states.map((s) => s.name), ["S0", "S5", "S10", "S15"]);
  assert.deepEqual(r.diagram.outputs.map((o) => [o.name, o.default]), [["vend", 0], ["change", 0]], "with two outputs, defaults are left off the labels");
  assert.ok(edges(r.diagram).includes("S15->S0: en && coin == 2'b10 / vend=1,change=1"));
});

test("imported diagrams pass the editor's checks and get a layout", async () => {
  for (const f of ["seq_1011_two_block.v", "traffic_three_block.v", "pattern_one_block.v", "handshake_enum.sv", "onehot_index.v", "arbiter_casez.v", "vending_if_else.v"]) {
    const r = await importVerilogLaidOut(fixture(f));
    assert.deepEqual(validate(r.diagram).filter((i) => i.level === "error"), [], f);
    assert.ok(r.diagram.states.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y)), f);
  }
});

test("options: pick the module and the state register, hide self loops", () => {
  const two = fixture("seq_1011_two_block.v") + "\nmodule empty(input a, output b); assign b = a; endmodule\n";
  assert.throws(() => importVerilog(two, { module: "empty" }), VerilogImportError);
  assert.throws(() => importVerilog(two, { module: "nope" }), /No module named "nope"/);
  const r = importVerilog(two, { selfLoops: false });
  assert.ok(r.diagram.transitions.every((t) => t.from !== t.to || Object.keys(t.outputs).length), "self loops are kept only when they carry outputs");
  assert.match(r.warnings[0], /also has empty/);
});

test("clear errors for code without an FSM", () => {
  assert.throws(() => importVerilog("module m(input a, output b); assign b = ~a; endmodule"), /No state machine found/);
  assert.throws(() => importVerilog("// nothing here"), /No module found/);
  const counter = `module c(input clk, input rst, output reg [3:0] n);
    always @(posedge clk) if (rst) n <= 0; else n <= n + 1;
  endmodule`;
  assert.throws(() => importVerilog(counter), /No state machine found/, "a counter is not a state register");
});

test("comments, attributes, `ifdef and a function-like macro do not confuse the parser", () => {
  const src = `
\`define USE_FAST
\`define NEXT(s) next = s
/* block comment with case ( and endcase */
module m (input clk, input rst_n, input go, output reg led);
  (* fsm_encoding = "gray" *) reg [1:0] state, next;
  localparam A = 2'd0, B = 2'd1; // B is also "A + 1"
\`ifdef USE_FAST
  localparam C = 2'd2;
\`else
  localparam C = 2'd3;
\`endif
  always @(posedge clk, negedge rst_n) state <= !rst_n ? A : next;
  always @(state or go) begin
    \`NEXT(state);
    led = 0;
    case (state)
      A: if (go) \`NEXT(B);
      B: begin led = 1; \`NEXT(C); end
      C: \`NEXT(A);
    endcase
  end
endmodule`;
  const r = importVerilog(src);
  assert.deepEqual(r.stateCodes, { A: "2'b00", B: "2'b01", C: "2'b10" });
  assert.deepEqual(edges(r.diagram), ["A->B: go", "A->A: !go", "B->C: ", "C->A: "]);
  assert.deepEqual(stateOutputs(r.diagram).B, { led: 1 });
});

test("named output constants and a counter used in conditions", () => {
  const src = `
module blinker(input clk, input rst, input en, output reg [1:0] color);
  localparam OFF = 1'b0, ON = 1'b1;
  localparam [1:0] RED = 2'd1, GREEN = 2'd2;
  reg state;
  reg [2:0] cnt;
  always @(posedge clk) begin
    if (rst) begin state <= OFF; cnt <= 0; end
    else begin
      cnt <= cnt + 1;
      case (state)
        OFF: if (en && cnt == 3'd7) state <= ON;
        ON:  if (!en || cnt == 3'd7) state <= OFF;
      endcase
    end
  end
  always @* color = (state == ON) ? GREEN : RED;
endmodule`;
  const r = importVerilog(src);
  assert.equal(r.machine, "moore");
  assert.deepEqual(stateOutputs(r.diagram), { OFF: { color: "RED" }, ON: { color: "GREEN" } });
  assert.deepEqual(r.constants, { RED: "2'd1", GREEN: "2'd2" });
  assert.ok(r.diagram.inputs.some((s) => s.name === "cnt" && s.width === 3), "the internal counter is listed with the inputs");
  assert.ok(r.warnings.some((w) => /Internal signal "cnt"/.test(w)));
  assert.ok(edges(r.diagram).includes("OFF->ON: en && cnt == 3'd7"));
});

// ---- behaviour against Icarus Verilog -------------------------------------------

const SIM = ["seq_1011_two_block.v", "traffic_three_block.v", "pattern_one_block.v", "handshake_enum.sv", "onehot_index.v", "arbiter_casez.v", "vending_if_else.v"];
for (const f of SIM) {
  test(`${f}: the diagram behaves like the Verilog, cycle by cycle`, { skip: !HAS_IVERILOG && "iverilog not installed" }, () => {
    const src = fixture(f);
    const r = importVerilog(src);
    const seq = randomInputs(r.diagram, 300, 7);
    const want = runIcarus(src, f, r, seq);
    const got = simulate(r.diagram, seq, constants(r));
    assert.equal(want.length, seq.length);
    for (let i = 0; i < seq.length; i++) {
      assert.deepEqual(got[i], want[i], `cycle ${i}, inputs ${JSON.stringify(seq[i], (_, v) => (typeof v === "bigint" ? Number(v) : v))}`);
    }
  });
}
