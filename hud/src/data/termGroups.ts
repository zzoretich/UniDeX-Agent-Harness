// termGroups.ts — the Term deck's list (spec 2026-10-08-term-agent-deck T1). Pure: terminals grouped by where they run,
// each group in order of the last launch there (as Sessions orders its workspaces), with the vault, home and other
// folders last; each row's end state; the filter; and the scope another tab opens Code with (spaces-redesign D12).
import { TERM_HOST_LABEL } from "./terminalLaunch";
import type { Place, TermHost } from "./terminalLaunch";
import type { HistoryRow } from "./sessionHistory";
import { rowStatus } from "./codeChat";

export interface TermRowInput {
  id: string;
  host: TermHost;
  title: string;
  place: Place;
  origin: string | null;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  /** The conversation the terminal is in, when it knows it (C6: the index lists it once the app's row is not needed). */
  sessionId?: string | null;
  /** The chat's open turn and the TUI's wait for you (rowStatus); absent is false. */
  turnOpen?: boolean;
  needsYou?: boolean;
}

export type RowEnd = "running" | "done" | "failed";

export interface TermRow extends TermRowInput { end: RowEnd; endText: string | null }
export interface TermGroup { key: string; label: string; kind: Place["kind"]; place: Place; rows: TermRow[] }

/** A place's group key: a workspace's name (Scratch included), the vault, home, or the folder itself. */
export function groupKey(p: Place): string {
  if (p.workspace) return `ws:${p.workspace}`;
  if (p.kind === "vault" || p.kind === "home") return p.kind;
  return `dir:${p.dir}`;
}

/**
 * Code scoped to one place (spaces-redesign D12): `reveal({workspace})` from Spaces shows only that workspace's group,
 * matched by its key and never by text (a filter for "site" would also match "site-repo"). `place` is the workspace's
 * own place, which the group's + starts in.
 */
export interface TermScope { key: string; label: string; place: Place }

export function scopeOf(place: Place): TermScope { return { key: groupKey(place), label: place.label, place }; }

/** How a row ended: still running, Done (exit 0), or Exited n. */
export function rowEnd(r: Pick<TermRowInput, "exited" | "exitCode">): { end: RowEnd; endText: string | null } {
  if (!r.exited) return { end: "running", endText: null };
  return r.exitCode ? { end: "failed", endText: `Exited ${r.exitCode}` } : { end: "done", endText: "Done" };
}

const LAST: Record<string, number> = { vault: 1, home: 2, other: 3 };

/**
 * The groups: workspaces and Scratch by their newest launch, then the vault, home and other folders; rows newest first.
 * With a scope, only its group: empty (so its + and Open workspace still show) when nothing runs there yet and no
 * filter is typed.
 */
export function groupTerminals(rows: TermRowInput[], filter = "", scope: TermScope | null = null): TermGroup[] {
  const q = filter.trim().toLowerCase();
  const by = new Map<string, TermGroup>();
  for (const r of rows) {
    const key = groupKey(r.place);
    if (scope && key !== scope.key) continue;
    if (q && !`${r.title}\n${r.place.label}\n${r.origin ?? ""}`.toLowerCase().includes(q)) continue;
    const place = scope ? scope.place : r.place;
    const g = by.get(key) ?? { key, label: place.label, kind: place.kind, place, rows: [] };
    g.rows.push({ ...r, ...rowEnd(r) });
    by.set(key, g);
  }
  if (scope && !by.size && !q) by.set(scope.key, { key: scope.key, label: scope.label, kind: scope.place.kind, place: scope.place, rows: [] });
  const newest = (g: TermGroup) => Math.max(...g.rows.map((r) => r.startedAt));
  for (const g of by.values()) g.rows.sort((a, b) => b.startedAt - a.startedAt);
  return [...by.values()].sort((a, b) => {
    const la = LAST[a.kind] ?? 0;
    const lb = LAST[b.kind] ?? 0;
    return la !== lb ? la - lb : newest(b) - newest(a);
  });
}

/** The next or previous row in list order (⇧⌘] / ⇧⌘[), wrapping; null with no rows. */
export function stepRow(groups: TermGroup[] | string[], current: string | null, dir: 1 | -1): string | null {
  const ids = (groups as Array<TermGroup | string>).flatMap((g) => (typeof g === "string" ? [g] : g.rows.map((r) => r.id)));
  if (!ids.length) return null;
  const i = current ? ids.indexOf(current) : -1;
  return ids[(i + dir + ids.length) % ids.length] ?? ids[0];
}

// ── the Code sidebar (spec 2026-11-09-code-chat C6) ──

export type SidebarStatus = ReturnType<typeof rowStatus>;
export type SidebarRow =
  /** A terminal of this app; `closed`: it was closed here and the index does not list its conversation yet. */
  | { kind: "open"; row: TermRow; status: SidebarStatus; closed?: boolean }
  | { kind: "past"; history: HistoryRow };
