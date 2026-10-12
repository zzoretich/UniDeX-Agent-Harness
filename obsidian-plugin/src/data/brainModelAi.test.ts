import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  memoryArgs, parseMergeEstimate, parseMergeDraft, parseSweepFile, parseSweepEstimate, parseSweepResult, parseAiEstimate,
  sweepScopeKey, usdText, estimateText, spendText, capText, aiReasonText, providerName, undoableMerge, touchesBrain, verbTouches,
  MEMORY_SWEEP_PATH, MERGE_MAX, SWEEP_MAX_PATHS, UNDO_DAYS,
} from "./brainModel";
import type { TrailEntry } from "./promoteTrail";

const P = (t: string, s: string): string => `brain/memory/${t}/${s}.md`;
const A = P("feedback", "small-diffs"), B = P("feedback", "small-diffs-in-review"), C = P("projects", "tide-api");
const H = (c: string): string => c.repeat(64);

test("memoryArgs: merge-draft, merge, unmerge, sweep, sweep dismiss (brain-ai A13)", () => {
  assert.deepEqual(memoryArgs({ verb: "merge-draft", paths: [A, B], estimate: true }), ["memory", "merge-draft", A, B, "--estimate", "--json"]);
  assert.deepEqual(memoryArgs({ verb: "merge-draft", paths: [A, B, C], estimate: false }), ["memory", "merge-draft", A, B, C, "--json"]);
  const into = { title: "Small diffs", description: "Keep diffs small", body: "Why: review.\n" };
  assert.deepEqual(memoryArgs({ verb: "merge", paths: [A, B], into, expect: [H("a"), H("b")] }),
    ["memory", "merge", A, B, "--into", JSON.stringify(into), "--expect", `${H("a")},${H("b")}`, "--json"]);
  assert.deepEqual(memoryArgs({ verb: "unmerge", path: A, expect: H("c") }), ["memory", "unmerge", A, "--expect", H("c"), "--json"]);
  assert.deepEqual(memoryArgs({ verb: "sweep", paths: [], estimate: true }), ["memory", "sweep", "--estimate", "--json"]);
  assert.deepEqual(memoryArgs({ verb: "sweep", paths: [C, A], estimate: false }), ["memory", "sweep", C, A, "--json"]);
  assert.deepEqual(memoryArgs({ verb: "sweep-dismiss", id: "0123456789ab" }), ["memory", "sweep", "dismiss", "0123456789ab", "--json"]);
  assert.deepEqual(memoryArgs({ verb: "set", path: A, fields: { title: "New title" }, expect: H("d") }),
    ["memory", "set", A, "--set", '{"title":"New title"}', "--expect", H("d"), "--json"]);
});

test("memoryArgs refuses what the runtime and the surface would", () => {
  const seven = Array.from({ length: MERGE_MAX + 1 }, (_, i) => P("projects", `p${i}`));
  assert.throws(() => memoryArgs({ verb: "merge-draft", paths: [A], estimate: false }), /2–6/);
  assert.throws(() => memoryArgs({ verb: "merge-draft", paths: seven, estimate: false }), /2–6/);
  assert.throws(() => memoryArgs({ verb: "merge-draft", paths: [A, A], estimate: false }), /different/);
  assert.throws(() => memoryArgs({ verb: "merge", paths: [A, B], into: { title: "t", description: "d", body: "b" }, expect: [H("a")] }), /hash/);
  assert.throws(() => memoryArgs({ verb: "merge", paths: [A, B], into: { title: "t", description: "d", body: "b" }, expect: [H("a"), "none"] }), /hash/);
  assert.throws(() => memoryArgs({ verb: "unmerge", path: A, expect: "none" }), /hash/);
  assert.throws(() => memoryArgs({ verb: "sweep", paths: Array.from({ length: SWEEP_MAX_PATHS + 1 }, (_, i) => P("projects", `p${i}`)), estimate: false }), /0–50/);
  assert.throws(() => memoryArgs({ verb: "sweep-dismiss", id: "--json" }), /not a suggestion id/);
  assert.throws(() => memoryArgs({ verb: "merge-draft", paths: [A, "--into"], estimate: false }), /not a memory path/);
});

