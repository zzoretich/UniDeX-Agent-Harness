// HostModelMenu.ts — the composer's host and model menu (spec 2026-10-07-sessions-ux U2, U4, U6, U9; Picker 2 on the
// design canvas). One chip, `● Claude Code · Opus 5.5 · High ▾`, opens a popover above it: the host switch (a host that
// is off greyed, with why), a search, the host's current models with the older ones folded, the chosen model's effort
// levels, a custom model id, and where the list came from with ↻. In a thread the host is locked (each host resumes only
// its own sessions) and the menu offers a new session on the other one; in Vault chat any host answers any question, at
// the levels its one-shot path takes. The choices come from data/agentSessions.ts; the owner keeps the value, remembers
// it (settingsDefaults.ts) and sends it.
import { setIcon } from "obsidian";
import type { HostCatalog, HostCatalogHost } from "../host";
import type { SessionHost } from "../data/aosConfig";
import {
  EFFORT_TITLE, HOST_LABEL, catalogHost, catalogSource, choiceText, defaultChoice, effortLabel, effortsFor, findModel,
  modelName, searchModels, splitModels, type HostChoice, type RememberedChoice,
} from "../data/agentSessions";
import { sanitizeSessionChoice } from "../settingsDefaults";

/** new: a session about to start (any ready host); thread: its next turn (the host is fixed); vault: a Vault question. */
export type HostModelMode = "new" | "thread" | "vault";

/** What the menu shows and the owner sends. A null model is the host's own default (Claude's `default`). In Vault mode
 *  with a `local` option, a null host is the local engine (local-first A2). */
export interface HostModelValue { host: SessionHost | null; model: string | null; effort: string | null }

/** Vault chat's local engine as a choice beside the hosts (local-first A2: ai.chat local under provider local). */
export interface LocalChoice {
  /** The model it runs (provider-state's, else local.model); null: the local model, unnamed. */
  model: string | null;
  /** Why it cannot answer now (the local engine down, its model not pulled), or null. A question still goes there and
   *  comes back with the reason and a "Run once on …" offer. */
  down: string | null;
}

export interface HostModelMenuOptions {
  mode: HostModelMode;
  catalog: HostCatalog | null;
  /** hostChoices(): which hosts are ready, and why not. */
  choices: HostChoice[];
  value: HostModelValue;
  /** The last choice on each host (the HUD's settings, U12): where a switch to that host starts. */
  remembered?: Partial<Record<SessionHost, RememberedChoice>> | null;
  /** The catalog is being fetched again: ↻ waits. */
  refreshing?: boolean;
  /** The chip does not open (a turn is being sent). */
  disabled?: boolean;
  onChange(value: HostModelValue): void;
  /** ↻: ask the hosts again. Without it the menu has no refresh button. */
  onRefresh?(): void;
  /** Thread mode: start a new session on the other host. Without it the menu offers none. */
  onNewSessionOn?(host: SessionHost): void;
  /** Thread mode: the model the thread ran on so far (null: the host's default), tagged "used so far" while another is
   *  picked. Left out, no row is tagged. */
  usedModel?: string | null;
  /** Vault mode: the local engine as the first choice, which a null host means (local-first A2). */
  local?: LocalChoice | null;
  now?: () => Date;
}

/** What update() may change: everything but the callbacks. */
export type HostModelMenuState = Partial<Pick<HostModelMenuOptions, "mode" | "catalog" | "choices" | "value" | "remembered" | "refreshing" | "disabled" | "usedModel" | "local">>;

type ValueInputs = Pick<HostModelMenuOptions, "mode" | "catalog" | "choices" | "value" | "remembered" | "local">;

/** The host the menu shows: a thread's own; else the chosen one while it is ready, else the first ready one. */
export function menuHost(mode: HostModelMode, host: SessionHost | null, choices: HostChoice[]): SessionHost | null {
  if (mode === "thread") return host;
  const ready = choices.filter((c) => c.ready).map((c) => c.host);
  return host && ready.includes(host) ? host : ready[0] ?? null;
}

/**
 * The value the chip shows and a turn sends. A thread keeps what it ran on (a null effort is the host's default, not a
 * change). A new session or a Vault question starts on a ready host, with a model and an effort that model takes: the
 * given ones when they fit, else the remembered ones for a host it moved to, else the host's defaults.
 */
