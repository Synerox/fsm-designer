// Verilog expressions for the FSM importer: the AST, constant folding with
// partial evaluation (known signals are substituted, the rest stays symbolic),
// and printing back to Verilog text.

export type Expr =
  | { k: "num"; v: bigint; w: number | null; x: bigint; z: bigint; src?: string; name?: string; signed?: boolean; index?: string }
  | { k: "id"; name: string }
  | { k: "un"; op: string; a: Expr; w?: number }
  | { k: "bin"; op: string; a: Expr; b: Expr; w?: number }
  | { k: "tern"; c: Expr; a: Expr; b: Expr; w?: number }
  | { k: "idx"; a: Expr; i: Expr }
  | { k: "part"; a: Expr; msb: Expr; lsb: Expr; mode: ":" | "+:" | "-:" }
  | { k: "cat"; parts: Expr[] }
  | { k: "rep"; n: Expr; parts: Expr[] }
  | { k: "call"; name: string; args: Expr[] };

export type Num = Extract<Expr, { k: "num" }>;

// Widths follow Verilog: + - * ~ & | ^ ?: and the left side of a shift are
// evaluated at the width of the expression they are in (the wider side of a
// comparison, the variable assigned), so with a 1-bit go, go + go == 2'd2 adds
// in 2 bits and y = ~go gives 2'b11 or 2'b10 for a 2-bit y. simplify passes
// that width down. When such an operator stays unknown in a context wider
// than its operands, or is stored in a variable, `w` on the node records the
// width it is evaluated at, so simplifying it again anywhere (a stored value
// read in another expression) computes the same value.

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
    return num(BigInt(v), null, { src, signed: true }); // a plain decimal is a signed integer
  }
  const w = m[1] ? Number(m[1].replace(/_/g, "")) : null;
  const signed = m[2] ? { signed: true } : {};
  const base = m[3].toLowerCase();
  const digits = m[4].replace(/_/g, "").toLowerCase();
  if (base === "d") {
    if (/[xz?]/.test(digits)) {
      const width = w ?? 32;
      return { k: "num", v: 0n, w, x: digits.includes("x") ? ONES(width) : 0n, z: /[z?]/.test(digits) ? ONES(width) : 0n, src };
    }
    return num(BigInt(digits), w, { src, ...signed });
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
  return { k: "num", v, w, x, z, src, ...signed };
}

const COMPARE = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">=", "&&", "||", "==?", "!=?"]);
const REDUCE = new Set(["&", "|", "^", "~&", "~|", "~^", "^~"]);
/** Shifts and **: the result has the left operand's width; the right one stands alone. */
const SHIFT = new Set(["<<", ">>", "<<<", ">>>", "**"]);

export function widthOf(e: Expr, ctx: EvalCtx): number {
  switch (e.k) {
    case "num": return e.w ?? 32;
    case "id": {
      // A named constant has the width of its value (an unsized one is 32 bits).
      const w = ctx.width(e.name);
      if (w !== undefined) return w;
      const v = ctx.lookup(e.name);
      return v && isNum(v) ? v.w ?? 32 : 1;
    }
    case "un": return e.op === "!" || REDUCE.has(e.op) ? 1 : e.w ?? widthOf(e.a, ctx);
    case "bin":
      if (COMPARE.has(e.op)) return 1;
      if (e.w !== undefined) return e.w;
      if (SHIFT.has(e.op)) return widthOf(e.a, ctx);
      return Math.max(widthOf(e.a, ctx), widthOf(e.b, ctx));
    case "tern": return e.w ?? Math.max(widthOf(e.a, ctx), widthOf(e.b, ctx));
    case "idx": return 1;
    case "part": {
      if (e.mode !== ":") return isConst(e.lsb) ? Number(e.lsb.v) : 1;
      return isConst(e.msb) && isConst(e.lsb) ? Math.abs(Number(e.msb.v) - Number(e.lsb.v)) + 1 : 1;
    }
    case "cat": return e.parts.reduce((s, p) => s + widthOf(p, ctx), 0);
    case "rep": return (isConst(e.n) ? Number(e.n.v) : 1) * e.parts.reduce((s, p) => s + widthOf(p, ctx), 0);
    case "call": return (e.name === "$signed" || e.name === "$unsigned") && e.args.length === 1 ? widthOf(e.args[0], ctx) : 32;
  }
}

/** v (w bits) read as two's complement. */
export function toSigned(v: bigint, w: number): bigint {
  return w > 0 && (v >> BigInt(w - 1)) & 1n ? v - (1n << BigInt(w)) : v;
}

