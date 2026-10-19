// skills.ts — the HUD-side loader for brain/_index/skills.json (spec 2026-09-23-universal-skills D7): every skill of
// both session hosts, written by the runtime only — `aos skills sync` (lib/skills.js), which also mirrors each host's user
// skills into the other host's folder. Pure parsing and formatting; only readSkills touches the filesystem. The tab runs
// a skill by typing its invocation into a fresh terminal session on the chosen host.
import * as path from "path";
import { fs } from "../host";

export const SKILLS_PATH = "brain/_index/skills.json";
export const SKILL_HOSTS = ["claude", "codex"] as const;
export type SkillHost = typeof SKILL_HOSTS[number];
/** The tab asks the runtime for a fresh sync on open when the cache is older than this. */
export const SKILLS_MAX_AGE_MS = 10 * 60_000;

export type SkillScope = "user" | "synced" | "mirror" | "plugin" | "builtin";
export interface SkillSide { path: string; via: string; invoke: string }
export interface SkillRow {
  id: string; name: string; description: string;
  origin: { host: SkillHost; scope: SkillScope; plugin: string | null; path: string };
  on: Record<SkillHost, SkillSide | null>;
  status: string; note: string | null;
}
export interface SkillsCache {
  scannedAt: string | null;
  hosts: Record<SkillHost, boolean>;
  sync: { on: boolean; reason: string | null; at: string | null };
  skills: SkillRow[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const SCOPES: SkillScope[] = ["user", "synced", "mirror", "plugin", "builtin"];

function sideFrom(v: unknown): SkillSide | null {
  const o = obj(v);
  const invoke = o && str(o.invoke);
  return o && invoke ? { path: str(o.path) ?? "", via: str(o.via) ?? "", invoke } : null;
}

function rowFrom(v: unknown): SkillRow | null {
  const o = obj(v);
  const id = o && str(o.id);
  if (!o || !id) return null;
  const origin = obj(o.origin) ?? {};
  const on = obj(o.on) ?? {};
  const host = origin.host === "codex" ? "codex" : "claude";
  const scope = SCOPES.includes(origin.scope as SkillScope) ? origin.scope as SkillScope : "user";
  return {
    id, name: str(o.name) ?? id, description: str(o.description) ?? "",
    origin: { host, scope, plugin: str(origin.plugin), path: str(origin.path) ?? "" },
    on: { claude: sideFrom(on.claude), codex: sideFrom(on.codex) },
    status: str(o.status) ?? "listed", note: str(o.note),
  };
}

export function emptySkills(): SkillsCache {
  return { scannedAt: null, hosts: { claude: true, codex: false }, sync: { on: false, reason: null, at: null }, skills: [] };
}

/** Tolerant: a missing, corrupt or foreign file is an empty cache; a row without an id is dropped. */
export function parseSkills(raw: string | null): SkillsCache {
  if (raw == null) return emptySkills();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return emptySkills(); }
  const o = obj(parsed);
  if (!o || o.schema !== 1 || !Array.isArray(o.skills)) return emptySkills();
  const hosts = obj(o.hosts) ?? {};
  const sync = obj(o.sync) ?? {};
  return {
    scannedAt: str(o.scannedAt),
    hosts: { claude: hosts.claude !== false, codex: hosts.codex === true },
    sync: { on: sync.on === true, reason: str(sync.reason), at: str(sync.at) },
    skills: (o.skills as unknown[]).map(rowFrom).filter((r): r is SkillRow => r !== null),
  };
}

export function readSkills(vaultRoot: string): SkillsCache {
  let raw: string | null = null;
  try { raw = fs.readFileSync(path.join(vaultRoot, SKILLS_PATH), "utf8"); } catch { /* not written yet */ }
  return parseSkills(raw);
}

/** True when the cache was never written or is older than maxAgeMs — the tab then spawns `aos skills sync`. */
export function skillsStale(cache: SkillsCache, now = Date.now(), maxAgeMs = SKILLS_MAX_AGE_MS): boolean {
  const t = cache.scannedAt ? Date.parse(cache.scannedAt) : NaN;
  return !Number.isFinite(t) || now - t > maxAgeMs;
}

/** The user's own skills (each host's, claude.ai-synced, orphaned copies) apart from plugin skills and built-ins. */
export function isYours(r: SkillRow): boolean { return r.origin.scope === "user" || r.origin.scope === "synced" || r.origin.scope === "mirror"; }

export function groupSkills(rows: SkillRow[]): { yours: SkillRow[]; listed: SkillRow[] } {
  return { yours: rows.filter(isYours), listed: rows.filter((r) => !isYours(r)) };
}

/** Case-insensitive match on the name, the description and the plugin; an empty query keeps everything. */
export function filterSkills(rows: SkillRow[], query: string): SkillRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => `${r.name}\n${r.description}\n${r.origin.plugin ?? ""}`.toLowerCase().includes(q));
}

/** "86 on both · 1 only in Claude Code · 0 only in Codex" over your skills. */
export function skillCounts(rows: SkillRow[]): { both: number; claude: number; codex: number } {
  const out = { both: 0, claude: 0, codex: 0 };
  for (const r of rows) {
    if (r.on.claude && r.on.codex) out.both++;
    else if (r.on.claude) out.claude++;
    else if (r.on.codex) out.codex++;
  }
  return out;
}

/** Where a skill comes from, for the source pill. */
export function sourceLabel(r: SkillRow): string {
  if (r.origin.scope === "synced") return "claude.ai";
  if (r.origin.scope === "plugin") return r.origin.plugin ?? "plugin";
  if (r.origin.scope === "builtin") return "built-in";
  if (r.origin.scope === "mirror") return "orphan copy";
  return r.origin.host === "codex" ? "codex" : "claude";
}

/** The status chip: shared → ok; a problem the user should look at → warn/failed; the rest neutral. */
export function statusChip(r: SkillRow): { cls: "is-ok" | "is-neutral" | "is-stale" | "is-failed" | "is-off"; text: string } {
  switch (r.status) {
    case "universal": return { cls: "is-ok", text: "on both" };
    case "pending": return { cls: "is-neutral", text: "not shared yet" };
    case "differs": return { cls: "is-stale", text: "differs" };
    case "edited": return { cls: "is-stale", text: "copy edited" };
    case "invalid": return { cls: "is-failed", text: "can't share" };
    case "error": return { cls: "is-failed", text: "sync failed" };
    case "excluded": return { cls: "is-off", text: "not shared" };
    default: return { cls: "is-neutral", text: r.on.claude && r.on.codex ? "both (plugin)" : r.origin.scope === "builtin" ? "built-in" : "plugin" };
  }
}

/** POSIX single quotes: a Codex `$name` must not be expanded by the shell, and nothing inside needs interpolation. */
export function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

/** What the run button types into a fresh terminal: the host's CLI with the skill's invocation as the first prompt. */
export function runCommand(r: SkillRow, host: SkillHost): string | null {
  const side = r.on[host];
  if (!side) return null;
  return `${host === "codex" ? "codex" : "claude"} ${shq(side.invoke)}`;
}

/** "as of 3m ago" material: the newest of the scan and the last sync. */
export function asOf(cache: SkillsCache): string | null { return cache.sync.at ?? cache.scannedAt; }
