// CodeChat — the Code tab's chat view of an agent terminal (spec 2026-11-09-code-chat C1, C4, C5; §4 "Layout of record").
// It draws the conversation the terminal's follower mirrors (data/codeFeeds.ts), in a 760 px column: your prompts as
// bubbles, the agent's text, tool rows that open (one ThreadView for the chat's life, Sessions' renderer), Show earlier
// over the 400-row cap, a working line with Stop while a turn runs, and a card for the TUI's prompt, read from the
// terminal's screen (data/codeFeeds.ts): its question with numbered choices, or "Waiting on you in the terminal".
// Under the column sit the composer (TerminalPanel moves its element into `composerSlot` while the chat shows) and the
// status line, drawn from spans exactly as the terminal draws it (C5), or the hint when there is none. The live PTY is
// one key away: every "Terminal ⌘J" here calls `toTerminal`. When the agent has exited and the login shell runs in its
// terminal (R39), the history stays, Stop and the working line go, and a notice takes the composer's place.

import { Component, MarkdownRenderer } from "obsidian";
import { routeWebLinks } from "./openWebLink";
import type { SessionHost } from "../data/aosConfig";
import type { ChatState } from "../data/codeChat";
import type { Span } from "../data/ansiSpans";
import type { ChatCard } from "../data/termScreen";
import { ThreadView, type ThreadViewContext } from "./ThreadView";

export type { ChatCard } from "../data/termScreen";

export interface CodeChatOptions {
  /** The same terminal (⌘J). */
  toTerminal(): void;
  /** Stop, while a turn runs: Esc to the PTY. */
  stop(): void;
  /** Show earlier: the rows before the cap. */
  showEarlier(): void;
  /** A card's choice: the key its TUI takes; true (or a promise of it) when it was written (the choices then wait for the
   *  next card). */
  answer?(key: string, card: ChatCard): boolean | Promise<boolean>;
  /** A status line link (https:// or agenticos://), opened as a link clicked in the terminal is (R32). */
  openLink(href: string): void;
  /** The session a web link clicked in a message belongs to (its browser), or null: none (a past conversation's chat). */
  linkSession(): string | null;
  /** The terminal's host and folder: models and file paths are named by them. */
  context(): { host: SessionHost; root: string | null };
  /** A past conversation (C6): rows and Show earlier only, with no composer, status line, Stop or way to a terminal. */
  readOnly?: boolean;
}

