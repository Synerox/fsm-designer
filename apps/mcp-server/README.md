# FSM Designer MCP server

讓 AI agent（Claude Desktop、Claude Code 或任何 MCP client）透過 FSM Designer
畫狀態轉移圖：從零建立或修改圖、從 **Verilog / SystemVerilog** 程式碼匯入、
用和桌面版相同的自動排版模式整理，並匯出 **PNG、SVG、LaTeX/TikZ** 或 `.fsm.json`。
它使用和桌面版編輯器同一套 `@fsm/core`（模型、排版、匯出），所以 agent 畫出來的圖
和你手動畫的一模一樣，存成的 `.fsm.json` 也可以直接用桌面版開啟繼續編輯。

## 建置

需要 Node 22 以上與 pnpm（`npm install -g pnpm`）。

```powershell
cd D:\FSMDesigner
pnpm install
pnpm -r build        # 會產生 packages\core\dist 與 apps\mcp-server\dist
```

伺服器入口是 `D:\FSMDesigner\apps\mcp-server\dist\index.js`，以 stdio 溝通：

```
node dist\index.js [--dir <工作資料夾>] [--app <FSM Designer.exe 路徑>]
node dist\index.js --help | --version
```

- `--dir`（或環境變數 `FSM_WORKSPACE`）：圖存成 `<工作資料夾>\<名稱>.fsm.json`，
  資料夾不存在會自動建立。沒指定時是使用者家目錄下的 `fsm-workspace`
  （Windows 上是 `%USERPROFILE%\fsm-workspace`），建議明確指定。可以寫 `~/圖` 這種路徑；
  指到一個檔案或沒有寫入權限的資料夾時，伺服器會說明原因並結束。
- `--app`（或環境變數 `FSM_DESIGNER_APP`）：`open_in_app` 要啟動的桌面版程式。
  沒指定時會在 `%LOCALAPPDATA%\FSM Designer`、`%ProgramFiles%\FSM Designer`
  找 `FSM Designer.exe` / `fsm-designer.exe`（安裝檔的預設位置）。
- 選項少了值、重複或打錯名稱時，伺服器會印出用法並以代碼 2 結束，不會默默用錯的資料夾。
- FSM 名稱只能用英數字與 `_`，最多 64 字元；`CON`、`NUL` 這類 Windows 裝置名稱，
  以及只差大小寫的同名圖都會被拒絕（Windows 與 macOS 上它們是同一個檔案）。

同一張圖的修改會逐一排隊執行，並以 `<名稱>.fsm.json.lock` 檔在多個程序之間互斥
（例如 Claude Desktop 與 Claude Code 同時連到同一個工作資料夾），所以同時呼叫多個
工具不會互相蓋掉。另一個程序最多等 30 秒；持有鎖的程序已結束時，鎖會自動接手，
不必手動刪除。寫檔採先寫暫存檔再改名，桌面版不會讀到寫到一半的檔案；工作資料夾裡
以捷徑（symlink）連到別處的 `.fsm.json` 會寫回原本的檔案。

## 在 Windows 上連接 Claude

以下假設程式在 `D:\FSMDesigner`，圖存在 `D:\FSMDiagrams`（不存在會自動建立）。

### Claude Code

在 PowerShell 或命令提示字元執行（`--scope user` 讓每個專案都能用）：

```powershell
claude mcp add fsm-designer --scope user -- node D:\FSMDesigner\apps\mcp-server\dist\index.js --dir D:\FSMDiagrams
claude mcp list      # 應該看到 fsm-designer: ... ✓ Connected
```

### Claude Desktop

1. 開啟 Claude Desktop ▸ 設定 ▸ 開發者（Developer）▸ 編輯設定（Edit Config），
   或直接編輯 `%APPDATA%\Claude\claude_desktop_config.json`。
2. 加入以下內容（JSON 裡的反斜線要寫兩次）：

```json
{
  "mcpServers": {
    "fsm-designer": {
      "command": "node",
      "args": [
        "D:\\FSMDesigner\\apps\\mcp-server\\dist\\index.js",
        "--dir", "D:\\FSMDiagrams"
      ]
    }
  }
}
```

3. 完全結束 Claude Desktop（系統匣圖示 ▸ 結束）再重開，輸入框的工具圖示裡會出現 fsm-designer。

若出現「找不到 node」，把 `"command"` 改成 node 的完整路徑，例如
`"C:\\Program Files\\nodejs\\node.exe"`。桌面版若裝在其他位置，在 `args` 加上
`"--app", "D:\\路徑\\FSM Designer.exe"`。

### 試試看

- 「畫一個偵測序列 1011 的 Moore FSM，輸入 x、輸出 z，匯出 PNG 給我看。」
- 「把 D:\rtl\uart_rx.v 裡的狀態機畫成狀態圖，匯出 LaTeX。」
- 「S0 和 S1 之間的線改成平行直線，間距 24，隱藏線上文字後匯出 SVG 到 out\seq.svg。」
- 「在 FSM Designer 裡打開這張圖。」

## 工具

