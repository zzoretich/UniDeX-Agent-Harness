import { setIcon } from "obsidian";
import { TERM_HOST_LABEL } from "../data/terminalLaunch";
import { ageText, type SidebarGroup, type SidebarRow, type TermRow } from "../data/termGroups";
import type { HistoryRow } from "../data/sessionHistory";

export interface TermListActions {
  select(id: string): void;
  close(id: string): void;
  /** The group header's +: start the host ⌘T starts in that group's place (Other folders: the vault). */
  startIn(group: SidebarGroup): void;
  clearEnded(): void;
  /** A workspace group's Open workspace: Spaces, with that workspace selected (spaces-redesign D12). Select only. */
  openWorkspace?(name: string): void;
  /** Show every group again after the list was scoped to one workspace (reveal). */
  clearScope?(): void;
  /** A row's Computer marks (agent-computer D32, D35): a dot while its agent drives a computer off-screen or waits on an
   *  ask, and "waiting" while it waits. */
  mark?(id: string): { dot: boolean; waiting: boolean };
  /** A past conversation: its read-only chat (code-chat C6). */
  openPast?(h: HistoryRow): void;
  /** A conversation closed in this app: its read-only chat, by the id its terminal knew. */
  openClosed?(r: TermRow): void;
  /** Show more (+10) in the group. */
  showMore?(key: string): void;
  /** All history: Sessions ▸ History. */
  allHistory?(): void;
}

/** The sidebar's counts: terminals running, those waiting on you, and those ended (Clear ended). */
export interface TermCounts { open: number; needs: number; ended: number }

/** Each group's icon, in the table form the compat scanner reads. */
const GROUP_ICONS: { id: string; icon: string }[] = [
  { id: "workspace", icon: "folder" },
  { id: "scratch", icon: "flask-conical" },
  { id: "other", icon: "folder-open" },
];

/**
 * The Code sidebar's list (spec 2026-10-08-term-agent-deck T1; code-chat C6): a search, then one group per place (each
 * workspace and Scratch, and Other folders; the newest activity first), each open terminal a status glyph, its title and
 * "Host · status · age", then the conversations closed here and past ones, which open read-only. Open rows keep the
 * panel's tab hooks (aos-term-tab, aos-term-tab-active, data-session) so the rest of the app and its tests find the
 * selected terminal the same way in the deck and in the Pulse strip.
 */
export class TermList {
  private filterEl: HTMLInputElement;
  private scopeEl: HTMLElement;
  private groupsEl: HTMLElement;
  private footEl: HTMLElement;
  private filter = "";
  private now = Date.now();
  private last: { groups: SidebarGroup[]; active: string | null; counts: TermCounts; activePast: string | null } = { groups: [], active: null, counts: { open: 0, needs: 0, ended: 0 }, activePast: null };

