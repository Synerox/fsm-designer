// Verilog -> FSM diagram. See extract.ts for how the state machine is found.

import { autoLayout } from "../layout.ts";
import type { LayoutOptions } from "../layout.ts";
import { extractFsm, stateRegisters, VerilogImportError } from "./extract.ts";
import type { ImportOptions, ImportResult } from "./extract.ts";
import { parseVerilog } from "./parser.ts";

export { VerilogImportError } from "./extract.ts";
export type { ImportOptions, ImportResult } from "./extract.ts";
export { VerilogSyntaxError } from "./lexer.ts";
export { parseExpression } from "./parser.ts";

/** Parse Verilog source and extract its FSM. States have no positions yet (see importVerilogLaidOut). */
export function importVerilog(source: string, opts: ImportOptions = {}): ImportResult {
  const file = parseVerilog(source);
  if (!file.modules.length) throw new VerilogImportError("No module found in the Verilog source");
  if (opts.module) {
    const m = file.modules.find((x) => x.name === opts.module);
    if (!m) throw new VerilogImportError(`No module named "${opts.module}". Modules: ${file.modules.map((x) => x.name).join(", ")}`);
    return extractFsm(m, opts);
  }
  const errors: string[] = [];
  for (const m of file.modules) {
    try {
      const r = extractFsm(m, opts);
      const others = file.modules.filter((x) => x !== m).map((x) => x.name);
      if (others.length) r.warnings.unshift(`Imported module ${m.name}; the file also has ${others.join(", ")} (pick one with module: "<name>")`);
      return r;
    } catch (e) {
      if (!(e instanceof VerilogImportError)) throw e;
      errors.push(e.message);
    }
  }
  throw new VerilogImportError(errors.length === 1 ? errors[0] : `No state machine found in any module:\n${errors.map((e) => `  ${e}`).join("\n")}`);
}

/**
 * Every state machine in the source, as the module and state register to
 * pass to importVerilog; the first is the one importVerilog picks by default.
 * Empty when the source does not parse or has no FSM.
 */
export function listStateMachines(source: string): Array<{ module: string; stateVar: string }> {
  try {
    return parseVerilog(source).modules.flatMap((m) => stateRegisters(m).map((stateVar) => ({ module: m.name, stateVar })));
  } catch {
    return [];
  }
}

/** importVerilog plus an automatic layout, ready to draw. */
export async function importVerilogLaidOut(source: string, opts: ImportOptions & { layout?: LayoutOptions } = {}): Promise<ImportResult> {
  const r = importVerilog(source, opts);
  await autoLayout(r.diagram, opts.layout ?? {});
  return r;
}
