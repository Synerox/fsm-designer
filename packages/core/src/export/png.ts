// PNG export: rasterises the SVG with resvg (a native module, loaded lazily so
// browser builds of @fsm/core never pull it in). resvg cannot draw bitmap
// colour-emoji fonts such as Noto Color Emoji, so emoji that a browser shows
// in the SVG are blank here; CJK text renders through the system fonts.

import { renderSvg } from "./svg.ts";
import type { SvgOptions } from "./svg.ts";
import type { FsmDiagram } from "../model.ts";

export interface PngOptions extends SvgOptions {
  scale?: number; // pixel density multiplier, default 2
}

export async function renderPng(d: FsmDiagram, opts: PngOptions = {}): Promise<Buffer> {
  const svg = renderSvg(d, opts);
  let Resvg: typeof import("@resvg/resvg-js").Resvg;
  try {
    ({ Resvg } = await import("@resvg/resvg-js"));
  } catch (e) {
    // Only a missing package means "install it". A package that is installed
    // but whose native binary fails to load (wrong platform or libc) says so,
    // and the original error rides along as the cause either way.
    const code = (e as { code?: unknown } | null)?.code;
    const missing = code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
    throw new Error(
      missing ? "PNG export needs the optional dependency @resvg/resvg-js (pnpm add @resvg/resvg-js)" : `PNG export could not load @resvg/resvg-js: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const r = new Resvg(svg, {
    fitTo: { mode: "zoom", value: opts.scale ?? 2 },
    font: { loadSystemFonts: true, defaultFontFamily: "Inter" },
    background: opts.background === "none" ? undefined : opts.background ?? "#ffffff",
  });
  return r.render().asPng();
}
