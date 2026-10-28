// A forgiving parser for the subset of Verilog-2001 / SystemVerilog that FSMs
// are written in: module headers and ports, declarations, parameters,
// localparams, `define constants, enums, continuous assigns and always blocks
// with begin/end, if/else and case/casez/casex. Anything else (instances,
// functions, generate blocks, loops) is skipped and reported.

import { tokenize, preprocess, VerilogSyntaxError } from "./lexer.ts";
import type { Token } from "./lexer.ts";
import { num, parseNumber } from "./expr.ts";
import type { Expr } from "./expr.ts";

export type Stmt =
  | { k: "block"; body: Stmt[] }
  | { k: "assign"; lhs: Expr; rhs: Expr; nb: boolean; line: number }
  | { k: "if"; c: Expr; t: Stmt; e?: Stmt; line: number }
  | { k: "case"; kind: "case" | "casez" | "casex"; subject: Expr; items: CaseItem[]; line: number }
  | { k: "skip"; what: string; line: number };

export interface CaseItem {
  labels: Expr[] | null; // null = default
  body: Stmt;
}

export interface Range {
  msb: Expr;
  lsb: Expr;
}

export interface Decl {
  name: string;
  dir?: "input" | "output" | "inout";
  range?: Range;
  /** Fixed width for types like integer (32) or a typedef'd enum. */
  width?: number;
  enumType?: string;
  init?: Expr;
  line: number;
}

export interface Param {
  name: string;
  value: Expr;
  range?: Range;
  local: boolean;
  line: number;
  /** "define" for a `define constant, "enum" for an enum member. */
  origin: "param" | "define" | "enum";
  enumType?: string;
}

export interface EnumType {
  name: string;
  range?: Range;
  members: string[];
}

export interface Sensitivity {
  edge: "posedge" | "negedge" | null;
  sig: string;
}

export interface Always {
  kind: "always" | "always_ff" | "always_comb" | "always_latch" | "initial";
  star: boolean;
  sens: Sensitivity[];
  body: Stmt;
  line: number;
}

export interface ContAssign {
  lhs: Expr;
  rhs: Expr;
  line: number;
}

export interface Module {
  name: string;
  line: number;
  ports: string[];
  decls: Map<string, Decl>;
  params: Param[];
  enums: Map<string, EnumType>;
  always: Always[];
  assigns: ContAssign[];
  /** Constructs that were skipped, for warnings. */
  skipped: string[];
  /** Syntax errors that made the parser skip code (they are in skipped too). */
  errors: string[];
}

export interface SourceFile {
  modules: Module[];
}

const UNARY = new Set(["!", "~", "-", "+", "&", "|", "^", "~&", "~|", "~^", "^~"]);
const BINARY_PREC: Record<string, number> = {
  "||": 1, "&&": 2, "|": 3, "^": 4, "~^": 4, "^~": 4, "&": 5,
  "==": 6, "!=": 6, "===": 6, "!==": 6, "==?": 6, "!=?": 6,
  "<": 7, "<=": 7, ">": 7, ">=": 7,
  "<<": 8, ">>": 8, "<<<": 8, ">>>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10, "**": 11,
};
const NET_TYPES = new Set(["wire", "reg", "logic", "bit", "var", "tri", "wand", "wor", "supply0", "supply1", "uwire", "tri0", "tri1"]);
const INT_TYPES: Record<string, number> = { integer: 32, int: 32, shortint: 16, longint: 64, byte: 8, genvar: 32, time: 64 };
const SKIP_BLOCKS: Record<string, string> = {
  function: "endfunction", task: "endtask", generate: "endgenerate", specify: "endspecify",
  covergroup: "endgroup", property: "endproperty", sequence: "endsequence", clocking: "endclocking",
  interface: "endinterface", program: "endprogram", class: "endclass", checker: "endchecker",
};

const PROCEDURAL = new Set(["always", "always_ff", "always_comb", "always_latch", "initial", "final"]);
const ITEM_START = new Set([
  ...PROCEDURAL, "assign", "module", "macromodule", "endmodule", "package", "endpackage", "parameter", "localparam",
  "typedef", "input", "output", "inout", "function", "task", "generate",
]);

