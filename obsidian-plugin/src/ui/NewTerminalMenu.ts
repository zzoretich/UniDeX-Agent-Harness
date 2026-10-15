import { Notice, setIcon } from "obsidian";
import type { TerminalLauncher } from "../data/terminalLauncher";
import {
  TERM_ACCESS, TERM_ACCESS_LABEL, TERM_ACCESS_NOTE, TERM_HOST_LABEL, firstActionable, menuRows, slugify,
  type MenuRow, type Place, type TermAccess, type TermHost,
} from "../data/terminalLaunch";

/** Each row's icon, in the table form the compat scanner reads. */
const ROW_ICONS: { id: string; icon: string }[] = [
  { id: "add", icon: "plus" },
  { id: "vault", icon: "book-open" },
  { id: "home", icon: "house" },
  { id: "place", icon: "folder" },
];
function rowIcon(r: MenuRow): string {
  const id = r.kind === "create" || r.kind === "new" ? "add" : r.place?.kind === "vault" ? "vault" : r.place?.kind === "home" ? "home" : "place";
  return ROW_ICONS.find((x) => x.id === id)?.icon ?? "folder";
}

/** What the menu asks its owner to start; the owner checks readiness, resolves the place and shows the terminal. */
export interface NewTerminalActions {
  /** Start `host` ("quick" = the one ⌘T starts) in `picked`, else wherever the context or the default says. */
  start(req: { host: TermHost | "quick"; picked?: Place | null; resume?: "last" | { id: string } | null }): Promise<void>;
  /** Make workspaces/<slug> and start `host` there. */
  create(name: string, host: TermHost, gitInit: boolean): Promise<void>;
  /** What you are looking at (a selected workspace terminal), for the "Same as selected" row. */
  context(): Place | null;
}

/**
 * The Term tab's New button (spec 2026-10-08-term-agent-deck T3): one click starts the host you used last, and its
 * second line says where. ▾ opens a menu that drops down: Start now (one row per host), Start <host> in… (pick a
 * place or type a name: an exact name starts there, anything else creates it), New workspace, and a preview of exactly
 * what will be typed. Focus stays in the filter; ↑↓ move, Enter starts, ⇧Enter continues the last conversation there,
 * ⌥Enter opens a shell there, Tab switches the host, Escape closes.
 */
export class NewTerminalMenu {
  readonly el: HTMLElement;
  private pop: HTMLElement | null = null;
  private mode: "menu" | "create" = "menu";
  private host: TermHost = "claude";
  private query = "";
  private rows: MenuRow[] = [];
  private hi: string | null = null;
  private reason: string | null = null;
  private createName = "";
  private createGit: boolean | null = null;
  private busy = false;
  /** True while renderPop replaces the menu: Chromium reports the focused field's removal as focus leaving it. */
  private redrawing = false;
  private error: string | null = null;

