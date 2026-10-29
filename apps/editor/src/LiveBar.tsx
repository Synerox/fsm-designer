// Status bar part for the live link to an AI agent (see live.ts): whether the
// page is connected, which workspace diagram it shows, and a way to pick
// another one or to stop the link.

import { useLang, tr } from "./i18n.ts";
import { disconnect, openLive, useLive } from "./live.ts";

export function LiveBar() {
  useLang((s) => s.lang); // re-render on a language change
  const { status, name, names, workspace, note } = useLive();
  if (status === "off") return null;
  const state =
    status === "connected" ? (name ? tr(`AI live: ${name}`, `AI 即時連動：${name}`, `AI ライブ：${name}`) : tr("AI connected", "AI 已連線", "AI 接続済み"))
    : status === "denied" ? tr("AI link refused: the link is out of date. Ask the AI to open the editor again.", "AI 連線被拒：連結已失效，請讓 AI 重新開啟編輯器。", "AI 接続が拒否されました：リンクが古くなっています。AI にもう一度開いてもらってください。")
    : status === "lost" ? tr("AI link lost, reconnecting…", "與 AI 的連線中斷，重新連線中…", "AI との接続が切れました。再接続中…")
    : tr("Connecting to the AI…", "正在連線到 AI…", "AI に接続中…");
  const tip = workspace ? tr(`Workspace: ${workspace}. Changes are saved there automatically.`, `工作資料夾：${workspace}。變更會自動存到這裡。`, `ワークスペース：${workspace}。変更は自動でここに保存されます。`) : undefined;
  return (
    <div className={`live live-${status}`} data-testid="live" role="status" title={tip}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-text">{note ?? state}</span>
      {status === "connected" && names.length > 0 && (
        <select
          aria-label={tr("Workspace diagram to show", "要顯示的工作資料夾圖檔", "表示するワークスペースの図")}
          value={name ?? ""}
          onChange={(e) => { if (e.target.value) void openLive(e.target.value); }}
        >
          {!name && <option value="">{tr("Open a workspace diagram…", "開啟工作資料夾中的圖…", "ワークスペースの図を開く…")}</option>}
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      )}
      <button className="chip" onClick={disconnect} title={tr("Stop the live link; the diagram stays on screen", "停止即時連動；圖會留在畫面上", "ライブ接続を止めます。図は画面に残ります")}>
        {status === "denied" ? tr("Close", "關閉", "閉じる") : tr("Disconnect", "中斷", "切断")}
      </button>
    </div>
  );
}
