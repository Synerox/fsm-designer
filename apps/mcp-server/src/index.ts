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
import { FileStore, userPath } from "./store.ts";
import { createServer, SERVER_VERSION } from "./server.ts";

const USAGE = "Usage: fsm-mcp-server [--dir <workspace folder>] [--app <FSM Designer executable>]\n       fsm-mcp-server --help | --version\nRuns an MCP server on stdio.";

function fail(msg: string): never {
  console.error(`fsm-mcp-server: ${msg}\n${USAGE}`);
  process.exit(2);
}

/** Parse argv left to right: each option once, each with a non-empty value that is not another option. */
function parseArgs(argv: string[]): { dir?: string; app?: string } {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  if (argv.length === 1 && argv[0] === "--version") {
    console.log(SERVER_VERSION);
    process.exit(0);
  }
  const out: { dir?: string; app?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a === "--dir" ? "dir" : a === "--app" ? "app" : undefined;
    if (!key) fail(a.startsWith("-") ? `unknown option ${a}` : `unexpected argument ${a}`);
    const v = argv[++i];
    if (v === undefined || v.trim() === "" || v.startsWith("--")) fail(`${a} needs a value`);
    if (out[key] !== undefined) fail(`${a} given twice`);
    out[key] = v;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
// The host (Claude Desktop, for one) starts the server in a folder we cannot
// predict and may not be allowed to write, so the default lives in the home
// folder. An empty FSM_WORKSPACE counts as unset.
let store: FileStore;
try {
  store = new FileStore(userPath(args.dir ?? (process.env.FSM_WORKSPACE?.trim() || join(homedir(), "fsm-workspace"))));
  await store.prepare();
} catch (e) {
  fail((e as Error).message);
}
// Hosts stop servers with a signal; exit normally so held lock files are removed.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
const server = createServer(store, { path: args.app ?? (process.env.FSM_DESIGNER_APP?.trim() || undefined) });
await server.connect(new StdioServerTransport());
console.error(`fsm-designer MCP server ${SERVER_VERSION} ready; workspace: ${store.location}`);
