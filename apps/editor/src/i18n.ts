import { create } from "zustand";
import { JA } from "./ja.ts";

export type Lang = "en" | "zh" | "ja";
const KEY = "fsm-designer.lang";

function load(): Lang {
  try { const v = localStorage.getItem(KEY); return v === "zh" || v === "ja" ? v : "en"; } catch { return "en"; }
}

export const useLang = create<{ lang: Lang; setLang(lang: Lang): void }>((set) => ({
  lang: load(),
  setLang(lang) { try { localStorage.setItem(KEY, lang); } catch {} set({ lang }); },
}));

/** UI text in the current language. Japanese comes from `ja`, else from the JA table by the English text. */
export function tr(en: string, zh: string, ja?: string): string {
  const lang = useLang.getState().lang;
  if (lang === "zh") return zh;
  if (lang === "ja") return ja ?? JA[en] ?? en;
  return en;
}
