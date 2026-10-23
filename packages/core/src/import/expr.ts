// Verilog expressions for the FSM importer: the AST, constant folding with
// partial evaluation (known signals are substituted, the rest stays symbolic),
// and printing back to Verilog text.

export type Expr =
  | { k: "num"; v: bigint; w: number | null; x: bigint; z: bigint; src?: string; name?: string }
  | { k: "id"; name: string }
  | { k: "un"; op: string; a: Expr }
  | { k: "bin"; op: string; a: Expr; b: Expr }
  | { k: "tern"; c: Expr; a: Expr; b: Expr }
  | { k: "idx"; a: Expr; i: Expr }
  | { k: "part"; a: Expr; msb: Expr; lsb: Expr; mode: ":" | "+:" | "-:" }
  | { k: "cat"; parts: Expr[] }
  | { k: "rep"; n: Expr; parts: Expr[] }
  | { k: "call"; name: string; args: Expr[] };

export type Num = Extract<Expr, { k: "num" }>;

export interface EvalCtx {
  /** Value of a name if it is known (a constant or a symbolic expression), else undefined. */
  lookup(name: string): Expr | undefined;
  /** Declared width in bits. */
  width(name: string): number | undefined;
  /** Truth value assumed for a boolean sub-expression, by its printed form. */
  assumed?(key: string): boolean | undefined;
}

const ONES = (w: number) => (1n << BigInt(w)) - 1n;
export const mask = (v: bigint, w: number) => v & ONES(w);

export function num(v: bigint | number, w: number | null = null, extra: Partial<Num> = {}): Num {
  const b = BigInt(v);
  return { k: "num", v: w === null ? b : mask(b, w), w, x: 0n, z: 0n, ...extra };
}

export const TRUE = num(1, 1);
export const FALSE = num(0, 1);
export const bool = (b: boolean) => (b ? TRUE : FALSE);
export const isNum = (e: Expr): e is Num => e.k === "num";
/** A constant with no x/z bits. */
export const isConst = (e: Expr): e is Num => e.k === "num" && e.x === 0n && e.z === 0n;

/** Parse a Verilog number literal (4'b10x1, 'hFF, 12, '1). */
export function parseNumber(text: string): Num {
  const src = text;
  if (/^'[01xXzZ]$/.test(text)) {
    // SystemVerilog fill literal: every bit is that value; width comes from context.
    const c = text[1].toLowerCase();
    const all = ONES(64);
    return { k: "num", v: c === "1" ? all : 0n, w: null, x: c === "x" ? all : 0n, z: c === "z" ? all : 0n, src };
  }
  const m = text.match(/^(\d[\d_]*)?'([sS]?)([bBoOdDhH])([0-9a-fA-FxXzZ?_]+)$/);
  if (!m) {
    const v = text.replace(/_/g, "");
    if (/[.eE]/.test(v)) return num(BigInt(Math.trunc(Number(v))), null, { src });
    return num(BigInt(v), null, { src });
  }
  const w = m[1] ? Number(m[1].replace(/_/g, "")) : null;
  const base = m[3].toLowerCase();
  const digits = m[4].replace(/_/g, "").toLowerCase();
  if (base === "d") {
    if (/[xz?]/.test(digits)) {
      const width = w ?? 32;
      return { k: "num", v: 0n, w, x: digits.includes("x") ? ONES(width) : 0n, z: /[z?]/.test(digits) ? ONES(width) : 0n, src };
    }
    return num(BigInt(digits), w, { src });
  }
  const bits = base === "b" ? 1 : base === "o" ? 3 : 4;
  let v = 0n, x = 0n, z = 0n;
  for (const ch of digits) {
    v <<= BigInt(bits); x <<= BigInt(bits); z <<= BigInt(bits);
    const full = ONES(bits);
    if (ch === "x") x |= full;
    else if (ch === "z" || ch === "?") z |= full;
    else v |= BigInt(parseInt(ch, 16));
  }
  if (w !== null) {
    // A leading x/z digit extends to the full width.
    const given = digits.length * bits;
    if (w > given) {
      const top = 1n << BigInt(given - 1);
      if (x & top) x |= ONES(w) & ~ONES(given);
      if (z & top) z |= ONES(w) & ~ONES(given);
    }
    v = mask(v, w); x = mask(x, w); z = mask(z, w);
  }
  return { k: "num", v, w, x, z, src };
}

const COMPARE = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">=", "&&", "||", "==?", "!=?"]);
const REDUCE = new Set(["&", "|", "^", "~&", "~|", "~^", "^~"]);

