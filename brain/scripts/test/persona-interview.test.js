'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const I = require('../persona/interview.js');

const TEMPLATES = path.join(__dirname, '..', '..', '..', 'vault-template', 'persona');
const ANSWERS = { name: 'Atlas', addressAs: 'boss', voice: 'dry, brief', priorities: 'shipping, tests', dutyModel: 'haiku', dutyEffort: 'medium', schedule: 'no' };

function configDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  fs.mkdirSync(path.join(root, 'skills', 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Does demo things\n---\n');
  return root;
}
function vaultDir() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  return v;
}

test('normalizeAnswers validates and coerces', () => {
  const a = I.normalizeAnswers(ANSWERS, { defaultModel: 'haiku' });
  assert.deepEqual(a.priorities, ['shipping', 'tests']);
  assert.equal(a.schedule, false);
  // execution amendment 2026-09-15 (A28): names are 2–40 chars, so the short fixtures are 'Ab', not 'A'.
  assert.equal(I.normalizeAnswers({ name: 'Ab' }, { defaultModel: 'sonnet' }).dutyModel, 'sonnet');
  assert.equal(I.normalizeAnswers({ name: 'Ab' }, {}).dutyCodexModel, null, 'blank → the user\'s Codex default');
  assert.equal(I.normalizeAnswers({ name: 'Ab', dutyCodexModel: ' gpt-5 ' }, {}).dutyCodexModel, 'gpt-5');
  assert.equal(I.QUESTIONS.find((q) => q.key === 'dutyCodexModel').when({ codex: false }), false, 'asked only where Codex is a host');
  // local-first A4: the Chief of Staff's models are the defaults; a stored pre-2.0 answer of null keeps the Codex default.
  assert.equal(I.normalizeAnswers({ name: 'Ab' }, {}).dutyModel, 'claude-opus-5-5');
  assert.equal(I.normalizeAnswers({ name: 'Ab' }, { defaultCodexModel: 'gpt-6-sol' }).dutyCodexModel, 'gpt-6-sol');
  assert.equal(I.normalizeAnswers({ name: 'Ab', dutyCodexModel: null }, { defaultCodexModel: 'gpt-6-sol' }).dutyCodexModel, null, 'an explicit null is kept (aos init --yes reruns a stored answer)');
  assert.equal(I.QUESTIONS.find((q) => q.key === 'dutyModel').when({ claude: false, codex: true }), false, 'a Codex-only machine is not asked for a Claude model');
  assert.equal(I.QUESTIONS.find((q) => q.key === 'dutyModel').def({}), 'claude-opus-5-5');
  assert.equal(I.QUESTIONS.find((q) => q.key === 'dutyCodexModel').def({ defaultCodexModel: 'gpt-6-sol' }), 'gpt-6-sol');
  assert.match(I.QUESTIONS.find((q) => q.key === 'dutyModel').prompt({}), /hosted model; the hourly check runs on the local model/);
  assert.equal(I.normalizeAnswers({ name: 'Ab' }, {}).schedule, true);
  assert.throws(() => I.normalizeAnswers({}, {}), /name is required/);
  assert.throws(() => I.normalizeAnswers({ name: 'Ab', dutyEffort: 'max' }, {}), /dutyEffort/);
  assert.throws(() => I.normalizeAnswers({ name: '../x' }, {}), /invalid agent name/);
  assert.throws(() => I.normalizeAnswers({ name: 'A' }, {}), /invalid agent name/);
});

