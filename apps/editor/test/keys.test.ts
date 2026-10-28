// The window keydown handler's decisions: what a key types, what deletes,
// when Space presses a button, and what Cut removes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteCopied, deletesSelection, keyPressesButton, typedText } from "../src/keys.ts";
import { copySelection, createState, createTransition, hasClipboard, multiSelection, newDiagram, pasteClipboard, setInitial } from "../src/store.ts";

const key = (k: string, mods: { ctrl?: boolean; alt?: boolean; meta?: boolean } = {}) =>
  ({ key: k, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta });

test("AltGr and Option characters are typed; shortcut chords are not", () => {
  assert.equal(typedText(key("a")), "a");
  assert.equal(typedText(key("\\", { ctrl: true, alt: true })), "\\", "Windows AltGr arrives as Ctrl+Alt");
  assert.equal(typedText(key("[", { ctrl: true, alt: true })), "[");
  assert.equal(typedText(key("ą", { ctrl: true, alt: true })), "ą");
  assert.equal(typedText(key("@", { alt: true })), "@", "macOS Option");
  assert.equal(typedText(key("|", { alt: true })), "|");
  assert.equal(typedText(key("f", { alt: true })), null, "Alt+F is a browser/menu chord");
  assert.equal(typedText(key("z", { ctrl: true, alt: true })), null);
  assert.equal(typedText(key("c", { ctrl: true })), null);
  assert.equal(typedText(key("[", { meta: true })), null);
  assert.equal(typedText(key("ArrowLeft", { alt: true })), null);
});

test("Backspace deletes a multiple selection or the start arrow, but edits text on one item", () => {
  const multi = multiSelection(["a", "b"], [], false);
  assert.equal(deletesSelection("Backspace", multi), true);
  assert.equal(deletesSelection("Backspace", { kind: "initial" }), true);
  assert.equal(deletesSelection("Backspace", { kind: "state", id: "a" }), false);
  assert.equal(deletesSelection("Backspace", { kind: "edge", from: "a", to: "b" }), false);
  assert.equal(deletesSelection("Delete", { kind: "state", id: "a" }), true);
  assert.equal(deletesSelection("Delete", null), false);
});

test("Space presses a button reached from the keyboard, but types after a mouse click on it", () => {
  const button = { tagName: "BUTTON" } as unknown as Element;
  const target = { closest: (sel: string) => (sel === "button" ? button : null) };
  const body = { closest: () => null };
  assert.equal(keyPressesButton(" ", target, null), true);
  assert.equal(keyPressesButton("Enter", target, null), true);
  assert.equal(keyPressesButton(" ", target, button), false, "the user clicked it, then typed");
  assert.equal(keyPressesButton("a", target, null), false);
  assert.equal(keyPressesButton(" ", body, null), false);
});

test("cut removes only what it copied; a lone line and the start arrow stay", () => {
  const d = newDiagram();
  const a = createState(d, 0, 0), b = createState(d, 100, 0), c = createState(d, 200, 0);
  createTransition(d, b.id, c.id);
  setInitial(d, b.id, Math.PI);
  const sel = multiSelection([a.id], [{ from: b.id, to: c.id }], true);
  assert.equal(copySelection(d, sel), 1);
  const kept = deleteCopied(d, sel);
  assert.deepEqual(d.states.map((s) => s.id), [b.id, c.id]);
  assert.equal(d.transitions.length, 1, "the line was not on the clipboard, so it is not deleted");
  assert.ok(d.states[0].isInitial);
  assert.deepEqual(kept, multiSelection([], [{ from: b.id, to: c.id }], true), "what was not cut stays selected");
  assert.ok(hasClipboard());
  pasteClipboard(d);
  assert.equal(d.states.length, 3);
});

test("cut takes a state's lines with it", () => {
  const d = newDiagram();
  const a = createState(d, 0, 0), b = createState(d, 100, 0);
  createTransition(d, a.id, b.id);
  createTransition(d, a.id, a.id);
  const sel = multiSelection([a.id], [{ from: a.id, to: b.id }], false);
  assert.equal(copySelection(d, sel), 2, "the state and its self loop");
  const kept = deleteCopied(d, sel);
  assert.deepEqual(d.states.map((s) => s.id), [b.id]);
  assert.equal(d.transitions.length, 0);
  assert.equal(kept, null);
});
