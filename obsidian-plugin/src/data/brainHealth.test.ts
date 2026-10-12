import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HYGIENE_SUBTITLE, FIX_LABEL, archiveShippedAsk, changeFile, changedFiles, compact, deadWeight, deadWeightButtons, deadWeightLegend,
  deadWeightSubtitle, duplicateRows, duplicatesBasis, fixBehindText, fixChangeList, fixDialog, fixDoneText, fixMoreText, healthTiles,
  hygieneCounts, hygieneRows, indexLineCount, liveClusters, shortFile, unreviewedCount, type HealthInput,
} from "./brainHealth";
import {
  DEFAULT_LIBRARY_FILTER, FIX_KINDS, healthCount, libraryRows, parseBrainHub, parseDraft, parseFixResult, parseMemory, usedWithin,
  type BrainMemory, type FixChange, type FixResult, type LibraryFilter,
} from "./brainModel";

const DAY = 24 * 3600 * 1000;
const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;

const mem = (type: string, slug: string, o: { title?: string; status?: string; reviewed?: boolean; pin?: boolean } = {}): string =>
  ["---", "type: memory", `tags: [memory/${type}${o.status ? `, status/${o.status}` : ""}]`, "created: 2026-09-01",
    ...(o.pin ? ["pin: true"] : []), ...(o.reviewed === undefined ? [] : [`reviewed: ${o.reviewed}`]), "---", "", `# ${o.title ?? slug}`, "", "A body.", ""].join("\n");

function memories(files: Array<[string, string, Parameters<typeof mem>[2]?]>): BrainMemory[] {
  return files.map(([t, s, o]) => parseMemory(P(t, s), mem(t, s, o))!).filter(Boolean);
}

function hub(doc: Record<string, unknown> = {}) {
  return parseBrainHub(JSON.stringify({ schema: 1, builtAt: "2026-10-11T12:00:00.000Z", counts: {}, batches: [], dups: [], clusters: [], usage: { since: null, paths: {} }, hygiene: {}, shipped: [], ...doc }))!;
}

function input(o: Partial<HealthInput> = {}): HealthInput {
  const ms = o.memories ?? [];
  return {
    now: new Date(2026, 9, 11, 15), memories: ms, byPath: new Map(ms.map((m) => [m.path, m])), drafts: [], hub: null, sources: null,
    pairs: [], indexRaw: null, settings: { telemetry: true, neverUsedDays: 30 }, ...o,
  };
}

// ── hygiene ──

test("hygieneCounts: sources sums only the old labels, index sums its three findings, and both agree with healthCount", () => {
  const h = hub({
    hygiene: {
      sources: { session: 4, "in-session": 2, wrap: 1, "manual-wrap": 20, "auto-wrap": 90, "(none)": 3 },
      oldType: [P("user", "a"), P("user", "b")], noDescription: [P("projects", "c")],
      unindexed: [P("reference", "d")], misfiled: [P("feedback", "e"), P("feedback", "f")], brokenIndex: [P("projects", "gone")],
      leftoverDrafts: ["rule-one"],
    },
  });
  const c = hygieneCounts(h);
  assert.equal(c.sources, 7);
  assert.deepEqual(c.labels, [{ label: "session", n: 4 }, { label: "in-session", n: 2 }, { label: "wrap", n: 1 }]);
  assert.equal(c.types, 2);
  assert.equal(c.descriptions, 1);
  assert.equal(c.index, 4);
  assert.deepEqual([c.unindexed, c.misfiled, c.broken], [1, 2, 1]);
  assert.equal(c.drafts, 1);
  assert.equal(healthCount(0, h), c.sources + c.types + c.descriptions + c.index + c.drafts, "the rows add up to the Health badge");
  assert.deepEqual(hygieneCounts(null), { sources: 0, labels: [], types: 0, descriptions: 0, index: 0, unindexed: 0, misfiled: 0, broken: 0, drafts: 0 });
});

