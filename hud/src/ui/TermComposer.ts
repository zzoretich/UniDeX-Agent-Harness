import { Notice, setIcon } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import { codeChatOn, fs, hudHost, sessionsHost, type HostCatalog } from "../host";
import { aliasCatalog } from "../data/claudeAsk";
import { HOST_LABEL, catalogHost, catalogModelId, hostChoices, sameModel, transcriptModelName, type HostChoice } from "../data/agentSessions";
import { readAgenticosJson, readProviderState } from "../data/aosConfig";
import { hasChat, type TerminalSession } from "../data/terminalSession";
import { TERM_ACCESS, TERM_ACCESS_LABEL, TERM_ACCESS_NOTE, TERM_HOST_LABEL, type TermAccess } from "../data/terminalLaunch";
import { IMAGE_TYPES, composeSend, composerWrites, dataUrlBase64, imageRefusal, insertMention, matchFiles, mentionAt, sanitizeSnippets, type Snippet } from "../data/termComposer";
import { SlashMenu } from "./SlashMenu";
import { HostModelMenu } from "./HostModelMenu";

/** The ids that tie the chips to their reason (M5). */
let whyIds = 0;

/** How many files the @ list reads from a place, and how deep: enough for a project, cheap on every open. */
const FILE_LIMIT = 3000;
const FILE_DEPTH = 6;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__"]);

/** An image in the composer (code-chat C7): its chip, and main's path for it once saved. */
interface Shot {
  el: HTMLElement;
  /** Where main saved it, or null while it is saving. */
  path: string | null;
  /** Settles when main has answered: true when it saved the image and the chip is still there. */
  saved: Promise<boolean>;
  /** Removed (×, a refusal, Send, another terminal). */
  gone: boolean;
}

/** The files a paste or a drop carries (Chromium lists them in `files`; `items` as a fallback). */
function filesOf(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files = Array.from(dt.files ?? []);
  if (files.length) return files;
  return Array.from(dt.items ?? []).filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => !!f);
}

/** A file's contents as a `data:` URL. */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === "string" ? resolve(r.result) : reject(new Error("unreadable")));
    r.onerror = () => reject(r.error ?? new Error("unreadable"));
    r.readAsDataURL(file);
  });
}

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
 * Its row of chips (spec 2026-11-09-code-chat §4): + attach adds an image, @ file and / commands start a mention or a
 * command, Snippets, then an agent's access and model (controls: a pick restarts the same conversation with it, C12). In
 * the chat view (`setMode("chat")`) TerminalPanel moves the whole element into the chat's 760 px column.
 *
 * Images (C7): an agent terminal's composer, while the Code chat surface is on, takes PNG, JPEG, GIF and WebP images up to
 * 10 MB by paste, drop or + attach. Each becomes a chip with its thumbnail and ×, and main saves it at once into the app's
 * own data folder (code:save-image, which checks it again by content and names the path). Send pastes the text, then the
 * images' paths, in one bracketed paste through the same guarded Send (a card holds it, the screen is read first). A
 * refused image says why under the box. A shell, an ended agent and a run with the surface off have no + chip and take no
 * image. The chips belong to the terminal they were added on: another terminal starts with none.
 */
export class TermComposer {
  readonly el: HTMLElement;
  /** The + attach chip's place, first in the row (C7). */
  readonly attachSlot: HTMLElement;
  /** The images to send, in the order they came (C7), and their chips' row above the text. */
  private shots: Shot[] = [];
  private shotsEl: HTMLElement;
  /** The + attach chip's file picker. */
  private picker: HTMLInputElement;
  /** Send waits for an image main is still saving (once). */
  private awaitingShots = false;
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
  /** The hosts as the model menu lists them, read once per terminal and catalog (two file reads, synchronous IPC in the
   *  app), and what the menu was last handed: it is updated only when that changes (I3), so an open menu stays as it is
   *  through a busy agent's updates. */
  private hostList: HostChoice[] | null = null;
  private menuShown = "";
  /** Why the chips wait, for screen readers (aria-describedby, M5). */
  private whyEl: HTMLElement;
  /** Called once the catalog is in: the panel names the top bar's model by it (M4). */
  onCatalog: (() => void) | null = null;
  /** The panel keeps the composer away (the chat of an agent that ended, R39): hidden, and Send writes nothing. */
  private blocked = false;
  /** The one line under the box when Send is refused because the TUI's prompt is up (R49). */
  private note: HTMLElement;

