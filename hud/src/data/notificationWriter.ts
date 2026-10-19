// notificationWriter.ts — the Notifications tab's two writes (spec 2026-09-24-notifications-design D3): read/archived
// flags in brain/notifications/state.json and votes appended to reactions.jsonl. Item files are never written here.
// state.json has two writers (this tab and `aos notify`), so every change re-reads it first (the todoWriter rule).
// The IO goes through a tiny adapter so tests stub it without "obsidian".
import type { App } from "obsidian";
import { NOTIFICATIONS_DIR, STATE_PATH, REACTIONS_PATH, setFlag, reactionLine } from "./notifications";

export interface NotificationAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export function adapterOf(app: App): NotificationAdapter {
  const a = app.vault.adapter;
  return { exists: (p) => a.exists(p), read: (p) => a.read(p), write: (p, d) => a.write(p, d), mkdir: (p) => a.mkdir(p) };
}

async function readOrNull(a: NotificationAdapter, p: string): Promise<string | null> {
  return (await a.exists(p)) ? a.read(p) : null;
}

async function ensureDir(a: NotificationAdapter): Promise<void> {
  if (!(await a.exists(NOTIFICATIONS_DIR))) await a.mkdir(NOTIFICATIONS_DIR);
}

/** Sets or clears `key` on `ids` in state.json; writes nothing when nothing changes. */
export async function setFlags(a: NotificationAdapter, ids: string[], key: "read" | "archived", value: boolean): Promise<void> {
  if (!ids.length) return;
  const before = await readOrNull(a, STATE_PATH);
  const after = setFlag(before, ids, key, value);
  if (before !== null && JSON.stringify(JSON.parse(before)) === JSON.stringify(JSON.parse(after))) return;
  await ensureDir(a);
  await a.write(STATE_PATH, after);
}

/** Appends one +1/-1 vote for `ref` in item `id`. */
export async function appendReaction(a: NotificationAdapter, id: string, ref: string, value: 1 | -1, now = new Date()): Promise<void> {
  const before = (await readOrNull(a, REACTIONS_PATH)) ?? "";
  await ensureDir(a);
  await a.write(REACTIONS_PATH, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${reactionLine(id, ref, value, now)}`);
}