test("hygieneRows: one row per fix kind, in FIX_KINDS order, with its count, its words and a button that opens a preview", () => {
  const rows = hygieneRows(hub({
    hygiene: {
      sources: { session: 30, wrap: 3, "manual-wrap": 5 }, oldType: Array.from({ length: 22 }, (_, i) => P("user", `u${i}`)),
      noDescription: [P("projects", "x"), P("projects", "y")], unindexed: [P("reference", "r")], misfiled: [P("feedback", "m")],
      brokenIndex: [], leftoverDrafts: ["only-one"],
    },
  }));
  assert.deepEqual(rows.map((r) => r.kind), [...FIX_KINDS]);
  const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
  assert.equal(by.sources.count, 33);
  assert.equal(by.sources.button, "Normalise 33…");
  assert.match(by.sources.text, /^33 memories carry an old source label \(session, wrap\)/);
  assert.equal(by.types.button, "Fix 22…");
  assert.equal(by.types.text, "22 memories use an old type: shape");
  assert.equal(by.descriptions.button, "Copy from MEMORY.md…");
  assert.equal(by.descriptions.text, "2 memories have no description: the list shows only titles");
  assert.equal(by.index.count, 2);
  assert.equal(by.index.button, "Fix 2…", "a mix of findings: Fix");
  assert.equal(by.index.text, "1 memory is not in MEMORY.md; 1 line sits under the wrong heading");
  assert.equal(by.drafts.button, "Remove the draft…");
  assert.equal(by.drafts.text, "1 approved draft is still in feedback/_drafts");
  for (const r of rows) assert.ok(r.button!.endsWith("…"), `${r.kind}: a dialog follows, so its button says so`);
});

test("hygieneRows: the index button names the one finding there is; zero rows have no button; no hub, no rows", () => {
  const only = (h: Record<string, unknown>) => hygieneRows(hub({ hygiene: h })).find((r) => r.kind === "index")!;
  assert.equal(only({ unindexed: [P("user", "a"), P("user", "b"), P("user", "c")] }).button, "Index 3…");
  assert.equal(only({ misfiled: [P("user", "a"), P("user", "b")] }).button, "Move 2…");
  assert.equal(only({ misfiled: [P("user", "a"), P("user", "b")] }).text, "2 lines sit under the wrong heading");
  assert.equal(only({ brokenIndex: [P("user", "gone")] }).button, "Remove 1…");
  assert.equal(only({ brokenIndex: [P("user", "gone")] }).text, "1 line points at a missing file");
  assert.equal(hygieneRows(hub({ hygiene: { leftoverDrafts: ["a", "b"] } })).find((r) => r.kind === "drafts")!.button, "Remove 2…");
  const clean = hygieneRows(hub({ hygiene: { sources: { "manual-wrap": 9, "auto-wrap": 4 } } }));
  assert.equal(clean.length, 5);
  for (const r of clean) { assert.equal(r.count, 0); assert.equal(r.button, null); assert.ok(r.text); }
  assert.deepEqual(hygieneRows(null), []);
});

test("the Hygiene card's subtitle promises a preview, never an undo (fixes are not undoable)", () => {
  assert.equal(HYGIENE_SUBTITLE, "one click, no model, with a preview first");
  assert.doesNotMatch(HYGIENE_SUBTITLE, /undo/i);
});

// ── tiles ──

