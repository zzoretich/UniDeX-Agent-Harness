'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./schedule.js');
const store = require('../brain/scripts/lib/routines-store.js');

const HOME = '/home/alice';
const VARS = S.scheduleVars({ vault: `${HOME}/AgenticOS`, configDir: `${HOME}/.claude`, node: '/usr/bin/node', model: 'haiku', effort: 'medium', agentName: 'Atlas', home: HOME });

const R = {
  monitor: { slug: 'monitor', schema: 1, name: 'Monitor', kind: 'duty', schedule: '0 13 * * *', enabled: true, guarded: true, body: '', errors: [] },
  sitrep: { slug: 'sitrep', schema: 1, name: 'Sitrep', kind: 'duty', schedule: '45 7 * * 1-5', enabled: true, guarded: true, body: '', errors: [] },
  brief: { slug: 'brief', schema: 1, name: 'Brief', kind: 'prompt', schedule: '0 9 1,15 * *', enabled: true, body: 'x', errors: [] },
  off: { slug: 'off', schema: 1, name: 'Off', kind: 'command', schedule: '0 9 * * *', enabled: false, argv: ['true'], body: '', errors: [] },
  broken: { slug: 'broken', schema: 1, name: 'Broken', kind: 'command', schedule: '0 99 * * *', enabled: true, argv: ['true'], body: '', errors: ['schedule: hour: 99-99 is outside 0-23'] },
};
const ALL = Object.values(R);

/** A vault dir with routine files written through the store, a state file path, and injected io. */
function vault(routines = ALL) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  for (const r of routines) if (!r.errors.length) store.write(r, { dir: path.join(v, 'brain', 'routines') });
  if (routines.includes(R.broken)) fs.writeFileSync(path.join(v, 'brain', 'routines', 'broken.md'), '---\nschema: 1\nname: Broken\nkind: command\nschedule: "0 99 * * *"\nenabled: true\nargv: [true]\n---\n');
  return { dir: v, stateFile: path.join(v, 'brain', '_index', 'routines.json'), launchAgentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'la-')), logDir: path.join(v, 'logs') };
}
const plists = (dir) => fs.readdirSync(dir).filter(f => f.endsWith('.plist')).sort();

test('scheduleVars derives the config path and log dir', () => {
  assert.equal(VARS.AOS_CONFIG, `${HOME}/.claude/agenticos.json`);
  assert.equal(VARS.LOG_DIR, `${HOME}/AgenticOS/persona/journal/logs`);
  assert.equal(VARS.AGENT_NAME, 'Atlas');
});

// Spec 2026-09-24-duty-model-settings-design D3: settings → interview answers → claude.model → the Chief of Staff's model
// (local-first A4: claude-opus-5-5, from sdk/lib/models.js); machine file wins.
test('dutyRunDefaults: persona.model/effort, then the interview answers, then claude.model and medium', () => {
  const answers = { dutyModel: 'haiku', dutyEffort: 'medium' };
  assert.deepEqual(S.dutyRunDefaults(), { model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(S.dutyRunDefaults({ vaultCfg: require('../brain/scripts/config.default.json') }), { model: 'claude-opus-5-5', effort: 'medium' }, 'a 2.0 install bakes the CoS model');
  assert.deepEqual(S.dutyRunDefaults({ userCfg: { claude: { model: 'opus' } } }), { model: 'opus', effort: 'medium' }, 'no answers → claude.model');
  assert.deepEqual(S.dutyRunDefaults({ userCfg: { claude: { model: 'opus' } }, answers }), { model: 'haiku', effort: 'medium' }, 'the answers beat claude.model');
  assert.deepEqual(S.dutyRunDefaults({ vaultCfg: { persona: { model: 'sonnet', effort: 'high' } }, answers }), { model: 'sonnet', effort: 'high' }, 'the settings beat the answers');
  assert.deepEqual(S.dutyRunDefaults({ userCfg: { persona: { model: 'opus' } }, vaultCfg: { persona: { model: 'sonnet', effort: 'low' } }, answers }),
    { model: 'opus', effort: 'low' }, 'agenticos.json wins over brain/config.json, key by key');
  assert.deepEqual(S.dutyRunDefaults({ vaultCfg: { persona: { model: null, effort: 'max' } }, answers: { dutyModel: ' ', dutyEffort: 'bogus' } }),
    { model: 'claude-opus-5-5', effort: 'medium' }, 'null, blank and unknown values fall through');
});

test('readVaultConfig: brain/config.json, or {} when missing or unparseable', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-vcfg-'));
  assert.deepEqual(S.readVaultConfig(vault), {});
  fs.mkdirSync(path.join(vault, 'brain'));
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), '{ nope');
  assert.deepEqual(S.readVaultConfig(vault), {});
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ persona: { model: 'sonnet' } }));
  assert.equal(S.readVaultConfig(vault).persona.model, 'sonnet');
});

