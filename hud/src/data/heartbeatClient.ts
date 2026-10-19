// heartbeatClient.ts — repurposed in Phase 6.
//
// Originally probed /api/health on the legacy dashboards/serve.js. Since the
// plugin is now self-sufficient, `up` reflects local watcher health: true when
// the LiveRunsWatcher has polled successfully within the last few cycles.
//
// The `on("change")` and `on("probe")` event surface stays the same so the
// rest of the plugin (the old Mission Control view, SidebarHUD, status bar) didn't need to
// change in this phase. Class name kept for source-diff minimization.

import { Events } from "obsidian";

export interface HeartbeatStatus {
  up: boolean;
  lastChangeAt: number;
}

export interface HealthSource { isHealthy(): boolean; }

const POLL_MS = 5000;

export class HeartbeatClient extends Events {
  private source: HealthSource | null = null;
  private status: HeartbeatStatus = { up: false, lastChangeAt: Date.now() };
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Wire the live watcher in after construction (it's created on onLayoutReady). */
  setSource(source: HealthSource | null): void {
    this.source = source;
    this.refresh();
  }

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => {
      this.refresh();
      // Probe event lets the status bar refresh its "ago" text even without a state change.
      this.trigger("probe");
    }, POLL_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getStatus(): HeartbeatStatus { return this.status; }

  private refresh(): void {
    const up = !!this.source?.isHealthy();
    if (up !== this.status.up) {
      this.status = { up, lastChangeAt: Date.now() };
      this.trigger("change", this.status);
    }
  }
}
