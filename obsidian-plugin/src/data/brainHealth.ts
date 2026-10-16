// brainHealth.ts — Health's words and numbers (spec 2026-10-11-brain-hub D20, D23, §6; plan PR 3; canvas Health). Pure:
// it takes one load of the hub's data (views/brain/types.ts BrainData fits HealthInput) and gives HealthMode its six
// tiles, the Duplicates card's rows, the Hygiene rows per `aos memory fix` kind, Dead weight's buckets and buttons, and
// FixModal's grouped change list. Nothing here touches the vault or runs a verb.
//
// The counts come from brain-hub.json (D12), as the Health badge's healthCount reads them: the runtime's hygiene and the
// fix verb share one finder (lib/memory-hygiene.js), and a fix's dry run, never this cache, is what the dialog shows.
// When the cache lags the files, the dry run finds nothing and the page says so and rescans (HealthMode).
import {
  DRAFTS_DIR, DRAFT_SLUG_RE, FIX_KINDS, LEGACY_SOURCES, MEMORY_PATH_RE, brainMdPercent, clip, estimateTokens, indexLineCount, shortDay,
  type BrainDraft, type BrainHub, type BrainMemory, type BrainSources, type FixChange, type FixKind, type FixRemoveReason, type FixResult,
  type HubDup,
} from "./brainModel";

/** What Health reads from one load (BrainData has every field). */
export interface HealthInput {
  now: Date;
  memories: readonly BrainMemory[];
  byPath: ReadonlyMap<string, BrainMemory>;
  drafts: readonly BrainDraft[];
  hub: BrainHub | null;
  sources: BrainSources | null;
  /** The live duplicate pairs less those memory-notdup.json lists or this page just dismissed (brainModel livePairs). */
  pairs: readonly HubDup[];
  indexRaw: string | null;
  settings: { telemetry: boolean; neverUsedDays: number };
}

const DAY_MS = 24 * 3600 * 1000;
/** A timestamp or a `YYYY-MM-DD` day (local midnight) in ms; NaN when it is neither (brainModel's rule). */
const timeOf = (s: string | null | undefined): number => {
  const v = String(s ?? "");
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v);
  return Number.isFinite(t) ? t : NaN;
};
/** "1 memory", "3 memories". */
export const pl = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** 342 · 4.3k · 17k: a tile's number. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

const list = (hy: Record<string, unknown>, k: string): string[] => (Array.isArray(hy[k]) ? (hy[k] as unknown[]).filter((p): p is string => typeof p === "string") : []);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// ── hygiene (D20): what each `aos memory fix <kind>` acts on ──

export interface HygieneCounts {
  /** Live memories whose `source:` is one of LEGACY_SOURCES (the sum of those labels' counts). */
  sources: number;
  /** Per old label, those present. */
  labels: Array<{ label: string; n: number }>;
  types: number;
  descriptions: number;
  /** unindexed + misfiled + brokenIndex: what `fix index` acts on. */
  index: number;
  unindexed: number;
  misfiled: number;
  broken: number;
  drafts: number;
}

/** brain-hub.json's hygiene, per fix kind (healthCount adds all but descriptions); all zero with no hub. */
export function hygieneCounts(hub: BrainHub | null): HygieneCounts {
  const hy = hub?.hygiene ?? {};
  const src = hy.sources && typeof hy.sources === "object" && !Array.isArray(hy.sources) ? (hy.sources as Record<string, unknown>) : {};
  const labels = LEGACY_SOURCES.map((label) => ({ label, n: count(src[label]) })).filter((x) => x.n > 0);
  const unindexed = list(hy, "unindexed").length;
  const misfiled = list(hy, "misfiled").length;
  const broken = list(hy, "brokenIndex").length;
  return {
    sources: labels.reduce((s, x) => s + x.n, 0), labels,
    types: list(hy, "oldType").length, descriptions: list(hy, "noDescription").length,
    index: unindexed + misfiled + broken, unindexed, misfiled, broken,
    drafts: list(hy, "leftoverDrafts").length,
  };
}

/** The Hygiene card's subtitle: each fix shows its dry run and asks first, and none is undoable (plan PR 3), so the card
 *  never says "undoable". */
export const HYGIENE_SUBTITLE = "one click, no model, with a preview first";

