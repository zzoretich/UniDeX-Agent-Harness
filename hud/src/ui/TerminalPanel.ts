// TerminalPanel — embeddable terminal component.
// Renders the panel chrome (header with tabs and the New button, body with xterm, optional drag handle) inside a host
// element. Each session gets its own xterm; only the active one is visible. The pool keeps which one is selected, so a
// tab switch, a launch from another tab or the Pulse strip all show the same terminal (spec 2026-10-08-term-agent-deck).
// The deck docks the Computer pane right of the terminal, following the selected terminal's place (agent-computer D4,
// D32); its rows show the Computer's dot and "waiting" (D35).
// An agent terminal opens in its chat (spec 2026-11-09-code-chat C1, C3, C13): the CodeChat lies over the terminal's body,
// which stays laid out, hidden, at its last size, so ⌘J (or the top bar's Chat | Terminal switch) flips to the same live
// PTY at once and nothing restarts. Each terminal remembers its view (CodeFeeds); a shell has no chat and no switch; with
// the Code chat surface off an agent opens in its terminal and the switch says so. When an agent exits and the login shell
// takes its terminal over (D18), its chat keeps the history and says so, with no composer; its terminal view's composer is
// a shell's (code-chat R39).

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import type AgenticOSPlugin from "../../main";
import { TerminalSession, hasChat } from "../data/terminalSession";
import type { LaunchNote } from "../data/terminalLauncher";
import { listen } from "../data/listen";
import { TERMINAL_FONT, currentTheme, onThemeChange, xtermTheme } from "./theme";
import { NewTerminalMenu, type NewTerminalActions } from "./NewTerminalMenu";
import { Notice } from "obsidian";
import { TermList } from "./TermList";
import { TermComposer } from "./TermComposer";
import { TermFind } from "./TermFind";
import { FIND_LIMIT } from "../data/termFind";
import { hudHost, shell } from "../host";
import { ConfirmModal } from "./ConfirmModal";
import { groupKey, scopeOf, stepRow } from "../data/termGroups";
import { restartKeepingOld } from "../data/terminalRestart";
import { CodeSidebarModel } from "../data/codeSidebarModel";
import { vaultPlace, workspacePlace, type Place, type TermAccess } from "../data/terminalLaunch";
import { ComputerPane } from "./ComputerPane";
import { storeFor, type ComputerStore, type RowMarks } from "../data/computerStore";
import { computerPaneStart, rememberComputerPane } from "../settingsDefaults";
import { CodeStage } from "./CodeStage";
import { CodeTopBar } from "./CodeTopBar";
import type { CodeView } from "../data/codeFeeds";

interface XtermBinding {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  container: HTMLElement;
  detachData: () => void;
}

export interface TerminalPanelOptions {
  resizable: boolean;          // show drag handle on bottom edge
  initialHeight?: number;
  onHeightChange?: (h: number) => void;
  onClose?: () => void;        // panel-level close (collapses the strip)
  showMaximize?: boolean;
  onMaximize?: () => void;
  fullPane?: boolean;          // render in full-pane mode (no drag handle, fills container)
  /** What the New button starts through (the Workbench view's launches); no New button without it. */
  launch?: NewTerminalActions;
  /** The Term tab's deck (spec 2026-10-08-term-agent-deck T1): a grouped list beside the terminal instead of tabs. */
  deck?: boolean;
  /** The deck's Open workspace on a workspace group: Spaces on that workspace (spaces-redesign D12). */
  openWorkspace?: (name: string) => void;
  /** The sidebar's All history: Sessions ▸ History. */
  openHistory?: () => void;
}

/** How long the "Started … · Change" note stays after a launch. */
const STARTED_MS = 6000;
/** The terminal view's composer height (px) until one is measured: a rough figure, the first ⌘J corrects it. */
const TERM_COMPOSER_H = 200;

export class TerminalPanel {
  private plugin: AgenticOSPlugin;
  private opts: TerminalPanelOptions;
  private host: HTMLElement | null = null;

