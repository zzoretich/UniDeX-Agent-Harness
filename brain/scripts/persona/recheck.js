#!/usr/bin/env node
'use strict';
/**
 * recheck.js — deterministic re-verification of pending proposals for the persona-flag-closer review
 * (docs/design/specs/2026-09-22-persona-earned-autonomy-design.md D1). A proposal's `recheck` recipe re-runs the
 * ORIGINAL check that found the problem:
 *   exit 0                      => STILL-VALID  (the finding is still present; the proposal still applies)
 *   nonzero                     => STALE        (already fixed or the premises changed)
 *   126 / 127 / timeout / spawn => RECIPE-ERROR (the recipe itself is broken)
 *
 *   node recheck.js <collect.json> [--root <vault>]   the review's step 2: a verdict per proposal
 *
 * The earned auto-apply gate, its daily confirmation counters (persona/flag-closer/confirmations.json, the tick's
 * `record` verb) and its whitelist (persona/autoapply.json) are gone (spec 2026-10-24-persona-learning-loop-design D1):
 * nothing applies a proposal without the user's decision, so nothing counts toward one. `--record` is accepted and
 * ignored, for a review skill one release behind. Exit 0 on every path but a usage error (2).
 */
const fs = require('fs');
const ledger = require('./ledger.js');
const { checkRecipe } = require('./recipe.js');

const VERDICT = { present: 'STILL-VALID', gone: 'STALE', error: 'RECIPE-ERROR' };

function defaultRoot(root) { return root || require('../lib/paths.js').PATHS.VAULT; }

/** Runs one recipe with the vault as cwd (ledger.runRecipe's semantics, the review's verdict names). */
function runRecipe(cmd, cwd) { return VERDICT[ledger.runRecipe(cmd, cwd)]; }

/** The review's verb: a verdict per proposal, and `refused` when the recipe grammar refused it (it never ran). */
function recheck(review, root, { run = runRecipe } = {}) {
  for (const p of review.proposals) {
    p.verdict = p.recheck ? run(p.recheck, root) : 'NO-RECIPE';
    const c = p.recheck ? checkRecipe(p.recheck) : { ok: true };
    if (!c.ok) p.refused = c.reason;   // RECIPE-ERROR because the grammar refused it (recipe-guard D5): it never ran
  }
  return review;
}

function main(argv, { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  const rootIx = argv.indexOf('--root');
  const positional = argv.filter((a, i) => !a.startsWith('--') && (rootIx < 0 || i !== rootIx + 1));
  let root;
  try { root = defaultRoot(rootIx >= 0 ? argv[rootIx + 1] : null); } catch (e) { stderr(`recheck: ${e.message}\n`); return 2; }
  if (!root) { stderr('recheck: no vault — pass --root <vault> or run `aos init`\n'); return 2; }
  const [input] = positional;
  if (!input || input === 'record') { stderr('usage: recheck.js <collect.json> [--root <vault>]\n'); return 2; }
  try {
    const review = JSON.parse(fs.readFileSync(input, 'utf8'));
    stdout(JSON.stringify(recheck(review, root), null, 2) + '\n');
    return 0;
  } catch (e) { stderr(`recheck: ${e.message}\n`); return 0; }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { runRecipe, recheck, main };
