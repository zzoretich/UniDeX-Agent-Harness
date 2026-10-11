// brainModel.ts — the Brain hub's data (spec 2026-10-11-brain-hub D1–D5, D7, D11, D12, D15, D16; plan PR 2). Pure: it
// takes the text of the memory files, MEMORY.md, the trail and the runtime's caches (brain/_index/brain-hub.json,
// brain-sources.json), and gives the views their modes, Review's batches and queues, Library's rows, the rail badge
// and the argv of every `aos memory` verb. The views read files through the vault adapter and run the verbs through
// plugin.aosJson (the `brain` surface); nothing here touches the vault.
//
// brain-hub.json is written by the scan, so between scans it lags the files: a memory kept a minute ago is still in its
// batch there. The model reads both and lets the files win: a batch keeps only the memories that are still live and
// unreviewed, and a memory written since the last scan gets a batch of its own (reviewBatches).
//
// The frontmatter rules mirror brain/scripts/lib/memory-ops.js (describe, getKey, getStatus, titleOf): one parser's
// answer, read twice.
import { parseTrail, type TrailEntry } from "./promoteTrail";
import { sha256Hex } from "./sha256";

// ── paths ──

export const BRAIN_HUB_PATH = "brain/_index/brain-hub.json";
export const BRAIN_SOURCES_PATH = "brain/_index/brain-sources.json";
export const MEMORY_INDEX_PATH = "MEMORY.md";
export const MEMORY_ROOT = "brain/memory";
export const DRAFTS_DIR = "brain/memory/feedback/_drafts";
export const PATTERNS_DIR = "brain/patterns";
export const REFLECTIONS_DIR = "brain/reflections";

export const MEMORY_TYPES = ["user", "feedback", "projects", "reference"] as const;
export type BrainMemoryType = (typeof MEMORY_TYPES)[number];
/** A memory's path as the runtime accepts it (memory-ops.js PATH_RE): a direct child of one of the four type folders. */
export const MEMORY_PATH_RE = /^brain\/memory\/(user|feedback|projects|reference)\/([a-z0-9][a-z0-9.-]{0,120})\.md$/;
/** A feedback draft's name (memory-ops.js SLUG_RE). */
export const DRAFT_SLUG_RE = /^[a-z0-9][a-z0-9.-]{0,120}$/;
/** The statuses that take a memory out of recall, the MOCs and BRAIN.md (D5, D7). */
export const GONE_STATUSES: readonly string[] = ["archived", "superseded"];
/** The statuses `aos memory set` offers (D17). */
export const SET_STATUSES = ["active", "complete", "paused"] as const;
export type SetStatus = (typeof SET_STATUSES)[number];

/** Whether a vault event on `path` can change the hub (the memory store, its index, the trail or the caches). */
export function touchesBrain(path: string): boolean {
  return path === MEMORY_INDEX_PATH || path === BRAIN_HUB_PATH || path === BRAIN_SOURCES_PATH || path === TRAIL_PATH_REL ||
    path === MEMORY_ROOT || path.startsWith(`${MEMORY_ROOT}/`) || path.startsWith(`${PATTERNS_DIR}/`) || path.startsWith(`${REFLECTIONS_DIR}/`);
}
const TRAIL_PATH_REL = "brain/_index/promote-log.jsonl";

// ── modes, queues, kinds (D2, D3) ──

export const BRAIN_MODES = ["review", "library", "bootstrap", "map", "health"] as const;
export type BrainMode = (typeof BRAIN_MODES)[number];
export const BRAIN_MODE_LABEL: Record<BrainMode, string> = { review: "Review", library: "Library", bootstrap: "Bootstrap", map: "Map", health: "Health" };
export function isBrainMode(x: unknown): x is BrainMode { return typeof x === "string" && (BRAIN_MODES as readonly string[]).includes(x); }

export const REVIEW_QUEUES = ["session", "drafts", "duplicates", "older"] as const;
export type ReviewQueue = (typeof REVIEW_QUEUES)[number];
export const REVIEW_QUEUE_LABEL: Record<ReviewQueue, string> = { session: "By session", drafts: "Drafts", duplicates: "Duplicates", older: "Older than 30d" };
export function isReviewQueue(x: unknown): x is ReviewQueue { return typeof x === "string" && (REVIEW_QUEUES as readonly string[]).includes(x); }

