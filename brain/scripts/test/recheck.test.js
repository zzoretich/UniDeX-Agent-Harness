'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../persona/recheck.js');

const PROPOSAL = (slug, recipe) => `---
slug: ${slug}
filed: 2026-09-10
target: duties/monitor.md (guarded)
recheck: "${recipe}"
autoapply_class: doc-typo
---
## What
change x
`;
function vault(proposals = { 'fix-thing': 'true' }) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-'));
  fs.mkdirSync(path.join(v, 'persona', 'proposals'), { recursive: true });
  fs.writeFileSync(path.join(v, 'persona', 'proposals', 'README.md'), '# Proposals\n');
  for (const [slug, recipe] of Object.entries(proposals)) fs.writeFileSync(path.join(v, 'persona', 'proposals', `2026-09-10-${slug}.md`), PROPOSAL(slug, recipe));
  return v;
}
const io = () => { const o = { out: '', err: '' }; return { o, opts: { stdout: (s) => { o.out += s; }, stderr: (s) => { o.err += s; } } }; };

test('runRecipe maps exit codes to the review verdicts', () => {
  assert.equal(R.runRecipe('true', os.tmpdir()), 'STILL-VALID');
  assert.equal(R.runRecipe('false', os.tmpdir()), 'STALE');
  assert.equal(R.runRecipe('exit 127', os.tmpdir()), 'RECIPE-ERROR');
});

test('recheck gives each proposal a verdict and nothing else: no gate, no counters, nothing written', () => {
  const v = vault();
  const review = R.recheck({ proposals: [
    { slug: 'fix-thing', recheck: 'true', autoapply_class: 'doc-typo' },
    { slug: 'gone', recheck: 'false' },
    { slug: 'legacy' },
  ] }, v);
  assert.deepEqual(review.proposals.map((p) => p.verdict), ['STILL-VALID', 'STALE', 'NO-RECIPE']);
  for (const p of review.proposals) {
    assert.equal('autoApply' in p, false, 'spec 2026-10-24-persona-learning-loop-design D1: no auto-apply gate');
    assert.equal('confirmations' in p, false);
  }
  assert.equal('autoApplyWhitelist' in review, false);
  assert.equal(fs.existsSync(path.join(v, 'persona', 'flag-closer', 'confirmations.json')), false);
});

test('a recipe outside the read-only grammar is RECIPE-ERROR with its reason and never runs', () => {
  const v = vault({ 'bad-one': 'mkdir ran-it' });
  const review = R.recheck({ proposals: [{ slug: 'bad-one', recheck: 'mkdir ran-it' }] }, v);
  assert.equal(review.proposals[0].verdict, 'RECIPE-ERROR');
  assert.equal(review.proposals[0].refused, "'mkdir' is not an allowed read-only command");
  assert.equal(fs.existsSync(path.join(v, 'ran-it')), false);
});

test('CLI: a review file is rechecked (--record accepted and ignored); the retired record verb and no input exit 2', () => {
  const v = vault();
  const collect = path.join(v, 'collect.json');
  fs.writeFileSync(collect, JSON.stringify({ proposals: [{ slug: 'fix-thing', recheck: 'true', autoapply_class: 'doc-typo' }] }));
  let { o, opts } = io();
  assert.equal(R.main([collect, '--record', '--root', v], opts), 0);
  assert.equal(JSON.parse(o.out).proposals[0].verdict, 'STILL-VALID');
  assert.equal(fs.existsSync(path.join(v, 'persona', 'flag-closer', 'confirmations.json')), false, '--record writes nothing');
  ({ o, opts } = io());
  assert.equal(R.main(['record', '--root', v], opts), 2);
  assert.match(o.err, /usage/);
  ({ o, opts } = io());
  assert.equal(R.main(['--root', v], opts), 2);
  ({ o, opts } = io());
  assert.equal(R.main([path.join(v, 'missing.json'), '--root', v], opts), 0);
  assert.match(o.err, /recheck: /);
});

test('CLI: without --root the review file is still the first argument (the flag-closer calls it that way)', () => {
  const v = vault();
  const collect = path.join(v, 'collect.json');
  fs.writeFileSync(collect, JSON.stringify({ proposals: [{ slug: 'fix-thing', recheck: 'true' }] }));
  const { o, opts } = io();
  assert.equal(R.main([collect], opts), 0);
  assert.equal(o.err, '');
  assert.equal(JSON.parse(o.out).proposals[0].verdict, 'STILL-VALID');
});
