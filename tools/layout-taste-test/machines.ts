// The machines shown in the taste test: the Verilog import fixtures plus a
// few small hand-made shapes and the examples users sent in.

import { readFileSync } from "node:fs";
import { addState, addTransition, createDiagram, fitStateSizes, importVerilog } from "../../packages/core/src/index.ts";
import type { FsmDiagram } from "../../packages/core/src/index.ts";

const FIXTURES = new URL("../../packages/core/test/import/fixtures/", import.meta.url);

function machine(names: string[], edges: Array<[string, string]>): FsmDiagram {
  const d = createDiagram({ name: "m" });
  for (const name of names) addState(d, { name, isInitial: name === names[0] });
  const id = (n: string) => d.states.find((s) => s.name === n)!.id;
  for (const [a, b] of edges) addTransition(d, { from: id(a), to: id(b), condition: "" });
  fitStateSizes(d);
  return d;
}

const S = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);
const E = (es: number[][]) => es.map(([a, b]) => [`S${a}`, `S${b}`] as [string, string]);

export function machines(): Array<[string, FsmDiagram]> {
  const files = ["seq_1011_two_block.v", "traffic_three_block.v", "pattern_one_block.v", "handshake_enum.sv", "onehot_index.v", "arbiter_casez.v", "vending_if_else.v", "uart_big.v", "cle_locked.v", "chain_32.v"];
  return [
    ...files.map((f) => [f.replace(/\.s?v$/, ""), importVerilog(readFileSync(new URL(f, FIXTURES), "utf8")).diagram] as [string, FsmDiagram]),
    ["sort", machine(["READ", "OUTPUT_CNT", "SORT_EVEN", "SORT_ODD", "MERGE", "FINISH"], [["READ", "READ"], ["READ", "OUTPUT_CNT"], ["OUTPUT_CNT", "SORT_EVEN"], ["SORT_EVEN", "SORT_ODD"], ["SORT_ODD", "SORT_EVEN"], ["SORT_ODD", "MERGE"], ["MERGE", "SORT_EVEN"], ["MERGE", "FINISH"], ["FINISH", "READ"]])],
    ["calc", machine(["IDLE", "DECIDE", "REQ", "RECEIVE", "CALC", "RESULT", "WRITE", "FINISH"], [["IDLE", "DECIDE"], ["DECIDE", "REQ"], ["REQ", "RECEIVE"], ["RECEIVE", "REQ"], ["RECEIVE", "WRITE"], ["RECEIVE", "RESULT"], ["RECEIVE", "CALC"], ["CALC", "CALC"], ["CALC", "RESULT"], ["CALC", "REQ"], ["RESULT", "RESULT"], ["RESULT", "WRITE"], ["WRITE", "DECIDE"], ["WRITE", "FINISH"], ["FINISH", "IDLE"]])],
    ["tri2", machine(S(4), E([[0, 1], [1, 2], [2, 0], [1, 3], [3, 2]]))],
    ["domino", machine(S(6), E([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 4]]))],
    ["hub", machine(S(5), E([[0, 1], [1, 0], [0, 2], [2, 0], [0, 3], [3, 0], [0, 4], [4, 0]]))],
    ["branch", machine(S(7), E([[0, 1], [0, 2], [0, 3], [1, 4], [2, 4], [3, 5], [4, 6], [5, 6], [6, 0]]))],
    ["ring8", machine(S(8), E([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 0]]))],
    ["chain9", machine(S(9), E([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8]]))],
  ];
}
