#!/usr/bin/env node
'use strict';
/**
 * reflect.js — the runner-side half of the nightly `reflect-daily` duty (docs/design/specs/2026-09-22-persona-reflect-daily-design.md).
 * The duty is a model run (persona/duties/reflect-daily.md through run-duty.sh, 0.50 USD); this script drains the
 * tick's queue deterministically and hands both reflects one evidence pack. run-duty.sh calls two verbs around the model:
 *
 *   precheck   snapshots the queue (<vault>/persona/queue.jsonl) into the state's `pending` and exits 3 — the runner
 *              skips the model — only when the queue is empty AND a daily reflect already drained today (an early run
 *              started by the tick counts as that day's reflect).
 *   beat       after the duty met its contract: removes exactly the snapshotted entries (identity ts + type + source)
 *              from the queue by an atomic rewrite, so a signal queued during the model run survives, and records
 *              `lastDrain`. Unreadable lines are dropped with one stderr note (no reader could use them).
 *
 * and the model calls one more:
 *
 *   inputs [--days N]   one JSON pack for the daily (7 days) and the Sunday (28 days) reflect: the pending queue grouped
 *                       by type with each source's title, the ledger summary, duty health from brain/_index/routines.json,
 *                       spend per duty from brain/_index/provider-spend.jsonl, feedback memories and drafts modified in
 *                       the window, agent-runs per day, and (spec 2026-09-22-persona-earned-autonomy-design D4) the auto-apply
 *                       ladder: the whitelisted classes, persona.autoapply.minVerified and the candidates the ledger's class
 *                       stats earned, minus any class with an open or rejected `autoapply-<class>` proposal. Every source may
 *                       be missing; the pack says so instead of failing.
 *
 * State: brain/_index/persona-reflect.json (schema 1). Every path is injectable; --root <vault> for the CLI.
 * Exit codes: precheck 3 = skip; 2 = usage; 0 otherwise (a failure inside precheck or beat is reported on stderr and
 * exits 0 so the duty still runs). Under AOS_HEADLESS=1 (a duty) --root must be the vault, or it exits 2
 * (lib/pin-root.js, spec 2026-09-23-duty-write-scope-design D3).
 */
const fs = require('fs');
const path = require('path');
const { assertPinned } = require('../lib/pin-root.js');

const SCHEMA = 1;
const EXIT_SKIP = 3;
const DEFAULT_DAYS = 7;
const DAY_MS = 86400e3;
const FEEDBACK_CAP = 40;

function defaultDeps(root) {
  const vault = root || require('../lib/paths.js').PATHS.VAULT;
  let config = () => ({});
  try { ({ loadConfig: config } = require('../lib/config.js')); } catch { /* no config module: defaults */ }
  return { vault, config, now: () => new Date() };
}

function files(deps) {
  const v = deps.vault;
  return {
    state: path.join(v, 'brain', '_index', 'persona-reflect.json'),
    queue: path.join(v, 'persona', 'queue.jsonl'),
    ledger: path.join(v, 'persona', 'ledger.jsonl'),
    routines: path.join(v, 'brain', '_index', 'routines.json'),
    spend: path.join(v, 'brain', '_index', 'provider-spend.jsonl'),
    agentRuns: path.join(v, 'brain', '_index', 'agent-runs'),
    duties: path.join(v, 'persona', 'duties'),
    feedback: path.join(v, 'brain', 'memory', 'feedback'),
    drafts: path.join(v, 'brain', 'memory', 'feedback', '_drafts'),
    autoapply: path.join(v, 'persona', 'autoapply.json'),
  };
}

