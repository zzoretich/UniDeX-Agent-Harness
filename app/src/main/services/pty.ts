// The page's terminals, in main (phase 4, S5): the app's own node-pty (unpacked from the archive in a packaged build).
// A terminal starts a shell listed in /etc/shells (or main's own $SHELL) with no arguments, in an existing folder, with
// main's environment plus TerminalSession's few variables. What is typed into it is the user's: a terminal is a shell
// by design, and SECURITY.md records that a compromised page could type there too.
//
// A Code launch's terminal can instead be the agent CLI itself (spawnAgent, agent-computer D18), while the computer
// surface is on: main resolves the binary through the runtime (as a Chat turn's), checks its install form
// (computer/admission.ts launchForm) and the words after it (policy/agent-launch.ts), starts it from the environment the
// user's login shell gives a typed command (its profile and rc files' exports, C1), and registers the process while it
// runs, so the computer bridge admits only agents this app started. With the surface off, and whatever main cannot vouch
// for, it answers `code: "fallback"`, and the page types the launch line into a shell as before: spawnAgent never
// blocks a launch. The page asks `agentFlags` whether a Codex line carries `--no-daemon` (R70): Codex 0.167's TUI
// otherwise runs the agenticos MCP server in its shared background server, which the bridge cannot admit. Main decides
// it again at the spawn, for the binary it runs, and refuses a line that disagrees with its answer (R79), the last time
// right before lib.spawn (R81).

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentFlags, PtyAgentRequest, PtyAgentResult, PtyEvent, PtySpawnRequest, Result } from "../../shared/ipc";
import { launchForm, VENDOR, type Sys } from "../computer/admission";
import type { AgentRef, AgentRegistry } from "../computer/registry";
import { agentArgvRefusal } from "../policy/agent-launch";
import { programRefusal, ptyEnv, shellRefusal, UUID_RE, type ProgramContext } from "../policy/programs";
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

/** The variables a host session (Claude Code, Codex) sets for itself and its children (terminalBaseEnv, R64). */
const HOST_SESSION_VAR = /^(?:CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CODEX_SANDBOX|CODEX_SANDBOX_NETWORK_DISABLED|CODEX_THREAD_ID|CODEX_SESSION_ID)$/;

/**
 * The environment a terminal starts from (spec 2026-10-08-term-agent-deck T14): main's own, with the login shell's PATH
 * when it is known, since an app opened from Finder has launchd's PATH and the terminal's zsh is not a login shell
 * (no /etc/zprofile, no ~/.zprofile), so `claude` or `codex` — or the node an npm-installed one runs on — would not be
 * found. CLAUDECODE goes: an app started from a Claude Code session must not make its terminals look like one. So do
 * that session's other markers (code-chat R64): every CLAUDE_CODE_* and CLAUDE_AGENT_SDK_* variable, CLAUDE_PID and
 * CLAUDE_EFFORT, and Codex's per-session CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED, CODEX_THREAD_ID and
 * CODEX_SESSION_ID. They describe the session that launched the app (one is a messaging token), not your settings, and an
 * app launchd starts has none; your settings live in the host's own settings and the rc files the terminal's zsh reads.
 * CODEX_HOME, CLAUDE_CONFIG_DIR and everything else stay. AOS_TERMINAL goes too (code-chat F8): an app started inside an
 * agent terminal must not hand that terminal's key to its own.
 */
