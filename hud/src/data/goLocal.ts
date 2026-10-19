// goLocal.ts — what the Go-local card and Settings read about `aos migrate local-first` (spec 2026-10-14-local-first A9;
// install-import B12; guided-tour C11): brain/_index/migrations.json as the runtime writes it (cli/migrations.js), the
// background spend of the last seven days from the ledger, the Chief of Staff's models worded for this Mac's hosts, and
// the argv the `migrate` surface admits (app/src/shared/surfaces.ts). Pure but for readMigrations, so node:test can load it.
import * as path from "path";
import { fs } from "../host";
import { VAULT_CONFIG_DEFAULTS, type SessionHost } from "./aosConfig";

export const MIGRATIONS_PATH = "brain/_index/migrations.json";
export const SPEND_PATH = "brain/_index/provider-spend.jsonl";

/** `applying`: an apply that stopped half way (cli/migrations.js); its backup is recorded, so Undo works on it too. */
export type MigrationState = "pending" | "applying" | "applied" | "declined" | "undone";
export interface MigrationRow { id: string; state: MigrationState; at: string | null; backup: string | null }
const STATES: readonly string[] = ["pending", "applying", "applied", "declined", "undone"];

/** migrations.json's rows by id; anything that does not parse is no row (the runtime rewrites the file). */
export function parseMigrations(text: string | null): Record<string, MigrationRow> {
  const out: Record<string, MigrationRow> = {};
  let j: unknown;
  try { j = JSON.parse(text ?? ""); } catch { return out; }
  const list = (j as { migrations?: unknown } | null)?.migrations;
  if (!Array.isArray(list)) return out;
  for (const m of list as Array<Record<string, unknown>>) {
    if (!m || typeof m.id !== "string" || !STATES.includes(String(m.state))) continue;
    out[m.id] = { id: m.id, state: m.state as MigrationState, at: typeof m.at === "string" ? m.at : null, backup: typeof m.backup === "string" ? m.backup : null };
  }
  return out;
}

export function readMigrations(vault: string): Record<string, MigrationRow> {
  let text: string | null = null;
  try { text = fs.readFileSync(path.join(vault, MIGRATIONS_PATH), "utf8"); } catch { text = null; }
  return parseMigrations(text);
}

/**
 * The ledger families that move to this Mac (local-first §4's routing table): background hooks, the reasoner's AI
 * features and the graph's pass. Duties, routines, cross-review, team seats and Sessions stay on the hosts.
 */
const STAYS_HOSTED = [/^duty:/, /^routine:/, /^cross-review:/, /^team:/, /^session:/];

/** USD and calls of the last `days` local days (today included) for the work that would move local. */
export function backgroundSpend(text: string | null, now: Date, days = 7): { usd: number; calls: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
  let usd = 0;
  let calls = 0;
  for (const line of (text ?? "").split("\n")) {
    let r: { ts?: unknown; usd?: unknown; feature?: unknown; provider?: unknown };
    try { r = JSON.parse(line); } catch { continue; }
    const t = Date.parse(String(r?.ts));
    if (!Number.isFinite(t) || t < start || t > now.getTime() + 60_000) continue;
    if (STAYS_HOSTED.some((re) => re.test(String(r.feature ?? "")))) continue;
    if (r.provider === "ollama") continue;
    calls++;
    if (typeof r.usd === "number" && Number.isFinite(r.usd)) usd += r.usd;
  }
  return { usd: Math.round(usd * 100) / 100, calls };
}

/** The Chief of Staff's model per host (sdk/lib/models.js CHIEF, the same two config.default.json carries). */
export const CHIEF_MODELS: Record<SessionHost, { model: string; label: string; host: string }> = {
  claude: { model: VAULT_CONFIG_DEFAULTS.persona.model ?? "claude-opus-5-5", label: "Opus 5.5", host: "Claude Code" },
  codex: { model: VAULT_CONFIG_DEFAULTS.persona.codexModel ?? "gpt-6-sol", label: "gpt-6-sol", host: "Codex" },
};

/**
 * The card's checkbox, worded for the hosts this Mac runs (both, or none, name both models). Until it is ticked the duties
 * keep what the upgrade pinned (cli/migrations.js PRE_2_0: the model they ran on, no failover); `--chief` moves the models
 * and turns the failover on, which with both hosts the box says.
 */
export function chiefChoice(hosts: readonly SessionHost[]): string {
  if (hosts.length === 1) return `Move the Chief of Staff to ${CHIEF_MODELS[hosts[0]].label}`;
  if (hosts.length === 2) return `Move the Chief of Staff to ${CHIEF_MODELS.claude.label} on Claude Code and ${CHIEF_MODELS.codex.label} on Codex, each standing in when the other cannot start a duty`;
  return `Move the Chief of Staff to ${CHIEF_MODELS.claude.label} / ${CHIEF_MODELS.codex.label} when you add a host`;
}

/** Who stays hosted, by name: "Claude Code", "Codex", "Claude Code and Codex", or "Claude Code or Codex" with none yet. */
export function hostedName(hosts: readonly SessionHost[]): string {
  if (hosts.length === 1) return CHIEF_MODELS[hosts[0]].host;
  return hosts.length === 2 ? "Claude Code and Codex" : "Claude Code or Codex, once you add one";
}

/** What moves to this Mac and what stays hosted (local-first §4, A1, A2). */
export const MOVES_LOCAL: readonly string[] = [
  "Session summaries, memory extraction and the wrap at the end of a session",
  "Workspace insights and file maps, embeddings and recall",
  "The Pulse briefing and the knowledge graph's semantic pass",
  "Merge with AI, the Brain sweep, Ask brain, the weekly reflection, Consolidate and Vault chat (each can switch back in Settings)",
];
export function staysHosted(hosts: readonly SessionHost[]): string[] {
  return [
    `Sessions, the Code tab's agents, cross-review and agent teams, on ${hostedName(hosts)}`,
    "Your Chief of Staff's duties (the hourly check triages on this Mac first and wakes it only for a real change)",
  ];
}

/** The `aos migrate local-first` argv the `migrate` surface admits. */
export function migrateArgs(action: "apply" | "decline" | "undo", chief = false): string[] {
  return ["migrate", "local-first", `--${action}`, ...(action === "apply" && chief ? ["--chief"] : []), "--json"];
}

/** The same, as a user types it in the Code tab (the card's fallback while the surface is off). */
export function migrateCommand(action: "apply" | "decline" | "undo", chief = false): string {
  return `aos ${migrateArgs(action, chief).filter((a) => a !== "--json").join(" ")}`;
}

/** "$4.20 over 38 calls" — or "nothing" when nothing was spent. */
export function spendText(s: { usd: number; calls: number }): string {
  if (!s.calls) return "nothing: background work spent no money in the last 7 days";
  return `$${s.usd.toFixed(2)} over ${s.calls} call${s.calls === 1 ? "" : "s"} in the last 7 days; on this Mac it costs nothing`;
}
