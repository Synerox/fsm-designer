// Verilog import: parser corner cases that used to lose states or whole
// always blocks without saying so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importVerilog, listStateMachines } from "../../src/import/index.ts";
import { parseVerilog } from "../../src/import/parser.ts";
import type { FsmDiagram } from "../../src/model.ts";

const edges = (d: FsmDiagram) => {
  const n = (id: string) => d.states.find((s) => s.id === id)!.name;
  return d.transitions.map((t) => `${n(t.from)}->${n(t.to)}: ${t.condition}`);
};

test("a `define constant built from other macros keeps its name and value", () => {
  // `RUN uses `IDLE, and `IDLE splices `W into a sized number.
  const src = `
\`define W 2
\`define IDLE \`W'd0
\`define RUN  (\`IDLE + 1)
\`define DONE 2'd2
module m(input clk, input rst_n, input go, output busy);
  reg [\`W-1:0] state, next;
  always @(posedge clk or negedge rst_n) if (!rst_n) state <= \`IDLE; else state <= next;
  always @(*) begin
    next = state;
    case (state)
      \`IDLE: if (go) next = \`RUN;
      \`RUN:  next = \`DONE;
      \`DONE: next = \`IDLE;
    endcase
  end
  assign busy = state != \`IDLE;
endmodule`;
  const r = importVerilog(src);
  assert.deepEqual(r.stateCodes, { IDLE: "2'b00", RUN: "2'b01", DONE: "2'b10" });
  assert.deepEqual(r.diagram.inputs.map((s) => s.name), ["go"]);
  assert.deepEqual(edges(r.diagram), ["IDLE->RUN: go", "IDLE->IDLE: !go", "RUN->DONE: ", "DONE->IDLE: "]);
  assert.deepEqual(r.warnings, []);
});

test("a syntax error that drops the FSM's always block is reported with its line", () => {
  const src = (body: string) => `module m(input clk, input rst_n, input a, output reg y);
  localparam S0 = 0, S1 = 1;
  reg s;
  always @(posedge clk or negedge rst_n)
${body}
  always @* y = (s == S1);
endmodule`;
  // Missing ")" on line 8, then a case and a begin that are never closed.
  assert.throws(() => importVerilog(src(`    if (!rst_n) s <= S0;
    else case (s)
      S0: if (a) s <= S1;
      S1: if (!a s <= S0;
    endcase`)), { message: /^line 8: expected "\)" but found "s"; .*no state machine was found in module m$/ });
  assert.throws(() => importVerilog(src(`    if (!rst_n) s <= S0;
    else case (s)
      S0: if (a) s <= S1;
    `)), { message: /^line 6: "case" without "endcase"/ });
  assert.throws(() => importVerilog(src(`    begin if (!rst_n) s <= S0;
    else begin
      if (a) s <= ~s;
    end`)), { message: /^line 5: "begin" without "end"/ });
});

test("after a broken always block the parser resumes at the next module item", () => {
  const r = importVerilog(`module m(input clk, input rst, input a, output reg y, output reg z);
  localparam S0 = 0, S1 = 1;
  reg s;
  always @* begin
    if (a) z = 1 else z = 0;
  end
  always @(posedge clk) if (rst) s <= S0; else case (s) S0: if (a) s <= S1; S1: s <= S0; endcase
  always @* y = s == S1;
endmodule`);
  assert.deepEqual(r.stateCodes, { S0: "1'b0", S1: "1'b1" });
  // Only the real error, not "instance of else" from resyncing inside the block.
  assert.deepEqual(r.warnings.filter((w) => w.startsWith("Skipped")), ['Skipped line 5: expected ";" but found "else"']);
});

