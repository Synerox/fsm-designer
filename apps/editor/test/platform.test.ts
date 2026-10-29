import { test } from "node:test";
import assert from "node:assert/strict";
import { fileError } from "../src/platform.ts";
import { useLang } from "../src/i18n.ts";

test("file errors say which file, open or save, and the common reasons in the UI language", () => {
  // The desktop shell's rejections, as lib.rs formats them.
  assert.equal(fileError("open", "/home/u/x.fsm.json", "/home/u/x.fsm.json: Permission denied (os error 13)").message, "Could not open x.fsm.json: permission denied");
  assert.equal(fileError("save", "C:\\d\\x.fsm.json", "C:\\d\\x.fsm.json: Access is denied. (os error 5)").message, "Could not save x.fsm.json: permission denied");
  assert.equal(fileError("open", "/v/big5.v", "/v/big5.v: stream did not contain valid UTF-8").message, "Could not open big5.v: it is not UTF-8 text");
  assert.equal(fileError("open", "/a/b.v", "/a/b.v: Is a directory (os error 21)").message, "Could not open b.v: Is a directory (os error 21)", "others as the OS said them");
  try {
    useLang.getState().setLang("zh");
    assert.equal(fileError("open", "/home/u/x.fsm.json", "/home/u/x.fsm.json: No such file or directory (os error 2)").message, "無法開啟 x.fsm.json：檔案不存在");
    useLang.getState().setLang("ja");
    assert.equal(fileError("save", "/home/u/x.fsm.json", new Error("/home/u/x.fsm.json: Permission denied (os error 13)")).message, "x.fsm.json を保存できませんでした：アクセス権がありません");
  } finally {
    useLang.getState().setLang("en");
  }
});
