// spacesModel.ts — the Spaces tab's model (spec 2026-10-09-spaces-redesign, PR 2 and PR 3). Pure: snapshot entries, the
// HUD's live terminals and threads, the host choices, and the to-dos, proposals and memory notes in; the rows the panes
// draw out. The list's groups, filter and hidden rule (D4, D22), the live dot (D26), the row and its git (D4, D24),
// Resume's target and folder (D7, D31, D32), the pick-up card (D6), Overview (D8), History (D10) and Linked (D27); PR 3:
// the page's `aos workspace` verbs as argv and their answers (D28, D29), what a move's confirmation names (D17), and
// Link to-dos…'s suggestions (D35). The panes under views/spaces/ render these; nothing here reads a file, spawns or
// writes.
import * as path from "path";
import type { AosJsonResult } from "./aosRun";
import type { Proposal } from "./proposals";
import type { MemoryMeta } from "./memories";
import type { Todo } from "./todos";
import type {
  Snapshot, WorkspaceEntry, WorkspaceGit, WorkspaceSessionRow, WorkspaceSessions,
} from "./snapshot";
import { TERM_HOST_LABEL, slugify, workspacePlace } from "./terminalLaunch";
import type { Place, PlaceWorld, TermHostChoice } from "./terminalLaunch";
import { lastThread, recentRows, shortAge, shortenCwd } from "./hostSessions";
import type { RecentRow } from "./hostSessions";
import { describeDisabledReason } from "./workspaceMaps";
import { THREAD_ID_RE } from "./statusline";

// ── the build checks behind Resume (spaces-redesign D7, A1) ──

/**
 * spaces-redesign D7 (A1), the build check run at the start of PR 2: on 2026-10-10 with Claude Code 2.1.296,
 * `claude --resume <id>` run from a workspace folder loaded a thread that had started at the vault root (a four-day-old
 * interactive vault-root session resumed from workspaces/<x>; a random id said "not found"). So a Claude row resumes in
 * the workspace's place like a Codex row, and the start-folder fallback below stays off. Should a later Claude Code
 * stop finding threads across folders, set `works` to false: a Claude row then resumes in its start folder
 * (`recent[].cwd`) with the hint "Resumes at ~/… where it started", or is disabled with "Started in ~/…, which no
 * longer exists" when `startExists` is false, and PR 3's Rename warns about Claude threads.
 */
export const CLAUDE_RESUME_CROSS_FOLDER = Object.freeze({
  works: true,
  checked: "2026-10-10",
  version: "Claude Code 2.1.296",
});

// D7 for Codex (`codex resume -C <cwd> <id>`, checked against codex-cli 0.162.0) is CODEX_RESUME_CD in terminalLaunch.ts,
// beside launchArgs, the one source of what a terminal types.

// ── status (D11, D19) ──

/** The five words a row shows: the scan's three and workspace.md's paused and done. */
export type SpaceStatus = "active" | "stalled" | "idle" | "paused" | "done";
export type StatusTone = "ok" | "warn" | "off" | "info";

const STATUS_RANK: Record<SpaceStatus, number> = { active: 0, stalled: 1, idle: 2, paused: 3, done: 4 };
const STATUS_ALIASES: Record<string, SpaceStatus> = {
  active: "active", stalled: "stalled", idle: "idle", paused: "paused", done: "done",
  // workspace.md's other words, as the runtime's statusOverride reads them, and the words of snapshots before D11
  shipped: "done", complete: "done", blocked: "paused", parked: "paused", "on hold": "paused",
};

/** An entry's status word; anything the page does not know (an older snapshot's planned or dormant) reads idle. */
export function statusWord(e: Pick<WorkspaceEntry, "status">): SpaceStatus {
  const v = String(e.status ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return STATUS_ALIASES[v] ?? "idle";
}

/** The status pill and dot (D5, D19): "active · auto" when the scan decided it, the bare word for an override. */
export interface StatusPill {
  word: SpaceStatus;
  auto: boolean;
  text: string;
  tone: StatusTone;
  /** A hollow dot (idle, paused) rather than a filled one; every dot also carries `text` as its label. */
  hollow: boolean;
}

const STATUS_TONE: Record<SpaceStatus, { tone: StatusTone; hollow: boolean }> = {
  active: { tone: "ok", hollow: false },
  stalled: { tone: "warn", hollow: false },
  idle: { tone: "off", hollow: true },
  paused: { tone: "warn", hollow: true },
  done: { tone: "info", hollow: false },
};

export function statusPill(e: Pick<WorkspaceEntry, "status" | "statusOverride" | "statusSource">): StatusPill {
  const word = statusWord(e);
  const auto = !e.statusOverride && e.statusSource !== "manifest";
  return { word, auto, text: auto ? `${word} · auto` : word, ...STATUS_TONE[word] };
}

// ── the list: groups, filter, hidden rule (D4, D22) ──

export type SpaceGroupKey = "pinned" | "active" | "stalled" | "idle" | "hidden";
export const SPACE_GROUP_ORDER: readonly SpaceGroupKey[] = ["pinned", "active", "stalled", "idle", "hidden"];
export const SPACE_GROUP_LABEL: Record<SpaceGroupKey, string> = {
  pinned: "PINNED", active: "ACTIVE", stalled: "STALLED", idle: "IDLE", hidden: "ARCHIVED AND _ FOLDERS",
};

export interface SpaceGroup {
  key: SpaceGroupKey;
  label: string;
  entries: WorkspaceEntry[];
  /** Whether the group starts folded: IDLE and the hidden group, unless a filter is typed (D4). */
  collapsed: boolean;
}

export interface SpaceList {
  groups: SpaceGroup[];
  /** `_` and archived entries, for "Show archived and _ folders (n)"; counted whatever the filter. */
  hiddenCount: number;
  /** Entries in the groups. */
  shown: number;
  /** Visible entries before the filter: the tab's count. */
  total: number;
}

/** The group an entry falls in: pinned first, then by status; paused, done and unknown words in IDLE; hidden apart. */
export function groupOf(e: WorkspaceEntry): SpaceGroupKey {
  if (e.hidden) return "hidden";
  if (e.pinned) return "pinned";
  const w = statusWord(e);
  return w === "active" || w === "stalled" ? w : "idle";
}

/** When the entry last moved: its activity (D11), else its newest session or last event. */
export function activityAt(e: Pick<WorkspaceEntry, "activity" | "sessions" | "lastEvent">): string | null {
  return e.activity?.at ?? e.sessions?.lastAt ?? e.lastEvent?.iso ?? null;
}

const msOf = (iso: string | null | undefined): number => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? -Infinity : t; };

