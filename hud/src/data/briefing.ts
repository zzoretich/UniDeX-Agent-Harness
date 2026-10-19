// briefing.ts — adaptive briefing (ported from the earlier Mission Control dashboard)
// (buildBriefing + composeBriefingText). Inspects the snapshot + history and
// emits one or two prioritized executive-summary lines.

import { Snapshot, HistoryRecord } from "./snapshot";

export interface BriefingInsight {
  priority: number;  // 0 critical, 1 errors, 2 alerts, 3 notable, 4 ambient, 5 all-clear
  key: string;
  text: string;
}

export interface BriefingResult {
  text: string;
  priority: number;
  insights: BriefingInsight[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export interface BriefingContext {
  /** Set when the snapshot can't be loaded at all. */
  offline?: boolean;
  /** Milliseconds since snapshot scannedAt. */
  ageMs?: number;
  /** How this user runs the wrap command (aosConfig invocationHint): "/wrap", "$agenticos:wrap", or both. */
  wrapHint?: string;
}

export function buildBriefing(snapshot: Snapshot | null, ctx: BriefingContext = {}): BriefingInsight[] {
  const out: BriefingInsight[] = [];
  const add = (priority: number, key: string, text: string) => out.push({ priority, key, text });

  if (ctx.offline || !snapshot) {
    add(0, "offline", "Scanner data unreachable. The Workbench is running without a current snapshot.");
    return out;
  }

  const h = snapshot.health?.counts || { error: 0, warn: 0, info: 0, total: 0 };
  if (h.error > 0) {
    add(1, "errors", `${plural(h.error, "error")} in the health subsystem requires attention. The health panel has specifics.`);
  }

  const missingRefs = snapshot.capabilities?.hooks?.missingRefs?.length || 0;
  if (missingRefs > 0) {
    add(1, "broken-hooks", `${plural(missingRefs, "hook reference")} in settings.json point to missing files — automations may misfire.`);
  }

  const drift = snapshot.gsd?.manifest?.drift || 0;
  if (drift > 0) {
    add(1, "manifest-drift", `GSD manifest drift detected — ${plural(drift, "tracked file")} missing on disk. A gsd update may be in order.`);
  }

  const ageMs = ctx.ageMs ?? Infinity;
  if (ageMs > 30 * 60_000) {
    const mins = Math.round(ageMs / 60_000);
    const label = mins >= 60 ? `${Math.round(mins / 60)} hour${mins >= 120 ? "s" : ""}` : `${mins} minutes`;
    add(2, "stale-scan", `Snapshot is ${label} stale. Hit /scan to bring the HUD current.`);
  }

  const staleSess = snapshot.projects?.staleSessionCount || 0;
  if (staleSess > 0) {
    add(2, "stale-sessions", `${plural(staleSess, "session")} haven't been touched in 30+ days — cleanup candidates.`);
  }

  const oU = snapshot.projects?.orphanUuids || {};
  const orphanTotal = (oU.sessionEnv?.length || 0) + (oU.tasks?.length || 0) + (oU.fileHistory?.length || 0);
  if (orphanTotal > 0) {
    add(2, "orphan-uuids", `${plural(orphanTotal, "orphan UUID")} in side-folders without matching conversations — likely residue from crashed sessions.`);
  }

  if (snapshot.brain?.sessions && !snapshot.brain.sessions.todayPresent) {
    add(2, "missing-today", `No session log for today yet. ${ctx.wrapHint || "/wrap"} at day's end works too.`);
  }

  const dormant = snapshot.plans?.summary?.dormant || 0;
  if (dormant > 0) {
    add(2, "dormant-plans", `${plural(dormant, "plan")} dormant 30+ days — worth reviewing whether they're still relevant.`);
  }

  const active = snapshot.projects?.activeSessionCount || 0;
  if (active > 0) {
    const locked = (snapshot.projects?.sessions || []).filter((x) => x.hasLock);
    const largest = locked.slice().sort((a, b) => (b.jsonlBytes || 0) - (a.jsonlBytes || 0))[0];
    const tail = largest ? `, the largest at ${humanSize(largest.jsonlBytes)} (${largest.records} records)` : "";
    add(3, "active-sessions", `${plural(active, "conversation")} currently live${tail}.`);
  }

  const prev: HistoryRecord | null | undefined = snapshot.history?.previous;
  if (prev) {
    const prevDone = prev?.plans?.done || 0;
    const curDone = snapshot.plans?.summary?.totalCheckboxesDone || 0;
    if (curDone > prevDone) {
      const delta = curDone - prevDone;
      add(3, "plan-progress", `Plans advanced by ${plural(delta, "checkbox")} since last snapshot — now ${curDone}/${snapshot.plans?.summary?.totalCheckboxes ?? "?"} overall.`);
    }
    const curBytes = (snapshot.folderAtlas || []).reduce((a, f) => a + (f.bytes || 0), 0);
    const prevBytes = prev?.totalBytes || 0;
    const dBytes = curBytes - prevBytes;
    if (prevBytes && Math.abs(dBytes) > 1024 * 1024 && Math.abs(dBytes / prevBytes) > 0.05) {
      add(3, "vault-growth", `Vault ${dBytes > 0 ? "grew" : "shrank"} by ${humanSize(Math.abs(dBytes))} since last snapshot.`);
    }
  }

  if (h.warn > 0 && h.error === 0) {
    add(4, "warnings", `${plural(h.warn, "warning")} remain in the health panel — not urgent, but worth knowing.`);
  }

  if (out.length === 0) {
    const freshness = ageMs < 60_000 ? "fresh" : ageMs < 5 * 60_000 ? "recent" : "current";
    add(5, "all-clear", `All systems operational. Snapshot is ${freshness}. Nothing requires attention.`);
  }

  return out;
}

export function composeBriefing(insights: BriefingInsight[]): BriefingResult {
  const sorted = [...insights].sort((a, b) => a.priority - b.priority);
  const seen = new Set<string>();
  const picked: BriefingInsight[] = [];
  for (const i of sorted) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    picked.push(i);
    if (picked.length >= 2) break;
  }
  return {
    text: picked.map((p) => p.text).join(" "),
    priority: picked[0]?.priority ?? 5,
    insights: picked,
  };
}