export interface HygieneRow {
  kind: FixKind;
  count: number;
  /** What the row says: the finding, or that there is none. */
  text: string;
  /** The button (it opens the dry run's dialog, so it ends in "…"); null when there is nothing to fix. */
  button: string | null;
}

/** What a Hygiene row's words depend on beyond the hub: how this machine's hosts invoke /wrap (aosConfig invocationHint,
 *  "$agenticos:wrap" on a Codex-only vault), and the memories as loaded (a misfiled line of a retired memory goes rather
 *  than moving). */
export interface HygieneContext { wrapHint: string; byPath?: ReadonlyMap<string, BrainMemory> }

/** Hygiene's rows, one per fix kind in FIX_KINDS order; none before the first scan writes brain-hub.json. */
export function hygieneRows(hub: BrainHub | null, cx: HygieneContext): HygieneRow[] {
  if (!hub) return [];
  const c = hygieneCounts(hub);
  // "Move" only when every misfiled line moves: one of an archived or superseded memory is removed instead.
  const retiredMisfiled = list(hub.hygiene ?? {}, "misfiled").some((p) => cx.byPath?.get(p)?.live === false);
  const mem = (n: number): string => pl(n, "memory", "memories");
  const row = (kind: FixKind): HygieneRow => {
    switch (kind) {
      case "sources": return c.sources
        ? { kind, count: c.sources, text: `${mem(c.sources)} ${c.sources === 1 ? "carries" : "carry"} an old source label (${c.labels.map((x) => x.label).join(", ")}) where ${cx.wrapHint} writes manual-wrap`, button: `Normalise ${c.sources}…` }
        : { kind, count: 0, text: "Every source label is current", button: null };
      case "types": return c.types
        ? { kind, count: c.types, text: `${mem(c.types)} ${c.types === 1 ? "uses" : "use"} an old type: shape`, button: `Fix ${c.types}…` }
        : { kind, count: 0, text: "Every memory uses type: memory", button: null };
      case "descriptions": return c.descriptions
        ? { kind, count: c.descriptions, text: `${mem(c.descriptions)} ${c.descriptions === 1 ? "keeps its" : "keep their"} description only in MEMORY.md, none in ${c.descriptions === 1 ? "its" : "their"} own frontmatter`, button: "Copy from MEMORY.md…" }
        : { kind, count: 0, text: "No memory lacks a description MEMORY.md has", button: null };
      case "index": {
        if (!c.index) return { kind, count: 0, text: "MEMORY.md lists every memory under its own heading", button: null };
        const parts = [
          c.unindexed ? `${mem(c.unindexed)} ${c.unindexed === 1 ? "is" : "are"} not in MEMORY.md` : "",
          c.misfiled ? `${pl(c.misfiled, "line")} ${c.misfiled === 1 ? "sits" : "sit"} under the wrong heading` : "",
          c.broken ? `${pl(c.broken, "line")} ${c.broken === 1 ? "points" : "point"} at a missing file` : "",
        ].filter(Boolean);
        const only = [c.unindexed, c.misfiled, c.broken].filter((n) => n > 0).length === 1;
        const verb = !only ? "Fix" : c.unindexed ? "Index" : c.misfiled ? (retiredMisfiled ? "Fix" : "Move") : "Remove";
        return { kind, count: c.index, text: parts.join("; "), button: `${verb} ${c.index}…` };
      }
      case "drafts": return c.drafts
        ? { kind, count: c.drafts, text: `${pl(c.drafts, "approved draft")} ${c.drafts === 1 ? "is" : "are"} still in feedback/_drafts`, button: c.drafts === 1 ? "Remove the draft…" : `Remove ${c.drafts}…` }
        : { kind, count: 0, text: "No approved draft is left behind", button: null };
    }
  };
  return FIX_KINDS.map(row);
}

// ── the six tiles (D20, D23: a coloured state always carries its word) ──

export type HealthTone = "warn" | "ok" | "plain" | "off";
export type HealthTileKey = "duplicates" | "unreviewed" | "unused" | "brainmd" | "memorymd" | "broken";
export interface HealthTile {
  key: HealthTileKey;
  /** The big number ("–" when there is none to show). */
  value: string;
  label: string;
  note: string;
  /** Colour only for state: warn, ok, off; plain is the text colour. */
  tone: HealthTone;
  /** The state in words beside the colour; "" for plain. */
  word: string;
}