export const LIBRARY_KINDS = ["memories", "drafts", "patterns", "reflections"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export const LIBRARY_KIND_LABEL: Record<LibraryKind, string> = { memories: "Memories", drafts: "Drafts", patterns: "Patterns", reflections: "Reflections" };

/** Where a link into the hub lands (D15): a mode, Review's queue, a memory to show in Library. Select only. */
export interface BrainTarget { mode?: BrainMode | null; queue?: ReviewQueue | null; memory?: string | null }

// ── frontmatter (memory-ops.js splitFm, getKey, getStatus, titleOf) ──

interface Front { lines: string[]; body: string; has: boolean }

/** The frontmatter's lines (without their line ends) and the body after the closing `---`. */
export function splitFrontmatter(text: string): Front {
  const open = text.startsWith("---\r\n") ? 5 : text.startsWith("---\n") ? 4 : 0;
  if (!open) return { lines: [], body: text, has: false };
  const m = /(^|\n)---[ \t]*(?:\r?\n|$)/.exec(text.slice(open));
  if (!m) return { lines: [], body: text, has: false };
  const close = open + m.index + m[1].length;
  const block = text.slice(open, close);
  return { lines: block ? block.replace(/\r?\n$/, "").split(/\r?\n/) : [], body: text.slice(close + m[0].length - m[1].length), has: true };
}

const unquote = (v: string): string => v.replace(/^(["'])(.*)\1$/, "$2");

/** A top-level key's value, quotes stripped; null when absent. */
export function fmKey(lines: readonly string[], key: string): string | null {
  const re = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`);
  for (const l of lines) { const m = re.exec(l); if (m) return unquote(m[1]); }
  return null;
}

const TAGS_INLINE = /^tags:[ \t]*\[(.*)\][ \t]*$/;
const STATUS_TAG = /^status\/([A-Za-z0-9_-]+)$/;

/** The `status/<x>` tag's x, inline `tags: [...]` or a block list; null when there is none. */
export function fmStatus(lines: readonly string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const inline = TAGS_INLINE.exec(lines[i]);
    if (inline) {
      for (const t of inline[1].split(",")) { const m = STATUS_TAG.exec(unquote(t.trim())); if (m) return m[1]; }
      return null;
    }
    if (/^tags:[ \t]*$/.test(lines[i])) {
      for (let j = i + 1; j < lines.length && /^[ \t]+-/.test(lines[j]); j++) {
        const m = STATUS_TAG.exec(unquote(lines[j].replace(/^[ \t]+-[ \t]*/, "").trim()));
        if (m) return m[1];
      }
      return null;
    }
  }
  return null;
}

/** The body's first H1, else `fallback`. */
export function titleOf(body: string, fallback: string): string {
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  return m ? m[1] : fallback;
}

/** The body's first paragraph that is not a heading, on one line. */
export function firstParagraph(body: string): string {
  const p = body.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).find((b) => b && !b.startsWith("#"));
  return p ? p.replace(/\s+/g, " ") : "";
}

/** `s` cut to `n` characters with an ellipsis. */
export function clip(s: string, n: number): string { return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; }

// ── the store ──

export interface BrainMemory {
  path: string;
  type: BrainMemoryType;
  slug: string;
  title: string;
  /** frontmatter `description:` */
  description: string | null;
  /** What a row says under its title: the description, else MEMORY.md's line, else the first paragraph. */
  summary: string;
  status: string | null;
  /** Not archived or superseded. */
  live: boolean;
  pin: boolean;
  reviewed: boolean | null;
  source: string | null;
  session: string | null;
  created: string | null;
  updated: string | null;
  supersededBy: string | null;
  archived: string | null;
  body: string;
  /** sha256 of the text, as `aos memory list --json` prints it: `set --expect` (D17). */
  hash: string;
}

/** MEMORY.md's description per memory path (`- [Title](brain/memory/…md) — description`, brain-hub.js readIndexLines). */
export function parseIndexLines(raw: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of String(raw ?? "").split("\n")) {
    const b = /^\s*-\s*\[([^\]]*)\]\((brain\/memory\/[^)]+\.md)\)\s*(?:—\s*(.*))?$/.exec(l);
    if (b && !out.has(b[2])) out.set(b[2], (b[3] ?? "").trim());
  }
  return out;
}

/** One memory file, or null when `path` is not a memory path (memory-ops.js describe). */
export function parseMemory(path: string, text: string, index: ReadonlyMap<string, string> = new Map()): BrainMemory | null {
  const p = MEMORY_PATH_RE.exec(path);
  if (!p) return null;
  const fm = splitFrontmatter(text);
  const status = fmStatus(fm.lines);
  const reviewed = fmKey(fm.lines, "reviewed");
  const description = fmKey(fm.lines, "description") || null;
  return {
    path, type: p[1] as BrainMemoryType, slug: p[2],
    title: titleOf(fm.body, p[2]),
    description,
    summary: clip(description || index.get(path) || firstParagraph(fm.body), 280),
    status, live: !GONE_STATUSES.includes(status ?? ""),
    pin: fmKey(fm.lines, "pin") === "true",
    reviewed: reviewed === null ? null : reviewed === "true",
    source: fmKey(fm.lines, "source") || null,
    session: fmKey(fm.lines, "session") || null,
    created: fmKey(fm.lines, "created") || null,
    updated: fmKey(fm.lines, "updated") || null,
    supersededBy: fmKey(fm.lines, "superseded_by") || null,
    archived: fmKey(fm.lines, "archived") || null,
    body: fm.body,
    hash: sha256Hex(text),
  };
}

export interface BrainDraft {
  slug: string;
  path: string;
  title: string;
  description: string | null;
  summary: string;
  session: string | null;
  created: string | null;
  body: string;
}

/** A feedback draft under brain/memory/feedback/_drafts (memory-ops.js listDrafts), or null for any other file. */
export function parseDraft(path: string, text: string): BrainDraft | null {
  const m = /^brain\/memory\/feedback\/_drafts\/([^/]+)\.md$/.exec(path);
  if (!m || !DRAFT_SLUG_RE.test(m[1])) return null;
  const fm = splitFrontmatter(text);
  const description = fmKey(fm.lines, "description") || null;
  return {
    slug: m[1], path, title: titleOf(fm.body, m[1]), description,
    summary: clip(description || firstParagraph(fm.body), 280),
    session: fmKey(fm.lines, "session") || null, created: fmKey(fm.lines, "created") || null, body: fm.body,
  };
}

export interface BrainNote { kind: "patterns" | "reflections"; path: string; title: string; summary: string; created: string | null; updated: string | null; body: string }

/** A pattern (brain/patterns/*.md) or a reflection (brain/reflections/*.md); README.md and anything deeper are not. */
export function parseNote(kind: "patterns" | "reflections", path: string, text: string): BrainNote | null {
  const dir = kind === "patterns" ? PATTERNS_DIR : REFLECTIONS_DIR;
  const m = new RegExp(`^${dir.replace("/", "\\/")}\\/([^/]+)\\.md$`).exec(path);
  if (!m || m[1] === "README") return null;
  const fm = splitFrontmatter(text);
  return {
    kind, path, title: titleOf(fm.body, m[1]), summary: clip(fmKey(fm.lines, "description") || firstParagraph(fm.body), 280),
    created: fmKey(fm.lines, "created") || null, updated: fmKey(fm.lines, "updated") || null, body: fm.body,
  };
}

// ── the runtime's caches (D10, D12) ──

export interface HubBatch { key: string; session: string | null; host: string | null; title: string; lead: string | null; at: string; paths: string[] }
export interface HubDup { a: string; b: string; score: number; title: number; text: number; meaning: number | null }
export interface HubCluster { paths: string[]; label: string }
export interface HubUsageRow { d7: number; d30: number; last: string | null; injected: number; recalled: number; read: number; claude: number; codex: number }
export interface HubUsage { since: string | null; paths: Record<string, HubUsageRow> }
export interface HubCounts {
  memories: number; byType: Record<string, number>; unreviewed: number; drafts: number; patterns: number; reflections: number;
  archived: number; superseded: number;
}
export interface BrainHub {
  schema: 1;
  builtAt: string | null;
  counts: HubCounts;
  batches: HubBatch[];
  dups: HubDup[];
  clusters: HubCluster[];
  usage: HubUsage;
  hygiene: Record<string, unknown>;
  shipped: Array<{ path: string; why: string }>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** brain-hub.json, or null when missing, unparseable or not schema 1. Every field is coerced: a bad row is dropped. */
export function parseBrainHub(raw: string | null): BrainHub | null {
  if (!raw) return null;
  let doc: Record<string, unknown>;
  try { doc = rec(JSON.parse(raw)); } catch { return null; }
  if (doc.schema !== 1) return null;
  const c = rec(doc.counts);
  const usage = rec(doc.usage);
  const paths: Record<string, HubUsageRow> = {};
  for (const [p, t] of Object.entries(rec(usage.paths))) {
    const r = rec(t);
    paths[p] = { d7: num(r.d7), d30: num(r.d30), last: strOrNull(r.last), injected: num(r.injected), recalled: num(r.recalled), read: num(r.read), claude: num(r.claude), codex: num(r.codex) };
  }
  return {
    schema: 1,
    builtAt: strOrNull(doc.builtAt),
    counts: {
      memories: num(c.memories), byType: Object.fromEntries(Object.entries(rec(c.byType)).map(([k, v]) => [k, num(v)])),
      unreviewed: num(c.unreviewed), drafts: num(c.drafts), patterns: num(c.patterns), reflections: num(c.reflections),
      archived: num(c.archived), superseded: num(c.superseded),
    },
    batches: arr<Record<string, unknown>>(doc.batches).map(rec).filter((b) => typeof b.key === "string" && Array.isArray(b.paths)).map((b) => ({
      key: b.key as string, session: strOrNull(b.session), host: strOrNull(b.host), title: strOrNull(b.title) ?? String(b.key),
      lead: strOrNull(b.lead), at: strOrNull(b.at) ?? "", paths: arr<unknown>(b.paths).filter((p): p is string => typeof p === "string"),
    })),
    dups: arr<Record<string, unknown>>(doc.dups).map(rec).filter((d) => typeof d.a === "string" && typeof d.b === "string").map((d) => ({
      a: d.a as string, b: d.b as string, score: num(d.score), title: num(d.title), text: num(d.text), meaning: typeof d.meaning === "number" ? d.meaning : null,
    })),
    clusters: arr<Record<string, unknown>>(doc.clusters).map(rec).filter((k) => Array.isArray(k.paths)).map((k) => ({
      paths: arr<unknown>(k.paths).filter((p): p is string => typeof p === "string"), label: strOrNull(k.label) ?? "",
    })),
    usage: { since: strOrNull(usage.since), paths },
    hygiene: rec(doc.hygiene),
    shipped: arr<Record<string, unknown>>(doc.shipped).map(rec).filter((s) => typeof s.path === "string").map((s) => ({ path: s.path as string, why: strOrNull(s.why) ?? "" })),
  };
}

export type BrainSection = "who" | "rules" | "active";
export interface BrainSources {
  builtAt: string | null;
  budget: number;
  tokens: number;
  sections: Record<BrainSection, { paths: string[]; tokens: number }>;
  omitted: string[];
}

/** brain-sources.json (D10), or null. */
export function parseBrainSources(raw: string | null): BrainSources | null {
  if (!raw) return null;
  let doc: Record<string, unknown>;
  try { doc = rec(JSON.parse(raw)); } catch { return null; }
  if (doc.schema !== 1) return null;
  const s = rec(doc.sections);
  const sec = (k: string) => { const x = rec(s[k]); return { paths: arr<unknown>(x.paths).filter((p): p is string => typeof p === "string"), tokens: num(x.tokens) }; };
  return {
    builtAt: strOrNull(doc.builtAt), budget: num(doc.budget), tokens: num(doc.tokens),
    sections: { who: sec("who"), rules: sec("rules"), active: sec("active") },
    omitted: arr<unknown>(rec(s.active).omitted).filter((p): p is string => typeof p === "string"),
  };
}

/** BRAIN.md against its budget, as a whole percent (Bootstrap's tab badge, the Pulse tile); null with no sources yet. */
export function brainMdPercent(src: BrainSources | null): number | null {
  if (!src || src.budget <= 0) return null;
  return Math.round((src.tokens / src.budget) * 100);
}

const SECTION_LABEL: Record<BrainSection, string> = { who: "Who you are", rules: "Critical rules", active: "Active context" };

/** The BRAIN.md section that carries `path` into every session (Library's "In BRAIN.md as"), or null. */
export function brainMdSection(src: BrainSources | null, path: string): { section: BrainSection; label: string; tokens: number } | null {
  if (!src) return null;
  for (const k of ["who", "rules", "active"] as BrainSection[]) {
    if (src.sections[k].paths.includes(path)) return { section: k, label: SECTION_LABEL[k], tokens: src.sections[k].tokens };
  }
  return null;
}

// ── the trail ──

/** The trail, oldest first (promote-log.jsonl). */
export function readTrailRows(raw: string | null): TrailEntry[] {
  return parseTrail(raw ?? "", Infinity).reverse();
}

const trailKey = (type: string, slug: string): string => `${type}/${slug}`;

/** When auto-wrap wrote each memory: the latest `written` row's ts per type/slug. */
export function writtenAtMap(trail: readonly TrailEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of trail) if (r.action === "written" && r.type && r.slug && (!out.has(trailKey(r.type, r.slug)) || r.ts > out.get(trailKey(r.type, r.slug))!)) out.set(trailKey(r.type, r.slug), r.ts);
  return out;
}

/** When a memory was written: the trail's ts, else its `created:` date ("" when neither). */
export function writtenAt(m: Pick<BrainMemory, "type" | "slug" | "created">, written: ReadonlyMap<string, string>): string {
  return written.get(trailKey(m.type, m.slug)) ?? m.created ?? "";
}

/** A memory's trail rows, newest first (Library's History). */
export function historyFor(trail: readonly TrailEntry[], m: Pick<BrainMemory, "type" | "slug">): TrailEntry[] {
  return trail.filter((r) => r.type === m.type && r.slug === m.slug).slice().reverse();
}

// ── Review (D3, D4, D7, D11) ──

/** A memory that looks like another one: the best partner and its score. */
export interface DupFlag { other: string; score: number }

export const pairKey = (a: string, b: string): string => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

/** The duplicate pairs whose memories are both still live and that this page has not dismissed, best first. */
export function livePairs(hub: BrainHub | null, byPath: ReadonlyMap<string, BrainMemory>, dismissed: ReadonlySet<string> = new Set()): HubDup[] {
  return (hub?.dups ?? [])
    .filter((d) => byPath.get(d.a)?.live && byPath.get(d.b)?.live && !dismissed.has(pairKey(d.a, d.b)))
    .sort((x, y) => y.score - x.score || x.a.localeCompare(y.a));
}

/** Each memory's best duplicate partner among the live pairs. */
export function dupFlags(pairs: readonly HubDup[]): Map<string, DupFlag> {
  const out = new Map<string, DupFlag>();
  for (const d of pairs) {
    for (const [me, other] of [[d.a, d.b], [d.b, d.a]]) {
      const cur = out.get(me);
      if (!cur || d.score > cur.score) out.set(me, { other, score: d.score });
    }
  }
  return out;
}

export interface ReviewBatch {
  key: string;
  title: string;
  /** The first memory's title: many sessions share one custom name. */
  lead: string | null;
  host: string | null;
  session: string | null;
  at: string;
  /** The memories still to review, oldest written first. */
  paths: string[];
  /** Those with no duplicate flag: what "Keep the N new" keeps (⇧K). */
  fresh: string[];
  /** Those that look like a memory you already have. */
  known: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

/** brain-hub.js buildBatches' key and title for a memory the last scan did not see; `day` is when it was written. */
function batchKeyOf(m: BrainMemory, day: string): { key: string; session: string | null; title: string } {
  const d = day || "undated";
  if (m.session && UUID.test(m.session)) return { key: m.session, session: m.session, title: `Session ${m.session.slice(0, 8)} · ${d}` };
  const key = `${m.session || "none"}:${day}`;
  return { key, session: null, title: key.startsWith("in-session") ? `In-session wrap · ${d}` : `Wrap · ${d}` };
}

/**
 * Review's batches (D3): the hub's, each keeping only the memories still live and unreviewed in the files, plus a batch
 * for each session whose memories the last scan did not see (one that matches a hub batch joins it). Newest first.
 *
 * A memory no hub batch holds landed after the hub was built, so with no trail row (its `created:` is a day, not a time)
 * it counts as written no earlier than `builtAt`: a session that wrote one this afternoon sorts above this morning's.
 */
export function reviewBatches(memories: readonly BrainMemory[], hub: BrainHub | null, written: ReadonlyMap<string, string>, flags: ReadonlyMap<string, DupFlag>): ReviewBatch[] {
  const open = new Map(memories.filter((m) => m.live && m.reviewed === false).map((m) => [m.path, m]));
  const groups = new Map<string, Omit<ReviewBatch, "fresh" | "known">>();
  const seen = new Set<string>();
  const atOf = new Map<string, string>();
  for (const b of hub?.batches ?? []) {
    const paths = b.paths.filter((p) => open.has(p) && !seen.has(p));
    for (const p of paths) { seen.add(p); atOf.set(p, writtenAt(open.get(p)!, written)); }
    if (!paths.length) continue;
    const g = groups.get(b.key);
    if (g) g.paths.push(...paths);
    else groups.set(b.key, { key: b.key, title: b.title, lead: b.lead, host: b.host, session: b.session, at: b.at, paths });
  }
  const built = hub?.builtAt ?? "";
  for (const m of open.values()) {
    if (seen.has(m.path)) continue;
    const own = writtenAt(m, written);
    const traced = written.has(trailKey(m.type, m.slug));
    const at = !traced && built && !(timeOf(own) > timeOf(built)) ? built : own;
    atOf.set(m.path, at);
    const k = batchKeyOf(m, own.slice(0, 10));
    const g = groups.get(k.key) ?? { key: k.key, title: k.title, lead: m.title, host: null, session: k.session, at: "", paths: [] };
    g.paths.push(m.path);
    if (later(at, g.at)) g.at = at;
    groups.set(k.key, g);
  }
  const t = (p: string): number => sortTime(atOf.get(p) ?? "");
  return [...groups.values()]
    .map((g) => {
      const paths = [...g.paths].sort((a, b) => t(a) - t(b) || a.localeCompare(b));
      return { ...g, lead: g.lead ?? open.get(paths[0])?.title ?? null, paths, fresh: paths.filter((p) => !flags.has(p)), known: paths.filter((p) => flags.has(p)) };
    })
    .sort((a, b) => sortTime(b.at) - sortTime(a.at) || a.key.localeCompare(b.key));
}

const DAY_MS = 24 * 3600 * 1000;
/** A timestamp or a `YYYY-MM-DD` day (local midnight) in ms; NaN when it is neither. */
const timeOf = (s: string): number => { const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s); return Number.isFinite(t) ? t : NaN; };
const sortTime = (s: string): number => { const t = timeOf(s); return Number.isFinite(t) ? t : -Infinity; };
const later = (a: string, b: string): boolean => sortTime(a) > sortTime(b);

/** Batches written in the last 7 days, and the rest ("Earlier", folded). */
export function splitByWeek(batches: readonly ReviewBatch[], now: Date): { week: ReviewBatch[]; earlier: ReviewBatch[] } {
  const cut = now.getTime() - 7 * DAY_MS;
  const week: ReviewBatch[] = [];
  const earlier: ReviewBatch[] = [];
  for (const b of batches) (timeOf(b.at) >= cut ? week : earlier).push(b);
  return { week, earlier };
}

/** The "Older than 30d" queue: live, unreviewed memories written more than `days` ago, oldest first. */
export function olderQueue(memories: readonly BrainMemory[], written: ReadonlyMap<string, string>, now: Date, days = 30): BrainMemory[] {
  const cut = now.getTime() - days * DAY_MS;
  return memories
    .filter((m) => m.live && m.reviewed === false && timeOf(writtenAt(m, written)) < cut)
    .sort((a, b) => writtenAt(a, written).localeCompare(writtenAt(b, written)) || a.path.localeCompare(b.path));
}

/** "Mark everything before <date> reviewed" (D3): the live, unreviewed memories written before that local day. */
export function writtenBefore(memories: readonly BrainMemory[], written: ReadonlyMap<string, string>, day: string): string[] {
  const cut = timeOf(day);
  if (!Number.isFinite(cut)) return [];
  return memories.filter((m) => m.live && m.reviewed === false && timeOf(writtenAt(m, written)) < cut).map((m) => m.path);
}

/** The day "Mark everything before …" offers first: the 1st of this month, or of last month in its first week. */
export function defaultMarkBefore(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  if (now.getDate() <= 7) d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export interface ReviewCounts { session: number; drafts: number; duplicates: number; older: number }

export function reviewCounts(batches: readonly ReviewBatch[], drafts: readonly BrainDraft[], pairs: readonly HubDup[], older: readonly BrainMemory[]): ReviewCounts {
  return { session: batches.reduce((n, b) => n + b.paths.length, 0), drafts: drafts.length, duplicates: pairs.length, older: older.length };
}

/** What a key does in Review (D4): ↑↓ K E M A P ⇧K ⏎. Null for anything else, and for any key held with ⌘, ⌃ or ⌥. */
export type ReviewKey = "up" | "down" | "keep" | "edit" | "merge" | "archive" | "pin" | "keepBatch" | "open";
export function reviewKey(e: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): ReviewKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "ArrowUp") return "up";
  if (e.key === "ArrowDown") return "down";
  if (e.key === "Enter") return "open";
  const k = e.key.toLowerCase();
  if (k === "k") return e.shiftKey ? "keepBatch" : "keep";
  if (e.shiftKey) return null;
  return ({ e: "edit", m: "merge", a: "archive", p: "pin" } as Record<string, ReviewKey>)[k] ?? null;
}

// ── the rail badge (D16) ──

/**
 * Memories written since Review was last opened (a per-machine marker), so the badge reaches zero: live, unreviewed,
 * written after `marker`. No marker yet counts nothing (the backlog is never the badge); the caller sets one.
 */
export function brainBadge(memories: readonly BrainMemory[], written: ReadonlyMap<string, string>, marker: string | null): number {
  const since = marker ? timeOf(marker) : NaN;
  if (!Number.isFinite(since)) return 0;
  return memories.filter((m) => m.live && m.reviewed === false && timeOf(writtenAt(m, written)) > since).length;
}

/**
 * The memories the trail says were written after the marker, each once: what the rail badge reads (it then opens only
 * these files, to count those still live and unreviewed, rather than the whole store on every vault event).
 */
export function trailSince(trail: readonly TrailEntry[], marker: string | null): string[] {
  const since = marker ? timeOf(marker) : NaN;
  if (!Number.isFinite(since)) return [];
  const out = new Set<string>();
  for (const r of trail) {
    const p = `brain/memory/${r.type}/${r.slug}.md`;
    if (r.action === "written" && timeOf(r.ts) > since && MEMORY_PATH_RE.test(p)) out.add(p);
  }
  return [...out];
}

/** The same count from the trail alone (Pulse's tile, which reads no memory files): `written` rows after the marker
 *  whose memory is still pending. */
export function sinceMarker(trail: ReadonlyArray<{ ts: string; action: string; pending?: boolean }>, marker: string | null): number {
  const since = marker ? timeOf(marker) : NaN;
  if (!Number.isFinite(since)) return 0;
  return trail.filter((r) => r.action === "written" && r.pending !== false && timeOf(r.ts) > since).length;
}

// ── the header (D2) ──

/** "338 memories · 9 patterns · 10 reflections · +13 a day": the live store and what landed per day over two weeks. */
export function headerStats(memories: readonly BrainMemory[], patterns: number, reflections: number, written: ReadonlyMap<string, string>, now: Date): string {
  const live = memories.filter((m) => m.live).length;
  const cut = now.getTime() - 14 * DAY_MS;
  const recent = memories.filter((m) => timeOf(writtenAt(m, written)) >= cut).length;
  const rate = Math.round(recent / 14);
  const pl = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  return [pl(live, "memory", "memories"), pl(patterns, "pattern", "patterns"), pl(reflections, "reflection", "reflections"), ...(rate > 0 ? [`+${rate} a day`] : [])].join(" · ");
}

export interface ModeBadge { text: string; tone: "warn" | "plain" }

/** Each mode's count in the tab strip: Review what waits, Library the live store, Bootstrap BRAIN.md's fill. */
export function modeBadges(o: { toReview: number; live: number; brainPct: number | null }): Partial<Record<BrainMode, ModeBadge>> {
  const out: Partial<Record<BrainMode, ModeBadge>> = {};
  if (o.toReview > 0) out.review = { text: String(o.toReview), tone: "warn" };
  out.library = { text: String(o.live), tone: "plain" };
  if (o.brainPct !== null) out.bootstrap = { text: `${o.brainPct}%`, tone: o.brainPct >= 100 ? "warn" : "plain" };
  return out;
}

// ── Library (D1, D2) ──

export type StatusFacet = "live" | "active" | "complete" | "paused" | "archived" | "superseded" | "any";
export const STATUS_FACETS: readonly StatusFacet[] = ["live", "active", "complete", "paused", "archived", "superseded", "any"];
export type UseFacet = "any" | "used" | "unused";

export interface LibraryFilter {
  kind: LibraryKind;
  query: string;
  type: BrainMemoryType | null;
  status: StatusFacet;
  source: string | null;
  use: UseFacet;
}
export const DEFAULT_LIBRARY_FILTER: LibraryFilter = { kind: "memories", query: "", type: null, status: "live", source: null, use: "any" };

export interface LibraryRow {
  path: string;
  kind: LibraryKind;
  title: string;
  summary: string;
  type: BrainMemoryType | null;
  status: string | null;
  pin: boolean;
  /** Uses in the last 30 days (null with no usage log). */
  use: number | null;
  /** "226×", "unused", or "" with no usage log. */
  useLabel: string;
}

export interface LibraryData { memories: readonly BrainMemory[]; drafts: readonly BrainDraft[]; patterns: readonly BrainNote[]; reflections: readonly BrainNote[] }

/** Every word of `query` (lowercased) in the haystack; the empty query matches. */
export function matchesQuery(query: string, ...hay: Array<string | null | undefined>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const h = hay.filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => h.includes(w));
}

/** A memory's status as the Status facet reads it (no status tag reads as active). */
const facetStatus = (m: BrainMemory): string => m.status ?? "active";

function statusMatches(m: BrainMemory, f: StatusFacet): boolean {
  if (f === "any") return true;
  if (f === "live") return m.live;
  return facetStatus(m) === f;
}

/** The usage log has rows (telemetry on and some session ran since the hub shipped). */
export function hasUsage(hub: BrainHub | null): boolean { return !!hub?.usage.since; }

/** Library's results (D2): the kind, the query over title, summary, body and path, the facets; by use, then newest. */
export function libraryRows(data: LibraryData, f: LibraryFilter, hub: BrainHub | null): LibraryRow[] {
  const usage = hasUsage(hub) ? hub!.usage.paths : null;
  const useOf = (p: string): number | null => (usage ? usage[p]?.d30 ?? 0 : null);
  const label = (n: number | null): string => (n === null ? "" : n > 0 ? `${n}×` : "unused");
  let rows: Array<LibraryRow & { at: string; titleHit: boolean }>;
  const q = f.query.trim();
  if (f.kind === "memories") {
    rows = data.memories
      .filter((m) => (f.type === null || m.type === f.type) && statusMatches(m, f.status) && (f.source === null || (m.source ?? "(none)") === f.source))
      .filter((m) => matchesQuery(q, m.title, m.summary, m.body, m.path))
      .map((m) => { const use = useOf(m.path); return { path: m.path, kind: f.kind, title: m.title, summary: m.summary, type: m.type, status: m.status, pin: m.pin, use, useLabel: label(use), at: m.updated ?? m.created ?? "", titleHit: matchesQuery(q, m.title) }; })
      .filter((r) => f.use === "any" || r.use === null || (f.use === "used" ? r.use > 0 : r.use === 0));
  } else if (f.kind === "drafts") {
    rows = data.drafts.filter((d) => matchesQuery(q, d.title, d.summary, d.body, d.path))
      .map((d) => ({ path: d.path, kind: f.kind, title: d.title, summary: d.summary, type: "feedback" as BrainMemoryType, status: "draft", pin: false, use: null, useLabel: "", at: d.created ?? "", titleHit: matchesQuery(q, d.title) }));
  } else {
    const notes = f.kind === "patterns" ? data.patterns : data.reflections;
    rows = notes.filter((n) => matchesQuery(q, n.title, n.summary, n.body, n.path))
      .map((n) => { const use = f.kind === "patterns" ? useOf(n.path) : null; return { path: n.path, kind: f.kind, title: n.title, summary: n.summary, type: null, status: null, pin: false, use, useLabel: label(use), at: n.updated ?? n.created ?? n.path, titleHit: matchesQuery(q, n.title) }; });
  }
  return rows
    .sort((a, b) => Number(b.titleHit && !!q) - Number(a.titleHit && !!q) || (b.use ?? -1) - (a.use ?? -1) || b.at.localeCompare(a.at) || a.title.localeCompare(b.title))
    .map(({ at: _at, titleHit: _hit, ...r }) => r);
}

/** The `source:` values among the memories, "(none)" for those without, most common first (the Source facet). */
export function sourceOptions(memories: readonly BrainMemory[]): string[] {
  const n = new Map<string, number>();
  for (const m of memories) n.set(m.source ?? "(none)", (n.get(m.source ?? "(none)") ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

/** Library's "Nearby": the live memories this one's duplicate pairs name, best first. */
export function nearby(pairs: readonly HubDup[], path: string, byPath: ReadonlyMap<string, BrainMemory>, limit = 6): Array<{ path: string; title: string; score: number }> {
  const out: Array<{ path: string; title: string; score: number }> = [];
  for (const d of pairs) {
    const other = d.a === path ? d.b : d.b === path ? d.a : null;
    const m = other ? byPath.get(other) : undefined;
    if (m) out.push({ path: m.path, title: m.title, score: d.score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** "claude 9 · codex 5" for a usage row; "" when neither host is counted. */
export function hostSplit(u: HubUsageRow | null | undefined): string {
  if (!u || (!u.claude && !u.codex)) return "";
  return [u.claude ? `claude ${u.claude}` : null, u.codex ? `codex ${u.codex}` : null].filter(Boolean).join(" · ");
}

// ── the verbs (D13, D14): `aos memory <verb> … --json` through the brain surface ──

/** At most this many paths per keep, archive or restore call (app/src/shared/surfaces.ts admits up to MAX_PATHS_PER_CALL). */
export const MAX_PATHS_PER_CALL = 50;

export type MemoryVerb =
  | { verb: "keep" | "archive" | "restore"; paths: readonly string[] }
  | { verb: "set"; path: string; fields: { pin?: boolean; status?: SetStatus; description?: string }; expect: string }
  | { verb: "supersede"; path: string; by: string }
  | { verb: "draft"; action: "approve" | "reject"; slug: string }
  | { verb: "notdup"; a: string; b: string };

/** The argv after `cli/aos.js` for a verb, `--json` last; throws on a path or slug the runtime would refuse anyway. */
export function memoryArgs(v: MemoryVerb): string[] {
  const path = (p: string): string => { if (!MEMORY_PATH_RE.test(p)) throw new Error(`not a memory path: ${p}`); return p; };
  switch (v.verb) {
    case "keep": case "archive": case "restore":
      if (!v.paths.length || v.paths.length > MAX_PATHS_PER_CALL) throw new Error(`${v.verb} takes 1–${MAX_PATHS_PER_CALL} paths`);
      return ["memory", v.verb, ...v.paths.map(path), "--json"];
    case "set":
      if (!/^(?:none|[0-9a-f]{16,64})$/.test(v.expect)) throw new Error("set needs the memory's hash");
      return ["memory", "set", path(v.path), "--set", JSON.stringify(v.fields), "--expect", v.expect, "--json"];
    case "supersede":
      return ["memory", "supersede", path(v.path), "--by", path(v.by), "--json"];
    case "draft":
      if (!DRAFT_SLUG_RE.test(v.slug)) throw new Error(`not a draft name: ${v.slug}`);
      return ["memory", "draft", v.action, v.slug, "--json"];
    case "notdup":
      return ["memory", "notdup", path(v.a), path(v.b), "--json"];
  }
}

/** `paths` in calls of at most MAX_PATHS_PER_CALL. */
export function chunks<T>(xs: readonly T[], n = MAX_PATHS_PER_CALL): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export interface KeepResult { kept: string[]; already: string[] }
export interface ArchiveResult { archived: string[]; already: string[]; brainMd: unknown }
export interface RestoreResult { restored: string[]; already: string[]; brainMd: unknown }
export interface SetResult { path: string; fields: string[]; written: boolean; hash: string; brainMd: unknown }
export interface SupersedeResult { path: string; by: string; already?: boolean; brainMd: unknown }
export interface DraftResult { approved?: string | null; rejected?: string; slug?: string }
export interface NotdupResult { pair: [string, string]; added: boolean }

export const BRAIN_OFF_TEXT = "Brain's write surface is off in this app: turn on Brain under the app's write surfaces to act from here";
export const BRAIN_UPGRADE_TEXT = "This vault's runtime predates the Brain hub: run aos upgrade";

export interface BrainVerbFailure {
  ok: false;
  reason: string;
  /** Main refused the spawn: the brain surface is off. */
  refused: boolean;
  /** The runtime does not know `aos memory` or the verb: `aos upgrade`. */
  outdated: boolean;
  /** `set --expect` refused a memory that changed since the page read it. */
  stale: boolean;
}
export type BrainVerbResult<T> = { ok: true; json: T } | BrainVerbFailure;

const fail = (reason: string, o: Partial<BrainVerbFailure> = {}): BrainVerbFailure => ({ ok: false, reason, refused: false, outdated: false, stale: false, ...o });

/** A verb's answer: the JSON object on exit 0, else why not (the runtime's own `aos: …` line, a refusal, an old runtime). */
export function brainVerbResult<T>(r: { code: number; stdout: string; stderr: string; timedOut: boolean; json: T | null; error?: string }): BrainVerbResult<T> {
  if (r.error && /\brefused\b/.test(r.error)) return fail(BRAIN_OFF_TEXT, { refused: true });
  if (r.timedOut) return fail("aos did not answer in time");
  if (r.error) return fail(`could not run aos: ${r.error}`);
  let body: unknown = r.json;
  if (body === null || body === undefined) { try { body = JSON.parse(r.stdout); } catch { body = null; } }
  if (r.code === 0 && body && typeof body === "object" && !Array.isArray(body)) return { ok: true, json: body as T };
  const lines = String(r.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  if (/unknown command: memory|unknown script memory|Cannot find module|aos memory: unknown verb/.test(first)) return fail(BRAIN_UPGRADE_TEXT, { outdated: true });
  const own = lines.find((l) => /^aos( [a-z-]+)?: /.test(l)) ?? first;
  const line = own ? own.replace(/^aos( [a-z-]+)?: /, "") : r.code === 0 ? "aos answered in an unexpected shape" : `aos exited ${r.code}`;
  return fail(line, { stale: /changed since it was read/.test(line) });
}
