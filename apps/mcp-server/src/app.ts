// Opens a diagram file in the FSM Designer desktop app (Tauri). The app takes
// a .fsm.json path on its command line, the same as double-clicking the file.

import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
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

const EXE_NAMES = ["FSM Designer.exe", "fsm-designer.exe", "FSM Designer", "fsm-designer"];

/** The program to run for `p`: a macOS .app bundle, an executable, or the install folder that holds one. */
async function program(p: string): Promise<string> {
  const s = await stat(p);
  if (s.isDirectory() && !p.endsWith(".app")) {
    for (const n of EXE_NAMES) if (await exists(join(p, n))) return program(join(p, n));
    throw new Error(`${p} is a folder without the FSM Designer program in it; give the path of the program itself to --app`);
  }
  if (!s.isDirectory() && process.platform !== "win32") {
    try {
      await access(p, constants.X_OK);
    } catch {
      throw new Error(`${p} is not executable; give the FSM Designer program to --app (or chmod +x it)`);
    }
  }
  return p;
}

/** Start the app on `file` without waiting for it. Returns the program used. */
export async function launchApp(file: string, opts: AppOptions = {}): Promise<string> {
  const list = opts.path ? [opts.path] : candidates();
  let found: string | undefined;
  for (const c of list) if (await exists(c)) { found = c; break; }
  if (!found)
    throw new Error(
      `FSM Designer app not found (looked in: ${list.join("; ")}). Install the desktop app, or start the MCP server with --app <path to the exe> ` +
      `(or the FSM_DESIGNER_APP environment variable). The diagram file is ${file}.`,
    );
  const exe = await program(found);
  // macOS: `open -a App file` hands the file over as an Apple event, which the app
  // does not read; --args puts it on the command line like on the other systems.
  const [cmd, args] = exe.endsWith(".app") ? ["open", ["-n", "-a", exe, "--args", file]] : [exe, [file]];
  // Windows only runs .cmd/.bat launchers through the shell.
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
  await new Promise<void>((resolve, reject) => {
    const child = shell
      ? spawn(`"${exe}" "${file}"`, { detached: true, stdio: "ignore", windowsHide: false, shell: true })
      : spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", (e) => reject(new Error(`Could not start ${exe}: ${(e as NodeJS.ErrnoException).code ?? e.message}. Check the --app path (or FSM_DESIGNER_APP). The diagram file is ${file}.`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  return exe;
}
