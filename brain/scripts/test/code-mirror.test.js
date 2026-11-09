'use strict';
// code-mirror.js: the follower that copies a host transcript into brain/_index/code as session events (spec
// 2026-11-09-code-chat C2a, plan task 2). A temporary vault, host folders injected as `dirs`, no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('../lib/code-mirror.js');

const SCRIPT = path.join(__dirname, '..', 'lib', 'sessions.js');
const TERM = '3b1f6a52-8c4d-4e7a-9b20-5d6e7f8a9b0c';
const TERM2 = '4c2a7b63-9d5e-4f8b-8c31-6e7f809b0c1d';
const ID_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const ID_B = 'bbbbbbbb-1111-4222-8333-444444444444';

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-code-mirror-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const dirs = {
    claude: { sessions: path.join(root, 'claude', 'projects'), archived: null },
    codex: { sessions: path.join(root, 'codex', 'sessions'), archived: path.join(root, 'codex', 'archived_sessions') },
  };
  return { root, vault, dirs };
}

const claudeFile = (env, id) => {
  const f = path.join(env.dirs.claude.sessions, '-work-demo', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return f;
};
const userLine = (id, text) => `${JSON.stringify({ type: 'user', sessionId: id, timestamp: '2026-11-09T15:00:00.000Z', message: { role: 'user', content: text } })}\n`;
const metaLine = (id, cwd, ts) => `${JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id, cwd, timestamp: ts } })}\n`;
const codexFile = (env, name) => {
  const f = path.join(env.dirs.codex.sessions, '2026', '11', '09', `rollout-${name}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return f;
};
const readEvents = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
}
const run = (opts) => {
  const ac = new AbortController();
  const done = M.follow({ pollMs: 20, ...opts, signal: ac.signal });
  return { stop: async () => { ac.abort(); await done; }, done };
};

test('cachePath: a terminal uuid or host-sessionId; anything else throws', () => {
  assert.equal(M.cachePath('/v', TERM), path.join('/v', 'brain', '_index', 'code', `${TERM}.jsonl`));
  assert.equal(M.cachePath('/v', `codex-${ID_A}`), path.join('/v', 'brain', '_index', 'code', `codex-${ID_A}.jsonl`));
  for (const bad of ['../x', 'claude-..', 'claude-a/b', 'abc', 'other-x', '']) assert.throws(() => M.cachePath('/v', bad), bad);
});

test('once: writes the whole cache atomically', () => {
  const env = fresh();
  fs.writeFileSync(claudeFile(env, ID_A), userLine(ID_A, 'hello') + userLine(ID_A, 'again'));
  const r = M.mirrorOnce({ host: 'claude', id: ID_A, vault: env.vault, dirs: env.dirs.claude });
  assert.equal(r.ok, true);
  assert.equal(r.cache, M.cachePath(env.vault, `claude-${ID_A}`));
  assert.deepEqual(readEvents(r.cache).map((e) => e.kind), ['session', 'prompt', 'prompt']);
  assert.equal(M.mirrorOnce({ host: 'claude', id: 'nope', vault: env.vault, dirs: env.dirs.claude }).ok, false);
  assert.equal(M.mirrorOnce({ host: 'claude', id: '../x', vault: env.vault, dirs: env.dirs.claude }).ok, false);
});

test('follow: a line written in two chunks yields its events once, after the newline', async () => {
  const env = fresh();
  const f = claudeFile(env, ID_A);
  const line = userLine(ID_A, 'second');
  fs.writeFileSync(f, userLine(ID_A, 'first') + line.slice(0, 20));
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'claude', id: ID_A, terminal: TERM, vault: env.vault, dirs: env.dirs.claude });
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.kind === 'prompt')));
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(readEvents(cache).filter((e) => e.kind === 'prompt').map((e) => e.text), ['first']);
  fs.appendFileSync(f, line.slice(20));
  assert.ok(await waitFor(() => readEvents(cache).filter((e) => e.kind === 'prompt').length === 2));
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(readEvents(cache).filter((e) => e.kind === 'prompt').map((e) => e.text), ['first', 'second']);
  await r.stop();
});

test('follow claude: a new session_id in the tee switches transcripts and writes a session event first', async () => {
  const env = fresh();
  fs.writeFileSync(claudeFile(env, ID_A), userLine(ID_A, 'in A'));
  fs.writeFileSync(claudeFile(env, ID_B), userLine(ID_B, 'in B'));
  const cache = M.cachePath(env.vault, TERM);
  const tee = (id, transcript_path) => {
    const f = path.join(env.vault, 'brain', '_index', 'statusline', `${TERM}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), session_id: id, transcript_path, ansi: 'x' }));
  };
  const r = run({ host: 'claude', cwd: '/work/demo', since: 0, terminal: TERM, vault: env.vault, dirs: env.dirs.claude });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(fs.existsSync(cache), false, 'nothing is written before the tee names a session');
  tee('../etc', '/etc/passwd');
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(fs.existsSync(cache), false, 'a bad session id is ignored');
  tee(ID_A, '/outside/hostDirs/x.jsonl');
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'in A')));
  tee(ID_B, '/outside/hostDirs/y.jsonl');
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'in B')));
  const ev = readEvents(cache);
  assert.deepEqual(ev.map((e) => e.kind), ['session', 'prompt', 'session', 'prompt']);
  assert.deepEqual(ev.filter((e) => e.kind === 'session').map((e) => e.id), [ID_A, ID_B]);
  await r.stop();
});

