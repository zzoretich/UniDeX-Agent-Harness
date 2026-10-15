// Getting started (tour C9): the rail foot's "Getting started n/m" and its drawer. The tasks are the chapters (done
// when run to their end) and a few actions the HUD sees done in the runtime's caches, never in a transcript: a session
// in the runs log, a routine of the user's own, a memory reviewed in the trail, a Chief of Staff set up. Each action is
// remembered once seen, so a cache that is rebuilt never unticks it. Pure but for the reads it is handed, so node:test
// can load it.
import { holds, type TourContext } from "./predicates";
import type { ChecklistAction, TourBook } from "./steps";
import type { TourState } from "./state";

export interface ChecklistItem {
  id: string;
  kind: "chapter" | "action";
  title: string;
  /** The chapter's summary, or what the action asks for. */
  body: string;
  done: boolean;
  /** The chapter to run: the item's own, or the one that shows how to do the action. */
  chapter: string | null;
}

export interface Checklist {
  items: ChecklistItem[];
  done: number;
  total: number;
  /** Whether the rail shows it: not put away, and something is left to do. */
  shown: boolean;
}

/** The checklist for this Mac: the welcome tour first, then each chapter it can show, then the actions. */
export function buildChecklist(book: TourBook, state: TourState, ctx: TourContext): Checklist {
  const items: ChecklistItem[] = [];
  const core = book.chapters.find((c) => c.id === book.core);
  const chapters = core ? [core, ...book.chapters.filter((c) => c !== core)] : book.chapters;
  for (const c of chapters) {
    if (!holds(c.when, ctx) || !c.steps.some((s) => holds(s.when, ctx))) continue;
    items.push({ id: c.id, kind: "chapter", title: c.id === book.core ? "Take the welcome tour" : `Tour ${c.title}`, body: c.summary, done: state.completed.includes(c.id), chapter: c.id });
  }
  for (const a of book.actions) {
    if (!holds(a.when, ctx)) continue;
    items.push({ id: a.id, kind: "action", title: a.title, body: a.body, done: !!state.checklist.done[a.id], chapter: a.chapter ?? null });
  }
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, shown: !state.checklist.dismissed && done < items.length };
}

// ── the actions' detectors ──

/** What a detector may read: a vault file's text (null when it is not there) and a folder's file paths. */
export interface CacheReader {
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
}

/** The runs log (data/runs.ts RUNS_PATH). */
export const RUNS_LOG = "brain/_index/agent-runs/runs.jsonl";
/** The memory trail (data/promoteTrail.ts TRAIL_PATH). */
export const MEMORY_TRAIL = "brain/_index/promote-log.jsonl";
/** The routines folder (data/routines.ts ROUTINES_DIR). */
export const ROUTINES_FOLDER = "brain/routines";
/** The persona's identity (data/aosConfig.ts PERSONA_IDENTITY_PATH): there once the Chief of Staff is set up. */
export const PERSONA_IDENTITY = "persona/IDENTITY.md";
/** The routines every vault starts with (vault-template/brain/routines): not the user's own. */
export const SEEDED_ROUTINES = ["README", "briefing", "monitor", "reflect", "sitrep"];
/** Trail verbs that are a person deciding on a memory (Brain's Review and Library): kept, archived, superseded, merged. */
const REVIEW_VERBS = new Set(["kept", "archived", "superseded", "merged"]);

function jsonl(text: string | null): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line) as unknown; if (o && typeof o === "object") rows.push(o as Record<string, unknown>); } catch { /* a torn line */ }
  }
  return rows;
}

/** A session row in the runs log (data/runs.ts isSessionRow): any host's session counts. */
export function hasSession(runsLog: string | null): boolean {
  return jsonl(runsLog).some((r) => r.script === "session" || (!r.script && /^sess-/.test(String(r.id ?? ""))));
}

/** A memory a person decided on in the trail. */
export function hasReview(trail: string | null): boolean {
  return jsonl(trail).some((r) => typeof r.action === "string" && REVIEW_VERBS.has(r.action));
}

/** A routine file that is not one of the seeded ones. */
export function hasOwnRoutine(files: readonly string[]): boolean {
  return files.some((f) => {
    const m = /([^/]+)\.md$/.exec(f);
    return !!m && !SEEDED_ROUTINES.includes(m[1]);
  });
}

export const DETECTORS: Record<string, (r: CacheReader) => Promise<boolean>> = {
  session: async (r) => hasSession(await r.read(RUNS_LOG)),
  routine: async (r) => hasOwnRoutine(await r.list(ROUTINES_FOLDER)),
  "memory-reviewed": async (r) => hasReview(await r.read(MEMORY_TRAIL)),
  persona: async (r) => (await r.read(PERSONA_IDENTITY)) !== null,
};

/** The actions seen done now, among those not yet ticked. A detector that fails counts as not done. */
export async function detectDone(actions: readonly ChecklistAction[], state: TourState, reader: CacheReader): Promise<string[]> {
  const out: string[] = [];
  for (const a of actions) {
    if (state.checklist.done[a.id]) continue;
    const detect = DETECTORS[a.detect];
    try { if (detect && await detect(reader)) out.push(a.id); } catch { /* unreadable: not done */ }
  }
  return out;
}
