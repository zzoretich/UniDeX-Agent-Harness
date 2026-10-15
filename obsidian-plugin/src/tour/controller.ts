// The tour in the Workbench (tour C1, C6, C9, C12): the commands (the palette, and the app's Help menu, built from
// them), the rail's Help menu and Getting started item, the chip a tab's first visit shows, and the checklist and
// What's new drawers. The engine does the spotlight; this decides what runs, remembers it in the HUD's settings
// (`tour`, state.ts) and draws the small pieces around it. No bridge call and no write surface: the only write is
// saveData.
import { Notice, setIcon } from "obsidian";
import type AgenticOSPlugin from "../../main";
import { VIEW_TYPE_WORKBENCH, WorkbenchView } from "../views/WorkbenchView";
import { invocationHint, readAgenticosJson, sessionHosts } from "../data/aosConfig";
import type { BrainMode } from "../data/brainModel";
import type { SpacesPane } from "../data/statusline";
import { shell } from "../host";
import { TourEngine, type ProbeResult, type TourEnd, type TourItem } from "./engine";
import { fillText, holds, type TourContext } from "./predicates";
import { BOOK, chapterById, chapterForTab, resolveRefs, type TourChapter, type TourStep } from "./steps";
import {
  markCompleted, markDismissed, markDone, markLaunched, markOffered, markSeen, sanitizeTourState, setChecklistDismissed, type TourState,
} from "./state";
import { buildChecklist, detectDone, type CacheReader } from "./checklist";
import { WHATS_NEW, whatsNewHistory } from "./whatsnew";

/** The tour's commands (ids under the plugin's own, so "agentic-os:tour-start"…); the app's Help menu lists these. */
export const TOUR_COMMANDS = [
  { id: "tour-start", name: "Take the tour" },
  { id: "tour-tab", name: "Tour this tab" },
  { id: "whats-new", name: "What's new" },
  { id: "getting-started", name: "Getting started" },
  { id: "docs", name: "Documentation" },
] as const;

/** Help ▸ Docs: the README on GitHub (the CSP keeps the page off the network; the browser opens it). */
export const DOCS_URL = "https://github.com/zzoretich/UniDeX-Agent-Harness#readme";

/** How long a tab stays shown before its first visit's chip appears (a tab passed through on the way gets none). */
const CHIP_DELAY_MS = 700;

export class TourController {
  readonly engine: TourEngine;
  private railSlot: HTMLElement | null = null;
  private chipEl: HTMLElement | null = null;
  private chipTimer: number | null = null;
  private menuEl: HTMLElement | null = null;
  private menuOff: (() => void) | null = null;
  private ctxCache: { at: number; ctx: TourContext } | null = null;
  private detecting = false;

  constructor(private readonly plugin: AgenticOSPlugin) {
    this.engine = new TourEngine({
      doc: document,
      route: (step) => this.route(step),
      context: () => this.context(),
    });
  }

  // ── state ──

  state(): TourState { return sanitizeTourState(this.plugin.settings.tour); }

  private save(next: TourState): void {
    this.plugin.settings.tour = next;
    void this.plugin.saveSettings();
    this.ctxCache = null;
    this.renderRail();
  }

  /** What step text and `when` read on this Mac, read again at most once a second. */
  context(): TourContext {
    const now = Date.now();
    if (this.ctxCache && now - this.ctxCache.at < 1000) return this.ctxCache.ctx;
    let cfg: ReturnType<typeof readAgenticosJson> = null;
    try { cfg = readAgenticosJson(this.plugin.claudeConfigDir()); } catch { /* unreadable: Claude Code only, as sessionHosts reads it */ }
    let chat = false;
    try { chat = this.plugin.chatAvailable(); } catch { /* no provider state */ }
    let sessions = chat;
    try { sessions = this.plugin.sessionsShown(); } catch { /* as chat */ }
    const base: TourContext = { hosts: sessionHosts(cfg), chat, sessions, checklist: false, cmd: (name) => invocationHint(name, cfg) };
    base.checklist = buildChecklist(BOOK, this.state(), base).shown;
    this.ctxCache = { at: now, ctx: base };
    return base;
  }

