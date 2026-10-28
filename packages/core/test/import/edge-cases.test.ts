// Verilog import: coding styles and corner cases found in an audit of the
// importer (dead branches, signed compares, reset look-alikes, detection of
// less common FSM styles, long case statements, deep nesting).
import { test } from "node:test";
import assert from "node:assert/strict";
import { importVerilog, listStateMachines, parseExpression } from "../../src/import/index.ts";
import { simplify } from "../../src/import/expr.ts";
import type { FsmDiagram } from "../../src/model.ts";

const edges = (d: FsmDiagram) => {
  const n = (id: string) => d.states.find((s) => s.id === id)!.name;
  return d.transitions.map((t) => `${n(t.from)}->${n(t.to)}: ${t.condition}${Object.keys(t.outputs).length ? ` / ${Object.entries(t.outputs).map(([k, v]) => `${k}=${v}`).join(",")}` : ""}`);
};
const stateOutputs = (d: FsmDiagram) => Object.fromEntries(d.states.map((s) => [s.name, s.outputs]));

test("a branch the code can never take is left out, not drawn as an unconditional transition", () => {
  const r = importVerilog(`
module m(input clk, input rst_n, input [3:0] cnt, output reg y);
  localparam S0 = 2'd0, S1 = 2'd1, S2 = 2'd2;
  reg [1:0] s, n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= S0; else s <= n;
  always @* begin
    n = s; y = 0;
    case (s)
      S0: if (cnt > 4'd15) n = S2; else if (cnt > 4'd3) n = S1;
      S1: begin y = 1; n = S0; end
      S2: n = S0;
    endcase
  end
endmodule`);
  assert.deepEqual(edges(r.diagram).filter((e) => e.startsWith("S0->")), ["S0->S1: cnt > 4'd3", "S0->S0: cnt <= 4'd3"]);
});

test("a case with many labels on one input lists each label once, not every earlier one again", () => {
  const labels = Array.from({ length: 11 }, (_, i) => `      8'd${i}: nx = ${["EXEC", "MEM", "HALT", "FETCH"][i % 4]};`).join("\n");
  const r = importVerilog(`
module dec(input clk, input rst, input [7:0] op, output reg [1:0] cls);
  localparam FETCH = 2'd0, EXEC = 2'd1, MEM = 2'd2, HALT = 2'd3;
  reg [1:0] s, nx;
  always @(posedge clk) if (rst) s <= FETCH; else s <= nx;
  always @* begin nx = s; cls = 0; case (s)
    FETCH: case (op)
${labels}
      default: nx = FETCH;
    endcase
    EXEC: begin cls = 1; nx = FETCH; end
    MEM: begin cls = 2; nx = FETCH; end
    HALT: cls = 3;
  endcase end
endmodule`);
  const e = edges(r.diagram);
  assert.ok(e.includes("FETCH->EXEC: op == 8'd0 || op == 8'd4 || op == 8'd8"), e.join("\n"));
  assert.ok(e.includes("FETCH->HALT: op == 8'd2 || op == 8'd6 || op == 8'd10"), e.join("\n"));
});

test("a long else-if chain on one input imports in reasonable time", () => {
  const arms = Array.from({ length: 600 }, (_, i) => `    ${i ? "else " : ""}if (x == ${i}) n = ${i % 2 ? "S1" : "S0"};`).join("\n");
  const src = `
module m(input clk, input rst_n, input [11:0] x, output reg y);
  localparam S0 = 0, S1 = 1;
  reg s, n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= S0; else s <= n;
  always @* begin n = s; y = s; case (s) S0: begin
${arms}
  end
  S1: n = S0;
  endcase end
endmodule`;
  const t0 = performance.now();
  const r = importVerilog(src);
  const ms = performance.now() - t0;
  assert.deepEqual(r.diagram.states.map((s) => s.name), ["S0", "S1"]);
  // Re-checking every earlier x != k on each new branch made this cubic (over 10 s for 600 arms).
  assert.ok(ms < 5000, `took ${ms.toFixed(0)} ms`);
});

