// personaHeartbeat.ts — the SidebarHUD's heartbeat pill, read from brain/_index/persona-heartbeat.json
// (schema 1, written by brain/scripts/persona/watchdog.js every 30 minutes and from the SessionStart hook).
// The watchdog already decided which duty missed its schedule; this module renders that verdict and the
// age of the last check, the way updateBadge.ts trusts the scanner's `behind`. Pure apart from the adapter
// read so node:test can load it; time and formatting are injected.
import { App } from "obsidian";

export const PERSONA_HEARTBEAT_PATH = "brain/_index/persona-heartbeat.json";

export type BeatStatus = "ok" | "missed" | "failed" | "never" | "disabled" | "unwatched" | "invalid" | "stale";

export interface HeartbeatBeat {
  kind?: string;
  schedule?: string | null;
  enabled?: boolean;
  status: BeatStatus | string;
  lastRunAt?: string | null;
  lastExit?: number | null;
  next?: string | null;
  due?: string | null;
}

export interface PersonaHeartbeat {
  schema: number;
  checkedAt: string;
  graceMinutes?: number;
  beats: Record<string, HeartbeatBeat>;
  misses?: Array<{ slug: string; due: string; lastRunAt: string | null }>;
}

export type HeartbeatTone = "ok" | "warn" | "bad";

export interface HeartbeatPill {
  label: string;
  tone: HeartbeatTone;
  title: string;
}

const HOUR_MS = 3600_000;
/** A beat the watchdog flagged: the pill is red whatever the check's age. */
const BAD = new Set(["missed", "failed"]);
/** A duty that cannot fire as scheduled yet (never ran, schedule not synced, file invalid): amber, not red. */
const WORRYING = new Set(["never", "stale", "invalid"]);

export function parsePersonaHeartbeat(raw: string): PersonaHeartbeat | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (o.schema !== 1 || typeof o.checkedAt !== "string") return null;
  if (!o.beats || typeof o.beats !== "object" || Array.isArray(o.beats)) return null;
  return o as unknown as PersonaHeartbeat;
}

export async function loadPersonaHeartbeat(app: App): Promise<PersonaHeartbeat | null> {
  try {
    return parsePersonaHeartbeat(await app.vault.adapter.read(PERSONA_HEARTBEAT_PATH));
  } catch {
    return null;   // persona off, or the watchdog has not run yet: no pill
  }
}

function defaultFormatNext(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * The pill, or null when there is no heartbeat file (the persona layer is off or the watchdog never ran).
 * Tone: `bad` on any missed or failed duty, or when the last check is 3 h old or more; `warn` when the check is
 * 1 h old or more, or a duty is never/stale/invalid; `ok` otherwise. The label carries the check's age and the
 * miss count; the tooltip lists every enabled duty with its status, last run and next fire.
 */
export function heartbeatPill(
  hb: PersonaHeartbeat | null,
  nowMs: number,
  formatAge: (iso: string) => string,
  formatNext: (iso: string) => string = defaultFormatNext,
): HeartbeatPill | null {
  if (!hb) return null;
  const checked = Date.parse(hb.checkedAt);
  const ageMs = Number.isFinite(checked) ? Math.max(0, nowMs - checked) : Number.POSITIVE_INFINITY;
  const duties = Object.entries(hb.beats)
    .filter(([, b]) => b && (b.kind === undefined || b.kind === "duty") && b.enabled !== false)
    .sort(([a], [b]) => a.localeCompare(b));
  const bad = duties.filter(([, b]) => BAD.has(String(b.status)));
  const worrying = duties.filter(([, b]) => WORRYING.has(String(b.status)));
  const tone: HeartbeatTone =
    bad.length > 0 || ageMs >= 3 * HOUR_MS ? "bad" :
    worrying.length > 0 || ageMs >= HOUR_MS ? "warn" : "ok";
  const age = Number.isFinite(checked) ? formatAge(hb.checkedAt) : "unknown";
  const missed = duties.filter(([, b]) => b.status === "missed").length;
  const label = `♥ ${age}${missed ? ` · ${missed} missed` : ""}`;
  const lines = duties.map(([slug, b]) => {
    const last = b.lastRunAt ? formatAge(b.lastRunAt) : "never";
    const next = b.next ? formatNext(b.next) : "—";
    return `${slug}: ${b.status} · last ${last} · next ${next}`;
  });
  const head = `watchdog checked ${age}${ageMs >= HOUR_MS && Number.isFinite(ageMs) ? " — is the heartbeat routine running? (aos routines list)" : ""}`;
  return { label, tone, title: [head, ...(lines.length ? lines : ["no enabled duties"])].join("\n") };
}
