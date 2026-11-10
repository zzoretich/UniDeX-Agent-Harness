// The Code chat view's transcript mirror, in main (spec 2026-11-09-code-chat, R2, R4, R10, R13–R18). One follower per agent
// terminal (its key, AOS_TERMINAL): `node <vault>/brain/scripts/lib/sessions.js mirror …`, which writes the conversation as
// events into <vault>/brain/_index/code/<terminal>.jsonl for the page to read, and a one-shot run for a past conversation
// the person opens. Nothing runs while the Code chat surface is off. The page names a pty, a host, a session id and a
// terminal key, never a path or an argument, and the key must be the one that pty started with (M6). Every argv is
// checked against the surface's spawn rules (shared/surfaces.ts) before it runs, and the cache goes back as a
// vault-relative path. A follower lives as long as its terminal (R16), not its PTY: an agent that exits hands the terminal
// to the login shell, a new PTY with the same key, and the follower goes on. It stops when the terminal is closed (end,
// from PtyService's kill and killAll), at unfollow and at stopAll (the app's quit), by SIGTERM. A follower that fails
// says so once in main's log.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeCache, CodeFollow, CodeFollowRequest, CodeViewRequest, Result } from "../../shared/ipc";
import { SURFACES } from "../../shared/surfaces";
import { programRefusal, spawnEnv, UUID_RE, type ProgramContext } from "../policy/programs";
import { refused } from "./fs";

/** How long a one-shot mirror may take before it is killed. */
export const VIEW_TIMEOUT_MS = 15_000;
/** A follower that ignores SIGTERM is killed after this long. */
const KILL_AFTER_MS = 3000;
const STDERR_TAIL = 2000;

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const validId = (id: unknown): id is string => typeof id === "string" && SESSION_ID.test(id) && !id.includes("..") && !id.startsWith("-");

const RULES = SURFACES.find((s) => s.id === "code")?.spawns.filter((r) => r.script === "lib/sessions.js") ?? [];
/** The `code` surface's spawn rules (shared/surfaces.ts): main runs no mirror command the table does not list. */
export const mirrorAllowed = (args: readonly string[]): boolean =>
  RULES.some((r) => (typeof r.args === "function" ? r.args(args) : r.args.test(args.join(" "))));

export interface CodeMirrorOptions {
  vaultRoot: () => string | null;
  /** Whether the Code chat surface is on. */
  enabled: () => boolean;
  context: () => ProgramContext;
  /** Main's own environment, the base of every child's. */
  env: NodeJS.ProcessEnv;
  /** The user's node, for the runtime's scripts. */
  node: () => string | null;
  /** A terminal's folder, start time and key (PtyService.info). */
  ptyInfo: (pty: string) => { cwd: string; startedAt: number; terminal: string | null } | null;
  spawnImpl?: typeof childProcess.spawn;
  viewTimeoutMs?: number;
  killAfterMs?: number;
}

interface Follower { pty: string; terminal: string; host: "claude" | "codex"; id: string | null; cache: string; child: childProcess.ChildProcess }

const fail = (error: string, code: string): Result<never> => ({ ok: false, error, code });
const OLD_RUNTIME = "the runtime is older than this app: run aos upgrade";
const alive = (c: childProcess.ChildProcess): boolean => c.exitCode === null && c.signalCode === null;
/** Why a run of the runtime ended with `code`: a usage exit is a runtime older than the mirror verb (M1). */
const exitWhy = (code: number | null, stderr: string): string => {
  if (code === 2 && /\busage:/.test(stderr)) return OLD_RUNTIME;
  const said = stderr.trim().split("\n").pop();
  return `the runtime stopped (exit ${code})${said ? `: ${said}` : ""}`;
};

export class CodeMirrorService {
  /** By terminal key. */
  private readonly followers = new Map<string, Follower>();
  private readonly views = new Set<childProcess.ChildProcess>();

  constructor(private readonly o: CodeMirrorOptions) {}

  private refusal(): string | null {
    if (!this.o.enabled()) return "the Code chat surface is off";
    if (!this.o.vaultRoot()) return "no vault is open";
    return null;
  }

