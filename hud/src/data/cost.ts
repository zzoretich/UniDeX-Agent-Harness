import type { AgentRun } from "./runs";

export interface CostByDay {
  date: string;
  cost: number;
  count: number;
}

export interface CostBreakdown {
  total: number;
  today: number;
  yesterday: number;
  daily: CostByDay[];
  topScripts: Array<{ script: string; cost: number; count: number }>;
}

export function buildCostBreakdown(runs: AgentRun[], days = 14): CostBreakdown {
  const byDay = new Map<string, CostByDay>();
  const byScript = new Map<string, { cost: number; count: number }>();
  let total = 0;

  for (const r of runs) {
    const cost = r.cost_usd || 0;
    total += cost;
    const date = (r.started_at || "").slice(0, 10);
    if (date) {
      const cur = byDay.get(date) || { date, cost: 0, count: 0 };
      cur.cost += cost;
      cur.count += 1;
      byDay.set(date, cur);
    }
    const s = byScript.get(r.script) || { cost: 0, count: 0 };
    s.cost += cost;
    s.count += 1;
    byScript.set(r.script, s);
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const yKey = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Build dense daily series for the last N days (filling 0s)
  const daily: CostByDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.push(byDay.get(k) || { date: k, cost: 0, count: 0 });
  }

  const topScripts = [...byScript.entries()]
    .map(([script, v]) => ({ script, ...v }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  return {
    total,
    today: byDay.get(todayKey)?.cost || 0,
    yesterday: byDay.get(yKey)?.cost || 0,
    daily,
    topScripts,
  };
}

/**
 * Anchored budget config (brain/_index/cost-budget.json). The panel does NOT sum
 * the analyzer's retail estimates (they run ~3.6× hot vs actual billing). It anchors
 * to a real claude.ai billed figure at a point in time, then adds calibrated
 * analyzer cost for sessions AFTER the anchor. Re-anchoring at each check-in
 * resets accumulated drift to zero. Manage via brain/scripts/cost-budget.js.
 */
export interface BudgetConfig {
  budget: number; // monthly budget ceiling, USD
  month: string; // "YYYY-MM" the anchor applies to
  anchorUsd: number; // real billed $ as of anchorAt
  anchorAt: string; // ISO timestamp the anchor was taken
  calibration: number; // analyzer → billed scaling factor (1 = raw)
  note?: string;
}

export interface MonthlyBudget {
  monthLabel: string; // "June 2026"
  monthToDate: number; // anchored: anchorUsd + calibration × post-anchor analyzer cost
  budget: number;
  budgetRemaining: number; // budget - monthToDate (may go negative)
  pctOfBudget: number; // monthToDate / budget (0..1+, 0 if budget<=0)
  paceProjected: number; // projected month-end spend at the current daily pace
  dayOfMonth: number; // ref day-of-month (1..31)
  daysInMonth: number;
  daily: CostByDay[]; // dense series (calibrated), day 1 of month → ref day
  topScripts: Array<{ script: string; cost: number; count: number }>; // calibrated $
  runCount: number; // runs this month
  costedCount: number; // runs this month carrying a cost (sync-coverage hint)
  // anchored-model fields
  anchorUsd: number; // real billed figure the month-to-date builds on
  newSpend: number; // calibrated analyzer cost since the anchor
  calibration: number;
  anchored: boolean; // true when a usable same-month anchor is present
  stale: boolean; // true when the anchor is from a previous month (needs re-anchor)
}

/** Canonical session identity, tolerant of the two telemetry formats:
 *  new records carry session_id; older ones only carry id "sess-<uuid>". */
function sessionKey(r: AgentRun): string {
  const anyR = r as AgentRun & { session_id?: string };
  return anyR.session_id || (r.id || "").replace(/^sess-/, "") || r.id || "";
}

/** Collapse duplicate run records for the same session (the telemetry log can
 *  contain both an old-format and a new-format line for one session, which would
 *  otherwise double-count its cost). Keeps the richest record per session:
 *  highest cost_usd, then highest tool_count. */
function dedupeRuns(runs: AgentRun[]): AgentRun[] {
  const best = new Map<string, AgentRun>();
  for (const r of runs) {
    const k = sessionKey(r);
    if (!k) continue;
    const cur = best.get(k);
    if (!cur) { best.set(k, r); continue; }
    const score = (x: AgentRun) => [x.cost_usd || 0, x.tool_count || 0];
    const [c1, t1] = score(r);
    const [c0, t0] = score(cur);
    if (c1 > c0 || (c1 === c0 && t1 > t0)) best.set(k, r);
  }
  return [...best.values()];
}

/** Local YYYY-MM-DD for an ISO timestamp (matches loadRunsForMonth's local filter). */
function localDateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Aggregate month-scoped runs into a budget burndown. `monthRuns` should already
 * be filtered to one calendar month (see loadRunsForMonth). `ref` anchors the
 * month label, day-of-month, and pace projection (default: now).
 */
export function buildMonthlyBudget(
  rawMonthRuns: AgentRun[],
  config?: Partial<BudgetConfig>,
  ref: Date = new Date(),
  /** cost.monthlyBudget from <vault>/brain/config.json (aosConfig.readVaultConfig); null → no ceiling. */
  monthlyBudget: number | null = null,
): MonthlyBudget {
  // Collapse duplicate session records so cost isn't counted twice.
  const monthRuns = dedupeRuns(rawMonthRuns);

  const budget = config?.budget ?? monthlyBudget ?? 0;
  const anchorUsd = config?.anchorUsd ?? 0;
  const anchorAt = config?.anchorAt ?? "";
  const calibration = typeof config?.calibration === "number" ? config.calibration : 1;
  const refMonth = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, "0")}`;
  const anchored = !!anchorAt && !!config?.month;
  const stale = anchored && config!.month !== refMonth;
  const anchorMs = anchorAt ? new Date(anchorAt).getTime() : 0;

  const byDay = new Map<string, CostByDay>();
  const byScript = new Map<string, { cost: number; count: number }>();
  let estTotal = 0; // raw analyzer sum of the whole month
  let newSpendRaw = 0; // raw analyzer sum of sessions started at/after the anchor
  let costedCount = 0;

  for (const r of monthRuns) {
    const cost = r.cost_usd || 0;
    estTotal += cost;
    if (cost > 0) costedCount++;
    // "New since anchor" = the session FINISHED after the anchor reading, so it
    // wasn't yet billed into anchorUsd. Using ended_at (not started_at) correctly
    // counts a session that was already open when the anchor was taken.
    const endMs = r.ended_at ? new Date(r.ended_at).getTime()
      : r.started_at ? new Date(r.started_at).getTime() : 0;
    if (anchored && !stale && endMs >= anchorMs) {
      newSpendRaw += cost;
    }
    const date = localDateKey(r.started_at || "");
    if (date) {
      const cur = byDay.get(date) || { date, cost: 0, count: 0 };
      cur.cost += cost;
      cur.count += 1;
      byDay.set(date, cur);
    }
    const s = byScript.get(r.script) || { cost: 0, count: 0 };
    s.cost += cost;
    s.count += 1;
    byScript.set(r.script, s);
  }

  // Anchored month-to-date: trust the real billed figure, add calibrated new usage.
  // Without a same-month anchor, fall back to a calibrated estimate of the whole month.
  const newSpend = newSpendRaw * calibration;
  const monthToDate = anchored && !stale ? anchorUsd + newSpend : estTotal * calibration;

  const year = ref.getFullYear();
  const month = ref.getMonth();
  const dayOfMonth = ref.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Dense daily series (calibrated $): day 1 of the month through ref's day.
  const daily: CostByDay[] = [];
  for (let day = 1; day <= dayOfMonth; day++) {
    const k = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const d = byDay.get(k);
    daily.push({ date: k, cost: (d?.cost ?? 0) * calibration, count: d?.count ?? 0 });
  }

  const pctOfBudget = budget > 0 ? monthToDate / budget : 0;
  // Linear projection: average daily burn so far × days in the month.
  const paceProjected = dayOfMonth > 0 ? (monthToDate / dayOfMonth) * daysInMonth : monthToDate;

  const topScripts = [...byScript.entries()]
    .map(([script, v]) => ({ script, cost: v.cost * calibration, count: v.count }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  return {
    monthLabel: ref.toLocaleString(undefined, { month: "long", year: "numeric" }),
    monthToDate,
    budget,
    budgetRemaining: budget - monthToDate,
    pctOfBudget,
    paceProjected,
    dayOfMonth,
    daysInMonth,
    daily,
    topScripts,
    runCount: monthRuns.length,
    costedCount,
    anchorUsd,
    newSpend,
    calibration,
    anchored,
    stale,
  };
}

export function formatUSD(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 10) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
