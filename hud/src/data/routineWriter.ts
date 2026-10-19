// routineWriter.ts — writes <vault>/brain/routines/<slug>.md from the Routines drawer (spec D7/D9).
// A `guarded: true` routine (the persona duties) is covered by the persona's self-modification
// contract: the drawer shows a confirm dialog first and this writer refuses a schedule or body change
// unless the caller passes `confirmed: true`. Enable/disable never needs the confirmation.
// Pure decision + composition (testable); the IO goes through a tiny adapter interface so tests can
// stub it without importing "obsidian".
import type { App } from "obsidian";
import { Routine, ROUTINES_DIR, routineFromFile, routineToFile, validateRoutine } from "./routines";

export interface RoutineAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export function adapterOf(app: App): RoutineAdapter {
  const a = app.vault.adapter;
  return {
    exists: (p) => a.exists(p),
    read: (p) => a.read(p),
    write: (p, d) => a.write(p, d),
    mkdir: (p) => a.mkdir(p),
    remove: (p) => a.remove(p),
  };
}

export type RoutineDraft = Omit<Routine, "errors" | "body"> & { body: string };
export class GuardedRoutineError extends Error {
  constructor(slug: string) { super(`${slug} is guarded by the persona contract — confirm the change first`); this.name = "GuardedRoutineError"; }
}

export function routinePath(slug: string): string { return `${ROUTINES_DIR}/${slug}.md`; }

/** True when the fields the persona contract covers (schedule, body, kind, argv/model/effort/budget) differ. */
export function isGuardedChange(before: Routine | null, after: RoutineDraft): boolean {
  if (!before) return false;
  if (!before.guarded) return false;
  const pick = (r: Partial<Routine>) => JSON.stringify([r.kind, String(r.schedule ?? "").trim(), String(r.body ?? "").trim(), r.argv ?? null, r.model ?? null, r.effort ?? null, r.budgetUsd ?? null, r.timeoutSec ?? null]);
  return pick(before) !== pick(after);
}

export interface WriteOptions { confirmed?: boolean; overwrite?: boolean }

/**
 * Validates, then writes. Throws on validation errors, on an existing file when `overwrite` is false,
 * and on a guarded change without `confirmed`. Returns the vault-relative path.
 */
export async function writeRoutine(adapter: RoutineAdapter, draft: RoutineDraft, opts: WriteOptions = {}): Promise<string> {
  const errors = validateRoutine(draft as Partial<Routine>);
  if (errors.length) throw new Error(`invalid routine: ${errors.join("; ")}`);
  const path = routinePath(draft.slug);
  const exists = await adapter.exists(path);
  if (exists && !opts.overwrite) throw new Error(`routine already exists: ${path}`);
  const before = exists ? routineFromFile(draft.slug, await adapter.read(path)) : null;
  if (isGuardedChange(before, draft) && !opts.confirmed) throw new GuardedRoutineError(draft.slug);
  if (!(await adapter.exists(ROUTINES_DIR))) await adapter.mkdir(ROUTINES_DIR);
  await adapter.write(path, routineToFile(draft));
  return path;
}

/** Flips `enabled:` in place; never a guarded change, never rewrites anything else. */
export async function setRoutineEnabled(adapter: RoutineAdapter, slug: string, enabled: boolean): Promise<Routine> {
  const path = routinePath(slug);
  const current = routineFromFile(slug, await adapter.read(path));
  if (current.errors.length) throw new Error(`${slug} is invalid: ${current.errors.join("; ")}`);
  const { errors, ...rest } = current;
  void errors;
  const draft = { ...rest, enabled } as RoutineDraft;
  await adapter.write(path, routineToFile(draft));
  return routineFromFile(slug, await adapter.read(path));
}

export async function deleteRoutine(adapter: RoutineAdapter, slug: string, opts: WriteOptions = {}): Promise<void> {
  const path = routinePath(slug);
  if (!(await adapter.exists(path))) return;
  const current = routineFromFile(slug, await adapter.read(path));
  if (current.guarded && !opts.confirmed) throw new GuardedRoutineError(slug);
  await adapter.remove(path);
}