| 工具 | 功能 |
| --- | --- |
| `create_fsm` | 一次建立（或用 `overwrite` 取代）整張圖：狀態、轉移、輸入輸出、clock/reset。會驗證、自動排版並存檔。建議優先使用。 |
| `list_fsms`、`get_fsm`、`delete_fsm` | 列出、讀取（摘要 + 驗證結果，可附原始 JSON）、刪除圖。 |
| `set_signals` | Moore/Mealy、輸入輸出埠（寬度、預設值）、clock 與 reset。 |
| `add_state`、`update_state`、`remove_state` | 狀態：名稱、顯示文字 `label`（如 `S₀`）、起始/接受、Moore 輸出、顏色、半徑 `radius`、字體大小、起始箭頭方向 `initialFrom`、位置。可用名稱或 id 指定。 |
| `add_transition`、`update_transition`、`remove_transition` | 轉移：條件、Mealy 輸出、優先順序、彎曲 `curve`、平行線間距 `gap`、自迴圈方向 `loopSide`、字體大小。 |
| `set_line_style` | 兩個狀態之間的線：`straight`（直線，來回兩條會平行錯開，`gap` 調間距）、`curved`（曲線）、`auto`（回到自動）。 |
| `auto_layout` | 自動排版，和桌面版按鈕相同（單一規則，只能調狀態間距 `spacing`）：比較方格、分層流程、蛇形與環形（主迴圈繞成長方形，短迴圈貼在旁邊）挑最好的，避免太長的箭頭，互指的三角形調成正三角形，互不相連的子圖分開排再並排；回傳選中的排法與修不掉的問題。`labels: "none"` 依隱藏文字的畫法排得更緊湊。 |
| `import_verilog` | 分析 Verilog/SystemVerilog（`code` 或檔案 `path`）：找出狀態暫存器、reset 狀態、每條轉移的條件、Moore/Mealy 輸出，排版後存檔並回傳 PNG 與報告。存檔名稱預設是 module 名稱（可用 `name` 改），已有同名的圖時要給 `overwrite: true`。支援寫法見 `packages/core/src/import/README.md`。 |
| `validate_fsm` | 錯誤（沒有狀態、沒有 reset 狀態、多條無條件轉移）與警告（到不了的狀態、重複條件、未宣告的輸入、不是合法 Verilog 運算式的條件）。 |
| `export_fsm` | `png`（同時以圖片回傳，agent 可以檢查自己的成果）、`svg`、`latex`（TikZ，可用 pdflatex 編譯）、`json`。`path` 另存檔案（相對路徑放在工作資料夾，給資料夾時存成 `<名稱>.<副檔名>`，不會覆蓋工作資料夾裡的 `.fsm.json`）。給了 `path` 時文字格式只回報寫入的檔案，要同時回傳內容請加 `inline: true`；`labels` = `all` / `noLoops` / `none` 對應桌面版的「全部／隱藏」線上文字。 |
| `open_in_app` | 用 FSM Designer 桌面版開啟這張圖，讓你接手手動編輯。桌面版不會自動重新讀檔，agent 之後再修改時需要重新開啟。 |

每張圖也可以用 MCP resource `fsm://<名稱>` 讀取；新增或刪除圖時伺服器會通知 client 重新整理清單。
`list_fsms` 會另外列出工作資料夾裡無法當作圖使用的 `.fsm.json`（例如檔名有空白）。

### 慣例

- 狀態、訊號、FSM 名稱都是 Verilog 識別字（`IDLE`、`got_1`）；想顯示其他文字用 `label`。
- 條件是對輸入的 Verilog 布林運算式：`x`、`!x`、`req[1] && !req[0]`、`cnt == 2'd3`。空字串代表「一定 / 其他情況」，匯出時若同一狀態還有其他轉移會標成 `else`（`elseLabels: false` 可關掉）。寫不成 Verilog 運算式的文字也會照樣畫出來，但 `add_transition` 的回覆與 `validate_fsm` 會提醒。
- 一張圖只能有一個初始（reset）狀態：`create_fsm` 沒標 `isInitial` 時用第一個狀態，標了兩個以上會回錯誤。
- Moore 輸出放在狀態，Mealy 輸出放在轉移：`{"z": 1}`、`{"state_out": "2'b10"}`。
- 同一狀態的轉移依 `priority`（小的先）再依清單順序判斷。
- 預設 clock `clk`、reset `rst_n`（低電位有效、非同步）。

## 架構

`src/tools.ts` 的工具只透過 `src/store.ts` 的 `DiagramStore` 介面讀寫圖，目前是
`FileStore`（工作資料夾裡的 `.fsm.json`），桌面版可以直接開啟。日後若桌面版提供
本機連線（例如 WebSocket），只要另外實作一個 `DiagramStore` 就能讓 agent 直接編輯
桌面版正在開啟的圖，工具本身不用改。`src/app.ts` 負責啟動桌面版。

## 測試

```powershell
pnpm --filter @fsm/core build        # 第一次或 core 改過之後
pnpm --filter @fsm/mcp-server test   # 透過 stdio 啟動真正的伺服器，逐一呼叫每個工具
```

測試涵蓋每個工具的正常與錯誤路徑、每種匯出格式、Verilog 匯入、同一張圖的並行修改
（同一程序與兩個程序）、已結束程序留下的鎖檔、損壞或版本較新的 `.fsm.json`、命令列參數、
資源清單通知，以及用假的執行檔測 `open_in_app`（這一項在 Windows 上略過）。