export function parseVerilog(source: string): SourceFile {
  // Only a body that parses as a whole expression keeps its name; anything
  // else is expanded as text where it is used, as a Verilog compiler would.
  const isExpr = (body: string) => { try { parseExpression(body); return true; } catch { return false; } };
  const pre = preprocess(source, isExpr);
  const p = new Parser(tokenize(pre.text));
  const globals: Param[] = [];
  for (const [name, body] of pre.constants) globals.push({ name, value: parseExpression(body), local: true, line: 0, origin: "define" });
  return p.file(globals);
}

/** Parse a single expression (used for transition conditions in tests and tools). */
export function parseExpression(text: string): Expr {
  const p = new Parser(tokenize(text));
  const e = p.expr();
  if (!p.done()) throw new VerilogSyntaxError(`unexpected "${p.peek().text}" in expression`);
  return e;
}

class Parser {
  private i = 0;
  private toks: Token[];
  constructor(toks: Token[]) { this.toks = toks; }

  done() { return this.i >= this.toks.length; }
  peek(o = 0): Token { return this.toks[this.i + o] ?? { kind: "op", text: "<eof>", line: this.toks[this.toks.length - 1]?.line ?? 0 }; }
  private next(): Token {
    const t = this.peek();
    if (this.done()) throw new VerilogSyntaxError("unexpected end of file", t.line);
    this.i++;
    return t;
  }
  private is(text: string, o = 0) { const t = this.peek(o); return t.text === text && t.kind !== "str"; }
  private accept(text: string) { if (this.is(text)) { this.i++; return true; } return false; }
  private expect(text: string): Token {
    const t = this.peek();
    if (!this.is(text)) throw new VerilogSyntaxError(`expected "${text}" but found "${t.text}"`, t.line);
    this.i++;
    return t;
  }
  private ident(): string {
    const t = this.next();
    if (t.kind !== "id") throw new VerilogSyntaxError(`expected a name but found "${t.text}"`, t.line);
    // pkg::name -> name
    if (this.is("::")) { this.i++; return this.ident(); }
    return t.text;
  }

  /** Skip to just past the next `;` at bracket depth 0. */
  private skipStatement() {
    let depth = 0;
    while (!this.done()) {
      const t = this.next().text;
      if (t === "(" || t === "[" || t === "{" || t === "'{") depth++;
      else if (t === ")" || t === "]" || t === "}") depth--;
      else if (t === ";" && depth <= 0) return;
    }
  }
  private skipUntil(end: string) {
    while (!this.done() && !this.is(end)) this.i++;
    this.accept(end);
    if (this.accept(":")) this.i++;
  }
  private skipParens() {
    if (!this.is("(")) return;
    let depth = 0;
    do {
      const t = this.next().text;
      if (t === "(") depth++;
      else if (t === ")") depth--;
    } while (depth > 0 && !this.done());
  }

  file(globals: Param[]): SourceFile {
    const modules: Module[] = [];
    const shared: Module = emptyModule("$unit", 0);
    shared.params.push(...globals);
    while (!this.done()) {
      const t = this.peek();
      if (t.text === "module" || t.text === "macromodule") {
        this.i++;
        const m = this.module(shared);
        modules.push(m);
      } else if (t.text === "package") {
        this.i++;
        this.ident();
        this.accept(";");
        this.items(shared, "endpackage");
      } else if (t.text in SKIP_BLOCKS) {
        this.i++;
        this.skipUntil(SKIP_BLOCKS[t.text]);
      } else if (["typedef", "localparam", "parameter", "import"].includes(t.text)) {
        this.item(shared);
      } else {
        this.i++;
      }
    }
    return { modules };
  }

