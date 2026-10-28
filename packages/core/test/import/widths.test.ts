// Verilog import: expression widths and truth values, as Verilog evaluates
// them (found by differential fuzzing against a Verilog-accurate simulator).
// A multi-bit value tested as a condition is not 1, an unsized literal is 32
// bits, + - ~ << work at the width of their context, an assignment keeps the
// low bits, and an output that copies an input is Mealy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importVerilog } from "../../src/import/index.ts";
import type { FsmDiagram } from "../../src/model.ts";
import { evaluate, simulate } from "./helpers.ts";

const edges = (d: FsmDiagram) => {
  const n = (id: string) => d.states.find((s) => s.id === id)!.name;
  return d.transitions.map((t) => `${n(t.from)}->${n(t.to)}: ${t.condition}${Object.keys(t.outputs).length ? ` / ${Object.entries(t.outputs).map(([k, v]) => `${k}=${v}`).join(",")}` : ""}`);
};
const stateOutputs = (d: FsmDiagram) => Object.fromEntries(d.states.map((s) => [s.name, s.outputs]));

/** A two-state machine: S0 runs `body`, S1 goes back to S0; `outs` are the defaults. */
const fsm = (ports: string, body: string, outs = "") => importVerilog(`
module m(input clk, input rst_n, ${ports});
  localparam S0 = 1'b0, S1 = 1'b1;
  reg state, next;
  always @(posedge clk or negedge rst_n) if (!rst_n) state <= S0; else state <= next;
  always @(*) begin
    next = state; ${outs}
    case (state)
      S0: ${body}
      S1: next = S0;
    endcase
  end
endmodule`);

