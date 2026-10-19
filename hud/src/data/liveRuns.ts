// liveRuns.ts — local filesystem watcher for SDK agent-run telemetry.
//
// Direct port of dashboards/agent-runs.js polling logic (pollLiveDir +
// pollSummaryLog + replay-on-attach) so the plugin can source run-start /
// event / run-end events without the heartbeat HTTP server. Events are
// emitted onto plugin.bus with the same { type, data } shape SSEClient uses,
// so the old Mission Control view's handleSSE() (and any other subscriber) is source-agnostic.

import type { Events } from "obsidian";
import * as path from "path";
import { fs, utf8 } from "../host";

interface LiveHeader {
  id: string;
  script: string;
  started_at: string;
  prompt?: string;
  pid?: number;
}

interface PolledFileState {
  cursor: number;
  header: LiveHeader | null;
}

export interface LiveRunsOptions {
  vault: string;
  bus: Events;
  pollMs?: number;
  /** Tag every emitted event with this source label so a subscriber can dedupe across SSE + local. */
  source?: string;
  /** Create agent-runs/live/ and runs.jsonl on start. false when telemetry is disabled: poll only what exists. */
  createDirs?: boolean;
}

export class LiveRunsWatcher {
  private opts: Required<LiveRunsOptions>;
  private liveDir: string;
  private summaryLog: string;
  private files = new Map<string, PolledFileState>();
  private summaryCursor = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPollOk = false;
  private lastPollAt = 0;

  constructor(options: LiveRunsOptions) {
    this.opts = {
      vault: options.vault,
      bus: options.bus,
      pollMs: options.pollMs ?? 300,
      source: options.source ?? "local",
      createDirs: options.createDirs ?? true,
    };
    const runsDir = path.join(this.opts.vault, "brain/_index/agent-runs");
    this.liveDir = path.join(runsDir, "live");
    this.summaryLog = path.join(runsDir, "runs.jsonl");
  }

  start(): void {
    if (this.opts.createDirs && fs.existsSync(this.opts.vault)) {
      try { fs.mkdirSync(this.liveDir, { recursive: true }); } catch { /* best-effort */ }
      if (!fs.existsSync(this.summaryLog)) {
        try { fs.writeFileSync(this.summaryLog, ""); } catch { /* best-effort */ }
      }
    }
    this.summaryCursor = this.safeStat(this.summaryLog).size;
    // Prime liveHeaders so the first poll has correct cursor offsets for files
    // that already existed when we started — but DO emit run-start replays for
    // any in-flight runs that exist right now, so a fresh subscriber catches up.
    this.primeLiveFiles();
    this.timer = setInterval(() => this.pollOnce(), this.opts.pollMs);
    // Don't keep Obsidian alive on this timer when the plugin is the only ref.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.files.clear();
  }

  /** Emit run-start for any currently in-flight runs — call after a view binds late. */
  replayInflight(): void {
    for (const state of this.files.values()) {
      if (!state.header) continue;
      this.emit("run-start", {
        id: state.header.id,
        script: state.header.script,
        started_at: state.header.started_at,
        prompt: state.header.prompt,
      });
    }
  }

  isHealthy(): boolean {
    if (!this.timer) return false;
    return this.lastPollOk && (Date.now() - this.lastPollAt) < this.opts.pollMs * 4;
  }

  // ── internals ────────────────────────────────────────────────────────

  private safeStat(p: string): { size: number; mtimeMs: number } {
    try { const s = fs.statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; }
    catch { return { size: 0, mtimeMs: 0 }; }
  }

  private primeLiveFiles(): void {
    let names: string[];
    try { names = fs.readdirSync(this.liveDir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith(".ndjson")) continue;
      const abs = path.join(this.liveDir, name);
      // Read header (first line) so subscribers that connect later can be replayed.
      try {
        const head = fs.readFileSync(abs, "utf8").split("\n", 1)[0];
        const obj = JSON.parse(head);
        if (obj && obj.type === "run_start") {
          // Initialize cursor at start-of-file so subsequent polls emit any
          // tool events already written. The header itself we won't re-broadcast
          // here — replayInflight() handles that on demand.
          this.files.set(abs, { cursor: 0, header: this.normalizeHeader(obj) });
        }
      } catch { /* skip unreadable */ }
    }
  }

  private normalizeHeader(o: unknown): LiveHeader | null {
    if (!o || typeof o !== "object") return null;
    const r = o as Record<string, unknown>;
    if (typeof r.id !== "string") return null;
    return {
      id: r.id,
      script: typeof r.script === "string" ? r.script : "unknown",
      started_at: typeof r.started_at === "string" ? r.started_at : new Date().toISOString(),
      prompt: typeof r.prompt === "string" ? r.prompt : undefined,
      pid: typeof r.pid === "number" ? r.pid : undefined,
    };
  }

  private pollOnce(): void {
    let ok = true;
    try { this.pollLiveDir(); } catch (e) { ok = false; console.warn("[agentic-os] liveRuns pollLiveDir:", e); }
    try { this.pollSummaryLog(); } catch (e) { ok = false; console.warn("[agentic-os] liveRuns pollSummaryLog:", e); }
    this.lastPollOk = ok;
    this.lastPollAt = Date.now();
  }

  private pollLiveDir(): void {
    let names: string[];
    try { names = fs.readdirSync(this.liveDir); } catch { return; }

    const seen = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".ndjson")) continue;
      const abs = path.join(this.liveDir, name);
      seen.add(abs);
      this.pollLiveFile(abs);
    }
    // Drop state for files that disappeared (endRun deletes the ndjson on success).
    for (const p of [...this.files.keys()]) {
      if (!seen.has(p)) this.files.delete(p);
    }
  }

  private pollLiveFile(abs: string): void {
    const stat = this.safeStat(abs);
    if (!stat.size) return;
    const state = this.files.get(abs) ?? { cursor: 0, header: null };
    if (stat.size <= state.cursor) return;

    let text: string;
    try { text = utf8(fs.readBytesSync(abs, state.cursor, stat.size - state.cursor)); } catch { return; }
    state.cursor = stat.size;
    this.files.set(abs, state);

    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj && (obj as { type?: string }).type === "run_start") {
        const header = this.normalizeHeader(obj);
        if (header) {
          state.header = header;
          this.emit("run-start", {
            id: header.id,
            script: header.script,
            started_at: header.started_at,
            prompt: header.prompt,
          });
        }
      } else {
        this.emit("event", { runId: state.header?.id, event: obj });
      }
    }
  }

  private pollSummaryLog(): void {
    const stat = this.safeStat(this.summaryLog);
    if (stat.size <= this.summaryCursor) return;

    let text: string;
    try { text = utf8(fs.readBytesSync(this.summaryLog, this.summaryCursor, stat.size - this.summaryCursor)); } catch { return; }
    this.summaryCursor = stat.size;

    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let summary: unknown;
      try { summary = JSON.parse(line); } catch { continue; }
      const id = (summary as { id?: string })?.id;
      if (!id) continue;
      this.emit("run-end", { id, summary });
    }
  }

  private emit(type: "run-start" | "event" | "run-end", data: Record<string, unknown>): void {
    this.opts.bus.trigger("sse", { type, data, raw: "", source: this.opts.source });
  }
}
