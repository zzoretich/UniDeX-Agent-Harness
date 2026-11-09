// Agent sessions, in main (UniDeX phase 2, spec 2026-10-07-unidex-sessions S1–S3, S8, S11). A turn is three processes,
// none through a shell:
//   1. the runtime's lib/sessions.js `args` plans it: the host is on and has a binary, today's session spend is under
//      sessions.perDayUsd, and the host CLI's argv and environment (the runtime owns every host flag);
//   2. the host's CLI runs it with <vault>/workspaces/<name> as its folder;
//   3. `sessions.js events` turns the CLI's stdout into the runtime's event shape, which main appends to the thread's
//      file (brain/_index/sessions/<workspace>/<thread>.jsonl) and sends to the page.
// When the turn ends, `sessions.js record` ledgers its spend and writes its row in agent-runs/runs.jsonl. Nothing runs
// while the Sessions surface is off. The page names a workspace, a host and a prompt, and each turn's model, effort and
// access (spec 2026-10-07-sessions-ux U6, U7); never a program, an argument or a path. `catalog` asks the runtime for
// each host's models and commands (`sessions.js catalog`, U3), which never calls a model. `onAgent` tells main which
// CLI each turn runs while it runs (agent-computer D18), and `resolveBin` names the binary a Code launch runs. The
// Computer pane's lines reach a Chat thread live (`noteEvent`, never stored), and its ask notices go to the Notifications
// tab through the runtime's notify.js (`postComputerNotice`, agent-computer D27).

import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { HostCatalog, Result, SessionAccess, SessionEvent, SessionEventRecord, SessionHost, SessionSendRequest, SessionStartRequest, SessionThread } from "../../shared/ipc";
import { programRefusal, spawnEnv, type ProgramContext } from "../policy/programs";
import { SURFACES } from "../../shared/surfaces";
import { refused } from "./fs";
import type { WorkspaceDir } from "./git";

/** How many turns may run at once, across every thread. */
export const MAX_RUNNING = 4;
/** Stop: SIGTERM, then SIGKILL after this long (team seats do the same, lib/team-run.js). */
export const GRACE_MS = 10_000;
const THREAD_MAX_BYTES = 8 * 1024 * 1024;
const RUNTIME_OUT_MAX = 1024 * 1024;
const STDERR_TAIL = 2000;

/** A workspace's folder name: one segment, not hidden (`.git`) and not the team worktrees (`_worktrees`). */
export const WORKSPACE_RE = /^[^._/\\\0][^/\\\0]{0,127}$/;

const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

export function workspaceDir(vault: string | null, name: string): WorkspaceDir {
  if (!vault) return { refusal: "no vault is open" };
  if (typeof name !== "string" || !WORKSPACE_RE.test(name)) return { refusal: "a workspace name" };
  const dir = path.join(vault, "workspaces", name);
  let stat: fs.Stats;
  try { stat = fs.statSync(dir); } catch {
    // Spaces' Archive moves the folder to workspaces/_archive/<name> and leaves its threads in brain/_index/sessions/<name>/,
    // listed and read-only until Restore (spaces-redesign D17).
    return { refusal: isDir(path.join(vault, "workspaces", "_archive", name)) ? `${name} is archived: restore it in Spaces to continue` : "no such workspace" };
  }
  if (!stat.isDirectory()) return { refusal: "not a workspace folder" };
  return { dir };
}

export interface SessionServiceOptions {
  vaultRoot: () => string | null;
  /** Whether the Sessions surface is on. */
  enabled: () => boolean;
  context: () => ProgramContext;
  /** Main's own environment, the base of every child's. */
  env: NodeJS.ProcessEnv;
  /** The user's node, for the runtime's scripts: agenticos.json's `node`, else the login shell's. */
  node: () => string | null;
  emit: (ev: SessionEvent) => void;
  spawnImpl?: typeof childProcess.spawn;
  now?: () => Date;
  graceMs?: number;
  /** agent-computer D18: a turn's CLI started (its pid, right after the spawn) and exited, for the agent registry. */
  onAgent?: (ev: AgentEvent) => void;
  /** The PATH a Code terminal starts with (pty.ts terminalBaseEnv), which `resolveBin` searches: the CLI the typed
   *  launch line would find is the one main runs. */
  terminalPATH?: () => string | null;
  /** How long `resolveBin` waits for the runtime before it gives up (BIN_TIMEOUT_MS; the tests pass a short one). */
  binTimeoutMs?: number;
  /** Whether the Computer surface is on (agent-computer D26): its notices run only then. Off when absent. */
  computerOn?: () => boolean;
}

