// The Code chat view's transcript mirror, in main (spec 2026-11-09-code-chat, R2, R4, R10, R13–R15). One follower per agent
// terminal: `node <vault>/brain/scripts/lib/sessions.js mirror …`, which writes the conversation as events into
// <vault>/brain/_index/code/<terminal>.jsonl for the page to read, and a one-shot run for a past conversation the person
// opens. Nothing runs while the Code chat surface is off. The page names a pty, a host, a session id and a terminal key;
// never a path or an argument. Every argv is checked against the surface's spawn rules (shared/surfaces.ts) before it
// runs, and the cache goes back as a vault-relative path. A follower dies with its terminal (onEnd), at unfollow and at
// stopAll (the app's quit), by SIGTERM.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeCache, CodeFollowRequest, CodeViewRequest, Result } from "../../shared/ipc";
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
  /** A running terminal's folder and start time (PtyService.info). */
  ptyInfo: (pty: string) => { cwd: string; startedAt: number } | null;
  spawnImpl?: typeof childProcess.spawn;
  viewTimeoutMs?: number;
  killAfterMs?: number;
}

interface Follower { terminal: string; cache: string; child: childProcess.ChildProcess }

const fail = (error: string, code: string): Result<never> => ({ ok: false, error, code });

export class CodeMirrorService {
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
    const script = path.join(vault, "brain", "scripts", "lib", "sessions.js");
    if (!fs.existsSync(script)) return { refusal: "this vault's runtime has no chat view yet: run aos upgrade" };
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
   * Follows `pty`'s conversation into brain/_index/code/<terminal>.jsonl. With an `id` the follower names that session
   * (`--id`); without one it names the terminal's folder and start time (`--cwd`, `--since`, R10). Idempotent per pty and
   * terminal (R2): a second call returns the running follower's cache. Another terminal key for the same pty replaces it.
   */
  follow(req: CodeFollowRequest): Result<CodeCache> {
    const why = this.refusal();
    if (why) { console.warn(`[main] code:follow: ${why}`); return refused(why); }
    if (req.host !== "claude" && req.host !== "codex") return fail("a host", "EINVAL");
    if (typeof req.terminal !== "string" || !UUID_RE.test(req.terminal)) return fail("a terminal key", "EINVAL");
    if (req.id != null && !validId(req.id)) return fail("a session id", "EINVAL");
    const running = this.followers.get(req.pty);
    if (running && running.terminal === req.terminal && running.child.exitCode === null && running.child.signalCode === null) return { ok: true, data: { cache: running.cache } };
    const info = this.o.ptyInfo(req.pty);
    if (!info) return fail("no such terminal", "ENOENT");
    this.unfollow(req.pty);
    const args = req.id != null
      ? ["mirror", "--host", req.host, "--id", req.id, "--terminal", req.terminal, "--follow"]
      : ["mirror", "--host", req.host, "--cwd", info.cwd, "--since", String(Math.max(0, Math.floor(info.startedAt))), "--terminal", req.terminal, "--follow"];
    const s = this.spawn(args);
    if ("refusal" in s) return fail(s.refusal, "EIO");
    const cache = `brain/_index/code/${req.terminal}.jsonl`;
    const f: Follower = { terminal: req.terminal, cache, child: s.child };
    this.followers.set(req.pty, f);
    const gone = (): void => { if (this.followers.get(req.pty) === f) this.followers.delete(req.pty); };
    s.child.on("exit", gone);
    s.child.on("error", gone);
    s.child.stderr?.on("data", () => { /* drained; the follower reports its state in its cache */ });
    return { ok: true, data: { cache } };
  }

  /** Stops the pty's follower (SIGTERM); nothing when none runs. */
  unfollow(pty: string): void {
    const f = this.followers.get(pty);
    if (!f) return;
    this.followers.delete(pty);
    this.stopChild(f.child);
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
        done(fail(stderr.trim().split("\n").pop() || `the runtime stopped (exit ${code})`, "EIO"));
      });
    });
  }

  /** On quit: every follower and every one-shot run is stopped. */
  stopAll(): void {
    for (const pty of [...this.followers.keys()]) this.unfollow(pty);
    for (const c of [...this.views]) this.stopChild(c);
    this.views.clear();
  }

  get running(): number { return this.followers.size; }
}
