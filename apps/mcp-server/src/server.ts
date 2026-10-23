// Builds the MCP server; separate from index.ts so tests and other hosts can embed it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiagramStore } from "./store.ts";
import { registerTools } from "./tools.ts";
import type { AppOptions } from "./app.ts";

export function createServer(store: DiagramStore, app: AppOptions = {}): McpServer {
  const server = new McpServer(
    { name: "fsm-designer", version: "0.2.0" },
    {
      instructions:
        "Build finite state machine diagrams. Prefer create_fsm with the whole machine in one call; " +
        "use add_state/add_transition/update_* for edits, auto_layout to re-arrange, " +
        "set_line_style for straight/curved lines, and export_fsm to get png/svg/latex (labels: none hides line text). " +
        "To draw an FSM from existing Verilog/SystemVerilog code, call import_verilog. open_in_app shows a diagram in the desktop app. " +
        "Export png to look at the result. Names must be Verilog identifiers; conditions are Verilog boolean expressions over inputs.",
    },
  );
  registerTools(server, store, app);
  return server;
}
