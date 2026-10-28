// LaTeX export: a TikZ picture using the `automata` library, keeping the
// diagram's coordinates (1 cm = 40 px by default).

import { unreachableStates } from "../model.ts";
import type { FsmDiagram } from "../model.ts";
import { stateRadius } from "../metrics.ts";
import { drawnSubLines, planDiagram } from "./svg.ts";
import type { PlanOptions } from "./svg.ts";
import { latexText, texEscape as tex } from "../text.ts";

export interface LatexOptions extends PlanOptions {
  standalone?: boolean; // wrap in a compilable \documentclass{standalone}; default true
  pxPerCm?: number; // default 40
}

/**
 * TikZ node names for the states. Ids that are already plain alphanumerics
 * (the editor's "s0", "s1", ...) are kept; any other id is stripped to
 * alphanumerics and, if that leaves nothing or clashes with another name,
 * numbered. Without this, ids "a-1" and "a1" (or "空闲" and "忙", both empty)
 * named the same node and edges attached to the wrong circle.
 */
function nodeNames(d: FsmDiagram): Map<string, string> {
  const safe = (id: string) => /^[A-Za-z0-9]+$/.test(id);
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const s of d.states) if (safe(s.id)) { names.set(s.id, s.id); used.add(s.id); }
  d.states.forEach((s, i) => {
    if (names.has(s.id)) return;
    const base = s.id.replace(/[^A-Za-z0-9]/g, "") || `state${i}`;
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base}x${k}`;
    names.set(s.id, name);
    used.add(name);
  });
  return names;
}

/** TikZ automata only draws the start arrow on four sides; pick the nearest. */
function texFont(pt: number): string {
  const p = Math.round(pt * 10) / 10;
  return `\\fontsize{${p}pt}{${Math.round(p * 12) / 10}pt}\\selectfont`;
}

function initialSide(angle = Math.PI): string {
  const k = Math.round(angle / (Math.PI / 2)) & 3; // screen coords: 0 right, 1 below, 2 left, 3 above
  return ["right", "below", "left", "above"][k];
}

export function renderLatex(d: FsmDiagram, opts: LatexOptions = {}): string {
  const missing = d.states.filter((s) => s.x === undefined || s.y === undefined);
  if (missing.length) throw new Error(`States without positions: ${missing.map((s) => s.name).join(", ")}. Run auto layout first.`);
  const k = opts.pxPerCm ?? 40;
  const ID = nodeNames(d);
  const lines: string[] = [];
  lines.push(`\\begin{tikzpicture}[>=Stealth, shorten >=1pt, auto, node distance=2.5cm, semithick,`);
  lines.push(`  every state/.style={draw, inner sep=0pt, font=\\footnotesize}, initial text=,`);
  lines.push(`  every edge/.append style={font=\\scriptsize}]`);
  const lost = unreachableStates(d); // drawn dashed
  for (const s of d.states) {
    const flags = ["state", s.isInitial ? `initial, initial where=${initialSide(s.initialAngle)}` : "", s.isAccepting ? "accepting" : "", lost.has(s.id) ? "dashed" : ""].filter(Boolean).join(", ");
    const o = drawnSubLines(d, s, opts);
    const name = s.label !== undefined ? latexText(s.label) : tex(s.name);
    const body = o.length ? `\\shortstack{${name}\\\\\\rule{0.8cm}{0.2pt}${o.map((l) => `\\\\\\scriptsize\\texttt{${tex(l)}}`).join("")}}` : name;
    // SVG y grows downward; TikZ y grows upward.
    const size = `minimum size=${((2 * stateRadius(d, s)) / k).toFixed(2)}cm`;
    // Only sizes set by hand get an explicit font; 15 px (the default) ~ \footnotesize (8 pt).
    const font = s.fontSize !== undefined ? `, font=${texFont((s.fontSize * 8) / 15)}` : "";
    lines.push(`  \\node[${flags}, ${size}${font}] (${ID.get(s.id)}) at (${(s.x! / k).toFixed(2)}, ${(-s.y! / k).toFixed(2)}) {${body}};`);
  }
  // Reuse the SVG renderer's routing so both exports bend and loop the same way.
  const plan = planDiagram(d, opts);
  const edgeLines: string[] = [];
  const curveLines: string[] = [];
  const labelLines: string[] = [];
  for (const e of plan.edges) {
    const { from, to } = e.transitions[0];
    // Labels go where the SVG renderer placed them (it avoids states and other
    // edges), as separate nodes rather than TikZ's midway edge labels.
    if (e.label && e.lines.length)
      labelLines.push(`  \\node[font=${e.transitions[0].fontSize !== undefined ? texFont((e.fontSize * 6) / 13) : "\\scriptsize"}\\ttfamily, align=center, fill=white, inner sep=1pt] at (${(e.label.x / k).toFixed(2)}, ${(-e.label.y / k).toFixed(2)}) {${e.lines.map(latexText).join("\\\\")}};`);
    let shape = "";
    if (e.loopAngle !== undefined) {
      const deg = Math.round((-e.loopAngle * 180) / Math.PI); // TikZ y axis points up
      shape = `loop, out=${deg + 30}, in=${deg - 30}, looseness=6`;
    } else if (e.offset) {
      shape = `transform canvas={shift={(${(e.offset.x / k).toFixed(3)}cm, ${(-e.offset.y / k).toFixed(3)}cm)}}`;
    } else if (e.curve !== 0) {
      // The SVG route as an explicit Bézier: TikZ's `bend` overflows ("Dimension
      // too large") on long edges, and this way both exports match exactly.
      const [x0, y0, cx, cy, x1, y1] = e.path.match(/-?[\d.]+/g)!.map((v) => Number(v) / k);
      const pt = (x: number, y: number) => `(${x.toFixed(2)}, ${(-y).toFixed(2)})`;
      curveLines.push(`  \\draw[->] ${pt(x0, y0)} .. controls ${pt(x0 + ((cx - x0) * 2) / 3, y0 + ((cy - y0) * 2) / 3)} and ${pt(x1 + ((cx - x1) * 2) / 3, y1 + ((cy - y1) * 2) / 3)} .. ${pt(x1, y1)};`);
      continue;
    }
    edgeLines.push(`    (${ID.get(from)}) edge[${shape}] (${ID.get(to)})`);
  }
  if (edgeLines.length) lines.push(`  \\path[->]`, ...edgeLines, `  ;`);
  lines.push(...curveLines);
  lines.push(...labelLines);
  lines.push(`\\end{tikzpicture}`);
  if (opts.standalone === false) return lines.join("\n") + "\n";
  return [
    `% Generated by FSM Designer: ${d.name}`,
    `\\documentclass[tikz, border=8pt]{standalone}`,
    `\\usetikzlibrary{automata, positioning, arrows.meta, quotes}`,
    `\\begin{document}`,
    ...lines,
    `\\end{document}`,
    ``,
  ].join("\n");
}
