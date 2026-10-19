// notifications.ts — the Notifications tab's data (spec 2026-09-24-notifications-design). Pure.
// The runtime writes items with brain/scripts/lib/notifications.js (`aos notify post`); this side reads the same files.
// Frontmatter values are single-line JSON, so they parse with JSON.parse (D7). Actions are re-checked against the same
// allow-list here: an item edited by hand still can never make the tab run anything but a named skill (D4).
import type { AgenticosJson, SessionHost } from "./aosConfig";
import { shq } from "./skills";

export const NOTIFICATIONS_DIR = "brain/notifications";
export const STATE_PATH = `${NOTIFICATIONS_DIR}/state.json`;
export const REACTIONS_PATH = `${NOTIFICATIONS_DIR}/reactions.jsonl`;
export const LEVELS = ["breaking", "alert", "edition", "info"] as const;
export type Level = (typeof LEVELS)[number];
export type View = "unread" | "all" | "archived";

const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{4}-[a-z0-9-]+$/;
const SKILL_RE = /^[a-z0-9][a-z0-9:_-]{0,60}$/;
const ANCHOR_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export interface AskAction { kind: "ask"; label: string; skill: string; arg?: string; anchor?: string }
export interface ReactAction { kind: "react"; label: string; value: 1 | -1; ref: string; anchor?: string }
export type NotificationAction = AskAction | ReactAction;

export interface Notification {
  id: string;
  path: string;
  from: string;
  level: Level;
  title: string;
  created: string;
  tags: string[];
  actions: NotificationAction[];
  body: string;
  requestedLevel?: string;
}
export interface ItemState { read?: boolean; archived?: boolean }
export type NotificationRow = Notification & { read: boolean; archived: boolean };
export interface Section { anchor: string | null; heading: string | null; text: string }

/** The item id when `path` is an item file (brain/notifications/<year>/<id>.md), else null. */
export function notificationId(path: string): string | null {
  const m = /^brain\/notifications\/(\d{4})\/([^/]+)\.md$/.exec(path);
  return m && ID_RE.test(m[2]) ? m[2] : null;
}

function parseMeta(text: string): { meta: Record<string, unknown>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    try { meta[kv[1]] = JSON.parse(kv[2]); } catch { meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ""); }
  }
  return { meta, body: text.slice(m[0].length).replace(/^\r?\n/, "") };
}

/** Only well-formed ask/react actions survive; anything else is dropped, never shown. */
export function parseActions(raw: unknown): NotificationAction[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationAction[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (typeof o.label !== "string" || !o.label.trim() || o.label.length > 40) continue;
    const anchor = typeof o.anchor === "string" && ANCHOR_RE.test(o.anchor) ? o.anchor : undefined;
    if (o.kind === "ask" && typeof o.skill === "string" && SKILL_RE.test(o.skill)) {
      const arg = typeof o.arg === "string" && o.arg.length <= 200 && !/[\r\n]/.test(o.arg) ? o.arg : undefined;
      out.push({ kind: "ask", label: o.label, skill: o.skill, ...(arg !== undefined ? { arg } : {}), ...(anchor ? { anchor } : {}) });
    } else if (o.kind === "react" && (o.value === 1 || o.value === -1) && typeof o.ref === "string" && o.ref.trim() && o.ref.length <= 120) {
      out.push({ kind: "react", label: o.label, value: o.value, ref: o.ref, ...(anchor ? { anchor } : {}) });
    }
  }
  return out;
}

/** One item, or null when the file is not a readable notification (it is then counted as unreadable). */
export function parseNotification(path: string, text: string): Notification | null {
  const id = notificationId(path);
  const p = id ? parseMeta(text) : null;
  if (!id || !p) return null;
  const { meta, body } = p;
  if (!LEVELS.includes(meta.level as Level) || typeof meta.title !== "string" || !meta.title) return null;
  const n: Notification = {
    id, path, from: String(meta.from ?? ""), level: meta.level as Level, title: meta.title, created: String(meta.created ?? ""),
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [], actions: parseActions(meta.actions), body,
  };
  if (typeof meta.requestedLevel === "string") n.requestedLevel = meta.requestedLevel;
  return n;
}

export function parseState(text: string | null): Record<string, ItemState> {
  if (!text) return {};
  try {
    const s = JSON.parse(text);
    if (s && typeof s === "object" && s.items && typeof s.items === "object" && !Array.isArray(s.items)) return s.items as Record<string, ItemState>;
  } catch { /* corrupt: nothing read yet */ }
  return {};
}