function readJson(file, what) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    console.error(`[reflect] ${file} is not a JSON object — treating ${what} as empty`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[reflect] ${file} unreadable: ${e.message} — treating ${what} as empty`);
  }
  return null;
}
/** Valid queue records plus the count of lines nobody can read. */
function readQueue(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { entries: [], bad: 0 }; }
  const entries = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && typeof r.type === 'string' && typeof r.source === 'string') entries.push(r); else bad++;
    } catch { bad++; }
  }
  return { entries, bad };
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readState(deps) {
  const s = readJson(files(deps).state, 'the reflect state');
  return s && s.schema === SCHEMA ? s : { schema: SCHEMA, lastDrainAt: null, lastDrain: null, drains: 0, skipped: 0, lastPrecheckAt: null, pending: null };
}
function writeState(deps, s) { writeAtomic(files(deps).state, JSON.stringify(s, null, 2) + '\n'); }

const pad = (n) => String(n).padStart(2, '0');
/** The runner names the journal by the local day, so "drained today" is local too. */
function localDay(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function identity(e) { return `${e.ts}\u0000${e.type}\u0000${e.source}`; }
function byType(entries) {
  const out = {};
  for (const e of entries) out[e.type] = (out[e.type] || 0) + 1;
  return out;
}

/** Runner verb. Snapshots the queue; `run: false` means the runner skips the model call. */
function precheck({ deps = defaultDeps(), now = deps.now() } = {}) {
  const s = readState(deps);
  const { entries } = readQueue(files(deps).queue);
  const drainedToday = !!s.lastDrainAt && localDay(new Date(s.lastDrainAt)) === localDay(now);
  const run = entries.length > 0 || !drainedToday;
  s.lastPrecheckAt = now.toISOString();
  s.pending = run ? { at: s.lastPrecheckAt, count: entries.length, ids: entries.map(identity) } : null;
  if (!run) s.skipped = (s.skipped || 0) + 1;
  writeState(deps, s);
  const reason = run ? (entries.length ? `${entries.length} signal(s) queued` : 'nothing drained today') : 'queue empty and already drained today';
  return { run, reason, pending: entries.length };
}

/** Runner verb. Drains the snapshot (or, without one, everything queued now) and keeps the rest. */
function beat({ deps = defaultDeps(), now = deps.now() } = {}) {
  const s = readState(deps);
  const f = files(deps);
  const { entries, bad } = readQueue(f.queue);
  const ids = s.pending && Array.isArray(s.pending.ids) ? new Set(s.pending.ids) : null;
  const drained = ids ? entries.filter(e => ids.has(identity(e))) : entries;
  const kept = ids ? entries.filter(e => !ids.has(identity(e))) : [];
  if (bad) console.error(`[reflect] ${f.queue}: dropped ${bad} unreadable line(s) on drain`);
  if (fs.existsSync(f.queue) || kept.length) writeAtomic(f.queue, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
  s.lastDrainAt = now.toISOString();
  s.lastDrain = { count: drained.length, byType: byType(drained) };
  s.drains = (s.drains || 0) + 1;
  s.pending = null;
  writeState(deps, s);
  return { drained: drained.length, kept: kept.length, byType: s.lastDrain.byType, lastDrainAt: s.lastDrainAt };
}

function mtime(file) { try { return Math.round(fs.statSync(file).mtimeMs); } catch { return null; } }
function listMd(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name).sort(); } catch { return []; }
}
function firstHeading(file) {
  try { const m = /^#\s+(.+)$/m.exec(fs.readFileSync(file, 'utf8')); return m ? m[1].trim().slice(0, 120) : null; } catch { return null; }
}
function rel(deps, file) { return path.relative(deps.vault, file).split(path.sep).join('/'); }
/** A queue source is `<vault-relative path>[#anchor]` or `<repo>:<path>`; the title is the note's H1 when the path is a vault note. */
function sourceTitle(deps, source) {
  const file = String(source).split('#')[0];
  if (!file.endsWith('.md') || file.includes(':')) return null;
  return firstHeading(path.join(deps.vault, file));
}
function round(n) { return Math.round(n * 1e4) / 1e4; }

function queueSection(deps) {
  const { entries } = readQueue(files(deps).queue);
  const grouped = {};
  for (const e of entries) {
    (grouped[e.type] = grouped[e.type] || []).push({ ts: e.ts || null, source: e.source, note: e.note || null, title: sourceTitle(deps, e.source) });
  }
  return { count: entries.length, byType: grouped };
}
function dutiesSection(deps) {
  const f = files(deps);
  const slugs = listMd(f.duties).map(n => n.slice(0, -3)).sort();
  const st = readJson(f.routines, 'the routine state');
  const rows = (st && st.routines && typeof st.routines === 'object') ? st.routines : {};
  return slugs.map(slug => {
    const r = rows[slug] || {};
    return { slug, lastRunAt: r.lastRunAt || null, lastExit: typeof r.lastExit === 'number' ? r.lastExit : null, failStreak: Number(r.failStreak) || 0, lastTrigger: r.lastTrigger || null, lastError: r.lastError || null };
  });
}
function spendSection(deps, since) {
  let text = '';
  try { text = fs.readFileSync(files(deps).spend, 'utf8'); } catch { return { window: 'no ledger', perDuty: {} }; }
  const per = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.feature !== 'string' || !r.feature.startsWith('duty:')) continue;
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || t < since) continue;
    const slug = r.feature.slice(5);
    const usd = Number(r.usd) || 0;
    const p = per[slug] || (per[slug] = { runs: 0, usd: 0, mean: 0, max: 0, lastAt: null });
    p.runs++; p.usd += usd; p.max = Math.max(p.max, usd);
    if (!p.lastAt || t > Date.parse(p.lastAt)) p.lastAt = r.ts;
  }
  for (const p of Object.values(per)) { p.mean = round(p.usd / p.runs); p.usd = round(p.usd); p.max = round(p.max); }
  return { window: 'duty:* rows', perDuty: per };
}
function feedbackSection(deps, since) {
  const f = files(deps);
  const pick = (dir) => listMd(dir)
    .map(name => ({ file: rel(deps, path.join(dir, name)), at: mtime(path.join(dir, name)) }))
    .filter(x => x.at !== null && x.at > since)
    .sort((a, b) => b.at - a.at).slice(0, FEEDBACK_CAP)
    .map(x => ({ file: x.file, title: firstHeading(path.join(deps.vault, x.file)) || path.basename(x.file, '.md'), at: new Date(x.at).toISOString() }));
  return { memories: pick(f.feedback), drafts: pick(f.drafts) };
}
function agentRunsSection(deps, since) {
  const dir = files(deps).agentRuns;
  const sinceDay = localDay(new Date(since));
  let days = [];
  try { days = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && e.name >= sinceDay).map(e => e.name).sort(); } catch { return []; }
  return days.map(day => {
    const row = { day, sessions: 0, notOk: 0, usd: 0 };
    let names = [];
    try { names = fs.readdirSync(path.join(dir, day)).filter(n => n.endsWith('.json')); } catch { return row; }
    for (const n of names) {
      const j = readJson(path.join(dir, day, n), 'an agent run');
      const s = j && j.summary && typeof j.summary === 'object' ? j.summary : j;
      if (!s) continue;
      row.sessions++;
      if (s.status && s.status !== 'ok') row.notOk++;
      row.usd += Number(s.cost_usd) || 0;
    }
    row.usd = round(row.usd);
    return row;
  });
}