const estimate = { available: true, reason: null, provider: "claude", model: "haiku", tokensIn: 1200, tokensOut: 600, usd: 0.0042, cap: { family: "hook", perDayUsd: 0.5, spentToday: 0.12, perCallUsd: 0.05 } };
const sources = [
  { path: A, title: "Prefer small diffs", type: "feedback", created: "2026-09-01", hash: H("a"), chars: 400, truncated: false },
  { path: B, title: "Prefer small diffs in review", type: "feedback", created: "2026-09-20", hash: H("b"), chars: 9000, truncated: true },
];

test("parseMergeEstimate and parseMergeDraft read the runtime's shapes; a wrong shape is null", () => {
  const e = parseMergeEstimate({ winner: A, type: "feedback", sources, baseHashes: [H("a"), H("b")], truncated: true, byHand: { title: "Prefer small diffs", description: "d", body: "b" }, estimate });
  assert.ok(e);
  assert.equal(e.winner, A);
  assert.equal(e.sources[1].truncated, true);
  assert.equal(e.estimate.available, true);
  assert.equal(e.estimate.cap?.perCallUsd, 0.05);
  assert.equal(parseMergeEstimate({ winner: A, sources, baseHashes: [H("a")], byHand: {}, estimate }), null, "a hash per source");
  assert.equal(parseMergeEstimate({ winner: "MEMORY.md", sources, baseHashes: [H("a"), H("b")], byHand: {}, estimate }), null);
  const d = parseMergeDraft({ winner: A, type: "feedback", sources, baseHashes: [H("a"), H("b")], mode: "ai", reason: null, provider: "codex", model: "gpt-5", usd: 0.01, estimated: true, cap: null, fields: { title: "T", description: "D", body: "B" }, generatedAt: "2026-10-12T10:00:00Z" });
  assert.ok(d);
  assert.equal(d.mode, "ai");
  assert.equal(d.provider, "codex");
  assert.equal(d.estimated, true);
  assert.equal(parseMergeDraft({ winner: A, sources, baseHashes: [H("a"), H("b")] }), null, "no fields");
  const off = parseAiEstimate({ available: true, provider: "none" });
  assert.equal(off.available, false, "none is never available");
  assert.equal(off.reason, "no-provider");
});

test("parseSweepFile keeps good cards, drops bad ones; results and estimates parse", () => {
  const card = { id: "0123456789ab", run: "r1", kind: "merge", paths: [A, B], hashes: [H("a"), H("b")], title: "Small diffs", description: "", why: "same rule", scope: null, state: "open" };
  const raw = JSON.stringify({
    schema: 1,
    runs: [{ id: "r1", at: "2026-10-12T10:00:00Z", scope: null, provider: "claude", model: "haiku", usd: 0.04, estimated: false, considered: 340, of: 350, suggestions: 1 }],
    suggestions: [card, { ...card, id: "zz" }, { ...card, id: "0123456789ac", kind: "rename" }, { ...card, id: "0123456789ad", paths: ["../x.md"] }],
  });
  const f = parseSweepFile(raw);
  assert.ok(f);
  assert.equal(f.runs.length, 1);
  assert.equal(f.suggestions.length, 1);
  assert.equal(f.suggestions[0].state, "open");
  assert.equal(parseSweepFile(JSON.stringify({ schema: 2 })), null);
  assert.equal(parseSweepFile("{"), null);
  assert.equal(parseSweepFile(null), null);
  const r = parseSweepResult({ run: { id: "r2", at: "x", scope: { paths: [C, A] }, provider: "codex", estimated: true, considered: 2, of: 2, suggestions: 1 }, suggestions: [card] });
  assert.deepEqual(r?.run.scope, { paths: [C, A] });
  const se = parseSweepEstimate({ scope: null, considered: 340, of: 350, estimate: { available: false, reason: "ollama-only", provider: "ollama" } });
  assert.equal(se?.estimate.available, false);
  assert.equal(se?.estimate.reason, "ollama-only");
});

test("sweepScopeKey matches lib/memory-sweep.js: sha256 of the sorted paths, 12 hex; null for the whole brain", () => {
  const want = createHash("sha256").update([C, A].sort().join("\n")).digest("hex").slice(0, 12);
  assert.equal(sweepScopeKey([C, A]), want);
  assert.equal(sweepScopeKey([A, C]), want);
  assert.equal(sweepScopeKey([]), null);
});

