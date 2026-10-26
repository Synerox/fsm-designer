#!/usr/bin/env node
// FSM Designer MCP server (stdio). Lets AI agents build FSM state diagrams and
// export them as PNG, SVG, LaTeX/TikZ or .fsm.json, or draw them from Verilog code.
//
//   fsm-mcp-server [--dir <workspace>] [--app <FSM Designer executable>]
//
// Diagrams are stored as <workspace>/<name>.fsm.json (default: $FSM_WORKSPACE
// or ~/fsm-workspace), which the desktop editor can open directly.

import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStore } from "./store.ts";
import { createServer, SERVER_VERSION } from "./server.ts";

const USAGE = "Usage: fsm-mcp-server [--dir <workspace folder>] [--app <FSM Designer executable>]\nRuns an MCP server on stdio.";
const FLAGS = ["--dir", "--app"];

/** The value after `flag`, or undefined when the flag is absent. A flag without a value is an error. */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value`);
  return v;
}

function fail(msg: string): never {
  console.error(`fsm-mcp-server: ${msg}\n${USAGE}`);
  process.exit(2);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (process.argv.includes("--version")) {
  console.log(SERVER_VERSION);
  process.exit(0);
}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    if (!FLAGS.includes(a)) fail(`unknown option ${a}`);
    i++; // skip its value
  } else fail(`unexpected argument ${a}`);
}

// The host (Claude Desktop, for one) starts the server in a folder we cannot
// predict and may not be allowed to write, so the default lives in the home folder.
const store = new FileStore(argValue("--dir") ?? process.env.FSM_WORKSPACE ?? join(homedir(), "fsm-workspace"));
const server = createServer(store, { path: argValue("--app") ?? process.env.FSM_DESIGNER_APP });
await server.connect(new StdioServerTransport());
console.error(`fsm-designer MCP server ready; workspace: ${store.location}`);
