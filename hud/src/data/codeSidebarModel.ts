// The Code tab's sidebar model (spec 2026-11-09-code-chat C6): the groups the list shows (the terminals, the conversations
// closed in this app and the past ones), the scope another tab opened Code on, and the facts rows and the top bar read of a
// terminal (its place, its conversation, its model). It touches no DOM; TerminalPanel owns the list and tells the model
// the one thing it needs of it, the filter text.

import type AgenticOSPlugin from "../../main";
import type { TerminalSession } from "./terminalSession";
import { HistoryCache } from "./historyCache";
import { groupSidebar, rowInput, sidebarOrder, statusInput, type SidebarGroup, type TermRow, type TermRowInput, type TermScope } from "./termGroups";
import { rowStatus } from "./codeChat";
import { placeOf, type Place, type PlaceWorld } from "./terminalLaunch";

export interface SidebarModelHost {
  /** What the list's filter box holds now ("" with no list). */
  filter(): string;
  /** The past conversations changed (the index was read): redraw the list. */
  changed(): void;
}

export class CodeSidebarModel {
  /** The groups as last built. */
  groups: SidebarGroup[] = [];
  /** The "Show more" counts by group. */
  extra: Record<string, number> = {};
  /** The workspace another tab opened Code on (reveal): the deck lists only its group until Show all or a launch
   *  elsewhere (spaces-redesign D12). */
  scope: TermScope | null = null;
  /** The past conversations (the index, digests). */
  private hist: HistoryCache | null = null;
  private lastInputs = new Map<string, TermRowInput>();
  private worldCache: { at: number; w: PlaceWorld } | null = null;

  constructor(private plugin: AgenticOSPlugin, private host: SidebarModelHost) {}

  /** The deck mounted: the past conversations start loading. */
  start(): void {
    this.hist = new HistoryCache({ vault: () => this.plugin.vaultRoot(), hosts: () => ({ choices: this.plugin.termLauncher.choices(), world: this.world() }) }, () => this.host.changed());
  }

  dispose(): void {
    this.hist?.dispose();
    this.hist = null;
    this.lastInputs.clear();
  }

  /** The past conversations are looked up again; `force` skips the two-second floor. */
  refreshHistory(force?: boolean): void { this.hist?.refresh(force); }

  /** The workspaces and links, read at most every two seconds: rows without a recorded place need them. */
  world(): PlaceWorld {
    const now = Date.now();
    if (!this.worldCache || now - this.worldCache.at > 2000) this.worldCache = { at: now, w: this.plugin.termLauncher.world() };
    return this.worldCache.w;
  }

  /** A link changed: the next read of the world is a fresh one. */
  forgetWorld(): void { this.worldCache = null; }

  placeOfSession(s: TerminalSession): Place { return s.meta.place ?? placeOf(s.cwd, this.world()); }

  /** Each terminal's row (rowInput): its conversation and turn as its chat has them, the source the chat and chips read. */
  private rowInputs(): TermRowInput[] {
    const feeds = this.plugin.codeFeeds;
    return this.plugin.terminalPool.list().map((s) => rowInput(s, this.placeOfSession(s), feeds?.get(s.id) ?? null));
  }

  /** The terminal's conversation: its chat's (a /clear, a new Codex thread), else the one its launch named. */
  conversationOf(s: TerminalSession): string | null {
    return this.plugin.codeFeeds?.get(s.id)?.state.sessionId ?? s.meta.sessionId ?? null;
  }

  /** The conversation's newest model (the cache's), else the launch's. */
  modelOf(s: TerminalSession): string | null {
    return this.plugin.codeFeeds?.get(s.id)?.state.model ?? s.meta.model ?? null;
  }

  /** What the rows show of each chat: its status word (from the open turn, and Needs you and printing from its screen,
   *  code-chat C10), whether it is followed, and its conversation (which hides its History row). */
  rowsSig(): string {
    const feeds = this.plugin.codeFeeds;
    if (!feeds) return "";
    return this.plugin.terminalPool.list().map((s) => {
      const f = feeds.get(s.id);
      return f ? `${s.id}:${f.follow}:${rowStatus(statusInput(s, f)).status}:${this.conversationOf(s) ?? ""}` : s.id;
    }).join(",");
  }

  /** The sidebar's groups now: the terminals, and (with the Code chat on) the conversations closed here and past ones. */
  build(): SidebarGroup[] {
    const inputs = this.rowInputs();
    this.lastInputs = new Map(inputs.map((r) => [r.id, r]));
    const on = this.plugin.codeFeeds?.on() ?? false;
    const filter = this.host.filter();
    const groups = groupSidebar(inputs, on ? this.hist?.rows() ?? [] : [], { now: Date.now(), filter, closed: on ? this.plugin.codeFeeds?.closedConvs.list() ?? [] : [], extra: this.extra });
    const scope = this.scope;
    if (!scope) return groups;
    const only = groups.filter((g) => g.key === scope.key);
    // A scoped workspace with nothing running keeps its group, so its + and Open workspace still show.
    if (!only.length && !filter.trim()) only.push({ key: scope.key, label: scope.label, place: scope.place, rows: [], more: 0 });
    return only;
  }

  /** The groups, rebuilt and kept (what the list draws). */
  rebuild(): SidebarGroup[] {
    this.groups = this.build();
    return this.groups;
  }

  /** The terminals in the list, in order (past and closed conversations are not terminals). */
  openRows(): TermRow[] {
    return this.groups.flatMap((g) => g.rows.flatMap((r) => (r.kind === "open" && !r.closed ? [r.row] : [])));
  }

  /** The ids of the terminals in list order (⇧⌘] / ⇧⌘[). */
  order(): string[] { return sidebarOrder(this.groups.length ? this.groups : this.build()); }

  /** The list's header counts. */
  counts(): { open: number; needs: number; ended: number } {
    const open = this.openRows();
    return {
      open: open.filter((r) => r.end === "running").length,
      needs: this.groups.reduce((n, g) => n + g.rows.filter((r) => r.kind === "open" && !r.closed && r.status.status === "needs").length, 0),
      ended: open.filter((r) => r.end !== "running").length,
    };
  }

  /** A terminal closed here keeps a row (when it knew its conversation) until the index lists that conversation (C6). */
  rememberClosed(id: string): void {
    const r = this.lastInputs.get(id);
    this.lastInputs.delete(id);
    if (r) this.plugin.codeFeeds?.closedConvs.add(r);
  }
}
