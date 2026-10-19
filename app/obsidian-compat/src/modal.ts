// Modal, SuggestModal and FuzzySuggestModal with Obsidian's DOM classes (.modal, .prompt, .suggestion-item), which the
// HUD's own styles.css targets.

import type { App } from "./plugin";

/** Open modals, the topmost last. */
const openModals: Modal[] = [];

/** The controls the keyboard can reach in a modal: never a disabled one, which cannot take focus. */
const FOCUSABLE = "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";

export class Modal {
  app: App;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  shouldRestoreSelection = true;
  // Only the topmost modal answers a key: Escape closes it alone, and Tab cycles through its controls, from the last
  // back to the first and, with Shift, from the first to the last (a dialog's focus never walks out behind it).
  private onKey = (ev: KeyboardEvent): void => {
    if (openModals[openModals.length - 1] !== this) return;
    if (ev.key === "Escape") { ev.preventDefault(); this.close(); return; }
    if (ev.key !== "Tab") return;
    const all = Array.from(this.modalEl.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
    if (!all.length) return;
    const first = all[0];
    const last = all[all.length - 1];
    const at = document.activeElement;
    const inside = at instanceof HTMLElement && this.modalEl.contains(at);
    if (ev.shiftKey ? !inside || at === first : !inside || at === last) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
  };
  private lastFocus: HTMLElement | null = null;
  /** The control that had the keyboard when the modal opened: it gets it back when the modal closes. */
  private returnTo: HTMLElement | null = null;
  // Keeps the keyboard in the topmost open modal. The HUD's embedded terminal focuses itself whenever it re-renders
  // (TerminalPanel, on the next animation frame), so without this the keys meant for a form here could reach a live
  // shell. Obsidian does not do this; it is the host's safety net.
  private onFocusIn = (ev: FocusEvent): void => {
    const target = ev.target instanceof HTMLElement ? ev.target : null;
    if (target && this.containerEl.contains(target)) { this.lastFocus = target; return; }
    if (openModals[openModals.length - 1] !== this) return;
    const back = this.lastFocus?.isConnected && this.containerEl.contains(this.lastFocus)
      ? this.lastFocus
      : this.modalEl.querySelector<HTMLElement>(FOCUSABLE);
    back?.focus();
  };

  constructor(app: App) {
    this.app = app;
    this.containerEl = createDiv({ cls: "modal-container mod-dim" });
    const bg = this.containerEl.createDiv({ cls: "modal-bg" });
    bg.addEventListener("click", () => this.close());
    this.modalEl = this.containerEl.createDiv({ cls: "modal" });
    const closeBtn = this.modalEl.createDiv({ cls: "modal-close-button", attr: { "aria-label": "Close" } });
    closeBtn.setText("✕");
    closeBtn.addEventListener("click", () => this.close());
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }

  open(): void {
    const at = document.activeElement;
    this.returnTo = at instanceof HTMLElement && at !== document.body ? at : null;
    document.body.appendChild(this.containerEl);
    openModals.push(this);
    document.addEventListener("keydown", this.onKey, true);
    document.addEventListener("focusin", this.onFocusIn, true);
    void this.onOpen();
  }

  close(): void {
    const i = openModals.indexOf(this);
    if (i >= 0) openModals.splice(i, 1);
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("focusin", this.onFocusIn, true);
    void this.onClose();
    this.containerEl.remove();
    // Back to the control that opened it, while it is still on the page (a redraw may have replaced it; the view then
    // puts the keyboard back itself) and no other modal holds the keyboard.
    const back = this.returnTo;
    this.returnTo = null;
    const top = openModals[openModals.length - 1];
    if (this.shouldRestoreSelection && back?.isConnected && (!top || top.containerEl.contains(back))) back.focus();
  }

  onOpen(): void | Promise<void> {}
  onClose(): void | Promise<void> {}

  setTitle(title: string): this { this.titleEl.setText(title); return this; }
  setContent(content: string | DocumentFragment): this { this.contentEl.setText(content); return this; }
}

export interface FuzzyMatch<T> { item: T; match: { score: number; matches: Array<[number, number]> } }

interface Instruction { command: string; purpose: string }

export abstract class SuggestModal<T> extends Modal {
  inputEl: HTMLInputElement;
  resultContainerEl: HTMLElement;
  limit = 50;
  emptyStateText = "No results found.";
  private instructionsEl: HTMLElement;
  private shown: T[] = [];
  private selected = 0;

