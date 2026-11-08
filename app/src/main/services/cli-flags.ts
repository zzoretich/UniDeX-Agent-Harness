// Whether an agent CLI takes a flag, read from its own `--help` (agent-computer R70). Codex 0.167's TUI runs its work,
// MCP servers included, in a shared background server (`codex app-server`, a daemon it starts and keeps) unless it is
// started with `--no-daemon`; the agenticos MCP server must stay the CLI's own child for the bridge to admit it (D18).
// Main asks the binary it resolved for a Code launch, once per binary (its real path, mtime and size), so an upgraded
// CLI is asked again. A probe that fails or runs past its timeout counts as "not listed" and is not cached. R77: the
// probe runs with the launch's environment (a Code terminal's, with the login PATH): an npm install's codex is a
// `#!/usr/bin/env node` script, and an app opened from the Dock has launchd's PATH, where there is no node.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";

/** How long a CLI's `--help` may take. */
export const HELP_TIMEOUT_MS = 5000;
/** At most this much of the help is read. */
const HELP_MAX = 1024 * 1024;

/** How a help is read: the environment it runs with (main's own when absent), the subcommand whose help it is (R77: a
 *  resume line asks `codex resume --help`), and its timeout. */
export interface HelpOptions { env?: NodeJS.ProcessEnv; sub?: string; timeoutMs?: number }

export interface FlagProbeDeps {
  realpath: (p: string) => string;
  stat: (p: string) => { mtimeMs: number; size: number };
  /** The CLI's `--help` output, or null when it failed or timed out. */
  help: (bin: string, o: HelpOptions) => Promise<string | null>;
}

/** `bin [sub] --help`'s stdout, or null when it cannot start, exits non-zero, or outlasts its timeout (it is killed then). */
export function cliHelp(bin: string, o: HelpOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      childProcess.execFile(bin, [...(o.sub ? [o.sub] : []), "--help"], {
        encoding: "utf8", timeout: o.timeoutMs ?? HELP_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: HELP_MAX, windowsHide: true, ...(o.env ? { env: o.env } : {}),
      }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

export const realFlagProbeDeps: FlagProbeDeps = {
  realpath: (p) => fs.realpathSync(p),
  stat: (p) => fs.statSync(p),
  help: (bin, o) => cliHelp(bin, o),
};

export class FlagProbe {
  private readonly cache = new Map<string, boolean>();
  /** R77: the probe running for each key, which concurrent asks share (one help run per key at a time). */
  private readonly running = new Map<string, Promise<string | null>>();
  private readonly re: RegExp;

  /** `flag`: a long option, such as `--no-daemon`; it counts only as a whole word in the help. */
  constructor(flag: string, private readonly d: FlagProbeDeps = realFlagProbeDeps) {
    this.re = new RegExp(`(^|[\\s,\\[])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s,=\\]])`, "m");
  }

  /** Whether `bin`'s help lists the flag: false when the binary is gone, or its help failed or timed out. `env`: the
   *  environment the help runs with, the launch's; `sub`: the subcommand whose help is read, cached apart (R77). */
  async lists(bin: string, o: { env?: NodeJS.ProcessEnv; sub?: string } = {}): Promise<boolean> {
    let key: string;
    try {
      const real = this.d.realpath(bin);
      const st = this.d.stat(real);
      key = `${real}\0${st.mtimeMs}\0${st.size}\0${o.sub ?? ""}`;
    } catch { return false; }
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let run = this.running.get(key);
    if (!run) {
      const started = this.d.help(bin, { env: o.env, sub: o.sub }).catch(() => null);
      run = started;
      this.running.set(key, started);
      void started.finally(() => { if (this.running.get(key) === started) this.running.delete(key); });
    }
    const out = await run;
    if (out === null) return false;
    const listed = this.re.test(out);
    this.cache.set(key, listed);
    return listed;
  }
}
