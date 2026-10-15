import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBrainHub, parseMemory, sweepScopeKey, SWEEP_MAX_PATHS,
  type BrainMap, type BrainMemory, type SweepCard, type SweepEstimate, type SweepFile, type SweepRun,
} from "./brainModel";
import {
  archiveAsk, consolidateAsk, currentCards, groupScopes, retitleAsk, runDay, scopeName, scopePaths, scopeSummary, sweepCardView,
  sweepDoneText, sweepEstimateLine, sweepGroups, sweepLine, sweepOffText, sweepState, sweepSummary, sweepViews, type SweepInput,
} from "./brainSweep";
/** A local-time instant: day math here is local, so a fixture in UTC would move days in UTC−11 and UTC+14 (CI tz-env). */
const L = (mo: number, d: number, h: number, mi = 0): string => new Date(2026, mo - 1, d, h, mi).toISOString();

const P = (t: string, s: string): string => `brain/memory/${t}/${s}.md`;
const A = P("feedback", "small-diffs"), B = P("feedback", "small-diffs-in-review"), C = P("projects", "tide-api"), D = P("projects", "tide-api-notes");
const E = P("projects", "release-1-4"), F = P("projects", "release-1-5");

const text = (title: string, status = "active", extra = ""): string =>
  ["---", "type: memory", `tags: [memory/projects, status/${status}]`, "created: 2026-10-01", ...(extra ? [extra] : []), "---", "", `# ${title}`, "", "Body.", ""].join("\n");
const mem = (p: string, title: string, status = "active"): BrainMemory => parseMemory(p, text(title, status))!;

const NOW = new Date(2026, 9, 12, 15);
const memories = [mem(A, "Prefer small diffs"), mem(B, "Prefer small diffs in review"), mem(C, "Tide API"), mem(D, "Tide API notes"), mem(E, "Release 1.4"), mem(F, "Release 1.5")];
const byPath = new Map(memories.map((m) => [m.path, m]));
const hashOf = (p: string): string => byPath.get(p)!.hash;

const card = (o: Partial<SweepCard> & Pick<SweepCard, "id" | "kind" | "paths">): SweepCard => ({
  run: "r1", hashes: o.paths.map(hashOf), title: "", description: "", why: "", scope: null, state: "open", ...o,
});
const run = (o: Partial<SweepRun> & Pick<SweepRun, "id" | "at">): SweepRun => ({
  scope: null, provider: "claude", model: "haiku", usd: 0.04, estimated: false, considered: 6, of: 6, suggestions: 2, chunks: null, failedChunks: 0, ...o,
});

test("a card's state: the files win (brain-ai A10)", () => {
  const merge = card({ id: "000000000001", kind: "merge", paths: [A, B], title: "Small diffs" });
  assert.equal(sweepState(merge, byPath), "open");
  assert.equal(sweepState({ ...merge, state: "dismissed" }, byPath), "dismissed", "dismissed is for good");
  const retired = new Map(byPath);
  retired.set(B, mem(B, "Prefer small diffs in review", "superseded"));
  assert.equal(sweepState(merge, retired), "done", "a path superseded: the merge happened");
  const gone = new Map(byPath);
  gone.delete(A);
  assert.equal(sweepState(merge, gone), "done", "a path gone");
  assert.equal(sweepState({ ...merge, hashes: [hashOf(A), "f".repeat(64)] }, byPath), "stale", "a hash differs");
  assert.equal(sweepState({ ...merge, hashes: ["", ""] }, byPath), "open", "no hash recorded: never stale");
  assert.equal(sweepState({ ...merge, state: "dismissed" }, retired), "dismissed", "dismissed wins over done");
});

test("a retitle is done once its title is the memory's, even though the hash moved", () => {
  const r = card({ id: "000000000002", kind: "retitle", paths: [C], title: "Tide API client" });
  assert.equal(sweepState(r, byPath), "open");
  const now = new Map(byPath);
  now.set(C, mem(C, "Tide API client"));
  assert.equal(sweepState(r, now), "done");
  now.set(C, mem(C, "Tide API (old)"));
  assert.equal(sweepState(r, now), "stale", "changed to something else");
});

