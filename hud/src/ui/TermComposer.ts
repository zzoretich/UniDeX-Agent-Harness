import { Notice, setIcon } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import { fs, sessionsHost, type HostCatalog } from "../host";
import { aliasCatalog } from "../data/claudeAsk";
import { catalogHost, hostChoices } from "../data/agentSessions";
import { readAgenticosJson, readProviderState } from "../data/aosConfig";
import type { TerminalSession } from "../data/terminalSession";
import { TERM_ACCESS, TERM_ACCESS_LABEL, TERM_ACCESS_NOTE, TERM_HOST_LABEL, type TermAccess } from "../data/terminalLaunch";
import { composerWrites, insertMention, matchFiles, mentionAt, sanitizeSnippets, type Snippet } from "../data/termComposer";
import { SlashMenu } from "./SlashMenu";
import { HostModelMenu } from "./HostModelMenu";

/** How many files the @ list reads from a place, and how deep: enough for a project, cheap on every open. */
const FILE_LIMIT = 3000;
const FILE_DEPTH = 6;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__"]);

/**
 * What the access and model chips need from the panel (code-chat C12): the conversation they would restart, whether a
 * turn is open, the model to show, and the restart itself.
 */
export interface ChipState {
  /** The conversation's id (the chat's), or null while there is none. */
  conversation: string | null;
  /** A turn is open (rowStatus "working"): the chips wait. */
  working: boolean;
  /** The conversation's newest model, else the launch's. */
  model: string | null;
  /** Starts the same conversation again with the pick, then closes this terminal. */
  restart(patch: { model?: string | null; access?: TermAccess | null }): Promise<void>;
}

/**
 * The Term composer (spec 2026-10-08-term-agent-deck T12): a box under an agent's terminal for longer messages. Enter
 * sends it as one bracketed paste and Enter; ⇧Enter adds a line; @ lists the place's files (inside the vault, where the
 * page may read; elsewhere the typed path goes as it is); / lists the host's commands (Claude `/name`, Codex `$skill`);
 * Snippets keeps prompts you reuse. Escape goes back to the terminal. A shell or an ended terminal has none. An agent
 * terminal whose agent exited runs the login shell now (D18, code-chat R39): its composer is a shell's (no / commands,
 * access or model), and while its chat shows the panel blocks the composer, so nothing reaches that shell from there.
 *
 * Its row of chips (spec 2026-11-09-code-chat §4): @ file and / commands start a mention or a command, Snippets, then an
 * agent's access and model (controls: a pick restarts the same conversation with it, C12); `attachSlot` is where Task 14's + chip goes. In
 * the chat view (`setMode("chat")`) TerminalPanel moves the whole element into the chat's 760 px column.
 */
export class TermComposer {
  readonly el: HTMLElement;
  /** The image chip's place, first in the row (Task 14). */
  readonly attachSlot: HTMLElement;
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
  private commandsChip: HTMLElement;
  private permChip: HTMLButtonElement;
  private accessMenu: HTMLElement | null = null;
  private modelWrap: HTMLElement;
  private modelMenu: HostModelMenu;
  private chips: ChipState | null = null;
  /** The panel keeps the composer away (the chat of an agent that ended, R39): hidden, and Send writes nothing. */
  private blocked = false;

