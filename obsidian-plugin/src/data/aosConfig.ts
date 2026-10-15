// aosConfig.ts — the plugin-side readers for the three config surfaces the brain
// scripts use. Pure (fs/os/path only) so node:test can load it.
//   <configDir>/agenticos.json              written by `aos init`      (contract §2)
//   <vault>/brain/config.json               user-editable product config (contract §1 Config)
//   <vault>/brain/_index/provider-state.json written by sdk/lib/provider.js (contract §3)
// VAULT_CONFIG_DEFAULTS is a verbatim copy of brain/scripts/config.default.json as it stands
// after Plan 2 Task 3 (contract §1 shape + scan.fileMapBudgetUnderClaude); the merge order
// (defaults ← vault config ← agenticos.json) matches lib/config.js loadConfig().
import * as path from "path";
import { env, fs } from "../host";

export type ProviderName = "ollama" | "claude" | "codex" | "none";
export type ProviderMode = ProviderName | "auto" | "local";

export interface AgenticosJson {
  version?: string;
  vault?: string;
  node?: string;
  claudeConfigDir?: string;
  provider?: ProviderMode;
  // bin: the absolute `claude` path aos init/upgrade resolved (contract §2, Task 0); absent in configs written before Plan 4.
  claude?: { model?: string; perCallUsd?: number; perDayUsd?: number; bin?: string };
  // The codex provider (design D9): model null = the user's own Codex default; caps over the same hook ledger.
  codex?: { model?: string | null; perCallUsd?: number; perDayUsd?: number; bin?: string };
  // The hosts a session may run under (design D1); absent in configs written before hosts existed (Claude-only).
  hosts?: { claude?: { enabled?: boolean; configDir?: string; bin?: string }; codex?: { enabled?: boolean; home?: string; bin?: string; install?: "plugin" | "direct" } };
  reasoner?: { model?: string; perCallUsd?: number; perDayUsd?: number; effort?: string };
  ollama?: { host?: string; port?: number };
  local?: { engine?: "ollama" | "openai"; url?: string | null; model?: string | null; embedder?: string; keepAlive?: string | number | null; hostedFallback?: boolean; onBattery?: "defer" | "run" };
  telemetry?: { enabled?: boolean; redact?: boolean; retentionDays?: number; staleAfterMinutes?: number };
  updates?: { check?: boolean; intervalHours?: number };
  cost?: { enabled?: boolean; monthlyBudget?: number | null };
  persona?: { enabled?: boolean };
  routines?: { enabled?: boolean; perRunUsd?: number; perDayUsd?: number; tools?: string; externalLabels?: string[] };
}

export interface OrchestratorEntry { nickname?: string; trigger?: string; match?: string }