/** The ladder (D4): whitelisted classes, the bar, and the candidates minus classes already proposed (open) or refused (rejected). */
function autoapplySection(deps, ledgerSummary, records) {
  const L = require('./ledger.js');
  const cfg = deps.config() || {};
  const a = (cfg.persona && cfg.persona.autoapply) || {};
  const minVerified = Number.isFinite(a.minVerified) && a.minVerified > 0 ? a.minVerified : L.DEFAULT_MIN_VERIFIED;
  const j = readJson(files(deps).autoapply, 'the auto-apply whitelist');
  const classes = j && Array.isArray(j.classes) ? j.classes.filter(c => typeof c === 'string') : [];
  const open = new Set((ledgerSummary && ledgerSummary.open) || []);
  const rejected = new Set(records.filter(r => r.event === 'rejected').map(r => r.slug));
  const candidates = L.autoapplyCandidates((ledgerSummary && ledgerSummary.byClass) || {}, { minVerified, whitelisted: classes })
    .filter(c => !open.has(`autoapply-${c.class}`) && !rejected.has(`autoapply-${c.class}`));
  return { classes, minVerified, candidates };
}

/** Model verb. The evidence pack for a reflect over the last `days`. */
function inputs({ deps = defaultDeps(), now = deps.now(), days = DEFAULT_DAYS } = {}) {
  const d = Number(days) > 0 ? Number(days) : DEFAULT_DAYS;
  const since = now.getTime() - d * DAY_MS;
  let ledger = null, records = [];
  try {
    const L = require('./ledger.js');
    ledger = L.summary({ file: files(deps).ledger, days: d, now });
    records = L.read({ file: files(deps).ledger });
  } catch (e) { console.error(`[reflect] ledger summary failed: ${e.message}`); }
  let autoapply = { classes: [], minVerified: null, candidates: [] };
  try { autoapply = autoapplySection(deps, ledger, records); } catch (e) { console.error(`[reflect] autoapply section failed: ${e.message}`); }
  // `today` leads the pack: the ISO stamps below are UTC, and a model dating its journal entry from generatedAt
  // files it under tomorrow for the last local hours of every day west of UTC.
  return {
    schema: SCHEMA, today: localDay(now), days: d, since: new Date(since).toISOString(), generatedAt: now.toISOString(),
    lastDrainAt: readState(deps).lastDrainAt,
    queue: queueSection(deps),
    ledger,
    duties: dutiesSection(deps),
    spend: spendSection(deps, since),
    feedback: feedbackSection(deps, since),
    agentRuns: agentRunsSection(deps, since),
    autoapply,
  };
}

const VALUE_FLAGS = ['--root', '--days'];
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.includes(argv[i])) { i++; continue; }
    if (String(argv[i]).startsWith('--')) continue;
    out.push(argv[i]);
  }
  return out;
}

function main(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };
  const [verb] = positionals(argv);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  try { assertPinned({ root: arg('--root') }); } catch (e) { process.stderr.write(`reflect: ${e.message}\n`); return 2; }
  let deps;
  try { deps = defaultDeps(arg('--root')); } catch (e) { process.stderr.write(`reflect: ${e.message}\n`); return 0; }
  try {
    switch (verb) {
      case 'precheck': { const r = precheck({ deps }); out(r); return r.run ? 0 : EXIT_SKIP; }
      case 'beat': out(beat({ deps })); return 0;
      case 'inputs': process.stdout.write(JSON.stringify(inputs({ deps, days: arg('--days') }), null, 2) + '\n'); return 0;
      case 'status': out(readState(deps)); return 0;
      default:
        process.stderr.write('usage: reflect.js precheck|beat|inputs [--days N]|status [--root <vault>]\n');
        return 2;
    }
  } catch (e) {
    process.stderr.write(`reflect ${verb}: ${e.message}\n`);
    return 0;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { SCHEMA, EXIT_SKIP, DEFAULT_DAYS, localDay, identity, readQueue, precheck, beat, inputs, readState, positionals, main };
