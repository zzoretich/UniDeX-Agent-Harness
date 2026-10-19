// The popup every Pulse tile opens (spec 2026-10-08-pulse-cockpit-design P3, P4): the ten areas in a list on the left
// (switch without closing; ↑↓ walk it), the open area's rows with their actions, and a way to its tab. Esc closes. The
// Health area keeps the old Pulse's pipeline chips, rows and Fix Queue. The Brain area summarises and jumps; the Brain
// tab acts, so nothing here keeps, edits or removes a memory (brain-hub D6, D15).
import { App, Modal, setIcon } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { PulseTab } from "../views/PulseTab";
import type { PulseModel, WrittenState } from "../views/pulse/model";
import { AREA_LABEL, AREA_TAB, brainLinks } from "../views/pulse/meta";
import { markRead, needActions, openBrain, openTab, runScript, tickTodo, type Act, type PulseCtx } from "../views/pulse/actions";
import { AREAS, type Area, type Tone } from "../data/pulseFacts";
import { reviewCommand, readAgenticosJson } from "../data/aosConfig";
import { MEMORY_PATH_RE } from "../data/brainModel";
import { sweepLine } from "../data/maintenance";
import { renderSystemDrawer } from "../views/SystemDrawer";
import { groupTodos, localDay, doneThisWeek } from "../data/todos";
import { formatRelative } from "../data/runs";
import { visibleWorkspaces } from "../data/snapshot";
import type { FixAction } from "../data/fixQueue";

const pl = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** How a memory written today reads in the Brain area: still to review (written), kept, or out of recall (D5, D7). */
const WRITTEN_STATE: Record<WrittenState, { tag: string; tone: Tone }> = {
  written: { tag: "written", tone: "info" }, kept: { tag: "kept", tone: "ok" }, archived: { tag: "archived", tone: "off" },
  superseded: { tag: "superseded", tone: "off" }, gone: { tag: "gone", tone: "off" },
};
const clock = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };

export class PulsePopup extends Modal {
  private chip: string | null = null;

  constructor(private plugin: AgenticOSPlugin, private tab: PulseTab, private model: PulseModel, private area: Area, private gone: () => void) {
    super(plugin.app as App);
  }

  onOpen(): void {
    this.modalEl.addClass("mod-pulse");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.gone();
  }

  show(area: Area): void { this.area = area; this.chip = null; this.render(); }
  update(model: PulseModel): void { this.model = model; this.render(); }

  private ctx(): PulseCtx { return this.tab.ctx(() => this.close()); }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("aos-pp");
    this.modalEl.setAttr("aria-label", AREA_LABEL[this.area]);
    const head = c.createDiv({ cls: "aos-pp-head" });
    const titles = head.createDiv({ cls: "aos-pp-titles" });
    titles.createEl("h2", { cls: "aos-pp-title", text: AREA_LABEL[this.area] });
    titles.createDiv({ cls: "aos-pp-sub", text: this.sub() });
    const tabId = AREA_TAB[this.area];
    if (tabId || this.area === "health") {
      const open = head.createEl("button", { cls: "aos-pp-btn", text: this.area === "health" ? "Open the System drawer" : `Open the ${AREA_LABEL[this.area]} tab` });
      const ic = open.createSpan({ cls: "aos-pp-ic" });
      setIcon(ic, "arrow-up-right");
      open.addEventListener("click", () => (this.area === "health" ? this.openSystem() : openTab(this.ctx(), tabId!)));
    }
    const x = head.createEl("button", { cls: "aos-pp-btn is-ghost", attr: { "aria-label": "Close" } });
    setIcon(x, "x");
    x.addEventListener("click", () => this.close());