/** Newest first by created time; the id breaks ties (the order lib/notifications.js lists in). */
export function newestFirst(a: { id: string; created: string }, b: { id: string; created: string }): number {
  const ta = Date.parse(a.created);
  const tb = Date.parse(b.created);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Items with their read/archived state, newest first. */
export function withState(items: Notification[], state: Record<string, ItemState>): NotificationRow[] {
  return items.map((n) => ({ ...n, read: !!state[n.id]?.read, archived: !!state[n.id]?.archived })).sort(newestFirst);
}

export function filterRows(rows: NotificationRow[], f: { view: View; level?: Level | null; from?: string | null }): NotificationRow[] {
  return rows.filter((r) => {
    if (f.view === "archived" ? !r.archived : r.archived) return false;
    if (f.view === "unread" && r.read) return false;
    if (f.level && r.level !== f.level) return false;
    if (f.from && r.from !== f.from) return false;
    return true;
  });
}

export function senders(rows: NotificationRow[]): string[] {
  return [...new Set(rows.map((r) => r.from).filter(Boolean))].sort();
}

/** The rail badge: unread, not archived; `breaking` is true while any of those is a breaking item. */
export function unreadBadge(rows: { level: Level; read: boolean; archived: boolean }[]): { count: number; breaking: boolean } {
  const unread = rows.filter((r) => !r.read && !r.archived);
  return { count: unread.length, breaking: unread.some((r) => r.level === "breaking") };
}

/** The anchor a `## Heading` gets: lowercase, runs of anything else become one dash. */
export function headingSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The body cut at each `## ` heading; the text before the first heading has anchor null. */
export function splitSections(body: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { anchor: null, heading: null, text: "" };
  for (const line of body.split("\n")) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (cur.heading !== null || cur.text.trim()) out.push(cur);
      cur = { anchor: headingSlug(h[1]), heading: h[1], text: "" };
    } else cur.text += `${line}\n`;
  }
  if (cur.heading !== null || cur.text.trim()) out.push(cur);
  return out.map((s) => ({ ...s, text: s.text.replace(/^\n+|\s+$/g, "") }));
}

/** The actions shown under a section: those anchored to it, or, for anchor null, the unanchored ones plus any whose
 *  anchor matches no heading (so an action is never lost to a typo). */
export function actionsFor(actions: NotificationAction[], anchor: string | null, anchors: (string | null)[]): NotificationAction[] {
  if (anchor !== null) return actions.filter((a) => a.anchor === anchor);
  return actions.filter((a) => !a.anchor || !anchors.includes(a.anchor));
}

/**
 * What an ask button types into a fresh terminal on `host` (D6): the host CLI with the skill invocation as the first
 * prompt, single-quoted so the shell expands nothing. Claude Code `/skill arg`; Codex `$skill arg`, where a plugin skill
 * `agenticos:x` reads `$x` on a directly wired Codex.
 */
export function askCommand(a: AskAction, host: SessionHost, cfg: AgenticosJson | null): string {
  let skill = a.skill;
  if (host === "codex" && cfg?.hosts?.codex?.install === "direct" && skill.startsWith("agenticos:")) skill = skill.slice("agenticos:".length);
  const prompt = `${host === "codex" ? "$" : "/"}${skill}${a.arg ? ` ${a.arg}` : ""}`;
  return `${host === "codex" ? "codex" : "claude"} ${shq(prompt)}`;
}

/** The last recorded vote per `<id>|<ref>` from reactions.jsonl; corrupt lines are skipped. */
export function parseReactions(text: string | null): Record<string, 1 | -1> {
  const out: Record<string, 1 | -1> = {};
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.id === "string" && typeof r.ref === "string" && (r.value === 1 || r.value === -1)) out[`${r.id}|${r.ref}`] = r.value;
    } catch { /* skip */ }
  }
  return out;
}

export function reactionLine(id: string, ref: string, value: 1 | -1, at: Date): string {
  return `${JSON.stringify({ schema: 1, at: at.toISOString(), id, ref, value })}\n`;
}

/** state.json text with `key` set (or cleared) on `ids`; the same shape lib/notifications.js writes. */
export function setFlag(stateText: string | null, ids: string[], key: "read" | "archived", value: boolean): string {
  const items = { ...parseState(stateText) };
  for (const id of ids) {
    const next: ItemState = { ...(items[id] ?? {}) };
    if (value) next[key] = true; else delete next[key];
    if (Object.keys(next).length) items[id] = next; else delete items[id];
  }
  return `${JSON.stringify({ schema: 1, items }, null, 2)}\n`;
}

/** "3m ago", "5h ago", "2d ago", or the date, from an ISO time. */
export function ago(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, (now.getTime() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return iso.slice(0, 10);
}
