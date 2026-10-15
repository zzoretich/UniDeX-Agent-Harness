// Who may talk to main, and the three shapes a handler takes. Only the app's own page, in the main window's main frame,
// loaded from app://hud, is answered; anything else gets EPERM (or nothing, for a one-way message). Every handler parses
// its arguments with a schema and answers with a Result: a thrown error never crosses the bridge.

import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { APP_ORIGIN, type Result } from "../../shared/ipc";

export type Trust = (e: IpcMainEvent | IpcMainInvokeEvent) => boolean;

/** Only `win`'s main frame, showing the app's page. */
export function trustMainWindow(getWin: () => BrowserWindow | null): Trust {
  return (e) => {
    const win = getWin();
    const frame = e.senderFrame;
    return !!win && !win.isDestroyed() && e.sender === win.webContents && !!frame && frame === e.sender.mainFrame
      && frame.url.startsWith(`${APP_ORIGIN}/`);
  };
}

const UNTRUSTED: Result<never> = { ok: false, error: "untrusted sender", code: "EPERM" };
const INVALID: Result<never> = { ok: false, error: "invalid arguments", code: "EINVAL" };
const FAILED: Result<never> = { ok: false, error: "failed", code: "EIO" };

function answer<S extends z.ZodType, T>(channel: string, trust: Trust, schema: S, fn: (args: z.infer<S>) => Result<T>, e: IpcMainEvent | IpcMainInvokeEvent, raw: unknown): Result<T> {
  if (!trust(e)) { console.warn(`[main] ${channel}: untrusted sender`); return UNTRUSTED; }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) { console.warn(`[main] ${channel}: invalid arguments`); return INVALID; }
  try { return fn(parsed.data); } catch (err) { console.error(`[main] ${channel} failed`, err); return FAILED; }
}

/** A synchronous call (ipcRenderer.sendSync): the page waits for the Result. Always answers, so the page never hangs. */
export function onSync<S extends z.ZodType, T>(channel: string, trust: Trust, schema: S, fn: (args: z.infer<S>) => Result<T>): void {
  ipcMain.on(channel, (e, raw) => { e.returnValue = answer(channel, trust, schema, fn, e, raw); });
}

/**
 * A synchronous call answered when `hold` says so: `hold(answer, reply)` runs the answer now or later (the page stays
 * blocked meanwhile, as for any synchronous call). The fs bridge holds the page's changes while a trash is in flight.
 */
export function onSyncHeld<S extends z.ZodType, T>(channel: string, trust: Trust, schema: S, fn: (args: z.infer<S>) => Result<T>,
  hold: (run: () => Result<T>, reply: (r: Result<T>) => void) => void): void {
  ipcMain.on(channel, (e, raw) => { hold(() => answer(channel, trust, schema, fn, e, raw), (r) => { e.returnValue = r; }); });
}

/** An asynchronous call (ipcRenderer.invoke). */
export function onInvoke<S extends z.ZodType, T>(channel: string, trust: Trust, schema: S, fn: (args: z.infer<S>) => Promise<Result<T>>): void {
  ipcMain.handle(channel, async (e, raw) => {
    if (!trust(e)) return UNTRUSTED;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return INVALID;
    try { return await fn(parsed.data); } catch (err) { console.error(`[main] ${channel} failed`, err); return FAILED; }
  });
}

/** A one-way message (ipcRenderer.send): dropped unless it is trusted and parses. */
export function onSend<S extends z.ZodType>(channel: string, trust: Trust, schema: S, fn: (args: z.infer<S>) => void): void {
  ipcMain.on(channel, (e, raw) => {
    if (!trust(e)) { console.warn(`[main] ${channel}: untrusted sender`); return; }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) { console.warn(`[main] ${channel}: invalid arguments`); return; }
    try { fn(parsed.data); } catch (err) { console.error(`[main] ${channel} failed`, err); }
  });
}
