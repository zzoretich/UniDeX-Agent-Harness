#!/usr/bin/env node
'use strict';
/**
 * recheck.js — deterministic re-verification of pending proposals and the auto-apply gate
 * (docs/design/specs/2026-09-22-persona-earned-autonomy-design.md D1, D2). A proposal's `recheck` recipe re-runs the
 * ORIGINAL check that found the problem:
 *   exit 0                      => STILL-VALID  (the finding is still present; the proposal still applies)
 *   nonzero                     => STALE        (already fixed or the premises changed)
 *   126 / 127 / timeout / spawn => RECIPE-ERROR (the recipe itself is broken)
 *
 *   node recheck.js <collect.json> [--record] [--root <vault>]   the persona-flag-closer review's step 2: verdicts, the
 *                                                                 confirmation count and the auto-apply gate per proposal
 *   node recheck.js record [--root <vault>]                       the tick's precheck: re-run every pending recipe and
 *                                                                 persist the counters — at most once per local day
 *
 * Confirmations: <vault>/persona/flag-closer/confirmations.json, { schema: 1, recordedDay, slugs: { <slug>: n } } — n
 * consecutive days the recipe still exited 0; anything else resets it to 0, a slug no longer pending is dropped. The
 * review reads the file and counts this run in memory without writing it (an interactive review must not inflate the
 * ladder); only `record` writes, and only the first time on a given local day, so the gate's "2 consecutive
 * confirmations" stays two days in `## Pending Proposals`, not two hours. A legacy flat { <slug>: n } file reads as slugs.
 * The gate: the class is listed in <vault>/persona/autoapply.json (missing or corrupt → nothing is whitelisted), the
 * verdict is STILL-VALID and the count is 2 or more. Exit 0 on every path but a usage error (2).
 */
const fs = require('fs');
const path = require('path');
const ledger = require('./ledger.js');
const { parseFrontmatter } = require('./backlog.js');
const { checkRecipe } = require('./recipe.js');

const SCHEMA = 1;
const MIN_CONFIRMATIONS = 2;
const VERDICT = { present: 'STILL-VALID', gone: 'STALE', error: 'RECIPE-ERROR' };

function defaultRoot(root) { return root || require('../lib/paths.js').PATHS.VAULT; }
function files(root) {
  return {
    autoapply: path.join(root, 'persona', 'autoapply.json'),
    confirmations: path.join(root, 'persona', 'flag-closer', 'confirmations.json'),
    proposals: path.join(root, 'persona', 'proposals'),
  };
}

/** Runs one recipe with the vault as cwd (ledger.runRecipe's semantics, the review's verdict names). */
function runRecipe(cmd, cwd) { return VERDICT[ledger.runRecipe(cmd, cwd)]; }

/** { classes } from persona/autoapply.json; missing or corrupt means NOTHING is whitelisted. */
function loadConfig(root) {
  try {
    const c = JSON.parse(fs.readFileSync(files(root).autoapply, 'utf8'));
    return { classes: Array.isArray(c.classes) ? c.classes.filter(x => typeof x === 'string') : [] };
  } catch { return { classes: [] }; }
}

function gateAutoApply(proposal, config, confirmations) {
  if (!proposal.autoapply_class) return { eligible: false, reason: 'no autoapply_class declared' };
  if (!config.classes.includes(proposal.autoapply_class)) return { eligible: false, reason: `class "${proposal.autoapply_class}" not whitelisted` };
  if (proposal.verdict !== 'STILL-VALID') return { eligible: false, reason: `verdict ${proposal.verdict}` };
  const n = confirmations[proposal.slug] || 0;
  if (n < MIN_CONFIRMATIONS) return { eligible: false, reason: `only ${n} consecutive confirmation(s), need ${MIN_CONFIRMATIONS}+` };
  return { eligible: true, reason: `class whitelisted, ${n} confirmations` };
}

