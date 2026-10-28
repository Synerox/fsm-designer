// Keyboard and mouse reference, shown over the canvas by the status bar's
// Hints button (laid out like Analog Canvas's shortcut sheet).

import { MOD, tr } from "./i18n.ts";
import type { MouseEvent } from "react";

/** Each hint: the keys pressed together, then what they do. */
const hints = (): Array<[string[], string]> => [
  [[tr("Double-click", "雙擊", "ダブルクリック"), tr("Empty space", "空白處", "空白部分")], tr("Add state", "新增狀態", "状態を追加")],
  [[tr("Double-click", "雙擊", "ダブルクリック"), tr("State", "狀態", "状態")], tr("Toggle accepting", "切換接受狀態", "受理状態を切替")],
  [[tr("Drag", "拖曳", "ドラッグ"), tr("State", "狀態", "状態")], tr("Move state", "移動狀態", "状態を移動")],
  [["Alt", tr("Drag", "拖曳", "ドラッグ")], tr("Move freely, no snap", "自由移動，不吸附", "吸着せずに移動")],
  [["Shift", tr("Drag", "拖曳", "ドラッグ")], tr("Add transition or self loop", "新增轉移或自迴圈", "遷移・自己ループを追加")],
  [["Shift", tr("Drag", "拖曳", "ドラッグ"), tr("Empty space", "空白處", "空白部分")], tr("Add start arrow", "新增起始箭頭", "開始矢印を追加")],
  [[tr("Drag", "拖曳", "ドラッグ"), tr("Line", "線條", "線")], tr("Bend or rotate line", "彎曲或旋轉線條", "線を曲げる・回す")],
  [[tr("Drag", "拖曳", "ドラッグ"), "□"], tr("Resize state", "調整狀態大小", "状態のサイズ変更")],
  [[tr("Type", "打字", "入力")], tr("Edit selected text", "編輯選取的文字", "選択中のテキストを編集")],
  [["←", "→"], tr("Move cursor", "移動游標", "カーソル移動")],
  [["Home", "End"], tr("Cursor to start or end", "游標到開頭或結尾", "カーソルを先頭・末尾へ")],
  [["↑", "↓"], tr("Cursor to start or end", "游標到開頭或結尾", "カーソルを先頭・末尾へ")],
  // Conditions keep "_0", since Verilog names such as data_0 use it.
  [["_0", "Space"], tr("Subscript ₀ in state names", "狀態名稱的下標 ₀", "状態名の下付き文字 ₀")],
  [[tr("\\name", "\\字母名", "\\文字名"), "Space"], tr("Greek letter: \\alpha → α, \\Omega → Ω", "希臘字母：\\alpha → α、\\Omega → Ω", "ギリシャ文字：\\alpha → α、\\Omega → Ω")],
  [[MOD, tr("Drag", "拖曳", "ドラッグ")], tr("Box select (to the right: inside only; to the left: touching)", "框選（往右：完整框住；往左：碰到就選）", "範囲選択（右へ：囲んだもの、左へ：触れたもの）")],
  [[MOD, tr("Click", "點一下", "クリック")], tr("Add or remove from selection", "加選或取消選取", "選択に追加・解除")],
  [[MOD, "A"], tr("Select all", "全選", "すべて選択")],
  [[MOD, "C"], tr("Copy", "複製", "コピー")],
  [[MOD, "X"], tr("Cut", "剪下", "切り取り")],
  [[MOD, "V"], tr("Paste", "貼上", "貼り付け")],
  [["Delete"], tr("Delete", "刪除", "削除")],
  [["Esc"], tr("Deselect", "取消選取", "選択解除")],
  [[MOD, "Z"], tr("Undo", "復原", "元に戻す")],
  [[MOD, "Shift", "Z"], tr("Redo", "重做", "やり直し")],
  [[MOD, "Y"], tr("Redo", "重做", "やり直し")],
  [[MOD, "S"], tr("Save", "儲存", "保存")],
  [[MOD, "Shift", "S"], tr("Save as", "另存新檔", "名前を付けて保存")],
  [[MOD, "O"], tr("Open", "開啟", "開く")],
  [[MOD, "N"], tr("New diagram", "新增圖", "新しい図")],
  [[MOD, "I"], tr("Import Verilog", "匯入 Verilog", "Verilog を読み込む")],
  [[MOD, "Enter"], tr("Import (in the Import Verilog dialog)", "匯入（在匯入 Verilog 視窗中）", "読み込む（Verilog 読み込み画面で）")],
  [[tr("Drag", "拖曳", "ドラッグ"), tr("Empty space", "空白處", "空白部分")], tr("Pan", "平移畫面", "画面を移動")],
  [[tr("Middle-drag", "中鍵拖曳", "中ボタンでドラッグ")], tr("Pan", "平移畫面", "画面を移動")],
  [[tr("Wheel", "滾輪", "ホイール")], tr("Pan", "平移畫面", "画面を移動")],
  [[MOD, tr("Wheel", "滾輪", "ホイール")], tr("Zoom", "縮放", "ズーム")],
  [["F"], tr("Fit to window", "符合視窗", "ウィンドウに合わせる")],
];

export function Hints({ onClose }: { onClose: (e: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <section className="hints" data-testid="hints" aria-label={tr("Shortcuts", "快捷鍵", "ショートカット")}>
      <header>
        <h4>{tr("Shortcuts", "快捷鍵與操作", "ショートカット")}</h4>
        <button className="ghost small" onClick={onClose} title={tr("Close", "關閉")} aria-label={tr("Close hints", "關閉提示", "ヒントを閉じる")}>{tr("Hints", "提示")} <span aria-hidden="true">✕</span></button>
      </header>
      <ul>
        {hints().map(([keys, what], i) => (
          <li key={i}>
            <span className="keys">
              {keys.map((k, j) => <kbd key={j}>{k}</kbd>)}
            </span>
            <span className="what">{what}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
