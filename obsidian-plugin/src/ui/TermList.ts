import { setIcon } from "obsidian";
import type { TermGroup } from "../data/termGroups";

export interface TermListActions {
  select(id: string): void;
  close(id: string): void;
  /** The group header's +: start the host ⌘T starts in that group's place. */
  startIn(group: TermGroup): void;
  clearEnded(): void;
  /** A workspace group's Open workspace: Spaces, with that workspace selected (spaces-redesign D12). Select only. */
  openWorkspace?(name: string): void;
  /** Show every group again after the list was scoped to one workspace (reveal). */
  clearScope?(): void;
}

/** Each group's icon, in the table form the compat scanner reads. */
const GROUP_ICONS: { id: string; icon: string }[] = [
  { id: "workspace", icon: "folder" },
  { id: "scratch", icon: "flask-conical" },
  { id: "vault", icon: "book-open" },
  { id: "home", icon: "house" },
  { id: "other", icon: "folder-open" },
];

/**
 * The Term deck's list (spec 2026-10-08-term-agent-deck T1): a filter, then one group per place (each workspace and
 * Scratch, newest launch first; then the vault, home and other folders), each row a host dot, the program's title, where
 * it came from, and how it ended. Rows keep the panel's tab hooks (aos-term-tab, aos-term-tab-active, data-session) so
 * the rest of the app and its tests find the selected terminal the same way in the deck and in the Pulse strip.
 */
export class TermList {
  private filterEl: HTMLInputElement;
  private scopeEl: HTMLElement;
  private groupsEl: HTMLElement;
  private footEl: HTMLElement;
  private filter = "";
  private last: { groups: TermGroup[]; active: string | null; open: number } = { groups: [], active: null, open: 0 };

  constructor(parent: HTMLElement, private actions: TermListActions, private onFilter: (q: string) => void) {
    this.filterEl = parent.createEl("input", { cls: "aos-tl-filter", attr: { type: "text", placeholder: "Filter terminals", "aria-label": "Filter terminals", spellcheck: "false" } });
    this.filterEl.addEventListener("input", () => { this.filter = this.filterEl.value; this.onFilter(this.filter); });
    this.scopeEl = parent.createDiv({ cls: "aos-tl-scope" });
    this.groupsEl = parent.createDiv({ cls: "aos-tl-groups", attr: { role: "listbox", "aria-label": "Terminals", "data-tour": "code-list" } });
    this.footEl = parent.createDiv({ cls: "aos-tl-foot" });
  }

  query(): string { return this.filter; }

  /** `scope`: the workspace the list is scoped to (reveal), which a bar above the groups names with Show all. */
  render(groups: TermGroup[], active: string | null, open: number, scope: { label: string } | null = null): void {
    this.last = { groups, active, open };
    this.renderScope(scope);
    this.groupsEl.empty();
    for (const g of groups) {
      const head = this.groupsEl.createDiv({ cls: `aos-tl-group is-${g.kind}`, attr: { "data-group": g.key } });
      const icon = head.createSpan({ cls: "aos-tl-groupicon" });
      setIcon(icon, GROUP_ICONS.find((x) => x.id === g.kind)?.icon ?? "folder");
      head.createSpan({ cls: "aos-tl-grouplabel", text: g.label, attr: { title: g.place.dir } });
      // A workspace's group links back to it in Spaces (spaces-redesign D12); Scratch, the vault and other folders are
      // not workspaces there.
      const ws = g.kind === "workspace" ? g.place.workspace : undefined;
      if (ws && this.actions.openWorkspace) {
        const open = head.createEl("button", {
          cls: "aos-tl-plus aos-tl-openws",
          attr: { type: "button", "data-workspace": ws, "aria-label": `Open workspace ${g.label} in Spaces`, title: "Open workspace" },
        });
        setIcon(open, "arrow-up-right");
        open.addEventListener("click", () => this.actions.openWorkspace?.(ws));
      }
      const plus = head.createEl("button", { cls: "aos-tl-plus", attr: { type: "button", "aria-label": `New terminal in ${g.label}`, title: `New terminal in ${g.label}` } });
      setIcon(plus, "plus");
      plus.addEventListener("click", () => this.actions.startIn(g));
      if (!g.rows.length) this.groupsEl.createDiv({ cls: "aos-tl-empty", text: `No terminal in ${g.label} yet: + starts one.` });
      for (const r of g.rows) {
        const on = r.id === active;
        const row = this.groupsEl.createDiv({
          cls: `aos-tl-row aos-term-tab${on ? " aos-term-tab-active is-active" : ""}${r.end !== "running" ? " aos-term-tab-exited" : ""}`,
          attr: { role: "option", "aria-selected": String(on), tabindex: "0", "data-session": r.id, "data-host": r.host, title: `${r.title} · in ${r.place.dir}` },
        });
        row.createSpan({ cls: `aos-term-dot is-${r.host}`, attr: { "aria-hidden": "true" } });
        const text = row.createSpan({ cls: "aos-tl-text" });
        text.createSpan({ cls: "aos-term-tab-label", text: r.title });
        if (r.origin) text.createSpan({ cls: "aos-tl-origin", text: `from ${r.origin}` });
        if (r.endText) row.createSpan({ cls: `aos-tl-end is-${r.end}`, text: r.end === "done" ? `✓ ${r.endText}` : r.endText });
        const close = row.createEl("button", { cls: "aos-tl-close", text: "×", attr: { type: "button", "aria-label": `Close ${r.title}`, title: "Close (⇧⌘W)" } });
        close.addEventListener("click", (e) => { e.stopPropagation(); this.actions.close(r.id); });
        row.addEventListener("click", () => this.actions.select(r.id));
        row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.actions.select(r.id); } });
      }
    }
    if (!groups.length) this.groupsEl.createDiv({ cls: "aos-tl-empty", text: this.filter ? "No terminal matches." : "No terminals yet." });
    this.renderFoot();
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
    const ended = this.last.groups.reduce((n, g) => n + g.rows.filter((r) => r.end !== "running").length, 0);
    this.footEl.createSpan({ cls: "aos-tl-count", text: `${this.last.open} open${ended ? ` · ${ended} ended` : ""}` });
    if (ended) {
      const b = this.footEl.createEl("button", { cls: "aos-tl-clear", text: "Clear ended", attr: { type: "button" } });
      b.addEventListener("click", () => this.actions.clearEnded());
    }
  }
}