  constructor(parent: HTMLElement, private plugin: AgenticOSPlugin, private focusTerminal: () => void, private bracketed: () => boolean = () => true) {
    this.el = parent.createDiv({ cls: "aos-tc is-hidden" });
    const box = this.el.createDiv({ cls: "aos-tc-box" });
    this.suggest = box.createDiv({ cls: "aos-tc-suggest", attr: { role: "listbox", "aria-label": "Files" } });
    this.shotsEl = box.createDiv({ cls: "aos-tc-shots", attr: { role: "list", "aria-label": "Images to send" } });
    this.input = box.createEl("textarea", { cls: "aos-tc-input", attr: { rows: "6", "aria-label": "Message to the agent", spellcheck: "true" } });
    const bar = box.createDiv({ cls: "aos-tc-bar" });
    this.attachSlot = bar.createSpan({ cls: "aos-tc-attach is-hidden" });
    const attach = this.attachSlot.createEl("button", { cls: "aos-tc-chip", text: "+ attach", attr: { type: "button", title: "Attach an image: PNG, JPEG, GIF or WebP up to 10 MB (or paste or drop one)" } });
    this.picker = this.attachSlot.createEl("input", { cls: "aos-tc-picker", attr: { type: "file", accept: IMAGE_TYPES.join(","), multiple: "", tabindex: "-1", "aria-hidden": "true" } });
    attach.addEventListener("click", () => { if (this.takesImages()) this.picker.click(); });
    this.picker.addEventListener("change", () => {
      const files = Array.from(this.picker.files ?? []);
      this.picker.value = "";
      this.takeFiles(files);
      this.input.focus();
    });
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
    this.whyEl = bar.createSpan({ cls: "aos-tc-sr", attr: { id: `aos-tc-why-${++whyIds}` } });
    const send = bar.createEl("button", { cls: "aos-tc-send", attr: { type: "button", "aria-label": "Send to the terminal" } });
    const sendIcon = send.createSpan({ cls: "aos-tc-icon" });
    setIcon(sendIcon, "arrow-up");
    send.addEventListener("click", () => this.send());
    this.slash = new SlashMenu(this.input, box, { commands: [], host: "claude" });
    this.input.addEventListener("input", () => { this.note.addClass("is-hidden"); this.onInput(); });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("paste", (e) => this.onPaste(e));
    box.addEventListener("dragover", (e) => {
      if (!this.takesImages() || !Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      box.addClass("is-drop");
    });
    box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget as Node | null)) box.removeClass("is-drop"); });
    box.addEventListener("drop", (e) => {
      box.removeClass("is-drop");
      if (!this.takesImages()) return;
      const files = filesOf(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      this.takeFiles(files);
    });
    this.note = this.el.createDiv({ cls: "aos-tc-note is-hidden", attr: { role: "status" } });
  }

  /** Shows the composer under a terminal that runs (an agent or a shell), else hides it. */
  setSession(s: TerminalSession | null): void {
    const live = !!s && !s.isExited;
    this.el.toggleClass("is-hidden", !live || this.blocked);
    if (!live || !s) { this.session = null; this.clearShots(); return; }
    // What runs decides: an agent terminal whose agent ended is a shell now (R39).
    const kind = s.agentEnded ? "shell" : s.meta.host;
    if (this.session?.id === s.id && this.shownHost === kind) return;
    // The images were for the agent they were added on (C7).
    this.clearShots();
    this.session = s;
    this.shownHost = kind;
    this.files = null;
    this.hostList = null;
    this.closeSuggest();
    const shell = kind === "shell";
    this.input.setAttr("placeholder", shell ? "Write a command…" : `Write to ${TERM_HOST_LABEL[s.meta.host]}…`);
    this.hint.setText(shell ? "⏎ run · ⇧⏎ new line · @ file · esc terminal" : "⏎ send · ⇧⏎ new line · @ file · / commands · esc terminal");
    this.commandsChip.toggleClass("is-hidden", shell);
    this.closeAccess();
    // The chips restart the chat's conversation: with the Code chat surface off there is none to restart (M1).
    const chips = !shell && codeChatOn();
    this.permChip.toggleClass("is-hidden", !chips);
    this.modelWrap.toggleClass("is-hidden", !chips);
    // Images go to an agent, through main's code:save-image, which the Code chat surface owns (C7, C13).
    this.attachSlot.toggleClass("is-hidden", !(chips && !!hudHost().code?.saveImage));
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

  /** Whether the composer is kept away now (block): nothing from the chat may reach the terminal then, a card's key
   *  included (R39). */
  get isBlocked(): boolean { return this.blocked; }

  /** The agent the composer writes to, or null for a shell, or a terminal whose agent ended (R39). */
  private agent(): "claude" | "codex" | null {
    const s = this.session;
    return s && hasChat(s.meta) && !s.agentEnded && s.meta.host !== "shell" ? s.meta.host : null;
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

  /** The model's name as the top bar and the model chip show it: the catalog's, else the full id's family and version (M4). */
  modelLabel(host: "claude" | "codex", model: string | null): string {
    return transcriptModelName(host, catalogHost(this.catalog, host), model);
  }

  /** The access chip says the terminal's launch access; the model chip the conversation's newest model, else the launch's.
   *  Their names say which chip is which, and a waiting chip's reason is read out with it (M5): the access chip stays
   *  focusable (aria-disabled), the model chip's trigger is disabled by its menu. */
  private syncChips(): void {
    const s = this.session;
    if (!s || !this.agent() || !codeChatOn()) return;
    const reason = this.chipReason();
    const access = s.meta.access ?? "host";
    this.whyEl.setText(reason ?? "");
    const why = reason ? this.whyEl.id : null;
    this.permChip.setText(TERM_ACCESS_LABEL[access]);
    this.permChip.setAttr("aria-disabled", reason ? "true" : null);
    this.permChip.setAttr("aria-describedby", why);
    this.permChip.setAttr("aria-label", `Access: ${TERM_ACCESS_LABEL[access]}`);
    this.permChip.setAttr("title", reason ?? `What the agent may do: ${TERM_ACCESS_NOTE[access]}`);
    this.modelWrap.setAttr("title", reason ?? "");
    const host = s.meta.host as "claude" | "codex";
    const model = this.chips?.model ?? s.meta.model ?? null;
    const entry = catalogHost(this.catalog, host);
    const label = transcriptModelName(host, entry, model);
    const sig = `${s.id}|${host}|${model ?? ""}|${reason ? 1 : 0}|${this.catalog?.fetchedAt ?? ""}`;
    if (sig !== this.menuShown) {
      this.menuShown = sig;
      this.hostList ??= hostChoices(readAgenticosJson(this.plugin.claudeConfigDir()), readProviderState(this.plugin.vaultRoot()));
      // The menu ticks the catalog's row for the transcript's id; the chip names it as the top bar does.
      this.modelMenu.update({ catalog: this.catalog, choices: this.hostList, value: { host, model: catalogModelId(host, entry, model), effort: null }, label, disabled: !!reason });
    }
    const trigger = this.modelWrap.querySelector(".aos-hm-trigger");
    trigger?.setAttribute("aria-label", `Model: ${HOST_LABEL[host]} · ${label}`);
    if (why) trigger?.setAttribute("aria-describedby", why);
    else trigger?.removeAttribute("aria-describedby");
    if (reason) this.closeAccess();
  }

  private restart(patch: { model?: string | null; access?: TermAccess | null }): void {
    const c = this.chips;
    if (!c || this.chipReason()) return;
    // The menu shows the pick until then; what runs is drawn again after (the old terminal, if the restart failed).
    void c.restart(patch).finally(() => { this.menuShown = ""; this.syncChips(); });
  }

  private pickModel(model: string | null): void {
    const host = this.agent();
    if (!host) return;
    const next = model ?? (host === "claude" ? "default" : null);
    const cur = this.chips?.model ?? this.session?.meta.model ?? null;
    // The catalog's alias and the transcript's full id of one model are the same pick (M4): nothing restarts.
    if (sameModel(host, catalogHost(this.catalog, host), next, cur)) { this.menuShown = ""; this.syncChips(); return; }
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
      // The hosts are read again with the catalog (a login since may have changed them).
      this.hostList = null;
      this.onCatalog?.();
    }
    this.slash.update(catalogHost(this.catalog, host)?.commands ?? [], host);
    this.syncChips();
  }

  private send(): void {
    const s = this.session;
    const text = this.input.value;
    const shots = this.shots.slice();
    if (!s || this.blocked || (!text.trim() && !shots.length)) return;
    // An image main is still saving: Send waits for it, once, then starts again from the top, so every check below runs on
    // what is there then. A refused or removed image sends nothing: its reason is under the box, the draft stays.
    if (shots.some((x) => x.path === null)) {
      if (this.awaitingShots) return;
      this.awaitingShots = true;
      void Promise.all(shots.map((x) => x.saved)).then((ok) => {
        this.awaitingShots = false;
        if (this.session === s && ok.every(Boolean)) this.send();
      });
      return;
    }
    // The ⏎ that ends a send would answer the TUI's prompt (the highlighted choice): while a card is up, nothing is
    // written and the draft (its images included) stays (R49). The screen is read fresh first, since the poll can be a
    // tick behind a prompt that just printed (bounded: R56).
    const feeds = this.plugin.codeFeeds;
    const known = feeds?.get(s.id)?.card;
    if (known || !feeds?.get(s.id)) { this.finishSend(s, text, shots, !!known); return; }
    void feeds.cardNow(s.id).then((held) => {
      // The draft, its images or the terminal changed while the screen was read: this send is no longer the one asked for.
      const same = this.shots.length === shots.length && this.shots.every((x, i) => x === shots[i]);
      if (this.session !== s || this.blocked || this.input.value !== text || !same) return;
      this.finishSend(s, text, shots, held);
    });
  }

  private finishSend(s: TerminalSession, text: string, shots: Shot[], held: boolean): void {
    if (held) {
      this.say(this.el.hasClass("is-chat") ? "Answer the card above first · Terminal ⌘J" : "Answer the prompt in the terminal first");
      return;
    }
    this.note.addClass("is-hidden");
    // One bracketed paste: the text, then the images' paths (C7).
    const paths = shots.map((x) => x.path).filter((p): p is string => p !== null);
    for (const w of composerWrites(composeSend(text, paths), undefined, this.bracketed())) s.write(w);
    this.input.value = "";
    this.clearShots();
    this.closeSuggest();
    this.focusTerminal();
  }

  /** The one line under the box: why Send waits, or why an image was not added. */
  private say(text: string): void {
    this.note.setText(text);
    this.note.removeClass("is-hidden");
  }

  // ── images (C7) ──

  /** Whether this composer takes an image now: an agent's, unblocked, with main's code:save-image (the surface on). */
  private takesImages(): boolean {
    return !!this.agent() && !this.blocked && codeChatOn() && !!hudHost().code?.saveImage;
  }

  /** A paste that carries an image adds its chip instead of text; any other paste is the textarea's own. */
  private onPaste(e: ClipboardEvent): void {
    if (!this.takesImages()) return;
    const files = filesOf(e.clipboardData).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    this.takeFiles(files);
  }

  /** The files a paste, a drop or the picker brought: each a chip, or the reason it is not. */
  private takeFiles(files: File[]): void {
    if (!files.length || !this.takesImages()) return;
    this.note.addClass("is-hidden");
    for (const f of files) this.addImage(f);
  }

  /** Adds `file`'s chip (its thumbnail and ×) and has main save it; a refusal takes the chip away and says why. */
  private addImage(file: File): void {
    const why = imageRefusal(file.type, file.size);
    if (why) { this.say(`Image not added: ${why}`); return; }
    const code = hudHost().code;
    const save = code?.saveImage?.bind(code);
    if (!save) return;
    const name = file.name || "Pasted image";
    const el = this.shotsEl.createDiv({ cls: "aos-tc-shot is-saving", attr: { role: "listitem", title: name } });
    const img = el.createEl("img", { cls: "aos-tc-thumb", attr: { alt: name } });
    const x = el.createEl("button", { cls: "aos-tc-shotx", attr: { type: "button", "aria-label": `Remove ${name}`, title: "Remove" } });
    setIcon(x, "x");
    const shot: Shot = { el, path: null, saved: Promise.resolve(false), gone: false };
    x.addEventListener("click", () => { this.dropShot(shot); this.input.focus(); });
    this.shots.push(shot);
    const refuse = (reason: string): false => {
      if (!shot.gone) { this.dropShot(shot); this.say(`Image not added: ${reason}`); }
      return false;
    };
    shot.saved = readDataUrl(file).then(async (url) => {
      if (shot.gone) return false;
      // The thumbnail is the image itself as a data: URL (the page's CSP allows data: images, not blob:); it goes with
      // its chip.
      img.src = url;
      const data = dataUrlBase64(url);
      if (data === null) return refuse("it could not be read");
      const r = await save({ mime: file.type, data });
      if (shot.gone) return false;
      if (!r.ok) return refuse(r.error);
      shot.path = r.data.path;
      el.removeClass("is-saving");
      return true;
    }).catch(() => refuse("it could not be read"));
  }

  private dropShot(shot: Shot): void {
    shot.gone = true;
    shot.el.detach();
    this.shots = this.shots.filter((x) => x !== shot);
  }

  private clearShots(): void {
    for (const x of this.shots) { x.gone = true; x.el.detach(); }
    this.shots = [];
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
