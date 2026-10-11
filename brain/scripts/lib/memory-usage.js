'use strict';
/**
 * memory-usage.js — which memories reach an agent (brain-hub D8, D9). One row per path in
 * brain/_index/memory-usage.jsonl: `{ts, host, how, path}`, how ∈ injected · recalled · read, path under brain/memory/
 * or brain/patterns/. Paths and counts only: never a prompt, a query or a snippet. inject-context.js writes `injected`
 * once per session; the MCP server writes `recalled` for recall's hits and `read` for a found memory_read, on both
 * hosts. Off when telemetry.enabled is false. A failure never reaches the caller: a hook exits 0 with nothing extra on
 * stdout, and a tool's answer never waits on its log row (a short lock wait, then it writes anyway).
 *
 * foldUsage (scan-vault) moves rows older than memory.usageDays into memory-usage-rollup.json, so the log stays short
 * and the totals stay whole; summarize() reads both. Takes the vault, resolves nothing at load.
 */
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx.js');

const HOWS = ['injected', 'recalled', 'read'];
const HOSTS = ['claude', 'codex'];
const PATH_OK = /^brain\/(?:memory|patterns)\/[^\0\n\r]{1,240}\.md$/;
const DAY_MS = 24 * 3600 * 1000;

function logFile(vault) { return path.join(vault, 'brain', '_index', 'memory-usage.jsonl'); }
function rollupFile(vault) { return path.join(vault, 'brain', '_index', 'memory-usage-rollup.json'); }
function isOn(cfg) { return !(cfg && cfg.telemetry && cfg.telemetry.enabled === false); }

/** A path as the log keeps it, or null: vault-relative, under brain/memory or brain/patterns, no drafts, no `..`. */
function cleanPath(p) {
  const rel = String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!PATH_OK.test(rel) || rel.split('/').includes('..') || rel.includes('/_drafts/')) return null;
  return rel;
}

/** Append one row per qualifying path (each once). → how many were written; 0 when off, on nothing, or on any failure. */
function logUsage({ vault, how, paths, host, cfg, now = new Date() } = {}) {
  try {
    if (!vault || !HOWS.includes(how) || !isOn(cfg)) return 0;
    const ts = now.toISOString();
    const h = HOSTS.includes(host) ? host : 'unknown';
    const seen = new Set();
    const rows = [];
    for (const p of paths || []) {
      const rel = cleanPath(p);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      rows.push(JSON.stringify({ ts, host: h, how, path: rel }));
    }
    if (!rows.length) return 0;
    fsx.appendLineSync(logFile(vault), rows.join('\n'), { lock: true, timeoutMs: 300 });
    return rows.length;
  } catch {
    return 0;
  }
}

function parseRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.ts === 'string' && HOWS.includes(r.how) && cleanPath(r.path) === r.path) rows.push(r);
    } catch { /* a torn line: skipped */ }
  }
  return rows;
}

function readLog(vault) { try { return parseRows(fs.readFileSync(logFile(vault), 'utf8')); } catch { return []; } }
function readRollup(vault) {
  try {
    const r = JSON.parse(fs.readFileSync(rollupFile(vault), 'utf8'));
    return r && r.schema === 1 && r.paths && typeof r.paths === 'object' ? r : null;
  } catch { return null; }
}

function blank() { return { injected: 0, recalled: 0, read: 0, claude: 0, codex: 0, last: null }; }
function add(t, r) {
  t[r.how] += 1;
  if (r.host === 'claude' || r.host === 'codex') t[r.host] += 1;
  if (!t.last || r.ts > t.last) t.last = r.ts;
}

/**
 * Per path: { injected, recalled, read, claude, codex, last, d7, d30 } over the rollup and the log, plus `since` (the
 * first row ever, so the hub can say how long it has been collecting). d7 and d30 come from the log alone, which always
 * covers at least memory.usageDays (≥ 30).
 */
function summarize(vault, { now = Date.now() } = {}) {
  const roll = readRollup(vault);
  const paths = {};
  let since = roll && roll.since ? roll.since : null;
  if (roll) for (const [p, t] of Object.entries(roll.paths)) paths[p] = { ...blank(), ...t, d7: 0, d30: 0 };
  for (const r of readLog(vault)) {
    const t = paths[r.path] || (paths[r.path] = { ...blank(), d7: 0, d30: 0 });
    add(t, r);
    const age = now - Date.parse(r.ts);
    if (age <= 7 * DAY_MS) t.d7 += 1;
    if (age <= 30 * DAY_MS) t.d30 += 1;
    if (!since || r.ts < since) since = r.ts;
  }
  return { since, paths };
}

/** Move rows older than `days` into the rollup, under the log's lock. → { folded, kept } */
function foldUsage(vault, { days = 90, now = Date.now() } = {}) {
  const file = logFile(vault);
  if (!fs.existsSync(file)) return { folded: 0, kept: 0 };
  const cutoff = new Date(now - Math.max(30, days) * DAY_MS).toISOString();
  return fsx.withLockSync(file, () => {
    const rows = readLog(vault);
    const old = rows.filter((r) => r.ts < cutoff);
    if (!old.length) return { folded: 0, kept: rows.length };
    const keep = rows.filter((r) => r.ts >= cutoff);
    const roll = readRollup(vault) || { schema: 1, since: null, through: null, paths: {} };
    for (const r of old) {
      add(roll.paths[r.path] || (roll.paths[r.path] = blank()), r);
      if (!roll.since || r.ts < roll.since) roll.since = r.ts;
    }
    roll.through = cutoff;
    // The rollup first: a crash between the two writes counts a row twice, never loses one.
    fsx.writeAtomic(rollupFile(vault), JSON.stringify(roll) + '\n');
    fsx.writeAtomic(file, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    return { folded: old.length, kept: keep.length };
  }, { timeoutMs: 2000 });
}

/** The paths a recall-wake.md names (`brain/…md` in backticks), for the injection's rows. */
function wakePaths(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/`(brain\/[^`\n]{1,240}\.md)`/g)) out.push(m[1]);
  return out;
}

module.exports = { HOWS, logFile, rollupFile, cleanPath, logUsage, readLog, summarize, foldUsage, wakePaths };
