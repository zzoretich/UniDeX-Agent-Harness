import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { loadRunDetail, RunDetail, RunEvent, formatEventLabel } from "../data/runDetail";
import { formatDuration, formatRelative, formatClockTime } from "../data/runs";
import { formatUSD } from "../data/cost";

export const VIEW_TYPE_RUN_INSPECTOR = "agentic-os-run-inspector";

let pendingId: string | null = null;
export function setPendingRunId(id: string): void { pendingId = id; }
export function consumePendingRunId(): string | null {
  const id = pendingId; pendingId = null; return id;
}

export class RunInspectorView extends ItemView {
  private detail: RunDetail | null = null;
  private runId: string | null = null;
  private expandedEvents = new Set<number>();
  private promptOpen = false;
  private replyOpen = false;
  private rawOpen = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_RUN_INSPECTOR; }
  getDisplayText(): string { return this.runId ? `Run · ${this.runId.slice(-10)}` : "Run Inspector"; }
  getIcon(): string { return "list-tree"; }

  async onOpen(): Promise<void> {
    const pending = consumePendingRunId();
    if (pending) this.runId = pending;
    await this.refresh();
  }

  async setRun(id: string): Promise<void> {
    this.runId = id;
    this.expandedEvents.clear();
    this.promptOpen = false;
    this.replyOpen = false;
    this.rawOpen = false;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.runId) { this.renderEmpty(); return; }
    this.detail = await loadRunDetail(this.app, this.runId);
    this.render();
  }

  private renderEmpty(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("aos-root", "aos-runinspector");
    root.createDiv({ cls: "aos-title", text: "Run inspector" });
    root.createDiv({ cls: "aos-dim", text: "no run selected" });
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("aos-root", "aos-runinspector");

    const header = root.createDiv({ cls: "aos-ri-header" });
    header.createSpan({ cls: "aos-title", text: "Run inspector" });
    header.createSpan({ cls: "aos-ri-id aos-dim", text: this.runId || "" });

    if (!this.detail) {
      root.createDiv({ cls: "aos-text-rose", text: `run ${this.runId} not found` });
      return;
    }

    const s = this.detail.summary;

    // header card
    const card = root.createDiv({ cls: "aos-ri-card" });
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
    this.collapsible(root, "PROMPT", s.prompt || "(empty)", this.promptOpen, (open) => { this.promptOpen = open; });

    // Reply section
    this.collapsible(root, "REPLY", s.reply || "(empty)", this.replyOpen, (open) => { this.replyOpen = open; });

    // Subagents (if any)
    if ((s.subagents || []).length > 0) {
      const sa = root.createDiv({ cls: "aos-ri-section" });
      sa.createDiv({ cls: "aos-ri-section-head", text: `SUBAGENTS · ${(s.subagents || []).length}` });
      for (const sub of s.subagents || []) {
        const r = sa.createDiv({ cls: "aos-ri-subagent" });
        r.textContent = typeof sub === "string" ? sub : JSON.stringify(sub);
      }
    }

    // Timeline
    const tl = root.createDiv({ cls: "aos-ri-section" });
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
        const toggle = head.createSpan({ cls: "aos-ri-evt-toggle", text: open ? "▾" : "▸" });
        head.style.cursor = "pointer";
        head.addEventListener("click", () => {
          if (this.expandedEvents.has(i)) this.expandedEvents.delete(i);
          else this.expandedEvents.add(i);
          this.render();
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
    this.collapsible(root, "RAW JSON", JSON.stringify(this.detail, null, 2), this.rawOpen, (open) => { this.rawOpen = open; }, true);
  }

  private stat(parent: HTMLElement, label: string, value: string): void {
    const el = parent.createDiv({ cls: "aos-ri-stat" });
    el.createDiv({ cls: "aos-ri-stat-v", text: value });
    el.createDiv({ cls: "aos-ri-stat-l aos-dim", text: label });
  }

  private collapsible(parent: HTMLElement, title: string, content: string, open: boolean, setOpen: (b: boolean) => void, pre = false): void {
    const sec = parent.createDiv({ cls: "aos-ri-section" });
    const head = sec.createDiv({ cls: "aos-ri-section-head aos-ri-collapse-head" });
    head.createSpan({ cls: "aos-ri-section-toggle", text: open ? "▾" : "▸" });
    head.createSpan({ text: ` ${title}` });
    head.addEventListener("click", () => { setOpen(!open); this.render(); });
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
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function formatOffsetMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}m${r.toString().padStart(2, "0")}s`;
}
