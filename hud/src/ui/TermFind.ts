import { setIcon } from "obsidian";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { findCountLabel, type FindResults } from "../data/termFind";
import { themeTokens } from "./theme";

/**
 * The Term find bar (⌘F; spec 2026-10-08-term-agent-deck §4): a small box over the terminal card that finds in the
 * selected terminal, scrollback included, with @xterm/addon-search. Typing finds as you go; Enter is the next match and
 * ⇧Enter the previous; Escape or × closes it, clears the highlights and goes back to the terminal. Switching terminals
 * while it is open finds the same words in the new one.
 */
export class TermFind {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private count: HTMLElement;
  private search: SearchAddon | null = null;
  private results: FindResults | null = null;
  private stopResults: (() => void) | null = null;

  constructor(parent: HTMLElement, private focusTerminal: () => void) {
    this.el = parent.createDiv({ cls: "aos-tf is-hidden", attr: { role: "search" } });
    this.input = this.el.createEl("input", { cls: "aos-tf-input", attr: { type: "text", placeholder: "Find", "aria-label": "Find in the terminal", spellcheck: "false" } });
    this.count = this.el.createSpan({ cls: "aos-tf-count", attr: { "aria-live": "polite" } });
    const prev = this.el.createEl("button", { cls: "aos-tf-btn", attr: { type: "button", "aria-label": "Previous match", title: "Previous match (⇧⏎)" } });
    const prevIcon = prev.createSpan({ cls: "aos-tf-icon" });
    setIcon(prevIcon, "chevron-up");
    const next = this.el.createEl("button", { cls: "aos-tf-btn", attr: { type: "button", "aria-label": "Next match", title: "Next match (⏎)" } });
    const nextIcon = next.createSpan({ cls: "aos-tf-icon" });
    setIcon(nextIcon, "chevron-down");
    const close = this.el.createEl("button", { cls: "aos-tf-btn", attr: { type: "button", "aria-label": "Close find", title: "Close (esc)" } });
    const closeIcon = close.createSpan({ cls: "aos-tf-icon" });
    setIcon(closeIcon, "x");
    prev.addEventListener("click", () => { this.find("previous"); this.input.focus(); });
    next.addEventListener("click", () => { this.find("next"); this.input.focus(); });
    close.addEventListener("click", () => this.close());
    this.input.addEventListener("input", () => this.find("next", true));
    this.input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") { e.preventDefault(); this.find(e.shiftKey ? "previous" : "next"); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
  }

  /** Opens the bar on a terminal's search (⌘F again only brings focus back), with the last words selected. */
  open(search: SearchAddon): void {
    const fresh = !this.isOpen() || this.search !== search;
    this.attach(search);
    this.el.removeClass("is-hidden");
    this.input.focus();
    this.input.select();
    if (fresh && this.input.value) this.find("next", true);
  }

  /** Points an open bar at the terminal now selected (or closes it when none is left): the old one's highlights go. */
  retarget(search: SearchAddon | null): void {
    if (!this.isOpen() || search === this.search) return;
    if (!search) { this.close(false); return; }
    this.attach(search);
    this.find("next", true);
  }

  /** Draws the highlights again, in the theme's colours (xterm keeps a decoration's colour until it is redrawn). */
  refresh(): void {
    if (!this.isOpen() || !this.search || !this.input.value) return;
    this.search.clearDecorations();
    this.find("next", true);
  }

  close(refocus = true): void {
    if (!this.isOpen()) return;
    this.detach();
    this.el.addClass("is-hidden");
    if (refocus) this.focusTerminal();
  }

  isOpen(): boolean { return !this.el.hasClass("is-hidden"); }

  isFocused(): boolean { return this.el.contains(document.activeElement); }

  private attach(search: SearchAddon): void {
    if (this.search === search) return;
    this.detach();
    this.search = search;
    const sub = search.onDidChangeResults((r) => { this.results = r; this.renderCount(); });
    this.stopResults = () => sub.dispose();
  }

  private detach(): void {
    this.stopResults?.();
    this.stopResults = null;
    // A closed terminal took its addon with it: there is nothing left to clear.
    try { this.search?.clearDecorations(); } catch { /* disposed */ }
    this.search = null;
    this.results = null;
    this.renderCount();
  }

  private find(dir: "next" | "previous", incremental = false): void {
    const q = this.input.value;
    if (!this.search) return;
    if (!q) { this.search.clearDecorations(); this.results = null; this.renderCount(); return; }
    const t = themeTokens(this.el.ownerDocument);
    const opts: ISearchOptions = {
      incremental,
      decorations: { matchBackground: t.termFindMatch, matchOverviewRuler: t.termFindMatch, activeMatchBackground: t.termFindActive, activeMatchColorOverviewRuler: t.termFindActive },
    };
    if (dir === "next") this.search.findNext(q, opts);
    else this.search.findPrevious(q, opts);
  }

  private renderCount(): void {
    const label = findCountLabel(this.input.value, this.results);
    this.count.setText(label);
    this.count.toggleClass("is-none", label === "No results");
  }
}