export interface VaultConfig {
  dailyNote: { layout: string };
  recallRoots: string[];
  quickLinks: string[];
  roster: { orchestrators: Record<string, OrchestratorEntry> };
  scan: { fileMapBudget: number; embedBudget: number; fileMapBudgetUnderClaude: number; insightsUnderClaude: boolean; fileMapBudgetUnderCodex: number; insightsUnderCodex: boolean; autoSweepOrphans: boolean };
  // The Stop hook's working-memory summary: every N typed prompts per session, at most every M minutes (0 = no floor).
  summary: { everyPrompts: number; minMinutes: number };
  provider: ProviderMode;
  claude: { model: string; perCallUsd: number; perDayUsd: number };
  codex: { model: string | null; effort: string; perCallUsd: number; perDayUsd: number };
  // The reasoner role: a Claude model with its own caps (reason:* ledger rows), used by the Chat tab; codexModel when Codex answers it.
  reasoner: { model: string; codexModel: string | null; perCallUsd: number; perDayUsd: number; effort: string };
  ollama: { host: string; port: number };
  // local-first A11: the local engine every background call runs on. model null = the Mac's RAM tier; keepAlive null = tiered.
  local: { engine: "ollama" | "openai"; url: string | null; model: string | null; embedder: string; keepAlive: string | number | null; hostedFallback: boolean; onBattery: "defer" | "run" };
  telemetry: { enabled: boolean; redact: boolean; retentionDays: number; staleAfterMinutes: number };
  updates: { check: boolean; intervalHours: number };
  cost: { enabled: boolean; monthlyBudget: number | null };
  graph: { enabled: boolean; out: string; timeoutSec: number; staleDays: number; semantic: { enabled: boolean | "auto"; runner: "auto" | "claude" | "codex"; everyHours: number; perCallUsd: number; perDayUsd: number; tokenBudget: number; timeoutSec: number } };
  notifications: { osAlert: boolean; retentionDays: number; maxPerSenderPerHour: number };
  persona: { enabled: boolean; runner: "auto" | "claude" | "codex"; model: string | null; effort: "low" | "medium" | "high" | null; codexModel: string | null; failover: boolean; perDutyUsd: number; perDayUsd: number; watchdog: { graceMinutes: number; notify: boolean }; tick: { flagAgeDays: number; earlyReflect: { corrections: number; dutyFailures: number } }; autoapply: { minVerified: number }; briefing: { enabled: boolean; staleHours: number } };
  // Routines (brain/routines/*.md): caps for the prompt kind and the launchd labels the Routines tab lists read-only.
  routines: { enabled: boolean; runner: "auto" | "claude" | "codex"; codexModel: string | null; perRunUsd: number; perDayUsd: number; tools: string; externalLabels: string[] };
  // Cross-review and handoff (spec 2026-09-23-cross-review D8): the HUD does not read these yet; mirrored so the defaults stay whole.
  crossReview: { enabled: boolean; claudeModel: string | null; codexModel: string | null; effort: string | null; perCallUsd: number; perDayUsd: number; timeoutSec: number; rounds: number };
  // Sessions (spec 2026-10-07-unidex-sessions S6): what a turn and a day of agent sessions may spend.
  sessions: { perTurnUsd: number; perDayUsd: number };
  // Spaces (spec 2026-10-09-spaces-redesign D30): the scan works these out; the HUD reads the results in snapshot.json.
  workspaces: { activeDays: number; idleDays: number; commits: number; recentSessions: number; ignoreCommitSubjects: string[]; attributeByFiles: boolean };
  memory: { usageDays: number; neverUsedDays: number; dupScore: number; clusterMin: number; mapMin: number };
  // Universal skills (spec 2026-09-23-universal-skills D6): the Skills tab reads the runtime's cache, not these; mirrored so the defaults stay whole.
  skills: { sync: boolean; exclude: string[] };
  // Universal agents (spec 2026-09-23-universal-agents D6): the Agents tab reads the runtime's cache, not these; mirrored likewise.
  agents: { sync: boolean; exclude: string[] };
  // The status line (spec 2026-09-28-statusline-design): the status bar reads the runtime's statusline.json, not these.
  statusline: { segments: string[]; links: boolean; chainPosition: "top" | "bottom"; subagents: boolean; refreshSeconds: number; codexItems: string[] };
}

export interface ProviderState {
  checkedAt: string;
  name: ProviderName;
  reason: string;
  ollama?: { reachable: boolean; checkedAt: string };
  // bin is `null` in the file whenever provider.js probed and found no CLI (contract §3), so the
  // type must admit null as well as absence; every reader guards with a truthiness check.
  claude?: { loggedIn: boolean; checkedAt: string; bin?: string | null };
  codex?: { loggedIn: boolean; checkedAt: string; bin?: string | null };
}