  private module(shared: Module): Module {
    const nameTok = this.peek();
    this.accept("static") || this.accept("automatic");
    const m = emptyModule(this.ident(), nameTok.line);
    m.params.push(...shared.params);
    for (const [k, v] of shared.enums) m.enums.set(k, v);
    while (this.is("import")) this.skipStatement();
    if (this.accept("#")) {
      this.expect("(");
      this.paramList(m, ")");
      this.expect(")");
    }
    if (this.accept("(")) {
      this.portList(m);
      this.expect(")");
    }
    this.expect(";");
    this.items(m, "endmodule");
    return m;
  }

  private paramList(m: Module, end: string) {
    let local = false;
    // The type and range of a list apply to every name in it
    // (localparam [1:0] X = 0, Y = ~0: Y is 2'b11), up to the next keyword.
    let range: Range | undefined;
    while (!this.is(end) && !this.done()) {
      if (this.accept("parameter")) { local = false; range = undefined; }
      else if (this.accept("localparam")) { local = true; range = undefined; }
      range = this.oneParam(m, local, range);
      if (!this.accept(",")) break;
    }
  }

  /** One `[type] [signed] [range] NAME = value`; returns the range for the names after it. */
  private oneParam(m: Module, local: boolean, listRange: Range | undefined): Range | undefined {
    if (this.is("type")) { this.skipStatement(); return undefined; }
    let range = listRange;
    let typed = false;
    const newType = () => { if (!typed) { typed = true; range = undefined; } };
    for (;;) {
      const t = this.peek();
      if (t.kind === "id" && (NET_TYPES.has(t.text) || t.text in INT_TYPES || t.text === "signed" || t.text === "unsigned" || t.text === "real")) { newType(); this.i++; continue; }
      if (t.kind === "id" && this.peek(1).kind === "id") { newType(); this.i++; continue; } // user type
      if (this.is("[")) { newType(); range = this.range(); continue; }
      break;
    }
    const tok = this.peek();
    const name = this.ident();
    while (this.is("[")) this.range();
    this.expect("=");
    const value = this.expr();
    m.params.push({ name, value, range, local, line: tok.line, origin: "param" });
    return range;
  }

  private range(): Range {
    this.expect("[");
    const msb = this.expr();
    if (this.accept(":")) {
      const lsb = this.expr();
      this.expect("]");
      return { msb, lsb };
    }
    this.expect("]");
    // [N] (an unpacked size) means N entries: [N-1:0].
    return { msb: { k: "bin", op: "-", a: msb, b: num(1) }, lsb: num(0) };
  }

  private portList(m: Module) {
    let dir: Decl["dir"];
    let range: Range | undefined;
    let enumType: string | undefined;
    let width: number | undefined;
    while (!this.is(")") && !this.done()) {
      const start = this.peek();
      let sawType = false;
      if (start.text === "input" || start.text === "output" || start.text === "inout") {
        dir = start.text;
        this.i++;
        range = undefined; enumType = undefined; width = undefined; sawType = true;
      }
      for (;;) {
        const t = this.peek();
        if (t.kind !== "id") break;
        if (NET_TYPES.has(t.text) || t.text === "signed" || t.text === "unsigned") { this.i++; sawType = true; continue; }
        if (t.text in INT_TYPES) { width = INT_TYPES[t.text]; this.i++; sawType = true; continue; }
        if (this.is("::", 1) && this.peek(2).kind === "id") { this.i += 2; continue; } // pkg::type
        if (this.peek(1).kind === "id" || (this.peek(1).text === "[" && m.enums.has(t.text))) {
          enumType = m.enums.has(t.text) ? t.text : undefined;
          this.i++;
          sawType = true;
          continue;
        }
        break;
      }
      if (this.is("[")) { range = this.range(); sawType = true; }
      if (this.is(".")) { this.skipToComma(); continue; }
      const tok = this.peek();
      const name = this.ident();
      while (this.is("[")) this.range();
      let init: Expr | undefined;
      if (this.accept("=")) init = this.expr();
      if (!sawType && !dir) {
        m.ports.push(name); // non-ANSI: declared in the body
      } else {
        m.ports.push(name);
        m.decls.set(name, { name, dir, range, width, enumType, init, line: tok.line });
      }
      if (!this.accept(",")) break;
    }
  }

