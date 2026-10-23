// Build the editor as one self-contained HTML file (for publishing as a
// claude.ai page or opening straight from disk): runs `vite build --mode single`
// and inlines its script and stylesheet.
//
//   node scripts/build-single.mjs [out.html]
//
// The output is page content without <html>/<head>/<body>, the form the
// Artifact publisher expects (browsers render it fine as is).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "artifact", "fsm-designer.html"));
execFileSync("npx", ["vite", "build", "--mode", "single", "--logLevel", "warn"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

const dist = join(root, "dist-single");
const assets = readdirSync(join(dist, "assets"));
const js = readFileSync(join(dist, "assets", assets.find((f) => f.endsWith(".js"))), "utf8");
const css = readFileSync(join(dist, "assets", assets.find((f) => f.endsWith(".css"))), "utf8");
const icon = readFileSync(join(root, "index.html"), "utf8").match(/<link rel="icon"[^>]*>/)?.[0] ?? "";

const html = [
  `<title>FSM Designer</title>`,
  icon,
  `<style>${css}</style>`,
  `<div id="root"></div>`,
  // "</script" inside the bundle would end the tag early; "<\/" means the same in JS.
  `<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>`,
  ``,
].join("\n");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out} (${(html.length / 1024).toFixed(0)} KB)`);
