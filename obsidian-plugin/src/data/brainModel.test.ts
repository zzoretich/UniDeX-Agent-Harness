import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseMemory, parseIndexLines, parseDraft, parseNote, parseBrainHub, parseBrainSources, brainMdPercent, brainMdSection,
  splitFrontmatter, fmStatus, readTrailRows, writtenAtMap, writtenAt, historyFor, livePairs, dupFlags, reviewBatches,
  splitByWeek, olderQueue, writtenBefore, defaultMarkBefore, reviewCounts, reviewKey, brainBadge, sinceMarker, trailSince,
  headerStats, modeBadges, libraryRows, sourceOptions, nearby, hostSplit, memoryArgs, chunks, brainVerbResult,
  touchesBrain, isBrainMode, isReviewQueue, sessionLabel, pairKey, DEFAULT_LIBRARY_FILTER, BRAIN_OFF_TEXT, BRAIN_UPGRADE_TEXT,
  MAX_PATHS_PER_CALL, shortDay, historyLine, bodyWithoutTitle, linkTargets, linksTo, linkSourceKind, nearbyBasis, filterShowing,
  librarySelection, batchWhen, batchMeta, knownLabel, batchLede, olderFirst, olderByMonth, reviewSelection, weekUse,
  pendingReview, compareAges, brainMdLine,
  type BrainMemory, type BrainHub,
} from "./brainModel";

const mem = (type: string, slug: string, o: { title?: string; tags?: string; reviewed?: boolean; session?: string; created?: string; updated?: string; source?: string; pin?: boolean; description?: string; extra?: string; body?: string } = {}): string =>
  ["---", "type: memory", `tags: [memory/${type}${o.tags ? `, ${o.tags}` : ""}]`, `created: ${o.created ?? "2026-10-01"}`, `updated: ${o.updated ?? o.created ?? "2026-10-01"}`,
    ...(o.source ? [`source: ${o.source}`] : []), ...(o.session ? [`session: ${o.session}`] : []), ...(o.pin ? ["pin: true"] : []),
    ...(o.description ? [`description: ${o.description}`] : []), ...(o.reviewed === undefined ? [] : [`reviewed: ${o.reviewed}`]), ...(o.extra ? [o.extra] : []), "---", "",
    `# ${o.title ?? slug}`, "", o.body ?? `The body of ${slug}.`, ""].join("\n");

const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;
const S1 = "2f25a8d9-301b-4619-a341-db99b2c4d8e7";
const S2 = "0c0ffee0-0000-4000-8000-000000000001";

function store(files: Record<string, string>, index: Map<string, string> = new Map()): BrainMemory[] {
  return Object.entries(files).map(([p, t]) => parseMemory(p, t, index)).filter((m): m is BrainMemory => !!m);
}