export function widthOf(e: Expr, ctx: EvalCtx): number {
  switch (e.k) {
    case "num": return e.w ?? 32;
    case "id": return ctx.width(e.name) ?? 1;
    case "un": return e.op === "!" || REDUCE.has(e.op) ? 1 : widthOf(e.a, ctx);
    case "bin":
      if (COMPARE.has(e.op)) return 1;
      if (["<<", ">>", "<<<", ">>>", "**"].includes(e.op)) return widthOf(e.a, ctx);
      return Math.max(widthOf(e.a, ctx), widthOf(e.b, ctx));
    case "tern": return Math.max(widthOf(e.a, ctx), widthOf(e.b, ctx));
    case "idx": return 1;
    case "part": {
      if (e.mode !== ":") return isConst(e.lsb) ? Number(e.lsb.v) : 1;
      return isConst(e.msb) && isConst(e.lsb) ? Math.abs(Number(e.msb.v) - Number(e.lsb.v)) + 1 : 1;
    }
    case "cat": return e.parts.reduce((s, p) => s + widthOf(p, ctx), 0);
    case "rep": return (isConst(e.n) ? Number(e.n.v) : 1) * e.parts.reduce((s, p) => s + widthOf(p, ctx), 0);
    case "call": return 32;
  }
}

/** The width an operand really has, for folding: unsized literals adopt the other side's. */
function opWidth(a: Num, b: Num): number {
  if (a.w !== null && b.w !== null) return Math.max(a.w, b.w);
  return a.w ?? b.w ?? 32;
}

function foldUnary(op: string, a: Num, w: number): Num {
  const v = a.w === null ? mask(a.v, w) : a.v;
  switch (op) {
    case "!": return bool(v === 0n);
    case "~": return num(~v, w);
    case "-": return num(-v, w);
    case "+": return num(v, w);
    case "&": return bool(v === ONES(w));
    case "~&": return bool(v !== ONES(w));
    case "|": return bool(v !== 0n);
    case "~|": return bool(v === 0n);
    case "^": return bool(popcount(v) % 2 === 1);
    case "~^": case "^~": return bool(popcount(v) % 2 === 0);
  }
  throw new Error(`unknown operator ${op}`);
}

function popcount(v: bigint): number {
  let n = 0;
  for (; v > 0n; v >>= 1n) n += Number(v & 1n);
  return n;
}

function foldBinary(op: string, a: Num, b: Num): Num | undefined {
  const w = opWidth(a, b);
  const x = mask(a.v, w), y = mask(b.v, w);
  switch (op) {
    case "+": return num(x + y, w);
    case "-": return num(x - y, w);
    case "*": return num(x * y, w);
    case "/": return y === 0n ? undefined : num(x / y, w);
    case "%": return y === 0n ? undefined : num(x % y, w);
    case "**": return num(x ** y, a.w);
    case "&": return num(x & y, w);
    case "|": return num(x | y, w);
    case "^": return num(x ^ y, w);
    case "~^": case "^~": return num(~(x ^ y), w);
    case "<<": case "<<<": return num(a.v << b.v, a.w ?? 32);
    case ">>": case ">>>": return num(a.v >> b.v, a.w ?? 32);
    case "==": case "===": return bool(x === y);
    case "!=": case "!==": return bool(x !== y);
    case "<": return bool(x < y);
    case "<=": return bool(x <= y);
    case ">": return bool(x > y);
    case ">=": return bool(x >= y);
    case "&&": return bool(a.v !== 0n && b.v !== 0n);
    case "||": return bool(a.v !== 0n || b.v !== 0n);
  }
  return undefined;
}

