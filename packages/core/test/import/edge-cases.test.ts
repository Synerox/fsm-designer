// Verilog import: coding styles and corner cases found in an audit of the
// importer (dead branches, signed compares, reset look-alikes, detection of
// less common FSM styles, long case statements, deep nesting).
import { test } from "node:test";
import assert from "node:assert/strict";
import { importVerilog, parseExpression } from "../../src/import/index.ts";
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
