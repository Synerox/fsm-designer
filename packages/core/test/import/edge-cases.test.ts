// Verilog import: coding styles and corner cases found in an audit of the
// importer (dead branches, signed compares, reset look-alikes, detection of
// less common FSM styles, long case statements, deep nesting).
import { test } from "node:test";
import assert from "node:assert/strict";
import { importVerilog } from "../../src/import/index.ts";
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
  const arms = Array.from({ length: 400 }, (_, i) => `    ${i ? "else " : ""}if (x == ${i}) n = ${i % 2 ? "S1" : "S0"};`).join("\n");
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
  // Re-checking every earlier x != k on each new branch made this cubic (about 6 s for 400 arms).
  assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
});