/** True when the expression is 1 bit wide (so it can stand for a condition as is). */
export function isBoolean(e: Expr, ctx: EvalCtx): boolean {
  return widthOf(e, ctx) === 1;
}

/** `e` as a 1-bit truth value: e itself if already 1 bit, else e != 0. */
function truth(e: Expr, ctx: EvalCtx): Expr {
  if (isConst(e)) return bool(e.v !== 0n);
  return isBoolean(e, ctx) ? e : { k: "bin", op: "!=", a: e, b: num(0) };
}

/**
 * Fold everything that is known. Names are replaced by ctx.lookup when it has
 * a value; what remains unknown stays as an expression.
 */
export function simplify(e: Expr, ctx: EvalCtx): Expr {
  const r = simplify1(e, ctx);
  if (ctx.assumed && !isNum(r)) {
    const v = ctx.assumed(printExpr(r));
    if (v !== undefined) return bool(v);
  }
  return r;
}

function simplify1(e: Expr, ctx: EvalCtx): Expr {
  switch (e.k) {
    case "num": return e;
    case "id": return ctx.lookup(e.name) ?? e;
    case "un": {
      const a = simplify(e.a, ctx);
      if (isConst(a)) return foldUnary(e.op, a, widthOf(a, ctx));
      if (e.op === "!" || (e.op === "~" && isBoolean(a, ctx))) {
        // !!x -> x, !(a == b) -> a != b
        if (a.k === "un" && (a.op === "!" || a.op === "~") && isBoolean(a.a, ctx)) return a.a;
        if (a.k === "bin") {
          const inv: Record<string, string> = { "==": "!=", "!=": "==", "===": "!==", "!==": "===", "<": ">=", ">=": "<", ">": "<=", "<=": ">" };
          if (inv[a.op]) return { ...a, op: inv[a.op] };
        }
        return { k: "un", op: "!", a };
      }
      return { ...e, a };
    }
    case "bin": {
      const a = simplify(e.a, ctx);
      if (e.op === "&&" || e.op === "||") {
        const and = e.op === "&&";
        if (isConst(a)) {
          if ((a.v !== 0n) !== and) return bool(!and);
          return truth(simplify(e.b, ctx), ctx);
        }
        const b = simplify(e.b, ctx);
        if (isConst(b)) return (b.v !== 0n) === and ? truth(a, ctx) : bool(!and);
        return { ...e, a, b };
      }
      const b = simplify(e.b, ctx);
      if (isConst(a) && isConst(b)) {
        const f = foldBinary(e.op, a, b);
        if (f) return f;
      }
      // Masks that decide a 1-bit operand: x & 0 -> 0, x & 1 -> x, x | 1 -> 1 ...
      if ((e.op === "&" || e.op === "|") && (isConst(a) || isConst(b))) {
        const c = (isConst(a) ? a : b) as Num;
        const o = isConst(a) ? b : a;
        if (isBoolean(o, ctx)) {
          const on = (c.v & 1n) === 1n;
          if (e.op === "&") return on ? o : FALSE;
          return on ? TRUE : o;
        }
      }
      if (e.op === "^" && (isConst(a) || isConst(b))) {
        const c = (isConst(a) ? a : b) as Num;
        const o = isConst(a) ? b : a;
        if (isBoolean(o, ctx)) return (c.v & 1n) === 1n ? simplify({ k: "un", op: "!", a: o }, ctx) : o;
      }
      // x == 1 -> x, x == 0 -> !x for a 1-bit x (and the != forms).
      if ((e.op === "==" || e.op === "!=" || e.op === "===" || e.op === "!==") && (isConst(a) || isConst(b))) {
        const c = (isConst(a) ? a : b) as Num;
        const o = isConst(a) ? b : a;
        if (isBoolean(o, ctx) && (c.v === 0n || c.v === 1n)) {
          const eq = e.op === "==" || e.op === "===";
          return (c.v === 1n) === eq ? o : simplify({ k: "un", op: "!", a: o }, ctx);
        }
        if (isConst(a)) return { ...e, op: e.op, a: b, b: a }; // constant on the right
      }
      return { ...e, a, b };
    }
    case "tern": {
      const c = simplify(e.c, ctx);
      if (isConst(c)) return simplify(c.v !== 0n ? e.a : e.b, ctx);
      return { ...e, c, a: simplify(e.a, ctx), b: simplify(e.b, ctx) };
    }
    case "idx": {
      const a = simplify(e.a, ctx);
      const i = simplify(e.i, ctx);
      if (isConst(i)) {
        const n = Number(i.v);
        if (isNum(a)) {
          if ((a.x | a.z) >> BigInt(n) & 1n) return { k: "num", v: 0n, w: 1, x: (a.x >> BigInt(n)) & 1n, z: (a.z >> BigInt(n)) & 1n };
          return num((a.v >> BigInt(n)) & 1n, 1);
        }
        const part = selectFromCat(a, n, n, ctx);
        if (part) return part;
        if (isBoolean(a, ctx) && n === 0 && a.k === "id") return a;
      }
      return { k: "idx", a, i };
    }
    case "part": {
      const a = simplify(e.a, ctx);
      const msb = simplify(e.msb, ctx);
      const lsb = simplify(e.lsb, ctx);
      if (isConst(msb) && isConst(lsb)) {
        let hi = Number(msb.v), lo = Number(lsb.v);
        if (e.mode === "+:") { lo = Number(msb.v); hi = lo + Number(lsb.v) - 1; }
        if (e.mode === "-:") { hi = Number(msb.v); lo = hi - Number(lsb.v) + 1; }
        if (hi < lo) [hi, lo] = [lo, hi];
        if (isConst(a)) return num(a.v >> BigInt(lo), hi - lo + 1);
        const part = selectFromCat(a, hi, lo, ctx);
        if (part) return part;
        return { k: "part", a, msb: num(hi), lsb: num(lo), mode: ":" };
      }
      return { ...e, a, msb, lsb };
    }
    case "cat": {
      const parts = e.parts.map((p) => simplify(p, ctx));
      if (parts.length === 1) return parts[0];
      if (parts.every(isConst)) {
        let v = 0n, w = 0;
        for (const p of parts) {
          const pw = widthOf(p, ctx);
          v = (v << BigInt(pw)) | mask(p.v, pw);
          w += pw;
        }
        return num(v, w);
      }
      return { k: "cat", parts };
    }
    case "rep": {
      const n = simplify(e.n, ctx);
      const parts = e.parts.map((p) => simplify(p, ctx));
      if (isConst(n)) {
        const all: Expr[] = [];
        for (let i = 0; i < Number(n.v); i++) all.push(...parts);
        return simplify({ k: "cat", parts: all }, ctx);
      }
      return { k: "rep", n, parts };
    }
    case "call": {
      const args = e.args.map((a) => simplify(a, ctx));
      if (e.name === "$clog2" && args.length === 1 && isConst(args[0])) {
        let n = 0;
        while ((1n << BigInt(n)) < args[0].v) n++;
        return num(n);
      }
      if ((e.name === "$signed" || e.name === "$unsigned") && args.length === 1) return args[0];
      return { ...e, args };
    }
  }
}