test("after if (cnt) on a multi-bit cnt, cnt still has its value: cnt < 5, cnt[3] and y = cnt are not computed with cnt = 1", () => {
  const a = fsm("input [3:0] cnt", "if (cnt && cnt < 4'd5) next = S1;");
  assert.deepEqual(edges(a.diagram).filter((e) => e.startsWith("S0->S1")), ["S0->S1: cnt && cnt < 4'd5"]);

  const b = fsm("input [3:0] cnt, output reg z", "if (cnt) begin z = cnt[3]; next = S1; end", "z = 0;");
  assert.equal(b.machine, "mealy");
  assert.deepEqual(edges(b.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: cnt[3] / z=1", "S0->S1: cnt && !cnt[3] / z=0", "S0->S0: !cnt / z=0"]);

  const c = fsm("input [3:0] cnt, output reg [3:0] y", "if (cnt) begin y = cnt; next = S1; end", "y = 0;");
  assert.deepEqual(edges(c.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: cnt / y=cnt", "S0->S0: !cnt / y=0"]);
});

test("an unsized literal is 32 bits wide, not the width of the other operand", () => {
  // 300 is not 44 for an 8-bit cnt, so every cnt above 100 moves.
  const a = fsm("input [7:0] cnt", "if (cnt > 8'd100 && cnt < 300) next = S1;");
  assert.deepEqual(edges(a.diagram).filter((e) => e.startsWith("S0->")), ["S0->S0: cnt <= 8'd100", "S0->S1: cnt > 8'd100"]);
  // cnt + 1 is 256 for cnt = 255, so z is never set.
  const b = fsm("input [7:0] cnt, output reg z", "if (cnt == 8'd255) begin if (cnt + 1 == 0) z = 1; end", "z = 0;");
  assert.deepEqual(stateOutputs(b.diagram), { S0: { z: 0 }, S1: { z: 0 } });
});

test("+ << and ~ work at the width of the comparison or assignment they are in", () => {
  // go + go is 2 in a 2-bit compare, not a lost carry.
  const a = fsm("input go", "if (go && go + go == 2'd2) next = S1;");
  assert.deepEqual(edges(a.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: go", "S0->S0: !go"]);
  const b = fsm("input go, output reg [1:0] y", "if (go) begin y = go + 1'b1; next = S1; end", "y = 0;");
  assert.deepEqual(edges(b.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: go / y=2", "S0->S0: !go / y=0"]);
  const c = fsm("input go, output reg [3:0] y", "if (go) begin y = go << 2; next = S1; end", "y = 0;");
  assert.deepEqual(edges(c.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: go / y=4", "S0->S0: !go / y=0"]);
  // A 2-bit ~go is 2'b11 or 2'b10, never !go.
  const d = fsm("input go, output reg [1:0] y", "begin y = ~go; next = S1; end", "y = 0;");
  assert.ok([...d.diagram.states, ...d.diagram.transitions].some((x) => x.outputs.y === "~go"));
  assert.deepEqual(simulate(d.diagram, [{ go: 0n }, { go: 0n }, { go: 1n }]).map((c) => c.out.y), [3n, 0n, 2n]);
  const e = fsm("input go", "if (~go == 2'b10) next = S1;");
  assert.deepEqual(edges(e.diagram).filter((x) => x.startsWith("S0->")), ["S0->S1: ~go == 2'b10", "S0->S0: ~go != 2'b10"]);
  assert.deepEqual(simulate(e.diagram, [{ go: 1n }, { go: 0n }, { go: 0n }]).map((c) => c.state), ["S0", "S1", "S0"]);
  // In a condition ~go is 1 bit wide, and still reads as !go.
  const f = fsm("input go", "if (~go) next = S1;");
  assert.deepEqual(edges(f.diagram).filter((x) => x.startsWith("S0->")), ["S0->S0: go", "S0->S1: !go"]);
});

test("x | C and x ^ C keep the upper bits of C for a 1-bit x", () => {
  const a = fsm("input go", "if ((go | 2'b10) == 2'b11) next = S1;");
  assert.deepEqual(edges(a.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: (go | 2'b10) == 2'b11", "S0->S0: (go | 2'b10) != 2'b11"]);
  assert.deepEqual(simulate(a.diagram, [{ go: 0n }, { go: 1n }, { go: 0n }]).map((c) => c.state), ["S0", "S0", "S1"]);
  const b = fsm("input go", "if ((go ^ 2'd3) != 2'd3) next = S1;");
  assert.deepEqual(simulate(b.diagram, [{ go: 0n }, { go: 1n }, { go: 0n }]).map((c) => c.state), ["S0", "S0", "S1"]);
  // A constant 0 or 1 still decides it.
  const c = fsm("input go", "if ((go & 2'b11) && (go | 1'b0)) next = S1;");
  assert.deepEqual(edges(c.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: go", "S0->S0: !go"]);
});

test("a 1-bit output assigned a wider value keeps its bit 0", () => {
  const a = fsm("input [3:0] data, output reg z", "begin z = data; next = S1; end", "z = 0;");
  assert.deepEqual(edges(a.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: data[0] / z=1", "S0->S1: !data[0] / z=0"]);
  const b = fsm("input [7:0] op, output reg z", "begin z = ~op; next = S1; end", "z = 0;");
  assert.deepEqual(edges(b.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: op[0] / z=0", "S0->S1: !op[0] / z=1"]);
  const c = fsm("input [4:0] en, output reg z", "begin z = en[4:2]; next = S1; end", "z = 0;");
  assert.deepEqual(edges(c.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: en[2] / z=1", "S0->S1: !en[2] / z=0"]);
  const d = fsm("input [3:0] a, output reg z", "begin z = a >> 1; next = S1; end", "z = 0;");
  assert.deepEqual(edges(d.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: a[1] / z=1", "S0->S1: !a[1] / z=0"]);
});

test("an output that copies an input is Mealy also in a state with a single path", () => {
  const r = fsm("input [3:0] data, output reg [3:0] q", "begin q = data; next = S1; end", "q = 0;");
  assert.equal(r.machine, "mealy");
  assert.deepEqual(r.mealyOutputs, ["q"]);
  assert.deepEqual(edges(r.diagram), ["S0->S1:  / q=data", "S1->S0:  / q=0"]);
});

test("the test simulator evaluates inputs at their declared widths", () => {
  const w = { valid: 6, x1: 2, data: 4, mode: 2, din: 8, go: 1 };
  assert.equal(evaluate("valid == 1'b0", { valid: 52n }, {}, w), 0n);
  assert.equal(evaluate("&x1", { x1: 3n }, {}, w), 1n);
  assert.equal(evaluate("&x1", { x1: 1n }, {}, w), 0n);
  assert.equal(evaluate("data[1:0] == mode", { data: 2n, mode: 2n }, {}, w), 1n);
  assert.equal(evaluate("din - 2'b11 < 8'h87", { din: 0n }, {}, w), 0n);
  assert.equal(evaluate("~go", { go: 1n }, {}, w), 0n);
  // An output value at the width it is assigned to.
  assert.equal(evaluate("~go", { go: 1n }, {}, w, 2), 2n);
});
