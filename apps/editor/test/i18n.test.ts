// UI text that reaches native dialogs follows the UI language.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useLang } from "../src/i18n.ts";
import { FSM_FILTER } from "../src/platform.ts";

test("the .fsm.json file-dialog filter is named in the current language", () => {
  try {
    assert.equal(FSM_FILTER.name, "FSM diagram");
    useLang.getState().setLang("zh");
    assert.equal(FSM_FILTER.name, "FSM 狀態圖");
    useLang.getState().setLang("ja");
    // The dialog plugin receives the filter as JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(FSM_FILTER)), { name: "FSM 図", extensions: ["fsm.json", "json"] });
  } finally {
    useLang.getState().setLang("en");
  }
});
