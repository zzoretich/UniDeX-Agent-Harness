'use strict';
/**
 * local-usage.js — how much background work the local engine did (local-first A18). A local call costs nothing, so it
 * stays out of provider-spend.jsonl (a scan can make hundreds, and every spend reader parses that file); instead a
 * daily rollup, brain/_index/local-usage.json:
 *   { "days": { "2026-10-14": { "calls": 12, "ms": 48000, "byFeature": { "session-summary": 3, "file-map": 9 } } } }
 * keeping the last KEEP_DAYS days. Recording never throws and never waits long: a busy lock skips the count.
 */
const path = require('path');
const fs = require('fs');
const { PATHS } = require('../../lib/paths.js');

const USAGE_PATH = path.join(PATHS.INDEX, 'local-usage.json');
const KEEP_DAYS = 30;

function pad(n) { return String(n).padStart(2, '0'); }
function localDay(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function parse(text) {
  try { const j = JSON.parse(text); return j && typeof j.days === 'object' && j.days ? j : { days: {} }; }
  catch { return { days: {} }; }
}

/** Count one local call. `now` is a test seam. */
function recordLocalCall({ feature = 'unknown', ms = 0, now = new Date() } = {}, file = USAGE_PATH) {
  try {
    require('../../lib/fsx.js').updateSync(file, (before) => {
      const u = parse(before || '');
      const day = localDay(now);
      const d = u.days[day] || (u.days[day] = { calls: 0, ms: 0, byFeature: {} });
      d.calls += 1;
      d.ms += Math.max(0, Math.round(Number(ms) || 0));
      d.byFeature[feature] = (d.byFeature[feature] || 0) + 1;
      for (const k of Object.keys(u.days).sort().slice(0, -KEEP_DAYS)) delete u.days[k];
      return JSON.stringify(u) + '\n';
    }, { timeoutMs: 250 });
  } catch { /* a stat, not a ledger: losing one count is fine */ }
}

/** Today's rollup ({ calls, ms, byFeature }), zeros when none. */
function localUsageToday(now = new Date(), file = USAGE_PATH) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* no local calls yet */ }
  return parse(text).days[localDay(now)] || { calls: 0, ms: 0, byFeature: {} };
}

module.exports = { recordLocalCall, localUsageToday, USAGE_PATH, KEEP_DAYS };
