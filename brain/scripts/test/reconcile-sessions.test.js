'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('../reconcile-sessions.js');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-09-22T12:00:00Z');
const SCRIPT = path.join(__dirname, '..', 'reconcile-sessions.js');

function liveDirWith(headers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-live-'));
  for (const h of headers) {
    const f = path.join(dir, `sess-${h.session_id}.ndjson`);
    fs.writeFileSync(f, JSON.stringify({ type: 'run_start', id: `sess-${h.session_id}`, script: 'session', ...h }) + '\n');
    const at = new Date(NOW - (h.idleMin || 0) * MIN);
    fs.utimesSync(f, at, at);
  }
  fs.writeFileSync(path.join(dir, 'junk.ndjson'), 'not json\n');
  return dir;
}

function transcriptAt(idleMin, name = 'rollout-2026-09-22T10-00-00-abc.jsonl') {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-tr-')), name);
  fs.writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id: 'abc', cwd: '/w' } }) + '\n');
  const at = new Date(NOW - idleMin * MIN);
  fs.utimesSync(f, at, at);
  return f;
}

test('findStale: only runs whose header, live file and transcript are all older than the window', () => {
  const trOld = transcriptAt(45);
  const trFresh = transcriptAt(2, 'rollout-2026-09-22T11-58-00-def.jsonl');
  const liveDir = liveDirWith([
    { session_id: 'abc', host: 'codex', started_at: new Date(NOW - 90 * MIN).toISOString(), idleMin: 60 },
    { session_id: 'def', host: 'codex', started_at: new Date(NOW - 90 * MIN).toISOString(), idleMin: 60 },
    { session_id: 'ghi', host: 'claude', started_at: new Date(NOW - 90 * MIN).toISOString(), idleMin: 3 },
    { session_id: 'jkl', host: 'claude', started_at: new Date(NOW - 2 * MIN).toISOString(), idleMin: 60 },
    { session_id: 'mno', host: 'claude', started_at: new Date(NOW - 90 * MIN).toISOString(), idleMin: 60 },
  ]);
  const map = { abc: trOld, def: trFresh };
  const stale = R.findStale({ liveDir, staleMs: 30 * MIN, now: NOW, findTranscript: (h, id) => map[id] || null });
  assert.deepEqual(stale.map((s) => s.sessionId).sort(), ['abc', 'mno']);
  const abc = stale.find((s) => s.sessionId === 'abc');
  assert.equal(abc.host, 'codex');
  assert.equal(abc.transcript, trOld);
  assert.equal(abc.endedAt.getTime(), NOW - 45 * MIN, 'ends when the transcript last changed');
  const mno = stale.find((s) => s.sessionId === 'mno');
  assert.equal(mno.transcript, null);
  assert.equal(mno.endedAt.getTime(), NOW - 60 * MIN, 'no transcript: ends at the live file mtime');
  assert.deepEqual(R.findStale({ liveDir: path.join(liveDir, 'missing'), staleMs: MIN, now: NOW }), []);
});