  private headerEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private noteEl: HTMLElement | null = null;
  private noteTimer: number | null = null;
  private newMenu: NewTerminalMenu | null = null;
  private list: TermList | null = null;
  private composer: TermComposer | null = null;
  /** Terminals whose chip pick is restarting them now (a second pick waits). */
  private restarting = new Set<string>();
  private finder: TermFind | null = null;
  /** The sidebar's groups and what rows and the top bar read of a terminal; the top bar; the stage with the chats. */
  private model: CodeSidebarModel;
  private topBar: CodeTopBar;
  private stage: CodeStage;
  /** The deck's Computer pane (agent-computer D4), in the app only; its store gives the rows their marks (D32, D35). */
  private computer: ComputerPane | null = null;
  private computerStore: ComputerStore | null = null;
  private unwatchComputer: (() => void) | null = null;
  /** The rows' marks as last drawn, so a computer's state that changes none of them redraws nothing. */
  private marksShown = "";
  /** The rows' status and conversation as last drawn, so a chat that changes neither redraws no list (I2). */
  private rowsShown = "";
  private unwatchFeeds: (() => void) | null = null;

  private bindings = new Map<string, XtermBinding>();
  private activeId: string | null = null;
  private resizeObs: ResizeObserver | null = null;
  private disposePool: (() => void) | null = null;
  private disposeTheme: (() => void) | null = null;
  private height: number;

  constructor(plugin: AgenticOSPlugin, opts: TerminalPanelOptions) {
    this.plugin = plugin;
    this.opts = opts;
    this.height = opts.initialHeight ?? 280;
    this.model = new CodeSidebarModel(plugin, {
      filter: () => this.list?.query() ?? "",
      changed: () => { if (this.host) this.renderTabs(); },
    });
    this.stage = new CodeStage(plugin, {
      activeId: () => this.activeId,
      activeSession: () => this.activeSession(),
      composer: () => this.composer,
      setView: (v) => this.setView(v),
      openLink: (href) => this.openLink(href),
      renderTabs: () => this.renderTabs(),
    });
    this.topBar = new CodeTopBar(plugin, this.model, this.stage, {
      activeSession: () => this.activeSession(),
      composer: () => this.composer,
      computer: () => this.computer,
      startIn: (place, host, resume) => this.startIn(place, host, resume),
      setView: (v) => this.setView(v),
      makeWorkspace: (named) => this.newMenu?.open("create", null, named),
      restartWith: (id, patch) => this.restartWith(id, patch),
      renderTabs: () => this.renderTabs(),
    });
  }

