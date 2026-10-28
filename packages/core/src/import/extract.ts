// Turn a parsed Verilog module into an FSM diagram, without guessing from names
// alone and without an LLM:
//
//  1. Find the state register: a register written in a clocked block that takes
//     two or more constant values (directly, or through a combinational
//     next-state variable) and is used as a case subject or compared with
//     constants. Counters (x <= x + 1) are ruled out.
//  2. Find clock and reset from the clocked block (sensitivity list and the
//     first if), and the reset state by running the block with reset asserted.
//  3. For every state, execute all combinational and clocked logic
//     symbolically with the state register fixed to that state. Each if/case
//     on an unknown signal forks the run; every finished run is one cube of
//     input conditions with a next state and output values.
//  4. Outputs that are the same in every run of a state depend on the state
//     only (Moore); outputs that vary with inputs are Mealy and go on the
//     transitions. Registered outputs that always take the same value when
//     entering a state are that state's Moore outputs.
//  5. Runs are grouped by (next state, Mealy outputs) and each group's
//     condition is minimised with Quine-McCluskey.

import { addSignal, addState, addTransition, createDiagram, DEFAULT_RESET } from "../model.ts";
import { fitStateSizes } from "../metrics.ts";
import type { FsmDiagram, OutputValue } from "../model.ts";
import { minimize } from "./boolmin.ts";
import { caseMatch, FALSE, formatNum, freeIds, isConst, isNum, mask, num, printExpr, simplify, TRUE, widthOf, wildcardBits } from "./expr.ts";
import type { EvalCtx, Expr, Num } from "./expr.ts";
import type { Always, Module, Stmt } from "./parser.ts";

export interface ImportOptions {
  /** Module to import when the file has several (default: the first one with an FSM). */
  module?: string;
  /** Name of the state register, when detection picks the wrong one. */
  stateVar?: string;
  /** Draw transitions that stay in the same state (default true). Self loops with Mealy outputs are always drawn. */
  selfLoops?: boolean;
  /** Limit on symbolic runs per state (default 4096). */
  maxPaths?: number;
}

export interface ImportResult {
  diagram: FsmDiagram;
  module: string;
  machine: "moore" | "mealy";
  stateVar: string;
  nextVar?: string;
  /** Number of always blocks (and continuous assigns) that make up the FSM, e.g. "3 always blocks". */
  style: string;
  /** State name -> encoding as a Verilog literal. */
  stateCodes: Record<string, string>;
  mooreOutputs: string[];
  mealyOutputs: string[];
  /** Named constants that appear in conditions or output values (e.g. RED, P_REQ), with their values. */
  constants: Record<string, string>;
  warnings: string[];
}

export class VerilogImportError extends Error {}

interface Block {
  seq: boolean;
  stmt: Stmt;
  writes: Set<string>;
  reads: Set<string>;
  line: number;
  always?: Always;
}

interface Assumption {
  atom: Expr;
  val: boolean;
}

interface Path {
  env: Map<string, Expr>; // blocking / combinational values
  nb: Map<string, Expr>; // values registered at the clock edge
  subst: Map<string, Expr>; // input values implied by assumptions
  assume: Map<string, Assumption>;
  /**
   * Values each multi-bit input can still take under the path's assumptions
   * about it (sig: those assumptions, printed), so the next assumption only
   * filters these instead of re-enumerating every value against all of them.
   */
  dom?: Map<string, { sig: string[]; vals: number[] }>;
}