  // ── the Workbench ──

  private async view(): Promise<WorkbenchView | null> {
    await this.plugin.activate(VIEW_TYPE_WORKBENCH);
    const leaf = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
    if (leaf && typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
    const v = leaf?.view;
    return v instanceof WorkbenchView ? v : null;
  }

  private shownView(): WorkbenchView | null {
    const v = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0]?.view;
    return v instanceof WorkbenchView ? v : null;
  }

  /** A step's route: the Workbench in front, then its tab (and Brain mode or Spaces pane) through open(). */
  private async route(step: TourStep): Promise<boolean> {
    const v = await this.view();
    if (!v) return false;
    if (!step.tab) return true;
    // steps.ts validateBook holds mode to a Brain mode and pane to a Spaces pane.
    return v.open({ tab: step.tab, mode: (step.mode ?? null) as BrainMode | null, pane: (step.pane ?? null) as SpacesPane | null });
  }

  // ── running chapters ──

  private items(chapter: TourChapter): TourItem[] { return chapter.steps.map((step) => ({ chapter, step })); }

  /** Runs a chapter; `after` runs once it ends, however it ends. */
  startChapter(id: string, after?: (how: TourEnd) => void): boolean {
    const chapter = chapterById(BOOK, id);
    if (!chapter || !holds(chapter.when, this.context())) return false;
    this.hideChip();
    this.closeMenu();
    this.shownView()?.closeDrawer();
    this.engine.run(this.items(chapter), {
      chapter: chapter.id,
      onEnd: (how) => {
        if (how === "done") this.save(markCompleted(this.state(), chapter.id));
        else if (how === "skipped") this.save(markDismissed(this.state(), chapter.id));
        after?.(how);
      },
    });
    return true;
  }

  /**
   * The welcome tour (Help ▸ Take the tour, and a new install's first launch): it ends by opening Getting started. The
   * first run also records this release as seen, so What's new later starts from it. `after` runs once it ends.
   */
  startCore(after?: (how: TourEnd) => void): void {
    const s = this.state();
    if (!s.lastSeenVersion) this.save(markSeen(s, this.plugin.manifest.version));
    const started = this.startChapter(BOOK.core, (how) => { if (how !== "stopped") this.openChecklist(); after?.(how); });
    if (!started) after?.("stopped");
  }

  // ── the launch sequence (tour C11, ui/launchSequence.ts) ──

  /** A launch dialog was shown: it never opens on its own again. */
  rememberLaunch(id: string): void { this.save(markLaunched(this.state(), id)); }

  /** What's new for the running release was shown. */
  markSeenNow(): void { this.save(markSeen(this.state(), this.plugin.manifest.version)); }

  /** Getting started at the end of the launch sequence: only while it is shown (not put away, something left). */
  openChecklistIfShown(): void {
    this.ctxCache = null;
    if (this.context().checklist) this.openChecklist();
  }

  /** Help ▸ Tour this tab: the chapter for the tab in front (and for Brain, its mode). */
  tourThisTab(): void {
    const v = this.shownView();
    const tab = v?.activeTabId() ?? "pulse";
    const mode = tab === "memory" ? document.querySelector(".aos-wb-content .aos-brain-body[data-mode]")?.getAttribute("data-mode") ?? null : null;
    const chapter = chapterForTab(BOOK, tab, mode);
    if (!chapter || !this.startChapter(chapter.id)) new Notice("This tab has no tour yet.");
  }

  /** Runs What's new entries' steps ("Show me"); `after` runs once they end. */
  showMe(refs: string[], after?: (how: TourEnd) => void): void {
    const items = resolveRefs(BOOK, refs);
    if (!items.length) { after?.("stopped"); return; }
    this.shownView()?.closeDrawer();
    this.engine.run(items, { chapter: null, onEnd: after });
  }

