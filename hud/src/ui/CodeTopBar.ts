// CodeTopBar — the deck's top bar for the selected terminal (spec 2026-11-09-code-chat §4): its title, its place with the
// place menu, "Host · Model", the Chat | Terminal switch at the right (or a past conversation's Resume), and when the
// terminal has ended, how it ended and how to go on. TerminalPanel mounts its two elements and draws it through renderHead.

import { Notice, setIcon } from "obsidian";
import type AgenticOSPlugin from "../../main";
import { hasChat, type TerminalSession } from "../data/terminalSession";
import { TERM_HOST_LABEL, placeKey, type Place, type TermAccess } from "../data/terminalLaunch";
import { rowStatus } from "../data/codeChat";
import type { CodeView } from "../data/codeFeeds";
import type { CodeSidebarModel } from "../data/codeSidebarModel";
import { LinkRepoModal } from "./LinkRepoModal";
import { HOST_APP_SETTINGS, runHostCommand } from "./hostCommands";
import type { CodeStage, PastSel } from "./CodeStage";
import { branchText, type CodePanes } from "./CodePanes";
import type { TermComposer } from "./TermComposer";
import type { ComputerPane } from "./ComputerPane";

/** What the top bar needs of the panel that holds it. */
export interface CodeTopBarHost {
  activeSession(): TerminalSession | undefined;
  composer(): TermComposer | null;
  computer(): ComputerPane | null;
  startIn(place: Place, host: "quick" | "shell" | "claude" | "codex", resume?: "last" | { id: string } | null): void;
  setView(v: CodeView): void;
  /** The New menu's New workspace sheet, named for a Scratch terminal. */
  makeWorkspace(named: string): void;
  restartWith(id: string, patch: { model?: string | null; access?: TermAccess | null }): Promise<void>;
  renderTabs(): void;
}

export class CodeTopBar {
  /** The deck's header: the terminal's title, place and chips (left), the view switch (right). */
  headMainEl: HTMLElement | null = null;
  viewEl: HTMLElement | null = null;
  /** The top bar's right after the switch: `+n −n` and the Diff, Files and Computer buttons (code-chat C8). */
  panesEl: HTMLElement | null = null;
  private hostChipEl: HTMLElement | null = null;
  /** The place chip as last drawn, which carries the ⎇ branch (renderStatus). */
  private placeChipEl: HTMLElement | null = null;
  private placeMenu: HTMLElement | null = null;
  /** What the top bar's switch shows (the terminal, its view, the surface; a past conversation's Resume), so a terminal's
   *  update that changes none of it leaves the switch and its focus alone (I3). */
  private switchShown: string | null = null;

  constructor(private plugin: AgenticOSPlugin, private model: CodeSidebarModel, private stage: CodeStage, private host: CodeTopBarHost, private panes: CodePanes) {}

  destroy(): void {
    this.switchShown = null;
    this.viewEl = null;
    this.panesEl = null;
    this.hostChipEl = null;
    this.placeChipEl = null;
    this.headMainEl = null;
    this.placeMenu = null;
  }

