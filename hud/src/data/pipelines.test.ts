import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPipeline, pipelineStatuses, PIPELINES_MANIFEST, PipelinesFile, PipelineState } from "./pipelines";

const NOW = Date.parse("2026-08-05T16:00:00Z");
const mk = (over: object): PipelineState => ({
  lastRun: { startedAt: "2026-08-05T15:59:00Z", endedAt: "2026-08-05T15:59:05Z",
    durationMs: 5000, status: "ok", error: null, wrote: [], counts: {}, pid: 1, ...over },
  history: [],
});

test("fresh ok run classifies ok", () => {
  const s = classifyPipeline("scan-vault", mk({}), NOW);
  assert.equal(s.health, "ok");
});

test("old ok run classifies stale once past its freshness window", () => {
  const s = classifyPipeline("scan-vault",
    mk({ startedAt: "2026-08-05T14:00:00Z", endedAt: "2026-08-05T14:00:05Z" }), NOW);
  assert.equal(s.health, "stale"); // scan-vault window = 45 min
});

test("error run classifies failed and carries the error text", () => {
  const s = classifyPipeline("auto-cost", mk({ status: "error", error: "boom" }), NOW);
  assert.equal(s.health, "failed");
  assert.match(s.detail, /boom/);
});

test("running run older than diedAfterMs classifies died", () => {
  const s = classifyPipeline("scan-vault",
    mk({ status: "running", endedAt: null, startedAt: "2026-08-05T15:30:00Z" }), NOW);
  assert.equal(s.health, "died"); // 30 min > 10 min diedAfter
});

test("running run within diedAfterMs stays ok (in-flight)", () => {
  const s = classifyPipeline("scan-vault",
    mk({ status: "running", endedAt: null, startedAt: "2026-08-05T15:58:30Z" }), NOW);
  assert.equal(s.health, "ok");
  assert.match(s.label, /running/i);
});

test("missing pipeline classifies neutral (never ran)", () => {
  const s = classifyPipeline("session-summary", undefined, NOW);
  assert.equal(s.health, "neutral");
  assert.match(s.detail, /no recorded runs yet/);
});

test("pipelineStatuses covers every manifest pipeline even on a null file", () => {
  const all = pipelineStatuses(null, NOW);
  assert.deepEqual(all.map((s) => s.name), Object.keys(PIPELINES_MANIFEST));
  assert.ok(all.every((s) => s.health === "neutral"));
  const file: PipelinesFile = { version: 1, pipelines: { "scan-vault": mk({}) } };
  const withOne = pipelineStatuses(file, NOW);
  assert.equal(withOne.find((s) => s.name === "scan-vault")?.health, "ok");
});

test("file-map is an expected pipeline", () => {
  const all = pipelineStatuses(null, NOW);
  assert.ok(all.some((s) => s.name === "file-map" && s.health === "neutral"));
});

