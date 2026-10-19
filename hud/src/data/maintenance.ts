// maintenance.ts — one Pulse line from snapshot.maintenance (scan-vault's orphan sweep, brain/scripts/sweep-orphans.js).
// Pure so node:test covers it; PulseTab only renders the result.
import type { SnapshotMaintenance } from "./snapshot";

export interface SweepLine { text: string; tone: "amber" | "dim" }

export function sweepLine(m: SnapshotMaintenance | undefined): SweepLine | null {
  const s = m?.orphanSweep;
  if (!s || !s.enabled) return null;
  // Fail-closed: the projects/ allow-list could not be read, so nothing was swept — the one case worth a visible line.
  if (s.reason) return { tone: "amber", text: `orphan sweep skipped: ${s.reason}` };
  const n = [s.swept, s.transientSwept].reduce((acc, t) => acc + (t?.sessionEnv?.length ?? 0) + (t?.fileHistory?.length ?? 0), 0);
  return n > 0 ? { tone: "dim", text: `orphan sweep: ${n} removed` } : null;
}
