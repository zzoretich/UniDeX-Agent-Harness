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
/** The Map's communities and neighbours, written beside brain-hub.json from graphify's graph (D19; PR 3). */
export const BRAIN_MAP_PATH = "brain/_index/brain-map.json";
/** The consolidation sweep's runs and suggestions (brain-hub D22; brain-ai A10), written by `aos memory sweep`. */
export const MEMORY_SWEEP_PATH = "brain/_index/memory-sweep.json";
/** Working memory and last session's recall, which Bootstrap measures against their budgets (D17). */
export const SESSION_MD_PATH = "brain/_index/SESSION.md";
export const RECALL_WAKE_PATH = "brain/_index/recall-wake.md";
/** The vault's settings (brain/config.json): telemetry, graph and memory.* decide what Map and Health can say. */
export const BRAIN_CONFIG_PATH = "brain/config.json";
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
    path === BRAIN_MAP_PATH || path === MEMORY_SWEEP_PATH || path === SESSION_MD_PATH || path === RECALL_WAKE_PATH || path === BRAIN_CONFIG_PATH ||
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

/**
 * Where a link into the hub lands (D15): a mode, Review's queue, a memory to show in Library. Select only. PR 3: `use`
 * opens Library with that use facet (Health's "Review the N" never-used memories), and `anchor` scrolls a mode to one
 * of its cards (BRAIN_ANCHORS: MEMORY.md's "Fix in Health →" lands on Hygiene).
 */
/** `pair`: the duplicate pair Review's Duplicates queue lands on (Health's Compare names the one on its row). */
export interface BrainTarget { mode?: BrainMode | null; queue?: ReviewQueue | null; memory?: string | null; use?: UseFacet | null; anchor?: BrainAnchor | null; pair?: { a: string; b: string } | null }
/** The cards a link can land on: Bootstrap's looks-shipped list and recall preview, Health's four cards. */
export const BRAIN_ANCHORS = ["shipped", "recall", "duplicates", "hygiene", "deadweight"] as const;
export type BrainAnchor = (typeof BRAIN_ANCHORS)[number];
export function isBrainAnchor(x: unknown): x is BrainAnchor { return typeof x === "string" && (BRAIN_ANCHORS as readonly string[]).includes(x); }

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

