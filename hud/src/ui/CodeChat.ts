// CodeChat — the Code tab's chat view of an agent terminal (spec 2026-11-09-code-chat C1, C4, C5; §4 "Layout of record").
// It draws the conversation the terminal's follower mirrors (data/codeFeeds.ts), in a 760 px column: your prompts as
// bubbles, the agent's text, tool rows that open (one ThreadView for the chat's life, Sessions' renderer), Show earlier
// over the 400-row cap, a working line with Stop while a turn runs, and a card for the TUI's prompt (Task 12 fills it).
// Under the column sit the composer (TerminalPanel moves its element into `composerSlot` while the chat shows) and the
// status line, drawn from spans exactly as the terminal draws it (C5), or the hint when there is none. The live PTY is
// one key away: every "Terminal ⌘J" here calls `toTerminal`.

import { Component, MarkdownRenderer } from "obsidian";
import type { SessionHost } from "../data/aosConfig";
import type { ChatState } from "../data/codeChat";
import type { Span } from "../data/ansiSpans";
import { ThreadView, type ThreadViewContext } from "./ThreadView";

/** What the TUI asks for, as Task 12 reads it from the terminal's screen (C4): its question with numbered choices, or a
 *  generic card when the screen shows something the chat cannot draw. */
export type ChatCard =
  | { kind: "approval"; title: string; detail: string | null; choices: { key: string; label: string }[] }
  | { kind: "waiting" };

export interface CodeChatOptions {
  /** The same terminal (⌘J). */
  toTerminal(): void;
  /** Stop, while a turn runs: Esc to the PTY. */
  stop(): void;
  /** Show earlier: the rows before the cap. */
  showEarlier(): void;
  /** A card's choice: the key its TUI takes. */
  answer?(key: string): void;
  /** A status line link (https:// or agenticos://), opened as a link clicked in the terminal is (R32). */
  openLink(href: string): void;
  /** The terminal's host and folder: models and file paths are named by them. */
  context(): { host: SessionHost; root: string | null };
}

/** How near the bottom counts as "at the end", where new rows keep the view. */
const AT_END_PX = 48;
const NO_CHAT = "No chat for this session yet";
const HINT = "Status line in the terminal ⌘J";

export class CodeChat {
  readonly el: HTMLElement;
  /** Where the composer sits while the chat shows. */
  readonly composerSlot: HTMLElement;
  private scroll: HTMLElement;
  private earlierEl: HTMLElement;
  private rowsEl: HTMLElement;
  private noteEl: HTMLElement;
  private workingEl: HTMLElement;
  private cardEl: HTMLElement;
  private statusEl: HTMLElement;
  private thread: ThreadView;
  private md = new Component();
  private expanded = new Set<string>();
  private state: ChatState | null = null;
  private why: string | null = null;
  private toEnd = true;

  constructor(parent: HTMLElement, private readonly o: CodeChatOptions) {
    this.md.load();
    this.el = parent.createDiv({ cls: "aos-cc is-hidden", attr: { role: "region", "aria-label": "Conversation" } });
    this.scroll = this.el.createDiv({ cls: "aos-cc-scroll" });
    const col = this.scroll.createDiv({ cls: "aos-cc-col" });
    this.earlierEl = col.createDiv({ cls: "aos-cc-earlier" });
    const earlier = this.earlierEl.createEl("button", { cls: "aos-cc-earlierbtn", text: "Show earlier", attr: { type: "button" } });
    earlier.addEventListener("click", () => this.o.showEarlier());
    this.rowsEl = col.createDiv({ cls: "aos-cc-rows" });
    this.noteEl = col.createDiv({ cls: "aos-cc-note" });
    this.workingEl = col.createDiv({ cls: "aos-cc-working" });
    this.cardEl = col.createDiv({ cls: "aos-cc-card" });
    const foot = this.el.createDiv({ cls: "aos-cc-foot" });
    const footCol = foot.createDiv({ cls: "aos-cc-footcol" });
    this.composerSlot = footCol.createDiv({ cls: "aos-cc-composer" });
    this.statusEl = footCol.createDiv({ cls: "aos-cc-status", attr: { title: "Your status line, as the terminal draws it" } });
    this.thread = new ThreadView(this.rowsEl, {
      md: (el, text) => { void MarkdownRenderer.renderMarkdown(text, el, "", this.md); },
      expanded: this.expanded,
      onToggle: (key) => {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.render();
      },
    });
    this.setStatus(null);
  }