/** How near the bottom counts as "at the end", where new rows keep the view. */
const AT_END_PX = 48;
const NO_CHAT = "No chat for this session yet";
const HINT = "Status line in the terminal ⌘J";
const WAITING = "Waiting on you in the terminal";
const ANSWER = "Answer in the terminal ⌘J";

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
  private endedEl: HTMLElement;
  private thread: ThreadView;
  private md = new Component();
  private expanded = new Set<string>();
  private state: ChatState | null = null;
  private why: string | null = null;
  /** The host whose agent ended in this terminal (R39), or null while it runs. */
  private ended: string | null = null;
  private toEnd = true;

  constructor(parent: HTMLElement, private readonly o: CodeChatOptions) {
    this.md.load();
    this.el = parent.createDiv({ cls: `aos-cc is-hidden${o.readOnly ? " is-readonly" : ""}`, attr: { role: "region", "aria-label": "Conversation" } });
    this.scroll = this.el.createDiv({ cls: "aos-cc-scroll" });
    const col = this.scroll.createDiv({ cls: "aos-cc-col" });
    this.earlierEl = col.createDiv({ cls: "aos-cc-earlier" });
    const earlier = this.earlierEl.createEl("button", { cls: "aos-cc-earlierbtn", text: "Show earlier", attr: { type: "button" } });
    earlier.addEventListener("click", () => this.o.showEarlier());
    this.rowsEl = col.createDiv({ cls: "aos-cc-rows" });
    // The message bodies' web links; the status line (in the foot, outside the rows) keeps its own openLink.
    routeWebLinks(this.rowsEl, () => o.linkSession());
    this.noteEl = col.createDiv({ cls: "aos-cc-note" });
    this.workingEl = col.createDiv({ cls: "aos-cc-working" });
    this.cardEl = col.createDiv({ cls: "aos-cc-card", attr: { "aria-live": "polite" } });
    // A read-only chat has no foot: its slot and status line are never in the page.
    const footCol = o.readOnly ? this.el.ownerDocument.createElement("div") : this.el.createDiv({ cls: "aos-cc-foot" }).createDiv({ cls: "aos-cc-footcol" });
    this.endedEl = footCol.appendChild(this.el.ownerDocument.createElement("div"));
    this.endedEl.className = "aos-cc-ended";
    this.endedEl.setAttribute("role", "status");
    this.composerSlot = footCol.appendChild(this.el.ownerDocument.createElement("div"));
    this.composerSlot.className = "aos-cc-composer";
    this.statusEl = footCol.appendChild(this.el.ownerDocument.createElement("div"));
    this.statusEl.className = "aos-cc-status";
    this.statusEl.title = "Your status line, as the terminal draws it";
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

  /** Shown or hidden (TerminalPanel's view switch). Shown again, a card up (one that came while it was hidden) is brought
   *  into view. */
  setVisible(on: boolean): void {
    const was = !this.el.hasClass("is-hidden");
    this.el.toggleClass("is-hidden", !on);
    if (on && this.toEnd) this.scroll.scrollTop = this.scroll.scrollHeight;
    if (on && !was) this.revealCard();
  }

  /** Another terminal's chat from now on: its rows start closed and its view at the end. */
  reset(): void {
    this.expanded.clear();
    this.state = null;
    this.why = null;
    this.toEnd = true;
    this.setCard(null);
    this.setEnded(null);
  }

  /** The chat as it is now; `why`: the reason it has none (main's answer to follow), shown on the empty line's hover. */
  show(state: ChatState, why: string | null = null): void {
    this.state = state;
    this.why = why;
    this.render();
  }

  /**
   * The agent ended and the login shell took over its terminal (R39): `host` names it ("Claude Code"), null while it runs.
   * The rows stay readable; Stop and the working line go; "<Host> ended · Terminal ⌘J" stands where the composer was (the
   * panel keeps the composer out, so nothing typed here reaches the shell).
   */
  setEnded(host: string | null): void {
    if (host === this.ended) return;
    this.ended = host;
    this.el.toggleClass("is-ended", !!host);
    this.endedEl.empty();
    if (host) {
      this.endedEl.appendText(`${host} ended · `);
      this.jump(this.endedEl, "Terminal ⌘J");
    }
    if (this.state) this.render();
  }

  /** The TUI's prompt as a card after the last row, or none (C4). Nothing here flips the view: the card waits in the
   *  chat, and its "Answer in the terminal ⌘J" goes there when you choose to. A card that appears or changes is scrolled
   *  into view (it is last, often under the fold). */
  setCard(card: ChatCard | null): void {
    const el = this.cardEl;
    el.empty();
    el.toggleClass("is-on", !!card);
    if (!card) return;
    if (card.kind === "waiting") {
      const box = el.createDiv({ cls: "aos-cc-gate is-waiting", attr: { role: "group", "aria-label": WAITING } });
      box.createSpan({ cls: "aos-cc-gatetitle", text: WAITING });
      this.jump(box, ANSWER);
      this.revealCard();
      return;
    }
    const box = el.createDiv({ cls: "aos-cc-gate", attr: { role: "group", "aria-label": card.title } });
    box.createDiv({ cls: "aos-cc-gatetitle", text: card.title });
    if (card.detail) box.createDiv({ cls: "aos-cc-gatedetail", text: card.detail });
    const row = box.createDiv({ cls: "aos-cc-gatechoices" });
    const buttons: HTMLButtonElement[] = [];
    card.choices.forEach((c, i) => {
      const b = row.createEl("button", { cls: `aos-cc-choice${i === 0 ? " is-first" : ""}`, attr: { type: "button", title: `${c.label} (${c.key} in the terminal)` } });
      // A long label (a path in it) wraps inside the card, never wider than it.
      b.createSpan({ cls: "aos-cc-choicelabel", text: c.label });
      b.createSpan({ cls: "aos-cc-choicekey", text: c.key });
      buttons.push(b);
      b.addEventListener("click", () => {
        if (b.disabled) return;
        // One answer per prompt: the choices wait for the TUI to move on (the next card), or come back when nothing was
        // written (the prompt changed under the click, or the agent ended).
        for (const x of buttons) x.disabled = true;
        const back = (ok: boolean | undefined) => { if (ok !== true) for (const x of buttons) x.disabled = false; };
        const r = this.o.answer?.(c.key, card);
        if (r instanceof Promise) void r.then(back, () => back(false));
        else back(r);
      });
    });
    this.jump(row, ANSWER);
    this.revealCard();
  }

  /** Scrolls the chat so the card is in view: its bottom at the view's bottom, or its top at the view's top when it is
   *  taller than the view. Smooth unless the person asked for reduced motion (as the tour scrolls); nothing while hidden. */
  private revealCard(): void {
    if (!this.cardEl.hasClass("is-on") || this.el.hasClass("is-hidden")) return;
    const sc = this.scroll;
    const view = sc.getBoundingClientRect();
    const box = this.cardEl.getBoundingClientRect();
    let by = box.bottom > view.bottom ? box.bottom - view.bottom : 0;
    if (box.top - by < view.top) by = box.top - view.top;
    if (Math.abs(by) < 1) return;
    const reduce = this.el.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    sc.scrollTo({ top: sc.scrollTop + by, behavior: reduce ? "auto" : "smooth" });
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
    else if (this.o.readOnly) {
      if (!s || !s.rows.length) this.noteEl.setText(this.why ?? "Loading…");
    } else if (!s || !s.rows.length) {
      this.note(`${NO_CHAT} · Terminal ⌘J`);
      if (this.why) this.noteEl.setAttr("title", this.why);
    }
    if (s?.turnOpen && !this.o.readOnly && !this.ended) {
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
    if (this.o.readOnly) { this.noteEl.setText(text); return; }
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