export function terminalBaseEnv(env: NodeJS.ProcessEnv, loginPATH: string | null): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (loginPATH) out.PATH = loginPATH;
  for (const k of Object.keys(out)) if (HOST_SESSION_VAR.test(k)) delete out[k];
  delete out.AOS_TERMINAL;
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
  /** Whether the computer surface is on (agent-computer D26). Off, or absent, every Code launch falls back with no
   *  reason, before any check runs: the launch is typed into a shell exactly as before the computer (C1, R65). */
  computerOn?: () => boolean;
  /** The environment `shell`, as a login, interactive shell in `cwd` started from `base`, gives a typed command, or null
   *  when it gives none (setup/env.ts loginShellEnv). Absent (the tests), the agent starts from `env`. */
  shellEnv?: (shell: string, cwd: string, base: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>;
  /** Whether a CLI's `--help`, run with `env` (the launch's: the terminal base environment, R77), lists `--no-daemon`
   *  (services/cli-flags.ts FlagProbe, cached per binary). Absent, no Codex launch carries the flag. */
  noDaemon?: (bin: string, env: NodeJS.ProcessEnv, sub?: "resume") => Promise<boolean>;
  /** Settings ▸ Computer (`computer.enabled`, agent-computer D25): the person's switch inside the surface. With it off no
   *  Codex launch carries `--no-daemon` (R77: the flag needs both switches). Absent, counted as on. */
  computerEnabled?: () => boolean;
  /** Whether a host is on in agenticos.json (setup/attach.ts hostsOf). With Codex off nothing is resolved or probed for
   *  its flags (R77: a Claude-only Mac runs no `codex --help`). Absent, counted as on. */
  hostOn?: (host: "claude" | "codex") => boolean;
  /** Whether the app is quitting (R86): no terminal starts then, so none is left running into Electron's teardown (an
   *  agent's exit makes the page start a shell in its terminal). Absent, counted as not. */
  quitting?: () => boolean;
  /** A terminal was closed: `kill(id)` (even after its process exited) or killAll, never the process's own exit (an agent
   *  that exits hands its terminal to the login shell). `terminal` is the key the PTY started with (AOS_TERMINAL), or null.
   *  The Code chat's follower for that terminal stops (code-chat R16). `why` is "closed" for `kill(id)` and "all" for
   *  `killAll()` (the page going: nothing forgets a session then, session-browser S1). `origin` is the id of the terminal's
   *  first process, which is `id` itself for a first process: the key a Code session's browser is named by. */
  onEnd?: (id: string, terminal: string | null, why: "closed" | "all", origin: string) => void;
  now?: () => number;
}

/**
 * How long the app's quit waits for its terminals (R86, `settle`): SIGHUP at once, SIGKILL at KILL_AFTER_MS to whatever
 * has not exited, and at SETTLE_MS the quit goes on whatever is left.
 */
export const SETTLE_MS = 1000;
export const KILL_AFTER_MS = 600;

/** A terminal asked for while the app quits (R86). */
const quittingRefusal: Result<never> = { ok: false, error: "the app is quitting", code: "ECANCELED" };

const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGHUP", "SIGINT"]);

const HOST_LABEL = { claude: "Claude Code", codex: "Codex" } as const;
const VENDOR_NAME = { claude: "Anthropic", codex: "OpenAI" } as const;

/** What TerminalSession sets on every terminal, set by main on an agent's. */
const TERM_VARS: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor", AGENTIC_OS: "1", FORCE_HYPERLINK: "1" };

/** Main cannot vouch for the agent: the page starts a shell and types the launch line, and says why. One line. */
const fallback = (why: string): Result<never> => ({ ok: false, error: why.replace(/\s+/g, " ").slice(0, 400), code: "fallback" });

/** A Codex line whose `--no-daemon` disagrees with main's answer now (R79): the page rebuilds it from `want` and asks once
 *  more. */
