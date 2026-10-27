// Checks on agent-supplied values that @fsm/core passes through unchanged:
// colours, export file targets and PNG sizes.

import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, isAbsolute } from "node:path";
import { userPath } from "./store.ts";

// CSS named colours (CSS Color 4), so a typo is an error instead of a black background.
const NAMED = new Set(
  ("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
    "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
    "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
    "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender " +
    "lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey " +
    "lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange " +
    "orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray " +
    "slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "),
);
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.]+%?\s*(?:[,\s]\s*[\d.]+%?\s*){2}(?:[,/]\s*[\d.]+%?\s*)?\)$/i;

/** True for colours both the SVG viewers and resvg understand. */
export function isColor(c: string): boolean {
  return HEX.test(c) || FUNC.test(c) || NAMED.has(c.toLowerCase());
}

export function checkColor(what: string, c: string, allowNone = false): void {
  if (allowNone && (c === "none" || c === "transparent")) return;
  if (!isColor(c))
    throw new Error(`${what} "${c}" is not a colour: use #rgb, #rrggbb, #rrggbbaa, rgb(…)/hsl(…) or a CSS colour name such as lightblue${allowNone ? ', or "none" for transparent' : ""}`);
}

export const FORMAT_EXT = { png: ".png", svg: ".svg", latex: ".tex", json: ".fsm.json" } as const;

/**
 * Where export_fsm writes `path`: relative paths go into the workspace, `~` is the
 * home folder, and a folder (or a path ending in a separator) gets `<name><ext>`.
 * Refuses to write over the workspace's own diagram files.
 */
export async function exportTarget(workspace: string, p: string, format: keyof typeof FORMAT_EXT, name: string): Promise<{ file: string; note: string }> {
  if (!p.trim()) throw new Error("path is empty; leave it out to only return the export");
  const raw = userPath(p);
  // Windows: "a.fsm.json::$DATA" or "a.fsm.json:x" write a stream of a.fsm.json.
  if (process.platform === "win32" && raw.replace(/^(\\\\\?\\)?[A-Za-z]:/, "").includes(":"))
    throw new Error(`"${p}" is not a usable file name (":" is only allowed after a drive letter)`);
  let file = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw);
  const isDir = /[\\/]$/.test(p) || (await stat(file).then((s) => s.isDirectory(), () => false));
  if (isDir) file = join(file, `${name}${FORMAT_EXT[format]}`);
  const lower = basename(file).toLowerCase();
  if (lower.endsWith(".fsm.json")) {
    if (format !== "json") throw new Error(`Refusing to write ${format} into ${file}: .fsm.json files are diagrams. Use a ${FORMAT_EXT[format]} file name`);
    if (await inWorkspace(workspace, file))
      throw new Error(`Refusing to write ${file}: that is where the workspace keeps the diagram "${basename(file).slice(0, -".fsm.json".length)}". ` +
        "To copy a diagram use create_fsm with the JSON from get_fsm; to export elsewhere give a path outside the workspace folder or a sub-folder");
  }
  // A device or pipe (the server's own stdout, /dev/...) is never an export target.
  const existing = await stat(file).catch(() => undefined);
  if (existing && !existing.isFile()) throw new Error(`Refusing to write ${file}: it is not a regular file`);
  // Whatever the spelling (links, \\?\ prefixes, short names), never write over a diagram file.
  const same = await sameAsDiagram(workspace, file);
  if (same) throw new Error(`Refusing to write ${file}: it is the workspace's diagram file ${same}. Give a path outside the workspace folder`);
  const want = FORMAT_EXT[format];
  const note = lower.endsWith(want) || (format === "latex" && extname(lower) === ".latex") ? "" : ` (note: the file name does not end in ${want})`;
  return { file, note };
}

/** The real path of `p`, resolving links in the part of it that exists. */
async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(await real(parent), basename(p));
  }
}

/** Whether `file` is directly in the workspace folder, however either path is spelled. Lower-cased: Windows and macOS ignore case. */
async function inWorkspace(workspace: string, file: string): Promise<boolean> {
  const a = (await real(dirname(file))).toLowerCase();
  const b = (await real(resolve(workspace))).toLowerCase();
  return a === b || a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
}

/** The workspace diagram file that `file` already is (same device and inode), if any. */
async function sameAsDiagram(workspace: string, file: string): Promise<string | undefined> {
  const t = await stat(file).catch(() => undefined);
  if (!t || !t.isFile()) return undefined;
  const names = await readdir(workspace).catch(() => [] as string[]);
  for (const n of names) {
    if (!n.toLowerCase().endsWith(".fsm.json")) continue;
    const s = await stat(join(workspace, n)).catch(() => undefined);
    if (s && s.dev === t.dev && s.ino === t.ino && s.ino !== 0) return join(workspace, n);
  }
  return undefined;
}
/** Largest PNG we render: about 40 megapixels, at most 16384 px on a side. */
const MAX_PIXELS = 40_000_000;
const MAX_SIDE = 16384;

/** The scale to render a `w`×`h` (px at scale 1) drawing at, never above the caps; `clamped` says if it was lowered. */
export function pngScale(w: number, h: number, scale: number): { scale: number; clamped: boolean; width: number; height: number } {
  const cap = Math.min(Math.sqrt(MAX_PIXELS / Math.max(1, w * h)), MAX_SIDE / Math.max(1, w, h));
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error("The drawing has no finite size (a state position or curve is not a finite number); fix the positions or run auto_layout");
  const s = Math.min(scale, Math.floor(cap * 100) / 100);
  if (s < 0.05) throw new Error(`The drawing is ${Math.round(w)}x${Math.round(h)} px, too large for a PNG; run auto_layout or move far-away states closer, or export svg`);
  return { scale: s, clamped: s < scale, width: Math.round(w * s), height: Math.round(h * s) };
}

/** Width and height of an SVG produced by renderSvg. */
export function svgSize(svg: string): { w: number; h: number } {
  const m = /<svg[^>]*\swidth="([^"]*)"[^>]*\sheight="([^"]*)"/.exec(svg);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: NaN, h: NaN };
}

/** Decode a source file: UTF-8 (with or without BOM) or UTF-16 with a BOM, as Windows editors sometimes save. */
export function decodeSource(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    le.swap16();
    return le.toString("utf16le");
  }
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