interface Run {
  assume: Map<string, Assumption>;
  next: bigint;
  comb: Map<string, OutputValue>;
  reg: Map<string, OutputValue | undefined>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESET_NAME = /(^|_)(n?a?s?rst|n?reset|rstn|resetn|rst_?b|clr|clear|init)(_?n|_?b|_?l)?($|_)/i;
const STATE_NAME = /state|^st$|_st$|^cs$|^ps$|^curr?|^cur_|fsm/i;

class Ctx {
  readonly params = new Map<string, Num>();
  readonly widths = new Map<string, number>();
  /** Signals declared signed: a value tried for one of them compares as two's complement. */
  readonly signed = new Set<string>();
  readonly warnings: string[] = [];
  readonly m: Module;
  constructor(m: Module) {
    this.m = m;
    const base: EvalCtx = { lookup: (n) => this.params.get(n), width: () => undefined };
    for (const p of m.params) {
      let v = simplify(p.value, base);
      if (!isConst(v)) continue;
      const w = p.range ? rangeWidth(p.range, base) : p.enumType ? enumWidth(m, p.enumType, base) : v.w;
      if (w) v = num(v.v, w, { src: v.src && v.w === w ? v.src : undefined });
      this.params.set(p.name, { ...v, name: p.name });
    }
    const pctx: EvalCtx = { lookup: (n) => this.params.get(n), width: () => undefined };
    for (const d of m.decls.values()) {
      const w = d.width ?? (d.enumType ? enumWidth(m, d.enumType, pctx) : d.range ? rangeWidth(d.range, pctx) : 1);
      this.widths.set(d.name, w ?? 1);
      if (d.signed) this.signed.add(d.name);
    }
  }
  warn(msg: string) { if (!this.warnings.includes(msg)) this.warnings.push(msg); }
}

function rangeWidth(r: { msb: Expr; lsb: Expr }, ctx: EvalCtx): number | undefined {
  const a = simplify(r.msb, ctx), b = simplify(r.lsb, ctx);
  return isConst(a) && isConst(b) ? Math.abs(Number(a.v) - Number(b.v)) + 1 : undefined;
}

function enumWidth(m: Module, type: string, ctx: EvalCtx): number | undefined {
  const e = m.enums.get(type);
  return e?.range ? rangeWidth(e.range, ctx) : 32;
}

// ---- walking statements -----------------------------------------------------

function eachStmt(s: Stmt, fn: (s: Stmt) => void) {
  fn(s);
  if (s.k === "block") s.body.forEach((b) => eachStmt(b, fn));
  else if (s.k === "if") { eachStmt(s.t, fn); if (s.e) eachStmt(s.e, fn); }
  else if (s.k === "case") s.items.forEach((i) => eachStmt(i.body, fn));
}

function eachExpr(s: Stmt, fn: (e: Expr) => void) {
  eachStmt(s, (x) => {
    if (x.k === "assign") { fn(x.lhs); fn(x.rhs); }
    else if (x.k === "if") fn(x.c);
    else if (x.k === "case") { fn(x.subject); for (const it of x.items) it.labels?.forEach(fn); }
  });
}

function subExprs(e: Expr, fn: (e: Expr) => void) {
  fn(e);
  switch (e.k) {
    case "un": subExprs(e.a, fn); break;
    case "bin": subExprs(e.a, fn); subExprs(e.b, fn); break;
    case "tern": subExprs(e.c, fn); subExprs(e.a, fn); subExprs(e.b, fn); break;
    case "idx": subExprs(e.a, fn); subExprs(e.i, fn); break;
    case "part": subExprs(e.a, fn); subExprs(e.msb, fn); subExprs(e.lsb, fn); break;
    case "cat": e.parts.forEach((p) => subExprs(p, fn)); break;
    case "rep": subExprs(e.n, fn); e.parts.forEach((p) => subExprs(p, fn)); break;
    case "call": e.args.forEach((a) => subExprs(a, fn)); break;
  }
}

function lhsBase(e: Expr): string[] {
  if (e.k === "id") return [e.name];
  if (e.k === "idx" || e.k === "part") return lhsBase(e.a);
  if (e.k === "cat") return e.parts.flatMap(lhsBase);
  return [];
}

function assignsTo(s: Stmt, name: string): Array<{ lhs: Expr; rhs: Expr }> {
  const out: Array<{ lhs: Expr; rhs: Expr }> = [];
  eachStmt(s, (x) => { if (x.k === "assign" && lhsBase(x.lhs).includes(name)) out.push(x); });
  return out;
}

/**
 * For each signal written in s, the signals its value can depend on: the
 * right-hand sides of its assignments and every condition around them.
 */
function signalDeps(s: Stmt, ctrl: Set<string>, deps: Map<string, Set<string>>) {
  switch (s.k) {
    case "block": s.body.forEach((b) => signalDeps(b, ctrl, deps)); break;
    case "assign": {
      const r = freeIds(s.rhs, new Set(ctrl));
      if (s.lhs.k === "idx") freeIds(s.lhs.i, r);
      for (const n of lhsBase(s.lhs)) { const d = deps.get(n) ?? new Set<string>(); r.forEach((x) => d.add(x)); deps.set(n, d); }
      break;
    }
    case "if": {
      const c = freeIds(s.c, new Set(ctrl));
      signalDeps(s.t, c, deps);
      if (s.e) signalDeps(s.e, c, deps);
      break;
    }
    case "case": {
      const c = freeIds(s.subject, new Set(ctrl));
      for (const it of s.items) it.labels?.forEach((l) => freeIds(l, c));
      for (const it of s.items) signalDeps(it.body, c, deps);
      break;
    }
  }
}

const writeCache = new WeakMap<Stmt, Set<string>>();
function writesOf(s: Stmt): Set<string> {
  let w = writeCache.get(s);
  if (!w) {
    const out = new Set<string>();
    eachStmt(s, (x) => { if (x.k === "assign") lhsBase(x.lhs).forEach((n) => out.add(n)); });
    writeCache.set(s, (w = out));
  }
  return w;
}

function makeBlocks(m: Module): Block[] {
  const blocks: Block[] = [];
  const mk = (seq: boolean, stmt: Stmt, line: number, always?: Always) => {
    const writes = new Set<string>(), reads = new Set<string>();
    eachStmt(stmt, (x) => {
      if (x.k === "assign") {
        lhsBase(x.lhs).forEach((n) => writes.add(n));
        freeIds(x.rhs, reads);
        // Index expressions on the left are reads too.
        if (x.lhs.k === "idx") freeIds(x.lhs.i, reads);
      } else if (x.k === "if") freeIds(x.c, reads);
      else if (x.k === "case") { freeIds(x.subject, reads); for (const it of x.items) it.labels?.forEach((l) => freeIds(l, reads)); }
    });
    blocks.push({ seq, stmt, writes, reads, line, always });
  };
  for (const a of m.always) {
    if (a.kind === "initial") continue;
    const seq = a.kind === "always_ff" || a.sens.some((s) => s.edge);
    mk(seq, a.body, a.line, a);
  }
  for (const a of m.assigns) mk(false, { k: "assign", lhs: a.lhs, rhs: a.rhs, nb: false, line: a.line }, a.line);
  return blocks;
}

/** Combinational blocks in dependency order (a block that defines x runs before blocks reading x). */
function orderComb(blocks: Block[]): Block[] {
  const comb = blocks.filter((b) => !b.seq);
  const done: Block[] = [];
  const state = new Map<Block, number>(); // 1 visiting, 2 done
  const visit = (b: Block) => {
    if (state.get(b)) return;
    state.set(b, 1);
    for (const o of comb) if (o !== b && [...o.writes].some((w) => b.reads.has(w) && !b.writes.has(w))) visit(o);
    state.set(b, 2);
    done.push(b);
  };
  comb.forEach(visit);
  return done;
}

// ---- state register detection ---------------------------------------------

interface Candidate {
  name: string;
  next?: string;
  score: number;
  values: Set<string>;
}

function findCandidates(c: Ctx, blocks: Block[]): Candidate[] {
  const m = c.m;
  const pctx: EvalCtx = { lookup: (n) => c.params.get(n), width: (n) => c.widths.get(n) };
  const constOf = (e: Expr): Num | undefined => { const v = simplify(e, pctx); return isConst(v) ? v : undefined; };
  const seqWritten = new Set(blocks.filter((b) => b.seq).flatMap((b) => [...b.writes]));
  const combWritten = new Set(blocks.filter((b) => !b.seq).flatMap((b) => [...b.writes]));
  const out: Candidate[] = [];
  for (const name of seqWritten) {
    const decl = m.decls.get(name);
    if (decl?.dir === "input") continue;
    const values = new Set<string>();
    let score = 0;
    let counter = false;
    const nexts = new Map<string, number>();
    for (const b of blocks.filter((x) => x.seq && x.writes.has(name))) {
      for (const a of assignsTo(b.stmt, name)) {
        const v = a.lhs.k === "id" ? constOf(a.rhs) : undefined;
        if (v) values.add(v.v.toString());
        if (a.rhs.k === "id" && combWritten.has(a.rhs.name)) nexts.set(a.rhs.name, (nexts.get(a.rhs.name) ?? 0) + 1);
        if (a.rhs.k === "bin" && ["+", "-"].includes(a.rhs.op) && freeIds(a.rhs).has(name)) counter = true;
      }
    }
    const next = [...nexts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (next) {
      for (const b of blocks.filter((x) => !x.seq && x.writes.has(next))) {
        for (const a of assignsTo(b.stmt, next)) {
          if (a.lhs.k !== "id") continue;
          const v = constOf(a.rhs);
          if (v) values.add(v.v.toString());
          if (a.rhs.k === "bin" && ["+", "-"].includes(a.rhs.op) && freeIds(a.rhs).has(name)) counter = true;
        }
      }
    }
    // Usage: case subject, comparisons with constants, one-hot bit tests.
    const names = new Set([name, ...(next ? [next] : [])]);
    let caseUses = 0, compares = 0, bitTests = 0;
    for (const b of blocks) {
      eachStmt(b.stmt, (x) => {
        if (x.k === "case" && x.subject.k === "id" && names.has(x.subject.name)) {
          caseUses++;
          for (const it of x.items) for (const l of it.labels ?? []) { const v = constOf(l); if (v) values.add(v.v.toString()); }
        }
      });
      eachExpr(b.stmt, (e) => subExprs(e, (s) => {
        if (s.k === "bin" && (s.op === "==" || s.op === "!=") && s.a.k === "id" && names.has(s.a.name) && constOf(s.b)) compares++;
        if (s.k === "idx" && s.a.k === "id" && names.has(s.a.name) && s.i.k === "id" && c.params.has(s.i.name)) bitTests++;
      }));
    }
    const enumTyped = decl?.enumType !== undefined;
    score = values.size * 2 + caseUses * 3 + compares + bitTests + (STATE_NAME.test(name) ? 3 : 0) + (enumTyped ? 3 : 0) + (next ? 2 : 0);
    if (counter) score -= 20;
    if (decl?.dir === "output") score -= 2;
    const enough = values.size >= 2 || bitTests >= 2 || (enumTyped && caseUses > 0);
    if (enough && (caseUses > 0 || compares > 0 || bitTests > 0)) out.push({ name, next, score, values });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---- reset and clock ----------------------------------------------------------

interface ResetInfo {
  name: string;
  activeLow: boolean;
  async: boolean;
}

/**
 * The if a reset would be in: the block's first if, past statements that do
 * not touch the state register (cnt <= cnt + 1; t = a & b; before the reset).
 */
function firstIf(s: Stmt, stateVar: string): Extract<Stmt, { k: "if" }> | undefined {
  if (s.k === "if") return s;
  if (s.k === "block") {
    for (const b of s.body) {
      if (b.k === "if") return b;
      if (b.k === "block") { const r = firstIf(b, stateVar); if (r) return r; }
      else if (b.k !== "skip" && !(b.k === "assign" && !lhsBase(b.lhs).includes(stateVar))) return undefined;
    }
  }
  return undefined;
}

function resetLiteral(c: Expr): { name: string; activeLow: boolean } | undefined {
  if (c.k === "id") return { name: c.name, activeLow: false };
  if (c.k === "un" && (c.op === "!" || c.op === "~") && c.a.k === "id") return { name: c.a.name, activeLow: true };
  if (c.k === "bin" && (c.op === "==" || c.op === "===" || c.op === "!=") && c.a.k === "id" && isConst(c.b)) {
    const one = c.b.v !== 0n;
    return { name: c.a.name, activeLow: (c.op === "!=") === one };
  }
  return undefined;
}

function findReset(c: Ctx, stateBlocks: Block[], stateVar: string): { reset?: ResetInfo; clock: string } {
  const b = stateBlocks[0];
  const edges = b.always?.sens.filter((s) => s.edge) ?? [];
  const ifs = firstIf(b.stmt, stateVar);
  let lit = ifs ? resetLiteral(ifs.c) : undefined;
  // state <= !rst_n ? IDLE : next;
  const tern = assignsTo(b.stmt, stateVar).map((a) => a.rhs).find((e) => e.k === "tern" && resetLiteral(e.c));
  if (!lit && tern?.k === "tern") {
    const l = resetLiteral(tern.c)!;
    if (edges.some((e) => e.sig === l.name) || RESET_NAME.test(l.name)) {
      const async = edges.length > 1 && edges.some((e) => e.sig === l.name);
      const clockEdge = edges.find((e) => e.sig !== l.name);
      return { reset: { ...l, async }, clock: clockEdge?.sig ?? "clk" };
    }
  }
  let reset: ResetInfo | undefined;
  if (lit) {
    const edge = edges.find((e) => e.sig === lit.name);
    if (edge && edges.length > 1) {
      reset = { name: lit.name, activeLow: lit.activeLow, async: true };
    } else if (!edge && c.m.decls.get(lit.name)?.dir !== "output") {
      // Without a reset-like name, only an if that sets the state to a
      // constant (if (go) state <= S1; else ...) counts as a synchronous
      // reset: if (en) state <= next; else state <= state; is an enable.
      const pctx: EvalCtx = { lookup: (n) => c.params.get(n), width: (n) => c.widths.get(n) };
      const sets = assignsTo(ifs!.t, stateVar);
      const setsConst = sets.length > 0 && sets.every((a) => isConst(simplify(a.rhs, pctx)));
      if (RESET_NAME.test(lit.name) || (setsConst && ifs!.e)) reset = { name: lit.name, activeLow: lit.activeLow, async: false };
    }
  }
  const clockEdge = edges.find((e) => e.sig !== reset?.name && e.edge === "posedge") ?? edges.find((e) => e.sig !== reset?.name);
  return { reset, clock: clockEdge?.sig ?? "clk" };
}

// ---- symbolic execution -----------------------------------------------------------

class Engine {
  private count = 0;
  private c: Ctx;
  private fixed: Map<string, Expr>;
  private limit: number;
  private needed?: Set<string>;
  private coarse: boolean;
  /**
   * needed: the signals worth following; statements that write none of them
   * are passed over, so unrelated logic (a FIFO, a second FSM) does not
   * multiply the cases. coarse: split on whole conditions instead of their
   * parts, for conditions with too many parts to enumerate.
   */
  constructor(c: Ctx, fixed: Map<string, Expr>, limit: number, needed?: Set<string>, coarse = false) {
    this.c = c;
    this.fixed = fixed;
    this.limit = limit;
    this.needed = needed;
    this.coarse = coarse;
  }

  private irrelevant(s: Stmt): boolean {
    const n = this.needed;
    return !!n && (s.k === "assign" || s.k === "if" || s.k === "case") && ![...writesOf(s)].some((w) => n.has(w));
  }

  ctx(p: Path): EvalCtx {
    return {
      lookup: (n) => p.env.get(n) ?? p.subst.get(n) ?? this.fixed.get(n) ?? this.c.params.get(n),
      width: (n) => this.c.widths.get(n),
      assumed: (k) => p.assume.get(k)?.val,
    };
  }

  run(blocks: Block[], paths: Path[], seq: boolean): Path[] {
    for (const b of blocks) paths = paths.flatMap((p) => this.exec(b.stmt, p, seq));
    return paths;
  }

  exec(s: Stmt, p: Path, seq: boolean): Path[] {
    if (this.irrelevant(s)) return [p];
    switch (s.k) {
      case "block": {
        let ps = [p];
        for (const b of s.body) ps = ps.flatMap((q) => this.exec(b, q, seq));
        return ps;
      }
      case "assign": {
        const v = simplify(s.rhs, this.ctx(p));
        // x ? A : B with an unknown x: fork, so each run assigns a constant.
        if (v.k === "tern") return this.branch(p, v.c).flatMap(([q, b]) => this.exec({ ...s, rhs: b ? v.a : v.b }, q, seq));
        const q = clonePath(p);
        this.write(q, s.lhs, v, seq, s.nb);
        return [q];
      }
      case "if": {
        const out: Path[] = [];
        for (const [q, b] of this.branch(p, s.c)) {
          if (b) out.push(...this.exec(s.t, q, seq));
          else if (s.e) out.push(...this.exec(s.e, q, seq));
          else out.push(q);
        }
        return out;
      }
      case "case": {
        const ctx = this.ctx(p);
        const subject = simplify(s.subject, ctx);
        let rest = [p];
        const out: Path[] = [];
        const items = [...s.items.filter((i) => i.labels), ...s.items.filter((i) => !i.labels)];
        // A casez/casex with wildcards reads best bit by bit, for every label.
        const bitwise = s.kind !== "case" && s.items.some((i) => i.labels?.some((l) => { const v = simplify(l, ctx); return isNum(v) && wildcardBits(s.kind, v, widthOf(subject, ctx)) !== 0n; }));
        for (const it of items) {
          if (!it.labels) {
            for (const q of rest) out.push(...this.exec(it.body, q, seq));
            rest = [];
            break;
          }
          const next: Path[] = [];
          for (const q of rest) {
            const cond = it.labels.map((l) => this.match(q, subject, l, s.kind, bitwise)).reduce((a, b) => ({ k: "bin", op: "||", a, b }));
            for (const [r, hit] of this.branch(q, cond)) {
              if (hit) out.push(...this.exec(it.body, r, seq));
              else next.push(r);
            }
          }
          rest = next;
        }
        return [...out, ...rest];
      }
      case "skip":
        this.c.warn(`Skipped ${s.what} on line ${s.line}; its effect is not in the diagram`);
        return [p];
    }
  }

  private write(q: Path, lhs: Expr, v: Expr, seq: boolean, nb: boolean) {
    const ctx = this.ctx(q);
    const set = (name: string, val: Expr) => {
      if (!seq || !nb) q.env.set(name, val);
      if (seq) q.nb.set(name, val);
    };
    if (lhs.k === "id") return set(lhs.name, v);
    if ((lhs.k === "idx" || lhs.k === "part") && lhs.a.k === "id") {
      const name = lhs.a.name;
      const w = this.c.widths.get(name) ?? 1;
      const cur = seq && nb ? q.nb.get(name) ?? ctx.lookup(name) : ctx.lookup(name);
      let hi: number | undefined, lo: number | undefined;
      if (lhs.k === "idx") { const i = simplify(lhs.i, ctx); if (isConst(i)) hi = lo = Number(i.v); }
      else {
        const part = simplify(lhs, { ...ctx, lookup: () => undefined });
        if (part.k === "part" && isConst(part.msb) && isConst(part.lsb)) { hi = Number(part.msb.v); lo = Number(part.lsb.v); }
      }
      if (cur && isConst(cur) && isConst(v) && hi !== undefined && lo !== undefined) {
        const fieldMask = mask(-1n, hi - lo + 1) << BigInt(lo);
        const nv = (mask(cur.v, w) & ~fieldMask) | ((v.v << BigInt(lo)) & fieldMask);
        return set(name, num(nv, w));
      }
      this.c.warn(`Could not follow the partial assignment to ${name}${hi !== undefined ? `[${hi}${lo !== hi ? `:${lo}` : ""}]` : "[...]"}`);
      return set(name, { k: "call", name: "$unknown", args: [] });
    }
    if (lhs.k === "cat") {
      const ws = lhs.parts.map((x) => widthOf(x, ctx));
      let shift = ws.reduce((a, b) => a + b, 0);
      lhs.parts.forEach((part, i) => {
        shift -= ws[i];
        const pv: Expr = isConst(v) ? num(v.v >> BigInt(shift), ws[i]) : { k: "part", a: v, msb: num(shift + ws[i] - 1), lsb: num(shift), mode: ":" };
        this.write(q, part, simplify(pv, ctx), seq, nb);
      });
    }
  }

  /** Expression that is true when `subject` matches case label `label`. */
  private match(p: Path, subject: Expr, label: Expr, kind: "case" | "casez" | "casex", bitwise = false): Expr {
    const ctx = this.ctx(p);
    const l = simplify(label, ctx);
    const w = Math.max(widthOf(subject, ctx), widthOf(l, ctx));
    if (isNum(subject) && isNum(l)) {
      const r = caseMatch(kind, subject, l, w);
      if (r !== undefined) return r ? TRUE : FALSE;
    }
    const wild = isNum(l) ? wildcardBits(kind, l, w) : 0n;
    const perBit = isNum(l) && (wild !== 0n || bitwise || subject.k === "cat") && w <= 32 && (subject.k === "id" || subject.k === "cat" || subject.k === "part");
    if (perBit && isNum(l)) {
      let e: Expr = TRUE;
      for (let i = w - 1; i >= 0; i--) {
        if ((wild >> BigInt(i)) & 1n) continue;
        const bit = simplify({ k: "idx", a: subject, i: num(i) }, ctx);
        const one = ((l.v >> BigInt(i)) & 1n) === 1n;
        const lit: Expr = one ? bit : { k: "un", op: "!", a: bit };
        e = e === TRUE ? lit : { k: "bin", op: "&&", a: e, b: lit };
      }
      return simplify(e, ctx);
    }
    return simplify({ k: "bin", op: "==", a: subject, b: l }, ctx);
  }

  /** Split a path on a condition: every result has the condition decided. */
  branch(p: Path, cond: Expr): Array<[Path, boolean]> {
    const out: Array<[Path, boolean]> = [];
    const work = [p];
    while (work.length) {
      const q = work.shift()!;
      const v = simplify(cond, this.ctx(q));
      if (isConst(v)) { out.push([q, v.v !== 0n]); continue; }
      const atom = this.coarse ? v : pickAtom(v, this.ctx(q));
      for (const val of [true, false]) {
        const r = this.assume(q, atom, val);
        if (r) work.push(r);
      }
      if (++this.count > this.limit) throw new VerilogImportError(`Too many cases to enumerate (more than ${this.limit}); the FSM's conditions are too complex to import`);
    }
    return out;
  }

  assume(q: Path, atom: Expr, val: boolean): Path | undefined {
    const r = clonePath(q);
    const key = printExpr(atom);
    r.assume.set(key, { atom, val });
    const ctx = this.ctx(r);
    if (atom.k === "id") {
      const w = this.c.widths.get(atom.name) ?? 1;
      if (w === 1) r.subst.set(atom.name, num(val ? 1 : 0, 1));
      else if (!val) r.subst.set(atom.name, num(0, w));
    } else if (atom.k === "bin" && (atom.op === "==" || atom.op === "===") && atom.a.k === "id" && isConst(atom.b) && val) {
      r.subst.set(atom.a.name, num(atom.b.v, this.c.widths.get(atom.a.name) ?? atom.b.w, this.c.signed.has(atom.a.name) ? { signed: true } : {}));
    } else if (atom.k === "un" && atom.op === "!" && atom.a.k === "id") {
      r.subst.set(atom.a.name, num(val ? 0 : 1, 1));
    }
    return feasible(r, this.c, ctx) ? r : undefined;
  }
}

function clonePath(p: Path): Path {
  return { env: new Map(p.env), nb: new Map(p.nb), subst: new Map(p.subst), assume: new Map(p.assume), dom: new Map(p.dom) };
}

/** The first sub-expression a condition depends on that is not itself boolean structure. */
function pickAtom(e: Expr, ctx: EvalCtx): Expr {
  const bool = (x: Expr) => widthOf(x, ctx) === 1;
  if (e.k === "un" && (e.op === "!" || (e.op === "~" && bool(e.a)))) return pickAtom(e.a, ctx);
  if (e.k === "bin") {
    if (e.op === "&&" || e.op === "||") return pickAtom(isConst(e.a) ? e.b : e.a, ctx);
    // (^ stays whole: splitting a parity of n bits gives 2^n cases.)
    if (["&", "|", "==", "!=", "===", "!=="].includes(e.op) && bool(e.a) && bool(e.b) && !isConst(e.b)) return pickAtom(isConst(e.a) ? e.b : e.a, ctx);
  }
  if (e.k === "tern") return pickAtom(e.c, ctx);
  return e;
}

/**
 * Is there an input assignment that satisfies every assumption of the path?
 * Checked per signal, by trying its values (up to 12 bits). A single
 * assumption is checked too: cnt > 4'd15 on a 4-bit cnt can never hold, and a
 * branch the code can never take must not become a transition.
 */
function feasible(p: Path, c: Ctx, ctx: EvalCtx): boolean {
  const groups = new Map<string, Assumption[]>();
  for (const a of p.assume.values()) {
    const v = simplify(a.atom, { ...ctx, assumed: undefined });
    if (isConst(v)) { if ((v.v !== 0n) !== a.val) return false; continue; }
    const ids = [...freeIds(v)];
    if (ids.length !== 1) continue;
    const g = groups.get(ids[0]) ?? [];
    g.push({ atom: v, val: a.val });
    groups.set(ids[0], g);
  }
  for (const [id, as] of groups) {
    const w = c.widths.get(id);
    if (w === undefined || w > 12) continue; // (an undeclared name's width is unknown)
    const tests = as.map((a) => valueTest(a.atom, id, w, c.signed.has(id), ctx));
    const holds = (x: number, from: number) => {
      for (let i = from; i < as.length; i++) if (tests[i](x) !== as[i].val) return false;
      return true;
    };
    const sig = as.map((a) => `${a.val ? "" : "!"}${printExpr(a.atom)}`);
    const known = p.dom?.get(id);
    let vals: number[];
    if (known && known.sig.length <= sig.length && known.sig.every((s, i) => s === sig[i])) {
      // The usual case on a long else-if chain: one new assumption on top of
      // the parent path's, so only the values still possible are tried.
      vals = known.vals.filter((x) => holds(x, known.sig.length));
    } else if (!p.dom || as.length === 1) {
      // Just look for one value (no list to keep for later assumptions).
      let ok = false;
      for (let x = 0; x < 1 << w && !ok; x++) ok = holds(x, 0);
      if (!ok) return false;
      continue;
    } else {
      vals = [];
      for (let x = 0; x < 1 << w; x++) if (holds(x, 0)) vals.push(x);
    }
    if (!vals.length) return false;
    p.dom!.set(id, { sig, vals });
  }
  return true;
}

/** The truth of `atom` (which reads only `id`) for each value of id. */
function valueTest(atom: Expr, id: string, w: number, signed: boolean, ctx: EvalCtx): (x: number) => boolean | undefined {
  // id == 5, id < 4'd9 ...: compared directly, the common case and the hot loop
  // (left to simplify when both sides are signed).
  if (atom.k === "bin" && atom.a.k === "id" && isConst(atom.b) && !(signed && atom.b.signed) && atom.b.v <= BigInt(Number.MAX_SAFE_INTEGER)) {
    const k = Number(atom.b.v);
    switch (atom.op) {
      case "==": case "===": return (x) => x === k;
      case "!=": case "!==": return (x) => x !== k;
      case "<": return (x) => x < k;
      case "<=": return (x) => x <= k;
      case ">": return (x) => x > k;
      case ">=": return (x) => x >= k;
    }
  }
  return (x) => {
    const r = simplify(atom, { lookup: (n) => (n === id ? num(x, w, signed ? { signed } : {}) : undefined), width: ctx.width });
    return isConst(r) ? r.v !== 0n : undefined;
  };
}

// ---- output values ------------------------------------------------------------

function outputValue(e: Expr, w: number): OutputValue {
  if (isConst(e)) {
    if (e.name) return e.name;
    if (w === 1) return Number(e.v & 1n);
    if (e.src && /'[sS]?[bBoOhH]/.test(e.src)) return e.src;
    return e.v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(e.v) : formatNum(e);
  }
  return printExpr(e);
}

const sameValue = (a: OutputValue | undefined, b: OutputValue | undefined) => String(a) === String(b);

// ---- the importer ----------------------------------------------------------------

/** Registers in m that look like state registers, most likely first. */
export function stateRegisters(m: Module): string[] {
  const cands = findCandidates(new Ctx(m), makeBlocks(m));
  return cands.filter((x, i) => i === 0 || x.score >= 6).map((x) => x.name);
}

export function extractFsm(m: Module, opts: ImportOptions = {}): ImportResult {
  const c = new Ctx(m);
  const blocks = makeBlocks(m);
  const cands = findCandidates(c, blocks);
  let cand = opts.stateVar ? cands.find((x) => x.name === opts.stateVar) : cands[0];
  if (opts.stateVar && !cand) {
    if (!blocks.some((b) => b.seq && b.writes.has(opts.stateVar!))) throw new VerilogImportError(`"${opts.stateVar}" is not a register written in a clocked always block of module ${m.name}`);
    cand = { name: opts.stateVar, score: 0, values: new Set() };
  }
  if (!cand) throw new VerilogImportError(`No state machine found in module ${m.name}: no register written in a clocked always block takes two or more constant state values`);
  for (const o of cands) if (o !== cand && o.score >= 6 && !opts.stateVar) c.warn(`Register "${o.name}" also looks like a state register; import it with stateVar: "${o.name}"`);
  const R = cand.name;
  const N = cand.next;
  const Rw = c.widths.get(R) ?? 1;
  for (const s of m.skipped) c.warn(`Skipped ${s}`);

  const stateBlocks = blocks.filter((b) => b.seq && b.writes.has(R));
  const { reset, clock } = findReset(c, stateBlocks, R);

  // Follow only what this FSM drives: outputs whose value depends on the state
  // register (directly or through combinational logic), and the logic feeding
  // them. Other FSMs and datapaths in the module are left alone.
  const deps = new Map<string, Set<string>>();
  for (const b of blocks) signalDeps(b.stmt, new Set(), deps);
  const combWritten = new Set(blocks.filter((b) => !b.seq).flatMap((b) => [...b.writes]));
  const blockingSeq = new Set<string>();
  for (const b of blocks) if (b.seq) eachStmt(b.stmt, (x) => { if (x.k === "assign" && !x.nb) lhsBase(x.lhs).forEach((n) => blockingSeq.add(n)); });
  const fromState = new Set([R, ...(N ? [N] : [])]);
  for (let grew = true; grew;) {
    grew = false;
    for (const sig of combWritten) if (!fromState.has(sig) && [...(deps.get(sig) ?? [])].some((x) => fromState.has(x))) { fromState.add(sig); grew = true; }
  }
  const allOutputs = [...m.decls.values()].filter((d) => d.dir === "output" && d.name !== R && d.name !== N).map((d) => d.name);
  const outputs = allOutputs.filter((o) => fromState.has(o) || [...(deps.get(o) ?? [])].some((x) => fromState.has(x)));
  for (const o of allOutputs) if (!outputs.includes(o) && deps.has(o)) c.warn(`Output "${o}" does not depend on "${R}"; it is left out`);
  const needed = new Set([R, ...(N ? [N] : []), ...outputs]);
  for (let grew = true; grew;) {
    grew = false;
    // Combinational signals that do not depend on the state (wire empty = wp == rp)
    // stay as named inputs, which reads better than their expansion.
    for (const sig of [...needed]) for (const x of deps.get(sig) ?? []) if ((fromState.has(x) || blockingSeq.has(x)) && !needed.has(x)) { needed.add(x); grew = true; }
  }
  const comb = orderComb(blocks).filter((b) => [...b.writes].some((w) => needed.has(w)));
  const seq = blocks.filter((b) => b.seq && [...b.writes].some((w) => needed.has(w)));
  const combOut = new Set(outputs.filter((o) => comb.some((b) => b.writes.has(o))));
  const regOut = new Set(outputs.filter((o) => !combOut.has(o) && seq.some((b) => b.writes.has(o))));

  // State constants named in the code, by value.
  const names = new Map<string, string>();
  const pctx: EvalCtx = { lookup: (n) => c.params.get(n), width: (n) => c.widths.get(n) };
  const stateNames = new Set([R, ...(N ? [N] : [])]);
  let oneHotIndex = false;
  const named = (e: Expr) => { if (e.k === "id" && c.params.has(e.name)) return e.name; return undefined; };
  const declaredValues = new Set<string>();
  const addName = (value: bigint, name?: string) => {
    const k = mask(value, Rw).toString();
    declaredValues.add(k);
    if (name && !names.has(k)) names.set(k, name);
  };
  const indexNames: string[] = [];
  for (const b of blocks) {
    eachStmt(b.stmt, (x) => {
      if (x.k === "assign" && x.lhs.k === "id" && stateNames.has(x.lhs.name)) {
        const v = simplify(x.rhs, pctx);
        if (isConst(v)) addName(v.v, named(x.rhs));
      }
      if (x.k === "case" && x.subject.k === "id" && stateNames.has(x.subject.name)) {
        for (const it of x.items) for (const l of it.labels ?? []) { const v = simplify(l, pctx); if (isConst(v)) addName(v.v, named(l)); }
      }
    });
    eachExpr(b.stmt, (e) => subExprs(e, (s) => {
      if (s.k === "bin" && (s.op === "==" || s.op === "!=") && s.a.k === "id" && stateNames.has(s.a.name)) {
        const v = simplify(s.b, pctx);
        if (isConst(v)) addName(v.v, named(s.b));
      }
      if (s.k === "idx" && s.a.k === "id" && stateNames.has(s.a.name) && s.i.k === "id" && c.params.has(s.i.name) && !indexNames.includes(s.i.name)) indexNames.push(s.i.name);
    }));
  }
  const enumType = m.decls.get(R)?.enumType;
  if (enumType) {
    for (const member of m.enums.get(enumType)?.members ?? []) { const v = c.params.get(member); if (v) addName(v.v, member); }
  }
  // One-hot written with indices: state[IDLE], next[S1] = 1'b1.
  if (indexNames.length >= 2 && Rw >= indexNames.length) {
    const idx = indexNames.map((n) => Number(c.params.get(n)!.v));
    if (idx.every((i) => i < Rw) && new Set(idx).size === idx.length) {
      oneHotIndex = true;
      names.clear();
      declaredValues.clear();
      indexNames.forEach((n, i) => addName(1n << BigInt(idx[i]), n));
    }
  }

  // Initial values (FPGA style, no reset): reg [1:0] state = IDLE; or initial state = IDLE;
  let initValue: bigint | undefined;
  const init = m.decls.get(R)?.init;
  if (init) { const v = simplify(init, pctx); if (isConst(v)) initValue = mask(v.v, Rw); }
  for (const a of m.always.filter((x) => x.kind === "initial")) {
    for (const asg of assignsTo(a.body, R)) { const v = simplify(asg.rhs, pctx); if (isConst(v)) initValue = mask(v.v, Rw); }
  }

  const fromPorts = (e: Expr) => {
    let ok = true;
    subExprs(e, (x) => { if (x.k === "call" || (x.k === "id" && m.decls.get(x.name)?.dir !== "input" && !c.params.has(x.name))) ok = false; });
    return ok;
  };
  const fixedBase = new Map<string, Expr>();
  const limit = opts.maxPaths ?? 4096;
  const empty = (): Path => ({ env: new Map(), nb: new Map(), subst: new Map(), assume: new Map(), dom: new Map() });

  // Reset state: run the state register's block with reset asserted.
  let resetValue: bigint | undefined;
  const resetRegOutputs = new Map<string, OutputValue>();
  if (reset) {
    const active = num(reset.activeLow ? 0 : 1, 1);
    const fixed = new Map(fixedBase);
    fixed.set(reset.name, active);
    const eng = new Engine(c, fixed, limit, needed);
    try {
      const runs = eng.run(seq.filter((b) => b.writes.has(R) || [...regOut].some((o) => b.writes.has(o))), [empty()], true);
      const vals = new Set(runs.map((r) => { const v = r.nb.get(R); return v && isConst(v) ? mask(v.v, Rw).toString() : "?"; }));
      if (vals.size === 1 && !vals.has("?")) resetValue = BigInt([...vals][0]);
      if (runs.length) for (const o of regOut) { const v = runs[0].nb.get(o); if (v && isConst(v)) resetRegOutputs.set(o, outputValue(v, c.widths.get(o) ?? 1)); }
    } catch { /* fall back below */ }
    fixedBase.set(reset.name, num(reset.activeLow ? 1 : 0, 1));
  } else {
    c.warn("No reset found for the state register; the diagram uses a default reset signal");
  }
  if (resetValue === undefined) resetValue = initValue;

  // Explore states: everything named in the code plus everything reachable.
  const order: bigint[] = [];
  const seen = new Set<string>();
  const enqueue = (v: bigint) => { const k = v.toString(); if (!seen.has(k)) { seen.add(k); order.push(v); } };
  if (resetValue !== undefined) enqueue(resetValue);
  for (const k of declaredValues) enqueue(BigInt(k));
  if (resetValue === undefined) {
    if (!order.length) throw new VerilogImportError(`Could not determine any state values for "${R}"`);
    c.warn(`Could not find the reset state of "${R}"; using ${names.get(order[0].toString()) ?? order[0]} as the initial state`);
    resetValue = order[0];
  }
  const runsByState = new Map<string, Run[]>();
  for (let i = 0; i < order.length; i++) {
    if (order.length > 256) throw new VerilogImportError(`More than 256 states reached from "${R}"; is it really a state register?`);
    const s = order[i];
    const fixed = new Map(fixedBase);
    fixed.set(R, num(s, Rw));
    let eng = new Engine(c, fixed, limit, needed);
    let paths: Path[];
    try {
      paths = eng.run(seq, eng.run(comb, [empty()], false), true);
    } catch (e) {
      if (!(e instanceof VerilogImportError) || !/^Too many cases/.test(e.message)) throw e;
      // Too many parts to split: keep this state's conditions as written.
      eng = new Engine(c, fixed, limit, needed, true);
      paths = eng.run(seq, eng.run(comb, [empty()], false), true);
      c.warn(`Conditions in state ${names.get(s.toString()) ?? s} have too many parts to simplify; they are kept as written`);
    }
    const runs: Run[] = [];
    for (let p of paths) {
      const ctx = eng.ctx(p);
      let nv = p.nb.get(R) ?? p.env.get(R);
      let next = s;
      if (nv) {
        nv = simplify(nv, ctx);
        if (isConst(nv)) next = mask(nv.v, Rw);
        else if (nv.k === "id" && nv.name === N) c.warn(`"${N}" is not assigned on every path of state ${names.get(s.toString()) ?? s}; assumed to stay`);
        else { c.warn(`Next state of ${names.get(s.toString()) ?? s} is not a constant (${printExpr(nv)}); that case is left out`); continue; }
      }
      // Split 1-bit combinational outputs that still depend on inputs (z = x
      // becomes z=1 on x, z=0 on !x). Values computed from internal data or
      // functions (tx = shreg[0], tx = parity(d)) are shown as written.
      let forks: Path[] = [p];
      for (const o of combOut) {
        if ((c.widths.get(o) ?? 1) !== 1) continue;
        forks = forks.flatMap((q) => {
          const v = q.env.get(o);
          if (!v) return [q];
          const sv = simplify(v, eng.ctx(q));
          if (isConst(sv) || !fromPorts(sv)) return [q];
          return eng.branch(q, sv).map(([r, b]) => { r.env.set(o, num(b ? 1 : 0, 1)); return r; });
        });
      }
      for (const q of forks) {
        const qctx = eng.ctx(q);
        const combVals = new Map<string, OutputValue>();
        for (const o of combOut) { const v = q.env.get(o); if (v) combVals.set(o, outputValue(simplify(v, qctx), c.widths.get(o) ?? 1)); }
        const regVals = new Map<string, OutputValue | undefined>();
        for (const o of regOut) { const v = q.nb.get(o); regVals.set(o, v ? outputValue(simplify(v, qctx), c.widths.get(o) ?? 1) : undefined); }
        runs.push({ assume: q.assume, next, comb: combVals, reg: regVals });
        enqueue(next);
      }
    }
    runsByState.set(s.toString(), runs);
  }

  // ---- names ----
  const stateName = new Map<string, string>();
  const used = new Set<string>();
  for (const v of order) {
    const k = v.toString();
    let n = names.get(k) ?? (oneHotIndex ? `S_${v.toString(2).padStart(Rw, "0")}` : `S${v}`);
    if (!IDENT.test(n)) n = `S${v}`;
    while (used.has(n)) n += "_";
    used.add(n);
    stateName.set(k, n);
  }

  // ---- Moore or Mealy, per output ----
  const moore = new Set<string>();
  const mealy = new Set<string>();
  const mooreValue = new Map<string, Map<string, OutputValue>>(); // state -> output -> value
  const setMoore = (state: string, o: string, v: OutputValue) => {
    const mm = mooreValue.get(state) ?? new Map<string, OutputValue>();
    mm.set(o, v);
    mooreValue.set(state, mm);
  };
  for (const o of combOut) {
    let same = true;
    for (const runs of runsByState.values()) {
      const vals = runs.filter((r) => r.comb.has(o)).map((r) => r.comb.get(o));
      if (vals.some((v) => !sameValue(v, vals[0]))) { same = false; break; }
    }
    if (same) {
      moore.add(o);
      for (const [k, runs] of runsByState) { const r = runs.find((x) => x.comb.has(o)); if (r) setMoore(k, o, r.comb.get(o)!); }
    } else mealy.add(o);
  }
  for (const o of regOut) {
    const byDest = new Map<string, OutputValue[]>();
    for (const runs of runsByState.values()) for (const r of runs) {
      const v = r.reg.get(o);
      if (v === undefined) continue;
      const k = r.next.toString();
      byDest.set(k, [...(byDest.get(k) ?? []), v]);
    }
    const rv = resetRegOutputs.get(o);
    if (rv !== undefined) byDest.set(resetValue.toString(), [...(byDest.get(resetValue.toString()) ?? []), rv]);
    const consistent = [...byDest.values()].every((vs) => vs.every((v) => sameValue(v, vs[0])));
    if (consistent) {
      if (!byDest.size) continue;
      moore.add(o);
      for (const [k, vs] of byDest) setMoore(k, o, vs[0]);
    } else {
      mealy.add(o);
      c.warn(`Registered output "${o}" changes with the transition taken, so it is shown on transitions (it updates one clock after the transition)`);
    }
  }
  const machine = mealy.size ? "mealy" : "moore";

  // ---- signals ----
  const internal = new Set<string>();
  const d = createDiagram({
    name: IDENT.test(m.name) ? m.name : "fsm",
    type: machine,
    clock: { name: IDENT.test(clock) ? clock : "clk" },
    reset: reset && IDENT.test(reset.name) ? reset : DEFAULT_RESET,
  });
  const defaults = new Map<string, OutputValue>();
  const allOut = outputs.filter((o) => moore.has(o) || mealy.has(o));
  for (const o of allOut) {
    // The most common value is the output's default.
    const counts = new Map<string, { v: OutputValue; n: number }>();
    const bump = (v: OutputValue | undefined) => { if (v === undefined) return; const k = String(v); const e = counts.get(k) ?? { v, n: 0 }; e.n++; counts.set(k, e); };
    for (const [k, runs] of runsByState) {
      if (moore.has(o)) bump(mooreValue.get(k)?.get(o));
      else for (const r of runs) bump(combOut.has(o) ? r.comb.get(o) : r.reg.get(o));
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    if (best) defaults.set(o, best.v);
  }

  // ---- transitions ----
  // Labels stay short: with several Mealy outputs (or more than three Moore
  // outputs) only values that differ from the output's default are drawn, and
  // the default is recorded on the signal.
  const trimMealy = mealyOutputsCount(outputs, mealy) >= 2;
  const trimMoore = mooreOutputsCount(outputs, moore) > 3;
  const trimmed = (o: string) => (mealy.has(o) ? trimMealy : trimMoore);
  const keep = (o: string, v: OutputValue | undefined) => v !== undefined && (!trimmed(o) || !sameValue(v, defaults.get(o)));
  const mealyList = allOut.filter((o) => mealy.has(o));
  const mooreList = allOut.filter((o) => moore.has(o));
  interface Group { next: bigint; outs: Record<string, OutputValue>; runs: Run[] }
  const transitionsOf = new Map<string, Array<{ to: bigint; condition: string; outputs: Record<string, OutputValue> }>>();
  for (const [k, runs] of runsByState) {
    const groups = new Map<string, Group>();
    for (const r of runs) {
      const outs: Record<string, OutputValue> = {};
      for (const o of mealyList) {
        const v = combOut.has(o) ? r.comb.get(o) : r.reg.get(o);
        if (keep(o, v)) outs[o] = v!;
      }
      const key = `${r.next}|${JSON.stringify(outs)}`;
      const g = groups.get(key) ?? { next: r.next, outs, runs: [] };
      g.runs.push(r);
      groups.set(key, g);
    }
    const conds = conditions([...groups.values()].map((g) => g.runs), runs, c, internal);
    // (A group no input value can reach has no condition: leave it out rather
    // than draw it as an unconditional transition.)
    const list = [...groups.values()].flatMap((g, i) => (conds[i] === undefined ? [] : [{ to: g.next, condition: conds[i]!, outputs: g.outs }]));
    transitionsOf.set(k, list);
  }

  for (const s of d.inputs) void s;
  for (const decl of m.decls.values()) {
    if (decl.dir !== "input" || decl.name === clock || decl.name === reset?.name) continue;
    tryAdd(d, "inputs", decl.name, c.widths.get(decl.name) ?? 1, c);
  }
  for (const n of internal) {
    if (d.inputs.some((s) => s.name === n) || n === R) continue;
    if (tryAdd(d, "inputs", n, c.widths.get(n) ?? 1, c)) c.warn(`Internal signal "${n}" is used in transition conditions; it is listed with the inputs`);
  }
  for (const o of allOut) {
    const w = c.widths.get(o) ?? 1;
    const def = defaults.get(o);
    try { addSignal(d, "outputs", { name: o, width: w, ...(def !== undefined && trimmed(o) ? { default: def } : {}) }); }
    catch (e) { c.warn(`Output "${o}" left out: ${(e as Error).message}`); }
  }

  // ---- states and transitions ----
  const stateCodes: Record<string, string> = {};
  const ids = new Map<string, string>();
  for (const v of order) {
    const k = v.toString();
    const name = stateName.get(k)!;
    const outs: Record<string, OutputValue> = {};
    for (const o of mooreList) {
      const val = mooreValue.get(k)?.get(o);
      if (keep(o, val) && d.outputs.some((x) => x.name === o)) outs[o] = val!;
    }
    const st = addState(d, { name, isInitial: v === resetValue, outputs: outs });
    ids.set(k, st.id);
    stateCodes[name] = `${Rw}'b${v.toString(2).padStart(Rw, "0")}`;
  }
  for (const v of order) {
    const k = v.toString();
    for (const t of transitionsOf.get(k) ?? []) {
      const self = t.to === v;
      if (self && opts.selfLoops === false && !Object.keys(t.outputs).length) continue;
      const outs = Object.fromEntries(Object.entries(t.outputs).filter(([o]) => d.outputs.some((x) => x.name === o)));
      addTransition(d, { from: ids.get(k)!, to: ids.get(t.to.toString())!, condition: t.condition, outputs: outs });
    }
  }

  fitStateSizes(d);

  const blockCount = new Set(blocks.filter((b) => b.writes.has(R) || (N && b.writes.has(N)) || allOut.some((o) => b.writes.has(o))).filter((b) => b.always)).size;
  const assigns = blocks.filter((b) => !b.always && allOut.some((o) => b.writes.has(o))).length;
  const style = `${blockCount} always block${blockCount === 1 ? "" : "s"}${assigns ? ` + ${assigns} assign${assigns === 1 ? "" : "s"}` : ""}`;

  return {
    diagram: d,
    module: m.name,
    machine,
    stateVar: R,
    ...(N ? { nextVar: N } : {}),
    style,
    stateCodes,
    mooreOutputs: mooreList,
    mealyOutputs: mealyList,
    constants: namedConstants(d, c),
    warnings: c.warnings,
  };
}

function namedConstants(d: FsmDiagram, c: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  const texts = [
    ...d.states.flatMap((s) => Object.values(s.outputs)),
    ...d.transitions.flatMap((t) => [t.condition, ...Object.values(t.outputs)]),
  ].filter((v): v is string => typeof v === "string");
  for (const t of texts) for (const id of t.match(/[A-Za-z_]\w*/g) ?? []) if (c.params.has(id)) out[id] = formatNum({ ...c.params.get(id)!, src: undefined, name: undefined });
  return out;
}

const mealyOutputsCount = (outputs: string[], mealy: Set<string>) => outputs.filter((o) => mealy.has(o)).length;
const mooreOutputsCount = (outputs: string[], moore: Set<string>) => outputs.filter((o) => moore.has(o)).length;

function tryAdd(d: FsmDiagram, kind: "inputs" | "outputs", name: string, width: number, c: Ctx): boolean {
  try { addSignal(d, kind, { name, width }); return true; }
  catch (e) { c.warn(`Signal "${name}" left out: ${(e as Error).message}`); return false; }
}

// ---- conditions ---------------------------------------------------------------------

/**
 * One condition string per group. Each group is a set of runs; the runs of a
 * state partition its input space, so the conditions are mutually exclusive.
 * undefined for a group that no input value reaches (all its runs turn out
 * impossible once every assumption is checked together): its condition would
 * be the empty one, which means "always".
 */
function conditions(groups: Run[][], all: Run[], c: Ctx, internal: Set<string>): Array<string | undefined> {
  if (groups.length === 1) return [""];
  const atoms: Assumption["atom"][] = [];
  const keys: string[] = [];
  const index = new Map<string, number>();
  for (const r of all) for (const [k, a] of r.assume) if (!index.has(k)) { index.set(k, keys.length); keys.push(k); atoms.push(a.atom); }
  for (const a of atoms) for (const n of freeIds(a)) if (!c.params.has(n)) internal.add(n);
  const lit = (i: number, val: boolean) => {
    if (val) return printExpr(atoms[i]);
    const neg = simplify({ k: "un", op: "!", a: atoms[i] }, { lookup: () => undefined, width: (n) => c.widths.get(n) });
    return printExpr(neg);
  };
  const fmt = (cubes: Array<Array<[number, boolean]>>) => {
    if (cubes.some((cu) => cu.length === 0)) return "";
    const parts = cubes.map((cu) => cu.map(([i, v]) => lit(i, v)).join(" && "));
    return parts.length === 1 ? parts[0] : parts.map((p, i) => (cubes[i].length > 1 ? `(${p})` : p)).join(" || ");
  };
  const k = keys.length;
  if (k <= 10) {
    const dummy: Path = { env: new Map(), nb: new Map(), subst: new Map(), assume: new Map() };
    const ctx: EvalCtx = { lookup: () => undefined, width: (n) => c.widths.get(n) };
    const on: number[][] = groups.map(() => []);
    const dc: number[] = [];
    for (let m = 0; m < 1 << k; m++) {
      const val = (i: number) => ((m >> (k - 1 - i)) & 1) === 1;
      const assume = new Map<string, Assumption>(keys.map((key, i) => [key, { atom: atoms[i], val: val(i) }]));
      if (!feasible({ ...dummy, assume }, c, ctx)) { dc.push(m); continue; }
      const gi = groups.findIndex((g) => g.some((r) => [...r.assume].every(([key, a]) => assume.get(key)!.val === a.val)));
      if (gi < 0) dc.push(m);
      else on[gi].push(m);
    }
    const reached = on.filter((o) => o.length).length;
    return groups.map((_, gi) => {
      if (!on[gi].length && reached) return undefined;
      const others = on.some((o, j) => j !== gi && o.length);
      if (!others) return "";
      const cubes = minimize(k, on[gi], dc);
      return fmt(cubes.map((cu) => {
        const ls: Array<[number, boolean]> = [];
        for (let i = 0; i < k; i++) { const b = 1 << (k - 1 - i); if (cu.care & b) ls.push([i, (cu.val & b) !== 0]); }
        return ls;
      }));
    });
  }
  // Too many atoms to minimise exactly: list the runs' cubes, without the
  // literals that an equality in the same cube already decides (op == 8'd4
  // makes op != 8'd0 ... op != 8'd3 redundant, and a case with many labels
  // would otherwise repeat every earlier label in every later one).
  const ctx: EvalCtx = { lookup: () => undefined, width: (n) => c.widths.get(n) };
  return groups.map((g) => fmt(g.map((r) => {
    const cube = [...r.assume].map(([key, a]): [number, boolean] => [index.get(key)!, a.val]);
    const eq = new Map<string, { at: number; value: Num }>();
    for (const [i, v] of cube) { const a = atoms[i]; if (v && a.k === "bin" && (a.op === "==" || a.op === "===") && a.a.k === "id" && isConst(a.b)) eq.set(a.a.name, { at: i, value: a.b }); }
    if (!eq.size) return cube;
    return cube.filter(([i, v]) => {
      const ids = [...freeIds(atoms[i])];
      const known = ids.length === 1 ? eq.get(ids[0]) : undefined;
      if (!known || known.at === i) return true;
      const w = c.widths.get(ids[0]) ?? known.value.w ?? 32;
      const r = simplify(atoms[i], { ...ctx, lookup: (n) => (n === ids[0] ? num(known.value.v, w) : undefined) });
      return !(isConst(r) && (r.v !== 0n) === v);
    });
  })));
}
