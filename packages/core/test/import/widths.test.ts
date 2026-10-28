// Verilog import: expression widths and truth values, as Verilog evaluates
// them (found by differential fuzzing against a Verilog-accurate simulator).
// A multi-bit value tested as a condition is not 1, an unsized literal is 32
// bits, + - ~ << work at the width of their context, an assignment keeps the
// low bits, and an output that copies an input is Mealy. Also: minimising the
// conditions of a case on many opcodes stays fast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importVerilog } from "../../src/import/index.ts";
import { minimize } from "../../src/import/boolmin.ts";
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

test("a signed operand of ~ or - is sign-extended to the width it is evaluated at, unless the rest is unsigned", () => {
  // ~4'sb1110 and -4'sd15 are 1 in an 8-bit y (sign-extended first), not 241.
  const a = fsm("input go, output reg [7:0] y", "begin y = ~4'sb1110; next = S1; end", "y = 0;");
  assert.deepEqual(stateOutputs(a.diagram), { S0: { y: 1 }, S1: { y: 0 } });
  const b = fsm("input go, output reg [7:0] y", "begin y = -(4'sd15); next = S1; end", "y = 0;");
  assert.deepEqual(stateOutputs(b.diagram), { S0: { y: 1 }, S1: { y: 0 } });
  // The same for a signed input known from the branch it is in.
  const c = fsm("input signed [3:0] s, output reg [7:0] y", "if (s == -4'sd1) begin y = -s; next = S1; end", "y = 0;");
  assert.deepEqual(edges(c.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: s == 4'd15 / y=1", "S0->S0: s != 4'd15 / y=0"]);
  const d = fsm("input signed [3:0] s, output reg [7:0] y", "if (s == -4'sd2) begin y = ~s; next = S1; end", "y = 0;");
  assert.deepEqual(edges(d.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: s == 4'd14 / y=1", "S0->S0: s != 4'd14 / y=0"]);
  // Compared with a signed d, ~s is sign-extended; with an unsigned d it is not.
  const e = fsm("input signed [3:0] s, input signed [7:0] d", "if (s == -4'sd2) begin if (d == ~s) next = S1; end");
  assert.deepEqual(edges(e.diagram).filter((x) => x.startsWith("S0->S1")), ["S0->S1: s == 4'd14 && d == 8'd1"]);
  const f = fsm("input signed [3:0] s, input [7:0] d", "if (s == -4'sd2) begin if (d == ~s) next = S1; end");
  assert.deepEqual(edges(f.diagram).filter((x) => x.startsWith("S0->S1")), ["S0->S1: s == 4'd14 && d == 8'd241"]);
});

test("after if (a & b) on multi-bit a and b, (a & b) == 0 is false", () => {
  // A truth assumption about a multi-bit value is the constraint value != 0:
  // the branch where it is 0 can never be taken, so z = 1 is never reached.
  for (const cmp of ["(a & b) == 4'd0", "!((a & b) != 0)", "(a & b) <= 0", "0 >= (a & b)"]) {
    const r = fsm("input [3:0] a, input [3:0] b, output reg z", `if (a & b) begin if (${cmp}) z = 1; else next = S1; end`, "z = 0;");
    assert.deepEqual(edges(r.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: a & b", "S0->S0: !(a & b)"], cmp);
    assert.deepEqual(stateOutputs(r.diagram), { S0: { z: 0 }, S1: { z: 0 } }, cmp);
  }
  // After if (!(a ^ b)) it is 0.
  const x = fsm("input [3:0] a, input [3:0] b", "if (!(a ^ b)) begin if ((a ^ b) == 0) next = S1; end");
  assert.deepEqual(edges(x.diagram).filter((e) => e.startsWith("S0->")), ["S0->S0: a ^ b", "S0->S1: !(a ^ b)"]);
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

test("a case on many opcodes of a wide input imports quickly", () => {
  const arms = (o: number) => Array.from({ length: 10 }, (_, i) => `        12'd${i * 7 + o}: begin n = S${(i + o) % 3}; y = ${i % 4}; end`).join("\n");
  const src = `
module m(input clk, input rst_n, input [11:0] op, output reg [1:0] y);
  localparam S0 = 2'd0, S1 = 2'd1, S2 = 2'd2;
  reg [1:0] s, n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= S0; else s <= n;
  always @* begin
    n = s; y = 0;
    case (s)
      S0: case (op)
${arms(1)}
      endcase
      S1: case (op)
${arms(2)}
      endcase
      default: n = S0;
    endcase
  end
endmodule`;
  const t0 = performance.now();
  const r = importVerilog(src);
  const ms = performance.now() - t0;
  assert.equal(r.diagram.transitions.length, 21);
  assert.ok(r.diagram.transitions.some((t) => t.condition === "op == 12'd1" && t.outputs.y === 0));
  // Minimising each condition over the 2^10 combinations of the ten compares took over 5 s.
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});

test("minimize with nearly every minterm don't-care gives a correct cover quickly", () => {
  const n = 10;
  const possible = [0, ...Array.from({ length: n }, (_, i) => 1 << i)];
  const dc = Array.from({ length: 1 << n }, (_, m) => m).filter((m) => !possible.includes(m));
  const t0 = performance.now();
  for (const m of possible) {
    const cubes = minimize(n, [m], dc);
    for (const p of possible) assert.equal(cubes.some((c) => (p & c.care) === c.val), p === m);
  }
  assert.ok(performance.now() - t0 < 1000, `took ${(performance.now() - t0).toFixed(0)} ms`);
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