const flagsRefusal = (want: boolean, bin: string): PtyAgentResult => ({
  ok: false, code: "flags", error: `this Codex launch ${want ? "needs" : "must go without"} --no-daemon now: the page builds it again`, flags: { noDaemon: want, bin },
});

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
  /** Terminal id → its folder, when it started and the key it carries (AOS_TERMINAL), until it is closed (kill, killAll):
   *  info, for the Code chat's followers (code-chat R10, M6). It outlives the process's own exit, as the follower does. */
  private readonly started = new Map<string, { cwd: string; startedAt: number; terminal: string | null; origin: string }>();
  /** Terminal id → the pid of the agent it runs (spawnAgent), while it is registered. */
  private readonly agents = new Map<string, number>();
  /** Bumped by killAll: an agent still being resolved when its page went is not started. */
  private epoch = 0;
  /** Terminals killAll ended whose exit node-pty has not reported yet (R86: the quit waits for them). */
  private readonly dying = new Set<PtyProcess>();
  /** The settle() calls waiting for `dying` to empty. */
  private readonly settled = new Set<() => void>();

  constructor(private readonly o: PtyServiceOptions) {}

  private loadLib(): PtyLib | null {
    if (this.lib || this.loadError) return this.lib;
    try { this.lib = this.o.load(); } catch (err) { this.loadError = err instanceof Error ? err.message.split("\n")[0] : String(err); }
    return this.lib;
  }

  available(): Result<null> {
    return this.loadLib() ? { ok: true, data: null } : { ok: false, error: `node-pty failed to load: ${this.loadError}`, code: "ENOSYS" };
  }

  /** A terminal's folder, start time (epoch ms) and key, from its start until it is closed; null for one main does not know. */
  info(id: string): { cwd: string; startedAt: number; terminal: string | null } | null {
    const i = this.started.get(id);
    return i ? { cwd: i.cwd, startedAt: i.startedAt, terminal: i.terminal } : null;
  }

  /** Whether a terminal is begun and not yet closed: running, or exited with its row still open in the page (session-browser S1). */
  holds(id: string): boolean { return this.sessions.has(id) || this.started.has(id); }

  /** Whether `id` names a terminal's first process, the only id that keys its browser: true while any held process
   *  has it as its origin, so a takeover shell's own id is false, and the first process's id stays true after it
   *  exited, or was closed alone, while the shell it left behind still runs (session-browser S1). */
  holdsOrigin(id: string): boolean {
    for (const i of this.started.values()) if (i.origin === id) return true;
    return false;
  }

  /** `origin` is the first process of the terminal this one takes over in (the login shell after the agent): taken only
   *  when main began that id in this page, else the process is its own origin (session-browser S1). */
  private begin(id: string, cwd: string, terminal: string | undefined, origin?: string): void {
    const given = origin !== undefined && origin !== id ? this.started.get(origin) : undefined;
    // The root of the chain: a page naming a takeover shell (itself an entry with another origin) gets that shell's origin.
    const root = given ? given.origin : id;
    this.started.set(id, { cwd, startedAt: (this.o.now ?? Date.now)(), terminal: typeof terminal === "string" && UUID_RE.test(terminal) ? terminal : null, origin: root });
  }

  /** The terminal was closed (kill, killAll): its follower stops (code-chat R16). */
  private end(id: string, why: "closed" | "all"): void {
    const i = this.started.get(id);
    const terminal = i?.terminal ?? null;
    const origin = i?.origin ?? id;
    this.started.delete(id);
    try { this.o.onEnd?.(id, terminal, why, origin); } catch { /* a follower's stop never blocks a terminal's close */ }
  }

  spawn(req: PtySpawnRequest): Result<{ pid: number }> {
    const lib = this.loadLib();
    if (!lib) return { ok: false, error: `node-pty failed to load: ${this.loadError}`, code: "ENOSYS" };
    if (this.o.quitting?.()) return quittingRefusal;
    if (this.sessions.has(req.id)) return { ok: false, error: "a terminal with this id is open", code: "EEXIST" };
    if (this.sessions.size >= MAX_TERMINALS) return { ok: false, error: "too many terminals", code: "EAGAIN" };
    const why = shellRefusal(req.file, req.args, this.o.context());
    if (why) return refused(why);
    const folder = folderRefusal(req.cwd);
    if (folder) return folder;
    const env = ptyEnv(this.baseEnv(), req.env, this.o.context());
    if ("refusal" in env) return refused(env.refusal);
    let p: PtyProcess;
    try {
      p = lib.spawn(req.file, [], { name: req.name, cols: req.cols, rows: req.rows, cwd: req.cwd, env: env.env });
    } catch (err) { return failure(err); }
    const { id } = req;
    this.sessions.set(id, p);
    this.begin(id, req.cwd, req.env?.AOS_TERMINAL, req.origin);
    p.onData((data) => this.o.emit({ id, type: "data", data }));
    p.onExit((e) => {
      this.reaped(p);
      // A stale shell (its page went, its id taken again since) neither ends nor speaks for the terminal that has the id
      // now; one killAll ended whose id is free still reports its exit.
      const now = this.sessions.get(id);
      if (now !== undefined && now !== p) return;
      if (now === p) this.sessions.delete(id);
      this.o.emit({ id, type: "exit", exitCode: e.exitCode, ...(e.signal !== undefined ? { signal: e.signal } : {}) });
    });
    return { ok: true, data: { pid: p.pid } };
  }

  /**
   * A Code launch's terminal, running the agent CLI itself (agent-computer D18). With the computer surface off it falls
   * back (`code: "fallback"`) with no reason and checks nothing (C1, R65). Refused (EROFS) for words launchArgs never
   * emits or a folder that is not one: the same folder rule as a shell's, so every Code place works (D30). Falls back
   * when the runtime names no binary, the peer addon is missing, the install form is neither the vendor's signed binary
   * nor its npm package, the login shell gives no environment, the environment would carry a config folder main does not
   * know, or the CLI does not start. Registered as `code:<id>` until it exits or the terminal is closed. A Codex line
   * whose `--no-daemon` disagrees with main's answer now is refused with `code: "flags"` and that answer (R79), asked
   * again right before the spawn (R81), so a switch flipped while the launch was prepared is not missed.
   */
  async spawnAgent(req: PtyAgentRequest): Promise<PtyAgentResult> {
    try { return await this.startAgent(req); }
    catch (err) { return fallback(`the agent did not start: ${err instanceof Error ? err.message : String(err)}`); }
  }

  /**
   * The words a Code launch of `host` adds for main (agent-computer R70): `noDaemon`, a Codex launch starts with
   * `--no-daemon`, so its TUI runs its app server in its own process and the agenticos MCP server stays the CLI's own
   * child, the process D18 admits. True only while Codex is an enabled host and the computer surface and Settings ▸
   * Computer are both on (R77; otherwise nothing is resolved or probed), for the binary the runtime resolves when main
   * vouches for its install form (the probe never runs anything else), and when that binary's help lists the flag.
   * R77: the help runs with the terminal base environment (the login PATH resolveBin searched), as the launch would, so
   * an npm install's `#!/usr/bin/env node` finds its node; `sub: "resume"` reads `codex resume --help` for a resume line,
   * whose flag is that subcommand's; `bin` names the binary probed (null when none was), so the page types the flag on a
   * fallback line only when that line names this binary. The menu's preview shows the argv that runs. This answer is
   * the page's to build the line with; `startAgent` decides again at the spawn (R79).
   */
  async agentFlags(host: "claude" | "codex", sub?: "resume"): Promise<Result<AgentFlags>> {
    const no: Result<AgentFlags> = { ok: true, data: { noDaemon: false, bin: null } };
    const { resolveBin, sys } = this.o;
    if (host !== "codex" || !this.switchesOn() || !resolveBin || !sys) return no;
    try {
      const resolved = await resolveBin(host);
      if ("reason" in resolved) return no;
      if (programRefusal(resolved.bin, this.o.context()) || launchForm(host, resolved.bin, sys, this.o.trusted) === null) return no;
      return { ok: true, data: { noDaemon: await this.noDaemonNow(resolved.bin, sub), bin: resolved.bin } };
    } catch { return no; }
  }

  /** Whether a Codex launch may carry `--no-daemon` at all now (R77): the computer surface, Settings ▸ Computer and the
   *  Codex host on, and a probe wired. Read live at each ask and each spawn (R79). */
  private switchesOn(): boolean {
    return !!this.o.computerOn?.() && this.o.computerEnabled?.() !== false && this.o.hostOn?.("codex") !== false && !!this.o.noDaemon;
  }

  /** Main's answer now for a Codex launch of `bin` (R79): the switches, then the binary's help (cached per binary key), or
   *  `codex resume --help` for a resume line. */
  private async noDaemonNow(bin: string, sub?: "resume"): Promise<boolean> {
    if (!this.switchesOn()) return false;
    try { return await this.o.noDaemon!(bin, this.baseEnv(), sub); } catch { return false; }
  }

  /** The base environment a terminal starts from now (terminalBaseEnv: main's own with the login PATH). */
  private baseEnv(): NodeJS.ProcessEnv { return typeof this.o.env === "function" ? this.o.env() : this.o.env; }

  private slotRefusal(id: string): Result<never> | null {
    if (this.sessions.has(id)) return { ok: false, error: "a terminal with this id is open", code: "EEXIST" };
    if (this.sessions.size >= MAX_TERMINALS) return { ok: false, error: "too many terminals", code: "EAGAIN" };
    return null;
  }

  private async startAgent(req: PtyAgentRequest): Promise<PtyAgentResult> {
    // C1 (R65a): the computer off, a Code launch is the typed line in a shell, as before the computer existed.
    if (!this.o.computerOn?.()) return fallback("");
    const lib = this.loadLib();
    if (!lib) return { ok: false, error: `node-pty failed to load: ${this.loadError}`, code: "ENOSYS" };
    if (this.o.quitting?.()) return quittingRefusal;
    const slot = this.slotRefusal(req.id);
    if (slot) return slot;
    // The words launchArgs builds, `--no-daemon` where it puts it; whether this launch carries it is decided below.
    const words = agentArgvRefusal(req.host, req.argv, { noDaemon: req.host === "codex" });
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
    const sub = req.argv[0] === "resume" ? "resume" : undefined;
    const carries = req.argv.includes("--no-daemon");
    if (req.host === "codex") {
      // R79: main decides `--no-daemon` here, for the binary it runs, with the switches as they are now; a line that
      // disagrees (the page's answer was older) is refused with the answer, so the page rebuilds it and asks once more.
      const want = await this.noDaemonNow(bin, sub);
      if (carries !== want) return flagsRefusal(want, bin);
      const flag = agentArgvRefusal(req.host, req.argv, { noDaemon: want });
      if (flag) return refused(`${label} with ${flag}`);
    }
    const set = { ...TERM_VARS, ...(req.terminal ? { AOS_TERMINAL: req.terminal } : {}), ...(req.configDir ? { [req.host === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: req.configDir } : {}) };
    const base = await this.agentBase(req.cwd, ctx);
    if ("reason" in base) return fallback(base.reason);
    const env = ptyEnv(base.env, set, ctx);
    if ("refusal" in env) return fallback(`the agent's environment would carry ${env.refusal}`);
    if (req.gitInit && !fs.existsSync(path.join(req.cwd, ".git"))) {
      // As the typed `[ -e .git ] || git init -q;` did: a failed init does not stop the agent.
      try { await (this.o.gitInit ?? gitInitIn)(req.cwd, env.env); } catch { /* the agent starts anyway */ }
    }
    // R81 (AC-R3-03): the switches can flip while agentBase() and git init are awaited, so main's answer is asked once
    // more, after them (the probe is cached per binary), and the switches read again with no await before the spawn.
    const now = req.host === "codex" ? await this.noDaemonNow(bin, sub) : false;
    // The awaits above let the page go, or another terminal in.
    if (epoch !== this.epoch) return { ok: false, error: "the page that asked for it is gone", code: "ECANCELED" };
    if (this.o.quitting?.()) return quittingRefusal;
    const again = this.slotRefusal(req.id);
    if (again) return again;
    if (req.host === "codex") {
      const ready = now && this.switchesOn();
      if (ready !== carries) return flagsRefusal(ready, bin);
    }
    let p: PtyProcess;
    try {
      p = lib.spawn(bin, [...req.argv], { name: "xterm-256color", cols: req.cols, rows: req.rows, cwd: req.cwd, env: env.env });
    } catch (err) { return fallback(`${label} did not start (${(err as NodeJS.ErrnoException)?.code ?? "error"})`); }
    const { id } = req;
    const pid = p.pid;
    this.sessions.set(id, p);
    this.agents.set(id, pid);
    this.begin(id, req.cwd, req.terminal);
    registry.add({ pid, host: req.host, page: "code", key: `code:${id}`, label: req.label, place: req.place, access: req.access });
    p.onData((data) => this.o.emit({ id, type: "data", data }));
    p.onExit((e) => {
      this.reaped(p);
      this.forget(id, pid);
      // A stale agent (its page went, its id taken again since) says nothing to the terminal that has the id now.
      if (this.sessions.get(id) !== p) return;
      this.sessions.delete(id);
      this.o.emit({ id, type: "exit", exitCode: e.exitCode, ...(e.signal !== undefined ? { signal: e.signal } : {}) });
    });
    return { ok: true, data: { pid } };
  }

  /**
   * The environment an agent starts from (C1, R65b): what main's $SHELL (the shell a new terminal starts), as a login,
   * interactive shell, gives a command typed into it, so the agent sees the exports of the user's profile and rc files
   * (API keys, proxies, certificates) as the typed launch did, while main still starts it, so its pid is the one the
   * bridge admits. A shell that gives none (a startup file exits, hangs or execs something else) falls back to the
   * typed launch, which runs those files itself. The shell starts from the terminal's base, without the markers of a
   * session that launched the app (R64), so what it gives is the user's own: a CLAUDE_CODE_* an rc file exports reaches
   * the agent as it reaches a typed launch. CLAUDECODE and AOS_TERMINAL never pass.
   */
  private async agentBase(cwd: string, ctx: ProgramContext): Promise<{ env: NodeJS.ProcessEnv } | { reason: string }> {
    const plain = this.baseEnv();
    let env: NodeJS.ProcessEnv | null = plain;
    if (this.o.shellEnv) {
      const shell = ctx.env.SHELL;
      const why = !shell ? "$SHELL is not set" : shellRefusal(shell, [], ctx);
      if (why) return { reason: `the login shell's environment could not be read: ${why}` };
      env = await this.o.shellEnv(shell as string, cwd, { ...plain, ...TERM_VARS });
      if (!env) return { reason: `${shell} gave no environment: a startup file failed, waited, or started something else` };
    }
    // A copy with its own PATH kept and CLAUDECODE and AOS_TERMINAL dropped; the rest is the base's or the rc files'.
    const out: NodeJS.ProcessEnv = { ...env };
    delete out.CLAUDECODE;
    delete out.AOS_TERMINAL;
    return { env: out };
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

  /** The page closes a terminal (its pty:kill). Its Code chat follower stops too, even when the process exited already. */
  kill(id: string, signal?: string): void {
    const p = this.sessions.get(id);
    if (p) {
      try { p.kill(signal && SIGNALS.has(signal) ? signal : undefined); } catch { /* gone */ }
      // A closed terminal's agent is forgotten at once, not when its exit arrives (agent-computer D18).
      const pid = this.agents.get(id);
      if (pid !== undefined) this.forget(id, pid);
    }
    const origin = this.started.get(id)?.origin ?? id;
    this.end(id, "closed");
    // Closing a takeover shell closes its terminal's first process too, so the terminal's key is not held any more
    // (session-browser S1); the origin's own end reports the same terminal key, and forgetting twice does nothing.
    if (origin !== id && (this.started.has(origin) || this.sessions.has(origin))) this.kill(origin, signal);
  }

  /** Every terminal ends with the page that opened it, and on quit. Each stays in `dying` until node-pty reports its
   *  exit. */
  killAll(): void {
    for (const p of this.sessions.values()) {
      this.dying.add(p);
      try { p.kill(); } catch { /* gone */ }
    }
    for (const id of new Set([...this.sessions.keys(), ...this.started.keys()])) this.end(id, "all");
    this.sessions.clear();
    this.epoch++;
    for (const [id, pid] of [...this.agents]) this.forget(id, pid);
  }

  get open(): number { return this.sessions.size; }

  /** Whether a terminal runs, or one was ended and node-pty has not reported its exit yet (R86). */
  get busy(): boolean { return this.sessions.size > 0 || this.dying.size > 0; }

  /**
   * The app's quit (R86): ends every terminal and resolves once node-pty has reported each one's exit, those killAll
   * ended earlier included. node-pty reports an exit from a thread of its own through the event loop: one that lands
   * while Electron tears Node down calls into an environment that can no longer run JavaScript, and the app aborts
   * (SIGABRT). So the quit goes on only after this. SIGHUP first, SIGKILL at `killAfterMs` to whatever still runs (a
   * shell that traps or ignores its hangup), and at `capMs` it resolves whatever is left, forgetting it, so a stuck
   * child never keeps the app from quitting. Every call waits for the same exits.
   */
  settle(capMs = SETTLE_MS, killAfterMs = KILL_AFTER_MS): Promise<void> {
    this.killAll();
    if (!this.dying.size) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const hard = setTimeout(() => {
        for (const p of this.dying) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
      }, killAfterMs);
      const cap = setTimeout(() => { this.dying.clear(); this.wake(); }, capMs);
      const done = (): void => { clearTimeout(hard); clearTimeout(cap); this.settled.delete(done); resolve(); };
      this.settled.add(done);
    });
  }

  /** node-pty reported `p`'s exit. */
  private reaped(p: PtyProcess): void {
    if (this.dying.delete(p)) this.wake();
  }

  /** Resolves the waiting settle() calls once no ended terminal's exit is still to come. */
  private wake(): void {
    if (this.dying.size) return;
    for (const done of [...this.settled]) done();
  }
}
