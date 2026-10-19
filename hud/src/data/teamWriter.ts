// teamWriter.ts — the Agent Teams tab's only write path (spec 2026-09-28-agent-teams-design D3, D4, D12). Every change runs
// `aos team`, the vendored brain/scripts/team.js, through runAos with its `cli` override and waits for the CLI's verdict:
// the tab never writes persona/teams/ itself, and the file event re-renders. Each board write sends the `ts` of the row
// the user saw as --expect, so a card drawn before someone else's decision is refused rather than overwriting it.
// Pure argument builders plus one runner, so tests drive the real team.js against a copy of the fixture vault.
import * as path from "path";
import { runAos, runAosJson } from "./aosRun";
import type { AosRunOptions, AosResult, AosJsonResult, SpawnFn } from "./aosRun";
import { BoardItem, expectOf } from "./teams";

/** The vendored team CLI, relative to the vault (`aos upgrade` copies brain/scripts). */
export const TEAM_CLI = "brain/scripts/team.js";

export interface TeamRunner {
  run(args: string[]): Promise<AosResult>;
  json<T>(args: string[]): Promise<AosJsonResult<T>>;
}

/** Runs team.js in the vault (or `o.cli`, for tests) with AOS_VAULT and AOS_CONFIG pinned, as runAos does. */
export function teamRunner(o: AosRunOptions, spawnFn?: SpawnFn): TeamRunner {
  const opts = { ...o, cli: o.cli ?? path.join(o.vault, TEAM_CLI) };
  return { run: (args) => runAos(args, opts, spawnFn), json: <T>(args: string[]) => runAosJson<T>(args, opts, spawnFn) };
}

// ── the verbs the tab uses ──

/** `list --json` sweeps killed runs (every team verb does) and names the presets `set` accepts. */
export const LIST_ARGS = ["list", "--json"];
export const INIT_ARGS = ["init"];

/** Approve the pending gate the card shows; a budget gate carries the amount the user picked. */
export function approveArgs(team: string, it: BoardItem, usd?: number | null): string[] {
  return ["gate", "approve", team, it.id, "--expect", expectOf(it), ...(usd != null ? ["--usd", String(usd)] : [])];
}
export function budgetArgs(team: string, it: BoardItem, usd: number): string[] {
  return ["budget", team, it.id, String(usd), "--expect", expectOf(it)];
}
export function pauseArgs(team: string, paused: boolean, member?: string): string[] {
  return [paused ? "pause" : "resume", team, ...(member ? [member] : [])];
}
export function setArgs(team: string, member: string, key: "provider" | "model" | "effort", value: string): string[] {
  return ["set", team, member, key, value];
}
export function addMemberArgs(team: string, agent: string): string[] { return ["member", "add", team, agent]; }
export function removeMemberArgs(team: string, member: string): string[] { return ["member", "remove", team, member]; }

/**
 * A note from the user to the lead: `@<lead>` leads the text, so the lead sees it addressed to them and team.js never
 * reads the text as a flag. Null for an empty message. The text goes as one argv entry, never through a shell.
 */
export function postArgs(team: string, lead: string, text: string): string[] | null {
  const body = text.trim();
  if (!body) return null;
  const to = `@${lead}`;
  const addressed = body === to || body.startsWith(`${to} `) ? body : `${to} ${body}`;
  return ["post", team, "--from", "user", "--kind", "note", addressed];
}

// ── what the CLI says back ──

export interface Presets {
  provider: string[]; model: string[]; effort: string[];
  /** Which models each provider runs; null from a runtime that does not say, when every model is offered. */
  models: { claude: string[]; codex: string[] } | null;
}
export interface ListJson { schema: 1; teams: { team: string; error?: string }[]; presets?: Record<string, unknown> }

/** The presets from `list --json`; null when this vault's runtime predates them (the pickers then show values only). */
export function presetsOf(j: ListJson | null): Presets | null {
  const p = j && j.presets;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  const provider = arr(p?.provider), model = arr(p?.model), effort = arr(p?.effort);
  const m = p && typeof p.models === "object" && p.models ? p.models as Record<string, unknown> : null;
  const claude = arr(m?.claude), codex = arr(m?.codex);
  return provider && model && effort ? { provider, model, effort, models: claude && codex ? { claude, codex } : null } : null;
}

/**
 * The models a seat's picker offers: `inherit` and its provider's own models (a seat on one provider ignores the other's,
 * team-run.js modelFor); an `opposite` seat runs on either, so it gets both. Every preset when the runtime does not say.
 */
export function modelChoices(p: Presets, provider: string | null): string[] {
  if (!p.models) return p.model;
  const own = provider === "claude" ? p.models.claude : provider === "codex" ? p.models.codex : [...p.models.claude, ...p.models.codex];
  return p.model.filter((v) => v === "inherit" || own.includes(v));
}

/** What a seat's model setting does on its provider: null when it is used, else what runs instead. */
export function ignoredModel(p: Presets, provider: string | null, model: string | null): string | null {
  if (!p.models || !model || model === "inherit" || provider === "opposite") return null;
  const own = provider === "codex" ? p.models.codex : p.models.claude;
  return own.includes(model) ? null : `not a ${provider === "codex" ? "Codex" : "Claude"} model: the ${provider === "codex" ? "Codex" : "Claude Code"} default runs`;
}

export interface TeamFailure { text: string; stale: boolean; upgrade: boolean }

/**
 * The one line to show for a refused or failed write. A stale --expect says the card was out of date; a runtime without
 * team.js asks for `aos upgrade`. The sweep's "found a killed run" lines are news, not the failure.
 */
export function teamFailure(r: AosResult): TeamFailure {
  if (r.timedOut) return { text: "aos team did not answer in time", stale: false, upgrade: false };
  if (r.error) return { text: `could not run aos team: ${r.error}`, stale: false, upgrade: false };
  if (/Cannot find module|MODULE_NOT_FOUND/.test(r.stderr)) {
    return { text: "this vault's runtime has no aos team yet: run aos upgrade", stale: false, upgrade: true };
  }
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const own = lines.filter((l) => l.startsWith("team: ") && !l.startsWith("team: found a killed run")).pop();
  const text = (own ?? lines[0] ?? `aos team exited ${r.code}`).replace(/^team: (refused: )?/, "");
  const stale = /^--expect failed on (\S+):/.exec(text);
  if (stale) return { text: `${stale[1]} changed after this view was drawn, so nothing was written. The tab now shows it as it is.`, stale: true, upgrade: false };
  return { text, stale: false, upgrade: false };
}
