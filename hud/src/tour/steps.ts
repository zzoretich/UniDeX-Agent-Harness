// The tour's content (tour C5, C6): steps.json, a chapter for every surface plus the welcome tour ("core"), and the
// Getting started actions. Content is data so tools/ (CommonJS) can check it; this module types it and says what is
// wrong with it (steps.test.ts runs validateBook over the shipped file). Pure, so node:test can load it.
import raw from "./steps.json";
import { isPredicate } from "./predicates";
import { BRAIN_MODES } from "../data/brainModel";
import { SPACES_PANES } from "../data/statusline";

export type Advance = "click" | "next";

export interface TourStep {
  id: string;
  /** The tab to show before the step (WorkbenchView.open); none for the rail, the status bar and other chrome. */
  tab?: string;
  /** Brain only: the mode to show. */
  mode?: string;
  /** Spaces: the pane to show for the selected workspace; Sessions: "history", its History (install-import B11). */
  pane?: string;
  /** A CSS selector for the one control the step spotlights. */
  anchor: string;
  title: string;
  /** Plain text: `**bold**`, ⌘ glyphs, `{host}` and `{cmd:<name>}`; never HTML. */
  body: string;
  /** "click" waits for the user's click on the control; "next" for Next (→ moves on from either). */
  advance: Advance;
  /** A predicate (predicates.ts); the step is skipped when it fails. */
  when?: string;
  /** The release the step first shipped in. */
  since: string;
}

export interface TourChapter {
  id: string;
  title: string;
  /** The tab the chapter tours: Tour this tab and the first visit's chip offer it there. */
  tab?: string;
  /** Brain only: the mode the chapter tours. */
  mode?: string;
  /** One line for the Getting started checklist. */
  summary: string;
  when?: string;
  steps: TourStep[];
}

/** A Getting started task the HUD sees done in the runtime's caches (checklist.ts DETECTORS). */
export interface ChecklistAction {
  id: string;
  title: string;
  body: string;
  /** The detector that says it is done. */
  detect: string;
  /** A chapter that shows how. */
  chapter?: string;
  when?: string;
}

export interface TourBook {
  schema: 1;
  /** The welcome tour's chapter id. */
  core: string;
  chapters: TourChapter[];
  actions: ChecklistAction[];
}

/** The tabs a step may route to (WorkbenchView WORKBENCH_TAB_IDS; kept here so this module stays import-free of views). */
export const TOUR_TABS = ["notifications", "pulse", "term", "chat", "todo", "spaces", "files", "routines", "proposals", "memory", "agent-teams", "agents", "skills", "connectors", "runs", "settings"];
const TOUR_MODES: readonly string[] = BRAIN_MODES;
const TOUR_PANES: readonly string[] = SPACES_PANES;
/** The Sessions tab's one pane a step may show: History (install-import B11). */
const SESSIONS_PANES: readonly string[] = ["history"];
/** The detectors checklist.ts knows. */
export const TOUR_DETECTORS = ["session", "routine", "memory-reviewed", "persona"];

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const HTML = /<\/?[a-z][^>]*>/i;

/** A step's global id: "<chapter>.<step>". */
export const stepRef = (chapter: string, step: string): string => `${chapter}.${step}`;

