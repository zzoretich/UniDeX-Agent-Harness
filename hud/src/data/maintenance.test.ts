import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepLine } from "./maintenance";

const skipped = { nonEmpty: 0, hasJsonl: 3, tooYoung: 0, error: 0 };

test("sweepLine: nothing when the sweep is absent or disabled", () => {
  assert.equal(sweepLine(undefined), null);
  assert.equal(sweepLine({}), null);
  assert.equal(sweepLine({ orphanSweep: { enabled: false, swept: {}, skipped } }), null);
});

test("sweepLine: a fail-closed sweep (projects/ unreadable) is amber with its reason", () => {
  const m = { orphanSweep: { enabled: true, reason: "projects-unreadable:EACCES", swept: {}, skipped: { ...skipped, error: 1 } } };
  assert.deepEqual(sweepLine(m), { tone: "amber", text: "orphan sweep skipped: projects-unreadable:EACCES" });
});

test("sweepLine: counts removed dirs across both trees and both rules; silent when nothing was removed", () => {
  const removed = { orphanSweep: { enabled: true, swept: { sessionEnv: ["a"], fileHistory: [] }, transientSwept: { sessionEnv: ["b", "c"] }, skipped } };
  assert.deepEqual(sweepLine(removed), { tone: "dim", text: "orphan sweep: 3 removed" });
  assert.equal(sweepLine({ orphanSweep: { enabled: true, swept: { sessionEnv: [], fileHistory: [] }, skipped } }), null);
});