  constructor(parent: HTMLElement, private plugin: AgenticOSPlugin, private focusTerminal: () => void, private bracketed: () => boolean = () => true) {
    this.el = parent.createDiv({ cls: "aos-tc is-hidden" });
    const box = this.el.createDiv({ cls: "aos-tc-box" });
    this.suggest = box.createDiv({ cls: "aos-tc-suggest", attr: { role: "listbox", "aria-label": "Files" } });
    this.input = box.createEl("textarea", { cls: "aos-tc-input", attr: { rows: "6", "aria-label": "Message to the agent", spellcheck: "true" } });
    const bar = box.createDiv({ cls: "aos-tc-bar" });
    this.attachSlot = bar.createSpan({ cls: "aos-tc-attach" });
    const file = bar.createEl("button", { cls: "aos-tc-chip", text: "@ file", attr: { type: "button", title: "Mention a file" } });
    file.addEventListener("click", () => this.startMention());
    this.commandsChip = bar.createEl("button", { cls: "aos-tc-chip", text: "/ commands", attr: { type: "button", title: "The agent's commands" } });
    this.commandsChip.addEventListener("click", () => this.startCommand());
    const snip = bar.createEl("button", { cls: "aos-tc-btn aos-tc-chip", attr: { type: "button", "aria-haspopup": "menu" } });
    const snipIcon = snip.createSpan({ cls: "aos-tc-icon" });
    setIcon(snipIcon, "bookmark");
    snip.createSpan({ text: "Snippets" });
    snip.addEventListener("click", () => this.toggleSnippets(bar));
    this.hint = bar.createSpan({ cls: "aos-tc-hint", text: "⏎ send · ⇧⏎ new line · @ file · / commands · esc terminal" });
    this.permChip = bar.createEl("button", { cls: "aos-tc-chip aos-tc-access is-hidden", attr: { type: "button", "aria-haspopup": "menu" } });
    this.permChip.addEventListener("click", () => this.toggleAccess(bar));
    this.modelWrap = bar.createSpan({ cls: "aos-tc-modelwrap is-hidden" });
    this.modelMenu = new HostModelMenu(this.modelWrap, {
      mode: "thread", catalog: null, choices: [], value: { host: "claude", model: null, effort: null },
      onChange: (v) => this.pickModel(v.model),
    });
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
    this.el.toggleClass("is-hidden", !live || this.blocked);
    if (!live || !s) { this.session = null; return; }
    // What runs decides: an agent terminal whose agent ended is a shell now (R39).
    const kind = s.agentEnded ? "shell" : s.meta.host;
    if (this.session?.id === s.id && this.shownHost === kind) return;
    this.session = s;
    this.shownHost = kind;
    this.files = null;
    this.closeSuggest();
    const shell = kind === "shell";
    this.input.setAttr("placeholder", shell ? "Write a command…" : `Write to ${TERM_HOST_LABEL[s.meta.host]}…`);
    this.hint.setText(shell ? "⏎ run · ⇧⏎ new line · @ file · esc terminal" : "⏎ send · ⇧⏎ new line · @ file · / commands · esc terminal");
    this.commandsChip.toggleClass("is-hidden", shell);
    this.closeAccess();
    this.permChip.toggleClass("is-hidden", shell);
    this.modelWrap.toggleClass("is-hidden", shell);
    this.syncChips();
    // A shell has no / commands: the list stays empty, so / is just a character.
    if (shell) this.slash.update([], "claude");
    else void this.loadCommands(s.meta.host as "claude" | "codex");
  }

  /** Keeps the composer away while `on` (the chat of an agent that ended, R39): hidden, ⌘L finds nothing, Send writes
   *  nothing. */
  block(on: boolean): void {
    this.blocked = on;
    this.el.toggleClass("is-hidden", on || !this.session);
  }

  /** The agent the composer writes to, or null for a shell, or a terminal whose agent ended (R39). */
  private agent(): "claude" | "codex" | null {
    const s = this.session;
    return s && s.meta.host !== "shell" && !s.agentEnded ? s.meta.host : null;
  }

  /** The chat view's column (smaller box, chips only) or under the terminal, as before. */
  setMode(mode: "chat" | "terminal"): void { this.el.toggleClass("is-chat", mode === "chat"); }

  /** What the access and model chips restart (the panel calls it as the chat's state changes); null: nothing to restart. */
  setChips(c: ChipState | null): void {
    this.chips = c;
    this.syncChips();
  }