test('writePersona renders the full layout from the templates', () => {
  const vault = vaultDir();
  const answers = I.normalizeAnswers(ANSWERS, {});
  const r = I.writePersona({ vault, configDir: configDir(), templatesDir: TEMPLATES, answers, node: '/opt/node/bin/node', now: new Date('2026-09-04T00:00:00Z') });
  const p = (rel) => fs.readFileSync(path.join(vault, 'persona', rel), 'utf8');
  assert.deepEqual(r.written.sort(), ['../brain/routines/heartbeat.md', '../brain/routines/reflect-daily.md', '../brain/routines/tick.md', 'IDENTITY.md', 'PLAYBOOK.md', 'STATE.md', 'answers.json', 'duties/monitor.md', 'duties/reflect.md', 'duties/reflect-daily.md', 'duties/sitrep.md', 'duties/tick.md', 'proposals/README.md'].sort());
  for (const name of ['heartbeat.md', 'tick.md', 'reflect-daily.md']) assert.equal(fs.readFileSync(path.join(vault, 'brain', 'routines', name), 'utf8'), fs.readFileSync(path.join(TEMPLATES, 'routines', name), 'utf8'), `${name} is seeded verbatim (run-routine.js expands {{NODE}}/{{VAULT}})`);
  assert.match(p('duties/tick.md'), new RegExp(`/opt/node/bin/node ${vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/brain/scripts/persona/tick.js signals`));
  assert.match(p('duties/reflect-daily.md'), new RegExp(`/opt/node/bin/node ${vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/brain/scripts/persona/reflect.js inputs --days 7`));
  assert.match(p('duties/reflect.md'), /reflect\.js inputs --days 28/, 'the weekly reflect reads the same evidence pack over a month');
  assert.match(p('STATE.md'), /- reflect: never\n- reflect-daily: never\n- sitrep: never\n- tick: never\n/);
  assert.match(p('IDENTITY.md'), /^# Atlas$/m);
  assert.match(p('IDENTITY.md'), /address the user as boss/);
  assert.match(p('IDENTITY.md'), /For interactive software development, if Superpowers is installed/);
  assert.match(p('IDENTITY.md'), /^updated: 2026-09-04$/m);
  assert.match(p('STATE.md'), /^# Persona State$/m);
  assert.match(p('STATE.md'), /## Flags\n\n## Priorities\n- shipping\n- tests\n/);
  assert.match(p('PLAYBOOK.md'), /^# Atlas PLAYBOOK — the front door$/m);
  assert.match(p('duties/sitrep.md'), new RegExp(`/opt/node/bin/node ${vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/brain/scripts/persona/sitrep-state.js diff`));
  assert.match(p('duties/monitor.md'), /\{yyyy\}\/\{yyyy\}-\{MM\}-\{MMMM\}\/\{yyyy\}-\{MM\}-\{dd\}\.md/);
  assert.equal(JSON.parse(p('answers.json')).name, 'Atlas');
  assert.equal(fs.existsSync(path.join(vault, 'persona', 'autoapply.json')), false, 'no auto-apply whitelist (spec 2026-10-24-persona-learning-loop-design D1)');
  assert.ok(fs.statSync(path.join(vault, 'persona', 'journal', 'logs')).isDirectory());
  for (const rel of ['IDENTITY.md', 'STATE.md', 'duties/monitor.md', 'duties/reflect.md', 'duties/reflect-daily.md', 'duties/sitrep.md', 'duties/tick.md', 'proposals/README.md']) assert.ok(!p(rel).includes('{{'), `${rel} fully rendered`);
  assert.ok(!fs.existsSync(path.join(vault, 'persona', 'DISABLED')));
});

test('a prefilled re-run keeps STATE.md, PLAYBOOK.md and proposals/README.md but regenerates IDENTITY.md', () => {
  const vault = vaultDir(); const cfg = configDir();
  I.writePersona({ vault, configDir: cfg, templatesDir: TEMPLATES, answers: I.normalizeAnswers(ANSWERS, {}) });
  fs.appendFileSync(path.join(vault, 'persona', 'STATE.md'), '- [ ] keep me\n');
  const r = I.writePersona({ vault, configDir: cfg, templatesDir: TEMPLATES, answers: I.normalizeAnswers({ ...ANSWERS, voice: 'warmer' }, {}) });
  assert.deepEqual(r.kept.sort(), ['../brain/routines/heartbeat.md', '../brain/routines/reflect-daily.md', '../brain/routines/tick.md', 'PLAYBOOK.md', 'STATE.md', 'proposals/README.md']);
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'STATE.md'), 'utf8'), /keep me/);
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'IDENTITY.md'), 'utf8'), /^warmer$/m);
});

