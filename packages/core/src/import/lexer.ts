// Verilog preprocessor and tokenizer for the FSM importer.
//
// The preprocessor handles `define / `undef / `ifdef / `ifndef / `elsif /
// `else / `endif and drops the other directives. A `define whose body is a
// plain constant expression (`define IDLE 2'b00) is kept as a named constant,
// so states keep their names; any other macro is expanded as text.

export type TokKind = "id" | "num" | "op" | "str" | "sys";

export interface Token {
  kind: TokKind;
  text: string;
  line: number;
}

export class VerilogSyntaxError extends Error {
  readonly line?: number;
  constructor(message: string, line?: number) {
    super(line !== undefined ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

export interface Preprocessed {
  text: string;
  /** Constant macros: name -> body text (parsed later as an expression). */
  constants: Map<string, string>;
}

/** Remove comments, keeping newlines (for line numbers) and string literals. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const CONST_BODY = /^[\w\s'()+\-*/%<>|&^~?:{},.`$]*$/;
const DROP = /^(timescale|include|default_nettype|resetall|celldefine|endcelldefine|line|pragma|unconnected_drive|nounconnected_drive|begin_keywords|end_keywords)\b/;

interface Macro {
  params: string[] | null;
  body: string;
}

/**
 * `isConst` says whether a macro body (with the macros in it already
 * expanded) parses as one expression; a body that does not is expanded as
 * text instead of being kept as a named constant.
 */
export function preprocess(source: string, isConst: (body: string) => boolean = () => true): Preprocessed {
  const lines = stripComments(source.replace(/\r\n?/g, "\n")).split("\n");
  const macros = new Map<string, Macro>();
  const constants = new Map<string, string>();
  const out: string[] = [];
  // Stack of [active, anyBranchTaken] for `ifdef nesting.
  const cond: Array<{ active: boolean; taken: boolean; parent: boolean }> = [];
  const active = () => cond.every((c) => c.active);

  for (let n = 0; n < lines.length; n++) {
    let line = lines[n];
    const m = line.match(/^\s*`(\w+)\s*(.*)$/);
    if (m) {
      const [, dir, rest] = m;
      if (dir === "ifdef" || dir === "ifndef") {
        const name = rest.trim().split(/\s+/)[0];
        const parent = active();
        const v = macros.has(name) === (dir === "ifdef");
        cond.push({ active: parent && v, taken: v, parent });
        out.push("");
        continue;
      }
      if (dir === "elsif") {
        const top = cond[cond.length - 1];
        if (top) {
          const v = !top.taken && macros.has(rest.trim().split(/\s+/)[0]);
          top.active = top.parent && v;
          top.taken ||= v;
        }
        out.push("");
        continue;
      }
      if (dir === "else") {
        const top = cond[cond.length - 1];
        if (top) { top.active = top.parent && !top.taken; top.taken = true; }
        out.push("");
        continue;
      }
      if (dir === "endif") {
        cond.pop();
        out.push("");
        continue;
      }
      if (!active()) { out.push(""); continue; }
      if (dir === "define") {
        // Join continuation lines.
        let body = rest;
        let extra = 0;
        while (/\\\s*$/.test(body) && n + 1 < lines.length) {
          body = body.replace(/\\\s*$/, " ") + lines[++n];
          extra++;
        }
        const dm = body.match(/^(\w+)(\(([^)]*)\))?\s*(.*)$/);
        if (dm) {
          const [, name, , params, b] = dm;
          const text = b.trim();
          // A constant may be built from other macros (`define RUN (`IDLE + 1),
          // `define IDLE `W'd0), so its body is expanded before it is judged,
          // and before it is defined (a body that names itself stays as is).
          constants.delete(name);
          const value = !dm[2] && text.includes("`") ? expandMacros(text, macros, constants, n + 1).trim() : text;
          macros.set(name, { params: dm[2] ? params.split(",").map((p) => p.trim()).filter(Boolean) : null, body: text });
          if (!dm[2] && value && CONST_BODY.test(value) && !/\b(begin|end|if|else|case|assign|always)\b/.test(value) && isConst(value)) constants.set(name, value);
        }
        out.push("", ...Array(extra).fill(""));
        continue;
      }
      if (dir === "undef") {
        const name = rest.trim();
        macros.delete(name);
        constants.delete(name);
        out.push("");
        continue;
      }
      if (DROP.test(dir)) { out.push(""); continue; }
    }
    if (!active()) { out.push(""); continue; }
    out.push(expandMacros(line, macros, constants, n + 1));
  }
  return { text: out.join("\n"), constants };
}

function expandMacros(line: string, macros: Map<string, Macro>, constants: Map<string, string>, lineNo: number, depth = 0): string {
  if (depth > 20) throw new VerilogSyntaxError("macro expansion too deep", lineNo);
  if (!line.includes("`")) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      const j = line.indexOf('"', i + 1);
      const stop = j < 0 ? line.length : j + 1;
      out += line.slice(i, stop);
      i = stop;
      continue;
    }
    if (line[i] !== "`") { out += line[i++]; continue; }
    const m = line.slice(i + 1).match(/^\w+/);
    if (!m) { i++; continue; }
    const name = m[0];
    i += 1 + name.length;
    const mac = macros.get(name);
    if (!mac) {
      // Unknown macro (e.g. defined in an `include we cannot read): leave a bare name.
      out += name;
      continue;
    }
    if (constants.has(name)) {
      // `W'd0 is a sized number: the width has to be spliced in as text.
      out += line[i] === "'" ? constants.get(name) : ` ${name} `;
      continue;
    }
    let body = mac.body;
    if (mac.params) {
      // Read the argument list.
      let j = i;
      while (line[j] === " ") j++;
      if (line[j] === "(") {
        let d = 0;
        const args: string[] = [];
        let cur = "";
        for (j = j + 1; j < line.length; j++) {
          const c = line[j];
          if (c === "(" || c === "{" || c === "[") d++;
          if (c === ")" || c === "}" || c === "]") { if (d === 0 && c === ")") break; d--; }
          if (c === "," && d === 0) { args.push(cur.trim()); cur = ""; continue; }
          cur += c;
        }
        args.push(cur.trim());
        i = j + 1;
        mac.params.forEach((p, k) => { body = body.replace(new RegExp(`\\b${p}\\b`, "g"), args[k] ?? ""); });
      }
    }
    out += " " + expandMacros(body, macros, constants, lineNo, depth + 1) + " ";
  }
  return out;
}