/** The problems with a book: none for a good one. Checks the shape, ids, predicates, tabs, modes, text and anchors. */
export function validateBook(book: unknown, o: { selectorOk?: (s: string) => boolean } = {}): string[] {
  const out: string[] = [];
  const b = book as Partial<TourBook> | null;
  if (!b || typeof b !== "object") return ["steps.json is not an object"];
  if (b.schema !== 1) out.push("schema must be 1");
  if (!Array.isArray(b.chapters)) return [...out, "chapters must be a list"];
  const chapterIds = new Set<string>();
  for (const c of b.chapters) {
    const at = `chapter ${c?.id ?? "?"}`;
    if (!c || typeof c.id !== "string" || !KEBAB.test(c.id)) { out.push(`${at}: id must be kebab-case`); continue; }
    if (chapterIds.has(c.id)) out.push(`${at}: listed twice`);
    chapterIds.add(c.id);
    if (typeof c.title !== "string" || !c.title.trim()) out.push(`${at}: no title`);
    if (typeof c.summary !== "string" || !c.summary.trim()) out.push(`${at}: no summary`);
    else if (c.summary.length > 100) out.push(`${at}: summary over 100 characters`);
    if (c.tab !== undefined && !TOUR_TABS.includes(c.tab)) out.push(`${at}: unknown tab ${c.tab}`);
    if (c.mode !== undefined && (c.tab !== "memory" || !TOUR_MODES.includes(c.mode))) out.push(`${at}: mode ${c.mode} needs tab memory and a Brain mode`);
    if (c.when !== undefined && (typeof c.when !== "string" || !isPredicate(c.when))) out.push(`${at}: unknown predicate ${String(c.when)}`);
    if (!Array.isArray(c.steps) || !c.steps.length) { out.push(`${at}: no steps`); continue; }
    const stepIds = new Set<string>();
    for (const s of c.steps) {
      const where = `step ${c.id}.${s?.id ?? "?"}`;
      if (!s || typeof s.id !== "string" || !KEBAB.test(s.id)) { out.push(`${where}: id must be kebab-case`); continue; }
      if (stepIds.has(s.id)) out.push(`${where}: listed twice`);
      stepIds.add(s.id);
      if (s.tab !== undefined && !TOUR_TABS.includes(s.tab)) out.push(`${where}: unknown tab ${s.tab}`);
      if (s.mode !== undefined && (s.tab !== "memory" || !TOUR_MODES.includes(s.mode))) out.push(`${where}: mode ${s.mode} needs tab memory and a Brain mode`);
      if (s.pane !== undefined && !((s.tab === "spaces" && TOUR_PANES.includes(s.pane)) || (s.tab === "chat" && SESSIONS_PANES.includes(s.pane)))) {
        out.push(`${where}: pane ${s.pane} needs tab spaces and a Spaces pane, or tab chat and history`);
      }
      if (typeof s.anchor !== "string" || !s.anchor.trim()) out.push(`${where}: no anchor`);
      else if (o.selectorOk && !o.selectorOk(s.anchor)) out.push(`${where}: anchor is not a valid selector: ${s.anchor}`);
      if (typeof s.title !== "string" || !s.title.trim()) out.push(`${where}: no title`);
      else if (s.title.length > 48) out.push(`${where}: title over 48 characters`);
      if (typeof s.body !== "string" || !s.body.trim()) out.push(`${where}: no body`);
      else if (s.body.length > 320) out.push(`${where}: body over 320 characters`);
      for (const t of [s.title, s.body]) if (typeof t === "string" && HTML.test(t)) out.push(`${where}: text holds HTML`);
      if (s.advance !== "click" && s.advance !== "next") out.push(`${where}: advance must be click or next`);
      if (s.when !== undefined && (typeof s.when !== "string" || !isPredicate(s.when))) out.push(`${where}: unknown predicate ${String(s.when)}`);
      if (typeof s.since !== "string" || !VERSION.test(s.since)) out.push(`${where}: since must be x.y.z`);
    }
  }
  if (typeof b.core !== "string" || !chapterIds.has(b.core)) out.push(`core names no chapter: ${String(b.core)}`);
  if (!Array.isArray(b.actions)) out.push("actions must be a list");
  else {
    const ids = new Set<string>();
    for (const a of b.actions) {
      const at = `action ${a?.id ?? "?"}`;
      if (!a || typeof a.id !== "string" || !KEBAB.test(a.id)) { out.push(`${at}: id must be kebab-case`); continue; }
      if (ids.has(a.id) || chapterIds.has(a.id)) out.push(`${at}: id is taken`);
      ids.add(a.id);
      if (typeof a.title !== "string" || !a.title.trim()) out.push(`${at}: no title`);
      if (typeof a.body !== "string" || !a.body.trim()) out.push(`${at}: no body`);
      if (!TOUR_DETECTORS.includes(a.detect)) out.push(`${at}: unknown detector ${String(a.detect)}`);
      if (a.chapter !== undefined && !chapterIds.has(a.chapter)) out.push(`${at}: unknown chapter ${a.chapter}`);
      if (a.when !== undefined && (typeof a.when !== "string" || !isPredicate(a.when))) out.push(`${at}: unknown predicate ${String(a.when)}`);
    }
  }
  return out;
}

/** steps.json as shipped. */
export const BOOK: TourBook = raw as unknown as TourBook;

export function chapterById(book: TourBook, id: string): TourChapter | null {
  return book.chapters.find((c) => c.id === id) ?? null;
}

/** Every step ref and chapter id: what a What's new entry's "Show me" may name. */
export function allRefs(book: TourBook): Set<string> {
  const refs = new Set<string>();
  for (const c of book.chapters) {
    refs.add(c.id);
    for (const s of c.steps) refs.add(stepRef(c.id, s.id));
  }
  return refs;
}

/** The steps a list of refs names, in order: a chapter id is all its steps, "<chapter>.<step>" one step. */
export function resolveRefs(book: TourBook, refs: readonly string[]): Array<{ chapter: TourChapter; step: TourStep }> {
  const out: Array<{ chapter: TourChapter; step: TourStep }> = [];
  for (const ref of refs) {
    const [cid, sid] = ref.split(".");
    const chapter = chapterById(book, cid);
    if (!chapter) continue;
    for (const step of chapter.steps) if (!sid || step.id === sid) out.push({ chapter, step });
  }
  return out;
}

/**
 * The chapter "Tour this tab" and the first visit offer on `tab`: the one for its mode when the tab has modes and one
 * matches, else the tab's own (the chapter for the tab with no mode).
 */
export function chapterForTab(book: TourBook, tab: string, mode: string | null = null): TourChapter | null {
  const forTab = book.chapters.filter((c) => c.tab === tab && c.id !== book.core);
  return (mode ? forTab.find((c) => c.mode === mode) : undefined) ?? forTab.find((c) => !c.mode) ?? null;
}
