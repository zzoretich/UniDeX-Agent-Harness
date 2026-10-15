// sessionHistory.ts — Sessions ▸ History (install-import B11): every past Claude Code and Codex session on this Mac, from
// the caches the runtime writes, never a transcript: brain/_index/session-index.json (collectors/hostSessions.js indexes
// each host's transcripts: who, where, when, the title) and brain/_index/session-digests.json (the import-digest
// routine's one-line summaries and workspaces, lib/import/digest.js). Interactive sessions only: a headless run, a
// Sessions thread (run headless by the app) and a team seat's run, and a Codex subagent, are not History; two
// transcripts naming one session (Claude Code's small stub files) are one row. A title is the digest's when there is one
// (the scan's, a Codex thread's own name included), else the index's, else the first prompt. Resume follows spaces-redesign D7 and
// D31: a Code terminal typing `claude --resume <id>` or `codex resume -C <folder> <id>`, only for a host that is on,
// off with why when it is not signed in, and no button at all for a host that is off (its rows still show, B15 §5.6).
// Pure, so node:test can load it.
import * as path from "path";
import { THREAD_ID_RE } from "./statusline";
import { TERM_HOST_LABEL, placeOf, vaultPlace, workspacePlace } from "./terminalLaunch";
import type { Place, PlaceWorld, TermHostChoice } from "./terminalLaunch";
import { shortenCwd } from "./hostSessions";

export const SESSION_INDEX_PATH = "brain/_index/session-index.json";
export const SESSION_DIGESTS_PATH = "brain/_index/session-digests.json";
/** History draws this many rows, then Show more adds as many again: a real vault can hold thousands. */
export const HISTORY_PAGE = 100;

export type HistoryHost = "claude" | "codex";
export const HISTORY_HOST_LABEL: Record<HistoryHost, string> = { claude: "Claude Code", codex: "Codex" };

/** One session as the index has it, after the interactive filter and the per-id fold. */
export interface IndexedSession {
  host: HistoryHost;
  id: string;
  /** The transcript's file name ends with `<id>.jsonl`, so `--resume <id>` opens this very thread. */
  fileMatches: boolean;
  /** In Codex's archived_sessions folder. */
  archived: boolean;
  title: string | null;
  cwd: string | null;
  startedAt: string | null;
  lastAt: string | null;
}

/** A digest's line: its summary, its workspace, and the session's title as the scan saw it (a Codex thread's own name
 *  among them, which the index's row does not keep). */
export interface Digest { summary: string; workspace: string | null; title: string | null }

export type HistoryResume =
  /** Type the resume line in a Code terminal at `place`. */
  | { state: "on"; place: Place; hint: string }
  /** Offered, but not now: the host is not signed in, or this session cannot be resumed by id. */
  | { state: "off"; reason: string }
  /** The host is off on this Mac: the row shows without a button. */
  | { state: "none" };

export interface HistoryRow {
  key: string;
  id: string;
  host: HistoryHost;
  hostLabel: string;
  title: string;
  /** The digest's one line, when the routine has reached this session. */
  summary: string | null;
  /** The workspace it belongs to (the digest's, else the folder it started in), or null. */
  workspace: string | null;
  /** Where it ran, for the row: the workspace's name, else the ~-shortened folder. */
  where: string | null;
  /** When it started (else last moved), local day and time. */
  at: string | null;
  day: string;
  time: string;
  resume: HistoryResume;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const ms = (iso: string | null): number => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? -Infinity : t; };
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * session-index.json's rows as History lists them. A row needs a host, a head with an id and kind `interactive`; ids
 * fold case-insensitively per host, the newest transcript winning (a stub file and the real one name the same id).
 */
export function parseSessionIndex(text: string | null): IndexedSession[] {
  let j: unknown;
  try { j = text ? JSON.parse(text) : null; } catch { return []; }
  if (!isObj(j) || !isObj(j.files)) return [];
  const byId = new Map<string, IndexedSession>();
  for (const [file, raw] of Object.entries(j.files)) {
    if (!isObj(raw) || !isObj(raw.head)) continue;
    const host = raw.host === "claude" || raw.host === "codex" ? raw.host : null;
    const id = str(raw.head.id);
    if (!host || !id || raw.head.kind !== "interactive") continue;
    const s: IndexedSession = {
      host, id,
      fileMatches: path.basename(file).toLowerCase().endsWith(`${id.toLowerCase()}.jsonl`),
      archived: /(^|[\\/])archived_sessions[\\/]/.test(file),
      title: str(raw.title) ?? str(raw.head.title) ?? str(raw.head.firstPrompt),
      cwd: str(raw.head.startCwd),
      startedAt: str(raw.head.startedAt),
      lastAt: str(raw.lastAt),
    };
    const key = `${host}:${id.toLowerCase()}`;
    const old = byId.get(key);
    if (!old) { byId.set(key, s); continue; }
    const keep = ms(s.lastAt) > ms(old.lastAt) ? s : old;
    const other = keep === s ? old : s;
    byId.set(key, {
      ...keep, title: keep.title ?? other.title, cwd: keep.cwd ?? other.cwd,
      startedAt: [keep.startedAt, other.startedAt].filter(Boolean).sort()[0] ?? null,
      fileMatches: keep.fileMatches || other.fileMatches,
    });
  }
  return [...byId.values()];
}

