'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cron = require('../lib/cron.js');
const W = require('../persona/watchdog.js');

// Local-time fixtures: 2026-09-22 is a Tuesday. sitrep fires weekdays 07:45, monitor daily 13:00, reflect Sundays 18:00.
const at = (h, m, d = 22) => new Date(2026, 8, d, h, m, 0, 0);
const iso = (d) => d.toISOString();
const row = (slug, schedule, over = {}) => ({ slug, kind: 'duty', schedule, enabled: true, health: 'ok', next: [], last: null, ...over });
const last = (d, exit = 0) => ({ at: iso(d), exit, usd: null, ms: 1000, trigger: 'scheduled', failStreak: 0, error: null });
const STATE = '---\ntype: persona-state\nupdated: 2026-09-22\n---\n\n# Persona State\n\n## Sitrep\n- fine\n\n## Flags\n- [ ] 2026-09-21 old flag the user owns\n\n## Priorities\n- tests\n';

test('check: ok inside grace, missed past it, computed from the last run', () => {
  const rows = [row('sitrep', '45 7 * * 1-5', { last: last(at(7, 45, 21)) })];
  const ok = W.check(rows, { now: at(8, 29), cron });
  assert.equal(ok.beats.sitrep.status, 'ok');
  assert.deepEqual(ok.misses, []);
  const missed = W.check(rows, { now: at(8, 31), cron });
  assert.equal(missed.beats.sitrep.status, 'missed');
  assert.equal(missed.beats.sitrep.due, iso(at(7, 45)));
  assert.deepEqual(missed.misses, [{ slug: 'sitrep', due: iso(at(7, 45)), lastRunAt: iso(at(7, 45, 21)) }]);
  assert.equal(missed.checkedAt, iso(at(8, 31)));
});

test('check: a duty that never ran is missed one cadence after the schedules were synced, never otherwise', () => {
  const rows = [row('reflect', '0 18 * * 0')];
  assert.equal(W.check(rows, { now: at(9, 0), cron }).beats.reflect.status, 'never');
  assert.equal(W.check(rows, { now: at(9, 0), syncedAt: iso(at(12, 0, 21)), cron }).beats.reflect.status, 'never', 'synced Monday: the first Sunday 18:00 is still ahead, so not yet a miss');
  assert.equal(W.check(rows, { now: at(9, 0), syncedAt: iso(at(12, 0, 13)), cron }).beats.reflect.status, 'missed');
});

test('check: disabled, command, invalid, stale and failed duties are reported but never missed', () => {
  const rows = [
    row('off', '0 13 * * *', { enabled: false }),
    row('heartbeat', '*/30 * * * *', { kind: 'command', last: last(at(1, 0, 1)) }),
    row('broken', 'bad', { health: 'invalid' }),
    row('moved', '0 13 * * *', { health: 'stale', last: last(at(13, 0, 1)) }),
    row('monitor', '0 13 * * *', { health: 'failed', last: last(at(13, 0, 21), 1) }),
  ];
  const r = W.check(rows, { now: at(13, 10), cron });
  assert.deepEqual(Object.fromEntries(Object.entries(r.beats).map(([k, b]) => [k, b.status])),
    { off: 'disabled', heartbeat: 'unwatched', broken: 'invalid', moved: 'stale', monitor: 'failed' });
  assert.deepEqual(r.misses, []);
  // A failed duty that then stops firing is a miss, not a failure — the miss wins.
  assert.equal(W.check(rows, { now: at(14, 0), cron }).beats.monitor.status, 'missed');
});