test('reconcile ends each stale run then spawns auto-cost and auto-wrap with AOS_HOST from the header; dry-run touches nothing', () => {
  const tr = transcriptAt(45);
  const liveDir = liveDirWith([
    { session_id: 'abc', host: 'codex', started_at: new Date(NOW - 90 * MIN).toISOString(), idleMin: 60 },
    { session_id: 'zzz', host: 'claude', started_at: new Date(NOW - 90 * MIN).toISOString(), idleMin: 60 },
  ]);
  const ended = [];
  const spawned = [];
  const deps = {
    liveDir, staleMs: 30 * MIN, now: NOW,
    findTranscript: (h, id) => (id === 'abc' ? tr : null),
    endRun: (id, reason, opts) => { ended.push([id, reason, opts]); return id !== 'zzz'; },
    spawn: (bin, args, opts) => { spawned.push({ args: args.map((a) => path.basename(a)), env: opts.env }); },
  };
  const dry = R.reconcile({ dryRun: true, deps });
  assert.deepEqual(dry.map((s) => s.sessionId).sort(), ['abc', 'zzz']);
  assert.equal(ended.length, 0);
  assert.equal(spawned.length, 0);
  const done = R.reconcile({ deps });
  assert.deepEqual(done.map((s) => s.sessionId), ['abc'], 'a run endRun refused (already gone) spawns no workers');
  assert.equal(ended.length, 2);
  assert.deepEqual(ended[0].slice(0, 2), ['abc', 'reconciled']);
  assert.equal(ended[0][2].transcriptPath, tr);
  assert.equal(ended[0][2].endedAt.getTime(), NOW - 45 * MIN);
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0].args, ['auto-cost.js', '--cost-one', 'abc', path.basename(tr)]);
  assert.equal(spawned[0].env.AOS_HOST, 'codex');
  assert.equal(spawned[0].env.AOS_DETACHED, '1');
  assert.deepEqual(spawned[1].args, ['auto-wrap.js']);
  assert.equal(spawned[1].env.AUTO_WRAP_DETACHED, '1');
  assert.equal(spawned[1].env.BRAIN_SESSION_ID, 'abc');
  assert.equal(spawned[1].env.BRAIN_TRANSCRIPT, tr);
  assert.equal(spawned[1].env.AOS_HOST, 'codex');
});

test('findStale: a Codex run whose process exited ends inside the idle window; alive, pid-less and Claude runs wait', () => {
  const recent = new Date(NOW - 5 * MIN).toISOString();
  const tr = transcriptAt(1);
  const liveDir = liveDirWith([
    { session_id: 'exited', host: 'codex', host_pid: 111, host_started: 'a', started_at: recent, idleMin: 2 },
    { session_id: 'running', host: 'codex', host_pid: 222, host_started: 'b', started_at: recent, idleMin: 2 },
    { session_id: 'nopid', host: 'codex', host_pid: null, host_started: null, started_at: recent, idleMin: 2 },
    { session_id: 'claude', host: 'claude', host_pid: 111, started_at: recent, idleMin: 2 },
    { session_id: 'idle', host: 'codex', host_pid: 222, host_started: 'b', started_at: new Date(NOW - 90 * MIN).toISOString(), idleMin: 60 },
  ]);
  const asked = [];
  const processState = (h) => { asked.push(h.session_id); return h.host_pid === 111 ? 'gone' : 'alive'; };
  const deps = { liveDir, staleMs: 30 * MIN, now: NOW, findTranscript: (h, id) => (id === 'exited' ? tr : null), processState };
  const stale = R.findStale(deps);
  assert.deepEqual(stale.map((s) => s.sessionId).sort(), ['exited', 'idle'], 'an alive Codex process keeps only the idle rule');
  const exited = stale.find((s) => s.sessionId === 'exited');
  assert.equal(exited.why, 'exited');
  assert.equal(exited.endedAt.getTime(), NOW - MIN, 'ends at the later of the transcript and the live file');
  assert.equal(stale.find((s) => s.sessionId === 'idle').why, 'idle');
  assert.deepEqual(asked.sort(), ['exited', 'idle', 'running'], 'never asked for a Claude run or a header without host_pid');

  const ended = [];
  const done = R.reconcile({ deps: { ...deps, endRun: (id, reason, opts) => { ended.push([id, reason, opts.endedAt.getTime()]); return true; }, spawn: () => {} } });
  assert.deepEqual(done.map((s) => s.sessionId).sort(), ['exited', 'idle']);
  assert.deepEqual(ended.find((e) => e[0] === 'exited'), ['exited', 'reconciled', NOW - MIN]);
});

test('findStale with the real process check: a recorded Codex pid that has exited is finished at once', () => {
  const dead = spawnSync('true');
  const liveDir = liveDirWith([
    { session_id: 'dead', host: 'codex', host_pid: dead.pid, host_started: '2026-09-22T11:55:00.000Z', started_at: new Date(NOW - 5 * MIN).toISOString(), idleMin: 2 },
  ]);
  const stale = R.findStale({ liveDir, staleMs: 30 * MIN, now: NOW, findTranscript: () => null });
  assert.deepEqual(stale.map((s) => [s.sessionId, s.why]), [['dead', 'exited']]);
});

