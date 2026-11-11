// host.ts — the HudHost seam (docs/design/plans/2026-10-05-sandbox-renderer.md S1). Everything the HUD does
// outside its own DOM goes through one HudHost: read or write a file, start a process or a terminal, hand a path or a
// link to the OS, read the environment, and (in the app only) run an agent session in a workspace and read or commit
// its repository. Under node:test that is the Node host (nodeHost.ts); in the AgenticOS
// Workbench app it is the sandboxed page's bridge to the main process, which checks every call.
//
// Modules import `fs`, `spawn`, `execFileSync`, `pty`, `shell` and `env` from here. Their names and signatures follow
// Node's, so a call site reads as it did; only the types are narrower (the subset the HUD uses). nodeHost.ts is the one
// HUD file that may import Node's I/O modules, node-pty or electron (host.test.ts fails on any other).
import { createNodeHost } from "./nodeHost";

export interface HostStats {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface HostDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The filesystem calls the HUD makes. Paths are absolute. Errors are thrown as Node's are (`code` ENOENT, EROFS …). */
export interface HostFs {
  existsSync(p: string): boolean;
  statSync(p: string): HostStats;
  readFileSync(p: string, encoding: "utf8"): string;
  readdirSync(p: string): string[];
  readdirSync(p: string, opts: { withFileTypes: true }): HostDirent[];
  /** Up to `length` bytes of a file from byte `position`: fewer at its end, none past it. */
  readBytesSync(p: string, position: number, length: number): Uint8Array;
  writeFileSync(p: string, data: string): void;
  appendFileSync(p: string, data: string): void;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  /** Calls `listener` when the file at `p` may have changed; `close()` stops it. */
  watch(p: string, listener: () => void): { close(): void };
  promises: {
    readFile(p: string, encoding: "utf8"): Promise<string>;
    readdir(p: string, opts: { withFileTypes: true }): Promise<HostDirent[]>;
    stat(p: string): Promise<HostStats>;
    access(p: string): Promise<void>;
  };
}

export interface HostSpawnOptions {
  cwd?: string;
  /** Variables set on top of the host's own environment (never a whole environment: the host keeps its own). */
  env?: Record<string, string>;
  /** Variables removed from it. */
  unsetEnv?: string[];
  /** "pipe" (the default) streams stdout and stderr as text; "ignore" drops them. */
  stdio?: "pipe" | "ignore";
  detached?: boolean;
}

export interface HostReadable {
  on(event: "data", listener: (chunk: string) => void): unknown;
}

/** A started process: the part of Node's ChildProcess the HUD uses. Output arrives as UTF-8 text. */
export interface HostChild {
  readonly pid?: number;
  readonly stdout: HostReadable | null;
  readonly stderr: HostReadable | null;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit" | "close", listener: (code: number | null, signal: string | null) => void): this;
  kill(signal?: string): boolean;
  unref(): void;
}

export type SpawnFn = (command: string, args: string[], opts?: HostSpawnOptions) => HostChild;

export interface HostPtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  /** Variables set on top of the host's own environment. */
  env?: Record<string, string>;
}

/** One terminal: node-pty's IPty, as far as the HUD uses it. */
export interface HostPtyProcess {
  readonly pid: number;
  /** The app's id for this terminal, which names a Code launch's agent to the computer as `code:<id>` (agent-computer
   *  D35); absent outside the app. */
  readonly id?: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (info: { exitCode: number; signal?: number }) => void): void;
}

/**
 * A Code launch's agent, run by the app's main process as the terminal's own process so it knows the CLI's pid
 * (agent-computer D18). Mirrors app/src/shared/ipc.ts PtyAgentRequest without the id, which the bridge assigns. `place`
 * is the computer the agent shares (terminalLaunch.placeKey, D30); `label` names it.
 */
