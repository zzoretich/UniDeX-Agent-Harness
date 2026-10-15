// The tour's memory on this Mac (tour C4, C9, C10): the HUD settings key `tour`, saved with the rest of the HUD's settings
// (saveData, the pulseSeenAt precedent), so it needs no bridge call and no write surface. loadSettings copies a stored
// value as it is, so everything here reads through sanitizeTourState, and every change returns a new object: the
// default lives in DEFAULT_SETTINGS and must never be mutated. Pure, so node:test can load it.

export interface ChecklistState {
  /** The rail's Getting started item was put away (Help ▸ Getting started brings it back). */
  dismissed: boolean;
  /** Each checklist action seen done, by its id, with when it was first seen (an ISO time). */
  done: Record<string, string>;
}

export interface TourState {
  /** The version whose What's new this Mac last showed (or whose welcome tour it ran); null before either. */
  lastSeenVersion: string | null;
  /** Chapters run to their last step, by id ("core" is the welcome tour). */
  completed: string[];
  /** Chapters skipped part way (Esc or Skip tour), by id. */
  dismissed: string[];
  checklist: ChecklistState;
  /** Tabs whose chapter has been offered once on a first visit (the chip), by tab id. */
  offered: string[];
  /**
   * The launch sequence's dialogs this Mac has shown (tour C11, ui/launchSequence.ts): "go-local@<vault key>" and
   * "import@<vault key>" per vault (tour/launch.ts vaultKey), and "whats-new@<version>" for the What's new card of a
   * release. The e2e harness pre-marks them.
   */
  launched: string[];
}

export const DEFAULT_TOUR_STATE: TourState = {
  lastSeenVersion: null,
  completed: [],
  dismissed: [],
  checklist: { dismissed: false, done: {} },
  offered: [],
  launched: [],
};

/** A version this file keeps: x.y.z with an optional pre-release or build tail. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** A chapter, tab or task id: lower-case words joined by hyphens or colons. */
const ID = /^[a-z0-9][a-z0-9:-]{0,63}$/;
const MAX_IDS = 200;
/** A launch-sequence id: an ID, "go-local@<8 hex>" or "import@<8 hex>" (per vault), or "whats-new@x.y.z". */
const LAUNCH_ID = /^(?:[a-z0-9][a-z0-9:-]{0,63}|(?:go-local|import)@[0-9a-f]{8}|whats-new@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function ids(v: unknown, re: RegExp = ID): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && re.test(x)))].slice(0, MAX_IDS);
}

/** A clean copy of a stored tour state; anything missing or malformed reads as its default. Never throws. */
export function sanitizeTourState(raw: unknown): TourState {
  const r = isRecord(raw) ? raw : {};
  const c = isRecord(r.checklist) ? r.checklist : {};
  const done: Record<string, string> = {};
  if (isRecord(c.done)) {
    for (const [k, v] of Object.entries(c.done)) {
      if (ID.test(k) && typeof v === "string" && !Number.isNaN(Date.parse(v)) && Object.keys(done).length < MAX_IDS) done[k] = v;
    }
  }
  return {
    lastSeenVersion: typeof r.lastSeenVersion === "string" && VERSION.test(r.lastSeenVersion) ? r.lastSeenVersion : null,
    completed: ids(r.completed),
    dismissed: ids(r.dismissed),
    checklist: { dismissed: c.dismissed === true, done },
    offered: ids(r.offered),
    launched: ids(r.launched, LAUNCH_ID),
  };
}

const add = (list: string[], id: string): string[] => (list.includes(id) ? list : [...list, id]);

/** The chapter ran to its end: completed, and no longer counted as skipped. */
export function markCompleted(s: TourState, chapter: string): TourState {
  const c = sanitizeTourState(s);
  return { ...c, completed: add(c.completed, chapter), dismissed: c.dismissed.filter((x) => x !== chapter) };
}

/** The chapter was skipped part way. One already completed stays completed. */
export function markDismissed(s: TourState, chapter: string): TourState {
  const c = sanitizeTourState(s);
  return c.completed.includes(chapter) ? c : { ...c, dismissed: add(c.dismissed, chapter) };
}

/** The tab's chapter was offered (its chip shown): it is never offered again. */
export function markOffered(s: TourState, tab: string): TourState {
  const c = sanitizeTourState(s);
  return { ...c, offered: add(c.offered, tab) };
}

/** Checklist actions seen done now; the first time each was seen is kept. */
export function markDone(s: TourState, tasks: string[], at: Date): TourState {
  const c = sanitizeTourState(s);
  const done = { ...c.checklist.done };
  for (const t of tasks) if (ID.test(t) && !done[t]) done[t] = at.toISOString();
  return { ...c, checklist: { ...c.checklist, done } };
}

/** Puts the checklist away, or brings it back. */
export function setChecklistDismissed(s: TourState, dismissed: boolean): TourState {
  const c = sanitizeTourState(s);
  return { ...c, checklist: { ...c.checklist, dismissed } };
}

/** What's new for `version` was shown (or the welcome tour ran on it). */
export function markSeen(s: TourState, version: string): TourState {
  const c = sanitizeTourState(s);
  return VERSION.test(version) ? { ...c, lastSeenVersion: version } : c;
}

/** A launch-sequence dialog was shown (tour C11): it never opens on its own again. */
export function markLaunched(s: TourState, id: string): TourState {
  const c = sanitizeTourState(s);
  return LAUNCH_ID.test(id) ? { ...c, launched: add(c.launched, id) } : c;
}