/** Live memories that still wait for review (the files win over the cache). */
export function unreviewedCount(memories: readonly BrainMemory[]): number {
  return memories.filter((m) => m.live && m.reviewed === false).length;
}

/** MEMORY.md's non-blank lines (brainModel, shared with Bootstrap's index card so the two never disagree). */
export { indexLineCount };

/** The clusters whose memories are still live, two or more of them (a merge since the scan can leave fewer). */
export function liveClusters(hub: BrainHub | null, byPath: ReadonlyMap<string, BrainMemory>): Array<{ paths: string[]; label: string }> {
  return (hub?.clusters ?? []).map((k) => ({ label: k.label, paths: k.paths.filter((p) => byPath.get(p)?.live) })).filter((k) => k.paths.length >= 2);
}

export function healthTiles(d: HealthInput): HealthTile[] {
  const hub = d.hub;
  const off = (key: HealthTileKey, label: string, note: string, word: string): HealthTile => ({ key, value: "–", label, note, tone: "off", word });
  const tiles: HealthTile[] = [];

  if (!hub) tiles.push(off("duplicates", "Duplicate pairs", "the next scan looks for them", "not scanned"));
  else {
    const n = d.pairs.length;
    const k = liveClusters(hub, d.byPath).length;
    tiles.push({ key: "duplicates", value: String(n), label: "Duplicate pairs", note: k ? `+ ${pl(k, "cluster")}` : "no clusters", tone: n ? "warn" : "ok", word: n ? "to compare" : "none found" });
  }

  const live = d.memories.filter((m) => m.live).length;
  const open = unreviewedCount(d.memories);
  tiles.push({
    key: "unreviewed", value: String(open), label: "Unreviewed",
    note: live ? `${Math.round((open / live) * 100)}% of all memories` : "no memories yet",
    tone: open ? "warn" : "ok", word: open ? "to review" : "all reviewed",
  });

  const dw = deadWeight(d);
  if (dw.state === "off") tiles.push(off("unused", "Never used", "telemetry is off", "off"));
  else if (dw.state === "nohub") tiles.push(off("unused", "Never used", "the next scan counts use", "not scanned"));
  else if (dw.state === "collecting") tiles.push(off("unused", "Never used", dw.since ? `collecting since ${shortDay(dw.since, d.now)}` : "nothing logged yet", "collecting"));
  else tiles.push({ key: "unused", value: String(dw.never), label: "Never used", note: `in ${pl(dw.days, "day")}`, tone: "plain", word: "" });

  const pct = brainMdPercent(d.sources);
  if (pct === null || !d.sources) tiles.push(off("brainmd", "BRAIN.md", "build-brain-md has not run yet", "not built"));
  else {
    // From the raw numbers, as Bootstrap's bar decides (a rounded 100% at 847 of 850 is not over): over its budget, or
    // full (at most its budget, with active projects left out), or within it.
    const s = d.sources;
    const over = s.tokens > s.budget;
    const full = !over && s.omitted.length > 0;
    tiles.push({ key: "brainmd", value: `${pct}%`, label: "BRAIN.md", note: `${s.tokens} of ${s.budget} tokens`, tone: over || full ? "warn" : "ok", word: over ? "over budget" : full ? "full" : "within budget" });
  }

  if (d.indexRaw === null) tiles.push(off("memorymd", "MEMORY.md", "no MEMORY.md in the vault", "missing"));
  else tiles.push({ key: "memorymd", value: compact(estimateTokens(d.indexRaw)), label: "MEMORY.md", note: `tokens · ${pl(indexLineCount(d.indexRaw), "line")}`, tone: "plain", word: "" });

  if (!hub) tiles.push(off("broken", "Broken links", "the next scan checks the index", "not scanned"));
  else {
    const c = hygieneCounts(hub);
    tiles.push({ key: "broken", value: String(c.broken), label: "Broken links", note: `${c.unindexed} unindexed · ${c.misfiled} misfiled`, tone: c.broken ? "warn" : "ok", word: c.broken ? "to fix" : "none broken" });
  }
  return tiles;
}

// ── Dead weight (D8, D20): used, quiet, never, against memory.neverUsedDays ──

