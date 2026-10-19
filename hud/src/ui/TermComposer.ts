import { Notice, setIcon } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import { fs, sessionsHost, type HostCatalog } from "../host";
import { aliasCatalog } from "../data/claudeAsk";
import { catalogHost } from "../data/agentSessions";
import type { TerminalSession } from "../data/terminalSession";
import { TERM_HOST_LABEL } from "../data/terminalLaunch";
import { composerWrites, insertMention, matchFiles, mentionAt, sanitizeSnippets, type Snippet } from "../data/termComposer";
import { SlashMenu } from "./SlashMenu";

/** How many files the @ list reads from a place, and how deep: enough for a project, cheap on every open. */
const FILE_LIMIT = 3000;
const FILE_DEPTH = 6;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__"]);

/**
 * The Term composer (spec 2026-10-08-term-agent-deck T12): a box under an agent's terminal for longer messages. Enter
 * sends it as one bracketed paste and Enter; ⇧Enter adds a line; @ lists the place's files (inside the vault, where the
 * page may read; elsewhere the typed path goes as it is); / lists the host's commands (Claude `/name`, Codex `$skill`);
 * Snippets keeps prompts you reuse. Escape goes back to the terminal. A shell or an ended terminal has none.
 */
export class TermComposer {
  readonly el: HTMLElement;
  private input: HTMLTextAreaElement;
  private suggest: HTMLElement;
  private snippetsMenu: HTMLElement | null = null;
  private slash: SlashMenu;
  private session: TerminalSession | null = null;
  private files: { dir: string; list: string[] } | null = null;
  private hits: string[] = [];
  private hi = 0;
  private catalog: HostCatalog | null = null;
  private hint: HTMLElement;
  private shownHost: string | null = null;

  constructor(parent: HTMLElement, private plugin: AgenticOSPlugin, private focusTerminal: () => void, private bracketed: () => boolean = () => true) {
    this.el = parent.createDiv({ cls: "aos-tc is-hidden" });
    const box = this.el.createDiv({ cls: "aos-tc-box" });
    this.suggest = box.createDiv({ cls: "aos-tc-suggest", attr: { role: "listbox", "aria-label": "Files" } });
    this.input = box.createEl("textarea", { cls: "aos-tc-input", attr: { rows: "6", "aria-label": "Message to the agent", spellcheck: "true" } });
    const bar = box.createDiv({ cls: "aos-tc-bar" });
    const snip = bar.createEl("button", { cls: "aos-tc-btn", attr: { type: "button", "aria-haspopup": "menu" } });
    const snipIcon = snip.createSpan({ cls: "aos-tc-icon" });
    setIcon(snipIcon, "bookmark");
    snip.createSpan({ text: "Snippets" });
    snip.addEventListener("click", () => this.toggleSnippets(bar));
    this.hint = bar.createSpan({ cls: "aos-tc-hint", text: "⏎ send · ⇧⏎ new line · @ file · / commands · esc terminal" });
    const send = bar.createEl("button", { cls: "aos-tc-send", attr: { type: "button", "aria-label": "Send to the terminal" } });
    const sendIcon = send.createSpan({ cls: "aos-tc-icon" });
    setIcon(sendIcon, "arrow-up");
    send.addEventListener("click", () => this.send());
    this.slash = new SlashMenu(this.input, box, { commands: [], host: "claude" });
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
  }

  /** Shows the composer under a terminal that runs (an agent or a shell), else hides it. */
  setSession(s: TerminalSession | null): void {
    const live = !!s && !s.isExited;
    this.el.toggleClass("is-hidden", !live);
    if (!live || !s) { this.session = null; return; }
    if (this.session?.id === s.id && this.shownHost === s.meta.host) return;
    this.session = s;
    this.shownHost = s.meta.host;
    this.files = null;
    this.closeSuggest();
    const shell = s.meta.host === "shell";
    this.input.setAttr("placeholder", shell ? "Write a command…" : `Write to ${TERM_HOST_LABEL[s.meta.host]}…`);
    this.hint.setText(shell ? "⏎ run · ⇧⏎ new line · @ file · esc terminal" : "⏎ send · ⇧⏎ new line · @ file · / commands · esc terminal");
    // A shell has no / commands: the list stays empty, so / is just a character.
    if (shell) this.slash.update([], "claude");
    else void this.loadCommands(s.meta.host as "claude" | "codex");
  }

  focus(): boolean {
    if (this.el.hasClass("is-hidden")) return false;
    this.input.focus();
    return true;
  }

  isFocused(): boolean { return this.el.contains(document.activeElement); }

  private async loadCommands(host: "claude" | "codex"): Promise<void> {
    if (!this.catalog) {
      const sh = sessionsHost();
      try {
        const r = sh ? await sh.sessions.catalog() : null;
        this.catalog = r && r.ok ? r.data : aliasCatalog(new Date());
      } catch { this.catalog = aliasCatalog(new Date()); }
    }
    this.slash.update(catalogHost(this.catalog, host)?.commands ?? [], host);
  }

