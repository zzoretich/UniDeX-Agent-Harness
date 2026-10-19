import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixQueue, FixQueueInputs } from "./fixQueue";
import { PipelineStatus } from "./pipelines";

const ok = (name: string): PipelineStatus =>
  ({ name, health: "ok", label: `${name} ok`, detail: "" });
const bad = (name: string, health: "failed" | "died" | "stale" | "neutral", detail = "boom"): PipelineStatus =>
  ({ name, health, label: `${name} ${health}`, detail });

const BASE: FixQueueInputs = {
  statuses: [ok("scan-vault"), ok("session-summary"), ok("auto-cost"), ok("heartbeat-writer")],
  costMonth: "2026-08", currentMonth: "2026-08", calibration: 0.3328,
  uncostedRuns: 0, healthErrors: 0, staleArtifacts: 0,
};

test("all-green inputs produce an empty queue", () => {
  assert.deepEqual(buildFixQueue(BASE), []);
});

test("stale or failed scan yields a run-scan spawn action", () => {
  const q = buildFixQueue({ ...BASE, statuses: [bad("scan-vault", "stale"), ...BASE.statuses.slice(1)] });
  const a = q.find((x) => x.id === "run-scan");
  assert.ok(a && a.kind === "spawn");
  assert.equal(a!.script, "brain/scripts/scan-vault.js");
  assert.deepEqual(a!.args, ["--quiet"]);
});

test("stale cost month or non-positive calibration yields the anchor modal", () => {
  const q1 = buildFixQueue({ ...BASE, costMonth: "2026-06" });
  assert.ok(q1.some((x) => x.kind === "anchor-modal"));
  const q2 = buildFixQueue({ ...BASE, calibration: -0.03 });
  assert.ok(q2.some((x) => x.kind === "anchor-modal" && /calibration/i.test(x.detail)));
});

test("uncosted runs yield a backfill spawn", () => {
  const q = buildFixQueue({ ...BASE, uncostedRuns: 3 });
  const a = q.find((x) => x.id === "cost-backfill");
  assert.equal(a?.kind, "spawn");
  assert.equal(a?.script, "brain/scripts/auto-cost.js");
  assert.deepEqual(a?.args, ["--backfill"]);
});

test("died pipeline yields an error-severity open-health action with its detail", () => {
  const q = buildFixQueue({ ...BASE, statuses: [bad("session-summary", "died", "started 30m ago"), ...BASE.statuses.filter(s => s.name !== "session-summary")] });
  const a = q.find((x) => x.id === "pipeline-session-summary");
  assert.equal(a?.severity, "error");
  assert.match(a!.detail, /30m/);
});

test("health errors yield open-health", () => {
  const q = buildFixQueue({ ...BASE, healthErrors: 2 });
  assert.ok(q.some((x) => x.id === "open-health" && x.kind === "open-file"));
});

test("stale artifacts yield a rebuild-brain-md spawn", () => {
  const q = buildFixQueue({ ...BASE, staleArtifacts: 2 });
  const a = q.find((x) => x.id === "rebuild-brain-md");
  assert.equal(a?.kind, "spawn");
  assert.equal(a?.script, "brain/scripts/build-brain-md.js");
  assert.deepEqual(a?.args, []);
  assert.equal(a?.severity, "warn");
});

test("zero stale artifacts yields no rebuild-brain-md card", () => {
  assert.ok(!buildFixQueue(BASE).some((x) => x.id === "rebuild-brain-md"));
});

test("queue is sorted errors first, then warns", () => {
  const q = buildFixQueue({ ...BASE, statuses: [bad("scan-vault", "stale"), bad("auto-cost", "failed"), ...BASE.statuses.slice(1, 3)], healthErrors: 1 });
  const sevs = q.map((x) => x.severity);
  assert.deepEqual([...sevs].sort((a, b) => (a === b ? 0 : a === "error" ? -1 : 1)), sevs);
});

test("failed auto-cost-backfill yields a rerun spawn (now in SAFE_RERUN)", () => {
  const q = buildFixQueue({ ...BASE, statuses: [...BASE.statuses, bad("auto-cost-backfill", "failed")] });
  const a = q.find((x) => x.id === "rerun-auto-cost-backfill");
  assert.equal(a?.kind, "spawn");
  assert.equal(a?.script, "brain/scripts/auto-cost.js");
  assert.deepEqual(a?.args, ["--backfill"]);
});

test("never-anchored cost state (no recorded month) yields an info anchor-first card", () => {
  // costMonth comes from cost-budget.json's config `month` — null when never anchored.
  // calibration stays a number (cost.ts defaults it), so the rule keys on costMonth ONLY.
  const q = buildFixQueue({ ...BASE, costMonth: null });
  const a = q.find((x) => x.id === "anchor-first");
  assert.equal(a?.severity, "info");
  assert.equal(a?.kind, "anchor-modal");
});

test("never-anchored cost state does not also fire re-anchor-cost even with a bad stored calibration", () => {
  // A stale/hand-edited cost-budget.json could have no month but a leftover bad calibration.
  // You cannot RE-anchor what was never anchored — anchor-first alone should surface.
  const q = buildFixQueue({ ...BASE, costMonth: null, calibration: -1 });
  const anchorCards = q.filter((x) => x.kind === "anchor-modal");
  assert.equal(anchorCards.length, 1);
  assert.equal(anchorCards[0].id, "anchor-first");
  assert.ok(!q.some((x) => x.id === "re-anchor-cost"));
});

test("pending map entries yield per-workspace map-now spawns", () => {
  const q = buildFixQueue({ ...BASE, mapPending: [{ workspace: "Example Workspace", pending: 12 }, { workspace: "_archive", pending: 0 }] });
  const a = q.find((x) => x.id === "map-Example Workspace");
  assert.equal(a?.kind, "spawn");
  assert.equal(a?.script, "brain/scripts/map-workspace.js");
  assert.deepEqual(a?.args, ["Example Workspace"]);
  assert.equal(a?.severity, "info");
  assert.ok(!q.some((x) => x.id === "map-_archive")); // zero pending = no card
});

test("absent mapPending input produces no map cards (backward compatible)", () => {
  assert.ok(!buildFixQueue(BASE).some((x) => x.id.startsWith("map-")));
});

test("neutral (never ran / disabled) pipelines produce no card", () => {
  const q = buildFixQueue({ ...BASE, statuses: [bad("auto-wrap", "neutral", "auto-wrap: disabled — no-provider"), ...BASE.statuses] });
  assert.ok(!q.some((x) => x.id.includes("auto-wrap")));
});

test("costEnabled=false suppresses every cost card but leaves the rest", () => {
  const q = buildFixQueue({ ...BASE, costEnabled: false, costMonth: null, uncostedRuns: 4, healthErrors: 1 });
  assert.ok(!q.some((x) => x.kind === "anchor-modal"));
  assert.ok(!q.some((x) => x.id === "cost-backfill"));
  assert.ok(q.some((x) => x.id === "open-health"));
  const stale = buildFixQueue({ ...BASE, costEnabled: false, costMonth: "2026-06" });
  assert.ok(!stale.some((x) => x.id === "re-anchor-cost"));
});