test("cost labels (brain-ai A5)", () => {
  assert.equal(usdText(0.0042), "$0.0042");
  assert.equal(usdText(0.06), "$0.06");
  assert.equal(usdText(0), "$0.00");
  assert.equal(estimateText(parseAiEstimate(estimate)), "about $0.0042 · haiku · Claude");
  assert.equal(estimateText(parseAiEstimate({ available: false, reason: "daily-cap", provider: "none", cap: { perDayUsd: 0.5 } })), "Today's model cap is reached ($0.50).");
  // With the cap's family the sentence names its key, word for word as the runtime's (lib/memory-ai.js reasonSentence).
  assert.equal(estimateText(parseAiEstimate({ available: false, reason: "daily-cap", provider: "none", cap: { family: "hook", perDayUsd: 0.5 } })), "Today's model cap is reached ($0.50, claude.perDayUsd).");
  assert.equal(estimateText(parseAiEstimate({ available: false, reason: "daily-cap", provider: "none", cap: { family: "codex", perDayUsd: 0.2 } })), "Today's model cap is reached ($0.20, codex.perDayUsd).");
  assert.equal(estimateText(parseAiEstimate({ available: false, reason: "reasoner-daily-cap", provider: "none", cap: { family: "reasoner-codex", perDayUsd: 5 } })), "Today's model cap is reached ($5.00, reasoner.perDayUsd).");
  assert.equal(capText({ family: "hook", perDayUsd: 0.5, spentToday: 0.12, perCallUsd: 0.05 }), "today $0.12 of $0.50");
  assert.equal(spendText({ provider: "codex", model: null, usd: 0.011, estimated: true, cap: null }), "drafted by Codex · Codex · $0.01 (estimated)");
  assert.equal(aiReasonText("forced"), "No model provider is set up.");
  assert.equal(aiReasonText("ollama-only"), "The sweep needs Claude or Codex; a local model cannot hold the whole brain.");
  assert.equal(providerName("ollama"), "Ollama");
});

test("undoableMerge: the newest merge, unchanged since, within UNDO_DAYS, not undone", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const row = (action: string, ts: string, extra: Record<string, unknown> = {}): TrailEntry => ({ ts, session: "", action, slug: "small-diffs", type: "feedback", title: "t", ...extra } as unknown as TrailEntry);
  const m = { type: "feedback", slug: "small-diffs", hash: H("e") } as const;
  const merged = row("merged", "2026-10-10T12:00:00Z", { record: "20261010-120000-abcd1234", hash: H("e"), from: [B] });
  assert.deepEqual(undoableMerge([merged], m, now)?.from, [B]);
  assert.equal(undoableMerge([merged], { ...m, hash: H("f") }, now), null, "edited since the merge");
  assert.equal(undoableMerge([merged, row("unmerged", "2026-10-11T12:00:00Z")], m, now), null, "already undone");
  const old = new Date(now.getTime() + UNDO_DAYS * 86_400_000);
  assert.equal(undoableMerge([merged], m, old), null, "older than the records are kept");
  assert.equal(undoableMerge([row("merged", "2026-10-10T12:00:00Z", { hash: H("e") })], m, now), null, "no record");
});

test("the sweep file is followed by vault events", () => {
  assert.equal(touchesBrain(MEMORY_SWEEP_PATH), true);
});

test("the files a verb changed: merge its paths, unmerge the merged memory and every one it restored", () => {
  const always = ["MEMORY.md", "brain/_index/promote-log.jsonl"];
  const into = { title: "Small diffs", description: "Keep diffs small", body: "Why." };
  assert.deepEqual(verbTouches({ verb: "merge", paths: [A, B], into, expect: [H("a"), H("b")] }), [...always, A, B]);
  const undo = { verb: "unmerge" as const, path: A, expect: H("e") };
  // The runtime rewrote the losers' files too: the load right after re-reads them, without waiting for vault events.
  assert.deepEqual(verbTouches(undo, { path: A, restored: [B, C], record: "r", hash: H("a"), brainMd: null }), [...always, A, B, C]);
  assert.deepEqual(verbTouches(undo, { restored: [B, "../../etc/passwd", 7, A] }), [...always, A, B], "only memory paths, once");
  assert.deepEqual(verbTouches(undo), [...always, A], "refused: nothing was restored");
  assert.deepEqual(verbTouches({ verb: "sweep", paths: [], estimate: false }), [], "a sweep writes no memory");
  assert.deepEqual(verbTouches({ verb: "sweep-dismiss", id: "0123456789ab" }), []);
});
