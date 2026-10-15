// localEngine.ts — Settings ▸ Local engine (local-first A8, A13, A18, A3): what the local engine is, whether it answers,
// the model background work runs on (or would), the embedder, today's local calls and the session wraps waiting for it.
// Read from files the runtime writes: brain/config.json and agenticos.json (readVaultConfig), provider-state.json (the
// engine's 60 s cache of what it serves, the model that resolved, why it last could not), brain/_index/local-usage.json
// (sdk/lib/local-usage.js) and auto-wrap's spool (lib/wrap-queue.js). No probe: `aos local` asks the engine itself.
import * as path from "path";
import { fs } from "../host";
import type { ProviderState, VaultConfig } from "./aosConfig";

export const LOCAL_USAGE_PATH = "brain/_index/local-usage.json";
export const WRAP_QUEUE_PATH = "brain/_index/auto-wrap-pending.jsonl";

export type LocalState = "answering" | "missing" | "down" | "unknown";

export interface LocalEngineView {
  /** Background work runs on the local engine (provider local). */
  active: boolean;
  provider: string;
  engine: "ollama" | "openai";
  url: string;
  state: LocalState;
  /** One line: what the engine is doing, or what to do. */
  stateText: string;
  /** The model background work runs on: the one that resolved, else local.model, else null (picked for this Mac). */
  model: string | null;
  modelNote: string;
  /** Whether the engine serves it, by its last cache; null when not known. */
  pulled: boolean | null;
  embedder: string;
  embedderPulled: boolean | null;
  today: { calls: number; ms: number };
  queued: number;
  /** "Pull the model" downloads through Ollama; an OpenAI-compatible server's own app downloads its models. */
  canPull: boolean;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function localDay(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/** Ollama tag equality as ollama.js sameModel has it: a bare name is its `:latest`. */
export function sameModel(a: string, b: string): boolean {
  const n = (s: string) => (s.includes(":") ? s : `${s}:latest`);
  return n(a) === n(b);
}

/** Where the local engine answers (sdk/lib/local-config.js localCfg): local.url, else Ollama's address, else LM Studio's. */
export function localUrl(cfg: Pick<VaultConfig, "local" | "ollama">): string {
  const set = typeof cfg.local.url === "string" && cfg.local.url.trim() ? cfg.local.url.trim().replace(/\/+$/, "") : null;
  if (set) return set;
  return cfg.local.engine === "openai" ? "http://127.0.0.1:1234/v1" : `http://${cfg.ollama.host || "127.0.0.1"}:${cfg.ollama.port || 11434}`;
}

/** Today's calls and time from local-usage.json's text; zeros when there is none. */
export function usageToday(text: string | null, now: Date): { calls: number; ms: number } {
  try {
    const j = JSON.parse(text ?? "") as { days?: Record<string, { calls?: unknown; ms?: unknown }> };
    const d = j.days?.[localDay(now)];
    return { calls: Number(d?.calls) || 0, ms: Number(d?.ms) || 0 };
  } catch { return { calls: 0, ms: 0 }; }
}

/** The view, pure over the config, the provider state, today's usage and the spool's length. */
export function localEngineView(cfg: Pick<VaultConfig, "provider" | "local" | "ollama">, state: ProviderState | null, today: { calls: number; ms: number }, queued: number): LocalEngineView {
  const active = cfg.provider === "local";
  const engine = cfg.local.engine === "openai" ? "openai" : "ollama";
  const url = localUrl(cfg);
  const cache = state?.local && state.local.url === url ? state.local : null;
  const models = Array.isArray(cache?.models) ? cache!.models : null;
  const model = (active && state?.model) || cfg.local.model || null;
  const has = (tag: string | null): boolean | null => (!tag || !models ? null : models.some((m) => sameModel(m, tag)));
  const pulled = model ? has(model) : cache && cache.reachable && active ? state?.localReason === "local-ready" : null;
  const embedderPulled = has(cfg.local.embedder);
  let st: LocalState = "unknown";
  if (cache && cache.reachable === false) st = "down";
  else if (active && state?.localReason === "local-down") st = "down";
  else if (active && state?.localReason === "local-model-missing") st = "missing";
  else if (cache && cache.reachable) st = pulled === false ? "missing" : "answering";
  const name = engine === "openai" ? "the OpenAI-compatible server" : "Ollama";
  const stateText = !active
    ? `Background work runs on ${cfg.provider}; the local engine runs it under provider local.`
    : st === "down" ? `${name} is not answering at ${url}: background work waits or uses heuristics, and session wraps queue up.`
      : st === "missing" ? `${name} answers, but the model is not downloaded yet: Pull the model.`
        : st === "answering" ? `${name} answers at ${url}.`
          : "Not checked yet: the next background call asks it.";
  const modelNote = model
    ? (cfg.local.model ? "set in local.model" : "picked for this Mac's memory") + (pulled === false ? " · not downloaded" : pulled ? " · downloaded" : "")
    : "picked for this Mac's memory when it first runs (qwen3.5:4b under 12 GB, else qwen3.5:9b)";
  return {
    active, provider: cfg.provider, engine, url, state: st, stateText, model, modelNote, pulled,
    embedder: cfg.local.embedder, embedderPulled, today, queued, canPull: engine === "ollama",
  };
}

/** "12 local calls today · 48 s" */
export function todayText(t: { calls: number; ms: number }): string {
  return `${t.calls} local call${t.calls === 1 ? "" : "s"} today${t.calls ? ` · ${Math.round(t.ms / 1000)} s` : ""}`;
}

/** Reads local-usage.json and the spool from the vault; a missing file is zero. */
export function readLocalFiles(vault: string, now: Date): { today: { calls: number; ms: number }; queued: number } {
  let usage: string | null = null;
  try { usage = fs.readFileSync(path.join(vault, LOCAL_USAGE_PATH), "utf8"); } catch { usage = null; }
  let queued = 0;
  try { queued = fs.readFileSync(path.join(vault, WRAP_QUEUE_PATH), "utf8").split("\n").filter((l) => l.trim()).length; } catch { queued = 0; }
  return { today: usageToday(usage, now), queued };
}