export interface HostPtyAgentRequest {
  host: "claude" | "codex";
  /** The words after the binary (terminalLaunch.launchArgs); main resolves the binary itself. */
  argv: string[];
  cwd: string;
  /** CLAUDE_CONFIG_DIR or CODEX_HOME for the agent, or null for the one a new terminal would find. */
  configDir: string | null;
  gitInit: boolean;
  cols: number;
  rows: number;
  place: string;
  label: string;
  access: "host" | "read" | "edit" | "run";
  /** The terminal's key, set as AOS_TERMINAL in the agent's environment (code-chat R15). */
  terminal?: string;
}

export interface HostPty {
  /** Starts a terminal; throws when terminals are unavailable or this one is refused. */
  spawn(file: string, args: string[], opts: HostPtyOptions): HostPtyProcess;
  /** Why terminals are unavailable (loading node-pty failed), or null when they are. Loads it on first call. */
  loadError(): string | null;
  /** Starts a Code launch's agent as the terminal's own process (the app only). `code: "fallback"`: start the shell and
   *  type the launch line instead, `error` says why; any other failure is a refusal. */
  spawnAgent?(req: HostPtyAgentRequest): Promise<HostPtyAgentResult>;
  /** The words main adds to a Code launch of `host` (the app only; agent-computer R70): `noDaemon`, a Codex launch
   *  carries `--no-daemon`. `sub: "resume"`: for a resume line, whose flag is `codex resume`'s; `bin`: the binary main
   *  probed, which a typed fallback must name to carry the flag (R77). Rejects when the bridge fails on the way: the
   *  page then has no answer, never a no (R79). */
  agentFlags?(host: "claude" | "codex", sub?: "resume"): Promise<HostAgentFlags>;
}

export interface HostShell {
  /** Opens a file or folder with the OS's default app: "" when it did, else why not (Electron's contract). */
  openPath(p: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(p: string): void;
}

export interface HostEnv {
  /** A variable of the host's environment (the HUD reads CLAUDE_CONFIG_DIR, AOS_CONFIG, AOS_VAULT, CODEX_HOME, SHELL). */
  get(name: string): string | undefined;
  homedir(): string;
  platform(): string;
  /** The working directory (the vault, in a host that has none of its own). */
  cwd(): string;
}

// ── agent sessions in a workspace (spec 2026-10-07-unidex-sessions) ──
// The app's main process runs them; these types mirror app/src/shared/ipc.ts (the HUD imports nothing from the app),
// and the app's typecheck holds the two together where bridgeHost.ts hands its bridge over.

/** A call's answer: the data, or why not (`code` EROFS when a policy or a switch refused it). Never thrown. */
export type HostResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string };
/** What main says a Codex launch's line carries (agent-computer R70, R77): `noDaemon`, and the binary it probed. */
export interface HostAgentFlags { noDaemon: boolean; bin?: string | null }
/** spawnAgent's answer. `code: "flags"` (R79): the line's `--no-daemon` disagrees with main's answer now, which `flags`
 *  carries; the page rebuilds the line from it and asks once more. */
export type HostPtyAgentResult = HostResult<HostPtyProcess> | { ok: false; error: string; code: "flags"; flags: { noDaemon: boolean; bin: string | null } };

export type HostSessionHost = "claude" | "codex";

/** What a turn may do (spec 2026-10-07-sessions-ux U7). */
export type HostSessionAccess = "read" | "edit" | "run";

/** One event of a thread: prompt (with its model, effort and access), session, text, tool, tool_result, patch, plan,
 *  usage, error or done, and its turn. `computer` (with `text`) is a Computer pane line, sent live and never stored
 *  (agent-computer D35). */
export interface HostSessionEvent {
  t: string;
  kind: "prompt" | "session" | "text" | "tool" | "tool_result" | "patch" | "plan" | "usage" | "error" | "done" | "computer";
  turn: number;
  [field: string]: unknown;
}

export interface HostSessionThread {
  id: string;
  workspace: string;
  host: HostSessionHost;
  /** The latest turn's choices; the next turn reuses them unless it names others. */
  model: string | null;
  effort: string | null;
  access: HostSessionAccess;
  title: string;
  created: string;
  updated: string;
  turns: number;
  running: boolean;
  usd: number;
}

