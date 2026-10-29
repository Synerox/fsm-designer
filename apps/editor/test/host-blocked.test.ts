// A published claude.ai page whose viewer cannot run the `downloads` capability.
import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = globalThis;
// Not declared, not granted, or no viewer answered in 10 s: use() gives null.
(globalThis as { claude?: unknown }).claude = { use: async () => null };
(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { saveDoc } = await import("../src/actions.ts");
const { createState, useEditor } = await import("../src/store.ts");

test("Save on a page that can save nothing says so and keeps the diagram unsaved", async () => {
  useEditor.getState().edit((d) => { createState(d, 100, 100); });
  // The page's frame blocks <a download> too, so falling back to it saved nothing
  // while the title lost its dot and New discarded the work without asking.
  await assert.rejects(saveDoc(), /^Error: This page can't save files\.$/);
  assert.equal(useEditor.getState().dirty, true);
  assert.equal(useEditor.getState().filePath, null);
});
