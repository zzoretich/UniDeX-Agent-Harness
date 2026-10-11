import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseMemory, parseIndexLines, parseDraft, parseNote, parseBrainHub, parseBrainSources, brainMdPercent, brainMdSection,
  splitFrontmatter, fmStatus, readTrailRows, writtenAtMap, writtenAt, historyFor, livePairs, dupFlags, reviewBatches,
  splitByWeek, olderQueue, writtenBefore, defaultMarkBefore, reviewCounts, reviewKey, brainBadge, sinceMarker, trailSince,
  headerStats, modeBadges, libraryRows, sourceOptions, nearby, hostSplit, memoryArgs, chunks, brainVerbResult,
  touchesBrain, isBrainMode, isReviewQueue, pairKey, DEFAULT_LIBRARY_FILTER, BRAIN_OFF_TEXT, BRAIN_UPGRADE_TEXT,
  MAX_PATHS_PER_CALL, type BrainMemory, type BrainHub,
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
  assert.deepEqual(brainMdSection(src, P("feedback", "graphify-first")), { section: "rules", label: "Critical rules", tokens: 42 });
  assert.equal(brainMdSection(src, P("projects", "old")), null);
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
  assert.deepEqual(s1.fresh, [P("reference", "c")]);
  const s2 = batches.find((b) => b.key === S2)!;
  assert.equal(s2.title, "Session 0c0ffee0 · 2026-10-11");
  assert.equal(s2.lead, "d");
  assert.equal(s2.at, "2026-10-11T12:00:00.000Z");     // a day only, after the scan: no earlier than builtAt
  assert.equal(batches[2].title, "In-session wrap · 2026-10-09");
  // No hub: each batch keeps its own day, and a timestamp later that day sorts above a bare day.
  const own = reviewBatches(memories, null, writtenAtMap(readTrailRows(TRAIL)), new Map());
  assert.deepEqual(own.map((b) => b.key), [S1, S2, "in-session:2026-10-09"]);
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