test("parseMemory reads what memory-ops.js describe reads: title, status, pin, reviewed, source, session, hash", () => {
  const text = mem("feedback", "graphify-first", { title: "Graphify first", tags: "status/active", pin: true, reviewed: true, source: "auto-wrap", session: S1 });
  const m = parseMemory(P("feedback", "graphify-first"), text)!;
  assert.equal(m.title, "Graphify first");
  assert.equal(m.type, "feedback");
  assert.equal(m.slug, "graphify-first");
  assert.equal(m.status, "active");
  assert.equal(m.live, true);
  assert.equal(m.pin, true);
  assert.equal(m.reviewed, true);
  assert.equal(m.source, "auto-wrap");
  assert.equal(m.session, S1);
  assert.equal(m.hash, createHash("sha256").update(text).digest("hex"));
  assert.equal(m.summary, "The body of graphify-first.");
  assert.match(m.body, /^\n# Graphify first/);
});

test("parseMemory: archived and superseded are not live; a block tag list and quotes read the same", () => {
  assert.equal(parseMemory(P("projects", "x"), mem("projects", "x", { tags: "status/archived", extra: "archived: 2026-10-11" }))!.live, false);
  const sup = parseMemory(P("projects", "y"), mem("projects", "y", { tags: "status/superseded", extra: "superseded_by: brain/memory/projects/x.md" }))!;
  assert.equal(sup.live, false);
  assert.equal(sup.supersededBy, "brain/memory/projects/x.md");
  const block = "---\ntype: memory\ntags:\n  - memory/reference\n  - 'status/paused'\nreviewed: \"false\"\n---\n\n# Block\n";
  const b = parseMemory(P("reference", "block"), block)!;
  assert.equal(b.status, "paused");
  assert.equal(b.reviewed, false);
  assert.deepEqual(fmStatus(splitFrontmatter("---\ntags: [memory/user]\n---\n").lines), null);
  assert.equal(parseMemory(P("user", "plain"), "# No frontmatter\n\nJust text.\n")!.status, null);
  assert.equal(parseMemory(P("user", "plain"), "# No frontmatter\n\nJust text.\n")!.live, true);
});

test("parseMemory: the summary is the description, else MEMORY.md's line, else the first paragraph; non-memory paths are null", () => {
  const index = parseIndexLines("# Memory\n\n## Feedback (how to work)\n\n- [Prefer small diffs](brain/memory/feedback/prefer-small-diffs.md) — one reviewable change at a time\n- [No dash](brain/memory/feedback/no-dash.md)\n");
  assert.equal(index.get(P("feedback", "prefer-small-diffs")), "one reviewable change at a time");
  assert.equal(index.get(P("feedback", "no-dash")), "");
  assert.equal(parseMemory(P("feedback", "prefer-small-diffs"), mem("feedback", "prefer-small-diffs"), index)!.summary, "one reviewable change at a time");
  assert.equal(parseMemory(P("feedback", "prefer-small-diffs"), mem("feedback", "prefer-small-diffs", { description: "own words" }), index)!.summary, "own words");
  assert.equal(parseMemory(P("feedback", "no-dash"), mem("feedback", "no-dash", { body: "First para\nwraps.\n\nSecond." }), index)!.summary, "First para wraps.");
  for (const p of ["brain/memory/feedback/_drafts/x.md", "brain/memory/feedback/README.MD", "brain/memory/other/x.md", "brain/memory/user/sub/x.md", "MEMORY.md", "brain/memory/user/Upper.md"]) {
    assert.equal(parseMemory(p, mem("user", "x")), null, p);
  }
});

test("parseDraft and parseNote", () => {
  const d = parseDraft("brain/memory/feedback/_drafts/ack-failures.md", "---\ntags: [memory/feedback, status/draft]\nsession: abc\ncreated: 2026-09-23\ndescription: Say when a tool failed.\n---\n\n# Acknowledge failures\n")!;
  assert.deepEqual([d.slug, d.title, d.description, d.session, d.created], ["ack-failures", "Acknowledge failures", "Say when a tool failed.", "abc", "2026-09-23"]);
  assert.equal(parseDraft("brain/memory/feedback/x.md", "# x"), null);
  assert.equal(parseNote("patterns", "brain/patterns/debugging.md", "---\nupdated: 2026-10-05\n---\n\n# Debugging Patterns\n\n### Bisect\n\nBisect first.\n")!.title, "Debugging Patterns");
  assert.equal(parseNote("patterns", "brain/patterns/README.md", "# x"), null);
  assert.equal(parseNote("reflections", "brain/reflections/2026-W40.md", "# Week 40\n\nThemes.")!.summary, "Themes.");
  assert.equal(parseNote("reflections", "brain/patterns/x.md", "# x"), null);
});

const HUB = (o: Partial<Record<keyof BrainHub, unknown>> = {}): string => JSON.stringify({
  schema: 1, builtAt: "2026-10-11T12:00:00.000Z",
  counts: { memories: 5, byType: { user: 1 }, unreviewed: 3, drafts: 1, patterns: 1, reflections: 0, archived: 0, superseded: 0 },
  batches: [], dups: [], clusters: [], usage: { since: null, paths: {} }, hygiene: {}, shipped: [], ...o,
});

test("parseBrainHub coerces every field and drops bad rows; anything else is null", () => {
  const h = parseBrainHub(HUB({
    batches: [{ key: S1, session: S1, host: "claude", title: "Spaces wrap-up", lead: "Close fix", at: "2026-10-11T04:36:00Z", paths: [P("feedback", "a"), 3] }, { nokey: true }],
    dups: [{ a: P("feedback", "a"), b: P("feedback", "b"), score: 0.92, title: 0.8, text: 0.5, meaning: null }, { a: 1 }],
    usage: { since: "2026-10-11T00:00:00Z", paths: { [P("feedback", "a")]: { d7: 2, d30: "x", injected: 2 } } },
  }))!;
  assert.equal(h.batches.length, 1);
  assert.deepEqual(h.batches[0].paths, [P("feedback", "a")]);
  assert.equal(h.dups.length, 1);
  assert.equal(h.dups[0].meaning, null);
  assert.deepEqual(h.usage.paths[P("feedback", "a")], { d7: 2, d30: 0, last: null, injected: 2, recalled: 0, read: 0, claude: 0, codex: 0 });
  assert.equal(h.counts.unreviewed, 3);
  for (const raw of [null, "", "not json", "[]", JSON.stringify({ schema: 2 })]) assert.equal(parseBrainHub(raw), null, String(raw));
});

test("brain-sources.json: the fill and which section carries a memory", () => {
  const src = parseBrainSources(JSON.stringify({ schema: 1, budget: 850, tokens: 875, sections: { who: { paths: [P("user", "profile")], tokens: 79 }, rules: { paths: [P("feedback", "graphify-first")], tokens: 42 }, active: { paths: [], omitted: [P("projects", "old")], tokens: 600 } } }))!;
  assert.equal(brainMdPercent(src), 103);
  assert.deepEqual(brainMdSection(src, P("feedback", "graphify-first")), { section: "rules", label: "Critical rules", tokens: 42, count: 1 });
  assert.equal(brainMdSection(src, P("projects", "old")), null);
  // The tokens are the section's: with others in it, the line says so rather than reading as this memory's cost.
  assert.equal(brainMdLine({ tokens: 42, count: 1 }), "42 tokens · every session, both hosts");
  assert.equal(brainMdLine({ tokens: 558, count: 21 }), "one of 21 memories, 558 tokens together · every session, both hosts");
  assert.deepEqual(src.omitted, [P("projects", "old")]);
  assert.equal(brainMdPercent(null), null);
  assert.equal(parseBrainSources("{}"), null);
});

const TRAIL = [
  { ts: "2026-10-11T04:30:00.000Z", session: S1, action: "written", slug: "a", type: "feedback", title: "A" },
  { ts: "2026-10-11T04:31:00.000Z", session: S1, action: "written", slug: "b", type: "feedback", title: "B" },
  { ts: "2026-10-11T05:00:00.000Z", session: S1, action: "kept", slug: "a", type: "feedback", title: "A" },
].map((r) => JSON.stringify(r)).join("\n") + "\n";

test("the trail: written-at per memory, else created; a memory's history newest first", () => {
  const rows = readTrailRows(TRAIL);
  assert.equal(rows[0].action, "written");
  const w = writtenAtMap(rows);
  assert.equal(writtenAt({ type: "feedback", slug: "a", created: "2026-10-10" }, w), "2026-10-11T04:30:00.000Z");
  assert.equal(writtenAt({ type: "feedback", slug: "zz", created: "2026-10-10" }, w), "2026-10-10");
  assert.deepEqual(historyFor(rows, { type: "feedback", slug: "a" }).map((r) => r.action), ["kept", "written"]);
  assert.deepEqual(readTrailRows(null), []);
});

test("reviewBatches: the files win over a stale hub; a memory the scan missed gets its own batch or joins its session's", () => {
  const files = {
    [P("feedback", "a")]: mem("feedback", "a", { reviewed: true, session: S1 }),            // kept since the scan
    [P("feedback", "b")]: mem("feedback", "b", { reviewed: false, session: S1 }),
    [P("reference", "c")]: mem("reference", "c", { reviewed: false, session: S1, created: "2026-10-11" }), // after the scan, same session
    [P("projects", "d")]: mem("projects", "d", { reviewed: false, session: S2, created: "2026-10-11" }),  // after the scan, new session
    [P("projects", "e")]: mem("projects", "e", { reviewed: false, tags: "status/archived" }),          // archived since
    [P("reference", "f")]: mem("reference", "f", { reviewed: false, session: "in-session", created: "2026-10-09" }),
  };
  const memories = store(files);
  const hub = parseBrainHub(HUB({ batches: [
    { key: S1, session: S1, host: "claude", title: "Spaces wrap-up", lead: "A", at: "2026-10-11T04:31:00.000Z", paths: [P("feedback", "a"), P("feedback", "b")] },
    { key: "x", session: null, host: null, title: "Old", lead: "E", at: "2026-10-01", paths: [P("projects", "e")] },
  ] }));
  const pairs = livePairs(parseBrainHub(HUB({ dups: [{ a: P("feedback", "b"), b: P("feedback", "a"), score: 0.9, title: 1, text: 0.5, meaning: null }] })), new Map(memories.map((m) => [m.path, m])));
  const batches = reviewBatches(memories, hub, writtenAtMap(readTrailRows(TRAIL)), dupFlags(pairs));
  assert.deepEqual(batches.map((b) => b.key), [S2, S1, "in-session:2026-10-09"]);
  const s1 = batches.find((b) => b.key === S1)!;
  assert.equal(s1.title, "Spaces wrap-up");
  assert.equal(s1.host, "claude");
  assert.deepEqual(s1.paths, [P("feedback", "b"), P("reference", "c")]);   // c landed after the scan: after b's trail ts
  assert.equal(s1.at, "2026-10-11T12:00:00.000Z");
  assert.deepEqual(s1.known, [P("feedback", "b")]);
  // c landed after the scan: nothing has checked it for duplicates, so ⇧K's "new" leaves it (D3, D11).
  assert.deepEqual(s1.fresh, []);
  assert.deepEqual(s1.unchecked, [P("reference", "c")]);
  const s2 = batches.find((b) => b.key === S2)!;
  assert.deepEqual([s2.fresh, s2.unchecked], [[], [P("projects", "d")]]);
  assert.equal(s2.title, "Session 0c0ffee0 · 2026-10-11");
  assert.equal(s2.lead, "d");
  assert.equal(s2.at, "2026-10-11T12:00:00.000Z");     // a day only, after the scan: no earlier than builtAt
  assert.equal(batches[2].title, "In-session wrap · 2026-10-09");
  // No hub: each batch keeps its own day, and a timestamp after that day's local midnight sorts above a bare day. A bare
  // day is local midnight, so the time is one past midnight on 2026-10-11 in every zone (UTC+14 to UTC−12: 18:00Z).
  const late = writtenAtMap(readTrailRows(TRAIL.replace("2026-10-11T04:31:00.000Z", "2026-10-11T18:00:00.000Z")));
  const own = reviewBatches(memories, null, late, new Map());
  assert.deepEqual(own.map((b) => b.key), [S1, S2, "in-session:2026-10-09"]);
  // With no hub nothing is checked: every memory waits for the check, none is "new".
  assert.deepEqual(own.flatMap((b) => b.fresh), []);
  assert.equal(own.flatMap((b) => b.unchecked).length, 4);
  // Once the hub holds a memory with no flag, it is new.
  const all = parseBrainHub(HUB({ batches: [{ key: S1, session: S1, host: "claude", title: "T", lead: "B", at: "2026-10-11T12:00:00.000Z", paths: [P("feedback", "b"), P("reference", "c")] }] }));
  const after = reviewBatches(memories, all, writtenAtMap(readTrailRows(TRAIL)), new Map()).find((b) => b.key === S1)!;
  assert.deepEqual([[...after.fresh].sort(), after.unchecked], [[P("feedback", "b"), P("reference", "c")], []]);
  assert.deepEqual(reviewCounts(batches, [], pairs, []), { session: 4, drafts: 0, duplicates: 1, older: 0 });
});

test("livePairs drops pairs with a gone memory and pairs dismissed here; dupFlags keeps each memory's best partner", () => {
  const memories = store({
    [P("feedback", "a")]: mem("feedback", "a"), [P("feedback", "b")]: mem("feedback", "b"), [P("feedback", "c")]: mem("feedback", "c"),
    [P("feedback", "gone")]: mem("feedback", "gone", { tags: "status/superseded" }),
  });
  const byPath = new Map(memories.map((m) => [m.path, m]));
  const hub = parseBrainHub(HUB({ dups: [
    { a: P("feedback", "a"), b: P("feedback", "b"), score: 0.85, title: 1, text: 0.5, meaning: null },
    { a: P("feedback", "a"), b: P("feedback", "c"), score: 0.95, title: 1, text: 0.5, meaning: null },
    { a: P("feedback", "a"), b: P("feedback", "gone"), score: 0.99, title: 1, text: 0.5, meaning: null },
  ] }));
  const pairs = livePairs(hub, byPath);
  assert.deepEqual(pairs.map((d) => d.score), [0.95, 0.85]);
  assert.deepEqual(dupFlags(pairs).get(P("feedback", "a")), { other: P("feedback", "c"), score: 0.95 });
  assert.deepEqual(dupFlags(pairs).get(P("feedback", "b")), { other: P("feedback", "a"), score: 0.85 });
  assert.equal(livePairs(hub, byPath, new Set([pairKey(P("feedback", "c"), P("feedback", "a"))])).length, 1);
  assert.deepEqual(nearby(pairs, P("feedback", "a"), byPath).map((n) => n.title), ["c", "b"]);
});

test("the week split, the 30-day queue, Mark everything before, and its default day", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const memories = store({
    [P("feedback", "new")]: mem("feedback", "new", { reviewed: false, created: "2026-10-10" }),
    [P("feedback", "old")]: mem("feedback", "old", { reviewed: false, created: "2026-08-01" }),
    [P("feedback", "older")]: mem("feedback", "older", { reviewed: false, created: "2026-07-01" }),
    [P("feedback", "kept")]: mem("feedback", "kept", { reviewed: true, created: "2026-07-01" }),
  });
  const w = new Map<string, string>();
  assert.deepEqual(olderQueue(memories, w, now).map((m) => m.slug), ["older", "old"]);
  assert.deepEqual(writtenBefore(memories, w, "2026-10-01").sort(), [P("feedback", "old"), P("feedback", "older")]);
  assert.deepEqual(writtenBefore(memories, w, "not a day"), []);
  const batches = reviewBatches(memories, null, w, new Map());
  const split = splitByWeek(batches, now);
  assert.equal(split.week.length, 1);
  assert.equal(split.earlier.length, 2);
  assert.equal(defaultMarkBefore(new Date(2026, 9, 11)), "2026-10-01");
  assert.equal(defaultMarkBefore(new Date(2026, 9, 3)), "2026-09-01");
  assert.equal(defaultMarkBefore(new Date(2026, 0, 2)), "2025-12-01");
});

