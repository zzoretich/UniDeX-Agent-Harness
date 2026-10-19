// The compat layer's way to the disk and the OS: the preload's bridge to main (window.aos, src/preload/index.ts), which
// checks every call.

import type { AosBridge, Result } from "../../src/shared/ipc";

let current: AosBridge | null = null;

export function setBridge(b: AosBridge | null): void { current = b; }

export function bridge(): AosBridge {
  current ??= (globalThis as { aos?: AosBridge }).aos ?? null;
  if (!current) throw new Error("UniDeX: no bridge to the main process");
  return current;
}

/** A failed call as Node would throw it: `code` from main (ENOENT …), the message naming what was asked. */
export function callError(r: Extract<Result<unknown>, { ok: false }>, what: string): NodeJS.ErrnoException {
  const err = new Error(`${r.code}: ${r.error}, ${what}`) as NodeJS.ErrnoException;
  err.code = r.code;
  return err;
}
