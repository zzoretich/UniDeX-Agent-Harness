// The PATH a terminal would have (phase 5, I3). An app started from Finder gets launchd's PATH (/usr/bin:/bin:/usr/sbin:
// /sbin), which finds none of what the wizard checks for: the user's node, claude, codex, ollama, uv. Main asks the
// user's login shell for its PATH once per preflight (the HUD's nodeResolver asks it the same way, for node), then adds
// the folders the wizard's own installs and the usual installers write to, so a tool installed by a fix is found without
// a new shell.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { privateNodeBinDir } from "./toolchain";

/** Printed before the PATH so the shell's own greeting (an interactive rc file may print one) cannot be mistaken for it. */
export const PATH_MARKER = "__AOS_PATH__=";

/**
 * Where programs get installed: ~/.local/bin (uv, and the claude, codex and aos links), the wizard's private Node
 * (install-import B1), cargo's, and Homebrew's (Apple silicon, Intel) for what a user installed with it.
 */
export function installDirs(home: string): string[] {
  return [path.join(home, ".local", "bin"), privateNodeBinDir(home), path.join(home, ".cargo", "bin"), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
}

const SYSTEM = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The PATH in a login shell's output, after the marker; null when it is not there. */
export function parseLoginPath(out: string): string | null {
  const line = out.split("\n").reverse().find((l) => l.startsWith(PATH_MARKER));
  const value = line?.slice(PATH_MARKER.length).trim();
  return value ? value : null;
}

/** PATH lists joined in order, each folder once, relative entries dropped. */
export function mergePath(...lists: Array<string | string[] | null | undefined>): string {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const dir of (Array.isArray(list) ? list : (list ?? "").split(":"))) if (dir && path.isAbsolute(dir)) seen.add(dir);
  }
  return [...seen].join(":");
}

export interface LoginPathDeps {
  shell: string | undefined;
  home: string;
  exec: (file: string, args: string[], opts: { encoding: "utf8"; timeout: number; env: NodeJS.ProcessEnv }) => string;
  env: NodeJS.ProcessEnv;
}

/**
 * The login shell's own PATH, as a new terminal would have it; null when the shell fails or hangs (its 8 s timeout).
 * $AOS_SETUP_PATH replaces the lookup (the e2e suite's stand-in tools).
 */
export function shellPath(d: LoginPathDeps): string | null {
  if (d.env.AOS_SETUP_PATH !== undefined) return mergePath(d.env.AOS_SETUP_PATH);
  const shell = d.shell && path.isAbsolute(d.shell) ? d.shell : "/bin/zsh";
  try {
    return parseLoginPath(d.exec(shell, ["-lic", `printf '\\n${PATH_MARKER}%s\\n' "$PATH"`], { encoding: "utf8", timeout: 8000, env: d.env }));
  } catch { return null; }
}

/**
 * The PATH the wizard runs with. $AOS_SETUP_PATH replaces the whole lookup (the e2e suite's stand-in tools); otherwise
 * the login shell's PATH (`shell`, when the caller already asked for it), then the install folders, then the system's.
 * A shell that fails or hangs falls back to main's own PATH.
 */
export function loginPath(d: LoginPathDeps, shell?: string | null): string {
  if (d.env.AOS_SETUP_PATH !== undefined) return mergePath(d.env.AOS_SETUP_PATH);
  const fromShell = shell === undefined ? shellPath(d) : shell;
  return mergePath(fromShell ?? d.env.PATH, installDirs(d.home), SYSTEM);
}

export const defaultLoginPathDeps = (env: NodeJS.ProcessEnv, home: string): LoginPathDeps => ({
  shell: env.SHELL, home, env,
  exec: (file, args, opts) => childProcess.execFileSync(file, args, { ...opts, stdio: ["ignore", "pipe", "ignore"] }),
});

/** An executable file named `name` in one of PATH's folders, else null. */
export function findOnPath(name: string, PATH: string, isExec: (p: string) => boolean = isExecutable): string | null {
  for (const dir of PATH.split(":")) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    if (isExec(p)) return p;
  }
  return null;
}

export function isExecutable(p: string): boolean {
  try { return fs.statSync(p).isFile() && (fs.statSync(p).mode & 0o111) !== 0; } catch { return false; }
}
