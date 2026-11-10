// CodeStage — the Code deck's stage (spec 2026-11-09-code-chat C1, C3, C5, C6, C13): the CodeChat that lies over the
// selected terminal's body (which stays laid out, hidden, at its last size), the read-only chat of a past conversation, the
// view that shows, and the composer's place under the stage or inside the chat's column. TerminalPanel owns the terminals;
// the stage asks it for the selected one through its host.

import type AgenticOSPlugin from "../../main";
import type { TerminalSession } from "../data/terminalSession";
import { hudHost } from "../host";
import { TERM_HOST_LABEL, type Place } from "../data/terminalLaunch";
import type { HistoryResume } from "../data/sessionHistory";
import { pastEarlier, pastState, pastView, type PastView } from "../data/pastChat";
import type { CodeView } from "../data/codeFeeds";
import type { ChatState } from "../data/codeChat";
import type { Span } from "../data/ansiSpans";
import type { ChatCard } from "../data/termScreen";
import { CodeChat } from "./CodeChat";
import type { TermComposer } from "./TermComposer";

/** A chat with nothing in it yet. */
const NO_CHAT: ChatState = { sessionId: null, rows: [], hiddenEarlier: 0, turnOpen: false, error: null, model: null };
const NO_REASON = "The conversation could not be loaded";

/** A past conversation open read-only in the stage (code-chat C6): a History row, or one closed in this app. */
export interface PastSel { key: string; host: "claude" | "codex"; id: string; title: string; place: Place; resume: HistoryResume }

/** What the stage needs of the panel that holds it. */
export interface CodeStageHost {
  activeId(): string | null;
  activeSession(): TerminalSession | undefined;
  composer(): TermComposer | null;
  /** Flips the selected agent terminal's view (the chat's "Terminal" link). */
  setView(v: CodeView): void;
  openLink(href: string): void;
  renderTabs(): void;
}

export class CodeStage {
  /** The deck's main column, and the stage that holds the terminal's body under the chat (code-chat C1). */
  frameEl: HTMLElement | null = null;
  stageEl: HTMLElement | null = null;
  chat: CodeChat | null = null;
  /** The past conversation shown read-only instead of a terminal, its chat, and what it shows now. */
  past: PastSel | null = null;
  private pastChat: CodeChat | null = null;
  private pastData: PastView | null = null;
  private pastSeq = 0;
  /** The terminal whose chat the CodeChat shows now, and what it drew of it (the feed's objects, which CodeFeeds replaces
   *  on every change, so the same ones mean nothing new to draw: I3). */
  private chatFor: string | null = null;
  private drawn: { state: ChatState; why: string | null; status: Span[][] | null; card: ChatCard | null } | null = null;

  constructor(private plugin: AgenticOSPlugin, private host: CodeStageHost) {}

  /** Mounts the stage in the deck's main column: the terminal's body, with the chats over it. Returns the body. */
  mount(frame: HTMLElement): HTMLElement {
    this.frameEl = frame;
    this.stageEl = frame.createDiv({ cls: "aos-term-stage" });
    const body = this.stageEl.createDiv({ cls: "aos-term-body" });
    this.chat = new CodeChat(this.stageEl, {
      toTerminal: () => this.host.setView("terminal"),
      stop: () => { const s = this.host.activeSession(); if (s && !s.isExited && !s.agentEnded) s.write("\x1b"); },
      // A card's choice (C4): never into the login shell of an agent that ended, nor while the composer is kept away
      // (R39); CodeFeeds writes the key only if the screen still shows that prompt.
      // It goes to the terminal whose card was drawn, and only while that card is still the live one.
      answer: (key, card) => {
        const s = this.host.activeSession();
        if (!s || this.past || s.id !== this.chatFor || s.isExited || s.agentEnded || this.host.composer()?.isBlocked) return false;
        return this.plugin.codeFeeds?.answer(s.id, key, card) ?? false;
      },
      showEarlier: () => { const id = this.host.activeId(); if (id) this.plugin.codeFeeds?.showEarlier(id); },
      openLink: (href) => this.host.openLink(href),
      context: () => {
        const s = this.host.activeSession();
        return { host: s?.meta.host === "codex" ? "codex" : "claude", root: s ? s.meta.place?.dir ?? s.cwd : null };
      },
    });
    this.pastChat = new CodeChat(this.stageEl, {
      readOnly: true,
      toTerminal: () => {}, stop: () => {},
      showEarlier: () => { if (this.pastData && this.past) { this.pastData = pastEarlier(this.pastData); this.drawPast(); } },
      openLink: (href) => this.host.openLink(href),
      context: () => ({ host: this.past?.host ?? "claude", root: this.past?.place.dir ?? null }),
    });
    return body;
  }

