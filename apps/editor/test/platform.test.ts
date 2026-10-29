import { test } from "node:test";
import assert from "node:assert/strict";
import { fileError } from "../src/platform.ts";
import { useLang } from "../src/i18n.ts";

test("file errors say which file, open or save, and why in the UI language", () => {
  assert.equal(fileError("open", "x.fsm.json", new Error("Unexpected token")).message, "Could not open x.fsm.json: Unexpected token");
  assert.equal(fileError("save", "dir/x.fsm.json", "quota exceeded").message, "Could not save x.fsm.json: quota exceeded");
  try {
    useLang.getState().setLang("zh");
    assert.equal(fileError("open", "x.fsm.json", "bad").message, "無法開啟 x.fsm.json：bad");
    useLang.getState().setLang("ja");
    assert.equal(fileError("save", "x.fsm.json", new Error("bad")).message, "x.fsm.json を保存できませんでした：bad");
  } finally {
    useLang.getState().setLang("en");
  }
});