  private skipToComma() {
    let depth = 0;
    while (!this.done()) {
      const t = this.peek().text;
      if (depth === 0 && (t === "," || t === ")")) { this.accept(","); return; }
      if (t === "(") depth++;
      if (t === ")") depth--;
      this.i++;
    }
  }

  private items(m: Module, end: string) {
    while (!this.done() && !this.is(end)) {
      // The next module starts before this one ended: stop here, or the next
      // module's blocks would be read as this one's.
      if (this.is("module") || this.is("macromodule") || this.is("package")) {
        m.skipped.push(`line ${this.peek().line}: "${this.peek().text}" before "${end}" of ${m.name}`);
        return;
      }
      const at = this.i;
      try {
        this.item(m);
      } catch (e) {
        if (!(e instanceof VerilogSyntaxError)) throw e;
        m.skipped.push(e.message);
        m.errors.push(e.message);
        this.i = at;
        // A broken always block holds statements of its own: resyncing at the
        // next `;` would land inside it and read the rest of it as module
        // items (`instance of else`), so skip to the next module item instead.
        if (PROCEDURAL.has(this.peek().text)) this.skipToItem(end);
        else this.skipStatement();
      }
      if (this.i === at) this.i++;
    }
    if (this.done()) m.skipped.push(`line ${this.peek().line}: "${end}" of ${m.name} missing at the end of the file`);
    this.accept(end);
    if (this.accept(":")) this.i++;
  }

  /** Skip past the current token to the next keyword that starts a module item. */
  private skipToItem(end: string) {
    this.i++;
    while (!this.done()) {
      const t = this.peek();
      if (t.kind === "id" && (t.text === end || ITEM_START.has(t.text) || NET_TYPES.has(t.text) || t.text in INT_TYPES)) return;
      this.i++;
    }
  }

  /**
   * At a keyword that cannot be inside a statement: an unclosed begin or case
   * ran into the next always block, so the error is reported where it opened.
   */
  private atItem() {
    const t = this.peek();
    return t.kind === "id" && (PROCEDURAL.has(t.text) || t.text === "endmodule" || t.text === "module" || t.text === "macromodule" || t.text === "endpackage");
  }

  private item(m: Module) {
    const t = this.peek();
    const w = t.text;
    if (t.kind !== "id") {
      if (w === ";") { this.i++; return; }
      this.skipStatement();
      return;
    }
    if (w === "input" || w === "output" || w === "inout") return this.declaration(m, w);
    if (NET_TYPES.has(w) || w in INT_TYPES || w === "signed") return this.declaration(m);
    if (w === "parameter" || w === "localparam") {
      this.i++;
      this.paramList(m, ";");
      this.expect(";");
      return;
    }
    if (w === "typedef") return this.typedef(m);
    if (w === "enum") return this.declaration(m);
    if (w === "assign") {
      this.i++;
      if (this.is("#")) this.delay();
      do {
        const lhs = this.lvalue();
        this.expect("=");
        m.assigns.push({ lhs, rhs: this.expr(), line: t.line });
      } while (this.accept(","));
      this.expect(";");
      return;
    }
    if (w === "always" || w === "always_ff" || w === "always_comb" || w === "always_latch" || w === "initial") return this.always(m, w);
    if (w in SKIP_BLOCKS) {
      this.i++;
      m.skipped.push(`${w} (line ${t.line})`);
      this.skipUntil(SKIP_BLOCKS[w]);
      return;
    }
    if (w === "if" || w === "for" || w === "case" || w === "begin") {
      m.skipped.push(`generate ${w} (line ${t.line})`);
      this.stmt();
      return;
    }
    // import pkg::*; the package's constants and types are already known.
    if (w === "import") { this.skipStatement(); return; }
    if (m.enums.has(w) && this.peek(1).kind === "id") return this.declaration(m);
    // pkg::state_t s, n;
    if (this.is("::", 1) && m.enums.has(this.peek(2).text) && (this.peek(3).kind === "id" || this.is("[", 3))) return this.declaration(m);
    if (this.peek(1).kind === "id" || this.peek(1).text === "#") {
      m.skipped.push(`instance of ${w} (line ${t.line})`);
    }
    this.skipStatement();
  }