test("a card's words: kind, what it does, the titles, the state's word", () => {
  const m = sweepCardView(card({ id: "000000000003", kind: "merge", paths: [A, B], title: "Small diffs", why: "the same rule  twice" }), byPath)!;
  assert.equal(m.word, "Merge");
  assert.equal(m.what, "2 into “Small diffs”");
  assert.deepEqual(m.titles.map((t) => t.title), ["Prefer small diffs", "Prefer small diffs in review"]);
  assert.equal(m.why, "the same rule twice");
  assert.equal(m.note, "");
  assert.equal(m.label, "Review: Merge 2 into “Small diffs”");
  const a = sweepCardView(card({ id: "000000000004", kind: "archive", paths: [E] }), byPath)!;
  assert.equal(a.what, "1 memory");
  const r = sweepCardView(card({ id: "000000000005", kind: "retitle", paths: [C], title: "Tide API client" }), byPath)!;
  assert.equal(r.what, "“Tide API” to “Tide API client”");
  const s = sweepCardView(card({ id: "000000000006", kind: "archive", paths: [E, F], hashes: ["0".repeat(64), hashOf(F)] }), byPath)!;
  assert.deepEqual([s.state, s.note, s.what], ["stale", "changed since the sweep", "2 memories"]);
  assert.equal(sweepCardView(card({ id: "000000000007", kind: "merge", paths: [A, B], state: "dismissed" }), byPath), null);
});

test("sweepViews lists open cards, then stale ones; done and dismissed are left out", () => {
  const cs = [
    card({ id: "00000000000a", kind: "archive", paths: [E], hashes: ["0".repeat(64)] }),
    card({ id: "00000000000b", kind: "merge", paths: [A, B] }),
    card({ id: "00000000000c", kind: "retitle", paths: [C], title: "Tide API" }),
    card({ id: "00000000000d", kind: "archive", paths: [F], state: "dismissed" }),
  ];
  assert.deepEqual(sweepViews(cs, byPath).map((v) => [v.id, v.state]), [["00000000000b", "open"], ["00000000000a", "stale"]]);
});

test("the sweep's line: last run, suggestions, open; stale, capped and scoped runs say so", () => {
  assert.equal(sweepLine(null, [], NOW), "No sweep yet");
  const r = run({ id: "r1", at: new Date(2026, 9, 12, 9).toISOString(), suggestions: 6 });
  assert.equal(sweepLine(r, [{ state: "open" }, { state: "open" }, { state: "open" }], NOW), "last run today · 6 suggestions · 3 open");
  const older = run({ id: "r0", at: L(10, 9, 10), suggestions: 1, considered: 340, of: 350 });
  assert.equal(sweepLine(older, [{ state: "stale" }], NOW, "Tide API"), "last run Oct 9 on “Tide API” · 1 suggestion · 0 open · 1 changed since · 340 of 350 memories looked at");
  assert.equal(runDay("nope", NOW), "");
});

test("scopePaths: the lead first, then most linked, at most 50, saying how many were left out", () => {
  const deg: Record<string, number> = { [A]: 1, [B]: 5, [C]: 3 };
  assert.deepEqual(scopePaths(C, [A, B, C], (p) => deg[p] ?? 0), { paths: [C, B, A], of: 3, cut: 0 });
  assert.deepEqual(scopePaths(null, [A, B], () => 0), { paths: [A, B], of: 2, cut: 0 }, "ties keep the order given");
  assert.deepEqual(scopePaths(D, [A, B], () => 0).paths, [A, B], "a lead not among the paths is not added");
  const many = Array.from({ length: 60 }, (_, i) => P("projects", `p${String(i).padStart(2, "0")}`));
  const s = scopePaths(many[59], many, (p) => Number(/p(\d+)\.md$/.exec(p)![1]));
  assert.equal(s.paths.length, SWEEP_MAX_PATHS);
  assert.equal(s.paths[0], many[59]);
  assert.equal(s.paths[1], many[58], "then the most linked");
  assert.deepEqual([s.of, s.cut], [60, 10]);
});