  constructor(parent: HTMLElement, private launcher: TerminalLauncher, private actions: NewTerminalActions) {
    this.el = parent.createDiv({ cls: "aos-ntm" });
    this.el.addEventListener("focusout", (e) => {
      if (this.redrawing) return;
      const next = e.relatedTarget as Node | null;
      if (this.pop && (!next || !this.el.contains(next))) this.close(false);
    });
    this.el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.pop) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    this.renderButton();
  }

  isOpen(): boolean { return !!this.pop; }

  /** Redraws the button (after a launch, a login, a setting change). An open menu is left alone: redrawing it would
   *  take the focus from what the user is typing, and focus leaving the menu closes it. */
  refresh(): void {
    this.renderButton();
  }

  /** Opens the menu, or the New workspace sheet; `reason` explains why ⌘T could not start straight away. */
  open(mode: "menu" | "create" = "menu", reason: string | null = null, name = ""): void {
    this.mode = mode;
    this.reason = reason;
    this.query = "";
    this.createName = name;
    this.createGit = null;
    this.error = null;
    const quick = this.launcher.quickHost();
    const ready = this.launcher.choices().filter((c) => !c.hidden && c.ready).map((c) => c.host);
    this.host = quick.host ?? this.launcher.choice().host ?? ready[0] ?? "shell";
    if (!ready.includes(this.host)) this.host = ready[0] ?? "shell";
    this.renderPop();
  }

  close(focusButton = true): void {
    if (!this.pop) return;
    this.pop.detach();
    this.pop = null;
    this.el.removeClass("is-open");
    this.el.querySelector(".aos-ntm-caret")?.setAttr("aria-expanded", "false");
    if (focusButton) (this.el.querySelector(".aos-ntm-main") as HTMLElement | null)?.focus();
  }

  destroy(): void { this.pop = null; this.el.detach(); }

  // ── the split button ──

  private renderButton(): void {
    const btn = this.el.querySelector(".aos-ntm-split");
    btn?.detach();
    const split = this.el.createDiv({ cls: "aos-ntm-split" });
    this.el.prepend(split);
    const quick = this.launcher.quickHost();
    const host = quick.host;
    const main = split.createEl("button", { cls: "aos-ntm-main", attr: { type: "button", "data-tour": "code-new" } });
    const top = main.createSpan({ cls: "aos-ntm-top" });
    top.createSpan({ cls: `aos-ntm-dot is-${host ?? "shell"}` });
    top.createSpan({ cls: "aos-ntm-name", text: host ? `New ${host === "shell" ? "shell" : TERM_HOST_LABEL[host]}` : "New terminal" });
    top.createSpan({ cls: "aos-ntm-kbd", text: "⌘T" });
    const where = host ? this.launcher.resolve(host, null, this.actions.context()).place.label : null;
    const sub = !host ? (quick.reason ?? "Pick a host")
      : host === "shell" ? `in ${where}`
      : `in ${where} · ${this.launcher.modelLabel(host)} · ${TERM_ACCESS_LABEL[this.launcher.choice().access as TermAccess]}`;
    main.createSpan({ cls: "aos-ntm-sub", text: sub });
    main.setAttr("title", host ? `Start ${TERM_HOST_LABEL[host]} ${sub} (⌘T). ▾ for another host, another place or a new workspace.` : sub);
    main.addEventListener("click", () => { this.actions.start({ host: "quick" }).catch((e) => new Notice(`Terminal: ${e instanceof Error ? e.message : String(e)}`)); });
    const caret = split.createEl("button", {
      cls: "aos-ntm-caret", attr: { type: "button", "aria-haspopup": "menu", "aria-expanded": this.pop ? "true" : "false", "aria-label": "New terminal: another host, another place, or a new workspace (⇧⌘T)" },
    });
    setIcon(caret, "chevron-down");
    caret.addEventListener("click", () => (this.pop ? this.close() : this.open()));
  }

  // ── the menu ──

  private renderPop(): void {
    this.redrawing = true;
    try { this.pop?.detach(); } finally { this.redrawing = false; }
    const pop = this.el.createDiv({ cls: "aos-ntm-pop", attr: { role: "dialog", "aria-label": this.mode === "create" ? "New workspace" : "New terminal" } });
    this.pop = pop;
    this.el.addClass("is-open");
    this.el.querySelector(".aos-ntm-caret")?.setAttr("aria-expanded", "true");
    if (this.reason) pop.createDiv({ cls: "aos-ntm-reason", text: this.reason });
    if (this.error) pop.createDiv({ cls: "aos-ntm-error", text: this.error, attr: { role: "alert" } });
    if (this.mode === "create") this.renderCreate(pop);
    else this.renderMenu(pop);
  }

  private hostSwitch(parent: HTMLElement, onPick: (h: TermHost) => void): void {
    const sw = parent.createDiv({ cls: "aos-ntm-hosts", attr: { role: "radiogroup", "aria-label": "Host" } });
    for (const c of this.launcher.choices()) {
      if (c.hidden) continue;
      const on = c.host === this.host;
      const b = sw.createEl("button", { cls: `aos-ntm-host${on ? " is-active" : ""}`, attr: { type: "button", role: "radio", "aria-checked": String(on), tabindex: "-1", title: c.reason ?? "" } });
      b.disabled = !c.ready;
      b.createSpan({ cls: `aos-ntm-dot is-${c.host}` });
      b.createSpan({ text: c.label });
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the filter, as the rows do
      b.addEventListener("click", () => onPick(c.host));
    }
  }

  private cycleHost(dir: 1 | -1): void {
    const ready = this.launcher.choices().filter((c) => !c.hidden && c.ready).map((c) => c.host);
    if (!ready.length) return;
    const i = ready.indexOf(this.host);
    this.host = ready[(i + dir + ready.length) % ready.length];
  }

  private renderMenu(pop: HTMLElement): void {
    this.hostSwitch(pop, (h) => { this.host = h; this.renderPop(); this.focusFilter(); });
    const box = pop.createDiv({ cls: "aos-ntm-searchbox" });
    const icon = box.createSpan({ cls: "aos-ntm-searchicon" });
    setIcon(icon, "search");
    const input = box.createEl("input", { cls: "aos-ntm-filter", attr: { type: "text", placeholder: "Find a workspace, or name a new one", "aria-label": "Find a workspace, or name a new one", spellcheck: "false" } });
    input.value = this.query;
    const list = pop.createDiv({ cls: "aos-ntm-list", attr: { role: "listbox", "aria-label": "Where to start" } });
    const foot = pop.createDiv({ cls: "aos-ntm-foot" });
    const draw = () => {
      this.rows = menuRows({
        query: this.query, host: this.host, choices: this.launcher.choices(), world: this.launcher.world(),
        context: this.actions.context(), recent: this.launcher.choice().recent,
        nowSub: (h) => {
          const where = this.launcher.resolve(h, null, this.actions.context()).place.label;
          return h === "shell" ? `${where} · zsh` : `${where} · ${this.launcher.modelLabel(h)}`;
        },
      });
      const ok = this.rows.filter((r) => r.kind !== "header" && !r.disabled);
      if (!ok.some((r) => r.key === this.hi)) this.hi = firstActionable(this.rows)?.key ?? null;
      this.renderRows(list);
      this.renderFoot(foot);
    };
    input.addEventListener("input", () => { this.query = input.value; this.hi = null; draw(); });
    input.addEventListener("keydown", (e) => this.onKey(e));
    draw();
    this.focusFilter();
  }

  private focusFilter(): void {
    (this.pop?.querySelector(".aos-ntm-filter") as HTMLInputElement | null)?.focus();
  }

  private renderRows(list: HTMLElement): void {
    list.empty();
    for (const r of this.rows) {
      if (r.kind === "header") { list.createDiv({ cls: "aos-ntm-head", text: r.label }); continue; }
      const item = list.createEl("button", {
        cls: `aos-ntm-row is-${r.kind}${r.key === this.hi ? " is-hi" : ""}`,
        attr: { type: "button", role: "option", tabindex: "-1", "aria-selected": String(r.key === this.hi), "data-key": r.key },
      });
      item.disabled = !!r.disabled;
      const lead = item.createSpan({ cls: "aos-ntm-lead" });
      if (r.kind === "now" && r.host) lead.createSpan({ cls: `aos-ntm-dot is-${r.host}` });
      else setIcon(lead, rowIcon(r));
      const text = item.createSpan({ cls: "aos-ntm-text" });
      text.createSpan({ cls: "aos-ntm-label", text: r.label });
      if (r.sub) text.createSpan({ cls: "aos-ntm-rowsub", text: r.sub });
      if (r.kbd) item.createSpan({ cls: "aos-ntm-kbd", text: r.kbd });
      item.addEventListener("mouseenter", () => { if (!r.disabled && this.hi !== r.key) { this.hi = r.key; this.markHi(list); this.renderFoot(this.pop?.querySelector(".aos-ntm-foot") as HTMLElement); } });
      item.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the filter
      item.addEventListener("click", (e) => { void this.act(r, e.shiftKey ? "resume" : e.altKey ? "shell" : "start"); });
    }
  }

  private markHi(list: HTMLElement): void {
    list.querySelectorAll(".aos-ntm-row").forEach((el) => {
      const on = (el as HTMLElement).dataset.key === this.hi;
      el.toggleClass("is-hi", on);
      el.setAttr("aria-selected", String(on));
    });
  }

  private renderFoot(foot: HTMLElement | null): void {
    if (!foot) return;
    foot.empty();
    const row = this.rows.find((r) => r.key === this.hi) ?? null;
    const host = row?.kind === "now" && row.host ? row.host : this.host;
    const accessRow = foot.createDiv({ cls: "aos-ntm-access" });
    if (host !== "shell") {
      const label = accessRow.createEl("label", { cls: "aos-ntm-accesslabel", text: "Access" });
      const sel = label.createEl("select", { cls: "aos-ntm-accesssel", attr: { "aria-label": "What the agent may do" } });
      const current = this.launcher.choice().access as TermAccess;
      for (const a of TERM_ACCESS) {
        const o = sel.createEl("option", { text: TERM_ACCESS_LABEL[a], attr: { value: a } });
        if (a === current) o.selected = true;
      }
      sel.addEventListener("change", () => { this.launcher.remember({ access: sel.value as TermAccess }); this.refresh(); });
      accessRow.createSpan({ cls: "aos-ntm-accessnote", text: TERM_ACCESS_NOTE[current] });
    }
    const place = row?.kind === "place" ? row.place ?? null : row?.kind === "now" ? this.launcher.resolve(host, null, this.actions.context()).place : null;
    const preview = row?.kind === "create"
      ? `${this.launcher.preview(host, { gitInit: this.launcher.gitDefault(row.slug ?? "") })}`
      : this.launcher.preview(host);
    const pre = foot.createDiv({ cls: "aos-ntm-preview" });
    pre.createSpan({ cls: "aos-ntm-prompt", text: "$ " });
    pre.createSpan({ text: preview });
    const where = row?.kind === "create" ? `workspaces/${row.slug}` : place?.dir;
    if (where) foot.createDiv({ cls: "aos-ntm-where", text: `in ${where}` });
    foot.createDiv({ cls: "aos-ntm-keys", text: "⏎ start · ⇧⏎ continue the last conversation · ⌥⏎ a shell there · Tab host" });
  }

  private onKey(e: KeyboardEvent): void {
    const ok = this.rows.filter((r) => r.kind !== "header" && !r.disabled);
    const i = ok.findIndex((r) => r.key === this.hi);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!ok.length) return;
      const j = e.key === "ArrowDown" ? (i + 1) % ok.length : (i - 1 + ok.length) % ok.length;
      this.hi = ok[j].key;
      const list = this.pop?.querySelector(".aos-ntm-list") as HTMLElement | null;
      if (list) { this.markHi(list); (list.querySelector(`[data-key="${this.hi}"]`) as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" }); }
      this.renderFoot(this.pop?.querySelector(".aos-ntm-foot") as HTMLElement);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      this.cycleHost(e.shiftKey ? -1 : 1);
      this.renderPop();
      this.focusFilter();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const r = ok[i] ?? null;
      if (r) void this.act(r, e.shiftKey ? "resume" : e.altKey ? "shell" : "start");
    }
  }

  private async act(r: MenuRow, how: "start" | "resume" | "shell"): Promise<void> {
    if (r.disabled || this.busy) return;
    if (r.kind === "new") { this.open("create"); return; }
    if (r.kind === "create") {
      if (how === "start" || how === "shell") await this.run(() => this.actions.create(this.query, how === "shell" ? "shell" : this.host, this.launcher.gitDefault(r.slug ?? "")));
      return;
    }
    const host: TermHost = how === "shell" ? "shell" : r.kind === "now" && r.host ? r.host : this.host;
    const picked = r.kind === "place" ? r.place ?? null : null;
    await this.run(() => this.actions.start({ host, picked, resume: how === "resume" && host !== "shell" ? "last" : null }));
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await fn();
      this.close(false);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      if (this.pop) this.renderPop();
    } finally {
      this.busy = false;
    }
  }

  // ── the New workspace sheet (T6, T7) ──

  private renderCreate(pop: HTMLElement): void {
    pop.addClass("is-create");
    pop.createDiv({ cls: "aos-ntm-title", text: "New workspace" });
    const label = pop.createEl("label", { cls: "aos-ntm-field" });
    label.createSpan({ cls: "aos-ntm-fieldname", text: "Name" });
    const input = label.createEl("input", { cls: "aos-ntm-name-input", attr: { type: "text", placeholder: "e.g. Tide chart", spellcheck: "false" } });
    input.value = this.createName;
    const hint = pop.createDiv({ cls: "aos-ntm-hint" });
    const exists = pop.createDiv({ cls: "aos-ntm-exists" });
    pop.createDiv({ cls: "aos-ntm-fieldname", text: "Then start" });
    this.hostSwitch(pop, (h) => { this.host = h; this.renderPop(); (this.pop?.querySelector(".aos-ntm-name-input") as HTMLInputElement | null)?.focus(); });
    const gitRow = pop.createEl("label", { cls: "aos-ntm-git" });
    const git = gitRow.createEl("input", { attr: { type: "checkbox" } });
    gitRow.createSpan({ text: "Start a git repo here" });
    const gitNote = gitRow.createSpan({ cls: "aos-ntm-gitnote" });
    const pre = pop.createDiv({ cls: "aos-ntm-preview" });
    const buttons = pop.createDiv({ cls: "aos-ntm-buttons" });
    const cancel = buttons.createEl("button", { cls: "aos-ntm-cancel", text: "Cancel", attr: { type: "button" } });
    const go = buttons.createEl("button", { cls: "aos-ntm-go mod-cta", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    git.addEventListener("change", () => { this.createGit = git.checked; draw(); });

    const draw = () => {
      const name = this.createName;
      const slug = slugify(name);
      const problem = this.launcher.nameProblem(name);
      const there = !problem && this.launcher.exists(name);
      const defaultGit = slug ? this.launcher.gitDefault(slug) : true;
      const gitOn = this.createGit ?? defaultGit;
      hint.setText(!name.trim() ? "workspaces/… · README.md, CLAUDE.md, AGENTS.md" : problem ?? `→ workspaces/${slug} · README.md, CLAUDE.md, AGENTS.md${!there && gitOn ? " · git repo" : ""}`);
      hint.toggleClass("is-bad", !!problem);
      exists.empty();
      exists.toggleClass("is-shown", there);
      if (there) exists.setText(`${slug} already exists: ⌘⏎ opens it, or choose another name.`);
      gitRow.toggleClass("is-hidden", there || !slug);
      git.checked = gitOn;
      gitNote.setText(defaultGit ? "" : " (off: your vault's git tracks workspaces/)");
      const hostName = this.host === "shell" ? "open a shell" : `start ${TERM_HOST_LABEL[this.host]}`;
      go.setText(there ? `Open ${slug} and ${hostName}` : `Create and ${hostName}`);
      go.disabled = !slug || !!problem;
      pre.empty();
      pre.createSpan({ cls: "aos-ntm-prompt", text: "$ " });
      pre.createSpan({ text: slug && !problem ? `${this.launcher.preview(this.host, { gitInit: !there && gitOn })}   in workspaces/${slug}` : "type a name to see what runs" });
    };
    const submit = (openExisting: boolean) => {
      const slug = slugify(this.createName);
      if (!slug || this.launcher.nameProblem(this.createName)) return;
      const there = this.launcher.exists(this.createName);
      if (there && !openExisting) { input.focus(); return; }
      const gitOn = !there && (this.createGit ?? this.launcher.gitDefault(slug));
      void this.run(() => this.actions.create(this.createName, this.host, gitOn));
    };
    input.addEventListener("input", () => { this.createName = input.value; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(e.metaKey); }
      else if (e.key === "Tab" && !e.shiftKey && e.altKey) { e.preventDefault(); this.cycleHost(1); this.renderPop(); (this.pop?.querySelector(".aos-ntm-name-input") as HTMLInputElement | null)?.focus(); }
    });
    go.addEventListener("click", () => submit(true));
    draw();
    input.focus();
  }
}
