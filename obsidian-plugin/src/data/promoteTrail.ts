// brain/_index/promote-log.jsonl, the trail of what happened to each memory: written by brain/scripts/lib/promote-log.js
// (auto-wrap) and lib/memory-ops.js (the `aos memory` verbs); keep the shapes in lockstep. The HUD only reads it: Pulse's
// keep, edit and revert gave way to the Brain tab's verbs, and nothing is deleted from the app (brain-hub D6, D14).
// Pure, so node:test can load it.
import type { MemoryType } from "./memoryWriter";

export const TRAIL_PATH = "brain/_index/promote-log.jsonl";

/** auto-wrap writes `written`; the verbs `kept`, `set`, `archived`, `superseded` and `restored`; the old Pulse trail wrote
 *  `edited` and `reverted`, which stay in older trails. */
export type TrailAction = "written" | "reverted" | "edited" | "kept" | "set" | "archived" | "superseded" | "restored";

export interface TrailEntry {
  ts: string;
  session: string;
  action: TrailAction;
  slug: string;
  type: MemoryType;
  title: string;
}

// Mirrors promote-log.js's readTrail: reverse to newest-first then slice, skipping
// any line that doesn't parse as JSON (a torn append shouldn't sink the whole read).
export function parseTrail(raw: string, limit: number): TrailEntry[] {
  const rows: TrailEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as TrailEntry); } catch { /* corrupt line — skip */ }
  }
  return rows.reverse().slice(0, limit);
}