/** a op, with ~ - + evaluated at w bits (their context's width) and the rest at a's own width. */
function foldUnary(op: string, a: Num, w: number): Num {
  const v = mask(a.v, w);
  const signed = a.signed ? { signed: true } : {};
  switch (op) {
    case "!": return bool(v === 0n);
    case "~": return num(~v, w, signed);
    case "-": return num(-v, w, signed);
    case "+": return num(v, w, signed);
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

/**
 * a op b with the operands extended to w bits: the width of the expression
 * they are in, never less than the wider operand's (an unsized literal counts
 * as 32 bits, so cnt < 300 is not cnt < 44 for an 8-bit cnt).
 */
function foldBinary(op: string, a: Num, b: Num, w: number): Num | undefined {
  // Verilog compares and computes in two's complement only when both operands
  // are signed (signed declarations, 8'sd30, plain decimals, $signed(x));
  // the narrower one is then sign-extended.
  const both = !!a.signed && !!b.signed;
  const signed = both ? { signed: true } : {};
  const x = both ? mask(toSigned(mask(a.v, a.w ?? 32), a.w ?? 32), w) : mask(a.v, w);
  const y = both ? mask(toSigned(mask(b.v, b.w ?? 32), b.w ?? 32), w) : mask(b.v, w);
  const [sx, sy] = both ? [toSigned(x, w), toSigned(y, w)] : [x, y];
  switch (op) {
    case "+": return num(x + y, w, signed);
    case "-": return num(x - y, w, signed);
    case "*": return num(x * y, w, signed);
    // (BigInt / and % truncate toward zero, as Verilog's signed ones do.)
    case "/": return y === 0n ? undefined : num(sx / sy, w, signed);
    case "%": return y === 0n ? undefined : num(sx % sy, w, signed);
    case "**": return num(x ** y, w);
    case "&": return num(x & y, w, signed);
    case "|": return num(x | y, w, signed);
    case "^": return num(x ^ y, w, signed);
    case "~^": case "^~": return num(~(x ^ y), w);
    // A shift keeps the left operand's sign and works at the width of its
    // context (go << 2 is 4 in a 4-bit y); >>> fills with the sign bit when
    // signed. (A shift by w or more leaves only zeros or sign bits.)
    case "<<": case "<<<": case ">>": case ">>>": {
      const aw = a.w ?? 32;
      const v = a.signed ? mask(toSigned(mask(a.v, aw), aw), w) : mask(a.v, aw);
      const n = b.v < BigInt(w) ? b.v : BigInt(w);
      const r = op === "<<" || op === "<<<" ? v << n : op === ">>>" && a.signed ? toSigned(v, w) >> n : v >> n;
      return num(r, w, a.signed ? { signed: true } : {});
    }
    case "==": case "===": return bool(x === y);
    case "!=": case "!==": return bool(x !== y);
    case "<": return bool(sx < sy);
    case "<=": return bool(sx <= sy);
    case ">": return bool(sx > sy);
    case ">=": return bool(sx >= sy);
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

/** !a for a simplified a: !!x -> x, !(a == b) -> a != b. */
function not(a: Expr, ctx: EvalCtx): Expr {
  // (~x is x's inverse only at 1 bit: a 2-bit ~go is never 0.)
  if (a.k === "un" && (a.op === "!" || (a.op === "~" && isBoolean(a, ctx))) && isBoolean(a.a, ctx)) return a.a;
  if (a.k === "bin") {
    const inv: Record<string, string> = { "==": "!=", "!=": "==", "===": "!==", "!==": "===", "<": ">=", ">=": "<", ">": "<=", "<=": ">" };
    if (inv[a.op]) return { ...a, op: inv[a.op] };
  }
  return { k: "un", op: "!", a };
}

/**
 * Fold everything that is known. Names are replaced by ctx.lookup when it has
 * a value; what remains unknown stays as an expression. cw is the width of the
 * context e is evaluated in (see the note at the top), when wider than e's own.
 */
export function simplify(e: Expr, ctx: EvalCtx, cw?: number): Expr {
  const r = simplify1(e, ctx, cw);
  // An assumption is about the truth of what was assumed, which is its value
  // only when it is 1 bit wide: after if (cnt) a 4-bit cnt is still unknown,
  // and cnt < 5 or cnt[3] must not read it as 1 (see simplifyCond).
  if (ctx.assumed && !isNum(r)) {
    const v = ctx.assumed(printExpr(r));
    if (v !== undefined && isBoolean(r, ctx)) return bool(v);
  }
  return r;
}

/**
 * e read as a truth value (an if, the operands of && || !, a ?: condition),
 * where an assumption about a multi-bit e (if (cnt) ... cnt != 0) decides it.
 */
export function simplifyCond(e: Expr, ctx: EvalCtx): Expr {
  const r = simplify(e, ctx);
  if (ctx.assumed && !isNum(r) && !isBoolean(r, ctx)) {
    const v = ctx.assumed(printExpr(r));
    if (v !== undefined) return bool(v);
  }
  return r;
}

/** n evaluated at ew bits: marked with the width when that is more than its operands give it. */
function atWidth<T extends Extract<Expr, { k: "un" | "bin" | "tern" }>>(n: T, ew: number, ctx: EvalCtx): T {
  if (n.w !== undefined) return n;
  return ew > widthOf(n, ctx) ? { ...n, w: ew } : n;
}

function simplify1(e: Expr, ctx: EvalCtx, cw?: number): Expr {
  switch (e.k) {
    case "num": return e;
    case "id": return ctx.lookup(e.name) ?? e;
    case "un": {
      if (e.op === "!" || REDUCE.has(e.op)) {
        // The operand of ! or a reduction stands alone (its own width).
        const a = e.op === "!" ? simplifyCond(e.a, ctx) : simplify(e.a, ctx);
        if (isConst(a)) return foldUnary(e.op, a, widthOf(a, ctx));
        if (e.op === "!") return not(a, ctx);
        return { ...e, a };
      }
      // ~ - +: at the context's width, so ~go is !go only where that is 1 bit.
      const ew = e.w ?? Math.max(widthOf(e.a, ctx), cw ?? 0);
      const a = simplify(e.a, ctx, ew);
      if (isConst(a)) return foldUnary(e.op, a, ew);
      if (e.op === "~" && ew === 1 && isBoolean(a, ctx)) return not(a, ctx);
      return atWidth({ ...e, a }, ew, ctx);
    }
    case "bin": {
      if (e.op === "&&" || e.op === "||") {
        const and = e.op === "&&";
        const a = simplifyCond(e.a, ctx);
        if (isConst(a)) {
          if ((a.v !== 0n) !== and) return bool(!and);
          return truth(simplifyCond(e.b, ctx), ctx);
        }
        const b = simplifyCond(e.b, ctx);
        if (isConst(b)) return (b.v !== 0n) === and ? truth(a, ctx) : bool(!and);
        return { ...e, a, b };
      }
      if (COMPARE.has(e.op)) {
        // Both sides are extended to the wider one: go + go == 2'd2 adds in 2 bits.
        const ow = Math.max(widthOf(e.a, ctx), widthOf(e.b, ctx));
        const a = simplify(e.a, ctx, ow);
        const b = simplify(e.b, ctx, ow);
        if (isConst(a) && isConst(b)) {
          const f = foldBinary(e.op, a, b, Math.max(ow, widthOf(a, ctx), widthOf(b, ctx)));
          if (f) return f;
        }
        // x == 1 -> x, x == 0 -> !x for a 1-bit x (and the != forms).
        if ((e.op === "==" || e.op === "!=" || e.op === "===" || e.op === "!==") && (isConst(a) || isConst(b))) {
          const c = (isConst(a) ? a : b) as Num;
          const o = isConst(a) ? b : a;
          if (isBoolean(o, ctx) && (c.v === 0n || c.v === 1n)) {
            const eq = e.op === "==" || e.op === "===";
            return (c.v === 1n) === eq ? o : not(o, ctx);
          }
          if (isConst(a)) return { ...e, op: e.op, a: b, b: a }; // constant on the right
        }
        return { ...e, a, b };
      }
      // Arithmetic, bitwise and shifts: at the context's width (a shift's
      // amount and a power's exponent stand alone).
      const shift = SHIFT.has(e.op);
      const ew = e.w ?? Math.max(shift ? widthOf(e.a, ctx) : Math.max(widthOf(e.a, ctx), widthOf(e.b, ctx)), cw ?? 0);
      const a = simplify(e.a, ctx, ew);
      const b = shift ? simplify(e.b, ctx) : simplify(e.b, ctx, ew);
      if (isConst(a) && isConst(b)) {
        const f = foldBinary(e.op, a, b, ew);
        if (f) return f;
      }
      // A constant that decides a 1-bit operand: x & 0 -> 0, x & 1 -> x,
      // x | 1 -> 1, x ^ 1 -> !x. Only bit 0 of C meets x, so C's other bits
      // are cleared by & but kept by | and ^: x | 2'b10 is 2 or 3, not x.
      if ((e.op === "&" || e.op === "|" || e.op === "^") && (isConst(a) || isConst(b))) {
        const c = (isConst(a) ? a : b) as Num;
        const o = isConst(a) ? b : a;
        const cv = mask(c.v, ew);
        if (isBoolean(o, ctx) && (e.op === "&" || cv >> 1n === 0n)) {
          const on = (cv & 1n) === 1n;
          if (e.op === "&") return on ? o : FALSE;
          if (e.op === "|") return on ? TRUE : o;
          return on ? not(o, ctx) : o;
        }
      }
      return atWidth({ ...e, a, b }, ew, ctx);
    }
    case "tern": {
      const c = simplifyCond(e.c, ctx);
      const ew = e.w ?? Math.max(widthOf(e.a, ctx), widthOf(e.b, ctx), cw ?? 0);
      if (isConst(c)) return simplify(c.v !== 0n ? e.a : e.b, ctx, ew);
      return atWidth({ ...e, c, a: simplify(e.a, ctx, ew), b: simplify(e.b, ctx, ew) }, ew, ctx);
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
        // en[4:2][0] -> en[2] (a value cut to its low bits, see lowBits).
        if (a.k === "part" && a.mode === ":" && isConst(a.msb) && isConst(a.lsb) && n <= Number(a.msb.v) - Number(a.lsb.v)) return simplify({ k: "idx", a: a.a, i: num(Number(a.lsb.v) + n) }, ctx);
        // A bit of a constant shift is a bit of the shifted value: (a >> 1)[0] -> a[1].
        if (a.k === "bin" && (a.op === ">>" || a.op === "<<") && isConst(a.b) && a.b.v < 64n) {
          const from = a.op === ">>" ? n + Number(a.b.v) : n - Number(a.b.v);
          return from >= 0 && from < widthOf(a.a, ctx) ? simplify({ k: "idx", a: a.a, i: num(from) }, ctx) : FALSE;
        }
        if (isBoolean(a, ctx) && n === 0 && (a.k === "id" || a.k === "idx")) return a;
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
        if (a.k === "part" && a.mode === ":" && isConst(a.msb) && isConst(a.lsb) && hi <= Number(a.msb.v) - Number(a.lsb.v)) {
          const base = Number(a.lsb.v);
          return simplify({ k: "part", a: a.a, msb: num(base + hi), lsb: num(base + lo), mode: ":" }, ctx);
        }
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
      // $signed(x) changes how x compares: fold it for a constant, keep it
      // (and so in the printed condition) otherwise.
      if ((e.name === "$signed" || e.name === "$unsigned") && args.length === 1 && isConst(args[0])) {
        const a = args[0];
        return { ...a, w: a.w ?? 32, signed: e.name === "$signed", src: undefined, name: undefined };
      }
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

/** Operators whose low n result bits depend only on the low n bits of their operands. */
const LOW_BITS = new Set(["+", "-", "*", "&", "|", "^", "~^", "^~", "<<", "<<<"]);

/**
 * The low w bits of e, which is what a w-bit variable keeps of it. The cut is
 * pushed down to the names where it can be (z = ~op gives !op[0], z = a + b
 * gives a[0] + b[0]), so the result also reads right as a condition;
 * otherwise e is selected as is ((a >> 1)[0]).
 */
export function lowBits(e: Expr, w: number, ctx: EvalCtx): Expr {
  if (widthOf(e, ctx) <= w) return e;
  const sel = (a: Expr): Expr => w === 1 ? { k: "idx", a, i: num(0) } : { k: "part", a, msb: num(w - 1), lsb: num(0), mode: ":" };
  switch (e.k) {
    case "num": {
      const v = mask(e.v, w);
      const same = v === e.v && mask(e.x, w) === e.x && mask(e.z, w) === e.z;
      return { ...e, v, x: mask(e.x, w), z: mask(e.z, w), w, ...(same ? {} : { src: undefined, name: undefined }) };
    }
    case "un":
      if (e.op === "~" || e.op === "-" || e.op === "+") return simplify({ ...e, a: lowBits(e.a, w, ctx), w }, ctx);
      break;
    case "bin":
      if (LOW_BITS.has(e.op)) return simplify({ ...e, a: lowBits(e.a, w, ctx), b: SHIFT.has(e.op) ? e.b : lowBits(e.b, w, ctx), w }, ctx);
      break;
    case "tern": return simplify({ ...e, a: lowBits(e.a, w, ctx), b: lowBits(e.b, w, ctx), w }, ctx);
  }
  return simplify(sel(e), ctx);
}

/**
 * v as stored in a w-bit variable: cut to its low w bits when wider, and an
 * operator evaluated at exactly w bits otherwise, so that reading the variable
 * in a wider expression neither keeps a carry it lost nor widens a ~.
 */
export function fitWidth(v: Expr, w: number, ctx: EvalCtx, signed = false): Expr {
  if (isNum(v)) {
    const { signed: _, ...r } = lowBits(v, w, ctx) as Num;
    return { ...r, w, ...(signed ? { signed: true } : {}) };
  }
  if (widthOf(v, ctx) > w) return lowBits(v, w, ctx);
  if ((v.k === "un" && (v.op === "~" || v.op === "-" || v.op === "+")) || (v.k === "bin" && !COMPARE.has(v.op)) || v.k === "tern") return v.w === undefined ? { ...v, w } : v;
  return v;
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