  private spawn(args: readonly string[]): { child: childProcess.ChildProcess } | { refusal: string } {
    if (!mirrorAllowed(args)) return { refusal: "that mirror command is not allowed" };
    const vault = this.o.vaultRoot();
    if (!vault) return { refusal: "no vault is open" };
    const node = this.o.node();
    if (!node) return { refusal: "no node: run aos doctor" };
    const ctx = this.o.context();
    const bad = programRefusal(node, ctx);
    if (bad) return { refusal: `node: ${bad}` };
    const lib = path.join(vault, "brain", "scripts", "lib");
    const script = path.join(lib, "sessions.js");
    // M1: the mirror verb came with lib/code-mirror.js; a runtime without it would only print its usage.
    if (!fs.existsSync(path.join(lib, "code-mirror.js")) || !fs.existsSync(script)) return { refusal: "this vault's runtime has no chat view yet: run aos upgrade" };
    const env = spawnEnv(this.o.env, { AOS_VAULT: vault, AOS_HOST: "" }, [], ctx);
    if ("refusal" in env) return { refusal: env.refusal };
    try {
      return { child: (this.o.spawnImpl ?? childProcess.spawn)(node, [script, ...args], { cwd: vault, env: env.env, shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true }) };
    } catch (err) { return { refusal: (err as NodeJS.ErrnoException).code ?? "the runtime did not start" }; }
  }

