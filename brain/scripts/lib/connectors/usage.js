'use strict';
/**
 * connectors/usage.js — how much each MCP server and connector is used, from both hosts' transcripts (connectors-tab
 * D13). Reads only through lib/transcript.js mcpCalls and lib/host.js sessionFiles; no model call.
 *
 *   collectUsage({ vault, userConfig, env, now, days, rows, hosts }) → { schema, updatedAt, days, rows }
 *   row: { host, key, name, builtin, calls, sessions, lastUsed, perDay: [n × days, oldest first, today last], perTool }
 *     `key` is the server as a call names it (mcp__<key>__<tool>). Claude Code writes a server's name into a tool name
 *     with every character but letters, digits, `_` and `-` as `_` (`claude.ai Mail` → claude_ai_Mail,
 *     `plugin:p:s` → plugin_p_s), so a key is matched to a discovered row (`rows`, discover.js) by that same rewrite of
 *     its name; one no row matches is a built-in server (`builtin: true`, `name` = the key).
 *   Days are UTC calendar days ending today; a call with no timestamp counts on its file's last-write day.
 *
 *   `sessions` counts the sessions that called it: a Claude Code subagent's transcript (<session>/subagents/, listed
 *   through sessionFiles' `subagents`) counts as its session's.
 *   Incremental (as session-index.json): brain/_index/connectors-usage-index.json { schema, files: { <abs>: { host, session,
 *   size, mtime, offset, calls: { <key>: { <tool>: { <YYYY-MM-DD>: n } } }, last: { <key>: ms } } } } keeps each transcript's counts and
 *   where its reading stopped; an unchanged file is not opened, an appended one is read from its offset, a shorter one
 *   is read again. A file last written before the window is dropped, as are counts older than it. The rows go to
 *   brain/_index/connectors-usage.json; the index is the runtime's alone (the Workbench reads only the rows).
 */
const path = require('path');
const H = require('../host.js');
const T = require('../transcript.js');
const C = require('../import/common.js');
const fsx = require('../fsx.js');

const SCHEMA = 1;
const DAY = 24 * 60 * 60 * 1000;

function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
/** The name a call would carry for a server named `name` (Claude Code's rewrite; Codex names keep their characters). */
function callKey(name) { return String(name).replace(/[^A-Za-z0-9_-]/g, '_'); }

function indexFile(vault) { return path.join(vault, 'brain', '_index', 'connectors-usage-index.json'); }
function outFile(vault) { return path.join(vault, 'brain', '_index', 'connectors-usage.json'); }

function readIndex(file) {
  const j = C.readJson(file);
  return j && j.schema === SCHEMA && j.files && typeof j.files === 'object' ? j.files : {};
}

/** Count `calls` into a record's { calls, last } (last: the newest call per key, in ms). */
function addCalls(rec, calls, fallbackMs) {
  for (const c of calls) {
    const at = c.at || fallbackMs;
    const day = dayOf(at);
    const k = (rec.calls[c.server] = rec.calls[c.server] || {});
    const t = (k[c.tool] = k[c.tool] || {});
    t[day] = (t[day] || 0) + 1;
    if (!rec.last[c.server] || at > rec.last[c.server]) rec.last[c.server] = at;
  }
  return rec;
}

/** Keep only the days at or after `first` (YYYY-MM-DD), and `last` for the keys still counted. */
function prune(rec, first) {
  const calls = {};
  for (const [key, tools] of Object.entries(rec.calls || {})) {
    for (const [tool, days] of Object.entries(tools)) {
      for (const [day, n] of Object.entries(days)) {
        if (day < first) continue;
        ((calls[key] = calls[key] || {})[tool] = calls[key][tool] || {})[day] = n;
      }
    }
  }
  const last = {};
  for (const key of Object.keys(calls)) if (rec.last && rec.last[key]) last[key] = rec.last[key];
  return { calls, last };
}