test("healthTiles: six tiles in the canvas order, each coloured state with its word", () => {
  const ms = memories([["feedback", "a", { reviewed: false }], ["feedback", "b", { reviewed: true }], ["projects", "c", { reviewed: false }], ["projects", "old", { status: "archived", reviewed: false }]]);
  const h = hub({ clusters: [{ paths: [P("feedback", "a"), P("feedback", "b"), P("projects", "c")], label: "alpha" }], hygiene: { unindexed: [P("feedback", "a")], misfiled: [], brokenIndex: [P("user", "gone"), P("user", "gone2")] } });
  const pairs = h.dups.length ? h.dups : [{ a: P("feedback", "a"), b: P("feedback", "b"), score: 0.9, title: 0.9, text: 0.8, meaning: null }];
  const index = "# Memory index\n\n## Feedback\n- [A](brain/memory/feedback/a.md) — one\n\n- [B](brain/memory/feedback/b.md) — two\n";
  const t = healthTiles(input({
    memories: ms, hub: h, pairs, indexRaw: index,
    sources: { builtAt: null, budget: 850, tokens: 875, sections: { who: { paths: [], tokens: 0 }, rules: { paths: [], tokens: 0 }, active: { paths: [], tokens: 0 } }, omitted: [], links: 0, lastSession: 0 },
  }));
  assert.deepEqual(t.map((x) => x.key), ["duplicates", "unreviewed", "unused", "brainmd", "memorymd", "broken"]);
  const by = Object.fromEntries(t.map((x) => [x.key, x]));
  assert.deepEqual([by.duplicates.value, by.duplicates.note, by.duplicates.tone, by.duplicates.word], ["1", "+ 1 cluster", "warn", "to compare"]);
  assert.deepEqual([by.unreviewed.value, by.unreviewed.note, by.unreviewed.tone, by.unreviewed.word], ["2", "67% of all memories", "warn", "to review"]);
  assert.deepEqual([by.brainmd.value, by.brainmd.note, by.brainmd.tone, by.brainmd.word], ["103%", "875 of 850 tokens", "warn", "over budget"]);
  assert.deepEqual([by.memorymd.value, by.memorymd.note, by.memorymd.tone], [String(Math.ceil(index.length / 4)), "tokens · 4 lines", "plain"]);
  assert.deepEqual([by.broken.value, by.broken.note, by.broken.tone, by.broken.word], ["2", "1 unindexed · 0 misfiled", "warn", "to fix"]);
  for (const x of t) if (x.tone !== "plain") assert.ok(x.word, `${x.key}: a coloured tile names its state`);
});

test("healthTiles: all clear reads ok with its words; no hub or no sources reads off, not zero", () => {
  const ms = memories([["user", "me", { reviewed: true }]]);
  const clear = Object.fromEntries(healthTiles(input({
    memories: ms, hub: hub(), indexRaw: "",
    sources: { builtAt: null, budget: 850, tokens: 400, sections: { who: { paths: [], tokens: 0 }, rules: { paths: [], tokens: 0 }, active: { paths: [], tokens: 0 } }, omitted: [], links: 0, lastSession: 0 },
  })).map((x) => [x.key, x]));
  assert.deepEqual([clear.duplicates.tone, clear.duplicates.word, clear.duplicates.note], ["ok", "none found", "no clusters"]);
  assert.deepEqual([clear.unreviewed.tone, clear.unreviewed.word], ["ok", "all reviewed"]);
  assert.deepEqual([clear.brainmd.value, clear.brainmd.tone, clear.brainmd.word], ["47%", "ok", "within budget"]);
  assert.deepEqual([clear.broken.value, clear.broken.tone, clear.broken.word], ["0", "ok", "none broken"]);
  const none = Object.fromEntries(healthTiles(input({ memories: ms })).map((x) => [x.key, x]));
  for (const k of ["duplicates", "unused", "brainmd", "memorymd", "broken"]) {
    assert.equal(none[k].value, "–", k);
    assert.equal(none[k].tone, "off", k);
    assert.ok(none[k].word, k);
  }
  assert.equal(none.duplicates.word, "not scanned");
  assert.equal(none.brainmd.word, "not built");
  assert.equal(none.memorymd.word, "missing");
});

test("unreviewedCount counts live memories with reviewed: false; indexLineCount counts non-blank lines; compact shortens", () => {
  const ms = memories([["user", "a", { reviewed: false }], ["user", "b", { reviewed: false, status: "superseded" }], ["user", "c"]]);
  assert.equal(unreviewedCount(ms), 1);
  assert.equal(indexLineCount("# A\n\n- one\r\n- two\n\n"), 3);
  assert.equal(indexLineCount(null), 0);
  assert.deepEqual([compact(342), compact(4300), compact(4000), compact(17250)], ["342", "4.3k", "4k", "17k"]);
});

// ── Dead weight ──

/** A usage row whose last use was `days` before the hub's build. */
const used = (built: number, days: number) => ({ d7: 0, d30: 0, last: new Date(built - days * DAY).toISOString(), injected: 1, recalled: 0, read: 0, claude: 1, codex: 0 });

