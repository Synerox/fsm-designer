// The Verilog importer's warnings and errors in UI words. @fsm/core writes
// them in English for its API callers (they mention options such as
// stateVar:); the editor rewrites the ones it knows, in every UI language.

import { useLang } from "./i18n.ts";

type Fill = (...m: string[]) => string;

/** A skipped construct as the parser names it: "function", "generate if", "instance of sync2".
 *  The ja form carries its を, spaced after an ASCII name but not after のインスタンス. */
const construct = (what: string, lang: "zh" | "ja") => {
  const inst = what.match(/^instance of (.+)$/);
  if (lang === "zh") return inst ? `${inst[1]} 實例` : what;
  return inst ? `${inst[1]} のインスタンスを` : `${what} を`;
};

/** Each warning: its pattern, then its zh and ja text, then English UI text where the core's wording is for API callers. */
const WARNINGS: Array<[RegExp, Fill, Fill, Fill?]> = [
  [/^Skipped (.+) on line (\d+); its effect is not in the diagram$/, (_, what, line) => `第 ${line} 行的 ${what} 無法分析，已略過，圖中不含它的效果`, (_, what, line) => `${line} 行目の ${what} は解析できないため省略しました。図にはその効果が含まれません`],
  // The parser's skips: a construct it does not read, or code with a syntax error.
  [/^Skipped (.+) \(line (\d+)\)$/, (_, what, line) => `已略過第 ${line} 行的 ${construct(what, "zh")}`, (_, what, line) => `${line} 行目の ${construct(what, "ja")}省略しました`],
  [/^Skipped line (\d+): (.+)$/, (_, line, msg) => `已略過第 ${line} 行（語法錯誤：${msg}）`, (_, line, msg) => `${line} 行目を省略しました（構文エラー：${msg}）`],
  [/^Skipped (.+)$/, (_, what) => `已略過 ${what}`, (_, what) => `${what} を省略しました`],
  [/^Internal signal "(.+)" is used in transition conditions/, (_, n) => `內部訊號 ${n} 出現在轉移條件中，已列為輸入`, (_, n) => `内部信号 ${n} が遷移条件に使われているため、入力として扱いました`],
  [/^Registered output "(.+)" changes with the transition taken/, (_, n) => `暫存器輸出 ${n} 依走哪條轉移而不同，所以畫在轉移上（實際在轉移後的下一個時脈才更新）`, (_, n) => `レジスタ出力 ${n} は通る遷移によって変わるため遷移上に描きました（実際には遷移後の次のクロックで更新）`],
  [/^No reset found/, () => "找不到狀態暫存器的 reset，圖中使用預設的 reset 訊號", () => "状態レジスタのリセットが見つからないため、既定のリセット信号を使います"],
  [/^Could not find the reset state of "(.+)"; using (.+) as the initial state$/, (_, r, s) => `找不到 ${r} 的 reset 狀態，改用 ${s} 當起始狀態`, (_, r, s) => `${r} のリセット状態が見つからないため、${s} を初期状態にしました`],
  [/^Register "(.+)" also looks like a state register/, (_, n) => `暫存器 ${n} 看起來也像狀態暫存器，這次匯入的是另一個（可在匯入視窗切換）`, (_, n) => `レジスタ ${n} も状態レジスタのようです。今回読み込んだのは別のものです（読み込み画面で切り替えられます）`, (_, n) => `Register "${n}" also looks like a state register; this import used another one (pick it in the Import dialog)`],
  [/^Output "(.+)" does not depend on "(.+)"; it is left out$/, (_, o, r) => `輸出 ${o} 跟 ${r} 無關（屬於其他電路），沒有畫進這張圖`, (_, o, r) => `出力 ${o} は ${r} と無関係（別の回路）なので図に含めていません`],
  // The reason after "left out:" is addSignal's own error message (a name clash or a bad
  // name). It is kept as technical detail, like the parser's syntax errors above.
  [/^Output "(.+)" left out: (.+)$/, (_, o, why) => `輸出 ${o} 沒有畫進這張圖（${why}）`, (_, o, why) => `出力 ${o} は図に含めていません（${why}）`],
  [/^Signal "(.+)" left out: (.+)$/, (_, n, why) => `訊號 ${n} 沒有列進這張圖（${why}）`, (_, n, why) => `信号 ${n} は図に含めていません（${why}）`],
  [/^Could not follow the partial assignment to (.+)$/, (_, n) => `無法追蹤對 ${n} 的部分位元指定，該值視為未知`, (_, n) => `${n} への部分的な代入を追跡できないため、その値は不明として扱います`],
  [/^Conditions in state (.+) have too many parts to simplify/, (_, st) => `狀態 ${st} 的條件組合太多，條件照原本的寫法顯示、沒有化簡`, (_, st) => `状態 ${st} の条件の組み合わせが多すぎるため、簡略化せず元の書き方のまま表示します`],
  [/^Imported module (\w+); the file also has (.+) \(pick/, (_, m, others) => `匯入的是 module ${m}；檔案裡還有 ${others}（沒有狀態機的 module 會略過）`, (_, m, others) => `読み込んだのは module ${m} です。ファイルにはほかに ${others} があります（ステートマシンのない module は省略）`, (_, m, others) => `Imported module ${m}; the file also has ${others} (modules without a state machine are skipped)`],
  [/^"(.+)" is not assigned on every path of state (.+); assumed to stay$/, (_, n, s) => `狀態 ${s} 有些情況沒有指定 ${n}，視為停在原狀態`, (_, n, s) => `状態 ${s} で ${n} が代入されない場合があり、同じ状態にとどまるとみなしました`],
  [/^Next state of (.+) is not a constant \((.+)\); that case is left out$/, (_, s, e) => `狀態 ${s} 的下一狀態不是常數（${e}），這種情況沒有畫出`, (_, s, e) => `状態 ${s} の次状態が定数ではない（${e}）ため、その場合は描いていません`],
  [/^Taking "(.+)" for a synchronous reset because it sets "(.+)" to a constant$/, (_, r, n) => `把 ${r} 視為同步 reset（它會把 ${n} 設成常數）`, (_, r, n) => `${r} は ${n} を定数にするため、同期リセットとみなしました`],
  // The example in parentheses is "a[4] reads a[3]": a bit select as written, then the position it reads.
  [/^"(.+)" is declared \[(-?\d+):(-?\d+)\]; its bit selects are shown as positions from the LSB \((.+) reads (.+)\)$/,
    (_, n, msb, lsb, as, is) => `${n} 宣告為 [${msb}:${lsb}]，它的位元選取改以從 LSB 起算的位置顯示（${as} 顯示為 ${is}）`,
    (_, n, msb, lsb, as, is) => `${n} は [${msb}:${lsb}] と宣言されているため、ビット選択は LSB から数えた位置で表示します（${as} は ${is} と表示）`],
];

/** An importer warning in the UI language (English ones that name API options are reworded too). */
export function warningText(w: string): string {
  const lang = useLang.getState().lang;
  for (const [re, zh, ja, en] of WARNINGS) {
    const m = w.match(re);
    if (!m) continue;
    if (lang === "en") return en ? en(...m) : w;
    return (lang === "ja" ? ja : zh)(...m);
  }
  return w;
}

/** An importer error in the UI language. A syntax error, or the engine's message after "Could not import the Verilog:", keeps its own (English) detail. */
export function importErrorText(msg: string): string {
  if (useLang.getState().lang === "ja") {
    if (/^No module found/.test(msg)) return "コードに module が見つかりません。";
    if (/No state machine found/.test(msg)) return `ステートマシンが見つかりません。クロック付き always ブロックで 2 つ以上の定数状態が代入されるレジスタが必要です。\n（${msg}）`;
    if (/^line \d+:/.test(msg)) return `構文エラー、${msg.replace(/^line (\d+): /, "$1 行目：")}`;
    if (/Too many cases/.test(msg)) return "条件の組み合わせが多すぎて、このステートマシンを展開できません。";
    let m = msg.match(/^Could not determine any state values for "(.+)"$/);
    if (m) return `${m[1]} がとる状態の値を判別できませんでした。`;
    m = msg.match(/^More than 256 states reached from "(.+)"/);
    if (m) return `${m[1]} から 256 個を超える状態に到達します。本当に状態レジスタですか？`;
    if (/^The Verilog is nested too deeply/.test(msg)) return "コードの入れ子が深すぎて読み込めません。";
    m = msg.match(/^Could not import the Verilog: (.+)$/);
    if (m) return `読み込めませんでした：${m[1]}`;
    return msg;
  }
  if (useLang.getState().lang !== "zh") {
    if (/No state machine found/.test(msg)) return `No state machine found: it needs a register assigned two or more constant states in a clocked always block.\n(${msg})`;
    if (/^line \d+:/.test(msg)) return `Syntax error, ${msg}`;
    return msg;
  }
  if (/^No module found/.test(msg)) return "程式碼裡找不到 module。";
  if (/No state machine found/.test(msg)) return `找不到狀態機：需要一個在時脈 always block 裡被指定成兩個以上常數狀態的暫存器。\n（${msg}）`;
  if (/^line \d+:/.test(msg)) return `語法錯誤，${msg.replace(/^line (\d+): /, "第 $1 行：")}`;
  if (/Too many cases/.test(msg)) return "條件組合太多，無法完整展開這個狀態機。";
  let m = msg.match(/^Could not determine any state values for "(.+)"$/);
  if (m) return `無法判斷 ${m[1]} 有哪些狀態值。`;
  m = msg.match(/^More than 256 states reached from "(.+)"/);
  if (m) return `從 ${m[1]} 走到的狀態超過 256 個，它真的是狀態暫存器嗎？`;
  if (/^The Verilog is nested too deeply/.test(msg)) return "程式碼巢狀層數太深，無法匯入。";
  m = msg.match(/^Could not import the Verilog: (.+)$/);
  if (m) return `無法匯入：${m[1]}`;
  return msg;
}
