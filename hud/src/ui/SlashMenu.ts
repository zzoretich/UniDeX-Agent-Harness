import type { SessionHost } from "../data/aosConfig";
import { HOST_LABEL, commandQuery, filterCommands, type CatalogCommand } from "../data/agentSessions";

/** The keys the menu answers, as its footnote says them. */
export const SLASH_KEYS = "↑↓ move · ↵ insert · esc close";

/** What the host's commands are called: Codex lists skills (spec U8). */
function noun(host: SessionHost, n: number): string {
  const word = host === "codex" ? "skill" : "command";
  return n === 1 ? word : `${word}s`;
}

/** The menu's heading. */
export function slashHeading(host: SessionHost): string {
  return host === "codex" ? "Skills" : "Commands";
}

/** The footnote: how many the host listed, "211 commands from Claude Code". */
export function slashCount(host: SessionHost, listed: number): string {
  return `${listed} ${noun(host, listed)} from ${HOST_LABEL[host]}`;
}

/** What the menu says with nothing to show: the host listed none (typing `$name` still reaches Codex), or none match. */
export function slashEmpty(host: SessionHost, listed: number, query: string): string {
  if (!listed) return host === "codex" ? "Codex listed no skills; typing $name still works" : `${HOST_LABEL[host]} listed no commands`;
  return `No ${noun(host, 2)} match ${query}`;
}

/** The composer's text with its leading command token (`/rev`, `$fix`) replaced by the command's insert text. */
export function insertCommand(text: string, insert: string): string {
  return insert + text.replace(/^[/$]\S*/, "").replace(/^\s+/, "");
}

/** The index `delta` rows away from `i` in a list of `n`, wrapping at both ends; -1 for an empty list. */
export function stepIndex(i: number, delta: number, n: number): number {
  if (n <= 0) return -1;
  return (((i + delta) % n) + n) % n;
}

let menuSeq = 0;

export interface SlashMenuOptions {
  commands: CatalogCommand[];
  host: SessionHost;
  /** After a command went into the textarea (which also fires its own `input` event). */
  onInsert?: (command: CatalogCommand, text: string) => void;
}

/**
 * The composer's `/` menu (spec 2026-10-07-sessions-ux U8). It watches the textarea: while the text is a command being
 * typed (`/` or, on Codex, `$` and no space yet) it shows the host's matching commands above the composer, the first
 * one selected. ↑↓ move, Enter or Tab inserts the command's text in place of the typed token, Escape closes and keeps
 * the text, a click inserts. Focus stays in the textarea throughout (aria-activedescendant), and ⌘↵ still sends.
 */