  private typedef(m: Module) {
    const line = this.peek().line;
    this.expect("typedef");
    if (!this.is("enum")) { this.skipStatement(); return; }
    const e = this.enumBody(m);
    const name = this.ident();
    this.expect(";");
    e.name = name;
    m.enums.set(name, e);
    for (const p of m.params) if (p.enumType === "") p.enumType = name;
    void line;
  }

  /** enum [base type] { A, B = expr, ... } — adds members as constants. */
  private enumBody(m: Module): EnumType {
    this.expect("enum");
    let range: Range | undefined;
    while (this.peek().kind === "id" && !this.is("{")) {
      const t = this.next().text;
      if (t in INT_TYPES) range = { msb: num(INT_TYPES[t] - 1), lsb: num(0) };
    }
    if (this.is("[")) range = this.range();
    this.expect("{");
    const members: string[] = [];
    let prev: Expr | undefined;
    while (!this.is("}")) {
      const tok = this.peek();
      const name = this.ident();
      let value: Expr;
      if (this.accept("=")) value = this.expr();
      else value = prev ? { k: "bin", op: "+", a: { k: "id", name: members[members.length - 1] }, b: num(1) } : num(0);
      prev = value;
      members.push(name);
      m.params.push({ name, value, range, local: true, line: tok.line, origin: "enum", enumType: "" });
      if (!this.accept(",")) break;
    }
    this.expect("}");
    return { name: "", range: range ?? { msb: num(31), lsb: num(0) }, members };
  }

  private declaration(m: Module, dir?: "input" | "output" | "inout") {
    if (dir) this.i++;
    let range: Range | undefined;
    let width: number | undefined;
    let enumType: string | undefined;
    for (;;) {
      const t = this.peek();
      if (t.kind !== "id") break;
      if (NET_TYPES.has(t.text) || t.text === "signed" || t.text === "unsigned" || t.text === "automatic" || t.text === "static") { this.i++; continue; }
      if (t.text in INT_TYPES) { width = INT_TYPES[t.text]; this.i++; continue; }
      if (t.text === "enum") {
        const e = this.enumBody(m);
        const anon = `$enum${m.enums.size}`;
        e.name = anon;
        m.enums.set(anon, e);
        for (const p of m.params) if (p.enumType === "") p.enumType = anon;
        enumType = anon;
        continue;
      }
      if (this.is("::", 1) && this.peek(2).kind === "id") { this.i += 2; continue; } // pkg::type: the type is what counts
      if (m.enums.has(t.text) && (this.peek(1).kind === "id" || this.peek(1).text === "[")) { enumType = t.text; this.i++; continue; }
      break;
    }
    if (this.is("[")) range = this.range();
    do {
      const tok = this.peek();
      const name = this.ident();
      while (this.is("[")) this.range(); // unpacked dimensions
      let init: Expr | undefined;
      if (this.accept("=")) init = this.expr();
      const old = m.decls.get(name);
      // `output z; reg z;` declares one signal in two steps.
      m.decls.set(name, {
        name,
        dir: dir ?? old?.dir,
        range: range ?? old?.range,
        width: width ?? old?.width,
        enumType: enumType ?? old?.enumType,
        init: init ?? old?.init,
        line: old?.line ?? tok.line,
      });
      // A net declared with a value (`wire w = a & b;`) is a continuous assignment.
      if (init && !dir && this.isNetInit(tok)) m.assigns.push({ lhs: { k: "id", name }, rhs: init, line: tok.line });
    } while (this.accept(","));
    this.expect(";");
  }

  private isNetInit(nameTok: Token): boolean {
    // Look back for the declaration keyword: wire/tri -> continuous, reg/logic -> initial value.
    for (let j = this.toks.indexOf(nameTok) - 1; j >= 0; j--) {
      const t = this.toks[j].text;
      if (t === ";") return false;
      if (t === "wire" || t === "tri" || t === "uwire") return true;
      if (t === "reg" || t === "logic" || t === "bit" || t === "var" || t === "integer") return false;
    }
    return false;
  }