test("deadWeight: telemetry off names the reason instead of counts, and the tile says off", () => {
  const d = input({ hub: hub(), settings: { telemetry: false, neverUsedDays: 30 } });
  const dw = deadWeight(d);
  assert.equal(dw.state, "off");
  assert.match(dw.text, /^telemetry\.enabled is off, so nothing is logged/);
  assert.deepEqual(deadWeightButtons(dw), { review: null, archive: null });
  const tile = healthTiles(d).find((x) => x.key === "unused")!;
  assert.deepEqual([tile.value, tile.tone, tile.word, tile.note], ["–", "off", "off", "telemetry is off"]);
});

test("deadWeight: no hub waits for the scan; an empty log and a young log say they are collecting, with since and from", () => {
  assert.equal(deadWeight(input()).state, "nohub");
  const empty = deadWeight(input({ hub: hub() }));
  assert.equal(empty.state, "collecting");
  assert.equal(empty.since, null);
  assert.match(empty.text, /^Collecting: nothing is logged yet\. The counts show once the log holds 30 days\.$/);
  // Local noon on Oct 1: the same day in every zone CI runs (UTC-11, UTC+14).
  const since = new Date(2026, 9, 1, 12).toISOString();
  const young = deadWeight(input({ hub: hub({ usage: { since, paths: {} } }) }));
  assert.equal(young.state, "collecting");
  assert.equal(young.text, "Collecting since Oct 1: the counts show from Oct 31, once the log holds 30 days.");
  const tile = healthTiles(input({ hub: hub({ usage: { since, paths: {} } }) })).find((x) => x.key === "unused")!;
  assert.deepEqual([tile.tone, tile.word, tile.note], ["off", "collecting", "collecting since Oct 1"]);
  // Thirty days on, the counts show.
  assert.equal(deadWeight(input({ now: new Date(2026, 9, 31, 13), hub: hub({ usage: { since, paths: {} } }) })).state, "ready");
});

test("deadWeight: used in 7 days, quiet in the window, never outside it, measured from when the hub counted", () => {
  const now = new Date(2026, 10, 20, 9);
  const built = now.getTime() - 3600 * 1000;
  const ms = memories([
    ["feedback", "hot"], ["feedback", "warm"], ["feedback", "cold"], ["user", "silent"], ["projects", "shipped-done", { status: "complete" }],
    ["projects", "looks-shipped", { status: "active" }], ["projects", "pinned-done", { status: "complete", pin: true }],
    ["projects", "still-going", { status: "active" }], ["projects", "used-done", { status: "complete" }], ["user", "gone", { status: "archived" }],
  ]);
  const h = hub({
    builtAt: new Date(built).toISOString(),
    usage: { since: new Date(built - 90 * DAY).toISOString(), paths: { [P("feedback", "hot")]: used(built, 2), [P("feedback", "warm")]: used(built, 20), [P("feedback", "cold")]: used(built, 45), [P("projects", "used-done")]: used(built, 1) } },
    shipped: [{ path: P("projects", "looks-shipped"), why: "1.2.0" }],
  });
  const dw = deadWeight(input({ now, memories: ms, hub: h }));
  assert.equal(dw.state, "ready");
  assert.deepEqual([dw.used, dw.quiet, dw.never], [2, 1, 6]);
  assert.deepEqual(dw.neverPaths.sort(), [P("feedback", "cold"), P("projects", "looks-shipped"), P("projects", "pinned-done"), P("projects", "shipped-done"), P("projects", "still-going"), P("user", "silent")].sort());
  assert.deepEqual(dw.shipped.sort(), [P("projects", "looks-shipped"), P("projects", "shipped-done")], "complete or looks shipped, never used, not pinned");
  assert.equal(dw.text, "6 memories nobody used in the last 30 days. 2 of them are project notes for shipped work.");
  assert.deepEqual(deadWeightButtons(dw), { review: "Review the 6", archive: "Archive the 2 shipped…" });
  assert.deepEqual(deadWeightLegend(dw).used, "used 2");
  assert.match(deadWeightLegend(dw).help, /^Used: in the last 7 days\. Quiet: not since, but in the last 30\. Never: not in 30 days\.$/);
  const tile = healthTiles(input({ now, memories: ms, hub: h })).find((x) => x.key === "unused")!;
  assert.deepEqual([tile.value, tile.note, tile.tone], ["6", "in 30 days", "plain"]);
  assert.equal(deadWeightSubtitle(30), "never injected, recalled or read in 30 days");
});