export class SlashMenu {
  private opts: SlashMenuOptions;
  private menu: HTMLElement | null = null;
  private items: CatalogCommand[] = [];
  private index = 0;
  /** The text Escape closed the menu on (or an insert left): it stays closed until the text changes. */
  private dismissed: string | null = null;
  private query: string | null = null;
  /** While an insert fires the textarea's input event, which must not reopen the menu on the inserted text. */
  private inserting = false;
  private readonly id = `aos-sm-${++menuSeq}`;
  private readonly onInput = (): void => {
    if (!this.inserting) this.dismissed = null;
    this.refresh();
  };
  private readonly onFocus = (): void => this.refresh();
  private readonly onBlur = (): void => this.close();
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);

  constructor(private input: HTMLTextAreaElement, private anchor: HTMLElement, opts: SlashMenuOptions) {
    this.opts = { ...opts };
    this.anchor.addClass("aos-sm-anchor");
    input.addEventListener("input", this.onInput);
    input.addEventListener("focus", this.onFocus);
    input.addEventListener("blur", this.onBlur);
    // Capture, so the menu's keys reach it before the composer's own handlers on the same textarea.
    input.addEventListener("keydown", this.onKey, { capture: true });
  }

  /** New commands or host (the catalog answered, or the draft's host changed); an open menu redraws. */
  update(commands: CatalogCommand[], host: SessionHost): void {
    this.opts = { ...this.opts, commands, host };
    if (this.menu) this.refresh();
  }

  isOpen(): boolean {
    return !!this.menu;
  }

  /** Opens, redraws or closes the menu for the textarea's text; call it after setting the text from code. */
  refresh(): void {
    const text = this.input.value;
    const q = commandQuery(text, this.opts.host);
    if (q === null || text === this.dismissed || document.activeElement !== this.input) { this.close(); return; }
    // A new query selects its first match; a redraw for the same query (new commands) keeps the selected one.
    const keep = this.menu && q === this.query ? this.items[this.index]?.name : undefined;
    this.query = q;
    this.items = filterCommands(this.opts.commands, q).items;
    this.index = Math.max(0, keep ? this.items.findIndex((c) => c.name === keep) : 0);
    this.render(text.charAt(0) + q);
  }

  close(): void {
    const menu = this.menu;
    if (!menu) return;
    this.menu = null;
    this.query = null;
    menu.detach();
    this.input.removeAttribute("aria-activedescendant");
    this.input.removeAttribute("aria-controls");
    this.input.removeAttribute("aria-autocomplete");
  }

  destroy(): void {
    this.close();
    this.input.removeEventListener("input", this.onInput);
    this.input.removeEventListener("focus", this.onFocus);
    this.input.removeEventListener("blur", this.onBlur);
    this.input.removeEventListener("keydown", this.onKey, { capture: true });
    this.anchor.removeClass("aos-sm-anchor");
  }

  private render(typed: string): void {
    const { host, commands } = this.opts;
    if (!this.menu) {
      this.menu = this.anchor.createDiv({ cls: "aos-sm-menu", attr: { id: this.id, role: "listbox" } });
      // The textarea keeps focus: a mousedown in the menu would blur it, and the blur closes the menu before a click.
      this.menu.addEventListener("mousedown", (e) => e.preventDefault());
    }
    const menu = this.menu;
    menu.setAttr("aria-label", slashHeading(host));
    menu.empty();
    menu.setAttr("data-host", host);
    menu.createDiv({ cls: "aos-sm-head", text: slashHeading(host), attr: { "aria-hidden": "true" } });
    const list = menu.createDiv({ cls: "aos-sm-list" });
    this.items.forEach((c, i) => {
      const on = i === this.index;
      const opt = list.createEl("button", {
        cls: `aos-sm-option${on ? " is-selected" : ""}`,
        attr: { type: "button", id: `${this.id}-${i}`, role: "option", "aria-selected": String(on), tabindex: "-1", "data-command": c.name },
      });
      opt.createSpan({ cls: "aos-sm-name", text: c.insert.trim() || c.name });
      opt.createSpan({ cls: "aos-sm-desc", text: c.description });
      if (c.hint) opt.createSpan({ cls: "aos-sm-hint", text: c.hint });
      opt.addEventListener("mousemove", () => { if (this.index !== i) this.select(i); });
      opt.addEventListener("click", () => this.insert(i));
    });
    if (!this.items.length) list.createDiv({ cls: "aos-sm-empty", text: slashEmpty(host, commands.length, typed) });
    const foot = menu.createDiv({ cls: "aos-sm-foot" });
    foot.createSpan({ cls: "aos-sm-count", text: slashCount(host, commands.length) });
    if (this.items.length) foot.createSpan({ cls: "aos-sm-keys", text: SLASH_KEYS });
    this.input.setAttr("aria-controls", this.id);
    this.input.setAttr("aria-autocomplete", "list");
    this.select(this.index);
  }

  private select(i: number): void {
    this.index = i;
    const opts = this.menu ? Array.from(this.menu.querySelectorAll<HTMLElement>(".aos-sm-option")) : [];
    opts.forEach((o, j) => { o.toggleClass("is-selected", j === i); o.setAttr("aria-selected", String(j === i)); });
    const on = opts[i];
    if (!on) { this.input.removeAttribute("aria-activedescendant"); return; }
    this.input.setAttr("aria-activedescendant", on.id);
    if (typeof on.scrollIntoView === "function") on.scrollIntoView({ block: "nearest" });
  }

  private key(e: KeyboardEvent): void {
    if (!this.menu || e.isComposing) return;
    // ⌘↵ / Ctrl+↵ sends: the composer's handler must see it.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = this.items.length;
    if (e.key === "Escape") {
      this.dismissed = this.input.value;
      this.close();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
      this.select(stepIndex(this.index, e.key === "ArrowDown" ? 1 : -1, n));
    } else if (((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) && n) {
      this.insert(this.index);
    } else return;
    // The keys the menu used stop here: no newline, no focus move, and the tab's Escape does not stop the turn.
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private insert(i: number): void {
    const c = this.items[i];
    if (!c) return;
    const text = insertCommand(this.input.value, c.insert);
    this.close();
    this.input.value = text;
    this.input.setSelectionRange(text.length, text.length);
    this.input.focus();
    // The owner keeps the text from the textarea's input event; an insert ending without a space stays closed.
    this.dismissed = text;
    this.inserting = true;
    try { this.input.dispatchEvent(new Event("input", { bubbles: true })); } finally { this.inserting = false; }
    this.opts.onInsert?.(c, text);
  }
}
