import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Bundle @fsm/core from source (its browser entry leaves out the Node-only PNG exporter).
// `vite build --mode single` makes one script + one stylesheet (no lazy chunks)
// for scripts/build-single.mjs, which inlines them into a single HTML page.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: { alias: { "@fsm/core": fileURLToPath(new URL("../../packages/core/src/browser.ts", import.meta.url)) } },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build:
    mode === "single"
      ? { target: "es2022", outDir: "dist-single", cssCodeSplit: false, assetsInlineLimit: Infinity, rolldownOptions: { output: { codeSplitting: false } } }
      : { target: "es2022", outDir: "dist" },
}));