test("deadWeight: neverUsedDays sets the window; a memory used inside it is not dead weight; everything used reads so", () => {
  const now = new Date(2026, 10, 20, 9);
  const built = now.getTime();
  const ms = memories([["feedback", "a"], ["feedback", "b"]]);
  const h = hub({ builtAt: new Date(built).toISOString(), usage: { since: new Date(built - 200 * DAY).toISOString(), paths: { [P("feedback", "a")]: used(built, 50), [P("feedback", "b")]: used(built, 3) } } });
  const wide = deadWeight(input({ now, memories: ms, hub: h, settings: { telemetry: true, neverUsedDays: 60 } }));
  assert.deepEqual([wide.used, wide.quiet, wide.never], [1, 1, 0]);
  assert.equal(wide.text, "Every memory was injected, recalled or read in the last 60 days.");
  assert.deepEqual(deadWeightButtons(wide), { review: null, archive: null });
  const narrow = deadWeight(input({ now, memories: ms, hub: h, settings: { telemetry: true, neverUsedDays: 5 } }));
  assert.deepEqual([narrow.used, narrow.quiet, narrow.never], [1, 0, 1]);
  assert.equal(deadWeightLegend(narrow).help, "Used: in the last 5 days. Never: not in 5 days.");
});

test("Review the N lands on exactly N rows: Library's unused facet follows neverUsedDays as Dead weight does", () => {
  const now = new Date(2026, 10, 20, 9);
  const built = now.getTime() - 3600 * 1000;
  // d30 as the runtime counts it (memory-usage.js summarize): the rows in the 30 days before the hub counted.
  const at = (days: number) => ({ ...used(built, days), d30: days <= 30 ? 1 : 0 });
  const ms = memories([["feedback", "d3"], ["feedback", "d20"], ["reference", "d45"], ["user", "d80"], ["projects", "none"], ["user", "gone", { status: "archived" }]]);
  const h = hub({
    builtAt: new Date(built).toISOString(),
    usage: { since: new Date(built - 200 * DAY).toISOString(), paths: { [P("feedback", "d3")]: at(3), [P("feedback", "d20")]: at(20), [P("reference", "d45")]: at(45), [P("user", "d80")]: at(80) } },
  });
  const data = { memories: ms, drafts: [], patterns: [], reflections: [] };
  // What Health's "Review the N" lands on (LibraryMode filterForUse): live memories, use unused.
  const unused: LibraryFilter = { ...DEFAULT_LIBRARY_FILTER, use: "unused" };
  for (const days of [14, 30, 60, 90]) {
    const dw = deadWeight(input({ now, memories: ms, hub: h, settings: { telemetry: true, neverUsedDays: days } }));
    const rows = libraryRows(data, unused, h, days);
    assert.deepEqual(rows.map((r) => r.path).sort(), [...dw.neverPaths].sort(), `${days} days`);
    assert.ok(rows.every((r) => r.useLabel === "unused"), `${days} days: every row reads unused`);
  }
  // Used inside the window but not in the last 30 days reads "used", never a count of 0.
  const wide = libraryRows(data, { ...DEFAULT_LIBRARY_FILTER, use: "used" }, h, 60);
  assert.deepEqual(wide.map((r) => [r.path, r.useLabel]).sort(), [[P("feedback", "d20"), "1×"], [P("feedback", "d3"), "1×"], [P("reference", "d45"), "used"]]);
  assert.equal(usedWithin(h, P("feedback", "d20"), 14), false);
  assert.equal(usedWithin(h, P("feedback", "d20"), 30), true);
  assert.equal(usedWithin(null, P("feedback", "d20"), 30), null, "no usage log, no answer");
});

