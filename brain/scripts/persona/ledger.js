#!/usr/bin/env node
'use strict';
/**
 * ledger.js — the proposal outcome ledger: <vault>/persona/ledger.jsonl, append-only, one JSON event per
 * line. It is the persona's track record: what reflect filed, what the user approved or rejected, and
 * whether an approved change held. Written only through this module; readers are the watchdog (verify),
 * the reflect duty (summary) and the flag-closer skill (append).
 *
 *   node ledger.js append <event> <slug> [--kind self|vault|workflow|product] [--target <text>] [--by <who>]
 *                                        [--class <autoapply_class>] [--recheck <sh>] [--commit <sha>] [--note <text>]
 *   node ledger.js verify                re-run the recheck recipe of every approval aged 1–14 days that has no
 *                                        verdict yet; append `regressed` (exit 0 again) or, after 7 days clean,
 *                                        `verified`. Prints one JSON line.
 *   node ledger.js summary [--days N] [--json]
 *   node ledger.js run-recipe '<recheck>'  run one recipe through the gate (the flag-closer's Approve and auto-apply
 *                                        lanes): prints present | gone | error | refused: <reason>, exit 0
 *   Every verb takes --root <vault> (default: the resolved vault) or --file <path>; under AOS_HEADLESS=1 both must name
 *   the vault and its own ledger (lib/pin-root.js, spec 2026-09-23-duty-write-scope-design D3).
 *
 * Recipes run only through runRecipe(), which refuses anything outside the read-only grammar in recipe.js before a
 * shell sees it (spec 2026-09-23-recipe-guard-design D1). `approved` and `auto-applied` are refused under
 * AOS_HEADLESS=1 — every duty runs headless, so only an interactive review can record an approval (D2).
 *
 * Line shape: { schema: 1, ts, event, slug, kind, target, by, class?, recheck?, commit?, note? }. `class` was the
 * proposal's autoapply_class for the retired auto-apply ladder (spec 2026-10-24-persona-learning-loop-design D1): it is
 * still accepted and kept on old lines, and nothing counts it. `auto-applied` stays readable for old ledgers; nothing
 * writes it any more.
 * Events: filed · approved · rejected · stale-dropped · auto-applied · verified · regressed, plus the two verbs an idea
 * (kind workflow or product) gets instead of approve/reject: accepted (kept in persona/backlog.md) · dismissed.
 * A corrupt line is skipped with one stderr warning (the twin of loadRepos() in sitrep-state.js).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkRecipe } = require('./recipe.js');
const { assertPinned } = require('../lib/pin-root.js');

const SCHEMA = 1;
const EVENTS = ['filed', 'approved', 'rejected', 'stale-dropped', 'auto-applied', 'verified', 'regressed', 'accepted', 'dismissed', 'undone'];
const KINDS = ['self', 'vault', 'workflow', 'product'];
const DECISIONS = ['filed', 'approved', 'rejected', 'accepted', 'dismissed'];
const TERMINAL = new Set(['approved', 'rejected', 'stale-dropped', 'auto-applied', 'accepted', 'dismissed']);
const APPLIED = new Set(['approved', 'auto-applied']);
const VERDICTS = new Set(['verified', 'regressed', 'undone']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const CLASS_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DAY_MS = 86400e3;

function defaultFile(root) {
  const vault = root || require('../lib/paths.js').PATHS.VAULT;
  return path.join(vault, 'persona', 'ledger.jsonl');
}

function read({ file } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[ledger] ${file} unreadable: ${e.message} — treating it as empty`);
    return [];
  }
  const out = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && typeof r.event === 'string' && typeof r.slug === 'string') out.push(r);
      else bad++;
    } catch { bad++; }
  }
  if (bad) console.error(`[ledger] ${file}: skipped ${bad} unreadable line(s)`);
  return out;
}

function validate(rec) {
  const errors = [];
  if (!EVENTS.includes(rec.event)) errors.push(`event must be one of ${EVENTS.join(', ')}`);
  if (!SLUG_RE.test(String(rec.slug || ''))) errors.push('slug must be kebab-case (2–61 chars)');
  if (rec.kind !== undefined && rec.kind !== null && !KINDS.includes(rec.kind)) errors.push(`kind must be one of ${KINDS.join(', ')}`);
  if (rec.class !== undefined && rec.class !== null && !CLASS_RE.test(String(rec.class))) errors.push('class must be kebab-case (1–41 chars)');
  for (const k of ['target', 'by', 'recheck', 'commit', 'note']) {
    if (rec[k] !== undefined && rec[k] !== null && typeof rec[k] !== 'string') errors.push(`${k} must be a string`);
  }
  return errors;
}

/** Appends one event and returns the record as written. Throws on a validation error. */
function append(rec, { file, now = new Date() } = {}) {
  const errors = validate(rec);
  if (errors.length) { const e = new Error(`invalid ledger event: ${errors.join('; ')}`); e.errors = errors; throw e; }
  if (APPLIED.has(rec.event) && process.env.AOS_HEADLESS === '1') {
    throw new Error(`${rec.event} needs an interactive session: a headless run (AOS_HEADLESS=1) never records an approval`);
  }
  const r = { schema: SCHEMA, ts: now.toISOString(), event: rec.event, slug: rec.slug, kind: rec.kind || 'self', target: rec.target || null, by: rec.by || null };
  for (const k of ['class', 'recheck', 'commit', 'note']) if (rec[k]) r[k] = rec[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(r) + '\n');
  return r;
}

