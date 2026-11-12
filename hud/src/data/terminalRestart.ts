// A chip restart keeps the running agent until the new one starts (code-chat C12, fix round 1; ruling R36).
import type { Launched } from "./terminalLauncher";

/** The Notice for a hand-over that failed: the old terminal (and its browser) was kept. */
export const HAND_OVER_KEPT = "The browser could not be handed over: the old terminal was kept.";

/** Thrown by `onReplace` when the browser hand-over call itself was REJECTED (not when it answered false: nothing to
 *  hand over, or the replacement keeps its own). The restart then keeps the old terminal (session-browser S22). */
export class HandOverFailed extends Error {
  constructor(readonly cause?: unknown) { super(HAND_OVER_KEPT); this.name = "HandOverFailed"; }
}

/** What the restart needs of the terminal pool. */
export interface RestartPool {
  remove(id: string): void;
  select(id: string): void;
}

/**
 * Launches the replacement with `launch`, and closes the old terminal only once the new agent has started (`ready`
 * settles, with or without a fallback reason: a typed launch line in a shell is a start). When the launch fails, or
 * `ready` rejects (a missing binary, a host that is off, a refusal from main), the new terminal is removed, the old one
 * stays selected and running, and the reason comes back for the panel to show. Returns null on success. `onReplace` runs
 * on success just before the old terminal is removed (the composer carries its draft to the new one, I1, and the old
 * terminal's browser moves to the new one, session-browser S22); it is awaited. One that throws is best effort and the
 * restart goes on, except a `HandOverFailed`: the old terminal is then kept with its browser, the new one stays selected,
 * and the Notice sentence `HAND_OVER_KEPT` comes back.
 *
 * Both agents sit on one conversation for that moment: accepted, since the chips are disabled while a turn runs, so both
 * are idle.
 */
export async function restartKeepingOld(
  pool: RestartPool, oldId: string, launch: () => Promise<Pick<Launched, "ready"> & { session: { id: string } }>,
  onReplace?: (oldId: string, newId: string) => void | Promise<void>,
): Promise<string | null> {
  let l: Awaited<ReturnType<typeof launch>>;
  try { l = await launch(); } catch (e) { return e instanceof Error ? e.message : String(e); }
  try {
    await l.ready;
  } catch (e) {
    pool.remove(l.session.id);
    pool.select(oldId);
    return e instanceof Error ? e.message : String(e);
  }
  try {
    await onReplace?.(oldId, l.session.id);
  } catch (e) {
    if (e instanceof HandOverFailed) { pool.select(l.session.id); return e.message; }
    /* anything else is best effort: the restart goes on */
  }
  pool.remove(oldId);
  pool.select(l.session.id);
  return null;
}
