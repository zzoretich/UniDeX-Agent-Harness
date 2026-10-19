import { App } from "obsidian";

export const RUNS_PATH = "brain/_index/agent-runs/runs.jsonl";
/** cost-sync's records (spec 2026-09-24-append-only-runs D2): runs.jsonl is never rewritten to patch a cost in. */
export const COSTS_PATH = "brain/_index/agent-runs/costs.jsonl";

export interface AgentRun {
  id: string;
  script: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  cost_usd: number;
  turns: number;
  status: "ok" | "error" | string;
  prompt?: string;
  reply?: string;
  tool_count?: number;
  subagents?: unknown[];
  error?: string | null;
  session_id?: string;
  segment?: number;
  cost_source?: string | null;
  tokens?: number | null;
  cost_synced_at?: string | null;
  /** On an earlier segment of a session: the run whose cost_usd carries the whole session's cost. */
  cost_counted_on?: string | null;
}

export interface CostRecord {
  session_id: string;
  cost_usd: number;
  cost_source?: string | null;
  tokens?: number | null;
  at?: string;
}

/** Parse JSONL lines, silently skipping malformed ones. */
function parseJsonl<T>(lines: string[]): T[] {
  const out: T[] = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as unknown;
      if (o && typeof o === "object") out.push(o as T);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
const parseRuns = (lines: string[]): AgentRun[] => parseJsonl<AgentRun>(lines);

/** The session a run belongs to: its session_id, else a session row's id (sess-<uuid>, segment suffix dropped). */
export function sessionOf(r: Partial<AgentRun>): string {
  if (r.session_id) return String(r.session_id);
  const m = /^sess-(.+?)(?:-s\d+)?$/.exec(typeof r.id === "string" ? r.id : "");
  return m ? m[1] : "";
}

const isSessionRow = (r: AgentRun): boolean => r.script === "session" || (!r.script && /^sess-/.test(String(r.id || "")));
const endOf = (r: AgentRun): string => String(r.ended_at || r.started_at || "");

/**
 * The runs with the cost records laid over them: a session's newest cost counted once, on its latest session run;
 * its other session runs read 0 with cost_counted_on naming that run. A session with no record keeps the highest
 * cost_usd its runs carry (costed before costs.jsonl), on the same one run. Headless runs keep their own cost.
 * Pure; the IDENTICAL rule is applyCosts in brain/scripts/lib/runs-log.js.
 */
export function applyCosts(runs: AgentRun[], costs: CostRecord[]): AgentRun[] {
  const out = runs.map((r) => ({ ...r }));
  const newest = new Map<string, CostRecord>();
  for (const c of costs) {
    if (!c || !c.session_id || typeof c.cost_usd !== "number") continue;
    const cur = newest.get(c.session_id);
    if (!cur || String(c.at || "") >= String(cur.at || "")) newest.set(c.session_id, c);
  }
  const groups = new Map<string, AgentRun[]>();
  for (const r of out) {
    if (!isSessionRow(r)) continue;
    const sid = sessionOf(r);
    if (!sid) continue;
    const g = groups.get(sid);
    if (g) g.push(r); else groups.set(sid, [r]);
  }
  for (const [sid, group] of groups) {
    let carrier = group[0];
    for (const r of group) if (endOf(r) >= endOf(carrier)) carrier = r;
    const rec = newest.get(sid);
    let cost: number | null = null;
    if (rec) {
      cost = rec.cost_usd;
      carrier.cost_source = rec.cost_source ?? carrier.cost_source ?? null;
      if (rec.tokens != null) carrier.tokens = rec.tokens;
      carrier.cost_synced_at = rec.at ?? carrier.cost_synced_at ?? null;
    } else {
      for (const r of group) if (typeof r.cost_usd === "number" && (cost === null || r.cost_usd > cost)) cost = r.cost_usd;
    }
    (carrier as { cost_usd: number | null }).cost_usd = cost;
    for (const r of group) {
      if (r === carrier) continue;
      if (typeof cost === "number") { r.cost_usd = 0; r.cost_counted_on = carrier.id || null; }
      else (r as { cost_usd: number | null }).cost_usd = null;
    }
  }
  return out;
}

async function readCosts(app: App): Promise<CostRecord[]> {
  try {
    const raw = await app.vault.adapter.read(COSTS_PATH);
    return parseJsonl<CostRecord>(raw.trim().split("\n").filter(Boolean));
  } catch {
    return []; // no costs recorded yet
  }
}

/** Whether a vault path is one of the two logs a run view renders. */
export function touchesRuns(p: string): boolean {
  return p === RUNS_PATH || p === COSTS_PATH;
}

export async function loadRuns(app: App, limit = 50): Promise<AgentRun[]> {
  try {
    const raw = await app.vault.adapter.read(RUNS_PATH);
    const lines = raw.trim().split("\n").filter(Boolean);
    return applyCosts(parseRuns(lines), await readCosts(app)).slice(-limit).reverse();
  } catch (err) {
    console.error("[agentic-os] failed to load runs:", err);
    return [];
  }
}

/**
 * Load every run whose started_at falls in the same calendar month (local time)
 * as `ref` (default: now), newest-first. Reads the full log rather than the
 * newest-N window, because a busy month can exceed loadRuns()'s cap and clip the
 * month-to-date total. Filtering by date keeps the result bounded to one month.
 */
export async function loadRunsForMonth(app: App, ref: Date = new Date()): Promise<AgentRun[]> {
  try {
    const raw = await app.vault.adapter.read(RUNS_PATH);
    const lines = raw.trim().split("\n").filter(Boolean);
    const y = ref.getFullYear();
    const m = ref.getMonth();
    const inMonth = applyCosts(parseRuns(lines), await readCosts(app)).filter((r) => {
      if (!r.started_at) return false;
      const d = new Date(r.started_at);
      return d.getFullYear() === y && d.getMonth() === m;
    });
    return inMonth.reverse(); // newest-first, matching loadRuns()
  } catch (err) {
    console.error("[agentic-os] failed to load month runs:", err);
    return [];
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs.toString().padStart(2, "0")}s`;
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