export function menuValue(o: ValueInputs): HostModelValue {
  // Vault with the local engine on offer: a null host is that choice, not "no host ready".
  if (o.mode === "vault" && o.local && o.value.host === null) return { host: null, model: null, effort: null };
  const host = menuHost(o.mode, o.value.host, o.choices);
  if (!host) return { host: null, model: null, effort: null };
  if (o.mode === "thread") return { host, model: o.value.model, effort: o.value.effort };
  const start = host === o.value.host ? { model: o.value.model, effort: o.value.effort } : o.remembered?.[host] ?? null;
  return { host, ...defaultChoice(host, catalogHost(o.catalog, host), start, o.mode === "vault") };
}

/** The value after a switch to `host`: its remembered model and effort, else its defaults. */
export function switchHost(host: SessionHost, catalog: HostCatalog | null, remembered: ValueInputs["remembered"], vault = false): HostModelValue {
  return { host, ...defaultChoice(host, catalogHost(catalog, host), remembered?.[host] ?? null, vault) };
}

/** The value after picking a model (null: the host's own default): the effort stays when the model takes it, else the
 *  catalog's default level, else medium, else the model's first. */
export function withModel(host: SessionHost, entry: HostCatalogHost | null, model: string | null, effort: string | null, vault = false): HostModelValue {
  return { host, ...defaultChoice(host, entry, { model, effort }, vault), model };
}

export interface ModelRow {
  /** The model's id; null for Codex's own default (no --model). */
  id: string | null;
  name: string;
  description: string;
  selected: boolean;
  /** Not in the catalog: an id typed in, or the host's default when the host listed nothing. */
  custom: boolean;
  /** A note after the name: "your default" (Codex's configured model), "used so far" (a thread's earlier model). */
  tag: string | null;
}

/**
 * The models the list shows: the current ones, then the older ones when they are unfolded; a search looks through all
 * of them. While the fold is shut the chosen model and the thread's earlier one (`used`) still show when they are older
 * ones, so a pick made through the search keeps its check once the search is cleared. The chosen model leads when the
 * catalog does not list it, so the check always has a row. `used` undefined: not a thread, or its model is unknown.
 */
export function modelRows(host: SessionHost, entry: HostCatalogHost | null, model: string | null, query: string, older: boolean, used?: string | null): { rows: ModelRow[]; olderCount: number; foldable: boolean } {
  const split = splitModels(entry);
  const q = query.trim();
  const own = (id: string | null): string | null => id ?? (host === "claude" ? "default" : null);
  const chosen = own(model);
  const usedId = used === undefined ? undefined : own(used);
  const listed = q ? searchModels(entry?.models ?? [], q)
    : older ? [...split.current, ...split.older]
    : [...split.current, ...split.older.filter((m) => m.id === chosen || m.id === usedId)];
  const tag = (id: string | null, selected: boolean): string | null => {
    const tags = [
      host === "codex" && id !== null && id === entry?.defaultModel ? "your default" : null,
      !selected && usedId !== undefined && id === usedId ? "used so far" : null,
    ].filter((t): t is string => !!t);
    return tags.length ? tags.join(" · ") : null;
  };
  const rows: ModelRow[] = listed.map((m) => {
    const selected = m.id === chosen;
    return { id: m.id, name: m.name, description: m.description, selected, custom: false, tag: tag(m.id, selected) };
  });
  if (!findModel(entry, chosen)) {
    const isOwn = chosen === null || (host === "claude" && chosen === "default");
    const extra: ModelRow = {
      id: chosen, name: modelName(host, entry, chosen), selected: true, custom: true, tag: tag(chosen, true),
      description: isOwn ? `${HOST_LABEL[host]}'s own default model` : "Custom model id",
    };
    if (!q || `${extra.name}\n${extra.id ?? ""}`.toLowerCase().includes(q.toLowerCase())) rows.unshift(extra);
  }
  return { rows, olderCount: split.older.length, foldable: !q && split.older.length > 0 };
}

/** A host that is on in agenticos.json: ready, or on but not logged in. */
function hostOn(c: HostChoice): boolean {
  return c.ready || (!!c.reason && / not logged in$/.test(c.reason));
}

/**
 * The line under the host switch for a host that is not ready: how to turn it on, or why it cannot run. `aos hosts add
 * <h>` (install-import B2) wires that host and leaves the other as it was, as Settings ▸ Hosts' Add button does.
 */