  destroy(): void {
    this.chat?.destroy();
    this.chat = null;
    this.pastChat?.destroy();
    this.pastChat = null;
    this.past = null;
    this.pastData = null;
    this.pastSeq++;
    this.chatFor = null;
    this.drawn = null;
    this.frameEl = null;
    this.stageEl = null;
  }

  // ── a past conversation, read-only (code-chat C6) ──

  /** Opens a past conversation: main mirrors it once (`code.view`), then the cache is read whole into the read-only chat. */
  showPast(sel: PastSel): void {
    const chat = this.pastChat;
    if (!chat) return;
    const seq = ++this.pastSeq;
    this.past = sel;
    this.pastData = null;
    chat.reset();
    chat.show(NO_CHAT, "Loading…");
    this.host.renderTabs();
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
  clearPast(): void {
    if (!this.past) return;
    this.past = null;
    this.pastData = null;
    this.pastSeq++;
  }

  // ── the chat view (spec 2026-11-09-code-chat C1, C3, C5, C13) ──

  /** Which view the selected terminal shows: always its terminal outside the deck. */
  viewOf(s: TerminalSession | undefined): CodeView {
    if (!s || !this.chat) return "terminal";
    return this.plugin.codeFeeds?.view(s.id) ?? "terminal";
  }

  /** Whether the selected terminal shows its chat now. */
  chatShown(): boolean { return this.viewOf(this.host.activeSession()) === "chat"; }

  /** Shows the selected terminal's view: the chat over its hidden terminal, with the composer in the chat's column, or
   *  the terminal with the composer under it. */
  applyView(): void {
    const chat = this.chat;
    const stage = this.stageEl;
    const composer = this.host.composer();
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
    const s = this.host.activeSession();
    const ended = !!s && s.meta.host !== "shell" && s.agentEnded;
    composer.block(on && ended);
    if (on && composer.el.parentElement !== chat.composerSlot) chat.composerSlot.appendChild(composer.el);
    if (!on && composer.el.parentElement !== frame) stage.after(composer.el);
    chat.setVisible(on);
    // A title or a model changing redraws the top bar, not the chat: the feed's own changes redraw that.
    if (on && (!was || this.chatFor !== this.host.activeId())) this.renderChat(true);
    // After renderChat, whose reset() for another terminal clears it.
    chat.setEnded(ended && s ? TERM_HOST_LABEL[s.meta.host] : null);
  }

  /** The selected terminal's chat, as its feed has it now. Only what changed is drawn again (I3): a status line that moved
   *  redraws the status line, not 400 rows (and your selection in them); `force` draws it all (the chat shown again). The
   *  card is the TUI's prompt on its screen (C4), none once the agent ended (R39). */
  renderChat(force = false): void {
    const chat = this.chat;
    const s = this.host.activeSession();
    if (!chat || !s || this.past || !this.chatShown()) return;
    const feed = this.plugin.codeFeeds?.get(s.id) ?? null;
    if (this.chatFor !== s.id) { chat.reset(); this.chatFor = s.id; this.drawn = null; }
    const state = feed?.state ?? NO_CHAT;
    const why = feed?.follow === "failed" ? feed.error : null;
    const status = feed?.status ?? null;
    const card = s.agentEnded || s.isExited ? null : feed?.card ?? null;
    const was = force ? null : this.drawn;
    if (!was || was.state !== state || was.why !== why) chat.show(state, why);
    if (!was || was.status !== status) chat.setStatus(status);
    if (!was || was.card !== card) chat.setCard(card);
    this.drawn = { state, why, status, card };
  }
}
