// The PATH a terminal would have (phase 5, I3). An app started from Finder gets launchd's PATH (/usr/bin:/bin:/usr/sbin:
// /sbin), which finds none of what the wizard checks for: the user's node, claude, codex, ollama, uv. Main asks the
// user's login shell for its PATH once per preflight (the HUD's nodeResolver asks it the same way, for node), then adds
// the folders the wizard's own installs and the usual installers write to, so a tool installed by a fix is found without
// a new shell.

import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
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

/** The most a shell's environment capture reads (R69): past it the capture gives none and the shell's group is killed. */
export const SHELL_ENV_CAP = 1024 * 1024;

/**
 * The environment `NAME=value` entries `env -0` printed after `marker` (whatever the shell's startup files printed before
 * it), or null when the marker is missing, nothing follows it, or what follows does not end in NUL (R69: a stream cut off
 * part way gives none, never part of an environment).
 */
export function parseShellEnv(out: string, marker: string): NodeJS.ProcessEnv | null {
  const at = out.indexOf(`\n${marker}\n`);
  if (at < 0) return null;
  const rest = out.slice(at + marker.length + 2);
  if (!rest.endsWith("\0")) return null;
  const env: NodeJS.ProcessEnv = {};
  for (const entry of rest.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return Object.keys(env).length ? env : null;
}

/**
 * The environment a terminal's shell gives what is typed into it (agent-computer C1, R65): `shell` started as a login,
 * interactive shell (its profile and rc files) in `cwd`, from `base`, printing its environment with `/usr/bin/env -0`
 * after a fresh marker, so a greeting cannot be mistaken for it. Null when the shell cannot start, fails, waits past
 * `timeoutMs` (killed then), prints more than `SHELL_ENV_CAP` bytes (killed then too), or never runs the command because a
 * startup file exits or execs something else: the caller then falls back to the launch typed into a shell. `_` (the
 * capture's own last command) is dropped. The output is read once the shell exits, so a daemon an rc file left holding
 * the pipe does not hold the launch.
 */
export function loginShellEnv(shell: string, cwd: string, base: NodeJS.ProcessEnv, timeoutMs = 8000): Promise<NodeJS.ProcessEnv | null> {
  const marker = `__AOS_ENV_${randomBytes(12).toString("hex")}__`;
  return new Promise((resolve) => {
    let child: childProcess.ChildProcess;
    try {
      // Its own session (detached: setsid), so an interactive shell finds no controlling terminal to take or read from.
      child = childProcess.spawn(shell, ["-l", "-i", "-c", `printf '\\n%s\\n' '${marker}'; exec /usr/bin/env -0`], { cwd, env: base, stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch { resolve(null); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      const env = ok ? parseShellEnv(Buffer.concat(chunks).toString("utf8"), marker) : null;
      if (env) delete env._;
      resolve(env);
    };
    // A shell that hangs, or prints past the cap, is killed with what its startup files started in its group.
    const kill = (): void => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
      finish(false);
    };
    const timer = setTimeout(kill, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      if (done) return;
      size += d.length;
      if (size > SHELL_ENV_CAP) { kill(); return; }
      chunks.push(d);
    });
    child.stdout?.on("end", () => { if (child.exitCode !== null) finish(child.exitCode === 0); });
    child.on("error", () => finish(false));
    // What env wrote is in the pipe by its exit: read for a moment longer, then stop, whoever else holds the pipe.
    child.on("exit", (code) => { if (child.stdout?.readableEnded) finish(code === 0); else setTimeout(() => finish(code === 0), 200); });
  });
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
