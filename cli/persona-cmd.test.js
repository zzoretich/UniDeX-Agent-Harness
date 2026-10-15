'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./persona-cmd.js');
// execution amendment 2026-09-15 (A12): resolveCtx reads AOS_VAULT before cfg.vault and readAgenticos reads AOS_CONFIG before
// the passed configDir, so an exported value would point every test at the real ~/.claude (cli/aos.test.js:35 does the same).
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT;

const ANSWERS = { name: 'Atlas', addressAs: 'boss', voice: 'dry', priorities: 'docs', dutyModel: 'haiku', dutyEffort: 'medium', schedule: 'yes' };

function world() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n');
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ version: '0.1.0', vault, node: '/usr/bin/node', claudeConfigDir: configDir, provider: 'auto', claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 }, cost: { enabled: false }, persona: { enabled: true } }));
  const answersFile = path.join(vault, 'in.json');
  fs.writeFileSync(answersFile, JSON.stringify(ANSWERS));
  const logs = []; const io = { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) };
  return { configDir, vault, answersFile, io, logs };
}

test('resolveCtx reads vault, node and default model from agenticos.json', () => {
  const w = world();
  const ctx = P.resolveCtx({ configDir: w.configDir });
  assert.equal(ctx.vault, w.vault); assert.equal(ctx.node, '/usr/bin/node');
  // local-first A4: the interview offers the Chief of Staff's models, not claude.model.
  assert.equal(ctx.defaultModel, 'claude-opus-5-5'); assert.equal(ctx.defaultCodexModel, 'gpt-6-sol');
  assert.equal(ctx.claude, true, 'a config without hosts is Claude only'); assert.equal(ctx.codex, false);
  assert.throws(() => P.resolveCtx({ configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nocfg-')) }), /aos init/);
});

test('runInterview with an answers file writes the persona and installs schedules', async () => {
  const w = world(); const calls = [];
  const r = await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, platform: 'darwin',
    installSchedules: (o) => { calls.push(o); o.warn('launchctl load com.agenticos.reflect.plist: boom'); return { platform: 'darwin', written: ['x'], labels: ['com.agenticos.monitor'], warnings: ['launchctl load com.agenticos.reflect.plist: boom'] }; } });
  assert.equal(r.answers.name, 'Atlas');
  assert.match(fs.readFileSync(path.join(w.vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Atlas$/m);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].vars.AGENT_NAME, 'Atlas');
  assert.equal(calls[0].vars.NODE, '/usr/bin/node');
  assert.equal(calls[0].vars.AOS_CONFIG, path.join(w.configDir, 'agenticos.json'));
  assert.ok(w.logs.some(l => /scheduled com\.agenticos\.monitor/.test(l)));
  // execution amendment 2026-09-15 (A30 carry-in): schedule.js's launchctl warnings reach the caller's io seam, not a bare stderr line.
  assert.ok(w.logs.includes('ERR warning: launchctl load com.agenticos.reflect.plist: boom'), 'installSchedules warn → io.error');
});

test('runInterview: persona.model/effort settings win over the answers for the schedules, and it says so (duty-model-settings D3)', async () => {
  const w = world(); const calls = [];
  fs.mkdirSync(path.join(w.vault, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'), JSON.stringify({ persona: { model: 'sonnet', effort: 'high' } }));
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, platform: 'darwin',
    installSchedules: (o) => { calls.push(o); return { platform: 'darwin', written: [], labels: [], warnings: [] }; } });
  assert.equal(calls[0].vars.MODEL, 'sonnet');
  assert.equal(calls[0].vars.EFFORT, 'high');
  assert.ok(w.logs.some(l => /duties run on sonnet \(persona\.model\), not the interview's haiku/.test(l)));
  assert.ok(w.logs.some(l => /duties run at high effort \(persona\.effort\), not the interview's medium/.test(l)));
  const w2 = world(); const calls2 = [];
  await P.runInterview({ configDir: w2.configDir, answersFile: w2.answersFile, io: w2.io, platform: 'darwin',
    installSchedules: (o) => { calls2.push(o); return { platform: 'darwin', written: [], labels: [], warnings: [] }; } });
  assert.equal(calls2[0].vars.MODEL, 'haiku', 'no setting → the answer');
  assert.ok(!w2.logs.some(l => /persona\.model/.test(l)), 'no override note without a setting');
});

test('schedule "no" (or schedule:false option) skips scheduling; dry-run writes nothing', async () => {
  const w = world(); let called = 0;
  fs.writeFileSync(w.answersFile, JSON.stringify({ ...ANSWERS, schedule: 'no' }));
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, installSchedules: () => { called++; } });
  assert.equal(called, 0);
  const w2 = world();
  const r = await P.runInterview({ configDir: w2.configDir, answersFile: w2.answersFile, io: w2.io, dryRun: true, installSchedules: () => { called++; } });
  assert.equal(r.dryRun, true);
  assert.ok(!fs.existsSync(path.join(w2.vault, 'persona')));
  assert.equal(called, 0);
});

test('run(): off/on toggle DISABLED; rename rewrites and re-renders installed schedules; usage errors exit 2', async () => {
  const w = world();
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, schedule: false });
  assert.equal(await P.run(['off'], { configDir: w.configDir, io: w.io }), 0);
  assert.ok(fs.existsSync(path.join(w.vault, 'persona', 'DISABLED')));
  assert.equal(await P.run(['on'], { configDir: w.configDir, io: w.io }), 0);
  assert.ok(!fs.existsSync(path.join(w.vault, 'persona', 'DISABLED')));
  let rerendered = null;
  assert.equal(await P.run(['rename', 'Beacon'], { configDir: w.configDir, io: w.io, isInstalled: () => true, installSchedules: (o) => { rerendered = o.vars.AGENT_NAME; return { written: [], labels: [] }; } }), 0);
  assert.match(fs.readFileSync(path.join(w.vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Beacon$/m);
  assert.equal(rerendered, 'Beacon');
  assert.equal(await P.run(['rename'], { configDir: w.configDir, io: w.io }), 2);
  assert.equal(await P.run(['bogus'], { configDir: w.configDir, io: w.io }), 2);
});

test('run() with --yes (or a non-TTY stdin) and no stored answers skips the interview with exit 1 and never blocks on readline', async () => {
  const w = world();
  assert.equal(await P.run(['--yes'], { configDir: w.configDir, io: w.io }), 1);
  assert.ok(w.logs.some(l => /no --persona-json and no terminal/.test(l) && /answers\.json/.test(l)));
  const r = await P.runInterview({ configDir: w.configDir, io: w.io });   // node --test: stdin is a pipe, not a TTY
  assert.equal(r.skipped, true);
  assert.ok(!fs.existsSync(path.join(w.vault, 'persona')));
});

test('runInterview with --yes reuses persona/answers.json (non-interactive re-run)', async () => {
  const w = world();
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, schedule: false });
  const r = await P.runInterview({ configDir: w.configDir, yes: true, io: w.io, schedule: false });
  assert.equal(r.answers.name, 'Atlas');
  assert.ok(r.kept.includes('STATE.md'));
});

test('on a Codex host the interview asks for the Codex duty model and stores it as persona.codexModel (lib/headless.js reads it)', async () => {
  const w = world();
  const cfgFile = path.join(w.configDir, 'agenticos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), hosts: { codex: { enabled: true } } }));
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'), JSON.stringify({ persona: { runner: 'codex' } }));
  fs.writeFileSync(w.answersFile, JSON.stringify({ ...ANSWERS, dutyCodexModel: 'gpt-5' }));
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, schedule: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', 'config.json'), 'utf8')).persona, { runner: 'codex', codexModel: 'gpt-5' });
  const w2 = world();   // no Codex host: brain/config.json is left alone
  await P.runInterview({ configDir: w2.configDir, answersFile: w2.answersFile, io: w2.io, schedule: false });
  assert.ok(!fs.existsSync(path.join(w2.vault, 'brain', 'config.json')));
});

test('a 2.0 install: the interview\'s Claude duty model replaces the shipped default persona.model, never one the owner set (local-first A4)', async () => {
  const w = world(); const calls = [];
  const defaults = require('../brain/scripts/config.default.json');
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'), JSON.stringify({ persona: { ...defaults.persona } }));
  fs.writeFileSync(w.answersFile, JSON.stringify({ ...ANSWERS, dutyModel: 'sonnet' }));
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, platform: 'darwin',
    installSchedules: (o) => { calls.push(o); return { platform: 'darwin', written: [], labels: [], warnings: [] }; } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', 'config.json'), 'utf8')).persona.model, 'sonnet');
  assert.equal(calls[0].vars.MODEL, 'sonnet', 'the schedules carry the answer');
  assert.ok(!w.logs.some(l => /not the interview's/.test(l)));
  // The wizard's preselected answer equals the default: nothing to write.
  const w2 = world();
  fs.writeFileSync(path.join(w2.vault, 'brain', 'config.json'), JSON.stringify({ persona: { ...defaults.persona } }));
  fs.writeFileSync(w2.answersFile, JSON.stringify({ ...ANSWERS, dutyModel: 'claude-opus-5-5' }));
  const before = fs.readFileSync(path.join(w2.vault, 'brain', 'config.json'), 'utf8');
  await P.runInterview({ configDir: w2.configDir, answersFile: w2.answersFile, io: w2.io, schedule: false });
  assert.equal(fs.readFileSync(path.join(w2.vault, 'brain', 'config.json'), 'utf8'), before);
  // A pre-2.0 vault (null) keeps its null: the answer is the next link of its chain anyway.
  const w3 = world();
  fs.writeFileSync(path.join(w3.vault, 'brain', 'config.json'), JSON.stringify({ persona: { model: null } }));
  await P.runInterview({ configDir: w3.configDir, answersFile: w3.answersFile, io: w3.io, schedule: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(w3.vault, 'brain', 'config.json'), 'utf8')).persona.model, null);
});

test('a Codex-only machine: no Claude question, and a missing Codex answer is the Chief of Staff\'s gpt-6-sol', async () => {
  const w = world();
  const cfgFile = path.join(w.configDir, 'agenticos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), hosts: { claude: { enabled: false }, codex: { enabled: true } } }));
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'), JSON.stringify({ persona: { model: 'claude-opus-5-5' } }));
  const { dutyModel, ...noClaude } = ANSWERS; // eslint-disable-line no-unused-vars
  fs.writeFileSync(w.answersFile, JSON.stringify(noClaude));
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, schedule: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', 'config.json'), 'utf8')).persona, { model: 'claude-opus-5-5', codexModel: 'gpt-6-sol' });
});

// install-import B2: `aos hosts add` sets the Chief of Staff up for the first host. Its default answers carry the duty models
// the settings name (the chief role's on a 2.0 vault, or the owner's), and stand in for a missing answers.json: offered in
// brackets on a terminal, taken as they are off one.
test('defaultAnswers and runInterview({ defaults }): offered on a terminal, the answers off one; a stored answers.json still wins', async () => {
  const { PassThrough } = require('stream');
  const w = world();
  const defaults = require('../brain/scripts/config.default.json');
  const cfgFile = path.join(w.configDir, 'agenticos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), hosts: { claude: { enabled: true }, codex: { enabled: true } } }));
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'), JSON.stringify({ persona: { ...defaults.persona } }));
  assert.equal(P.hasPersona(w.vault), false);
  assert.deepEqual(P.defaultAnswers({ vault: w.vault, configDir: w.configDir }), { name: 'Atlas', dutyModel: 'claude-opus-5-5', dutyCodexModel: 'gpt-6-sol', schedule: true });
  // A terminal: every question answered with Return takes the bracketed default.
  const input = new PassThrough(); const output = new PassThrough(); let shown = '';
  output.on('data', (d) => { shown += d; });
  input.end('\n'.repeat(12));
  const r = await P.runInterview({ configDir: w.configDir, io: w.io, schedule: false, streams: { input, output }, defaults: P.defaultAnswers({ vault: w.vault, configDir: w.configDir }) });
  assert.match(shown, /Agent name \(required; e\.g\. Atlas\) \[Atlas\]: /);
  assert.match(shown, /Codex model for duties \(when Claude Code cannot start one\) \[gpt-6-sol\]: /);
  assert.deepEqual([r.answers.name, r.answers.dutyModel, r.answers.dutyCodexModel, r.defaulted], ['Atlas', 'claude-opus-5-5', 'gpt-6-sol', false]);
  assert.equal(P.hasPersona(w.vault), true);
  // No terminal: the defaults are the answers. A model the owner set is the one they carry.
  const w2 = world();
  fs.writeFileSync(path.join(w2.vault, 'brain', 'config.json'), JSON.stringify({ persona: { ...defaults.persona, model: 'sonnet', codexModel: null } }));
  const d2 = P.defaultAnswers({ vault: w2.vault, configDir: w2.configDir });
  assert.deepEqual([d2.dutyModel, d2.dutyCodexModel], ['sonnet', null]);
  const r2 = await P.runInterview({ configDir: w2.configDir, io: w2.io, schedule: false, defaults: d2 });
  assert.deepEqual([r2.defaulted, r2.answers.name, r2.answers.dutyModel], [true, 'Atlas', 'sonnet']);
  assert.ok(!w2.logs.some((l) => /skipping the interview/.test(l)));
  // A stored answers.json is reused before any default.
  const r3 = await P.runInterview({ configDir: w.configDir, io: w.io, schedule: false, yes: true, defaults: { name: 'Other', schedule: true } });
  assert.deepEqual([r3.answers.name, r3.defaulted], ['Atlas', false]);
});
