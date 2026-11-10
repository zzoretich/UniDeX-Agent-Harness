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
import { TerminalSession } from "../data/terminalSession";
import type { LaunchNote } from "../data/terminalLauncher";
import { listen } from "../data/listen";
import { TERMINAL_FONT, currentTheme, onThemeChange, xtermTheme } from "./theme";
import { NewTerminalMenu, type NewTerminalActions } from "./NewTerminalMenu";
import { Notice, setIcon } from "obsidian";
import { TermList } from "./TermList";
import { TermComposer } from "./TermComposer";
import { TermFind } from "./TermFind";
import { FIND_LIMIT } from "../data/termFind";
import { hudHost, shell } from "../host";
import { ConfirmModal } from "./ConfirmModal";
import { LinkRepoModal } from "./LinkRepoModal";
import { groupKey, groupSidebar, rowInput, scopeOf, sidebarOrder, stepRow, type SidebarGroup, type TermRow, type TermRowInput, type TermScope } from "../data/termGroups";
import { restartKeepingOld } from "../data/terminalRestart";
import { HistoryCache } from "../data/historyCache";
import type { HistoryResume, HistoryRow } from "../data/sessionHistory";
import { pastEarlier, pastState, pastView, type PastView } from "../data/pastChat";
import { TERM_HOST_LABEL, placeKey, placeOf, vaultPlace, workspacePlace, type Place, type PlaceWorld, type TermAccess } from "../data/terminalLaunch";
import { ComputerPane } from "./ComputerPane";
import { storeFor, type ComputerStore, type RowMarks } from "../data/computerStore";
import { computerPaneStart, rememberComputerPane } from "../settingsDefaults";
import { CodeChat } from "./CodeChat";
import type { CodeView } from "../data/codeFeeds";
import { rowStatus, type ChatState } from "../data/codeChat";
import { HOST_APP_SETTINGS, runHostCommand } from "./hostCommands";

/** A chat with nothing in it yet. */
const NO_CHAT: ChatState = { sessionId: null, rows: [], hiddenEarlier: 0, turnOpen: false, error: null, model: null };

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
const NO_REASON = "The conversation could not be loaded";

