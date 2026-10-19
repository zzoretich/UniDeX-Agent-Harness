import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { applyCosts, sessionOf, touchesRuns, RUNS_PATH, COSTS_PATH } from "./runs";
import type { AgentRun, CostRecord } from "./runs";

// The runtime's cases: brain/scripts/lib/runs-log.js applyCosts must agree on every one (spec 2026-09-24-append-only-runs D3).
const FIXTURE = path.join(__dirname, "..", "..", "..", "brain", "scripts", "test", "fixtures", "apply-costs.json");
const { cases } = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as {
  cases: { name: string; runs: AgentRun[]; costs: CostRecord[]; expect: Record<string, unknown>[] }[];
};

for (const c of cases) {
  test(`applyCosts (same cases as the runtime): ${c.name}`, () => {
    const out = applyCosts(c.runs, c.costs);
    assert.equal(out.length, c.expect.length);
    c.expect.forEach((want, i) => {
      for (const [k, v] of Object.entries(want)) {
        assert.deepEqual((out[i] as unknown as Record<string, unknown>)[k], v, `${c.name} · row ${i} · ${k}`);
      }
    });
  });
}

test("sessionOf reads session_id, else a session run id without its segment suffix", () => {
  assert.equal(sessionOf({ session_id: "abc" }), "abc");
  assert.equal(sessionOf({ id: "sess-abc-s2" }), "abc");
  assert.equal(sessionOf({ id: "run-tick-1" }), "");
});

test("touchesRuns is true for runs.jsonl and costs.jsonl only", () => {
  assert.equal(touchesRuns(RUNS_PATH), true);
  assert.equal(touchesRuns(COSTS_PATH), true);
  assert.equal(touchesRuns("brain/_index/agent-runs/wrap-offsets.json"), false);
});
