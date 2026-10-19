// listen.ts — listeners a component owns and removes itself (spec 2026-09-24-hud-deck-fixes D1). Pure.
// Obsidian's Events.on() returns an EventRef that offref() removes. plugin.registerEvent() would instead keep the ref,
// and the closure over its owner, until the plugin unloads, so a panel mounted on every tab visit leaked three.

/** The part of Obsidian's `Events` this needs; `R` is its `EventRef`. */
export interface Emitter<R> {
  on(name: string, callback: (...data: unknown[]) => unknown): R;
  offref(ref: R): void;
}

/** Subscribes every handler; the returned function removes them all and is safe to call more than once. */
export function listen<R>(emitter: Emitter<R>, handlers: Record<string, (...data: unknown[]) => unknown>): () => void {
  let refs: R[] | null = Object.entries(handlers).map(([name, cb]) => emitter.on(name, cb));
  return () => {
    if (!refs) return;
    for (const ref of refs) emitter.offref(ref);
    refs = null;
  };
}
