'use strict';
/**
 * spend-ledger.js — the provider layer's shared money + error primitives.
 *   ProviderUnavailable  typed error every provider throws instead of a bare string
 *   recordSpend/spendToday  append-only USD ledger at brain/_index/provider-spend.jsonl
 *   reasonSpendToday        the reasoner role's share of today (feature reason:*), for its own cap
 *   routineSpendToday       the prompt routines' share of today (feature routine:*), for routines.perDayUsd
 *   graphSpendToday         the vault graph's semantic pass (feature graph:*), for graph.semantic.perDayUsd
 *   crossReviewSpendToday   cross-review and handoff calls (feature cross-review:*), for crossReview.perDayUsd
 * Lives apart from provider.js so claude-cli.js can ledger without a require cycle.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../../lib/paths.js');

const SPEND_PATH = path.join(PATHS.INDEX, 'provider-spend.jsonl');

class ProviderUnavailable extends Error {
  /** @param {'PROVIDER_NONE'|'PROVIDER_UNREACHABLE'|'PROVIDER_CAP'} code */
  constructor(code, message, provider = 'none') {
    super(message || code);
    this.name = 'ProviderUnavailable';
    this.code = code;
    this.provider = provider;
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
function localDay(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function readRows() {
  let raw;
  try { raw = fs.readFileSync(SPEND_PATH, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line — skip */ }
  }
  return rows;
}

function recordSpend({ feature, provider, model, usd, inputTokens, outputTokens, ms }) {
  const row = {
    ts: new Date().toISOString(),
    feature: feature || 'unknown',
    provider: provider || 'claude',
    model: model || null,
    usd: Number(usd) || 0,
    inputTokens: inputTokens == null ? null : Number(inputTokens),
    outputTokens: outputTokens == null ? null : Number(outputTokens),
    ms: ms == null ? null : Number(ms),
  };
  fs.mkdirSync(path.dirname(SPEND_PATH), { recursive: true });
  fs.appendFileSync(SPEND_PATH, JSON.stringify(row) + '\n');
  return row;
}

/** The metered families that never count against the hook cap: four carry their own daily cap, agent teams (`team:`)
 *  are capped per board item instead (spec 2026-09-28-agent-teams D8), and `session:` rows are the retired Sessions tab's
 *  turns (remove-sessions D12), which a ledger may still hold. */
const HOOK_EXCLUDE = /^(duty|reason|routine|graph|cross-review|team|session):/;
const REASON_ROWS = /^reason:/;
const ROUTINE_ROWS = /^routine:/;
const GRAPH_ROWS = /^graph:/;
const CROSS_REVIEW_ROWS = /^cross-review:/;
const TEAM_ROWS = /^team:/;

/**
 * USD spent on the local calendar day of `now` (default: now) by the rows the hook cap
 * (`claude.perDayUsd`) governs. Rows whose `feature` matches `exclude` are skipped — by
 * default the persona's `duty:*` runs (gated by `persona.perDayUsd`), the reasoner's
 * `reason:*` calls (gated by `reasoner.perDayUsd`) and prompt routines' `routine:*` runs
 * (gated by `routines.perDayUsd`), the vault graph's `graph:*` semantic calls (gated by
 * `graph.semantic.perDayUsd`) and `cross-review:*` review, build, inspect and handoff calls (gated by
 * `crossReview.perDayUsd`): any of them would otherwise blow the $0.50 hook cap on
 * its first call of the day. The Obsidian Chat tab's legacy `chat` rows stay
 * counted. `include` keeps only matching rows (applied before `exclude`); `exclude: null`
 * sums every row.
 */
function spendToday(now = new Date(), { exclude = HOOK_EXCLUDE, include = null } = {}) {
  const day = localDay(now);
  let sum = 0;
  for (const r of readRows()) {
    const t = new Date(r.ts);
    if (Number.isNaN(t.getTime()) || localDay(t) !== day) continue;
    const feature = String(r.feature || '');
    if (include && !include.test(feature)) continue;
    if (exclude && exclude.test(feature)) continue;
    sum += Number(r.usd) || 0;
  }
  return Math.round(sum * 1e6) / 1e6;
}

/** Today's reasoner spend: the rows the reasoner cap (`reasoner.perDayUsd`) governs. */
function reasonSpendToday(now = new Date()) {
  return spendToday(now, { include: REASON_ROWS, exclude: null });
}

/** Today's prompt-routine spend: the rows `routines.perDayUsd` governs. */
function routineSpendToday(now = new Date()) {
  return spendToday(now, { include: ROUTINE_ROWS, exclude: null });
}

/** Today's vault-graph semantic spend: the rows `graph.semantic.perDayUsd` governs (spec 2026-09-23-graphify D10). */
function graphSpendToday(now = new Date()) {
  return spendToday(now, { include: GRAPH_ROWS, exclude: null });
}

/** Today's cross-review spend: the rows `crossReview.perDayUsd` governs (spec 2026-09-23-cross-review D7). */
function crossReviewSpendToday(now = new Date()) {
  return spendToday(now, { include: CROSS_REVIEW_ROWS, exclude: null });
}

module.exports = { ProviderUnavailable, recordSpend, spendToday, reasonSpendToday, routineSpendToday, graphSpendToday, crossReviewSpendToday, SPEND_PATH, HOOK_EXCLUDE, REASON_ROWS, ROUTINE_ROWS, GRAPH_ROWS, CROSS_REVIEW_ROWS, TEAM_ROWS };