const MAP: BrainMap = {
  schema: 1, builtAt: "2026-10-12T08:00:00Z", state: "ok", mapMin: 2, graph: null,
  communities: [{ id: "c1", name: "Releases (old name)", lead: E, paths: [E, F], edges: 1 }],
  links: [], memories: {},
} as unknown as BrainMap;
const HUB = parseBrainHub(JSON.stringify({ schema: 1, builtAt: "2026-10-12T08:00:00Z", clusters: [{ paths: [C, D], label: "tide api" }] }));

test("a scope's name: its cluster, else the community it leads, else the lead and how many more", () => {
  const d = { byPath, hub: HUB, map: MAP };
  assert.equal(scopeName([], d), "Whole brain");
  assert.equal(scopeName([D, C], d), "tide api", "the same memories, any order");
  assert.equal(scopeName([E, F], d), "Release 1.4", "the community's lead's title as the file says now");
  assert.equal(scopeName([A, B], d), "Prefer small diffs and 1 more");
  assert.equal(scopeName([A], d), "Prefer small diffs");
});

test("groupScopes: the key of the paths sent now, and earlier runs on the same lead", () => {
  const file: SweepFile = {
    runs: [run({ id: "r2", at: L(10, 12, 10), scope: { paths: [E, F, A] } }), run({ id: "r1", at: L(10, 11, 10), scope: { paths: [C, D] } }), run({ id: "r0", at: L(10, 10, 10) })],
    suggestions: [],
  };
  const keys = groupScopes(file, [E, F]);
  assert.deepEqual([...keys].sort(), [sweepScopeKey([E, F])!, sweepScopeKey([E, F, A])!].sort());
  assert.deepEqual([...groupScopes(null, [C, D])], [sweepScopeKey([C, D])]);
});

test("a group re-run after its members changed replaces the earlier run's open cards on the same lead (A10)", () => {
  // Swept on [C, D, E] (lead C): "archive E". D was merged away since, so the group now sends [C, E] (another key); the
  // runtime keeps the first run's card under its own key, and the newer run on the same lead suggests nothing.
  const k1 = sweepScopeKey([C, D, E])!, k2 = sweepScopeKey([C, E])!;
  const first = run({ id: "r1", at: L(10, 12, 9), scope: { paths: [C, D, E] }, suggestions: 1 });
  const stale = card({ id: "0000000000c1", kind: "archive", paths: [E], scope: k1, run: "r1" });
  const whole = card({ id: "0000000000c2", kind: "merge", paths: [A, B], run: "r0" });
  const other = card({ id: "0000000000c3", kind: "archive", paths: [F], scope: sweepScopeKey([E, F]), run: "r9" });
  const before: SweepFile = { runs: [first, run({ id: "r0", at: L(10, 12, 8) })], suggestions: [stale, whole] };
  assert.deepEqual(currentCards(before).map((c) => c.id), ["0000000000c1", "0000000000c2"], "the newest run on C: its card is listed");
  assert.deepEqual(scopeSummary(input(before), groupScopes(before, [C, E])).views.map((v) => v.id), ["0000000000c1"], "the group's panel shows the earlier run's card");

  const again = run({ id: "r2", at: L(10, 12, 10), scope: { paths: [C, E] }, suggestions: 0 });
  const after: SweepFile = { runs: [again, ...before.runs], suggestions: [stale, whole, other, { ...stale, id: "0000000000c4", state: "dismissed" }] };
  assert.deepEqual(currentCards(after).map((c) => c.id), ["0000000000c2", "0000000000c3", "0000000000c4"], "replaced by r2; the whole brain's, a run the file no longer lists and a dismissed one stay");
  const t = scopeSummary(input(after), groupScopes(after, [C, E]));
  assert.deepEqual([t.line, t.views.length], ["last run today · 0 suggestions · 0 open", 0], "the re-run's line, and no stale card under it");
  assert.equal(sweepSummary(input(after)).views.some((v) => v.id === "0000000000c1"), false, "nor in Health's sweep card");
  assert.equal(sweepGroups(input(after)).flatMap((g) => g.cards).some((v) => v.id === "0000000000c1"), false);
  assert.deepEqual(currentCards(null), []);
});

