import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMonthlyBudget, formatUSD } from "./cost";
import type { AgentRun } from "./runs";

const REF = new Date(2026, 8, 10, 12, 0, 0); // 2026-09-10 local
const run = (id: string, cost: number, day = 3): AgentRun => ({
  id: `sess-${id}`, script: "session",
  started_at: new Date(2026, 8, day, 9, 0, 0).toISOString(), ended_at: new Date(2026, 8, day, 10, 0, 0).toISOString(),
  duration_ms: 3_600_000, cost_usd: cost, turns: 4, status: "ok", tool_count: 2,
});

test("no anchor and no configured budget → budget 0, pct 0, month-to-date is the raw estimate", () => {
  const b = buildMonthlyBudget([run("a", 2), run("b", 3)], undefined, REF);
  assert.equal(b.budget, 0);
  assert.equal(b.pctOfBudget, 0);
  assert.equal(b.monthToDate, 5);
  assert.equal(b.runCount, 2);
});

test("cost.monthlyBudget from config supplies the ceiling", () => {
  const b = buildMonthlyBudget([run("a", 25)], undefined, REF, 100);
  assert.equal(b.budget, 100);
  assert.equal(b.pctOfBudget, 0.25);
  assert.equal(b.budgetRemaining, 75);
});

test("an anchored cost-budget.json budget still wins over the config value", () => {
  const b = buildMonthlyBudget([run("a", 1)], { budget: 40, month: "2026-09", anchorUsd: 10, anchorAt: new Date(2026, 8, 1).toISOString(), calibration: 1 }, REF, 100);
  assert.equal(b.budget, 40);
  assert.equal(b.anchored, true);
  assert.equal(b.monthToDate, 11); // anchorUsd + post-anchor run
});

test("month label uses the user's default locale (no hard-coded en-US)", () => {
  const b = buildMonthlyBudget([], undefined, REF);
  assert.equal(b.monthLabel, REF.toLocaleString(undefined, { month: "long", year: "numeric" }));
});

test("formatUSD scales precision", () => {
  assert.equal(formatUSD(0), "$0.00");
  assert.equal(formatUSD(0.0034), "$0.0034");
  assert.equal(formatUSD(12.5), "$12.50");
});
