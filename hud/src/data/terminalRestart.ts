// A chip restart keeps the running agent until the new one starts (code-chat C12, fix round 1; ruling R36).
import type { Launched } from "./terminalLauncher";

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
 * on success just before the old terminal is removed (the composer carries its draft to the new one, I1).
 *
 * Both agents sit on one conversation for that moment: accepted, since the chips are disabled while a turn runs, so both
 * are idle.
 */
export async function restartKeepingOld(
  pool: RestartPool, oldId: string, launch: () => Promise<Pick<Launched, "ready"> & { session: { id: string } }>,
  onReplace?: (oldId: string, newId: string) => void,
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
  onReplace?.(oldId, l.session.id);
  pool.remove(oldId);
  pool.select(l.session.id);
  return null;
}
