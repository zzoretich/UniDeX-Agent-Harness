// agents.ts — the HUD-side loader for brain/_index/agents.json (spec 2026-09-23-universal-agents D7): every agent of
// both session hosts, written by the runtime only — `aos agents sync` (lib/agents.js, also run by the skills-sync hook),
// which also mirrors each host's user agents into the other host's agents folder. Pure parsing and formatting; only
// readAgents touches the filesystem. The tab starts an agent by typing the row's run command into a fresh terminal:
// `claude --agent <name>` (a session as the agent) or `codex '<starter prompt>'` (Codex spawns the role it is asked for).
import * as path from "path";
import { fs } from "../host";

export const AGENTS_PATH = "brain/_index/agents.json";
export const AGENT_HOSTS = ["claude", "codex"] as const;
export type AgentHost = typeof AGENT_HOSTS[number];
/** The tab asks the runtime for a fresh sync on open when the cache is older than this. */
export const AGENTS_MAX_AGE_MS = 10 * 60_000;

export type AgentScope = "user" | "mirror" | "plugin" | "config";
export interface AgentSide { path: string; via: string; invoke: string; run: string | null }
export interface AgentRow {
  id: string; name: string; description: string;
  origin: { host: AgentHost; scope: AgentScope; plugin: string | null; path: string };
  on: Record<AgentHost, AgentSide | null>;
  readOnly: boolean;
  status: string; note: string | null;
}
export interface AgentsCache {
  scannedAt: string | null;
  hosts: Record<AgentHost, boolean>;
  codexAgents: { on: boolean; reason: string | null };
  sync: { on: boolean; reason: string | null; at: string | null };
  agents: AgentRow[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const SCOPES: AgentScope[] = ["user", "mirror", "plugin", "config"];
const RUN_FOR: Record<AgentHost, string> = { claude: "claude ", codex: "codex " };

function sideFrom(v: unknown, host: AgentHost): AgentSide | null {
  const o = obj(v);
  const invoke = o && str(o.invoke);
  if (!o || !invoke) return null;
  // The run command is typed into a shell: accept only one that starts the host's own CLI.
  const run = str(o.run);
  return { path: str(o.path) ?? "", via: str(o.via) ?? "", invoke, run: run && run.startsWith(RUN_FOR[host]) ? run : null };
}

function rowFrom(v: unknown): AgentRow | null {
  const o = obj(v);
  const id = o && str(o.id);
  if (!o || !id) return null;
  const origin = obj(o.origin) ?? {};
  const on = obj(o.on) ?? {};
  const host = origin.host === "codex" ? "codex" : "claude";
  const scope = SCOPES.includes(origin.scope as AgentScope) ? origin.scope as AgentScope : "user";
  return {
    id, name: str(o.name) ?? id, description: str(o.description) ?? "",
    origin: { host, scope, plugin: str(origin.plugin), path: str(origin.path) ?? "" },
    on: { claude: sideFrom(on.claude, "claude"), codex: sideFrom(on.codex, "codex") },
    readOnly: o.readOnly === true,
    status: str(o.status) ?? "listed", note: str(o.note),
  };
}

export function emptyAgents(): AgentsCache {
  return { scannedAt: null, hosts: { claude: true, codex: false }, codexAgents: { on: true, reason: null }, sync: { on: false, reason: null, at: null }, agents: [] };
}

/** Tolerant: a missing, corrupt or foreign file is an empty cache; a row without an id is dropped. */
export function parseAgents(raw: string | null): AgentsCache {
  if (raw == null) return emptyAgents();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return emptyAgents(); }
  const o = obj(parsed);
  if (!o || o.schema !== 1 || !Array.isArray(o.agents)) return emptyAgents();
  const hosts = obj(o.hosts) ?? {};
  const sync = obj(o.sync) ?? {};
  const cx = obj(o.codexAgents) ?? {};
  return {
    scannedAt: str(o.scannedAt),
    hosts: { claude: hosts.claude !== false, codex: hosts.codex === true },
    codexAgents: { on: cx.on !== false, reason: str(cx.reason) },
    sync: { on: sync.on === true, reason: str(sync.reason), at: str(sync.at) },
    agents: (o.agents as unknown[]).map(rowFrom).filter((r): r is AgentRow => r !== null),
  };
}

export function readAgents(vaultRoot: string): AgentsCache {
  let raw: string | null = null;
  try { raw = fs.readFileSync(path.join(vaultRoot, AGENTS_PATH), "utf8"); } catch { /* not written yet */ }
  return parseAgents(raw);
}

/** True when the cache was never written or is older than maxAgeMs — the tab then spawns `aos agents sync`. */
export function agentsStale(cache: AgentsCache, now = Date.now(), maxAgeMs = AGENTS_MAX_AGE_MS): boolean {
  const t = cache.scannedAt ? Date.parse(cache.scannedAt) : NaN;
  return !Number.isFinite(t) || now - t > maxAgeMs;
}

/** The user's own agents (each host's, and orphaned copies) apart from plugin agents and config.toml roles. */
export function isYours(r: AgentRow): boolean { return r.origin.scope === "user" || r.origin.scope === "mirror"; }

export function groupAgents(rows: AgentRow[]): { yours: AgentRow[]; listed: AgentRow[] } {
  return { yours: rows.filter(isYours), listed: rows.filter((r) => !isYours(r)) };
}

/** Case-insensitive match on the name, the description and the plugin; an empty query keeps everything. */
export function filterAgents(rows: AgentRow[], query: string): AgentRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => `${r.name}\n${r.description}\n${r.origin.plugin ?? ""}`.toLowerCase().includes(q));
}

/** "33 on both · 0 Claude Code only · 0 Codex only" over your agents. */
export function agentCounts(rows: AgentRow[]): { both: number; claude: number; codex: number } {
  const out = { both: 0, claude: 0, codex: 0 };
  for (const r of rows) {
    if (r.on.claude && r.on.codex) out.both++;
    else if (r.on.claude) out.claude++;
    else if (r.on.codex) out.codex++;
  }
  return out;
}

/** Where an agent comes from, for the source pill. */
export function sourceLabel(r: AgentRow): string {
  if (r.origin.scope === "plugin") return r.origin.plugin ?? "plugin";
  if (r.origin.scope === "config") return "config.toml";
  if (r.origin.scope === "mirror") return "orphan copy";
  return r.origin.host === "codex" ? "codex" : "claude";
}

/** The status chip: shared → ok; a problem the user should look at → warn/failed; the rest neutral. */
export function statusChip(r: AgentRow): { cls: "is-ok" | "is-neutral" | "is-stale" | "is-failed" | "is-off"; text: string } {
  switch (r.status) {
    case "universal": return { cls: "is-ok", text: "on both" };
    case "pending": return { cls: "is-neutral", text: "not shared yet" };
    case "differs": return { cls: "is-stale", text: "differs" };
    case "edited": return { cls: "is-stale", text: "copy edited" };
    case "invalid": return { cls: "is-failed", text: "can't share" };
    case "error": return { cls: "is-failed", text: "sync failed" };
    case "excluded": return { cls: "is-off", text: "not shared" };
    default: return { cls: "is-neutral", text: r.origin.scope === "config" ? "config.toml" : "plugin" };
  }
}

/** What the run button types into a fresh terminal on `host`, or null when that host lacks the agent. */
export function runCommand(r: AgentRow, host: AgentHost): string | null {
  return r.on[host]?.run ?? null;
}

/** "as of 3m ago" material: the newest of the scan and the last sync. */
export function asOf(cache: AgentsCache): string | null { return cache.sync.at ?? cache.scannedAt; }