export const VAULT_CONFIG_DEFAULTS: VaultConfig = {
  dailyNote: { layout: "{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md" },
  recallRoots: ["brain/memory", "brain/patterns", "persona/journal", "brain/notifications"],
  quickLinks: [
    "- Memory index: `MEMORY.md` (root) · Working memory: [[SESSION]]",
    "- Projects: `brain/memory/projects/` · Reference: `brain/memory/reference/` · Patterns: `brain/patterns/`",
    "- Daily logs: `<year>/<year>-<month>/<date>.md`",
  ],
  roster: { orchestrators: {} },
  scan: { fileMapBudget: 40, embedBudget: 40, fileMapBudgetUnderClaude: 0, insightsUnderClaude: false, fileMapBudgetUnderCodex: 0, insightsUnderCodex: false, autoSweepOrphans: false },
  summary: { everyPrompts: 10, minMinutes: 15 },
  provider: "local",
  claude: { model: "haiku", perCallUsd: 0.05, perDayUsd: 0.5 },
  codex: { model: null, effort: "low", perCallUsd: 0.05, perDayUsd: 0.5 },
  reasoner: { model: "claude-opus-5", codexModel: null, perCallUsd: 0.5, perDayUsd: 5.0, effort: "medium" },
  ollama: { host: "127.0.0.1", port: 11434 },
  local: { engine: "ollama", url: null, model: null, embedder: "qwen3-embedding:0.6b", keepAlive: null, hostedFallback: false, onBattery: "defer" },
  telemetry: { enabled: true, redact: true, retentionDays: 30, staleAfterMinutes: 30 },
  updates: { check: true, intervalHours: 24 },
  cost: { enabled: false, monthlyBudget: null },
  graph: { enabled: true, out: "brain/graphify-out", timeoutSec: 120, staleDays: 7, semantic: { enabled: "auto", runner: "auto", everyHours: 24, perCallUsd: 0.25, perDayUsd: 1.0, tokenBudget: 20000, timeoutSec: 1800 } },
  notifications: { osAlert: true, retentionDays: 30, maxPerSenderPerHour: 6 },
  persona: { enabled: true, runner: "auto", model: "claude-opus-5-5", effort: null, codexModel: "gpt-6-sol", failover: true, perDutyUsd: 2.0, perDayUsd: 6.0, watchdog: { graceMinutes: 45, notify: true }, tick: { flagAgeDays: 7, earlyReflect: { corrections: 3, dutyFailures: 2 } }, autoapply: { minVerified: 3 }, briefing: { enabled: true, staleHours: 3 } },
  routines: { enabled: true, runner: "auto", codexModel: null, perRunUsd: 2.0, perDayUsd: 6.0, tools: "Read,Glob,Grep", externalLabels: [] },
  crossReview: { enabled: true, claudeModel: null, codexModel: null, effort: null, perCallUsd: 3.0, perDayUsd: 10.0, timeoutSec: 600, rounds: 5 },
  sessions: { perTurnUsd: 1.0, perDayUsd: 10.0 },
  workspaces: { activeDays: 7, idleDays: 30, commits: 10, recentSessions: 12, ignoreCommitSubjects: ["^vault backup:"], attributeByFiles: true },
  memory: { usageDays: 90, neverUsedDays: 30, dupScore: 0.8, clusterMin: 3, mapMin: 8 },
  skills: { sync: true, exclude: [] },
  agents: { sync: true, exclude: [] },
  statusline: {
    segments: ["needs-you", "runs", "spend", "health"], links: true, chainPosition: "top", subagents: true, refreshSeconds: 5,
    codexItems: ["model-with-reasoning", "task-progress", "project-name", "git-branch", "context-used", "five-hour-limit", "weekly-limit"],
  },
};

export const PROVIDER_STATE_PATH = "brain/_index/provider-state.json";
export const VAULT_CONFIG_PATH = "brain/config.json";

export type SessionHost = "claude" | "codex";

/** The hosts a session may run under: `hosts.<h>.enabled` not false. A config without `hosts` predates Codex (Claude only). */
export function sessionHosts(cfg: AgenticosJson | null): SessionHost[] {
  const h = cfg && cfg.hosts;
  if (!h) return ["claude"];
  return (["claude", "codex"] as SessionHost[]).filter((k) => !!h[k] && h[k]!.enabled !== false);
}

/** How the user invokes a plugin command on `host`: Claude Code `/name`; Codex `$agenticos:name`, or `$name` when wired directly. */
export function invocation(name: string, host: SessionHost, cfg: AgenticosJson | null): string {
  if (host === "claude") return `/${name}`;
  return cfg?.hosts?.codex?.install === "direct" ? `$${name}` : `$agenticos:${name}`;
}

