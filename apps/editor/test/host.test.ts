// Saving on a published claude.ai page, through the viewer's `downloads` capability.
import { test } from "node:test";
import assert from "node:assert/strict";

let reject: (filename: string) => string | null = () => null;
const saved: string[] = [];
const downloads = {
  async save({ filename }: { filename: string; data: unknown }) {
    const code = reject(filename);
    if (code) throw Object.assign(new Error(code), { code });
    saved.push(filename);
    return { status: "saved" };
  },
};
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { claude?: unknown }).claude = { use: async (name: string) => (name === "downloads" ? downloads : null) };
(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { exportLatex, exportSvg } = await import("../src/actions.ts");
const { createState, newDiagram, useEditor } = await import("../src/store.ts");
const { useLang } = await import("../src/i18n.ts");

const d = newDiagram();
createState(d, 100, 100);
useEditor.getState().load(d, null);

test("Save as .tex on a page that cannot save .tex returns the .txt name it saved instead", async () => {
  reject = (f) => (f.endsWith(".tex") ? "rejected_extension" : null);
  assert.equal(await exportLatex(), "State_Diagram.tex.txt", "the caller needs the name to tell the user");
  assert.deepEqual(saved, ["State_Diagram.tex.txt"]);
});

test("host save errors are sentences in the UI language, not capability codes", async () => {
  try {
    reject = () => "extension_not_enabled";
    await assert.rejects(exportSvg(), /^Error: This page can't save \.svg files\.$/);
    reject = () => "too_large";
    await assert.rejects(exportSvg(), /^Error: The file is too large to save from this page\.$/);
    for (const code of ["unavailable", "not_granted", "capability_removed", "some_new_code"]) {
      reject = () => code;
      await assert.rejects(exportSvg(), /^Error: This page can't save files\.$/, code);
    }
    useLang.getState().setLang("ja");
    reject = () => "extension_not_enabled";
    await assert.rejects(exportSvg(), /^Error: このページでは \.svg ファイルを保存できません。$/);
    useLang.getState().setLang("zh");
    reject = () => "unavailable";
    await assert.rejects(exportSvg(), /^Error: 這個頁面無法儲存檔案。$/);
  } finally {
    useLang.getState().setLang("en");
  }
});
