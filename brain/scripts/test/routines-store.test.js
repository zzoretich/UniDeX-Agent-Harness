'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/routines-store.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'routines');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aos-routines-'));

test('list: every fixture, sorted, invalid ones carry errors', () => {
  const all = store.list({ dir: FIXTURES });
  assert.deepEqual(all.map(r => r.slug), ['bad-cron', 'bad-engine', 'bad-kind', 'local-digest', 'missing-argv', 'monitor', 'morning-brief', 'scan-refresh']);
  const bySlug = Object.fromEntries(all.map(r => [r.slug, r]));
  assert.deepEqual(bySlug.monitor.errors, []);
  assert.deepEqual(bySlug['morning-brief'].errors, []);
  assert.deepEqual(bySlug['scan-refresh'].errors, []);
  assert.deepEqual(bySlug['local-digest'].errors, []);
  assert.match(bySlug['bad-cron'].errors[0], /^schedule: hour/);
  assert.deepEqual(bySlug['bad-engine'].errors, ['engine is for prompt routines only']);
  assert.match(bySlug['bad-kind'].errors[0], /^kind must be one of/);
  assert.match(bySlug['missing-argv'].errors[0], /argv/);
});

test('list: a missing dir is an empty list; README.md is skipped', () => {
  assert.deepEqual(store.list({ dir: path.join(os.tmpdir(), 'does-not-exist-' + Date.now()) }), []);
  assert.ok(!store.list({ dir: FIXTURES }).some(r => r.slug.toLowerCase() === 'readme'));
});