/** session-digests.json by `<host>:<id>`. */
export function parseDigests(text: string | null): Map<string, Digest> {
  const out = new Map<string, Digest>();
  let j: unknown;
  try { j = text ? JSON.parse(text) : null; } catch { return out; }
  if (!isObj(j) || !Array.isArray(j.sessions)) return out;
  for (const d of j.sessions) {
    if (!isObj(d)) continue;
    const host = d.host === "claude" || d.host === "codex" ? d.host : null;
    const id = str(d.id);
    const summary = str(d.summary);
    if (!host || !id || !summary) continue;
    out.set(`${host}:${id.toLowerCase()}`, { summary: summary.replace(/\s+/g, " ").trim(), workspace: str(d.workspace), title: str(d.title) });
  }
  return out;
}

/** Whether History has a session to list: the index names one (the Sessions rail button follows this too). */
export function hasHistory(indexText: string | null): boolean {
  return parseSessionIndex(indexText).length > 0;
}

/** The local day (YYYY-MM-DD) and time (HH:MM) of an instant; empty for none. */
export function localDayTime(iso: string | null): { day: string; time: string } {
  const t = ms(iso);
  if (!Number.isFinite(t)) return { day: "", time: "" };
  const d = new Date(t);
  return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day's heading: Today, Yesterday, "Mon 13 Oct", with the year when it is not this one; "Undated" for none. */
export function dayLabel(day: string, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return "Undated";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const base = `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** What Resume does for a session (spaces-redesign D7, D31; install-import B11). */
export function resumeFor(s: Pick<IndexedSession, "host" | "id" | "fileMatches" | "archived" | "cwd">, workspace: string | null, choices: readonly TermHostChoice[], world: PlaceWorld): HistoryResume {
  const choice = choices.find((c) => c.host === s.host);
  if (!choice || choice.hidden) return { state: "none" };
  if (!choice.ready) return { state: "off", reason: choice.reason || `${TERM_HOST_LABEL[s.host]} is not ready` };
  if (s.archived) return { state: "off", reason: "Archived in Codex" };
  // A lowercase UUID equal to its file's id never reads as a flag, and opens this thread and no other.
  if (!THREAD_ID_RE.test(s.id) || !s.fileMatches) return { state: "off", reason: "Its session id is not the one in its file name, so it cannot be resumed by id" };
  if (workspace && world.workspaces.includes(workspace)) {
    const place = workspacePlace(workspace, world);
    return { state: "on", place, hint: `Resumes in ${place.linked ? `${shortenCwd(place.dir, world.home)}, its code folder` : `workspaces/${workspace}`}` };
  }
  const place = s.cwd ? placeOf(s.cwd, world) : vaultPlace(world);
  const where = place.kind === "vault" ? "the vault" : shortenCwd(place.dir, world.home);
  return { state: "on", place, hint: `Resumes in ${where}${s.cwd ? ", where it started" : ""}` };
}

/** History's rows, newest first by when each started (so a day's rows sit together, as the daily notes have them), with
 *  the digests' lines and each one's Resume. */
export function historyRows(sessions: readonly IndexedSession[], digests: ReadonlyMap<string, Digest>, choices: readonly TermHostChoice[], world: PlaceWorld): HistoryRow[] {
  return sessions
    .map((s): HistoryRow & { sort: number } => {
      const key = `${s.host}:${s.id.toLowerCase()}`;
      const dg = digests.get(key) ?? null;
      const cwdPlace = s.cwd ? placeOf(s.cwd, world) : null;
      const fromCwd = cwdPlace && cwdPlace.kind === "workspace" ? cwdPlace.workspace ?? null : null;
      const workspace = dg?.workspace && world.workspaces.includes(dg.workspace) ? dg.workspace : fromCwd;
      const at = s.startedAt ?? s.lastAt;
      const { day, time } = localDayTime(at);
      return {
        key, id: s.id, host: s.host, hostLabel: HISTORY_HOST_LABEL[s.host],
        title: (dg?.title ?? s.title ?? "").replace(/\s+/g, " ").trim() || "Untitled session",
        summary: dg?.summary ?? null,
        workspace, where: workspace ?? (s.cwd ? shortenCwd(s.cwd, world.home) : null),
        at, day, time, resume: resumeFor(s, workspace, choices, world), sort: ms(at),
      };
    })
    .sort((a, b) => b.sort - a.sort || (a.key < b.key ? -1 : 1))
    .map(({ sort, ...row }) => { void sort; return row; });
}

/** Rows whose title, summary, workspace, folder or host name holds every word of the query. */
export function filterHistory(rows: readonly HistoryRow[], query: string): HistoryRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((r) => {
    const hay = `${r.title}\n${r.summary ?? ""}\n${r.where ?? ""}\n${r.hostLabel}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Consecutive rows by day, in the rows' order. */
export function groupByDay(rows: readonly HistoryRow[]): Array<{ day: string; rows: HistoryRow[] }> {
  const out: Array<{ day: string; rows: HistoryRow[] }> = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.day === r.day) last.rows.push(r);
    else out.push({ day: r.day, rows: [r] });
  }
  return out;
}

/** The line under History's title: how many, on which hosts, and how many the digest has summarised. */
export function historyCount(rows: readonly HistoryRow[]): string {
  if (!rows.length) return "No past sessions on this Mac yet";
  const n = (h: HistoryHost) => rows.filter((r) => r.host === h).length;
  const hosts = (["claude", "codex"] as const).filter((h) => n(h) > 0).map((h) => `${HISTORY_HOST_LABEL[h]} ${n(h)}`);
  const summarised = rows.filter((r) => r.summary).length;
  return `${rows.length} past session${rows.length === 1 ? "" : "s"} · ${hosts.join(" · ")}${summarised ? ` · ${summarised} summarised` : ""}`;
}
