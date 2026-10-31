// What the wizard and attach mode may run (phase 5, I4, I5; install-import B1, B2, B13, B14). The page names a fix by id and a
// step by name; the commands, the program, the arguments, the downloads and the files are main's. A fix is either a
// toolchain job (setup/toolchain.ts: a pinned download, checked, then put in place; or Ollama's models through its API)
// or, for the two logins, a fixed command line the user sees typed in the wizard's terminal before it runs. No fix needs
// Homebrew, npm or a terminal of the user's own. `aos init` and `aos upgrade` are the payload's own CLI run with the
// node preflight found, never through a shell.

import * as os from "node:os";
import * as path from "node:path";
import type { HostId, ImportRunRequest, InstallRequest, PersonaAnswers, SetupCheckId, SetupFixId } from "../../shared/ipc";
import { foldPath } from "../../shared/surfaces";
import { sameOnDisk } from "./identity";
import type { ToolchainJob } from "../setup/toolchain";
import { importArgs } from "../../../../hud/src/data/importModel";

export type Fix =
  /** Run by /bin/sh -c in the wizard's terminal, with the login PATH (setup/env.ts). */
  | { kind: "terminal"; label: string; command: string; needs: SetupCheckId[] }
  /** A toolchain job main runs itself, its output and progress in the wizard. */
  | { kind: "download"; label: string; job: ToolchainJob; needs: SetupCheckId[] };

export const FIXES: Record<SetupFixId, Fix> = {
  node: { kind: "download", label: "Install Node.js", job: "node", needs: [] },
  uv: { kind: "download", label: "Install uv", job: "uv", needs: [] },
  ollama: { kind: "download", label: "Install Ollama", job: "ollama", needs: [] },
  "ollama-models": { kind: "download", label: "Download the models", job: "models", needs: ["ollama"] },
  claude: { kind: "download", label: "Install Claude Code", job: "claude", needs: [] },
  codex: { kind: "download", label: "Install Codex", job: "codex", needs: [] },
  "claude-login": { kind: "terminal", label: "Log in", command: "claude auth login", needs: ["claude"] },
  "codex-login": { kind: "terminal", label: "Log in", command: "codex login", needs: ["codex"] },
};

export const FIX_IDS = Object.keys(FIXES) as SetupFixId[];

/** Why a fix cannot run while only `ok` checks pass, else null. */
export function fixBlocked(id: SetupFixId, ok: ReadonlySet<SetupCheckId>): string | null {
  const missing = FIXES[id].needs.filter((n) => !ok.has(n));
  if (!missing.length) return null;
  const names: Partial<Record<SetupCheckId, string>> = { node: "Node.js", claude: "Claude Code", codex: "the Codex CLI", ollama: "Ollama" };
  return `needs ${missing.map((n) => names[n] ?? n).join(" and ")} first`;
}

/** The program and arguments of a terminal fix. */
export function fixCommandLine(id: SetupFixId): { file: string; args: string[] } {
  const fix = FIXES[id];
  if (fix.kind !== "terminal") throw new Error(`${id} is not a terminal fix`);
  return { file: "/bin/sh", args: ["-c", fix.command] };
}

/**
 * A vault folder as the user typed or picked it: absolute, or ~/…; null when it is neither, or is home (in any spelling
 * the disk opens as home: foldPath, or any other name for its folder, such as the /System/Volumes/Data firmlink) or a
 * root.
 */
export function resolveVaultPath(input: string, home: string = os.homedir()): string | null {
  const raw = input.trim();
  const p = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(p) || p.includes("\0")) return null;
  const abs = path.resolve(p);
  if (foldPath(abs) === foldPath(path.resolve(home)) || sameOnDisk(abs, home) || path.parse(abs).root === abs) return null;
  return abs;
}

/** The answers `aos init --persona-json` reads (persona/interview.js normalizeAnswers checks them again). */
export function personaJson(a: PersonaAnswers, hosts: { claude: boolean; codex: boolean }): Record<string, unknown> {
  return {
    name: a.name.trim(),
    addressAs: a.addressAs.trim(),
    voice: a.voice.trim(),
    priorities: a.priorities.map((p) => p.trim()).filter(Boolean),
    ...(hosts.claude && a.dutyModel.trim() ? { dutyModel: a.dutyModel.trim() } : {}),
    ...(hosts.codex && a.dutyCodexModel.trim() ? { dutyCodexModel: a.dutyCodexModel.trim() } : {}),
    dutyEffort: a.dutyEffort,
    schedule: a.schedule,
  };
}