  mount(host: HTMLElement): void {
    this.host = host;
    host.empty();
    host.addClass("aos-term");
    if (this.opts.fullPane) host.addClass("aos-term-fullpane");
    if (!this.opts.fullPane) host.style.height = `${this.height}px`;

    // header (the deck: the list on the left, then the selected terminal's header over its body)
    let frame: HTMLElement = host;
    if (this.opts.deck) {
      host.addClass("aos-term-deck");
      const aside = host.createDiv({ cls: "aos-tl" });
      aside.createDiv({ cls: "aos-tl-head" }).createSpan({ cls: "aos-term-title", text: "Code" });
      if (this.opts.launch) {
        this.newMenu = new NewTerminalMenu(aside.createDiv({ cls: "aos-tl-new" }), this.plugin.termLauncher, this.opts.launch, true);
        this.newMenu.el.addClass("is-left");
      }
      this.list = new TermList(aside, {
        select: (id) => this.activate(id),
        close: (id) => this.closeSession(id),
        startIn: (g) => this.startIn(g.place ?? vaultPlace(this.model.world()), "quick"),
        clearEnded: () => { for (const s of this.plugin.terminalPool.list()) if (s.isExited) this.plugin.terminalPool.remove(s.id); },
        openWorkspace: this.opts.openWorkspace ? (name) => this.opts.openWorkspace?.(name) : undefined,
        clearScope: () => { this.model.scope = null; this.renderTabs(); },
        mark: (id) => this.marks(id),
        openPast: (h) => this.stage.showPast({ key: h.key, host: h.host, id: h.id, title: h.title, place: h.place, resume: h.resume }),
        openClosed: (r) => { if (r.sessionId && r.host !== "shell") this.stage.showPast({ key: `closed:${r.host}:${r.sessionId}`, host: r.host, id: r.sessionId, title: r.title, place: r.place, resume: { state: "on", place: r.place, hint: "" } }); },
        showMore: (key) => { this.model.extra[key] = (this.model.extra[key] ?? 0) + 10; this.renderTabs(); },
        allHistory: this.opts.openHistory ? () => this.opts.openHistory?.() : undefined,
      }, () => this.renderTabs());
      this.model.start();
      frame = host.createDiv({ cls: "aos-term-main", attr: { "data-tour": "code-main" } });
    }
    this.headerEl = frame.createDiv({ cls: "aos-term-header", attr: { "data-tour": "code-header" } });
    const left = this.headerEl.createDiv({ cls: "aos-term-header-left" });
    if (this.opts.deck) this.topBar.headMainEl = left.createDiv({ cls: "aos-term-head" });
    else left.createSpan({ cls: "aos-term-title", text: "Terminal" });
    this.tabsEl = this.headerEl.createDiv({ cls: "aos-term-tabs" });

    const right = this.headerEl.createDiv({ cls: "aos-term-header-right" });
    if (this.opts.launch && !this.opts.deck) this.newMenu = new NewTerminalMenu(right, this.plugin.termLauncher, this.opts.launch);
    if (this.opts.deck) this.topBar.viewEl = right.createDiv({ cls: "aos-term-view" });

    if (this.opts.showMaximize && this.opts.onMaximize) {
      const max = right.createEl("button", { cls: "aos-term-btn", text: "⛶" });
      max.setAttr("title", "Open in dedicated tab");
      max.addEventListener("click", () => { this.opts.onMaximize?.(); });
    }
    if (this.opts.onClose) {
      const close = right.createEl("button", { cls: "aos-term-btn aos-term-btn-close", text: "▾" });
      close.setAttr("title", "Collapse panel");
      close.addEventListener("click", () => { this.opts.onClose?.(); });
    }

    // body (the deck: on a stage the chat lies over, so the terminal keeps its size while the chat shows)
    if (this.opts.deck) {
      this.bodyEl = this.stage.mount(frame);
      this.composer = new TermComposer(frame, this.plugin, () => this.focus(), () => this.bracketedPaste());
      this.composer.onCatalog = () => { if (this.host) this.topBar.renderHostChip(); };
      this.finder = new TermFind(this.bodyEl, () => this.focus());
      this.mountComputer(host);
      this.unwatchFeeds = this.plugin.codeFeeds?.subscribe((id) => {
        if (!this.host) return;
        // Any terminal's chat moves its row (Working, Idle) and the conversation it is in: the list redraws when a row
        // would read differently, the selected one or not.
        if (this.list && this.model.rowsSig() !== this.rowsShown) this.renderTabs();
        if (id !== this.activeId) return;
        this.stage.renderChat();
        this.topBar.renderHostChip();
      }) ?? null;
    } else {
      this.bodyEl = frame.createDiv({ cls: "aos-term-body" });
    }

    // drag handle
    if (this.opts.resizable && !this.opts.fullPane) {
      const handle = host.createDiv({ cls: "aos-term-handle" });
      this.bindDragResize(handle, host);
    }

    // ensure at least one session (an empty Term tab or Pulse strip opens a shell: spec T13)
    const pool = this.plugin.terminalPool;
    if (!pool || pool.list().length === 0) {
      if (pool) {
        try { pool.create(); }
        catch (e) { this.renderError(e); return; }
      }
    }
    if (!pool) { this.renderError(new Error("Terminal pool not initialized")); return; }

    this.activeId = pool.selectedId();
    this.renderTabs();
    if (this.activeId) this.ensureBindingForActive();

    // resize observer
    this.resizeObs = new ResizeObserver(() => this.refit());
    this.resizeObs.observe(this.bodyEl);

    // xterm paints a canvas from literal colours, so a theme switch repaints every open terminal
    this.disposeTheme?.();
    this.disposeTheme = onThemeChange((theme) => {
      for (const b of this.bindings.values()) b.term.options.theme = xtermTheme(theme);
      this.finder?.refresh();
    });

    // listen for pool changes: owned by this panel and removed in unmount(), not plugin.registerEvent(), which kept
    // three listeners per visit alive until the plugin unloaded (spec 2026-09-24-hud-deck-fixes D1)
    this.disposePool?.();
    this.disposePool = listen(pool, {
      "session-add": (s: TerminalSession) => {
        if (!this.host) return;
        // A terminal that starts outside the scoped workspace (⌘T in the vault, a skill's button) ends the scope, so the
        // new row is never hidden.
        if (this.model.scope && s && groupKey(this.model.placeOfSession(s)) !== this.model.scope.key) this.model.scope = null;
        this.renderTabs();
      },
      "session-remove": (id: string) => {
        if (!this.host) return;
        this.model.rememberClosed(id);
        const b = this.bindings.get(id);
        if (b) { b.detachData(); try { b.term.dispose(); } catch {} this.bindings.delete(id); }
        if (this.activeId === id) {
          this.activeId = pool.selectedId();
          if (this.activeId) this.ensureBindingForActive();
          else this.finder?.retarget(null);
        }
        this.renderTabs();
      },
      "session-exit": () => { if (this.host) this.renderTabs(); },
      "session-update": () => { if (this.host) { this.renderTabs(); this.newMenu?.refresh(); } },
      "session-select": (id: string | null) => {
        if (!this.host || !id || id === this.activeId) return;
        this.stage.clearPast();
        this.activeId = id;
        this.renderTabs();
        this.ensureBindingForActive();
      },
      "session-launched": (note: LaunchNote) => { if (this.host) this.showStarted(note); },
    });
    // A launch from another tab switches here after it announced itself: show its note now.
    const last = pool.lastLaunch;
    if (last && last.id === this.activeId && Date.now() - last.at < STARTED_MS) this.showStarted(last as LaunchNote);
  }