  /** Why the chips do nothing now, or null: no conversation yet, or a turn is open (C12). */
  private chipReason(): string | null {
    const c = this.chips;
    if (!c || !c.conversation) return "Nothing to restart yet: this session has no chat conversation";
    if (c.working) return "Wait for the turn to finish, then change it";
    return null;
  }

  /** The access chip says the terminal's launch access; the model chip the conversation's newest model, else the launch's. */
  private syncChips(): void {
    const s = this.session;
    if (!s || !this.agent()) return;
    const reason = this.chipReason();
    const access = s.meta.access ?? "host";
    this.permChip.setText(TERM_ACCESS_LABEL[access]);
    this.permChip.disabled = !!reason;
    this.permChip.setAttr("title", reason ?? `What the agent may do: ${TERM_ACCESS_NOTE[access]}`);
    this.modelWrap.setAttr("title", reason ?? "");
    this.modelMenu.update({
      catalog: this.catalog, choices: hostChoices(readAgenticosJson(this.plugin.claudeConfigDir()), readProviderState(this.plugin.vaultRoot())),
      value: { host: s.meta.host as "claude" | "codex", model: this.chips?.model ?? s.meta.model ?? null, effort: null }, disabled: !!reason,
    });
    if (reason) this.closeAccess();
  }

  private restart(patch: { model?: string | null; access?: TermAccess | null }): void {
    const c = this.chips;
    if (!c || this.chipReason()) return;
    void c.restart(patch).finally(() => this.syncChips());
  }

  private pickModel(model: string | null): void {
    const host = this.agent();
    if (!host) return;
    const next = model ?? (host === "claude" ? "default" : null);
    const cur = this.chips?.model ?? this.session?.meta.model ?? null;
    if ((next ?? "default") === (cur ?? "default")) return;
    this.restart({ model: next });
  }

  private toggleAccess(bar: HTMLElement): void {
    if (this.accessMenu) { this.closeAccess(); return; }
    if (this.chipReason() || !this.agent()) return;
    const menu = bar.createDiv({ cls: "aos-tc-snippets aos-tc-accessmenu", attr: { role: "menu", "aria-label": "What the agent may do" } });
    this.accessMenu = menu;
    const cur = this.session?.meta.access ?? "host";
    for (const a of TERM_ACCESS) {
      const b = menu.createEl("button", { cls: "aos-tc-snip", text: TERM_ACCESS_LABEL[a], attr: { type: "button", role: "menuitemradio", "aria-checked": String(a === cur), "data-access": a, title: TERM_ACCESS_NOTE[a] } });
      b.addEventListener("click", () => {
        this.closeAccess();
        if (a !== cur) this.restart({ access: a });
      });
    }
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); this.closeAccess(); this.permChip.focus(); } });
  }

  private closeAccess(): void { this.accessMenu?.detach(); this.accessMenu = null; }

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
    this.syncChips();
  }

  private send(): void {
    const s = this.session;
    const text = this.input.value;
    if (!s || this.blocked || !text.trim()) return;
    for (const w of composerWrites(text, undefined, this.bracketed())) s.write(w);
    this.input.value = "";
    this.closeSuggest();
    this.focusTerminal();
  }

  // ── the chips ──

  /** @ file: an @ at the caret (after a space), and the place's files listed for it. */
  private startMention(): void {
    const v = this.input.value;
    const at = this.input.selectionStart ?? v.length;
    const before = v.slice(0, at);
    const sep = before && !/\s$/.test(before) ? " " : "";
    this.input.value = `${before}${sep}@${v.slice(at)}`;
    const caret = at + sep.length + 1;
    this.input.focus();
    this.input.setSelectionRange(caret, caret);
    this.onInput();
  }

  /** / commands: in an empty composer, the host's command mark (Codex's skills start with $) and its menu. */
  private startCommand(): void {
    const host = this.agent();
    if (!host) return;
    if (!this.input.value.trim()) this.input.value = host === "codex" ? "$" : "/";
    this.input.focus();
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
    this.slash.refresh();
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
    const host = this.agent() ?? "shell";
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