/** A past conversation open read-only in the stage (code-chat C6): a History row, or one closed in this app. */
interface PastSel { key: string; host: "claude" | "codex"; id: string; title: string; place: Place; resume: HistoryResume }

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
  private headMainEl: HTMLElement | null = null;
  private placeMenu: HTMLElement | null = null;
  private sidebar: SidebarGroup[] = [];
  /** The past conversations (the index, digests), the ones closed in this app, and the "Show more" counts by group. */
  private hist: HistoryCache | null = null;
  private lastInputs = new Map<string, TermRowInput>();
  private extra: Record<string, number> = {};
  /** The past conversation shown read-only instead of a terminal, its chat, and what it shows now. */
  private past: PastSel | null = null;
  private pastChat: CodeChat | null = null;
  private pastData: PastView | null = null;
  private pastSeq = 0;
  /** The workspace another tab opened Code on (reveal): the deck lists only its group until Show all or a launch
   *  elsewhere (spaces-redesign D12). */
  private scope: TermScope | null = null;
  private worldCache: { at: number; w: PlaceWorld } | null = null;
  /** The deck's Computer pane (agent-computer D4), in the app only; its store gives the rows their marks (D32, D35). */
  private computer: ComputerPane | null = null;
  private computerStore: ComputerStore | null = null;
  private unwatchComputer: (() => void) | null = null;
  /** The rows' marks as last drawn, so a computer's state that changes none of them redraws nothing. */
  private marksShown = "";
  /** The rows' status and conversation as last drawn, so a chat that changes neither redraws no list (I2). */
  private rowsShown = "";
  /** The deck's main column, and the stage that holds the terminal's body under the chat (code-chat C1). */
  private frameEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private chat: CodeChat | null = null;
  /** The top bar's Chat | Terminal switch, and the place Task 13's pane buttons go. */
  private viewEl: HTMLElement | null = null;
  private hostChipEl: HTMLElement | null = null;
  private unwatchFeeds: (() => void) | null = null;
  /** The terminal whose chat the CodeChat shows now. */
  private chatFor: string | null = null;

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
        startIn: (g) => this.startIn(g.place ?? vaultPlace(this.world()), "quick"),
        clearEnded: () => { for (const s of this.plugin.terminalPool.list()) if (s.isExited) this.plugin.terminalPool.remove(s.id); },
        openWorkspace: this.opts.openWorkspace ? (name) => this.opts.openWorkspace?.(name) : undefined,
        clearScope: () => { this.scope = null; this.renderTabs(); },
        mark: (id) => this.marks(id),
        openPast: (h) => this.showPast({ key: h.key, host: h.host, id: h.id, title: h.title, place: h.place, resume: h.resume }),
        openClosed: (r) => { if (r.sessionId && r.host !== "shell") this.showPast({ key: `closed:${r.host}:${r.sessionId}`, host: r.host, id: r.sessionId, title: r.title, place: r.place, resume: { state: "on", place: r.place, hint: "" } }); },
        showMore: (key) => { this.extra[key] = (this.extra[key] ?? 0) + 10; this.renderTabs(); },
        allHistory: this.opts.openHistory ? () => this.opts.openHistory?.() : undefined,
      }, () => this.renderTabs());
      this.hist = new HistoryCache({ vault: () => this.plugin.vaultRoot(), hosts: () => ({ choices: this.plugin.termLauncher.choices(), world: this.world() }) }, () => { if (this.host) this.renderTabs(); });
      frame = host.createDiv({ cls: "aos-term-main", attr: { "data-tour": "code-main" } });
    }
    this.headerEl = frame.createDiv({ cls: "aos-term-header", attr: { "data-tour": "code-header" } });
    const left = this.headerEl.createDiv({ cls: "aos-term-header-left" });
    if (this.opts.deck) this.headMainEl = left.createDiv({ cls: "aos-term-head" });
    else left.createSpan({ cls: "aos-term-title", text: "Terminal" });
    this.tabsEl = this.headerEl.createDiv({ cls: "aos-term-tabs" });

    const right = this.headerEl.createDiv({ cls: "aos-term-header-right" });
    if (this.opts.launch && !this.opts.deck) this.newMenu = new NewTerminalMenu(right, this.plugin.termLauncher, this.opts.launch);
    if (this.opts.deck) this.viewEl = right.createDiv({ cls: "aos-term-view" });

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
      this.frameEl = frame;
      this.stageEl = frame.createDiv({ cls: "aos-term-stage" });
      this.bodyEl = this.stageEl.createDiv({ cls: "aos-term-body" });
      this.chat = new CodeChat(this.stageEl, {
        toTerminal: () => this.setView("terminal"),
        stop: () => { const s = this.activeSession(); if (s && !s.isExited && !s.agentEnded) s.write("\x1b"); },
        showEarlier: () => { if (this.activeId) this.plugin.codeFeeds?.showEarlier(this.activeId); },
        openLink: (href) => this.openLink(href),
        context: () => {
          const s = this.activeSession();
          return { host: s?.meta.host === "codex" ? "codex" : "claude", root: s ? s.meta.place?.dir ?? s.cwd : null };
        },
      });
      this.pastChat = new CodeChat(this.stageEl, {
        readOnly: true,
        toTerminal: () => {}, stop: () => {},
        showEarlier: () => { if (this.pastData && this.past) { this.pastData = pastEarlier(this.pastData); this.drawPast(); } },
        openLink: (href) => this.openLink(href),
        context: () => ({ host: this.past?.host ?? "claude", root: this.past?.place.dir ?? null }),
      });
      this.composer = new TermComposer(frame, this.plugin, () => this.focus(), () => this.bracketedPaste());
      this.finder = new TermFind(this.bodyEl, () => this.focus());
      this.mountComputer(host);
      this.unwatchFeeds = this.plugin.codeFeeds?.subscribe((id) => {
        if (!this.host) return;
        // Any terminal's chat moves its row (Working, Idle) and the conversation it is in: the list redraws when a row
        // would read differently, the selected one or not.
        if (this.list && this.rowsSig() !== this.rowsShown) this.renderTabs();
        if (id !== this.activeId) return;
        this.renderChat();
        this.renderHostChip();
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
        if (this.scope && s && groupKey(this.placeOfSession(s)) !== this.scope.key) this.scope = null;
        this.renderTabs();
      },
      "session-remove": (id: string) => {
        if (!this.host) return;
        this.rememberClosed(id);
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
        this.clearPast();
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
    this.chat?.destroy();
    this.chat = null;
    this.pastChat?.destroy();
    this.pastChat = null;
    this.past = null;
    this.pastData = null;
    this.pastSeq++;
    this.hist = null;
    this.lastInputs.clear();
    this.chatFor = null;
    this.frameEl = null;
    this.stageEl = null;
    this.viewEl = null;
    this.hostChipEl = null;
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
    this.headMainEl = null;
    this.placeMenu = null;
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
  refreshSidebar(): void { if (this.host && this.list) this.renderTabs(); }

  /** Another rail tab is in front: the Computer pane lets its view go and selects nothing (ruling R51). */
  leave(): void { this.computer?.hide(); }

  /** Keys to the selected terminal; in its chat view the terminal is hidden, so nothing takes them. */
  focus(): void {
    if (!this.activeId || this.past || this.chatShown()) return;
    const b = this.bindings.get(this.activeId);
    b?.term.focus();
  }

  /** ⌘J: an agent terminal's chat or its live terminal (code-chat C1). A shell, or the surface off, stays as it is. */
  toggleView(): void {
    const s = this.activeSession();
    const feeds = this.plugin.codeFeeds;
    if (this.past || !s || !feeds || !this.chat || s.meta.host === "shell" || !feeds.on()) return;
    this.setView(feeds.view(s.id) === "chat" ? "terminal" : "chat");
  }

  /** Makes a pool session the visible one — also for a session created outside the panel (WorkbenchView.runInTerm). */
  activate(id: string): void {
    if (!this.plugin.terminalPool.get(id)) return;
    this.clearPast();
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
    this.scope = name && w.workspaces.includes(name) ? scopeOf(workspacePlace(name, w)) : null;
    this.renderTabs();
    if (!this.scope) return;
    const rows = this.openRows();
    if (!rows.length || rows.some((r) => r.id === this.activeId)) return;
    this.activate((rows.find((r) => r.end === "running") ?? rows[0]).id);
  }

  /** Opens the New menu (⇧⌘T), or its New workspace sheet (⇧⌘N); `reason` says why ⌘T could not start at once. */
  openNewMenu(mode: "menu" | "create" = "menu", reason: string | null = null): void {
    this.newMenu?.open(mode, reason);
  }

  /** The next or previous terminal in the list (⇧⌘] / ⇧⌘[). */
  step(dir: 1 | -1): void {
    const next = stepRow(sidebarOrder(this.sidebar.length ? this.sidebar : this.buildSidebar()), this.activeId, dir);
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
    if (!this.finder || !b || this.past || this.chatShown()) return false;
    this.finder.open(b.search);
    return true;
  }

  /** Closes the selected terminal (⇧⌘W), asking first while an agent runs in it. */
  closeActive(): void { if (this.activeId) this.closeSession(this.activeId); }

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
      this.rowsShown = this.rowsSig();
      this.hist?.refresh();
      this.sidebar = this.buildSidebar();
      const open = this.openRows();
      const counts = { open: open.filter((r) => r.end === "running").length, needs: this.sidebar.reduce((n, g) => n + g.rows.filter((r) => r.kind === "open" && !r.closed && r.status.status === "needs").length, 0), ended: open.filter((r) => r.end !== "running").length };
      this.list.render(this.sidebar, this.activeId, counts, this.scope, this.past?.key ?? null);
      this.renderHead();
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

  /** The workspaces and links, read at most every two seconds: rows without a recorded place need them. */
  private world(): PlaceWorld {
    const now = Date.now();
    if (!this.worldCache || now - this.worldCache.at > 2000) this.worldCache = { at: now, w: this.plugin.termLauncher.world() };
    return this.worldCache.w;
  }

  private placeOfSession(s: TerminalSession): Place { return s.meta.place ?? placeOf(s.cwd, this.world()); }

  /** Each terminal's row (rowInput): its conversation and turn as its chat has them, the source the chat and chips read. */
  private rowInputs(): TermRowInput[] {
    const feeds = this.plugin.codeFeeds;
    return this.plugin.terminalPool.list().map((s) => rowInput(s, this.placeOfSession(s), feeds?.get(s.id) ?? null));
  }

  /** The terminal's conversation: its chat's (a /clear, a new Codex thread), else the one its launch named. */
  private conversationOf(s: TerminalSession): string | null {
    return this.plugin.codeFeeds?.get(s.id)?.state.sessionId ?? s.meta.sessionId ?? null;
  }

  /** What the rows show of each chat: its status and its conversation (which hides its History row). */
  private rowsSig(): string {
    const feeds = this.plugin.codeFeeds;
    if (!feeds) return "";
    return this.plugin.terminalPool.list().map((s) => {
      const f = feeds.get(s.id);
      return f ? `${s.id}:${f.follow}:${f.state.turnOpen ? 1 : 0}:${this.conversationOf(s) ?? ""}` : s.id;
    }).join(",");
  }

  /** The sidebar's groups now: the terminals, and (with the Code chat on) the conversations closed here and past ones. */
  private buildSidebar(): SidebarGroup[] {
    const inputs = this.rowInputs();
    this.lastInputs = new Map(inputs.map((r) => [r.id, r]));
    const on = this.plugin.codeFeeds?.on() ?? false;
    const groups = groupSidebar(inputs, on ? this.hist?.rows() ?? [] : [], { now: Date.now(), filter: this.list?.query() ?? "", closed: on ? this.plugin.codeFeeds?.closedConvs.list() ?? [] : [], extra: this.extra });
    const scope = this.scope;
    if (!scope) return groups;
    const only = groups.filter((g) => g.key === scope.key);
    // A scoped workspace with nothing running keeps its group, so its + and Open workspace still show.
    if (!only.length && !(this.list?.query() ?? "").trim()) only.push({ key: scope.key, label: scope.label, place: scope.place, rows: [], more: 0 });
    return only;
  }

  /** The terminals in the list, in order (past and closed conversations are not terminals). */
  private openRows(): TermRow[] {
    return this.sidebar.flatMap((g) => g.rows.flatMap((r) => (r.kind === "open" && !r.closed ? [r.row] : [])));
  }

  /** A terminal closed here keeps a row (when it knew its conversation) until the index lists that conversation (C6). */
  private rememberClosed(id: string): void {
    const r = this.lastInputs.get(id);
    this.lastInputs.delete(id);
    if (r) this.plugin.codeFeeds?.closedConvs.add(r);
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

  /** The deck's top bar for the selected terminal (code-chat §4): its title, its place (with a menu; Task 13 adds the
   *  branch), "Host · Model", and at the right the Chat | Terminal switch; when it has ended, how it ended and how to go
   *  on. The switch also sets which view shows. */
  private renderHead(): void {
    const el = this.headMainEl;
    if (!el) return;
    el.empty();
    this.placeMenu = null;
    this.hostChipEl = null;
    const past = this.past;
    const s = past ? undefined : this.activeId ? this.plugin.terminalPool.get(this.activeId) : undefined;
    this.composer?.setSession(s ?? null);
    this.renderSwitch(s);
    this.applyView();
    if (past) { this.renderPastHead(el, past); return; }
    if (!s) { this.computer?.follow(null); return; }
    const place = this.placeOfSession(s);
    // The pane shows the computer this terminal's place shares (agent-computer D30, D32), shell or agent.
    this.computer?.follow({ place: placeKey(place), label: place.label });
    el.createSpan({ cls: "aos-term-headtitle", text: s.getTitle() });
    const wrap = el.createDiv({ cls: "aos-term-placewrap" });
    const chip = wrap.createEl("button", { cls: "aos-term-place", attr: { type: "button", "aria-haspopup": "menu", title: place.dir } });
    const placeIcon = chip.createSpan({ cls: "aos-term-placeicon" });
    setIcon(placeIcon, "folder");
    chip.createSpan({ text: place.linked ? `${place.label} (code)` : place.label });
    const caret = chip.createSpan({ cls: "aos-term-placecaret" });
    setIcon(caret, "chevron-down");
    chip.addEventListener("click", () => this.togglePlaceMenu(wrap, s, place));
    const chips = el.createDiv({ cls: "aos-term-chips" });
    this.hostChipEl = chips.createSpan({ cls: "aos-term-chip" });
    this.renderHostChip();
    if (s.isExited) {
      const end = el.createDiv({ cls: "aos-term-endbar", attr: { role: "status" } });
      end.createSpan({ text: s.exitCode ? `Ended · Exited ${s.exitCode}` : "Ended" });
      const btn = (label: string, fn: () => void, title?: string) => {
        const b = end.createEl("button", { cls: "aos-term-endbtn", text: label, attr: { type: "button", ...(title ? { title } : {}) } });
        b.addEventListener("click", fn);
      };
      if (s.meta.host !== "shell") {
        const host = s.meta.host;
        btn("Restart", () => this.startIn(place, host));
        // By id on either host when the terminal knows its conversation (a new Claude Code one, or any resume by id);
        // otherwise the latest one in this folder (spaces-redesign D7).
        const id = this.conversationOf(s);
        if (id) btn("Resume", () => this.startIn(place, host, { id }), `Resume this conversation (${id.slice(0, 8)}…)`);
        else btn("Resume latest", () => this.startIn(place, host, "last"), "Resume the latest conversation in this folder");
      }
      btn("Open a shell here", () => this.startIn(place, "shell"));
    }
  }

  // ── a past conversation, read-only (code-chat C6) ──

  /** Its title, where it ran, its host, and at the right Resume (the row's resume line, D7/D31) or why there is none. */
  private renderPastHead(el: HTMLElement, p: PastSel): void {
    el.createSpan({ cls: "aos-term-headtitle", text: p.title });
    const where = el.createSpan({ cls: "aos-term-place is-static", attr: { title: p.place.dir } });
    const icon = where.createSpan({ cls: "aos-term-placeicon" });
    setIcon(icon, "folder");
    where.createSpan({ text: p.place.linked ? `${p.place.label} (code)` : p.place.label });
    const chips = el.createDiv({ cls: "aos-term-chips" });
    const chip = chips.createSpan({ cls: "aos-term-chip" });
    chip.createSpan({ cls: `aos-term-dot is-${p.host}` });
    chip.createSpan({ text: `${TERM_HOST_LABEL[p.host]} · Past conversation` });
    const view = this.viewEl;
    if (!view) return;
    const r = p.resume;
    if (r.state === "on") {
      const b = view.createEl("button", { cls: "aos-cv-resume", text: "Resume", attr: { type: "button", title: r.hint || `Resume this conversation in ${p.place.label}` } });
      b.addEventListener("click", () => this.startIn(r.place, p.host, { id: p.id }));
    } else if (r.state === "off") {
      view.createSpan({ cls: "aos-cv-noresume", text: r.reason, attr: { title: r.reason } });
    }
  }

  /** Opens a past conversation: main mirrors it once (`code.view`), then the cache is read whole into the read-only chat. */
  private showPast(sel: PastSel): void {
    const chat = this.pastChat;
    if (!chat) return;
    const seq = ++this.pastSeq;
    this.past = sel;
    this.pastData = null;
    chat.reset();
    chat.show(NO_CHAT, "Loading…");
    this.renderTabs();
    const code = hudHost().code;
    if (!code) { chat.show({ ...NO_CHAT, error: "Past conversations open in the app" }); return; }
    void code.view({ host: sel.host, id: sel.id }).then((r) => {
      if (seq !== this.pastSeq || !this.past) return;
      if (!r.ok) { chat.show({ ...NO_CHAT, error: r.error || NO_REASON }); return; }
      this.pastData = pastView(this.plugin.codeFeeds?.readCache(r.data.cache) ?? []);
      this.drawPast();
    }, (e: unknown) => {
      if (seq === this.pastSeq) chat.show({ ...NO_CHAT, error: e instanceof Error ? e.message : NO_REASON });
    });
  }

  private drawPast(): void {
    if (!this.pastChat || !this.past || !this.pastData) return;
    this.pastChat.show(pastState(this.pastData, this.past.host, this.past.place.dir));
  }

  /** A terminal is selected (or none): the past conversation goes. */
  private clearPast(): void {
    if (!this.past) return;
    this.past = null;
    this.pastData = null;
    this.pastSeq++;
  }

  // ── the chat view (spec 2026-11-09-code-chat C1, C3, C5, C13) ──

  private activeSession(): TerminalSession | undefined {
    return this.activeId ? this.plugin.terminalPool.get(this.activeId) : undefined;
  }

  /** Which view the selected terminal shows: always its terminal outside the deck. */
  private viewOf(s: TerminalSession | undefined): CodeView {
    if (!s || !this.chat) return "terminal";
    return this.plugin.codeFeeds?.view(s.id) ?? "terminal";
  }

  /** Whether the selected terminal shows its chat now. */
  private chatShown(): boolean { return this.viewOf(this.activeSession()) === "chat"; }

  /** The conversation's newest model (the cache's), else the launch's. */
  private modelOf(s: TerminalSession): string | null {
    return this.plugin.codeFeeds?.get(s.id)?.state.model ?? s.meta.model ?? null;
  }

  /** "Host · Model" in the top bar, and the composer's model chip. */
  private renderHostChip(): void {
    const s = this.activeSession();
    const el = this.hostChipEl;
    if (!s || !el) return;
    el.empty();
    el.createSpan({ cls: `aos-term-dot is-${s.meta.host}` });
    const model = s.meta.host === "shell" ? null : this.modelOf(s);
    el.createSpan({ text: s.meta.host === "shell" ? "Shell" : `${TERM_HOST_LABEL[s.meta.host]} · ${model ?? "default model"}` });
    if (s.meta.host !== "shell") {
      const feed = this.plugin.codeFeeds?.get(s.id)?.state;
      const working = rowStatus({ exited: s.isExited, exitCode: s.exitCode, turnOpen: feed?.turnOpen ?? false, printing: false, needsYou: false }).status === "working";
      this.composer?.setChips({ conversation: feed?.sessionId ?? null, working, model, restart: (patch) => this.restartWith(s.id, patch) });
    }
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
    if (!s || s.meta.host === "shell" || !conv || this.restarting.has(id)) return Promise.resolve();
    this.restarting.add(id);
    const host = s.meta.host;
    // What the chips show is what runs (R37): the shown model (null: the host's default) and the shown access ("host":
    // the host's default), never the settings'. Only the picked one is passed to a Codex resume.
    const model = "model" in patch ? patch.model ?? null : this.modelOf(s);
    const access = patch.access ?? s.meta.access ?? "host";
    const chosen = { model: "model" in patch, access: "access" in patch };
    return restartKeepingOld(pool, id, () => this.plugin.termLauncher.launch({
      host, picked: this.placeOfSession(s), resume: { id: conv }, origin: s.meta.origin, model, access, chosen,
    })).then((why) => { if (why) new Notice(`Terminal: ${why}`); }).finally(() => { this.restarting.delete(id); });
  }

  /** The top bar's Chat | Terminal ⌘J switch for an agent terminal; with the surface off, a note that sends you to the
   *  app's settings; nothing for a shell (C3). It carries the tour's anchor. */
  private renderSwitch(s: TerminalSession | undefined): void {
    const el = this.viewEl;
    if (!el) return;
    el.empty();
    const feeds = this.plugin.codeFeeds;
    if (!s || s.meta.host === "shell" || !feeds || !this.chat) return;
    if (!feeds.on()) {
      const off = el.createDiv({ cls: "aos-cv is-off", attr: { "data-tour": "code-view" } });
      off.createSpan({ text: "Chat view is off · " });
      const go = off.createEl("button", { cls: "aos-cv-settings", text: "Settings", attr: { type: "button", title: "App settings: turn on the Code chat write surface" } });
      go.addEventListener("click", () => { runHostCommand(this.plugin.app, HOST_APP_SETTINGS); });
      return;
    }
    const view = feeds.view(s.id);
    const group = el.createDiv({ cls: "aos-cv", attr: { role: "group", "aria-label": "View", "data-tour": "code-view" } });
    const btn = (v: CodeView, label: string, kbd: string | null) => {
      const b = group.createEl("button", { cls: `aos-cv-btn${view === v ? " is-on" : ""}`, attr: { type: "button", "aria-pressed": String(view === v) } });
      b.createSpan({ text: label });
      if (kbd) b.createSpan({ cls: "aos-cv-kbd", text: kbd });
      b.addEventListener("click", () => this.setView(v));
    };
    btn("chat", "Chat", null);
    btn("terminal", "Terminal", "⌘J");
  }

  /** Shows the selected terminal's view: the chat over its hidden terminal, with the composer in the chat's column, or
   *  the terminal with the composer under it. */
  private applyView(): void {
    const chat = this.chat;
    const stage = this.stageEl;
    const composer = this.composer;
    const frame = this.frameEl;
    if (!chat || !stage || !composer || !frame) return;
    // A past conversation lies over the stage like the chat does, with no composer under it.
    const past = !!this.past;
    stage.toggleClass("is-past", past);
    this.pastChat?.setVisible(past);
    if (past) { chat.setVisible(false); return; }
    const on = this.chatShown();
    const was = stage.hasClass("is-chat");
    stage.toggleClass("is-chat", on);
    composer.setMode(on ? "chat" : "terminal");
    // An agent that exited left the login shell in its terminal (R39): the chat says so, and its composer never writes to
    // that shell (the terminal view's composer does, as a shell's).
    const s = this.activeSession();
    const ended = !!s && s.meta.host !== "shell" && s.agentEnded;
    composer.block(on && ended);
    if (on && composer.el.parentElement !== chat.composerSlot) chat.composerSlot.appendChild(composer.el);
    if (!on && composer.el.parentElement !== frame) stage.after(composer.el);
    chat.setVisible(on);
    // A title or a model changing redraws the top bar, not the chat: the feed's own changes redraw that.
    if (on && (!was || this.chatFor !== this.activeId)) this.renderChat();
    // After renderChat, whose reset() for another terminal clears it.
    chat.setEnded(ended && s ? TERM_HOST_LABEL[s.meta.host] : null);
  }

  /** The selected terminal's chat, as its feed has it now. */
  private renderChat(): void {
    const chat = this.chat;
    const s = this.activeSession();
    if (!chat || !s || this.past || !this.chatShown()) return;
    const feed = this.plugin.codeFeeds?.get(s.id) ?? null;
    if (this.chatFor !== s.id) { chat.reset(); this.chatFor = s.id; }
    chat.show(feed?.state ?? NO_CHAT, feed?.follow === "failed" ? feed.error : null);
    chat.setStatus(feed?.status ?? null);
  }

  /** Flips the selected agent terminal to `v` and remembers it; the keys go to what shows. */
  private setView(v: CodeView): void {
    const s = this.activeSession();
    const feeds = this.plugin.codeFeeds;
    if (!s || !feeds || s.meta.host === "shell" || !feeds.on()) return;
    feeds.setView(s.id, v);
    this.renderSwitch(s);
    this.applyView();
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

  private togglePlaceMenu(wrap: HTMLElement, s: TerminalSession, place: Place): void {
    if (this.placeMenu) { this.placeMenu.detach(); this.placeMenu = null; return; }
    const menu = wrap.createDiv({ cls: "aos-term-placemenu", attr: { role: "menu" } });
    this.placeMenu = menu;
    const item = (label: string, fn: () => void) => {
      const b = menu.createEl("button", { cls: "aos-term-placeitem", text: label, attr: { type: "button", role: "menuitem" } });
      b.addEventListener("click", () => { menu.detach(); this.placeMenu = null; fn(); });
    };
    const quick = this.plugin.termLauncher.quickHost().host;
    if (quick && quick !== "shell") item(`Start ${TERM_HOST_LABEL[quick]} here`, () => this.startIn(place, quick));
    item("Open a shell here", () => this.startIn(place, "shell"));
    if (place.kind === "scratch") {
      const named = s.getTitle() !== TERM_HOST_LABEL[s.meta.host] ? s.getTitle() : "";
      item("Make this a workspace…", () => this.newMenu?.open("create", null, named));
    }
    if (place.kind === "workspace" && place.workspace) {
      const name = place.workspace;
      item(place.linked ? "Change the code folder…" : "Link a code folder…", () => {
        new LinkRepoModal(this.plugin.app, name, this.plugin.termLauncher.world().links[name] ?? null, async (typed) => {
          const abs = await this.plugin.termLauncher.linkRepo(name, typed);
          this.worldCache = null;
          new Notice(abs ? `${name} is linked to ${abs}` : `${name} is no longer linked`);
          this.renderTabs();
          return abs;
        }).open();
      });
    }
    item("Copy path", () => { void navigator.clipboard?.writeText(place.dir).then(() => new Notice(`Copied ${place.dir}`)); });
    (menu.querySelector("button") as HTMLElement | null)?.focus();
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); menu.detach(); this.placeMenu = null; } });
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
      if (this.past) return;
      if (this.chatShown()) { if (this.activeId === sess.id) this.composer?.focus(); return; }
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
      if (!this.chatShown()) {
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