/** Bits hi..lo of a concatenation, when they fall inside one part. */
function selectFromCat(a: Expr, hi: number, lo: number, ctx: EvalCtx): Expr | undefined {
  if (a.k !== "cat") return undefined;
  let top = widthOf(a, ctx) - 1;
  for (const p of a.parts) {
    const w = widthOf(p, ctx);
    const plo = top - w + 1;
    if (hi <= top && lo >= plo) {
      if (hi === top && lo === plo) return p;
      if (hi === lo) return simplify({ k: "idx", a: p, i: num(lo - plo) }, ctx);
      return simplify({ k: "part", a: p, msb: num(hi - plo), lsb: num(lo - plo), mode: ":" }, ctx);
    }
    top = plo - 1;
  }
  return undefined;
}

/** Does `value` match a case label? casez treats z/? label bits as wildcards, casex also x. */
export function caseMatch(kind: "case" | "casez" | "casex", value: Num, label: Num, w: number): boolean | undefined {
  const care = ONES(w) & ~(kind === "case" ? 0n : kind === "casez" ? label.z | value.z : label.z | label.x | value.z | value.x);
  if (kind === "case" && (label.x | label.z) !== 0n) return false; // x never equals a 2-state value
  return ((mask(value.v, w) ^ mask(label.v, w)) & care) === 0n;
}