test("archiveShippedAsk names the count, the reason and the way back", () => {
  const a = archiveShippedAsk(2, 30);
  assert.equal(a.title, "Archive 2 shipped projects?");
  assert.match(a.message, /the 2 project notes nobody used in the last 30 days that are complete or look shipped/);
  assert.match(a.message, /Nothing is deleted: Restore in Library puts each one back\.$/);
  assert.equal(a.confirm, "Archive 2");
  assert.match(archiveShippedAsk(1, 30).message, /^Archives the project note nobody used in the last 30 days that is complete or looks shipped\./);
});

// ── Duplicates ──

test("duplicateRows: pairs with titles, live clusters, leftover drafts with their title; the basis names meaning only with embeddings", () => {
  const ms = memories([["feedback", "pick-options", { title: "Pick options" }], ["feedback", "pick-option", { title: "Pick an option" }], ["reference", "notes", { title: "Notes" }], ["feedback", "rule-one", { title: "Rule one" }], ["reference", "gone", { status: "archived" }]]);
  const byPath = new Map(ms.map((m) => [m.path, m]));
  const drafts = [parseDraft("brain/memory/feedback/_drafts/rule-one.md", "---\ncreated: 2026-10-01\n---\n\n# Rule one (draft)\n\nText.\n")!];
  const h = hub({
    clusters: [{ paths: [P("feedback", "pick-options"), P("feedback", "pick-option"), P("reference", "notes")], label: "pick option" }, { paths: [P("reference", "notes"), P("reference", "gone")], label: "dead" }],
    hygiene: { leftoverDrafts: ["rule-one", "no-such-file", "Bad Slug"] },
  });
  const pairs = [{ a: P("feedback", "pick-options"), b: P("feedback", "pick-option"), score: 0.917, title: 0.9, text: 0.8, meaning: null }];
  const r = duplicateRows({ pairs, byPath, hub: h, drafts });
  assert.deepEqual(r.pairs, [{ a: P("feedback", "pick-options"), b: P("feedback", "pick-option"), score: "0.92", aTitle: "Pick options", bTitle: "Pick an option", meta: "feedback" }]);
  assert.equal(r.clusters.length, 1, "a cluster left with one live memory is gone");
  assert.equal(r.clusters[0].count, "3×");
  assert.equal(r.clusters[0].label, "pick option");
  assert.equal(r.clusters[0].titles, "Pick options · Pick an option · Notes");
  assert.deepEqual(r.drafts, [
    { slug: "rule-one", path: "brain/memory/feedback/_drafts/rule-one.md", title: "Rule one (draft)" },
    { slug: "no-such-file", path: "brain/memory/feedback/_drafts/no-such-file.md", title: "no-such-file" },
  ]);
  assert.equal(r.meaning, false);
  assert.equal(duplicatesBasis(false), "title and text similarity, no model");
  assert.equal(duplicateRows({ pairs: [{ ...pairs[0], meaning: 0.93 }], byPath, hub: h, drafts }).meaning, true);
  assert.equal(duplicatesBasis(true), "title, text and meaning similarity, no model");
  assert.deepEqual(liveClusters(null, byPath), []);
  assert.deepEqual(duplicateRows({ pairs: [], byPath, hub: null, drafts }), { pairs: [], clusters: [], drafts: [], meaning: false });
});

// ── a fix: its change list, its dialog, its Notices ──

const CH = (path: string, action: FixChange["action"], before: string | null, after: string | null): FixChange => ({ path, action, before, after });