  /** e2e: routes each step of a chapter and says whether its control showed, was gated, or was missing. */
  probe(id: string, waitMs?: number): Promise<ProbeResult[]> {
    const chapter = chapterById(BOOK, id);
    return chapter ? this.engine.probe(this.items(chapter), waitMs) : Promise.resolve([]);
  }

  // ── commands ──

  registerCommands(): void {
    const run: Record<(typeof TOUR_COMMANDS)[number]["id"], () => void> = {
      "tour-start": () => this.startCore(),
      "tour-tab": () => { void this.view().then(() => this.tourThisTab()); },
      "whats-new": () => { void this.view().then(() => this.openWhatsNew()); },
      "getting-started": () => { void this.view().then(() => this.openChecklist()); },
      docs: () => { void shell.openExternal(DOCS_URL); },
    };
    for (const c of TOUR_COMMANDS) this.plugin.addCommand({ id: c.id, name: c.name, callback: run[c.id] });
  }

  // ── the rail: Help and Getting started ──

  /** WorkbenchView's rail foot: the slot Getting started is drawn in (it comes and goes) and the Help button. */
  mountRail(slot: HTMLElement): void {
    this.railSlot = slot;
    this.renderRail();
    void this.detect();
  }

  unmountRail(): void {
    this.railSlot = null;
    this.hideChip();
    this.closeMenu();
  }

  /** Getting started n/m, while it is not put away and something is left. */
  renderRail(): void {
    const slot = this.railSlot;
    if (!slot) return;
    slot.empty();
    const list = buildChecklist(BOOK, this.state(), this.context());
    if (!list.shown) return;
    const label = `Getting started ${list.done}/${list.total}`;
    const b = slot.createDiv({ cls: "aos-wb-railact aos-tour-railchecklist", attr: { "data-action": "checklist", "aria-label": label, title: label, role: "button", tabindex: "0" } });
    const icon = b.createDiv({ cls: "aos-wb-railicon" });
    setIcon(icon, "list-checks");
    b.createDiv({ cls: "aos-tour-railcount", text: `${list.done}/${list.total}`, attr: { "aria-hidden": "true" } });
    const open = (): void => this.openChecklist();
    b.addEventListener("click", open);
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  }

