'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../persona/tick.js');

const NOW = new Date(2026, 8, 22, 10, 0); // Tue 2026-09-22 10:00 local: the tick's once-a-day rules and flag ages are local days
const at = (ms) => new Date(NOW.getTime() + ms);
const HOUR = 3600e3, DAY = 86400e3;

/** A vault with the inputs the tick watches, all stamped an hour before NOW so a later touch is visible. */
function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-vault-'));
  const put = (rel, text = '') => { const f = path.join(v, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  put('persona/journal/2026-09-22.md', '## 09:00 — duty: sitrep\n- status: OK\n');
  put('brain/memory/feedback/existing-rule.md', '# Existing rule\n');
  put('brain/memory/feedback/_drafts/.keep', '');
  put('persona/STATE.md', '# Persona State\n\n## Sitrep\n- fine\n\n## Flags\n- [ ] 2026-09-01 duty \'monitor\' FAILED — old\n- [ ] 2026-09-20 fresh flag\n\n## Priorities\n- tests\n');
  put('persona/proposals/README.md', '# Proposals\n');
  put('persona/ledger.jsonl', JSON.stringify({ schema: 1, ts: '2026-09-15T00:00:00.000Z', event: 'approved', slug: 'old-fix', kind: 'self' }) + '\n');
  const repo = path.join(v, 'repo');
  put('repo/.git/HEAD', 'ref: refs/heads/main\n');
  put('repo/.git/refs/heads/main', `${'a'.repeat(40)}\n`);
  put('repo/.git/index', 'idx');
  put('repo/.planning/STATE.md', 'phase: 2 of 5\n');
  put('persona/repos.json', JSON.stringify({ stall_threshold_days: 4, repos: [{ name: 'app', path: repo }] }));
  put('brain/_index/persona-heartbeat.json', JSON.stringify({ schema: 1, checkedAt: at(-HOUR).toISOString(), beats: { sitrep: { status: 'ok', lastRunAt: '2026-09-22T07:45:00.000Z' } } }));
  // The routines the signature reads (their status, never their run times): a duty, two half-hourly commands, the tick.
  put('brain/routines/sitrep.md', '---\nschema: 1\nname: Sitrep\nkind: duty\nschedule: "45 7 * * 1-5"\nenabled: true\n---\nx\n');
  put('brain/routines/heartbeat.md', '---\nschema: 1\nname: Heartbeat\nkind: command\nschedule: "*/30 * * * *"\nenabled: true\nargv: ["true"]\n---\n');
  put('brain/routines/briefing.md', '---\nschema: 1\nname: Briefing\nkind: command\nschedule: "*/30 7-22 * * *"\nenabled: true\nargv: ["true"]\n---\n');
  put('brain/routines/tick.md', '---\nschema: 1\nname: Tick\nkind: command\nschedule: "0 * * * *"\nenabled: true\nargv: ["true"]\nbudgetUsd: 0.5\ntools: "Read,Bash({{NODE}} {{VAULT}}/brain/scripts/persona/tick.js:*)"\ntimeoutSec: 900\n---\n');
  put('brain/_index/routines.json', JSON.stringify({ schema: 1, routines: {
    sitrep: { lastRunAt: '2026-09-22T07:45:00.000Z', lastExit: 0, failStreak: 0 },
    heartbeat: { lastRunAt: at(-HOUR).toISOString(), lastExit: 0, failStreak: 0 },
    briefing: { lastRunAt: at(-HOUR).toISOString(), lastExit: 0, failStreak: 0 },
  }, synced: {}, syncedAt: null }));
  const old = at(-HOUR);
  const stamp = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) stamp(f); fs.utimesSync(f, old, old); } fs.utimesSync(dir, old, old); };
  stamp(v);
  return v;
}
function deps(v, cfg = {}) { return { vault: v, config: () => cfg, now: () => NOW }; }
const touch = (f, when) => { fs.utimesSync(f, when, when); };
const state = (v) => JSON.parse(fs.readFileSync(path.join(v, 'brain', '_index', 'persona-tick.json'), 'utf8'));
const queueLines = (v) => { try { return fs.readFileSync(path.join(v, 'persona', 'queue.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

test('precheck: the first run is a change; after a beat an untouched vault is unchanged and counts the skip', () => {
  const v = vault(); const d = deps(v);
  const first = T.precheck({ deps: d });
  assert.deepEqual(first, { changed: true, changes: ['first-run'], since: null });
  assert.ok(state(v).pending, 'the pending signature waits for the beat');
  const b = T.beat({ deps: d, now: at(60e3) });
  assert.equal(b.beats, 1);
  assert.equal(state(v).pending, null);
  const second = T.precheck({ deps: d, now: at(HOUR) });
  assert.equal(second.changed, false);
  assert.deepEqual(second.changes, []);
  assert.equal(second.since, at(60e3).toISOString());
  assert.equal(state(v).skipped, 1);
  assert.equal(T.main(['precheck', '--root', v]), T.EXIT_UNCHANGED, 'the CLI exit the runner keys on');
});

/** routines.json as the half-hourly runs leave it: every routine's run time bumped, exits as given. */
function bumpRuns(v, when, exits = {}) {
  const f = path.join(v, 'brain', '_index', 'routines.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const slug of ['heartbeat', 'briefing', 'tick']) st.routines[slug] = { ...(st.routines[slug] || {}), lastRunAt: when.toISOString(), lastExit: 0 };
  for (const [slug, exit] of Object.entries(exits)) st.routines[slug] = { ...(st.routines[slug] || {}), lastRunAt: when.toISOString(), lastExit: exit, failStreak: exit ? 1 : 0 };
  fs.writeFileSync(f, JSON.stringify(st));
  const hb = path.join(v, 'brain', '_index', 'persona-heartbeat.json');
  const cur = JSON.parse(fs.readFileSync(hb, 'utf8'));
  for (const b of Object.values(cur.beats)) b.lastRunAt = when.toISOString();
  fs.writeFileSync(hb, JSON.stringify({ ...cur, checkedAt: when.toISOString() }));
}
const setHeartbeat = (v, slug, status) => {
  const hb = path.join(v, 'brain', '_index', 'persona-heartbeat.json');
  const cur = JSON.parse(fs.readFileSync(hb, 'utf8'));
  cur.beats[slug] = { ...(cur.beats[slug] || {}), status };
  fs.writeFileSync(hb, JSON.stringify(cur));
};

test('signature (local-first A5): run times never count — the heartbeat, briefing and tick bumping theirs is a quiet hour', () => {
  const v = vault(); const d = deps(v);
  T.precheck({ deps: d }); T.beat({ deps: d });
  for (let h = 1; h <= 3; h++) {
    bumpRuns(v, at(h * HOUR));
    // The tick's own writes and a `git status` (which rewrites .git/index) are no news either.
    fs.appendFileSync(path.join(v, 'persona', 'journal', '2026-09-22.md'), `\n## 1${h}:00 — duty: tick\n- status: OK\n`);
    touch(path.join(v, 'repo', '.git', 'index'), at(h * HOUR));
    assert.deepEqual(T.precheck({ deps: d, now: at(h * HOUR) }).changes, [], `hour ${h}`);
  }
  assert.equal(state(v).skipped, 3);
  assert.equal(T.signature(d).v, T.SIG_VERSION);
  assert.equal(Object.prototype.hasOwnProperty.call(T.signature(d).routines, 'tick'), false, 'the tick is not its own signal');
});

test('signature: a failure, a miss, a correction, a commit, a proposal, a flag and an alert each wake, named in changes', () => {
  const v = vault(); const d = deps(v);
  T.precheck({ deps: d }); T.beat({ deps: d });
  const step = (h, expect, why) => { assert.deepEqual(T.precheck({ deps: d, now: at(h * HOUR) }).changes, expect, why); T.beat({ deps: d, now: at(h * HOUR) }); };
  bumpRuns(v, at(HOUR), { briefing: 1 });
  step(1, ['routines.briefing'], 'a command routine that started failing');
  bumpRuns(v, at(2 * HOUR), { briefing: 1 });
  step(2, [], 'still failing is no news');
  setHeartbeat(v, 'sitrep', 'missed');
  step(3, ['routines.sitrep'], 'the watchdog marked a duty missed');
  const draft = path.join(v, 'brain', 'memory', 'feedback', '_drafts', 'r-1.md');
  fs.writeFileSync(draft, '# Rule\n'); touch(draft, at(4 * HOUR));
  step(4, ['corrections']);
  fs.writeFileSync(path.join(v, 'repo', '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
  step(5, ['repos.app'], 'a new commit on a tracked repo');
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-22-x.md'), '---\nslug: x\n---\n');
  step(6, ['proposals']);
  const st = path.join(v, 'persona', 'STATE.md');
  fs.writeFileSync(st, fs.readFileSync(st, 'utf8').replace('## Flags\n', '## Flags\n- [ ] 2026-09-22 a new flag\n'));
  step(7, ['flags']);
  fs.writeFileSync(st, fs.readFileSync(st, 'utf8').replace('- fine', '- tick queued 1'));
  step(8, [], 'the Sitrep block the tick rewrites is not a flag');
  const N = require('../lib/notifications.js');
  N.post({ from: 'ron', level: 'info', title: 'Evening news', body: 'x' }, { vault: v, now: at(9 * HOUR) });
  step(9, [], 'an info post is not an inbox alert');
  N.post({ from: 'pepper', level: 'alert', title: 'Bill due', body: 'x' }, { vault: v, now: at(10 * HOUR) });
  step(10, ['inbox']);
});

test('signature: the vault\'s own repo counts by its memory files, never its backup commits', () => {
  const v = vault(); const d = deps(v);
  const put = (rel, text) => { const f = path.join(v, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  put('.git/HEAD', 'ref: refs/heads/main\n');
  put('.git/refs/heads/main', `${'c'.repeat(40)}\n`);
  put('brain/memory/projects/app.md', '# App\n');
  fs.writeFileSync(path.join(v, 'persona', 'repos.json'), JSON.stringify({ repos: [{ name: 'app', path: path.join(v, 'repo') }, { name: 'vault', path: v }] }));
  const sig = T.signature(d);
  assert.deepEqual(Object.keys(sig.repos), ['app'], 'the vault is no HEAD');
  assert.equal(sig.memory.n, 2, 'its memory files instead (the fixture\'s rule and the project)');
  T.precheck({ deps: d }); T.beat({ deps: d });
  fs.writeFileSync(path.join(v, '.git', 'refs', 'heads', 'main'), `${'d'.repeat(40)}\n`);
  assert.deepEqual(T.precheck({ deps: d, now: at(HOUR) }).changes, [], 'a vault backup commit is no news');
  const mem = put('brain/memory/projects/new.md', '# New\n'); touch(mem, at(HOUR));
  assert.deepEqual(T.precheck({ deps: d, now: at(2 * HOUR) }).changes, ['memory']);
  assert.equal(T.signature(deps(fs.mkdtempSync(path.join(os.tmpdir(), 'tick-bare-')))).memory, null, 'an untracked vault has no memory key');
});

test('repoHead: branch and commit from the files (loose ref, packed ref, detached, worktree), null for a non-repo', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-repo-'));
  const put = (rel, text) => { const f = path.join(r, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  assert.equal(T.repoHead(r), null);
  put('.git/HEAD', 'ref: refs/heads/dev\n');
  put('.git/packed-refs', `# pack-refs\n${'e'.repeat(40)} refs/heads/dev\n`);
  assert.equal(T.repoHead(r), `refs/heads/dev@${'e'.repeat(40)}`);
  put('.git/refs/heads/dev', `${'f'.repeat(40)}\n`);
  assert.equal(T.repoHead(r), `refs/heads/dev@${'f'.repeat(40)}`, 'a loose ref beats the packed one');
  put('.git/HEAD', `${'1'.repeat(40)}\n`);
  assert.equal(T.repoHead(r), '1'.repeat(40));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-wt-'));
  put('.git/worktrees/wt/HEAD', 'ref: refs/heads/dev\n');
  put('.git/worktrees/wt/commondir', '../..\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(r, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(T.repoHead(wt), `refs/heads/dev@${'f'.repeat(40)}`);
});

test('beat: the tick\'s own journal and STATE.md writes do not wake the next tick, a change during the run still does', () => {
  const v = vault(); const d = deps(v);
  T.precheck({ deps: d });
  // during the "model run": the tick appends its journal entry and its STATE line, and the user edits a feedback rule
  const j = path.join(v, 'persona', 'journal', '2026-09-22.md');
  fs.appendFileSync(j, '\n## 10:00 — duty: tick\n- status: OK\n'); touch(j, at(60e3));
  const st = path.join(v, 'persona', 'STATE.md');
  fs.appendFileSync(st, '- tick: 2026-09-22 OK\n'); touch(st, at(60e3));
  const rule = path.join(v, 'brain', 'memory', 'feedback', 'existing-rule.md');
  fs.appendFileSync(rule, 'more\n'); touch(rule, at(60e3));
  T.beat({ deps: d, now: at(2 * 60e3) });
  assert.deepEqual(T.precheck({ deps: d, now: at(HOUR) }).changes, ['corrections'], 'only the external edit is news');
});

test('a pre-2.0 signature (no version) reads as a first run, once', () => {
  const v = vault(); const d = deps(v);
  fs.writeFileSync(path.join(v, 'brain', '_index', 'persona-tick.json'), JSON.stringify({ schema: 1, lastBeatAt: at(-HOUR).toISOString(), lastSignature: { journal: 1, beats: 'sitrep:ok:x' }, beats: 40, skipped: 0 }));
  assert.deepEqual(T.precheck({ deps: d }).changes, ['first-run']);
  T.beat({ deps: d });
  assert.deepEqual(T.precheck({ deps: d, now: at(HOUR) }).changes, []);
});

test('signals: one candidate per type with a source pointer, nothing older than the last beat, queued ones marked', () => {
  const v = vault(); const d = deps(v, { persona: { tick: { flagAgeDays: 7 } } });
  // The fixture is stamped one hour before NOW; the last beat lands a minute after that, so only later writes are news.
  const SINCE = at(-HOUR + 60e3);
  T.precheck({ deps: d }); T.beat({ deps: d, now: SINCE });
  const draft = path.join(v, 'brain', 'memory', 'feedback', '_drafts', 'r-1.md');
  fs.writeFileSync(draft, '# Always run the gate\n'); touch(draft, at(-30 * 60e3));
  const hb = path.join(v, 'brain', '_index', 'persona-heartbeat.json');
  fs.writeFileSync(hb, JSON.stringify({ schema: 1, checkedAt: NOW.toISOString(), beats: {
    sitrep: { status: 'missed', due: at(-20 * 60e3).toISOString(), lastRunAt: '2026-09-21T07:45:00.000Z' },
    monitor: { status: 'failed', lastRunAt: at(-3 * HOUR).toISOString() },   // before the last beat: already seen
    reflect: { status: 'ok', lastRunAt: '2026-09-20T18:00:00.000Z' },
  } }));
  touch(path.join(v, 'repo', '.planning', 'STATE.md'), at(-5 * DAY));
  fs.appendFileSync(path.join(v, 'persona', 'ledger.jsonl'), JSON.stringify({ schema: 1, ts: at(-10 * 60e3).toISOString(), event: 'regressed', slug: 'old-fix', kind: 'self' }) + '\n');
  T.queue({ type: 'repo-stall', source: 'app:.planning/STATE.md', note: 'already there', deps: d });

  const r = T.signals({ deps: d });
  assert.equal(r.since, SINCE.toISOString());
  assert.equal(r.flagAgeDays, 7);
  const by = Object.fromEntries(r.candidates.map(c => [c.type, c]));
  assert.deepEqual(Object.keys(by).sort(), ['correction', 'duty-failure', 'flag-aged', 'regressed', 'repo-stall']);
  assert.equal(r.candidates.length, 5, 'monitor failed before the last beat and the 2-day-old flag are not candidates');
  assert.equal(by.correction.source, 'brain/memory/feedback/_drafts/r-1.md');
  assert.equal(by.correction.title, 'Always run the gate');
  assert.equal(by['duty-failure'].source, 'brain/_index/persona-heartbeat.json#sitrep');
  assert.equal(by['duty-failure'].title, "duty 'sitrep' missed");
  assert.equal(by['repo-stall'].source, 'app:.planning/STATE.md');
  assert.equal(by['repo-stall'].queued, true, 'already in the queue');
  assert.match(by['repo-stall'].title, /^app planning idle 5d$/);
  assert.equal(by.regressed.source, 'persona/ledger.jsonl#old-fix');
  assert.equal(by['flag-aged'].source, "persona/STATE.md#duty 'monitor' FAILED — old");
  assert.match(by['flag-aged'].title, /^flag open 21d: /);
  for (const c of r.candidates.filter(c => c.type !== 'repo-stall')) assert.equal(c.queued, false, c.type);
});

test('signals: a first run looks back 24 h, not forever', () => {
  const v = vault(); const d = deps(v);
  const old = path.join(v, 'brain', 'memory', 'feedback', 'existing-rule.md');
  touch(old, at(-2 * DAY));
  const recent = path.join(v, 'brain', 'memory', 'feedback', 'new-rule.md');
  fs.writeFileSync(recent, '# New\n'); touch(recent, at(-2 * HOUR));
  const r = T.signals({ deps: d });
  assert.equal(r.since, at(-DAY).toISOString());
  assert.deepEqual(r.candidates.filter(c => c.type === 'correction').map(c => c.source), ['brain/memory/feedback/new-rule.md']);
});

test('queue: validates the type and the source, appends the line shape, dedupes on (type, source)', () => {
  const v = vault(); const d = deps(v);
  assert.throws(() => T.queue({ type: 'gossip', source: 'x', deps: d }), /type must be one of/);
  assert.throws(() => T.queue({ type: 'correction', source: ' ', deps: d }), /--source/);
  const a = T.queue({ type: 'correction', source: 'brain/memory/feedback/_drafts/r-1.md', note: '  the third time this week  ', deps: d });
  assert.equal(a.duplicate, false);
  assert.deepEqual(a.record, { schema: 1, ts: NOW.toISOString(), type: 'correction', source: 'brain/memory/feedback/_drafts/r-1.md', note: 'the third time this week', by: 'tick' });
  const b = T.queue({ type: 'correction', source: 'brain/memory/feedback/_drafts/r-1.md', deps: d, now: at(HOUR) });
  assert.equal(b.duplicate, true);
  assert.equal(b.record.ts, NOW.toISOString(), 'the original record is returned');
  T.queue({ type: 'flag-aged', source: 'persona/STATE.md#old', deps: d });
  assert.deepEqual(queueLines(v).map(q => q.type), ['correction', 'flag-aged']);
  assert.equal(queueLines(v)[1].note, null);
});

// Spec 2026-09-22-persona-reflect-daily-design D7: the queue can bring the daily reflect forward, decided runner-side.
test('shouldReflectEarly: 3 corrections, a duty with failStreak 2, or two duties failing once; nothing below', () => {
  const T0 = { corrections: 3, dutyFailures: 2 };
  const c = (n) => Array.from({ length: n }, (_, i) => ({ type: 'correction', source: `brain/memory/feedback/r-${i}.md` }));
  const fail = (slug) => ({ type: 'duty-failure', source: `brain/_index/persona-heartbeat.json#${slug}` });
  assert.equal(T.shouldReflectEarly(c(2), null, T0).trigger, false);
  assert.equal(T.shouldReflectEarly(c(3), null, T0).trigger, true);
  assert.match(T.shouldReflectEarly(c(3), null, T0).reason, /3 corrections queued/);
  assert.equal(T.shouldReflectEarly([fail('reflect')], { routines: { reflect: { failStreak: 1 } } }, T0).trigger, false);
  assert.equal(T.shouldReflectEarly([fail('reflect')], { routines: { reflect: { failStreak: 2 } } }, T0).trigger, true, 'one duty failing twice in a row is a streak');
  assert.equal(T.shouldReflectEarly([fail('reflect'), fail('monitor')], null, T0).trigger, true, 'two duties failing once each');
  assert.deepEqual(T.shouldReflectEarly([...c(1), fail('sitrep'), { type: 'repo-stall', source: 'app:x' }], { routines: {} }, T0), { trigger: false, reason: null, corrections: 1, failures: 1 });
  assert.equal(T.shouldReflectEarly([], null, T0).trigger, false, 'a drained queue never triggers');
  assert.deepEqual(T.earlyThresholds({}), { corrections: 3, dutyFailures: 2 });
  assert.deepEqual(T.earlyThresholds({ persona: { tick: { earlyReflect: { corrections: 2, dutyFailures: -1 } } } }), { corrections: 2, dutyFailures: 2 });
});

test('beat starts reflect-daily early once per day through run-routine.js, and not when the routine is missing or disabled', () => {
  const v = vault();
  const spawned = [];
  const d = { ...deps(v), spawnReflect: (argv) => { spawned.push(argv); return 4242; } };
  for (let i = 0; i < 3; i++) T.queue({ type: 'correction', source: `brain/memory/feedback/r-${i}.md`, deps: d });
  T.precheck({ deps: d });
  // no routine file yet → decision is yes, but nothing to start
  const b0 = T.beat({ deps: d });
  assert.equal(b0.earlyReflect.started, false);
  assert.match(b0.earlyReflect.reason, /no valid brain\/routines\/reflect-daily\.md/);
  assert.equal(spawned.length, 0);
  // seed the routine like aos persona does, then the next beat starts it
  const routines = path.join(v, 'brain', 'routines');
  fs.mkdirSync(routines, { recursive: true });
  const seed = path.join(__dirname, '..', '..', '..', 'vault-template', 'persona', 'routines', 'reflect-daily.md');
  fs.copyFileSync(seed, path.join(routines, 'reflect-daily.md'));
  // (NOW is 10:00 local; the two same-day beats at 10:30 and 11:00 share its local day in every timezone)
  const b1 = T.beat({ deps: d, now: at(30 * 60e3) });
  assert.equal(b1.earlyReflect.started, true, JSON.stringify(b1.earlyReflect));
  assert.equal(b1.earlyReflect.pid, 4242);
  assert.deepEqual(b1.earlyReflect.argv, [process.execPath, path.join(__dirname, '..', 'routines', 'run-routine.js'), 'reflect-daily', '--early']);
  assert.equal(state(v).lastEarlyReflectAt, at(30 * 60e3).toISOString());
  // same day, still over threshold → not again
  const b2 = T.beat({ deps: d, now: at(HOUR) });
  assert.equal(b2.earlyReflect.started, false);
  assert.match(b2.earlyReflect.reason, /already started today/);
  assert.equal(spawned.length, 1);
  // next day → again; disabled routine → never
  const b3 = T.beat({ deps: d, now: at(DAY + 2 * HOUR) });
  assert.equal(b3.earlyReflect.started, true);
  fs.writeFileSync(path.join(routines, 'reflect-daily.md'), fs.readFileSync(path.join(routines, 'reflect-daily.md'), 'utf8').replace('enabled: true', 'enabled: false'));
  const b4 = T.beat({ deps: d, now: at(2 * DAY + 2 * HOUR) });
  assert.equal(b4.earlyReflect.started, false);
  assert.match(b4.earlyReflect.reason, /disabled/);
  assert.equal(spawned.length, 2);
  // below threshold → the check says so and touches nothing
  fs.writeFileSync(path.join(v, 'persona', 'queue.jsonl'), '');
  const b5 = T.beat({ deps: d, now: at(3 * DAY) });
  assert.deepEqual(b5.earlyReflect, { started: false, reason: 'below threshold', corrections: 0, failures: 0 });
  assert.equal(b5.beats, 6, 'the beat itself is always recorded');
});

test('CLI: queue prints the record, a bad queue call exits 2, usage exits 2, a corrupt state file reads as empty', () => {
  const v = vault();
  assert.equal(T.main(['queue', 'regressed', '--source', 'persona/ledger.jsonl#x', '--note', 'n', '--root', v]), 0);
  assert.equal(queueLines(v).length, 1);
  assert.equal(T.main(['queue', 'nope', '--source', 'x', '--root', v]), 2);
  assert.equal(T.main(['--root', v]), 2);
  assert.deepEqual(T.positionals(['--root', v, 'queue', 'correction', '--source', 'a b', '--note', 'why']), ['queue', 'correction']);
  fs.writeFileSync(path.join(v, 'brain', '_index', 'persona-tick.json'), '{ not json');
  assert.equal(T.readState(deps(v)).lastBeatAt, null);
  assert.equal(T.main(['precheck', '--root', v]), 0, 'a first run after a corrupt state is a change');
  assert.equal(state(v).schema, 1);
});

// Spec 2026-10-24-persona-learning-loop-design D1: nothing applies a proposal unasked, so the precheck no longer counts
// daily confirmations toward an auto-apply gate — not even for a proposal that still declares a class.
test('precheck records no confirmations, whatever a proposal declares', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-20-fix-thing.md'), '---\nslug: fix-thing\nrecheck: "true"\nautoapply_class: doc-typo\n---\n## What\nx\n');
  const r = T.precheck({ deps: deps(v) });
  assert.equal(typeof r.changed, 'boolean');
  assert.equal('confirmations' in r, false);
  assert.equal(fs.existsSync(path.join(v, 'persona', 'flag-closer', 'confirmations.json')), false);
});

// ── triage (local-first A5): rules first, the local model on a real change, the hosted tick duty only when it wakes ──
const localModel = (reply, calls = []) => ({ name: 'ollama', model: 'qwen3.5:9b', calls, chat: async (o) => { calls.push(o); return typeof reply === 'function' ? reply(o) : reply; } });
function triageDeps(v, provider, { cfg = {}, spawned = [], exit = 0 } = {}) {
  return { ...deps(v, cfg), node: '/n/node', env: { PATH: '/usr/bin:/bin' }, provider: async () => provider, spawnDuty: (o) => { spawned.push(o); return exit; } };
}
const journalOf = (v) => { try { return fs.readFileSync(path.join(v, 'persona', 'journal', '2026-09-22.md'), 'utf8'); } catch { return ''; } };
const triageLines = (v) => journalOf(v).split('\n').filter((l) => l.includes('— tick triage:'));

test('triage: a quiet hour makes no hosted call, and no local call when the signature is unchanged', async () => {
  const v = vault(); const spawned = [];
  const local = localModel('{"wake": false, "reason": "nothing to act on"}');
  const d = triageDeps(v, local, { spawned });
  const first = await T.triage({ deps: d });
  assert.equal(first.action, 'stay');
  assert.equal(local.calls.length, 1, 'the first look asks the local model once');
  assert.deepEqual(triageLines(v), ['## 10:00 — tick triage: no run — nothing to act on (local model qwen3.5:9b; changed: first triage)']);
  for (let h = 1; h <= 3; h++) {
    bumpRuns(v, at(h * HOUR));
    const r = await T.triage({ deps: d, now: at(h * HOUR) });
    assert.equal(r.action, 'unchanged', `hour ${h}`);
  }
  assert.equal(local.calls.length, 1, 'no local call while the signature is unchanged');
  assert.equal(spawned.length, 0, 'no hosted call: the duty never started');
  assert.equal(triageLines(v).length, 1, 'a quiet hour writes no journal line');
  const s = state(v);
  assert.equal(s.skipped, 3); assert.equal(s.triages, 1); assert.equal(s.localCalls, 1); assert.equal(s.wakes || 0, 0);
});

test('triage: a failure wakes — the local model decides, one journal line, and the hosted tick duty starts through run-duty.sh', async () => {
  const v = vault(); const spawned = [];
  const local = localModel((o) => (o.prompt.includes('routine briefing: ok → failed') ? '{"wake": true, "reason": "the briefing started failing"}' : '{"wake": false, "reason": "quiet"}'));
  const d = triageDeps(v, local, { spawned, exit: 0 });
  await T.triage({ deps: d });
  bumpRuns(v, at(HOUR), { briefing: 1 });
  const r = await T.triage({ deps: d, now: at(HOUR) });
  assert.equal(r.action, 'woke');
  assert.deepEqual(r.changes, ['routine briefing: ok → failed']);
  const call = local.calls[1];
  assert.deepEqual(call.format, T.DECISION_SCHEMA, 'a small JSON decision');
  assert.equal(call.feature, 'tick-triage');
  assert.equal(call.think, false);
  assert.deepEqual(JSON.parse(call.prompt).changed, ['routine briefing: ok → failed']);
  assert.equal(spawned.length, 1);
  const p = spawned[0];
  assert.equal(p.cmd, 'sh');
  assert.deepEqual(p.args, [path.join(__dirname, '..', 'persona', 'run-duty.sh'), 'tick'], 'the same runner a scheduled duty uses');
  assert.equal(p.env.PERSONA_MAX_USD, '0.5', 'the tick routine file\'s budgetUsd');
  assert.equal(p.env.PERSONA_TOOLS, `Read,Bash(/n/node ${v}/brain/scripts/persona/tick.js:*)`, 'its tools, {{NODE}}/{{VAULT}} expanded');
  assert.equal(p.env.PERSONA_TIMEOUT, '780', 'inside the routine\'s 900 s');
  assert.equal(p.env.AOS_VAULT, v);
  assert.equal(p.cwd, v);
  assert.deepEqual(triageLines(v).slice(-1), ['## 11:00 — tick triage: woke the Chief of Staff — the briefing started failing (local model qwen3.5:9b; changed: routine briefing: ok → failed)']);
  assert.equal(state(v).wakes, 1);
  assert.equal(state(v).lastTriage.by, 'local');
  // The duty's exit is the routine's: a failed woken duty shows on the tick routine.
  setHeartbeat(v, 'sitrep', 'missed');
  const failed = await T.triage({ deps: { ...d, provider: async () => localModel('{"wake": true, "reason": "sitrep missed"}'), spawnDuty: () => 1 }, now: at(2 * HOUR) });
  assert.equal(failed.action, 'woke');
  assert.equal(failed.exit, 1);
});

test('triage: local down, a hosted background provider, an error or a non-decision → any real change wakes, by the rules', async () => {
  for (const [label, provider, why] of [
    ['none', { name: 'none', reason: 'local-down' }, /local model is unavailable \(local-down\)/],
    ['hosted', { name: 'claude', chat: async () => { throw new Error('a hosted call must never happen'); } }, /background provider claude/],
    ['error', { name: 'ollama', chat: async () => { throw new Error('ECONNRESET'); } }, /did not answer \(ECONNRESET\)/],
    ['garbage', { name: 'ollama', chat: async () => 'I think maybe' }, /answer was not a decision/],
  ]) {
    const v = vault(); const spawned = [];
    const r = await T.triage({ deps: triageDeps(v, provider, { spawned }) });
    assert.equal(r.action, 'woke', label);
    assert.equal(r.decision.by, 'rules', label);
    assert.match(r.decision.reason, why, label);
    assert.match(r.decision.reason, /any real change wakes the Chief of Staff$/, label);
    assert.equal(spawned.length, 1, label);
    assert.match(triageLines(v)[0], / \(rules; changed: first triage\)$/, label);
  }
  const v = vault();
  const r = await T.triage({ deps: { ...triageDeps(v, null), provider: async () => { throw new Error('no vault'); } } });
  assert.equal(r.decision.by, 'rules');
});

test('triage decision parsing: JSON, JSON in prose, string booleans; anything else is no decision', () => {
  assert.deepEqual(T.parseDecision('{"wake": true, "reason": "a duty failed"}'), { wake: true, reason: 'a duty failed' });
  assert.deepEqual(T.parseDecision('Sure.\n```json\n{"wake": false, "reason": "only churn"}\n```'), { wake: false, reason: 'only churn' });
  assert.deepEqual(T.parseDecision('{"wake": "yes", "reason": "x"}'), { wake: true, reason: 'x' });
  assert.deepEqual(T.parseDecision('{"wake": "FALSE"}'), { wake: false, reason: 'the local model says it can wait' });
  assert.deepEqual(T.parseDecision('{"wake": true, "reason": "line one\\n## heading `code`"}'), { wake: true, reason: 'line one heading code' }, 'one journal line, no markup');
  assert.equal(T.parseDecision('{"wake": true, "reason": "' + 'x'.repeat(300) + '"}').reason.length, 160);
  for (const bad of ['', 'no', '[]', '{"reason": "x"}', '{"wake": "maybe"}', '{"wake": 1}', null, '{ broken']) assert.equal(T.parseDecision(bad), null, String(bad));
});

test('triage: back to the last run\'s state is quiet; persona off and a headless caller are refused without a call', async () => {
  const v = vault();
  const local = localModel('{"wake": false, "reason": "wait"}');
  const d = triageDeps(v, local);
  T.precheck({ deps: d }); T.beat({ deps: d });
  const st = path.join(v, 'persona', 'STATE.md');
  const before = fs.readFileSync(st, 'utf8');
  fs.writeFileSync(st, before.replace('## Flags\n', '## Flags\n- [ ] 2026-09-22 transient\n'));
  assert.equal((await T.triage({ deps: d, now: at(HOUR) })).action, 'stay');
  fs.writeFileSync(st, before);
  assert.equal((await T.triage({ deps: d, now: at(2 * HOUR) })).action, 'unchanged', 'the flag closed again: what the last run saw');
  assert.equal(local.calls.length, 1);
  fs.writeFileSync(path.join(v, 'persona', 'DISABLED'), 'x');
  assert.equal((await T.triage({ deps: d, now: at(3 * HOUR) })).action, 'off');
  fs.rmSync(path.join(v, 'persona', 'DISABLED'));
  assert.equal((await T.triage({ deps: triageDeps(v, local, { cfg: { persona: { enabled: false } } }), now: at(3 * HOUR) })).action, 'off');
  const errs = []; const orig = process.stderr.write; process.stderr.write = (m) => { errs.push(String(m)); return true; };
  try { assert.equal(await T.mainTriage(['--triage', '--root', v], { env: { AOS_HEADLESS: '1' } }), 2); } finally { process.stderr.write = orig; }
  assert.match(errs.join(''), /never inside a duty/);
  assert.equal(local.calls.length, 1, 'none of these asked the model');
});

test('mainTriage prints one JSON line and returns the woken duty\'s exit', async () => {
  const v = vault();
  const out = []; const orig = process.stdout.write; process.stdout.write = (m) => { out.push(String(m)); return true; };
  let code;
  try { code = await T.mainTriage(['--triage'], { env: {}, deps: triageDeps(v, { name: 'none', reason: 'local-down' }, { exit: 1 }) }); } finally { process.stdout.write = orig; }
  assert.equal(code, 1);
  const line = JSON.parse(out.join(''));
  assert.equal(line.action, 'woke');
  assert.deepEqual(line.changes, ['first triage']);
  assert.equal(line.decision.by, 'rules');
});

// Spec 2026-10-24-persona-learning-loop-design D11: a duty that was refused tool calls is news, with the refused call
// and the rule it came closest to in the title, so a wrong node spelling is visible without reading the duty log.
test('signals: a duty run refused tool calls since the last beat is a duty-denied candidate; queue takes the type', () => {
  const v = vault(); const d = deps(v);
  const SINCE = at(-HOUR + 60e3);
  T.precheck({ deps: d }); T.beat({ deps: d, now: SINCE });
  const near = 'Bash(/opt/homebrew/Cellar/node/26.0.0/bin/node /srv/vault/brain/scripts/persona/tick.js:*)';
  const rec = (ts, duty) => JSON.stringify({ schema: 1, ts, duty, model: 'm', count: 2, denied: [
    { tool: 'Bash', input: '/opt/homebrew/opt/node/bin/node /srv/vault/brain/scripts/persona/tick.js signals', near }, { tool: 'Edit', input: 'x', near: null }] });
  const fresh = at(-10 * 60e3).toISOString();
  fs.writeFileSync(path.join(v, 'brain', '_index', 'duty-denials.jsonl'), `${rec(at(-2 * HOUR).toISOString(), 'monitor')}\n${rec(fresh, 'tick')}\nnot json\n`);
  const dd = T.signals({ deps: d }).candidates.filter((c) => c.type === 'duty-denied');
  assert.equal(dd.length, 1, 'the run before the last beat was already seen');
  assert.equal(dd[0].source, `brain/_index/duty-denials.jsonl#tick@${fresh}`);
  assert.equal(dd[0].title, `duty 'tick': 2 tool call(s) denied, e.g. Bash \`/opt/homebrew/opt/node/bin/node /srv/vault/brain/scripts/persona/tick.js signals\`; nearest allowed rule ${near}`);
  assert.equal(dd[0].queued, false);
  const q = T.queue({ type: 'duty-denied', source: dd[0].source, note: 'the rule names the Cellar node', deps: d });
  assert.equal(q.duplicate, false);
  assert.equal(q.record.type, 'duty-denied');
  assert.equal(T.signals({ deps: d }).candidates.find((c) => c.type === 'duty-denied').queued, true);
});