export interface DeadWeight {
  /** off: telemetry.enabled is false; nohub: no brain-hub.json yet; collecting: the log is younger than `days`. */
  state: "off" | "nohub" | "collecting" | "ready";
  days: number;
  /** The first usage row ever (usage.since), null before any. */
  since: string | null;
  /** The day the counts first show (since + days), null before any row. */
  readyOn: Date | null;
  /** Live memories used in the last 7 days (or `days`, when shorter). */
  used: number;
  /** Used in the last `days`, but not in the last 7. */
  quiet: number;
  /** Not injected, recalled or read in the last `days`: what Library's "unused" facet lists (brainModel usedWithin). */
  never: number;
  neverPaths: string[];
  /** Never-used, unpinned projects that are complete or look shipped (brain-hub.json `shipped`): "Archive the N shipped…". */
  shipped: string[];
  /** The card's sentence. */
  text: string;
}

/**
 * Dead weight over the live memories. The windows are measured from when the hub counted (builtAt), as its d7 and d30
 * are, so "never" is exactly Library's "unused" over the same `days` (brainModel usedWithin; d30 is 0 at the default
 * 30). The counts wait until the log is `days` old: before that, "never" would only mean "not yet".
 */
export function deadWeight(d: HealthInput): DeadWeight {
  const days = Math.max(1, Math.floor(d.settings.neverUsedDays));
  const blank = { days, used: 0, quiet: 0, never: 0, neverPaths: [] as string[], shipped: [] as string[] };
  if (!d.settings.telemetry) {
    return { ...blank, state: "off", since: null, readyOn: null, text: "telemetry.enabled is off, so nothing is logged. Turn it on (aos config set telemetry.enabled true) to see what sessions use." };
  }
  if (!d.hub) return { ...blank, state: "nohub", since: null, readyOn: null, text: "The next scan writes brain-hub.json with the use counts." };
  const since = d.hub.usage.since;
  const first = timeOf(since);
  const readyOn = Number.isFinite(first) ? new Date(first + days * DAY_MS) : null;
  if (!readyOn || d.now.getTime() < readyOn.getTime()) {
    return {
      ...blank, state: "collecting", since, readyOn,
      text: readyOn
        ? `Collecting since ${shortDay(since, d.now)}: the counts show from ${shortDay(readyOn.toISOString(), d.now)}, once the log holds ${pl(days, "day")}.`
        : `Collecting: nothing is logged yet. The counts show once the log holds ${pl(days, "day")}.`,
    };
  }
  const built = timeOf(d.hub.builtAt);
  const ref = Number.isFinite(built) ? built : d.now.getTime();
  const recent = Math.min(7, days);
  const shippedSet = new Set(d.hub.shipped.map((s) => s.path));
  let used = 0;
  let quiet = 0;
  const neverPaths: string[] = [];
  const shipped: string[] = [];
  for (const m of d.memories) {
    if (!m.live) continue;
    const last = timeOf(d.hub.usage.paths[m.path]?.last ?? null);
    const age = Number.isFinite(last) ? ref - last : Infinity;
    if (age <= recent * DAY_MS) used++;
    else if (age <= days * DAY_MS) quiet++;
    else {
      neverPaths.push(m.path);
      const done = m.status === "complete" || ((m.status ?? "active") === "active" && shippedSet.has(m.path));
      if (m.type === "projects" && !m.pin && done) shipped.push(m.path);
    }
  }
  const never = neverPaths.length;
  const text = !never
    ? `Every memory was injected, recalled or read in the last ${pl(days, "day")}.`
    : `${pl(never, "memory", "memories")} nobody used in the last ${pl(days, "day")}.${shipped.length ? ` ${shipped.length} of them ${shipped.length === 1 ? "is a project note" : "are project notes"} for shipped work.` : ""}`;
  return { state: "ready", days, since, readyOn, used, quiet, never, neverPaths, shipped, text };
}

/** The Dead weight card's subtitle. */
export function deadWeightSubtitle(days: number): string {
  return `never injected, recalled or read in ${pl(Math.max(1, Math.floor(days)), "day")}`;
}

