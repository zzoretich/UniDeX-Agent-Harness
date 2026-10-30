'use strict';
// Spec 2026-10-24-persona-learning-loop-design D13: a release's Chief of Staff prompts reach an existing vault as
// proposals — never by rewriting the guarded files — and a render the user rejected is not filed again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../persona/interview.js');
const L = require('../persona/ledger.js');
const P = require('../persona/prompt-updates.js');
const Exact = require('../persona/proposal.js');
const { checkRecipe } = require('../persona/recipe.js');

const TEMPLATES = path.join(__dirname, '..', '..', '..', 'vault-template', 'persona');
const ANSWERS = { name: 'Atlas', addressAs: 'boss', voice: 'dry, brief', priorities: 'shipping, tests', dutyModel: 'haiku', dutyEffort: 'medium', schedule: 'no' };
const NODE = '/opt/node/bin/node';
const SETUP = new Date('2026-09-04T12:00:00');
const LATER = new Date('2026-10-24T12:00:00');

/** A vault the interview set up on SETUP, from the shipped templates. */
function setUp() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-prompts-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-prompts-cfg-'));
  I.writePersona({ vault, configDir, templatesDir: TEMPLATES, answers: I.normalizeAnswers(ANSWERS, {}), node: NODE, now: SETUP });
  return vault;
}
const run = (vault, over = {}) => P.file({ vault, node: NODE, version: '9.9.9', deps: { templatesDir: TEMPLATES, now: LATER, html: { render() {} }, ...over } });
const proposals = (vault) => fs.readdirSync(path.join(vault, 'persona', 'proposals')).filter((f) => f !== 'README.md').sort();
const read = (vault, rel) => fs.readFileSync(path.join(vault, rel), 'utf8');

test('a vault on the shipped prompts gets no proposal, the identity\'s own date included', () => {
  const vault = setUp();
  const r = run(vault);
  assert.deepEqual(r.filed, []);
  assert.deepEqual(r.unchanged.sort(), ['IDENTITY.md', ...I.DUTIES.map((d) => `duties/${d}.md`)].sort(), 'IDENTITY.md rendered on another day is not a change');
  assert.deepEqual(proposals(vault), []);
});

