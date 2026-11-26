// What Code needs of the host CLIs, in main (remove-sessions D11; these lived in the Sessions service until it went):
//   - `resolveBin` names the binary a Code launch runs (`sessions.js bin <host>`, on a Code terminal's PATH, agent-computer D18);
//   - `catalog` asks the runtime for each host's models and commands (`sessions.js catalog`, which never calls a model),
//     for Code's composer and Routines;
//   - `postComputerNotice` sends the Computer pane's off-screen asks to the Notifications tab through the runtime's
//     notify.js (agent-computer D27), behind the Computer surface (D26).
// None of these runs a turn or writes a thread, and none is behind a surface of its own: Code needs them whichever
// surfaces are on. Every command is `node <vault>/brain/scripts/<script>`, never through a shell.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HostCatalog, Result, SessionHost } from "../../shared/ipc";
import { programRefusal, spawnEnv, type ProgramContext } from "../policy/programs";
import { SURFACES } from "../../shared/surfaces";
import { refused } from "./fs";

const RUNTIME_OUT_MAX = 1024 * 1024;
const STDERR_TAIL = 2000;

/** A workspace's folder name: one segment, not hidden (`.git`) and not the team worktrees (`_worktrees`). */
export const WORKSPACE_RE = /^[^._/\\\0][^/\\\0]{0,127}$/;

export interface HostServiceOptions {
  vaultRoot: () => string | null;
  context: () => ProgramContext;
  /** Main's own environment, the base of every child's. */
  env: NodeJS.ProcessEnv;
  /** The user's node, for the runtime's scripts: agenticos.json's `node`, else the login shell's. */
  node: () => string | null;
  spawnImpl?: typeof childProcess.spawn;
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

/** How long a computer notice waits for the runtime before it gives up (it kills it then). */
const NOTICE_TIMEOUT_MS = 15_000;
/** The `computer` surface's rule for its notice (shared/surfaces.ts): main runs no notify.js command the table does not
 *  list, so a title that could read as a flag, or that notify.js would refuse, never reaches it. */
const NOTICE_RULE = SURFACES.find((x) => x.id === "computer")?.spawns.find((r) => r.script === "notify.js")?.args;
const noticeAllowed = (args: readonly string[]): boolean =>
  typeof NOTICE_RULE === "function" ? NOTICE_RULE(args) : NOTICE_RULE ? NOTICE_RULE.test(args.join(" ")) : false;

export class HostService {
  private catalogRun: Promise<Result<HostCatalog>> | null = null;

  constructor(private readonly o: HostServiceOptions) {}

  /** Each host's models and commands, from the runtime (its cache, or the hosts again with `refresh`); one at a time. */
  catalog(refresh = false): Promise<Result<HostCatalog>> {
    if (!this.o.vaultRoot()) return Promise.resolve(refused("no vault is open"));
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
   * The binary a Code launch runs (`sessions.js bin <host>`), resolved on a Code terminal's PATH, or why there is none:
   * the runtime cannot run (no vault, no node), is older than the verb, found no binary, or did not answer within
   * binTimeoutMs (then it is killed).
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
   * agent-computer D27: one Notifications item for an ask raised off-screen, `notify.js post --from computer --level
   * info --title <title> --body-file -` with the body on stdin. Level info: the app shows its own desktop notification,
   * so the runtime raises none. Behind the Computer surface (D26). Rejects with the runtime's last line, a title it would
   * refuse, no vault, or the surface off.
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
    if (!fs.existsSync(script)) return { refusal: rel === "notify.js" ? "this vault's runtime has no notifications yet: run aos upgrade" : "this vault's runtime is too old for this app: run aos upgrade" };
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
}