  private always(m: Module, kind: Always["kind"]) {
    const line = this.next().line;
    let star = kind === "always_comb" || kind === "always_latch";
    const sens: Sensitivity[] = [];
    if (this.accept("@")) {
      if (this.accept("*")) star = true;
      else if (this.peek().kind === "id") sens.push({ edge: null, sig: this.ident() });
      else {
        this.expect("(");
        if (this.accept("*")) star = true;
        else {
          do {
            let edge: Sensitivity["edge"] = null;
            if (this.accept("posedge")) edge = "posedge";
            else if (this.accept("negedge")) edge = "negedge";
            const e = this.expr();
            sens.push({ edge, sig: e.k === "id" ? e.name : e.k === "idx" && e.a.k === "id" ? e.a.name : "?" });
          } while (this.accept("or") || this.accept(","));
        }
        this.expect(")");
      }
    }
    const body = this.stmt();
    m.always.push({ kind, star: star || (kind !== "initial" && sens.length > 0 && sens.every((s) => !s.edge)), sens, body, line });
  }

  private delay() {
    this.expect("#");
    if (this.is("(")) this.skipParens();
    else this.next();
  }

  // ---- statements ---------------------------------------------------------

  stmt(): Stmt {
    const t = this.peek();
    const w = t.kind === "id" || t.kind === "op" ? t.text : "";
    if (w === "begin" || w === "fork") {
      this.i++;
      if (this.accept(":")) this.ident();
      const body: Stmt[] = [];
      const end = w === "begin" ? ["end"] : ["join", "join_any", "join_none"];
      while (!end.includes(this.peek().text)) {
        if (this.done() || this.atItem()) throw new VerilogSyntaxError(`"${w}" without "${end[0]}"`, t.line);
        // Local declarations inside a block.
        if (this.peek().kind === "id" && (NET_TYPES.has(this.peek().text) || this.peek().text in INT_TYPES)) { this.skipStatement(); continue; }
        body.push(this.stmt());
      }
      this.i++;
      if (this.accept(":")) this.ident();
      return { k: "block", body };
    }
    if (w === "unique" || w === "unique0" || w === "priority") { this.i++; return this.stmt(); }
    if (w === "if") {
      this.i++;
      this.expect("(");
      const c = this.expr();
      this.expect(")");
      const thenS = this.stmt();
      let elseS: Stmt | undefined;
      if (this.accept("else")) elseS = this.stmt();
      return { k: "if", c, t: thenS, e: elseS, line: t.line };
    }
    if (w === "case" || w === "casez" || w === "casex") {
      this.i++;
      this.expect("(");
      const subject = this.expr();
      this.expect(")");
      const inside = this.accept("inside");
      const items: Array<{ labels: Array<Expr | ValueRange> | null; body: Stmt }> = [];
      while (!this.accept("endcase")) {
        if (this.done() || this.atItem()) throw new VerilogSyntaxError(`"${w}" without "endcase"`, t.line);
        if (this.accept("default")) {
          this.accept(":");
          items.push({ labels: null, body: this.stmt() });
          continue;
        }
        const labels: Array<Expr | ValueRange> = [];
        do labels.push(inside ? this.insideItem() : this.expr()); while (this.accept(","));
        this.expect(":");
        items.push({ labels, body: this.stmt() });
      }
      // A [lo:hi] label of `case (x) inside` matches a range, which a case
      // label compared for equality cannot say, so such a case becomes
      // case (1'b1) with each label turned into its condition.
      if (items.some((it) => it.labels?.some((l) => "lo" in l))) {
        const labels = (ls: Array<Expr | ValueRange> | null) => ls && ls.map((l) => insideMatch(subject, l));
        return { k: "case", kind: w, subject: num(1, 1), items: items.map((it) => ({ labels: labels(it.labels), body: it.body })), line: t.line };
      }
      return { k: "case", kind: w, subject, items: items as CaseItem[], line: t.line };
    }
    if (w === "for" || w === "while" || w === "repeat" || w === "foreach") {
      this.i++;
      this.skipParens();
      this.stmt();
      return { k: "skip", what: `${w} loop`, line: t.line };
    }
    if (w === "do") {
      this.i++;
      this.stmt();
      this.expect("while");
      this.skipParens();
      this.accept(";");
      return { k: "skip", what: "do-while loop", line: t.line };
    }
    if (w === "forever") { this.i++; this.stmt(); return { k: "skip", what: "forever loop", line: t.line }; }
    if (w === "#") { this.delay(); return this.stmt(); }
    if (w === "@") {
      this.i++;
      if (this.is("(")) this.skipParens(); else this.next();
      return this.stmt();
    }
    if (w === "wait") { this.i++; this.skipParens(); return this.stmt(); }
    if (w === ";") { this.i++; return { k: "block", body: [] }; }
    if (t.kind === "sys" || ["disable", "return", "break", "continue", "->", "deassign", "release"].includes(w)) {
      this.skipStatement();
      return { k: "skip", what: t.text, line: t.line };
    }
    if (w === "assign" || w === "force") this.i++;
    // Task call: name(...); or, for a task without arguments, name;
    if (t.kind === "id" && (this.is("(", 1) || this.is(";", 1))) {
      this.skipStatement();
      return { k: "skip", what: `call ${t.text}`, line: t.line };
    }
    const lhs = this.lvalue();
    const op = this.next();
    if (op.text === "++" || op.text === "--") {
      this.accept(";");
      return { k: "assign", lhs, rhs: { k: "bin", op: op.text[0], a: lhs, b: num(1) }, nb: false, line: t.line };
    }
    if (!["=", "<=", "+=", "-=", "*=", "/=", "&=", "|=", "^=", "<<=", ">>="].includes(op.text))
      throw new VerilogSyntaxError(`expected an assignment but found "${op.text}"`, op.line);
    if (this.is("#")) this.delay();
    if (this.is("@")) { this.i++; if (this.is("(")) this.skipParens(); else this.next(); }
    let rhs = this.expr();
    if (op.text.length > 1 && op.text !== "<=") rhs = { k: "bin", op: op.text.slice(0, -1), a: lhs, b: rhs };
    this.expect(";");
    return { k: "assign", lhs, rhs, nb: op.text === "<=", line: t.line };
  }