  /** The deck's top bar for the selected terminal (code-chat §4): its title, its place (with a menu) and ⎇ branch,
   *  "Host · Model", and at the right the Chat | Terminal switch, `+n −n` and the pane buttons (C8); when it has ended, how
   *  it ended and how to go on. The switch also sets which view shows. */
  renderHead(): void {
    const el = this.headMainEl;
    if (!el) return;
    el.empty();
    this.placeMenu = null;
    this.hostChipEl = null;
    this.placeChipEl = null;
    const past = this.stage.past;
    const s = past ? undefined : this.host.activeSession();
    this.host.composer()?.setSession(s ?? null);
    this.renderSwitch(s);
    this.stage.applyView();
    this.panes.follow(s);
    this.panes.renderBar(this.panesEl, s, s ? this.model.placeOfSession(s) : null);
    if (past) { this.renderPastHead(el, past); return; }
    if (!s) { this.host.computer()?.follow(null); return; }
    const place = this.model.placeOfSession(s);
    // The pane shows the computer this terminal's place shares (agent-computer D30, D32), shell or agent.
    this.host.computer()?.follow({ place: placeKey(place), label: place.label });
    el.createSpan({ cls: "aos-term-headtitle", text: s.getTitle() });
    const wrap = el.createDiv({ cls: "aos-term-placewrap" });
    const chip = wrap.createEl("button", { cls: "aos-term-place", attr: { type: "button", "aria-haspopup": "menu", title: place.dir } });
    this.placeChipEl = chip;
    const placeIcon = chip.createSpan({ cls: "aos-term-placeicon" });
    setIcon(placeIcon, "folder");
    chip.createSpan({ text: place.linked ? `${place.label} (code)` : place.label });
    // ⎇ branch where main found a repository (C8), as last read: never a call on a draw.
    const branch = branchText(this.panes.statusOf(s));
    if (branch) chip.createSpan({ cls: "aos-term-branch", text: branch });
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
        btn("Restart", () => this.host.startIn(place, host));
        // By id on either host when the terminal knows its conversation (a new Claude Code one, or any resume by id);
        // otherwise the latest one in this folder (spaces-redesign D7).
        const id = this.model.conversationOf(s);
        if (id) btn("Resume", () => this.host.startIn(place, host, { id }), `Resume this conversation (${id.slice(0, 8)}…)`);
        else btn("Resume latest", () => this.host.startIn(place, host, "last"), "Resume the latest conversation in this folder");
      }
      btn("Open a shell here", () => this.host.startIn(place, "shell"));
    }
  }

  /** The pane buttons alone, when only they changed (the Computer pane opened or collapsed by its own button). */
  renderPanes(): void {
    const s = this.stage.past ? undefined : this.host.activeSession();
    this.panes.renderBar(this.panesEl, s, s ? this.model.placeOfSession(s) : null);
  }

  /** A git status read landed, or the Diff pane opened or closed: the place chip's ⎇ branch and the pane buttons only, so
   *  an open place menu and the rest of the bar stay as they are. */
  renderStatus(): void {
    const s = this.stage.past ? undefined : this.host.activeSession();
    const chip = this.placeChipEl;
    if (chip?.isConnected && s) {
      chip.querySelector(".aos-term-branch")?.remove();
      const branch = branchText(this.panes.statusOf(s));
      if (branch) {
        const span = chip.createSpan({ cls: "aos-term-branch", text: branch });
        chip.querySelector(".aos-term-placecaret")?.before(span);
      }
    }
    this.renderPanes();
  }

  /** Its title, where it ran and its host (renderPastView puts Resume at the right). */
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
  }

  /** At the top bar's right, a past conversation's Resume (the row's resume line, D7/D31) or why there is none. */
  private renderPastView(view: HTMLElement, p: PastSel): void {
    const r = p.resume;
    if (r.state === "on") {
      const b = view.createEl("button", { cls: "aos-cv-resume", text: "Resume", attr: { type: "button", title: r.hint || `Resume this conversation in ${p.place.label}` } });
      b.addEventListener("click", () => this.host.startIn(r.place, p.host, { id: p.id }));
    } else if (r.state === "off") {
      view.createSpan({ cls: "aos-cv-noresume", text: r.reason, attr: { title: r.reason } });
    }
  }

  /** "Host · Model" in the top bar (the model by its name, not the transcript's full id: M4), and the composer's chips. */
  renderHostChip(): void {
    const s = this.host.activeSession();
    const el = this.hostChipEl;
    if (!s || !el) return;
    el.empty();
    el.createSpan({ cls: `aos-term-dot is-${s.meta.host}` });
    const model = s.meta.host === "shell" ? null : this.model.modelOf(s);
    const name = s.meta.host === "shell" ? "" : this.host.composer()?.modelLabel(s.meta.host, model) ?? model ?? "Default";
    el.createSpan({ text: s.meta.host === "shell" ? "Shell" : `${TERM_HOST_LABEL[s.meta.host]} · ${name}` });
    if (s.meta.host !== "shell") {
      const feed = this.plugin.codeFeeds?.get(s.id)?.state;
      const working = rowStatus({ exited: s.isExited, exitCode: s.exitCode, turnOpen: feed?.turnOpen ?? false, printing: false, needsYou: false }).status === "working";
      this.host.composer()?.setChips({ conversation: feed?.sessionId ?? null, working, model, restart: (patch) => this.host.restartWith(s.id, patch) });
    }
  }

  /** The top bar's Chat | Terminal ⌘J switch for an agent terminal; with the surface off, a note that sends you to the
   *  app's settings; nothing for a shell (C3); a past conversation's Resume. It carries the tour's anchor. Drawn again only
   *  when what it shows changed (I3), so a busy agent's title never takes the keyboard's focus from it. */
  renderSwitch(s: TerminalSession | undefined): void {
    const el = this.viewEl;
    if (!el) return;
    const feeds = this.plugin.codeFeeds;
    const past = this.stage.past;
    const sig = past ? `past:${past.key}` : `${s?.id ?? ""}:${s?.meta.host ?? ""}:${feeds?.on() ? 1 : 0}:${s && feeds ? feeds.view(s.id) : ""}`;
    if (sig === this.switchShown) return;
    this.switchShown = sig;
    el.empty();
    if (past) { this.renderPastView(el, past); return; }
    if (!s || !hasChat(s.meta) || !feeds || !this.stage.chat) return;
    if (!feeds.on()) {
      const off = el.createDiv({ cls: "aos-cv is-off", attr: { "data-tour": "code-view" } });
      off.createSpan({ text: "Chat view is off · " });
      const go = off.createEl("button", { cls: "aos-cv-settings", text: "Settings", attr: { type: "button", title: "The chat view needs the Code chat write surface; App settings ▸ Write access shows whether it is on" } });
      go.addEventListener("click", () => { runHostCommand(this.plugin.app, HOST_APP_SETTINGS); });
      return;
    }
    const view = feeds.view(s.id);
    const group = el.createDiv({ cls: "aos-cv", attr: { role: "group", "aria-label": "View", "data-tour": "code-view" } });
    const btn = (v: CodeView, label: string, kbd: string | null) => {
      const b = group.createEl("button", { cls: `aos-cv-btn${view === v ? " is-on" : ""}`, attr: { type: "button", "aria-pressed": String(view === v) } });
      b.createSpan({ text: label });
      if (kbd) b.createSpan({ cls: "aos-cv-kbd", text: kbd });
      b.addEventListener("click", () => this.host.setView(v));
    };
    btn("chat", "Chat", null);
    btn("terminal", "Terminal", "⌘J");
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
    if (quick && quick !== "shell") item(`Start ${TERM_HOST_LABEL[quick]} here`, () => this.host.startIn(place, quick));
    item("Open a shell here", () => this.host.startIn(place, "shell"));
    if (place.kind === "scratch") {
      const named = s.getTitle() !== TERM_HOST_LABEL[s.meta.host] ? s.getTitle() : "";
      item("Make this a workspace…", () => this.host.makeWorkspace(named));
    }
    if (place.kind === "workspace" && place.workspace) {
      const name = place.workspace;
      item(place.linked ? "Change the code folder…" : "Link a code folder…", () => {
        new LinkRepoModal(this.plugin.app, name, this.plugin.termLauncher.world().links[name] ?? null, async (typed) => {
          const abs = await this.plugin.termLauncher.linkRepo(name, typed);
          this.model.forgetWorld();
          new Notice(abs ? `${name} is linked to ${abs}` : `${name} is no longer linked`);
          this.host.renderTabs();
          return abs;
        }).open();
      });
    }
    item("Copy path", () => { void navigator.clipboard?.writeText(place.dir).then(() => new Notice(`Copied ${place.dir}`)); });
    (menu.querySelector("button") as HTMLElement | null)?.focus();
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); menu.detach(); this.placeMenu = null; } });
  }
}