/** Dead weight's buttons: "Review the N" (Library, use unused) and "Archive the N shipped…"; null when there are none. */
export function deadWeightButtons(dw: DeadWeight): { review: string | null; archive: string | null } {
  if (dw.state !== "ready") return { review: null, archive: null };
  return { review: dw.never ? `Review the ${dw.never}` : null, archive: dw.shipped.length ? `Archive the ${dw.shipped.length} shipped…` : null };
}

/** The bar's legend under its three words, and the line that says what each means. */
export function deadWeightLegend(dw: DeadWeight): { used: string; quiet: string; never: string; help: string } {
  const recent = Math.min(7, dw.days);
  return {
    used: `used ${dw.used}`, quiet: `quiet ${dw.quiet}`, never: `never ${dw.never}`,
    help: recent < dw.days
      ? `Used: in the last ${pl(recent, "day")}. Quiet: not since, but in the last ${dw.days}. Never: not in ${pl(dw.days, "day")}.`
      : `Used: in the last ${pl(dw.days, "day")}. Never: not in ${pl(dw.days, "day")}.`,
  };
}

/** "Archive the N shipped…"'s question (spec §6: archiving more than one confirms first). */
export function archiveShippedAsk(n: number, days: number): { title: string; message: string; confirm: string } {
  return {
    title: `Archive ${pl(n, "shipped project")}?`,
    message: `Archives ${n === 1 ? "the project note" : `the ${n} project notes`} nobody used in the last ${pl(days, "day")} that ${n === 1 ? "is" : "are"} complete or ${n === 1 ? "looks" : "look"} shipped. They leave recall, the MOCs and BRAIN.md. Nothing is deleted: Restore in Library puts each one back.`,
    confirm: `Archive ${n}`,
  };
}

// ── Duplicates and clusters (D11) ──

export interface PairRow { a: string; b: string; score: string; aTitle: string; bTitle: string; meta: string }
export interface ClusterRow { key: string; label: string; paths: string[]; count: string; titles: string }
export interface DraftRow { slug: string; path: string; title: string }
export interface DuplicateRows { pairs: PairRow[]; clusters: ClusterRow[]; drafts: DraftRow[]; meaning: boolean }

/**
 * The Duplicates card: the live pairs best first, the clusters still holding two live memories, and the approved drafts
 * left in feedback/_drafts (a draft is the same rule twice: the drafts fix removes them). `meaning` is whether any pair
 * was scored by embeddings (D11: without Ollama, BM25 only, and the card says so).
 */
export function duplicateRows(d: Pick<HealthInput, "pairs" | "byPath" | "hub" | "drafts">): DuplicateRows {
  const t = (p: string): string => d.byPath.get(p)?.title ?? p;
  const pairs = d.pairs.map((x) => {
    const a = d.byPath.get(x.a);
    const b = d.byPath.get(x.b);
    const types = [...new Set([a?.type, b?.type].filter(Boolean))].join(" · ");
    return { a: x.a, b: x.b, score: x.score.toFixed(2), aTitle: t(x.a), bTitle: t(x.b), meta: types };
  });
  const clusters = liveClusters(d.hub, d.byPath).map((k) => ({
    key: [...k.paths].sort().join("|"), label: k.label || t(k.paths[0]), paths: k.paths, count: `${k.paths.length}×`,
    titles: clip(k.paths.map(t).join(" · "), 240),
  }));
  const byslug = new Map(d.drafts.map((x) => [x.slug, x]));
  const drafts = list(d.hub?.hygiene ?? {}, "leftoverDrafts").filter((s) => DRAFT_SLUG_RE.test(s)).map((slug) => ({
    slug, path: `${DRAFTS_DIR}/${slug}.md`,
    title: byslug.get(slug)?.title ?? d.byPath.get(`brain/memory/feedback/${slug}.md`)?.title ?? slug,
  }));
  return { pairs, clusters, drafts, meaning: d.pairs.some((x) => x.meaning !== null) };
}

/** The Duplicates card's subtitle (D11: the basis of the scores, named). */
export function duplicatesBasis(meaning: boolean): string {
  return meaning ? "title, text and meaning similarity, no model" : "title and text similarity, no model";
}

// ── a fix: its labels, its dialog, its change list, what the page says after ──

/** What a Notice calls each fix. */
export const FIX_LABEL: Record<FixKind, string> = {
  sources: "Normalise source labels", types: "Fix old types", descriptions: "Copy descriptions",
  index: "Fix MEMORY.md", drafts: "Remove leftover drafts",
};