  constructor(app: App) {
    super(app);
    this.modalEl.addClass("prompt");
    this.titleEl.remove();
    this.contentEl.remove();
    const wrap = this.modalEl.createDiv({ cls: "prompt-input-container" });
    this.inputEl = wrap.createEl("input", { cls: "prompt-input", attr: { type: "text", spellcheck: "false" } });
    this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" });
    this.instructionsEl = this.modalEl.createDiv({ cls: "prompt-instructions" });
    this.inputEl.addEventListener("input", () => this.update());
    this.inputEl.addEventListener("keydown", (ev) => this.onInputKey(ev));
  }

  setPlaceholder(text: string): void { this.inputEl.placeholder = text; }

  setInstructions(list: Instruction[]): void {
    this.instructionsEl.empty();
    for (const i of list) {
      const row = this.instructionsEl.createDiv({ cls: "prompt-instruction" });
      row.createSpan({ cls: "prompt-instruction-command", text: i.command });
      row.createSpan({ text: i.purpose });
    }
  }

  open(): void {
    super.open();
    this.update();
    this.inputEl.focus();
  }

  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;

  private async update(): Promise<void> {
    this.shown = (await this.getSuggestions(this.inputEl.value)).slice(0, this.limit);
    this.selected = 0;
    this.resultContainerEl.empty();
    if (this.shown.length === 0) {
      this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: this.emptyStateText });
      return;
    }
    this.shown.forEach((item, i) => {
      const el = this.resultContainerEl.createDiv({ cls: "suggestion-item" });
      this.renderSuggestion(item, el);
      el.addEventListener("mousemove", () => this.select(i));
      el.addEventListener("click", (ev) => this.choose(i, ev));
    });
    this.select(0);
  }

  private select(i: number): void {
    const items = this.resultContainerEl.querySelectorAll(".suggestion-item");
    items[this.selected]?.classList.remove("is-selected");
    this.selected = Math.max(0, Math.min(i, items.length - 1));
    const el = items[this.selected];
    el?.classList.add("is-selected");
    el?.scrollIntoView({ block: "nearest" });
  }

  private choose(i: number, ev: MouseEvent | KeyboardEvent): void {
    const item = this.shown[i];
    if (item === undefined) return;
    this.close();
    this.onChooseSuggestion(item, ev);
  }

  private onInputKey(ev: KeyboardEvent): void {
    if (ev.key === "ArrowDown") { ev.preventDefault(); this.select(this.selected + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); this.select(this.selected - 1); }
    else if (ev.key === "Enter") { ev.preventDefault(); this.choose(this.selected, ev); }
  }
}

/** Scores `text` against `query` as an in-order subsequence; contiguous runs and early matches score higher. */
export function fuzzyScore(query: string, text: string): FuzzyMatch<null>["match"] | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, matches: [] };
  const t = text.toLowerCase();
  const matches: Array<[number, number]> = [];
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    run = found === ti ? run + 1 : 1;
    score += run * 2 - (found - ti) * 0.1 - found * 0.001;
    const last = matches[matches.length - 1];
    if (last && last[1] === found) last[1] = found + 1; else matches.push([found, found + 1]);
    ti = found + 1;
  }
  return { score, matches };
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

  getSuggestions(query: string): FuzzyMatch<T>[] {
    const out: FuzzyMatch<T>[] = [];
    for (const item of this.getItems()) {
      const match = fuzzyScore(query, this.getItemText(item));
      if (match) out.push({ item, match });
    }
    return query.trim() ? out.sort((a, b) => b.match.score - a.match.score) : out;
  }

  renderSuggestion(value: FuzzyMatch<T>, el: HTMLElement): void { el.setText(this.getItemText(value.item)); }

  onChooseSuggestion(value: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void { this.onChooseItem(value.item, evt); }
}