// Regression: file-map is on-demand (brain/scripts/map-workspace.js) and has
// nothing to do while 0 files are pending, so it used to sit permanently
// "stale 9d" with no action that could clear it. Age must carry no signal here.
test("file-map never classifies stale by age, however old its last ok run", () => {
  const ancient = classifyPipeline("file-map",
    mk({ startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:05:00Z" }), NOW);
  assert.equal(ancient.health, "ok");
  assert.doesNotMatch(ancient.detail, /freshness window/);
});

// ...but a genuinely broken on-demand run must still surface.
test("file-map still classifies failed and died", () => {
  assert.equal(classifyPipeline("file-map",
    mk({ status: "error", error: "ollama refused" }), NOW).health, "failed");
  assert.equal(classifyPipeline("file-map",
    mk({ status: "running", endedAt: null, startedAt: "2026-08-05T15:30:00Z" }), NOW).health, "died");
});

test("an explicit null staleAfterMs disables age-based staleness", () => {
  const s = classifyPipeline("scan-vault",
    mk({ startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:00:05Z" }), NOW,
    { staleAfterMs: null });
  assert.equal(s.health, "ok");
});

test("auto-wrap and build-brain-md are expected pipelines that classify never on a null file", () => {
  const all = pipelineStatuses(null, NOW);
  assert.ok(all.some((s) => s.name === "auto-wrap" && s.health === "neutral"));
  assert.ok(all.some((s) => s.name === "build-brain-md" && s.health === "neutral"));
});

test("a disabled stage renders neutral with its reason and provider on hover, never red", () => {
  const s = classifyPipeline("auto-cost", mk({ status: "disabled", reason: "cost disabled", provider: "none" }), NOW);
  assert.equal(s.health, "neutral");
  assert.match(s.label, /COST off/);
  assert.match(s.detail, /cost disabled/);
  assert.match(s.detail, /provider none/);
});

test("a skipped stage is neutral with its reason, like disabled, and never goes stale (contract §5)", () => {
  const fresh = classifyPipeline("session-summary", mk({ status: "skipped", reason: "nothing to write" }), NOW);
  assert.equal(fresh.health, "neutral");
  assert.match(fresh.label, /WRAP skipped/);
  assert.match(fresh.detail, /nothing to write/);
  const old = classifyPipeline("session-summary",
    mk({ status: "skipped", startedAt: "2026-08-03T10:00:00Z", endedAt: "2026-08-03T10:00:01Z" }), NOW);
  assert.equal(old.health, "neutral", "a skip carries no verdict, so its age carries none either");
});

test("embed-vault is a manifest stage: EMBED chip, disabled under claude/none renders neutral", () => {
  const file: PipelinesFile = { version: 1, pipelines: { "embed-vault": mk({ status: "disabled", reason: "no-embed", provider: "claude" }) } };
  const s = pipelineStatuses(file, NOW).find((x) => x.name === "embed-vault");
  assert.equal(s?.health, "neutral");
  assert.match(s!.label, /^EMBED off/);
  assert.match(s!.detail, /no-embed/);
});

test("ledger keys outside the manifest are appended with an upper-cased short name", () => {
  const file: PipelinesFile = { version: 1, pipelines: { "feedback-apply": mk({}) } };
  const all = pipelineStatuses(file, NOW);
  const extra = all.find((s) => s.name === "feedback-apply");
  assert.equal(extra?.health, "ok");
  assert.match(extra!.label, /^FEEDBACK-APPLY/);
  assert.equal(all.length, Object.keys(PIPELINES_MANIFEST).length + 1);
});

test("the manifest carries every safe rerun the Fix Queue needs", () => {
  assert.deepEqual(PIPELINES_MANIFEST["scan-vault"].safeRerun, { script: "brain/scripts/scan-vault.js", args: ["--quiet"] });
  assert.deepEqual(PIPELINES_MANIFEST["auto-cost-backfill"].safeRerun, { script: "brain/scripts/auto-cost.js", args: ["--backfill"] });
  assert.equal(PIPELINES_MANIFEST["file-map"].staleMs, null);
  assert.equal(PIPELINES_MANIFEST["session-summary"].safeRerun, null);
  assert.equal(PIPELINES_MANIFEST["embed-vault"].short, "EMBED");
  assert.equal(PIPELINES_MANIFEST["embed-vault"].staleMs, null);
  // scan-vault.js is the only writer of the embed-vault ledger key (scan-vault.js:449
  // withReport('embed-vault')), so it is also the only rerun that can clear the card.
  assert.deepEqual(PIPELINES_MANIFEST["embed-vault"].safeRerun, { script: "brain/scripts/scan-vault.js", args: ["--quiet"] });
  assert.equal(PIPELINES_MANIFEST["graph-build"].short, "GRAPH");
  assert.equal(PIPELINES_MANIFEST["graph-build"].staleMs, null);
  assert.deepEqual(PIPELINES_MANIFEST["graph-build"].safeRerun, { script: "brain/scripts/graph-build.js", args: ["--quiet"] });
  assert.equal(PIPELINES_MANIFEST["graph-semantic"].short, "SEM");
  assert.equal(PIPELINES_MANIFEST["graph-semantic"].safeRerun, null, "a pass that spends money is never a one-click rerun");
});
