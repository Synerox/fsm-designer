// TikZ export details: node names, edge geometry, label fonts, loop angles and label text (Greek, symbols, CJK).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, addTransition, asciiText, createDiagram, latexText, parseDiagram, prettyText, renderLatex } from "../../src/index.ts";

/** Every `\node[state...] (name) at (x, y)` of the output, by name. */
function stateNodes(tex: string): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const m of tex.matchAll(/\\node\[state[^\]]*\] \(([^)]*)\) at \((-?[\d.]+), (-?[\d.]+)\)/g)) out.set(m[1], { x: Number(m[2]), y: Number(m[3]) });
  return out;
}

test("latex node names stay distinct when ids differ only in punctuation or script", () => {
  const d = parseDiagram({
    name: "ids",
    states: [
      { id: "a-1", name: "A", x: 0, y: 0, isInitial: true },
      { id: "a1", name: "B", x: 200, y: 0 },
      { id: "---", name: "C", x: 400, y: 0 },
      { id: "空闲", name: "D", x: 600, y: 0 },
      { id: "s4", name: "E", x: 800, y: 0 },
    ],
    transitions: [
      { from: "a-1", to: "a1" },
      { from: "---", to: "空闲" },
    ],
  });
  const tex = renderLatex(d);
  const nodes = stateNodes(tex);
  assert.equal(nodes.size, 5, `one node name per state: ${[...nodes.keys()].join(" ")}`);
  assert.ok(![...nodes.keys()].includes(""), "no empty node name");
  assert.equal(nodes.get("a1")?.x, 5, "a plain alphanumeric id keeps its own name");
  assert.ok(nodes.has("s4"), "editor-style ids are kept as they are");
  // Each edge joins the two circles it was drawn between.
  const at = (x: number) => [...nodes].find(([, p]) => p.x === x)![0];
  assert.match(tex, new RegExp(`\\(${at(0)}\\) edge\\[\\] \\(${at(5)}\\)`));
  assert.match(tex, new RegExp(`\\(${at(10)}\\) edge\\[\\] \\(${at(15)}\\)`));
});

test("latex draws a transition with non-numeric geometry as a plain line instead of crashing", () => {
  const d = createDiagram({ name: "m" });
  addState(d, { name: "A", x: 0, y: 0, isInitial: true });
  addState(d, { name: "B", x: 200, y: 0 });
  const t = addTransition(d, { from: "A", to: "B" });
  (t as unknown as { curve: unknown }).curve = "abc"; // as a hand-edited .fsm.json can hold
  // The plan treats a curve that is not a finite number as unset (svg.ts given()).
  const tex = renderLatex(d);
  assert.match(tex, /\(s0\) edge\[\] \(s1\)/);
  assert.doesNotMatch(tex, /NaN/);
});

test("straight edges both ways keep their ends on the circles in latex, whatever the gap", () => {
  const d = createDiagram({ name: "m" });
  addState(d, { name: "A", x: 0, y: 0, isInitial: true });
  addState(d, { name: "B", x: 200, y: 0 });
  addTransition(d, { from: "A", to: "B", curve: 0 });
  addTransition(d, { from: "B", to: "A", curve: 0, gap: 48 }); // the Inspector's maximum for r = 30
  const tex = renderLatex(d);
  assert.doesNotMatch(tex, /transform canvas/);
  // Each end is the border anchor of its own circle at the angle where the
  // SVG line meets it: o = 24 px off the centre line, so asin(24 / 30) = 53.1°.
  const segs = [...tex.matchAll(/\\draw\[->\] \((\w+)\.(-?[\d.]+)\) -- \((\w+)\.(-?[\d.]+)\);/g)].map((m) => [m[1], Number(m[2]), m[3], Number(m[4])]);
  assert.deepEqual(segs, [["s0", 53.1, "s1", 126.9], ["s1", -126.9, "s0", -53.1]]);
});

test("an edge label sized 13 px by hand prints like the default size, not smaller", () => {
  const d = createDiagram({ name: "m" });
  addState(d, { name: "A", x: 0, y: 0, isInitial: true });
  addState(d, { name: "B", x: 200, y: 0 });
  addState(d, { name: "C", x: 0, y: 200 });
  addTransition(d, { from: "A", to: "B", condition: "x", fontSize: 13 });
  addTransition(d, { from: "A", to: "C", condition: "y", fontSize: 15 });
  const tex = renderLatex(d);
  assert.match(tex, /\\fontsize\{7pt\}\{8\.4pt\}\\selectfont\\ttfamily[^\n]*\{x\}/, "13 px = \\scriptsize = 7 pt");
  assert.match(tex, /\\fontsize\{8\.1pt\}[^\n]*\{y\}/, "bigger in the editor, bigger in TeX");
});

