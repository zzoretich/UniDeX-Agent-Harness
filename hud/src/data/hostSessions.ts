// hostSessions.ts — formatting for the per-workspace session counts the runtime's
// collectors/hostSessions.js attaches to the snapshot (workspace hub spec D5), and since spaces-redesign the rows built
// on them: a workspace's recent sessions (D25, History and the pick-up card's *last*) and the outside list with its
// Vanished group and git (D21). Pure, so node:test can load it.
import type { HostSessionsOutside, WorkspaceSessionRow, WorkspaceSessions } from "./snapshot";
import { env } from "../host";

export function agoLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const d = Math.floor((now - t) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`;
}

/** The days the counts cover, or null for a snapshot written before they had a window (all-time counts). */
function windowOf(s: Pick<WorkspaceSessions, "windowDays">): number | null {
  const n = s.windowDays;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

const validIso = (iso: string | null | undefined): iso is string => !!iso && !Number.isNaN(Date.parse(iso));

/**
 * "claude 12 · codex 3 · 2d ago", omitting a host with no sessions. Since spaces-redesign D34 the counts cover the last
 * `windowDays` days on both hosts, so a workspace whose sessions are all older reads "none in 30d · 45d ago" rather
 * than losing its chip. Null when there were none at all.
 */
export function sessionsChip(s: WorkspaceSessions | undefined | null, now: number = Date.now()): string | null {
  if (!s) return null;
  const parts: string[] = [];
  if (s.claude) parts.push(`claude ${s.claude}`);
  if (s.codex) parts.push(`codex ${s.codex}`);
  if (!parts.length) {
    const days = windowOf(s);
    if (days === null || !validIso(s.lastAt)) return null;
    parts.push(`none in ${days}d`);
  }
  parts.push(agoLabel(s.lastAt, now));
  return parts.join(" · ");
}

/** The title of a workspace's session counts (D34): the window they cover and both hosts' numbers; null without a
 *  window (an older snapshot's all-time counts) or a chip. Spaces' list row puts it on its host counts. */
export function sessionsTitle(s: WorkspaceSessions | undefined | null, now: number = Date.now()): string | null {
  const days = s ? windowOf(s) : null;
  if (!s || days === null || sessionsChip(s, now) === null) return null;
  const newest = validIso(s.lastAt) ? `; the newest ${agoLabel(s.lastAt, now)}` : "";
  return `Sessions in the last ${days} days, both hosts: Claude Code ${s.claude || 0}, Codex ${s.codex || 0}${newest}`;
}

export function shortenCwd(cwd: string, home: string = env.homedir()): string {
  if (home && (cwd === home || cwd.startsWith(home + "/"))) return "~" + cwd.slice(home.length);
  return cwd;
}

/**
 * A short age for lists: "now", "40m", "9h", "3d", "12d", "3w", "4mo", "2y"; "" for no or a bad time
 * (spaces-redesign D4: a row's last-active age).
 */
export function shortAge(iso: string | null | undefined, now: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const min = Math.max(0, Math.floor((now - t) / 60000));
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 63) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

// ── a workspace's recent sessions (spaces-redesign D25, D10, D6) ──

export const SESSION_HOST_LABEL: Record<WorkspaceSessionRow["host"], string> = { claude: "Claude Code", codex: "Codex" };

/** How a session came to count for the workspace (D20), in words for a tooltip. */
export const VIA_TEXT: Record<WorkspaceSessionRow["via"], string> = {
  app: "A Sessions thread in this workspace",
  team: "A team seat working on this workspace's board item",
  cwd: "Started in this workspace or its code folder",
  worktree: "Started in a worktree of this workspace's repository",
  files: "Started at the vault root; most of the files it touched are here",
};

/** One History row for a session (D10): the host dot, the title, its age and kind, and whether Resume is offered. */
export interface RecentRow {
  id: string;
  host: WorkspaceSessionRow["host"];
  hostLabel: string;
  kind: WorkspaceSessionRow["kind"];
  /** The session's title, or "Untitled session". */
  title: string;
  titleSource: WorkspaceSessionRow["titleSource"];
  /** When it was last active (else when it started). */
  at: string | null;
  age: string;
  /** "claude · 40m", with "· headless", "· team seat" or "· Sessions" for those kinds. */
  meta: string;
  via: WorkspaceSessionRow["via"];
  viaText: string;
  resumable: boolean;
  reason: string | null;
  /** A Sessions thread's id (via app). */
  thread: string | null;
  /** The start folder, ~-shortened, and whether it still exists. */
  cwd: string | null;
  cwdLabel: string | null;
  startExists: boolean;
}

const KIND_NOTE: Record<WorkspaceSessionRow["kind"], string> = { interactive: "", headless: " · headless", team: " · team seat", app: " · Sessions" };

const rowAt = (r: Pick<WorkspaceSessionRow, "lastAt" | "startedAt">): string | null => r.lastAt ?? r.startedAt ?? null;
const msOf = (iso: string | null): number => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? -Infinity : t; };

function validRow(r: unknown): r is WorkspaceSessionRow {
  const x = r as WorkspaceSessionRow;
  return !!x && typeof x.id === "string" && !!x.id && (x.host === "claude" || x.host === "codex");
}

/** The workspace's recent sessions, newest first, as History lists them; rows the page cannot read are left out. */
export function recentRows(s: WorkspaceSessions | null | undefined, now: number = Date.now(), home: string = env.homedir()): RecentRow[] {
  const rows = (Array.isArray(s?.recent) ? s!.recent : []).filter(validRow);
  return rows
    .map((r): RecentRow => {
      const at = rowAt(r);
      const age = shortAge(at, now);
      return {
        id: r.id, host: r.host, hostLabel: SESSION_HOST_LABEL[r.host], kind: r.kind,
        title: (r.title ?? "").trim() || "Untitled session", titleSource: r.titleSource ?? null,
        at, age, meta: `${r.host}${age ? ` · ${age}` : ""}${KIND_NOTE[r.kind] ?? ""}`,
        via: r.via, viaText: VIA_TEXT[r.via] ?? "", resumable: r.resumable === true, reason: r.reason ?? null,
        thread: typeof r.thread === "string" && r.thread ? r.thread : null,
        cwd: r.cwd ?? null, cwdLabel: r.cwd ? shortenCwd(r.cwd, home) : null, startExists: r.startExists !== false,
      };
    })
    .sort((a, b) => msOf(b.at) - msOf(a.at));
}

/**
 * The pick-up card's *last* (D6, Mechanics › PR 2): the newest row of kind interactive or app; team and headless runs
 * show only in History. Null when there is none.
 */
export function lastThread(s: WorkspaceSessions | null | undefined): WorkspaceSessionRow | null {
  let best: WorkspaceSessionRow | null = null;
  for (const r of (Array.isArray(s?.recent) ? s!.recent : []).filter(validRow)) {
    if (r.kind !== "interactive" && r.kind !== "app") continue;
    if (!best || msOf(rowAt(r)) > msOf(rowAt(best))) best = r;
  }
  return best;
}

// ── the outside list (spaces-redesign D21; the PR 2 stand-in opens it in the centre pane) ──

/** One folder outside every workspace: where, whether it still exists, sessions per host, last active, match, git. */
export interface OutsideListRow {
  cwd: string;
  label: string;
  exists: boolean;
  claude: number;
  codex: number;
  total: number;
  lastAt: string | null;
  age: string;
  /** The counts chip, as the old footer showed it: "claude 2 · today", "none in 30d · 45d ago". */
  chip: string;
  /** A workspace whose name is the folder's (compared as slugs): "Adopt into <name>" in PR 3. */
  match: string | null;
  /** "git · main", "git · main · 2 worktrees", or null when the folder is not in a repository (or the snapshot predates it). */
  git: string | null;
  gitRoot: string | null;
  worktrees: number;
}

/** The outside list split as the centre pane shows it: folders that exist, then a "Vanished (n)" group. */
export interface OutsideGroups {
  present: OutsideListRow[];
  vanished: OutsideListRow[];
  /** Every row, for the footer's "Outside workspaces (n)". */
  total: number;
  /** Existing folders whose name matches a workspace (PR 3's "n to adopt" badge). */
  matched: number;
}

/** "git · main · 2 worktrees" for an outside row, or null (spaces-redesign D21). */
export function outsideGitLabel(o: Pick<HostSessionsOutside, "git" | "worktrees">): string | null {
  if (!o.git) return null;
  const n = typeof o.worktrees === "number" && o.worktrees > 0 ? o.worktrees : 0;
  return `git · ${o.git.branch ?? "detached"}${n ? ` · ${n} worktree${n === 1 ? "" : "s"}` : ""}`;
}

export function outsideGroups(list: HostSessionsOutside[] | undefined | null, now: number = Date.now(), home: string = env.homedir(), windowDays?: number | null): OutsideGroups {
  const present: OutsideListRow[] = [];
  const vanished: OutsideListRow[] = [];
  for (const o of list ?? []) {
    if (!o || typeof o.cwd !== "string" || !o.cwd) continue;
    const row: OutsideListRow = {
      cwd: o.cwd, label: shortenCwd(o.cwd, home), exists: o.exists !== false,
      claude: o.claude || 0, codex: o.codex || 0, total: o.total || 0, lastAt: o.lastAt ?? null, age: shortAge(o.lastAt, now),
      chip: sessionsChip({ claude: o.claude, codex: o.codex, total: o.total, lastAt: o.lastAt, windowDays: windowDays ?? undefined }, now) ?? agoLabel(o.lastAt, now),
      match: typeof o.match === "string" && o.match ? o.match : null,
      git: outsideGitLabel(o), gitRoot: o.git?.root ? shortenCwd(o.git.root, home) : null,
      worktrees: typeof o.worktrees === "number" && o.worktrees > 0 ? o.worktrees : 0,
    };
    (row.exists ? present : vanished).push(row);
  }
  return { present, vanished, total: present.length + vanished.length, matched: present.filter((r) => r.match).length };
}