test("signed inputs, signed literals and $signed() compare as two's complement", () => {
  const thermo = (decl: string, below: string) => `
module thermo(input clk, input rst_n, ${decl} temp, output reg heat, output reg cool);
  localparam OK = 2'd0, COLD = 2'd1, HOT = 2'd2;
  reg [1:0] s, n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= OK; else s <= n;
  always @* begin
    n = s; heat = 0; cool = 0;
    case (s)
      OK:   if (${below}) n = COLD; else if (temp > 8'sd30) n = HOT;
      COLD: begin heat = 1; if (!(${below})) n = OK; end
      HOT:  begin cool = 1; if (temp <= 8'sd30) n = OK; end
      default: n = OK;
    endcase
  end
endmodule`;
  const r = importVerilog(thermo("input signed [7:0]", "temp < 0"));
  assert.deepEqual(edges(r.diagram), [
    "OK->COLD: temp < 0",
    "OK->HOT: temp > 8'sd30",
    "OK->OK: temp >= 0 && temp <= 8'sd30",
    "COLD->OK: temp >= 0",
    "COLD->COLD: temp < 0",
    "HOT->OK: temp <= 8'sd30",
    "HOT->HOT: temp > 8'sd30",
  ]);
  // On an unsigned input only $signed() makes "below zero" possible, and the condition keeps it.
  const f = importVerilog(thermo("input [7:0]", "$signed(temp) < 0"));
  assert.ok(edges(f.diagram).includes("OK->COLD: $signed(temp) < 0"), edges(f.diagram).join("\n"));
  // Unsigned, temp < 0 can never hold: no transition to COLD at all.
  const u = importVerilog(thermo("input [7:0]", "temp < 0"));
  assert.ok(!edges(u.diagram).some((e) => e.startsWith("OK->COLD")), edges(u.diagram).join("\n"));
  // Constant folding follows the same rule: two's complement only when both sides are signed.
  const fold = (e: string) => { const r = simplify(parseExpression(e), { lookup: () => undefined, width: () => undefined }); return r.k === "num" ? r.v : undefined; };
  assert.equal(fold("-1 < 0"), 1n);
  assert.equal(fold("4'sb1000 < 4'sd0"), 1n);
  assert.equal(fold("4'sb1111 == -1"), 1n);
  assert.equal(fold("4'b1000 < 4'sd0"), 0n);
  assert.equal(fold("$signed(4'b1000) < 0"), 1n);
});

test("an enable in the first if is not taken for a synchronous reset", () => {
  const r = importVerilog(`
module m7(input clk, input en, input a, output reg y);
  localparam S0 = 0, S1 = 1; reg s = S0, n;
  always @(posedge clk) if (en) s <= n; else s <= s;
  always @* begin n = s; case (s) S0: if (a) n = S1; S1: if (!a) n = S0; endcase end
  always @* y = (s == S1);
endmodule`);
  assert.notEqual(r.diagram.reset.name, "en");
  assert.deepEqual(r.diagram.inputs.map((s) => s.name), ["en", "a"]);
  assert.ok(edges(r.diagram).includes("S0->S1: a && en"), edges(r.diagram).join("\n"));
  // A constant preset without a reset-like name still is one.
  const g = importVerilog(`
module g(input clk, input go, input a, output y);
  localparam S0 = 0, S1 = 1; reg s, n;
  always @(posedge clk) if (go) s <= S1; else s <= n;
  always @* begin n = s; case (s) S0: if (a) n = S1; S1: n = S0; endcase end
  assign y = s;
endmodule`);
  assert.deepEqual(g.diagram.reset, { name: "go", activeLow: false, async: false });
});

test("the reset is found past statements before it in the clocked block", () => {
  const r = importVerilog(`
module m3(input clk, input rst, input a, output reg y);
  localparam S0 = 0, S1 = 1; reg s; reg [3:0] cnt;
  always @(posedge clk) begin
    cnt <= cnt + 1;
    if (rst) s <= S0; else case (s) S0: if (a) s <= S1; S1: if (!a) s <= S0; endcase
  end
  always @* y = (s == S1);
endmodule`);
  assert.deepEqual(r.diagram.reset, { name: "rst", activeLow: false, async: false });
  assert.deepEqual(r.diagram.inputs.map((s) => s.name), ["a"]);
  assert.deepEqual(r.warnings, []);
});