test('renameAgent rewrites the name everywhere it was rendered', () => {
  const vault = vaultDir();
  I.writePersona({ vault, configDir: configDir(), templatesDir: TEMPLATES, answers: I.normalizeAnswers(ANSWERS, {}) });
  const r = I.renameAgent({ vault, newName: 'Beacon' });
  assert.equal(r.from, 'Atlas'); assert.equal(r.to, 'Beacon');
  assert.ok(r.changed.includes('IDENTITY.md') && r.changed.includes('PLAYBOOK.md') && r.changed.includes('duties/monitor.md'));
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Beacon$/m);
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'PLAYBOOK.md'), 'utf8'), /^# Beacon PLAYBOOK/m);
  assert.equal(I.currentName(vault), 'Beacon');
  assert.throws(() => I.renameAgent({ vault: vaultDir(), newName: 'X' }), /no persona to rename/);

  // execution amendment 2026-09-15 (A53): a rename must never rewrite a parsed STATE.md heading
  // — a name that matches a heading word (e.g. "Flags") is exactly what the validator still
  // accepts, and the old \b<old>\b replace across the whole file would turn `## Flags` into
  // `## Beacon`.
  const v2 = vaultDir();
  I.writePersona({ vault: v2, configDir: configDir(), templatesDir: TEMPLATES, answers: I.normalizeAnswers({ ...ANSWERS, name: 'Flags' }, {}) });
  I.renameAgent({ vault: v2, newName: 'Beacon' });
  const state2 = fs.readFileSync(path.join(v2, 'persona', 'STATE.md'), 'utf8');
  assert.match(state2, /## Flags/);
  assert.match(state2, /^# Persona State$/m);
  assert.match(fs.readFileSync(path.join(v2, 'persona', 'IDENTITY.md'), 'utf8'), /^# Beacon$/m);
  assert.match(fs.readFileSync(path.join(v2, 'persona', 'PLAYBOOK.md'), 'utf8'), /^# Beacon PLAYBOOK — the front door$/m);
  assert.match(fs.readFileSync(path.join(v2, 'persona', 'duties', 'monitor.md'), 'utf8'), /You are Beacon\./);

  // execution amendment 2026-09-15 (A55): a rename must keep an absolute node path in the
  // re-rendered duty files (Task 8 calls renameAgent from launchd with a minimal PATH), and a
  // same-name rename must report no changes and leave every file byte-identical.
  const v3 = vaultDir();
  I.writePersona({ vault: v3, configDir: configDir(), templatesDir: TEMPLATES, answers: I.normalizeAnswers(ANSWERS, {}), node: process.execPath });
  I.renameAgent({ vault: v3, newName: 'Beacon' });
  const sitrep3 = fs.readFileSync(path.join(v3, 'persona', 'duties', 'sitrep.md'), 'utf8');
  // Anchored on the markdown backtick: process.execPath itself typically ends in "node" (e.g.
  // /usr/local/bin/node), so a plain "node <path>" substring check would false-pass against the
  // correct value's suffix. The backtick can only precede the start of the rendered command.
  assert.ok(sitrep3.includes(`\`${process.execPath} ${v3}/brain/scripts/persona/sitrep-state.js diff`), 'the absolute node path survived the rename');
  assert.ok(!sitrep3.includes(`\`node ${v3}/brain/scripts/persona/sitrep-state.js diff`), 'must not degrade to the bare "node" fallback');
  const before3 = {};
  for (const rel of ['IDENTITY.md', 'PLAYBOOK.md', 'STATE.md', 'duties/monitor.md', 'duties/reflect.md', 'duties/sitrep.md']) {
    before3[rel] = fs.readFileSync(path.join(v3, 'persona', rel), 'utf8');
  }
  const r3 = I.renameAgent({ vault: v3, newName: 'Beacon' });
  assert.deepEqual(r3.changed, []);
  for (const rel of Object.keys(before3)) {
    assert.equal(fs.readFileSync(path.join(v3, 'persona', rel), 'utf8'), before3[rel], `${rel} byte-identical after a same-name rename`);
  }
});

test('ask() reads answers from a stream, applying defaults and prefill', async () => {
  const input = new PassThrough(); const output = new PassThrough(); output.resume();
  const p = I.ask({ defaultModel: 'haiku', exampleName: 'Atlas' }, { voice: 'terse' }, { input, output });
  for (const line of ['Atlas', '', '', 'docs', '', '', 'n']) input.write(line + '\n');
  const raw = await p;
  assert.equal(raw.name, 'Atlas');
  assert.equal(raw.addressAs, 'the user');
  assert.equal(raw.voice, 'terse');
  assert.equal(raw.priorities, 'docs');
  assert.equal(raw.dutyModel, 'haiku');
  assert.equal(raw.schedule, 'n');
});

test('CLI --answers writes the layout and prints a JSON summary', () => {
  const vault = vaultDir();
  const file = path.join(vault, 'answers-in.json');
  fs.writeFileSync(file, JSON.stringify(ANSWERS));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'persona', 'interview.js'), '--vault', vault, '--config-dir', configDir(), '--templates', TEMPLATES, '--answers', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.schedule, false);
  assert.ok(out.written.includes('IDENTITY.md'));
  const usage = spawnSync(process.execPath, [path.join(__dirname, '..', 'persona', 'interview.js'), '--vault', vault, '--yes'], { encoding: 'utf8', env: { ...process.env, AOS_VAULT: '' } });
  assert.equal(usage.status, 0, 'a second --yes run reuses persona/answers.json and finds the checkout templates without --templates');
  assert.equal(I.defaultTemplatesDir(), TEMPLATES, 'from the checkout the fallback is vault-template/persona');

  // execution amendment 2026-09-15 (A52): the interactive path (no --answers, no --yes) must
  // still print exactly one JSON line on stdout — prompts go to stderr instead. Input is the
  // name, then six empty lines accepting every default (7 lines for 7 QUESTIONS).
  const interactiveVault = vaultDir();
  const interactive = spawnSync(process.execPath, [path.join(__dirname, '..', 'persona', 'interview.js'), '--vault', interactiveVault, '--config-dir', configDir(), '--templates', TEMPLATES], { encoding: 'utf8', input: 'Atlas\n\n\n\n\n\n\n' });
  assert.equal(interactive.status, 0, interactive.stderr);
  const interactiveOut = JSON.parse(interactive.stdout.trim().split('\n').pop());
  assert.ok(interactiveOut.persona && interactiveOut.written && interactiveOut.kept);
  assert.equal(interactiveOut.schedule, true);
  assert.ok(!interactive.stdout.includes('Agent name'), 'prompt text went to stderr, not stdout');
});