const cand = (file, startedAt, mtimeMs, cwd = '/work/demo') => ({ file, cwd, startedAt, mtimeMs });

test('pickCodexRollout: newest-appended matching cwd after since; null when none', () => {
  const c = [cand('old', 1000, 5000), cand('new', 100000, 200000), cand('other', 100000, 300000, '/elsewhere'), cand('stale', 2000, 400)];
  assert.deepEqual(M.pickCodexRollout(c, { cwd: '/work/demo', since: 1000, claimed: new Set() }), { file: 'new' });
  assert.equal(M.pickCodexRollout(c, { cwd: '/nowhere', since: 0, claimed: new Set() }), null);
  assert.equal(M.pickCodexRollout(c, { cwd: '/work/demo', since: 999999, claimed: new Set() }), null);
});

test('pickCodexRollout: two live rollouts started within 5 s in one cwd → ambiguous', () => {
  const c = [cand('a', 100000, 200000), cand('b', 103000, 201000)];
  assert.deepEqual(M.pickCodexRollout(c, { cwd: '/work/demo', since: 0, claimed: new Set() }), { ambiguous: true });
  const apart = [cand('a', 100000, 200000), cand('b', 120000, 201000)];
  assert.deepEqual(M.pickCodexRollout(apart, { cwd: '/work/demo', since: 0, claimed: new Set() }), { file: 'b' });
});

test('pickCodexRollout: a rollout claimed by another terminal is skipped', () => {
  const c = [cand('a', 100000, 200000), cand('b', 103000, 201000)];
  assert.deepEqual(M.pickCodexRollout(c, { cwd: '/work/demo', since: 0, claimed: new Set(['b']) }), { file: 'a' });
  assert.equal(M.pickCodexRollout(c, { cwd: '/work/demo', since: 0, claimed: new Set(['a', 'b']) }), null);
});

