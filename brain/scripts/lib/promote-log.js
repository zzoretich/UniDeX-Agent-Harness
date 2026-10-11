'use strict';
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths.js');
const fsx = require('./fsx.js');

const TRAIL_PATH = path.join(PATHS.INDEX, 'promote-log.jsonl');

function appendTrail(entry) {
  const row = { ts: new Date().toISOString(), ...entry };
  // One locked append (brain-hub plan, PR 1): `aos memory` writes this trail too, from another process.
  fsx.appendLineSync(TRAIL_PATH, JSON.stringify(row), { lock: true });
  return row;
}

function readTrail(limit = 20) {
  let raw = '';
  try { raw = fs.readFileSync(TRAIL_PATH, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* corrupt line — skip */ }
  }
  return rows.reverse().slice(0, limit);
}

function revertedSlugs() {
  return new Set(readTrail(Infinity).filter((r) => r.action === 'reverted').map((r) => r.slug));
}

module.exports = { TRAIL_PATH, appendTrail, readTrail, revertedSlugs };
