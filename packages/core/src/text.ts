// Label text. Labels hold real Unicode (S₀, β): the editor converts the
// shortcuts "_0" and "\beta" when the user presses space after them (see
// expandShortcut). Exports draw labels as stored; LaTeX turns the Unicode
// (and any shortcut syntax left in older files) back into TeX.

import type { State } from "./model.ts";

const GREEK = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu",
  "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
];
const GREEK_CHAR: Record<string, string> = {};
GREEK.forEach((g, i) => {
  // Skip U+03A2 (no capital final sigma) so capitals line up with lowercase.
  GREEK_CHAR[g] = String.fromCodePoint(0x3b1 + i + (i >= 17 ? 1 : 0));
  GREEK_CHAR[g[0].toUpperCase() + g.slice(1)] = String.fromCodePoint(0x391 + i + (i >= 17 ? 1 : 0));
});
GREEK_CHAR.varepsilon = "ε";
GREEK_CHAR.varphi = "φ";

const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

const CHAR_GREEK: Record<string, string> = {};
for (const [name, ch] of Object.entries(GREEK_CHAR)) CHAR_GREEK[ch] ??= name;
const UNSUB: Record<string, string> = {};
for (const [c, sub] of Object.entries(SUB)) UNSUB[sub] = c;
const SUB_RUN = new RegExp(`[${Object.values(SUB).join("").replace(/[-\\\]]/g, "\\$&")}]+`, "g");
const GREEK_RUN = new RegExp(`[${Object.keys(CHAR_GREEK).join("")}]`, "g");

type Piece = { kind: "text" | "greek" | "sub"; value: string };

/** Split a label into plain text, greek letters and subscripts, in either Unicode or shortcut form. */
function pieces(raw: string, shortcuts: boolean): Piece[] {
  const out: Piece[] = [];
  const short = shortcuts ? `\\\\([A-Za-z]+)|_\\{([^{}]*)\\}|_([0-9])` : `(\\b\\B)()()`; // second form never matches
  const re = new RegExp(`${short}|(${SUB_RUN.source})|(${GREEK_RUN.source})`, "g");
  let last = 0;
  for (let m; (m = re.exec(raw)); ) {
    if (m[1] !== undefined && !(m[1] in GREEK_CHAR)) continue;
    if (m[2] !== undefined && ![...m[2]].every((c) => c in SUB)) continue;
    if (m.index > last) out.push({ kind: "text", value: raw.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "greek", value: m[1] });
    else if (m[4] !== undefined) out.push({ kind: "sub", value: [...m[4]].map((c) => UNSUB[c]).join("") });
    else if (m[5] !== undefined) out.push({ kind: "greek", value: CHAR_GREEK[m[5]] });
    else out.push({ kind: "sub", value: m[2] ?? m[3] });
    last = re.lastIndex;
  }
  if (last < raw.length) out.push({ kind: "text", value: raw.slice(last) });
  return out;
}

/**
 * Typing helper: when the user presses space at `caret`, turn a shortcut just
 * before it into its character ("\beta" -> β, "_0" -> ₀, "_{12}" -> ₁₂) and
 * swallow the space. Returns null when there is nothing to convert, so the
 * caller inserts a normal space.
 */
export function expandShortcut(text: string, caret: number, opts: { subscripts?: boolean } = {}): { text: string; caret: number } | null {
  const before = text.slice(0, caret), after = text.slice(caret);
  const done = (head: string, ch: string) => ({ text: head + ch + after, caret: head.length + ch.length });
  const g = before.match(/\\([A-Za-z]+)$/);
  if (g && g[1] in GREEK_CHAR) return done(before.slice(0, -g[0].length), GREEK_CHAR[g[1]]);
  if (opts.subscripts ?? true) {
    const m = before.match(/_\{([^{}]+)\}$|_([^\s_\\{}]+)$/);
    const body = m && (m[1] ?? m[2]);
    if (m && body && [...body].every((c) => c in SUB)) return done(before.slice(0, -m[0].length), [...body].map((c) => SUB[c]).join(""));
  }
  return null;
}

/** ASCII spelling of a label for use as an identifier: S₀ -> S_0, β -> beta. */
export function asciiText(text: string): string {
  return text.replace(SUB_RUN, (run) => "_" + [...run].map((c) => UNSUB[c]).join("")).replace(GREEK_RUN, (c) => CHAR_GREEK[c]);
}

/** Old shortcut syntax ("S_0", "\beta") turned into Unicode, for labels written by hand or by agents. */
export function prettyText(raw: string): string {
  return pieces(raw, true).map((p) => (p.kind === "greek" ? GREEK_CHAR[p.value] : p.kind === "sub" ? [...p.value].map((c) => SUB[c]).join("") : p.value)).join("");
}

/** Escape for LaTeX text mode. */
export function texEscape(s: string): string {
  return s.replace(/[\\{}$&#^_%~<>|]/g, (c) => ({
    "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", $: "\\$", "&": "\\&", "#": "\\#",
    "^": "\\textasciicircum{}", _: "\\_", "%": "\\%", "~": "\\textasciitilde{}",
    // OT1 (the default font encoding) prints < > | as ¡ ¿ —.
    "<": "\\textless{}", ">": "\\textgreater{}", "|": "\\textbar{}",
  })[c]!);
}

/** Label text for LaTeX text mode: β becomes $\beta$, S₀ becomes S$_{0}$, everything else is escaped as typed. */
export function latexText(raw: string): string {
  return pieces(raw, false).map((p) => (p.kind === "greek" ? `$\\${p.value}$` : p.kind === "sub" ? `$_{${p.value}}$` : texEscape(p.value))).join("");
}

/** The raw text a state shows: its free-form label if set, else its identifier. */
export function stateText(s: State): string {
  return s.label ?? s.name;
}

/** What a state shows on screen and in SVG/PNG: its label exactly as stored, else its identifier. */
export function stateDisplay(s: State): string {
  return s.label ?? s.name;
}
