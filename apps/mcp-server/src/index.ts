#!/usr/bin/env node
// FSM Designer MCP server (stdio). Lets AI agents build FSM state diagrams and
// export them as PNG, SVG, LaTeX/TikZ or .fsm.json, or draw them from Verilog code.
//
//   fsm-mcp-server [--dir <workspace>] [--app <FSM Designer executable>]
//
// Diagrams are stored as <workspace>/<name>.fsm.json (default: $FSM_WORKSPACE
// or ./fsm-workspace), which the desktop editor can open directly.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStore } from "./store.ts";
import { createServer } from "./server.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--help")) {
  console.log("Usage: fsm-mcp-server [--dir <workspace folder>] [--app <FSM Designer executable>]\nRuns an MCP server on stdio.");
  process.exit(0);
}
const store = new FileStore(argValue("--dir") ?? process.env.FSM_WORKSPACE ?? "fsm-workspace");
const server = createServer(store, { path: argValue("--app") ?? process.env.FSM_DESIGNER_APP });
await server.connect(new StdioServerTransport());
console.error(`fsm-designer MCP server ready; workspace: ${store.location}`);
