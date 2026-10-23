// Opens a diagram file in the FSM Designer desktop app (Tauri). The app takes
// a .fsm.json path on its command line, the same as double-clicking the file.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface AppOptions {
  /** The app's executable (or .app bundle on macOS); default: look in the usual install folders. */
  path?: string;
}

/** Where the installers put the app, most likely first. */
function candidates(): string[] {
  const env = process.env;
  if (process.platform === "win32") {
    const dirs = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "FSM Designer"), env.ProgramFiles && join(env.ProgramFiles, "FSM Designer"), env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"]!, "FSM Designer")];
    return dirs.filter((d): d is string => !!d).flatMap((d) => [join(d, "FSM Designer.exe"), join(d, "fsm-designer.exe")]);
  }
  if (process.platform === "darwin") return ["/Applications/FSM Designer.app", join(env.HOME ?? "", "Applications", "FSM Designer.app")];
  return ["/usr/bin/fsm-designer", "/usr/local/bin/fsm-designer"];
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Start the app on `file` without waiting for it. Returns the program used. */
export async function launchApp(file: string, opts: AppOptions = {}): Promise<string> {
  const list = opts.path ? [opts.path] : candidates();
  let exe: string | undefined;
  for (const c of list) if (await exists(c)) { exe = c; break; }
  if (!exe)
    throw new Error(
      `FSM Designer app not found (looked in: ${list.join("; ")}). Install the desktop app, or start the MCP server with --app <path to the exe> ` +
      `(or the FSM_DESIGNER_APP environment variable). The diagram file is ${file}.`,
    );
  const [cmd, args] = exe.endsWith(".app") ? ["open", ["-a", exe, file]] : [exe, [file]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  return exe;
}
