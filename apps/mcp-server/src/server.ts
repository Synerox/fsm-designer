// Builds the MCP server; separate from index.ts so tests and other hosts can embed it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiagramStore } from "./store.ts";
import { registerTools } from "./tools.ts";
import type { AppOptions } from "./app.ts";

export const SERVER_VERSION = "0.3.0";

export function createServer(store: DiagramStore, app: AppOptions = {}): McpServer {
  const server = new McpServer(
    { name: "fsm-designer", version: SERVER_VERSION },
    {
      instructions:
        `Build finite state machine (FSM) state diagrams; they are saved as <name>.fsm.json in ${store.location}. ` +
        "Prefer create_fsm with the whole machine in one call (declare inputs/outputs, then states, then transitions); " +
        "use add_state/add_transition/update_*/remove_*/set_signals for edits (get_fsm shows state and transition ids), auto_layout to re-arrange, " +
        "set_line_style for straight/curved lines, and export_fsm to get png/svg/latex (labels: none hides line text). " +
        "To draw an FSM from existing Verilog/SystemVerilog code, call import_verilog. open_in_app shows a diagram in the desktop app. " +
        "Export png to look at the result and fix layout problems. " +
        "FSM, state and signal names must be Verilog identifiers (letters, digits, _); use a state's label for other text. " +
        "Conditions are Verilog boolean expressions over the declared inputs (x, !x, a && b, cnt == 2'd3); an empty condition means 'otherwise'. " +
        "Moore outputs go on states, Mealy outputs on transitions, as {\"z\": 1}.",
    },
  );
  registerTools(server, store, app);
  return server;
}
