// Verilog import: parser corner cases that used to lose states or whole
// always blocks without saying so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importVerilog } from "../../src/import/index.ts";
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
