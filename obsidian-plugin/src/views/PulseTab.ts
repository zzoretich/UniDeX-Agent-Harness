// Pulse, the Workbench's Home (spec 2026-10-08-pulse-cockpit-design): the Chief of Staff's paragraph over ten tiles that
// fill the pane without a scrollbar. A tile shows a count and as many rows as its height holds (P2); a click opens the
// popup on its area (ui/PulsePopup.ts), where the rows act or jump (P4). The Brain tile summarises and its numbers jump
// into the Brain tab, which acts (brain-hub D15).
import { TAbstractFile, setIcon } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { loadPulseModel, BRIEFING_ROUTINE_PATH, type PulseModel } from "./pulse/model";
import { needActions, openBrain, runScript, type Act, type PulseCtx } from "./pulse/actions";
import { AREA_ICON, AREA_LABEL, BRIEFING_ROUTINE, bandLabels, brainLinks, brainReviewLabel, brainTodayLabel, touchesPulse } from "./pulse/meta";
import { fineOf, mentionParts, sayOf } from "../data/briefingBand";
import type { Area, NeedItem, Tone } from "../data/pulseFacts";
import type { FixAction } from "../data/fixQueue";
import { AnchorModal } from "../ui/AnchorModal";
import { COMMAND_REGISTRY, executeCommand } from "../data/commandRegistry";
import { PulsePopup } from "../ui/PulsePopup";
import { formatRelative } from "../data/runs";
import { visibleWorkspaces } from "../data/snapshot";
import { groupTodos, localDay } from "../data/todos";
import { adapterOf as routineAdapter } from "../data/routineWriter";
import { AOS_CLI } from "../data/aosRun";