const pad = (n) => String(n).padStart(2, '0');
function localDay(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/** The counters file, tolerant of the legacy flat shape and of a corrupt file (read as empty, one stderr line). */
function readConfirmations(root) {
  const file = files(root).confirmations;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[recheck] ${file} unreadable: ${e.message} — starting the counters over`);
    return { schema: SCHEMA, recordedDay: null, slugs: {} };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { schema: SCHEMA, recordedDay: null, slugs: {} };
  const src = j.slugs && typeof j.slugs === 'object' ? j.slugs : j;
  const slugs = {};
  for (const [k, v] of Object.entries(src)) if (k !== 'schema' && k !== 'recordedDay' && Number.isInteger(v) && v >= 0) slugs[k] = v;
  return { schema: SCHEMA, recordedDay: typeof j.recordedDay === 'string' ? j.recordedDay : null, slugs };
}
function writeConfirmations(root, conf) {
  const file = files(root).confirmations;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(conf, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Counts one pass over `proposals` (each { slug, verdict }) into `slugs`, dropping what is no longer pending. */
function tally(slugs, proposals) {
  const next = {};
  for (const p of proposals) next[p.slug] = p.verdict === 'STILL-VALID' ? (slugs[p.slug] || 0) + 1 : 0;
  return next;
}

/** The review's verb: verdicts, the confirmation count (this run included) and the gate per proposal. Writes only with `record`. */
function recheck(review, root, { record = false, now = new Date(), run = runRecipe } = {}) {
  const conf = readConfirmations(root);
  const config = loadConfig(root);
  for (const p of review.proposals) {
    p.verdict = p.recheck ? run(p.recheck, root) : 'NO-RECIPE';
    const c = p.recheck ? checkRecipe(p.recheck) : { ok: true };
    if (!c.ok) p.refused = c.reason;   // RECIPE-ERROR because the grammar refused it (recipe-guard D5): it never ran
  }
  const slugs = tally(conf.slugs, review.proposals);
  for (const p of review.proposals) {
    p.confirmations = slugs[p.slug];
    p.autoApply = gateAutoApply(p, config, slugs);
  }
  if (record && conf.recordedDay !== localDay(now)) writeConfirmations(root, { schema: SCHEMA, recordedDay: localDay(now), slugs });
  review.autoApplyWhitelist = config.classes;
  return review;
}

/** The pending proposals' slug and recipe, from persona/proposals/*.md (README excluded; a missing dir is empty). */
function pendingProposals(root) {
  const dir = files(root).proposals;
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').sort(); } catch { return []; }
  return names.map(f => {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { /* unreadable: no recipe */ }
    const fm = parseFrontmatter(text) || {};
    return { file: path.join(dir, f), slug: fm.slug || f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''), recheck: fm.recheck || null };
  });
}

/** The tick's verb (D2): one confirmation pass per local day; `recorded: false` when today already counted. */
function record({ root, now = new Date(), run = runRecipe } = {}) {
  const conf = readConfirmations(root);
  const day = localDay(now);
  if (conf.recordedDay === day) return { recorded: false, day, slugs: conf.slugs };
  const proposals = pendingProposals(root).map(p => ({ slug: p.slug, verdict: p.recheck ? run(p.recheck, root) : 'NO-RECIPE' }));
  const slugs = tally(conf.slugs, proposals);
  writeConfirmations(root, { schema: SCHEMA, recordedDay: day, slugs });
  return { recorded: true, day, slugs };
}

function main(argv, { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), now = new Date() } = {}) {
  const rootIx = argv.indexOf('--root');
  const positional = argv.filter((a, i) => !a.startsWith('--') && (rootIx < 0 || i !== rootIx + 1));
  let root;
  try { root = defaultRoot(rootIx >= 0 ? argv[rootIx + 1] : null); } catch (e) { stderr(`recheck: ${e.message}\n`); return 2; }
  if (!root) { stderr('recheck: no vault — pass --root <vault> or run `aos init`\n'); return 2; }
  const [input] = positional;
  if (!input) { stderr('usage: recheck.js <collect.json> [--record] | record  [--root <vault>]\n'); return 2; }
  try {
    if (input === 'record') { stdout(JSON.stringify(record({ root, now })) + '\n'); return 0; }
    const review = JSON.parse(fs.readFileSync(input, 'utf8'));
    stdout(JSON.stringify(recheck(review, root, { record: argv.includes('--record'), now }), null, 2) + '\n');
    return 0;
  } catch (e) { stderr(`recheck: ${e.message}\n`); return 0; }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { SCHEMA, MIN_CONFIRMATIONS, localDay, runRecipe, loadConfig, gateAutoApply, readConfirmations, recheck, pendingProposals, record, main };
