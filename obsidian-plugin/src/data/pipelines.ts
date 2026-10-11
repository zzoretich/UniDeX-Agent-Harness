// Ledger reader + health classifier for brain/_index/pipelines.json
// (written by brain/scripts/lib/pipeline-report.js — keep shapes in lockstep).
// Pure core; the obsidian import below is TYPE-ONLY (erased at runtime) so
// node:test can import this module without resolving the "obsidian" external.
import type { App } from "obsidian";

export const PIPELINES_PATH = "brain/_index/pipelines.json";

export interface PipelineEntry {
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "running" | "ok" | "skipped" | "disabled" | "error";
  provider?: string | null;   // which provider ran the stage (contract §3)
  reason?: string | null;     // why it was skipped/disabled
  error: string | null;
  wrote: string[];
  counts: Record<string, number>;
  pid?: number;
}
export interface PipelineState { lastRun: PipelineEntry | null; history: PipelineEntry[]; }
export interface PipelinesFile { version: number; pipelines: Record<string, PipelineState>; }

// "neutral" = nothing to judge: never ran, or the stage is disabled by config (renders gray).
export type PipelineHealth = "ok" | "stale" | "failed" | "died" | "neutral";
export interface PipelineStatus {
  name: string;
  health: PipelineHealth;
  label: string;   // short chip text, e.g. "SCAN ok 2m"
  detail: string;  // tooltip/expanded text incl. error message when failed/died
  entry?: PipelineEntry;
}

// staleAfterMs: null disables age-based staleness entirely (on-demand pipelines).
export interface ClassifyCfg { staleAfterMs: number | null; diedAfterMs: number; }

export interface PipelineManifestEntry {
  short: string;                                       // chip prefix, e.g. "SCAN"
  staleMs: number | null;                              // null = never stale by age (on-demand stage)
  safeRerun: { script: string; args: string[] } | null; // one-click rerun the Fix Queue may offer
}

// The one place the plugin knows a pipeline's name, chip label, freshness window and safe
// rerun. Expected set = these keys ∪ whatever else the ledger contains. file-map and
// embed-vault are on-demand / provider-gated: elapsed time carries no signal, so their
// windows are null. file-map backlog surfaces through the Fix Queue's mapPending rows;
// embed-vault is ledgered `disabled` (reason no-embed) under the claude/none providers,
// which renders neutral. Its rerun is scan-vault.js, not embed-vault.js: the incremental
// embed is safe under ollama either way, but only scan-vault writes the `embed-vault`
// ledger row (scan-vault.js:449 withReport), so only scan-vault can clear the card.
export const PIPELINES_MANIFEST: Record<string, PipelineManifestEntry> = {
  "scan-vault":         { short: "SCAN",     staleMs: 45 * 60_000,           safeRerun: { script: "brain/scripts/scan-vault.js", args: ["--quiet"] } },
  "session-summary":    { short: "WRAP",     staleMs: 24 * 60 * 60_000,      safeRerun: null },
  "auto-cost":          { short: "COST",     staleMs: 24 * 60 * 60_000,      safeRerun: null },
  "auto-cost-backfill": { short: "BACKFILL", staleMs: 7 * 24 * 60 * 60_000,  safeRerun: { script: "brain/scripts/auto-cost.js", args: ["--backfill"] } },
  "heartbeat-writer":   { short: "STAFF",    staleMs: 45 * 60_000,           safeRerun: { script: "brain/scripts/heartbeat-writer.js", args: [] } },
  "file-map":           { short: "MAP",      staleMs: null,                  safeRerun: null },
  "auto-wrap":          { short: "AWRAP",    staleMs: 24 * 60 * 60_000,      safeRerun: null },
  "build-brain-md":     { short: "BRAIN",    staleMs: 45 * 60_000,           safeRerun: null },
  "embed-vault":        { short: "EMBED",    staleMs: null,                  safeRerun: { script: "brain/scripts/scan-vault.js", args: ["--quiet"] } },
  // graphify's structural pass (spec 2026-09-23-graphify D7): a scan-vault stage, ledgered `disabled` when the graph is
  // off or graphify is not installed. Freshness is `aos doctor`'s `graph fresh` row (graph.staleDays), so no window here.
  "graph-build":        { short: "GRAPH",    staleMs: null,                  safeRerun: { script: "brain/scripts/graph-build.js", args: ["--quiet"] } },
  // The semantic pass (spec D5/D10): daily, capped, spends money — so no one-click rerun; `aos graph build --semantic` asks first.
  "graph-semantic":     { short: "SEM",      staleMs: null,                  safeRerun: null },
  // The Brain hub's cache and the usage fold (spec 2026-10-11-brain-hub D12): a scan-vault stage like embed-vault, so
  // its rerun is the scan and freshness follows the scan's own window.
  "brain-hub":          { short: "HUB",      staleMs: null,                  safeRerun: { script: "brain/scripts/scan-vault.js", args: ["--quiet"] } },
};
const DIED_AFTER_MS = 10 * 60_000;

