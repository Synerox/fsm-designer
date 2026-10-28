// Shared size estimates so layout and renderers agree on how big a state is.
// There is no font engine here, so widths are averages for a sans-serif face.

import { STATE_RADIUS } from "./model.ts";
import { stateDisplay } from "./text.ts";
import type { FsmDiagram, OutputValue, State } from "./model.ts";

export const NAME_SIZE = 15;
export const SMALL_SIZE = 12;
export const LABEL_SIZE = 13;

// Characters about 1 em wide: CJK (with Chinese/Japanese punctuation), kana,
// Hangul, fullwidth forms (the （，）：１ that Chinese and Japanese input
// methods type) and symbols that usually show as emoji.
const WIDE = /[\u1100-\u115F\u2600-\u27BF\u2E80-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
// Emoji pictographs, drawn a little wider than 1 em.
const EMOJI = /[\u{1F000}-\u{1FAFF}]/u;
// Combining marks, zero-width spaces and joiners, variation selectors, skin
// tones and tag characters change the glyph before them and add no width.
const ZERO = /[\u0300-\u036F\u200B-\u200F\u2060\u20D0-\u20FF\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0000}-\u{E007F}]/u;

export function textWidth(s: string, size: number, bold = false): number {
  let w = 0, joined = false;
  for (const ch of s) {
    if (ch < "\u0300") w += /[A-Z0-9_=]/.test(ch) ? 0.68 : /[il!.,:;'|1 ]/.test(ch) ? 0.32 : 0.56;
    // A character after a zero-width joiner merges into one emoji with the one before it.
    else if (!joined && !ZERO.test(ch)) w += EMOJI.test(ch) ? 1.25 : WIDE.test(ch) ? 1 : 0.56;
    joined = ch === "\u200D";
  }
  return w * size * (bold ? 1.06 : 1);
}

export function formatOutputs(o: Record<string, OutputValue>): string {
  return Object.entries(o).map(([k, v]) => `${k}=${typeof v === "boolean" ? Number(v) : v}`).join(", ");
}

/**
 * Lines shown under the state name (outputs that depend on the state only):
 * one line if short, else one per output. Mealy machines can have them too
 * (an output that depends on the state alone, e.g. an imported "busy").
 */
export function stateSubLines(_d: FsmDiagram, s: State): string[] {
  if (!Object.keys(s.outputs).length) return [];
  const one = formatOutputs(s.outputs);
  if (one.length <= 16) return [one];
  return Object.entries(s.outputs).map(([k, v]) => formatOutputs({ [k]: v }));
}

export const SUB_LINE_H = SMALL_SIZE * 1.2;

/**
 * A state's radius: its own size if set, else the default. Text never changes
 * it. A hand-edited file can hold 0, a negative size or null, which would draw
 * an invalid circle and NaN self loops: those get the default, and tiny sizes
 * the editor's minimum of 10.
 */
export function stateRadius(_d: FsmDiagram, s: State): number {
  const r = s.radius;
  return r === undefined || !Number.isFinite(r) || r <= 0 ? STATE_RADIUS : Math.max(r, 10);
}

/**
 * Imported or agent-built names and outputs are often longer than a
 * hand-drawn "S0": grow every state to one size, big enough for its text (up
 * to a limit, past which the name's font shrinks instead). Never shrinks a
 * state that is already bigger. The editor calls this only on opened files
 * that come without coordinates; there, text never resizes a drawn state.
 */
export function fitStateSizes(d: FsmDiagram): void {
  const MAX = 64;
  const need = (name: string, size: number, subs: string[]) => {
    const w = Math.max(textWidth(name, size, true), ...subs.map((l) => textWidth(l, SMALL_SIZE)));
    const h = size + (subs.length ? 6 + subs.length * SUB_LINE_H : 0);
    return Math.hypot(w / 2, h / 2) + 3;
  };
  let r = STATE_RADIUS;
  for (const s of d.states) r = Math.max(r, need(stateDisplay(s), NAME_SIZE, stateSubLines(d, s)));
  if (r <= STATE_RADIUS) return;
  r = Math.min(MAX, Math.ceil(r / 4) * 4);
  for (const s of d.states) {
    if ((s.radius ?? STATE_RADIUS) < r) s.radius = r;
    const own = s.radius ?? STATE_RADIUS;
    let size = NAME_SIZE;
    while (size > 9 && need(stateDisplay(s), size, stateSubLines(d, s)) > own) size--;
    if (size !== NAME_SIZE && s.fontSize === undefined) s.fontSize = size;
  }
}

export function stateFontSize(s: State): number {
  return s.fontSize ?? NAME_SIZE;
}

export function transitionFontSize(t: { fontSize?: number }): number {
  return t.fontSize ?? LABEL_SIZE;
}