  /** Shown or hidden (TerminalPanel's view switch). */
  setVisible(on: boolean): void {
    this.el.toggleClass("is-hidden", !on);
    if (on && this.toEnd) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  /** Another terminal's chat from now on: its rows start closed and its view at the end. */
  reset(): void {
    this.expanded.clear();
    this.state = null;
    this.why = null;
    this.toEnd = true;
    this.setCard(null);
  }

  /** The chat as it is now; `why`: the reason it has none (main's answer to follow), shown on the empty line's hover. */
  show(state: ChatState, why: string | null = null): void {
    this.state = state;
    this.why = why;
    this.render();
  }

  /** The TUI's prompt as a card after the last row, or none (Task 12). */
  setCard(card: ChatCard | null): void {
    const el = this.cardEl;
    el.empty();
    el.toggleClass("is-on", !!card);
    if (!card) return;
    if (card.kind === "waiting") {
      const box = el.createDiv({ cls: "aos-cc-gate is-waiting" });
      box.createSpan({ cls: "aos-cc-gatetitle", text: "Waiting on you in the terminal" });
      this.jump(box, "⌘J");
      return;
    }
    const box = el.createDiv({ cls: "aos-cc-gate", attr: { role: "group", "aria-label": card.title } });
    box.createDiv({ cls: "aos-cc-gatetitle", text: card.title });
    if (card.detail) box.createDiv({ cls: "aos-cc-gatedetail", text: card.detail });
    const row = box.createDiv({ cls: "aos-cc-gatechoices" });
    card.choices.forEach((c, i) => {
      const b = row.createEl("button", { cls: `aos-cc-choice${i === 0 ? " is-first" : ""}`, attr: { type: "button" } });
      b.createSpan({ text: c.label });
      b.createSpan({ cls: "aos-cc-choicekey", text: c.key });
      b.addEventListener("click", () => this.o.answer?.(c.key));
    });
    this.jump(row, "Answer in the terminal ⌘J");
  }

  /** The status line's rows (C5), or the hint when there is none to show. Links keep their target as an attribute and
   *  open through `openLink` (R32): the page never navigates. */
  setStatus(lines: Span[][] | null): void {
    const el = this.statusEl;
    el.empty();
    el.toggleClass("is-hint", !lines);
    if (!lines) {
      const hint = el.createEl("button", { cls: "aos-cc-hint", text: HINT, attr: { type: "button" } });
      hint.addEventListener("click", () => this.o.toTerminal());
      return;
    }
    for (const line of lines) {
      const row = el.createDiv({ cls: "aos-cc-statusline" });
      for (const span of line) {
        const node = span.href ? row.createEl("a", { cls: "aos-cc-statuslink", text: span.text }) : row.createSpan({ text: span.text });
        if (span.fg) node.style.color = span.fg;
        if (span.bold) node.style.fontWeight = "600";
        if (span.dim) node.style.opacity = "0.7";
        if (span.underline) node.style.textDecoration = "underline";
        const href = span.href;
        if (href) {
          node.setAttribute("href", href);
          const open = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); if (e.type === "click") this.o.openLink(href); };
          node.addEventListener("click", open);
          node.addEventListener("auxclick", open);
        }
      }
      if (!line.length) row.appendText(" ");
    }
  }

  destroy(): void {
    this.thread.destroy();
    this.md.unload();
    this.el.detach();
  }

  // ── private ──

  private render(): void {
    const s = this.state;
    const sc = this.scroll;
    const atEnd = this.toEnd || sc.scrollHeight - sc.scrollTop - sc.clientHeight < AT_END_PX;
    const focus = this.focusKey();
    this.earlierEl.toggleClass("is-on", !!s && s.hiddenEarlier > 0);
    this.rowsEl.empty();
    this.noteEl.empty();
    this.workingEl.empty();
    if (s) {
      const c = this.o.context();
      const ctx: ThreadViewContext = { host: c.host, entry: null, root: c.root, choices: new Map() };
      this.thread.render(s.rows, ctx);
    }
    this.noteEl.removeAttribute("title");
    if (s?.error) this.note(s.error);
    else if (!s || !s.rows.length) {
      this.note(`${NO_CHAT} · Terminal ⌘J`);
      if (this.why) this.noteEl.setAttr("title", this.why);
    }
    if (s?.turnOpen) {
      this.workingEl.createSpan({ cls: "aos-cc-workingtext", text: "Working…" });
      const stop = this.workingEl.createEl("button", { cls: "aos-cc-stop", attr: { type: "button", title: "Stop this turn (Esc in the terminal)" } });
      stop.createSpan({ text: "Stop" });
      stop.createSpan({ cls: "aos-cc-kbd", text: "esc", attr: { "aria-hidden": "true" } });
      stop.addEventListener("click", () => this.o.stop());
    }
    this.restoreFocus(focus);
    if (atEnd) sc.scrollTop = sc.scrollHeight;
    // Hidden, the column has no height to scroll: it goes to the end when it shows (setVisible).
    if (s && !this.el.hasClass("is-hidden")) this.toEnd = false;
  }

  /** A line that ends in "Terminal ⌘J" gets that part as a button to the terminal. */
  private note(text: string): void {
    const m = /^(.*?)(?: · )?(Terminal ⌘J)$/.exec(text);
    if (!m) { this.noteEl.setText(text); return; }
    this.noteEl.appendText(m[1] ? `${m[1]} · ` : "");
    this.jump(this.noteEl, m[2]);
  }

  private jump(parent: HTMLElement, label: string): void {
    const b = parent.createEl("button", { cls: "aos-cc-jump", text: label, attr: { type: "button" } });
    b.addEventListener("click", () => this.o.toTerminal());
  }

  /** The tool line that has the focus, so a redraw gives it back (SessionsTab's keepFocus). */
  private focusKey(): string | null {
    const a = this.el.ownerDocument.activeElement as HTMLElement | null;
    return a && this.rowsEl.contains(a) ? a.getAttribute("data-focus") : null;
  }

  private restoreFocus(key: string | null): void {
    if (!key) return;
    const el = Array.from(this.rowsEl.querySelectorAll<HTMLElement>("[data-focus]")).find((x) => x.getAttribute("data-focus") === key);
    el?.focus();
  }
}