function ago(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 36 * 60 * 60_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function classifyPipeline(
  name: string, state: PipelineState | undefined, nowMs: number, cfg?: Partial<ClassifyCfg>
): PipelineStatus {
  const m = PIPELINES_MANIFEST[name];
  const short = m?.short ?? name.toUpperCase();
  const last = state?.lastRun ?? null;
  if (!last) return { name, health: "neutral", label: `${short} —`, detail: `${name}: no recorded runs yet` };

  // Explicit undefined checks, not ??: a configured `null` window means "never
  // stale by age" and must not fall through to the default.
  const staleAfter: number | null =
    cfg?.staleAfterMs !== undefined ? cfg.staleAfterMs
      : m ? m.staleMs
        : 60 * 60_000;
  const diedAfter = cfg?.diedAfterMs ?? DIED_AFTER_MS;
  const startMs = Date.parse(last.startedAt);
  const age = nowMs - startMs;

  // contract §5 / spec §12: `disabled` (turned off by config) and `skipped` (the stage ran and
  // decided there was nothing to do — daily cap, no signal, nothing to write) both mean "nothing
  // to judge". Both render gray with the reason on hover, and neither ever goes stale by age,
  // so the Fix Queue offers no card for either.
  if (last.status === "disabled" || last.status === "skipped") {
    const why = [last.reason ? ` — ${last.reason}` : "", last.provider ? ` (provider ${last.provider})` : ""].join("");
    return {
      name, health: "neutral", entry: last,
      label: `${short} ${last.status === "disabled" ? "off" : "skipped"}`,
      detail: `${name}: ${last.status}${why}`,
    };
  }
  if (last.status === "running") {
    if (age > diedAfter) {
      return { name, health: "died", entry: last,
        label: `${short} died`,
        detail: `${name}: started ${ago(age)} ago and never finished — process likely killed mid-run` };
    }
    return { name, health: "ok", entry: last, label: `${short} running`, detail: `${name}: in flight (${ago(age)})` };
  }
  if (last.status === "error") {
    return { name, health: "failed", entry: last,
      label: `${short} failed`,
      detail: `${name}: ${last.error ?? "unknown error"} (${ago(age)} ago)` };
  }
  if (staleAfter !== null && age > staleAfter) {
    return { name, health: "stale", entry: last,
      label: `${short} stale ${ago(age)}`,
      detail: `${name}: last ok run ${ago(age)} ago — past its ${Math.round(staleAfter / 60_000)}m freshness window` };
  }
  // Only `ok` reaches here: running, error, disabled and skipped all returned above.
  return { name, health: "ok", entry: last, label: `${short} ok ${ago(age)}`, detail: `${name}: ok, ${ago(age)} ago` };
}

export function pipelineStatuses(file: PipelinesFile | null, nowMs: number): PipelineStatus[] {
  const names = Object.keys(PIPELINES_MANIFEST);
  const known = new Set(names);
  for (const n of Object.keys(file?.pipelines ?? {})) if (!known.has(n)) names.push(n);
  return names.map((n) => classifyPipeline(n, file?.pipelines?.[n], nowMs));
}

// ── IO (the only function that touches Obsidian at runtime — via its param) ──
export async function loadPipelines(app: App): Promise<PipelinesFile | null> {
  try {
    const raw = await app.vault.adapter.read(PIPELINES_PATH);
    const parsed = JSON.parse(raw) as PipelinesFile;
    return parsed && parsed.pipelines ? parsed : null;
  } catch (err) {
    console.error("[agentic-os] failed to load pipelines ledger:", err);
    return null;
  }
}