const FIX_TITLE: Record<FixKind, string> = {
  sources: "Normalise source labels?", types: "Fix the old type: shape?", descriptions: "Copy descriptions from MEMORY.md?",
  index: "Fix MEMORY.md?", drafts: "Remove the leftover drafts?",
};

/** The file a change writes: MEMORY.md for an index change, else its own path (a memory or a draft). */
export function changeFile(c: Pick<FixChange, "path" | "action">): string {
  return c.action.startsWith("index-") ? "MEMORY.md" : c.path;
}

/** "projects/alpha.md", "_drafts/beta.md", "MEMORY.md": a file as a Notice names it. */
export function shortFile(p: string): string {
  const m = MEMORY_PATH_RE.exec(p);
  if (m) return `${m[1]}/${m[2]}.md`;
  if (p.startsWith(`${DRAFTS_DIR}/`)) return `_drafts/${p.slice(DRAFTS_DIR.length + 1)}`;
  return p;
}

/** The files a fix changes (or would), each once, in the order of its changes. */
export function changedFiles(changes: readonly FixChange[]): string[] {
  return [...new Set(changes.map(changeFile))];
}

export interface FixLine {
  action: FixChange["action"];
  /** "source", "type", "tags", "description", "add line", "move line", "remove line" (with its reason: "remove line ·
   *  missing file"), "remove draft". */
  label: string;
  /** The memory an index change is about (its title), null otherwise. */
  subject: string | null;
  /** Shown struck: null reads "none". */
  before: string | null;
  /** Shown after the arrow: null reads "removed". */
  after: string | null;
}
export interface FixGroup { file: string; title: string | null; lines: FixLine[] }
export interface FixChangeList { groups: FixGroup[]; files: number; changes: number; more: number; moreFiles: number }

const LINE_LABEL: Record<FixChange["action"], string> = {
  source: "source", type: "type", tags: "tags", description: "description",
  "index-add": "add line", "index-move": "move line", "index-remove": "remove line", "draft-remove": "remove draft",
};
/** Why an index line goes, beside its label (FixChange.reason; none from an older runtime). */
const REMOVE_WHY: Record<FixRemoveReason, string> = { missing: "missing file", retired: "archived or superseded", duplicate: "second copy" };
/** FixModal shows this many changes, then "and N more". */
export const FIX_SHOW = 40;
const VALUE_MAX = 200;

/**
 * A fix's changes grouped by the file they write (MEMORY.md once for every index change), in the order they come,
 * each readable as before → after; at most `cap` lines, the rest counted (`more` changes, `moreFiles` files not shown at
 * all). `titleOf` names a memory (BrainData.byPath), null when it is not one.
 */
export function fixChangeList(changes: readonly FixChange[], titleOf: (path: string) => string | null, cap = FIX_SHOW): FixChangeList {
  const all = new Map<string, FixLine[]>();
  for (const c of changes) {
    const f = changeFile(c);
    const index = c.action.startsWith("index-") && c.action !== "index-remove";
    const v = (s: string | null): string | null => (s === null ? null : clip(s.replace(/\s+/g, " ").trim(), VALUE_MAX));
    const label = c.action === "index-remove" && c.reason ? `${LINE_LABEL[c.action]} · ${REMOVE_WHY[c.reason]}` : LINE_LABEL[c.action];
    const line: FixLine = { action: c.action, label, subject: index ? titleOf(c.path) ?? shortFile(c.path) : null, before: v(c.before), after: v(c.after) };
    const g = all.get(f);
    if (g) g.push(line);
    else all.set(f, [line]);
  }
  const groups: FixGroup[] = [];
  let shown = 0;
  let moreFiles = 0;
  for (const [file, lines] of all) {
    const room = Math.max(0, cap - shown);
    if (!room) { moreFiles++; continue; }
    const part = lines.slice(0, room);
    shown += part.length;
    groups.push({ file, title: file === "MEMORY.md" ? null : titleOf(file), lines: part });
  }
  return { groups, files: all.size, changes: changes.length, more: changes.length - shown, moreFiles };
}

