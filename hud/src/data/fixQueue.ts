// Rules → one-click repairs. Pure: inputs in, FixAction[] out.
// PulseTab executes: spawn → plugin.runBrainScript(script, args);
// anchor-modal → AnchorModal; open-file → workspace.openLinkText.
import { PipelineStatus, PIPELINES_MANIFEST } from "./pipelines";

export interface FixAction {
  id: string;
  title: string;
  detail: string;
  severity: "error" | "warn" | "info";
  kind: "spawn" | "anchor-modal" | "open-file";
  script?: string;
  args?: string[];
  path?: string;
}

export interface FixQueueInputs {
  statuses: PipelineStatus[];
  costMonth: string | null;     // cost-budget.json month, e.g. "2026-08"
  currentMonth: string;         // "YYYY-MM" now
  calibration: number | null;
  uncostedRuns: number;         // this-month runs with no cost_usd
  healthErrors: number;         // snapshot health error count
  staleArtifacts: number;       // snapshot health issues with area === "artifacts"
  mapPending?: { workspace: string; pending: number }[];  // per-workspace unmapped counts
  costEnabled?: boolean;        // default true; false → no anchor / backfill cards (cost module off or no budget)
}

export function buildFixQueue(i: FixQueueInputs): FixAction[] {
  const out: FixAction[] = [];
  const costOn = i.costEnabled !== false;

  for (const s of i.statuses) {
    if (s.health === "ok" || s.health === "neutral") continue;
    const rerun = PIPELINES_MANIFEST[s.name]?.safeRerun ?? null;
    if ((s.health === "stale" || s.health === "failed" || s.health === "died") && rerun) {
      out.push({
        id: s.name === "scan-vault" ? "run-scan" : `rerun-${s.name}`,
        title: s.health === "stale" ? `${s.name} is stale` : `${s.name} ${s.health}`,
        detail: s.detail, severity: s.health === "stale" ? "warn" : "error",
        kind: "spawn", script: rerun.script, args: rerun.args,
      });
    } else {
      // Not safely re-runnable from a button (needs a session/stdin) — surface loudly.
      out.push({
        id: `pipeline-${s.name}`, title: `${s.name} ${s.health}`, detail: s.detail,
        severity: s.health === "stale" ? "warn" : "error",
        kind: "open-file", path: "brain/_index/health.md",
      });
    }
  }

  // Requires an anchored month: you cannot RE-anchor what was never anchored — the
  // never-anchored case is anchor-first's job below, exclusively.
  if (costOn && i.costMonth !== null && (i.costMonth !== i.currentMonth || (typeof i.calibration === "number" && i.calibration <= 0))) {
    const calBad = typeof i.calibration === "number" && i.calibration <= 0;
    out.push({
      id: "re-anchor-cost",
      title: calBad ? "Cost calibration invalid" : `Cost anchor is from ${i.costMonth}`,
      detail: calBad
        ? `calibration ${i.calibration} would invert the MTD trend — re-anchor with the current claude.ai figure`
        : `Re-anchor for ${i.currentMonth} with the current claude.ai billed figure`,
      severity: "warn", kind: "anchor-modal",
    });
  }

  if (costOn && i.costMonth === null) {
    // Never anchored: cost-budget.json has no month. calibration is NOT part of this
    // condition — cost.ts defaults it to a number even with no anchor, so requiring
    // calibration === null would make this rule unreachable from PulseTab's feed.
    out.push({
      id: "anchor-first",
      title: "Cost tracking not yet anchored",
      detail: "No anchor recorded — enter the current claude.ai billed MTD figure to start cost tracking",
      severity: "info", kind: "anchor-modal",
    });
  }

  if (costOn && i.uncostedRuns > 0) {
    out.push({
      id: "cost-backfill", title: `${i.uncostedRuns} session(s) missing cost`,
      detail: "Run auto-cost backfill to cost sessions the SessionEnd hook missed",
      severity: "info", kind: "spawn", script: "brain/scripts/auto-cost.js", args: ["--backfill"],
    });
  }

  if (i.healthErrors > 0) {
    out.push({
      id: "open-health", title: `${i.healthErrors} health error(s)`,
      detail: "Open health.md for specifics", severity: "error",
      kind: "open-file", path: "brain/_index/health.md",
    });
  }

  if (i.staleArtifacts > 0) {
    out.push({
      id: "rebuild-brain-md",
      title: `${i.staleArtifacts} stale artifact(s)`,
      detail: "BRAIN.md/MOC freshness contracts expired — rebuild the compiled brain artifacts",
      severity: "warn",
      kind: "spawn", script: "brain/scripts/build-brain-md.js", args: [],
    });
  }

  for (const m of i.mapPending ?? []) {
    if (m.pending <= 0) continue;
    out.push({
      id: `map-${m.workspace}`, title: `${m.workspace}: ${m.pending} file(s) unmapped`,
      detail: "Describe the remaining files now (unbounded run, reports as file-map)",
      severity: "info", kind: "spawn", script: "brain/scripts/map-workspace.js", args: [m.workspace],
    });
  }

  const rank = { error: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
