// What's new (tour C2, C10): whatsnew.json holds a list per release, each entry a short note and, when it has them, the
// tour steps "Show me" runs. The HUD selects the releases newer than the version this Mac last saw, up to the one it
// runs (manifest.version, kept equal to the app's by bump-version, which refuses a version with no release here). The
// launch sequence (ui/launchSequence.ts) shows them as a card after an update; Help ▸ What's new keeps the history.
// 2.0.0's entries: background work on your Mac, the Chief of Staff's models, your imported history, the tour. Still to
// write with PR 9's second stage: Sessions ▸ History (PR 7b) and routine engines (PR 4), once those are on main.
// Pure, so node:test (and tools/, which reads the JSON) can load it.
import raw from "./whatsnew.json";

export interface WhatsNewEntry {
  id: string;
  title: string;
  body: string;
  /** Step refs ("<chapter>.<step>") or chapter ids "Show me" runs, in order; empty for a note with nothing to show. */
  steps: string[];
}

export interface WhatsNewRelease {
  version: string;
  entries: WhatsNewEntry[];
}

export interface WhatsNewFile {
  schema: 1;
  releases: WhatsNewRelease[];
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** -1, 0 or 1 by major.minor.patch; a version that does not parse sorts first. */
export function cmpVersion(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The problems with a whatsnew.json: none for a good one. `stepRefs` are the ids "Show me" may name. */
export function validateWhatsNew(file: unknown, stepRefs: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const f = file as Partial<WhatsNewFile> | null;
  if (!f || typeof f !== "object") return ["whatsnew.json is not an object"];
  if (f.schema !== 1) out.push("whatsnew.json: schema must be 1");
  if (!Array.isArray(f.releases)) return [...out, "whatsnew.json: releases must be a list"];
  const seen = new Set<string>();
  for (const r of f.releases) {
    if (!r || typeof r.version !== "string" || !VERSION.test(r.version)) { out.push(`whatsnew.json: a release has no x.y.z version`); continue; }
    if (seen.has(r.version)) out.push(`whatsnew.json: ${r.version} is listed twice`);
    seen.add(r.version);
    if (!Array.isArray(r.entries)) { out.push(`whatsnew.json ${r.version}: entries must be a list`); continue; }
    const ids = new Set<string>();
    for (const e of r.entries) {
      const where = `whatsnew.json ${r.version} ${e?.id ?? "?"}`;
      if (!e || typeof e.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(e.id)) out.push(`${where}: id must be kebab-case`);
      else if (ids.has(e.id)) out.push(`${where}: id is listed twice`);
      else ids.add(e.id);
      if (typeof e?.title !== "string" || !e.title.trim()) out.push(`${where}: no title`);
      if (typeof e?.body !== "string" || !e.body.trim()) out.push(`${where}: no body`);
      if (!Array.isArray(e?.steps)) out.push(`${where}: steps must be a list`);
      else for (const s of e.steps) if (typeof s !== "string" || !stepRefs.has(s)) out.push(`${where}: unknown step ${String(s)}`);
    }
  }
  return out;
}

/**
 * The releases to show, newest first: those after `lastSeen` up to `current`. With no `lastSeen` (an install that ran
 * before the tour kept one) it is What's new in the release this Mac runs: its x.y line up to `current`.
 */
export function selectWhatsNew(releases: readonly WhatsNewRelease[], lastSeen: string | null, current: string): WhatsNewRelease[] {
  const cur = VERSION.exec(current);
  const floor = lastSeen ?? (cur ? `${cur[1]}.${cur[2]}.0` : current);
  const include = (v: string) => (lastSeen ? cmpVersion(v, floor) > 0 : cmpVersion(v, floor) >= 0) && cmpVersion(v, current) <= 0;
  return releases.filter((r) => include(r.version) && r.entries.length > 0).sort((a, b) => cmpVersion(b.version, a.version));
}

/**
 * The launch sequence's What's new card (tour C2, C10): null when there is nothing to show. An install that has never
 * kept a last-seen version (one from before the tour, not a first run) always gets the card, with "Take the full tour":
 * What's new in the running release's x.y line, even when that line has no entries yet. Otherwise only the releases
 * after the last one seen, and only when one of them has entries.
 */
export function launchWhatsNew(releases: readonly WhatsNewRelease[], lastSeen: string | null, current: string): { line: string; releases: WhatsNewRelease[]; firstTime: boolean } | null {
  const shown = selectWhatsNew(releases, lastSeen, current);
  const cur = VERSION.exec(current);
  const line = cur ? `${cur[1]}.${cur[2]}` : current;
  if (!lastSeen) return { line, releases: shown, firstTime: true };
  return shown.length ? { line, releases: shown, firstTime: false } : null;
}

/** Every release up to `current`, newest first: Help ▸ What's new keeps the history. */
export function whatsNewHistory(releases: readonly WhatsNewRelease[], current: string): WhatsNewRelease[] {
  return releases.filter((r) => cmpVersion(r.version, current) <= 0 && r.entries.length > 0).sort((a, b) => cmpVersion(b.version, a.version));
}

/** whatsnew.json as shipped. */
export const WHATS_NEW: WhatsNewFile = raw as WhatsNewFile;
