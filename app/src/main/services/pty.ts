// The page's terminals, in main (phase 4, S5): the app's own node-pty (unpacked from the archive in a packaged build).
// A terminal starts a shell listed in /etc/shells (or main's own $SHELL) with no arguments, in an existing folder, with
// main's environment plus TerminalSession's few variables. What is typed into it is the user's: a terminal is a shell
// by design, and SECURITY.md records that a compromised page could type there too.
//
// A Code launch's terminal can instead be the agent CLI itself (spawnAgent, agent-computer D18): main resolves the
// binary through the runtime (as a Chat turn's), checks its install form (computer/admission.ts launchForm) and the
// words after it (policy/agent-launch.ts), and registers the process while it runs, so the computer bridge admits only
// agents this app started. Whatever main cannot vouch for answers `code: "fallback"`, and the page types the launch
// line into a shell as before: spawnAgent never blocks a launch.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PtyAgentRequest, PtyEvent, PtySpawnRequest, Result } from "../../shared/ipc";
import { launchForm, VENDOR, type Sys } from "../computer/admission";
import type { AgentRef, AgentRegistry } from "../computer/registry";
import { agentArgvRefusal } from "../policy/agent-launch";
import { programRefusal, ptyEnv, shellRefusal, type ProgramContext } from "../policy/programs";
import { failure, refused } from "./fs";
import type { BinResolution } from "./sessions";

export type { PtyAgentRequest };

/** How many terminals may be open at once. */
export const MAX_TERMINALS = 32;

export interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
}

export interface PtyLib { spawn(file: string, args: string[], opts: Record<string, unknown>): PtyProcess }

/**
 * The environment a terminal starts from (spec 2026-10-08-term-agent-deck T14): main's own, with the login shell's PATH
 * when it is known, since an app opened from Finder has launchd's PATH and the terminal's zsh is not a login shell
 * (no /etc/zprofile, no ~/.zprofile), so `claude` or `codex` — or the node an npm-installed one runs on — would not be
 * found. CLAUDECODE goes: an app started from a Claude Code session must not make its terminals look like one.
 */
export function terminalBaseEnv(env: NodeJS.ProcessEnv, loginPATH: string | null): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (loginPATH) out.PATH = loginPATH;
  delete out.CLAUDECODE;
  return out;
}

export interface PtyServiceOptions {
  context: () => ProgramContext;
  /** The base environment, or how to get it at each new terminal (terminalBaseEnv). */
  env: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  emit: (ev: PtyEvent) => void;
  /** Loads node-pty (the tests pass a fake). */
  load: () => PtyLib;
  /** agent-computer D18: the binary a Code launch runs, as the runtime resolves it, or why none (SessionService.resolveBin). */
  resolveBin?: (host: "claude" | "codex") => Promise<BinResolution>;
  /** The agents this app spawned: a Code launch's CLI is registered while it runs. */
  registry?: AgentRegistry;
  /** The peer addon's checks, or null when it did not load (every Code launch then falls back). */
  sys?: Sys | null;
  /** Real paths a test build treats as a vendor-signed CLI (agent-computer D18: AOS_E2E_TRUSTED_CLI, never packaged). */
  trusted?: readonly string[];
  /** A Code launch's agent left the registry: it exited, its terminal closed, or its page went (agent-computer D31: the
   *  computer frees its wheel and cancels its asks). */
  onAgentGone?: (agent: AgentRef) => void;
  /** Runs `git init -q` in a folder (the tests pass a fake). */
  gitInit?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGHUP", "SIGINT"]);

const HOST_LABEL = { claude: "Claude Code", codex: "Codex" } as const;
const VENDOR_NAME = { claude: "Anthropic", codex: "OpenAI" } as const;

/** What TerminalSession sets on every terminal, set by main on an agent's. */
const TERM_VARS: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor", AGENTIC_OS: "1", FORCE_HYPERLINK: "1" };

/** Main cannot vouch for the agent: the page starts a shell and types the launch line, and says why. One line. */
const fallback = (why: string): Result<never> => ({ ok: false, error: why.replace(/\s+/g, " ").slice(0, 400), code: "fallback" });

/** Why a folder may not be a terminal's working directory, or null. */
function folderRefusal(cwd: string): Result<never> | null {
  try { if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) return refused("a working directory that is not a folder"); }
  catch { return refused("a working directory that is not there"); }
  return null;
}