/** The invocation for every enabled host, for UI text: "/todo", "$agenticos:todo", or "/todo (Claude Code) or $agenticos:todo (Codex)". */
export function invocationHint(name: string, cfg: AgenticosJson | null): string {
  const hosts = sessionHosts(cfg);
  if (hosts.length === 1) return invocation(name, hosts[0], cfg);
  if (!hosts.length) return `/${name}`;
  return `${invocation(name, "claude", cfg)} (Claude Code) or ${invocation(name, "codex", cfg)} (Codex)`;
}

/**
 * What the Proposals tab's review button types into a fresh terminal: the persona-flag-closer skill in the user's first
 * host. The Codex form is single-quoted, or the shell would expand `$agenticos` to nothing.
 */
export function reviewCommand(cfg: AgenticosJson | null): { host: SessionHost; label: string; command: string } {
  const host = sessionHosts(cfg)[0] || "claude";
  if (host === "codex") return { host, label: "Review in Codex ❯_", command: `codex '${invocation("persona-flag-closer", "codex", cfg)}'` };
  return { host, label: "Review in Claude ❯_", command: 'claude "review persona flags"' };
}

export function claudeConfigDir(): string {
  return path.resolve(env.get("CLAUDE_CONFIG_DIR") || path.join(env.homedir(), ".claude"));
}

/**
 * Where agenticos.json lives. `configDir` is Plugin.claudeConfigDir() (Task 3) — the setting,
 * then agenticos.json's own claudeConfigDir, then the env chain — so a plugin read never
 * disagrees with the folder the settings tab names. Omitted, this is the env chain alone.
 * $AOS_CONFIG still outranks both: it names the file directly (the CLI/test knob).
 */
export function agenticosJsonPath(configDir?: string): string {
  return path.resolve(env.get("AOS_CONFIG") || path.join(configDir || claudeConfigDir(), "agenticos.json"));
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return null; }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge<T extends object>(base: T, over: unknown): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (!isPlainObject(over)) return out as T;
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

export function readAgenticosJson(configDir?: string): AgenticosJson | null {
  const j = readJson<unknown>(agenticosJsonPath(configDir));
  return isPlainObject(j) ? (j as AgenticosJson) : null;
}

export function readVaultConfig(vaultRoot: string, configDir?: string): VaultConfig {
  const vaultCfg = readJson<unknown>(path.join(vaultRoot, VAULT_CONFIG_PATH)) ?? {};
  const userCfg = readAgenticosJson(configDir) ?? {};
  // structuredClone so an untouched nested subtree (e.g. VAULT_CONFIG_DEFAULTS.roster) is never
  // handed out by reference — contract §1 requires the same of the scripts' loadConfig().
  return structuredClone(deepMerge(deepMerge(VAULT_CONFIG_DEFAULTS, vaultCfg), userCfg));
}

export function dailyNoteLayout(vaultRoot: string): string {
  return readVaultConfig(vaultRoot).dailyNote.layout;
}

export function readProviderState(vaultRoot: string): ProviderState | null {
  const s = readJson<unknown>(path.join(vaultRoot, PROVIDER_STATE_PATH));
  if (!isPlainObject(s) || typeof s.name !== "string") return null;
  return s as unknown as ProviderState;
}

export const PERSONA_IDENTITY_PATH = "persona/IDENTITY.md";

/**
 * The agent's chosen name (contract §6): the first Markdown H1 of <vault>/persona/IDENTITY.md,
 * which `aos init` renders from identity.template.md with {{AGENT_NAME}}. null when the persona
 * layer is absent or the file has no H1 — callers fall back to a neutral label.
 */
export function personaName(vaultRoot: string): string | null {
  let text: string;
  try { text = fs.readFileSync(path.join(vaultRoot, PERSONA_IDENTITY_PATH), "utf8"); } catch { return null; }
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(text);
  return m ? m[1] : null;
}