  /** SIGTERM, then SIGKILL if it is still there after a while (the timer never keeps the app alive). */
  private stopChild(child: childProcess.ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    }, this.o.killAfterMs ?? KILL_AFTER_MS);
    t.unref?.();
    child.once("exit", () => clearTimeout(t));
  }

  /**
   * Follows `pty`'s conversation into brain/_index/code/<terminal>.jsonl. With an `id` Claude's follower names that session
   * (`--id`); Codex's names it and keeps the terminal's folder (`--id`, `--cwd`, `--since`: R18). Without one it names the
   * folder and start time (`--cwd`, `--since`, R10). Idempotent per pty, terminal, host and id (R2): the running follower's
   * cache with `fresh: false`. Anything else for the terminal replaces its follower, `fresh: true` (R16b). The key must be
   * the one the pty started with (M6).
   */
  follow(req: CodeFollowRequest): Result<CodeFollow> {
    const why = this.refusal();
    if (why) { console.warn(`[main] code:follow: ${why}`); return refused(why); }
    if (req.host !== "claude" && req.host !== "codex") return fail("a host", "EINVAL");
    if (typeof req.terminal !== "string" || !UUID_RE.test(req.terminal)) return fail("a terminal key", "EINVAL");
    if (req.id != null && !validId(req.id)) return fail("a session id", "EINVAL");
    const id = req.id ?? null;
    const running = this.followers.get(req.terminal);
    if (running && running.pty === req.pty && running.host === req.host && running.id === id && alive(running.child)) {
      return { ok: true, data: { cache: running.cache, fresh: false } };
    }
    const info = this.o.ptyInfo(req.pty);
    if (!info) return fail("no such terminal", "ENOENT");
    if (info.terminal !== req.terminal) return fail("that terminal key is not this terminal's", "EINVAL");
    const replaced = [...this.followers.values()].some((f) => f.terminal === req.terminal || f.pty === req.pty);
    this.stop((f) => f.terminal === req.terminal || f.pty === req.pty);
    // The page tails the new cache from 0: the replaced follower's lines must not be there to read (its own cleanup never
    // removes a file another follower wrote since).
    const vault = this.o.vaultRoot();
    if (replaced && vault) { try { fs.unlinkSync(path.join(vault, "brain", "_index", "code", `${req.terminal}.jsonl`)); } catch { /* none yet */ } }
    const since = String(Math.max(0, Math.floor(info.startedAt)));
    const args = id === null
      ? ["mirror", "--host", req.host, "--cwd", info.cwd, "--since", since, "--terminal", req.terminal, "--follow"]
      : req.host === "codex"
        ? ["mirror", "--host", req.host, "--id", id, "--cwd", info.cwd, "--since", since, "--terminal", req.terminal, "--follow"]
        : ["mirror", "--host", req.host, "--id", id, "--terminal", req.terminal, "--follow"];
    const s = this.spawn(args);
    if ("refusal" in s) return fail(s.refusal, "EIO");
    const cache = `brain/_index/code/${req.terminal}.jsonl`;
    const f: Follower = { pty: req.pty, terminal: req.terminal, host: req.host, id, cache, child: s.child };
    this.followers.set(req.terminal, f);
    let stderr = "";
    let warned = false;
    // F10: a follower that fails says so once (a SIGTERM's exit has no code, and says nothing).
    const warn = (what: string): void => { if (!warned) { warned = true; console.warn(`[main] code:follow: the follower for ${req.terminal}: ${what}`); } };
    const gone = (): void => { if (this.followers.get(req.terminal) === f) this.followers.delete(req.terminal); };
    s.child.on("exit", gone);
    s.child.on("error", (err) => { gone(); warn(`it did not start (${(err as NodeJS.ErrnoException).code ?? err.message})`); });
    s.child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-STDERR_TAIL); });
    s.child.on("close", (code: number | null) => { if (code !== null && code !== 0) warn(exitWhy(code, stderr)); });
    return { ok: true, data: { cache, fresh: true } };
  }

  /** SIGTERMs the followers `which` picks. */
  private stop(which: (f: Follower) => boolean): void {
    for (const [key, f] of [...this.followers]) {
      if (!which(f)) continue;
      this.followers.delete(key);
      this.stopChild(f.child);
    }
  }

  /** Stops the follower of the terminal `pty` belongs to: started for it, or for another PTY with its key (the agent the
   *  login shell took over from). Nothing when none runs. */
  unfollow(pty: string): void {
    const key = this.o.ptyInfo(pty)?.terminal ?? null;
    this.stop((f) => f.pty === pty || (key !== null && f.terminal === key));
  }

  /** The terminal `pty` was closed (PtyService's onEnd: kill, killAll); `terminal` is its key. */
  end(pty: string, terminal: string | null): void {
    this.stop((f) => f.pty === pty || (terminal !== null && f.terminal === terminal));
  }

  /** Mirrors a past conversation once and answers with its cache, or why it could not (exit not 0, or over the timeout). */
  async view(req: CodeViewRequest): Promise<Result<CodeCache>> {
    const why = this.refusal();
    if (why) { console.warn(`[main] code:view: ${why}`); return refused(why); }
    if (req.host !== "claude" && req.host !== "codex") return fail("a host", "EINVAL");
    if (!validId(req.id)) return fail("a session id", "EINVAL");
    const s = this.spawn(["mirror", "--host", req.host, "--id", req.id, "--once"]);
    if ("refusal" in s) return fail(s.refusal, "EIO");
    const { child } = s;
    this.views.add(child);
    return new Promise<Result<CodeCache>>((resolve) => {
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, this.o.viewTimeoutMs ?? VIEW_TIMEOUT_MS);
      const done = (r: Result<CodeCache>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.views.delete(child);
        resolve(r);
      };
      child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-STDERR_TAIL); });
      child.on("error", (err) => done(fail((err as NodeJS.ErrnoException).code ?? err.message, "EIO")));
      child.on("close", (code) => {
        if (timedOut) return done(fail("the conversation took too long to load", "ETIMEDOUT"));
        if (code === 0) return done({ ok: true, data: { cache: `brain/_index/code/${req.host}-${req.id}.jsonl` } });
        if (code === 2 && /\busage:/.test(stderr)) return done(fail(OLD_RUNTIME, "EIO"));
        done(fail(stderr.trim().split("\n").pop() || `the runtime stopped (exit ${code})`, "EIO"));
      });
    });
  }

  /** On quit: every follower and every one-shot run is stopped. */
  stopAll(): void {
    this.stop(() => true);
    for (const c of [...this.views]) this.stopChild(c);
    this.views.clear();
  }

  get running(): number { return this.followers.size; }
}