/** `git init -q` in `cwd`, found on the terminal's PATH. */
function gitInitIn(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    childProcess.execFile("git", ["init", "-q"], { cwd, env, timeout: 30_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

export class PtyService {
  private lib: PtyLib | null = null;
  private loadError: string | null = null;
  private readonly sessions = new Map<string, PtyProcess>();
  /** Terminal id → the pid of the agent it runs (spawnAgent), while it is registered. */
  private readonly agents = new Map<string, number>();
  /** Bumped by killAll: an agent still being resolved when its page went is not started. */
  private epoch = 0;

  constructor(private readonly o: PtyServiceOptions) {}

  private loadLib(): PtyLib | null {
    if (this.lib || this.loadError) return this.lib;
    try { this.lib = this.o.load(); } catch (err) { this.loadError = err instanceof Error ? err.message.split("\n")[0] : String(err); }
    return this.lib;
  }

  available(): Result<null> {
    return this.loadLib() ? { ok: true, data: null } : { ok: false, error: `node-pty failed to load: ${this.loadError}`, code: "ENOSYS" };
  }

  spawn(req: PtySpawnRequest): Result<{ pid: number }> {
    const lib = this.loadLib();
    if (!lib) return { ok: false, error: `node-pty failed to load: ${this.loadError}`, code: "ENOSYS" };
    if (this.sessions.has(req.id)) return { ok: false, error: "a terminal with this id is open", code: "EEXIST" };
    if (this.sessions.size >= MAX_TERMINALS) return { ok: false, error: "too many terminals", code: "EAGAIN" };
    const why = shellRefusal(req.file, req.args, this.o.context());
    if (why) return refused(why);
    const folder = folderRefusal(req.cwd);
    if (folder) return folder;
    const base = typeof this.o.env === "function" ? this.o.env() : this.o.env;
    const env = ptyEnv(base, req.env, this.o.context());
    if ("refusal" in env) return refused(env.refusal);
    let p: PtyProcess;
    try {
      p = lib.spawn(req.file, [], { name: req.name, cols: req.cols, rows: req.rows, cwd: req.cwd, env: env.env });
    } catch (err) { return failure(err); }
    const { id } = req;
    this.sessions.set(id, p);
    p.onData((data) => this.o.emit({ id, type: "data", data }));
    p.onExit((e) => {
      this.sessions.delete(id);
      this.o.emit({ id, type: "exit", exitCode: e.exitCode, ...(e.signal !== undefined ? { signal: e.signal } : {}) });
    });
    return { ok: true, data: { pid: p.pid } };
  }

  /**
   * A Code launch's terminal, running the agent CLI itself (agent-computer D18). Refused (EROFS) for words launchArgs
   * never emits or a folder that is not one: the same folder rule as a shell's, so every Code place works (D30). Falls
   * back (`code: "fallback"`) when the runtime names no binary, the peer addon is missing, the install form is neither
   * the vendor's signed binary nor its npm package, the environment would carry a config folder main does not know, or
   * the CLI does not start. Registered as `code:<id>` until it exits or the terminal is closed.
   */
  async spawnAgent(req: PtyAgentRequest): Promise<Result<{ pid: number }>> {
    try { return await this.startAgent(req); }
    catch (err) { return fallback(`the agent did not start: ${err instanceof Error ? err.message : String(err)}`); }
  }

  private slotRefusal(id: string): Result<never> | null {
    if (this.sessions.has(id)) return { ok: false, error: "a terminal with this id is open", code: "EEXIST" };
    if (this.sessions.size >= MAX_TERMINALS) return { ok: false, error: "too many terminals", code: "EAGAIN" };
    return null;
  }

  private async startAgent(req: PtyAgentRequest): Promise<Result<{ pid: number }>> {
    const lib = this.loadLib();
    if (!lib) return { ok: false, error: `node-pty failed to load: ${this.loadError}`, code: "ENOSYS" };
    const slot = this.slotRefusal(req.id);
    if (slot) return slot;
    const words = agentArgvRefusal(req.host, req.argv);
    if (words) return refused(`${HOST_LABEL[req.host]} with ${words}`);
    const folder = folderRefusal(req.cwd);
    if (folder) return folder;
    const label = HOST_LABEL[req.host];
    const epoch = this.epoch;
    const { resolveBin, registry, sys } = this.o;
    if (!resolveBin || !registry) return fallback("this app keeps no record of the agents it starts");
    if (!sys) return fallback("the app's peer addon did not load");
    const resolved = await resolveBin(req.host);
    if ("reason" in resolved) return fallback(resolved.reason);
    const { bin } = resolved;
    const ctx = this.o.context();
    const program = programRefusal(bin, ctx);
    if (program) return fallback(`${label} at ${bin}: ${program}`);
    if (launchForm(req.host, bin, sys, this.o.trusted) === null) {
      return fallback(`${label} at ${bin} isn't a supported install: it is neither signed by ${VENDOR_NAME[req.host]} nor the ${VENDOR[req.host].pkg} npm package`);
    }
    const set = { ...TERM_VARS, ...(req.configDir ? { [req.host === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: req.configDir } : {}) };
    const base = typeof this.o.env === "function" ? this.o.env() : this.o.env;
    const env = ptyEnv(base, set, ctx);
    if ("refusal" in env) return fallback(`the agent's environment would carry ${env.refusal}`);
    if (req.gitInit && !fs.existsSync(path.join(req.cwd, ".git"))) {
      // As the typed `[ -e .git ] || git init -q;` did: a failed init does not stop the agent.
      try { await (this.o.gitInit ?? gitInitIn)(req.cwd, env.env); } catch { /* the agent starts anyway */ }
    }
    // The awaits above let the page go, or another terminal in.
    if (epoch !== this.epoch) return { ok: false, error: "the page that asked for it is gone", code: "ECANCELED" };
    const again = this.slotRefusal(req.id);
    if (again) return again;
    let p: PtyProcess;
    try {
      p = lib.spawn(bin, [...req.argv], { name: "xterm-256color", cols: req.cols, rows: req.rows, cwd: req.cwd, env: env.env });
    } catch (err) { return fallback(`${label} did not start (${(err as NodeJS.ErrnoException)?.code ?? "error"})`); }
    const { id } = req;
    const pid = p.pid;
    this.sessions.set(id, p);
    this.agents.set(id, pid);
    registry.add({ pid, host: req.host, page: "code", key: `code:${id}`, label: req.label, place: req.place, access: req.access });
    p.onData((data) => this.o.emit({ id, type: "data", data }));
    p.onExit((e) => {
      this.forget(id, pid);
      // A stale agent (its page went, its id taken again since) says nothing to the terminal that has the id now.
      if (this.sessions.get(id) !== p) return;
      this.sessions.delete(id);
      this.o.emit({ id, type: "exit", exitCode: e.exitCode, ...(e.signal !== undefined ? { signal: e.signal } : {}) });
    });
    return { ok: true, data: { pid } };
  }

  /** Takes a terminal's agent out of the registry, unless that pid has been registered again by something else since,
   *  and says it is gone (once: a later exit finds it already forgotten). */
  private forget(id: string, pid: number): void {
    if (this.agents.get(id) === pid) this.agents.delete(id);
    const ref = this.o.registry?.get(pid);
    if (!ref || ref.key !== `code:${id}`) return;
    this.o.registry?.remove(pid);
    try { this.o.onAgentGone?.(ref); } catch (err) { console.error("[main] onAgentGone failed", err); }
  }

  write(id: string, data: string): void { this.sessions.get(id)?.write(data); }

  resize(id: string, cols: number, rows: number): void {
    try { this.sessions.get(id)?.resize(cols, rows); } catch { /* a race with its exit */ }
  }

  kill(id: string, signal?: string): void {
    const p = this.sessions.get(id);
    if (!p) return;
    try { p.kill(signal && SIGNALS.has(signal) ? signal : undefined); } catch { /* gone */ }
    // A closed terminal's agent is forgotten at once, not when its exit arrives (agent-computer D18).
    const pid = this.agents.get(id);
    if (pid !== undefined) this.forget(id, pid);
  }

  /** Every terminal ends with the page that opened it, and on quit. */
  killAll(): void {
    for (const p of this.sessions.values()) { try { p.kill(); } catch { /* gone */ } }
    this.sessions.clear();
    this.epoch++;
    for (const [id, pid] of [...this.agents]) this.forget(id, pid);
  }

  get open(): number { return this.sessions.size; }
}