test("a registered output that copies an input goes on the transitions, not into the state", () => {
  const r = importVerilog(`
module m(input clk, input rst_n, input a, input b, output reg y);
  localparam S0 = 0, S1 = 1;
  reg s;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) begin s <= S0; y <= 0; end
    else case (s)
      S0: if (a) begin s <= S1; y <= b; end else y <= 0;
      S1: begin s <= S0; y <= 0; end
    endcase
endmodule`);
  assert.equal(r.machine, "mealy");
  assert.deepEqual(stateOutputs(r.diagram).S1, {});
  assert.ok(edges(r.diagram).includes("S0->S1: a && b / y=1"), edges(r.diagram).join("\n"));
  assert.ok(r.warnings.some((w) => /Registered output "y"/.test(w)));
  const w = importVerilog(`
module m(input clk, input rst_n, input a, input [3:0] din, output reg [3:0] dout);
  localparam S0 = 0, S1 = 1;
  reg s;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) begin s <= S0; dout <= 0; end
    else case (s)
      S0: if (a) begin s <= S1; dout <= din; end
      S1: s <= S0;
    endcase
endmodule`);
  assert.deepEqual(w.mealyOutputs, ["dout"]);
  assert.ok(edges(w.diagram).includes("S0->S1: a / dout=din"), edges(w.diagram).join("\n"));
});

test("a stored compound value (a state-dependent wire, a blocking temp) folds once its inputs are decided", () => {
  const r = importVerilog(`
module m(input clk, input rst, input a, input b, input c, output reg y);
  localparam IDLE = 2'd0, RUN = 2'd1, DONE = 2'd2;
  reg [1:0] state, next;
  wire fire = (state == RUN) & a & b;
  always @(posedge clk) if (rst) state <= IDLE; else state <= next;
  always @* begin
    next = state; y = 0;
    case (state)
      IDLE: if (c) next = RUN;
      RUN: if (fire) next = DONE; else if (!c) next = IDLE;
      DONE: begin y = 1; next = IDLE; end
    endcase
  end
endmodule`, { maxPaths: 64 });
  assert.deepEqual(r.warnings, []);
  assert.ok(edges(r.diagram).includes("RUN->DONE: a && b"), edges(r.diagram).join("\n"));
  const t = importVerilog(`
module m(input clk, input rst, input a, input b, output reg y);
  localparam S0 = 1'b0, S1 = 1'b1;
  reg s; reg t;
  always @(posedge clk) begin
    if (rst) s <= S0;
    else begin
      t = a & b;
      case (s)
        S0: if (t) s <= S1;
        S1: if (!a) s <= S0;
      endcase
    end
  end
  always @* y = s;
endmodule`, { maxPaths: 64 });
  assert.deepEqual(t.warnings, []);
  assert.ok(edges(t.diagram).includes("S0->S1: a && b"), edges(t.diagram).join("\n"));
});

test("a next state written only with ?: is detected", () => {
  const src = `
module m(input clk, input rst_n, input a, input b, output reg y);
  localparam S0 = 2'd0, S1 = 2'd1, S2 = 2'd2, S3 = 2'd3;
  reg [1:0] s, n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= S0; else s <= n;
  always @* begin
    n = (s == S0) ? (a ? S1 : S0) :
        (s == S1) ? (b ? S2 : a ? S3 : S1) :
        (s == S2) ? S3 : S0;
    y = (s == S3) ? 1'b1 : 1'b0;
  end
endmodule`;
  assert.deepEqual(listStateMachines(src), [{ module: "m", stateVar: "s" }]);
  const r = importVerilog(src);
  assert.ok(edges(r.diagram).includes("S1->S3: !b && a"), edges(r.diagram).join("\n"));
  // A register written as one ?: and a wire next state behind a ?: reset.
  const one = importVerilog(`
module m(input clk, input rst_n, input a, output reg y);
  localparam S0 = 0, S1 = 1;
  reg s;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= S0; else s <= a ? S1 : S0;
  always @* y = (s == S1);
endmodule`);
  assert.deepEqual(edges(one.diagram), ["S0->S1: a", "S0->S0: !a", "S1->S1: a", "S1->S0: !a"]);
  const w = importVerilog(`
module a07 (input clk, input rst, input x, input y, output wire o);
  localparam S0=2'd0, S1=2'd1, S2=2'd2;
  reg [1:0] st;
  wire [1:0] nx = (st == S0) ? (x ? S1 : S0) : (st == S1) ? (y ? S2 : (x ? S1 : S0)) : S0;
  always @(posedge clk) st <= rst ? S0 : nx;
  assign o = (st == S2) ? 1'b1 : 1'b0;
endmodule`);
  assert.equal(w.nextVar, "nx");
  assert.deepEqual(w.diagram.reset, { name: "rst", activeLow: false, async: false });
  assert.ok(edges(w.diagram).includes("S1->S2: y"), edges(w.diagram).join("\n"));
});