test("reviewKey: ↑↓ K E M A P ⇧K ⏎, nothing with a modifier", () => {
  assert.equal(reviewKey({ key: "k" }), "keep");
  assert.equal(reviewKey({ key: "K", shiftKey: true }), "keepBatch");
  assert.equal(reviewKey({ key: "e" }), "edit");
  assert.equal(reviewKey({ key: "m" }), "merge");
  assert.equal(reviewKey({ key: "a" }), "archive");
  assert.equal(reviewKey({ key: "p" }), "pin");
  assert.equal(reviewKey({ key: "ArrowDown" }), "down");
  assert.equal(reviewKey({ key: "ArrowUp" }), "up");
  assert.equal(reviewKey({ key: "Enter" }), "open");
  assert.equal(reviewKey({ key: "k", metaKey: true }), null);
  assert.equal(reviewKey({ key: "A", shiftKey: true }), null);
  assert.equal(reviewKey({ key: "x" }), null);
});

test("the rail badge counts what was written since the marker, never the backlog", () => {
  const memories = store({
    [P("feedback", "a")]: mem("feedback", "a", { reviewed: false }),
    [P("feedback", "b")]: mem("feedback", "b", { reviewed: false }),
    [P("feedback", "c")]: mem("feedback", "c", { reviewed: true }),
  });
  const w = new Map([["feedback/a", "2026-10-11T10:00:00Z"], ["feedback/b", "2026-10-11T08:00:00Z"], ["feedback/c", "2026-10-11T11:00:00Z"]]);
  assert.equal(brainBadge(memories, w, null), 0);
  assert.equal(brainBadge(memories, w, "2026-10-11T09:00:00Z"), 1);
  assert.equal(brainBadge(memories, w, "2026-10-11T07:00:00Z"), 2);
  assert.equal(sinceMarker([{ ts: "2026-10-11T10:00:00Z", action: "written", pending: true }, { ts: "2026-10-11T10:00:00Z", action: "written", pending: false }, { ts: "2026-10-11T10:00:00Z", action: "kept" }], "2026-10-11T09:00:00Z"), 1);
  assert.equal(sinceMarker([], null), 0);
  const rows = readTrailRows(TRAIL);
  assert.deepEqual(trailSince(rows, "2026-10-11T04:30:30Z"), [P("feedback", "b")]);
  assert.deepEqual(trailSince(rows, "2026-10-11T00:00:00Z"), [P("feedback", "a"), P("feedback", "b")]);
  assert.deepEqual(trailSince(rows, null), []);
});

