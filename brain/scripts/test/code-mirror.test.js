'use strict';
// code-mirror.js: the follower that copies a host transcript into brain/_index/code as session events (spec
// 2026-11-09-code-chat C2a, plan task 2, fix wave R16–R18). A temporary vault, host folders injected as `dirs`, no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const M = require('../lib/code-mirror.js');
const H = require('../lib/host.js');

const SCRIPT = path.join(__dirname, '..', 'lib', 'sessions.js');
const TERM = '3b1f6a52-8c4d-4e7a-9b20-5d6e7f8a9b0c';
const TERM2 = '4c2a7b63-9d5e-4f8b-8c31-6e7f809b0c1d';
const TERM3 = '5d3b8c74-0e6f-4a9c-9d42-7f8091a2b3c4';
const ID_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const ID_B = 'bbbbbbbb-1111-4222-8333-444444444444';
const ID_C = 'cccccccc-1111-4222-8333-444444444444';
const ID_D = 'dddddddd-1111-4222-8333-444444444444';

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-code-mirror-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  const dirs = {
    claude: { sessions: path.join(root, 'claude', 'projects'), archived: null },
    codex: { sessions: path.join(root, 'codex', 'sessions'), archived: path.join(root, 'codex', 'archived_sessions') },
  };
  return { root, vault, work: fs.realpathSync.native(work), dirs };
}