  unmount(): void {
    // The host is shared (the Workbench's content area): take back the classes mount() put on it.
    this.host?.removeClass("aos-term", "aos-term-fullpane", "aos-term-deck");
    this.computer?.destroy();
    this.computer = null;
    this.unwatchComputer?.();
    this.unwatchComputer = null;
    this.computerStore = null;
    this.marksShown = "";
    this.unwatchFeeds?.();
    this.unwatchFeeds = null;
    this.stage.destroy();
    this.model.dispose();
    this.topBar.destroy();
    this.disposePool?.();
    this.disposePool = null;
    this.disposeTheme?.();
    this.disposeTheme = null;
    if (this.noteTimer !== null) { window.clearTimeout(this.noteTimer); this.noteTimer = null; }
    this.newMenu?.destroy();
    this.newMenu = null;
    this.list = null;
    this.composer = null;
    this.finder?.close(false);
    this.finder = null;
    // dispose xterm instances but DON'T touch PTYs in the pool
    for (const b of this.bindings.values()) {
      try { b.detachData(); } catch { /* ignore */ }
      try { b.term.dispose(); } catch { /* ignore */ }
    }
    this.bindings.clear();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.host = null;
  }

  /** The Code tab was shown again: the past conversations are looked up again (the scan may have indexed more). */
  refreshSidebar(): void { if (this.host && this.list) { this.model.refreshHistory(true); this.renderTabs(); } }

  /** Another rail tab is in front: the Computer pane lets its view go and selects nothing (ruling R51). */
  leave(): void { this.computer?.hide(); }

  /** Keys to the selected terminal; in its chat view the terminal is hidden, so nothing takes them. */
  focus(): void {
    if (!this.activeId || this.stage.past || this.stage.chatShown()) return;
    const b = this.bindings.get(this.activeId);
    b?.term.focus();
  }

  /** ⌘J: an agent terminal's chat or its live terminal (code-chat C1). A shell, or the surface off, stays as it is. */
  toggleView(): void {
    const s = this.activeSession();
    const feeds = this.plugin.codeFeeds;
    if (this.stage.past || !s || !feeds || !this.stage.chat || !hasChat(s.meta) || !feeds.on()) return;
    this.setView(feeds.view(s.id) === "chat" ? "terminal" : "chat");
  }

  /** Makes a pool session the visible one — also for a session created outside the panel (WorkbenchView.runInTerm). */
  activate(id: string): void {
    if (!this.plugin.terminalPool.get(id)) return;
    this.stage.clearPast();
    this.activeId = id;
    this.plugin.terminalPool.select(id);
    this.renderTabs();
    this.ensureBindingForActive();
  }

