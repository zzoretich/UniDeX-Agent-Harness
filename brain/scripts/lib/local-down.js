'use strict';
/**
 * local-down.js — local-first A3: under provider local, is the local engine down by its last resolve (provider.js
 * writes `localReason` into brain/_index/provider-state.json on every resolve), and how many sessions wait in
 * auto-wrap's spool for it (lib/wrap-queue.js). Files only: no probe, no model.
 *
 *   localWaiting({ cfg, vault }) → { reason: 'local-down' | 'local-model-missing' | null, queued, line }
 *     line: "local model down: 2 wraps queued" (or "local model not downloaded: …"), null while it is up.
 * Health (collectors/health.js) puts the line in the snapshot, so Pulse and the briefing show it; `aos doctor` and
 * `aos status` read the same two files.
 */
const fs = require('fs');
const path = require('path');

const DOWN = new Set(['local-down', 'local-model-missing']);

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { return 0; }
}

function localWaiting({ cfg, vault } = {}) {
  const idx = path.join(vault || require('./paths.js').PATHS.VAULT, 'brain', '_index');
  const queued = countLines(path.join(idx, 'auto-wrap-pending.jsonl'));
  const st = readJson(path.join(idx, 'provider-state.json'));
  const reason = cfg && cfg.provider === 'local' && st && DOWN.has(st.localReason) ? st.localReason : null;
  if (!reason) return { reason: null, queued, line: null };
  const what = reason === 'local-down' ? 'local model down' : 'local model not downloaded';
  return { reason, queued, line: `${what}: ${queued} wrap${queued === 1 ? '' : 's'} queued` };
}

module.exports = { localWaiting };