test('follow codex: folder mode follows the matching rollout, claims it, and releases the claim on exit', async () => {
  const env = fresh();
  const now = Date.now();
  const iso = new Date(now).toISOString();
  fs.writeFileSync(codexFile(env, `x-${ID_A}`), metaLine(ID_A, '/elsewhere', iso));
  const mine = codexFile(env, `y-${ID_B}`);
  fs.writeFileSync(mine, metaLine(ID_B, '/work/demo', iso));
  const cache = M.cachePath(env.vault, TERM);
  const claim = path.join(env.vault, 'brain', '_index', 'code', `${TERM}.claim.json`);
  const r = run({ host: 'codex', cwd: '/work/demo', since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.kind === 'session' && e.id === ID_B)));
  assert.ok(await waitFor(() => fs.existsSync(claim)));
  assert.deepEqual(JSON.parse(fs.readFileSync(claim, 'utf8')), { pid: process.pid, cwd: '/work/demo', file: mine });
  await r.stop();
  assert.equal(fs.existsSync(claim), false);
});

test('follow codex: a rollout claimed by a live terminal is skipped, and two unclaimed twins write one error', async () => {
  const env = fresh();
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const a = codexFile(env, `a-${ID_A}`);
  const b = codexFile(env, `b-${ID_B}`);
  fs.writeFileSync(a, metaLine(ID_A, '/work/demo', iso));
  fs.writeFileSync(b, metaLine(ID_B, '/work/demo', iso));
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'codex', cwd: '/work/demo', since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.kind === 'error')));
  await new Promise((res) => setTimeout(res, 500));
  const errs = readEvents(cache).filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, "Can't tell which conversation · Terminal ⌘J");
  const dir = path.join(env.vault, 'brain', '_index', 'code');
  fs.writeFileSync(path.join(dir, `${TERM2}.claim.json`), JSON.stringify({ pid: process.pid, cwd: '/work/demo', file: a }));
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.kind === 'session' && e.id === ID_B)));
  assert.equal(readEvents(cache).some((e) => e.id === ID_A), false);
  await r.stop();
});

test('mirror CLI: bad host or both --id and --cwd → exit 2', () => {
  const env = fresh();
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, 'mirror', ...args], { encoding: 'utf8', env: { ...process.env, AOS_VAULT: env.vault } });
  assert.equal(cli('--host', 'bogus', '--id', ID_A, '--once').status, 2);
  assert.equal(cli('--host', 'claude', '--id', ID_A, '--cwd', '/work/demo', '--since', '0', '--follow').status, 2);
  assert.equal(cli('--host', 'claude', '--id', ID_A).status, 2);
  assert.equal(cli('--host', 'claude', '--id', '../x', '--once').status, 2);
  assert.equal(cli('--host', 'codex', '--cwd', 'rel', '--since', '0', '--terminal', TERM, '--follow').status, 2);
  assert.equal(cli('--host', 'codex', '--cwd', '/work/demo', '--since', '0', '--follow').status, 2);
  assert.equal(cli('--host', 'claude', '--id', ID_A, '--terminal', 'nope', '--follow').status, 2);
});

test('pruneCodeCaches: removes code caches over 14 days and tees over 24 h, keeps fresher', () => {
  const env = fresh();
  const code = path.join(env.vault, 'brain', '_index', 'code');
  const sl = path.join(env.vault, 'brain', '_index', 'statusline');
  fs.mkdirSync(code, { recursive: true });
  fs.mkdirSync(sl, { recursive: true });
  const now = new Date('2026-11-20T12:00:00Z');
  const put = (file, ageMs) => { fs.writeFileSync(file, 'x'); const t = new Date(now.getTime() - ageMs); fs.utimesSync(file, t, t); };
  const H = 3600 * 1000;
  put(path.join(code, 'old.jsonl'), 15 * 24 * H);
  put(path.join(code, 'new.jsonl'), 13 * 24 * H);
  put(path.join(sl, 'old.json'), 25 * H);
  put(path.join(sl, 'new.json'), 23 * H);
  assert.deepEqual(M.pruneCodeCaches(env.vault, { now }), { pruned: 2 });
  assert.deepEqual(fs.readdirSync(code), ['new.jsonl']);
  assert.deepEqual(fs.readdirSync(sl), ['new.json']);
  assert.deepEqual(M.pruneCodeCaches(path.join(env.root, 'none'), { now }), { pruned: 0 });
});
