// The guard log. Main decides every write, spawn and read the page asks for (src/main/policy, phase 4); when it refuses
// one, the page records it here and throws Node's EROFS, as the write guards did when they ran in the page. The log is
// what the e2e suite and the packaged smoke read (window.aosHost.guard).
//
// The page keeps three questions of its own: whether the note editor may save a path, so a note it may not save opens
// without an Edit button; whether a HUD surface's writes reach a path, so a button whose writes are off shows why
// instead of failing (Spaces' + to-do and Link to-dos… need the To-Do surface's writes, spaces-redesign D35); and whether
// an enabled surface runs a runtime script with given arguments, so a card whose command would be refused names it for
// the Code tab instead (the Go-local card, local-first A9). The host installs that rule (src/renderer/pagePolicy.ts);
// main still checks every write, save and spawn.

export interface GuardEntry {
  kind: "read" | "write" | "spawn";
  what: string;
  at: string;
}

export interface WriteGuard {
  /** Whether the note editor may save this absolute path. */
  canSave(target: unknown): boolean;
  /** Whether an enabled HUD surface may write this absolute path (display only: main decides each write). */
  canWrite(target: unknown): boolean;
  /** Whether an enabled HUD surface runs `node <vault>/brain/scripts/<script> args…` (display only: main decides). */
  canRun?(script: string, args: readonly string[]): boolean;
}

export interface GuardState {
  policy: WriteGuard;
  log: GuardEntry[];
}

const SAVES_NOTHING: WriteGuard = { canSave: () => false, canWrite: () => false };

const g = globalThis as { __aosGuard?: GuardState };

export function guardState(): GuardState {
  g.__aosGuard ??= { policy: SAVES_NOTHING, log: [] };
  return g.__aosGuard;
}

export function setWriteGuard(policy: WriteGuard): void { guardState().policy = policy; }

export function canSave(target: unknown): boolean { return guardState().policy.canSave(target); }

export function canWrite(target: unknown): boolean { return guardState().policy.canWrite(target); }

export function canRun(script: string, args: readonly string[]): boolean { return guardState().policy.canRun?.(script, args) ?? false; }

/** Records an action main refused and returns the error to throw. */
export function refuse(kind: GuardEntry["kind"], what: string): Error {
  const entry: GuardEntry = { kind, what, at: new Date().toISOString() };
  const s = guardState();
  s.log.push(entry);
  if (s.log.length > 500) s.log.shift();
  console.warn(`[guard] refused ${kind}: ${what}`);
  const why = kind === "read" ? "outside what the app reads" : "no write surface that allows it is on";
  const err = new Error(`UniDeX: ${what} refused; ${why}`) as NodeJS.ErrnoException;
  err.code = "EROFS";
  return err;
}