  private lvalue(): Expr {
    if (this.is("{")) {
      this.i++;
      const parts: Expr[] = [];
      do parts.push(this.lvalue()); while (this.accept(","));
      this.expect("}");
      return { k: "cat", parts };
    }
    let e: Expr = { k: "id", name: this.ident() };
    while (this.is(".") && this.peek(1).kind === "id") { this.i++; e = { k: "id", name: `${(e as { name: string }).name}_${this.ident()}` }; }
    return this.selects(e);
  }

  private selects(e: Expr): Expr {
    while (this.is("[")) {
      this.i++;
      const a = this.expr();
      if (this.accept(":")) { const b = this.expr(); this.expect("]"); e = { k: "part", a: e, msb: a, lsb: b, mode: ":" }; continue; }
      if (this.accept("+:")) { const b = this.expr(); this.expect("]"); e = { k: "part", a: e, msb: a, lsb: b, mode: "+:" }; continue; }
      if (this.accept("-:")) { const b = this.expr(); this.expect("]"); e = { k: "part", a: e, msb: a, lsb: b, mode: "-:" }; continue; }
      this.expect("]");
      e = { k: "idx", a: e, i: a };
    }
    return e;
  }

  // ---- expressions ----------------------------------------------------------

  expr(): Expr {
    const c = this.binary(1);
    if (this.accept("?")) {
      const a = this.expr();
      this.expect(":");
      const b = this.expr();
      return { k: "tern", c, a, b };
    }
    return c;
  }