/** `aos init`'s arguments: unattended (--yes), the user's host (or none) and folder, the persona answers when given. */
export function installArgs(cli: string, req: InstallRequest, vault: string, personaFile: string | null): string[] {
  return [cli, "init", "--yes", "--vault", vault, "--host", req.host, ...(req.superpowers === false ? ["--no-superpowers"] : []), ...(personaFile ? ["--persona-json", personaFile] : [])];
}

/** The hosts an install request turns on. */
export function requestHosts(host: InstallRequest["host"]): { claude: boolean; codex: boolean } {
  return { claude: host === "claude" || host === "both", codex: host === "codex" || host === "both" };
}

/** install-import B14: the one line Finish offers to append, so `aos` and the hosts' CLIs in ~/.local/bin run from a terminal. */
export const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

/** The login profile zsh (macOS's shell) reads: $ZDOTDIR/.zprofile when ZDOTDIR is set, else ~/.zprofile. */
export function zprofilePath(home: string, env: NodeJS.ProcessEnv): string {
  const dir = env.ZDOTDIR && path.isAbsolute(env.ZDOTDIR) ? env.ZDOTDIR : home;
  return path.join(dir, ".zprofile");
}

/**
 * "Bring in your history" (install-import B13): `aos import`'s arguments from the payload's CLI, as the HUD builds them
 * (hud/src/data/importModel.ts importArgs, the one argv the import surface admits too), with only the
 * proposals main's own last scan listed. Throws on a request the runtime would refuse.
 */
export function importJobArgs(cli: string, req: ImportRunRequest, scanned: ReadonlySet<string>): string[] {
  return [cli, ...importArgs({ from: req.from, only: req.only, accept: req.accept.filter((id) => scanned.has(id)) })];
}

/** The scan before it: `aos import --dry-run --json` over every kind, both hosts. */
export function importScanArgs(cli: string): string[] {
  return [cli, ...importArgs({ from: ["claude", "codex"], only: ["instructions", "memories", "projects", "mcp", "sessions"] }, { dryRun: true, json: true })];
}

/** `aos uninstall --host <host>` from the payload's CLI: that host's plugin, hooks and MCP server out; the vault and the rest kept. */
export function unwireArgs(cli: string, host: HostId): string[] {
  return [cli, "uninstall", "--host", host];
}

export type SetupStep = "preflight" | "fix" | "install" | "upgrade" | "finish" | "claude-md" | "path" | "import" | "unwire";

export interface SetupState {
  /** A vault is attached (the Workbench is showing). */
  attached: boolean;
  /** `aos init` finished with exit 0 in this run. */
  installed: boolean;
  /** The app carries a runtime. */
  payload: boolean;
  /** The vault's runtime is older than the payload's. */
  behind: boolean;
  /** A fix, the install or an upgrade is running. */
  busy: boolean;
}

/** Why a step may not run now, or null. */
export function stepRefusal(step: SetupStep, s: SetupState): string | null {
  if (s.busy && step !== "claude-md" && step !== "preflight") return "another setup step is running";
  switch (step) {
    // The checks and their fixes are the wizard's: once a vault is attached, neither runs.
    case "preflight": case "fix": return s.attached ? "a vault is already attached" : null;
    case "install": return s.attached ? "a vault is already attached" : !s.payload ? "this build carries no runtime" : null;
    case "upgrade": return !s.payload ? "this build carries no runtime" : !s.attached ? "no vault is attached" : !s.behind ? "the vault's runtime is not behind this app's" : null;
    // Attaches only what agenticos.json names, which main reads itself: after the wizard's install, or a terminal's
    // `aos init`, or a vault folder that is back (an external disk).
    case "finish": return s.attached ? "a vault is already attached" : null;
    case "claude-md": return s.attached || s.installed ? null : "no vault yet";
    // Finish's PATH line: the wizard's, once `aos init` has put the launcher in ~/.local/bin.
    case "path": return s.attached ? "a vault is already attached" : s.installed ? null : "no vault yet";
    // Bring in your history: the wizard's, between the install and the Workbench (Settings ▸ Import has it after).
    case "import": return s.attached ? "a vault is already attached" : !s.payload ? "this build carries no runtime" : s.installed ? null : "no vault yet";
    // An earlier install's host taken out: before this install, never after it or once a vault is attached.
    case "unwire": return s.attached ? "a vault is already attached" : !s.payload ? "this build carries no runtime" : s.installed ? "the install already finished" : null;
  }
}