test('reconcileFlags: adds under the heading, keeps foreign flags, removes only its own on recovery, honours a closed miss', () => {
  const due = iso(at(7, 45));
  const a = W.reconcileFlags(STATE, { misses: [{ slug: 'sitrep', due, lastRunAt: iso(at(7, 45, 21)) }], today: '2026-09-22' });
  assert.equal(a.added.length, 1);
  assert.match(a.text, /## Flags\n- \[ \] 2026-09-22 duty 'sitrep' MISSED — due 2026-09-22 07:45, last run 2026-09-21 07:45 \(watchdog\)\n- \[ \] 2026-09-21 old flag the user owns\n\n## Priorities/);
  const again = W.reconcileFlags(a.text, { misses: [{ slug: 'sitrep', due, lastRunAt: null }], today: '2026-09-22' });
  assert.equal(again.text, a.text, 'idempotent while the miss persists');
  const recovered = W.reconcileFlags(a.text, { misses: [], today: '2026-09-22' });
  assert.deepEqual(recovered.removed, ['sitrep']);
  assert.equal(recovered.text, STATE);
  const closed = W.reconcileFlags(STATE, { misses: [{ slug: 'sitrep', due }], alerted: { sitrep: due }, today: '2026-09-22' });
  assert.equal(closed.text, STATE, 'a (slug, due) the user already closed is not re-added');
  const regressed = W.reconcileFlags(STATE, { regressed: ['trim-state'], today: '2026-09-22' });
  assert.match(regressed.text, /approved proposal 'trim-state' REGRESSED — its recheck exits 0 again \(watchdog\)/);
  const noHeading = W.reconcileFlags('# State\n\n## Priorities\n', { misses: [{ slug: 'x', due }], today: '2026-09-22' });
  assert.equal(noHeading.text, '# State\n\n## Priorities\n');
});

function fixture({ rows, syncedAt = null, cfg = {}, verify = { checked: 0, verified: [], regressed: [] }, state = STATE } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-'));
  const personaDir = path.join(root, 'persona');
  fs.mkdirSync(personaDir, { recursive: true });
  if (state !== null) fs.writeFileSync(path.join(personaDir, 'STATE.md'), state);
  const calls = { notify: [], verify: 0 };
  const deps = {
    vault: root, personaDir,
    stateFile: path.join(root, 'brain', '_index', 'persona-heartbeat.json'),
    store: { readState: () => ({ syncedAt }), overview: () => rows },
    cron,
    ledger: { defaultFile: (v) => path.join(v, 'persona', 'ledger.jsonl'), verify: () => { calls.verify++; return typeof verify === 'function' ? verify() : verify; } },
    config: () => ({ persona: { enabled: true, watchdog: { graceMinutes: 45, notify: true }, ...cfg } }),
    notify: (title, msg) => { calls.notify.push([title, msg]); return true; },
    now: () => at(9, 0),
  };
  return { root, personaDir, deps, calls };
}

test('run: a miss writes the state file, one flag and one notification; a repeat is silent; recovery clears', () => {
  const rows = [row('sitrep', '45 7 * * 1-5', { last: last(at(7, 45, 21)) }), row('monitor', '0 13 * * *', { last: last(at(13, 0, 21)) })];
  const f = fixture({ rows });
  const first = W.run({ deps: f.deps });
  assert.deepEqual(first.notified, ['sitrep']);
  assert.deepEqual(f.calls.notify, [['AgenticOS', "duty 'sitrep' missed its 2026-09-22 07:45 run"]]);
  const st = JSON.parse(fs.readFileSync(f.deps.stateFile, 'utf8'));
  assert.equal(st.schema, 1);
  assert.equal(st.checkedAt, iso(at(9, 0)));
  assert.equal(st.beats.sitrep.status, 'missed');
  assert.equal(st.beats.monitor.status, 'ok');
  assert.deepEqual(st.alerted, { sitrep: iso(at(7, 45)) });
  assert.equal(st.flags.added.length, 1);
  assert.equal(f.calls.verify, 1);
  const md = fs.readFileSync(path.join(f.personaDir, 'STATE.md'), 'utf8');
  assert.match(md, /duty 'sitrep' MISSED/);
  assert.match(md, /old flag the user owns/);

  const second = W.run({ deps: f.deps });
  assert.deepEqual(second.notified, []);
  assert.equal(f.calls.notify.length, 1, 'no second notification for the same miss');
  assert.equal(f.calls.verify, 1, 'verify runs once a day');
  assert.equal(fs.readFileSync(path.join(f.personaDir, 'STATE.md'), 'utf8'), md, 'no duplicate flag');

  rows[0].last = last(at(8, 50));   // the duty ran
  const third = W.run({ deps: f.deps });
  assert.deepEqual(third.state.misses, []);
  assert.deepEqual(third.state.alerted, {});
  assert.deepEqual(third.state.flags.removed, ['sitrep']);
  assert.equal(fs.readFileSync(path.join(f.personaDir, 'STATE.md'), 'utf8'), STATE);
});

test('run: a user-closed flag stays closed for that miss; a regressed approval is flagged and notified', () => {
  const rows = [row('sitrep', '45 7 * * 1-5', { last: last(at(7, 45, 21)) })];
  let verify = { checked: 1, verified: [], regressed: ['trim-state'] };
  const f = fixture({ rows, verify: () => verify });
  W.run({ deps: f.deps });
  assert.equal(f.calls.notify.length, 2);
  assert.match(f.calls.notify[1][1], /'trim-state' regressed/);
  let md = fs.readFileSync(path.join(f.personaDir, 'STATE.md'), 'utf8');
  assert.match(md, /REGRESSED/);
  fs.writeFileSync(path.join(f.personaDir, 'STATE.md'), STATE);   // the user closes both lines
  verify = { checked: 0, verified: [], regressed: [] };
  W.run({ deps: f.deps });
  md = fs.readFileSync(path.join(f.personaDir, 'STATE.md'), 'utf8');
  assert.equal(md, STATE, 'neither line comes back while nothing new happened');
});

test('run: hook mode is throttled, persona off skips without writing, missing STATE.md and a corrupt state file are survived', () => {
  const rows = [row('sitrep', '45 7 * * 1-5', { last: last(at(7, 45, 21)) })];
  const f = fixture({ rows });
  assert.equal(W.run({ hook: true, deps: f.deps }).skipped, undefined);
  assert.equal(W.run({ hook: true, deps: f.deps }).skipped, 'fresh');
  assert.equal(W.run({ deps: f.deps }).skipped, undefined, 'the routine always checks');

  const off = fixture({ rows, cfg: { enabled: false } });
  assert.equal(W.run({ deps: off.deps }).skipped, 'persona off');
  assert.ok(!fs.existsSync(off.deps.stateFile));
  const disabled = fixture({ rows });
  fs.writeFileSync(path.join(disabled.personaDir, 'DISABLED'), '');
  assert.equal(W.run({ deps: disabled.deps }).skipped, 'persona off');

  const bare = fixture({ rows, state: null });
  fs.mkdirSync(path.dirname(bare.deps.stateFile), { recursive: true });
  fs.writeFileSync(bare.deps.stateFile, '{not json');
  const out = W.run({ deps: bare.deps });
  assert.equal(out.state.misses.length, 1);
  assert.deepEqual(out.state.flags, { added: [], removed: [] });
  assert.equal(bare.calls.notify.length, 1);
});

test('run: notify:false suppresses notifications but still flags; verify errors are recorded, not thrown', () => {
  const rows = [row('sitrep', '45 7 * * 1-5', { last: last(at(7, 45, 21)) })];
  const f = fixture({ rows, cfg: { watchdog: { notify: false } }, verify: () => { throw new Error('ledger unreadable'); } });
  const out = W.run({ deps: f.deps });
  assert.deepEqual(f.calls.notify, []);
  assert.deepEqual(out.notified, ['sitrep']);
  assert.match(fs.readFileSync(path.join(f.personaDir, 'STATE.md'), 'utf8'), /MISSED/);
  assert.deepEqual(out.state.verify, { error: 'ledger unreadable' });
});

test('osNotify: unsupported platform returns false and never throws', () => {
  assert.equal(W.osNotify('t', 'm', { platform: 'win32' }), false);
});

test('run: the SessionStart hook never runs recipes; the heartbeat routine still verifies once a day', () => {
  const rows = [row('sitrep', '45 7 * * 1-5', { last: last(at(7, 45, 21)) })];
  const f = fixture({ rows });
  const out = W.run({ hook: true, deps: f.deps });
  assert.equal(out.skipped, undefined);
  assert.equal(f.calls.verify, 0, 'the hook path skips verify');
  assert.equal(out.state.lastVerifyAt, null);
  W.run({ deps: f.deps });
  assert.equal(f.calls.verify, 1, 'the routine verifies');
});

// local-first A5, PR 9 (the 2.0 launch): the tick routine became `kind: command` (`tick.js --triage`, which wakes the
// duty itself only for a real change), so a quiet hour with no duty run is no longer a miss. Read through the real
// routines store from the shipped files: the 1.9 tick (a duty) misses, the 2.0 one is unwatched, and the migration's
// rewrite (aos migrate local-first) takes the old MISSED flag away at the next check.
test('run: the 2.0 tick (a command) is never a missed duty; the 1.9 tick was, and its flag goes once the file is 2.0', () => {
  const store = require('../lib/routines-store.js');
  const repo = path.join(__dirname, '..', '..', '..');
  const tick20 = fs.readFileSync(path.join(repo, 'vault-template', 'persona', 'routines', 'tick.md'), 'utf8');
  const tick19 = fs.readFileSync(path.join(repo, 'cli', 'fixtures', 'tick-1.9.md'), 'utf8');
  const f = fixture({ rows: [] });
  const dir = path.join(f.root, 'brain', 'routines');
  const file = path.join(f.root, 'brain', '_index', 'routines.json');
  const logDir = path.join(f.personaDir, 'journal', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  // The tick last ran at 03:00; by 09:00 five hourly fires have passed with no run recorded (the triage found nothing).
  store.writeState({ ...store.readState({ file }), routines: { tick: { lastRunAt: iso(at(3, 0)), lastExit: 0, lastDurationMs: 800 } }, syncedAt: iso(at(12, 0, 21)) }, { file });
  f.deps.store = { readState: () => store.readState({ file }), overview: ({ now }) => store.overview({ dir, file, logDir, now }) };

  fs.writeFileSync(path.join(dir, 'tick.md'), tick19);
  const before = W.run({ deps: f.deps });
  assert.equal(before.state.beats.tick.kind, 'duty');
  assert.equal(before.state.beats.tick.status, 'missed');
  assert.match(fs.readFileSync(path.join(f.personaDir, 'STATE.md'), 'utf8'), /duty 'tick' MISSED/);

  fs.writeFileSync(path.join(dir, 'tick.md'), tick20);
  const after = W.run({ deps: f.deps });
  assert.equal(after.state.beats.tick.kind, 'command');
  assert.equal(after.state.beats.tick.status, 'unwatched');
  assert.deepEqual(after.state.misses, []);
  assert.deepEqual(after.state.flags.removed, ['tick']);
  assert.doesNotMatch(fs.readFileSync(path.join(f.personaDir, 'STATE.md'), 'utf8'), /MISSED/);
  // A woken run's duty log (run-duty.sh writes duty-tick.log) changes nothing: the routine is still a command.
  fs.writeFileSync(path.join(logDir, 'duty-tick.log'), '[x] duty=tick start\n[x] duty=tick done (exit 1)\n');
  assert.equal(W.run({ deps: f.deps }).state.beats.tick.status, 'unwatched');
  assert.equal(f.calls.notify.length, 1, 'only the 1.9 tick was ever notified');
});