export function hostOffLine(c: HostChoice): string | null {
  if (c.ready) return null;
  if (hostOn(c)) return c.reason;
  return `${c.label} is off on this Mac: aos hosts add ${c.host} turns it on`;
}

/** What the menu says when no host is ready: with every host off, how to turn one on; else the lines say why. */
export function noHostLine(choices: HostChoice[]): string {
  return choices.some(hostOn)
    ? "No host is ready on this Mac."
    : "No host is ready on this Mac. Run aos hosts add claude or aos hosts add codex, then reopen this menu.";
}

/** The effort row's note: Codex's configured level, which a turn without one runs at. */
export function effortNote(host: SessionHost, entry: HostCatalogHost | null): string {
  return host === "codex" && entry?.defaultEffort ? `Your Codex default: ${effortLabel(entry.defaultEffort)}` : "";
}

/** Why a typed model id cannot be used, or null. The rule is the one the HUD's settings keep a model by (and the app's
 *  session schema admits), so a custom id is remembered as it was typed. */
export function customModelError(text: string): string | null {
  const id = text.trim();
  if (!id) return "Type a model id.";
  if (id.startsWith("-")) return "A model id cannot start with a dash.";
  if (sanitizeSessionChoice({ models: { claude: id } }).models.claude !== id) return "A model id is one word of letters, digits and . _ : / [ ] -, up to 80 characters.";
  return null;
}

/** The local engine's name in the chip and the host switch. */
export const LOCAL_LABEL = "This Mac";

let menus = 0;

/**
 * The chip and its popover. The owner renders it once into the composer's toolbar, passes the catalog, the host
 * choices and its value, and hears every pick through onChange; update() hands it a new catalog or value. Keys: ↑↓ walk
 * the models (↓ from the search), Enter picks, Escape closes; focus goes back to the chip.
 */
export class HostModelMenu {
  private opts: HostModelMenuOptions;
  private readonly root: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly id = `aos-hm-${++menus}`;
  private pop: HTMLElement | null = null;
  private listWrap: HTMLElement | null = null;
  private query = "";
  private older = false;
  /** The custom id field while it is open: what was typed and why it was refused. */
  private custom: { text: string; error: string | null } | null = null;
  private readonly onOutside = (e: MouseEvent): void => {
    if (e.target instanceof Node && this.root.contains(e.target)) return;
    this.close(false);
  };

