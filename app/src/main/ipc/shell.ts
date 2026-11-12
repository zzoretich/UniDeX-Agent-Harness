// shell:* — what the page hands to the OS: https links, documents and folders (policy/shell.ts decides which).

import { app, shell } from "electron";
import { CH } from "../../shared/ipc";
import type { ReadScope } from "../policy/read-scope";
import { externalAllowed, openPathAction } from "../policy/shell";
import { PathArgs, UrlArgs } from "./schemas";
import { onInvoke, onSend, type Trust } from "./trust";

/** Opens a link in the browser when it is https; anything else is refused and logged. Main uses it too. */
export function openExternalSafe(url: string): void {
  const allowed = externalAllowed(url);
  if (testRecord) recordExternalOpen(url, allowed);
  if (!allowed) console.warn(`[main] refused to open ${url.slice(0, 200)}`);
  else void shell.openExternal(url);
}

/** Whether this is a dev run or a test build: it records what it opens outside (`__aosMain.externalOpens`). */
const testRecord = !app.isPackaged || __AOS_TEST_BUILD__;
const externalOpenLog: Array<{ url: string; opened: boolean }> = [];
/** Pushes one entry, newest last, capped at 50. */
export function recordExternalOpen(url: string, opened: boolean, log: Array<{ url: string; opened: boolean }> = externalOpenLog): void {
  log.push({ url, opened });
  if (log.length > 50) log.shift();
}
/** What main opened outside (or refused to), for the e2e suite (`__aosMain.externalOpens`). */
export const externalOpens = (): Array<{ url: string; opened: boolean }> => externalOpenLog.map((o) => ({ ...o }));

export function registerShellIpc(trust: Trust, scope: () => ReadScope | null, vaultRoot: () => string | null): void {
  onSend(CH.shellOpenExternal, trust, UrlArgs, ({ url }) => openExternalSafe(url));
  // Electron's contract: "" when it opened, else why not.
  onInvoke(CH.shellOpenPath, trust, PathArgs, async ({ p }) => {
    const s = scope();
    if (!s) return { ok: true, data: "no vault" };
    const what = openPathAction(p, s, vaultRoot());
    if ("refusal" in what) { console.warn(`[main] refused to open ${p} (${what.refusal})`); return { ok: true, data: what.refusal }; }
    if (what.action === "reveal") { shell.showItemInFolder(p); return { ok: true, data: "" }; }
    return { ok: true, data: await shell.openPath(p) };
  });
  onSend(CH.shellShowItem, trust, PathArgs, ({ p }) => {
    const s = scope();
    if (s?.canRead(p)) shell.showItemInFolder(p);
    else console.warn(`[main] refused to show ${p}`);
  });
}
