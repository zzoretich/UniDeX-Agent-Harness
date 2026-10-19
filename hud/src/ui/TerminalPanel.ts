// TerminalPanel — embeddable terminal component.
// Renders the panel chrome (header with tabs and the New button, body with xterm, optional drag handle) inside a host
// element. Each session gets its own xterm; only the active one is visible. The pool keeps which one is selected, so a
// tab switch, a launch from another tab or the Pulse strip all show the same terminal (spec 2026-10-08-term-agent-deck).

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
import { shell } from "../host";
import { ConfirmModal } from "./ConfirmModal";
import { LinkRepoModal } from "./LinkRepoModal";
import { groupKey, groupTerminals, scopeOf, stepRow, type TermGroup, type TermRowInput, type TermScope } from "../data/termGroups";
import { TERM_ACCESS_LABEL, TERM_HOST_LABEL, placeOf, workspacePlace, type Place, type PlaceWorld } from "../data/terminalLaunch";

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
}

/** How long the "Started … · Change" note stays after a launch. */
const STARTED_MS = 6000;

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
  private finder: TermFind | null = null;
  private headMainEl: HTMLElement | null = null;
  private placeMenu: HTMLElement | null = null;
  private groups: TermGroup[] = [];
  /** The workspace another tab opened Code on (reveal): the deck lists only its group until Show all or a launch
   *  elsewhere (spaces-redesign D12). */
  private scope: TermScope | null = null;
  private worldCache: { at: number; w: PlaceWorld } | null = null;

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
        this.newMenu = new NewTerminalMenu(aside.createDiv({ cls: "aos-tl-new" }), this.plugin.termLauncher, this.opts.launch);
        this.newMenu.el.addClass("is-left");
      }
      this.list = new TermList(aside, {
        select: (id) => this.activate(id),
        close: (id) => this.closeSession(id),
        startIn: (g) => this.startIn(g.place, "quick"),
        clearEnded: () => { for (const s of this.plugin.terminalPool.list()) if (s.isExited) this.plugin.terminalPool.remove(s.id); },
        openWorkspace: this.opts.openWorkspace ? (name) => this.opts.openWorkspace?.(name) : undefined,
        clearScope: () => { this.scope = null; this.renderTabs(); },
      }, () => this.renderTabs());
      frame = host.createDiv({ cls: "aos-term-main", attr: { "data-tour": "code-main" } });
    }
    this.headerEl = frame.createDiv({ cls: "aos-term-header", attr: { "data-tour": "code-header" } });
    const left = this.headerEl.createDiv({ cls: "aos-term-header-left" });
    if (this.opts.deck) this.headMainEl = left.createDiv({ cls: "aos-term-head" });
    else left.createSpan({ cls: "aos-term-title", text: "Terminal" });
    this.tabsEl = this.headerEl.createDiv({ cls: "aos-term-tabs" });

    const right = this.headerEl.createDiv({ cls: "aos-term-header-right" });
    if (this.opts.launch && !this.opts.deck) this.newMenu = new NewTerminalMenu(right, this.plugin.termLauncher, this.opts.launch);

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

    // body
    this.bodyEl = frame.createDiv({ cls: "aos-term-body" });
    if (this.opts.deck) {
      this.composer = new TermComposer(frame, this.plugin, () => this.focus(), () => this.bracketedPaste());
      this.finder = new TermFind(this.bodyEl, () => this.focus());
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

  focus(): void {
    if (!this.activeId) return;
    const b = this.bindings.get(this.activeId);
    b?.term.focus();
  }

  /** Makes a pool session the visible one — also for a session created outside the panel (WorkbenchView.runInTerm). */
  activate(id: string): void {
    if (!this.plugin.terminalPool.get(id)) return;
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
    const rows = this.groups.flatMap((g) => g.rows);
    if (!rows.length || rows.some((r) => r.id === this.activeId)) return;
    this.activate((rows.find((r) => r.end === "running") ?? rows[0]).id);
  }

  /** Opens the New menu (⇧⌘T), or its New workspace sheet (⇧⌘N); `reason` says why ⌘T could not start at once. */
  openNewMenu(mode: "menu" | "create" = "menu", reason: string | null = null): void {
    this.newMenu?.open(mode, reason);
  }

  /** The next or previous terminal in the list (⇧⌘] / ⇧⌘[). */
  step(dir: 1 | -1): void {
    const next = stepRow(this.groups.length ? this.groups : groupTerminals(this.rowInputs()), this.activeId, dir);
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
    if (!this.finder || !b) return false;
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
      this.groups = groupTerminals(this.rowInputs(), this.list.query(), this.scope);
      this.list.render(this.groups, this.activeId, this.plugin.terminalPool.list().filter((s) => !s.isExited).length, this.scope);
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

  private rowInputs(): TermRowInput[] {
    return this.plugin.terminalPool.list().map((s) => ({
      id: s.id, host: s.meta.host, title: s.getTitle(), place: this.placeOfSession(s), origin: s.meta.origin,
      startedAt: s.meta.startedAt, exited: s.isExited, exitCode: s.exitCode,
    }));
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

  /** The deck's header for the selected terminal: its place (with a menu), title, host, model and access, and when it
   *  has ended, how it ended and how to go on. */
  private renderHead(): void {
    const el = this.headMainEl;
    if (!el) return;
    el.empty();
    this.placeMenu = null;
    const s = this.activeId ? this.plugin.terminalPool.get(this.activeId) : undefined;
    this.composer?.setSession(s ?? null);
    if (!s) return;
    const place = this.placeOfSession(s);
    const wrap = el.createDiv({ cls: "aos-term-placewrap" });
    const chip = wrap.createEl("button", { cls: "aos-term-place", attr: { type: "button", "aria-haspopup": "menu", title: place.dir } });
    const placeIcon = chip.createSpan({ cls: "aos-term-placeicon" });
    setIcon(placeIcon, "folder");
    chip.createSpan({ text: place.linked ? `${place.label} (code)` : place.label });
    const caret = chip.createSpan({ cls: "aos-term-placecaret" });
    setIcon(caret, "chevron-down");
    chip.addEventListener("click", () => this.togglePlaceMenu(wrap, s, place));
    el.createSpan({ cls: "aos-term-sep", text: "/" });
    el.createSpan({ cls: "aos-term-headtitle", text: s.getTitle() });
    const chips = el.createDiv({ cls: "aos-term-chips" });
    const hostChip = chips.createSpan({ cls: "aos-term-chip" });
    hostChip.createSpan({ cls: `aos-term-dot is-${s.meta.host}` });
    hostChip.createSpan({ text: s.meta.host === "shell" ? "Shell" : TERM_HOST_LABEL[s.meta.host] });
    if (s.meta.host !== "shell") {
      chips.createSpan({ cls: "aos-term-chip", text: s.meta.model ?? "default model" });
      if (s.meta.access) chips.createSpan({ cls: "aos-term-chip", text: TERM_ACCESS_LABEL[s.meta.access] });
    }
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
        const id = s.meta.sessionId;
        if (id) btn("Resume", () => this.startIn(place, host, { id }), `Resume this conversation (${id.slice(0, 8)}…)`);
        else btn("Resume latest", () => this.startIn(place, host, "last"), "Resume the latest conversation in this folder");
      }
      btn("Open a shell here", () => this.startIn(place, "shell"));
    }
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
    // refit + focus next frame so layout settles; a menu or field the user is in keeps its focus
    requestAnimationFrame(() => {
      this.refit();
      if (this.newMenu?.isOpen() || this.typingElsewhere()) return;
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

  private refit(): void {
    if (!this.activeId) return;
    const b = this.bindings.get(this.activeId);
    if (!b) return;
    try {
      b.fit.fit();
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