/** The runtime's order (collectors/workspaces.js compareEntries) inside a group: status, newest activity, name. */
function compareInGroup(a: WorkspaceEntry, b: WorkspaceEntry): number {
  return (STATUS_RANK[statusWord(a)] - STATUS_RANK[statusWord(b)])
    || (msOf(activityAt(b)) - msOf(activityAt(a)) || 0)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** The branch the filter matches, for a workspace with its own repo or a linked code folder's (D24). */
export function branchOf(e: Pick<WorkspaceEntry, "git">): string | null {
  return e.git && e.git.kind === "repo" ? e.git.branch : null;
}

/** "Filter by name, branch, next step": every word typed must appear in one of them, case-insensitive. */
export function matchesQuery(e: WorkspaceEntry, query: string): boolean {
  const words = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [e.name, e.label ?? "", branchOf(e) ?? "", e.next?.text ?? ""].join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * The list (D4): PINNED, ACTIVE, STALLED, IDLE, each in the runtime's order, empty groups left out; `_` and archived
 * entries (D22) only when `showHidden`, in a group of their own at the end. `query` filters every group.
 */
export function spaceList(entries: WorkspaceEntry[] | null | undefined, opts: { query?: string; showHidden?: boolean } = {}): SpaceList {
  const all = (entries ?? []).filter((e): e is WorkspaceEntry => !!e && typeof e.name === "string" && !!e.name);
  const query = opts.query ?? "";
  const hiddenCount = all.filter((e) => e.hidden).length;
  const total = all.length - hiddenCount;
  const by = new Map<SpaceGroupKey, WorkspaceEntry[]>();
  for (const e of all) {
    if (e.hidden && !opts.showHidden) continue;
    if (!matchesQuery(e, query)) continue;
    const k = groupOf(e);
    (by.get(k) ?? by.set(k, []).get(k)!).push(e);
  }
  const typed = !!query.trim();
  const groups: SpaceGroup[] = [];
  for (const key of SPACE_GROUP_ORDER) {
    const list = by.get(key);
    if (!list || !list.length) continue;
    groups.push({ key, label: SPACE_GROUP_LABEL[key], entries: [...list].sort(compareInGroup), collapsed: !typed && (key === "idle" || key === "hidden") });
  }
  return { groups, hiddenCount, shown: groups.reduce((n, g) => n + g.entries.length, 0), total };
}

export function hiddenToggleText(n: number): string {
  return `Show archived and _ folders (${n})`;
}

// ── live (D26) ──

/** What the HUD sees running in a workspace now: Code terminals placed there and Sessions threads mid-turn. */
export interface LiveState { terminals: number; threads: number; total: number; title: string }

export interface LiveThreadInput { workspace: string; running: boolean }
export interface LiveTerminalInput { place: Pick<Place, "workspace">; exited: boolean }

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The live dot per workspace name (D26): Code terminals whose place names the workspace and have not exited, and
 * Sessions threads whose turn is running. A CLI session started outside the app is not seen; its row shows its age.
 */
export function liveByWorkspace(threads: LiveThreadInput[] | null | undefined, terminals: LiveTerminalInput[] | null | undefined): Map<string, LiveState> {
  const out = new Map<string, LiveState>();
  const bump = (name: string | undefined, key: "terminals" | "threads") => {
    if (!name) return;
    const s = out.get(name) ?? { terminals: 0, threads: 0, total: 0, title: "" };
    s[key]++;
    s.total++;
    out.set(name, s);
  };
  for (const t of terminals ?? []) if (t && !t.exited) bump(t.place?.workspace, "terminals");
  for (const t of threads ?? []) if (t && t.running) bump(t.workspace, "threads");
  for (const s of out.values()) {
    s.title = `Live: ${[s.terminals ? `${plural(s.terminals, "terminal")} in Code` : "", s.threads ? `${plural(s.threads, "running thread")} in Sessions` : ""].filter(Boolean).join(", ")}`;
  }
  return out;
}

// ── git (D24) ──

/** The list row's git (D4): "main ✓", "main · 2 changed", "main · no remote", "tracked by the vault", "no git". */
export interface GitBrief {
  kind: "repo" | "vault" | "none";
  text: string;
  /** Colour only for state (D19): dirty warn, no remote off. */
  tone: "warn" | "off" | null;
  dirty: number;
  noRemote: boolean;
}

export function gitBrief(git: WorkspaceGit | null | undefined): GitBrief {
  if (!git) return { kind: "none", text: "no git", tone: null, dirty: 0, noRemote: false };
  if (git.kind === "vault") return { kind: "vault", text: "tracked by the vault", tone: null, dirty: 0, noRemote: false };
  const dirty = Math.max(0, git.dirty || 0);
  const noRemote = !(git.remotes ?? []).length;
  const branch = git.branch ?? (git.head ? `detached ${git.head}` : "detached");
  const parts = [dirty ? `${branch} · ${dirty} changed` : `${branch} ✓`];
  if (noRemote) parts.push("no remote");
  return { kind: "repo", text: parts.join(" · "), tone: dirty ? "warn" : noRemote ? "off" : null, dirty, noRemote };
}

/** A part of the meta line's git, with its own tone (D19: only "n changed" is warn and "no remote" off). */
export interface GitPart { text: string; tone: "warn" | "off" | null }

/**
 * The dossier's meta line git part (D5, D24) as parts: "main", "clean" or "2 changed" (warn), the short hash, "↑1 ↓2",
 * "no remote" (off); "tracked by the vault" for a vault-tracked folder (the pane adds "· Link code folder…"); null
 * without git. The pane joins them with " · " and colours only the parts that carry a state.
 */
export function gitMetaParts(git: WorkspaceGit | null | undefined): GitPart[] | null {
  if (!git) return null;
  if (git.kind === "vault") return [{ text: "tracked by the vault", tone: null }];
  const parts: GitPart[] = [{ text: git.branch ?? "detached", tone: null }, git.dirty ? { text: `${git.dirty} changed`, tone: "warn" } : { text: "clean", tone: null }];
  if (git.head) parts.push({ text: git.head, tone: null });
  const ab = [git.ahead ? `↑${git.ahead}` : "", git.behind ? `↓${git.behind}` : ""].filter(Boolean).join(" ");
  if (ab) parts.push({ text: ab, tone: null });
  if (!(git.remotes ?? []).length) parts.push({ text: "no remote", tone: "off" });
  return parts;
}

/** The meta line's git as one line: "main · clean · 7fda846", "main · 2 changed · ↑1 ↓2 · no remote". */
export function gitMeta(git: WorkspaceGit | null | undefined): string | null {
  const parts = gitMetaParts(git);
  return parts ? parts.map((p) => p.text).join(" · ") : null;
}

// ── the list row (D4) ──

/** The to-do and proposal counts a row shows (from `linkedFor`); zero is left out. */
export interface LinkedCounts { todos: number; proposals: number }

export interface SpaceRow {
  name: string;
  label: string;
  status: StatusPill;
  /** Last-active age, "40m", "12d"; stalled rows tint it (D19). */
  age: string;
  ageTone: "warn" | null;
  git: GitBrief;
  /** Hosts with sessions in the window, Claude Code first, and "claude 6 · codex 2". */
  hosts: Array<{ host: "claude" | "codex"; count: number }>;
  hostsText: string;
  live: LiveState | null;
  /** The next step, else the handoff's Now line, else empty (D4). */
  line: string;
  lineKind: "next" | "now" | "none";
  todos: number;
  proposals: number;
  pinned: boolean;
  hidden: boolean;
}

export function hostCounts(s: WorkspaceSessions | null | undefined): Array<{ host: "claude" | "codex"; count: number }> {
  const out: Array<{ host: "claude" | "codex"; count: number }> = [];
  if (s?.claude) out.push({ host: "claude", count: s.claude });
  if (s?.codex) out.push({ host: "codex", count: s.codex });
  return out;
}

export function spaceRow(e: WorkspaceEntry, o: { live?: Map<string, LiveState> | null; counts?: LinkedCounts | null; now?: number } = {}): SpaceRow {
  const status = statusPill(e);
  const hosts = hostCounts(e.sessions);
  const next = e.next?.text?.trim() || "";
  const handNow = e.handoff?.now?.trim() || "";
  return {
    name: e.name, label: e.label || e.name, status,
    age: shortAge(activityAt(e), o.now ?? Date.now()), ageTone: status.word === "stalled" ? "warn" : null,
    git: gitBrief(e.git), hosts, hostsText: hosts.map((h) => `${h.host} ${h.count}`).join(" · "),
    live: o.live?.get(e.name) ?? null,
    line: next ? `Next: ${next}` : handNow ? `Now: ${handNow}` : "", lineKind: next ? "next" : handNow ? "now" : "none",
    todos: o.counts?.todos ?? 0, proposals: o.counts?.proposals ?? 0, pinned: !!e.pinned, hidden: !!e.hidden,
  };
}

// ── Resume (D7, D31, D32) ──

/** What a Resume button names: a session of a workspace, looked up again in the current snapshot. */
export interface ResumeRef { workspace: string; id: string }

export type ResumeTarget =
  /** Type the resume line into a Code terminal at `place` (its group stays `ws:<name>`, D26). */
  | { kind: "terminal"; disabled: false; host: "claude" | "codex"; id: string; cwd: string; place: Place; hint: string; startFolder: boolean }
  /** A Sessions thread: open it there (spec §4's table). */
  | { kind: "sessions"; disabled: false; workspace: string; thread: string; hint: string }
  | { kind: "disabled"; disabled: true; reason: string };

export interface ResumeContext {
  /** Where workspaces and their linked code folders are (TerminalLauncher.world()). */
  world: PlaceWorld;
  /** Whether the Sessions tab is shown (a model provider is set up): a Sessions thread opens there (D32). Default true. */
  sessionsAvailable?: boolean;
  /** D7's build check; tests flip it. Default `CLAUDE_RESUME_CROSS_FOLDER.works`. */
  claudeCrossFolder?: boolean;
}

export const SESSIONS_OFF_TEXT = "Sessions is hidden: set up a model provider to use it";
export const CLI_THREAD_TEXT = "Started in a terminal: resume it in Code";

const off = (reason: string): ResumeTarget => ({ kind: "disabled", disabled: true, reason });

/** "<Host> is off on this machine: run aos hosts add <h>" (D31; install-import B2: it keeps the other host). */
export function hostOffText(host: "claude" | "codex"): string {
  return `${TERM_HOST_LABEL[host]} is off on this machine: run aos hosts add ${host}`;
}

/** The entry by name in the current snapshot, hidden ones included (an archived workspace keeps its rows). */
export function entryByName(snapshot: Pick<Snapshot, "workspaces"> | null | undefined, name: string): WorkspaceEntry | null {
  return (snapshot?.workspaces ?? []).find((w) => w && w.name === name) ?? null;
}

/**
 * Whether and where Resume reopens a session (D7, D31, D32). The id must be in this workspace's `recent` in the current
 * snapshot; a Sessions thread opens in Sessions; otherwise it must be a lowercase UUID, `resumable` (each `false`
 * carries the runtime's reason), and its host on and logged in. The folder: the workspace's place, its linked code
 * folder when it has one, for both hosts (A1 found Claude resumes across folders; with that check off, a Claude row
 * resumes in its start folder, or is disabled when that folder is gone). The returned `place` keeps the workspace, so
 * the terminal's Code group is `ws:<name>` and the live dot holds even when `cwd` is a start folder.
 */
export function resumeTarget(ref: ResumeRef, snapshot: Pick<Snapshot, "workspaces"> | null | undefined, choices: TermHostChoice[], ctx: ResumeContext): ResumeTarget {
  const entry = ref && typeof ref.workspace === "string" ? entryByName(snapshot, ref.workspace) : null;
  if (!entry) return off("This workspace is not in the current scan");
  const row = (entry.sessions?.recent ?? []).find((r) => r && r.id === ref.id) ?? null;
  if (!row) return off("No longer among this workspace's recent sessions");
  if (row.kind === "app") {
    if (ctx.sessionsAvailable === false) return off(SESSIONS_OFF_TEXT);
    const thread = typeof row.thread === "string" ? row.thread : "";
    if (!THREAD_ID_RE.test(thread)) return off("This Sessions thread has no id the page can open");
    return { kind: "sessions", disabled: false, workspace: entry.name, thread, hint: "Opens in Sessions" };
  }
  // A host session id as the scan records it is a lowercase hex UUID (the ThreadId pattern), so it never reads as a flag.
  if (!THREAD_ID_RE.test(row.id)) return off("Not a session id that can be resumed");
  if (!row.resumable) return off(row.reason || "This session cannot be resumed");
  const host = row.host;
  if (host !== "claude" && host !== "codex") return off("Unknown host");
  const choice = choices.find((c) => c.host === host);
  if (!choice || choice.hidden) return off(hostOffText(host));
  if (!choice.ready) return off(choice.reason || `${TERM_HOST_LABEL[host]} is not ready`);

  const home = ctx.world.home;
  const base = workspacePlace(entry.name, ctx.world);
  const crossFolder = ctx.claudeCrossFolder ?? CLAUDE_RESUME_CROSS_FOLDER.works;
  if (host === "claude" && !crossFolder) {
    // Claude files a transcript under its start folder: without one recorded, no folder is known to find it from.
    if (!row.cwd) return off("No start folder recorded for this thread");
    const short = shortenCwd(row.cwd, home);
    if (row.startExists === false) return off(`Started in ${short}, which no longer exists`);
    const place: Place = path.resolve(row.cwd) === path.resolve(base.dir) ? base : { ...base, dir: row.cwd, linked: false };
    return { kind: "terminal", disabled: false, host, id: row.id, cwd: row.cwd, place, hint: `Resumes at ${short} where it started`, startFolder: true };
  }
  const where = base.linked ? `${shortenCwd(base.dir, home)}, its code folder` : `workspaces/${entry.name}`;
  // D7, amended 2026-10-10 by the user: a thread the scan credited through a worktree (workspaces/.worktrees/<ws>/<branch>,
  // <repo>.worktrees/<x>) resumes in that worktree while it still exists, so the agent stays on its branch; the place
  // keeps workspace=<name>, so Code still groups it under ws:<name>. A worktree that is gone, or not known to exist,
  // falls back to the workspace's place, and the hint says which.
  const fromWorktree = row.via === "worktree" && !!row.cwd && path.resolve(row.cwd) !== path.resolve(base.dir);
  if (fromWorktree && row.startExists === true) {
    const cwd = row.cwd as string;
    return { kind: "terminal", disabled: false, host, id: row.id, cwd, place: { ...base, dir: cwd, linked: false }, hint: `Resumes in ${shortenCwd(cwd, home)}, its worktree`, startFolder: true };
  }
  const why = !fromWorktree ? "" : row.startExists === false ? ", as its worktree is gone" : ", not the worktree it started in";
  return { kind: "terminal", disabled: false, host, id: row.id, cwd: base.dir, place: base, hint: `Resumes in ${where}${why}`, startFolder: false };
}

/** A row of Resume's split menu that starts a new session (D5, D31). */
export interface NewSessionRow { host: "claude" | "codex"; label: string; disabled: boolean; reason: string | null }

/**
 * The split menu's "New <Host> session" rows: only hosts that are on (a host that is off gets no row), a host that is
 * not logged in disabled with its reason (D31). Never hard-codes a host: it follows `TerminalLauncher.choices()`.
 */
export function newSessionRows(choices: TermHostChoice[]): NewSessionRow[] {
  return choices
    .filter((c): c is TermHostChoice & { host: "claude" | "codex" } => (c.host === "claude" || c.host === "codex") && !c.hidden)
    .map((c) => ({ host: c.host, label: `New ${c.label} session`, disabled: !c.ready, reason: c.ready ? null : c.reason ?? `${c.label} is not ready` }));
}

/** "Open last thread in Sessions" (D32): only for a Sessions thread, and only while Sessions is shown. */
export function sessionsLink(row: WorkspaceSessionRow | null | undefined, sessionsAvailable: boolean): { disabled: boolean; reason: string | null; thread: string | null } {
  if (!sessionsAvailable) return { disabled: true, reason: SESSIONS_OFF_TEXT, thread: null };
  if (!row) return { disabled: true, reason: "No session yet", thread: null };
  if (row.kind !== "app") return { disabled: true, reason: CLI_THREAD_TEXT, thread: null };
  // The same check resumeTarget makes on the field before it opens a thread.
  if (typeof row.thread !== "string" || !THREAD_ID_RE.test(row.thread)) return { disabled: true, reason: "This Sessions thread has no id the page can open", thread: null };
  return { disabled: false, reason: null, thread: row.thread };
}

// ── the pick-up card (D6) ──

export const PICKUP_EMPTY = {
  last: "No session yet: start one from Resume's menu",
  now: "No Now line in a handoff",
  next: "No next step in HANDOFF, STATUS or PLAN",
  // The row's own ↻ is the way to make one; the text names no glyph beside a button that is one.
  read: "No insight yet",
} as const;

/** The read's ↻ under provider `none`: it still regenerates, and the runtime writes a heuristic read
 *  (collectors/workspaceInsights.js heuristicInsight), as the scan does there. */
export const HEURISTIC_READ_TEXT = "No model provider is set up: ↻ writes a heuristic read";

export interface PickupRow {
  key: "last" | "now" | "next" | "read";
  /** The row's text, or null for its empty state. */
  text: string | null;
  empty: string;
  /** Where it came from: "from HANDOFF-x.md › Now", "from workspace.md", "qwen3.5:9b · 2h". */
  source: string | null;
}

export interface Pickup {
  last: PickupRow & { session: WorkspaceSessionRow | null; host: "claude" | "codex" | null; age: string; title: string | null; resume: ResumeRef | null };
  now: PickupRow;
  next: PickupRow;
  /** The insight in one line; `suggests` is its next step, shown as "suggests: …" (D23). ↻ stays on under `none`,
   *  where the runtime writes a heuristic read: `refreshNote` says so (null with a provider). */
  read: PickupRow & { suggests: string | null; refreshNote: string | null };
  /** The card header's source: the handoff's Now when there is one. */
  header: string | null;
}

/**
 * The pick-up rows (D6): *last* the newest interactive or Sessions row (team and headless runs show only in History),
 * *now* the handoff's Now line, *next* the next step with its source, *read* the insight with model and age.
 * `provider` is the resolved model provider's name (`readProviderState(vault)?.name ?? "none"`): under "none", or none
 * given, ↻ still regenerates the read, which the runtime then writes by its heuristic, and `refreshNote` says so (D33
 * turns off only the map's per-file ↻, where `none` has no fallback).
 */
export function pickupFor(e: WorkspaceEntry, o: { now?: number; provider?: string | null } = {}): Pickup {
  const now = o.now ?? Date.now();
  const s = lastThread(e.sessions);
  const sAge = s ? shortAge(s.lastAt ?? s.startedAt, now) : "";
  const title = s ? (s.title ?? "").trim() || "Untitled session" : null;
  const last = {
    key: "last" as const, text: s ? `${s.host}${sAge ? ` · ${sAge}` : ""} — “${title}”` : null, empty: PICKUP_EMPTY.last,
    source: s ? (s.kind === "app" ? "a Sessions thread" : null) : null,
    session: s, host: s?.host ?? null, age: sAge, title, resume: s ? { workspace: e.name, id: s.id } : null,
  };
  const h = e.handoff ?? null;
  const nowText = h?.now?.trim() || null;
  const nowRow: PickupRow = { key: "now", text: nowText, empty: PICKUP_EMPTY.now, source: nowText && h ? `from ${h.file} › Now` : null };
  const nextText = e.next?.text?.trim() || null;
  const nextFrom = e.next?.from ? `from ${e.next.from}` : e.next?.source === "manifest" ? "from workspace.md" : null;
  const nextRow: PickupRow = { key: "next", text: nextText, empty: PICKUP_EMPTY.next, source: nextText ? nextFrom : null };
  const ins = e.insight;
  const insText = ins && ins.status === "ok" && ins.text ? ins.text.trim() : null;
  const noProvider = describeDisabledReason(o.provider) !== null;
  const insAge = ins?.generatedAt ? shortAge(ins.generatedAt, now) : "";
  const read = {
    key: "read" as const, text: insText, empty: PICKUP_EMPTY.read,
    source: insText ? [ins?.model ?? "", insAge].filter(Boolean).join(" · ") || null : null,
    suggests: insText && ins?.next ? ins.next.trim() || null : null,
    refreshNote: noProvider ? HEURISTIC_READ_TEXT : null,
  };
  return { last, now: nowRow, next: nextRow, read, header: nowRow.source };
}

// ── Overview (D8) ──

export interface Overview {
  summary: { text: string | null; source: string | null; template: boolean };
  objectives: { items: Array<{ text: string; done: boolean }>; done: number; total: number; pct: number; label: string };
  docs: Array<{ name: string; path: string; note: string | null; age: string; done: boolean }>;
}

const SUMMARY_SOURCE: Record<string, string> = { manifest: "workspace.md", derived: "guessed from the folder", ai: "model guess" };

export function overviewFor(e: WorkspaceEntry, o: { now?: number } = {}): Overview {
  const now = o.now ?? Date.now();
  const items = (e.objectives ?? []).filter((x) => x && x.text).map((x) => ({ text: x.text, done: x.done === true }));
  const done = items.filter((x) => x.done).length;
  const total = items.length;
  const summary = e.summary?.trim() || null;
  return {
    summary: { text: summary, source: summary ? SUMMARY_SOURCE[e.summarySource] ?? null : null, template: e.summaryTemplate === true },
    objectives: { items, done, total, pct: total ? Math.round((done / total) * 100) : 0, label: total ? `${done} of ${total}` : "" },
    docs: (e.docs ?? []).filter((d) => d && d.name).map((d) => ({ name: d.name, path: d.path, note: d.note ?? null, age: shortAge(d.mtime, now), done: d.done === true })),
  };
}

// ── History (D10) ──

export type HistoryFilter = "all" | "sessions" | "commits";
export const HISTORY_FILTERS: readonly HistoryFilter[] = ["all", "sessions", "commits"];

export interface HistoryItem {
  kind: "session" | "commit";
  key: string;
  title: string;
  /** "claude · 40m", "7fda846 · 1h · code folder". */
  meta: string;
  at: string | null;
  host: "claude" | "codex" | null;
  session: RecentRow | null;
  /** What Resume names for a session row; `resumeTarget` decides whether it is on. */
  resume: ResumeRef | null;
  hash: string | null;
}

/** Sessions and commits newest first (D10); commits come from the workspace's repo or its linked code folder. */
export function historyFor(e: WorkspaceEntry, filter: HistoryFilter = "all", o: { now?: number; home?: string } = {}): HistoryItem[] {
  const now = o.now ?? Date.now();
  const out: HistoryItem[] = [];
  if (filter !== "commits") {
    for (const r of recentRows(e.sessions, now, o.home)) {
      out.push({ kind: "session", key: `s:${r.id}`, title: r.title, meta: r.meta, at: r.at, host: r.host, session: r, resume: { workspace: e.name, id: r.id }, hash: null });
    }
  }
  if (filter !== "sessions") {
    const where = e.repoPath && e.git?.kind === "repo" ? " · code folder" : "";
    (e.commits ?? []).forEach((c, i) => {
      if (!c || !c.subject) return;
      const age = shortAge(c.iso, now);
      out.push({ kind: "commit", key: `c:${c.hash ?? i}`, title: c.subject, meta: [c.hash ?? "", age].filter(Boolean).join(" · ") + where, at: c.iso, host: null, session: null, resume: null, hash: c.hash ?? null });
    });
  }
  return out.sort((a, b) => msOf(b.at) - msOf(a.at));
}

// ── Linked (D27) ──

export type LinkKind = "todo" | "proposal" | "memory";
/** How an item matched: a `#ws/` tag, a proposal's target or recheck, a note's `workspace:`, its slug, or a body mention. */
export type LinkHow = "tag" | "target" | "recheck" | "workspace" | "slug" | "mention";

export interface LinkedItem {
  kind: LinkKind;
  /** Stable within its kind: a to-do's raw line, a proposal's file name, a note's path. */
  key: string;
  text: string;
  how: LinkHow;
  /** The rule in words, shown on the row: "tagged #ws/site", "target names workspaces/site". */
  howText: string;
  /** The former name (from `aliases:`) it matched through, when it did. */
  former: string | null;
  /** "pending" for a proposal (every file in persona/proposals is). */
  tag: string | null;
  todo?: Todo;
  proposal?: Proposal;
  memory?: MemoryMeta;
}

export interface LinkedGroup {
  kind: LinkKind;
  label: string;
  items: LinkedItem[];
  count: number;
  /** The number beside the heading; null at zero (a zero count is hidden, D27). */
  countText: string | null;
}

export interface Linked {
  groups: LinkedGroup[];
  total: number;
  /** Nothing links here: "Nothing links to this space: no to-dos, proposals or memory notes name it." */
  empty: boolean;
}

export const LINKED_EMPTY_TEXT = "Nothing links to this space: no to-dos, proposals or memory notes name it.";
export const LINK_GROUP_LABEL: Record<LinkKind, string> = { todo: "To-do", proposal: "Proposal", memory: "Memory" };

export interface LinkedSources { todos?: Todo[] | null; proposals?: Proposal[] | null; memories?: MemoryMeta[] | null }

/** The name a workspace shows and links by: its label, so `_archive/<n>` links as <n>. */
function baseName(e: Pick<WorkspaceEntry, "name" | "label">): string {
  return (e.label || e.name.replace(/^_archive\//, "")).trim();
}

/** The workspace's `#ws/` slug (D27): its folder name as a slug. */
export function workspaceSlug(e: Pick<WorkspaceEntry, "name" | "label">): string {
  return slugify(baseName(e));
}

/**
 * Former names from `aliases:` (D17, D27): an alias that is a folder under the vault's workspaces/ (what Rename
 * records) gives its folder name; `_archive/<n>` gives <n>. Without `vault`, a folder whose parent is named
 * `workspaces` counts. Adopted folders outside the vault are not names (they still link by path, below).
 */
export function formerNames(e: Pick<WorkspaceEntry, "name" | "label" | "aliases">, vault?: string | null): string[] {
  const out: string[] = [];
  const self = baseName(e);
  for (const a of e.aliases ?? []) {
    if (typeof a !== "string" || !path.isAbsolute(a)) continue;
    let segs: string[] = [];
    if (vault) {
      const rel = path.relative(path.join(path.resolve(vault), "workspaces"), path.resolve(a));
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) segs = rel.split(path.sep);
    } else {
      const parts = path.resolve(a).split(path.sep);
      const i = parts.lastIndexOf("workspaces");
      if (i >= 0) segs = parts.slice(i + 1);
    }
    const n = segs[0] === "_archive" ? segs[1] : segs[0];
    if (!n || n.startsWith("_") || n.startsWith(".") || n === self || out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

/** Folders outside the vault recorded under `aliases:` (adopted, D16): matched by path in a proposal. */
function outsideAliases(e: Pick<WorkspaceEntry, "aliases">, vault?: string | null): string[] {
  const out: string[] = [];
  for (const a of e.aliases ?? []) {
    if (typeof a !== "string" || !path.isAbsolute(a)) continue;
    if (vault) {
      const rel = path.relative(path.resolve(vault), path.resolve(a));
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) continue;
    } else if (a.split("/").includes("workspaces")) continue;
    out.push(path.resolve(a));
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` names the folder path `p`: not glued to a longer word before it, and followed by its end, a `/`,
 * whitespace, a closing quote or bracket, punctuation, or a full stop that ends the sentence. So `workspaces/site`
 * matches "workspaces/site/PLAN.md" and "(workspaces/site)" but not "workspaces/site-repo".
 */
export function namesPath(text: string | null | undefined, p: string): boolean {
  if (!text || !p) return false;
  return new RegExp(`(?:^|[^\\w.-])${escapeRe(p)}(?=$|[/\\s"'\`),;:\\]>|]|\\.(?:$|\\s))`).test(text);
}

/**
 * What links to a workspace (D27), computed live: open to-dos tagged `#ws/<slug>`; proposals whose `workspace:` (PR 3)
 * names it, or whose `target` or `recheck` names the workspace's path; memory notes whose `workspace:` names it,
 * whose slug is its slug, or whose body mentions `workspaces/<name>/`. A former name from `aliases:` counts for every
 * rule, and an adopted folder's path for proposals. Each item says how it matched; a zero count shows no number.
 */
export function linkedFor(e: Pick<WorkspaceEntry, "name" | "label" | "aliases">, src: LinkedSources, opts: { vault?: string | null; home?: string | null } = {}): Linked {
  const self = baseName(e);
  const former = formerNames(e, opts.vault);
  const names = [self, ...former];
  const slugs = names.map((n) => slugify(n));
  const formerOf = (i: number): string | null => (i > 0 ? names[i] : null);
  const suffix = (f: string | null): string => (f ? ` (former name ${f})` : "");

  // To-do: the tag, exactly (case-insensitive); open items only.
  const todos: LinkedItem[] = [];
  for (const t of src.todos ?? []) {
    if (!t || t.done) continue;
    const tags = (t.tags ?? []).map((x) => x.toLowerCase());
    const i = slugs.findIndex((s) => !!s && tags.includes(`ws/${s}`));
    if (i < 0) continue;
    todos.push({ kind: "todo", key: t.raw, text: t.text || t.body, how: "tag", howText: `tagged #ws/${slugs[i]}${suffix(formerOf(i))}`, former: formerOf(i), tag: null, todo: t });
  }

  // Proposal: its `workspace:` (PR 3: /propose writes it, D27), then target, then recheck, naming workspaces/<name> or an
  // adopted folder (absolute or ~/).
  const home = opts.home ?? null;
  const paths: Array<{ p: string; shown: string; former: string | null }> = names.map((n, i) => ({ p: `workspaces/${n}`, shown: `workspaces/${n}`, former: formerOf(i) }));
  for (const a of outsideAliases(e, opts.vault)) {
    const shown = home ? shortenCwd(a, home) : a;
    paths.push({ p: a, shown, former: null });
    if (shown !== a) paths.push({ p: shown, shown, former: null });
  }
  const proposals: LinkedItem[] = [];
  for (const p of src.proposals ?? []) {
    if (!p) continue;
    const key = typeof p.workspace === "string" && p.workspace ? slugify(p.workspace) : "";
    const wi = key ? slugs.indexOf(key) : -1;
    if (wi >= 0 && slugs[wi]) {
      proposals.push({ kind: "proposal", key: p.name, text: p.slug, how: "workspace", howText: `workspace: ${p.workspace}${suffix(formerOf(wi))}`, former: formerOf(wi), tag: "pending", proposal: p });
      continue;
    }
    let hit: { how: "target" | "recheck"; at: (typeof paths)[number] } | null = null;
    for (const how of ["target", "recheck"] as const) {
      const at = paths.find((x) => namesPath(p[how], x.p));
      if (at) { hit = { how, at }; break; }
    }
    if (!hit) continue;
    proposals.push({ kind: "proposal", key: p.name, text: p.slug, how: hit.how, howText: `its ${hit.how} names ${hit.at.shown}${suffix(hit.at.former)}`, former: hit.at.former, tag: "pending", proposal: p });
  }

  // Memory: `workspace:`, then the slug, then a body mention.
  const memories: LinkedItem[] = [];
  for (const m of src.memories ?? []) {
    if (!m) continue;
    const ws = m.workspace ? slugify(m.workspace) : "";
    let i = ws ? slugs.indexOf(ws) : -1;
    let how: LinkHow | null = i >= 0 ? "workspace" : null;
    let howText = i >= 0 ? `workspace: ${m.workspace}` : "";
    if (!how) {
      i = slugs.indexOf(String(m.slug ?? "").toLowerCase());
      if (i >= 0 && slugs[i]) { how = "slug"; howText = `named ${m.slug}`; }
    }
    if (!how) {
      i = names.findIndex((n) => (m.mentions ?? []).includes(n));
      if (i >= 0) { how = "mention"; howText = `mentions workspaces/${names[i]}/`; }
    }
    if (!how || i < 0) continue;
    memories.push({ kind: "memory", key: m.path, text: m.title, how, howText: `${howText}${suffix(formerOf(i))}`, former: formerOf(i), tag: null, memory: m });
  }

  const group = (kind: LinkKind, items: LinkedItem[]): LinkedGroup =>
    ({ kind, label: LINK_GROUP_LABEL[kind], items, count: items.length, countText: items.length ? String(items.length) : null });
  const groups = [group("todo", todos), group("proposal", proposals), group("memory", memories)];
  const total = todos.length + proposals.length + memories.length;
  return { groups, total, empty: total === 0 };
}

/** The row's counts from a `linkedFor` result. */
export function linkedCounts(l: Linked): LinkedCounts {
  return { todos: l.groups.find((g) => g.kind === "todo")?.count ?? 0, proposals: l.groups.find((g) => g.kind === "proposal")?.count ?? 0 };
}

/**
 * The project notes whose `status/` tag Archive and Restore flip (spaces-redesign D17, §6): those Linked found by their
 * `workspace:` or their exact slug, never by a body mention. Only notes under brain/memory/projects/. As the runtime
 * flips them (cli/workspace.js flipProjectNotes): `holds` keeps the notes whose frontmatter carries the tag that flips
 * now (status/active for Archive, status/archived for Restore; noteHoldsStatus), and `only` keeps Restore to Archive's
 * record (`archivedNotes:`), so the confirmation names exactly the notes that change.
 */
export function flippingNotes(
  l: Linked | null | undefined,
  o: { holds?: (path: string) => boolean; only?: readonly string[] | null } = {},
): Array<{ title: string; path: string }> {
  const mem = l?.groups.find((g) => g.kind === "memory")?.items ?? [];
  return mem
    .filter((i) => (i.how === "workspace" || i.how === "slug") && i.memory && i.memory.path.startsWith("brain/memory/projects/"))
    .filter((i) => (!o.holds || o.holds(i.key)) && (!o.only || o.only.includes(i.key)))
    .map((i) => ({ title: i.text || i.key, path: i.key }));
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Whether a note's frontmatter carries `status/<word>` as a tag, by the runtime's rule (cli/workspace.js statusTag). */
export function noteHoldsStatus(text: string | null | undefined, word: "active" | "archived"): boolean {
  const m = typeof text === "string" ? FRONTMATTER_RE.exec(text) : null;
  if (!m) return false;
  const re = new RegExp(`(^|[\\s,\\[\\-'"])status/${word}(?=$|[\\s,\\]'"])`);
  return m[1].split(/\r?\n/).some((l) => re.test(l));
}

/**
 * A frontmatter list by key, as the runtime's listField reads it (`[a, b]`, a block list, or one value): Archive's
 * record in an archived workspace.md, `archivedNotes:` (the notes it flipped) and `archivedFrom:` (the name it came
 * from when it archived under a dated one). [] when the key is missing.
 */
export function manifestList(text: string | null | undefined, key: string): string[] {
  const m = typeof text === "string" ? FRONTMATTER_RE.exec(text) : null;
  if (!m) return [];
  const out: string[] = [];
  const unquote = (v: string): string => v.trim().replace(/^["']|["']$/g, "");
  let on = false;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const item = /^\s*-(?:\s+(.*))?$/.exec(raw);
    if (item && on) { const v = unquote(item[1] ?? ""); if (v) out.push(v); continue; }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    on = kv[1] === key;
    if (!on) continue;
    const value = kv[2].trim();
    const flow = /^\[(.*)\]$/.exec(value);
    for (const v of (flow ? flow[1].split(",") : value ? [value] : []).map(unquote)) if (v) out.push(v);
  }
  return out;
}

// ── Link to-dos… (D35) ──

/** + to-do and Link to-dos… write TODO.md through the To-Do surface: with its writes off, both are off with this. */
export const TODO_WRITES_OFF_TEXT = "Needs the To-Do surface's writes";

/** A to-do Link to-dos… offers: untagged, open, and naming the workspace. Only offered: nothing is tagged without a click. */
export interface TodoSuggestion {
  todo: Todo;
  /** The to-do's raw line: what the one-click edit names (todos.ts editTodo). */
  key: string;
  text: string;
  /** The words it matched, as the to-do wrote them. */
  matched: string;
  how: "name" | "slug" | "former";
  former: string | null;
}

/** A name as a pattern: its words joined by any run of spaces, `-` or `_`, case-insensitive. */
function namePattern(name: string): string | null {
  const words = name.toLowerCase().split(/[\s_-]+/).filter(Boolean).map(escapeRe);
  return words.length ? words.join("[\\s_-]+") : null;
}

/** Where `name` appears in `text` as a whole name: not glued to a letter, digit, `-` or `_` on either side. */
function findName(text: string, name: string): { at: number; len: number } | null {
  const p = namePattern(name);
  if (!p) return null;
  const m = new RegExp(`(?<![\\p{L}\\p{N}_-])${p}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, "iu").exec(text);
  return m ? { at: m.index, len: m[0].length } : null;
}

/** Where `workspaces/<name>` appears in `text` (a short name counts only so). */
function findPath(text: string, name: string): { at: number; len: number } | null {
  const m = new RegExp(`(?<![\\p{L}\\p{N}_.-])workspaces/${escapeRe(name)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, "iu").exec(text);
  return m ? { at: m.index, len: m[0].length } : null;
}

/**
 * Link to-dos…'s suggestions (D35): open to-dos with no `#ws/` tag at all whose text names the workspace, by its name,
 * its slug, or a former name from `aliases:` (D17), as whole words (`harbor map` names harbor-map; `site-repo` does not
 * name site). A name of one or two characters only counts as `workspaces/<name>`, so short names do not match every
 * to-do. `others` are the other workspaces' names: where a longer one of them is what the to-do names, it names that
 * one, not this. Pure: suggesting writes nothing (the click goes through the To-Do surface's writer).
 */
export function todoLinkSuggestions(todos: Todo[] | null | undefined, e: Pick<WorkspaceEntry, "name" | "label" | "aliases">, opts: { vault?: string | null; others?: string[] } = {}): TodoSuggestion[] {
  const self = baseName(e);
  const slug = slugify(self);
  const cands: Array<{ name: string; how: TodoSuggestion["how"]; former: string | null }> = [{ name: self, how: "name", former: null }];
  if (slug && slug !== self.toLowerCase()) cands.push({ name: slug, how: "slug", former: null });
  for (const f of formerNames(e, opts.vault)) cands.push({ name: f, how: "former", former: f });
  const selfKeys = new Set(cands.map((c) => slugify(c.name)));
  // Only another workspace whose name is longer than one of this one's and holds it ("site docs" around "site") can
  // own the mention; a shorter one ("site" inside "site docs") never hides this workspace's own name.
  const others = (opts.others ?? [])
    .map((n) => String(n ?? "").replace(/^_archive\//, "").trim())
    .filter((n) => n && !selfKeys.has(slugify(n)))
    .filter((n) => cands.some((c) => slugify(n).length > slugify(c.name).length && findName(n.replace(/[\s_-]+/g, " "), c.name) !== null));
  const out: TodoSuggestion[] = [];
  for (const t of todos ?? []) {
    if (!t || t.done) continue;
    if ((t.tags ?? []).some((x) => /^ws\//i.test(x))) continue;
    let text = String(t.text || t.body || "");
    // A longer workspace name that holds this one ("site docs" around "site") is that workspace's mention: blank it out.
    for (const o of others) {
      for (let hit = findName(text, o); hit; hit = findName(text, o)) text = text.slice(0, hit.at) + " ".repeat(hit.len) + text.slice(hit.at + hit.len);
    }
    for (const c of cands) {
      const hit = slugify(c.name).replace(/-/g, "").length < 3 ? findPath(text, c.name) : findName(text, c.name);
      if (!hit) continue;
      out.push({ todo: t, key: t.raw, text: t.text || t.body, matched: String(t.text || t.body || "").slice(hit.at, hit.at + hit.len), how: c.how, former: c.former });
      break;
    }
  }
  return out;
}

// ── the page's workspace verbs (D28, D29; the plan's Mechanics › PR 3 › Security) ──

/**
 * The argument kinds the spaces surface admits (app/src/shared/surfaces.ts KEBAB, WS, HASH, PATH; none starts with
 * `-`). The page builds a verb's argv only from values that pass them, so what the runtime refuses is a real refusal,
 * never a line the surface would not run; the runtime checks every name and path again (cli/workspace.js).
 */
export const KEBAB_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const WS_RE = /^[^\s\0._\/\\-][^\/\\\0\n\r\u2028\u2029]{0,127}$/;
export const HASH_RE = /^(?:none|[0-9a-f]{16,64})$/;
export const PATH_RE = /^(?:\/|~\/)[^\0\n\r\u2028\u2029]+$/;

export type ManifestStatus = "active" | "paused" | "done";
export const MANIFEST_STATUSES: readonly ManifestStatus[] = ["active", "paused", "done"];

/** The workspace.md keys `aos workspace set` writes (D18; the runtime's allow-list). `""` clears a key. */
export interface ManifestFields {
  status?: ManifestStatus | "";
  pinned?: boolean;
  summary?: string;
  objectives?: string[];
  next?: string;
  repo?: string;
}

function arg(re: RegExp, v: unknown, what: string): string {
  if (typeof v !== "string" || !re.test(v)) throw new Error(`Not ${what} Spaces can pass to aos: ${JSON.stringify(String(v ?? "").slice(0, 60))}`);
  return v;
}
const wsArg = (name: string): string => arg(WS_RE, name, "a workspace name");

/**
 * Each verb's argv in the one order the spaces surface admits (`--json` last; `new`'s flags in the order --git, --pin,
 * --empty). Throws on a value its argument kind refuses.
 */
export const workspaceArgs = {
  new(slug: string, o: { git?: boolean; pin?: boolean; empty?: boolean } = {}): string[] {
    if (o.git && o.empty) throw new Error("A workspace made for a clone starts empty: --git and --empty never go together");
    return ["workspace", "new", arg(KEBAB_RE, slug, "a new workspace name"), ...(o.git ? ["--git"] : []), ...(o.pin ? ["--pin"] : []), ...(o.empty ? ["--empty"] : []), "--json"];
  },
  draft: (name: string): string[] => ["workspace", "draft", wsArg(name), "--json"],
  /** Compare-and-set (D13): only `fields`, on the file whose hash is `expect` (`none`: no workspace.md yet). */
  set(name: string, fields: ManifestFields, expect: string, o: { dryRun?: boolean } = {}): string[] {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("set takes an object of workspace.md keys");
    return ["workspace", "set", wsArg(name), "--set", JSON.stringify(fields), "--expect", arg(HASH_RE, expect, "a workspace.md hash"), ...(o.dryRun ? ["--dry-run"] : []), "--json"];
  },
  archive: (name: string): string[] => ["workspace", "archive", wsArg(name), "--json"],
  /** An archived workspace by its own name (`_archive/<n>`'s <n>). */
  restore: (name: string): string[] => ["workspace", "restore", wsArg(name), "--json"],
  rename: (name: string, next: string): string[] => ["workspace", "rename", wsArg(name), arg(KEBAB_RE, next, "a new workspace name"), "--json"],
  /** The alias form only (D16): the folder stays where it is. */
  adopt: (folder: string, into: string): string[] => ["workspace", "adopt", arg(PATH_RE, folder, "a folder"), "--into", wsArg(into), "--json"],
  hide: (folder: string): string[] => ["workspace", "hide", arg(PATH_RE, folder, "a folder"), "--json"],
  unhide: (folder: string): string[] => ["workspace", "unhide", arg(PATH_RE, folder, "a folder"), "--json"],
};

/** The page asked for a verb while the spaces surface is off (main refused the spawn): what to do instead (host parity). */
export const SPACES_OFF_TEXT = "Spaces' write surface is off in this app: run the aos workspace command in a terminal instead";
/** The vault's vendored runtime has no such verb or flag yet. */
export const UPGRADE_TEXT = "The vault's runtime predates this action: run aos upgrade";
/** `set --expect` found another workspace.md than the draft read (D13). */
export const STALE_TEXT = "workspace.md changed: draft again";

export interface VerbFailure {
  ok: false;
  reason: string;
  /** Main refused the spawn: the spaces surface is off (the caller may take today's path instead). */
  refused: boolean;
  /** The runtime does not know the verb or a flag: the vault needs `aos upgrade`. */
  outdated: boolean;
  /** `set --expect` refused a changed workspace.md. */
  stale: boolean;
}
export type VerbResult<T> = { ok: true; json: T } | VerbFailure;

const fail = (reason: string, o: Partial<VerbFailure> = {}): VerbFailure => ({ ok: false, reason, refused: false, outdated: false, stale: false, ...o });
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The runtime's own message: `{ok:false, reason|error}` on stdout, else its `aos …: ` line on stderr. */
function said(body: unknown, stderr: string): string | null {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const s = str(b.reason) ?? str(b.error) ?? str(b.message);
    if (s) return s;
  }
  const lines = String(stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const own = lines.find((l) => /^aos( [a-z-]+)?: /.test(l)) ?? lines[0] ?? null;
  return own ? own.replace(/^aos( [a-z-]+)?: /, "") : null;
}

/**
 * A verb's answer (spaces-redesign D28): `{ok: true, …}` (or any object without `ok: false`) on exit 0, else why not.
 * Each verb prints `{ok, …}` or an error with a reason (the plan's Mechanics › PR 3); a spawn main refused says the
 * surface is off, and a runtime that does not know the verb says to upgrade.
 */
export function verbResult<T>(r: Pick<AosJsonResult<T>, "code" | "stdout" | "stderr" | "timedOut" | "json"> & { error?: string }): VerbResult<T> {
  if (r.error && /\brefused\b/.test(r.error)) return fail(SPACES_OFF_TEXT, { refused: true });
  if (r.timedOut) return fail("aos did not answer in time");
  if (r.error) return fail(`could not run aos: ${r.error}`);
  let body: unknown = r.json;
  let parsed = body !== null && body !== undefined;
  if (!parsed) { try { body = JSON.parse(r.stdout); parsed = true; } catch { body = null; } }
  const okBody = !!body && typeof body === "object" && !Array.isArray(body) && (body as { ok?: unknown }).ok !== false;
  if (r.code === 0 && okBody) return { ok: true, json: body as T };
  // Exit 0 with text instead of JSON: a runtime from before PR 3, whose `workspace new` took `--json` and printed its
  // text lines (spaces-redesign D28). It did the work, so the caller's fallback (createAndLaunch) finds the folder made.
  if (r.code === 0 && !parsed && String(r.stdout ?? "").trim()) return fail(`${UPGRADE_TEXT} (it answered in text, not JSON)`, { outdated: true });
  const line = said(body, r.stderr) ?? (r.code === 0 ? "aos answered in an unexpected shape" : `aos exited ${r.code}`);
  // An old runtime only by its own usage error (exit 2, `unknown verb|flag|command` opening stderr's first line) or a
  // module it lacks: never by text anywhere in the answer, which can hold a workspace name someone chose, so a refusal
  // never sends the caller to its HostFs fallback (terminalLauncher createAndLaunch, linkRepo).
  const first = String(r.stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const usage = r.code === 2 && /^(?:aos: )?(?:aos workspace: )?unknown (?:verb|flag|command)\b/.test(first);
  if (usage || /^(?:aos: )?(?:Error: )?Cannot find module /.test(first)) return fail(`${UPGRADE_TEXT} (${line})`, { outdated: true });
  return fail(line, { stale: /workspace\.md changed/i.test(line) });
}

// ── moves: what each confirmation names (D16, D17; §6 Confirmation) ──

export type MoveKind = "archive" | "restore" | "rename" | "adopt";

export interface MovePlanInput {
  /** The app's Sessions threads kept under brain/_index/sessions/<n>/. */
  threads: number;
  /** Host sessions credited to the workspace (or the folder, for Adopt) in the count window. */
  sessions?: number;
  /** The project notes whose status/ tag flips (flippingNotes). */
  notes?: Array<{ title: string; path: string }>;
  /** Rename: the new name. Restore: the name it goes back to (Archive's `archivedFrom:` for a dated archive). */
  to?: string;
  /** Adopt: the folder, as it reads (~/…). */
  folder?: string;
  /** Archive: workspaces/_archive/<n> is taken already, so the runtime adds a date to the name. */
  archiveTaken?: boolean;
  /** Rename: Claude Code threads among its recent sessions, and D7's build check (Rename warns only when it failed). */
  claudeThreads?: number;
  claudeCrossFolder?: boolean;
  /** Rename: the workspace is a git repository of its own, so Codex asks once to trust its new path (host parity). */
  ownRepo?: boolean;
}

export interface MovePlan {
  kind: MoveKind;
  title: string;
  confirm: string;
  /** What moves (or, for Adopt, the folder) and where it goes (or the workspace whose alias it becomes). */
  from: string;
  to: string;
  items: string[];
  /** The notes whose tag flips, by title. */
  notes: string[];
  footnote: string | null;
  /** A warning shown above the buttons (Rename's Claude threads when a cross-folder resume fails). */
  warn: string | null;
}

/**
 * What a move's confirmation says (§6: the source and destination, the threads that move, the notes whose tag flips).
 * Archive and Restore move the folder between workspaces/ and workspaces/_archive/ with its map; Rename moves the
 * folder, its map and its threads and records the old path as an alias; Adopt records an alias and moves nothing.
 */
export function movePlan(kind: MoveKind, e: Pick<WorkspaceEntry, "name" | "label">, o: MovePlanInput): MovePlan {
  const n = baseName(e);
  const threads = Math.max(0, o.threads || 0);
  const sessions = Math.max(0, o.sessions || 0);
  const notes = (o.notes ?? []).map((x) => x.title);
  const threadsText = plural(threads, "Sessions thread");
  if (kind === "archive") {
    const items = [
      `Moves workspaces/${n} to workspaces/_archive/${n}${o.archiveTaken ? " with today's date added (that name is taken)" : ""}`,
      `Moves its file map to brain/_index/workspace-maps/_archive/`,
      notes.length ? `Marks its project memory archived: status/active becomes status/archived in ${plural(notes.length, "note")}` : "No project note names it by workspace: or slug, so no tag changes",
    ];
    if (threads) items.push(`Keeps its ${threadsText} listed in Sessions, read-only until Restore`);
    items.push(sessions ? `Keeps its ${plural(sessions, "session")} and its git history attached` : "Keeps its sessions and git history attached");
    return { kind, title: `Archive ${n}?`, confirm: "Archive", from: `workspaces/${n}`, to: `workspaces/_archive/${n}`, items, notes, footnote: "Restore it any time: show archived and _ folders, then More › Restore…", warn: null };
  }
  if (kind === "restore") {
    const back = o.to || n;
    const items = [
      `Moves workspaces/_archive/${n} back to workspaces/${back}`,
      "Moves its file map back to brain/_index/workspace-maps/",
      notes.length ? `Marks its project memory active again: status/archived becomes status/active in ${plural(notes.length, "note")}` : "No project note names it by workspace: or slug, so no tag changes",
    ];
    if (threads) items.push(`Its ${threadsText} take${threads === 1 ? "s" : ""} turns again`);
    return { kind, title: `Restore ${n}?`, confirm: "Restore", from: `workspaces/_archive/${n}`, to: `workspaces/${back}`, items, notes, footnote: null, warn: null };
  }
  if (kind === "rename") {
    const to = o.to ?? "";
    const items = [
      `Moves workspaces/${n} to workspaces/${to || "…"}`,
      threads ? `Moves its file map and its ${threadsText}, and rewrites each thread's workspace to ${to || "the new name"}` : "Moves its file map",
      `Records workspaces/${n} under aliases:, so its past sessions, to-dos and notes still count here`,
    ];
    if (o.ownRepo) items.push(`Codex asks once to trust workspaces/${to || "…"}: it is a git repository of its own`);
    const claude = Math.max(0, o.claudeThreads || 0);
    const crossFolder = o.claudeCrossFolder ?? CLAUDE_RESUME_CROSS_FOLDER.works;
    const warn = claude && !crossFolder ? `${plural(claude, "Claude thread")} may not resume from the new folder` : null;
    return { kind, title: `Rename ${n}`, confirm: "Rename", from: `workspaces/${n}`, to: `workspaces/${to || "…"}`, items, notes: [], footnote: null, warn };
  }
  const folder = o.folder ?? "";
  const items = [
    `Records ${folder} under ${n}'s aliases: in its workspace.md`,
    "Moves nothing: the folder stays where it is",
    sessions ? `Its ${plural(sessions, "session")} count${sessions === 1 ? "s" : ""} toward ${n} after the next scan` : `Its sessions count toward ${n} after the next scan`,
  ];
  return { kind, title: `Adopt ${folder} into ${n}?`, confirm: "Adopt", from: folder, to: `${n} (alias)`, items, notes: [], footnote: "Adopting from Spaces never moves a folder: aos workspace adopt without --into, in a terminal, still does.", warn: null };
}
