// renderPng's error when @resvg/resvg-js cannot be loaded. Each case runs in a
// child process whose loader hook makes the import fail the way it does in the wild.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const index = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

/** renderPng's error message and its cause's message when importing resvg throws an error with this code. */
function loadFailure(code: string, message: string): { message: string; cause?: string } {
  const failing = `const e = new Error(${JSON.stringify(message)}); e.code = ${JSON.stringify(code)}; throw e;`;
  const hooks = `export async function resolve(spec, ctx, next) {
    if (spec === "@resvg/resvg-js") return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(failing)}), shortCircuit: true };
    return next(spec, ctx);
  }`;
  const register = `import { register } from "node:module"; register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hooks)}));`;
  const run = `import { addState, createDiagram, renderPng } from ${JSON.stringify(index)};
    const d = createDiagram({ name: "m" });
    addState(d, { name: "A", x: 0, y: 0, isInitial: true });
    renderPng(d).then(() => console.log("{}"), (e) => console.log(JSON.stringify({ message: e.message, cause: e.cause?.message })));`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", run], { encoding: "utf8" });
  return JSON.parse(out);
}

test("renderPng asks to install resvg only when it is missing, and keeps the real error", () => {
  const missing = loadFailure("ERR_MODULE_NOT_FOUND", "Cannot find package '@resvg/resvg-js'");
  assert.match(missing.message, /needs the optional dependency @resvg\/resvg-js/);
  assert.equal(missing.cause, "Cannot find package '@resvg/resvg-js'");
  const broken = loadFailure("ERR_DLOPEN_FAILED", "GLIBC_2.38 not found");
  assert.doesNotMatch(broken.message, /pnpm add/, "an installed package with a broken binary is not 'missing'");
  assert.match(broken.message, /could not load @resvg\/resvg-js: GLIBC_2\.38 not found/);
  assert.equal(broken.cause, "GLIBC_2.38 not found");
});