test('read: frontmatter types, flow arrays with quoted items, body', () => {
  const r = store.read('morning-brief', { dir: FIXTURES });
  assert.equal(r.schema, 1);
  assert.equal(r.kind, 'prompt');
  assert.equal(r.schedule, '30 7 * * 1-5');
  assert.equal(r.enabled, true);
  assert.equal(r.budgetUsd, 0.5);
  assert.equal(r.timeoutSec, 600);
  assert.deepEqual(r.tags, ['brief', 'two words']);
  assert.match(r.body, /^Read today's daily note/);
  assert.match(r.body, /one action\.\n$/);
  const cmd = store.read('scan-refresh', { dir: FIXTURES });
  assert.deepEqual(cmd.argv, ['node', 'brain/scripts/scan-vault.js', '--quiet']);
  assert.equal(cmd.enabled, false);
  assert.equal(cmd.body, '');
  assert.equal(store.read('nope', { dir: FIXTURES }), null);
  assert.equal(store.read('../etc/passwd', { dir: FIXTURES }), null);
  const local = store.read('local-digest', { dir: FIXTURES });
  assert.equal(local.engine, 'local');
  assert.equal(local.model, 'qwen3.5:9b');
  assert.equal(local.maxTurns, 12);
  assert.deepEqual(local.writes, ['notes/digests/', 'brain/reflections/*.md']);
  assert.equal(local.output, 'notify');
});

// local-first A6/A7: engine and model for prompt routines; writes, maxTurns and output for the local agent. A routine
// without engine is valid exactly as before (the runner keeps today's resolution).
test('validate: engine, maxTurns, writes and output on prompt routines', () => {
  const base = { slug: 'ok-slug', schema: 1, name: 'x', kind: 'prompt', schedule: '0 9 * * *', enabled: true, body: 'hi' };
  for (const engine of store.ENGINES) assert.deepEqual(store.validate({ ...base, engine }), [], engine);
  assert.deepEqual(store.ENGINES, ['local', 'claude', 'codex']);
  assert.deepEqual(store.validate({ ...base, engine: 'codex', model: 'gpt-6-sol' }), []);
  assert.deepEqual(store.validate({ ...base, engine: 'local', model: 'qwen3.5:4b', maxTurns: 24, writes: ['notes/', 'notes/**/*.md', 'TODO.md'], output: 'notes/out.md' }), []);
  assert.deepEqual(store.validate({ ...base, output: 'log' }), []);
  assert.deepEqual(store.validate({ ...base, output: 'notify' }), []);
  assert.deepEqual(store.validate({ ...base, engine: 'ollama' }), ['engine must be one of local, claude, codex']);
  assert.deepEqual(store.validate({ ...base, engine: null }), ['engine must be one of local, claude, codex']);
  assert.deepEqual(store.validate({ ...base, kind: 'duty', engine: 'local' }), ['engine is for prompt routines only']);
  assert.deepEqual(store.validate({ ...base, kind: 'command', argv: ['ls'], engine: 'claude' }), ['engine is for prompt routines only']);
  for (const maxTurns of [0, -1, 1.5, 201, '5']) assert.match(store.validate({ ...base, maxTurns }).join(), /maxTurns/, String(maxTurns));
  assert.deepEqual(store.validate({ ...base, maxTurns: 200 }), []);
  for (const writes of ['notes/', ['/abs/notes/'], ['../out/'], ['notes/../../x'], ['a,b'], [''], ['~/x']]) {
    assert.match(store.validate({ ...base, writes }).join(), /writes/, JSON.stringify(writes));
  }
  for (const output of ['daily', 'notes/out.txt', '/abs/out.md', '../out.md', 3]) assert.match(store.validate({ ...base, output }).join(), /output/, String(output));
  // The duty's writes rule is unchanged: paths, no commas.
  assert.deepEqual(store.validate({ ...base, kind: 'duty', writes: ['notes/inbox/'] }), []);
});

test('KEY_ORDER: engine sits before model, maxTurns after budgetUsd, output after writes', () => {
  const text = store.toFile({ slug: 'k', schema: 1, name: 'K', kind: 'prompt', schedule: '0 9 * * *', enabled: true, output: 'notify', writes: ['notes/'], maxTurns: 8, model: 'qwen3.5:4b', engine: 'local', body: 'go' });
  assert.equal(text, '---\nschema: 1\nname: K\nkind: prompt\nschedule: "0 9 * * *"\nenabled: true\nengine: local\nmodel: "qwen3.5:4b"\nmaxTurns: 8\nwrites: [notes/]\noutput: notify\n---\n\ngo\n');
});

test('validate: kind-specific rules and the slug rule', () => {
  const base = { slug: 'ok-slug', schema: 1, name: 'x', kind: 'prompt', schedule: '0 9 * * *', enabled: true, body: 'hi' };
  assert.deepEqual(store.validate(base), []);
  assert.deepEqual(store.validate({ ...base, kind: 'command', argv: ['ls'] }), []);
  assert.deepEqual(store.validate({ ...base, kind: 'duty', body: '' }), []);
  assert.deepEqual(store.validate({ ...base, kind: 'duty', body: '', budgetUsd: 0.05, tools: 'Read,Glob' }), [], 'a duty may carry its own budget and allowlist');
  assert.match(store.validate({ ...base, kind: 'duty', budgetUsd: -1 }).join(), /budgetUsd/);
  assert.match(store.validate({ ...base, kind: 'duty', tools: ['Read'] }).join(), /tools/);
  assert.deepEqual(store.validate({ ...base, kind: 'duty', body: '', writes: ['notes/inbox/', 'TODO.md'] }), [], 'a duty may widen its write scope');
  assert.match(store.validate({ ...base, kind: 'duty', writes: 'notes/' }).join(), /writes/);
  assert.match(store.validate({ ...base, kind: 'duty', writes: ['a,b'] }).join(), /writes/);
  assert.match(store.validate({ ...base, kind: 'duty', tools: ' ' }).join(), /tools/);
  assert.deepEqual(store.validate({ ...base, kind: 'duty', body: '', model: 'sonnet', effort: 'high' }), [], 'a duty may pick its own model and effort');
  assert.match(store.validate({ ...base, kind: 'duty', effort: 'max' }).join(), /effort/);
  assert.match(store.validate({ ...base, kind: 'duty', model: ' ' }).join(), /model/);
  assert.match(store.validate({ ...base, body: '' }).join(), /needs a body/);
  assert.match(store.validate({ ...base, effort: 'max' }).join(), /effort/);
  assert.match(store.validate({ ...base, budgetUsd: -1 }).join(), /budgetUsd/);
  assert.match(store.validate({ ...base, timeoutSec: 1.5 }).join(), /timeoutSec/);
  assert.match(store.validate({ ...base, tags: 'x' }).join(), /tags/);
  assert.match(store.validate({ ...base, guarded: 'yes' }).join(), /guarded/);
  assert.match(store.validate({ ...base, enabled: 'true' }).join(), /enabled/);
  assert.match(store.validate({ ...base, schema: 2 }).join(), /schema/);
  assert.match(store.validate({ ...base, schedule: '0 9 1 * 1' }).join(), /both be restricted/);
  assert.match(store.validate({ ...base, kind: 'command', argv: ['ls', 3] }).join(), /argv/);
  for (const slug of ['A', 'a', '-a', 'a b', 'a'.repeat(42), 'Ünï']) {
    assert.match(store.validate({ ...base, slug }).join(), /slug/, `slug ${JSON.stringify(slug)}`);
  }
});

test('write + read round-trips every valid fixture byte-for-byte after one normalisation', () => {
  const dir = tmpDir();
  for (const slug of ['monitor', 'morning-brief', 'scan-refresh', 'local-digest']) {
    const r = store.read(slug, { dir: FIXTURES });
    store.write(r, { dir });
    const again = store.read(slug, { dir });
    const strip = (x) => { const { errors, ...rest } = x; return rest; };   // eslint-disable-line no-unused-vars
    assert.deepEqual(strip(again), strip(r), slug);
    // Second write is a fixed point.
    const first = fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8');
    store.write(again, { dir });
    assert.equal(fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8'), first);
  }
});

test('write: refuses an invalid routine and leaves no file behind', () => {
  const dir = tmpDir();
  assert.throws(() => store.write({ slug: 'x-y', schema: 1, name: 'n', kind: 'prompt', schedule: 'bad', enabled: true, body: 'b' }, { dir }), /invalid routine: schedule/);
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('serializer: quoting rules and key order', () => {
  const text = store.toFile({ slug: 's', schema: 1, name: 'Needs "quotes": yes', kind: 'command', schedule: '0 9 * * *', enabled: true,
    argv: ['sh', '-c', 'echo "hi, there"'], tags: ['true', 'plain'], body: '' });
  const lines = text.split('\n');
  assert.equal(lines[0], '---');
  assert.deepEqual(lines.slice(1, 8), [
    'schema: 1',
    'name: "Needs \\"quotes\\": yes"',
    'kind: command',
    'schedule: "0 9 * * *"',
    'enabled: true',
    'argv: [sh, "-c", "echo \\"hi, there\\""]',
    'tags: ["true", plain]',
  ]);
  const back = store.fromFile('s', text);
  assert.deepEqual(back.argv, ['sh', '-c', 'echo "hi, there"']);
  assert.deepEqual(back.tags, ['true', 'plain']);
  assert.equal(back.name, 'Needs "quotes": yes');
});

test('parseFrontmatter: no block, unterminated block, comments, unknown keys kept', () => {
  assert.deepEqual(store.parseFrontmatter('plain').hasFrontmatter, false);
  assert.deepEqual(store.parseFrontmatter('---\nname: x\n').hasFrontmatter, false);
  const { frontmatter, body } = store.parseFrontmatter('---\n# a comment\nname: x\ncustom: 3\nempty:\n---\n\nbody\n');
  assert.deepEqual(frontmatter, { name: 'x', custom: 3, empty: null });
  assert.equal(body, 'body\n');
  assert.match(store.fromFile('s', 'no frontmatter').errors[0], /no frontmatter/);
});

test('fingerprint: kind, schedule (whitespace-normalised) and enabled', () => {
  const a = { kind: 'duty', schedule: '0  13 * * *', enabled: true };
  assert.equal(store.fingerprint(a), 'duty|0 13 * * *|on');
  assert.notEqual(store.fingerprint(a), store.fingerprint({ ...a, enabled: false }));
  assert.equal(store.fingerprint(a), store.fingerprint({ ...a, schedule: '0 13 * * *', name: 'different' }));
});

test('state: missing/corrupt → empty; patchState creates and updates; schema pinned', () => {
  const file = path.join(tmpDir(), 'routines.json');
  assert.deepEqual(store.readState({ file }), { schema: 1, routines: {}, synced: {}, syncedAt: null });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(store.readState({ file }).routines, {});
  const e = store.patchState('monitor', (cur) => ({ ...cur, lastExit: 0, lastRunAt: '2026-09-21T13:00:00.000Z', failStreak: 0 }), { file });
  assert.equal(e.lastExit, 0);
  store.patchState('monitor', (cur) => { cur.failStreak = 2; }, { file });
  const st = store.readState({ file });
  assert.equal(st.routines.monitor.failStreak, 2);
  assert.equal(st.routines.monitor.lastRunAt, '2026-09-21T13:00:00.000Z');
  assert.equal(st.schema, 1);
  store.writeState({ ...st, synced: { monitor: 'duty|0 13 * * *|on' }, syncedAt: 'x' }, { file });
  assert.equal(store.readState({ file }).synced.monitor, 'duty|0 13 * * *|on');
});

test('health: off, invalid, stale, failed, missed, ok', () => {
  const r = { kind: 'duty', schedule: '0 13 * * *', enabled: true, errors: [] };
  const now = new Date(2026, 8, 21, 14, 0);
  assert.equal(store.health({ ...r, enabled: false }, null, now), 'off');
  assert.equal(store.health({ ...r, errors: ['x'] }, null, now), 'invalid');
  assert.equal(store.health(r, null, now, { synced: 'duty|0 12 * * *|on' }), 'stale');
  assert.equal(store.health(r, { lastExit: 1 }, now), 'failed');
  assert.equal(store.health(r, { lastExit: 0, lastRunAt: new Date(2026, 8, 20, 13, 0).toISOString() }, now), 'missed');
  assert.equal(store.health(r, { lastExit: 0, lastRunAt: new Date(2026, 8, 21, 13, 0).toISOString() }, now), 'ok');
  assert.equal(store.health(r, { lastExit: 0, lastRunAt: new Date(2026, 8, 20, 13, 0).toISOString() }, new Date(2026, 8, 21, 13, 10)), 'ok', 'inside the grace window');
  assert.equal(store.health(r, null, now), 'ok', 'never run, never synced: nothing to miss yet');
});

// ---------- duty log fallback (spec host-routines D1) ----------

function dutyWorld() {
  const dir = tmpDir();
  const logDir = path.join(dir, 'persona', 'journal', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const rdir = path.join(dir, 'brain', 'routines');
  store.write({ slug: 'monitor', schema: 1, name: 'Monitor', kind: 'duty', schedule: '0 13 * * *', enabled: true, guarded: true, body: '' }, { dir: rdir });
  store.write({ slug: 'scan', schema: 1, name: 'Scan', kind: 'command', schedule: '0 13 * * *', enabled: true, argv: ['true'], body: '' }, { dir: rdir });
  const file = path.join(dir, 'brain', '_index', 'routines.json');
  const log = (slug, text, mtime) => {
    const f = path.join(logDir, `duty-${slug}.log`);
    fs.writeFileSync(f, text);
    if (mtime) fs.utimesSync(f, mtime, mtime);
    return f;
  };
  return { dir, rdir, logDir, file, log };
}
const T = (iso) => new Date(iso);

test('dutyLogLast: mtime + the last "done (exit N)" line; start-only, empty, absent and odd slugs are null', () => {
  const w = dutyWorld();
  const done = T('2026-09-21T17:01:00Z');
  w.log('monitor', '[stamp] duty=monitor model=haiku effort=medium budget=2 start\n{"result":"…"}\n[stamp] duty=monitor done (exit 0)\n', done);
  assert.deepEqual(store.dutyLogLast('monitor', { logDir: w.logDir }), { at: done.toISOString(), exit: 0 });
  w.log('monitor', '[stamp] duty=monitor done (exit 3)', done);
  assert.deepEqual(store.dutyLogLast('monitor', { logDir: w.logDir }), { at: done.toISOString(), exit: 3 });
  w.log('monitor', '[stamp] duty=monitor done (exit 0)\n[stamp] duty=monitor model=haiku start\n', done);
  assert.equal(store.dutyLogLast('monitor', { logDir: w.logDir }), null);
  w.log('monitor', '', done);
  assert.equal(store.dutyLogLast('monitor', { logDir: w.logDir }), null);
  assert.equal(store.dutyLogLast('sitrep', { logDir: w.logDir }), null);
  assert.equal(store.dutyLogLast('../etc', { logDir: w.logDir }), null);
  // A log longer than the 4 KiB tail window still finds the last line.
  w.log('monitor', 'x'.repeat(10_000) + '\n[stamp] duty=monitor done (exit 0)\n', done);
  assert.equal(store.dutyLogLast('monitor', { logDir: w.logDir }).exit, 0);
});

test('mergeDutyLog: a newer log run replaces the entry (trigger duty-log); the runner\'s own run keeps the entry', () => {
  const w = dutyWorld();
  const duty = { slug: 'monitor', kind: 'duty' };
  // Runner recorded a 55 s run starting 15:49; the log's end (mtime) is inside that window → the entry wins.
  const entry = { lastRunAt: '2026-09-21T19:49:12.000Z', lastExit: 0, lastCostUsd: 0.12, lastDurationMs: 55_000, failStreak: 0, lastTrigger: 'manual', lastError: null };
  w.log('monitor', '[stamp] duty=monitor done (exit 0)', T('2026-09-21T19:50:07Z'));
  assert.equal(store.mergeDutyLog(duty, entry, { logDir: w.logDir }), entry);
  // A run three hours later that bypassed run-routine.js → synthesized entry, cost unknown.
  w.log('monitor', '[stamp] duty=monitor done (exit 0)', T('2026-09-21T23:00:00Z'));
  const merged = store.mergeDutyLog(duty, entry, { logDir: w.logDir });
  assert.deepEqual(merged, { lastRunAt: '2026-09-21T23:00:00.000Z', lastExit: 0, lastCostUsd: null, lastDurationMs: null, failStreak: 0, lastTrigger: 'duty-log', lastError: null });
  // A failed log run after a failed entry increments the streak; no entry at all still synthesizes.
  w.log('monitor', '[stamp] duty=monitor done (exit 1)', T('2026-09-21T23:00:00Z'));
  assert.equal(store.mergeDutyLog(duty, { ...entry, lastExit: 1, failStreak: 2 }, { logDir: w.logDir }).failStreak, 3);
  const fresh = store.mergeDutyLog(duty, null, { logDir: w.logDir });
  assert.equal(fresh.lastExit, 1); assert.equal(fresh.failStreak, 1); assert.match(fresh.lastError, /from the duty log/);
  // An older log than the entry, a non-duty routine, or no log: the entry as it was.
  w.log('monitor', '[stamp] duty=monitor done (exit 1)', T('2026-09-20T13:00:00Z'));
  assert.equal(store.mergeDutyLog(duty, entry, { logDir: w.logDir }), entry);
  assert.equal(store.mergeDutyLog({ slug: 'monitor', kind: 'command' }, entry, { logDir: w.logDir }), entry);
  assert.equal(store.mergeDutyLog({ slug: 'sitrep', kind: 'duty' }, null, { logDir: w.logDir }), null);
});

test('overview: a duty run seen only in its log shows as its last run and clears "missed"', () => {
  const w = dutyWorld();
  const now = T('2026-09-21T23:00:00Z');
  // Schedules applied yesterday, nothing recorded since: the 13:00 fire looks missed…
  store.writeState({ routines: {}, synced: { monitor: 'duty|0 13 * * *|on', scan: 'command|0 13 * * *|on' }, syncedAt: '2026-09-20T20:00:00Z' }, { file: w.file });
  let rows = store.overview({ dir: w.rdir, file: w.file, logDir: w.logDir, now });
  assert.equal(rows.find(r => r.slug === 'monitor').health, 'missed');
  assert.equal(rows.find(r => r.slug === 'monitor').last, null);
  // …until the duty log says the 13:00 run happened (this machine's exact case).
  w.log('monitor', '[stamp] duty=monitor done (exit 0)', T('2026-09-21T17:01:00Z'));
  rows = store.overview({ dir: w.rdir, file: w.file, logDir: w.logDir, now });
  const m = rows.find(r => r.slug === 'monitor');
  assert.equal(m.health, 'ok');
  assert.deepEqual(m.last, { at: '2026-09-21T17:01:00.000Z', exit: 0, usd: null, ms: null, trigger: 'duty-log', failStreak: 0, error: null });
  // The command routine has no duty log and is still missed.
  assert.equal(rows.find(r => r.slug === 'scan').health, 'missed');
  // A failing log run reads as failed.
  w.log('monitor', '[stamp] duty=monitor done (exit 2)', T('2026-09-21T17:01:00Z'));
  assert.equal(store.overview({ dir: w.rdir, file: w.file, logDir: w.logDir, now }).find(r => r.slug === 'monitor').health, 'failed');
});