/** Bits a casez/casex label does not care about. */
export function wildcardBits(kind: "case" | "casez" | "casex", label: Num, w: number): bigint {
  if (kind === "case") return 0n;
  return mask(kind === "casez" ? label.z : label.z | label.x, w);
}

// ---- printing -------------------------------------------------------------

const PREC: Record<string, number> = {
  "||": 1, "&&": 2, "|": 3, "^": 4, "~^": 4, "^~": 4, "&": 5,
  "==": 6, "!=": 6, "===": 6, "!==": 6, "==?": 6, "!=?": 6,
  "<": 7, "<=": 7, ">": 7, ">=": 7,
  "<<": 8, ">>": 8, "<<<": 8, ">>>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10, "**": 11,
};

export function formatNum(n: Num): string {
  if (n.src && n.x === 0n && n.z === 0n) return n.src;
  if (n.x !== 0n || n.z !== 0n) {
    const w = n.w ?? 32;
    let s = "";
    for (let i = w - 1; i >= 0; i--) {
      const b = BigInt(i);
      s += (n.x >> b) & 1n ? "x" : (n.z >> b) & 1n ? "?" : String((n.v >> b) & 1n);
    }
    return `${w}'b${s}`;
  }
  if (n.w === null) return n.v.toString();
  if (n.w === 1) return `1'b${n.v}`;
  return `${n.w}'d${n.v}`;
}

export function printExpr(e: Expr, parent = 0): string {
  switch (e.k) {
    case "num": return e.name ?? formatNum(e); // named constants (localparam, enum, `define) keep their names
    case "id": return e.name;
    case "un": {
      const inner = printExpr(e.a, 12);
      return `${e.op}${inner}`;
    }
    case "bin": {
      const p = PREC[e.op] ?? 6;
      // Parenthesise && inside || although precedence makes it optional: easier to read.
      const lp = e.op === "||" ? 2.5 : p;
      const s = `${printExpr(e.a, lp)} ${e.op} ${printExpr(e.b, e.op === "||" ? 2.5 : p + 0.5)}`;
      return p < parent ? `(${s})` : s;
    }
    case "tern": {
      const s = `${printExpr(e.c, 1)} ? ${printExpr(e.a, 0)} : ${printExpr(e.b, 0)}`;
      return parent > 0 ? `(${s})` : s;
    }
    case "idx": return `${printExpr(e.a, 13)}[${printExpr(e.i)}]`;
    case "part": return `${printExpr(e.a, 13)}[${printExpr(e.msb)}${e.mode}${printExpr(e.lsb)}]`;
    case "cat": return `{${e.parts.map((p) => printExpr(p)).join(", ")}}`;
    case "rep": return `{${printExpr(e.n)}{${e.parts.map((p) => printExpr(p)).join(", ")}}}`;
    case "call": return `${e.name}(${e.args.map((a) => printExpr(a)).join(", ")})`;
  }
}

/** Identifiers an expression reads. */
export function freeIds(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.k) {
    case "id": out.add(e.name); break;
    case "un": freeIds(e.a, out); break;
    case "bin": freeIds(e.a, out); freeIds(e.b, out); break;
    case "tern": freeIds(e.c, out); freeIds(e.a, out); freeIds(e.b, out); break;
    case "idx": freeIds(e.a, out); freeIds(e.i, out); break;
    case "part": freeIds(e.a, out); freeIds(e.msb, out); freeIds(e.lsb, out); break;
    case "cat": e.parts.forEach((p) => freeIds(p, out)); break;
    case "rep": freeIds(e.n, out); e.parts.forEach((p) => freeIds(p, out)); break;
    case "call": e.args.forEach((a) => freeIds(a, out)); break;
  }
  return out;
}
