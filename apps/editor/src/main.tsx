import { Component, StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { setAsideAutosave } from "./actions.ts";
import { tr } from "./i18n.ts";
import "./styles.css";

/**
 * A throw while rendering would otherwise leave an empty page, and if the
 * autosaved diagram causes it, every reload would too. This offers a way out:
 * the autosave is set aside (kept, not deleted) and the editor starts blank.
 */
class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <p>{tr("The editor stopped because of an error:", "編輯器發生錯誤而停止：", "エラーのためエディターが停止しました：")}</p>
        <pre>{error.message}</pre>
        <button className="primary" onClick={() => { setAsideAutosave(); location.reload(); }}>{tr("Start a new diagram", "開始新的圖", "新しい図を始める")}</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);