/** One host's models and the commands a prompt may start with (the runtime's lib/host-catalog.js). */
export interface HostCatalogHost {
  ok: boolean;
  off?: boolean;
  reason?: string;
  version: string | null;
  fetchedAt: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  models: { id: string; name: string; description: string; efforts: string[]; main: boolean }[];
  commands: { name: string; insert: string; description: string; hint: string | null }[];
}

export interface HostCatalog { schema: 1; fetchedAt: string; hosts: Partial<Record<HostSessionHost, HostCatalogHost>> }

// ── the Computer pane (agent-computer D5, D32); mirrors app/src/shared/ipc.ts ComputerState and the calls of
// AosBridge.computer, plain shapes the app's typecheck holds together ──

export interface HostComputerRect { x: number; y: number; width: number; height: number }
export interface HostComputerTab { index: number; url: string; title: string; openedBy: string | null; active: boolean; canBack: boolean; canForward: boolean }
export type HostComputerNavGo = "back" | "forward" | "reload";
export type HostComputerHolder =
  | { kind: "agent"; session: string; label: string }
  | { kind: "user"; resume: { session: string; label: string } | null }
  | null;
export interface HostComputerAsk {
  id: string; at: number; computer: string; session: string; sessionLabel: string; why: string;
  title: string; detail: string; site: string | null; always?: boolean;
}
export interface HostComputerLogLine { at: number; session: string; text: string }
export type HostComputerAnswer = "once" | "always" | "deny";
export interface HostComputerState {
  place: string; tabs: HostComputerTab[]; holder: HostComputerHolder; asks: readonly HostComputerAsk[];
  log: readonly HostComputerLogLine[]; marked: boolean; poppedOut: boolean;
}
export type HostComputerEvent = { type: "state"; state: HostComputerState } | { type: "reveal"; askId: string };

/** The pane's calls. A place is `ws:<workspace>`, `vault`, `home` or `dir:<absolute path>`. */
export interface HostComputer {
  /** Whether the Computer surface is on for this run of the app (agent-computer D26; it cannot change while the app
   *  runs). Off, or absent (fail closed; the app always sets it): the pane is only its collapsed strip, whatever its page
   *  shows (ruling R54), and the tour's Computer steps are skipped. */
  readonly enabled?: boolean;
  /** The start page a tab the person opens starts on, whose search the address bar uses for words (data/computerStart.ts):
   *  main's, fixed at boot, which is the e2e suite's fixture in its runs. Absent: START_PAGE, DuckDuckGo. */
  readonly startPage?: string;
  /** Null when the Computer surface is off or the place is refused. */
  select(place: string | null): Promise<HostComputerState | null>;
  show(bounds: HostComputerRect | null): void;
  navigate(url: string): Promise<HostResult<null>>;
  tab(op: { kind: "new" } | { kind: "close" | "select"; index: number }): void;
  /** The person's Back, Forward or Reload on the active tab (session-browser S13). */
  nav(go: HostComputerNavGo): void;
  takeOver(): void;
  handBack(): void;
  answer(askId: string, a: HostComputerAnswer): void;
  mark(origin: string, on: boolean): void;
  popOut(): void;
  onEvent(cb: (ev: HostComputerEvent) => void): () => void;
}

/** The Code chat view's transcript mirror, its Diff pane's git and its composer's images (app/src/shared/ipc.ts
 *  AosBridge.code); only the app has it. `cache` is a vault-relative path (code-chat R14). */