test('a prompt that differs becomes one self proposal: the whole new text, the diff, a cmp recheck, a ledger line', () => {
  const vault = setUp();
  const rel = 'persona/duties/reflect-daily.md';
  const shipped = read(vault, rel);
  fs.writeFileSync(path.join(vault, rel), shipped.replace('Budget is 0.50 USD', 'Budget is 2.00 USD'));
  const r = run(vault);
  assert.deepEqual(r.filed, ['update-duty-reflect-daily']);
  assert.deepEqual(proposals(vault), ['2026-10-24-update-duty-reflect-daily.md']);
  const text = read(vault, 'persona/proposals/2026-10-24-update-duty-reflect-daily.md');
  assert.match(text, /^slug: update-duty-reflect-daily$/m);
  assert.match(text, /^kind: self$/m);
  assert.match(text, /^target: persona\/duties\/reflect-daily\.md \(guarded\)$/m);
  assert.match(text, /^# Update the reflect-daily duty's prompt to the one UniDeX 9\.9\.9 ships$/m);
  const recipe = /^recheck: "(.*)"$/m.exec(text)[1];
  assert.equal(recipe, '! cmp -s persona/duties/reflect-daily.md brain/_index/persona-prompts/duties/reflect-daily.md');
  assert.deepEqual(checkRecipe(recipe), { ok: true }, 'inside the read-only grammar');
  assert.ok(text.includes(`\`\`\`\`markdown\n${shipped.replace(/\n$/, '')}\n\`\`\`\``), 'the What is the whole render, fenced past its own code blocks');
  assert.match(text, /^-.*Budget is 2\.00 USD/m, 'the diff shows the hand edit being replaced');
  assert.match(text, /^\+.*Budget is 0\.50 USD/m);
  assert.equal(read(vault, 'brain/_index/persona-prompts/duties/reflect-daily.md'), shipped, 'the render the recheck compares with');
  assert.equal(L.runRecipe(recipe, vault), 'present', 'still differs: the proposal holds');
  const filed = L.read({ file: path.join(vault, 'persona', 'ledger.jsonl') }).filter((e) => e.slug === 'update-duty-reflect-daily');
  assert.deepEqual(filed.map((e) => [e.event, e.by, e.kind]), [['filed', 'upgrade', 'self']]);
  assert.match(filed[0].note, /^render [0-9a-f]{12}$/);
  assert.equal(read(vault, rel).includes('2.00 USD'), true, 'the guarded file itself is never touched');
  const exact = Exact.preview(vault, '2026-10-24-update-duty-reflect-daily.md');
  assert.equal(exact.changes[0].path, rel);
  assert.equal(exact.changes[0].content, shipped);
  assert.equal(exact.changes[0].before.includes('2.00 USD'), true);

  assert.deepEqual(run(vault).pending, ['update-duty-reflect-daily'], 'the next upgrade leaves the pending one alone');
  assert.equal(proposals(vault).length, 1);
  fs.writeFileSync(path.join(vault, rel), shipped);   // approved: the What applied exactly
  assert.equal(L.runRecipe(recipe, vault), 'gone');
  fs.rmSync(path.join(vault, 'persona', 'proposals', '2026-10-24-update-duty-reflect-daily.md'));
  assert.deepEqual(run(vault).filed, []);
});

test('a rejected render is not filed again; a newer render supersedes a pending one', () => {
  const vault = setUp();
  const rel = 'persona/duties/tick.md';
  fs.appendFileSync(path.join(vault, rel), '\nMy own line.\n');
  assert.deepEqual(run(vault).filed, ['update-duty-tick']);
  L.append({ event: 'rejected', slug: 'update-duty-tick', kind: 'self', by: 'user', note: 'keep mine' }, { file: path.join(vault, 'persona', 'ledger.jsonl'), now: LATER });
  fs.rmSync(path.join(vault, 'persona', 'proposals', '2026-10-24-update-duty-tick.md'));
  const again = run(vault);
  assert.deepEqual(again.filed, []);
  assert.deepEqual(again.declined, ['update-duty-tick']);

  const vault2 = setUp();
  fs.appendFileSync(path.join(vault2, rel), '\nMy own line.\n');
  run(vault2);
  const newer = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-prompts-tmpl-'));
  fs.cpSync(TEMPLATES, newer, { recursive: true });
  fs.appendFileSync(path.join(newer, 'duties', 'tick.md'), '\nA line the next release adds.\n');
  const r = P.file({ vault: vault2, node: NODE, deps: { templatesDir: newer, now: new Date('2026-11-02T12:00:00'), html: { render() {} } } });
  assert.deepEqual(r.filed, ['update-duty-tick']);
  assert.deepEqual(proposals(vault2), ['2026-11-02-update-duty-tick.md'], 'the older render is replaced, not kept beside it');
  assert.match(read(vault2, 'persona/proposals/2026-11-02-update-duty-tick.md'), /A line the next release adds\./);
});

test('nothing runs on a vault without a Chief of Staff or with it off; --dry-run writes nothing', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-prompts-bare-'));
  assert.match(run(bare).skipped, /answers\.json is missing/);
  const vault = setUp();
  fs.writeFileSync(path.join(vault, 'persona', 'DISABLED'), '');
  assert.match(run(vault).skipped, /is off/);
  fs.rmSync(path.join(vault, 'persona', 'DISABLED'));
  fs.appendFileSync(path.join(vault, 'persona', 'duties', 'monitor.md'), '\nx\n');
  const dry = P.file({ vault, node: NODE, dryRun: true, deps: { templatesDir: TEMPLATES, now: LATER } });
  assert.deepEqual(dry.filed, ['update-duty-monitor']);
  assert.deepEqual(proposals(vault), []);
  assert.equal(fs.existsSync(path.join(vault, 'brain', '_index', 'persona-prompts')), false);
});

test('fenceFor outruns the longest backtick run inside the text', () => {
  assert.equal(P.fenceFor('plain'), '````');
  assert.equal(P.fenceFor('has ```` four'), '`````');
  assert.equal(P.slugFor('IDENTITY.md'), 'update-identity');
  assert.equal(P.slugFor('duties/sitrep.md'), 'update-duty-sitrep');
});