test("fixChangeList groups changes by the file they write (MEMORY.md once for every index change), before → after", () => {
  const titles = new Map([[P("user", "a"), "Alpha"], [P("projects", "b"), "Beta"]]);
  const l = fixChangeList([
    CH(P("user", "a"), "type", "user", "memory"),
    CH(P("user", "a"), "tags", "[a]", "[a, memory/user, status/active]"),
    CH(P("projects", "b"), "index-add", null, "- [Beta](brain/memory/projects/b.md) — the beta"),
    CH("MEMORY.md", "index-remove", "- [Gone](brain/memory/projects/gone.md) — was here", null),
    CH(P("user", "a"), "index-move", "## Projects", "## User"),
    CH("brain/memory/feedback/_drafts/rule.md", "draft-remove", "Rule (draft)", null),
  ], (p) => titles.get(p) ?? null);
  assert.equal(l.files, 3);
  assert.equal(l.changes, 6);
  assert.deepEqual([l.more, l.moreFiles], [0, 0]);
  assert.deepEqual(l.groups.map((g) => [g.file, g.title, g.lines.length]), [[P("user", "a"), "Alpha", 2], ["MEMORY.md", null, 3], ["brain/memory/feedback/_drafts/rule.md", null, 1]]);
  assert.deepEqual(l.groups[0].lines[0], { action: "type", label: "type", subject: null, before: "user", after: "memory" });
  assert.deepEqual(l.groups[1].lines.map((x) => [x.label, x.subject]), [["add line", "Beta"], ["remove line", null], ["move line", "Alpha"]]);
  assert.deepEqual(l.groups[2].lines[0], { action: "draft-remove", label: "remove draft", subject: null, before: "Rule (draft)", after: null });
  assert.equal(changeFile(CH(P("user", "a"), "index-move", null, null)), "MEMORY.md");
  assert.deepEqual(changedFiles([CH(P("user", "a"), "source", "wrap", "manual-wrap"), CH(P("user", "b"), "index-add", null, "x"), CH(P("user", "a"), "type", null, "memory")]), [P("user", "a"), "MEMORY.md"]);
});

test("fixChangeList caps what it shows and counts the rest: changes, and files not shown at all", () => {
  const changes = Array.from({ length: 50 }, (_, i) => CH(P("feedback", `m${String(i).padStart(2, "0")}`), "source", "session", "manual-wrap"));
  const l = fixChangeList(changes, () => null, 40);
  assert.equal(l.groups.length, 40);
  assert.deepEqual([l.files, l.more, l.moreFiles], [50, 10, 10]);
  assert.equal(fixMoreText(l), "and 10 more changes in 10 files not shown");
  const one = fixChangeList([CH(P("user", "a"), "type", null, "memory"), CH(P("user", "a"), "tags", null, "[memory/user, status/active]")], () => null, 1);
  assert.deepEqual([one.more, one.moreFiles], [1, 0]);
  assert.equal(fixMoreText(one), "and 1 more change");
  assert.equal(fixMoreText({ more: 0, moreFiles: 0 }), "");
  const long = fixChangeList([CH(P("user", "a"), "description", null, `x${" word".repeat(80)}`)], () => null);
  assert.ok(long.groups[0].lines[0].after!.length <= 200);
  assert.ok(long.groups[0].lines[0].after!.endsWith("…"));
});

const R = (kind: FixResult["kind"], changes: FixChange[], o: Partial<FixResult> = {}): FixResult => ({ kind, dryRun: true, changes, files: changedFiles(changes).length, brainMd: null, ...o });

