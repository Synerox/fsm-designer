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
  const button = target.closest("button");
  return button !== null && button !== clicked;
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
