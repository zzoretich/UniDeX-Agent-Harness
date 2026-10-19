import { Notice, TFile } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { loadRuns, AgentRun, touchesRuns, formatDuration, formatRelative, formatClockTime } from "../data/runs";
import { loadRunDetail, RunDetail, formatEventLabel } from "../data/runDetail";
import { setPendingRunId, VIEW_TYPE_RUN_INSPECTOR } from "./RunInspectorView";
import { formatUSD } from "../data/cost";
import { loadStaff, StaffAgent } from "../data/staff";

export class RunsTab {
  private host: HTMLElement | null = null;
  private sub: "runs" | "agents" = "runs";
  private runs: AgentRun[] = [];
  private staff: StaffAgent[] = [];
  private query = "";
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;

  // ── run-detail drawer state — PORT of RunInspectorView's instance fields (~14-20).
  // RunInspectorView renders into a fixed view root and keeps one run's detail alive
  // at a time; RunsTab's drawer is the same "one open run at a time" shape, so these
  // stay instance fields rather than threaded parameters. render() itself, though,
  // takes an explicit (host, run) — see renderDetailBody's doc comment for why.
  private detail: RunDetail | null = null;
  private expandedEvents = new Set<number>();
  private promptOpen = false;
  private replyOpen = false;
  private rawOpen = false;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      this.view.registerEvent(
        this.plugin.app.vault.on("modify", (f: TAbstractFile) => {
          if (touchesRuns(f.path)) this.schedule();
        })
      );
      this.view.registerEvent(this.plugin.bus.on("runs-appended", () => this.schedule()));
      // PORT of the old Staff Roster view's onOpen heartbeat.json watcher (~26-30) — restored per
      // fix-round ruling: the brief's literal "one listener on vault modify of
      // RUNS_PATH" mount() spec left the agents sub-view without live refresh on a
      // bare heartbeat.json edit. Adaptations: this.app → this.plugin.app; the
      // source's own scheduleRefresh() call routes through this file's existing
      // schedule() debounce instead (RunsTab has one debounce method, not two, and it
      // already covers both listeners' needs identically — same 250ms coalesce). The
      // source's 30s poll timer (this.timer = window.setInterval(...)) is deliberately
      // NOT restored — the ruling named the listener only.
      this.view.registerEvent(
        this.plugin.app.vault.on("modify", (f: TAbstractFile) => {
          if (f.path.startsWith("brain/agents/") && f.path.endsWith("heartbeat.json")) this.schedule();
        })
      );
    }
    void this.refresh();
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    this.runs = await loadRuns(this.plugin.app);
    this.staff = await loadStaff(this.plugin.app);
    this.render();
  }

  // ── ⌘K omnisearch entry points (Task 7) — not ports, new. Called by
  // main.ts's openOmni() dispatch after it has already opened this tab via
  // plugin.openWorkbenchTab("runs"), so `mount()` has already run and `host`
  // is set; what's NOT guaranteed yet is that refresh()'s async load has
  // landed (cold open: mount() is synchronous, refresh() isn't). showRun
  // checks the already-loaded list first (warm — instant), and only refreshes
  // if the id isn't there yet (cold), matching the brief's "find the run in
  // its loaded list; if not loaded yet, refresh first."

  async showRun(id: string): Promise<void> {
    // If the tab was last left on the agents sub-view, switch + repaint first —
    // otherwise the drawer would open over a grid that doesn't show runs at all.
    if (this.sub !== "runs") { this.sub = "runs"; this.render(); }
    let run = this.runs.find((r) => r.id === id);
    if (!run) {
      await this.refresh();
      run = this.runs.find((r) => r.id === id);
    }
    if (!run) { new Notice(`Run not found: ${id}`); return; }
    this.view.openDrawer(
      `run ${idShort(run.id)}`,
      (drawerHost) => { void this.renderRunDetail(drawerHost, run!); },
      () => {
        setPendingRunId(run!.id);
        void this.plugin.activate(VIEW_TYPE_RUN_INSPECTOR, "split");
      }
    );
  }

  /** Same "⌬ agents" chip switch as the head's click handler (render() below). */
  showAgents(): void {
    this.sub = "agents";
    this.render();
  }

  // ── render ──────────────────────────────────────────────────────────

  private render(): void {
    if (!this.view.isTabActive("runs")) return;
    const host = this.host;
    if (!host) return;
    host.empty();

    const head = host.createDiv({ cls: "aos-runs-head" });
    const runsChip = head.createSpan({ cls: "aos-runs-chip", text: "≣ runs", attr: { "data-tour": "runs-list" } });
    runsChip.toggleClass("is-active", this.sub === "runs");
    runsChip.addEventListener("click", () => { this.sub = "runs"; this.render(); });
    const agentsChip = head.createSpan({ cls: "aos-runs-chip", text: "⌬ agents", attr: { "data-tour": "runs-agents" } });
    agentsChip.toggleClass("is-active", this.sub === "agents");
    agentsChip.addEventListener("click", () => { this.sub = "agents"; this.render(); });

    const search = head.createEl("input", { cls: "aos-runs-filter", attr: { type: "text", placeholder: "filter…", value: this.query } });
    // assigned below; closed over by the input handler so typing updates just the body,
    // not the head (which would otherwise lose focus on every keystroke — see
    // MemoryTab's map-search precedent).
    let body: HTMLElement | null = null;
    search.addEventListener("input", () => {
      this.query = search.value;
      if (body) this.renderBody(body);
    });

    body = host.createDiv({ cls: "aos-runs-body" });
    this.renderBody(body);
  }

  private renderBody(host: HTMLElement): void {
    host.empty();
    if (this.sub === "runs") this.renderRunsList(host);
    else this.renderAgentsGrid(host);
  }

  // ── runs sub-view — new markup (aos-runs-*), not a port ───────────────

  private filteredRuns(): AgentRun[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.runs;
    return this.runs.filter((r) =>
      r.id.toLowerCase().includes(q) ||
      r.script.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q)
    );
  }

  private renderRunsList(host: HTMLElement): void {
    const filtered = this.filteredRuns();
    if (filtered.length === 0) {
      host.createDiv({ cls: "aos-dim", text: this.runs.length === 0 ? "no runs recorded" : "no matches" });
      return;
    }
    // loadRuns() already returns newest-first (see runs.ts: it reverses the tail slice).
    for (const run of filtered) {
      const row = host.createDiv({ cls: "aos-runs-row" });
      row.createSpan({ cls: "aos-runs-id", text: idShort(run.id) });
      row.createSpan({ cls: "aos-runs-script", text: run.script });
      row.createSpan({ cls: "aos-dim", text: typeof run.duration_ms === "number" ? formatDuration(run.duration_ms) : "—" });
      row.createSpan({ cls: "aos-dim", text: typeof run.cost_usd === "number" && run.cost_usd > 0 ? formatUSD(run.cost_usd) : "—" });
      row.createSpan({ cls: "aos-dim", text: formatRelative(run.started_at) });
      row.addEventListener("click", () => {
        this.view.openDrawer(
          `run ${idShort(run.id)}`,
          (drawerHost) => { void this.renderRunDetail(drawerHost, run); },
          () => {
            setPendingRunId(run.id);
            void this.plugin.activate(VIEW_TYPE_RUN_INSPECTOR, "split");
          }
        );
      });
    }
  }

  // ── agents sub-view — PORT of the old Staff Roster view's render (~48) / renderCard (~66) /
  //    freshnessBadge (~122) / module-level colorFor (~149). Adaptations: this.app →
  //    this.plugin.app throughout. The standalone view's heartbeat.json vault listener
  //    IS ported (see mount() — restored in a fix round after live review found the
  //    agents sub-view didn't refresh without it); its 30s poll timer is deliberately
  //    NOT ported (freshness badges re-age only on a heartbeat/RUNS_PATH event or tab
  //    re-entry, not on a bare clock tick — a smoke-checklist note, not a bug). A query
  //    filter (new) is applied before the grid loop so the shared head's filter input
  //    works in this sub-view too.

  private filteredStaff(): StaffAgent[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.staff;
    return this.staff.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      (a.description || "").toLowerCase().includes(q)
    );
  }

  private renderAgentsGrid(host: HTMLElement): void {
    const container = host.createDiv({ cls: "aos-staff" });

    const header = container.createDiv({ cls: "aos-staff-header" });
    header.createSpan({ cls: "aos-title", text: "Staff roster" });
    header.createSpan({ cls: "aos-dim", text: `${this.staff.length} agents · live tail ${this.plugin.hb.getStatus().up ? "active" : "idle"}` });

    if (this.staff.length === 0) {
      container.createDiv({ cls: "aos-dim", text: "no agents found under brain/agents/" });
      return;
    }

    const filtered = this.filteredStaff();
    if (filtered.length === 0) {
      container.createDiv({ cls: "aos-dim", text: "no matches" });
      return;
    }

    const grid = container.createDiv({ cls: "aos-staff-grid" });
    for (const a of filtered) grid.appendChild(this.renderCard(a));
  }

  // PORT of the old Staff Roster view's renderCard (~66)
  private renderCard(agent: StaffAgent): HTMLElement {
    const card = document.createElement("div");
    card.className = "aos-staff-card";
    const color = agent.color || colorFor(agent.name);
    card.style.borderLeft = `3px solid ${color}`;

    const head = card.createDiv({ cls: "aos-staff-card-head" });
    head.createSpan({ cls: "aos-staff-name", text: agent.name });
    const freshness = this.freshnessBadge(agent);
    head.appendChild(freshness);

    if (agent.description) {
      card.createDiv({ cls: "aos-dim aos-staff-desc", text: agent.description });
    }

    const hb = agent.heartbeat;
    if (hb) {
      if (hb.summary) {
        card.createDiv({ cls: "aos-staff-summary", text: hb.summary });
      }
      const meta = card.createDiv({ cls: "aos-staff-meta" });
      if (hb.status) meta.createSpan({ cls: `aos-pill aos-pill-${hb.status === "ok" ? "cyan" : "rose"}`, text: hb.status });
      if (hb.trigger) meta.createSpan({ cls: "aos-pill aos-pill-dim", text: hb.trigger });
      if (hb.duration_sec) meta.createSpan({ cls: "aos-dim", text: `${hb.duration_sec}s` });

      const times = card.createDiv({ cls: "aos-staff-times" });
      if (hb.completed_at) times.createDiv({ text: `last: ${formatRelative(hb.completed_at)}`, cls: "aos-dim" });
      if (hb.next_fire) times.createDiv({ text: `next: ${formatRelative(hb.next_fire)}`, cls: "aos-text-cyan" });

      if (hb.last_brief) {
        const link = card.createEl("a", { cls: "aos-link", text: "▸ last brief", href: "#" });
        link.addEventListener("click", async (e) => {
          e.preventDefault();
          await this.openLastBrief(hb.last_brief as string);
        });
      }
    } else {
      card.createDiv({ cls: "aos-dim", text: "no heartbeat" });
    }

    const actions = card.createDiv({ cls: "aos-staff-actions" });
    const openDir = actions.createEl("a", { cls: "aos-link", text: "▸ open folder", href: "#" });
    openDir.addEventListener("click", async (e) => {
      e.preventDefault();
      const persona = `agents/${agent.name}.md`;
      const file = this.plugin.app.vault.getAbstractFileByPath(persona);
      if (file instanceof TFile) {
        await this.plugin.app.workspace.getLeaf("tab").openFile(file);
      } else {
        new Notice(`No persona file: ${persona}`);
      }
    });

    return card;
  }

  // PORT of the old Staff Roster view's freshnessBadge (~122)
  private freshnessBadge(a: StaffAgent): HTMLElement {
    const t = a.heartbeatMtime || 0;
    const now = Date.now();
    const ageMs = now - t;
    let cls = "aos-text-cyan", label = "live";
    if (ageMs > 7 * 24 * 60 * 60 * 1000) { cls = "aos-text-rose"; label = "stale"; }
    else if (ageMs > 24 * 60 * 60 * 1000) { cls = "aos-text-amber"; label = "1d+"; }
    const el = document.createElement("span");
    el.className = `aos-staff-fresh ${cls}`;
    el.textContent = label;
    return el;
  }

  // PORT of the old Staff Roster view's openLastBrief (~135) — a transitive dependency of
  // renderCard's "last brief" link. Not separately named in the brief's method list,
  // but ported alongside since renderCard would break without it.
  private async openLastBrief(path: string): Promise<void> {
    let rel = path;
    const vaultPath = (this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
    if (vaultPath && path.startsWith(vaultPath + "/")) rel = path.slice(vaultPath.length + 1);
    const file = this.plugin.app.vault.getAbstractFileByPath(rel);
    if (file instanceof TFile) {
      await this.plugin.app.workspace.getLeaf("split", "vertical").openFile(file);
    } else {
      new Notice(`Brief not found: ${rel}`);
    }
  }

  // ── run-detail drawer ───────────────────────────────────────────────
  // PORT of RunInspectorView.render (~59) / collapsible (~162), plus its stat (~156)
  // helper and module-level truncate/formatOffsetMs. Neither RunInspectorView nor
  // the old Staff Roster view use a Component (e.g. MarkdownRenderer) or window-level
  // listeners — verified by inspecting both sources — so there is no extra
  // lifecycle cleanup to wire beyond the standard debounce-clear + host-empty
  // already in unmount() below.

  // Mirrors RunInspectorView.setRun+refresh: reset the collapsible/expand state and
  // (re)load detail, since each drawer open is effectively "switching to" a
  // (possibly different) run. Split from renderDetailBody so toggle clicks can
  // re-paint synchronously without re-fetching.
  private async renderRunDetail(host: HTMLElement, run: AgentRun): Promise<void> {
    this.expandedEvents.clear();
    this.promptOpen = false;
    this.replyOpen = false;
    this.rawOpen = false;
    this.detail = await loadRunDetail(this.plugin.app, run.id);
    this.renderDetailBody(host, run);
  }

  // PORT of RunInspectorView.render (~59). Adaptations: root → host; this.runId →
  // run.id; this.render() → this.renderDetailBody(host, run) (RunInspectorView
  // renders into a fixed view root and calls this.render() with no arguments — the
  // drawer's host/run must be threaded through instead). The source's own
  // "[ RUN INSPECTOR ]" + run-id header block is DROPPED: openDrawer() already shows
  // an equivalent title (`run ${short}`) above this body, so repeating it here would
  // be redundant — the same call Task 2 made dropping MemoryInspectorView's header
  // when porting it into MemoryTab's drawer.
  private renderDetailBody(host: HTMLElement, run: AgentRun): void {
    host.empty();
    host.addClass("aos-runinspector");

    if (!this.detail) {
      host.createDiv({ cls: "aos-text-rose", text: `run ${run.id} not found` });
      return;
    }

    const s = this.detail.summary;

    // header card
    const card = host.createDiv({ cls: "aos-ri-card" });
    const top = card.createDiv({ cls: "aos-ri-top" });
    const statusCls = s.status === "ok" ? "aos-text-cyan" : "aos-text-rose";
    top.createSpan({ cls: `aos-ri-status ${statusCls}`, text: s.status });
    top.createSpan({ cls: "aos-ri-script", text: s.script });
    top.createSpan({ cls: "aos-ri-when aos-dim", text: `${formatClockTime(s.started_at)} · ${formatRelative(s.started_at)}` });

    const stats = card.createDiv({ cls: "aos-ri-stats" });
    this.stat(stats, "duration", formatDuration(s.duration_ms));
    this.stat(stats, "cost", formatUSD(s.cost_usd || 0));
    this.stat(stats, "turns", String(s.turns ?? 0));
    this.stat(stats, "tools", String(s.tool_count ?? 0));
    this.stat(stats, "subagents", String((s.subagents || []).length));

    if (s.error) {
      const err = card.createDiv({ cls: "aos-ri-error aos-text-rose" });
      err.textContent = s.error;
    }

    // Prompt section
    this.collapsible(host, "PROMPT", s.prompt || "(empty)", this.promptOpen, (open) => { this.promptOpen = open; }, () => this.renderDetailBody(host, run));

    // Reply section
    this.collapsible(host, "REPLY", s.reply || "(empty)", this.replyOpen, (open) => { this.replyOpen = open; }, () => this.renderDetailBody(host, run));

    // Subagents (if any)
    if ((s.subagents || []).length > 0) {
      const sa = host.createDiv({ cls: "aos-ri-section" });
      sa.createDiv({ cls: "aos-ri-section-head", text: `SUBAGENTS · ${(s.subagents || []).length}` });
      for (const sub of s.subagents || []) {
        const r = sa.createDiv({ cls: "aos-ri-subagent" });
        r.textContent = typeof sub === "string" ? sub : JSON.stringify(sub);
      }
    }

    // Timeline
    const tl = host.createDiv({ cls: "aos-ri-section" });
    tl.createDiv({ cls: "aos-ri-section-head", text: `TIMELINE · ${this.detail.events.length} events` });
    const list = tl.createDiv({ cls: "aos-ri-timeline" });
    const startTs = this.detail.events[0]?.ts || 0;
    for (let i = 0; i < this.detail.events.length; i++) {
      const e = this.detail.events[i];
      const row = list.createDiv({ cls: "aos-ri-evt" });
      const head = row.createDiv({ cls: "aos-ri-evt-head" });
      head.createSpan({ cls: "aos-ri-evt-time aos-dim", text: `+${formatOffsetMs(e.ts - startTs)}` });
      head.createSpan({ cls: "aos-ri-evt-type", text: formatEventLabel(e) });

      const hasDetail = !!(e.tools || e.results || e.subtype || Object.keys(e).length > 3);
      if (hasDetail) {
        const open = this.expandedEvents.has(i);
        head.createSpan({ cls: "aos-ri-evt-toggle", text: open ? "▾" : "▸" });
        head.style.cursor = "pointer";
        head.addEventListener("click", () => {
          if (this.expandedEvents.has(i)) this.expandedEvents.delete(i);
          else this.expandedEvents.add(i);
          this.renderDetailBody(host, run);
        });
        if (open) {
          const det = row.createDiv({ cls: "aos-ri-evt-detail" });
          if (e.tools) {
            for (const t of e.tools) {
              det.createDiv({ cls: "aos-ri-tool" }).textContent = `▸ ${t.name}  ${truncate(t.input_summary, 140)}`;
            }
          } else if (e.results) {
            for (const r2 of e.results) {
              const cls = r2.is_error ? "aos-text-rose" : "aos-text-cyan";
              det.createDiv({ cls: `aos-ri-tool ${cls}` }).textContent = `▸ ${truncate(r2.output_summary, 200)}`;
            }
          } else {
            const pre = det.createEl("pre", { cls: "aos-ri-evt-json" });
            pre.textContent = JSON.stringify(e, null, 2);
          }
        }
      }
    }

    // Raw JSON
    this.collapsible(host, "RAW JSON", JSON.stringify(this.detail, null, 2), this.rawOpen, (open) => { this.rawOpen = open; }, () => this.renderDetailBody(host, run), true);
  }

  // PORT of RunInspectorView.stat (~156) — verbatim, no this.app/this.render() dependency.
  private stat(parent: HTMLElement, label: string, value: string): void {
    const el = parent.createDiv({ cls: "aos-ri-stat" });
    el.createDiv({ cls: "aos-ri-stat-v", text: value });
    el.createDiv({ cls: "aos-ri-stat-l aos-dim", text: label });
  }

  // PORT of RunInspectorView.collapsible (~162). Adaptation: gained one parameter,
  // `rerender`, inserted before the trailing `pre` flag — the source calls
  // this.render() directly, which RunsTab has no equivalent of (it has multiple
  // render targets, not one fixed view root), so the caller supplies how to repaint.
  private collapsible(parent: HTMLElement, title: string, content: string, open: boolean, setOpen: (b: boolean) => void, rerender: () => void, pre = false): void {
    const sec = parent.createDiv({ cls: "aos-ri-section" });
    const head = sec.createDiv({ cls: "aos-ri-section-head aos-ri-collapse-head" });
    head.createSpan({ cls: "aos-ri-section-toggle", text: open ? "▾" : "▸" });
    head.createSpan({ text: ` ${title}` });
    head.addEventListener("click", () => { setOpen(!open); rerender(); });
    if (open) {
      const body = sec.createDiv({ cls: "aos-ri-collapse-body" });
      if (pre) {
        const p = body.createEl("pre", { cls: "aos-ri-pre" });
        p.textContent = content;
      } else {
        body.textContent = content;
      }
    }
  }

  unmount(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.host?.empty();
    this.host = null;
  }
}

// id-short: mirrors the .slice(-10) convention RunInspectorView.getDisplayText uses
// for its own short-id display. New helper (the source inlines this once; RunsTab
// needs it in both the row and the drawer title, so it's factored out here).
function idShort(id: string): string {
  return id.slice(-10);
}

// PORT of RunInspectorView's module-level truncate (~180) — verbatim.
function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// PORT of RunInspectorView's module-level formatOffsetMs (~185) — verbatim.
function formatOffsetMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

// PORT of the old Staff Roster view's module-level colorFor (~149) — verbatim.
function colorFor(name: string): string {
  const palette = ["var(--udx-chart-1)", "var(--udx-chart-4)", "var(--udx-chart-3)", "var(--udx-chart-5)", "var(--udx-text)"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
