#!/usr/bin/env node
// FSM Designer MCP server (stdio). Lets AI agents build FSM state diagrams and
// export them as PNG, SVG, LaTeX/TikZ or .fsm.json, or draw them from Verilog code.
//
//   fsm-mcp-server [--dir <workspace>] [--port <n>] [--editor-url <url>] [--no-live]
//
// Diagrams are stored as <workspace>/<name>.fsm.json (default: $FSM_WORKSPACE
// or ~/fsm-workspace). The server also links the web editor to the workspace
// over 127.0.0.1 (see bridge.ts), so the user sees the agent's diagram live.

import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStore, userPath } from "./store.ts";
import { createServer, SERVER_VERSION } from "./server.ts";
import { DEFAULT_PORT, LiveBridge, liveStore } from "./bridge.ts";

const USAGE = "Usage: fsm-mcp-server [--dir <workspace folder>] [--port <n>] [--editor-url <url>] [--no-live]\n       fsm-mcp-server --help | --version\n" +
  `Runs an MCP server on stdio. The web editor links to it on 127.0.0.1:<port> (default ${DEFAULT_PORT}, 0 = any free port; --no-live turns this off).`;

interface Args { dir?: string; port?: string; "editor-url"?: string; "no-live"?: boolean }
const VALUED = ["dir", "port", "editor-url"] as const;

function fail(msg: string): never {
  console.error(`fsm-mcp-server: ${msg}\n${USAGE}`);
  process.exit(2);
}

/** Parse argv left to right: each option once, each with a non-empty value that is not another option. */
function parseArgs(argv: string[]): Args {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  if (argv.length === 1 && argv[0] === "--version") {
    console.log(SERVER_VERSION);
    process.exit(0);
  }
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-live") {
      if (out["no-live"]) fail(`${a} given twice`);
      out["no-live"] = true;
      continue;
    }
    const key = VALUED.find((k) => a === `--${k}`);
    if (!key) fail(a.startsWith("-") ? `unknown option ${a}` : `unexpected argument ${a}`);
    const v = argv[++i];
    if (v === undefined || v.trim() === "" || v.startsWith("--")) fail(`${a} needs a value`);
    if (out[key] !== undefined) fail(`${a} given twice`);
    out[key] = v;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
let port: number | undefined;
if (args.port !== undefined) {
  port = Number(args.port);
  if (!/^\d+$/.test(args.port) || port > 65535) fail(`--port must be a port number (0-65535), not ${args.port}`);
}
if (args["editor-url"] !== undefined) {
  let u: URL | undefined;
  try { u = new URL(args["editor-url"]); } catch { /* reported below */ }
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) fail(`--editor-url must be an http(s) URL, not ${args["editor-url"]}`);
}
if (args["no-live"] && (port !== undefined || args["editor-url"] !== undefined)) fail("--no-live cannot be combined with --port or --editor-url");
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
let bridge: LiveBridge | undefined;
const server = createServer(liveStore(store, () => bridge), () => bridge);
if (!args["no-live"]) {
  bridge = new LiveBridge(store, {
    port,
    editorUrl: args["editor-url"],
    tokenFile: process.env.FSM_LIVE_TOKEN_FILE?.trim() || undefined,
    onListChanged: () => server.sendResourceListChanged(),
  });
  await bridge.start();
}
await server.connect(new StdioServerTransport());
const live = !bridge ? "live editor link off" : bridge.running ? `live editor link on 127.0.0.1:${bridge.port}` : `live editor link failed: ${bridge.error}`;
console.error(`fsm-designer MCP server ${SERVER_VERSION} ready; workspace: ${store.location}; ${live}`);