test("package-scoped types (pkg::state_t) in ports and declarations keep the enum's width", () => {
  const r = importVerilog(`package fsm_pkg;
  typedef enum logic [1:0] {IDLE, RUN, DONE} st_t;
endpackage
module m (input logic clk, input logic rst_n, input logic go, output fsm_pkg::st_t cur);
  import fsm_pkg::*;
  fsm_pkg::st_t s, n;
  always_ff @(posedge clk or negedge rst_n) if (!rst_n) s <= fsm_pkg::IDLE; else s <= n;
  always_comb begin
    n = s;
    case (s)
      fsm_pkg::IDLE: if (go) n = RUN;
      RUN: n = DONE;
      DONE: n = IDLE;
    endcase
  end
  assign cur = s;
endmodule`);
  assert.deepEqual(r.stateCodes, { IDLE: "2'b00", RUN: "2'b01", DONE: "2'b10" });
  assert.deepEqual(r.diagram.outputs.map((s) => [s.name, s.width]), [["cur", 2]]);
  assert.deepEqual(edges(r.diagram), ["IDLE->RUN: go", "IDLE->IDLE: !go", "RUN->DONE: ", "DONE->IDLE: "]);
  assert.deepEqual(r.warnings, []);
});

test("the range of a parameter list applies to every name in it", () => {
  // Y = ~0 in [1:0] is 2'b11, so the state compares equal to Y and Y goes on to Z.
  const r = importVerilog(`module m(input clk, input rst_n, input a, output reg y);
  localparam [1:0] X = 0, Y = ~0, Z = 1;
  reg [1:0] s;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) s <= X;
    else case (s)
      X: if (a) s <= Y;
      Y: s <= Z;
      Z: s <= X;
      default: s <= X;
    endcase
  always @* y = (s == Y);
endmodule`);
  assert.deepEqual(r.stateCodes, { X: "2'b00", Y: "2'b11", Z: "2'b01" });
  assert.deepEqual(r.diagram.states.map((s) => [s.name, s.outputs.y]), [["X", 0], ["Y", 1], ["Z", 0]]);
  assert.deepEqual(edges(r.diagram), ["X->Y: a", "X->X: !a", "Y->Z: ", "Z->X: "]);
  // A new keyword starts a new list: B is not cut to [1:0].
  const p = importVerilog(`module m(input clk, input rst, output reg [3:0] q);
  localparam signed [1:0] S0 = 0, S1 = -1; parameter B = 5;
  reg [1:0] s;
  always @(posedge clk) if (rst) s <= S0; else case (s) S0: s <= S1; S1: s <= S0; endcase
  always @* q = s == S1 ? B : 0;
endmodule`);
  assert.deepEqual(p.stateCodes, { S0: "2'b00", S1: "2'b11" });
  assert.deepEqual(p.diagram.states.map((s) => [s.name, s.outputs.q]), [["S0", 0], ["S1", "B"]]);
  assert.equal(p.constants.B, "5");
  assert.deepEqual(edges(p.diagram), ["S0->S1: ", "S1->S0: "]);
});

test("[lo:hi] ranges in case-inside labels and in inside lists", () => {
  const r = importVerilog(`module m(input logic clk, input logic rst_n, input logic [3:0] d, output logic hit);
  typedef enum logic [1:0] {IDLE, LOW, HIGH} st_t;
  st_t s, n;
  always_ff @(posedge clk or negedge rst_n) if (!rst_n) s <= IDLE; else s <= n;
  always_comb begin
    n = s;
    case (s)
      IDLE: case (d) inside
              [4'd0:4'd3], 4'd7: n = LOW;
              [4'd12:4'd15]: n = HIGH;
              default: n = IDLE;
            endcase
      LOW: if (d inside {4'd1, [4'd8:4'd9]}) n = IDLE;
      HIGH: n = IDLE;
    endcase
  end
  assign hit = (s != IDLE);
endmodule`);
  assert.deepEqual(r.stateCodes, { IDLE: "2'b00", LOW: "2'b01", HIGH: "2'b10" });
  assert.deepEqual(edges(r.diagram), [
    "IDLE->LOW: d <= 4'd3 || d == 4'd7",
    "IDLE->HIGH: d >= 4'd12",
    "IDLE->IDLE: d > 4'd3 && d != 4'd7 && d < 4'd12",
    "LOW->IDLE: d == 4'd1 || (d >= 4'd8 && d <= 4'd9)",
    "LOW->LOW: d > 4'd9 || (d != 4'd1 && d < 4'd8)",
    "HIGH->IDLE: ",
  ]);
});