const claudeFile = (env, id) => {
  const f = path.join(env.dirs.claude.sessions, '-work-demo', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return f;
};
const userLine = (id, text) => `${JSON.stringify({ type: 'user', sessionId: id, timestamp: '2026-11-09T15:00:00.000Z', message: { role: 'user', content: text } })}\n`;
const iso = (ms) => new Date(ms).toISOString();
const metaLine = (id, cwd, ts) => `${JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id, cwd, timestamp: ts } })}\n`;
const codexUser = (text, ms = Date.now()) => `${JSON.stringify({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'user_message', message: text } })}\n`;
const codexFile = (env, name) => {
  const f = path.join(env.dirs.codex.sessions, '2026', '11', '09', `rollout-${name}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return f;
};
const readEvents = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const sessionIds = (file) => readEvents(file).filter((e) => e.kind === 'session').map((e) => e.id);
const claimPath = (env, term) => path.join(env.vault, 'brain', '_index', 'code', `${term}.claim.json`);
const readClaim = (env, term) => { try { return JSON.parse(fs.readFileSync(claimPath(env, term), 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return false;
}
const run = (opts) => {
  const ac = new AbortController();
  const done = M.follow({ pollMs: 20, ...opts, signal: ac.signal });
  return { stop: async () => { ac.abort(); await done; }, done };
};
const setMtime = (file, ms) => { const t = new Date(ms); fs.utimesSync(file, t, t); };

test('cachePath: a terminal uuid or host-sessionId; anything else throws', () => {
  assert.equal(M.cachePath('/v', TERM), path.join('/v', 'brain', '_index', 'code', `${TERM}.jsonl`));
  assert.equal(M.cachePath('/v', `codex-${ID_A}`), path.join('/v', 'brain', '_index', 'code', `codex-${ID_A}.jsonl`));
  for (const bad of ['../x', 'claude-..', 'claude-a/b', 'abc', 'other-x', '']) assert.throws(() => M.cachePath('/v', bad), bad);
});

test('once: writes the whole cache atomically, a last line without its newline included', () => {
  const env = fresh();
  fs.writeFileSync(claudeFile(env, ID_A), userLine(ID_A, 'hello') + userLine(ID_A, 'again').trimEnd());
  const r = M.mirrorOnce({ host: 'claude', id: ID_A, vault: env.vault, dirs: env.dirs.claude });
  assert.equal(r.ok, true);
  assert.equal(r.cache, M.cachePath(env.vault, `claude-${ID_A}`));
  assert.deepEqual(readEvents(r.cache).map((e) => e.kind), ['session', 'prompt', 'prompt']);
  assert.equal(M.mirrorOnce({ host: 'claude', id: 'nope', vault: env.vault, dirs: env.dirs.claude }).ok, false);
  assert.equal(M.mirrorOnce({ host: 'claude', id: '../x', vault: env.vault, dirs: env.dirs.claude }).ok, false);
});

test('F7: reads are capped and loop until caught up — follow and once give every line once, in order', async () => {
  const env = fresh();
  const f = claudeFile(env, ID_A);
  const texts = Array.from({ length: 12 }, (_, i) => `line ${i} x${'x'.repeat(i * 37)}`);
  fs.writeFileSync(f, texts.map((t) => userLine(ID_A, t)).join(''));
  const once = M.mirrorOnce({ host: 'claude', id: ID_A, vault: env.vault, dirs: env.dirs.claude, readCap: 64 });
  assert.deepEqual(readEvents(once.cache).filter((e) => e.kind === 'prompt').map((e) => e.text), texts);
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'claude', id: ID_A, terminal: TERM, vault: env.vault, dirs: env.dirs.claude, readCap: 64 });
  assert.ok(await waitFor(() => readEvents(cache).filter((e) => e.kind === 'prompt').length === texts.length));
  fs.appendFileSync(f, userLine(ID_A, 'one more'));
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'one more')));
  assert.deepEqual(readEvents(cache).filter((e) => e.kind === 'prompt').map((e) => e.text), [...texts, 'one more']);
  await r.stop();
});

test('follow: a line written in two chunks yields its events once, after the newline', async () => {
  const env = fresh();
  const f = claudeFile(env, ID_A);
  const line = userLine(ID_A, 'second');
  fs.writeFileSync(f, userLine(ID_A, 'first') + line.slice(0, 20));
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'claude', id: ID_A, terminal: TERM, vault: env.vault, dirs: env.dirs.claude });
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.kind === 'prompt')));
  await sleep(100);
  assert.deepEqual(readEvents(cache).filter((e) => e.kind === 'prompt').map((e) => e.text), ['first']);
  fs.appendFileSync(f, line.slice(20));
  assert.ok(await waitFor(() => readEvents(cache).filter((e) => e.kind === 'prompt').length === 2));
  await sleep(100);
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
  await sleep(100);
  assert.equal(fs.existsSync(cache), false, 'nothing is written before the tee names a session');
  tee('../etc', '/etc/passwd');
  await sleep(100);
  assert.equal(fs.existsSync(cache), false, 'a bad session id is ignored');
  tee(ID_A, '/outside/hostDirs/x.jsonl');
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'in A')));
  tee(ID_B, '/outside/hostDirs/y.jsonl');
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'in B')));
  const ev = readEvents(cache);
  assert.deepEqual(ev.map((e) => e.kind), ['session', 'prompt', 'session', 'prompt']);
  assert.deepEqual(ev.filter((e) => e.kind === 'session').map((e) => [e.id, e.turn, e.model]), [[ID_A, 0, null], [ID_B, 0, null]]);
  for (const s of ev.filter((e) => e.kind === 'session')) assert.ok(!Number.isNaN(Date.parse(s.t)), 'a synthesized session event is stamped now');
  await r.stop();
});

test('F7 (M5): a tee naming a new session writes its session event at once, and looks for the transcript every 2 s', async () => {
  const env = fresh();
  fs.writeFileSync(claudeFile(env, ID_A), userLine(ID_A, 'in A'));
  const cache = M.cachePath(env.vault, TERM);
  const teeFile = path.join(env.vault, 'brain', '_index', 'statusline', `${TERM}.json`);
  fs.mkdirSync(path.dirname(teeFile), { recursive: true });
  fs.writeFileSync(teeFile, JSON.stringify({ session_id: ID_A }));
  const real = H.findTranscript;
  let lookups = 0;
  H.findTranscript = (...a) => { if (a[1] === ID_C) lookups++; return real(...a); };
  try {
    const r = run({ host: 'claude', cwd: '/work/demo', since: 0, terminal: TERM, vault: env.vault, dirs: env.dirs.claude });
    assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'in A')));
    fs.writeFileSync(teeFile, JSON.stringify({ session_id: ID_C }));
    assert.ok(await waitFor(() => sessionIds(cache).at(-1) === ID_C, 1000), 'the /clear shows at once, before the transcript exists');
    await sleep(800); // about 40 polls of 20 ms: one lookup per 8 polls, not one per poll
    assert.ok(lookups >= 2 && lookups <= 8, `looked up ${lookups} times`);
    fs.writeFileSync(claudeFile(env, ID_C), userLine(ID_C, 'in C'));
    assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'in C')));
    assert.deepEqual(readEvents(cache).map((e) => e.kind), ['session', 'prompt', 'session', 'prompt'], 'the transcript\'s own session event is not written twice');
    await r.stop();
  } finally { H.findTranscript = real; }
});

test('F4: a stopped follower removes its terminal cache; a transcript that is gone keeps it; a conversation cache stays', async () => {
  const env = fresh();
  const f = claudeFile(env, ID_A);
  fs.writeFileSync(f, userLine(ID_A, 'hello'));
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'claude', id: ID_A, terminal: TERM, vault: env.vault, dirs: env.dirs.claude });
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.kind === 'prompt')));
  await r.stop();
  assert.equal(fs.existsSync(cache), false, 'a terminal does not outlive the app: its cache goes with its follower');
  const byId = run({ host: 'claude', id: ID_A, vault: env.vault, dirs: env.dirs.claude });
  const idCache = M.cachePath(env.vault, `claude-${ID_A}`);
  assert.ok(await waitFor(() => readEvents(idCache).some((e) => e.kind === 'prompt')));
  await byId.stop();
  assert.ok(fs.existsSync(idCache), 'a <host>-<id> cache is a past conversation\'s');
  const g = run({ host: 'claude', id: ID_A, terminal: TERM2, vault: env.vault, dirs: env.dirs.claude });
  const cache2 = M.cachePath(env.vault, TERM2);
  assert.ok(await waitFor(() => readEvents(cache2).some((e) => e.kind === 'prompt')));
  fs.unlinkSync(f);
  await g.done;
  assert.ok(fs.existsSync(cache2), 'the chat it had stays');
});

test('F4: a stopped follower never removes a cache or claim another follower wrote since', async () => {
  const env = fresh();
  const now = Date.now();
  fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now)));
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'codex', cwd: env.work, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => sessionIds(cache).includes(ID_A)));
  // A follower that replaced this one for the same terminal writes its own (a new file each).
  fs.writeFileSync(`${cache}.new`, '{"kind":"session","id":"x"}\n');
  fs.renameSync(`${cache}.new`, cache);
  fs.writeFileSync(`${claimPath(env, TERM)}.new`, JSON.stringify({ pid: process.pid, cwd: env.work, since: now, file: null }));
  fs.renameSync(`${claimPath(env, TERM)}.new`, claimPath(env, TERM));
  await r.stop();
  assert.ok(fs.existsSync(cache));
  assert.ok(fs.existsSync(claimPath(env, TERM)));
});

test('F7: a transcript that cannot be opened is a missing poll, not the follower\'s end; ten in a row are its end', async () => {
  const env = fresh();
  const f = claudeFile(env, ID_A);
  fs.writeFileSync(f, userLine(ID_A, 'first'));
  const cache = M.cachePath(env.vault, TERM);
  const real = fs.openSync;
  let fail = 0;
  fs.openSync = (p, ...rest) => {
    if (p === f && fail > 0) { fail--; const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
    return real(p, ...rest);
  };
  try {
    const r = run({ host: 'claude', id: ID_A, terminal: TERM, vault: env.vault, dirs: env.dirs.claude });
    assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'first')));
    fail = 3; // archived and back between the stat and the open, three polls running
    fs.appendFileSync(f, userLine(ID_A, 'second'));
    assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'second')), 'it kept following');
    let ended = false;
    r.done.then(() => { ended = true; });
    fail = 1000;
    fs.appendFileSync(f, userLine(ID_A, 'third'));
    assert.ok(await waitFor(() => ended, 2000), 'ten missing polls end it');
    assert.ok(fs.existsSync(cache), 'a gone transcript keeps its cache');
  } finally { fs.openSync = real; }
});

test('F7: the follower ends when its parent changes (the app crashed), removing its cache and claim', async () => {
  const env = fresh();
  const now = Date.now();
  fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now)));
  let parent = 4242;
  let ended = false;
  const done = M.follow({ host: 'codex', cwd: env.work, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex, pollMs: 20, parentPid: () => parent }).then(() => { ended = true; });
  const cache = M.cachePath(env.vault, TERM);
  assert.ok(await waitFor(() => sessionIds(cache).includes(ID_A)));
  parent = 1;
  assert.ok(await waitFor(() => ended, 1000));
  await done;
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.existsSync(claimPath(env, TERM)), false);
});

// ── Codex folder mode (R17) ──

const me = (o) => ({ cwd: '/w', since: 100000, file: null, mtimeMs: 0, ...o });
const cand = (file, startedAt, mtimeMs, extra = {}) => ({ file, id: `id-${file}`, cwd: '/w', startedAt, mtimeMs, ...extra });

test('pickCodexRollout: a new terminal adopts the rollout that started with it; another folder, an old or a claimed one never', () => {
  const c = [cand('mine', 101000, 200000), cand('other', 101000, 300000, { cwd: '/elsewhere' }), cand('stale', 2000, 99000), cand('late', 140000, 200000)];
  assert.deepEqual(M.pickCodexRollout(c, { me: me() }), { file: 'mine', id: 'id-mine' });
  assert.equal(M.pickCodexRollout(c, { me: me({ cwd: '/nowhere' }) }), null);
  assert.equal(M.pickCodexRollout(c, { me: me(), peers: [{ since: 50000, file: 'mine', mtimeMs: 200000 }] }), null, 'a peer\'s file');
  assert.equal(M.pickCodexRollout([cand('slow', 99500, 200000)], { me: me() }).file, 'slow', 'a start up to 1 s before the terminal\'s');
});

test('pickCodexRollout: with a current file, only a rollout that started after its last append; never away while it is appended', () => {
  const mine = me({ file: 'cur', mtimeMs: 150000 });
  assert.deepEqual(M.pickCodexRollout([cand('new', 160000, 170000)], { me: mine }), { file: 'new', id: 'id-new' }, 'a /new after it went quiet');
  assert.equal(M.pickCodexRollout([cand('new', 140000, 170000)], { me: mine }), null, 'it was still appended after the new one began');
  assert.equal(M.pickCodexRollout([cand('cur', 100500, 150000)], { me: mine }), null, 'its own file');
});

test('pickCodexRollout: another follower that could own the rollout makes it ambiguous; an active one does not', () => {
  const n = [cand('new', 160000, 170000)];
  const mine = me({ file: 'cur', mtimeMs: 150000 });
  assert.deepEqual(M.pickCodexRollout(n, { me: mine, peers: [{ since: 50000, file: 'p', mtimeMs: 155000 }] }), { ambiguous: true }, 'a peer quiet before it began');
  assert.deepEqual(M.pickCodexRollout(n, { me: mine, peers: [{ since: 50000, file: 'p', mtimeMs: 165000 }] }), { file: 'new', id: 'id-new' }, 'a peer appended after it began');
  assert.deepEqual(M.pickCodexRollout(n, { me: mine, peers: [{ since: 159500, file: null, mtimeMs: 0 }] }), { ambiguous: true }, 'a peer with no file that started before it');
  assert.deepEqual(M.pickCodexRollout(n, { me: mine, peers: [{ since: 162000, file: null, mtimeMs: 0 }] }), { file: 'new', id: 'id-new' }, 'a peer that started after it');
  assert.deepEqual(M.pickCodexRollout([cand('a', 101000, 200000), cand('b', 102000, 200000)], { me: me() }), { ambiguous: true }, 'two adoptable');
});

test('pickCodexRollout: two terminals with no file started within 5 s cannot be told apart', () => {
  const c = [cand('a', 101000, 200000)];
  assert.deepEqual(M.pickCodexRollout(c, { me: me(), peers: [{ since: 103000, file: null, mtimeMs: 0 }] }), { ambiguous: true });
  assert.deepEqual(M.pickCodexRollout(c, { me: me(), peers: [{ since: 106000, file: null, mtimeMs: 0 }] }), { file: 'a', id: 'id-a' });
  assert.equal(M.pickCodexRollout([], { me: me(), peers: [{ since: 103000, file: null, mtimeMs: 0 }] }), null, 'nothing to show is not ambiguous');
});

test('pickCodexRollout: resume --last — an older rollout appended since the terminal started, judged by that append', () => {
  const old = [cand('old', 5000, 104000)];
  const beginOf = (c, after) => (c.file === 'old' && after === 99000 ? 103000 : null);
  assert.deepEqual(M.pickCodexRollout(old, { me: me(), beginOf }), { file: 'old', id: 'id-old' });
  assert.deepEqual(M.pickCodexRollout(old, { me: me(), beginOf, peers: [{ since: 50000, file: 'p', mtimeMs: 90000 }] }), { ambiguous: true }, 'a quiet peer could have resumed it');
  assert.equal(M.pickCodexRollout(old, { me: me(), beginOf: () => null }), null, 'no append since');
});

test('follow codex: folder mode claims at start, follows the matching rollout, and releases the claim on exit', async () => {
  const env = fresh();
  const now = Date.now();
  fs.writeFileSync(codexFile(env, `x-${ID_A}`), metaLine(ID_A, '/elsewhere', iso(now)));
  const mine = codexFile(env, `y-${ID_B}`);
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'codex', cwd: env.work, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.deepEqual(readClaim(env, TERM), { pid: process.pid, cwd: env.work, since: now - 1000, file: null }, 'claimed before any rollout');
  fs.writeFileSync(mine, metaLine(ID_B, env.work, iso(now)) + codexUser('hello'));
  assert.ok(await waitFor(() => sessionIds(cache).includes(ID_B)));
  assert.ok(await waitFor(() => readClaim(env, TERM)?.file === mine));
  assert.deepEqual(readClaim(env, TERM), { pid: process.pid, cwd: env.work, since: now - 1000, file: mine });
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.kind === 'prompt')));
  await r.stop();
  assert.equal(fs.existsSync(claimPath(env, TERM)), false);
  assert.equal(fs.existsSync(cache), false);
});

test('follow codex: a folder named through a symlink matches its rollouts and claims by real path', async () => {
  const env = fresh();
  const now = Date.now();
  const link = path.join(env.root, 'link');
  fs.symlinkSync(env.work, link);
  fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now)));
  const r = run({ host: 'codex', cwd: link, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => sessionIds(M.cachePath(env.vault, TERM)).includes(ID_A)));
  assert.equal(readClaim(env, TERM).cwd, env.work);
  await r.stop();
  // The other way round: the rollout names the link, the terminal the real folder.
  const env2 = fresh();
  const link2 = path.join(env2.root, 'link');
  fs.symlinkSync(env2.work, link2);
  fs.writeFileSync(codexFile(env2, `a-${ID_A}`), metaLine(ID_A, link2, iso(now)));
  const r2 = run({ host: 'codex', cwd: env2.work, since: now - 1000, terminal: TERM, vault: env2.vault, dirs: env2.dirs.codex });
  assert.ok(await waitFor(() => sessionIds(M.cachePath(env2.vault, TERM)).includes(ID_A)));
  await r2.stop();
});

test('follow codex: a rollout claimed by a live terminal is skipped, and two unclaimed twins write one error', async () => {
  const env = fresh();
  const now = Date.now();
  const a = codexFile(env, `a-${ID_A}`);
  const b = codexFile(env, `b-${ID_B}`);
  fs.writeFileSync(a, metaLine(ID_A, env.work, iso(now)));
  fs.writeFileSync(b, metaLine(ID_B, env.work, iso(now)));
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'codex', cwd: env.work, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.kind === 'error')));
  await sleep(500);
  const errs = readEvents(cache).filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, "Can't tell which conversation · Terminal ⌘J");
  setMtime(a, now + 5000); // the other terminal is busy in it
  fs.writeFileSync(claimPath(env, TERM2), JSON.stringify({ pid: process.pid, cwd: env.work, since: now - 30000, file: a }));
  assert.ok(await waitFor(() => sessionIds(cache).includes(ID_B)));
  assert.equal(readEvents(cache).some((e) => e.id === ID_A), false);
  await r.stop();
});

test('follow codex: two terminals started 60 s apart each keep their own rollout while both are appended', async () => {
  const env = fresh();
  const now = Date.now();
  const r1 = codexFile(env, `t1-${ID_A}`);
  const r2 = codexFile(env, `t2-${ID_B}`);
  fs.writeFileSync(r1, metaLine(ID_A, env.work, iso(now - 119500)) + codexUser('one'));
  fs.writeFileSync(r2, metaLine(ID_B, env.work, iso(now - 59500)) + codexUser('two'));
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM)?.file === r1));
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 60000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM2)?.file === r2));
  for (let i = 0; i < 8; i++) { fs.appendFileSync(r1, codexUser(`one ${i}`)); fs.appendFileSync(r2, codexUser(`two ${i}`)); await sleep(60); }
  assert.ok(await waitFor(() => readEvents(M.cachePath(env.vault, TERM2)).some((e) => e.text === 'two 7')));
  assert.deepEqual(sessionIds(M.cachePath(env.vault, TERM)), [ID_A]);
  assert.deepEqual(sessionIds(M.cachePath(env.vault, TERM2)), [ID_B]);
  assert.ok(readEvents(M.cachePath(env.vault, TERM)).every((e) => !String(e.text || '').startsWith('two')));
  assert.equal(readEvents(M.cachePath(env.vault, TERM2)).some((e) => e.kind === 'error'), false);
  await f1.stop();
  await f2.stop();
});

test('follow codex: two terminals started within 5 s are both ambiguous', async () => {
  const env = fresh();
  const now = Date.now();
  fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now - 9500)));
  fs.writeFileSync(codexFile(env, `b-${ID_B}`), metaLine(ID_B, env.work, iso(now - 6500)));
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 10000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 7000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  const c1 = M.cachePath(env.vault, TERM);
  const c2 = M.cachePath(env.vault, TERM2);
  assert.ok(await waitFor(() => readEvents(c1).some((e) => e.kind === 'error') && readEvents(c2).some((e) => e.kind === 'error')));
  await sleep(400);
  for (const c of [c1, c2]) assert.deepEqual(readEvents(c).map((e) => e.kind), ['error'], 'one error each, no conversation');
  await f1.stop();
  await f2.stop();
});

test('follow codex: a /new in one terminal while the other is idle is ambiguous on both until the other appends', async () => {
  const env = fresh();
  const now = Date.now();
  const r1 = codexFile(env, `t1-${ID_A}`);
  const r2 = codexFile(env, `t2-${ID_B}`);
  fs.writeFileSync(r1, metaLine(ID_A, env.work, iso(now - 119500)));
  fs.writeFileSync(r2, metaLine(ID_B, env.work, iso(now - 59500)));
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM)?.file === r1));
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 60000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM2)?.file === r2));
  setMtime(r1, now - 30000);
  setMtime(r2, now - 30000);
  const r3 = codexFile(env, `t3-${ID_C}`);
  fs.writeFileSync(r3, metaLine(ID_C, env.work, iso(now - 10000)) + codexUser('the new one'));
  const c1 = M.cachePath(env.vault, TERM);
  const c2 = M.cachePath(env.vault, TERM2);
  assert.ok(await waitFor(() => readEvents(c1).some((e) => e.kind === 'error') && readEvents(c2).some((e) => e.kind === 'error')));
  await sleep(300);
  assert.equal(sessionIds(c1).includes(ID_C), false, 'not while T2 is quiet too');
  fs.appendFileSync(r2, codexUser('T2 is typing'));
  assert.ok(await waitFor(() => sessionIds(c1).at(-1) === ID_C));
  assert.ok(readEvents(c1).some((e) => e.text === 'the new one'), 'the new rollout from its start');
  assert.ok(await waitFor(() => readEvents(c2).some((e) => e.text === 'T2 is typing')));
  await sleep(300);
  assert.deepEqual(sessionIds(c2), [ID_B]);
  assert.equal(readEvents(c1).filter((e) => e.kind === 'error').length, 1, 'one error per episode');
  await f1.stop();
  await f2.stop();
});

test('follow codex (R18): with --id, that rollout is the first adoption, then the folder is followed', async () => {
  const env = fresh();
  const now = Date.now();
  const old = codexFile(env, `old-${ID_A}`);
  fs.writeFileSync(old, metaLine(ID_A, env.work, iso(now - 3600000)) + codexUser('resumed'));
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'codex', id: ID_A, cwd: env.work, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM)?.file === old));
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'resumed')));
  setMtime(old, now - 5000);
  fs.writeFileSync(codexFile(env, `new-${ID_D}`), metaLine(ID_D, env.work, iso(now - 2000)) + codexUser('after /new'));
  assert.ok(await waitFor(() => sessionIds(cache).at(-1) === ID_D));
  assert.deepEqual(sessionIds(cache), [ID_A, ID_D]);
  await r.stop();
});

test('follow codex: an archived rollout is never a candidate', async () => {
  const env = fresh();
  const now = Date.now();
  const arch = path.join(env.dirs.codex.archived, `rollout-z-${ID_A}.jsonl`);
  fs.mkdirSync(path.dirname(arch), { recursive: true });
  fs.writeFileSync(arch, metaLine(ID_A, env.work, iso(now)));
  const r = run({ host: 'codex', cwd: env.work, since: now - 1000, terminal: TERM3, vault: env.vault, dirs: env.dirs.codex });
  await sleep(300);
  assert.equal(fs.existsSync(M.cachePath(env.vault, TERM3)), false);
  await r.stop();
});

test('mirror CLI: bad arguments exit 2; codex takes --id with --cwd and --since (R18), claude does not', () => {
  const env = fresh();
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, 'mirror', ...args], { encoding: 'utf8', env: { ...process.env, AOS_VAULT: env.vault } });
  assert.equal(cli('--host', 'bogus', '--id', ID_A, '--once').status, 2);
  assert.equal(cli('--host', 'claude', '--id', ID_A, '--cwd', '/work/demo', '--since', '0', '--terminal', TERM, '--follow').status, 2);
  assert.equal(cli('--host', 'codex', '--id', ID_A, '--cwd', '/work/demo', '--since', '0', '--once').status, 2);
  assert.equal(cli('--host', 'codex', '--id', ID_A, '--cwd', '/work/demo', '--since', '0', '--follow').status, 2, 'folder mode needs a terminal');
  assert.equal(cli('--host', 'codex', '--id', ID_A, '--cwd', 'rel', '--since', '0', '--terminal', TERM, '--follow').status, 2);
  assert.equal(cli('--host', 'codex', '--id', ID_A, '--cwd', '/work/demo', '--terminal', TERM, '--follow').status, 2, '--cwd without --since');
  assert.equal(cli('--host', 'claude', '--id', ID_A).status, 2);
  assert.equal(cli('--host', 'claude', '--id', '../x', '--once').status, 2);
  assert.equal(cli('--host', 'codex', '--cwd', 'rel', '--since', '0', '--terminal', TERM, '--follow').status, 2);
  assert.equal(cli('--host', 'codex', '--cwd', '/work/demo', '--since', '0', '--follow').status, 2);
  assert.equal(cli('--host', 'claude', '--id', ID_A, '--terminal', 'nope', '--follow').status, 2);
  const usage = spawnSync(process.execPath, [SCRIPT, 'nope'], { encoding: 'utf8', env: { ...process.env, AOS_VAULT: env.vault } });
  assert.match(usage.stderr, /mirror --host h \(--id i \[--cwd d --since ms\] \| --cwd d --since ms\)/);
});

test('mirror CLI: a --follow child exits 0 on SIGTERM and removes its claim and cache', async () => {
  const env = fresh();
  const now = Date.now();
  fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now)) + codexUser('hello'));
  const child = spawn(process.execPath, [SCRIPT, 'mirror', '--host', 'codex', '--id', ID_A, '--cwd', env.work, '--since', String(now - 1000), '--terminal', TERM, '--follow'], {
    env: { ...process.env, AOS_VAULT: env.vault, CODEX_HOME: path.join(env.root, 'codex'), CLAUDE_CONFIG_DIR: path.join(env.root, 'claude') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const cache = M.cachePath(env.vault, TERM);
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'hello'), 8000), stderr);
  assert.equal(readClaim(env, TERM)?.pid, child.pid);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(fs.existsSync(claimPath(env, TERM)), false);
  assert.equal(fs.existsSync(cache), false);
});

test('pruneCodeCaches: removes code caches over 14 days and tees over 24 h, keeps fresher', () => {
  const env = fresh();
  const code = path.join(env.vault, 'brain', '_index', 'code');
  const sl = path.join(env.vault, 'brain', '_index', 'statusline');
  fs.mkdirSync(code, { recursive: true });
  fs.mkdirSync(sl, { recursive: true });
  const now = new Date('2026-11-20T12:00:00Z');
  const put = (file, ageMs) => { fs.writeFileSync(file, 'x'); const t = new Date(now.getTime() - ageMs); fs.utimesSync(file, t, t); };
  const HOUR = 3600 * 1000;
  put(path.join(code, 'old.jsonl'), 15 * 24 * HOUR);
  put(path.join(code, 'new.jsonl'), 13 * 24 * HOUR);
  put(path.join(sl, 'old.json'), 25 * HOUR);
  put(path.join(sl, 'new.json'), 23 * HOUR);
  assert.deepEqual(M.pruneCodeCaches(env.vault, { now }), { pruned: 2 });
  assert.deepEqual(fs.readdirSync(code), ['new.jsonl']);
  assert.deepEqual(fs.readdirSync(sl), ['new.json']);
  assert.deepEqual(M.pruneCodeCaches(path.join(env.root, 'none'), { now }), { pruned: 0 });
});