/** Runs a recheck recipe the way the flag-closer does: exit 0 = the finding is present. A recipe outside the read-only
 *  grammar (recipe.js) is never spawned and reads as 'error'. */
function runRecipe(cmd, cwd) {
  if (!checkRecipe(cmd).ok) return 'error';
  try {
    execFileSync('/bin/sh', ['-c', cmd], { cwd, timeout: 15000, stdio: 'ignore' });
    return 'present';
  } catch (e) {
    if (e.status === 126 || e.status === 127) return 'error';
    if (typeof e.status === 'number') return 'gone';
    return 'error';   // timeout or spawn failure
  }
}

function ts(r) { const t = Date.parse(r.ts); return Number.isFinite(t) ? t : NaN; }

/** Approvals with a recipe and no verdict since; each gets exactly one of verified / regressed in the end. */
function unverified(records) {
  return records.filter(a => APPLIED.has(a.event) && a.recheck && Number.isFinite(ts(a)) &&
    !records.some(r => r.slug === a.slug && VERDICTS.has(r.event) && ts(r) >= ts(a)));
}

/**
 * The verification pass (spec D8). An approval aged under `minDays` is left to settle; one whose recipe exits 0
 * again is `regressed` at once; one clean for `settleDays` is `verified`. Beyond `maxDays` nothing is checked —
 * the summary lists it as unverified. A broken recipe is skipped, never judged.
 */
function verify({ file, root, now = new Date(), run = runRecipe, minDays = 1, settleDays = 7, maxDays = 14 } = {}) {
  const records = read({ file });
  const out = { checked: 0, verified: [], regressed: [], skipped: 0 };
  for (const a of unverified(records)) {
    const ageDays = (now - ts(a)) / DAY_MS;
    if (ageDays < minDays || ageDays > maxDays) continue;
    out.checked++;
    const res = run(a.recheck, root);
    const base = { slug: a.slug, kind: a.kind, target: a.target, by: 'watchdog', class: a.class || null };
    if (res === 'present') {
      append({ ...base, event: 'regressed', note: `recheck exits 0 again ${Math.floor(ageDays)}d after approval` }, { file, now });
      out.regressed.push(a.slug);
    } else if (res === 'gone' && ageDays >= settleDays) {
      append({ ...base, event: 'verified', note: `recheck clean for ${Math.floor(ageDays)}d` }, { file, now });
      out.verified.push(a.slug);
    } else if (res === 'error') out.skipped++;
  }
  return out;
}

/** Counts over the last `days`, plus the all-time open (filed, undecided) and unverified slugs. */
function summary({ file, days = 28, now = new Date() } = {}) {
  const records = read({ file });
  const since = now - days * DAY_MS;
  const win = records.filter(r => ts(r) >= since);
  const counts = Object.fromEntries(EVENTS.map(e => [e, 0]));
  const blank = () => Object.fromEntries(DECISIONS.map(e => [e, 0]));
  const byKind = Object.fromEntries(KINDS.map(k => [k, blank()]));
  for (const r of win) {
    counts[r.event] = (counts[r.event] || 0) + 1;
    const k = byKind[r.kind] || (byKind[r.kind] = blank());
    if (r.event in k) k[r.event]++;
  }
  const decided = counts.approved + counts.rejected;
  const judged = counts.accepted + counts.dismissed;
  const bySlug = new Map();
  for (const r of records) { if (!bySlug.has(r.slug)) bySlug.set(r.slug, []); bySlug.get(r.slug).push(r); }
  const open = [];
  for (const [slug, evs] of bySlug) {
    const filed = evs.filter(e => e.event === 'filed').pop();
    if (filed && !evs.some(e => TERMINAL.has(e.event) && ts(e) >= ts(filed))) open.push(slug);
  }
  return {
    days, total: win.length, counts, byKind,
    approvalRate: decided ? Math.round((counts.approved / decided) * 100) / 100 : null,
    acceptRate: judged ? Math.round((counts.accepted / judged) * 100) / 100 : null,
    regressed: win.filter(r => r.event === 'regressed').map(r => r.slug),
    verified: win.filter(r => r.event === 'verified').map(r => r.slug),
    dismissed: win.filter(r => r.event === 'dismissed').map(r => r.slug),
    open: open.sort(),
    unverified: unverified(records).map(a => a.slug).sort(),
  };
}

