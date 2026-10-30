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
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (info: { exitCode: number; signal?: number }) => void): void;
}

export interface HostPty {
  /** Starts a terminal; throws when terminals are unavailable or this one is refused. */
  spawn(file: string, args: string[], opts: HostPtyOptions): HostPtyProcess;
  /** Why terminals are unavailable (loading node-pty failed), or null when they are. Loads it on first call. */
  loadError(): string | null;
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

export type HostSessionHost = "claude" | "codex";

/** What a turn may do (spec 2026-10-07-sessions-ux U7). */
export type HostSessionAccess = "read" | "edit" | "run";

/** One event of a thread: prompt (with its model, effort and access), session, text, tool, tool_result, patch, plan,
 *  usage, error or done, and its turn. */
export interface HostSessionEvent {
  t: string;
  kind: "prompt" | "session" | "text" | "tool" | "tool_result" | "patch" | "plan" | "usage" | "error" | "done";
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

export interface HostGit {
  status(workspace: string): Promise<HostResult<HostGitStatus>>;
  diff(workspace: string, file?: string): Promise<HostResult<{ stat: string; text: string; truncated: boolean }>>;
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

export const pty: HostPty = {
  spawn: (file, args, opts) => hudHost().pty.spawn(file, args, opts),
  loadError: () => hudHost().pty.loadError(),
};

export const shell: HostShell = {
  openPath: (p) => hudHost().shell.openPath(p),
  openExternal: (url) => hudHost().shell.openExternal(url),
  showItemInFolder: (p) => hudHost().shell.showItemInFolder(p),
};

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
