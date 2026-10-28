// Keyboard behaviour shared by the modal dialogs (LaTeX export, Import Verilog
// and the in-page "Discard changes?" confirm). Each is a .modal box inside a
// .modal-backdrop. While one is open the editor's window shortcuts stand down
// (see modalOpen), Escape cancels the topmost dialog wherever focus is, Tab
// cycles inside it, and focus goes back to where it was when it closes.

import { useEffect, useRef } from "react";

/** True while any modal dialog is on screen. */
export function modalOpen(): boolean {
  return document.querySelector(".modal-backdrop") !== null;
}

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]";

function focusables(box: Element): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
}

/** The dialog on top: backdrops all share one z-index, so the last one in the page. */
function topmost(): Element | null {
  const all = document.querySelectorAll(".modal-backdrop .modal");
  return all[all.length - 1] ?? null;
}

/**
 * Make `box` (a .modal) behave as a modal dialog until the returned function
 * is called: focus moves into it (unless the caller already put it there),
 * Escape calls `cancel`, and Tab stays inside. The returned function puts
 * focus back on the element that had it, or into the dialog underneath when
 * that element is gone or disabled.
 */
export function modalKeys(box: HTMLElement, cancel: () => void): () => void {
  const opener = document.activeElement as HTMLElement | null;
  if (!box.contains(document.activeElement)) focusables(box)[0]?.focus();
  const onKey = (e: KeyboardEvent) => {
    if (topmost() !== box || e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables(box);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey ? at <= 0 : at === -1 || at === items.length - 1) {
      e.preventDefault();
      items[e.shiftKey ? items.length - 1 : 0].focus();
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => {
    window.removeEventListener("keydown", onKey, true);
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected && !box.contains(now)) return; // focus already moved on
    const others = [...document.querySelectorAll(".modal-backdrop .modal")].filter((m) => m !== box);
    const under = others[others.length - 1] ?? null;
    const usable = opener && opener !== document.body && opener.isConnected && !(opener as HTMLButtonElement).disabled && (!under || under.contains(opener));
    if (usable) opener.focus();
    else if (under) focusables(under)[0]?.focus();
  };
}

/** modalKeys for a React dialog: put the returned ref on its .modal box. */
export function useModal<T extends HTMLElement>(cancel: () => void) {
  const ref = useRef<T>(null);
  const latest = useRef(cancel);
  useEffect(() => { latest.current = cancel; });
  useEffect(() => modalKeys(ref.current!, () => latest.current()), []);
  return ref;
}
