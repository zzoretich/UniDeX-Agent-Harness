#!/usr/bin/env node
/**
 * cost-budget.js — manage the anchored monthly Claude-spend budget + reconciliation ledger.
 *
 * The Cost panel does NOT sum the analyzer's retail estimates (they run ~3.6x hot
 * vs actual billing). Instead it anchors to a real claude.ai billed figure at a
 * point in time and adds calibrated analyzer cost for sessions that ENDED
 * after that anchor. Re-anchoring at each check-in resets accumulated drift.
 *
 * Every --anchor appends a row to cost-budget-ledger.jsonl capturing the real $,
 * the analyzer's raw cost of sessions that closed since the previous anchor,
 * and the per-interval derived calibration. Across intervals where a session
 * actually closed, a pooled calibration (Σ realDelta / Σ tokenGoblinDelta) is
 * computed and written back to the config — self-tuning the 0.279 seed.
 *
 * Usage:
 *   node cost-budget.js                  # show config, derived MTD, and ledger summary
 *   node cost-budget.js --anchor 512.40  # re-anchor to a fresh claude.ai number (now) + log + recalibrate
 *   node cost-budget.js --calibration .31# pin calibration manually (skips auto-recompute this run)
 *   node cost-budget.js --budget 100     # override the monthly budget (default: cost.monthlyBudget in brain/config.json)
 *   node cost-budget.js --ledger         # print the full reconciliation ledger
 *
 * --anchor stamps anchorAt=now and month=current, so it doubles as the month reset.
 */

const fs = require('fs');
const path = require('path');
const brain = require('./sdk/lib/brain.js');
const { loadConfig } = require('./lib/config.js');

const CONFIG = path.join(brain.PATHS.VAULT, 'brain/_index/cost-budget.json');
const RUNS = path.join(brain.PATHS.VAULT, 'brain/_index/agent-runs/runs.jsonl');
const LEDGER = path.join(brain.PATHS.VAULT, 'brain/_index/cost-budget-ledger.jsonl');

const round = (x, n = 6) => Math.round(x * 10 ** n) / 10 ** n;

