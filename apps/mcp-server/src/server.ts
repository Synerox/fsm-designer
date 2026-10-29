// Builds the MCP server; separate from index.ts so tests and other hosts can embed it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiagramStore } from "./store.ts";
import { registerTools } from "./tools.ts";
import type { LiveBridge } from "./bridge.ts";

import { readFileSync } from "node:fs";

/** The package version, so serverInfo and --version cannot drift from package.json. */
export const SERVER_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function createServer(store: DiagramStore, live: () => LiveBridge | undefined = () => undefined): McpServer {
  const server = new McpServer(
    { name: "fsm-designer", version: SERVER_VERSION },
    {
      instructions:
        `Build finite state machine (FSM) state diagrams. Each diagram is saved as <name>.fsm.json in ${store.location} and stays there between sessions; ` +
        "call list_fsms to see the existing ones. " +
        "Build a whole machine with one create_fsm call: declare inputs and outputs, then states, then transitions (from/to are state names). " +
        "The clock and reset are implicit (clk and active-low async rst_n unless you set clock/reset); never list them as inputs. " +
        "create_fsm refuses an existing name unless overwrite: true. " +
        "Edit parts with add_state/update_state/remove_state, add_transition/update_transition/remove_transition and set_line_style: " +
        "these take the diagram as `fsm` (add_state names the new state with `name`; update_state/remove_state pick a state with `state`, a name or id). " +
        "Whole-diagram tools (create_fsm, get_fsm, delete_fsm, set_signals, validate_fsm, auto_layout, export_fsm, open_in_editor) take the diagram as `name`. " +
        "get_fsm lists state ids (s0, s1...) and transition ids (t0, t1...). " +
        "auto_layout re-arranges, set_line_style makes lines straight or curved, export_fsm gives png/svg/latex/json (look at the png to check the result). " +
        "To draw an FSM from existing Verilog/SystemVerilog code, call import_verilog. " +
        "open_in_editor shows a diagram to the user in the FSM Designer web editor, live: later tool edits appear there at once, and the user's own edits there are saved into the same file. " +
        "So when the user may have edited it, read the diagram again (get_fsm) before changing it; get_editor_state tells which diagram the user is looking at and what is selected there (\"this state\"). " +
        "FSM, state and signal names are Verilog identifiers (letters, digits, _); use a state's label for other text such as S₀. " +
        "Conditions are Verilog boolean expressions over the declared inputs (x, !x, a && b, cnt == 2'd3); an empty condition means 'otherwise'. " +
        "Moore outputs go on states, Mealy outputs on transitions, as {\"z\": 1}. Diagrams are also readable as resources fsm://<name>.",
    },
  );
  registerTools(server, store, live);
  return server;
}
