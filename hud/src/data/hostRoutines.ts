// hostRoutines.ts — the HUD-side loader for brain/_index/routines-hosts.json (spec host-routines D4): the
// routines each session host owns, written by the runtime only — `aos routines hosts --refresh` (the Codex
// app's Automations, read through sqlite3) and `aos routines import-cloud` (the Claude Code cloud snapshot a
// session fetched with RemoteTrigger). Pure parsing; only readHostRoutines touches the filesystem. The rows are
// read-only in the tab: a Codex Automation is edited in the Codex app, a cloud routine at claude.ai/code/routines.
import * as path from "path";
import { fs } from "../host";

export const HOST_ROUTINES_PATH = "brain/_index/routines-hosts.json";
export const HOST_NAMES = ["codex", "claude"] as const;
export type HostName = typeof HOST_NAMES[number];
/** The Codex section is re-read on mount when it is older than this (the tab spawns `aos routines hosts --refresh`). */
export const CODEX_MAX_AGE_MS = 10 * 60_000;

export interface HostRoutine {
  id: string; name: string; cadence: string; schedule: string; enabled: boolean;
  status: string | null; next: string | null; last: { at: string; status: string } | null;
  model: string | null; target: string | null; link: string | null; summary: string;
}
export interface HostSection { fetchedAt: string | null; ok: boolean; warning: string | null; routines: HostRoutine[] }
export type HostRoutinesCache = { hosts: Partial<Record<HostName, HostSection>> };
export interface HostRow extends HostRoutine { host: HostName; fetchedAt: string | null }

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function routineFrom(v: unknown): HostRoutine | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  const last = o.last && typeof o.last === "object" && str((o.last as Record<string, unknown>).at)
    ? { at: str((o.last as Record<string, unknown>).at)!, status: str((o.last as Record<string, unknown>).status) ?? "ran" }
    : null;
  return {
    id, name: str(o.name) ?? id, cadence: str(o.cadence) ?? "", schedule: str(o.schedule) ?? "", enabled: o.enabled === true,
    status: str(o.status), next: str(o.next), last, model: str(o.model), target: str(o.target), link: str(o.link), summary: str(o.summary) ?? "",
  };
}

export function emptyHostRoutines(): HostRoutinesCache { return { hosts: {} }; }

/** Tolerant: a missing, corrupt or foreign file is an empty cache; a section without a routines[] is dropped. */
export function parseHostRoutines(raw: string | null): HostRoutinesCache {
  if (raw == null) return emptyHostRoutines();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return emptyHostRoutines(); }
  const hosts = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).hosts : null;
  if (!hosts || typeof hosts !== "object") return emptyHostRoutines();
  const out = emptyHostRoutines();
  for (const h of HOST_NAMES) {
    const s = (hosts as Record<string, unknown>)[h];
    if (!s || typeof s !== "object" || !Array.isArray((s as Record<string, unknown>).routines)) continue;
    const sec = s as Record<string, unknown>;
    out.hosts[h] = {
      fetchedAt: str(sec.fetchedAt), ok: sec.ok !== false, warning: str(sec.warning),
      routines: (sec.routines as unknown[]).map(routineFrom).filter((r): r is HostRoutine => r !== null),
    };
  }
  return out;
}

export function readHostRoutines(vaultRoot: string): HostRoutinesCache {
  let raw: string | null = null;
  try { raw = fs.readFileSync(path.join(vaultRoot, HOST_ROUTINES_PATH), "utf8"); } catch { /* not written yet */ }
  return parseHostRoutines(raw);
}

/** Flat rows in host order (codex, then claude), each carrying its section's fetchedAt. */
export function hostRows(cache: HostRoutinesCache): HostRow[] {
  const out: HostRow[] = [];
  for (const h of HOST_NAMES) {
    const s = cache.hosts[h];
    if (!s) continue;
    for (const r of s.routines) out.push({ ...r, host: h, fetchedAt: s.fetchedAt });
  }
  return out;
}

/** The chip on a host row: ran once → neutral; a failed last run → failed; paused → off; else ok. */
export function hostChip(r: HostRoutine): { cls: "is-ok" | "is-neutral" | "is-off" | "is-failed"; text: string } {
  if (r.status === "ran once") return { cls: "is-neutral", text: "ran once" };
  if (r.last && /fail|error|cancel/i.test(r.last.status)) return { cls: "is-failed", text: r.last.status };
  if (!r.enabled) return { cls: "is-off", text: r.status ?? "paused" };
  return { cls: "is-ok", text: r.status ?? "active" };
}

/** True when a section is absent or older than maxAgeMs — the tab then asks the runtime to re-read that host. */
export function sectionStale(section: HostSection | undefined, now = Date.now(), maxAgeMs = CODEX_MAX_AGE_MS): boolean {
  if (!section || !section.fetchedAt) return true;
  const t = Date.parse(section.fetchedAt);
  return !Number.isFinite(t) || now - t > maxAgeMs;
}

/** At most one Codex refresh a minute. */
export const CODEX_REFRESH_GAP_MS = 60_000;

/**
 * Whether the tab should ask the runtime to re-read Codex's automations: only on a machine where Codex is a session host
 * (elsewhere the runtime never writes that section, so it would look stale forever), when the section is stale, and at
 * most once a minute since the last ask.
 */
export function codexRefreshDue(hosts: readonly string[], section: HostSection | undefined, lastAskedAt: number, now = Date.now()): boolean {
  return hosts.includes("codex") && sectionStale(section, now) && now - lastAskedAt > CODEX_REFRESH_GAP_MS;
}