/** One transcript's record, read only as far as it changed. → { rec, changed } */
function readFile(f, old, first) {
  const format = f.host === 'codex' ? 'codex' : 'claude';
  if (old && old.host === f.host && old.size === f.size && old.mtime === f.mtimeMs) {
    const kept = prune(old, first);
    return { rec: { ...old, ...kept }, changed: JSON.stringify(kept.calls) !== JSON.stringify(old.calls || {}) };
  }
  const resume = old && old.host === f.host && Number.isInteger(old.offset) && f.size >= old.size && old.offset <= f.size;
  const r = T.mcpCalls(f.file, resume ? old.offset : 0, { format });
  if (!r) return { rec: null, changed: !!old };
  const base = resume && !r.reset ? JSON.parse(JSON.stringify({ calls: old.calls || {}, last: old.last || {} })) : { calls: {}, last: {} };
  const kept = prune(addCalls(base, r.calls, f.mtimeMs), first);
  return { rec: { host: f.host, session: f.parent || f.id || f.file, size: f.size, mtime: f.mtimeMs, offset: r.offset, ...kept }, changed: true };
}

function collectUsage({ vault, userConfig = null, env = process.env, now = Date.now(), days = 30, rows = [], hosts = null, write = true } = {}) {
  const span = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  const today = dayOf(now);
  const first = dayOf(Date.parse(`${today}T00:00:00.000Z`) - (span - 1) * DAY);
  const windowStart = Date.parse(`${first}T00:00:00.000Z`);
  const on = hosts || (H.enabledHosts(userConfig).length ? H.enabledHosts(userConfig) : ['claude']);
  const idxPath = vault ? indexFile(vault) : null;
  const prev = idxPath ? readIndex(idxPath) : {};
  const files = {};
  let dirty = false;
  for (const host of on) {
    const dirs = H.hostDirs(host, { env, userConfig });
    // A subagent's calls are its session's (D13): Claude Code keeps them in <session>/subagents/.
    for (const f of H.sessionFiles(host, { dirs, subagents: true })) {
      if (f.mtimeMs < windowStart) continue;
      const { rec, changed } = readFile(f, prev[f.file], first);
      if (changed) dirty = true;
      if (rec) files[f.file] = rec;
    }
  }
  if (Object.keys(prev).some((k) => !files[k])) dirty = true;

  // Roll the files up per host and key.
  const names = new Map();
  for (const r of rows) if (r && r.host && r.name) names.set(`${r.host}\t${callKey(r.name)}`, r.name);
  const dayIndex = new Map();
  for (let i = 0; i < span; i++) dayIndex.set(dayOf(windowStart + i * DAY), i);
  const out = new Map();
  const sessionsOf = new Map();
  for (const [file, rec] of Object.entries(files)) {
    for (const [key, tools] of Object.entries(rec.calls || {})) {
      const id = `${rec.host}\t${key}`;
      const named = names.get(id);
      const row = out.get(id) || { host: rec.host, key, name: named || key, builtin: !named, calls: 0, sessions: 0, lastUsed: null, perDay: new Array(span).fill(0), perTool: {} };
      let inFile = 0;
      for (const [tool, byDay] of Object.entries(tools)) {
        for (const [day, n] of Object.entries(byDay)) {
          const i = dayIndex.get(day);
          if (i === undefined) continue;
          row.perDay[i] += n;
          row.perTool[tool] = (row.perTool[tool] || 0) + n;
          row.calls += n;
          inFile += n;
        }
      }
      const last = rec.last && rec.last[key];
      if (last && (!row.lastUsed || last > Date.parse(row.lastUsed))) row.lastUsed = new Date(last).toISOString();
      if (inFile) {
        const s = sessionsOf.get(id) || sessionsOf.set(id, new Set()).get(id);
        s.add(rec.session || file);
        row.sessions = s.size;
        out.set(id, row);
      }
    }
  }
  const result = {
    schema: SCHEMA, updatedAt: new Date(now).toISOString(), days: span,
    rows: [...out.values()].sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.host < b.host ? -1 : 1)),
  };
  if (write && vault) {
    if (dirty) fsx.writeAtomic(idxPath, JSON.stringify({ schema: SCHEMA, files }) + '\n');
    fsx.writeAtomic(outFile(vault), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

module.exports = { collectUsage, callKey, indexFile, outFile, SCHEMA };