test('CLI positional `rename <name>` (the launcher form, contract §4.3) renames without starting the interview', () => {
  const bin = path.join(__dirname, '..', 'persona', 'interview.js');
  const vault = vaultDir();
  I.writePersona({ vault, configDir: configDir(), templatesDir: TEMPLATES, answers: I.normalizeAnswers(ANSWERS, {}) });
  assert.deepEqual(I.positionals(['--vault', vault, 'rename', 'Beacon', '--yes']), ['rename', 'Beacon']);
  // stdin is closed (`input: ''`): if main() fell through to ask(), readline would end the process with exit 1, not 0.
  const r = spawnSync(process.execPath, [bin, '--vault', vault, 'rename', 'Beacon'], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.from, 'Atlas'); assert.equal(out.to, 'Beacon');
  assert.ok(out.changed.includes('IDENTITY.md'));
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Beacon$/m);
  // The launcher passes no --vault; it exports AOS_VAULT (contract §4.1 step 4).
  const viaEnv = spawnSync(process.execPath, [bin, 'rename', 'Cairn'], { encoding: 'utf8', input: '', env: { ...process.env, AOS_VAULT: vault } });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(I.currentName(vault), 'Cairn');
  const usage = spawnSync(process.execPath, [bin, '--vault', vault, 'rename'], { encoding: 'utf8', input: '' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: interview\.js \[--vault <dir>\] rename <name>/);
  const none = spawnSync(process.execPath, [bin, '--vault', vaultDir(), 'rename', 'X'], { encoding: 'utf8', input: '' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no persona to rename/);
});