function input(file: SweepFile): SweepInput {
  return { now: NOW, byPath, hub: HUB, map: MAP, sweep: file };
}

test("Health's groups: the whole brain first, then each scope named, newest run first; claimed scopes left out", () => {
  const kTide = sweepScopeKey([C, D])!, kRel = sweepScopeKey([E, F])!;
  const file: SweepFile = {
    runs: [run({ id: "r3", at: L(10, 12, 11), scope: { paths: [E, F] } }), run({ id: "r2", at: L(10, 12, 10), scope: { paths: [C, D] } }), run({ id: "r1", at: L(10, 12, 9) })],
    suggestions: [
      card({ id: "0000000000a1", kind: "retitle", paths: [C], title: "Tide API client", scope: kTide, run: "r2" }),
      card({ id: "0000000000a2", kind: "merge", paths: [A, B], title: "Small diffs", run: "r1" }),
      card({ id: "0000000000a3", kind: "archive", paths: [F], scope: kRel, run: "r3" }),
      card({ id: "0000000000a4", kind: "archive", paths: [E], scope: "abcdefabcdef", run: "gone" }),
    ],
  };
  const g = sweepGroups(input(file));
  assert.deepEqual(g.map((x) => [x.scope, x.name, x.cards.map((c) => c.id)]), [
    [null, "Whole brain", ["0000000000a2"]],
    [kRel, "Release 1.4", ["0000000000a3"]],
    [kTide, "tide api", ["0000000000a1"]],
    ["abcdefabcdef", "An earlier scoped sweep", ["0000000000a4"]],
  ]);
  assert.deepEqual(sweepGroups(input(file), new Set([kTide])).map((x) => x.scope), [null, kRel, "abcdefabcdef"]);
  assert.deepEqual(sweepGroups({ ...input(file), sweep: null }), []);
  const s = sweepSummary(input(file));
  assert.equal(s.line, "last run today on “Release 1.4” · 2 suggestions · 4 open");
  const t = scopeSummary(input(file), groupScopes(file, [C, D]));
  assert.deepEqual([t.line, t.views.map((v) => v.id)], ["last run today · 2 suggestions · 1 open", ["0000000000a1"]]);
  assert.equal(scopeSummary(input(file), new Set()).line, "No sweep yet");
  assert.equal(sweepSummary({ ...input(file), sweep: null }).line, "No sweep yet");
});

const est = (o: Partial<SweepEstimate["estimate"]> = {}, considered = 6, of = 6, chunks: number | null = null): SweepEstimate => ({
  scope: null, considered, of, chunks,
  estimate: { available: true, reason: null, provider: "claude", model: "haiku", tokensIn: 9000, tokensOut: 1500, usd: 0.06, cap: { family: "reasoner", perDayUsd: 5, spentToday: 0.12, perCallUsd: 0.5 }, once: [], ...o },
});

test("the estimate line, and the sweep off with its reason and what still works (A4, A5, A7)", () => {
  assert.deepEqual(sweepEstimateLine(est()), { off: false, text: "about $0.06 · haiku · Claude · today $0.12 of $5.00" });
  assert.equal(sweepEstimateLine(est({}, 340, 350)).text, "about $0.06 · haiku · Claude · today $0.12 of $5.00 · looks at 340 of 350 memories");
  const off = sweepEstimateLine(est({ available: false, reason: "claude-not-logged-in", provider: "none", cap: null }));
  assert.deepEqual(off, { off: true, text: "Claude Code is not signed in. Merge with AI still works by hand." });
  assert.equal(sweepOffText({ reason: "ollama-only", cap: null }), "The sweep needs Claude or Codex; a local model cannot hold the whole brain. Merge with AI still works, on Ollama.");
  // The reasoner's cap stops the sweep, not Merge: it drafts on the hook chain, under the hook's own cap (A7).
  assert.equal(sweepOffText({ reason: "reasoner-daily-cap", cap: { family: "reasoner", perDayUsd: 5, spentToday: 5, perCallUsd: 0.5 } }), "Today's model cap is reached ($5.00, reasoner.perDayUsd). Merge with AI still works.");
  // The hook's own cap, no provider: the merge's chain is down too, so it is finished by hand (A4).
  assert.equal(sweepOffText({ reason: "daily-cap", cap: { family: "hook", perDayUsd: 0.5, spentToday: 0.5, perCallUsd: 0.05 } }), "Today's model cap is reached ($0.50, claude.perDayUsd). Merge with AI still works by hand.");
  assert.equal(sweepOffText({ reason: "no-provider", cap: null }), "No model provider is set up. Merge with AI still works by hand.");
});