  constructor(parentEl: HTMLElement, opts: HostModelMenuOptions) {
    this.opts = { ...opts };
    this.root = parentEl.createDiv({ cls: "aos-hm", attr: { "data-mode": opts.mode } });
    this.trigger = this.root.createEl("button", {
      cls: "aos-hm-trigger",
      attr: { type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": `${this.id}-pop` },
    });
    this.trigger.addEventListener("click", () => (this.pop ? this.close() : this.open()));
    this.trigger.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !this.pop) { e.preventDefault(); this.open(); }
    });
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    // Tabbing out of the menu closes it, as a click outside does.
    this.root.addEventListener("focusout", (e) => {
      const to = e.relatedTarget;
      if (this.pop && to instanceof Node && !this.root.contains(to)) this.close(false);
    });
    this.renderTrigger();
  }

  /** The value the chip shows: what the owner sends with the next turn. */
  value(): HostModelValue { return menuValue(this.opts); }

  isOpen(): boolean { return this.pop !== null; }

  update(next: HostModelMenuState): void {
    this.opts = { ...this.opts, ...next };
    this.root.setAttr("data-mode", this.opts.mode);
    if (this.opts.disabled) this.close(false);
    this.renderTrigger();
    if (this.pop) this.renderPop();
  }

  open(): void {
    if (this.pop || this.opts.disabled) return;
    const v = this.value();
    const entry = v.host ? catalogHost(this.opts.catalog, v.host) : null;
    this.query = "";
    this.custom = null;
    this.older = !!v.model && splitModels(entry).older.some((m) => m.id === v.model);
    this.pop = this.root.createDiv({
      cls: "aos-hm-pop",
      attr: { id: `${this.id}-pop`, role: "dialog", "aria-label": this.opts.mode === "thread" ? "Model for the next turn" : "Host and model" },
    });
    this.root.ownerDocument.addEventListener("mousedown", this.onOutside, true);
    this.renderTrigger();
    this.renderPop("search");
  }

  /** Closes the popover; `focusTrigger` (the default) puts focus back on the chip, a click elsewhere keeps its own. */
  close(focusTrigger = true): void {
    if (!this.pop) return;
    this.root.ownerDocument.removeEventListener("mousedown", this.onOutside, true);
    this.pop.detach();
    this.pop = null;
    this.listWrap = null;
    this.renderTrigger();
    if (focusTrigger) this.trigger.focus();
  }

  destroy(): void {
    this.close(false);
    this.root.detach();
  }

  private vault(): boolean { return this.opts.mode === "vault"; }

  private entry(host: SessionHost | null): HostCatalogHost | null {
    return host ? catalogHost(this.opts.catalog, host) : null;
  }

  /** A pick: the chip and the popover redraw, then the owner hears it. */
  private emit(next: HostModelValue, focus?: string): void {
    this.opts = { ...this.opts, value: next };
    this.renderTrigger();
    if (this.pop) this.renderPop(focus);
    this.opts.onChange(next);
  }

  private renderTrigger(): void {
    const v = this.value();
    const t = this.trigger;
    t.empty();
    t.disabled = !!this.opts.disabled;
    t.setAttr("data-host", v.host);
    t.setAttr("aria-expanded", String(!!this.pop));
    t.toggleClass("is-open", !!this.pop);
    if (this.opts.mode === "thread" && v.host) {
      const lock = t.createSpan({ cls: `aos-hm-lockicon is-${v.host}` });
      setIcon(lock, "lock");
      t.setAttr("title", `This thread stays on ${HOST_LABEL[v.host]}`);
    } else {
      t.createSpan({ cls: `aos-hm-dot${v.host ? ` is-${v.host}` : ""}` });
      t.setAttr("title", "Host and model");
    }
    if (!v.host && this.opts.local) {
      // The dot drawn above has no host class; the local engine's own.
      t.querySelector(".aos-hm-dot")?.addClass("is-local");
      t.setAttr("data-host", "local");
      t.createSpan({ cls: "aos-hm-chiphost", text: LOCAL_LABEL });
      t.createSpan({ cls: "aos-hm-chiprest", text: `· ${this.opts.local.model ?? "local model"}${this.opts.local.down ? " · down" : ""}` });
    } else if (!v.host) t.createSpan({ cls: "aos-hm-chiphost", text: "No host ready" });
    else {
      t.createSpan({ cls: "aos-hm-chiphost", text: HOST_LABEL[v.host] });
      t.createSpan({ cls: "aos-hm-chiprest", text: `· ${choiceText(v.host, this.entry(v.host), v.model, v.effort, this.vault())}` });
    }
    const chev = t.createSpan({ cls: "aos-hm-chev" });
    setIcon(chev, "chevron-down");
  }

  /** Redraws the popover. Focus stays on the control it was on (by its data-hm-key), or goes to `focus` when given. */
  private renderPop(focus?: string): void {
    const pop = this.pop;
    if (!pop) return;
    const active = this.root.ownerDocument.activeElement;
    const key = focus ?? (active instanceof HTMLElement && pop.contains(active) ? active.getAttribute("data-hm-key") : null);
    pop.empty();
    this.listWrap = null;
    const v = this.value();
    const host = v.host;
    if (this.opts.mode === "thread") this.renderLock(pop, host);
    else this.renderHosts(pop, host);
    if (host) {
      this.renderSearch(pop, host);
      this.listWrap = pop.createDiv({ cls: "aos-hm-modelwrap" });
      this.renderModels();
      this.renderEfforts(pop, host, v);
      this.renderFoot(pop, host);
    }
    if (host && this.opts.mode === "thread") pop.createDiv({ cls: "aos-hm-caption", text: "Applies from your next message. Earlier turns keep the model they ran on." });
    else if (host && this.vault()) pop.createDiv({ cls: "aos-hm-caption", text: "Each question can use any host" });
    else if (!host && this.opts.local) {
      pop.createDiv({ cls: "aos-hm-caption", text: this.opts.local.down ?? `Answers on ${this.opts.local.model ?? "the local model"} on this Mac; nothing is spent.` });
    }
    if (!key) return;
    const el = Array.from(pop.querySelectorAll<HTMLElement>("[data-hm-key]")).find((x) => x.getAttribute("data-hm-key") === key);
    if (el && !(el as HTMLButtonElement).disabled) el.focus();
    // The control is gone or disabled now (↻ while it asks): focus stays in the menu, so its keys keep working.
    else (pop.querySelector<HTMLElement>(".aos-hm-search") ?? pop.querySelector<HTMLElement>("input, button:not(:disabled)"))?.focus();
  }

  /** Thread mode: the host, locked, and a new session on the other host when that one is ready. */
  private renderLock(pop: HTMLElement, host: SessionHost | null): void {
    if (!host) return;
    const row = pop.createDiv({ cls: "aos-hm-lock" });
    const icon = row.createSpan({ cls: "aos-hm-lockicon" });
    setIcon(icon, "lock");
    const text = row.createSpan({ cls: "aos-hm-locktext" });
    text.createSpan({ cls: "aos-hm-lockhost", text: HOST_LABEL[host] });
    text.appendText(` · this thread stays on ${HOST_LABEL[host]}`);
    const other: SessionHost = host === "claude" ? "codex" : "claude";
    const onNew = this.opts.onNewSessionOn;
    if (!onNew || !this.opts.choices.some((c) => c.host === other && c.ready)) return;
    const b = row.createEl("button", { cls: "aos-hm-newon", text: `New session on ${HOST_LABEL[other]}`, attr: { type: "button", "data-host": other, "data-hm-key": "new-session" } });
    b.addEventListener("click", () => { this.close(); onNew(other); });
  }

  /** New and Vault: the host switch, a line for each host that is off, or what to do when none is ready. */
  private renderHosts(pop: HTMLElement, host: SessionHost | null): void {
    const group = pop.createDiv({ cls: "aos-hm-hosts", attr: { role: "group", "aria-label": "Host" } });
    const local = this.vault() ? this.opts.local : null;
    if (local) {
      // The local engine first (local-first A2): a question goes there unless a host is picked for it.
      const on = host === null;
      const b = group.createEl("button", {
        cls: `aos-hm-host${on ? " is-active" : ""}`,
        attr: { type: "button", "data-host": "local", "aria-pressed": String(on), "data-hm-key": "host:local", title: local.down ?? "Ask the local model on this Mac" },
      });
      b.createSpan({ cls: "aos-hm-dot is-local" });
      b.appendText(LOCAL_LABEL);
      b.addEventListener("click", () => {
        if (on) return;
        this.query = "";
        this.older = false;
        this.custom = null;
        this.emit({ host: null, model: null, effort: null }, "host:local");
      });
    }
    for (const c of this.opts.choices) {
      const on = c.host === host;
      const b = group.createEl("button", {
        cls: `aos-hm-host${on ? " is-active" : ""}`,
        attr: {
          type: "button", "data-host": c.host, "aria-pressed": String(on), "data-hm-key": `host:${c.host}`,
          title: c.ready ? (this.vault() ? `Ask ${c.label}` : `Run this session on ${c.label}`) : c.reason ?? hostOffLine(c) ?? "",
        },
      });
      b.createSpan({ cls: `aos-hm-dot is-${c.host}` });
      b.appendText(c.label);
      b.disabled = !c.ready;
      b.addEventListener("click", () => {
        if (!c.ready || c.host === host) return;
        this.query = "";
        this.older = false;
        this.custom = null;
        this.emit(switchHost(c.host, this.opts.catalog, this.opts.remembered, this.vault()), `host:${c.host}`);
      });
    }
    if (!host && !local) {
      pop.createDiv({ cls: "aos-hm-nohost", text: noHostLine(this.opts.choices) });
      // With every host off the line above says it all; else each host says why it is not ready.
      if (!this.opts.choices.some(hostOn)) return;
    }
    for (const c of this.opts.choices) {
      const line = hostOffLine(c);
      if (line) pop.createDiv({ cls: "aos-hm-offline", text: line, attr: { "data-host": c.host } });
    }
  }

  private renderSearch(pop: HTMLElement, host: SessionHost): void {
    const n = this.entry(host)?.models.length ?? 0;
    const box = pop.createEl("label", { cls: "aos-hm-searchbox" });
    const icon = box.createSpan({ cls: "aos-hm-searchicon" });
    setIcon(icon, "search");
    const input = box.createEl("input", {
      cls: "aos-hm-search",
      attr: {
        type: "text", "aria-label": "Search models", "aria-controls": `${this.id}-models`, spellcheck: "false", autocomplete: "off",
        placeholder: n ? `Search ${n} ${HOST_LABEL[host]} models` : "Search models", "data-hm-key": "search",
      },
    });
    input.value = this.query;
    input.addEventListener("input", () => { this.query = input.value; this.renderModels(); });
  }

  /** The list alone, so typing in the search keeps its focus. */
  private renderModels(): void {
    const wrap = this.listWrap;
    const v = this.value();
    if (!wrap || !v.host) return;
    const host = v.host;
    wrap.empty();
    const entry = this.entry(host);
    const used = this.opts.mode === "thread" ? this.opts.usedModel : undefined;
    const { rows, olderCount, foldable } = modelRows(host, entry, v.model, this.query, this.older, used);
    const list = wrap.createDiv({ cls: "aos-hm-models", attr: { id: `${this.id}-models`, role: "listbox", "aria-label": `${HOST_LABEL[host]} models` } });
    for (const r of rows) {
      const b = list.createEl("button", {
        cls: `aos-hm-model${r.selected ? " is-selected" : ""}${r.custom ? " is-custom" : ""}`,
        attr: { type: "button", role: "option", "aria-selected": String(r.selected), "data-model": r.id ?? "", "data-hm-key": `model:${r.id ?? ""}` },
      });
      const text = b.createSpan({ cls: "aos-hm-modeltext" });
      // The name and its tag on one line; the tag stays out of the name, which the chip and the tests read.
      const line = text.createSpan({ cls: "aos-hm-modelline" });
      line.createSpan({ cls: "aos-hm-modelname", text: r.name });
      if (r.tag) { line.appendText(" "); line.createSpan({ cls: "aos-hm-modeltag", text: r.tag }); }
      if (r.description) text.createSpan({ cls: "aos-hm-modeldesc", text: r.description });
      if (r.selected) {
        const check = b.createSpan({ cls: "aos-hm-check" });
        setIcon(check, "check");
      }
      b.addEventListener("click", () => this.pickModel(r.id));
    }
    if (this.query.trim() && !rows.length) wrap.createDiv({ cls: "aos-hm-empty", text: "No model matches. Use a custom model id below." });
    if (foldable) {
      const b = wrap.createEl("button", {
        cls: "aos-hm-older",
        attr: { type: "button", "aria-expanded": String(this.older), "aria-controls": `${this.id}-models`, "data-hm-key": "older" },
      });
      b.createSpan({ text: this.older ? "Hide older models" : `Older models (${olderCount})` });
      const icon = b.createSpan({ cls: "aos-hm-chev" });
      setIcon(icon, this.older ? "chevron-up" : "chevron-down");
      b.addEventListener("click", () => {
        this.older = !this.older;
        this.renderModels();
        this.listWrap?.querySelector<HTMLElement>(".aos-hm-older")?.focus();
      });
    }
  }

  private pickModel(id: string | null): void {
    const v = this.value();
    if (!v.host) return;
    this.emit(withModel(v.host, this.entry(v.host), id, v.effort, this.vault()), `model:${id ?? ""}`);
  }

  private renderEfforts(pop: HTMLElement, host: SessionHost, v: HostModelValue): void {
    const entry = this.entry(host);
    const levels = effortsFor(host, entry, v.model, this.vault());
    const box = pop.createDiv({ cls: "aos-hm-effortbox" });
    const head = box.createDiv({ cls: "aos-hm-efforthead" });
    head.createSpan({ cls: "aos-hm-efforttitle", text: EFFORT_TITLE[host] });
    const note = effortNote(host, entry);
    if (note) head.createSpan({ cls: "aos-hm-effortnote", text: note });
    if (!levels.length) {
      box.createDiv({ cls: "aos-hm-noeffort", text: "This model has no effort setting." });
      return;
    }
    const group = box.createDiv({ cls: "aos-hm-efforts", attr: { role: "group", "aria-label": EFFORT_TITLE[host] } });
    for (const l of levels) {
      const on = l === v.effort;
      const b = group.createEl("button", {
        cls: `aos-hm-effort${on ? " is-active" : ""}`, text: effortLabel(l),
        attr: { type: "button", "aria-pressed": String(on), "data-effort": l, "data-hm-key": `effort:${l}` },
      });
      b.addEventListener("click", () => { if (!on) this.emit({ ...v, effort: l }, `effort:${l}`); });
    }
  }

  /** Custom model id… (or its field), where the list came from, and ↻. */
  private renderFoot(pop: HTMLElement, host: SessionHost): void {
    const foot = pop.createDiv({ cls: "aos-hm-foot" });
    const entry = this.entry(host);
    const custom = this.custom;
    if (custom) {
      const row = foot.createDiv({ cls: "aos-hm-customrow" });
      const example = entry?.models.find((m) => !m.main)?.id ?? entry?.models[0]?.id;
      const input = row.createEl("input", {
        cls: "aos-hm-custominput",
        attr: {
          type: "text", "aria-label": "Custom model id", spellcheck: "false", autocomplete: "off", "data-hm-key": "custom-input",
          placeholder: example ? `e.g. ${example}` : "A model id", "aria-invalid": custom.error ? "true" : null,
          "aria-describedby": custom.error ? `${this.id}-customerror` : null,
        },
      });
      input.value = custom.text;
      input.addEventListener("input", () => { custom.text = input.value; });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this.useCustom(); }
        else if (e.key === "Escape") {
          // Escape here closes the field, not the menu.
          e.preventDefault();
          e.stopPropagation();
          this.custom = null;
          this.renderPop("custom");
        }
      });
      const use = row.createEl("button", { cls: "mod-cta aos-hm-customuse", text: "Use", attr: { type: "button", "data-hm-key": "custom-use" } });
      use.addEventListener("click", () => this.useCustom());
      if (custom.error) foot.createDiv({ cls: "aos-hm-customerror", text: custom.error, attr: { id: `${this.id}-customerror`, role: "alert" } });
      return;
    }
    const row = foot.createDiv({ cls: "aos-hm-footrow" });
    const open = row.createEl("button", { cls: "aos-hm-custom", text: "Custom model id…", attr: { type: "button", "data-hm-key": "custom" } });
    open.addEventListener("click", () => {
      this.custom = { text: "", error: null };
      this.renderPop("custom-input");
    });
    const now = this.opts.now ? this.opts.now() : new Date();
    row.createSpan({ cls: `aos-hm-source${entry?.ok ? "" : " is-short"}`, text: catalogSource(host, entry, now) });
    const onRefresh = this.opts.onRefresh;
    if (!onRefresh) return;
    const refresh = row.createEl("button", {
      cls: `aos-hm-refresh${this.opts.refreshing ? " is-busy" : ""}`,
      attr: { type: "button", "aria-label": "Refresh the model list", title: "Ask the host again", "data-hm-key": "refresh" },
    });
    setIcon(refresh, "refresh-cw");
    refresh.disabled = !!this.opts.refreshing;
    refresh.addEventListener("click", () => onRefresh());
  }

  private useCustom(): void {
    const custom = this.custom;
    const v = this.value();
    if (!custom || !v.host) return;
    const error = customModelError(custom.text);
    if (error) {
      custom.error = error;
      this.renderPop("custom-input");
      return;
    }
    this.custom = null;
    this.emit(withModel(v.host, this.entry(v.host), custom.text.trim(), v.effort, this.vault()), "custom");
  }

  /** Escape closes; ↓ from the search and ↑↓ in the list walk the models and the Older toggle; Enter in the search
   *  picks the first match. */
  private onKey(e: KeyboardEvent): void {
    if (!this.pop) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    const search = this.pop.querySelector<HTMLInputElement>(".aos-hm-search");
    const items = this.listWrap ? Array.from(this.listWrap.querySelectorAll<HTMLElement>(".aos-hm-model, .aos-hm-older")) : [];
    const at = target ? items.indexOf(target) : -1;
    if (target && target === search) {
      if (e.key === "ArrowDown" && items.length) { e.preventDefault(); items[0].focus(); }
      else if (e.key === "Enter") {
        const first = this.listWrap?.querySelector<HTMLElement>(".aos-hm-model");
        if (first) { e.preventDefault(); first.click(); }
      }
      return;
    }
    if (at < 0 || e.key === "Enter") return;
    e.preventDefault();
    if (e.key === "ArrowDown") items[Math.min(at + 1, items.length - 1)].focus();
    else if (at > 0) items[at - 1].focus();
    else search?.focus();
  }
}
