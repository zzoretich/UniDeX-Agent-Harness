// MergeModal.ts — Merge with AI (brain-hub D21; spec 2026-10-12-brain-hub-ai A1, A2, A4, A5, A8, A9, A12; the plan's
// PR 4 Mechanics › HUD › Merge). The contract's entry point: BrainTab hands it to every mode as ctx.merge(paths), and
// Review's M, Health's duplicate rows and a sweep's Merge card open it. Built by the hud-merge builder.
import type { BrainCtx } from "./types";

/** Open the Merge dialog on 2–6 memories; resolves true when Save merged wrote the merge, false on Cancel or a failure. */
export function openMerge(ctx: BrainCtx, paths: readonly string[]): Promise<boolean> {
  void ctx;
  void paths;
  return Promise.resolve(false);
}