  /** The rail's Help button opens this menu beside it. */
  toggleMenu(anchor: HTMLElement): void {
    if (this.menuEl) { this.closeMenu(true, anchor); return; }
    const doc = anchor.ownerDocument;
    const menu = doc.body.createDiv({ cls: "aos-tour-menu", attr: { role: "menu", "aria-label": "Help" } });
    this.menuEl = menu;
    const rows: HTMLElement[] = [];
    const item = (key: string, label: string, detail: string, run: () => void): void => {
      const b = menu.createEl("button", { cls: "aos-tour-menuitem", attr: { type: "button", role: "menuitem", tabindex: "-1", "data-key": key } });
      b.createSpan({ cls: "aos-tour-menulabel", text: label });
      b.createSpan({ cls: "aos-tour-menudetail", text: detail });
      b.addEventListener("click", (e) => { e.preventDefault(); this.closeMenu(true, anchor); run(); });
      rows.push(b);
    };
    item("tour-start", "Take the tour", "The ten-step welcome tour", () => this.startCore());
    item("tour-tab", "Tour this tab", "Every control on the tab you are on", () => this.tourThisTab());
    item("whats-new", "What's new", "What changed in each update", () => this.openWhatsNew());
    item("getting-started", "Getting started", "Your checklist", () => this.openChecklist());
    item("docs", "Documentation", "The README on GitHub", () => { void shell.openExternal(DOCS_URL); });
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.round(r.right + 8)}px`;
    const h = menu.offsetHeight || 220;
    menu.style.top = `${Math.round(Math.max(8, Math.min(r.top, (doc.defaultView?.innerHeight ?? 800) - h - 8)))}px`;
    anchor.setAttribute("aria-expanded", "true");
    const onDown = (e: Event): void => {
      const t = e.target as Node | null;
      if (t && (menu.contains(t) || anchor.contains(t))) return;
      this.closeMenu(false, anchor);
    };
    doc.addEventListener("pointerdown", onDown, true);
    menu.addEventListener("keydown", (e) => {
      const i = rows.indexOf(doc.activeElement as HTMLElement);
      if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); this.closeMenu(true, anchor); }
      else if (e.key === "ArrowDown") { e.preventDefault(); rows[(i + 1) % rows.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); rows[(i - 1 + rows.length) % rows.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); rows[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); rows[rows.length - 1].focus(); }
    });
    this.menuOff = () => doc.removeEventListener("pointerdown", onDown, true);
    rows[0]?.focus();
  }

  private closeMenu(refocus = false, anchor?: HTMLElement): void {
    const m = this.menuEl;
    if (!m) return;
    this.menuOff?.();
    this.menuOff = null;
    m.remove();
    this.menuEl = null;
    anchor?.setAttribute("aria-expanded", "false");
    if (refocus) anchor?.focus();
  }

  // ── the first visit's chip ──

  /** WorkbenchView.setTab: a tab's first visit offers its chapter once, as a chip (never during a tour or a modal). */
  tabShown(tab: string): void {
    this.hideChip();
    const s = this.state();
    if (s.offered.includes(tab) || this.engine.running()) return;
    const chapter = chapterForTab(BOOK, tab);
    if (!chapter || s.completed.includes(chapter.id) || !holds(chapter.when, this.context())) return;
    this.chipTimer = window.setTimeout(() => {
      this.chipTimer = null;
      const v = this.shownView();
      if (!v || v.activeTabId() !== tab || this.engine.running() || document.querySelector(".modal-container")) return;
      this.showChip(v, tab, chapter);
    }, CHIP_DELAY_MS);
  }

  private showChip(v: WorkbenchView, tab: string, chapter: TourChapter): void {
    this.save(markOffered(this.state(), tab));
    const host = v.getChipHost();
    const chip = host.createDiv({ cls: "aos-tour-chip", attr: { role: "status", "data-chapter": chapter.id } });
    this.chipEl = chip;
    chip.createSpan({ cls: "aos-tour-chiptext", text: `New to ${chapter.title}?` });
    const go = chip.createEl("button", { cls: "aos-tour-chipgo", text: "Take the tour", attr: { type: "button" } });
    go.addEventListener("click", () => { this.hideChip(); this.startChapter(chapter.id); });
    const x = chip.createEl("button", { cls: "aos-tour-chipx", text: "✕", attr: { type: "button", "aria-label": "Not now" } });
    x.addEventListener("click", () => this.hideChip());
  }

  hideChip(): void {
    if (this.chipTimer !== null) { window.clearTimeout(this.chipTimer); this.chipTimer = null; }
    this.chipEl?.remove();
    this.chipEl = null;
  }

  // ── Getting started ──

  /** Ticks the actions the runtime's caches show done. */
  async detect(): Promise<void> {
    if (this.detecting) return;
    this.detecting = true;
    try {
      const a = this.plugin.app.vault.adapter;
      const reader: CacheReader = {
        read: async (p) => { try { return (await a.exists(p)) ? await a.read(p) : null; } catch { return null; } },
        list: async (d) => { try { return (await a.exists(d)) ? (await a.list(d)).files : []; } catch { return []; } },
      };
      const done = await detectDone(BOOK.actions, this.state(), reader);
      if (done.length) this.save(markDone(this.state(), done, new Date()));
    } finally { this.detecting = false; }
  }

  /** Opens the drawer (and brings the rail item back if it was put away). */
  openChecklist(): void {
    const v = this.shownView();
    if (!v) return;
    if (this.state().checklist.dismissed) this.save(setChecklistDismissed(this.state(), false));
    v.openDrawer("GETTING STARTED", (host) => this.renderChecklist(host));
    void this.detect().then(() => {
      const body = document.querySelector<HTMLElement>(".aos-wb-drawer .aos-tour-checklist");
      if (body?.parentElement) { const parent = body.parentElement; parent.empty(); this.renderChecklist(parent); }
    });
  }

  private renderChecklist(host: HTMLElement): void {
    const ctx = this.context();
    const list = buildChecklist(BOOK, this.state(), ctx);
    const root = host.createDiv({ cls: "aos-tour-checklist" });
    const head = root.createDiv({ cls: "aos-tour-cl-head" });
    head.createDiv({ cls: "aos-tour-cl-count", text: `${list.done} of ${list.total} done` });
    const bar = head.createDiv({ cls: "aos-tour-cl-bar", attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(list.total), "aria-valuenow": String(list.done), "aria-label": "Getting started" } });
    bar.createDiv({ cls: "aos-tour-cl-fill" }).style.width = `${list.total ? Math.round((list.done / list.total) * 100) : 0}%`;
    const section = (title: string, kind: "chapter" | "action"): void => {
      const items = list.items.filter((i) => i.kind === kind);
      if (!items.length) return;
      root.createDiv({ cls: "aos-tour-cl-section", text: title });
      const ul = root.createEl("ul", { cls: "aos-tour-cl-list" });
      for (const it of items) {
        const li = ul.createEl("li", { cls: `aos-tour-cl-item${it.done ? " is-done" : ""}`, attr: { "data-task": it.id } });
        li.createSpan({ cls: "aos-tour-cl-mark", text: it.done ? "✓" : "", attr: { "aria-hidden": "true" } });
        const what = li.createDiv({ cls: "aos-tour-cl-what" });
        const title = fillText(it.title, ctx);
        what.createDiv({ cls: "aos-tour-cl-title", text: title });
        what.createDiv({ cls: "aos-tour-cl-body", text: fillText(it.body, ctx) });
        if (it.done) li.setAttr("aria-label", `${title}, done`);
        if (it.chapter) {
          const chapter = it.chapter;
          const b = li.createEl("button", { cls: "aos-tour-cl-go", text: it.kind === "chapter" ? (it.done ? "Again" : "Start") : "Show me", attr: { type: "button" } });
          b.addEventListener("click", () => { this.startChapter(chapter, (how) => { if (how === "done") this.openChecklist(); }); });
        }
      }
    };
    section("TOURS", "chapter");
    section("FIRST STEPS", "action");
    const foot = root.createDiv({ cls: "aos-tour-cl-foot" });
    if (list.done >= list.total) foot.createDiv({ cls: "aos-tour-cl-note", text: "All done. Help ▸ Getting started brings this back." });
    const hide = foot.createEl("button", { cls: "aos-tour-cl-hide", text: "Hide checklist", attr: { type: "button", title: "Help ▸ Getting started brings it back" } });
    hide.addEventListener("click", () => {
      this.save(setChecklistDismissed(this.state(), true));
      this.shownView()?.closeDrawer();
    });
  }

  // ── What's new ──

  /** Help ▸ What's new: every release's entries, newest first; seeing them records this release as seen. */
  openWhatsNew(): void {
    const v = this.shownView();
    if (!v) return;
    this.save(markSeen(this.state(), this.plugin.manifest.version));
    v.openDrawer("WHAT'S NEW", (host) => {
      const root = host.createDiv({ cls: "aos-tour-whatsnew" });
      const releases = whatsNewHistory(WHATS_NEW.releases, this.plugin.manifest.version);
      if (!releases.length) {
        root.createDiv({ cls: "aos-tour-wn-empty", text: "Nothing new to show yet. Each update lists its changes here, with a Show me for the ones you can see." });
        return;
      }
      for (const r of releases) {
        root.createDiv({ cls: "aos-tour-wn-version", text: `What's new in ${r.version}` });
        for (const e of r.entries) {
          const card = root.createDiv({ cls: "aos-tour-wn-entry", attr: { "data-entry": e.id } });
          card.createDiv({ cls: "aos-tour-wn-title", text: e.title });
          card.createDiv({ cls: "aos-tour-wn-body", text: e.body });
          if (e.steps.length) {
            const b = card.createEl("button", { cls: "aos-tour-wn-show", text: "Show me", attr: { type: "button" } });
            b.addEventListener("click", () => this.showMe(e.steps));
          }
        }
      }
    });
  }
}