test("a case on a concatenation of the state and inputs is detected", () => {
  const src = `
module a05 (input clk, input rst, input [1:0] in, output reg o);
  reg [1:0] st, nx;
  always @(posedge clk) if (rst) st <= 2'b00; else st <= nx;
  always @* begin
    nx = st; o = 0;
    casex ({st, in})
      4'b00_1x: nx = 2'b01;
      4'b00_0x: nx = 2'b00;
      4'b01_x1: begin nx = 2'b10; o = 1; end
      4'b01_x0: nx = 2'b01;
      4'b10_xx: nx = 2'b00;
      default: nx = 2'b00;
    endcase
  end
endmodule`;
  assert.deepEqual(listStateMachines(src), [{ module: "a05", stateVar: "st" }]);
  assert.ok(edges(importVerilog(src).diagram).includes("S1->S2: in[0] / o=1"));
  const named = importVerilog(`
module m(input clk, input rst_n, input a, output reg y);
  localparam S0 = 1'b0, S1 = 1'b1;
  reg s, n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= S0; else s <= n;
  always @* begin
    n = s; y = 0;
    case ({s, a})
      {S0, 1'b1}: n = S1;
      {S1, 1'b0}: begin n = S0; y = 1; end
      default: n = s;
    endcase
  end
endmodule`);
  assert.deepEqual(named.diagram.states.map((s) => s.name), ["S0", "S1"]);
  assert.ok(edges(named.diagram).includes("S1->S0: !a / y=1"), edges(named.diagram).join("\n"));
});

test("one-hot with plain bit indices, and a one-hot write whose index is a ?:", () => {
  const src = `
module oh2(input clk, input rst, input go, output reg busy);
  reg [2:0] st, nx;
  always @(posedge clk) if (rst) st <= 3'b001; else st <= nx;
  always @* begin
    nx = 3'b000; busy = 0;
    case (1'b1)
      st[0]: if (go) nx[1] = 1'b1; else nx[0] = 1'b1;
      st[1]: begin busy = 1; nx[2] = 1'b1; end
      st[2]: nx[0] = 1'b1;
    endcase
  end
endmodule`;
  assert.deepEqual(listStateMachines(src), [{ module: "oh2", stateVar: "st" }]);
  const r = importVerilog(src);
  assert.deepEqual(r.stateCodes, { S_001: "3'b001", S_010: "3'b010", S_100: "3'b100" });
  assert.deepEqual(edges(r.diagram), ["S_001->S_010: go", "S_001->S_001: !go", "S_010->S_100: ", "S_100->S_001: "]);
  const t = importVerilog(`
module m(input clk, input rst_n, input go, input stop, output reg run);
  parameter IDLE = 0, GO = 1, RUN = 2;
  reg [2:0] st;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) st <= 3'b001;
    else begin
      st <= 3'b000;
      case (1'b1)
        st[IDLE]: st[go ? GO : IDLE] <= 1'b1;
        st[GO]:   st[RUN] <= 1'b1;
        st[RUN]:  st[stop ? IDLE : RUN] <= 1'b1;
        default:  st[IDLE] <= 1'b1;
      endcase
    end
  always @* run = st[RUN];
endmodule`);
  assert.deepEqual(t.warnings, []);
  assert.deepEqual(edges(t.diagram), ["IDLE->GO: go", "IDLE->IDLE: !go", "GO->RUN: ", "RUN->IDLE: stop", "RUN->RUN: !stop"]);
  assert.deepEqual(stateOutputs(t.diagram).RUN, { run: 1 });
});