  /**
   * Scopes the deck to a workspace (spaces-redesign D12): only its group, by key, with "Show all" above it; its newest
   * terminal is selected when the selected one is elsewhere (a running one first). Select only: it never starts a
   * terminal. No workspace, or one that is not a folder under workspaces/, shows every group again.
   */
  reveal(target: { workspace?: string | null }): void {
    const w = this.plugin.termLauncher.world();
    const name = target.workspace ?? null;
    this.model.scope = name && w.workspaces.includes(name) ? scopeOf(workspacePlace(name, w)) : null;
    this.renderTabs();
    if (!this.model.scope) return;
    const rows = this.model.openRows();
    if (!rows.length || rows.some((r) => r.id === this.activeId)) return;
    this.activate((rows.find((r) => r.end === "running") ?? rows[0]).id);
  }

  /** Opens the New menu (⇧⌘T), or its New workspace sheet (⇧⌘N); `reason` says why ⌘T could not start at once. */
  openNewMenu(mode: "menu" | "create" = "menu", reason: string | null = null): void {
    this.newMenu?.open(mode, reason);
  }

  /** The next or previous terminal in the list (⇧⌘] / ⇧⌘[). */
  step(dir: 1 | -1): void {
    const next = stepRow(this.model.order(), this.activeId, dir);
    if (next) this.activate(next);
  }

  /** Whether the selected terminal's program asked for bracketed paste (zsh, Claude Code and Codex do). */
  private bracketedPaste(): boolean {
    const b = this.activeId ? this.bindings.get(this.activeId) : undefined;
    return b ? b.term.modes.bracketedPasteMode : true;
  }

  /** Focuses the composer under the selected terminal (⌘L); false when it has none (it ended). */
  focusComposer(): boolean { return this.composer?.focus() ?? false; }

  /** Opens the find bar on the selected terminal (⌘F); false when there is no terminal to find in. */
  openFind(): boolean {
    const b = this.activeId ? this.bindings.get(this.activeId) : undefined;
    if (!this.finder || !b || this.stage.past || this.stage.chatShown()) return false;
    this.finder.open(b.search);
    return true;
  }

  /** Closes the selected terminal (⇧⌘W), asking first while an agent runs in it. A past conversation shown read-only is
   *  not a terminal: the one hidden under it stays. */
  closeActive(): void { if (this.activeId && !this.stage.past) this.closeSession(this.activeId); }

  /** A plain shell in the default place (the old "+ new"). */
  async createNewSession(): Promise<void> {
    try {
      const sess = this.plugin.terminalPool.create();
      this.activate(sess.id);
    } catch (e) {
      this.renderError(e);
    }
  }

  // ── private ──────────────────────────────────────────────────────────

  private renderError(e: unknown): void {
    this.bodyEl?.empty();
    const wrap = this.bodyEl?.createDiv({ cls: "aos-term-error" });
    if (!wrap) return;
    wrap.createDiv({ cls: "aos-text-rose", text: "Terminal unavailable" });
    const msg = e instanceof Error ? e.message : String(e);
    wrap.createDiv({ cls: "aos-dim aos-term-error-msg", text: msg });
  }