test('throttled: a stamp younger than five minutes skips the sweep; --force and an old stamp run it and refresh the stamp', () => {
  const stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-stamp-')), '.reconcile');
  assert.equal(R.throttled(false, stamp, NOW), false, 'no stamp yet: run and write it');
  assert.ok(fs.existsSync(stamp));
  fs.utimesSync(stamp, new Date(NOW - MIN), new Date(NOW - MIN));
  assert.equal(R.throttled(false, stamp, NOW), true);
  assert.equal(R.throttled(true, stamp, NOW), false);
  fs.utimesSync(stamp, new Date(NOW - 6 * MIN), new Date(NOW - 6 * MIN));
  assert.equal(R.throttled(false, stamp, NOW), false);
  assert.ok(Date.now() - fs.statSync(stamp).mtime.getTime() < 10 * 1000, 'the stamp was refreshed');
});

test('as a hook: exits 0 fast, answers Stop with {} under Codex and nothing under Claude Code; inline --dry-run lists the sweep', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rec-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  const base = { ...process.env, AOS_VAULT: vault, AOS_CONFIG: path.join(vault, 'none.json') };
  delete base.AOS_DETACHED;
  const stop = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'h1', stop_hook_active: false }), encoding: 'utf8', env: { ...base, AOS_HOST: 'codex' } });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, '{}');
  const start = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'h1', source: 'startup' }), encoding: 'utf8', env: { ...base, CLAUDE_PROJECT_DIR: vault } });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stdout, '');
  assert.ok(fs.existsSync(path.join(vault, 'brain', '_index', 'agent-runs', '.reconcile')), 'the hook stamped the sweep');
  const inline = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--force'], { input: '', encoding: 'utf8', env: { ...base, AOS_HOST: '', CLAUDE_PROJECT_DIR: '' } });
  assert.equal(inline.status, 0, inline.stderr);
  assert.match(inline.stdout, /nothing stale/);
});

// A fresh install under provider local has no login recorded until something asks the hosts (local-first A17), and the
// Workbench shows Sessions only for a signed-in host. The run the Workbench starts at launch asks them even when a sweep
// ran a minute ago (the throttle) or telemetry is off (then it writes nothing under agent-runs/): the sign-in check is
// free, and a fresh cache costs one read.
test('inline: the hosts\' sign-in is refreshed before the throttle and the telemetry switch; telemetry off writes nothing else', () => {
  for (const telemetry of [true, false]) {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rec-login-'));
    const runs = path.join(vault, 'brain', '_index', 'agent-runs');
    const claude = path.join(vault, 'fake-claude.sh');
    fs.writeFileSync(claude, '#!/bin/sh\n[ "$1 $2" = "auth status" ] && echo \'{"loggedIn": true}\' && exit 0\nexit 1\n', { mode: 0o755 });
    const cfgFile = path.join(vault, 'agenticos.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ vault, provider: 'local', claude: { bin: claude }, telemetry: { enabled: telemetry }, hosts: { claude: { enabled: true }, codex: { enabled: false } } }));
    fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'brain', '_index', 'provider-state.json'), JSON.stringify({ name: 'none', reason: 'local-down' }));
    if (telemetry) {
      fs.mkdirSync(runs, { recursive: true });
      fs.writeFileSync(path.join(runs, '.reconcile'), 'just now\n');   // a sweep a moment ago: the sweep itself is throttled
    }
    const env = { ...process.env, AOS_VAULT: vault, AOS_CONFIG: cfgFile, AOS_HOST: '', CLAUDE_PROJECT_DIR: '' };
    delete env.AOS_DETACHED;
    const r = spawnSync(process.execPath, [SCRIPT], { input: '', encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    const st = JSON.parse(fs.readFileSync(path.join(vault, 'brain', '_index', 'provider-state.json'), 'utf8'));
    assert.equal(st.claude && st.claude.loggedIn, true, `telemetry ${telemetry}: Claude Code's sign-in recorded`);
    assert.equal(st.claude.bin, claude);
    if (!telemetry) assert.ok(!fs.existsSync(runs), 'telemetry off: nothing under agent-runs/');
  }
});