/** "and 12 more changes", "and 12 more changes in 9 files not shown"; "" when everything is shown. */
export function fixMoreText(l: Pick<FixChangeList, "more" | "moreFiles">): string {
  if (l.more <= 0) return "";
  return `and ${l.more} more ${l.more === 1 ? "change" : "changes"}${l.moreFiles ? ` in ${pl(l.moreFiles, "file")} not shown` : ""}`;
}

/** FixModal's words for a dry run: the question, what it changes, the button. Fixes are not undoable (plan PR 3). */
export function fixDialog(kind: FixKind, r: Pick<FixResult, "changes" | "files">): { title: string; lede: string; confirm: string; note: string } {
  const files = r.files > 0 ? r.files : changedFiles(r.changes).length;
  const mem = (n: number): string => pl(n, "memory", "memories");
  const by = (a: FixChange["action"]): number => r.changes.filter((c) => c.action === a).length;
  let lede: string;
  let confirm: string;
  switch (kind) {
    case "sources":
      lede = `Sets source: manual-wrap on ${mem(files)} that ${files === 1 ? "carries" : "carry"} an old label. Only that line changes.`;
      confirm = `Normalise ${files}`;
      break;
    case "types":
      lede = `Sets type: memory, and the tags it needs, on ${mem(files)}. Their name, description and body stay.`;
      confirm = `Fix ${files}`;
      break;
    case "descriptions":
      lede = `Gives ${mem(files)} the description ${files === 1 ? "its" : "their"} MEMORY.md line already has.`;
      confirm = `Copy ${files}`;
      break;
    case "index": {
      const add = by("index-add");
      const move = by("index-move");
      // Each removal by its reason (FixChange.reason); a row from an older runtime names none, and the lede claims none.
      const rm = (why: FixRemoveReason | null): number => r.changes.filter((c) => c.action === "index-remove" && (c.reason ?? null) === why).length;
      const parts = [
        add ? `adds ${pl(add, "missing line")}` : "",
        move ? `moves ${pl(move, "line")} under ${move === 1 ? "its" : "their"} own heading` : "",
        rm("missing") ? `removes ${pl(rm("missing"), "line")} to a missing file` : "",
        rm("retired") ? `removes ${pl(rm("retired"), "line")} of archived or superseded memories` : "",
        rm("duplicate") ? `removes ${pl(rm("duplicate"), "second copy", "second copies")} of a memory's line` : "",
        rm(null) ? `removes ${pl(rm(null), "line")}` : "",
      ].filter(Boolean);
      const said = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "changes nothing";
      lede = `In MEMORY.md, ${said}.${move ? ` A moved line keeps its text.` : ""}`;
      confirm = "Fix MEMORY.md";
      break;
    }
    case "drafts":
      lede = `Removes ${pl(files, "draft file")} whose rule is already a live feedback memory.`;
      confirm = `Remove ${files}`;
      break;
  }
  const rebuild = kind === "types" || kind === "index" ? " BRAIN.md is rebuilt after." : "";
  return { title: FIX_TITLE[kind], lede, confirm, note: `There is no undo: each change goes into the trail with its before and after.${rebuild}` };
}

/** After a dry run that found nothing: the cache was behind the files. */
export function fixBehindText(kind: FixKind): string {
  return `${FIX_LABEL[kind]}: nothing to fix. brain-hub.json was behind the files; rescanning in the background.`;
}

/** After a real run: the files it changed by name (three, then "and N more"), and a BRAIN.md rebuild that failed. */
export function fixDoneText(kind: FixKind, r: FixResult | null): string {
  if (!r) return `${FIX_LABEL[kind]}: done.`;
  const files = changedFiles(r.changes);
  if (!files.length) return `${FIX_LABEL[kind]}: nothing left to fix.`;
  const names = files.slice(0, 3).map(shortFile);
  const rest = files.length - names.length;
  const named = rest > 0 ? `${names.join(", ")} and ${rest} more` : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const n = r.files > 0 ? r.files : files.length;
  const brain = r.brainMd && !r.brainMd.ok ? ` BRAIN.md was not rebuilt${r.brainMd.error ? ` (${clip(r.brainMd.error, 120)})` : ""}: run aos build-brain-md.` : "";
  return `${FIX_LABEL[kind]}: changed ${pl(n, "file")} (${named}).${brain}`;
}
