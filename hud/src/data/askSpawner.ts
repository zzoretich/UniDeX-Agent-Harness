// askSpawner.ts — local spawner for brain/scripts/sdk/ask.js --local (the provider path; see below).
//
// Replaces the legacy POST /api/ask round-trip. Captures the run id by
// scraping the first stderr chunk (telemetry.js writes `[telemetry] run_id=<id>`)
// so subscribers can filter the plugin.bus stream by this run.
//
// Concurrency: hard-capped to 2 in-flight calls — matches serve.js's ASK_MAX.
// Timeout: 90s default (longer than serve.js's 60s; SDK + tool calls add up).

import { spawn, type HostChild, type SpawnFn } from "../host";

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_CONCURRENT = 2;

let inflight = 0;

export interface AskResult {
  ok: boolean;
  runId: string | null;     // null only if telemetry stderr line never arrived
  answer: string;           // trimmed stdout
  stderr: string;           // captured stderr (minus the run_id line)
  elapsedMs: number;
  exitCode: number | null;
  error?: string;
  usd?: number;             // claude provider only: total_cost_usd of the headless call
}

export interface AskHandle {
  /** Resolves with the captured run id once stderr produces it (or after 5s, with null). */
  runIdPromise: Promise<string | null>;
  /** Resolves when the child process exits or is cancelled. */
  result: Promise<AskResult>;
  /** Kill the child process. Result will resolve with ok:false and error="cancelled". */
  cancel(): void;
}

export function isAskBusy(): boolean { return inflight >= MAX_CONCURRENT; }

/** Last non-empty stderr line that is not a stack frame (`at …`), or "" — the message a user needs, never an inner frame. */
export function lastStderrLine(s: string): string {
  return s.trim().split("\n").map((l) => l.trim()).filter((l) => l && !/^at\s/.test(l)).pop() || "";
}

export type AskHost = "claude" | "codex";

/** The efforts each host's one-shot path takes from Vault chat (spec 2026-10-07-sessions-ux U9): ask.js passes them on. */
export const ASK_EFFORTS: Record<AskHost, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

export interface RunAskOptions {
  vault: string;
  question: string;
  /** Absolute node binary from Plugin.nodeBin(); "node" lets spawn try PATH. */
  node?: string;
  timeoutMs?: number;
  /** Vault chat's menu pick: that host only (ask.js --host=), never a fallback to another. */
  host?: AskHost;
  /** A model id from the host's catalog; "default" means the host's own, so no --model. */
  model?: string;
  /** Sent only with a model and only when the host's levels include it (ASK_EFFORTS). */
  effort?: string;
  /** A Vault chat question under provider local (ask.js --chat): it runs where ai.chat says (local-first A2). Only
   *  without a host: a named host answers whatever ai.chat says. */
  chat?: boolean;
}

/**
 * ask.js's argv in the one order the chat surface admits (app/src/shared/surfaces.ts): --local, then --chat (a Vault
 * question under provider local, with no host) or --host=, --model= and --effort= as single arguments, then the
 * question. The surface admits a model only after a host and an effort only after a model: without a host both are left
 * off, and a model that is empty, "default", holds a space or starts with "-" is left off with its effort.
 */
export function buildAskArgs(o: Pick<RunAskOptions, "question" | "host" | "model" | "effort" | "chat">): string[] {
  const args = ["brain/scripts/sdk/ask.js", "--local"];
  if (o.chat && !o.host) args.push("--chat");
  if (o.host) {
    args.push(`--host=${o.host}`);
    const model = o.model && o.model !== "default" && /^[^\s-]\S*$/.test(o.model) ? o.model : "";
    if (model) args.push(`--model=${model}`);
    if (o.effort && ASK_EFFORTS[o.host].includes(o.effort)) args.push(`--effort=${o.effort}`);
  }
  args.push(o.question);
  return args;
}

export function runAsk(opts: RunAskOptions, deps: { spawn?: SpawnFn } = {}): AskHandle {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  let stdoutBuf = "";
  let stderrBuf = "";
  let runId: string | null = null;
  let runIdResolve!: (id: string | null) => void;
  const runIdPromise = new Promise<string | null>((r) => { runIdResolve = r; });
  // Fallback: if telemetry never emits the line within 5s, resolve as null
  const runIdTimer = setTimeout(() => runIdResolve(runId), 5000);

  if (isAskBusy()) {
    const err: AskResult = {
      ok: false, runId: null, answer: "", stderr: "",
      elapsedMs: 0, exitCode: null,
      error: `ask busy (>= ${MAX_CONCURRENT} in flight)`,
    };
    runIdResolve(null);
    return {
      runIdPromise,
      result: Promise.resolve(err),
      cancel: () => { /* no-op */ },
    };
  }

  inflight++;
  let child: HostChild;
  let killed = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const result = new Promise<AskResult>((resolve) => {
    try {
      // --local is mandatory: Plan 2 made ask.js default to --context (prints the
      // <<<AOS_CONTEXT feature=ask>>> block for a Claude Code session and exits without
      // answering). The Chat tab wants the answer, so it always asks for the provider path.
      child = (deps.spawn ?? spawn)(opts.node ?? "node", buildAskArgs(opts), { cwd: opts.vault });
    } catch (err) {
      inflight--;
      clearTimeout(runIdTimer);
      runIdResolve(null);
      resolve({
        ok: false, runId: null, answer: "", stderr: "",
        elapsedMs: Date.now() - start, exitCode: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    killTimer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout?.on("data", (d) => { stdoutBuf += d; });
    child.stderr?.on("data", (chunk) => {
      // Scrape run_id from the first stderr write — the [telemetry] line is
      // emitted synchronously right after live ndjson is opened.
      if (!runId) {
        const m = /\[telemetry\] run_id=(\S+)/.exec(chunk);
        if (m) {
          runId = m[1];
          runIdResolve(runId);
        }
      }
      // Strip the telemetry line from the surfaced stderr so callers don't see noise.
      stderrBuf += chunk.replace(/\[telemetry\] run_id=\S+\n?/g, "");
    });

    child.on("error", (err) => {
      inflight--;
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(runIdTimer);
      runIdResolve(runId);
      resolve({
        ok: false, runId, answer: stdoutBuf.trim(), stderr: stderrBuf,
        elapsedMs: Date.now() - start, exitCode: null,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      inflight--;
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(runIdTimer);
      runIdResolve(runId);
      resolve({
        ok: code === 0 && !killed,
        runId,
        answer: stdoutBuf.trim(),
        stderr: stderrBuf,
        elapsedMs: Date.now() - start,
        exitCode: code,
        // Surface the script's own last stderr line (e.g. "recall index missing", "ollama
        // unreachable") instead of the bare exit code; fall back to "exit N" only when silent.
        // Stack frames are skipped: ask.js's `[ask] fatal: ${err.stack}` path ends in `at …`
        // lines, and the frame is never the message the user needs.
        error: cancelled ? "cancelled"
          : killed ? "cancelled (timeout)"
          : code !== 0 ? (lastStderrLine(stderrBuf) || `exit ${code}`).slice(0, 400)
          : undefined,
      });
    });
  });

  return {
    runIdPromise,
    result,
    cancel: () => {
      if (!child || killed) return;
      killed = true;
      cancelled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    },
  };
}