export interface HostCode {
  /** Whether the Code chat surface is on for this run of the app (fixed at boot, as the Computer's is). Off, or absent
   *  (fail closed), no terminal carries AOS_TERMINAL, so the status line writes no per-terminal copy (code-chat F9). */
  readonly enabled?: boolean;
  /** Follows an agent terminal's conversation; again with the same pty, terminal, host and id returns the running
   *  follower's cache with `fresh: false`. `fresh: true`: a new follower writes its cache from the start (R16b). */
  follow(req: { pty: string; host: "claude" | "codex"; terminal: string; id?: string | null }): Promise<HostResult<{ cache: string; fresh: boolean }>>;
  /** Stops the follower of the terminal `pty` belongs to. */
  unfollow(pty: string): void;
  /** Mirrors a past conversation once. */
  view(req: { host: "claude" | "codex"; id: string }): Promise<HostResult<{ cache: string }>>;
  /** The Diff pane's read-only git (code-chat C8) for the terminal `pty`: main picks the folder from that terminal's cwd (a
   *  vault workspace or a workspace's linked code folder) and refuses any other place. Needs no write surface. */
  git?(req: { pty: string; op: "status" | "diff"; file?: string }): Promise<HostResult<HostGitStatus | HostGitDiff>>;
  /** The composer's image (code-chat C7): main checks its type (PNG, JPEG, GIF or WebP), its size (10 MB at most) and its
   *  content, saves it into the app's own data folder and answers with the absolute path it chose; the page never names
   *  one. Refused (EROFS) while the Code chat surface is off. */
  saveImage?(req: { mime: string; data: string }): Promise<HostResult<{ path: string }>>;
}

export interface HostSessions {
  /** Opens a thread in a workspace and starts its first turn; events follow on onEvent. */
  start(req: { workspace: string; host: HostSessionHost; text: string; model?: string | null; effort?: string | null; access?: HostSessionAccess; allowCommands?: boolean }): Promise<HostResult<HostSessionThread>>;
  /** The thread's next turn; a field left out reuses the thread's last. */
  send(req: { thread: string; text: string; model?: string | null; effort?: string | null; access?: HostSessionAccess; allowCommands?: boolean }): Promise<HostResult<HostSessionThread>>;
  stop(thread: string): void;
  list(): Promise<HostResult<HostSessionThread[]>>;
  read(thread: string): Promise<HostResult<HostSessionEvent[]>>;
  /** Each host's models and commands; `refresh` asks the hosts again. */
  catalog(refresh?: boolean): Promise<HostResult<HostCatalog>>;
  onEvent(cb: (ev: { thread: string; event: HostSessionEvent }) => void): () => void;
}

/** A workspace's repository: its branch and the files that differ from HEAD (`git status --porcelain=v2` codes). */
export interface HostGitStatus {
  repo: boolean;
  branch: string | null;
  detached: boolean;
  merging: boolean;
  /** Lines added and removed against HEAD (null for a binary file). */
  files: { path: string; status: string; added: number | null; removed: number | null }[];
}

export interface HostGitDiff { stat: string; text: string; truncated: boolean }

export interface HostGit {
  status(workspace: string): Promise<HostResult<HostGitStatus>>;
  diff(workspace: string, file?: string): Promise<HostResult<HostGitDiff>>;
  commit(workspace: string, message: string): Promise<HostResult<{ commit: string }>>;
}

export interface HostProposalPreview {
  name: string; slug: string; digest: string; token: string; recheck: string | null; legacy?: boolean;
  changes: { path: string; op: string; base: string | null; after: string | null; before: string | null; content: string | null }[];
}
export interface HostProposalUndo { undoId: string; slug: string; at: string; changes: string[] }
export interface HostProposals {
  preview(name: string): Promise<HostResult<HostProposalPreview>>;
  apply(name: string, digest: string, token: string): Promise<HostResult<unknown>>;
  reject(name: string, digest: string, token: string): Promise<HostResult<unknown>>;
  undos(): Promise<HostResult<HostProposalUndo[]>>;
  undo(undoId: string): Promise<HostResult<unknown>>;
}

export interface HudHost {
  fs: HostFs;
  spawn: SpawnFn;
  execFileSync(file: string, args: string[], opts: { encoding: "utf8"; timeout: number }): string;
  pty: HostPty;
  shell: HostShell;
  env: HostEnv;
  /** Agent sessions and their repositories: only the app has them (its main runs the turns); undefined elsewhere. */
  sessions?: HostSessions;
  /** The Computer pane's calls: only the app has them; undefined elsewhere. */
  computer?: HostComputer;
  /** The Code chat view's transcript mirror: only the app has it; undefined elsewhere. */
  code?: HostCode;
  git?: HostGit;
  proposals?: HostProposals;
}

