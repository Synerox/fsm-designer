// Decisions behind the editor's window keydown handler (App.tsx), kept free of
// React and the DOM so the tests can check them directly.

import { deleteSelection, multiSelection, selectionParts } from "./store.ts";
import type { Selection } from "./store.ts";
import type { FsmDiagram } from "@fsm/core";

type KeyInfo = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey">;

/**
 * The character a key press types into the selected state or line, or null.
 * AltGr (sent as Ctrl+Alt on Windows) and macOS Option type characters such
 * as \ [ ] { } @ | or ą on many keyboard layouts, so an Alt chord counts as
 * text unless it gives an ASCII letter or digit (Alt+F, Ctrl+Alt+Z are
 * shortcut chords). Ctrl or Cmd alone never types.
 */
export function typedText(e: KeyInfo): string | null {
  if (e.key.length !== 1 || e.metaKey) return null;
  if (!e.ctrlKey && !e.altKey) return e.key;
  if (e.altKey && !/[A-Za-z0-9]/.test(e.key)) return e.key;
  return null;
}

/**
 * Whether a key deletes the selection. Backspace also deletes when there is
 * no text to edit (a multiple selection or the start arrow), since it is the
 * key labelled "delete" on Mac keyboards; on one state or line it edits text.
 */
export function deletesSelection(key: string, sel: Selection): boolean {
  if (!sel) return false;
  return key === "Delete" || (key === "Backspace" && (sel.kind === "multi" || sel.kind === "initial"));
}

/**
 * Whether Space or Enter should press the focused button rather than type
 * into the selection. A button reached with Tab (or focused by a menu or
 * dialog) is being used from the keyboard; one the user just clicked keeps
 * focus in Chromium, and Space after it is still meant as typing.
 */
export function keyPressesButton(key: string, target: Pick<Element, "closest">, clicked: Element | null): boolean {
  if (key !== " " && key !== "Enter") return false;
  // Space toggles a focused checkbox the same way it presses a button.
  const button = target.closest(PRESSABLE);
  return button !== null && button !== clicked;
}

/** Controls that Space presses (the focus a mouse click leaves is remembered as `clicked`). */
export const PRESSABLE = "button, input[type=checkbox], input[type=radio]";

// <input> types that take no typing: the editor's shortcuts still apply while
// one has focus (Chromium leaves focus on a checkbox after a click on it).
const KEYLESS_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/**
 * Whether the focused element takes keys for itself, so the editor's
 * shortcuts and typing must leave them alone: a text or number field, a
 * select list, or an open menu. A checkbox does not: Ctrl+Z after toggling
 * one undoes the toggle, as after any button.
 */
export function ownsKeys(target: Pick<Element, "closest">): boolean {
  const el = target.closest("input, textarea, select, [role=menu]");
  if (!el) return false;
  return !(el.tagName === "INPUT" && KEYLESS_INPUTS.has((el as HTMLInputElement).type));
}

// Text is edited on the canvas by whole characters as the user sees them: an
// emoji is two UTF-16 code units (or more, joined), and stepping or deleting
// one unit would leave half a character in the saved file.
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Offsets in `text` where the caret may stand, in order (0 and text.length included). */
function caretStops(text: string): number[] {
  if (graphemes) return [...[...graphemes.segment(text)].map((s) => s.index), text.length];
  // Without Intl.Segmenter, keep at least surrogate pairs whole.
  const stops = [0];
  for (const ch of text) stops.push(stops[stops.length - 1] + ch.length);
  return stops;
}

/** `caret` moved back onto a character boundary, if it was inside one. */
export function snapCaret(text: string, caret: number): number {
  const stops = caretStops(text);
  let at = 0;
  for (const s of stops) if (s <= caret) at = s;
  return at;
}

/** The caret one whole character to the left (dir -1) or right (dir 1). */
export function stepCaret(text: string, caret: number, dir: -1 | 1): number {
  const stops = caretStops(text);
  if (dir < 0) return stops.filter((s) => s < caret).pop() ?? 0;
  return stops.find((s) => s > caret) ?? text.length;
}

/**
 * The delete half of Cut, run after copySelection copied `sel`: delete what
 * was copied, which is the selected states (their lines go with them). Lines
 * without both ends selected and the start arrow can't be copied, so they
 * stay in the diagram rather than being lost; the return value is what is
 * left of the selection, to keep it selected.
 */
export function deleteCopied(d: FsmDiagram, sel: Selection): Selection {
  const { states, edges, initial } = selectionParts(sel);
  deleteSelection(d, multiSelection(states, [], false));
  const left = edges.filter((e) => d.transitions.some((t) => t.from === e.from && t.to === e.to));
  return multiSelection([], left, initial && d.states.some((s) => s.isInitial));
}