function formatSummary(s) {
  const applied = ['self', 'vault'].map(k => `${k} ${s.byKind[k].filed}/${s.byKind[k].approved}/${s.byKind[k].rejected}`).join(' · ');
  const ideas = ['workflow', 'product'].map(k => `${k} ${s.byKind[k].filed}/${s.byKind[k].accepted}/${s.byKind[k].dismissed}`).join(' · ');
  return [
    `ledger: last ${s.days}d — ${s.total} event(s)`,
    `  filed ${s.counts.filed} · approved ${s.counts.approved} · rejected ${s.counts.rejected} · stale-dropped ${s.counts['stale-dropped']}${s.counts['auto-applied'] ? ` · auto-applied ${s.counts['auto-applied']}` : ''} · accepted ${s.counts.accepted} · dismissed ${s.counts.dismissed}${s.dismissed.length ? ` (${s.dismissed.join(', ')})` : ''}`,
    `  verified ${s.counts.verified} · regressed ${s.counts.regressed}${s.regressed.length ? ` (${s.regressed.join(', ')})` : ''} · approval rate ${s.approvalRate === null ? 'n/a' : s.approvalRate} · accept rate ${s.acceptRate === null ? 'n/a' : s.acceptRate}`,
    `  by kind (filed/approved/rejected): ${applied} · (filed/accepted/dismissed): ${ideas}`,
    `  open: ${s.open.length ? s.open.join(', ') : 'none'} · unverified approvals: ${s.unverified.length ? s.unverified.join(', ') : 'none'}`,
  ].join('\n');
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1]; i++; }
    else positional.push(a);
  }
  return { flags, positional };
}

function main(argv, { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), now = new Date() } = {}) {
  const { flags, positional } = parseArgs(argv);
  const [verb, event, slug] = positional;
  let file;
  try {
    assertPinned({ root: flags.root, file: flags.file, fileRel: path.join('persona', 'ledger.jsonl') });
    file = flags.file || defaultFile(flags.root);
  } catch (e) { stderr(`ledger: ${e.message}\n`); return 2; }
  const root = flags.root || path.dirname(path.dirname(file));
  if (verb === 'append') {
    if (!event || !slug) { stderr('usage: ledger.js append <event> <slug> [--kind k] [--target t] [--by who] [--class c] [--recheck sh] [--commit sha] [--note text]\n'); return 2; }
    try {
      const r = append({ event, slug, kind: flags.kind, target: flags.target, by: flags.by, class: flags.class, recheck: flags.recheck, commit: flags.commit, note: flags.note }, { file, now });
      stdout(JSON.stringify(r) + '\n');
      return 0;
    } catch (e) { stderr(`ledger: ${e.message}\n`); return 2; }
  }
  if (verb === 'verify') { stdout(JSON.stringify(verify({ file, root, now })) + '\n'); return 0; }
  if (verb === 'run-recipe') {
    const cmd = positional[1];
    if (!cmd) { stderr("usage: ledger.js run-recipe '<recheck>' [--root <vault>]\n"); return 2; }
    const c = checkRecipe(cmd);
    stdout(`${c.ok ? runRecipe(cmd, root) : `refused: ${c.reason}`}\n`);
    return 0;
  }
  if (verb === 'summary') {
    const days = Number(flags.days) > 0 ? Number(flags.days) : 28;
    const s = summary({ file, days, now });
    stdout(flags.json ? JSON.stringify(s, null, 2) + '\n' : formatSummary(s) + '\n');
    return 0;
  }
  stderr('usage: ledger.js append|verify|summary|run-recipe [--root <vault>|--file <path>]\n');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { SCHEMA, EVENTS, KINDS, DECISIONS, defaultFile, read, validate, append, runRecipe, verify, summary, formatSummary, main };