const TONE_RANK: Tone[] = ["danger", "warn", "gate", "info", "ok", "off"];
const pl = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const clock = (iso: string | Date): string => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export class PulseTab {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private refreshDebounce: number | null = null;
  private listenersRegistered = false;
  private resize: ResizeObserver | null = null;
  private fitFrame: number | null = null;
  private popup: PulsePopup | null = null;
  model: PulseModel | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const on = (f: TAbstractFile, old?: string) => { if (touchesPulse(f.path) || (old !== undefined && touchesPulse(old))) this.schedule(); };
      this.view.registerEvent(this.plugin.app.vault.on("modify", (f) => on(f)));
      this.view.registerEvent(this.plugin.app.vault.on("create", (f) => on(f)));
      this.view.registerEvent(this.plugin.app.vault.on("delete", (f) => on(f)));
      this.view.registerEvent(this.plugin.app.vault.on("rename", (f, old) => on(f, old)));
    }
    this.root = host.createDiv({ cls: "aos-pulse-cockpit" });
    this.resize = new ResizeObserver(() => this.scheduleFit());
    this.resize.observe(this.root);
    if (this.model) this.render();
    void this.refresh();
  }

  schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => { this.refreshDebounce = null; void this.refresh(); }, 200);
  }

  async refresh(): Promise<void> {
    this.model = await loadPulseModel(this.plugin, this.plugin.settings.pulseSeenAt ?? null, new Date());
    this.render();
    this.popup?.update(this.model);
  }

  /** Whether something runs in a workspace now (spaces-redesign D26): a Code terminal placed there, or a Sessions
   *  thread mid-turn (the model's liveByWorkspace, the rule Spaces' live dot uses). */
  isLive(name: string): boolean { return (this.model?.liveBy.get(name)?.total ?? 0) > 0; }

  /** What rows and the popup act through. */
  ctx(close: () => void = () => {}): PulseCtx {
    return {
      plugin: this.plugin, view: this.view, refresh: () => this.schedule(), close,
      queue: () => this.getFixActions(), execute: (a) => this.execute(a),
    };
  }

  openArea(area: Area): void {
    if (!this.model) return;
    if (this.popup) { this.popup.show(area); return; }
    this.popup = new PulsePopup(this.plugin, this, this.model, area, () => { this.popup = null; });
    this.popup.open();
  }

  private render(): void {
    if (!this.view.isTabActive("pulse") || !this.root || !this.model) return;
    const m = this.model;
    this.root.empty();
    this.renderBand(this.root, m);
    const grid = this.root.createDiv({ cls: "aos-pulse-grid" });
    this.renderNeeds(grid, m);
    this.renderHealth(grid, m);
    this.renderAgents(grid, m);
    this.renderWorkspaces(grid, m);
    this.renderTodo(grid, m);
    this.renderDecisions(grid, m);
    this.renderNotifications(grid, m);
    this.renderRoutines(grid, m);
    this.renderSpend(grid, m);
    this.renderBrain(grid, m);
    // A list also shrinks when the band grows (a paragraph that wraps once more, a font that loads late) while the root
    // keeps its size: watch every list, and only this render's.
    this.resize?.disconnect();
    this.resize?.observe(this.root);
    for (const list of Array.from(this.root.querySelectorAll<HTMLElement>(".aos-pulse-list"))) this.resize?.observe(list);
    this.scheduleFit();
  }

  // ── the briefing band ──

  private renderBand(parent: HTMLElement, m: PulseModel): void {
    const p = m.paragraph;
    const band = parent.createDiv({ cls: `aos-pulse-band aos-pulse-briefing is-${p.source}` });
    const name = m.facts.persona;
    band.createDiv({ cls: "aos-pulse-av", text: (name ?? "B").slice(0, 1).toUpperCase(), attr: { "aria-hidden": "true" } });
    const main = band.createDiv({ cls: "aos-pulse-band-main" });
    const meta = main.createDiv({ cls: "aos-pulse-band-meta" });
    meta.createSpan({ cls: "aos-briefing-label", text: name ?? "Briefing" });
    const when = p.source === "model" && p.at ? `briefing · ${clock(p.at)}` : "composed from the facts";
    meta.createSpan({ cls: "aos-pulse-band-src", text: `${name ? "Chief of Staff · " : ""}${when}`, attr: p.reason ? { title: `The Chief of Staff's own paragraph is not shown: ${p.reason}` } : {} });
    const text = main.createEl("p", { cls: "aos-briefing-text" });
    const tones = this.areaTones(m);
    for (const part of mentionParts(p.text, p.mentions)) {
      if (!part.area) { text.appendText(part.text); continue; }
      const area = part.area;
      const b = text.createEl("button", { cls: `aos-pulse-ent is-${this.mentionTone(m, part.text, area, tones)}`, text: part.text, attr: { "data-area": area } });
      b.addEventListener("click", () => this.openArea(area));
    }
    if (m.since) {
      const s = main.createDiv({ cls: "aos-pulse-since" });
      const ci = s.createSpan({ cls: "aos-pulse-ic" });
      setIcon(ci, "clock");
      s.createSpan({ text: `Since you last looked at ${clock(m.since.at)}: ` });
      s.createSpan({ cls: "aos-pulse-since-parts", text: m.since.parts.join(" · ") });
    }
    if (m.waitingForHost) {
      // local-first §5: no host to run the Chief of Staff (none enabled, or every duty today skipped waiting for one).
      const w = main.createDiv({ cls: "aos-pulse-waiting", attr: { role: "status" } });
      w.createSpan({ text: "Add Claude Code or Codex to start your Chief of Staff." });
      const add = w.createEl("button", { cls: "aos-pulse-waiting-go", text: "Add a host", attr: { title: "Settings ▸ Hosts: install Claude Code or Codex, then sign in" } });
      add.addEventListener("click", () => { this.view.open({ tab: "settings" }); });
    }
    this.renderCommandDeck(main);

    const side = band.createDiv({ cls: "aos-pulse-band-side" });
    const tools = side.createDiv({ cls: "aos-pulse-band-tools" });
    tools.createSpan({ cls: "aos-pulse-dim", text: m.snapshot?.scannedAt ? `scanned ${formatRelative(m.snapshot.scannedAt)}` : "not scanned yet" });
    if (!m.personaOff && m.routineInstalled && !m.briefingOff) {
      const re = tools.createEl("button", { cls: "aos-pulse-iconbtn", attr: { "aria-label": "Write the briefing now", title: "Write the briefing now" } });
      setIcon(re, "sparkles");
      re.addEventListener("click", () => runScript(this.ctx(), "brain/scripts/persona/briefing.js", ["--force"], "the briefing"));
    }
    const scan = tools.createEl("button", { cls: "aos-pulse-iconbtn", attr: { "aria-label": "Rescan the vault", title: "Rescan the vault" } });
    setIcon(scan, "refresh-cw");
    scan.addEventListener("click", () => runScript(this.ctx(), "brain/scripts/scan-vault.js", ["--quiet"], "a scan"));
    const top = m.facts.needsYou.slice(0, 2)
      .map((n) => ({ n, a: needActions(this.ctx(), n, { unreadIds: this.unreadIds(m) })[0] as Act | undefined }))
      .filter((t): t is { n: NeedItem; a: Act } => !!t.a);
    const labels = bandLabels(top.map(({ n, a }) => ({ n, label: a.label, jump: a.jump })));
    top.forEach(({ n, a }, i) => {
      const b = side.createEl("button", { cls: `aos-pulse-act${i === 0 ? " mod-cta" : ""}`, text: labels[i], attr: { title: n.title } });
      b.addEventListener("click", () => void a.run());
    });
    if (!m.personaOff && !m.routineInstalled && name) {
      const on = side.createEl("button", { cls: "aos-pulse-act aos-pulse-turnon", text: `Turn on ${name}'s briefing`, attr: { title: "Adds the briefing routine (brain/routines/briefing.md) and schedules it" } });
      on.addEventListener("click", () => void this.turnOnBriefing());
    }
  }

  /** Each area's tone: its most urgent item's; Routines ok when it has routines and none failing. */
  private areaTones(m: PulseModel): Partial<Record<Area, Tone>> {
    const out: Partial<Record<Area, Tone>> = {};
    for (const n of m.facts.needsYou) {
      const cur = out[n.area];
      if (!cur || TONE_RANK.indexOf(n.tone) < TONE_RANK.indexOf(cur)) out[n.area] = n.tone;
    }
    if (!out.routines && m.facts.summary.routines.total) out.routines = "ok";
    if (m.facts.needsYou.length) out.needs = m.facts.needsYou[0].tone;
    return out;
  }

  /** A chip's tone: green for what is fine, neutral for "N more", the item's own tone when the words name one, else
   *  its area's. */
  private mentionTone(m: PulseModel, phrase: string, area: Area, tones: Partial<Record<Area, Tone>>): Tone {
    const p = phrase.toLowerCase();
    if (fineOf(m.facts.summary).some((f) => f.phrase.toLowerCase() === p)) return "ok";
    if (area === "needs" && /^\S+ (more|others?)$/.test(p)) return "off";
    const item = m.facts.needsYou.find((n) => { const s = sayOf(n).toLowerCase(); return s === p || s.includes(p) || p.includes(n.title.toLowerCase()); });
    return item?.tone ?? tones[area] ?? "off";
  }

  private unreadIds(m: PulseModel): string[] { return m.inputs.notifications.filter((n) => !n.read && !n.archived).map((n) => n.id); }

  /** The Commands row (P11): the registry, as the old command deck showed it, in one compact line. */
  private renderCommandDeck(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: "aos-deck aos-pulse-deck" });
    wrap.createSpan({ cls: "aos-deck-label", text: "Commands" });
    const list = wrap.createDiv({ cls: "aos-deck-list" });
    for (const cmd of COMMAND_REGISTRY) {
      const btn = list.createEl("button", { cls: `aos-deck-btn aos-deck-btn-${cmd.kind}` });
      btn.textContent = cmd.name;
      btn.setAttr("title", `${cmd.kind} · ${cmd.desc}`);
      btn.addEventListener("click", () => { void executeCommand(this.plugin.app, cmd); });
    }
  }

  /** "Turn on" (P14): writes the routine the vault template seeds, through the Routines surface, and schedules it. */
  private async turnOnBriefing(): Promise<void> {
    try {
      const a = routineAdapter(this.plugin.app);
      if (!(await a.exists(BRIEFING_ROUTINE_PATH))) await a.write(BRIEFING_ROUTINE_PATH, BRIEFING_ROUTINE);
      runScript(this.ctx(), AOS_CLI, ["routines", "sync"], "routines sync");
    } catch (e) {
      console.warn("[agentic-os] turning on the briefing failed:", e);
    }
    this.schedule();
  }

  // ── tiles ──

  private head(el: HTMLElement, area: Area, pill: { text: string; tone: Tone } | null, note?: string): void {
    const h = el.createDiv({ cls: "aos-pulse-tile-head" });
    const ic = h.createSpan({ cls: "aos-pulse-ic" });
    setIcon(ic, AREA_ICON[area]);
    h.createSpan({ cls: "aos-pulse-tile-label", text: AREA_LABEL[area] });
    if (note) h.createSpan({ cls: "aos-pulse-dim aos-pulse-clip", text: note });
    h.createSpan({ cls: "aos-pulse-sp" });
    if (pill) h.createSpan({ cls: `aos-pulse-pill is-${pill.tone}`, text: pill.text });
  }

  private tile(grid: HTMLElement, area: Area, opts: { span?: number; pill?: { text: string; tone: Tone } | null; note?: string } = {}): HTMLElement {
    const el = grid.createEl("button", { cls: `aos-pulse-tile${opts.span ? ` span-${opts.span}` : ""}`, attr: { "data-area": area, "aria-label": `${AREA_LABEL[area]}: open` } });
    el.addEventListener("click", () => this.openArea(area));
    this.head(el, area, opts.pill ?? null, opts.note);
    return el.createDiv({ cls: "aos-pulse-tile-body" });
  }

  /** A list that keeps only the rows its height holds; fit() hides the rest and writes "+N more" under it. */
  private list(body: HTMLElement, more: (n: number) => string = (n) => `+${n} more`): HTMLElement {
    const l = body.createDiv({ cls: "aos-pulse-list" });
    const m = body.createDiv({ cls: "aos-pulse-more is-empty" });
    (m as HTMLElement & { _more?: (n: number) => string })._more = more;
    return l;
  }

  private row(list: HTMLElement, o: { tone?: Tone | null; title: string; meta?: string; right?: string }): HTMLElement {
    const r = list.createDiv({ cls: "aos-pulse-li", attr: { title: o.title } });
    if (o.tone) r.createSpan({ cls: `aos-pulse-dot is-${o.tone}` });
    r.createSpan({ cls: "aos-pulse-li-title", text: o.title });
    if (o.meta) r.createSpan({ cls: "aos-pulse-li-meta", text: o.meta });
    if (o.right) r.createSpan({ cls: "aos-pulse-li-right", text: o.right });
    return r;
  }

  private big(body: HTMLElement, value: string, label: string, sub?: string): void {
    const b = body.createDiv({ cls: "aos-pulse-big" });
    b.createSpan({ cls: "aos-pulse-big-n", text: value });
    if (sub) b.createSpan({ cls: "aos-pulse-big-sub", text: sub });
    b.createSpan({ cls: "aos-pulse-big-label", text: label });
  }

  private age(since: string | null, now: Date): string {
    const t = since ? (/^\d{4}-\d{2}-\d{2}$/.test(since) ? new Date(`${since}T00:00:00`).getTime() : Date.parse(since)) : NaN;
    if (!Number.isFinite(t)) return "";
    const h = (now.getTime() - t) / 3600_000;
    return h < 1 ? "now" : h < 24 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)}d`;
  }

  private when(iso: string, now: Date): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return localDay(d) === localDay(now) ? `today ${clock(d)}` : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  private renderNeeds(grid: HTMLElement, m: PulseModel): void {
    const items = m.facts.needsYou;
    const card = grid.createDiv({ cls: "aos-pulse-tile is-card span-2", attr: { "data-area": "needs" } });
    const headBtn = card.createEl("button", { cls: "aos-pulse-tile-headbtn", attr: { "aria-label": "Needs you: open" } });
    headBtn.addEventListener("click", () => this.openArea("needs"));
    this.head(headBtn, "needs", { text: String(items.length), tone: items.length ? items[0].tone : "ok" });
    const body = card.createDiv({ cls: "aos-pulse-tile-body" });
    if (!items.length) { body.createDiv({ cls: "aos-pulse-empty", text: "Nothing needs you. Everything is on schedule." }); return; }
    const list = this.list(body, (n) => `+${n} more · open the list`);
    const ctx = this.ctx();
    const unread = this.unreadIds(m);
    for (const n of items) {
      const r = list.createDiv({ cls: "aos-pulse-li is-act" });
      r.createSpan({ cls: `aos-pulse-dot is-${n.tone}` });
      const t = r.createEl("button", { cls: "aos-pulse-li-title aos-pulse-link", text: n.title, attr: { title: n.title } });
      t.addEventListener("click", () => this.openArea("needs"));
      r.createSpan({ cls: "aos-pulse-li-meta", text: AREA_LABEL[n.area] });
      const age = this.age(n.since, m.now);
      if (age) r.createSpan({ cls: "aos-pulse-li-right", text: age });
      const a = needActions(ctx, n, { unreadIds: unread })[0];
      if (a) r.createEl("button", { cls: `aos-pulse-rowbtn${a.jump ? "" : " mod-cta"}`, text: a.label }).addEventListener("click", () => void a.run());
    }
  }

  private renderHealth(grid: HTMLElement, m: PulseModel): void {
    const s = m.facts.summary.health;
    const pill = s.errors ? { text: pl(s.errors, "error"), tone: "danger" as Tone } : s.warnings ? { text: pl(s.warnings, "warning"), tone: "warn" as Tone } : { text: "all clear", tone: "ok" as Tone };
    const body = this.tile(grid, "health", { pill });
    const line = body.createDiv({ cls: "aos-pulse-line" });
    line.createSpan({ cls: "aos-pulse-strong", text: pl(s.errors, "error") });
    line.createSpan({ cls: "aos-pulse-dim", text: ` · ${pl(s.warnings, "warning")} · ${pl(s.notes, "note")}` });
    const pipes = m.statuses.filter((x) => !x.name.startsWith("routine:"));
    const judged = pipes.filter((x) => x.health !== "neutral");
    this.leds(body, "Pipelines", `${judged.filter((x) => x.health === "ok").length}/${judged.length}`,
      pipes.map((x) => ({ tone: (x.health === "ok" ? "ok" : x.health === "stale" ? "warn" : x.health === "neutral" ? "off" : "danger") as Tone, title: x.detail })));
    this.leds(body, "Routines", `${m.routineRows.filter((r) => r.health === "ok").length}/${m.routineRows.length}`,
      m.routineRows.map((r) => ({ tone: (r.health === "ok" ? "ok" : r.health === "off" ? "off" : r.health === "failed" || r.health === "invalid" ? "danger" : "warn") as Tone, title: `${r.routine.slug}: ${r.health}` })));
    const err = m.facts.needsYou.find((n) => n.area === "health");
    if (err) this.row(this.list(body), { tone: err.tone, title: err.title });
  }

  private leds(body: HTMLElement, label: string, count: string, dots: { tone: Tone; title: string }[]): void {
    const w = body.createDiv({ cls: "aos-pulse-ledrow" });
    const h = w.createDiv({ cls: "aos-pulse-ledhead" });
    h.createSpan({ cls: "aos-pulse-dim", text: label });
    h.createSpan({ cls: "aos-pulse-sp" });
    h.createSpan({ cls: "aos-pulse-mono aos-pulse-dim", text: count });
    const leds = w.createDiv({ cls: "aos-pulse-leds" });
    for (const d of dots) leds.createSpan({ cls: `aos-pulse-led is-${d.tone}`, attr: { title: d.title } });
  }

  private renderAgents(grid: HTMLElement, m: PulseModel): void {
    const body = this.tile(grid, "agents", { pill: m.live.length ? { text: `${m.live.length} live`, tone: "info" } : null });
    const list = this.list(body);
    for (const l of m.live) this.agentRow(list, l.title, l.sub, "info");
    if (m.facts.persona) {
      const beats = Object.entries(m.heartbeat?.beats ?? {});
      const bad = beats.some(([, b]) => b.status === "missed" || b.status === "failed");
      const last = beats.map(([slug, b]) => ({ slug, at: b.lastRunAt ?? "" })).sort((a, b) => b.at.localeCompare(a.at))[0];
      const flags = m.facts.summary.decisions.flags;
      this.agentRow(list, m.facts.persona, `Chief of Staff${last?.at ? ` · ${last.slug} ${formatRelative(last.at)}` : ""}${flags ? ` · ${pl(flags, "flag")}` : ""}`, bad ? "danger" : flags ? "warn" : "ok");
    }
    for (const t of m.teams) this.agentRow(list, t.name, `team · ${pl(t.members, "seat")} · ${t.working ? `${t.working} working` : "idle"}${t.gates ? ` · ${pl(t.gates, "gate")}` : ""}`, t.gates ? "gate" : t.blocked ? "danger" : t.working ? "info" : "off");
    for (const s of [...m.staff].sort((a, b) => b.heartbeatMtime - a.heartbeatMtime).slice(0, 8)) {
      const hb = s.heartbeat;
      const at = hb?.completed_at || hb?.started_at;
      this.agentRow(list, s.name, `${hb?.status ?? "no runs"}${at ? ` · ${formatRelative(at)}` : ""}`, hb?.status === "running" ? "info" : hb?.status === "crashed" || hb?.errored_at ? "danger" : "off");
    }
  }

  private agentRow(list: HTMLElement, name: string, line: string, tone: Tone): void {
    const r = list.createDiv({ cls: "aos-pulse-li is-agent", attr: { title: `${name}: ${line}` } });
    r.createSpan({ cls: "aos-pulse-av sm", text: name.slice(0, 1).toUpperCase(), attr: { "aria-hidden": "true" } });
    const t = r.createDiv({ cls: "aos-pulse-li-stack" });
    t.createSpan({ cls: "aos-pulse-li-title", text: name });
    t.createSpan({ cls: "aos-pulse-li-meta", text: line });
    r.createSpan({ cls: `aos-pulse-dot is-${tone}` });
  }

  private renderWorkspaces(grid: HTMLElement, m: PulseModel): void {
    // Hidden entries (`_` folders, archived ones) stay out of the rows as they do of the count (spaces-redesign D22).
    const ws = visibleWorkspaces(m.snapshot?.workspaces).sort((a, b) => String(b.lastEvent?.iso ?? "").localeCompare(String(a.lastEvent?.iso ?? "")));
    const s = m.facts.summary.workspaces;
    const stalled = ws.filter((w) => w.status === "stalled").length;
    const body = this.tile(grid, "workspaces", { span: 2, note: `${s.total} · ${s.active} active${stalled ? ` · ${stalled} stalled` : ""}` });
    const list = this.list(body);
    for (const w of ws) {
      this.row(list, { tone: this.isLive(w.name) ? "info" : w.status === "active" ? "ok" : "off", title: w.name, meta: w.next?.text ?? w.summary ?? "", right: w.lastEvent?.iso ? this.when(w.lastEvent.iso, m.now) : "" });
    }
  }

  private renderTodo(grid: HTMLElement, m: PulseModel): void {
    const s = m.facts.summary.todo;
    const total = s.open + s.done;
    const pct = total ? Math.round((s.done / total) * 100) : 0;
    const body = this.tile(grid, "todo", { pill: { text: `${s.open} open`, tone: s.overdue ? "warn" : "off" } });
    this.big(body, String(s.done), total ? `done · ${pct}%` : "nothing listed", `/${total}`);
    body.createDiv({ cls: "aos-pulse-bar" }).createSpan({ attr: { style: `width: ${pct}%` } });
    body.createDiv({ cls: "aos-pulse-dim aos-pulse-line", text: s.overdue || s.today ? `${s.overdue} overdue · ${s.today} due today` : "Nothing overdue or due today" });
    const g = groupTodos(m.todos, localDay(m.now));
    const list = this.list(body);
    for (const t of [...g.overdue, ...g.today, ...g.upcoming, ...g.someday]) this.row(list, { tone: g.overdue.includes(t) ? "warn" : null, title: t.text });
  }

  private renderDecisions(grid: HTMLElement, m: PulseModel): void {
    const d = m.decisions;
    const body = this.tile(grid, "proposals", { pill: { text: String(d.length), tone: d.length ? "gate" : "ok" } });
    if (!d.length) { body.createDiv({ cls: "aos-pulse-empty", text: "No decision waits on you." }); return; }
    const first = [...d].sort((a, b) => (b.days ?? -1) - (a.days ?? -1))[0];
    const lead = body.createDiv({ cls: "aos-pulse-lead" });
    lead.createDiv({ cls: "aos-pulse-strong aos-pulse-clip", text: first.title, attr: { title: first.title } });
    lead.createDiv({ cls: "aos-pulse-dim", text: first.days !== null ? `waiting on you for ${pl(first.days, "day")}` : first.sub });
    const list = this.list(body);
    for (const [k, label, tone] of [["proposal", "Proposals", "gate"], ["gate", "Team gates", "gate"], ["flag", "Flags", "warn"], ["drafts", "Feedback drafts", "gate"]] as [string, string, Tone][]) {
      const n = k === "drafts" ? m.inputs.drafts : d.filter((x) => x.kind === k).length;
      this.row(list, { tone: n ? tone : "off", title: label, right: String(n) });
    }
  }

  private renderNotifications(grid: HTMLElement, m: PulseModel): void {
    const s = m.facts.summary.notifications;
    const body = this.tile(grid, "notifications", { pill: s.unread ? { text: `${s.unread} unread`, tone: s.breaking ? "danger" : "info" } : { text: "all read", tone: "ok" } });
    const n0 = m.inputs.notifications[0];
    const latest = s.latest ?? (n0 ? { title: n0.title, from: n0.from, created: n0.created } : null);
    if (latest) {
      const lead = body.createDiv({ cls: "aos-pulse-lead" });
      lead.createDiv({ cls: "aos-pulse-strong aos-pulse-clip", text: latest.title, attr: { title: latest.title } });
      lead.createDiv({ cls: "aos-pulse-dim", text: `${latest.from}${latest.created ? ` · ${this.when(latest.created, m.now)}` : ""}${s.latest ? " · unread" : ""}` });
    }
    const by = new Map<string, number>();
    for (const n of m.inputs.notifications) by.set(n.from || "unknown", (by.get(n.from || "unknown") ?? 0) + 1);
    const max = Math.max(1, ...by.values());
    const list = this.list(body);
    for (const [from, n] of [...by.entries()].sort((a, b) => b[1] - a[1])) {
      const r = list.createDiv({ cls: "aos-pulse-li is-bar" });
      r.createSpan({ cls: "aos-pulse-li-title", text: from });
      r.createSpan({ cls: "aos-pulse-bar" }).createSpan({ attr: { style: `width: ${Math.max(3, Math.round((n / max) * 100))}%` } });
      r.createSpan({ cls: "aos-pulse-li-right", text: String(n) });
    }
  }

  private renderRoutines(grid: HTMLElement, m: PulseModel): void {
    const s = m.facts.summary.routines;
    const ok = m.routineRows.filter((r) => r.health === "ok").length;
    const body = this.tile(grid, "routines", { pill: s.failing ? { text: `${s.failing} failing`, tone: "danger" } : { text: `${ok} green`, tone: "ok" } });
    body.createDiv({ cls: "aos-pulse-dim aos-pulse-line", text: "Next up" });
    const list = this.list(body);
    const next = m.routineRows.filter((r) => r.routine.enabled !== false && r.next[0]).sort((a, b) => a.next[0].getTime() - b.next[0].getTime());
    for (const r of next) this.row(list, { title: r.routine.slug, meta: r.routine.name ?? "", right: clock(r.next[0]) });
  }

  private renderSpend(grid: HTMLElement, m: PulseModel): void {
    const s = m.facts.summary.spend;
    const week = m.spendDays.reduce((n, d) => n + d.usd, 0);
    const body = this.tile(grid, "spend", { note: `${pl(s.calls, "call")} today` });
    this.big(body, `$${s.usd.toFixed(2)}`, "today");
    const bars = body.createDiv({ cls: "aos-pulse-bars" });
    const max = Math.max(0.01, ...m.spendDays.map((d) => d.usd));
    m.spendDays.forEach((d, i) => {
      const col = bars.createDiv({ cls: "aos-pulse-barcol", attr: { title: `${d.day}: $${d.usd.toFixed(2)}` } });
      col.createSpan({ cls: `aos-pulse-barfill${i === m.spendDays.length - 1 ? " is-today" : ""}`, attr: { style: `height: ${Math.round((d.usd / max) * 100)}%` } });
      col.createSpan({ cls: "aos-pulse-barday", text: new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: "narrow" }) });
    });
    body.createDiv({ cls: "aos-pulse-dim aos-pulse-line", text: m.costActive ? m.costLine : `$${week.toFixed(2)} over 7 days` });
  }

  /**
   * Brain (brain-hub D15, canvas PulseAfter): today's writes and those since Review was last open, then three numbers that
   * each open a mode of the Brain tab, and a way into Review. A card, as Needs you is: its head opens the popup, and no
   * button holds another.
   */
  private renderBrain(grid: HTMLElement, m: PulseModel): void {
    const card = grid.createDiv({ cls: "aos-pulse-tile is-card", attr: { "data-area": "memory" } });
    const headBtn = card.createEl("button", { cls: "aos-pulse-tile-headbtn", attr: { "aria-label": `${AREA_LABEL.memory}: open` } });
    headBtn.addEventListener("click", () => this.openArea("memory"));
    this.head(headBtn, "memory", null);
    const body = card.createDiv({ cls: "aos-pulse-tile-body" });
    this.big(body, String(m.facts.summary.memory.writtenToday), brainTodayLabel(m.brain.sinceLooked));
    const links = body.createDiv({ cls: "aos-pulse-brainlinks" });
    for (const l of brainLinks({ toReview: m.inputs.toReview ?? null, drafts: m.inputs.drafts, brainPct: m.inputs.brainPct ?? null })) {
      const b = links.createEl("button", { cls: `aos-pulse-brainlink is-${l.tone}`, attr: { "data-brain-link": l.id, title: `${l.row} · opens ${l.dest}` } });
      b.createSpan({ cls: "aos-pulse-brainlink-n", text: l.value });
      b.createSpan({ cls: "aos-pulse-brainlink-k", text: `${l.label} →` });
      b.addEventListener("click", () => openBrain(this.ctx(), l.target));
    }
    const go = body.createEl("button", { cls: "aos-pulse-brainreview", attr: { "data-brain-link": "today" }, text: brainReviewLabel(m.brain.pendingToday) });
    go.addEventListener("click", () => openBrain(this.ctx(), { mode: "review", queue: "session" }));
  }

  // ── fitting rows to the height (P2) ──

  private scheduleFit(): void {
    if (this.fitFrame !== null) return;
    this.fitFrame = window.requestAnimationFrame(() => { this.fitFrame = null; this.fit(); });
  }

  /** Every list shows the rows its height holds; the rest become "+N more". The headline numbers never move. */
  private fit(): void {
    if (!this.root) return;
    for (const list of Array.from(this.root.querySelectorAll<HTMLElement>(".aos-pulse-list"))) {
      const rows = Array.from(list.children) as HTMLElement[];
      for (const r of rows) r.style.display = "";
      const limit = list.clientHeight;
      let hidden = 0;
      for (const r of rows) if (r.offsetTop + r.offsetHeight > limit + 1) { r.style.display = "none"; hidden++; }
      const more = list.nextElementSibling as (HTMLElement & { _more?: (n: number) => string }) | null;
      if (more?.classList.contains("aos-pulse-more")) {
        more.textContent = hidden > 0 && more._more ? more._more(hidden) : "";
        more.toggleClass("is-empty", hidden <= 0);
      }
    }
  }

  // ── the Fix Queue (now in the Health area) and ⌘K ──

  /** Live Fix Queue snapshot for ⌘K (openOmni) — a copy, so callers can't mutate it. */
  getFixActions(): FixAction[] { return [...(this.model?.queue ?? [])]; }

  /** Runs a Fix Queue action: from ⌘K, the Health area or a needs-you row. */
  execute(a: FixAction): void {
    if (a.kind === "spawn" && a.script) {
      this.plugin.runBrainScript(a.script, a.args ?? [], () => this.schedule());
    } else if (a.kind === "anchor-modal" && this.model?.costActive) {
      new AnchorModal(this.plugin.app, (usd) => {
        this.plugin.runBrainScript("brain/scripts/cost-budget.js", ["--anchor", String(usd)], () => this.schedule());
      }).open();
    } else if (a.kind === "open-file" && a.path) {
      void this.plugin.app.workspace.openLinkText(a.path, "", true);
    }
  }

  unmount(): void {
    // "Since you last looked" (P10) counts from here.
    this.plugin.settings.pulseSeenAt = new Date().toISOString();
    void this.plugin.saveSettings();
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = null;
    this.resize?.disconnect();
    this.resize = null;
    this.host?.empty();
    this.host = null;
    this.root = null;
  }
}
