// Test helpers for the Verilog importer: a cycle simulator for diagrams and an
// Icarus Verilog runner, so an imported diagram can be checked against the
// Verilog it came from.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outgoing } from "../../src/model.ts";
import type { FsmDiagram, OutputValue } from "../../src/model.ts";
import { isConst, simplify } from "../../src/import/expr.ts";
import type { Expr } from "../../src/import/expr.ts";
import { parseExpression } from "../../src/import/index.ts";
import type { ImportResult } from "../../src/import/index.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");
export const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

export const HAS_IVERILOG = spawnSync("iverilog", ["-V"], { stdio: "ignore" }).error === undefined;

export type Inputs = Record<string, bigint>;
export interface Cycle {
  state: string;
  out: Record<string, bigint>;
}

/** Value of a condition or output value given input values (and named constants). */
export function evaluate(e: string | OutputValue, inputs: Inputs, constants: Record<string, bigint> = {}): bigint {
  if (typeof e === "number") return BigInt(e);
  if (typeof e === "boolean") return e ? 1n : 0n;
  if (e.trim() === "") return 1n;
  const ast = parseExpression(e);
  const lookup = (n: string): Expr | undefined => {
    const v = inputs[n] ?? constants[n];
    return v === undefined ? undefined : { k: "num", v, w: null, x: 0n, z: 0n };
  };
  const r = simplify(ast, { lookup, width: () => undefined });
  if (!isConst(r)) throw new Error(`cannot evaluate "${e}" with ${JSON.stringify(Object.keys(inputs))}`);
  return r.v;
}

/** Run a diagram cycle by cycle: outputs before each clock edge, as a Mealy/Moore machine would show them. */
export function simulate(d: FsmDiagram, seq: Inputs[], constants: Record<string, bigint> = {}): Cycle[] {
  let cur = d.states.find((s) => s.isInitial)!;
  const out: Cycle[] = [];
  for (const inputs of seq) {
    const taken = outgoing(d, cur.id).filter((t) => evaluate(t.condition, inputs, constants) !== 0n);
    if (taken.length > 1 && taken.some((t) => t.priority === undefined)) {
      throw new Error(`state ${cur.name}: ${taken.length} transitions are enabled (${taken.map((t) => t.condition).join(" | ")})`);
    }
    const t = taken[0];
    const vals: Record<string, bigint> = {};
    for (const o of d.outputs) {
      const v = t?.outputs[o.name] ?? cur.outputs[o.name] ?? o.default ?? 0;
      vals[o.name] = evaluate(v, inputs, constants) & ((1n << BigInt(o.width)) - 1n);
    }
    out.push({ state: cur.name, out: vals });
    if (t) cur = d.states.find((s) => s.id === t.to)!;
  }
  return out;
}

/** Deterministic pseudo-random input vectors. */
export function randomInputs(d: FsmDiagram, n: number, seed = 1): Inputs[] {
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  return Array.from({ length: n }, () => Object.fromEntries(d.inputs.map((s) => [s.name, BigInt(rnd()) & ((1n << BigInt(s.width)) - 1n)])));
}

/**
 * Simulate the original Verilog in Icarus with the same inputs: reset for two
 * cycles, then one line per cycle with the state register and every output,
 * printed just before the clock edge.
 */
export function runIcarus(source: string, file: string, r: ImportResult, seq: Inputs[]): Cycle[] {
  const d = r.diagram;
  const dir = mkdtempSync(join(tmpdir(), "fsm-import-"));
  const clk = d.clock.name, rst = d.reset.name;
  const active = d.reset.activeLow ? 0 : 1;
  // Internal signals the importer listed as inputs are driven with force.
  const internal = new Set(r.warnings.map((w) => w.match(/^Internal signal "(.+)" is used/)?.[1]).filter(Boolean));
  const ports = [clk, rst, ...d.inputs.filter((s) => !internal.has(s.name)).map((s) => s.name), ...d.outputs.map((s) => s.name)];
  const L = [
    "`timescale 1ns/1ps",
    "module tb;",
    `  reg ${clk} = 0;`,
    `  reg ${rst} = ${active};`,
    ...d.inputs.map((s) => `  reg [${s.width - 1}:0] ${s.name} = 0;`),
    ...d.outputs.map((s) => `  wire [${s.width - 1}:0] ${s.name};`),
    `  always #5 ${clk} = ~${clk};`,
    `  ${r.module} dut (${ports.map((p) => `.${p}(${p})`).join(", ")});`,
    "  initial begin",
    `    @(posedge ${clk}); @(posedge ${clk}); @(negedge ${clk});`,
    `    ${rst} = ${1 - active};`,
  ];
  for (const inputs of seq) {
    for (const [k, v] of Object.entries(inputs)) L.push(internal.has(k) ? `    force dut.${k} = ${v};` : `    ${k} = ${v};`);
    L.push("    #1;");
    L.push(`    $display("%0d${d.outputs.map(() => " %0d").join("")}", dut.${r.stateVar}${d.outputs.map((o) => `, ${o.name}`).join("")});`);
    L.push(`    @(negedge ${clk});`);
  }
  L.push("    $finish;", "  end", "endmodule", "");
  const dut = join(dir, file);
  writeFileSync(dut, source);
  writeFileSync(join(dir, "tb.sv"), L.join("\n"));
  const compile = spawnSync("iverilog", ["-g2012", "-o", join(dir, "sim.vvp"), dut, join(dir, "tb.sv")], { encoding: "utf8" });
  if (compile.status !== 0) throw new Error(compile.stderr);
  const run = spawnSync("vvp", ["-n", join(dir, "sim.vvp")], { encoding: "utf8" });
  const codes = new Map(Object.entries(r.stateCodes).map(([name, lit]) => [BigInt("0b" + lit.split("'b")[1]).toString(), name]));
  return run.stdout.trim().split("\n").filter((l) => /^\d/.test(l)).map((line) => {
    const [st, ...outs] = line.trim().split(/\s+/);
    return { state: codes.get(st) ?? `?${st}`, out: Object.fromEntries(d.outputs.map((o, i) => [o.name, BigInt(outs[i])])) };
  });
}