test("Consolidate with AI…'s question names the group, the cost and the members left out", () => {
  const q = consolidateAsk("Releases", est(), { paths: [E, F], of: 2, cut: 0 });
  assert.equal(q.title, "Consolidate “Releases” with AI?");
  assert.equal(q.message, "A model reads these 2 memories and suggests merges, archives and retitles; nothing changes until you apply one. Cost: about $0.06 · haiku · Claude, today $0.12 of $5.00.");
  assert.equal(q.confirm, "Run the sweep");
  const many = Array.from({ length: 50 }, (_, i) => P("projects", `p${i}`));
  assert.match(consolidateAsk("Big", est({ cap: null }), { paths: many, of: 61, cut: 11 }).message, /reads these 50 memories .* It looks at the 50 most linked of the 61\. Cost: about \$0\.06 · haiku · Claude\.$/);
  assert.match(consolidateAsk("Big", est({}, 40, 50), { paths: many, of: 50, cut: 0 }).message, /^A model reads 40 of these 50 memories/);
});

test("the Notice after a sweep", () => {
  const r = { run: run({ id: "r1", at: "x", provider: "codex", model: "gpt-5-codex", usd: 0.03, estimated: true, considered: 340, of: 350 }), suggestions: [card({ id: "0000000000b1", kind: "archive", paths: [E] })] };
  assert.equal(sweepDoneText(r), "Sweep: 1 suggestion · swept by gpt-5-codex · Codex · $0.03 (estimated) · 340 of 350 memories looked at");
  assert.equal(sweepDoneText({ ...r, suggestions: [], run: { ...r.run, considered: 6, of: 6, provider: "claude", model: "haiku", estimated: false } }, "Releases"), "Sweep of “Releases”: nothing to suggest · swept by haiku · Claude · $0.03");
  assert.equal(sweepDoneText(null), "Sweep: done");
});

test("Archive and Retitle ask first, naming what changes and the way back", () => {
  const a = archiveAsk({ titles: [{ path: E, title: "Release 1.4" }, { path: F, title: "Release 1.5" }, { path: C, title: "Tide API" }], why: "shipped" });
  assert.equal(a.title, "Archive 3 memories?");
  assert.equal(a.message, "Archives “Release 1.4”, “Release 1.5” and “Tide API”. They leave recall, the MOCs and BRAIN.md. Nothing is deleted: Restore in Library puts each one back. The sweep's reason: shipped");
  assert.equal(a.confirm, "Archive 3");
  const one = archiveAsk({ titles: [{ path: E, title: "Release 1.4" }], why: "" });
  assert.deepEqual([one.title, one.confirm], ["Archive 1 memory?", "Archive"]);
  assert.match(one.message, /It leaves recall.*puts it back\.$/);
  const r = retitleAsk("Tide API", { title: "Tide API client", description: "How the client calls it", why: "vague" });
  assert.equal(r.title, "Retitle 'Tide API' to 'Tide API client'?");
  assert.equal(r.message, "The heading and its MEMORY.md line change; the file name stays, so links keep working. The description becomes “How the client calls it”. The sweep's reason: vague");
  assert.equal(r.confirm, "Retitle");
});