/** A Code launch's binary, or why the runtime named none (one line, for the launch note). */
export type BinResolution = { bin: string } | { reason: string };

/** How long a Code launch waits for the runtime to name its binary: the terminal is starting meanwhile. */
export const BIN_TIMEOUT_MS = 10_000;

const HOST_LABEL: Record<SessionHost, string> = { claude: "Claude Code", codex: "Codex" };

export type AgentEvent =
  | { kind: "start"; pid: number; thread: string; workspace: string; host: SessionHost; access: SessionAccess; title: string }
  | { kind: "end"; pid: number; thread: string };

interface Meta { schema: 1; kind: "meta"; thread: string; workspace: string; host: SessionHost; model: string | null; effort: string | null; access?: SessionAccess; title: string; created: string }

/** What one turn runs with (U6, U7); each `prompt` record keeps its own. */
interface TurnOptions { model: string | null; effort: string | null; access: SessionAccess }

const ACCESS: readonly SessionAccess[] = ["read", "edit", "run"];

/** The options of the thread's latest turn: its last prompt that recorded them, else the thread's first (older files). */
function lastOptions(meta: Meta, lines: Array<Record<string, unknown>>): TurnOptions {
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = lines[i];
    if (r.kind === "prompt" && typeof r.access === "string" && ACCESS.includes(r.access as SessionAccess)) {
      return { model: typeof r.model === "string" ? r.model : null, effort: typeof r.effort === "string" ? r.effort : null, access: r.access as SessionAccess };
    }
  }
  return { model: meta.model, effort: meta.effort, access: meta.access ?? "edit" };
}

/** A request's level: `access`, else the older `allowCommands` flag, else `fallback`. */
const accessOf = (req: { access?: SessionAccess; allowCommands?: boolean }, fallback: SessionAccess): SessionAccess =>
  req.access ?? (req.allowCommands === true ? "run" : req.allowCommands === false ? "edit" : fallback);

/** `end`: tells onAgent the turn's CLI ended (once; a later call does nothing). Stop calls it at once (R76). */
interface Running { agent: childProcess.ChildProcess | null; stopped: boolean; timer: NodeJS.Timeout | null; turn?: number; end?: () => void }

type Event = Omit<SessionEventRecord, "turn">;

/** How long a computer notice waits for the runtime before it gives up (it kills it then). */
const NOTICE_TIMEOUT_MS = 15_000;
/** The `computer` surface's rule for its notice (shared/surfaces.ts): main runs no notify.js command the table does not
 *  list, so a title that could read as a flag, or that notify.js would refuse, never reaches it. */
const NOTICE_RULE = SURFACES.find((x) => x.id === "computer")?.spawns.find((r) => r.script === "notify.js")?.args;
const noticeAllowed = (args: readonly string[]): boolean =>
  typeof NOTICE_RULE === "function" ? NOTICE_RULE(args) : NOTICE_RULE ? NOTICE_RULE.test(args.join(" ")) : false;

const titleOf = (text: string): string => {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/** The thread's records (the meta line first); a damaged line is skipped. */
function readLines(file: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    if (size > THREAD_MAX_BYTES) {
      // Very long threads: the meta line and the newest records.
      const fd = fs.openSync(file, "r");
      try {
        const head = Buffer.alloc(Math.min(size, 64 * 1024));
        fs.readSync(fd, head, 0, head.length, 0);
        const tail = Buffer.alloc(THREAD_MAX_BYTES);
        fs.readSync(fd, tail, 0, tail.length, size - tail.length);
        const t = tail.toString("utf8");
        text = `${head.toString("utf8").split("\n")[0]}\n${t.slice(t.indexOf("\n") + 1)}`;
      } finally { fs.closeSync(fd); }
    } else text = fs.readFileSync(file, "utf8");
  } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as unknown; if (r && typeof r === "object") out.push(r as Record<string, unknown>); } catch { /* skipped */ }
  }
  return out;
}