/** A scalar's text: surrounding quotes stripped, and a single-quoted `''` read as `'` (memory-ops unquote's twin). */
const unquote = (v: string): string => {
  const q = /^(["'])(.*)\1$/.exec(v);
  if (!q) return v;
  return q[1] === "'" ? q[2].replace(/''/g, "'") : q[2];
};

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
      // A block item at any indent, zero included (`tags:\n- a`): memory-ops getStatus's rule.
      for (let j = i + 1; j < lines.length && /^[ \t]*-(?:[ \t]|$)/.test(lines[j]); j++) {
        const m = STATUS_TAG.exec(unquote(lines[j].replace(/^[ \t]*-[ \t]*/, "").trim()));
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

/**
 * Whether a memory's text still waits for review: `reviewed: false` and live (no `status/archived` or
 * `status/superseded` tag). Archive and supersede leave `reviewed:` as it was (memory-ops.js retire), so a count of
 * `reviewed: false` alone keeps what the hub retired (brain-hub D5, D7). The frontmatter only, no hash: the rail badge
 * and Pulse read it per file. lib/pulse-facts.js pendingReview is its twin.
 */
export function pendingReview(text: string | null): boolean {
  if (!text) return false;
  const fm = splitFrontmatter(text);
  return fm.has && fmKey(fm.lines, "reviewed") === "false" && !GONE_STATUSES.includes(fmStatus(fm.lines) ?? "");
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
  /** The Quick links block's and the hand-editable Last Session block's tokens (Bootstrap's other two sections). */
  links: number;
  lastSession: number;
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
    links: num(rec(s.links).tokens), lastSession: num(rec(s.lastSession).tokens),
  };
}

// ── the Map (D19; PR 3): brain/_index/brain-map.json, written by brain-hub.js from graphify's graph ──

/** One community of memories: graphify's, with the index hubs taken out, named by its most-linked memory. */
export interface MapCommunity {
  /** "c<graphify community id>": stable while the graph's communities are. */
  id: string;
  /** The title of `lead`, its most-linked memory. */
  name: string;
  lead: string;
  /** Its live memories, most linked first. */
  paths: string[];
  /** Links between its own memories. */
  edges: number;
}
export interface MapLink { a: string; b: string; n: number }
export interface MapNeighbour { path: string; n: number }
export interface MapMemory {
  /** The community it belongs to, or null (a group under mapMin, or no link once the hubs are out). */
  community: string | null;
  /** How many other memories it links to. */
  degree: number;
  /** At most 12, the strongest first. */
  neighbours: MapNeighbour[];
}
export type MapState = "ok" | "off" | "missing";
export interface BrainMap {
  schema: 1;
  builtAt: string | null;
  /** "off": graph.enabled is false (`aos graph on`); "missing": no graph.json yet (the next scan builds one). */
  state: MapState;
  /** The whole graph as graphify built it (the footer's "N communities · N nodes"), null unless state is "ok". */
  graph: { builtAt: string | null; mode: string | null; nodes: number; edges: number; communities: number } | null;
  mapMin: number;
  /** The index hubs left out, as vault paths (MEMORY.md, brain/_index/MOC-*.md, brain/_index/BRAIN.md) found in the graph. */
  hubs: string[];
  /** Communities holding at least mapMin live memories, largest first. */
  communities: MapCommunity[];
  /** Links between those communities: a memory of `a` linked to one of `b`, counted. */
  links: MapLink[];
  /** Every live memory the graph holds, by path. */
  memories: Record<string, MapMemory>;
  /** What fell under mapMin: that many communities holding that many memories. */
  smaller: { communities: number; memories: number };
  /** Live memories the graph holds that link to no other memory once the hubs are out. */
  unlinked: number;
}

const MAP_STATES: readonly MapState[] = ["ok", "off", "missing"];
const strs = (v: unknown): string[] => arr<unknown>(v).filter((p): p is string => typeof p === "string");

/** brain-map.json, or null when missing, unparseable or not schema 1. Every field is coerced: a bad row is dropped. */
export function parseBrainMap(raw: string | null): BrainMap | null {
  if (!raw) return null;
  let doc: Record<string, unknown>;
  try { doc = rec(JSON.parse(raw)); } catch { return null; }
  if (doc.schema !== 1) return null;
  const state = MAP_STATES.includes(doc.state as MapState) ? (doc.state as MapState) : "missing";
  const g = doc.graph && typeof doc.graph === "object" ? rec(doc.graph) : null;
  const memories: Record<string, MapMemory> = {};
  for (const [p, v] of Object.entries(rec(doc.memories))) {
    if (!MEMORY_PATH_RE.test(p)) continue;
    const m = rec(v);
    memories[p] = {
      community: strOrNull(m.community), degree: num(m.degree),
      neighbours: arr<Record<string, unknown>>(m.neighbours).map(rec).filter((n) => typeof n.path === "string" && MEMORY_PATH_RE.test(n.path as string)).slice(0, 12).map((n) => ({ path: n.path as string, n: num(n.n) })),
    };
  }
  const sm = rec(doc.smaller);
  return {
    schema: 1, builtAt: strOrNull(doc.builtAt), state,
    graph: state === "ok" && g ? { builtAt: strOrNull(g.builtAt), mode: strOrNull(g.mode), nodes: num(g.nodes), edges: num(g.edges), communities: num(g.communities) } : null,
    mapMin: num(doc.mapMin), hubs: strs(doc.hubs),
    communities: arr<Record<string, unknown>>(doc.communities).map(rec).filter((c) => typeof c.id === "string").map((c) => ({
      id: c.id as string, name: strOrNull(c.name) ?? String(c.id), lead: strOrNull(c.lead) ?? "",
      paths: strs(c.paths).filter((p) => MEMORY_PATH_RE.test(p)), edges: num(c.edges),
    })),
    links: arr<Record<string, unknown>>(doc.links).map(rec).filter((l) => typeof l.a === "string" && typeof l.b === "string").map((l) => ({ a: l.a as string, b: l.b as string, n: num(l.n) })),
    memories, smaller: { communities: num(sm.communities), memories: num(sm.memories) }, unlinked: num(doc.unlinked),
  };
}

// ── Bootstrap's budgets (D17) ──

/** The vault's token estimate (brain/scripts/lib/text-budget.js estimateTokens): characters / 4, rounded up. */
export function estimateTokens(s: string | null | undefined): number { return Math.ceil(String(s ?? "").length / 4); }
/** MEMORY.md's lines as Bootstrap's index card and Health's tile both count them: the non-blank ones. */
export function indexLineCount(raw: string | null): number {
  return String(raw ?? "").split(/\r?\n/).filter((l) => l.trim()).length;
}
/** SESSION.md's budget: auto-wrap fits its sections into this many tokens (auto-wrap.js fitToBudget). */
export const SESSION_BUDGET = 400;
/** recall-wake.md holds at most this many snippets (sdk/lib/recall.js WAKE_MAX_SNIPPETS). */
export const WAKE_MAX = 3;

// ── the recall preview (D18; PR 3): sdk/recall-cli.js on the typed text, the path agents' recall takes ──

/** The runtime script, relative to the vault (the brain surface admits it with exactly recallArgs' argv). */
export const RECALL_CLI = "brain/scripts/sdk/recall-cli.js";
/** BRAIN.md's builder, relative to the vault: the brain surface runs it with no arguments (Bootstrap's bulk Mark complete,
 *  whose sets skip their own rebuild, rebuilds once). */
export const BUILD_BRAIN_MD = "brain/scripts/build-brain-md.js";
export const RECALL_LIMIT = 8;
/** One hit as recall-cli.js --json prints it (sdk/lib/recall.js queryRecallHybrid): `flag` is the age ("3d", "stale: 40d"). */
export interface RecallHit { path: string; score: number; flag: string; snippet: string }

/** The preview's query as one argument: control characters out, spaces folded, every leading dash and space dropped
 *  ("- - item", "-- --warm": never a flag, so the brain surface's rule always admits it). */
export function recallQuery(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").replace(/^[-\s]+/, "").trim().slice(0, 200);
}

/** The argv after recall-cli.js: one query, `--limit N`, `--json`; throws on an empty query. Never `--warm`. */
export function recallArgs(text: string, limit = RECALL_LIMIT): string[] {
  const q = recallQuery(text);
  if (!q) throw new Error("type something to preview");
  const n = Math.max(1, Math.min(99, Math.floor(limit)));
  return [q, "--limit", String(n), "--json"];
}

/** recall-cli.js's --json body: an array of hits, each coerced; a row without a path is dropped. */
export function parseRecallHits(body: unknown): RecallHit[] {
  return arr<Record<string, unknown>>(body).map(rec).filter((h) => typeof h.path === "string" && h.path).map((h) => ({
    path: h.path as string, score: num(h.score), flag: strOrNull(h.flag) ?? "", snippet: typeof h.snippet === "string" ? h.snippet : "",
  }));
}

/** BRAIN.md against its budget, as a whole percent (Bootstrap's tab badge, the Pulse tile); null with no sources yet. */
export function brainMdPercent(src: BrainSources | null): number | null {
  if (!src || src.budget <= 0) return null;
  return Math.round((src.tokens / src.budget) * 100);
}

const SECTION_LABEL: Record<BrainSection, string> = { who: "Who you are", rules: "Critical rules", active: "Active context" };

/**
 * The BRAIN.md section that carries `path` into every session (Library's "In BRAIN.md as"), or null. `tokens` is the
 * whole section's and `count` how many memories share it: brain-sources.json records tokens per section only (D10).
 */
export function brainMdSection(src: BrainSources | null, path: string): { section: BrainSection; label: string; tokens: number; count: number } | null {
  if (!src) return null;
  for (const k of ["who", "rules", "active"] as BrainSection[]) {
    const s = src.sections[k];
    if (s.paths.includes(path)) return { section: k, label: SECTION_LABEL[k], tokens: s.tokens, count: s.paths.length };
  }
  return null;
}

/** The line under IN BRAIN.MD AS: the section, then its tokens, as the section's total when others share it. */
export function brainMdLine(sec: { tokens: number; count: number }): string {
  const tokens = sec.count > 1 ? `one of ${sec.count} memories, ${sec.tokens} tokens together` : `${sec.tokens} tokens`;
  return `${tokens} · every session, both hosts`;
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
  /** Those the scan checked and found no duplicate for: what "Keep the N new" keeps (⇧K). */
  fresh: string[];
  /** Those that look like a memory you already have. */
  known: string[];
  /**
   * Those brain-hub.json does not hold yet (written since it was built, or no hub at all): nothing has checked them for
   * duplicates, so ⇧K leaves them until it has (D3, D11). Showing the tab rebuilds the hub (BrainTab.checkHub).
   */
  unchecked: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

/** A session as the hub names it: a host session's id by its first 8 characters, anything else ("in-session", a merge
 *  note) whole, clipped. */
export function sessionLabel(session: string): string {
  return `session ${UUID.test(session) ? session.slice(0, 8) : clip(session, 40)}`;
}

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
 * Nothing has checked it for duplicates either: it is `unchecked`, never `fresh`, until the hub is built again.
 */
export function reviewBatches(memories: readonly BrainMemory[], hub: BrainHub | null, written: ReadonlyMap<string, string>, flags: ReadonlyMap<string, DupFlag>): ReviewBatch[] {
  const open = new Map(memories.filter((m) => m.live && m.reviewed === false).map((m) => [m.path, m]));
  const groups = new Map<string, Omit<ReviewBatch, "fresh" | "known" | "unchecked">>();
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
      // A hub batch holds only what its scan scored for duplicates; anything else waits for the next build (D11).
      return {
        ...g, lead: g.lead ?? open.get(paths[0])?.title ?? null, paths,
        fresh: paths.filter((p) => !flags.has(p) && seen.has(p)), known: paths.filter((p) => flags.has(p)),
        unchecked: paths.filter((p) => !flags.has(p) && !seen.has(p)),
      };
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
export function modeBadges(o: { toReview: number; live: number; brainPct: number | null; health?: number }): Partial<Record<BrainMode, ModeBadge>> {
  const out: Partial<Record<BrainMode, ModeBadge>> = {};
  if (o.toReview > 0) out.review = { text: String(o.toReview), tone: "warn" };
  out.library = { text: String(o.live), tone: "plain" };
  if (o.brainPct !== null) out.bootstrap = { text: `${o.brainPct}%`, tone: o.brainPct >= 100 ? "warn" : "plain" };
  // Health: what it can act on now (duplicate pairs plus hygiene findings with a fix); nothing when all is well (PR 3).
  if (o.health) out.health = { text: String(o.health), tone: "warn" };
  return out;
}

/**
 * Health's badge: the live duplicate pairs plus every hygiene finding a fix acts on (healthCount; PR 3), except a
 * description only MEMORY.md has: every writer (auto-wrap, /wrap, an approved draft, /feedback) leaves a new memory's
 * description to its MEMORY.md line, and every list reads it from there, so that count would climb back after each
 * session. Health still lists it, with its fix, on demand.
 */
export function healthCount(pairs: number, hub: BrainHub | null): number {
  const hy = hub?.hygiene ?? {};
  const n = (k: string): number => (Array.isArray(hy[k]) ? (hy[k] as unknown[]).length : 0);
  const sources = hy.sources && typeof hy.sources === "object" ? rec(hy.sources) : {};
  const legacy = LEGACY_SOURCES.reduce((s, k) => s + num(sources[k]), 0);
  return pairs + legacy + n("oldType") + n("unindexed") + n("misfiled") + n("brokenIndex") + n("leftoverDrafts");
}
/** The source labels `fix sources` rewrites to manual-wrap (lib/memory-hygiene.js LEGACY_SOURCES). */
export const LEGACY_SOURCES: readonly string[] = ["session", "in-session", "wrap"];

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

/** The window "unused" is measured over by default: memory.neverUsedDays' default, and the hub's own d30. */
export const UNUSED_DAYS = 30;

/**
 * Whether a session injected, recalled or read `path` in the `days` before the hub counted (builtAt), or null without a
 * usage log. "Unused" means one thing across the hub (memory.neverUsedDays, the setting "Memory unused after"): Library's
 * Use facet and Health's Dead weight both read it. At 30 days it is the hub's d30 > 0; another window reads `last`
 * against builtAt, as Dead weight does (brainHealth.ts deadWeight).
 */
export function usedWithin(hub: BrainHub | null, path: string, days = UNUSED_DAYS): boolean | null {
  if (!hasUsage(hub)) return null;
  const n = Math.max(1, Math.floor(days));
  const u = hub!.usage.paths[path];
  const built = timeOf(hub!.builtAt ?? "");
  if (n === UNUSED_DAYS || !Number.isFinite(built)) return (u?.d30 ?? 0) > 0;
  const last = timeOf(u?.last ?? "");
  return Number.isFinite(last) && built - last <= n * DAY_MS;
}

/**
 * Library's results (D2): the kind, the query over title, summary, body and path, the facets; by use, then newest.
 * `days` is the window "unused" is measured over (memory.neverUsedDays): a row's label is its uses in 30 days, "used"
 * when it has none that recent but was used within `days`, or "unused".
 */
export function libraryRows(data: LibraryData, f: LibraryFilter, hub: BrainHub | null, days = UNUSED_DAYS): LibraryRow[] {
  const usage = hasUsage(hub) ? hub!.usage.paths : null;
  const useOf = (p: string): number | null => (usage ? usage[p]?.d30 ?? 0 : null);
  const label = (n: number | null, used: boolean | null): string => (n === null || used === null ? "" : !used ? "unused" : n > 0 ? `${n}×` : "used");
  let rows: Array<LibraryRow & { at: string; titleHit: boolean; used: boolean | null }>;
  const q = f.query.trim();
  if (f.kind === "memories") {
    rows = data.memories
      .filter((m) => (f.type === null || m.type === f.type) && statusMatches(m, f.status) && (f.source === null || (m.source ?? "(none)") === f.source))
      .filter((m) => matchesQuery(q, m.title, m.summary, m.body, m.path))
      .map((m) => { const use = useOf(m.path); const used = usedWithin(hub, m.path, days); return { path: m.path, kind: f.kind, title: m.title, summary: m.summary, type: m.type, status: m.status, pin: m.pin, use, useLabel: label(use, used), at: m.updated ?? m.created ?? "", titleHit: matchesQuery(q, m.title), used }; })
      .filter((r) => f.use === "any" || r.used === null || (f.use === "used") === r.used);
  } else if (f.kind === "drafts") {
    rows = data.drafts.filter((d) => matchesQuery(q, d.title, d.summary, d.body, d.path))
      .map((d) => ({ path: d.path, kind: f.kind, title: d.title, summary: d.summary, type: "feedback" as BrainMemoryType, status: "draft", pin: false, use: null, useLabel: "", at: d.created ?? "", titleHit: matchesQuery(q, d.title), used: null }));
  } else {
    const notes = f.kind === "patterns" ? data.patterns : data.reflections;
    rows = notes.filter((n) => matchesQuery(q, n.title, n.summary, n.body, n.path))
      .map((n) => { const use = f.kind === "patterns" ? useOf(n.path) : null; const used = f.kind === "patterns" ? usedWithin(hub, n.path, days) : null; return { path: n.path, kind: f.kind, title: n.title, summary: n.summary, type: null, status: null, pin: false, use, useLabel: label(use, used), at: n.updated ?? n.created ?? n.path, titleHit: matchesQuery(q, n.title), used }; });
  }
  return rows
    .sort((a, b) => Number(b.titleHit && !!q) - Number(a.titleHit && !!q) || (b.use ?? -1) - (a.use ?? -1) || b.at.localeCompare(a.at) || a.title.localeCompare(b.title))
    .map(({ at: _at, titleHit: _hit, used: _used, ...r }) => r);
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
  /** skipBrainMd: the caller rebuilds BRAIN.md once after several (Bootstrap's bulk Mark complete; ctx.brainMd). */
  /** title: a sweep's Retitle card (brain-ai A10): the H1 and the MEMORY.md line change, the slug stays. */
  | { verb: "set"; path: string; fields: { pin?: boolean; status?: SetStatus; description?: string; title?: string }; expect: string; skipBrainMd?: boolean }
  | { verb: "supersede"; path: string; by: string }
  | { verb: "draft"; action: "approve" | "reject"; slug: string }
  | { verb: "notdup"; a: string; b: string }
  /** expect: the dry run's hash (FixResult.expect); the real run refuses unless it makes exactly the changes shown. */
  | { verb: "fix"; kind: FixKind; dryRun: boolean; expect?: string | null }
  /** brain-ai A4–A8: 2–6 memories drafted into one; estimate makes no model call (ctx.preview), else one call (ctx.run). */
  | { verb: "merge-draft"; paths: readonly string[]; estimate: boolean }
  /** brain-ai A9: the fields written over the oldest, the others superseded; expect is MergeEstimate.baseHashes. */
  | { verb: "merge"; paths: readonly string[]; into: MergeFields; expect: readonly string[] }
  /** brain-ai A2: the newest merge into `path` undone; expect is the merged memory's current hash. */
  | { verb: "unmerge"; path: string; expect: string }
  /** brain-ai A3, A10, A11: the sweep over every memory (no paths) or a community's or cluster's (lead first, ≤ 50). */
  | { verb: "sweep"; paths: readonly string[]; estimate: boolean }
  | { verb: "sweep-dismiss"; id: string };

/**
 * `aos memory fix <kind>` (D20; PR 3), each acting on exactly what brain-hub.json's `hygiene` finds (lib/memory-hygiene.js):
 *   sources       the old source labels (session, in-session, wrap) → manual-wrap, the label /wrap writes today
 *   types         the old `type:` shape (a host's auto-memory: type: user, or none) → type: memory and the tags it needs
 *   descriptions  a memory with no description of its own gets its MEMORY.md line's (as archive keeps one)
 *   index         a live memory missing from MEMORY.md gets its line; a line under another type's heading moves under its
 *                 own; a line goes when nothing is at its path, when its memory is archived or superseded, or when it is
 *                 a second copy (FixChange.reason)
 *   drafts        a feedback draft whose memory was approved and is live is removed (the one delete spec §6 allows)
 * `--dry-run` writes nothing and prints the same changes and their hash (`expect`); a real run given that hash refuses
 * unless it would make exactly those changes, writes them, logs a `fixed` trail row per changed memory or draft (and per
 * memory whose MEMORY.md lines go) with each field's before and after, and rebuilds BRAIN.md after a real types or index
 * run that changed files (index rewrites MEMORY.md, which BRAIN.md's bullets come from; types changes nothing it reads).
 */
export const FIX_KINDS = ["sources", "types", "descriptions", "index", "drafts"] as const;
export type FixKind = (typeof FIX_KINDS)[number];
export function isFixKind(x: unknown): x is FixKind { return typeof x === "string" && (FIX_KINDS as readonly string[]).includes(x); }
/** A fix's `expect` (lib/memory-fix.js EXPECT_RE): 32 hex characters. */
export const FIX_EXPECT_RE = /^[0-9a-f]{32}$/;
/** One change: a memory's frontmatter field, a MEMORY.md line, or a draft file. `before`/`after` are null when absent. */
export interface FixChange {
  /** brain/memory/<type>/<slug>.md, MEMORY.md (a broken line), or brain/memory/feedback/_drafts/<slug>.md. */
  path: string;
  /** source, type, tags, description: a frontmatter line · index-add, index-move, index-remove: MEMORY.md · draft-remove. */
  action: "source" | "type" | "tags" | "description" | "index-add" | "index-move" | "index-remove" | "draft-remove";
  before: string | null;
  after: string | null;
  /** An index-remove's why: nothing at its path (missing), its memory archived or superseded (retired), or a second copy
   *  of a line its memory keeps (duplicate). */
  reason?: FixRemoveReason;
}
export type FixRemoveReason = "missing" | "retired" | "duplicate";
export interface FixResult {
  kind: FixKind;
  dryRun: boolean;
  /** Every change, in the order it was (or would be) made. */
  changes: FixChange[];
  /** How many files changed (a memory with two field changes counts once; MEMORY.md counts once). */
  files: number;
  /** build-brain-md's run after a real types or index run with files > 0; null when it did not run. */
  brainMd: { ok: boolean; error?: string } | null;
  /** The changes' hash: a dry run's goes back with the real run (MemoryVerb fix.expect); null from an older runtime. */
  expect: string | null;
}

/** The argv after `cli/aos.js` for a verb, `--json` last; throws on a path or slug the runtime would refuse anyway. */
export function memoryArgs(v: MemoryVerb): string[] {
  const path = (p: string): string => { if (!MEMORY_PATH_RE.test(p)) throw new Error(`not a memory path: ${p}`); return p; };
  switch (v.verb) {
    case "keep": case "archive": case "restore":
      if (!v.paths.length || v.paths.length > MAX_PATHS_PER_CALL) throw new Error(`${v.verb} takes 1–${MAX_PATHS_PER_CALL} paths`);
      return ["memory", v.verb, ...v.paths.map(path), "--json"];
    case "set":
      if (!/^(?:none|[0-9a-f]{16,64})$/.test(v.expect)) throw new Error("set needs the memory's hash");
      return ["memory", "set", path(v.path), "--set", JSON.stringify(v.fields), "--expect", v.expect, ...(v.skipBrainMd ? ["--skip-brain-md"] : []), "--json"];
    case "supersede":
      return ["memory", "supersede", path(v.path), "--by", path(v.by), "--json"];
    case "draft":
      if (!DRAFT_SLUG_RE.test(v.slug)) throw new Error(`not a draft name: ${v.slug}`);
      return ["memory", "draft", v.action, v.slug, "--json"];
    case "notdup":
      return ["memory", "notdup", path(v.a), path(v.b), "--json"];
    case "fix":
      if (!isFixKind(v.kind)) throw new Error(`not a fix: ${String(v.kind)}`);
      if (v.dryRun) return ["memory", "fix", v.kind, "--dry-run", "--json"];
      if (v.expect != null && !FIX_EXPECT_RE.test(v.expect)) throw new Error("a fix's expect is the hash its dry run printed");
      return ["memory", "fix", v.kind, ...(v.expect != null ? ["--expect", v.expect] : []), "--json"];
    case "merge-draft":
      return ["memory", "merge-draft", ...mergePaths(v.paths).map(path), ...(v.estimate ? ["--estimate"] : []), "--json"];
    case "merge": {
      const ps = mergePaths(v.paths).map(path);
      if (v.expect.length !== ps.length || !v.expect.every((h) => MEMORY_HASH_RE.test(h))) throw new Error("merge needs each memory's hash, in order");
      return ["memory", "merge", ...ps, "--into", JSON.stringify({ title: v.into.title, description: v.into.description, body: v.into.body }), "--expect", v.expect.join(","), "--json"];
    }
    case "unmerge":
      if (!MEMORY_HASH_RE.test(v.expect)) throw new Error("unmerge needs the memory's hash");
      return ["memory", "unmerge", path(v.path), "--expect", v.expect, "--json"];
    case "sweep":
      if (v.paths.length > SWEEP_MAX_PATHS || new Set(v.paths).size !== v.paths.length) throw new Error(`a sweep takes 0–${SWEEP_MAX_PATHS} different memories`);
      return ["memory", "sweep", ...v.paths.map(path), ...(v.estimate ? ["--estimate"] : []), "--json"];
    case "sweep-dismiss":
      if (!SWEEP_ID_RE.test(v.id)) throw new Error(`not a suggestion id: ${v.id}`);
      return ["memory", "sweep", "dismiss", v.id, "--json"];
  }
}

/** A fix result's body, coerced (the page shows a dry run's changes before asking, then the real run's count). */
export function parseFixResult(body: unknown): FixResult | null {
  const r = rec(body);
  if (!isFixKind(r.kind)) return null;
  const actions: readonly FixChange["action"][] = ["source", "type", "tags", "description", "index-add", "index-move", "index-remove", "draft-remove"];
  const changes = arr<Record<string, unknown>>(r.changes).map(rec)
    .filter((c) => typeof c.path === "string" && actions.includes(c.action as FixChange["action"]))
    .map((c): FixChange => ({
      path: c.path as string, action: c.action as FixChange["action"], before: typeof c.before === "string" ? c.before : null, after: typeof c.after === "string" ? c.after : null,
      ...(c.action === "index-remove" && (c.reason === "missing" || c.reason === "retired" || c.reason === "duplicate") ? { reason: c.reason } : {}),
    }));
  const b = r.brainMd && typeof r.brainMd === "object" ? rec(r.brainMd) : null;
  const expect = typeof r.expect === "string" && FIX_EXPECT_RE.test(r.expect) ? r.expect : null;
  return { kind: r.kind, dryRun: r.dryRun === true, changes, files: num(r.files), brainMd: b ? { ok: b.ok === true, ...(typeof b.error === "string" ? { error: b.error } : {}) } : null, expect };
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

// ── AI helpers (brain-hub D21, D22; spec 2026-10-12-brain-hub-ai A1–A14): merge drafts and the consolidation sweep ──

/** A merge takes 2–6 memories (A8); a scoped sweep at most 50 (A3; app/src/shared/surfaces.ts admits the same). */
export const MERGE_MIN = 2;
export const MERGE_MAX = 6;
export const SWEEP_MAX_PATHS = 50;
/** A memory's sha256 as `merge --expect` and `unmerge --expect` take it (memory-ops.js sha256). */
export const MEMORY_HASH_RE = /^[0-9a-f]{16,64}$/;
/** A sweep card's id (lib/memory-sweep.js ID_RE): sha256(kind + sorted paths), 12 hex. */
export const SWEEP_ID_RE = /^[0-9a-f]{12}$/;
/** How long the page waits for one model call (A12): the runtime gives merge 90 s and the sweep 120 s. */
export const AI_TIMEOUT_MS = 150_000;
/** The merged fields' limits (A8): `merge --into` refuses longer ones. */
export const MERGE_LIMITS = { title: 120, description: 200, body: 16_000 } as const;
/** A merge can be undone while its record is kept (A2): brain-hub.js prunes records older than this. */
export const UNDO_DAYS = 30;

function mergePaths(paths: readonly string[]): readonly string[] {
  if (paths.length < MERGE_MIN || paths.length > MERGE_MAX || new Set(paths).size !== paths.length) throw new Error(`a merge takes ${MERGE_MIN}–${MERGE_MAX} different memories`);
  return paths;
}

export type AiProvider = "ollama" | "claude" | "codex" | "none";
const AI_PROVIDERS: readonly AiProvider[] = ["ollama", "claude", "codex", "none"];
/** The daily cap a call counts against (A5): its family, today's spend, and the per-call cap (null under Codex). */
export interface AiCap { family: "hook" | "codex" | "reasoner" | "reasoner-codex" | null; perDayUsd: number; spentToday: number; perCallUsd: number | null }
/** What one call would cost before it is made (A5), or why none can be. */
export interface AiEstimate {
  available: boolean;
  /** null when available; else the provider's reason (forced, daily-cap, no-provider, claude-not-logged-in, ollama-only…). */
  reason: string | null;
  provider: AiProvider;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  cap: AiCap | null;
}
export interface MergeFields { title: string; description: string; body: string }
export interface MergeSource { path: string; title: string; type: BrainMemoryType; created: string | null; hash: string; chars: number; truncated: boolean }
interface MergeBase {
  /** The oldest source: the merged text is written over it, so its path, links and pins carry over (A1). */
  winner: string;
  type: BrainMemoryType;
  sources: MergeSource[];
  /** Each source's hash in the order given: `merge --expect` (A9). */
  baseHashes: string[];
  /** A source's body was cut to fit the prompt (8,000 characters each, 24,000 in all). */
  truncated: boolean;
}
/** `merge-draft --estimate`: no model call; the no-model draft to start from (A4) and what a call would cost (A5). */
export interface MergeEstimate extends MergeBase { byHand: MergeFields; estimate: AiEstimate }
/** `merge-draft`: the model's draft, or the no-model one with why (mode by-hand: none, a cap, no answer, a bad reply). */
export interface MergeDraft extends MergeBase {
  mode: "ai" | "by-hand";
  reason: string | null;
  provider: AiProvider;
  model: string | null;
  /** The call's cost: real under Claude, priced tokens under Codex (estimated), 0 for Ollama and by-hand. */
  usd: number;
  estimated: boolean;
  /** The cap re-read after the call: "today $y of $z". */
  cap: AiCap | null;
  fields: MergeFields;
  generatedAt: string;
}
export interface MergeResult { path: string; superseded: string[]; record: string; hash: string; brainMd: unknown }
export interface UnmergeResult { path: string; restored: string[]; record: string; hash: string; brainMd: unknown }

export const SWEEP_KINDS = ["merge", "archive", "retitle"] as const;
export type SweepKind = (typeof SWEEP_KINDS)[number];
export const SWEEP_KIND_LABEL: Record<SweepKind, string> = { merge: "Merge", archive: "Archive", retitle: "Retitle" };
export interface SweepRun {
  id: string;
  at: string;
  /** null: the whole brain; else the paths a community or cluster sent (lead first). */
  scope: { paths: string[] } | null;
  provider: AiProvider;
  model: string | null;
  usd: number;
  estimated: boolean;
  /** Memories sent, of those in scope (the prompt is capped, A11). */
  considered: number;
  of: number;
  suggestions: number;
}
export interface SweepCard {
  id: string;
  run: string;
  kind: SweepKind;
  paths: string[];
  /** Each path's hash when the sweep saw it: a different one now makes the card done or stale (brainSweep.ts). */
  hashes: string[];
  /** merge: the proposed title; retitle: the new title; "" when none. */
  title: string;
  /** retitle: the new description, "" when none. */
  description: string;
  why: string;
  /** The run's scope key (null: the whole brain): 12 hex of sha256(sorted paths joined by "\n"). */
  scope: string | null;
  state: "open" | "dismissed";
}
export interface SweepFile { runs: SweepRun[]; suggestions: SweepCard[] }
export interface SweepEstimate { scope: { paths: string[] } | null; considered: number; of: number; estimate: AiEstimate }
export interface SweepResult { run: SweepRun; suggestions: SweepCard[] }
export interface SweepDismissResult { dismissed: string; already: boolean }

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const aiProvider = (v: unknown): AiProvider => (AI_PROVIDERS.includes(v as AiProvider) ? (v as AiProvider) : "none");
const memType = (v: unknown, p: string): BrainMemoryType => ((MEMORY_TYPES as readonly string[]).includes(v as string) ? (v as BrainMemoryType) : ((MEMORY_PATH_RE.exec(p)?.[1] ?? "projects") as BrainMemoryType));

export function parseAiCap(v: unknown): AiCap | null {
  if (!v || typeof v !== "object") return null;
  const r = rec(v);
  const fam = r.family;
  return {
    family: fam === "hook" || fam === "codex" || fam === "reasoner" || fam === "reasoner-codex" ? fam : null,
    perDayUsd: num(r.perDayUsd), spentToday: num(r.spentToday), perCallUsd: typeof r.perCallUsd === "number" && Number.isFinite(r.perCallUsd) ? r.perCallUsd : null,
  };
}
export function parseAiEstimate(v: unknown): AiEstimate {
  const r = rec(v);
  const provider = aiProvider(r.provider);
  const available = r.available === true && provider !== "none";
  return {
    available, reason: available ? null : strOrNull(r.reason) ?? "no-provider", provider, model: strOrNull(r.model),
    tokensIn: num(r.tokensIn), tokensOut: num(r.tokensOut), usd: num(r.usd), cap: parseAiCap(r.cap),
  };
}
function parseMergeFields(v: unknown): MergeFields { const r = rec(v); return { title: str(r.title), description: str(r.description), body: str(r.body) }; }
function parseMergeBase(r: Record<string, unknown>): MergeBase | null {
  const winner = str(r.winner);
  if (!MEMORY_PATH_RE.test(winner)) return null;
  const sources = arr<unknown>(r.sources).map(rec).filter((s) => MEMORY_PATH_RE.test(str(s.path))).map((s): MergeSource => ({
    path: str(s.path), title: str(s.title) || str(s.path), type: memType(s.type, str(s.path)), created: strOrNull(s.created),
    hash: str(s.hash), chars: num(s.chars), truncated: s.truncated === true,
  }));
  const baseHashes = strs(r.baseHashes).filter((h) => MEMORY_HASH_RE.test(h));
  if (sources.length < MERGE_MIN || baseHashes.length !== sources.length) return null;
  return { winner, type: memType(r.type, winner), sources, baseHashes, truncated: r.truncated === true };
}
/** `merge-draft --estimate`'s body, or null when it is not one (an older runtime, a wrong shape). */
export function parseMergeEstimate(body: unknown): MergeEstimate | null {
  const r = rec(body);
  const base = parseMergeBase(r);
  if (!base || !r.byHand || !r.estimate) return null;
  return { ...base, byHand: parseMergeFields(r.byHand), estimate: parseAiEstimate(r.estimate) };
}
/** `merge-draft`'s body, or null. */
export function parseMergeDraft(body: unknown): MergeDraft | null {
  const r = rec(body);
  const base = parseMergeBase(r);
  if (!base || !r.fields) return null;
  return {
    ...base, mode: r.mode === "ai" ? "ai" : "by-hand", reason: strOrNull(r.reason), provider: aiProvider(r.provider), model: strOrNull(r.model),
    usd: num(r.usd), estimated: r.estimated === true, cap: parseAiCap(r.cap), fields: parseMergeFields(r.fields), generatedAt: str(r.generatedAt),
  };
}
function parseSweepRun(v: unknown): SweepRun | null {
  const r = rec(v);
  if (!str(r.id)) return null;
  const sc = r.scope && typeof r.scope === "object" ? rec(r.scope) : null;
  return {
    id: str(r.id), at: str(r.at), scope: sc ? { paths: strs(sc.paths).filter((p) => MEMORY_PATH_RE.test(p)) } : null,
    provider: aiProvider(r.provider), model: strOrNull(r.model), usd: num(r.usd), estimated: r.estimated === true,
    considered: num(r.considered), of: num(r.of), suggestions: num(r.suggestions),
  };
}
function parseSweepCard(v: unknown): SweepCard | null {
  const r = rec(v);
  const id = str(r.id);
  const kind = r.kind as SweepKind;
  const paths = strs(r.paths).filter((p) => MEMORY_PATH_RE.test(p));
  if (!SWEEP_ID_RE.test(id) || !SWEEP_KINDS.includes(kind) || !paths.length) return null;
  const hashes = strs(r.hashes);
  return {
    id, run: str(r.run), kind, paths, hashes: hashes.length === paths.length ? hashes : paths.map(() => ""),
    title: str(r.title), description: str(r.description), why: str(r.why),
    scope: typeof r.scope === "string" && /^[0-9a-f]{12}$/.test(r.scope) ? r.scope : null, state: r.state === "dismissed" ? "dismissed" : "open",
  };
}
/** brain/_index/memory-sweep.json (schema 1), or null when absent or not one. */
export function parseSweepFile(raw: string | null): SweepFile | null {
  if (!raw) return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  const r = rec(j);
  if (r.schema !== 1) return null;
  return {
    runs: arr<unknown>(r.runs).map(parseSweepRun).filter((x): x is SweepRun => !!x),
    suggestions: arr<unknown>(r.suggestions).map(parseSweepCard).filter((x): x is SweepCard => !!x),
  };
}
export function parseSweepEstimate(body: unknown): SweepEstimate | null {
  const r = rec(body);
  if (!r.estimate) return null;
  const sc = r.scope && typeof r.scope === "object" ? rec(r.scope) : null;
  return { scope: sc ? { paths: strs(sc.paths) } : null, considered: num(r.considered), of: num(r.of), estimate: parseAiEstimate(r.estimate) };
}
export function parseSweepResult(body: unknown): SweepResult | null {
  const r = rec(body);
  const run = parseSweepRun(r.run);
  if (!run) return null;
  return { run, suggestions: arr<unknown>(r.suggestions).map(parseSweepCard).filter((x): x is SweepCard => !!x) };
}
/** A sweep's scope key as lib/memory-sweep.js writes it: null for the whole brain. */
export function sweepScopeKey(paths: readonly string[]): string | null {
  return paths.length ? sha256Hex([...paths].sort().join("\n")).slice(0, 12) : null;
}

/** "Claude", "Codex", "Ollama", or "no provider". */
export function providerName(p: AiProvider): string {
  return p === "claude" ? "Claude" : p === "codex" ? "Codex" : p === "ollama" ? "Ollama" : "no provider";
}
/** "$0.004", "$0.06", "$1.20" (four places under a cent). */
export function usdText(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  return `$${v < 0.01 && v > 0 ? v.toFixed(4).replace(/0+$/, "") : v.toFixed(2)}`;
}
/** The config key each cap family's daily limit is (lib/memory-ai.js CAP_KEYS). */
const CAP_KEY: Record<NonNullable<AiCap["family"]>, string> = { hook: "claude.perDayUsd", codex: "codex.perDayUsd", reasoner: "reasoner.perDayUsd", "reasoner-codex": "reasoner.perDayUsd" };
/** Why no call can be made, as a sentence (A4, A7): the provider's reason, or the sweep's Ollama-only. */
export function aiReasonText(reason: string | null, cap: AiCap | null = null): string {
  const r = reason ?? "";
  if (r === "forced" || r === "none" || r === "no-provider") return "No model provider is set up.";
  // The runtime's sentence (lib/memory-ai.js reasonSentence): the amount and, when the cap's family says it, its key.
  if (/daily-cap$/.test(r)) return cap ? `Today's model cap is reached (${usdText(cap.perDayUsd)}${cap.family ? `, ${CAP_KEY[cap.family]}` : ""}).` : "Today's model cap is reached.";
  if (r === "claude-not-logged-in") return "Claude Code is not signed in.";
  if (r === "codex-not-logged-in") return "Codex is not signed in.";
  if (r === "no-codex" || r === "codex-not-configured") return "Codex is not set up.";
  if (r === "ollama-only") return "The sweep needs Claude or Codex; a local model cannot hold the whole brain.";
  return r ? `No model call possible (${r}).` : "No model call possible.";
}
/** "about $0.004 · haiku · Claude", or the reason it is off (A5). */
export function estimateText(e: AiEstimate): string {
  if (!e.available) return aiReasonText(e.reason, e.cap);
  return `about ${usdText(e.usd)} · ${e.model ?? providerName(e.provider)} · ${providerName(e.provider)}`;
}
/** "today $0.12 of $0.50" for a cap, "" without one. */
export function capText(cap: AiCap | null): string {
  return cap && cap.perDayUsd > 0 ? `today ${usdText(cap.spentToday)} of ${usdText(cap.perDayUsd)}` : "";
}
/** "drafted by haiku · Claude · $0.004 · today $0.12 of $0.50", with "(estimated)" under Codex (A5). */
export function spendText(d: Pick<MergeDraft, "provider" | "model" | "usd" | "estimated" | "cap">, verb = "drafted by"): string {
  const cost = `${usdText(d.usd)}${d.estimated ? " (estimated)" : ""}`;
  return [`${verb} ${d.model ?? providerName(d.provider)}`, providerName(d.provider), cost, capText(d.cap)].filter(Boolean).join(" · ");
}

export interface MergeOfferRow { at: string; record: string; hash: string; from: string[] }
/**
 * The merge a memory can still undo (A2): its newest `merged` trail row, younger than UNDO_DAYS, with no `unmerged` row
 * after it, and only while the memory still reads as the merge left it (the row's hash is its current one). null otherwise.
 */
export function undoableMerge(trail: readonly TrailEntry[], m: Pick<BrainMemory, "type" | "slug" | "hash">, now: Date): MergeOfferRow | null {
  let last: MergeOfferRow | null = null;
  for (const t of trail) {
    if (t.type !== m.type || t.slug !== m.slug) continue;
    const row = t as unknown as Record<string, unknown>;
    if (t.action === "merged") last = { at: t.ts, record: str(row.record), hash: str(row.hash), from: strs(row.from) };
    else if ((t.action as string) === "unmerged") last = null;
  }
  if (!last || !last.record || last.hash !== m.hash) return null;
  const age = now.getTime() - timeOf(last.at);
  return Number.isFinite(age) && age < UNDO_DAYS * 86_400_000 ? last : null;
}

export const BRAIN_OFF_TEXT = "Brain's write surface is off in this app: run the aos memory command in a terminal instead";
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

// ── Library's reader and context (D1, D2): days, the history line, backlinks, the selection, the facets that show a memory ──

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 30" (local time), with the year when it is not `now`'s; "" for anything that is not a date. */
export function shortDay(s: string | null | undefined, now: Date): string {
  const t = timeOf(String(s ?? ""));
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

/**
 * Library's History in one line, oldest first: "Written by auto-wrap Sep 30 · kept Oct 2 · archived Oct 5". `rows` are
 * the memory's trail rows (historyFor, any order); with no `written` row the line starts at its `created:` day. A `set`
 * row names its fields (memory-ops.js appendTrail), a `fixed` row its kind ("fixed (sources)", lib/memory-fix.js), a
 * `merged` row how many memories went into this one ("merged 2 into this", its `from`; brain-ai A9) and an `unmerged`
 * row reads "merge undone" (A2). One action twice on one day reads once; a long trail keeps its first event and its
 * last six.
 */
export function historyLine(rows: readonly TrailEntry[], m: Pick<BrainMemory, "source" | "created">, now: Date): string {
  // Rows in one millisecond keep no order of their own (historyFor hands them newest first): a memory is written first.
  const asc = [...rows].sort((a, b) => sortTime(a.ts) - sortTime(b.ts) || Number(b.action === "written") - Number(a.action === "written"));
  const parts: string[] = [];
  if (!asc.some((r) => r.action === "written") && m.created) { const c = shortDay(m.created, now); if (c) parts.push(`created ${c}`); }
  for (const r of asc) {
    const action = String(r.action);
    const fields = arr<unknown>((r as { fields?: unknown }).fields).filter((f): f is string => typeof f === "string" && /^[a-z_]{1,30}$/.test(f));
    const kind = (r as { kind?: unknown }).kind;
    const from = arr<unknown>((r as { from?: unknown }).from).filter((p) => typeof p === "string" && MEMORY_PATH_RE.test(p)).length;
    const what = action === "written" ? `written by ${m.source || "auto-wrap"}`
      : action === "set" ? (fields.length ? `set ${fields.join(", ")}` : "changed")
      : action === "fixed" ? (isFixKind(kind) ? `fixed (${kind})` : "fixed")
      : action === "merged" ? (from ? `merged ${from} into this` : "merged")
      : action === "unmerged" ? "merge undone"
      : /^[a-z-]{1,20}$/.test(action) ? action : "changed";
    const day = shortDay(r.ts, now);
    const part = day ? `${what} ${day}` : what;
    if (parts[parts.length - 1] !== part) parts.push(part);
  }
  const shown = parts.length > 7 ? [parts[0], "…", ...parts.slice(-6)] : parts;
  const line = shown.join(" · ");
  return line ? line[0].toUpperCase() + line.slice(1) : "";
}

/** The body without its leading H1 when that is the title the reader already shows above it. */
export function bodyWithoutTitle(body: string, title: string): string {
  const m = /^\s*#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(body);
  return m && m[1] === title ? body.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, "") : body;
}

export interface LinkTargets { wiki: Set<string>; paths: Set<string> }

/**
 * What a markdown text links, lowercased (Library's "Linked from"): each wiki-link's note name (after its last `/`, no
 * `.md`, no #heading or |alias) and each markdown link's path (decoded, no leading `./` or `/`, no #anchor).
 */
export function linkTargets(text: string): LinkTargets {
  const wiki = new Set<string>();
  const paths = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const name = m[1].trim().toLowerCase().replace(/\.md$/, "");
    if (name) wiki.add(name.slice(name.lastIndexOf("/") + 1));
  }
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    let p = m[1].replace(/#.*$/, "");
    try { p = decodeURI(p); } catch { /* keep it as written */ }
    p = p.replace(/^\.?\//, "").toLowerCase();
    if (p) paths.add(p);
  }
  return { wiki, paths };
}

/** Whether a file with these targets links `path`: [[name]], [[name|…]], [[name#…]] or ](path). */
export function linksTo(t: LinkTargets, path: string): boolean {
  const p = path.toLowerCase();
  return t.wiki.has(p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, "")) || t.paths.has(p);
}

/** What "Linked from" calls a linking file: a memory's type, draft, pattern, reflection, index (MEMORY.md, the MOCs,
 *  BRAIN.md) or vault. */
export function linkSourceKind(path: string): string {
  const m = MEMORY_PATH_RE.exec(path);
  if (m) return m[1];
  if (path.startsWith(`${DRAFTS_DIR}/`)) return "draft";
  if (path === MEMORY_INDEX_PATH || path.startsWith("brain/_index/")) return "index";
  if (path.startsWith(`${PATTERNS_DIR}/`)) return "pattern";
  if (path.startsWith(`${REFLECTIONS_DIR}/`)) return "reflection";
  return "vault";
}

/** How Nearby scored a memory's partners: "meaning" when one of its pairs has an embedding score, else "words"; null
 *  when it has no pair (D11: no Ollama, BM25 only, labelled). */
export function nearbyBasis(pairs: readonly HubDup[], path: string): "meaning" | "words" | null {
  let any = false;
  for (const d of pairs) if (d.a === path || d.b === path) { if (d.meaning !== null) return "meaning"; any = true; }
  return any ? "words" : null;
}

/**
 * The smallest change to Library's facets that shows `m` (a link into the hub, D15): the Memories kind, a type, source
 * or use facet that hides it cleared, and the Status facet widened to "live", or to "any" when it is archived or
 * superseded. The query is the header's and stays.
 */
export function filterShowing(f: LibraryFilter, m: BrainMemory, hub: BrainHub | null, days = UNUSED_DAYS): LibraryFilter {
  const used = usedWithin(hub, m.path, days);
  return {
    ...f, kind: "memories",
    type: f.type !== null && f.type !== m.type ? null : f.type,
    status: statusMatches(m, f.status) ? f.status : m.live ? "live" : "any",
    source: f.source !== null && f.source !== (m.source ?? "(none)") ? null : f.source,
    use: f.use === "any" || used === null || (f.use === "used") === used ? f.use : "any",
  };
}

/**
 * Library's selection after its rows change. A selection whose file is gone is dropped. One the person chose stays
 * (in the reader) even when a filter hides it, so clearing the search goes back to it; an automatic one (the first row)
 * stays while it is in the rows. Otherwise the first row, chosen by nobody.
 */
export function librarySelection(rows: ReadonlyArray<{ path: string }>, sel: string | null, chosen: boolean, exists: (p: string) => boolean): { sel: string | null; chosen: boolean } {
  if (sel && !exists(sel)) { sel = null; chosen = false; }
  if (sel && (chosen || rows.some((r) => r.path === sel))) return { sel, chosen };
  return { sel: rows[0]?.path ?? null, chosen: false };
}

// ── Review's words and selection (views/brain/ReviewMode.ts; D3, D4, D7) ──

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const isBareDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
const sameLocalDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A batch row's time (D3): "04:36" (local) when it was written today, else "Oct 9"; "today" for a bare day that is today. */
export function batchWhen(at: string, now: Date): string {
  const t = timeOf(at);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  if (!sameLocalDay(d, now)) return shortDay(at, now);
  return isBareDay(at) ? "today" : hhmm(d);
}

/** The batch header's line: "claude · today 04:36 · session 2f25a8d9"; "wrap" with no host, unknown parts left out. */
export function batchMeta(b: Pick<ReviewBatch, "host" | "at" | "session">, now: Date): string {
  const t = timeOf(b.at);
  let when = "";
  if (Number.isFinite(t)) {
    const d = new Date(t);
    const day = sameLocalDay(d, now) ? "today" : shortDay(b.at, now);
    when = isBareDay(b.at) ? day : `${day} ${hhmm(d)}`;
  }
  return [b.host ?? "wrap", when, b.session ? sessionLabel(b.session) : ""].filter(Boolean).join(" · ");
}

/** A batch row's pill: "1 looks known", "3 look known"; "" for none. */
export function knownLabel(n: number): string {
  return n <= 0 ? "" : n === 1 ? "1 looks known" : `${n} look known`;
}

/**
 * The batch header's lede: "6 left to review. 3 look new, 3 look like ones you already have." `total` is what the
 * session left to review (what was kept or archived is not counted, so the lede never claims what the session wrote),
 * `known` those with a duplicate flag, `unchecked` those the duplicate check has not seen yet (D3, D11).
 */
export function batchLede(total: number, known: number, unchecked = 0): string {
  if (total <= 0) return "Nothing left to review from this session.";
  const k = Math.min(Math.max(0, known), total);
  const u = Math.min(Math.max(0, unchecked), total - k);
  const fresh = total - k - u;
  if (total === 1) return `1 left to review. It ${k ? "looks like one you already have" : u ? "waits for the duplicate check" : "looks new"}.`;
  const head = `${total} left to review.`;
  const all = total === 2 ? "Both" : `All ${total}`;
  if (fresh === total) return `${head} ${all} look new.`;
  if (k === total) return `${head} ${all} look like ones you already have.`;
  if (u === total) return `${head} ${all} wait for the duplicate check.`;
  const parts = [
    fresh ? (fresh === 1 ? "1 looks new" : `${fresh} look new`) : "",
    k ? (k === 1 ? "1 looks like one you already have" : `${k} look like ones you already have`) : "",
    u ? (u === 1 ? "1 waits for the duplicate check" : `${u} wait for the duplicate check`) : "",
  ].filter(Boolean);
  return `${head} ${parts.join(", ")}.`;
}

/** Two memories, the one written first first (then the earlier `created:`, then the path): "Keep the older one" (D7). */
export function olderFirst<M extends Pick<BrainMemory, "path" | "type" | "slug" | "created">>(a: M, b: M, written: ReadonlyMap<string, string>): [M, M] {
  const ta = sortTime(writtenAt(a, written));
  const tb = sortTime(writtenAt(b, written));
  if (ta !== tb) return ta < tb ? [a, b] : [b, a];
  const ca = a.created ?? "";
  const cb = b.created ?? "";
  if (ca !== cb) return (ca || "￿") < (cb || "￿") ? [a, b] : [b, a];
  return a.path <= b.path ? [a, b] : [b, a];
}

/**
 * M's comparison (D7): which of a card's memory and the one it looks like is the older, by the same rule "Keep the older
 * one" picks its winner with (olderFirst), so the boxes' labels never disagree with what the button keeps.
 */
export function compareAges<M extends Pick<BrainMemory, "path" | "type" | "slug" | "created">>(mine: M, other: M, written: ReadonlyMap<string, string>): { mine: "OLDER" | "NEWER"; other: "OLDER" | "NEWER"; older: M; newer: M } {
  const [older, newer] = olderFirst(mine, other, written);
  const mineOlder = older.path === mine.path;
  return { mine: mineOlder ? "OLDER" : "NEWER", other: mineOlder ? "NEWER" : "OLDER", older, newer };
}

/** The Older queue's months in the queue's order: "September 2026" and its memories ("Undated" for none). */
export function olderByMonth<M extends Pick<BrainMemory, "type" | "slug" | "created">>(memories: readonly M[], written: ReadonlyMap<string, string>): Array<{ label: string; items: M[] }> {
  const out: Array<{ label: string; items: M[] }> = [];
  for (const m of memories) {
    const t = timeOf(writtenAt(m, written));
    const label = Number.isFinite(t) ? `${MONTH_NAMES[new Date(t).getMonth()]} ${new Date(t).getFullYear()}` : "Undated";
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(m);
    else out.push({ label, items: [m] });
  }
  return out;
}

/**
 * Review's selection after a redraw (D4): `key` while it is still listed; else the row now at its old index, which is
 * the next one after an action took it out (the last when it was the last); null when nothing is listed.
 */
export function reviewSelection(keys: readonly string[], key: string | null, index: number): { key: string | null; index: number } {
  if (key !== null) { const i = keys.indexOf(key); if (i >= 0) return { key, index: i }; }
  if (!keys.length) return { key: null, index: 0 };
  const i = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : 0, keys.length - 1));
  return { key: keys[i], index: i };
}

/** "used 6× this week", "not used this week", or "" with no usage log (Review's compare box, D8). */
export function weekUse(hub: BrainHub | null, path: string): string {
  if (!hasUsage(hub)) return "";
  const n = hub!.usage.paths[path]?.d7 ?? 0;
  return n > 0 ? `used ${n}× this week` : "not used this week";
}
