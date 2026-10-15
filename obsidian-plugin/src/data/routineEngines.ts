// routineEngines.ts — the Routines editor's engine and model choices for a prompt routine (local-first A6, A7), pure over
// what the HUD already reads: the config (provider, local.*, claude.model, routines.codexModel), provider-state.json's
// local cache (the models the engine served at its last check: the HUD never asks the engine itself), the enabled hosts
// (agenticos.json), Claude Code's models (the runtime's CLAUDE_MODELS in lib/settings-schema.js, mirrored here and
// pinned by the test) and the Codex catalog the app keeps (lib/host-catalog.js, through sessions.catalog()).
import type { HostCatalog } from "../host";
import type { ProviderState, SessionHost, VaultConfig } from "./aosConfig";
import { localUrl, sameModel } from "./localEngine";
import type { Routine, RoutineEngine } from "./routines";

/** lib/settings-schema.js CLAUDE_MODELS: the Claude models every Claude picker offers. */
export const CLAUDE_MODELS = ["haiku", "sonnet", "opus", "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-opus-5-5", "claude-fable-5-1"];

export const ENGINE_LABEL: Record<RoutineEngine, string> = { local: "Local · this Mac", claude: "Claude Code", codex: "Codex" };

/** The editor's note under the local engine (local-first A7, the plan's tool-calling risk). */
export const SMALL_MODEL_NOTE = "Runs on this Mac's model, free. Small local models can lose the thread on long, many-step routines: keep the steps few, or pick Claude Code or Codex for those.";

export interface Choice { value: string; label: string }

type EngineCfg = Pick<VaultConfig, "provider" | "local" | "ollama">;

/** The local engine is set up: background work runs on it (provider local or ollama), or the runtime saw it answer. */
export function localConfigured(cfg: EngineCfg, state: ProviderState | null): boolean {
  if (cfg.provider === "local" || cfg.provider === "ollama") return true;
  return state?.local?.reachable === true || state?.ollama?.reachable === true;
}

/**
 * The engine select: Default (routines.runner, which keeps today's resolution), Local when the local engine is set up,
 * and each enabled host. A value the routine already has stays offered, marked when this machine cannot run it, so
 * opening and saving a routine never changes its engine.
 */
export function engineChoices(cfg: EngineCfg, state: ProviderState | null, hosts: SessionHost[], current?: string | null): Choice[] {
  const out: Choice[] = [{ value: "", label: "Default (routines.runner)" }];
  const local = localConfigured(cfg, state);
  if (local || current === "local") out.push({ value: "local", label: ENGINE_LABEL.local + (local ? "" : " (not set up here)") });
  for (const h of ["claude", "codex"] as const) {
    const on = hosts.includes(h);
    if (on || current === h) out.push({ value: h, label: ENGINE_LABEL[h] + (on ? "" : " (not enabled here)") });
  }
  return out;
}

/** A new prompt routine starts on the local engine when it is set up; otherwise on the default runner. */
export function defaultEngine(cfg: EngineCfg, state: ProviderState | null): "" | "local" {
  return localConfigured(cfg, state) ? "local" : "";
}

/** The models the local engine served at its last check (provider-state.json), the embedders left out; null when unknown. */
export function pulledModels(cfg: EngineCfg, state: ProviderState | null): string[] | null {
  const cache = state?.local && state.local.url === localUrl(cfg) ? state.local : null;
  if (!cache || !Array.isArray(cache.models)) return null;
  return cache.models.filter((m) => typeof m === "string" && !/embed/i.test(m) && !sameModel(m, cfg.local.embedder));
}

/** Codex's listed models from the catalog, current ones first; [] when it has none. */
export function codexModels(catalog: HostCatalog | null): string[] {
  const entry = catalog?.hosts?.codex;
  if (!entry || !Array.isArray(entry.models)) return [];
  const ids = [...entry.models.filter((m) => m.main), ...entry.models.filter((m) => !m.main)].map((m) => m.id);
  return [...new Set(ids)];
}

interface ModelCfg extends EngineCfg { claude: { model: string }; routines: { codexModel?: string | null }; codex?: { model?: string | null } }

/**
 * The model select for `engine` ("" = the default runner, whose model is a Claude model by contract). The first choice is
 * blank: the engine's own default, named. The routine's current model is always kept, marked when it is not listed.
 */
export function modelChoices(engine: string, cfg: ModelCfg, state: ProviderState | null, catalog: HostCatalog | null, current?: string | null): Choice[] {
  const out: Choice[] = [];
  let listed: string[] = [];
  if (engine === "local") {
    const resolved = state?.model || cfg.local.model || null;
    out.push({ value: "", label: resolved ? `This Mac's model (${resolved})` : "This Mac's model (picked for its memory)" });
    const pulled = pulledModels(cfg, state);
    listed = pulled ?? [];
    for (const m of listed) out.push({ value: m, label: m });
    if (current && !listed.some((m) => sameModel(m, current))) out.push({ value: current, label: `${current}${pulled ? " (not downloaded)" : ""}` });
    return out;
  }
  if (engine === "codex") {
    const def = cfg.routines.codexModel || cfg.codex?.model || null;
    out.push({ value: "", label: def ? `routines.codexModel (${def})` : "Codex's own default" });
    listed = codexModels(catalog);
  } else {
    out.push({ value: "", label: `claude.model (${cfg.claude.model})` });
    listed = CLAUDE_MODELS;
  }
  for (const m of listed) out.push({ value: m, label: m });
  if (current && !listed.includes(current)) out.push({ value: current, label: `${current} (not listed)` });
  return out;
}

/** The engine pill's text and title on a prompt routine's row. */
export function enginePill(r: Pick<Routine, "engine" | "model">): { text: string; title: string } {
  const e = typeof r.engine === "string" && r.engine ? r.engine : null;
  const model = r.model ? ` · model ${r.model}` : "";
  return e ? { text: e, title: `engine: ${e}${model}` } : { text: "auto", title: `engine: routines.runner (auto)${model}` };
}

/** Fields only a prompt routine carries, dropped when the kind changes (writes stays for a duty, whose own rule it is). */
export function dropPromptOnly<T extends Partial<Routine>>(draft: T, kind: string): T {
  if (kind === "prompt") return draft;
  delete draft.engine; delete draft.maxTurns; delete draft.output;
  if (kind === "command") delete draft.writes;
  return draft;
}

/** Writes as the editor shows them (one per line) and back. */
export function writesText(writes: string[] | undefined): string { return (writes ?? []).join("\n"); }
export function parseWrites(text: string): string[] | undefined {
  const list = text.split("\n").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}