test("headerStats and the mode badges", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const files: Record<string, string> = {};
  for (let i = 0; i < 28; i++) files[P("reference", `r${i}`)] = mem("reference", `r${i}`, { created: "2026-10-05" });
  files[P("reference", "gone")] = mem("reference", "gone", { tags: "status/archived" });
  assert.equal(headerStats(store(files), 9, 1, new Map(), now), "28 memories · 9 patterns · 1 reflection · +2 a day");
  assert.equal(headerStats(store({}), 0, 0, new Map(), now), "0 memories · 0 patterns · 0 reflections");
  assert.deepEqual(modeBadges({ toReview: 257, live: 338, brainPct: 103 }), { review: { text: "257", tone: "warn" }, library: { text: "338", tone: "plain" }, bootstrap: { text: "103%", tone: "warn" } });
  assert.deepEqual(modeBadges({ toReview: 0, live: 3, brainPct: null }), { library: { text: "3", tone: "plain" } });
});

test("libraryRows: kinds, the query over title and body, the facets, by use with a usage log, else newest", () => {
  const memories = store({
    [P("feedback", "graphify-first")]: mem("feedback", "graphify-first", { title: "Graphify first", updated: "2026-09-30", source: "auto-wrap", pin: true, body: "Ask the graph tools." }),
    [P("reference", "graph-pass")]: mem("reference", "graph-pass", { title: "Graph semantic pass", updated: "2026-10-05", body: "Finish the pass." }),
    [P("reference", "tides")]: mem("reference", "tides", { title: "Tide notes", updated: "2026-10-09", body: "Rate limit; the graph is unrelated." }),
    [P("projects", "old")]: mem("projects", "old", { title: "Old graph spike", tags: "status/archived" }),
  });
  const data = { memories, drafts: [parseDraft("brain/memory/feedback/_drafts/d.md", "# Draft graph rule\n")!], patterns: [], reflections: [] };
  const rows = libraryRows(data, { ...DEFAULT_LIBRARY_FILTER, query: "graph" }, null);
  assert.deepEqual(rows.map((r) => r.title), ["Graph semantic pass", "Graphify first", "Tide notes"]);   // title hits first, then newest
  assert.equal(rows[0].useLabel, "");
  const hub = parseBrainHub(HUB({ usage: { since: "2026-10-01T00:00:00Z", paths: { [P("feedback", "graphify-first")]: { d30: 226 } } } }));
  const used = libraryRows(data, { ...DEFAULT_LIBRARY_FILTER, query: "graph" }, hub);
  assert.deepEqual(used.map((r) => [r.title, r.useLabel]), [["Graphify first", "226×"], ["Graph semantic pass", "unused"], ["Tide notes", "unused"]]);
  assert.deepEqual(libraryRows(data, { ...DEFAULT_LIBRARY_FILTER, use: "unused" }, hub).map((r) => r.title), ["Tide notes", "Graph semantic pass"]);
  assert.deepEqual(libraryRows(data, { ...DEFAULT_LIBRARY_FILTER, status: "archived" }, null).map((r) => r.title), ["Old graph spike"]);
  assert.equal(libraryRows(data, { ...DEFAULT_LIBRARY_FILTER, status: "any" }, null).length, 4);
  assert.deepEqual(libraryRows(data, { ...DEFAULT_LIBRARY_FILTER, type: "feedback" }, null).map((r) => r.title), ["Graphify first"]);
  assert.deepEqual(libraryRows(data, { ...DEFAULT_LIBRARY_FILTER, source: "(none)" }, null).map((r) => r.title), ["Tide notes", "Graph semantic pass"]);
  assert.deepEqual(libraryRows(data, { ...DEFAULT_LIBRARY_FILTER, kind: "drafts" }, null).map((r) => [r.title, r.status]), [["Draft graph rule", "draft"]]);
  assert.deepEqual(sourceOptions(memories), ["(none)", "auto-wrap"]);
  assert.equal(hostSplit({ d7: 0, d30: 0, last: null, injected: 0, recalled: 0, read: 0, claude: 9, codex: 5 }), "claude 9 · codex 5");
  assert.equal(hostSplit(null), "");
});