  private binary(min: number): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const p = t.kind === "op" ? BINARY_PREC[t.text] : undefined;
      if (p === undefined || p < min) break;
      this.i++;
      // ** is right-associative; everything else left.
      const right = this.binary(t.text === "**" ? p : p + 1);
      left = { k: "bin", op: t.text, a: left, b: right };
    }
    if (this.is("inside")) {
      // x inside {A, B}: equality with any member.
      this.i++;
      this.expect("{");
      const opts: Array<Expr | ValueRange> = [];
      do opts.push(this.insideItem()); while (this.accept(","));
      this.expect("}");
      const x = left;
      left = opts.map((o) => insideMatch(x, o)).reduce((a, b) => ({ k: "bin", op: "||", a, b }));
    }
    return left;
  }

  /** One member of an inside list or a case-inside label: a value or a [lo:hi] range. */
  private insideItem(): Expr | ValueRange {
    if (!this.accept("[")) return this.expr();
    const lo = this.expr();
    this.expect(":");
    const hi = this.expr();
    this.expect("]");
    return { lo, hi };
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.kind === "op" && UNARY.has(t.text)) {
      this.i++;
      const a = this.unary();
      return { k: "un", op: t.text, a };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.next();
    let e: Expr;
    if (t.kind === "num") {
      e = parseNumber(t.text);
      if (this.is("'") && this.is("(", 1)) { this.i += 2; e = this.expr(); this.expect(")"); } // size cast 4'(x)
    } else if (t.kind === "str") {
      e = num(0);
    } else if (t.kind === "sys") {
      const args: Expr[] = [];
      if (this.accept("(")) {
        if (!this.is(")")) do args.push(this.expr()); while (this.accept(","));
        this.expect(")");
      }
      e = { k: "call", name: t.text, args };
    } else if (t.kind === "id") {
      let name = t.text;
      while (this.accept("::")) name = this.ident();
      if (this.is("'") && this.is("(", 1)) {
        // type cast state_t'(x)
        this.i += 2;
        e = this.expr();
        this.expect(")");
      } else if (this.is("(")) {
        this.i++;
        const args: Expr[] = [];
        if (!this.is(")")) do args.push(this.expr()); while (this.accept(","));
        this.expect(")");
        e = { k: "call", name, args };
      } else {
        while (this.is(".") && this.peek(1).kind === "id") { this.i++; name = `${name}_${this.ident()}`; }
        e = { k: "id", name };
      }
    } else if (t.text === "(") {
      e = this.expr();
      if (this.accept(":")) { this.expr(); if (this.accept(":")) this.expr(); } // min:typ:max
      this.expect(")");
    } else if (t.text === "{") {
      const first = this.expr();
      if (this.is("{")) {
        // replication {n{a, b}}
        this.i++;
        const parts: Expr[] = [];
        do parts.push(this.expr()); while (this.accept(","));
        this.expect("}");
        this.expect("}");
        e = { k: "rep", n: first, parts };
      } else {
        const parts = [first];
        while (this.accept(",")) parts.push(this.expr());
        this.expect("}");
        e = { k: "cat", parts };
      }
    } else if (t.text === "'{") {
      let depth = 1;
      while (depth > 0 && !this.done()) { const x = this.next().text; if (x === "{" || x === "'{") depth++; if (x === "}") depth--; }
      e = num(0);
    } else {
      throw new VerilogSyntaxError(`unexpected "${t.text}"`, t.line);
    }
    return this.selects(e);
  }
}

interface ValueRange {
  lo: Expr;
  hi: Expr;
}

/** x inside {item}: equal to a value, or between the bounds of a [lo:hi] range. */
function insideMatch(x: Expr, item: Expr | ValueRange): Expr {
  if (!("lo" in item)) return { k: "bin", op: "==", a: x, b: item };
  return { k: "bin", op: "&&", a: { k: "bin", op: ">=", a: x, b: item.lo }, b: { k: "bin", op: "<=", a: x, b: item.hi } };
}

function emptyModule(name: string, line: number): Module {
  return { name, line, ports: [], decls: new Map(), params: [], enums: new Map(), always: [], assigns: [], skipped: [], errors: [] };
}
