'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./routines.js');
const store = require('../brain/scripts/lib/routines-store.js');

function world() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cfg-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ vault, node: process.execPath, claude: { model: 'haiku' } }));
  const logs = []; const errs = [];
  const io = { log: (m) => logs.push(String(m)), error: (m) => errs.push(String(m)) };
  const dir = path.join(vault, 'brain', 'routines');
  const put = (slug, extra = {}, body = '') => store.write({ slug, schema: 1, name: slug, kind: 'command', schedule: '0 9 * * *', enabled: true, argv: ['true'], ...extra, body }, { dir });
  return { configDir, vault, io, logs, errs, dir, put, out: () => logs.join('\n') };
}
const NOW = new Date(2026, 8, 21, 14, 0);   // Mon 2026-09-21 14:00 local

test('list: empty vault says where routines live', async () => {
  const w = world();
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io }), 0);
  assert.match(w.out(), /no routines under .*brain\/routines/);
});

test('list: a table with cadence, next fire, last run and health; --json mirrors it', async () => {
  const w = world();
  w.put('monitor', { kind: 'duty', schedule: '0 13 * * *', guarded: true });
  w.put('off', { enabled: false });
  fs.writeFileSync(path.join(w.dir, 'bad.md'), '---\nschema: 1\nname: bad\nkind: command\nschedule: "x"\nenabled: true\nargv: [true]\n---\n');
  store.patchState('monitor', (c) => ({ ...c, lastRunAt: new Date(2026, 8, 21, 13, 0).toISOString(), lastExit: 0, lastCostUsd: 0.12, failStreak: 0, lastTrigger: 'scheduled' }), { file: path.join(w.vault, 'brain', '_index', 'routines.json') });
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  const out = w.out();
  assert.match(out, /^slug\s+kind\s+on\s+cadence\s+next\s+last\s+health$/m);
  assert.match(out, /^monitor\s+duty\s+on\s+Every day at 13:00\s+Tue 2026-09-22 13:00\s+1h ago \(exit 0, \$0\.12\)\s+ok$/m);
  assert.match(out, /^off\s+command\s+off\s+Every day at 09:00\s+—\s+never\s+off$/m);
  assert.match(out, /^bad\s+command\s+on\s+x\s+—\s+never\s+invalid$/m);
  assert.match(w.errs.join('\n'), /^bad: schedule: /m);

  w.logs.length = 0;
  assert.equal(await R.main(['list', '--json'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  const j = JSON.parse(w.out());
  assert.equal(j.schema, 1);
  const m = j.routines.find(r => r.slug === 'monitor');
  assert.equal(m.health, 'ok');
  assert.equal(m.last.usd, 0.12);
  assert.equal(m.next.length, 3);
  assert.equal(j.routines.find(r => r.slug === 'bad').health, 'invalid');
});

test('list: stale after the schedule changed since the last sync; failed after a bad exit', async () => {
  const w = world();
  w.put('alpha');
  const file = path.join(w.vault, 'brain', '_index', 'routines.json');
  store.writeState({ ...store.readState({ file }), synced: { alpha: 'command|0 8 * * *|on' }, syncedAt: NOW.toISOString() }, { file });
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  assert.match(w.out(), /^alpha\s+.*\s+stale$/m);
  store.patchState('alpha', (c) => ({ ...c, lastExit: 3, failStreak: 2 }), { file });
  store.writeState({ ...store.readState({ file }), synced: { alpha: 'command|0 9 * * *|on' } }, { file });
  w.logs.length = 0;
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  assert.match(w.out(), /^alpha\s+.*\s+failed$/m);
});

test('sync: builds the template vars from persona answers and reports labels, removals and warnings', async () => {
  const w = world();
  w.put('alpha');
  fs.mkdirSync(path.join(w.vault, 'persona'), { recursive: true });
  fs.writeFileSync(path.join(w.vault, 'persona', 'answers.json'), JSON.stringify({ name: 'Atlas', dutyModel: 'sonnet', dutyEffort: 'high' }));
  let seen = null;
  const installSchedules = (o) => { seen = o; o.warn('launchctl load x: boom'); return { platform: 'darwin', written: ['x'], removed: ['/tmp/la/com.agenticos.gone.plist'], labels: ['com.agenticos.alpha'], warnings: ['launchctl load x: boom'] }; };
  assert.equal(await R.main(['sync'], { configDir: w.configDir, io: w.io, installSchedules, platform: 'darwin' }), 1, 'a warning makes sync exit 1');
  assert.equal(seen.vars.VAULT, w.vault);
  assert.equal(seen.vars.AGENT_NAME, 'Atlas');
  assert.equal(seen.vars.MODEL, 'sonnet');
  assert.equal(seen.vars.EFFORT, 'high');
  assert.equal(seen.vars.NODE, process.execPath);
  assert.equal(seen.vars.AOS_CONFIG, path.join(w.configDir, 'agenticos.json'));
  assert.equal(seen.platform, 'darwin');
  assert.match(w.out(), /routines: scheduled com\.agenticos\.alpha; removed com\.agenticos\.gone\.plist/);
  assert.match(w.errs.join('\n'), /warning: launchctl load x: boom/);
  w.logs.length = 0;
  assert.equal(await R.main(['sync'], { configDir: w.configDir, io: w.io, installSchedules: () => ({ platform: 'win32', unsupported: true, written: [], removed: [], labels: [], warnings: [] }) }), 0);
  assert.match(w.out(), /not supported on win32/);
});

test('sync: persona.model and persona.effort in brain/config.json win over the interview answers (duty-model-settings D3)', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.vault, 'persona'), { recursive: true });
  fs.writeFileSync(path.join(w.vault, 'persona', 'answers.json'), JSON.stringify({ name: 'Atlas', dutyModel: 'haiku', dutyEffort: 'medium' }));
  fs.mkdirSync(path.join(w.vault, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'), JSON.stringify({ persona: { model: 'sonnet', effort: 'high' } }));
  let seen = null;
  await R.main(['sync'], { configDir: w.configDir, io: w.io, installSchedules: (o) => { seen = o; return { platform: 'linux', written: [], removed: [], labels: [], warnings: [] }; } });
  assert.equal(seen.vars.MODEL, 'sonnet');
  assert.equal(seen.vars.EFFORT, 'high');
  assert.equal(seen.vars.AGENT_NAME, 'Atlas');
});

test('sync --if-installed re-renders only where schedules are installed, and never installs them (install-import B10)', async () => {
  const w = world();
  w.put('alpha');
  let synced = 0;
  let asked = null;
  const installSchedules = () => { synced++; return { platform: 'darwin', written: [], removed: ['/tmp/la/com.agenticos.import-digest.plist'], labels: ['com.agenticos.alpha'], warnings: [] }; };
  const none = { configDir: w.configDir, io: w.io, installSchedules, platform: 'darwin', isInstalled: (o) => { asked = o; return false; } };
  assert.equal(await R.main(['sync', '--if-installed'], none), 0);
  assert.equal(synced, 0, 'nothing installed here: nothing rendered or loaded');
  assert.deepEqual(asked, { platform: 'darwin', vault: w.vault });
  assert.match(w.out(), /no schedules installed here; nothing re-rendered/);
  w.logs.length = 0;
  assert.equal(await R.main(['sync', '--if-installed'], { ...none, isInstalled: () => true }), 0);
  assert.equal(synced, 1);
  assert.match(w.out(), /routines: scheduled com\.agenticos\.alpha; removed com\.agenticos\.import-digest\.plist/);
  assert.equal(await R.main(['sync'], { ...none }), 0, 'plain sync installs whatever is installed or not');
  assert.equal(synced, 2);
});

test('sync without persona answers falls back to claude.model and the default agent name', async () => {
  const w = world();
  let seen = null;
  await R.main(['sync'], { configDir: w.configDir, io: w.io, installSchedules: (o) => { seen = o; return { platform: 'linux', written: [], removed: [], labels: [], warnings: [] }; } });
  assert.equal(seen.vars.MODEL, 'haiku');
  assert.equal(seen.vars.AGENT_NAME, 'persona');
  assert.match(w.out(), /scheduled nothing \(no enabled routine\)/);
});

test('enable/disable rewrite the file and sync; unknown or invalid slugs exit 2', async () => {
  const w = world();
  w.put('alpha');
  let synced = 0;
  const opts = { configDir: w.configDir, io: w.io, installSchedules: () => { synced++; return { platform: 'linux', written: [], removed: [], labels: [], warnings: [] }; } };
  assert.equal(await R.main(['disable', 'alpha'], opts), 0);
  assert.equal(store.read('alpha', { dir: w.dir }).enabled, false);
  assert.equal(await R.main(['enable', 'alpha'], opts), 0);
  assert.equal(store.read('alpha', { dir: w.dir }).enabled, true);
  assert.equal(synced, 2);
  assert.match(w.out(), /alpha: disabled[\s\S]*alpha: enabled/);
  assert.equal(await R.main(['enable', 'nope'], opts), 2);
  await assert.rejects(() => R.main(['enable'], opts), R.UsageError);
});

test('run: spawns the vendored runner with --manual (and --dry-run), propagating its exit code', async () => {
  const w = world();
  w.put('alpha');
  fs.mkdirSync(path.join(w.vault, 'brain', 'scripts', 'routines'), { recursive: true });
  fs.writeFileSync(path.join(w.vault, 'brain', 'scripts', 'routines', 'run-routine.js'), '// vendored\n');
  let seen = null;
  const spawn = (cmd, args, o) => { seen = { cmd, args, o }; return { status: 3 }; };
  assert.equal(await R.main(['run', 'alpha', '--dry-run'], { configDir: w.configDir, io: w.io, spawn }), 3);
  assert.equal(seen.cmd, process.execPath);
  assert.deepEqual(seen.args, [path.join(w.vault, 'brain', 'scripts', 'routines', 'run-routine.js'), 'alpha', '--manual', '--dry-run']);
  assert.equal(seen.o.env.AOS_VAULT, w.vault);
  assert.equal(seen.o.cwd, w.vault);
  assert.equal(await R.main(['run', 'nope'], { configDir: w.configDir, io: w.io, spawn }), 2);
  await assert.rejects(() => R.main(['run'], { configDir: w.configDir, io: w.io, spawn }), R.UsageError);
});

test('next: three fire times per routine, disabled and invalid rows say so', async () => {
  const w = world();
  w.put('alpha', { schedule: '45 7 * * 1-5' });
  w.put('off', { enabled: false });
  assert.equal(await R.main(['next'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  assert.match(w.out(), /^alpha: Weekdays at 07:45\n  Tue 2026-09-22 07:45\n  Wed 2026-09-23 07:45\n  Thu 2026-09-24 07:45$/m);
  assert.match(w.out(), /^off: disabled$/m);
  w.logs.length = 0;
  assert.equal(await R.main(['next', 'alpha'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  assert.ok(!w.out().includes('off:'));
  assert.equal(await R.main(['next', 'nope'], { configDir: w.configDir, io: w.io }), 2);
});

test('unknown verb is a usage error; no verb means list', async () => {
  const w = world();
  await assert.rejects(() => R.main(['frob'], { configDir: w.configDir, io: w.io }), /unknown verb "frob"/);
  assert.equal(await R.main([], { configDir: w.configDir, io: w.io }), 0);
  assert.match(w.out(), /no routines/);
});

// ---------- hosts / import-cloud (spec host-routines D3–D4) ----------

const H = require('../brain/scripts/lib/host-routines.js');
// The host payloads are absolute UTC instants, so their clock is too: a local 14:00 NOW falls before the fixture's
// 13:00Z run east of UTC+1, and the last run would read as in the future (spec 2026-09-23-ci-safety-net-design D5).
const HOST_NOW = new Date('2026-09-21T14:00:00Z');
const CLOUD = { data: [
  { id: 'trig_a', name: 'Weekly digest', cron_expression: '0 13 * * 1', enabled: true, next_run_at: '2026-09-28T13:00:00Z', last_fired_at: '2026-09-21T13:00:05Z',
    derived_state: { model: 'claude-sonnet-5', prompt: 'Summarize.' }, job_config: { ccr: { session_context: { sources: [{ git_repository: { url: 'https://github.com/example/repo' } }] } } } },
  { id: 'trig_b', name: 'One shot', run_once_at: '2026-05-16T13:00:00Z', enabled: false, last_fired_at: '2026-05-16T13:00:06Z', ended_reason: 'run_once_fired' },
] };
function codexWorld(w, rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-codex-'));
  fs.mkdirSync(path.join(home, 'sqlite'), { recursive: true });
  fs.writeFileSync(H.codexDbPath(home), '');
  fs.writeFileSync(path.join(w.configDir, 'agenticos.json'), JSON.stringify({ vault: w.vault, node: process.execPath, hosts: { codex: { home } } }));
  return { home, exec: () => JSON.stringify(rows) };
}
const CODEX = [{ id: 'auto_1', name: 'Nightly triage', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=22;BYMINUTE=0', next_run_at: Date.parse('2026-09-22T02:00:00Z'),
  last_run_at: Date.parse('2026-09-21T02:00:00Z'), model: 'gpt-5-codex', cwds: '["/tmp/proj"]', prompt: 'Triage.', run_status: 'completed', run_at: Date.parse('2026-09-21T02:00:30Z') }];

test('hosts: empty says how to fill it; --refresh reads Codex through the injected sqlite3; --json is the cache', async () => {
  const w = world();
  assert.equal(await R.main(['hosts'], { configDir: w.configDir, io: w.io, now: HOST_NOW }), 0);
  assert.match(w.out(), /no host routines yet — `aos routines hosts --refresh`/);
  const { exec } = codexWorld(w, CODEX);
  w.logs.length = 0;
  assert.equal(await R.main(['hosts', '--refresh'], { configDir: w.configDir, io: w.io, now: HOST_NOW, exec }), 0);
  assert.match(w.out(), /^host\s+name\s+cadence\s+on\s+next\s+last\s+as-of$/m);
  assert.match(w.out(), /^codex\s+Nightly triage\s+Every day at 22:00\s+on\s+(Mon|Tue) 2026-09-2\d \d\d:\d\d\s+\d+h ago \(completed\)\s+1s ago$/m);
  assert.deepEqual(w.errs, []);
  w.logs.length = 0;
  assert.equal(await R.main(['hosts', '--json'], { configDir: w.configDir, io: w.io, now: HOST_NOW }), 0);
  const cache = JSON.parse(w.out());
  assert.equal(cache.schema, 1); assert.equal(cache.hosts.codex.ok, true); assert.equal(cache.hosts.codex.routines[0].id, 'auto_1');
  assert.ok(fs.existsSync(path.join(w.vault, 'brain', '_index', 'routines-hosts.json')));
});

test('hosts --refresh: an unreadable Codex database is a warning row, never a failure', async () => {
  const w = world();
  codexWorld(w, []);
  const exec = () => { const e = new Error('spawn sqlite3 ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.equal(await R.main(['hosts', '--refresh'], { configDir: w.configDir, io: w.io, now: HOST_NOW, exec }), 0);
  assert.match(w.out(), /no host routines \(codex checked\)/);
  assert.match(w.errs.join('\n'), /^warning: codex: could not read Codex automations: sqlite3 is not on PATH$/m);
});

test('import-cloud: from a file and from stdin, then the HOSTS table; a bad payload exits 2; list appends HOSTS', async () => {
  const w = world();
  const file = path.join(w.vault, 'cloud.json');
  fs.writeFileSync(file, JSON.stringify(CLOUD));
  assert.equal(await R.main(['import-cloud', file], { configDir: w.configDir, io: w.io, now: HOST_NOW }), 0);
  assert.match(w.out(), /^import-cloud: 2 cloud routines → .*routines-hosts\.json$/m);
  assert.match(w.out(), /^claude\s+One shot\s+once at (Sat|Sun|Mon) 2026-05-1\d \d\d:\d\d\s+off\s+—\s+\d+d ago \(ran once\)\s+1s ago$/m);
  assert.match(w.out(), /^claude\s+Weekly digest\s+Mondays at 13:00 \(UTC\)\s+on\s+(Mon|Tue) 2026-09-2[89] \d\d:\d\d\s+\d+[mh] ago \(fired\)\s+1s ago$/m);
  w.logs.length = 0;
  assert.equal(await R.main(['import-cloud', '-'], { configDir: w.configDir, io: w.io, now: HOST_NOW, stdin: () => JSON.stringify({ data: [] }) }), 0);
  assert.match(w.out(), /^import-cloud: 0 cloud routines/m);
  assert.match(w.out(), /no host routines \(claude checked\)/);
  w.logs.length = 0; w.errs.length = 0;
  fs.writeFileSync(file, JSON.stringify({ nope: 1 }));
  assert.equal(await R.main(['import-cloud', file], { configDir: w.configDir, io: w.io, now: HOST_NOW }), 2);
  assert.match(w.errs.join('\n'), /expected the RemoteTrigger list payload/);
  assert.equal(await R.main(['import-cloud', path.join(w.vault, 'missing.json')], { configDir: w.configDir, io: w.io, now: HOST_NOW }), 2);
  await assert.rejects(R.main(['import-cloud'], { configDir: w.configDir, io: w.io }), R.UsageError);
  // list: the routine table first, then HOSTS from the cache (a codex section beside the claude one).
  fs.writeFileSync(file, JSON.stringify(CLOUD));
  await R.main(['import-cloud', file], { configDir: w.configDir, io: w.io, now: HOST_NOW });
  w.put('monitor', { kind: 'duty', schedule: '0 13 * * *' });
  w.logs.length = 0;
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io, now: HOST_NOW }), 0);
  const out = w.out();
  assert.ok(out.indexOf('slug  kind') < out.indexOf('\nHOSTS\nhost'), 'HOSTS follows the routine table');
  assert.match(out, /^claude\s+Weekly digest/m);
  w.logs.length = 0;
  await R.main(['list', '--json'], { configDir: w.configDir, io: w.io, now: HOST_NOW });
  assert.equal(JSON.parse(w.out()).hosts.claude.routines.length, 2);
});

test('list: a duty run recorded only in persona/journal/logs shows as its last run (duty-log)', async () => {
  const w = world();
  w.put('monitor', { kind: 'duty', schedule: '0 13 * * *' });
  const logDir = path.join(w.vault, 'persona', 'journal', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const f = path.join(logDir, 'duty-monitor.log');
  fs.writeFileSync(f, '[stamp] duty=monitor done (exit 0)\n');
  const end = new Date(2026, 8, 21, 13, 1); fs.utimesSync(f, end, end);
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  assert.match(w.out(), /^monitor\s+duty\s+on\s+Every day at 13:00\s+Tue 2026-09-22 13:00\s+59m ago \(exit 0\)\s+ok$/m);
  w.logs.length = 0;
  await R.main(['list', '--json'], { configDir: w.configDir, io: w.io, now: NOW });
  assert.equal(JSON.parse(w.out()).routines[0].last.trigger, 'duty-log');
});