test("latex loop angles stay within one turn whatever loopAngle holds", () => {
  const d = createDiagram({ name: "m" });
  addState(d, { name: "A", x: 0, y: 0, isInitial: true });
  addState(d, { name: "B", x: 200, y: 0 });
  addState(d, { name: "C", x: 400, y: 0 });
  addTransition(d, { from: "A", to: "A", loopAngle: 1000 });
  addTransition(d, { from: "B", to: "B", loopAngle: -7.5 });
  addTransition(d, { from: "C", to: "C", loopAngle: -Math.PI / 2 }); // straight up
  const loops = [...renderLatex(d).matchAll(/loop, out=(-?\d+), in=(-?\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(loops.length, 3);
  for (const [out, inn] of loops) assert.ok(Math.abs(out) <= 210 && Math.abs(inn) <= 210, `out=${out}, in=${inn}`);
  // Same direction as before, only wrapped: -7.5 rad is 430 deg, i.e. 70 deg.
  assert.deepEqual(loops[1], [100, 40]);
  assert.deepEqual(loops[2], [120, 60]);
});

test("latexText writes Greek with the TeX letter that looks like the screen", () => {
  // Unicode ε and φ are TeX's \varepsilon and \varphi; ϵ and ϕ are \epsilon and \phi.
  assert.equal(latexText("ε φ ϵ ϕ"), "$\\varepsilon$ $\\varphi$ $\\epsilon$ $\\phi$");
  // Capitals that look like Latin letters (and omicron) have no macro: \Alpha would not compile.
  assert.equal(latexText("Α Β Ο ο Χ"), "A B O $o$ X");
  assert.equal(latexText("Γ Σ Ω β"), "$\\Gamma$ $\\Sigma$ $\\Omega$ $\\beta$");
  assert.equal(asciiText("ε φ"), "epsilon phi", "identifiers keep the plain names");
});

test("latexText turns math symbols into TeX and drops invisible direction marks", () => {
  assert.equal(latexText("x ≥ 1 ∧ ¬y → z"), "x $\\geq$ 1 $\\wedge$ $\\neg$y $\\rightarrow$ z");
  assert.equal(latexText("∑ ≠ ×"), "$\\sum$ $\\neq$ $\\times$");
  assert.equal(latexText("rtl ‮evil‬"), "rtl evil");
  assert.equal(latexText("Ñandú 狀態"), "Ñandú 狀態", "letters stay as typed");
});

test("latex asks for xelatex or lualatex, with CJK fonts, only when labels need them", () => {
  const d = createDiagram({ name: "m" });
  addState(d, { name: "A", label: "S₀ ≥ Ñ", x: 0, y: 0, isInitial: true });
  addState(d, { name: "B", x: 200, y: 0 });
  addTransition(d, { from: "A", to: "B", condition: "x ≥ 1" });
  const plain = renderLatex(d);
  assert.doesNotMatch(plain, /RequireTUTeX|ctex|xelatex/, "Latin text and symbols still compile with pdflatex");
  d.states[1].label = "空闲";
  const cjk = renderLatex(d);
  assert.match(cjk, /^% Some labels are Chinese, Japanese or Korean: compile with xelatex or lualatex/m);
  assert.match(cjk, /\\documentclass[^\n]*\n\\usepackage\{iftex\}\n\\RequireTUTeX\n\\usepackage\[UTF8, scheme=plain\]\{ctex\}\n/);
  // Fandol, ctex's default on Linux, prints Korean and some Traditional Chinese blank: say so, with a font line to uncomment.
  assert.match(cjk, /^% Some labels are Chinese[^\n]*print blank[^\n]*Fandol[^\n]*Korean/m);
  assert.match(cjk, /\{ctex\}\n% \\setCJKmainfont\{Noto Serif CJK TC\}\\setCJKsansfont\{Noto Sans CJK TC\}\\setCJKmonofont\{Noto Sans CJK TC\} % if characters are missing: uncomment/);
  assert.doesNotMatch(cjk, /setmainfont/, "CJK alone needs no Latin font");
  assert.match(renderLatex(d, { standalone: false }), /^% Some labels are Chinese/, "a bare picture still says what it needs");
  d.states[1].label = "🚦";
  const emoji = renderLatex(d);
  assert.match(emoji, /\\RequireTUTeX/);
  assert.doesNotMatch(emoji, /ctex/);
  d.states[1].label = "Ожидание";
  const cyrillic = renderLatex(d);
  assert.match(cyrillic, /^% Some labels use characters pdflatex cannot typeset[^\n]*print blank/m);
  assert.match(cyrillic, /\n% \\usepackage\{fontspec\}\\setmainfont\{DejaVu Serif\}\\setmonofont\{DejaVu Sans Mono\} % if characters are missing: uncomment/);
  // Inside Latin-1 and Latin Extended-A, OT1 pdflatex still lacks primes, guillemets, eth, ogonek letters, ...
  d.states[1].label = "S′ x″";
  const prime = renderLatex(d);
  assert.match(prime, /\{S\$'\$ x\$''\$\}/, "primes become TeX primes");
  assert.doesNotMatch(prime, /RequireTUTeX|xelatex/);
  for (const label of ["«x»", "Ðþ", "Ąę", "„x“", "‹x›"]) {
    d.states[1].label = label;
    assert.match(renderLatex(d), /\\RequireTUTeX/, `${label} needs xelatex or lualatex`);
  }
});

test("prettyText leaves empty subscript braces as typed", () => {
  assert.equal(prettyText("_{}"), "_{}");
  assert.equal(prettyText("S_{}x"), "S_{}x");
  assert.equal(prettyText("S_{12}"), "S₁₂");
});

test("a straight pair between states at the same place writes no NaN into the TeX", () => {
  const d = createDiagram({ name: "same" });
  addState(d, { name: "A", x: 0, y: 0, isInitial: true });
  addState(d, { name: "B", x: 0, y: 0 });
  addTransition(d, { from: "A", to: "B", curve: 0 });
  addTransition(d, { from: "B", to: "A", curve: 0 });
  const out = renderLatex(d);
  assert.doesNotMatch(out, /NaN/);
  assert.equal(out.match(/\\draw\[->\] \(s\d\.-?[\d.]+\) -- \(s\d\.-?[\d.]+\);/g)?.length, 2);
});
