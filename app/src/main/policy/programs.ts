// Which program a spawn may start, in which folder, with which environment (phase 4, S4). The write policy says which
// commands a surface runs (`node <script> …`, `claude -p …`); this says that `node` and `claude` are programs the user
// installed, not something the page chose. The page cannot create a file outside the vault or the app's data, and
// cannot make one executable, so a program is trusted when it is a bare name (main's PATH finds it) or an absolute,
// executable file outside both. The child's environment is main's own plus a few named variables, each with a rule
// for its value: the page never sends a whole environment, and never NODE_OPTIONS, PATH or DYLD_*.

import * as fs from "node:fs";
import * as path from "node:path";
import { agenticosFiles, claudeDirs, codexHomes, type ScopeOptions } from "./read-scope";

export interface ProgramContext extends ScopeOptions {
  /** /etc/shells, as main read it. */
  shells: readonly string[];
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** The path as the disk spells it (links followed, each name in the disk's own case), so a folder spelled in another case
 *  is still recognised as the vault; the path itself when it is not there. */
function realOrSelf(p: string): string { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }

/** Folders the page can write into (through the bridge): no program may live there. */
function writable(ctx: ProgramContext): string[] {
  return [...(ctx.vaultRoot ? [ctx.vaultRoot] : []), ctx.userData].flatMap((p) => [path.resolve(p), realOrSelf(p)]);
}

/** Why `cmd` may not be started, or null when it may. */
export function programRefusal(cmd: string, ctx: ProgramContext): string | null {
  if (!cmd || cmd.includes("\0")) return "no program";
  if (!cmd.includes("/")) return /^[A-Za-z0-9._+-]+$/.test(cmd) ? null : "an odd program name";
  if (!path.isAbsolute(cmd)) return "a relative program path";
  const real = realOrSelf(cmd);
  if (writable(ctx).some((root) => inside(root, real))) return "a program inside the vault or the app's data";
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return "not a file";
    if ((st.mode & 0o111) === 0) return "not executable";
  } catch { return "no such program"; }
  return null;
}

/** Whether a folder may be a spawned process's working directory: inside the vault. */
export function cwdRefusal(cwd: string | undefined, ctx: ProgramContext): string | null {
  if (!cwd) return "no working directory";
  if (!ctx.vaultRoot || !path.isAbsolute(cwd)) return "a working directory outside the vault";
  const roots = [path.resolve(ctx.vaultRoot), realOrSelf(ctx.vaultRoot)];
  const p = path.resolve(cwd);
  return roots.some((r) => inside(r, p) || inside(r, realOrSelf(p))) ? null : "a working directory outside the vault";
}

type ValueRule = (value: string, ctx: ProgramContext) => boolean;

const oneOf = (list: (ctx: ProgramContext) => readonly string[]): ValueRule =>
  (v, ctx) => list(ctx).some((p) => path.resolve(p) === path.resolve(v) || realOrSelf(p) === realOrSelf(v));

/** The variables a spawn may set, and what each may be set to. The pins the HUD sends (aosRun, claudeAsk, main.ts). */
const SPAWN_VARS: Record<string, ValueRule> = {
  AOS_VAULT: (v, ctx) => !!ctx.vaultRoot && oneOf((c) => [c.vaultRoot as string])(v, ctx),
  AOS_CONFIG: oneOf((ctx) => agenticosFiles(ctx)),
  CLAUDE_CONFIG_DIR: oneOf((ctx) => claudeDirs(ctx)),
  CODEX_HOME: oneOf((ctx) => codexHomes(ctx)),
  AOS_HEADLESS: (v) => v === "1",
  // Blank, so a runtime script started from the app never looks like a hook (main.ts reconcile-sessions).
  AOS_HOST: (v) => v === "",
  CLAUDE_PROJECT_DIR: (v) => v === "",
};

/** And a terminal's, on top: what TerminalSession always sets. */
const PTY_VARS: Record<string, ValueRule> = {
  ...SPAWN_VARS,
  TERM: (v) => v === "xterm-256color",
  COLORTERM: (v) => v === "truecolor",
  AGENTIC_OS: (v) => v === "1",
  // So Claude Code keeps the links its status line prints (it drops them when it cannot tell the terminal shows them).
  FORCE_HYPERLINK: (v) => v === "1",
};

/** The variables a spawn may remove: CLAUDECODE, so a headless claude never re-enters the user's hooks. */
const UNSET_VARS = new Set(["CLAUDECODE"]);

export type EnvResult = { env: NodeJS.ProcessEnv } | { refusal: string };

function buildEnv(rules: Record<string, ValueRule>, base: NodeJS.ProcessEnv, set: Record<string, string> = {}, unset: readonly string[] = [], ctx: ProgramContext): EnvResult {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(set)) {
    const rule = Object.prototype.hasOwnProperty.call(rules, k) ? rules[k] : undefined;
    if (!rule) return { refusal: `the variable ${k}` };
    if (typeof v !== "string" || !rule(v, ctx)) return { refusal: `${k}=${String(v).slice(0, 80)}` };
    env[k] = v;
  }
  for (const k of unset) {
    if (!UNSET_VARS.has(k)) return { refusal: `removing ${k}` };
    delete env[k];
  }
  return { env };
}

/** A spawned process's environment: main's own, with the page's allowed variables on top. */
export function spawnEnv(base: NodeJS.ProcessEnv, set: Record<string, string> | undefined, unset: readonly string[] | undefined, ctx: ProgramContext): EnvResult {
  return buildEnv(SPAWN_VARS, base, set, unset, ctx);
}

/** A terminal's environment. */
export function ptyEnv(base: NodeJS.ProcessEnv, set: Record<string, string> | undefined, ctx: ProgramContext): EnvResult {
  return buildEnv(PTY_VARS, base, set, [], ctx);
}

/** The shells a terminal may start: /etc/shells, and main's own $SHELL. Absolute, with no arguments. */
export function shellRefusal(file: string, args: readonly string[], ctx: ProgramContext): string | null {
  if (args.length) return "a shell with arguments";
  const allowed = new Set([...ctx.shells, ctx.env.SHELL].filter((s): s is string => !!s && path.isAbsolute(s)));
  if (!allowed.has(file)) return `${file} is not in /etc/shells`;
  return programRefusal(file, ctx);
}

/** /etc/shells → its absolute entries. */
export function parseShells(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/"));
}
