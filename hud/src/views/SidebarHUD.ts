import { ItemView, WorkspaceLeaf, TAbstractFile } from "obsidian";
import { BRAND } from "../brand";
import { loadSnapshot, Snapshot, SNAPSHOT_PATH, loadSnapshotHistory, DailySnapshot, seriesFromHistory } from "../data/snapshot";
import { loadRuns, AgentRun, touchesRuns, formatDuration, formatRelative, formatClockTime } from "../data/runs";
import { sparkline } from "../data/sparkline";
import { loadStaff, StaffAgent } from "../data/staff";
import { loadPipelines, pipelineStatuses, PipelineStatus, PIPELINES_PATH } from "../data/pipelines";
import { updateBadge } from "../data/updateBadge";
import { loadPersonaHeartbeat, heartbeatPill, PersonaHeartbeat, PERSONA_HEARTBEAT_PATH } from "../data/personaHeartbeat";
import type AgenticOSPlugin from "../../main";

export const VIEW_TYPE_SIDEBAR_HUD = "agentic-os-sidebar-hud";

export class SidebarHUDView extends ItemView {
  private plugin: AgenticOSPlugin;
  private snapshot: Snapshot | null = null;
  private runs: AgentRun[] = [];
  private history: DailySnapshot[] = [];
  private staff: StaffAgent[] = [];
  private statuses: PipelineStatus[] = [];
  private heartbeat: PersonaHeartbeat | null = null;
  private clockTimerId: number | null = null;
  private refreshDebounce: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AgenticOSPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_SIDEBAR_HUD; }
  getDisplayText(): string { return BRAND.name; }
  getIcon(): string { return "radio"; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("aos-root", "aos-sidebar");
    await this.refresh();
    this.registerVaultWatchers();
    this.clockTimerId = window.setInterval(() => this.tickClock(), 1000);
  }

  async onClose(): Promise<void> {
    if (this.clockTimerId !== null) window.clearInterval(this.clockTimerId);
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
  }

  private registerVaultWatchers(): void {
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file.path === SNAPSHOT_PATH || touchesRuns(file.path) || file.path === PIPELINES_PATH || file.path === PERSONA_HEARTBEAT_PATH) {
          this.scheduleRefresh();
        }
      })
    );
    this.registerEvent(this.plugin.bus.on("runs-appended", () => this.scheduleRefresh()));
  }

  private scheduleRefresh(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => this.refresh(), 200);
  }

  private async refresh(): Promise<void> {
    this.snapshot = await loadSnapshot(this.app);
    this.runs = await loadRuns(this.app, 12);
    this.history = await loadSnapshotHistory(this.app, 14);
    this.staff = await loadStaff(this.app);
    const led = await loadPipelines(this.app);
    this.statuses = pipelineStatuses(led, Date.now());
    this.heartbeat = await loadPersonaHeartbeat(this.app);
    this.render();
  }

  private tickClock(): void {
    const el = this.containerEl.querySelector(".aos-sb-clock");
    if (el) el.textContent = new Date().toLocaleTimeString(undefined, { hour12: false });
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("aos-root", "aos-sidebar");

    const head = root.createDiv({ cls: "aos-sb-head" });
    head.createDiv({ cls: "aos-sb-title", text: BRAND.name });
    head.createDiv({ cls: "aos-sb-clock aos-text-cyan", text: new Date().toLocaleTimeString(undefined, { hour12: false }) });

    // pipeline LEDs — first HUD section; same chip markup as PulseTab's strip
    // (aos-pulse-chip is-<health> + dot + label), just stacked vertically here.
    // Rendered ahead of the snapshot-unavailable early-return below so pipeline
    // health stays visible even when the snapshot itself can't load.
    const leds = root.createDiv({ cls: "aos-hud-leds" });
    for (const st of this.statuses) {
      const chip = leds.createSpan({ cls: `aos-pulse-chip is-${st.health}`, attr: { "aria-label": st.detail, title: st.detail } });
      chip.createSpan({ cls: "aos-pulse-dot" });
      chip.createSpan({ text: st.label });
    }

    const s = this.snapshot;
    if (!s) {
      root.createDiv({ cls: "aos-dim aos-sb-empty", text: "snapshot unavailable" });
      return;
    }

    // status line
    const status = root.createDiv({ cls: "aos-sb-status" });
    status.createSpan({ cls: "aos-pill aos-pill-cyan", text: s.config.settings.model || "?" });
    status.createSpan({ cls: "aos-pill aos-pill-dim", text: s.config.settings.effortLevel || "?" });
    const hbUp = this.plugin.hb.getStatus().up;
    status.createSpan({ cls: `aos-pill ${hbUp ? "aos-pill-cyan" : "aos-pill-dim"}`, text: hbUp ? "⚡ live" : "⚡ idle" });
    if (s.config.settings.dangerousMode) {
      status.createSpan({ cls: "aos-pill aos-pill-rose", text: "danger" });
    }
    // Only when the scanner says a newer release exists and it is not snoozed; otherwise the row is
    // unchanged. updateBadge() owns that decision (src/data/updateBadge.ts).
    const update = updateBadge(s.config.updates, formatRelative);
    if (update) {
      status.createSpan({ cls: "aos-pill aos-pill-amber", text: update.label, attr: { title: update.title } });
    }
    // The persona heartbeat: the watchdog's verdict on the duty schedule (src/data/personaHeartbeat.ts). Absent
    // until the watchdog has written its file once; green/amber/rose follow the last check's age and any miss.
    const beat = heartbeatPill(this.heartbeat, Date.now(), formatRelative);
    if (beat) {
      const tone = beat.tone === "ok" ? "aos-pill-green" : beat.tone === "warn" ? "aos-pill-amber" : "aos-pill-rose";
      status.createSpan({ cls: `aos-pill ${tone}`, text: beat.label, attr: { title: beat.title, "aria-label": beat.title } });
    }

    // sparkline trend tiles
    const trends = root.createDiv({ cls: "aos-sb-trends" });
    this.makeTrendRow(trends, "agents", s.capabilities.agents.count, seriesFromHistory(this.history, "agents"));
    this.makeTrendRow(trends, "memories", s.config.memoryMd?.pointers ?? 0, seriesFromHistory(this.history, "memories"));
    this.makeTrendRow(trends, "skills", s.capabilities.skills.count, seriesFromHistory(this.history, "skills"));
    this.makeTrendRow(trends, "sessions", s.brain.counts?.sessions ?? 0, seriesFromHistory(this.history, "sessions"));

    // last-scan / health
    const meta = root.createDiv({ cls: "aos-sb-meta" });
    meta.createDiv({ text: `scan ${formatRelative(s.scannedAt)}`, cls: "aos-dim" });
    const issues = s.health?.issues ?? [];
    if (issues.length === 0) {
      meta.createDiv({ text: "health ok", cls: "aos-text-cyan" });
    } else {
      const err = issues.filter(i => i.severity === "error").length;
      const wrn = issues.filter(i => i.severity === "warn").length;
      meta.createDiv({ text: `${err} err · ${wrn} warn`, cls: err > 0 ? "aos-text-rose" : "aos-text-amber" });
    }

    // staff strip
    if (this.staff.length > 0) {
      root.createDiv({ cls: "aos-sb-section-label", text: "── staff ──" });
      const strip = root.createDiv({ cls: "aos-sb-staff" });
      for (const a of this.staff) {
        const cell = strip.createDiv({ cls: "aos-sb-staff-cell" });
        const ageMs = Date.now() - (a.heartbeatMtime || 0);
        const cls = ageMs > 7 * 86400000 ? "aos-text-rose" : ageMs > 86400000 ? "aos-text-amber" : "aos-text-cyan";
        cell.createSpan({ cls: `aos-dot aos-dot-ok ${cls}` });
        cell.createSpan({ cls: "aos-sb-staff-name", text: a.name });
      }
    }

    // mini ticker
    root.createDiv({ cls: "aos-sb-section-label", text: "── recent runs ──" });
    const tk = root.createDiv({ cls: "aos-sb-ticker" });
    if (this.runs.length === 0) {
      tk.createDiv({ cls: "aos-dim", text: "none" });
    } else {
      for (const run of this.runs.slice(0, 6)) {
        const row = tk.createDiv({ cls: "aos-sb-ticker-row" });
        row.createSpan({ cls: `aos-dot ${run.status === "ok" ? "aos-dot-ok" : "aos-dot-err"}` });
        row.createSpan({ cls: "aos-sb-tk-time", text: formatClockTime(run.started_at) });
        row.createSpan({ cls: "aos-sb-tk-name", text: run.script });
        row.createSpan({ cls: "aos-sb-tk-dur", text: formatDuration(run.duration_ms) });
      }
    }
  }

  private makeTrendRow(parent: HTMLElement, label: string, current: number, series: number[]): void {
    const row = parent.createDiv({ cls: "aos-sb-trend" });
    row.createSpan({ cls: "aos-sb-trend-label", text: label });
    row.createSpan({ cls: "aos-sb-trend-spark", text: sparkline(series, 14) });
    row.createSpan({ cls: "aos-sb-trend-value", text: String(current) });
  }
}
