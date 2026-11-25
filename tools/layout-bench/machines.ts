// The machines the layout benchmark draws: the Verilog import fixtures,
// control machines of the kinds people really write (a CPU's control unit,
// UART, I2C and SPI controllers, "abort back to IDLE from anywhere", an error
// state every step can fall into, a dispatcher with one chain per command),
// plain shapes (rings, chains, stars, meshes, trees, K5, K3,3, Petersen),
// the e2e check's generated machines and random connected graphs.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addState, addTransition, createDiagram, fitStateSizes, importVerilog } from "../../packages/core/src/index.ts";
import type { FsmDiagram } from "../../packages/core/src/index.ts";

const FIXTURES = fileURLToPath(new URL("../../packages/core/test/import/fixtures/", import.meta.url));

export interface Machine { name: string; group: "verilog" | "hand" | "real" | "shape" | "gen" | "rand"; d: FsmDiagram }

export function machines(): Machine[] {
  const out: Machine[] = [];
  const named = (names: string[], edges: Array<[string, string, string?]>): FsmDiagram => {
    const d = createDiagram({ name: "m" });
    for (const name of names) addState(d, { name, isInitial: name === names[0] });
    for (const [a, b, c] of edges) addTransition(d, { from: a, to: b, condition: c ?? "" });
    fitStateSizes(d);
    return d;
  };
  const idx = (n: number, edges: Array<[number, number]>): FsmDiagram => {
    const d = createDiagram({ name: "m" });
    for (let i = 0; i < n; i++) addState(d, { name: `S${i}`, isInitial: i === 0 });
    for (const [a, b] of edges) addTransition(d, { from: `S${a}`, to: `S${b}`, condition: `x${a}${b}` });
    return d;
  };
  const add = (group: Machine["group"], name: string, d: FsmDiagram) => out.push({ name, group, d });

  // --- Verilog fixtures (real imported machines, long labels) ---
  for (const f of readdirSync(FIXTURES).sort()) {
    if (!/\.s?v$/.test(f)) continue;
    try {
      add("verilog", f.replace(/\.s?v$/, ""), importVerilog(readFileSync(`${FIXTURES}/${f}`, "utf8")).diagram);
    } catch { /* a fixture that is not one importable machine */ }
  }

  // --- taste-test machines ---
  add("hand", "sort", named(["READ", "OUTPUT_CNT", "SORT_EVEN", "SORT_ODD", "MERGE", "FINISH"], [["READ", "READ"], ["READ", "OUTPUT_CNT"], ["OUTPUT_CNT", "SORT_EVEN"], ["SORT_EVEN", "SORT_ODD"], ["SORT_ODD", "SORT_EVEN"], ["SORT_ODD", "MERGE"], ["MERGE", "SORT_EVEN"], ["MERGE", "FINISH"], ["FINISH", "READ"]]));
  add("hand", "calc", named(["IDLE", "DECIDE", "REQ", "RECEIVE", "CALC", "RESULT", "WRITE", "FINISH"], [["IDLE", "DECIDE"], ["DECIDE", "REQ"], ["REQ", "RECEIVE"], ["RECEIVE", "REQ"], ["RECEIVE", "WRITE"], ["RECEIVE", "RESULT"], ["RECEIVE", "CALC"], ["CALC", "CALC"], ["CALC", "RESULT"], ["CALC", "REQ"], ["RESULT", "RESULT"], ["RESULT", "WRITE"], ["WRITE", "DECIDE"], ["WRITE", "FINISH"], ["FINISH", "IDLE"]]));

  // --- realistic control FSMs ---
  // Multi-cycle CPU control: fetch, decode, then one chain per instruction class, back to fetch.
  add("real", "cpu_multicycle", named(
    ["FETCH", "DECODE", "MEM_ADR", "MEM_RD", "MEM_WB", "MEM_WR", "EXEC", "ALU_WB", "BRANCH", "JUMP", "ADDI_EX", "ADDI_WB"],
    [["FETCH", "DECODE"], ["DECODE", "MEM_ADR", "op==LW||op==SW"], ["DECODE", "EXEC", "op==RTYPE"], ["DECODE", "BRANCH", "op==BEQ"], ["DECODE", "JUMP", "op==J"], ["DECODE", "ADDI_EX", "op==ADDI"],
      ["MEM_ADR", "MEM_RD", "op==LW"], ["MEM_ADR", "MEM_WR", "op==SW"], ["MEM_RD", "MEM_WB"], ["MEM_WB", "FETCH"], ["MEM_WR", "FETCH"], ["EXEC", "ALU_WB"], ["ALU_WB", "FETCH"], ["BRANCH", "FETCH"], ["JUMP", "FETCH"], ["ADDI_EX", "ADDI_WB"], ["ADDI_WB", "FETCH"]]));
  // UART receiver with error handling.
  add("real", "uart_rx", named(
    ["IDLE", "START", "DATA", "PARITY", "STOP", "DONE", "FRAME_ERR", "PAR_ERR"],
    [["IDLE", "START", "!rx"], ["IDLE", "IDLE", "rx"], ["START", "DATA", "tick&&!rx"], ["START", "IDLE", "tick&&rx"], ["DATA", "DATA", "bit_cnt<7"], ["DATA", "PARITY", "bit_cnt==7&&par_en"], ["DATA", "STOP", "bit_cnt==7&&!par_en"],
      ["PARITY", "STOP", "par_ok"], ["PARITY", "PAR_ERR", "!par_ok"], ["STOP", "DONE", "rx"], ["STOP", "FRAME_ERR", "!rx"], ["DONE", "IDLE"], ["FRAME_ERR", "IDLE", "clr"], ["PAR_ERR", "IDLE", "clr"]]));
  // I2C master.
  add("real", "i2c_master", named(
    ["IDLE", "START", "ADDR", "ADDR_ACK", "WR_DATA", "WR_ACK", "RD_DATA", "RD_ACK", "RESTART", "STOP", "NACK_ERR"],
    [["IDLE", "START", "go"], ["START", "ADDR"], ["ADDR", "ADDR", "cnt!=0"], ["ADDR", "ADDR_ACK", "cnt==0"], ["ADDR_ACK", "WR_DATA", "ack&&!rw"], ["ADDR_ACK", "RD_DATA", "ack&&rw"], ["ADDR_ACK", "NACK_ERR", "!ack"],
      ["WR_DATA", "WR_DATA", "cnt!=0"], ["WR_DATA", "WR_ACK", "cnt==0"], ["WR_ACK", "WR_DATA", "ack&&more"], ["WR_ACK", "RESTART", "ack&&rs"], ["WR_ACK", "STOP", "ack&&!more&&!rs"], ["WR_ACK", "NACK_ERR", "!ack"],
      ["RD_DATA", "RD_DATA", "cnt!=0"], ["RD_DATA", "RD_ACK", "cnt==0"], ["RD_ACK", "RD_DATA", "more"], ["RD_ACK", "STOP", "!more"], ["RESTART", "ADDR"], ["STOP", "IDLE"], ["NACK_ERR", "STOP"]]));
  // SPI flash controller: command dispatch with several chains.
  add("real", "spi_flash", named(
    ["IDLE", "CMD", "ADDR", "DUMMY", "READ", "WREN", "PROG", "ERASE", "WAIT_BUSY", "POLL", "DONE", "ERR"],
    [["IDLE", "CMD", "start"], ["CMD", "ADDR", "is_rd||is_pp||is_er"], ["CMD", "WREN", "need_wren"], ["WREN", "CMD"], ["ADDR", "DUMMY", "is_fast"], ["ADDR", "READ", "is_rd&&!is_fast"], ["ADDR", "PROG", "is_pp"], ["ADDR", "ERASE", "is_er"], ["DUMMY", "READ"],
      ["READ", "READ", "len!=0"], ["READ", "DONE", "len==0"], ["PROG", "PROG", "len!=0"], ["PROG", "WAIT_BUSY", "len==0"], ["ERASE", "WAIT_BUSY"], ["WAIT_BUSY", "POLL"], ["POLL", "WAIT_BUSY", "busy"], ["POLL", "DONE", "!busy&&!fail"], ["POLL", "ERR", "fail"], ["DONE", "IDLE"], ["ERR", "IDLE", "ack"]]));
  // Cache controller (textbook).
  add("real", "cache_ctrl", named(["IDLE", "COMPARE", "ALLOCATE", "WRITEBACK"],
    [["IDLE", "COMPARE", "valid"], ["COMPARE", "IDLE", "hit"], ["COMPARE", "ALLOCATE", "miss&&!dirty"], ["COMPARE", "WRITEBACK", "miss&&dirty"], ["ALLOCATE", "COMPARE", "mem_ready"], ["ALLOCATE", "ALLOCATE", "!mem_ready"], ["WRITEBACK", "ALLOCATE", "mem_ready"], ["WRITEBACK", "WRITEBACK", "!mem_ready"]]));
  // AXI-lite slave: read and write channels.
  add("real", "axi_lite", named(["IDLE", "WADDR", "WDATA", "WRESP", "RADDR", "RDATA"],
    [["IDLE", "WADDR", "awvalid"], ["IDLE", "RADDR", "arvalid&&!awvalid"], ["WADDR", "WDATA", "wvalid"], ["WADDR", "WADDR", "!wvalid"], ["WDATA", "WRESP"], ["WRESP", "IDLE", "bready"], ["WRESP", "WRESP", "!bready"], ["RADDR", "RDATA"], ["RDATA", "IDLE", "rready"], ["RDATA", "RDATA", "!rready"]]));
  // Elevator: floors up and down, door states.
  add("real", "elevator", named(["F1", "F1_OPEN", "UP12", "F2", "F2_OPEN", "UP23", "F3", "F3_OPEN", "DN32", "DN21"],
    [["F1", "F1_OPEN", "call1"], ["F1_OPEN", "F1", "tmo"], ["F1", "UP12", "call2||call3"], ["UP12", "F2"], ["F2", "F2_OPEN", "call2"], ["F2_OPEN", "F2", "tmo"], ["F2", "UP23", "call3"], ["UP23", "F3"], ["F3", "F3_OPEN", "call3"], ["F3_OPEN", "F3", "tmo"], ["F3", "DN32", "call1||call2"], ["DN32", "F2"], ["F2", "DN21", "call1"], ["DN21", "F1"]]));
  // Every state can abort back to IDLE (very common: "if (abort) state <= IDLE").
  for (const n of [6, 9, 12, 16]) {
    const names = ["IDLE", ...Array.from({ length: n - 1 }, (_, i) => `STEP${i + 1}`)];
    const e: Array<[string, string, string?]> = [];
    for (let i = 0; i < n - 1; i++) e.push([names[i], names[i + 1], "go"]);
    e.push([names[n - 1], names[0], "done"]);
    for (let i = 2; i < n - 1; i++) e.push([names[i], names[0], "abort"]);
    add("real", `abort_chain${n}`, named(names, e));
  }
  // Chain where every state can fall into one error state that returns to idle.
  for (const n of [7, 10, 14]) {
    const names = ["IDLE", ...Array.from({ length: n - 2 }, (_, i) => `P${i + 1}`), "ERROR"];
    const e: Array<[string, string, string?]> = [];
    for (let i = 0; i < n - 2; i++) e.push([names[i], names[i + 1], "ok"]);
    e.push([names[n - 2], names[0], "ok"]);
    for (let i = 1; i < n - 1; i++) e.push([names[i], "ERROR", "err"]);
    e.push(["ERROR", "IDLE", "clr"]);
    add("real", `error_sink${n}`, named(names, e));
  }
  // Dispatcher: idle picks one of k handlers, each a chain of m, back to idle.
  for (const [k, m] of [[3, 2], [4, 3], [6, 2], [5, 4]] as const) {
    const names = ["IDLE"];
    const e: Array<[string, string, string?]> = [];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < m; j++) names.push(`H${i}_${j}`);
      e.push(["IDLE", `H${i}_0`, `cmd==${i}`]);
      for (let j = 0; j + 1 < m; j++) e.push([`H${i}_${j}`, `H${i}_${j + 1}`]);
      e.push([`H${i}_${m - 1}`, "IDLE"]);
    }
    add("real", `dispatch${k}x${m}`, named(names, e));
  }
  // Sequence detectors (KMP-like fallbacks): chain with many back edges.
  for (const [n, pat] of [[6, "101101"], [8, "11010011"], [10, "1101101011"]] as const) {
    const p = pat.slice(0, n);
    const names = Array.from({ length: n + 1 }, (_, i) => `M${i}`);
    const e: Array<[string, string, string?]> = [];
    for (let i = 0; i <= n; i++) for (const bit of ["0", "1"]) {
      // Longest prefix of p that is a suffix of (p[0..i) + bit).
      const s = (i === n ? p.slice(1) : p.slice(0, i)) + bit;
      let k = Math.min(n, s.length);
      while (k > 0 && p.slice(0, k) !== s.slice(s.length - k)) k--;
      e.push([names[i], names[k], bit === "1" ? "x" : "!x"]);
    }
    add("real", `seqdet${n}`, named(names, e));
  }
  // Traffic light with pedestrian request and night mode.
  add("real", "traffic_ped", named(["NS_GREEN", "NS_YELLOW", "ALL_RED1", "EW_GREEN", "EW_YELLOW", "ALL_RED2", "PED_WALK", "PED_FLASH", "NIGHT_FLASH"],
    [["NS_GREEN", "NS_YELLOW", "t_done"], ["NS_YELLOW", "ALL_RED1"], ["ALL_RED1", "EW_GREEN", "!ped"], ["ALL_RED1", "PED_WALK", "ped"], ["EW_GREEN", "EW_YELLOW", "t_done"], ["EW_YELLOW", "ALL_RED2"], ["ALL_RED2", "NS_GREEN", "!ped"], ["ALL_RED2", "PED_WALK", "ped"], ["PED_WALK", "PED_FLASH", "t_done"], ["PED_FLASH", "NS_GREEN"],
      ["NS_GREEN", "NIGHT_FLASH", "night"], ["EW_GREEN", "NIGHT_FLASH", "night"], ["NIGHT_FLASH", "NS_GREEN", "!night"]]));
  // Two-level protocol: link training with retries.
  add("real", "link_train", named(["RESET", "DETECT", "POLL_ACT", "POLL_CFG", "CFG_LW", "CFG_LN", "CFG_DONE", "L0", "RECOV", "L1", "DISABLED", "HOT_RST"],
    [["RESET", "DETECT"], ["DETECT", "POLL_ACT", "rx_det"], ["DETECT", "DETECT", "!rx_det"], ["POLL_ACT", "POLL_CFG", "ts1x8"], ["POLL_ACT", "DETECT", "tmo"], ["POLL_CFG", "CFG_LW", "ts2x8"], ["POLL_CFG", "DETECT", "tmo"], ["CFG_LW", "CFG_LN"], ["CFG_LW", "DETECT", "tmo"], ["CFG_LN", "CFG_DONE"], ["CFG_LN", "DETECT", "tmo"], ["CFG_DONE", "L0", "idle8"], ["CFG_DONE", "DETECT", "tmo"],
      ["L0", "RECOV", "err"], ["L0", "L1", "pm_req"], ["L1", "RECOV", "wake"], ["RECOV", "L0", "ok"], ["RECOV", "CFG_LW", "cfg"], ["RECOV", "DETECT", "tmo"], ["RECOV", "HOT_RST", "hot"], ["RECOV", "DISABLED", "dis"], ["HOT_RST", "DETECT"], ["DISABLED", "DETECT"]]));

  // --- geometric shapes ---
  const ring = (n: number) => Array.from({ length: n }, (_, i) => [i, (i + 1) % n] as [number, number]);
  const chain = (n: number) => Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]);
  for (const n of [5, 8, 12, 20]) add("shape", `ring${n}`, idx(n, ring(n)));
  for (const n of [5, 9, 16]) add("shape", `chain${n}`, idx(n, chain(n)));
  add("shape", "ring8_chords", idx(8, [...ring(8), [0, 4], [2, 6]]));
  add("shape", "ring10_back", idx(10, [...ring(10), [3, 0], [6, 3], [8, 5]]));
  add("shape", "fig8", idx(7, [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6], [6, 3]]));
  add("shape", "three_loops", idx(10, [[0, 1], [1, 2], [2, 0], [0, 3], [3, 4], [4, 5], [5, 0], [0, 6], [6, 7], [7, 8], [8, 9], [9, 0]]));
  add("shape", "ladder5", idx(10, [...chain(5), ...chain(5).map(([a, b]) => [a + 5, b + 5] as [number, number]), ...[0, 1, 2, 3, 4].map((i) => [i, i + 5] as [number, number])]));
  add("shape", "bintree15", idx(15, Array.from({ length: 14 }, (_, i) => [Math.floor(i / 2), i + 1] as [number, number])));
  add("shape", "bintree7_ret", idx(7, [...Array.from({ length: 6 }, (_, i) => [Math.floor(i / 2), i + 1] as [number, number]), [3, 0], [4, 0], [5, 0], [6, 0]]));
  add("shape", "star8", idx(9, Array.from({ length: 8 }, (_, i) => [[0, i + 1], [i + 1, 0]] as Array<[number, number]>).flat()));
  add("shape", "star12", idx(13, Array.from({ length: 12 }, (_, i) => [[0, i + 1], [i + 1, 0]] as Array<[number, number]>).flat()));
  add("shape", "mesh3x3", idx(9, [0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => [i % 3 < 2 ? [i, i + 1] : null, i < 6 ? [i, i + 3] : null].filter(Boolean) as Array<[number, number]>)));
  add("shape", "mesh4x4", idx(16, Array.from({ length: 16 }, (_, i) => i).flatMap((i) => [i % 4 < 3 ? [i, i + 1] : null, i < 12 ? [i, i + 4] : null].filter(Boolean) as Array<[number, number]>)));
  add("shape", "k5", idx(5, [0, 1, 2, 3, 4].flatMap((a) => [0, 1, 2, 3, 4].filter((b) => b > a).map((b) => [a, b] as [number, number]))));
  add("shape", "k33", idx(6, [0, 1, 2].flatMap((a) => [3, 4, 5].map((b) => [a, b] as [number, number]))));
  add("shape", "petersen", idx(10, [...[0, 1, 2, 3, 4].map((i) => [i, (i + 1) % 5] as [number, number]), ...[0, 1, 2, 3, 4].map((i) => [i, i + 5] as [number, number]), ...[0, 1, 2, 3, 4].map((i) => [5 + i, 5 + ((i + 2) % 5)] as [number, number])]));
  add("shape", "skip_chain10", idx(10, [...chain(10), [0, 2], [2, 4], [4, 6], [6, 8], [9, 0]]));
  add("shape", "diamond_chain", idx(10, [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [3, 5], [4, 6], [5, 6], [6, 7], [6, 8], [7, 9], [8, 9], [9, 0]]));
  add("shape", "two_islands", idx(9, [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 6], [6, 3], [7, 8]]));

  // --- e2e generated machines (each state to the next and to one random other) ---
  const generated = (n: number, seed: number) => {
    const name = `gen${n}_${seed}`;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const w = Math.max(1, Math.ceil(Math.log2(n)));
    const st = (i: number) => `ST_${i}`;
    let v = `module ${name}(input clk, input rst, input a, input b, output reg y);\n  localparam ${Array.from({ length: n }, (_, i) => `${st(i)} = ${w}'d${i}`).join(", ")};\n  reg [${w - 1}:0] st, nx;\n  always @(posedge clk) if (rst) st <= ST_0; else st <= nx;\n  always @(*) begin\n    nx = st; y = 0;\n    case (st)\n`;
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      let other = Math.floor(rnd() * n);
      if (other === next) other = (other + 2) % n;
      v += `      ${st(i)}: begin ${i % 3 === 0 ? "y = 1; " : ""}if (a) nx = ${st(next)}; else if (b) nx = ${st(other)}; end\n`;
    }
    return importVerilog(v + "    endcase\n  end\nendmodule\n").diagram!;
  };
  for (const [n, seed] of [[6, 1], [8, 3], [10, 9], [12, 5], [14, 4], [16, 11], [18, 2], [20, 6], [24, 8]] as const) add("gen", `gen${n}_${seed}`, generated(n, seed));

  // --- random connected graphs: a spanning tree plus m extra lines ---
  const random = (n: number, m: number, seed: number) => {
    const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const e: Array<[number, number]> = [];
    for (let i = 1; i < n; i++) e.push([Math.floor(r() * i), i]);
    for (let k = 0; k < m; k++) { const a = Math.floor(r() * n), b = Math.floor(r() * n); if (a !== b) e.push([a, b]); }
    return idx(n, e);
  };
  for (const [n, m, seed] of [[6, 3, 1], [8, 4, 2], [10, 5, 3], [12, 6, 4], [14, 7, 5], [16, 8, 6], [20, 10, 7], [24, 12, 8], [30, 15, 9], [12, 14, 10], [16, 20, 11]] as const) add("rand", `rand${n}_${m}_${seed}`, random(n, m, seed));

  return out;
}