    const body = c.createDiv({ cls: "aos-pp-body" });
    const nav = body.createDiv({ cls: "aos-pp-nav", attr: { role: "tablist", "aria-label": "Pulse areas" } });
    for (const a of AREAS) {
      const b = nav.createEl("button", { cls: `aos-pp-navbtn${a === this.area ? " is-on" : ""}`, attr: { "data-area": a, role: "tab", "aria-selected": String(a === this.area) } });
      const [count, tone] = this.count(a);
      b.createSpan({ cls: `aos-pulse-dot is-${tone}` });
      b.createSpan({ cls: "aos-pp-navlabel", text: AREA_LABEL[a] });
      b.createSpan({ cls: "aos-pp-navcount", text: count });
      b.addEventListener("click", () => this.show(a));
    }
    nav.createDiv({ cls: "aos-pp-keys", text: "Esc closes · ↑↓ moves between areas" });
    nav.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const i = AREAS.indexOf(this.area);
      this.show(AREAS[(i + (e.key === "ArrowDown" ? 1 : AREAS.length - 1)) % AREAS.length]);
      (this.contentEl.querySelector(".aos-pp-navbtn.is-on") as HTMLElement | null)?.focus();
    });
    const main = body.createDiv({ cls: "aos-pp-main" });
    this.renderArea(main);
  }

  /** The count and tone each area shows in the list. */
  private count(a: Area): [string, Tone] {
    const f = this.model.facts;
    const s = f.summary;
    switch (a) {
      case "needs": return [String(f.needsYou.length), f.needsYou[0]?.tone ?? "ok"];
      case "health": return [s.health.errors ? `${s.health.errors} err` : String(s.health.warnings), s.health.errors ? "danger" : s.health.warnings ? "warn" : "ok"];
      case "agents": return [this.model.live.length ? `${this.model.live.length} live` : "", this.model.live.length ? "info" : "off"];
      case "workspaces": return [String(s.workspaces.total), "off"];
      case "todo": return [String(s.todo.open), s.todo.overdue ? "warn" : "off"];
      case "proposals": return [String(this.model.decisions.length), this.model.decisions.length ? "gate" : "ok"];
      case "notifications": return [String(s.notifications.unread), s.notifications.breaking ? "danger" : s.notifications.unread ? "info" : "ok"];
      case "routines": return [String(s.routines.total), s.routines.failing ? "danger" : "ok"];
      case "spend": return [`$${s.spend.usd.toFixed(2)}`, "off"];
      // Brain (brain-hub D15): what waits in Review, as the tile's "to review" counts it (today's, before the first scan).
      case "memory": {
        const n = this.model.inputs.toReview ?? s.memory.pendingReview;
        return [String(n), n ? "warn" : s.memory.drafts ? "gate" : "ok"];
      }
    }
  }

  private sub(): string {
    const m = this.model;
    const s = m.facts.summary;
    switch (this.area) {
      case "needs": return m.facts.needsYou.length ? `${pl(m.facts.needsYou.length, "item")}: what is broken first, then decisions, stale work, reading` : "Nothing needs you";
      case "health": return `${pl(s.health.errors, "error")} · ${pl(s.health.warnings, "warning")} · ${pl(s.health.notes, "note")}${m.snapshot?.scannedAt ? ` · scanned ${formatRelative(m.snapshot.scannedAt)}` : ""}`;
      case "agents": return `${m.facts.persona ? "the Chief of Staff · " : ""}${pl(m.teams.length, "team")} · ${pl(m.live.length, "live session")} · ${pl(m.staff.length, "agent")} with runs`;
      case "workspaces": return `${s.workspaces.total} workspaces · ${s.workspaces.active} active · newest activity first`;
      case "todo": return `${s.todo.open} open · ${s.todo.done} done · ${s.todo.overdue} overdue · ${s.todo.today} due today`;
      case "proposals": return `${pl(s.decisions.proposals, "proposal")} · ${pl(s.decisions.gates, "team gate")} · ${pl(s.decisions.flags, "flag")} · ${pl(s.decisions.drafts, "feedback draft")}`;
      case "notifications": return `${s.notifications.unread} unread of ${s.notifications.total}`;
      case "routines": return `${pl(s.routines.total, "routine")} · ${s.routines.failing ? `${s.routines.failing} failing` : "none failing"}`;
      case "spend": return `$${s.spend.usd.toFixed(2)} today · ${pl(s.spend.calls, "model call")} · $${m.spendDays.reduce((n, d) => n + d.usd, 0).toFixed(2)} over 7 days`;
      case "memory": return `${s.memory.writtenToday} written today · ${m.brain.sinceLooked} since you looked · ${m.inputs.toReview ?? "—"} to review · ${pl(s.memory.drafts, "feedback draft")}`;
    }
  }

  // ── rows ──

  private chips(main: HTMLElement, chips: { id: string; label: string }[]): void {
    const w = main.createDiv({ cls: "aos-pp-chips" });
    for (const c of chips) {
      const b = w.createEl("button", { cls: `aos-pp-chip${(this.chip ?? chips[0].id) === c.id ? " is-on" : ""}`, text: c.label });
      b.addEventListener("click", () => { this.chip = c.id; this.render(); });
    }
  }

  private row(list: HTMLElement, o: { tone?: Tone | null; title: string; meta?: string; tag?: string; acts?: Act[] }): HTMLElement {
    const r = list.createDiv({ cls: "aos-pp-row" });
    if (o.tone) r.createSpan({ cls: `aos-pulse-dot is-${o.tone}` });
    const t = r.createDiv({ cls: "aos-pp-rowtext" });
    t.createDiv({ cls: "aos-pp-rowtitle", text: o.title, attr: { title: o.title } });
    if (o.meta) t.createDiv({ cls: "aos-pp-rowmeta", text: o.meta });
    if (o.tag) r.createSpan({ cls: `aos-pulse-pill is-${o.tone ?? "off"}`, text: o.tag });
    for (const a of o.acts ?? []) {
      const b = r.createEl("button", { cls: `aos-pp-btn${a.primary && !a.jump ? " mod-cta" : ""}`, text: a.label });
      b.addEventListener("click", () => void a.run());
    }
    return r;
  }

  private renderArea(main: HTMLElement): void {
    const m = this.model;
    const ctx = this.ctx();
    const list = (): HTMLElement => main.createDiv({ cls: "aos-pp-list" });
    switch (this.area) {
      case "needs": {
        this.chips(main, [{ id: "all", label: `All ${m.facts.needsYou.length}` }, { id: "fix", label: "Broken & stale" }, { id: "decide", label: "Decisions" }, { id: "read", label: "Reading" }]);
        const pick = this.chip ?? "all";
        const items = m.facts.needsYou.filter((n) => pick === "all" || (pick === "fix" ? n.tier === 0 || n.tier === 2 : pick === "decide" ? n.tier === 1 : n.tier >= 3));
        const l = list();
        const unread = m.inputs.notifications.filter((n) => !n.read && !n.archived).map((n) => n.id);
        for (const n of items) this.row(l, { tone: n.tone, title: n.title, meta: `${AREA_LABEL[n.area]}${n.since ? ` · since ${n.since.slice(0, 10)}` : ""}`, acts: needActions(ctx, n, { unreadIds: unread }) });
        if (!items.length) l.createDiv({ cls: "aos-pp-empty", text: "Nothing here." });
        return;
      }
      case "health": return this.renderHealth(main);
      case "agents": {
        const l = list();
        for (const x of m.live) this.row(l, { tone: "info", title: x.title, meta: x.sub, tag: "live", acts: [{ label: "Show →", jump: true, run: () => openTab(ctx, x.sub.endsWith("Sessions") ? "chat" : "term") }] });
        if (m.facts.persona) {
          const beats = Object.entries(m.heartbeat?.beats ?? {}).sort((a, b) => String(b[1].lastRunAt ?? "").localeCompare(String(a[1].lastRunAt ?? "")));
          this.row(l, { tone: beats.some(([, b]) => b.status === "missed" || b.status === "failed") ? "danger" : "ok", title: `${m.facts.persona} — Chief of Staff`, meta: beats.slice(0, 4).map(([s, b]) => `${s} ${b.status}${b.lastRunAt ? ` ${formatRelative(b.lastRunAt)}` : ""}`).join(" · ") || "no duty has run yet" });
        }
        for (const t of m.teams) this.row(l, { tone: t.gates ? "gate" : t.working ? "info" : "off", title: `${t.name} — team`, meta: `${pl(t.members, "seat")} · ${t.working} working · ${t.blocked} blocked · ${pl(t.gates, "gate")}${t.paused ? " · paused" : ""}`, acts: [{ label: "Board →", jump: true, run: () => openTab(ctx, "agent-teams") }] });
        for (const s of [...m.staff].sort((a, b) => b.heartbeatMtime - a.heartbeatMtime)) {
          const hb = s.heartbeat;
          const at = hb?.completed_at || hb?.started_at;
          this.row(l, { tone: hb?.status === "running" ? "info" : hb?.errored_at ? "danger" : "off", title: s.name, meta: `${hb?.summary ?? hb?.status ?? "no runs"}${at ? ` · ${formatRelative(at)}` : ""}` });
        }
        return;
      }
      case "workspaces": {
        const l = list();
        for (const w of visibleWorkspaces(m.snapshot?.workspaces).sort((a, b) => String(b.lastEvent?.iso ?? "").localeCompare(String(a.lastEvent?.iso ?? "")))) {
          // A row opens Spaces on its workspace (spaces-redesign D12); live as the tile says it (D26).
          const live = this.tab.isLive(w.name);
          const open = (): void => { ctx.close(); if (!ctx.view.open({ tab: "spaces", workspace: w.name })) ctx.view.setTab("spaces"); };
          this.row(l, { tone: live ? "info" : w.status === "active" ? "ok" : "off", title: w.name, meta: [live ? "live now" : null, w.lastEvent?.iso ? formatRelative(w.lastEvent.iso) : null, w.next?.text ? `next: ${w.next.text}` : null, w.summary].filter(Boolean).join(" · "), tag: w.status ?? undefined, acts: [{ label: "Open →", jump: true, run: open }] });
        }
        return;
      }
      case "todo": {
        const today = localDay(m.now);
        const g = groupTodos(m.todos, today);
        const l = list();
        for (const [label, items, tone] of [["overdue", g.overdue, "warn"], ["today", g.today, "info"], ["upcoming", g.upcoming, null], ["someday", g.someday, null]] as [string, typeof g.today, Tone | null][]) {
          for (const t of items) this.row(l, { tone, title: t.text, meta: t.due ? `${label} · due ${t.due}` : label, acts: [{ label: "Done", jump: false, primary: true, run: () => tickTodo(ctx, t.raw) }] });
        }
        for (const t of doneThisWeek(m.todos, today)) this.row(l, { tone: "ok", title: t.text, meta: `done ${t.doneOn}` });
        return;
      }
      case "proposals": {
        const l = list();
        const rc = reviewCommand(readAgenticosJson());
        for (const d of m.decisions) {
          const act: Act = d.kind === "gate" ? { label: "Open →", jump: true, run: () => openTab(ctx, "agent-teams") }
            : d.kind === "drafts" ? { label: "Review →", jump: true, run: () => openBrain(ctx, { mode: "review", queue: "drafts" }) }
            : { label: "Review →", jump: true, run: () => { ctx.close(); ctx.view.runInTerm(rc.command, { host: rc.host, origin: "Pulse" }); } };
          this.row(l, { tone: d.kind === "flag" ? "warn" : "gate", title: d.title, meta: `${d.sub}${d.days !== null ? ` · ${pl(d.days, "day")}` : ""}`, acts: [act] });
        }
        if (!m.decisions.length) l.createDiv({ cls: "aos-pp-empty", text: "No decision waits on you." });
        return;
      }
      case "notifications": {
        this.chips(main, [{ id: "unread", label: `Unread ${m.facts.summary.notifications.unread}` }, { id: "all", label: `All ${m.inputs.notifications.length}` }]);
        const unreadOnly = (this.chip ?? "unread") === "unread";
        const l = list();
        for (const n of m.inputs.notifications.filter((x) => !x.archived && (!unreadOnly || !x.read))) {
          const tone: Tone = n.level === "breaking" ? "danger" : n.level === "alert" ? "warn" : n.read ? "off" : "info";
          const acts: Act[] = [...(n.read ? [] : [{ label: "Mark read", jump: false, primary: true, run: () => markRead(ctx, [n.id]) } as Act]), { label: "Open →", jump: true, run: () => openTab(ctx, "notifications") }];
          this.row(l, { tone, title: n.title, meta: `${n.from} · ${n.level} · ${n.created ? formatRelative(n.created) : ""}`, tag: n.read ? undefined : "unread", acts });
        }
        const ids = m.inputs.notifications.filter((x) => !x.read && !x.archived).map((x) => x.id);
        if (ids.length) this.footer(main, `${ids.length} unread`, { label: "Mark all read", jump: false, run: () => markRead(ctx, ids) });
        return;
      }
      case "routines": {
        const l = list();
        for (const r of m.routineRows) {
          const tone: Tone = r.health === "ok" ? "ok" : r.health === "off" ? "off" : r.health === "failed" || r.health === "invalid" ? "danger" : "warn";
          const last = r.last?.lastRunAt ? `last ${formatRelative(r.last.lastRunAt)}${r.last.lastExit ? ` (exit ${r.last.lastExit})` : ""}` : "never ran";
          const next = r.next[0] ? `next ${r.next[0].toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
          this.row(l, { tone, title: r.routine.slug, meta: [r.cadence, last, next].filter(Boolean).join(" · "), tag: r.health, acts: [{ label: "Run now", jump: false, run: () => runScript(ctx, "brain/scripts/routines/run-routine.js", [r.routine.slug, "--manual"], r.routine.slug) }] });
        }
        return;
      }
      case "spend": {
        const bars = main.createDiv({ cls: "aos-pulse-bars is-wide" });
        const max = Math.max(0.01, ...m.spendDays.map((d) => d.usd));
        for (const d of m.spendDays) {
          const col = bars.createDiv({ cls: "aos-pulse-barcol" });
          col.createSpan({ cls: "aos-pulse-barval", text: `$${d.usd.toFixed(2)}` });
          col.createSpan({ cls: "aos-pulse-barfill", attr: { style: `height: ${Math.round((d.usd / max) * 100)}%` } });
          col.createSpan({ cls: "aos-pulse-barday", text: new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: "short" }) });
        }
        const l = list();
        for (const f of m.spendFamilies) this.row(l, { tone: "off", title: f.family, meta: pl(f.calls, "call"), tag: `$${f.usd.toFixed(2)}` });
        this.footer(main, "Background model calls from provider-spend.jsonl; your own sessions are on the Runs tab.");
        return;
      }
      case "memory": return this.renderBrain(main);
    }
  }

  private footer(main: HTMLElement, text: string, act?: Act): void {
    const f = main.createDiv({ cls: "aos-pp-foot" });
    f.createSpan({ cls: "aos-pp-foottext", text });
    if (act) f.createEl("button", { cls: "aos-pp-btn", text: act.label }).addEventListener("click", () => void act.run());
  }

  private openSystem(): void {
    this.close();
    this.tab.ctx().view.openDrawer("System", (h) => { void renderSystemDrawer(this.plugin, h); });
  }

  // ── Health: the issues, then the old Pulse's chips, rows and Fix Queue (pulse.spec.ts reads them here) ──

  private renderHealth(main: HTMLElement): void {
    const m = this.model;
    const l = main.createDiv({ cls: "aos-pp-list" });
    const tone = (s: string): Tone => (s === "error" ? "danger" : s === "warn" ? "warn" : "off");
    for (const i of m.snapshot?.health?.issues ?? []) this.row(l, { tone: tone(i.severity), title: i.message, meta: `${i.area} · ${i.severity}` });

    const strip = main.createDiv({ cls: "aos-pulse-strip" });
    for (const s of m.statuses) {
      const chip = strip.createSpan({ cls: `aos-pulse-chip is-${s.health}`, attr: { "aria-label": s.detail, title: s.detail } });
      chip.createSpan({ cls: "aos-pulse-dot" });
      chip.createSpan({ text: s.label });
    }

    const rows = main.createDiv({ cls: "aos-pulse-rows" });
    if (m.costActive) {
      const cost = rows.createDiv({ cls: "aos-pulse-row" });
      cost.createSpan({ text: "COST", cls: "aos-pulse-rowlabel" });
      cost.createSpan({ text: m.costLine, cls: m.costWarn ? "aos-text-amber" : undefined });
    }
    const issues = m.snapshot?.health?.issues ?? [];
    const errs = issues.filter((i) => i.severity === "error").length;
    const warns = issues.filter((i) => i.severity === "warn").length;
    const health = rows.createDiv({ cls: "aos-pulse-row" });
    health.createSpan({ text: "HEALTH", cls: "aos-pulse-rowlabel" });
    health.createSpan({ text: errs || warns ? `${errs} err · ${warns} warn` : "all clear", cls: errs ? "aos-text-rose" : warns ? "aos-text-amber" : "aos-text-green" });
    const sweep = sweepLine(m.snapshot?.maintenance);
    if (sweep) {
      const maint = rows.createDiv({ cls: "aos-pulse-row" });
      maint.createSpan({ text: "MAINTENANCE", cls: "aos-pulse-rowlabel" });
      maint.createSpan({ text: sweep.text, cls: sweep.tone === "amber" ? "aos-text-amber" : "aos-dim" });
    }
    const sys = rows.createDiv({ cls: "aos-pulse-row" });
    const sysLink = sys.createEl("a", { cls: "aos-pulse-rowlabel aos-link", text: "SYSTEM ▸", href: "#" });
    sysLink.addEventListener("click", (e) => { e.preventDefault(); this.openSystem(); });

    const fq = main.createDiv({ cls: "aos-pulse-fixq" });
    fq.createDiv({ text: `Fix queue (${m.queue.length})`, cls: "aos-pulse-fixq-title" });
    if (!m.queue.length) fq.createDiv({ text: "nothing to fix — all pipelines reporting clean", cls: "aos-dim" });
    for (const a of m.queue) {
      const card = fq.createDiv({ cls: `aos-pulse-fix is-${a.severity}` });
      card.createDiv({ text: a.title, cls: "aos-pulse-fix-title" });
      card.createDiv({ text: a.detail, cls: "aos-pulse-fix-detail" });
      const btn = card.createEl("a", { text: this.actionLabel(a), cls: "aos-link", href: "#" });
      btn.addEventListener("click", (e) => { e.preventDefault(); if (a.kind !== "spawn") this.close(); this.tab.execute(a); });
    }
  }

  private actionLabel(a: FixAction): string {
    if (a.kind === "spawn") return `▶ run ${a.script?.split("/").pop()} ${a.args?.join(" ") ?? ""}`.trim();
    if (a.kind === "anchor-modal") return "▶ re-anchor…";
    return "▸ open";
  }

  // ── Brain (brain-hub D15): the numbers that jump into the Brain tab, then today's writes, read only ──

  private renderBrain(main: HTMLElement): void {
    const m = this.model;
    const ctx = this.ctx();
    const sum = main.createDiv({ cls: "aos-pp-list" });
    for (const l of brainLinks({ toReview: m.inputs.toReview ?? null, drafts: m.inputs.drafts, brainPct: m.inputs.brainPct ?? null })) {
      this.row(sum, { tone: l.tone, title: l.row, meta: l.meta, acts: [{ label: l.act, jump: true, run: () => openBrain(ctx, l.target) }] }).setAttr("data-brain-link", l.id);
    }
    main.createDiv({ cls: "aos-pp-section", text: "Written today" });
    const today = main.createDiv({ cls: "aos-pp-list" });
    for (const w of m.brain.written) {
      const st = WRITTEN_STATE[w.state];
      const open = w.state !== "gone" && MEMORY_PATH_RE.test(w.path);
      const r = this.row(today, { tone: st.tone, title: w.title, meta: `${w.type} · ${clock(w.at)}`, tag: st.tag, acts: open ? [{ label: "Open →", jump: true, run: () => openBrain(ctx, { mode: "library", memory: w.path }) }] : [] });
      r.setAttr("data-memory", w.path);
      r.setAttr("data-state", w.state);
    }
    if (!m.brain.written.length) today.createDiv({ cls: "aos-pp-empty", text: "Nothing written today." });
  }
}