test('listRoutines reads the vault store; installable keeps enabled + valid only', () => {
  const v = vault();
  const all = S.listRoutines({ vault: v.dir });
  assert.deepEqual(all.map(r => r.slug), ['brief', 'broken', 'monitor', 'off', 'sitrep']);
  assert.deepEqual(S.installable(all).map(r => r.slug), ['brief', 'monitor', 'sitrep']);
  assert.deepEqual(S.listRoutines({ vault: fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')) }), []);
});

test('renderLaunchd: generic template, label, runner argv, calendar from the cron expression, no placeholder left', () => {
  const xml = S.renderLaunchd(R.sitrep, VARS);
  assert.match(xml, /<key>Label<\/key><string>com\.agenticos\.sitrep<\/string>/);
  assert.match(xml, new RegExp(`<string>${HOME}/AgenticOS/brain/scripts/routines/run-routine\\.js</string>\\s*<string>sitrep</string>`));
  assert.match(xml, /<string>exec "\$AOS_NODE" "\$0" "\$@"<\/string>/);
  assert.match(xml, /<key>AOS_NODE<\/key><string>\/usr\/bin\/node<\/string>/);
  assert.match(xml, /<key>PERSONA_NAME<\/key><string>Atlas<\/string>/);
  assert.equal((xml.match(/<dict><key>Weekday<\/key><integer>\d<\/integer><key>Hour<\/key><integer>7<\/integer><key>Minute<\/key><integer>45<\/integer><\/dict>/g) || []).length, 5);
  assert.match(xml, /launchd-sitrep-error\.log/);
  assert.ok(!xml.includes('{{'), 'no unrendered placeholder');
  assert.match(S.renderLaunchd(R.monitor, VARS), /<array>\n    <dict><key>Hour<\/key><integer>13<\/integer><key>Minute<\/key><integer>0<\/integer><\/dict>\n  <\/array>/);
  assert.match(S.renderLaunchd(R.brief, VARS), /<key>Day<\/key><integer>15<\/integer>/);
  // execution amendment 2026-09-15 (A30): substituted values are XML-escaped in the plist (cron stays raw).
  assert.match(S.renderLaunchd(R.monitor, { ...VARS, AGENT_NAME: 'R&D <lab>' }), /<key>PERSONA_NAME<\/key><string>R&amp;D &lt;lab&gt;<\/string>/);
  assert.ok(S.renderCron([R.monitor], { ...VARS, AGENT_NAME: 'R&D' }).includes('PERSONA_NAME=R&D'));
});

test('renderCron: one line per installable routine, each ending with the com.agenticos.<slug> marker', () => {
  assert.equal(S.CRON_TAG, '# com.agenticos.');
  const lines = S.renderCron(ALL, VARS).trim().split('\n');
  assert.equal(lines.length, 3);
  for (const slug of ['monitor', 'sitrep', 'brief']) {
    const l = lines.find(x => x.endsWith(`${S.CRON_TAG}${slug}`));
    assert.ok(l, slug);
    assert.ok(l.includes(`run-routine.js ${slug} >>`), `${slug} runs through run-routine.js`);
    assert.ok(l.startsWith(R[slug].schedule + ' '), `${slug} keeps its cron expression`);
    assert.ok(l.includes('AOS_NODE=/usr/bin/node') && l.includes('PATH='), `${slug} carries the env`);
  }
  assert.ok(!lines.join('').includes('{{'));
  assert.equal(S.renderCron([], VARS), '');
  assert.equal(S.renderCron([R.off, R.broken], VARS), '');
});

test('stripAgenticosCron removes only lines tagged with the given slugs', () => {
  const text = '0 1 * * * echo keep-me\n0 2 * * * old # com.agenticos.monitor\n0 3 * * * mine # com.agenticos.custom\n# a comment about agenticos that stays\n0 4 * * * x # com.agenticos.ollama\n';
  assert.equal(S.stripAgenticosCron(text, ['monitor', 'sitrep']), '0 1 * * * echo keep-me\n0 3 * * * mine # com.agenticos.custom\n# a comment about agenticos that stays\n0 4 * * * x # com.agenticos.ollama');
  assert.equal(S.stripAgenticosCron(text, []), text.trimEnd());
});

test('knownSlugs: files ∪ last sync ∪ legacy duties, never ollama', () => {
  const slugs = S.knownSlugs({ routines: [R.brief], state: { synced: { gone: 'x' } } });
  assert.deepEqual(slugs.sort(), ['brief', 'gone', 'monitor', 'reflect', 'sitrep']);
  assert.deepEqual(S.knownSlugs().sort(), ['monitor', 'reflect', 'sitrep']);
});

test('installSchedules on darwin: one plist per installable routine, stale ones unloaded and deleted, sync recorded', () => {
  const v = vault();
  const vars = { ...VARS, VAULT: v.dir, LOG_DIR: v.logDir };
  for (const f of ['com.agenticos.reflect.plist', 'com.agenticos.off.plist', 'com.agenticos.ollama.plist']) fs.writeFileSync(path.join(v.launchAgentsDir, f), '<plist/>\n');
  const calls = [];
  // execution amendment 2026-09-15 (A30): a failing `launchctl load` is reported, never thrown — the brief load fails here.
  const exec = (cmd, args) => { calls.push([cmd, ...args]); if (args[0] === 'load' && args[1].endsWith('com.agenticos.brief.plist')) throw new Error('boom'); };
  const warnings = [];
  const r = S.installSchedules({ platform: 'darwin', vars, launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile, exec, warn: (m) => warnings.push(m), now: () => new Date('2026-09-21T13:00:00Z') });
  assert.deepEqual(r.written.map(p => path.basename(p)).sort(), ['com.agenticos.brief.plist', 'com.agenticos.monitor.plist', 'com.agenticos.sitrep.plist']);
  assert.deepEqual(r.labels.sort(), ['com.agenticos.brief', 'com.agenticos.monitor', 'com.agenticos.sitrep']);
  assert.deepEqual(r.removed.map(p => path.basename(p)).sort(), ['com.agenticos.off.plist', 'com.agenticos.reflect.plist'], 'disabled + legacy-without-file are removed');
  assert.deepEqual(plists(v.launchAgentsDir), ['com.agenticos.brief.plist', 'com.agenticos.monitor.plist', 'com.agenticos.ollama.plist', 'com.agenticos.sitrep.plist']);
  assert.equal(calls.filter(c => c[1] === 'load').length, 3);
  assert.deepEqual(calls.filter(c => c[1] === 'unload').map(c => path.basename(c[2])).sort(), ['com.agenticos.brief.plist', 'com.agenticos.monitor.plist', 'com.agenticos.off.plist', 'com.agenticos.reflect.plist', 'com.agenticos.sitrep.plist']);
  assert.deepEqual(r.warnings, warnings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /launchctl load .*com\.agenticos\.brief\.plist: boom/);
  assert.ok(fs.existsSync(v.logDir), 'log dir created');
  const st = store.readState({ file: v.stateFile });
  assert.deepEqual(st.synced, { brief: 'prompt|0 9 1,15 * *|on', monitor: 'duty|0 13 * * *|on', sitrep: 'duty|45 7 * * 1-5|on' });
  assert.equal(st.syncedAt, '2026-09-21T13:00:00.000Z');
  assert.match(fs.readFileSync(path.join(v.launchAgentsDir, 'com.agenticos.brief.plist'), 'utf8'), /run-routine\.js/);
  assert.equal(S.isInstalled({ platform: 'darwin', vault: v.dir, launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile }), true);

  // A routine deleted after a sync is still cleaned up on the next sync (it is in the recorded set).
  fs.unlinkSync(path.join(v.dir, 'brain', 'routines', 'brief.md'));
  const again = S.installSchedules({ platform: 'darwin', vars, launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile, exec: () => {}, warn: () => {} });
  assert.deepEqual(again.removed.map(p => path.basename(p)), ['com.agenticos.brief.plist']);
  assert.deepEqual(Object.keys(store.readState({ file: v.stateFile }).synced).sort(), ['monitor', 'sitrep']);

  const rm = S.removeSchedules({ platform: 'darwin', vault: v.dir, launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile, exec: (cmd, args) => calls.push([cmd, ...args]) });
  assert.deepEqual(rm.removed.map(p => path.basename(p)).sort(), ['com.agenticos.monitor.plist', 'com.agenticos.sitrep.plist']);
  assert.deepEqual(plists(v.launchAgentsDir), ['com.agenticos.ollama.plist'], 'the Ollama supervisor is never ours');
  assert.equal(S.isInstalled({ platform: 'darwin', vault: v.dir, launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile }), false);
  assert.deepEqual(store.readState({ file: v.stateFile }).synced, {});
});

test('installSchedules with injected routines needs no vault files', () => {
  const v = vault([]);
  const r = S.installSchedules({ platform: 'darwin', vars: { ...VARS, VAULT: v.dir, LOG_DIR: v.logDir }, routines: [R.monitor], launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile, exec: () => {}, warn: () => {} });
  assert.deepEqual(r.labels, ['com.agenticos.monitor']);
});

test('installSchedules on linux merges into the existing crontab without duplicates; remove strips only our lines', () => {
  const v = vault();
  const vars = { ...VARS, VAULT: v.dir, LOG_DIR: v.logDir };
  let crontab = '0 1 * * * echo keep-me\n0 2 * * * old-line # com.agenticos.monitor\n0 5 * * * legacy # com.agenticos.reflect\n0 6 * * * x # com.agenticos.ollama\n';
  // execution amendment 2026-09-15 (A10): launchAgentsDir is injected — removeSchedules deletes plists on EVERY
  // platform, so without it this test would unlink from the real ~/Library/LaunchAgents. No schedule test may ever
  // resolve the real dir or the real crontab.
  const io = { launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile, readCrontab: () => crontab, writeCrontab: (t) => { crontab = t; } };
  const r = S.installSchedules({ platform: 'linux', vars, ...io });
  const lines = crontab.trim().split('\n');
  assert.equal(lines[0], '0 1 * * * echo keep-me');
  assert.equal(lines[1], '0 6 * * * x # com.agenticos.ollama', 'the ollama line is foreign and kept');
  assert.equal(lines.filter(l => l.includes(S.CRON_TAG)).length, 4);
  assert.ok(!crontab.includes('old-line') && !crontab.includes('legacy'), 'our stale lines are replaced');
  assert.deepEqual(r.removed, ['# com.agenticos.reflect'], 'a legacy tag with no routine file is reported removed');
  assert.deepEqual(r.labels.sort(), ['# com.agenticos.brief', '# com.agenticos.monitor', '# com.agenticos.sitrep']);
  assert.equal(S.isInstalled({ platform: 'linux', vault: v.dir, ...io }), true);
  S.removeSchedules({ platform: 'linux', vault: v.dir, ...io });
  assert.equal(crontab.trim(), '0 1 * * * echo keep-me\n0 6 * * * x # com.agenticos.ollama');
  assert.equal(S.isInstalled({ platform: 'linux', vault: v.dir, ...io }), false);

  // execution amendment 2026-09-15 (A56): a failed `crontab -l` (not "no crontab") must never be treated as
  // empty — no readCrontab/writeCrontab injected here, so the real readCrontabWith/writeCrontabWith seams run
  // through this fake exec.
  {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === '-l') throw Object.assign(new Error('crontab: permission denied'), { stderr: 'crontab: permission denied', status: 1 });
      return '';
    };
    const warnings = [];
    const r2 = S.installSchedules({ platform: 'linux', vars, launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile, exec, warn: (m) => warnings.push(m) });
    assert.ok(!calls.some(c => c[1] === '-'), 'no crontab - call recorded');
    assert.equal(r2.warnings.length, 1);
    assert.match(r2.warnings[0], /crontab -l failed/);
    assert.deepEqual(r2.warnings, warnings);
    assert.equal(r2.written.length, 0, 'no cron entry written');
  }

  // A genuine "no crontab for <user>" IS empty — the three routine lines are written.
  {
    let writeInput = null;
    const exec = (cmd, args, opts) => {
      if (args[0] === '-l') throw Object.assign(new Error('no crontab for atlas'), { stderr: 'no crontab for atlas', status: 1 });
      if (args[0] === '-') { writeInput = opts && opts.input; }
      return '';
    };
    const r3 = S.installSchedules({ platform: 'linux', vars, launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile, exec });
    assert.equal(r3.warnings.length, 0);
    assert.equal(r3.written.length, 1);
    const writtenLines = writeInput.trim().split('\n');
    assert.equal(writtenLines.length, 3);
    for (const slug of ['monitor', 'sitrep', 'brief']) assert.ok(writtenLines.some(l => l.endsWith(`${S.CRON_TAG}${slug}`)), slug);
  }

  // execution amendment 2026-09-15 (A57): a failing `crontab -` on removeSchedules is reported, never thrown —
  // `aos uninstall` must finish its teardown.
  {
    const existingCrontab = `0 9 * * * echo mine\n${S.renderCron(ALL, vars).trim()}\n`;
    const exec = (cmd, args) => {
      if (args[0] === '-l') return existingCrontab;
      if (args[0] === '-') throw Object.assign(new Error('crontab: /var/spool/cron: Permission denied'), { status: 1 });
      return '';
    };
    const rm = S.removeSchedules({ platform: 'linux', vault: v.dir, launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile, exec });
    assert.equal(rm.warnings.length, 1);
    assert.match(rm.warnings[0], /crontab - failed/);
  }
});

test('unsupported platforms install nothing and say so', () => {
  const v = vault([]);
  const r = S.installSchedules({ platform: 'win32', vars: { ...VARS, VAULT: v.dir, LOG_DIR: v.logDir }, launchAgentsDir: v.launchAgentsDir, stateFile: v.stateFile });
  assert.deepEqual(r.written, []);
  assert.equal(r.unsupported, true);
});

test('removeSchedules without a vault still deletes the legacy duty plists (uninstall on a pre-migration machine) and never the Ollama supervisor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-'));
  for (const f of ['com.agenticos.monitor.plist', 'com.agenticos.sitrep.plist', 'com.agenticos.ollama.plist', 'com.agenticos.custom.plist']) fs.writeFileSync(path.join(dir, f), '<plist/>\n');
  const calls = [];
  const rm = S.removeSchedules({ platform: 'linux', launchAgentsDir: dir, exec: (cmd, args) => { calls.push([cmd, ...args]); return ''; }, readCrontab: () => '', writeCrontab: () => { throw new Error('no crontab write expected'); } });
  assert.deepEqual(rm.removed.map(p => path.basename(p)).sort(), ['com.agenticos.monitor.plist', 'com.agenticos.sitrep.plist']);
  assert.ok(fs.existsSync(path.join(dir, 'com.agenticos.ollama.plist')), 'com.agenticos.ollama is Plan 2\'s, installed by hand');
  assert.ok(fs.existsSync(path.join(dir, 'com.agenticos.custom.plist')), 'an unknown label is not ours without a file or a sync record');
  assert.equal(calls.filter(c => c[0] === 'launchctl').length, 0, 'launchctl only runs on darwin');
});