let current: HudHost | null = null;

/** Installs the host every HUD module uses from now on. The app calls this before it loads the plugin. */
export function setHudHost(host: HudHost): void { current = host; }

/** The installed host; the Node host when none was installed (node:test). */
export function hudHost(): HudHost {
  current ??= createNodeHost();
  return current;
}

// ── Node-shaped views of the current host, so `fs.readFileSync(…)` and `spawn(…)` read as they always did ──

export const fs: HostFs = {
  existsSync: (p) => hudHost().fs.existsSync(p),
  statSync: (p) => hudHost().fs.statSync(p),
  readFileSync: (p, encoding) => hudHost().fs.readFileSync(p, encoding),
  readdirSync: ((p: string, opts?: { withFileTypes: true }) =>
    (opts ? hudHost().fs.readdirSync(p, opts) : hudHost().fs.readdirSync(p))) as HostFs["readdirSync"],
  readBytesSync: (p, position, length) => hudHost().fs.readBytesSync(p, position, length),
  writeFileSync: (p, data) => hudHost().fs.writeFileSync(p, data),
  appendFileSync: (p, data) => hudHost().fs.appendFileSync(p, data),
  mkdirSync: (p, opts) => hudHost().fs.mkdirSync(p, opts),
  watch: (p, listener) => hudHost().fs.watch(p, listener),
  promises: {
    readFile: (p, encoding) => hudHost().fs.promises.readFile(p, encoding),
    readdir: (p, opts) => hudHost().fs.promises.readdir(p, opts),
    stat: (p) => hudHost().fs.promises.stat(p),
    access: (p) => hudHost().fs.promises.access(p),
  },
};

export const spawn: SpawnFn = (command, args, opts) => hudHost().spawn(command, args, opts);

export function execFileSync(file: string, args: string[], opts: { encoding: "utf8"; timeout: number }): string {
  return hudHost().execFileSync(file, args, opts);
}

/** What a host without agent terminals answers (plain Node): fall back, with nothing to say about a computer. */
const NO_AGENT_SPAWN: HostResult<never> = { ok: false, error: "", code: "fallback" };

export const pty: Required<HostPty> = {
  spawn: (file, args, opts) => hudHost().pty.spawn(file, args, opts),
  loadError: () => hudHost().pty.loadError(),
  spawnAgent: (req) => {
    const p = hudHost().pty;
    return p.spawnAgent ? p.spawnAgent(req) : Promise.resolve(NO_AGENT_SPAWN);
  },
  // A host without agent terminals adds nothing to a launch line.
  agentFlags: (host, sub) => {
    const p = hudHost().pty;
    return p.agentFlags ? p.agentFlags(host, sub) : Promise.resolve({ noDaemon: false });
  },
};

export const shell: HostShell = {
  openPath: (p) => hudHost().shell.openPath(p),
  openExternal: (url) => hudHost().shell.openExternal(url),
  showItemInFolder: (p) => hudHost().shell.showItemInFolder(p),
};

/** Whether the installed host runs the Code chat's followers now (its surface is on): only then does a terminal carry
 *  AOS_TERMINAL (code-chat F9). */
export function codeChatOn(): boolean { return hudHost().code?.enabled === true; }

/** The installed host's sessions and git, or null when it has none (plain Node). */
export function sessionsHost(): { sessions: HostSessions; git: HostGit } | null {
  const h = hudHost();
  return h.sessions && h.git ? { sessions: h.sessions, git: h.git } : null;
}

export const env: HostEnv = {
  get: (name) => hudHost().env.get(name),
  homedir: () => hudHost().env.homedir(),
  platform: () => hudHost().env.platform(),
  cwd: () => hudHost().env.cwd(),
};

/** UTF-8 bytes → text, and the byte length of a text, without Node's Buffer (the app's page has none). */
const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();
export function utf8(bytes: Uint8Array): string { return decoder.decode(bytes); }
export function utf8Bytes(text: string): Uint8Array { return encoder.encode(text); }
