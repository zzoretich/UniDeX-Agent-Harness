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
  /** An agent whose chat is not followed (the Code chat surface off, refused, not yet started): nothing says whether a
   *  turn runs, so its row reads Running rather than Idle (M1). Absent is false. */
  noChat?: boolean;
}

/** What rowInput reads of a pool terminal (TerminalSession). */
export interface RowSession {
  id: string;
  meta: { host: TermHost; origin: string | null; startedAt: number; sessionId: string | null };
  getTitle(): string;
  isExited: boolean;
  exitCode: number | null;
  agentEnded: boolean;
}
/** What rowInput reads of its chat (CodeFeeds' feed), or null for none. */
export interface RowFeed { follow: "pending" | "on" | "off" | "failed"; state: { sessionId: string | null; turnOpen: boolean } }

/**
 * A terminal's sidebar row from what the pool and its chat know, the one source the chat and the chips read too (code-chat
 * C6): its conversation is the chat's (which follows a /clear, and is the only id a new Codex terminal has), else the one
 * its launch named; no turn is open once its agent ended and the login shell runs (R39); an agent whose chat is not
 * followed reads Running.
 */
export function rowInput(s: RowSession, place: Place, feed: RowFeed | null): TermRowInput {
  const agent = s.meta.host !== "shell";
  return {
    id: s.id, host: s.meta.host, title: s.getTitle(), place, origin: s.meta.origin, startedAt: s.meta.startedAt,
    exited: s.isExited, exitCode: s.exitCode, sessionId: feed?.state.sessionId ?? s.meta.sessionId ?? null,
    // Task 12 reads "Needs you" from the screen and sets needsYou here.
    turnOpen: agent && !s.agentEnded && (feed?.state.turnOpen ?? false), needsYou: false,
    noChat: agent && feed?.follow !== "on",
  };
}

export type RowEnd = "running" | "done" | "failed";

export interface TermRow extends TermRowInput { end: RowEnd; endText: string | null }

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

/** The next or previous row in list order (⇧⌘] / ⇧⌘[), wrapping; null with no rows. */
export function stepRow(ids: string[], current: string | null, dir: 1 | -1): string | null {
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
 * A past conversation's activity is when it last moved (the index's lastAt), else its start. A conversation an open
 * terminal is in, or a closed one the index already lists, shows once. The filter matches the title, the host, the place
 * and what started a terminal or where a past one ran.
 */
export function groupSidebar(open: TermRowInput[], history: HistoryRow[], o: SidebarOptions): SidebarGroup[] {
  const q = o.filter.trim().toLowerCase();
  const per = o.perGroup ?? 10;
  const windowMs = (o.windowDays ?? 14) * DAY_MS;
  const hit = (...fields: Array<string | null | undefined>): boolean => !q || fields.filter(Boolean).join("\n").toLowerCase().includes(q);

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
    if (!hit(r.title, r.host, TERM_HOST_LABEL[r.host], r.place.label, r.origin)) continue;
    const known = rowStatus({ exited: r.exited, exitCode: r.exitCode, turnOpen: !!r.turnOpen, printing: false, needsYou: !!r.needsYou });
    const status: SidebarStatus = r.noChat && known.status === "idle" ? { status: "idle", text: "Running" } : known;
    add(r.place, r.startedAt, true, { kind: "open", row: { ...r, ...rowEnd(r) }, status });
  }
  for (const r of o.closed) {
    if (r.sessionId && (indexed.has(convoKey(r.host, r.sessionId)) || taken.has(convoKey(r.host, r.sessionId)))) continue;
    if (!hit(r.title, r.host, TERM_HOST_LABEL[r.host], r.place.label, r.origin)) continue;
    add(r.place, r.startedAt, false, { kind: "open", closed: true, row: { ...r, ...rowEnd(r) }, status: { status: "exited", text: "Closed" } });
  }
  for (const h of history) {
    const at = stamp(h.lastAt ?? h.at);
    if (o.now - at > windowMs || taken.has(convoKey(h.host, h.id))) continue;
    if (!hit(h.title, h.host, h.hostLabel, h.place.label, h.where)) continue;
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