function metaOf(lines: Array<Record<string, unknown>>): Meta | null {
  const m = lines[0];
  return m && m.kind === "meta" && typeof m.thread === "string" && (m.host === "claude" || m.host === "codex") && typeof m.workspace === "string" ? (m as unknown as Meta) : null;
}

export class SessionService {
  private readonly running = new Map<string, Running>();
  /** thread id → its file, as threads are opened or listed. */
  private readonly files = new Map<string, string>();

  constructor(private readonly o: SessionServiceOptions) {}

  private now(): Date { return this.o.now ? this.o.now() : new Date(); }

  private refusal(): string | null {
    if (!this.o.enabled()) return "the Sessions surface is off";
    if (!this.o.vaultRoot()) return "no vault is open";
    return null;
  }

  private sessionsDir(vault: string): string { return path.join(vault, "brain", "_index", "sessions"); }

  private find(thread: string): string | null {
    const known = this.files.get(thread);
    if (known && fs.existsSync(known)) return known;
    const vault = this.o.vaultRoot();
    if (!vault) return null;
    const root = this.sessionsDir(vault);
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root); } catch { return null; }
    for (const d of dirs) {
      const f = path.join(root, d, `${thread}.jsonl`);
      if (fs.existsSync(f)) { this.files.set(thread, f); return f; }
    }
    return null;
  }

  private threadOf(meta: Meta, lines: Array<Record<string, unknown>>, file: string): SessionThread {
    let turns = 0;
    let usd = 0;
    for (const r of lines) {
      if (r.kind === "prompt") turns += 1;
      if (r.kind === "done" && typeof r.usd === "number" && Number.isFinite(r.usd)) usd += r.usd;
    }
    let updated = meta.created;
    try { updated = fs.statSync(file).mtime.toISOString(); } catch { /* as created */ }
    const last = lastOptions(meta, lines);
    return {
      id: meta.thread, workspace: meta.workspace, host: meta.host, model: last.model, effort: last.effort, access: last.access, title: meta.title,
      created: meta.created, updated, turns, running: this.running.has(meta.thread), usd: Math.round(usd * 1e6) / 1e6,
    };
  }

  async start(req: SessionStartRequest): Promise<Result<SessionThread>> {
    const why = this.refusal();
    if (why) return refused(why);
    const vault = this.o.vaultRoot() as string;
    const w = workspaceDir(vault, req.workspace);
    if ("refusal" in w) return refused(w.refusal);
    if (!req.text.trim()) return refused("a turn needs a prompt");
    if (this.running.size >= MAX_RUNNING) return { ok: false, error: "too many sessions are running", code: "EAGAIN" };
    const opts: TurnOptions = { model: req.model || null, effort: req.effort || null, access: accessOf(req, "edit") };
    const meta: Meta = {
      schema: 1, kind: "meta", thread: randomUUID(), workspace: req.workspace, host: req.host, model: opts.model,
      effort: opts.effort, access: opts.access, title: titleOf(req.text), created: this.now().toISOString(),
    };
    const file = path.join(this.sessionsDir(vault), req.workspace, `${meta.thread}.jsonl`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(meta)}\n`, { flag: "wx" });
    } catch (err) { return { ok: false, error: (err as NodeJS.ErrnoException).code ?? "failed", code: "EIO" }; }
    this.files.set(meta.thread, file);
    this.running.set(meta.thread, { agent: null, stopped: false, timer: null });
    void this.turn(meta, file, w.dir, req.text, opts);
    return { ok: true, data: this.threadOf(meta, readLines(file), file) };
  }

  async send(req: SessionSendRequest): Promise<Result<SessionThread>> {
    const why = this.refusal();
    if (why) return refused(why);
    const file = this.find(req.thread);
    if (!file) return { ok: false, error: "no such thread", code: "ENOENT" };
    const lines = readLines(file);
    const meta = metaOf(lines);
    if (!meta) return { ok: false, error: "the thread's file is damaged", code: "EIO" };
    if (this.running.has(meta.thread)) return { ok: false, error: "a turn is running", code: "EBUSY" };
    if (this.running.size >= MAX_RUNNING) return { ok: false, error: "too many sessions are running", code: "EAGAIN" };
    if (!req.text.trim()) return refused("a turn needs a prompt");
    const w = workspaceDir(this.o.vaultRoot(), meta.workspace);
    if ("refusal" in w) return refused(w.refusal);
    const last = lastOptions(meta, lines);
    const opts: TurnOptions = {
      model: req.model === undefined ? last.model : req.model || null,
      effort: req.effort === undefined ? last.effort : req.effort || null,
      access: accessOf(req, last.access),
    };
    this.running.set(meta.thread, { agent: null, stopped: false, timer: null });
    void this.turn(meta, file, w.dir, req.text, opts);
    return { ok: true, data: this.threadOf(meta, lines, file) };
  }

  stop(thread: string): void {
    const r = this.running.get(thread);
    if (!r || r.stopped) return;
    r.stopped = true;
    // R76 (S-AC-02): the turn ends on the computer now, by the path its exit takes (its asks cancelled, its wheel freed),
    // not after the CLI's SIGTERM grace; the exit later finds it done.
    r.end?.();
    if (r.agent) {
      try { r.agent.kill("SIGTERM"); } catch { /* gone */ }
      const agent = r.agent;
      r.timer = setTimeout(() => { try { agent.kill("SIGKILL"); } catch { /* gone */ } }, this.o.graceMs ?? GRACE_MS);
    }
  }

  async list(): Promise<Result<SessionThread[]>> {
    const why = this.refusal();
    if (why) return refused(why);
    const root = this.sessionsDir(this.o.vaultRoot() as string);
    const out: SessionThread[] = [];
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root); } catch { return { ok: true, data: [] }; }
    for (const d of dirs) {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(root, d)).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
      for (const n of names) {
        const file = path.join(root, d, n);
        const lines = readLines(file);
        const meta = metaOf(lines);
        if (!meta) continue;
        this.files.set(meta.thread, file);
        out.push(this.threadOf(meta, lines, file));
      }
    }
    out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
    return { ok: true, data: out };
  }

  async read(thread: string): Promise<Result<SessionEventRecord[]>> {
    const why = this.refusal();
    if (why) return refused(why);
    const file = this.find(thread);
    if (!file) return { ok: false, error: "no such thread", code: "ENOENT" };
    return { ok: true, data: readLines(file).filter((r) => r.kind !== "meta") as unknown as SessionEventRecord[] };
  }

  private catalogRun: Promise<Result<HostCatalog>> | null = null;

  /** Each host's models and commands, from the runtime (its cache, or the hosts again with `refresh`); one at a time. */
  catalog(refresh = false): Promise<Result<HostCatalog>> {
    const why = this.refusal();
    if (why) return Promise.resolve(refused(why));
    if (this.catalogRun) return this.catalogRun;
    const run = (async (): Promise<Result<HostCatalog>> => {
      const r = await this.runtime(["catalog", ...(refresh ? ["--refresh"] : [])]);
      let cat: HostCatalog | null = null;
      try { cat = JSON.parse(r.stdout.trim().split("\n").pop() || "null") as HostCatalog; } catch { cat = null; }
      if (r.code !== 0 || !cat || cat.schema !== 1 || !cat.hosts || typeof cat.hosts !== "object") {
        return { ok: false, error: r.stderr.trim().split("\n").pop() || "the runtime listed no models", code: "EIO" };
      }
      return { ok: true, data: cat };
    })();
    this.catalogRun = run;
    void run.finally(() => { if (this.catalogRun === run) this.catalogRun = null; });
    return run;
  }

  /**
   * The binary a Code launch runs (`sessions.js bin <host>`), resolved as a turn's is but on a Code terminal's PATH, or
   * why there is none: the runtime cannot run (no vault, no node), is older than the verb, found no binary, or did not
   * answer within binTimeoutMs (then it is killed). Not behind the Sessions surface: Code needs none.
   */
  async resolveBin(host: SessionHost): Promise<BinResolution> {
    const PATH = this.o.terminalPATH?.();
    const r = await this.runtime(["bin", host], PATH ? { ...this.o.env, PATH } : this.o.env, this.o.binTimeoutMs ?? BIN_TIMEOUT_MS);
    if (r.timedOut) return { reason: "the runtime didn't answer" };
    let out: { ok?: unknown; bin?: unknown } | null = null;
    try { out = JSON.parse(r.stdout.trim().split("\n").pop() || "null") as { ok?: unknown; bin?: unknown } | null; } catch { out = null; }
    if (r.code === 0 && out?.ok === true && typeof out.bin === "string" && path.isAbsolute(out.bin)) return { bin: out.bin };
    if (r.code === 3 && out?.ok === false) return { reason: `the runtime found no ${HOST_LABEL[host]} binary: run aos doctor` };
    // A runtime without the verb prints its usage and exits 2.
    if (r.code === 2 && /\busage:/.test(r.stderr)) return { reason: "the runtime is older than this app: run aos upgrade" };
    const said = r.stderr.trim().split("\n").pop();
    return { reason: r.code === -1 && said ? said : `the runtime named no ${HOST_LABEL[host]} binary (${said || `exit ${r.code}`})` };
  }

  /**
   * agent-computer D35: a Computer pane line for a Chat thread's timeline (an ask, its answer, a page's own navigation),
   * sent to the page as a live `computer` event of the thread's current (or last) turn. Never written to the thread's
   * file: the pane's activity log keeps it. Nothing for a thread main does not know.
   */
  noteEvent(thread: string, text: string): void {
    let turn = this.running.get(thread)?.turn;
    if (turn === undefined) {
      const file = this.find(thread);
      if (!file) return;
      turn = readLines(file).filter((r) => r.kind === "prompt").length;
    }
    this.o.emit({ thread, event: { t: this.now().toISOString(), kind: "computer", turn, text } });
  }

  /**
   * agent-computer D27: one Notifications item for an ask raised off-screen, `notify.js post --from computer --level
   * info --title <title> --body-file -` with the body on stdin. Level info: the app shows its own desktop notification,
   * so the runtime raises none. Behind the Computer surface (D26), not the Sessions one. Rejects with the runtime's last
   * line, a title it would refuse, no vault, or the surface off.
   */
  postComputerNotice(title: string, body: string): Promise<void> {
    if (!this.o.computerOn?.()) return Promise.reject(new Error("the Computer surface is off"));
    const args = ["post", "--from", "computer", "--level", "info", "--title", title, "--body-file", "-"];
    if (!noticeAllowed(args)) return Promise.reject(new Error("a notice title must be one line of 1–160 characters, not starting with a dash"));
    const s = this.runtimeSpawn(args, ["pipe", "ignore", "pipe"], this.o.env, "notify.js");
    if ("refusal" in s) return Promise.reject(new Error(s.refusal));
    const { child } = s;
    return new Promise<void>((resolve, reject) => {
      let stderr = "";
      let settled = false;
      const done = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        done(new Error("the runtime didn't answer"));
      }, NOTICE_TIMEOUT_MS);
      child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-STDERR_TAIL); });
      child.on("error", (err) => done(new Error((err as NodeJS.ErrnoException).code ?? err.message)));
      child.on("close", (code) => done(code === 0 ? null : new Error(stderr.trim().split("\n").pop() || `notify.js exited ${code ?? "on a signal"}`)));
      child.stdin?.on("error", () => { /* it went first: its exit says why */ });
      child.stdin?.end(body);
    });
  }

  private agentEvent(ev: AgentEvent): void {
    try { this.o.onAgent?.(ev); } catch (err) { console.error("[main] onAgent failed", err); }
  }

  /** On quit: every running turn is stopped (its file says so the next time it is read). */
  killAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  get runningCount(): number { return this.running.size; }

  /** `node <vault>/brain/scripts/<script> <args>` from the vault (lib/sessions.js unless named), or why it cannot run. */
  private runtimeSpawn(args: readonly string[], stdio: childProcess.StdioOptions, base: NodeJS.ProcessEnv = this.o.env, rel: "lib/sessions.js" | "notify.js" = "lib/sessions.js"): { child: childProcess.ChildProcess } | { refusal: string } {
    const vault = this.o.vaultRoot();
    if (!vault) return { refusal: "no vault is open" };
    const node = this.o.node();
    if (!node) return { refusal: "no node: run aos doctor" };
    const ctx = this.o.context();
    const bad = programRefusal(node, ctx);
    if (bad) return { refusal: `node: ${bad}` };
    const script = path.join(vault, "brain", "scripts", ...rel.split("/"));
    if (!fs.existsSync(script)) return { refusal: rel === "notify.js" ? "this vault's runtime has no notifications yet: run aos upgrade" : "this vault's runtime has no sessions yet: run aos upgrade" };
    const env = spawnEnv(base, { AOS_VAULT: vault, AOS_HOST: "" }, [], ctx);
    if ("refusal" in env) return { refusal: env.refusal };
    try {
      return { child: (this.o.spawnImpl ?? childProcess.spawn)(node, [script, ...args], { cwd: vault, env: env.env, shell: false, stdio, windowsHide: true }) };
    } catch (err) { return { refusal: (err as NodeJS.ErrnoException).code ?? "the runtime did not start" }; }
  }

  /** One short runtime command's output; with `timeoutMs`, a command still running then is killed and `timedOut`. */
  private runtime(args: readonly string[], base?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
    const s = this.runtimeSpawn(args, ["ignore", "pipe", "pipe"], base);
    if ("refusal" in s) return Promise.resolve({ code: -1, stdout: "", stderr: s.refusal });
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timer: NodeJS.Timeout | null = null;
      const done = (r: { code: number; stdout: string; stderr: string; timedOut?: boolean }): void => {
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(r);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timer = null;
          try { s.child.kill("SIGKILL"); } catch { /* gone */ }
          resolve({ code: -1, stdout, stderr, timedOut: true });
        }, timeoutMs);
      }
      s.child.stdout?.on("data", (b: Buffer) => { if (stdout.length < RUNTIME_OUT_MAX) stdout += b.toString("utf8"); });
      s.child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-STDERR_TAIL); });
      s.child.on("error", (err) => done({ code: -1, stdout, stderr: (err as NodeJS.ErrnoException).code ?? err.message }));
      s.child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
    });
  }

  private async turn(meta: Meta, file: string, dir: string, text: string, opts: TurnOptions): Promise<void> {
    const before = readLines(file);
    const n = before.filter((r) => r.kind === "prompt").length + 1;
    const resume = [...before].reverse().find((r) => r.kind === "session" && typeof r.id === "string")?.id as string | undefined;
    const startedAt = this.now();
    const append = (e: Event): void => {
      const rec = { ...e, turn: n } as SessionEventRecord;
      try { fs.appendFileSync(file, `${JSON.stringify(rec)}\n`); } catch { /* the page still sees it */ }
      this.o.emit({ thread: meta.thread, event: rec });
    };
    const iso = (): string => this.now().toISOString();
    let usd: number | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCount = 0;
    let reply = "";
    let failure: string | null = null;
    const state: Running = this.running.get(meta.thread) ?? { agent: null, stopped: false, timer: null };
    state.turn = n;
    this.running.set(meta.thread, state);
    append({ t: iso(), kind: "prompt", text, model: opts.model, effort: opts.effort, access: opts.access });
    try {
      const req: Record<string, unknown> = { host: meta.host, prompt: text, model: opts.model, effort: opts.effort, access: opts.access };
      if (resume) req.resume = resume;
      else if (meta.host === "claude") req.sessionId = meta.thread;
      const planned = await this.runtime(["args", JSON.stringify(req)]);
      let plan: { ok?: boolean; reason?: string; bin?: string; argv?: string[]; env?: { set?: Record<string, string>; unset?: string[] } } | null = null;
      try { plan = JSON.parse(planned.stdout.trim().split("\n").pop() || "null"); } catch { plan = null; }
      if (!plan || !plan.ok || typeof plan.bin !== "string" || !Array.isArray(plan.argv)) {
        failure = plan?.reason || planned.stderr.trim().split("\n").pop() || "the runtime did not plan the turn";
        append({ t: iso(), kind: "error", message: failure });
        append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" });
        return;
      }
      if (state.stopped) { failure = "stopped"; append({ t: iso(), kind: "error", message: "stopped" }); append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" }); return; }
      const ctx = this.o.context();
      const bad = programRefusal(plan.bin, ctx);
      const env = spawnEnv(this.o.env, plan.env?.set, plan.env?.unset, ctx);
      if (bad || "refusal" in env) {
        failure = bad ? `${meta.host}: ${bad}` : `the environment: ${(env as { refusal: string }).refusal}`;
        append({ t: iso(), kind: "error", message: failure });
        append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" });
        return;
      }
      const filter = this.runtimeSpawn(["events", "--host", meta.host, ...(opts.model ? ["--model", opts.model] : [])], ["pipe", "pipe", "pipe"]);
      if ("refusal" in filter) {
        failure = filter.refusal;
        append({ t: iso(), kind: "error", message: failure });
        append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" });
        return;
      }
      let agent: childProcess.ChildProcess;
      try {
        agent = (this.o.spawnImpl ?? childProcess.spawn)(plan.bin, plan.argv, { cwd: dir, env: env.env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (err) {
        try { filter.child.kill("SIGTERM"); } catch { /* gone */ }
        failure = `${meta.host} did not start (${(err as NodeJS.ErrnoException).code ?? "error"})`;
        append({ t: iso(), kind: "error", message: failure });
        append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" });
        return;
      }
      state.agent = agent;
      const pid = agent.pid;
      if (typeof pid === "number") {
        this.agentEvent({ kind: "start", pid, thread: meta.thread, workspace: meta.workspace, host: meta.host, access: opts.access, title: meta.title });
        let ended = false;
        const end = (): void => { if (!ended) { ended = true; this.agentEvent({ kind: "end", pid, thread: meta.thread }); } };
        state.end = end;
        agent.once("exit", end);
        agent.once("close", end);
      }
      let stderrTail = "";
      agent.stderr?.on("data", (b: Buffer) => { stderrTail = (stderrTail + b.toString("utf8")).slice(-STDERR_TAIL); });
      if (agent.stdout && filter.child.stdin) agent.stdout.pipe(filter.child.stdin);
      filter.child.stdin?.on("error", () => { /* the filter went first */ });
      let pendingDone: Event | null = null;
      const decoder = new StringDecoder("utf8");
      let rest = "";
      const onLine = (line: string): void => {
        if (!line.trim()) return;
        let e: Event;
        try { e = JSON.parse(line) as Event; } catch { return; }
        if (!e || typeof e !== "object" || typeof e.kind !== "string") return;
        if (e.kind === "done") { pendingDone = e; return; }
        if (e.kind === "usage") { inputTokens = Number(e.in) || 0; outputTokens = Number(e.out) || 0; if (typeof e.usd === "number") usd = e.usd; }
        if (e.kind === "tool") toolCount += 1;
        if (e.kind === "text" && typeof e.text === "string") reply = e.text;
        append(e);
      };
      filter.child.stdout?.on("data", (b: Buffer) => {
        const lines = (rest + decoder.write(b)).split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) onLine(l);
      });
      const closed = (c: childProcess.ChildProcess): Promise<number | null> => new Promise((resolve) => {
        c.on("error", () => resolve(-1));
        c.on("close", (code) => resolve(code));
      });
      const [agentCode] = await Promise.all([closed(agent), closed(filter.child)]);
      onLine(rest + decoder.end());
      if (state.timer) clearTimeout(state.timer);
      const done = pendingDone as Event | null;
      if (state.stopped) { failure = "stopped"; append({ t: iso(), kind: "error", message: "stopped" }); }
      else if ((!done || done.ok !== true) && agentCode !== 0 && stderrTail.trim()) {
        failure = stderrTail.trim().split("\n").slice(-3).join(" ").slice(0, 500);
        append({ t: iso(), kind: "error", message: failure });
      }
      if (done && typeof done.usd === "number") usd = done.usd;
      append(state.stopped ? { ...(done ?? { t: iso(), kind: "done", estimated: meta.host === "codex" }), ok: false, usd } : (done ?? { t: iso(), kind: "done", ok: false, usd, estimated: meta.host === "codex" }));
      if (!state.stopped && !(done && done.ok === true) && !failure) failure = "the turn failed";
    } finally {
      // The turn's spend and its run row land before the thread reads as idle.
      const status = state.stopped ? "stopped" : failure ? "error" : "ok";
      await this.runtime(["record", JSON.stringify({
        host: meta.host, model: opts.model, usd, inputTokens, outputTokens, ms: this.now().getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(), status, prompt: text, reply, toolCount, error: status === "ok" ? null : failure,
        workspace: meta.workspace, thread: meta.thread,
      })]);
      this.running.delete(meta.thread);
    }
  }
}