  private send(): void {
    const s = this.session;
    const text = this.input.value;
    if (!s || !text.trim()) return;
    for (const w of composerWrites(text, undefined, this.bracketed())) s.write(w);
    this.input.value = "";
    this.closeSuggest();
    this.focusTerminal();
  }

  // ── @ files ──

  private placeFiles(): string[] {
    const s = this.session;
    if (!s) return [];
    const dir = s.meta.place?.dir ?? s.cwd;
    if (this.files?.dir === dir) return this.files.list;
    const vault = path.resolve(this.plugin.vaultRoot());
    const rel = path.relative(vault, dir);
    const list: string[] = [];
    // The page reads only inside the vault: a linked code folder elsewhere gets no list (the typed path still goes).
    if (rel.startsWith("..") || path.isAbsolute(rel)) { this.files = { dir, list }; return list; }
    const walk = (abs: string, prefix: string, depth: number) => {
      if (list.length >= FILE_LIMIT || depth > FILE_DEPTH) return;
      let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }> = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (list.length >= FILE_LIMIT) return;
        if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
        const relp = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(abs, e.name), relp, depth + 1);
        else if (e.isFile()) list.push(relp);
      }
    };
    walk(dir, "", 0);
    this.files = { dir, list };
    return list;
  }

  private onInput(): void {
    const m = mentionAt(this.input.value, this.input.selectionStart ?? this.input.value.length);
    if (!m) { this.closeSuggest(); return; }
    this.hits = matchFiles(this.placeFiles(), m.query);
    this.hi = 0;
    this.renderSuggest();
  }

  private renderSuggest(): void {
    this.suggest.empty();
    this.suggest.toggleClass("is-open", this.hits.length > 0);
    this.hits.forEach((p, i) => {
      const row = this.suggest.createEl("button", { cls: `aos-tc-file${i === this.hi ? " is-hi" : ""}`, text: p, attr: { type: "button", role: "option", tabindex: "-1" } });
      row.addEventListener("mousedown", (e) => { e.preventDefault(); this.pick(p); });
    });
  }

  private closeSuggest(): void { this.hits = []; this.suggest.empty(); this.suggest.removeClass("is-open"); }

  private pick(p: string): void {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const m = mentionAt(this.input.value, caret);
    if (!m) return;
    const r = insertMention(this.input.value, m.start, caret, p);
    this.input.value = r.text;
    this.input.setSelectionRange(r.caret, r.caret);
    this.closeSuggest();
    this.input.focus();
  }

  private onKey(e: KeyboardEvent): void {
    if (this.slash.isOpen() || e.isComposing) return;
    if (this.hits.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.hi = (this.hi + (e.key === "ArrowDown" ? 1 : this.hits.length - 1)) % this.hits.length;
        this.renderSuggest();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); this.pick(this.hits[this.hi]); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.closeSuggest(); return; }
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.focusTerminal(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); this.send(); }
  }

  // ── snippets ──

  private snippets(): Snippet[] { return sanitizeSnippets(this.plugin.settings.terminalSnippets); }

  private toggleSnippets(bar: HTMLElement): void {
    if (this.snippetsMenu) { this.snippetsMenu.detach(); this.snippetsMenu = null; return; }
    const menu = bar.createDiv({ cls: "aos-tc-snippets", attr: { role: "menu" } });
    this.snippetsMenu = menu;
    const host = this.session?.meta.host;
    const list = this.snippets().filter((s) => !s.host || s.host === host);
    const close = () => { menu.detach(); this.snippetsMenu = null; };
    if (!list.length) menu.createDiv({ cls: "aos-tc-snipnote", text: "No snippets yet: write a prompt, then Save as snippet." });
    for (const s of list) {
      const b = menu.createEl("button", { cls: "aos-tc-snip", text: s.title, attr: { type: "button", role: "menuitem", title: s.text } });
      b.addEventListener("click", () => {
        const v = this.input.value;
        this.input.value = v ? `${v}${v.endsWith("\n") ? "" : "\n"}${s.text}` : s.text;
        close();
        this.input.focus();
      });
    }
    const save = menu.createEl("button", { cls: "aos-tc-snip is-save", text: "Save as snippet", attr: { type: "button", role: "menuitem" } });
    save.disabled = !this.input.value.trim();
    save.addEventListener("click", () => {
      const text = this.input.value;
      this.plugin.settings.terminalSnippets = sanitizeSnippets([...this.snippets(), { text, host: null }]);
      void this.plugin.saveSettings();
      new Notice(`Saved "${text.trim().split("\n")[0].slice(0, 60)}" as a snippet`);
      close();
      this.input.focus();
    });
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); this.input.focus(); } });
  }
}