  private renderTabs(): void {
    if (this.opts.deck && this.list) {
      this.marksShown = this.marksSig();
      this.rowsShown = this.model.rowsSig();
      // At most every two seconds (the caches' stats are synchronous IPC; a busy agent's title renders this often).
      this.model.refreshHistory();
      const sidebar = this.model.rebuild();
      const counts = this.model.counts();
      this.list.render(sidebar, this.activeId, counts, this.model.scope, this.stage.past?.key ?? null);
      this.topBar.renderHead();
      return;
    }
    this.tabsEl.empty();
    const sessions = this.plugin.terminalPool.list();
    for (const s of sessions) {
      const tab = this.tabsEl.createDiv({ cls: "aos-term-tab", attr: { "data-session": s.id, "data-host": s.meta.host } });
      if (s.id === this.activeId) tab.addClass("aos-term-tab-active");
      if (s.isExited) tab.addClass("aos-term-tab-exited");
      tab.createSpan({ cls: `aos-term-dot is-${s.meta.host}`, attr: { "aria-hidden": "true" } });
      tab.createSpan({ cls: "aos-term-tab-label", text: s.getTitle() });
      const place = s.meta.place?.label ?? s.meta.origin;
      if (place) tab.createSpan({ cls: "aos-term-tab-place", text: place });
      if (s.isExited && s.exitCode) tab.createSpan({ cls: "aos-term-tab-exit", text: `Exited ${s.exitCode}` });
      const why = [s.meta.origin ? `from ${s.meta.origin}` : null, s.meta.place ? `in ${s.meta.place.dir}` : `in ${s.cwd}`].filter(Boolean).join(" · ");
      tab.setAttr("title", `${s.getTitle()} · ${why}`);
      const close = tab.createSpan({ cls: "aos-term-tab-close", text: "×" });
      close.setAttr("title", "Close session");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.terminalPool.remove(s.id);
      });
      tab.addEventListener("click", () => { this.activate(s.id); });
    }
  }

  /** "Started Claude Code in Vault · Change" for a few seconds; Change ends that terminal and reopens the menu. */
  private showStarted(note: LaunchNote): void {
    if (this.noteTimer !== null) window.clearTimeout(this.noteTimer);
    this.noteEl?.detach();
    const el = this.headerEl.createDiv({ cls: "aos-term-started", attr: { role: "status" } });
    this.tabsEl.after(el);
    el.createSpan({ text: note.text });
    if (this.opts.launch && note.why !== "picked") {
      const change = el.createEl("button", { cls: "aos-term-started-change", text: "Change", attr: { type: "button" } });
      change.addEventListener("click", () => {
        this.plugin.terminalPool.remove(note.id);
        this.openNewMenu("menu");
      });
    }
    this.noteEl = el;
    this.noteTimer = window.setTimeout(() => { el.detach(); this.noteTimer = null; }, STARTED_MS);
  }

  private closeSession(id: string): void {
    const s = this.plugin.terminalPool.get(id);
    if (!s) return;
    if (s.meta.host === "shell" || s.isExited) { this.plugin.terminalPool.remove(id); return; }
    new ConfirmModal(this.plugin.app, "Close this terminal?", `${s.getTitle()} is still running in it; closing ends it.`, "Close", (ok) => {
      if (ok) this.plugin.terminalPool.remove(id);
    }).open();
  }

  private startIn(place: Place, host: "quick" | "shell" | "claude" | "codex", resume: "last" | { id: string } | null = null): void {
    this.opts.launch?.start({ host, picked: place, resume }).catch((e) => new Notice(`Terminal: ${e instanceof Error ? e.message : String(e)}`));
  }

  /**
   * The model or access chip's pick (code-chat C12): starts the same host at the same place on the same conversation
   * (`resume` by the chat's id) with the pick; once the new agent has started it closes the old terminal, whose follower
   * ends with it (a failed start keeps the old one and says why: restartKeepingOld); the new one gets its own. With no
   * conversation known there is nothing to resume, and nothing happens. The other chip's value rides along as shown, so
   * a model changed in the TUI is not lost by an access pick.
   */
  restartWith(id: string, patch: { model?: string | null; access?: TermAccess | null }): Promise<void> {
    const pool = this.plugin.terminalPool;
    const s = pool.get(id);
    const conv = this.plugin.codeFeeds?.get(id)?.state.sessionId ?? null;
    if (!s || !hasChat(s.meta) || !conv || this.restarting.has(id)) return Promise.resolve();
    this.restarting.add(id);
    const host = s.meta.host;
    // What the chips show is what runs (R37): the shown model (null: the host's default) and the shown access ("host":
    // the host's default), never the settings'. Only the picked one is passed to a Codex resume.
    const model = "model" in patch ? patch.model ?? null : this.model.modelOf(s);
    const access = patch.access ?? s.meta.access ?? "host";
    const chosen = { model: "model" in patch, access: "access" in patch };
    return restartKeepingOld(pool, id, () => this.plugin.termLauncher.launch({
      host, picked: this.model.placeOfSession(s), resume: { id: conv }, origin: s.meta.origin, model, access, chosen,
    })).then((why) => { if (why) new Notice(`Terminal: ${why}`); }).finally(() => { this.restarting.delete(id); });
  }

  // ── the chat view (spec 2026-11-09-code-chat C1, C3, C5, C13) ──

  private activeSession(): TerminalSession | undefined {
    return this.activeId ? this.plugin.terminalPool.get(this.activeId) : undefined;
  }

  /** Flips the selected agent terminal to `v` and remembers it; the keys go to what shows. */
  private setView(v: CodeView): void {
    const s = this.activeSession();
    const feeds = this.plugin.codeFeeds;
    if (!s || !feeds || !hasChat(s.meta) || !feeds.on()) return;
    feeds.setView(s.id, v);
    this.topBar.renderSwitch(s);
    this.stage.applyView();
    if (v === "terminal") {
      this.ensureBindingForActive();
    } else {
      this.bindings.get(s.id)?.term.blur();
      this.composer?.focus();
    }
  }

  /** The Computer pane, third in the deck after the terminal (agent-computer D4): only in the app, which has a computer. */
  private mountComputer(host: HTMLElement): void {
    const computer = hudHost().computer;
    if (!computer) return;
    this.computer = new ComputerPane({
      host: computer,
      page: "code",
      settings: () => computerPaneStart(this.plugin.settings.computerPane, "code", window.innerWidth),
      save: (pane) => {
        this.plugin.settings.computerPane = rememberComputerPane(this.plugin.settings.computerPane, "code", pane);
        void this.plugin.saveSettings();
      },
    });
    this.computer.mount(host);
    this.computerStore = storeFor(computer);
    this.unwatchComputer = this.computerStore.subscribe(() => {
      if (this.host && this.list && this.marksSig() !== this.marksShown) this.renderTabs();
    });
  }

  /** A row's Computer marks: its agent's, by the key the computer names it by (D35); none for a shell. */
  private marks(id: string): RowMarks {
    return this.computerStore?.marks(this.plugin.terminalPool.get(id)?.computerKey ?? null) ?? { dot: false, waiting: false };
  }

  private marksSig(): string {
    if (!this.computerStore) return "";
    return this.plugin.terminalPool.list().map((s) => { const m = this.marks(s.id); return `${s.id}:${m.dot ? 1 : 0}${m.waiting ? 1 : 0}`; }).join(",");
  }

  private ensureBindingForActive(): void {
    if (!this.activeId) return;
    const sess = this.plugin.terminalPool.get(this.activeId);
    if (!sess) return;
    let b = this.bindings.get(sess.id);
    if (!b) b = this.createBinding(sess);

    // show active, hide others
    for (const [id, binding] of this.bindings.entries()) {
      binding.container.style.display = id === this.activeId ? "block" : "none";
    }
    this.finder?.retarget(b.search);
    // refit + focus next frame so layout settles; a menu or field the user is in keeps its focus. A chat that shows keeps
    // the terminal hidden at its size, and offers its composer instead (code-chat C1).
    requestAnimationFrame(() => {
      this.refit();
      if (this.newMenu?.isOpen() || this.typingElsewhere()) return;
      if (this.stage.past) return;
      if (this.stage.chatShown()) { if (this.activeId === sess.id) this.composer?.focus(); return; }
      b?.term.focus();
    });
  }

  /** Whether a field in the panel has the focus (the list's filter, the composer, the find bar): a terminal shown later
   *  must not take the typing from it. The terminal's own input does not count. */
  private typingElsewhere(): boolean {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !this.host?.contains(a) || a.classList.contains("xterm-helper-textarea")) return false;
    return a.matches("input, textarea, select") || a.isContentEditable;
  }

  private createBinding(sess: TerminalSession): XtermBinding {
    const container = this.bodyEl.createDiv({ cls: "aos-term-xterm" });
    const term = new Terminal({
      theme: xtermTheme(currentTheme(this.bodyEl.ownerDocument)),
      fontFamily: TERMINAL_FONT,
      fontSize: this.plugin.settings.terminalFontSize || 13,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: this.plugin.settings.terminalScrollback || 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // ⌘F finds in this terminal, scrollback included (the find bar draws the highlights: proposed API, allowed above).
    const search = new SearchAddon({ highlightLimit: FIND_LIMIT });
    term.loadAddon(search);
    // Links: https opens in the browser; agenticos:// (the agents' status lines) opens its Workbench tab (spec §4).
    term.loadAddon(new WebLinksAddon((_e, uri) => this.openLink(uri)));
    // Links an app prints (OSC 8, as Claude Code's status line does) may be agenticos:// ones: openLink checks each.
    term.options.linkHandler = { activate: (_e, text) => this.openLink(text), allowNonHttpProtocols: true };
    // Shift+Enter is a new line in Claude Code's prompt: Ctrl+J, which its docs say works in every terminal (T12).
    // Every event of that key stays from xterm: the keypress after the keydown would send ⏎ too, and submit the prompt.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && sess.meta.host === "claude" && !sess.isExited) {
        if (e.type === "keydown") sess.write("\n");
        return false;
      }
      return true;
    });
    term.open(container);

    // hydrate from cached scrollback
    const back = sess.getScrollback();
    if (back) term.write(back);

    // wire PTY → xterm
    const detachData = sess.onData((d) => term.write(d));
    // wire xterm → PTY
    term.onData((d) => sess.write(d));
    term.onResize(({ cols, rows }) => sess.resize(cols, rows));

    const binding: XtermBinding = { term, fit, search, container, detachData };
    this.bindings.set(sess.id, binding);
    return binding;
  }

  private openLink(uri: string): void {
    let u: URL;
    try { u = new URL(uri); } catch { return; }
    if (u.protocol === "https:" || u.protocol === "http:") { void shell.openExternal(u.toString()); return; }
    if (u.protocol === "agenticos:" && u.hostname === "workbench") {
      const tab = u.searchParams.get("tab");
      if (tab && /^[a-z-]+$/.test(tab)) void this.plugin.openWorkbenchTab(tab);
    }
    // A note in the vault (the status line's "1 flag" opens persona/STATE.md): a relative path that never climbs out.
    if (u.protocol === "agenticos:" && u.hostname === "note") {
      const file = u.searchParams.get("file");
      if (file && !file.startsWith("/") && !file.split(/[\\/]/).includes("..")) void this.plugin.app.workspace.openLinkText(file, "", true);
    }
  }

  /** The composer's height under the terminal view, kept while the chat shows (it sits inside the chat then, off the stage). */
  private termComposerH = TERM_COMPOSER_H;

  /** The rows the terminal view's composer takes from the stage, in this terminal's lines. */
  private composerRows(b: XtermBinding): number {
    const screen = b.container.querySelector<HTMLElement>(".xterm-screen");
    const line = screen && b.term.rows ? screen.clientHeight / b.term.rows : 0;
    return line > 0 ? Math.ceil(this.termComposerH / line) : 0;
  }

  private refit(): void {
    if (!this.activeId) return;
    const b = this.bindings.get(this.activeId);
    if (!b) return;
    try {
      if (!this.stage.chatShown()) {
        b.fit.fit();
        if (this.composer?.el.isConnected && this.composer.el.offsetHeight) this.termComposerH = this.composer.el.offsetHeight;
        return;
      }
      // While the chat shows, the terminal lies hidden under it, laid out at the stage's size: the agent's TUI is sized to
      // what the terminal view will give it, so ⌘J redraws nothing (C1). A stage with no size (a tab hidden) keeps the last.
      const d = b.fit.proposeDimensions();
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return;
      const rows = Math.max(2, d.rows - this.composerRows(b));
      if (d.cols !== b.term.cols || rows !== b.term.rows) b.term.resize(d.cols, rows);
    } catch { /* container not laid out yet */ }
  }

  private bindDragResize(handle: HTMLElement, host: HTMLElement): void {
    let startY = 0;
    let startH = 0;
    let dragging = false;
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const next = Math.max(140, Math.min(900, startH + (e.clientY - startY)));
      this.height = next;
      host.style.height = `${next}px`;
      this.refit();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.opts.onHeightChange?.(this.height);
    };
    handle.addEventListener("mousedown", (e: MouseEvent) => {
      dragging = true;
      startY = e.clientY;
      startH = host.clientHeight;
      document.body.style.cursor = "row-resize";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }
}