const OPS = [
  "<<<=", ">>>=", "<<<", ">>>", "===", "!==", "==?", "!=?", "<<=", ">>=",
  "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "~&", "~|", "~^", "^~", "**", "->", "+:", "-:", "::",
  "++", "--", "+=", "-=", "*=", "/=", "&=", "|=", "^=", "'{",
];

export function tokenize(text: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\f" || c === "\v") { i++; continue; }
    // Attribute (* ... *), but not the @(*) sensitivity list.
    if (c === "(" && text[i + 1] === "*" && text[i + 2] !== ")" && toks[toks.length - 1]?.text !== "@") {
      const end = text.indexOf("*)", i + 2);
      const stop = end < 0 ? n : end + 2;
      line += (text.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      toks.push({ kind: "str", text: text.slice(i, j + 1), line });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j])) j++;
      toks.push({ kind: "id", text: text.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === "\\") {
      // Escaped identifier, up to whitespace.
      let j = i + 1;
      while (j < n && !/\s/.test(text[j])) j++;
      toks.push({ kind: "id", text: text.slice(i + 1, j).replace(/\W/g, "_"), line });
      i = j;
      continue;
    }
    if (c === "$") {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j])) j++;
      toks.push({ kind: "sys", text: text.slice(i, j), line });
      i = j;
      continue;
    }
    // Numbers: 12, 4'b10_1x, 'hFF, 8 'd 255, '0, 1.5
    const num = text.slice(i).match(/^(\d[\d_]*\s*)?'[sS]?[bBoOdDhH]\s*[0-9a-fA-FxXzZ?_]+|^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|^'[01xXzZ]/);
    if (num) {
      toks.push({ kind: "num", text: num[0].replace(/\s+/g, ""), line });
      i += num[0].length;
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) {
      toks.push({ kind: "op", text: op, line });
      i += op.length;
      continue;
    }
    toks.push({ kind: "op", text: c, line });
    i++;
  }
  return toks;
}