/** `place` is null for Other folders (the vault, home and every other folder). */
export interface SidebarGroup { key: string; label: string; place: Place | null; rows: SidebarRow[]; more: number }

export const OTHER_KEY = "other";
export const OTHER_LABEL = "Other folders";
const DAY_MS = 86_400_000;

const convoKey = (host: string, id: string): string => `${host}:${id.toLowerCase()}`;
const stamp = (iso: string | null): number => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? 0 : t; };

/** How long ago, in one unit: now, 5m, 3h, 2d. */
export function ageText(now: number, then: number): string {
  const d = Math.max(0, now - then);
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < DAY_MS) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / DAY_MS)}d`;
}

export interface SidebarOptions {
  now: number;
  filter: string;
  /** Conversations closed in this app (newest activity = their start), kept until `history` has their id. */
  closed: TermRowInput[];
  /** Past conversations count when they are at most this many days old (default 14). */
  windowDays?: number;
  /** Past (and closed) rows a group shows before Show more (default 10). */
  perGroup?: number;
  /** Rows Show more added, by group key. */
  extra?: Record<string, number>;
}

/**
 * The Code sidebar's groups: where each conversation runs. A group is shown when a terminal of this app is open there or a
 * past conversation is within the window; workspaces and Scratch keep their own group, the vault, home and every other
 * folder share "Other folders". Groups are ordered by their newest activity; a group lists its open terminals first (they
 * never count against the cut), then the closed and past conversations newest first, `perGroup` of them and `more` left.
 * A conversation an open terminal is in, or a closed one the index already lists, shows once. The filter matches title and
 * host.
 */
export function groupSidebar(open: TermRowInput[], history: HistoryRow[], o: SidebarOptions): SidebarGroup[] {
  const q = o.filter.trim().toLowerCase();
  const per = o.perGroup ?? 10;
  const windowMs = (o.windowDays ?? 14) * DAY_MS;
  const hit = (title: string, host: string, hostLabel: string): boolean => !q || `${title}\n${host}\n${hostLabel}`.toLowerCase().includes(q);

  const taken = new Set<string>();
  for (const r of open) if (r.sessionId) taken.add(convoKey(r.host, r.sessionId));
  const indexed = new Set(history.map((h) => convoKey(h.host, h.id)));

  type Item = { at: number; live: boolean; row: SidebarRow };
  const by = new Map<string, { place: Place | null; label: string; items: Item[]; newest: number }>();
  const add = (place: Place, at: number, live: boolean, row: SidebarRow): void => {
    const key = groupKey(place);
    const k = place.kind === "workspace" || place.kind === "scratch" ? key : OTHER_KEY;
    let g = by.get(k);
    if (!g) { g = { place: k === OTHER_KEY ? null : place, label: k === OTHER_KEY ? OTHER_LABEL : place.label, items: [], newest: 0 }; by.set(k, g); }
    g.items.push({ at, live, row });
    if (at > g.newest) g.newest = at;
  };

  for (const r of open) {
    if (!hit(r.title, r.host, TERM_HOST_LABEL[r.host])) continue;
    const status = rowStatus({ exited: r.exited, exitCode: r.exitCode, turnOpen: !!r.turnOpen, printing: false, needsYou: !!r.needsYou });
    add(r.place, r.startedAt, true, { kind: "open", row: { ...r, ...rowEnd(r) }, status });
  }
  for (const r of o.closed) {
    if (r.sessionId && indexed.has(convoKey(r.host, r.sessionId))) continue;
    if (!hit(r.title, r.host, TERM_HOST_LABEL[r.host])) continue;
    add(r.place, r.startedAt, false, { kind: "open", closed: true, row: { ...r, ...rowEnd(r) }, status: { status: "exited", text: "Closed" } });
  }
  for (const h of history) {
    const at = stamp(h.at);
    if (o.now - at > windowMs || taken.has(convoKey(h.host, h.id))) continue;
    if (!hit(h.title, h.host, h.hostLabel)) continue;
    add(h.place, at, false, { kind: "past", history: h });
  }

  const out: SidebarGroup[] = [];
  for (const [key, g] of by) {
    const live = g.items.filter((i) => i.live).sort((a, b) => b.at - a.at);
    const rest = g.items.filter((i) => !i.live).sort((a, b) => b.at - a.at);
    const shown = per + (o.extra?.[key] ?? 0);
    out.push({ key, label: g.label, place: g.place, rows: [...live, ...rest.slice(0, shown)].map((i) => i.row), more: Math.max(0, rest.length - shown) });
  }
  const newest = (g: SidebarGroup): number => by.get(g.key)?.newest ?? 0;
  return out.sort((a, b) => newest(b) - newest(a) || (a.key < b.key ? -1 : 1));
}

/** The ids of the sidebar's open terminals in list order (⇧⌘] / ⇧⌘[ step through them). */
export function sidebarOrder(groups: SidebarGroup[]): string[] {
  return groups.flatMap((g) => g.rows.flatMap((r) => (r.kind === "open" && !r.closed ? [r.row.id] : [])));
}