/** cost.monthlyBudget from config; 0 when unset (the HUD hides the budget row for 0/null). */
function defaultBudget() {
  const b = loadConfig().cost.monthlyBudget;
  return typeof b === 'number' && b > 0 ? b : 0;
}
function readConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch { c = { month: '', anchorUsd: 0, anchorAt: '', calibration: 1, note: '' }; }
  // execution amendment 2026-09-15 (A35): fill `budget` from config only when that gives a positive number — main() persists
  // this object, and a stored `budget: 0` would make the HUD's `config?.budget ?? monthlyBudget` (hud/src/data/cost.ts:149)
  // hide a monthlyBudget set later. With no budget anywhere the key stays absent; deriveState() falls back to defaultBudget().
  if (!(typeof c.budget === 'number' && c.budget > 0)) { const b = defaultBudget(); if (b > 0) c.budget = b; }
  return c;
}
function writeConfig(c) { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n'); }

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** Deduped session records from runs.jsonl with costs.jsonl laid over it (lib/runs-log.js readRuns), richest per session. */
function readBestRuns() {
  const { readRuns, sessionOf } = require('./lib/runs-log.js');
  const key = (r) => sessionOf(r) || r.id || '';
  const best = new Map();
  for (const r of readRuns({ runsFile: RUNS })) {
    const k = key(r); if (!k) continue;
    const cur = best.get(k);
    if (!cur || (r.cost_usd || 0) > (cur.cost_usd || 0)) best.set(k, r);
  }
  return [...best.values()];
}

/** Raw analyzer cost of sessions that ENDED in [fromMs, toMs). */
function tgCostEndedBetween(fromMs, toMs) {
  let sum = 0;
  for (const r of readBestRuns()) {
    const end = r.ended_at ? new Date(r.ended_at).getTime() : (r.started_at ? new Date(r.started_at).getTime() : 0);
    if (end >= fromMs && end < toMs) sum += (r.cost_usd || 0);
  }
  return sum;
}

function readLedger() {
  try {
    return fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function appendLedger(row) { fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n'); }

/**
 * Pooled calibration across settled intervals. Guarded: an interval that
 * spans a claude.ai billing-month reset is not a valid sample — its
 * realDelta compares two different months' baselines. Negative realDelta
 * always means a reset (real spend never decreases within a month), and
 * rows carrying prevTs are also excluded when the endpoints' calendar
 * months differ (a reset can still yield a positive delta).
 */
function pooledCalibration(rows) {
  let real = 0, tg = 0, intervals = 0;
  for (const r of rows) {
    if (!(typeof r.tgRawDelta === 'number' && r.tgRawDelta > 0 && typeof r.realDelta === 'number')) continue;
    if (r.realDelta < 0) continue;
    if (r.prevTs && String(r.ts).slice(0, 7) !== String(r.prevTs).slice(0, 7)) continue;
    real += r.realDelta; tg += r.tgRawDelta; intervals++;
  }
  return tg > 0 ? { value: round(real / tg, 4), real: round(real, 2), tg: round(tg, 2), intervals } : null;
}

// Mirror the plugin's anchored math so the CLI can show the same MTD.
function deriveState(c) {
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const stale = c.month && c.month !== month;
  const anchorMs = c.anchorAt ? new Date(c.anchorAt).getTime() : 0;
  let newSpendRaw = 0;
  for (const r of readBestRuns()) {
    if (!r.started_at) continue;
    const endMs = r.ended_at ? new Date(r.ended_at).getTime() : new Date(r.started_at).getTime();
    if (endMs >= anchorMs && r.started_at.slice(0, 7) === month) newSpendRaw += (r.cost_usd || 0);
  }
  const cal = typeof c.calibration === 'number' ? c.calibration : 1;
  const newSpend = newSpendRaw * cal;
  const anchor = stale ? 0 : (c.anchorUsd || 0);
  return { month, stale, anchor, newSpendRaw, newSpend, cal, mtd: anchor + newSpend, budget: (typeof c.budget === 'number' && c.budget > 0) ? c.budget : defaultBudget() };
}

function main() {
  const c = readConfig();
  const anchor = arg('--anchor');
  const calibration = arg('--calibration');
  const budget = arg('--budget');
  let changed = false;
  let calMsg = '';

  if (budget !== null) { c.budget = parseFloat(budget); changed = true; }

  if (anchor !== null) {
    const newReal = parseFloat(anchor);
    // Previous reading = last ledger row, else the current config anchor.
    const ledger = readLedger();
    const prev = ledger.length ? ledger[ledger.length - 1] : null;
    const prevReal = prev ? prev.realUsd : (c.anchorUsd || 0);
    const prevTs = prev ? prev.ts : (c.anchorAt || new Date().toISOString());
    const nowIso = new Date().toISOString();
    const tgRawDelta = tgCostEndedBetween(new Date(prevTs).getTime(), new Date(nowIso).getTime());
    const realDelta = newReal - prevReal;
    const derived = tgRawDelta > 0 ? round(realDelta / tgRawDelta, 4) : null;
    appendLedger({
      ts: nowIso, event: 'anchor', realUsd: round(newReal, 2),
      prevTs,
      prevRealUsd: round(prevReal, 2), realDelta: round(realDelta, 2),
      tgRawDelta: round(tgRawDelta, 2), derivedCalibration: derived,
      note: `interval ${prevTs} → ${nowIso}`,
    });

    c.anchorUsd = newReal;
    c.anchorAt = nowIso;
    c.month = nowIso.slice(0, 7);
    c.note = `Anchored $${round(newReal, 2)} on ${nowIso}. MTD = anchor + calibration × analyzer cost of sessions ended after anchor (guarded pooling skips reset-spanning intervals). Re-anchor monthly: node brain/scripts/cost-budget.js --anchor <usd>.`;
    changed = true;

    // Auto-recalibrate from the pooled ledger (unless calibration is pinned this run).
    if (calibration === null) {
      const pooled = pooledCalibration(readLedger());
      if (pooled) {
        calMsg = `  calibration auto-updated ${c.calibration} → ${pooled.value}  (from ${pooled.intervals} settled interval(s): $${pooled.real} real / $${pooled.tg} analyzer)\n`;
        c.calibration = pooled.value;
      } else {
        calMsg = `  calibration unchanged (${c.calibration}) — no closed-session interval yet to derive from\n`;
      }
    }
  }

  if (calibration !== null) { c.calibration = parseFloat(calibration); changed = true; }
  if (changed) { writeConfig(c); }

  if (process.argv.includes('--ledger')) {
    const rows = readLedger();
    process.stdout.write(`Reconciliation ledger (${rows.length} rows) — ${LEDGER}\n`);
    for (const r of rows) {
      process.stdout.write(`  ${r.ts}  real $${r.realUsd}  Δreal $${r.realDelta ?? '—'}  Δanalyzer $${r.tgRawDelta ?? '—'}  derived ${r.derivedCalibration ?? '—'}\n`);
    }
    return;
  }

  const s = deriveState(c);
  const pooled = pooledCalibration(readLedger());
  process.stdout.write(
    `Budget config (${CONFIG})\n` +
    `  month:        ${c.month}${s.stale ? '  ⚠ STALE (rolled over to ' + s.month + ' — re-anchor)' : ''}\n` +
    `  budget:       ${s.budget ? '$' + s.budget.toFixed(2) : '(none — aos cost enable --budget <usd>)'}\n` +
    `  anchor:       $${(c.anchorUsd || 0).toFixed(2)}  @ ${c.anchorAt || '(unset)'}\n` +
    `  calibration:  ${c.calibration}${pooled ? `  (pooled from ${pooled.intervals} interval(s))` : '  (seed — no settled intervals yet)'}\n` +
    (calMsg || '') +
    `  ─ derived ─\n` +
    `  new sessions (since anchor): $${s.newSpendRaw.toFixed(2)} raw × ${s.cal} = $${s.newSpend.toFixed(2)}\n` +
    `  MONTH-TO-DATE: $${s.mtd.toFixed(2)}${s.budget ? ` / $${s.budget.toFixed(2)}  (${(s.mtd / s.budget * 100).toFixed(1)}%)` : ''}\n` +
    `  ledger rows:  ${readLedger().length}\n` +
    (changed ? '  (config updated)\n' : '')
  );
}

if (require.main === module) main();
module.exports = { pooledCalibration, deriveState, defaultBudget, readConfig };