test("fixDialog: the question, what it changes, its button, and that there is no undo", () => {
  const src = fixDialog("sources", R("sources", [CH(P("user", "a"), "source", "session", "manual-wrap"), CH(P("user", "b"), "source", "wrap", "manual-wrap")]));
  assert.equal(src.title, "Normalise source labels?");
  assert.equal(src.lede, "Sets source: manual-wrap on 2 memories that carry an old label. Only that line changes.");
  assert.equal(src.confirm, "Normalise 2");
  assert.match(src.note, /^There is no undo: each change goes into the trail with its before and after\.$/);
  const ty = fixDialog("types", R("types", [CH(P("user", "a"), "type", "user", "memory"), CH(P("user", "a"), "tags", null, "[memory/user, status/active]")]));
  assert.deepEqual([ty.confirm, ty.lede], ["Fix 1", "Sets type: memory, and the tags it needs, on 1 memory. Their name, description and body stay."]);
  assert.match(ty.note, /BRAIN\.md is rebuilt after\.$/);
  assert.equal(fixDialog("descriptions", R("descriptions", [CH(P("user", "a"), "description", null, "x")])).lede, "Gives 1 memory the description its MEMORY.md line already has.");
  const ix = fixDialog("index", R("index", [CH(P("user", "a"), "index-add", null, "l"), CH(P("user", "b"), "index-add", null, "l"), CH(P("user", "c"), "index-move", "## A", "## B"), CH("MEMORY.md", "index-remove", "l", null)]));
  assert.equal(ix.lede, "In MEMORY.md, adds 2 missing lines, moves 1 line under its own heading and removes 1 line to a missing file. The text of each line stays.");
  assert.equal(ix.confirm, "Fix MEMORY.md");
  assert.equal(fixDialog("index", R("index", [CH(P("user", "a"), "index-add", null, "l")])).lede, "In MEMORY.md, adds 1 missing line. The text of each line stays.");
  const dr = fixDialog("drafts", R("drafts", [CH("brain/memory/feedback/_drafts/a.md", "draft-remove", "A", null)]));
  assert.deepEqual([dr.title, dr.confirm, dr.lede], ["Remove the leftover drafts?", "Remove 1", "Removes 1 draft file whose rule is already a live feedback memory."]);
  for (const k of FIX_KINDS) assert.doesNotMatch(fixDialog(k, R(k, [])).note, /undoable|can be undone/i);
});

test("fixDoneText names the files changed (three, then and N more) and a BRAIN.md rebuild that failed", () => {
  const four = [CH(P("user", "a"), "source", "wrap", "manual-wrap"), CH(P("user", "b"), "source", "wrap", "manual-wrap"), CH(P("feedback", "c"), "source", "wrap", "manual-wrap"), CH(P("feedback", "d"), "source", "wrap", "manual-wrap")];
  assert.equal(fixDoneText("sources", R("sources", four, { dryRun: false })), "Normalise source labels: changed 4 files (user/a.md, user/b.md, feedback/c.md and 1 more).");
  assert.equal(fixDoneText("sources", R("sources", four.slice(0, 2), { dryRun: false })), "Normalise source labels: changed 2 files (user/a.md and user/b.md).");
  const ix = R("index", [CH(P("user", "a"), "index-add", null, "l"), CH(P("user", "b"), "index-move", "## A", "## B")], { dryRun: false, brainMd: { ok: false, error: "lock held" } });
  assert.equal(fixDoneText("index", ix), "Fix MEMORY.md: changed 1 file (MEMORY.md). BRAIN.md was not rebuilt (lock held): run aos build-brain-md.");
  assert.equal(fixDoneText("index", { ...ix, brainMd: { ok: true } }), "Fix MEMORY.md: changed 1 file (MEMORY.md).");
  assert.equal(fixDoneText("drafts", R("drafts", [CH("brain/memory/feedback/_drafts/rule.md", "draft-remove", "Rule", null)], { dryRun: false })), "Remove leftover drafts: changed 1 file (_drafts/rule.md).");
  assert.equal(fixDoneText("types", R("types", [], { dryRun: false })), "Fix old types: nothing left to fix.");
  assert.equal(fixDoneText("types", null), "Fix old types: done.");
  assert.equal(fixBehindText("descriptions"), "Copy descriptions: nothing to fix. brain-hub.json was behind the files; rescanning in the background.");
  assert.equal(shortFile("MEMORY.md"), "MEMORY.md");
  assert.equal(Object.keys(FIX_LABEL).length, FIX_KINDS.length);
});

test("a fix result parsed by parseFixResult flows into the change list and the Notice", () => {
  const r = parseFixResult({ kind: "descriptions", dryRun: true, files: 1, brainMd: null, changes: [{ path: P("projects", "x"), action: "description", before: null, after: "The x project" }, { path: P("projects", "x"), action: "bogus" }] })!;
  const l = fixChangeList(r.changes, () => "X");
  assert.deepEqual(l.groups, [{ file: P("projects", "x"), title: "X", lines: [{ action: "description", label: "description", subject: null, before: null, after: "The x project" }] }]);
  assert.equal(fixDialog("descriptions", r).confirm, "Copy 1");
});
