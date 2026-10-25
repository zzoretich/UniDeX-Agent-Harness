'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SCRIPTS = path.join(__dirname, '..', '..', '..', 'plugin', 'skills', 'persona-flag-closer', 'scripts');
const { collect, defaultRoot, defaultLogDir, verbsFor, KINDS, SURFACES } = require(path.join(SCRIPTS, 'collect.js'));
const { recheck, runRecipe } = require('../persona/recheck.js');   // the runner moved into the vendored runtime (spec 2026-09-22-persona-earned-autonomy-design D1)
const { render } = require(path.join(SCRIPTS, 'render-digest.js'));

const PROPOSAL = (recipe) => `---
slug: fix-thing
filed: 2026-08-10
target: duties/monitor.md (guarded)
recheck: "${recipe}"
autoapply_class: doc-typo
---
## What
change x
## Premises
| Premise | Status | Evidence |
|---|---|---|
| file exists | VERIFIED | ls |
| nobody edited it | ASSUMED | hope |
`;

function vault(recipe = 'true') {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'pfc-'));
  fs.mkdirSync(path.join(v, 'persona', 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(v, 'persona', 'journal', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(v, 'persona', 'proposals', 'README.md'), '# Proposals\n');
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-08-10-fix-thing.md'), PROPOSAL(recipe));
  fs.writeFileSync(path.join(v, 'persona', 'STATE.md'), '# Persona State\n## Flags\n- [ ] open flag\n- [x] closed flag\n## Priorities\n');
  fs.writeFileSync(path.join(v, 'persona', 'journal', 'logs', 'duty-monitor-error.log'), 'boom\n');
  fs.writeFileSync(path.join(v, 'persona', 'journal', 'logs', 'launchd-monitor-error.log'), 'ignored\n');
  return v;
}

test('collect reads proposals, open flags and new duty error-log lines from the vault layout', () => {
  const v = vault();
  const out = collect(v, { updateState: true });
  assert.equal(out.proposals.length, 1);
  assert.equal(out.proposals[0].slug, 'fix-thing');
  assert.equal(out.proposals[0].premises.length, 2);
  assert.deepEqual(out.flags.map(f => f.text), ['open flag']);
  assert.deepEqual(out.logFindings.map(l => path.basename(l.log)), ['duty-monitor-error.log']);
  assert.equal(out.changedSinceLastRun, true);
  assert.ok(fs.existsSync(path.join(v, 'persona', 'flag-closer', 'log-offsets.json')));
  assert.ok(fs.existsSync(path.join(v, 'persona', 'flag-closer', 'last-hash.txt')));
  const again = collect(v, { updateState: false });
  assert.equal(again.logFindings.length, 0, 'offsets consumed');
  assert.equal(again.changedSinceLastRun, false);
});

test('defaultRoot honors AOS_VAULT, then agenticos.json; defaultLogDir follows PERSONA_LOG_DIR', () => {
  const saved = { AOS_VAULT: process.env.AOS_VAULT, AOS_CONFIG: process.env.AOS_CONFIG, PERSONA_LOG_DIR: process.env.PERSONA_LOG_DIR };
  try {
    process.env.AOS_VAULT = '/v1';
    assert.equal(defaultRoot(), '/v1');
    delete process.env.AOS_VAULT;
    const cfg = path.join(os.tmpdir(), `pfc-cfg-${process.pid}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ vault: '/v2' }));
    process.env.AOS_CONFIG = cfg;
    assert.equal(defaultRoot(), '/v2');
    delete process.env.PERSONA_LOG_DIR;
    assert.equal(defaultLogDir('/v2'), path.join('/v2', 'persona', 'journal', 'logs'));
    process.env.PERSONA_LOG_DIR = '/logs';
    assert.equal(defaultLogDir('/v2'), '/logs');
  } finally {
    for (const [k, val] of Object.entries(saved)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
  }
});

test('recheck verdicts; no auto-apply gate (spec 2026-10-24-persona-learning-loop-design D1)', () => {
  assert.equal(runRecipe('true', os.tmpdir()), 'STILL-VALID');
  assert.equal(runRecipe('false', os.tmpdir()), 'STALE');
  assert.equal(runRecipe('exit 127', os.tmpdir()), 'RECIPE-ERROR');
  const v = vault('true');
  fs.writeFileSync(path.join(v, 'persona', 'autoapply.json'), JSON.stringify({ classes: ['doc-typo'] }));
  const review = recheck(collect(v), v);
  assert.equal(review.proposals[0].verdict, 'STILL-VALID');
  assert.equal('autoApply' in review.proposals[0], false, 'a whitelisted class earns nothing');
  assert.equal('autoapply_class' in review.proposals[0], false, 'collect no longer carries the class');
  assert.equal(fs.existsSync(path.join(v, 'persona', 'flag-closer', 'confirmations.json')), false);
  const html = render(review);
  assert.ok(!/auto-apply/i.test(html), 'the digest has no auto-apply column or whitelist');
  assert.match(html, /nothing applies without your decision/);
});

test('render escapes and titles the digest neutrally', () => {
  const v = vault();
  const html = render(recheck(collect(v), v));
  assert.match(html, /<title>Persona Flag Review<\/title>/);
  assert.match(html, /open flag/);
  assert.ok(!html.includes('{{'));
});

test('proposal kind: defaults to self, is read from frontmatter, an unknown value lints; the digest shows a Kind column', () => {
  const v = vault();
  const withKind = (slug, kind) => PROPOSAL('true').replace('slug: fix-thing', `slug: ${slug}`).replace('target:', `kind: ${kind}\ntarget:`);
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-20-idea-two.md'), withKind('idea-two', 'product'));
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-21-odd-three.md'), withKind('odd-three', 'meta'));
  const out = collect(v);
  assert.deepEqual(out.proposals.map(p => [p.slug, p.kind]), [['fix-thing', 'self'], ['idea-two', 'product'], ['odd-three', 'meta']]);
  assert.deepEqual(out.proposals[0].lint, []);
  assert.deepEqual(out.proposals[2].lint, ['unknown kind "meta" (self | vault | workflow | product)']);
  assert.deepEqual(KINDS, ['self', 'vault', 'workflow', 'product']);
  const html = render(recheck(out, v));
  assert.match(html, /<th>Kind · decision<\/th>/);
  assert.match(html, /<td>product<div class="sub">accept → backlog \/ dismiss<\/div><\/td>/);
  assert.match(html, /<td>self<div class="sub">approve \/ reject<\/div><\/td>/);
});

// Spec 2026-09-22-persona-reflect-daily-design D5/D6: an idea gets accept/dismiss, a change gets approve/reject; a
// product proposal names the surface a feature run starts from, and the digest shows it under the target.
test('verbs per kind, and the surface a product proposal names (linted when missing or unknown)', () => {
  assert.deepEqual(verbsFor('self'), { accept: 'Approve', decline: 'Reject', defer: 'Defer', label: 'approve / reject', route: 'apply' });
  assert.deepEqual(verbsFor('vault').accept, 'Approve');
  assert.deepEqual(verbsFor('workflow'), { accept: 'Accept', decline: 'Dismiss', defer: 'Defer', label: 'accept → backlog / dismiss', route: 'backlog' });
  assert.equal(verbsFor('product').route, 'backlog');
  assert.equal(verbsFor(undefined).route, 'apply', 'no kind reads as self');
  assert.deepEqual(SURFACES, ['cli', 'plugin', 'brain', 'hud', 'vault-template', 'docs']);
  const v = vault();
  const withKind = (slug, extra) => PROPOSAL('true').replace('slug: fix-thing', `slug: ${slug}`).replace('target:', `${extra}\ntarget:`);
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-20-hud-idea.md'), withKind('hud-idea', 'kind: product\nsurface: hud'));
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-21-no-surface.md'), withKind('no-surface', 'kind: product'));
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-21-odd-surface.md'), withKind('odd-surface', 'kind: workflow\nsurface: kitchen'));
  const out = collect(v);
  const by = Object.fromEntries(out.proposals.map(p => [p.slug, p]));
  assert.equal(by['hud-idea'].surface, 'hud');
  assert.deepEqual(by['hud-idea'].lint, []);
  assert.equal(by['hud-idea'].verbs.accept, 'Accept');
  assert.equal(by['fix-thing'].surface, null);
  assert.deepEqual(by['fix-thing'].lint, [], 'a self proposal needs no surface');
  assert.deepEqual(by['no-surface'].lint, ['product proposal names no surface (cli | plugin | brain | hud | vault-template | docs)']);
  assert.deepEqual(by['odd-surface'].lint, ['unknown surface "kitchen" (cli | plugin | brain | hud | vault-template | docs)']);
  const html = render(recheck(out, v));
  assert.match(html, /duties\/monitor\.md \(guarded\) · surface: hud<\/div>/);
});
