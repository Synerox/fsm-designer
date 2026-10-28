// textWidth: the width estimate behind label rects, export bounds and fitted
// state sizes, for scripts other than Latin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addState, createDiagram, fitStateSizes, planDiagram, textWidth } from "../../src/index.ts";

const em = (s: string) => Math.round((textWidth(s, 10) / 10) * 100) / 100;

test("Hangul, fullwidth forms and emoji count as wide characters", () => {
  assert.equal(em("日本語テ"), 4, "CJK and kana, as before");
  assert.equal(em("한국어다"), 4);
  assert.equal(em("ＡＢＣＤ"), 4);
  assert.equal(em("１２３４"), 4);
  assert.equal(em("（，）："), 4, "the punctuation Chinese and Japanese input methods type");
  assert.equal(em("😀😀😀😀"), 5);
  assert.equal(em("abcd"), 2.24, "Latin is unchanged");
  assert.equal(em("S_0 == 1"), 4.72);
});

test("joined emoji, skin tones and combining marks add no width of their own", () => {
  assert.equal(em("👨‍👩‍👧‍👦"), em("😀"), "a ZWJ family is one glyph");
  assert.equal(em("👍🏽"), em("👍"));
  assert.equal(em("❤️"), em("❤"), "variation selector");
  assert.equal(em("é"), em("e"), "e + combining acute");
});

test("a Hangul name grows its state and the picture like a CJK one", () => {
  const fitted = (label: string) => {
    const d = createDiagram({ name: "m" });
    addState(d, { name: "S0", label, x: 0, y: 0 });
    fitStateSizes(d);
    return [d.states[0].radius, planDiagram(d).bounds.maxX];
  };
  assert.deepEqual(fitted("상태기계상태기계"), fitted("狀態機器狀態機器"));
});