test("a missing endmodule does not merge the next module into this one", () => {
  const src = `module first(input clk, input rst, input a, output reg y);
  localparam S0 = 0, S1 = 1;
  reg s;
  always @(posedge clk) if (rst) s <= S0; else case (s) S0: if (a) s <= S1; S1: s <= S0; endcase
  always @* y = s;

module second(input clk, input rst, input b, output reg z);
  localparam T0 = 2'd0, T1 = 2'd1, T2 = 2'd2;
  reg [1:0] t;
  always @(posedge clk) if (rst) t <= T0; else case (t) T0: if (b) t <= T1; T1: t <= T2; T2: t <= T0; endcase
  always @* z = (t == T2);
endmodule`;
  assert.deepEqual(listStateMachines(src), [{ module: "first", stateVar: "s" }, { module: "second", stateVar: "t" }]);
  const r = importVerilog(src);
  assert.equal(r.stateVar, "s");
  assert.deepEqual(r.diagram.outputs.map((s) => s.name), ["y"]);
  assert.ok(r.warnings.includes('Skipped line 7: "module" before "endmodule" of first'), r.warnings.join("\n"));
  assert.deepEqual(importVerilog(src, { module: "second" }).stateCodes, { T0: "2'b00", T1: "2'b01", T2: "2'b10" });
  // At the end of the file it is only a warning.
  const last = importVerilog(src.replace(/endmodule$/, ""), { module: "second" });
  assert.ok(last.warnings.includes('Skipped line 11: "endmodule" of second missing at the end of the file'), last.warnings.join("\n"));
});

test("a task called without parentheses is skipped like one with them", () => {
  const r = importVerilog(`module m(input clk, input rst, input a, output reg y, output reg z);
  localparam S0 = 1'b0, S1 = 1'b1;
  reg s, n;
  task set_out; begin y = 1; end endtask
  always @(posedge clk) if (rst) s <= S0; else s <= n;
  always @* begin
    n = s; y = 0; z = 0;
    case (s)
      S0: if (a) n = S1;
      S1: begin set_out; z = 1; n = S0; end
    endcase
  end
endmodule`);
  assert.deepEqual(edges(r.diagram), ["S0->S1: a", "S0->S0: !a", "S1->S0: "]);
  assert.deepEqual(r.diagram.states.map((s) => [s.name, s.outputs.z]), [["S0", 0], ["S1", 1]]);
  assert.ok(r.warnings.includes("Skipped call set_out on line 10; its effect is not in the diagram"), r.warnings.join("\n"));
});

test("a missing comma in an ANSI port list keeps both ports and is reported", () => {
  const src = `module m(input clk
  input rst, input [1:0] a
  input b, output reg y);
  localparam S0 = 0, S1 = 1;
  reg s;
  always @(posedge clk) if (rst) s <= S0; else case (s) S0: if (a == 2 && b) s <= S1; S1: s <= S0; endcase
  always @* y = s == S1;
endmodule`;
  assert.deepEqual(parseVerilog(src).modules[0].ports, ["clk", "rst", "a", "b", "y"]);
  const r = importVerilog(src);
  assert.deepEqual(r.diagram.inputs.map((s) => [s.name, s.width]), [["a", 2], ["b", 1]]);
  assert.deepEqual(r.warnings, ['Skipped line 2: expected "," before "input"', 'Skipped line 3: expected "," before "input"']);
});