  constructor(parent: HTMLElement, private actions: TermListActions, private onFilter: (q: string) => void) {
    const search = parent.createEl("label", { cls: "aos-tl-search" });
    const icon = search.createSpan({ cls: "aos-tl-searchicon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "search");
    this.filterEl = search.createEl("input", { cls: "aos-tl-filter", attr: { type: "text", placeholder: "Search sessions", "aria-label": "Search sessions", spellcheck: "false" } });
    this.filterEl.addEventListener("input", () => { this.filter = this.filterEl.value; this.onFilter(this.filter); });
    this.scopeEl = parent.createDiv({ cls: "aos-tl-scope" });
    this.groupsEl = parent.createDiv({ cls: "aos-tl-groups", attr: { role: "listbox", "aria-label": "Sessions", "data-tour": "code-list" } });
    this.footEl = parent.createDiv({ cls: "aos-tl-foot" });
  }

  query(): string { return this.filter; }

  /** `scope`: the workspace the list is scoped to (reveal), which a bar above the groups names with Show all. */
  render(groups: SidebarGroup[], active: string | null, counts: TermCounts, scope: { label: string } | null = null, activePast: string | null = null): void {
    this.last = { groups, active, counts, activePast };
    this.now = Date.now();
    this.renderScope(scope);
    this.groupsEl.empty();
    for (const g of groups) {
      const head = this.groupsEl.createDiv({ cls: `aos-tl-group is-${g.place?.kind ?? "other"}`, attr: { "data-group": g.key } });
      const icon = head.createSpan({ cls: "aos-tl-groupicon" });
      setIcon(icon, GROUP_ICONS.find((x) => x.id === (g.place?.kind ?? "other"))?.icon ?? "folder");
      head.createSpan({ cls: "aos-tl-grouplabel", text: g.label, attr: { ...(g.place ? { title: g.place.dir } : {}) } });
      // A workspace's group links back to it in Spaces (spaces-redesign D12); Scratch and Other folders are not
      // workspaces there.
      const ws = g.place?.kind === "workspace" ? g.place.workspace : undefined;
      if (ws && this.actions.openWorkspace) {
        const open = head.createEl("button", {
          cls: "aos-tl-plus aos-tl-openws",
          attr: { type: "button", "data-workspace": ws, "aria-label": `Open workspace ${g.label} in Spaces`, title: "Open workspace" },
        });
        setIcon(open, "arrow-up-right");
        open.addEventListener("click", () => this.actions.openWorkspace?.(ws));
      }
      // Other folders has no place of its own: its + starts in the vault.
      const where = g.place ? g.label : "the vault";
      const plus = head.createEl("button", { cls: "aos-tl-plus", attr: { type: "button", "aria-label": `New terminal in ${where}`, title: `New terminal in ${where}` } });
      setIcon(plus, "plus");
      plus.addEventListener("click", () => this.actions.startIn(g));
      if (!g.rows.length) this.groupsEl.createDiv({ cls: "aos-tl-empty", text: `No terminal in ${g.label} yet: + starts one.` });
      for (const r of g.rows) {
        if (r.kind === "past") this.pastRow(r.history);
        else if (r.closed) this.closedRow(r);
        else this.openRow(r);
      }
      if (g.more > 0 && this.actions.showMore) {
        const more = this.groupsEl.createEl("button", { cls: "aos-tl-more", text: "Show more", attr: { type: "button", "data-group": g.key, title: `${g.more} older` } });
        more.addEventListener("click", () => this.actions.showMore?.(g.key));
      }
    }
    if (!groups.length) this.groupsEl.createDiv({ cls: "aos-tl-empty", text: this.filter ? "No session matches." : "No sessions yet." });
    this.renderFoot();
  }

  private openRow(r: Extract<SidebarRow, { kind: "open" }>): void {
    const row = r.row;
    const on = row.id === this.last.active && !this.last.activePast;
    const el = this.groupsEl.createDiv({
      cls: `aos-tl-row aos-term-tab${on ? " aos-term-tab-active is-active" : ""}${row.end !== "running" ? " aos-term-tab-exited" : ""}`,
      attr: { role: "option", "aria-selected": String(on), tabindex: "0", "data-session": row.id, "data-host": row.host, title: `${row.title} · in ${row.place.dir}` },
    });
    el.createSpan({ cls: `aos-tl-glyph is-${row.host === "shell" ? "shell" : r.status.status}`, attr: { "aria-hidden": "true" } });
    const text = el.createSpan({ cls: "aos-tl-text" });
    text.createSpan({ cls: "aos-term-tab-label", text: row.title });
    // An ended row says how it ended once, in its end mark (✓ Done, Exited n), not again in this line.
    const sub = row.host === "shell" ? `Shell · ${row.place.label}`
      : row.endText ? `${TERM_HOST_LABEL[row.host]} · ${ageText(this.now, row.startedAt)}`
      : `${TERM_HOST_LABEL[row.host]} · ${r.status.text} · ${ageText(this.now, row.startedAt)}`;
    text.createSpan({ cls: `aos-tl-sub${r.status.status === "needs" ? " is-needs" : ""}`, text: sub });
    if (row.origin) text.createSpan({ cls: "aos-tl-origin", text: `from ${row.origin}` });
    const m = this.actions.mark?.(row.id);
    if (m?.waiting) el.createSpan({ cls: "aos-tl-waiting", text: "waiting", attr: { title: "Waiting for your answer in the Computer pane" } });
    if (m?.dot) {
      const why = m.waiting ? "Asking in the Computer pane" : "Working in the Computer pane, off-screen";
      el.createSpan({ cls: `aos-tl-cdot${m.waiting ? " is-waiting" : ""}`, attr: { role: "img", "aria-label": why, title: why } });
    }
    if (row.endText) el.createSpan({ cls: `aos-tl-end is-${row.end}`, text: row.end === "done" ? `✓ ${row.endText}` : row.endText });
    const close = el.createEl("button", { cls: "aos-tl-close", text: "×", attr: { type: "button", "aria-label": `Close ${row.title}`, title: "Close (⇧⌘W)" } });
    close.addEventListener("click", (e) => { e.stopPropagation(); this.actions.close(row.id); });
    el.addEventListener("click", () => this.actions.select(row.id));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.actions.select(row.id); } });
  }

  /** A conversation closed in this app: not a terminal any more, so it opens read-only like a past one. */
  private closedRow(r: Extract<SidebarRow, { kind: "open" }>): void {
    const row = r.row;
    const key = `closed:${row.host}:${row.sessionId ?? row.id}`;
    const el = this.pastEl(key, row.title, `${row.title} · in ${row.place.dir}`, `${TERM_HOST_LABEL[row.host]} · Closed · ${ageText(this.now, row.startedAt)}`);
    el.addClass("is-closed");
    this.activate(el, () => this.actions.openClosed?.(row));
  }

  private pastRow(h: HistoryRow): void {
    const where = h.where ? ` · ${h.where}` : "";
    const last = h.lastAt ?? h.at;
    const el = this.pastEl(h.key, h.title, `${h.title}${where}`, `${h.hostLabel} · ${last ? ageText(this.now, Date.parse(last)) : "undated"}`);
    el.setAttr("data-host", h.host);
    this.activate(el, () => this.actions.openPast?.(h));
  }

  private pastEl(key: string, title: string, hover: string, sub: string): HTMLElement {
    const on = key === this.last.activePast;
    const el = this.groupsEl.createDiv({
      cls: `aos-tl-past${on ? " is-active" : ""}`,
      attr: { role: "option", "aria-selected": String(on), tabindex: "0", "data-history": key, title: hover },
    });
    el.createSpan({ cls: "aos-tl-glyph is-past", attr: { "aria-hidden": "true" } });
    const text = el.createSpan({ cls: "aos-tl-text" });
    text.createSpan({ cls: "aos-tl-title", text: title });
    text.createSpan({ cls: "aos-tl-sub", text: sub });
    return el;
  }

  private activate(el: HTMLElement, fn: () => void): void {
    el.addEventListener("click", fn);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
  }

  /** "Showing <workspace> only · Show all" while another tab scoped the list (spaces-redesign D12). */
  private renderScope(scope: { label: string } | null): void {
    this.scopeEl.empty();
    this.scopeEl.toggleClass("is-on", !!scope);
    if (!scope) return;
    this.scopeEl.createSpan({ cls: "aos-tl-scopetext", text: `Showing ${scope.label} only` });
    const all = this.scopeEl.createEl("button", { cls: "aos-tl-clear aos-tl-scopeall", text: "Show all", attr: { type: "button" } });
    all.addEventListener("click", () => this.actions.clearScope?.());
  }

  private renderFoot(): void {
    this.footEl.empty();
    const c = this.last.counts;
    const count = this.footEl.createSpan({ cls: "aos-tl-count" });
    count.appendText(`${c.open} open · `);
    count.createSpan({ cls: `aos-tl-needs${c.needs ? " is-on" : ""}`, text: `${c.needs} need you` });
    if (c.ended) {
      const b = this.footEl.createEl("button", { cls: "aos-tl-clear", text: "Clear ended", attr: { type: "button", title: `${c.ended} ended` } });
      b.addEventListener("click", () => this.actions.clearEnded());
    }
    if (this.actions.allHistory) {
      const all = this.footEl.createEl("button", { cls: "aos-tl-allhistory", text: "All history", attr: { type: "button", title: "Sessions ▸ History: every past Claude Code and Codex session" } });
      all.addEventListener("click", () => this.actions.allHistory?.());
    }
  }
}