test("memoryArgs: each verb's argv, --json last; bad paths, slugs, hashes and counts throw", () => {
  const a = P("feedback", "a");
  const b = P("feedback", "b");
  assert.deepEqual(memoryArgs({ verb: "keep", paths: [a, b] }), ["memory", "keep", a, b, "--json"]);
  assert.deepEqual(memoryArgs({ verb: "archive", paths: [a] }), ["memory", "archive", a, "--json"]);
  assert.deepEqual(memoryArgs({ verb: "set", path: a, fields: { pin: true }, expect: "a".repeat(64) }), ["memory", "set", a, "--set", '{"pin":true}', "--expect", "a".repeat(64), "--json"]);
  assert.deepEqual(memoryArgs({ verb: "supersede", path: a, by: b }), ["memory", "supersede", a, "--by", b, "--json"]);
  assert.deepEqual(memoryArgs({ verb: "draft", action: "reject", slug: "ack-failures" }), ["memory", "draft", "reject", "ack-failures", "--json"]);
  assert.deepEqual(memoryArgs({ verb: "notdup", a, b }), ["memory", "notdup", a, b, "--json"]);
  assert.throws(() => memoryArgs({ verb: "keep", paths: ["brain/memory/feedback/../x.md"] }));
  assert.throws(() => memoryArgs({ verb: "keep", paths: [] }));
  assert.throws(() => memoryArgs({ verb: "keep", paths: Array.from({ length: MAX_PATHS_PER_CALL + 1 }, () => a) }));
  assert.throws(() => memoryArgs({ verb: "set", path: a, fields: { pin: true }, expect: "nothex" }));
  assert.throws(() => memoryArgs({ verb: "draft", action: "approve", slug: "-x" }));
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("brainVerbResult: the JSON, a refusal, an old runtime, a stale hash, the runtime's own line", () => {
  const base = { code: 0, stdout: "", stderr: "", timedOut: false, json: null };
  assert.deepEqual(brainVerbResult({ ...base, json: { kept: ["x"], already: [] } }), { ok: true, json: { kept: ["x"], already: [] } });
  assert.deepEqual(brainVerbResult({ ...base, stdout: '{"pair":["a","b"],"added":true}' }), { ok: true, json: { pair: ["a", "b"], added: true } });
  const refused = brainVerbResult({ ...base, code: -1, error: "spawn refused by the write policy" });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.refused, true);
  assert.equal(!refused.ok && refused.reason, BRAIN_OFF_TEXT);
  const old = brainVerbResult({ ...base, code: 2, stderr: "aos: unknown command: memory\n" });
  assert.equal(!old.ok && old.outdated, true);
  assert.equal(!old.ok && old.reason, BRAIN_UPGRADE_TEXT);
  const stale = brainVerbResult({ ...base, code: 1, stderr: "aos: brain/memory/feedback/a.md changed since it was read: read it again\n" });
  assert.equal(!stale.ok && stale.stale, true);
  assert.equal(!stale.ok && stale.reason, "brain/memory/feedback/a.md changed since it was read: read it again");
  assert.equal((brainVerbResult({ ...base, timedOut: true, code: -1 }) as { reason: string }).reason, "aos did not answer in time");
});

test("touchesBrain, isBrainMode, isReviewQueue", () => {
  for (const p of ["MEMORY.md", "brain/memory/user/x.md", "brain/memory/feedback/_drafts/d.md", "brain/_index/brain-hub.json", "brain/_index/brain-sources.json", "brain/_index/promote-log.jsonl", "brain/patterns/a.md", "brain/reflections/w.md"]) assert.equal(touchesBrain(p), true, p);
  for (const p of ["TODO.md", "brain/memoryx/a.md", "brain/_index/snapshot.json"]) assert.equal(touchesBrain(p), false, p);
  assert.equal(isBrainMode("library"), true);
  assert.equal(isBrainMode("graph"), false);
  assert.equal(isReviewQueue("drafts"), true);
  assert.equal(isReviewQueue("all"), false);
});

// ── Library's reader and context ──

test("shortDay: month and day, the year only when it is not this year's, empty for a non-date", () => {
  const now = new Date(2026, 9, 11, 12);
  assert.equal(shortDay("2026-09-30", now), "Sep 30");
  assert.equal(shortDay(new Date(2026, 9, 2, 15).toISOString(), now), "Oct 2");
  assert.equal(shortDay("2025-12-31", now), "Dec 31 2025");
  assert.equal(shortDay("someday", now), "");
  assert.equal(shortDay(null, now), "");
});

test("historyLine: oldest first, written by the source, set names its fields, created when the trail has no written row", () => {
  const now = new Date(2026, 9, 11, 12);
  const at = (mo: number, d: number): string => new Date(2026, mo, d, 12).toISOString();
  const row = (action: string, ts: string, extra: Record<string, unknown> = {}) => ({ ts, session: "", action, slug: "a", type: "feedback", title: "A", ...extra }) as never;
  const rows = [row("archived", at(9, 5)), row("set", at(9, 3), { fields: ["pin"] }), row("kept", at(9, 2)), row("kept", at(9, 2)), row("written", at(8, 30))];
  assert.equal(historyLine(rows, { source: "auto-wrap", created: "2026-09-30" }, now), "Written by auto-wrap Sep 30 · kept Oct 2 · set pin Oct 3 · archived Oct 5");
  assert.equal(historyLine([row("kept", at(9, 2))], { source: null, created: "2026-09-29" }, now), "Created Sep 29 · kept Oct 2");
  // Written and kept in the same millisecond, handed over newest first (historyFor): the write still leads.
  assert.equal(historyLine([row("kept", at(9, 2)), row("written", at(9, 2))], { source: null, created: null }, now), "Written by auto-wrap Oct 2 · kept Oct 2");
  assert.equal(historyLine([row("<b>", at(9, 2))], { source: null, created: null }, now), "Changed Oct 2");
  assert.equal(historyLine([], { source: null, created: null }, now), "");
  const many = Array.from({ length: 10 }, (_, i) => row("kept", at(9, i + 1)));
  const line = historyLine(many, { source: null, created: null }, now);
  assert.match(line, /^Kept Oct 1 · … · kept Oct 5 · /);
  assert.equal(line.split(" · ").length, 8);
});

test("bodyWithoutTitle drops the leading H1 only when it is the title", () => {
  assert.equal(bodyWithoutTitle("\n# Graphify first\n\nAsk the graph.\n", "Graphify first"), "Ask the graph.\n");
  assert.equal(bodyWithoutTitle("# Other\n\nText", "Graphify first"), "# Other\n\nText");
  assert.equal(bodyWithoutTitle("Intro\n# Graphify first\n", "Graphify first"), "Intro\n# Graphify first\n");
});

test("linkTargets and linksTo: wiki-links by name (alias, heading, folder), markdown links by vault path", () => {
  const t = linkTargets("See [[Graphify-First|the rule]], [[notes/tide#Top]], ![[img.png]] and [x](brain/memory/reference/graph-pass.md#why) or [y](./brain/memory/user/me.md \"t\") [z](https://example.com/a%20b)");
  assert.ok(linksTo(t, "brain/memory/feedback/graphify-first.md"));
  assert.ok(linksTo(t, "brain/memory/projects/tide.md"));
  assert.ok(linksTo(t, "brain/memory/reference/graph-pass.md"));
  assert.ok(linksTo(t, "brain/memory/user/me.md"));
  assert.ok(!linksTo(t, "brain/memory/feedback/graph.md"));
  assert.ok(t.paths.has("https://example.com/a b"));
  assert.equal(linkTargets("[[#heading]] [[]]").wiki.size, 0);
});

test("linkSourceKind names what links a memory", () => {
  assert.equal(linkSourceKind("brain/memory/reference/x.md"), "reference");
  assert.equal(linkSourceKind("brain/memory/feedback/_drafts/x.md"), "draft");
  assert.equal(linkSourceKind("MEMORY.md"), "index");
  assert.equal(linkSourceKind("brain/_index/BRAIN.md"), "index");
  assert.equal(linkSourceKind("brain/patterns/p.md"), "pattern");
  assert.equal(linkSourceKind("brain/reflections/r.md"), "reflection");
  assert.equal(linkSourceKind("AGENTICOS.md"), "vault");
});

test("nearbyBasis: meaning when a pair has an embedding score, words without, null with no pair", () => {
  const a = P("feedback", "a"), b = P("feedback", "b"), c = P("feedback", "c");
  const pairs = [{ a, b, score: 0.9, title: 0.5, text: 0.9, meaning: null }, { a: b, b: c, score: 0.8, title: 0.2, text: 0.6, meaning: 0.8 }];
  assert.equal(nearbyBasis(pairs, a), "words");
  assert.equal(nearbyBasis(pairs, b), "meaning");
  assert.equal(nearbyBasis(pairs, P("user", "z")), null);
});

test("filterShowing clears or widens only the facets that hide the memory", () => {
  const files = {
    [P("feedback", "live")]: mem("feedback", "live", { source: "auto-wrap" }),
    [P("projects", "gone")]: mem("projects", "gone", { tags: "status/archived" }),
    [P("projects", "done")]: mem("projects", "done", { tags: "status/complete" }),
  };
  const [live, gone, done] = store(files);
  const f = { ...DEFAULT_LIBRARY_FILTER, kind: "drafts" as const, query: "q", type: "projects" as const, source: "(none)", status: "paused" as const };
  assert.deepEqual(filterShowing(f, live, null), { ...f, kind: "memories", type: null, source: null, status: "live" });
  assert.deepEqual(filterShowing(f, gone, null), { ...f, kind: "memories", status: "any" });
  assert.deepEqual(filterShowing({ ...DEFAULT_LIBRARY_FILTER, status: "complete" }, done, null), { ...DEFAULT_LIBRARY_FILTER, status: "complete" });
  const hub = parseBrainHub(JSON.stringify({ schema: 1, usage: { since: "2026-10-01", paths: { [live.path]: { d30: 3 } } } }));
  assert.equal(filterShowing({ ...DEFAULT_LIBRARY_FILTER, use: "unused" }, live, hub).use, "any");
  assert.equal(filterShowing({ ...DEFAULT_LIBRARY_FILTER, use: "used" }, live, hub).use, "used");
  assert.equal(filterShowing({ ...DEFAULT_LIBRARY_FILTER, use: "used" }, done, hub).use, "any");
  assert.equal(filterShowing({ ...DEFAULT_LIBRARY_FILTER, use: "used" }, done, null).use, "used");
});

test("librarySelection keeps a chosen memory through a filter, an automatic one only while it matches", () => {
  const rows = [{ path: "x" }, { path: "y" }];
  const all = (): boolean => true;
  assert.deepEqual(librarySelection(rows, null, false, all), { sel: "x", chosen: false });
  assert.deepEqual(librarySelection(rows, "y", false, all), { sel: "y", chosen: false });
  assert.deepEqual(librarySelection(rows, "z", false, all), { sel: "x", chosen: false });
  assert.deepEqual(librarySelection(rows, "z", true, all), { sel: "z", chosen: true });
  assert.deepEqual(librarySelection([], "z", true, all), { sel: "z", chosen: true });
  assert.deepEqual(librarySelection(rows, "z", true, (p) => p !== "z"), { sel: "x", chosen: false });
  assert.deepEqual(librarySelection([], null, false, all), { sel: null, chosen: false });
});

// ── Review's words and selection ──

test("batchWhen and batchMeta: today's time, another day's date, a bare day, host or wrap, the session's first 8", () => {
  const now = new Date(2026, 9, 11, 12);
  const today = new Date(2026, 9, 11, 4, 36).toISOString();
  const oct9 = new Date(2026, 9, 9, 14, 5).toISOString();
  assert.equal(batchWhen(today, now), "04:36");
  assert.equal(batchWhen(oct9, now), "Oct 9");
  assert.equal(batchWhen("2026-10-11", now), "today");
  assert.equal(batchWhen("2026-10-01", now), "Oct 1");
  assert.equal(batchWhen("", now), "");
  assert.equal(batchMeta({ host: "claude", at: today, session: S1 }, now), "claude · today 04:36 · session 2f25a8d9");
  assert.equal(batchMeta({ host: "codex", at: oct9, session: null }, now), "codex · Oct 9 14:05");
  assert.equal(batchMeta({ host: null, at: "2026-10-01", session: null }, now), "wrap · Oct 1");
  assert.equal(batchMeta({ host: null, at: "", session: S2 }, now), "wrap · session 0c0ffee0");
});

test("knownLabel and batchLede read right for none, one and many", () => {
  assert.equal(knownLabel(0), "");
  assert.equal(knownLabel(1), "1 looks known");
  assert.equal(knownLabel(3), "3 look known");
  // What is left to review, never "wrote": a batch shrinks as its memories are kept.
  assert.equal(batchLede(6, 3), "6 left to review. 3 look new, 3 look like ones you already have.");
  assert.equal(batchLede(6, 1), "6 left to review. 5 look new, 1 looks like one you already have.");
  assert.equal(batchLede(6, 5), "6 left to review. 1 looks new, 5 look like ones you already have.");
  assert.equal(batchLede(4, 0), "4 left to review. All 4 look new.");
  assert.equal(batchLede(3, 3), "3 left to review. All 3 look like ones you already have.");
  assert.equal(batchLede(2, 0), "2 left to review. Both look new.");
  assert.equal(batchLede(2, 2), "2 left to review. Both look like ones you already have.");
  assert.equal(batchLede(1, 0), "1 left to review. It looks new.");
  assert.equal(batchLede(1, 1), "1 left to review. It looks like one you already have.");
  assert.equal(batchLede(0, 0), "Nothing left to review from this session.");
  // Not checked for duplicates yet (written since the last scan).
  assert.equal(batchLede(1, 0, 1), "1 left to review. It waits for the duplicate check.");
  assert.equal(batchLede(3, 0, 3), "3 left to review. All 3 wait for the duplicate check.");
  assert.equal(batchLede(4, 1, 1), "4 left to review. 2 look new, 1 looks like one you already have, 1 waits for the duplicate check.");
  assert.equal(batchLede(3, 0, 2), "3 left to review. 1 looks new, 2 wait for the duplicate check.");
});

test("olderFirst: by when written (the trail, then created), then created, then path", () => {
  const ms = store({
    [P("feedback", "a")]: mem("feedback", "a", { created: "2026-10-07" }),
    [P("feedback", "b")]: mem("feedback", "b", { created: "2026-10-09" }),
    [P("feedback", "c")]: mem("feedback", "c", { created: "2026-10-09" }),
  });
  const [a, b, c] = ms;
  assert.deepEqual(olderFirst(b, a, new Map()).map((m) => m.slug), ["a", "b"]);
  assert.deepEqual(olderFirst(c, b, new Map()).map((m) => m.slug), ["b", "c"]);
  const written = new Map([["feedback/a", "2026-10-10T08:00:00.000Z"]]);
  assert.deepEqual(olderFirst(a, b, written).map((m) => m.slug), ["b", "a"]);
});

test("compareAges labels the two boxes by the rule Keep the older one keeps with: the card can be the older one", () => {
  const ms = store({
    [P("feedback", "sep")]: mem("feedback", "sep", { created: "2026-09-21" }),
    [P("feedback", "oct")]: mem("feedback", "oct", { created: "2026-10-11" }),
  });
  const [sep, oct] = ms;
  const onOct = compareAges(oct, sep, new Map());
  assert.deepEqual([onOct.mine, onOct.other, onOct.older.slug, onOct.newer.slug], ["NEWER", "OLDER", "sep", "oct"]);
  const onSep = compareAges(sep, oct, new Map());
  assert.deepEqual([onSep.mine, onSep.other, onSep.older.slug, onSep.newer.slug], ["OLDER", "NEWER", "sep", "oct"]);
});

test("pendingReview: reviewed: false in a live memory's frontmatter; archived, superseded, kept or body-only text is not", () => {
  assert.equal(pendingReview(mem("feedback", "a", { reviewed: false })), true);
  assert.equal(pendingReview(mem("feedback", "a", { reviewed: false, tags: "status/active" })), true);
  assert.equal(pendingReview(mem("feedback", "a", { reviewed: false, tags: "status/archived" })), false);
  assert.equal(pendingReview(mem("feedback", "a", { reviewed: false, tags: "status/superseded" })), false);
  assert.equal(pendingReview(mem("feedback", "a", { reviewed: true, body: "reviewed: false" })), false);
  assert.equal(pendingReview(mem("feedback", "a", { reviewed: false }).replace("reviewed: false", 'reviewed: "false"')), true);
  assert.equal(pendingReview("reviewed: false\n"), false);
  assert.equal(pendingReview(null), false);
});

test("olderByMonth groups the queue's order by month; reviewSelection keeps the key, else the same index, else the last", () => {
  const ms = store({
    [P("projects", "a")]: mem("projects", "a", { created: "2026-08-03" }),
    [P("projects", "b")]: mem("projects", "b", { created: "2026-08-28" }),
    [P("projects", "c")]: mem("projects", "c", { created: "2026-09-02" }),
  });
  assert.deepEqual(olderByMonth(ms, new Map()).map((g) => [g.label, g.items.map((m) => m.slug)]), [["August 2026", ["a", "b"]], ["September 2026", ["c"]]]);
  assert.deepEqual(reviewSelection(["a", "b", "c"], "b", 0), { key: "b", index: 1 });
  assert.deepEqual(reviewSelection(["a", "c"], "b", 1), { key: "c", index: 1 });   // b was kept: the next card
  assert.deepEqual(reviewSelection(["a"], "c", 2), { key: "a", index: 0 });        // the last one went: the one before
  assert.deepEqual(reviewSelection(["a", "b"], null, 0), { key: "a", index: 0 });
  assert.deepEqual(reviewSelection([], "a", 3), { key: null, index: 0 });
});

test("weekUse: the 7-day count, not used, nothing with no usage log", () => {
  const p = P("feedback", "a");
  assert.equal(weekUse(null, p), "");
  assert.equal(weekUse(parseBrainHub(HUB()), p), "");
  const hub = parseBrainHub(HUB({ usage: { since: "2026-10-01T00:00:00Z", paths: { [p]: { d7: 6, d30: 9 } } } }));
  assert.equal(weekUse(hub, p), "used 6× this week");
  assert.equal(weekUse(hub, P("feedback", "b")), "not used this week");
});

test("sessionLabel: a host session by its first 8 characters, anything else whole", () => {
  assert.equal(sessionLabel("2f25a8d9-301b-4619-a341-db99b2c4d8e7"), "session 2f25a8d9");
  assert.equal(sessionLabel("in-session"), "session in-session");
});
