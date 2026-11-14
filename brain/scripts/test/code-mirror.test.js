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
// How long a test lets a follower started by run() write something. A follower writes after a whole number of polls (a
// "can't tell" error needs three folder scans, one every eight polls: 17 polls, about 0.4 s when idle), and each poll
// sleeps on a timer, so a loaded machine stretches that; waitFor returns the moment its condition holds, so the wide
// limit costs a passing run nothing.
const FOLLOWER_MS = 10000;
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
    assert.ok(await waitFor(() => sessionIds(cache).at(-1) === ID_C, FOLLOWER_MS), 'the /clear shows before the transcript exists');
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
    assert.ok(await waitFor(() => ended, FOLLOWER_MS), 'ten missing polls end it');
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
  assert.ok(await waitFor(() => ended, FOLLOWER_MS));
  await done;
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.existsSync(claimPath(env, TERM)), false);
});

// ── Codex folder mode (R17) ──

const me = (o) => ({ cwd: '/w', since: 100000, file: null, mtimeMs: 0, ...o });
const cand = (file, startedAt, mtimeMs, extra = {}) => ({ file, id: `id-${file}`, cwd: '/w', startedAt, mtimeMs, ...extra });

test('pickCodexRollout: a new terminal adopts the rollout that started with it; another folder, an old or a claimed one never', () => {
  const c = [cand('mine', 101000, 200000), cand('other', 101000, 300000, { cwd: '/elsewhere' }), cand('stale', 2000, 99000)];
  assert.deepEqual(M.pickCodexRollout(c, { me: me() }), { file: 'mine', id: 'id-mine' });
  assert.equal(M.pickCodexRollout(c, { me: me({ cwd: '/nowhere' }) }), null);
  assert.equal(M.pickCodexRollout(c, { me: me(), peers: [{ since: 50000, file: 'mine', mtimeMs: 200000 }] }), null, 'a peer\'s file');
  assert.equal(M.pickCodexRollout([cand('slow', 99500, 200000)], { me: me() }).file, 'slow', 'a start up to 1 s before the terminal\'s');
  assert.deepEqual(M.pickCodexRollout([cand('mine', 101000, 200000), cand('late', 140000, 200000)], { me: me() }), { ambiguous: true }, 'two new candidates are ambiguous');
});

test('pickCodexRollout (R61): a rollout that starts minutes after the terminal (its startup dialogs first) is adopted', () => {
  assert.deepEqual(M.pickCodexRollout([cand('dialogs', 100000 + 24600, 200000)], { me: me() }), { file: 'dialogs', id: 'id-dialogs' });
  const hours = 2 * 3600000 + 14 * 60000;
  assert.deepEqual(M.pickCodexRollout([cand('away', 100000 + hours, 100000 + hours + 5000)], { me: me() }), { file: 'away', id: 'id-away' });
});

test('pickCodexRollout: with a current file, a rollout that started after its last append; never away while it is appended', () => {
  const mine = me({ file: 'cur', mtimeMs: 150000 });
  assert.deepEqual(M.pickCodexRollout([cand('new', 160000, 170000)], { me: mine }), { file: 'new', id: 'id-new' }, 'a /new after it went quiet');
  assert.equal(M.pickCodexRollout([cand('new', 140000, 170000)], { me: mine, beginOf: () => null }), null, 'it was still appended after the new one began');
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

test('pickCodexRollout (R17b): with a current file, an older rollout that grows after its last append is a /resume, judged by that growth', () => {
  const mine = me({ file: 'cur', mtimeMs: 150000 });
  const old = [cand('old', 5000, 170000)];
  const asked = [];
  const beginOf = (c, after) => { asked.push([c.file, after]); return after === 150000 ? 160000 : null; };
  assert.deepEqual(M.pickCodexRollout(old, { me: mine, beginOf }), { file: 'old', id: 'id-old' });
  assert.deepEqual(asked, [['old', 150000]], 'its activity start: its first growth after the current file\'s last append');
  assert.deepEqual(M.pickCodexRollout(old, { me: mine, beginOf, peers: [{ since: 50000, file: 'p', mtimeMs: 155000 }] }), { ambiguous: true }, 'a peer quiet before it could have resumed it');
  assert.deepEqual(M.pickCodexRollout(old, { me: mine, beginOf, peers: [{ since: 50000, file: 'p', mtimeMs: 165000 }] }), { file: 'old', id: 'id-old' }, 'a peer busy after it began');
  assert.equal(M.pickCodexRollout(old, { me: mine, beginOf: () => 150000 }), null, 'growth no later than the current file\'s last append');
  assert.equal(M.pickCodexRollout(old, { me: mine, beginOf: () => null }), null);
  asked.length = 0;
  assert.equal(M.pickCodexRollout([cand('old', 5000, 140000)], { me: mine, beginOf }), null, 'not grown since');
  assert.deepEqual(asked, [], 'and not read');
});

test('follow codex: folder mode claims at start, follows the matching rollout, and releases the claim on exit', async () => {
  const env = fresh();
  const now = Date.now();
  fs.writeFileSync(codexFile(env, `x-${ID_A}`), metaLine(ID_A, '/elsewhere', iso(now)));
  const mine = codexFile(env, `y-${ID_B}`);
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'codex', cwd: env.work, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.deepEqual(readClaim(env, TERM), { pid: process.pid, cwd: env.work, since: now - 1000, file: null, session: null, held: [] }, 'claimed before any rollout');
  fs.writeFileSync(mine, metaLine(ID_B, env.work, iso(now)) + codexUser('hello'));
  assert.ok(await waitFor(() => sessionIds(cache).includes(ID_B)));
  assert.ok(await waitFor(() => readClaim(env, TERM)?.file === mine));
  assert.deepEqual(readClaim(env, TERM), { pid: process.pid, cwd: env.work, since: now - 1000, file: mine, session: ID_B, held: [mine] });
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
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.kind === 'error'), FOLLOWER_MS));
  await sleep(500);
  const errs = readEvents(cache).filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, "Can't tell which conversation · Terminal ⌘J");
  setMtime(a, now + 5000); // the other terminal is busy in it
  fs.writeFileSync(claimPath(env, TERM2), JSON.stringify({ pid: process.pid, cwd: env.work, since: now - 30000, file: a }));
  assert.ok(await waitFor(() => sessionIds(cache).includes(ID_B), FOLLOWER_MS));
  assert.equal(readEvents(cache).some((e) => e.id === ID_A), false);
  await r.stop();
});

test('follow codex: two terminals started 60 s apart each keep their own rollout while both are appended', async () => {
  const env = fresh();
  const now = Date.now();
  const r1 = codexFile(env, `t1-${ID_A}`);
  const r2 = codexFile(env, `t2-${ID_B}`);
  fs.writeFileSync(r1, metaLine(ID_A, env.work, iso(now - 119500)) + codexUser('one'));
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM)?.file === r1));
  // R61: T2's rollout does not exist until T2 prompts, so T1 has already adopted its own by then.
  fs.writeFileSync(r2, metaLine(ID_B, env.work, iso(now - 59500)) + codexUser('two'));
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
  assert.ok(await waitFor(() => readEvents(c1).some((e) => e.kind === 'error') && readEvents(c2).some((e) => e.kind === 'error'), FOLLOWER_MS));
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
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM)?.file === r1));
  // R61: the second terminal's rollout does not exist until it prompts, so the first has already adopted its own.
  fs.writeFileSync(r2, metaLine(ID_B, env.work, iso(now - 59500)));
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 60000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM2)?.file === r2));
  setMtime(r1, now - 30000);
  setMtime(r2, now - 30000);
  const r3 = codexFile(env, `t3-${ID_C}`);
  fs.writeFileSync(r3, metaLine(ID_C, env.work, iso(now - 10000)) + codexUser('the new one'));
  const c1 = M.cachePath(env.vault, TERM);
  const c2 = M.cachePath(env.vault, TERM2);
  assert.ok(await waitFor(() => readEvents(c1).some((e) => e.kind === 'error') && readEvents(c2).some((e) => e.kind === 'error'), FOLLOWER_MS));
  await sleep(300);
  assert.equal(sessionIds(c1).includes(ID_C), false, 'not while T2 is quiet too');
  fs.appendFileSync(r2, codexUser('T2 is typing'));
  assert.ok(await waitFor(() => sessionIds(c1).at(-1) === ID_C, FOLLOWER_MS));
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
  assert.ok(await waitFor(() => sessionIds(cache).at(-1) === ID_D, FOLLOWER_MS));
  assert.deepEqual(sessionIds(cache), [ID_A, ID_D]);
  await r.stop();
});

test('follow codex (R17b): a /resume of an older rollout after the current one went quiet is followed, from its start', async () => {
  const env = fresh();
  const now = Date.now();
  const cur = codexFile(env, `cur-${ID_A}`);
  const old = codexFile(env, `old-${ID_B}`);
  fs.writeFileSync(cur, metaLine(ID_A, env.work, iso(now - 119500)) + codexUser('in the current one', now - 119000));
  fs.writeFileSync(old, metaLine(ID_B, env.work, iso(now - 600000)) + codexUser('from long ago', now - 599000));
  setMtime(old, now - 590000);
  const cache = M.cachePath(env.vault, TERM);
  const r = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM)?.file === cur));
  setMtime(cur, now - 30000);
  await sleep(200);
  assert.deepEqual(sessionIds(cache), [ID_A]);
  fs.appendFileSync(old, codexUser('resumed here'));
  assert.ok(await waitFor(() => sessionIds(cache).at(-1) === ID_B, FOLLOWER_MS));
  assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'resumed here')));
  const after = readEvents(cache).slice(readEvents(cache).findIndex((e) => e.kind === 'session' && e.id === ID_B));
  assert.deepEqual(after.filter((e) => e.kind === 'prompt').map((e) => e.text), ['from long ago', 'resumed here'], 'the resumed rollout from its start');
  assert.equal(readClaim(env, TERM).file, old);
  await r.stop();
});

test('follow codex (R17b): the same /resume with an idle live peer is ambiguous on both until the peer appends', async () => {
  const env = fresh();
  const now = Date.now();
  const r1 = codexFile(env, `t1-${ID_A}`);
  const r2 = codexFile(env, `t2-${ID_C}`);
  const old = codexFile(env, `old-${ID_B}`);
  fs.writeFileSync(r1, metaLine(ID_A, env.work, iso(now - 119500)));
  fs.writeFileSync(old, metaLine(ID_B, env.work, iso(now - 600000)) + codexUser('from long ago', now - 599000));
  setMtime(old, now - 590000);
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM)?.file === r1));
  // R61: the second terminal's rollout does not exist until it prompts, so the first has already adopted its own.
  fs.writeFileSync(r2, metaLine(ID_C, env.work, iso(now - 59500)));
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 60000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM2)?.file === r2));
  setMtime(r1, now - 30000);
  setMtime(r2, now - 30000);
  fs.appendFileSync(old, codexUser('resumed somewhere'));
  const c1 = M.cachePath(env.vault, TERM);
  const c2 = M.cachePath(env.vault, TERM2);
  assert.ok(await waitFor(() => readEvents(c1).some((e) => e.kind === 'error') && readEvents(c2).some((e) => e.kind === 'error'), FOLLOWER_MS));
  await sleep(300);
  assert.equal(sessionIds(c1).includes(ID_B) || sessionIds(c2).includes(ID_B), false, 'neither while both are quiet');
  await sleep(20);
  fs.appendFileSync(r2, codexUser('T2 is typing'));
  assert.ok(await waitFor(() => sessionIds(c1).at(-1) === ID_B, FOLLOWER_MS));
  assert.ok(await waitFor(() => readEvents(c2).some((e) => e.text === 'T2 is typing')));
  await sleep(300);
  assert.deepEqual(sessionIds(c2), [ID_C]);
  assert.equal(readEvents(c1).filter((e) => e.kind === 'error').length, 1, 'one error per episode');
  await f1.stop();
  await f2.stop();
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

test('pruneCodeCaches: removes code caches and session reports over 14 days and tees over 24 h, keeps fresher', () => {
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
  put(path.join(code, `${TERM}.session.json`), 15 * 24 * HOUR);
  put(path.join(code, `${TERM2}.session.json`), 13 * 24 * HOUR);
  assert.deepEqual(M.pruneCodeCaches(env.vault, { now }), { pruned: 3 });
  assert.deepEqual(fs.readdirSync(code).sort(), [`${TERM2}.session.json`, 'new.jsonl']);
  assert.deepEqual(fs.readdirSync(sl), ['new.json']);
  assert.deepEqual(M.pruneCodeCaches(path.join(env.root, 'none'), { now }), { pruned: 0 });
});

// ── Fix round 2 ──

test('pickCodexRollout (R25): a no-file peer contends only for a rollout it could adopt itself', () => {
  const t2 = me({ since: 160000 });
  const n = [cand('new', 161000, 170000)];
  assert.deepEqual(M.pickCodexRollout(n, { me: t2, peers: [{ since: 100000, file: null, mtimeMs: 0 }] }), { ambiguous: true }, 'R61: T1 (since 100 s, no file) could adopt a rollout started at 161 s, however long after');
  assert.deepEqual(M.pickCodexRollout(n, { me: t2, peers: [{ since: 171000, file: null, mtimeMs: 0 }] }), { file: 'new', id: 'id-new' }, 'a peer whose since is after the rollout\'s start + 1 s does not contend');
  assert.deepEqual(M.pickCodexRollout(n, { me: t2, peers: [{ since: 150000, file: null, mtimeMs: 0 }] }), { ambiguous: true }, 'a peer at 150 s could adopt it');
  assert.deepEqual(M.pickCodexRollout(n, { me: t2, peers: [{ since: 161000 - 600000, file: null, mtimeMs: 0 }] }), { ambiguous: true }, 'a peer 10 minutes earlier still contends');
  // an older rollout first grown at or after the peer's since − 1 s
  const old = [cand('old', 5000, 170000)];
  const beginOf = (c, from) => (from === 159000 ? 162000 : from === 99000 ? 120000 : null);
  assert.deepEqual(M.pickCodexRollout(old, { me: t2, beginOf, peers: [{ since: 100000, file: null, mtimeMs: 0 }] }), { ambiguous: true }, 'a peer for which it is a resume of an older rollout contends');
  assert.deepEqual(M.pickCodexRollout(old, { me: t2, beginOf: (c, from) => (from === 159000 ? 162000 : null), peers: [{ since: 100000, file: null, mtimeMs: 0 }] }), { file: 'old', id: 'id-old' }, 'but not when it has no growth after the peer\'s since');
});

test('follow codex (R25, R61): a third terminal beside two stuck no-file twins is ambiguous, since the twins could still adopt its rollout', async () => {
  const env = fresh();
  const now = Date.now();
  const r3 = codexFile(env, `t3-${ID_C}`);
  fs.mkdirSync(path.join(env.vault, 'brain', '_index', 'code'), { recursive: true });
  for (const [term, since] of [[TERM, now - 200000], [TERM2, now - 197000]]) {
    fs.writeFileSync(claimPath(env, term), JSON.stringify({ pid: process.pid, cwd: env.work, since, file: null }));
  }
  fs.writeFileSync(r3, metaLine(ID_C, env.work, iso(now - 59500)));
  const f3 = run({ host: 'codex', cwd: env.work, since: now - 60000, terminal: TERM3, vault: env.vault, dirs: env.dirs.codex });
  try {
    assert.ok(await waitFor(() => readEvents(M.cachePath(env.vault, TERM3)).some((e) => e.kind === 'error'), FOLLOWER_MS), 'no chat, one error: the safe failure');
    assert.equal(readClaim(env, TERM3)?.file ?? null, null);
  } finally { await f3.stop(); }
});

test('follow codex (R25, R61): a --id follower whose rollout is missing makes a neighbour\'s new rollout ambiguous', async () => {
  const env = fresh();
  const now = Date.now();
  const mine = codexFile(env, `mine-${ID_B}`);
  fs.writeFileSync(mine, metaLine(ID_B, env.work, iso(now - 29500)));
  const lost = run({ host: 'codex', id: ID_A, cwd: env.work, since: now - 90000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  assert.ok(await waitFor(() => readClaim(env, TERM) !== null, FOLLOWER_MS));
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 30000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  try {
    assert.ok(await waitFor(() => readEvents(M.cachePath(env.vault, TERM2)).some((e) => e.kind === 'error'), FOLLOWER_MS), 'it could adopt that rollout, so the neighbour shows no chat');
    assert.equal(readClaim(env, TERM2)?.file ?? null, null);
  } finally { await f2.stop(); await lost.stop(); }
});

test('follow codex (R26): subagent and exec rollouts in the folder are never adopted, though they grow after the parent\'s last append', async () => {
  const env = fresh();
  const now = Date.now();
  const src = (id, source, ts) => `${JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id, cwd: env.work, timestamp: ts, source } })}\n`;
  const cur = codexFile(env, `cur-${ID_A}`);
  const sub = codexFile(env, `sub-${ID_B}`);
  const exe = codexFile(env, `exec-${ID_C}`);
  fs.writeFileSync(cur, src(ID_A, 'cli', iso(now - 119500)) + codexUser('in the current one', now - 119000));
  fs.writeFileSync(sub, src(ID_B, { subagent: { thread_spawn: { parent_thread_id: ID_A, depth: 1 } } }, iso(now - 600000)) + codexUser('delegated', now - 599000));
  setMtime(sub, now - 590000);
  const r = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const cache = M.cachePath(env.vault, TERM);
  try {
    assert.ok(await waitFor(() => readClaim(env, TERM)?.file === cur, FOLLOWER_MS));
    setMtime(cur, now - 30000);
    await sleep(100);
    fs.appendFileSync(sub, codexUser('the subagent works on'));
    fs.writeFileSync(exe, src(ID_C, 'exec', iso(now - 10000)) + codexUser('a headless run', now - 9000));
    await sleep(500);
    assert.deepEqual(sessionIds(cache), [ID_A]);
    assert.equal(readEvents(cache).some((e) => e.kind === 'error'), false, 'and nothing is ambiguous');
    assert.equal(readClaim(env, TERM).file, cur);
  } finally { await r.stop(); }
});

test('follow codex (D): a rollout that cannot be stat\'ed keeps its last known append, so no older rollout becomes a candidate', async () => {
  const env = fresh();
  const now = Date.now();
  const cur = codexFile(env, `cur-${ID_A}`);
  const other = codexFile(env, `other-${ID_B}`);
  fs.writeFileSync(cur, metaLine(ID_A, env.work, iso(now - 119500)) + codexUser('in the current one', now - 119000));
  const r = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const cache = M.cachePath(env.vault, TERM);
  try {
    assert.ok(await waitFor(() => readClaim(env, TERM)?.file === cur, FOLLOWER_MS));
    // R61: another session's rollout appears only after this one has adopted its own.
    fs.writeFileSync(other, metaLine(ID_B, env.work, iso(now - 60000)) + codexUser('another', now - 59000));
    setMtime(other, now - 40000);
    fs.unlinkSync(cur);
    // ten missing polls end it, and the scans in them saw no file
    let ended = false;
    r.done.then(() => { ended = true; });
    await waitFor(() => ended, FOLLOWER_MS);
    assert.deepEqual(sessionIds(cache), [ID_A], 'the chat it had; the other rollout was never taken');
    assert.ok(ended, 'the follower ended when its rollout stayed gone');
  } finally { await r.stop(); }
});

// ── Session reports from the code-session hook (spec 2026-11-10-codex-session-claim) ──

const report = (env, term, id, atMs) => M.writeSessionReport(env.vault, { terminal: term, host: 'codex', sessionId: id, source: 'startup', now: new Date(atMs) });
const errors = (file) => readEvents(file).filter((e) => e.kind === 'error');

test('session reports: written with only the id, read back; anything not a valid report reads as none', () => {
  const env = fresh();
  assert.equal(M.writeSessionReport(env.vault, { terminal: 'nope', host: 'codex', sessionId: ID_A }), null);
  assert.equal(M.writeSessionReport(env.vault, { terminal: TERM, host: 'codex', sessionId: '../x' }), null);
  assert.equal(M.writeSessionReport(env.vault, { terminal: TERM, host: 'other', sessionId: ID_A }), null);
  assert.equal(M.readSessionReport(env.vault, TERM), null, 'none written');
  const file = report(env, TERM, ID_A, 1700000000000);
  assert.deepEqual(M.readSessionReport(env.vault, TERM), { atMs: 1700000000000, host: 'codex', sessionId: ID_A });
  for (const bad of ['{', JSON.stringify({ at: 'x', host: 'codex', session_id: ID_A }), JSON.stringify({ at: iso(1), host: 'codex', session_id: 'a/b' }), JSON.stringify({ at: iso(1), host: 'x', session_id: ID_A })]) {
    fs.writeFileSync(file, bad);
    assert.equal(M.readSessionReport(env.vault, TERM), null, bad);
  }
});

test('pickCodexRollout: a peer\'s session is claimed like its file; a peer waiting for its reported session neither contends nor counts for the 5 s rule', () => {
  const t = me({ since: 100000 });
  const c = [cand('x', 101000, 110000)];
  assert.deepEqual(M.pickCodexRollout(c, { me: t, peers: [{ since: 100500, file: null, mtimeMs: 0 }] }), { ambiguous: true }, 'without a report: the 5 s rule');
  assert.equal(M.pickCodexRollout(c, { me: t, peers: [{ since: 100500, file: null, mtimeMs: 0, session: 'id-x' }] }), null, 'the peer\'s reported session');
  assert.deepEqual(M.pickCodexRollout(c, { me: t, peers: [{ since: 100500, file: null, mtimeMs: 0, session: 'id-other' }] }), { file: 'x', id: 'id-x' }, 'a peer that waits for its own session');
  assert.deepEqual(M.pickCodexRollout(c, { me: t, peers: [{ since: 50000, file: null, mtimeMs: 0, session: 'id-other' }] }), { file: 'x', id: 'id-x' }, 'and does not contend (R25) either');
  assert.equal(M.pickCodexRollout(c, { me: t, peers: [{ since: 50000, file: 'now', mtimeMs: 200000, session: 'id-now', held: ['x'] }] }), null, 'a rollout a peer followed before');
});

test('follow codex (R75): two terminals started within 5 s, each named by its report, follow their own rollouts with no error', async () => {
  const env = fresh();
  const now = Date.now();
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 10000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 7000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  const c1 = M.cachePath(env.vault, TERM);
  const c2 = M.cachePath(env.vault, TERM2);
  try {
    report(env, TERM, ID_A, now - 9000);
    report(env, TERM2, ID_B, now - 6000);
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_A && readClaim(env, TERM2)?.session === ID_B), 'each claims its session at once');
    assert.equal(readClaim(env, TERM).file, null, 'no rollout yet: Codex writes it at the first prompt');
    // R61: each rollout appears at its terminal's first prompt.
    fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now - 9000)) + codexUser('one'));
    fs.writeFileSync(codexFile(env, `b-${ID_B}`), metaLine(ID_B, env.work, iso(now - 6000)) + codexUser('two'));
    assert.ok(await waitFor(() => readEvents(c1).some((e) => e.text === 'one') && readEvents(c2).some((e) => e.text === 'two')));
    await sleep(400);
    assert.deepEqual(sessionIds(c1), [ID_A]);
    assert.deepEqual(sessionIds(c2), [ID_B]);
    assert.deepEqual([...errors(c1), ...errors(c2)], [], 'no "Can\'t tell which conversation"');
    assert.ok(readEvents(c1).every((e) => e.text !== 'two') && readEvents(c2).every((e) => e.text !== 'one'));
  } finally { await f1.stop(); await f2.stop(); }
});

test('follow codex (D3): while a reported rollout is not there yet there is no folder guess, then it is followed from its start', async () => {
  const env = fresh();
  const now = Date.now();
  // a no-file peer started with it: the folder guess alone would be ambiguous
  fs.mkdirSync(path.dirname(claimPath(env, TERM2)), { recursive: true });
  fs.writeFileSync(claimPath(env, TERM2), JSON.stringify({ pid: process.pid, cwd: env.work, since: now - 1000, file: null }));
  const r = run({ host: 'codex', cwd: env.work, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const cache = M.cachePath(env.vault, TERM);
  try {
    report(env, TERM, ID_A, now);
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_A));
    fs.writeFileSync(codexFile(env, `b-${ID_B}`), metaLine(ID_B, env.work, iso(now)) + codexUser('not mine'));
    await sleep(600);
    assert.deepEqual(errors(cache), [], 'no guess while it waits');
    assert.equal(sessionIds(cache).includes(ID_B), false);
    fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now)) + codexUser('mine', now));
    assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'mine')));
    assert.equal(readClaim(env, TERM).file, codexFile(env, `a-${ID_A}`));
    assert.deepEqual(sessionIds(cache), [ID_A]);
  } finally { await r.stop(); }
});

test('follow codex (D3): a /new reported in the TUI claims the new session at once and follows its rollout once it exists', async () => {
  const env = fresh();
  const now = Date.now();
  const a = codexFile(env, `a-${ID_A}`);
  fs.writeFileSync(a, metaLine(ID_A, env.work, iso(now - 59000)) + codexUser('first', now - 58000));
  const r = run({ host: 'codex', cwd: env.work, since: now - 60000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const cache = M.cachePath(env.vault, TERM);
  try {
    assert.ok(await waitFor(() => readClaim(env, TERM)?.file === a), 'the folder guess, with no report');
    report(env, TERM, ID_C, now);
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_C));
    assert.deepEqual(readClaim(env, TERM), { pid: process.pid, cwd: env.work, since: now - 60000, file: a, session: ID_C, held: [a] }, 'the old rollout stays claimed');
    assert.deepEqual(sessionIds(cache), [ID_A], 'the chat stays on what it shows until the new rollout exists');
    const c = codexFile(env, `c-${ID_C}`);
    fs.writeFileSync(c, metaLine(ID_C, env.work, iso(now)) + codexUser('after new', now));
    assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'after new')));
    await sleep(300);
    assert.deepEqual(sessionIds(cache), [ID_A, ID_C]);
    assert.deepEqual(readClaim(env, TERM).held, [a, c]);
  } finally { await r.stop(); }
});

test('follow codex (D3): a /resume the folder guess finds after a report is followed, and the same report never pulls it back', async () => {
  const env = fresh();
  const now = Date.now();
  const r = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const cache = M.cachePath(env.vault, TERM);
  try {
    report(env, TERM, ID_A, now - 110000);
    const a = codexFile(env, `a-${ID_A}`);
    fs.writeFileSync(a, metaLine(ID_A, env.work, iso(now - 110000)) + codexUser('a1', now - 109000));
    assert.ok(await waitFor(() => readClaim(env, TERM)?.file === a));
    setMtime(a, now - 30000);
    const b = codexFile(env, `b-${ID_B}`);
    fs.writeFileSync(b, metaLine(ID_B, env.work, iso(now - 3600000)) + codexUser('b old', now - 3590000) + codexUser('b resumed', now));
    assert.ok(await waitFor(() => sessionIds(cache).at(-1) === ID_B, FOLLOWER_MS), 'R17b: the /resume');
    report(env, TERM, ID_A, now - 110000); // the same report written again: a new mtime, the same report
    await sleep(500);
    assert.deepEqual(sessionIds(cache), [ID_A, ID_B]);
    assert.equal(readClaim(env, TERM).file, b);
  } finally { await r.stop(); }
});

test('follow codex (D4): a report from before the terminal, or before a follower given an id, is ignored; a later one is not', async () => {
  const env = fresh();
  const now = Date.now();
  // before the terminal started
  report(env, TERM, ID_A, now - 5000);
  fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now - 5000)));
  const f1 = run({ host: 'codex', cwd: env.work, since: now, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  // after the terminal started but before this follower (Resume with an id)
  const b = codexFile(env, `b-${ID_B}`);
  const c = codexFile(env, `c-${ID_C}`);
  fs.writeFileSync(b, metaLine(ID_B, env.work, iso(now - 59000)) + codexUser('the resumed one', now - 58000));
  fs.writeFileSync(c, metaLine(ID_C, env.work, iso(now - 30000)) + codexUser('the reported one', now - 29000));
  setMtime(b, now - 1000);
  setMtime(c, now - 20000);
  report(env, TERM2, ID_C, now - 30000);
  const f2 = run({ host: 'codex', id: ID_B, cwd: env.work, since: now - 60000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  const c1 = M.cachePath(env.vault, TERM);
  const c2 = M.cachePath(env.vault, TERM2);
  try {
    assert.ok(await waitFor(() => sessionIds(c2).includes(ID_B)));
    await sleep(500);
    assert.deepEqual(sessionIds(c1), [], 'the report from before the terminal');
    assert.deepEqual(sessionIds(c2), [ID_B], 'the report from before the follower');
    report(env, TERM2, ID_C, Date.now());
    assert.ok(await waitFor(() => readEvents(c2).some((e) => e.text === 'the reported one')), 'a report after it');
    assert.equal(sessionIds(c2).at(-1), ID_C);
  } finally { await f1.stop(); await f2.stop(); }
});

test('follow codex (D5): a report is looked up by id; a transcript_path in it is never read', async () => {
  const env = fresh();
  const now = Date.now();
  const decoy = path.join(env.root, 'decoy.jsonl');
  fs.writeFileSync(decoy, metaLine(ID_A, env.work, iso(now)) + codexUser('decoy'));
  fs.mkdirSync(path.join(env.vault, 'brain', '_index', 'code'), { recursive: true });
  fs.writeFileSync(path.join(env.vault, 'brain', '_index', 'code', `${TERM}.session.json`), JSON.stringify({ at: iso(now), host: 'codex', session_id: ID_A, transcript_path: decoy }));
  const r = run({ host: 'codex', cwd: env.work, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const cache = M.cachePath(env.vault, TERM);
  try {
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_A));
    await sleep(400);
    assert.equal(readEvents(cache).some((e) => e.text === 'decoy'), false);
    fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now)) + codexUser('real'));
    assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'real')));
  } finally { await r.stop(); }
});

test('follow codex (C1): a /new in one terminal never hands its old rollout to a quiet neighbour', async () => {
  const env = fresh();
  const now = Date.now();
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 117000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  const c1 = M.cachePath(env.vault, TERM);
  const c2 = M.cachePath(env.vault, TERM2);
  const a = codexFile(env, `a-${ID_A}`);
  const b = codexFile(env, `b-${ID_B}`);
  try {
    report(env, TERM, ID_A, now - 110000);
    report(env, TERM2, ID_B, now - 108000);
    fs.writeFileSync(a, metaLine(ID_A, env.work, iso(now - 110000)) + codexUser('a1', now - 109000));
    fs.writeFileSync(b, metaLine(ID_B, env.work, iso(now - 108000)) + codexUser('b1', now - 107000));
    assert.ok(await waitFor(() => readClaim(env, TERM)?.file === a && readClaim(env, TERM2)?.file === b));
    setMtime(b, now - 50000); // T2 has been quiet
    fs.appendFileSync(a, codexUser('a2', now - 10000)); // T1 works on
    assert.ok(await waitFor(() => readEvents(c1).some((e) => e.text === 'a2')));
    report(env, TERM, ID_C, now);
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_C));
    await sleep(600);
    assert.deepEqual(sessionIds(c2), [ID_B], 'T2 stays on its own conversation');
    fs.writeFileSync(codexFile(env, `c-${ID_C}`), metaLine(ID_C, env.work, iso(now)) + codexUser('c1', now));
    assert.ok(await waitFor(() => readEvents(c1).some((e) => e.text === 'c1')));
    await sleep(600);
    assert.deepEqual(sessionIds(c2), [ID_B], 'and after T1 follows its new one');
    assert.equal(readClaim(env, TERM2).file, b);
    assert.deepEqual([...errors(c1), ...errors(c2)], []);
  } finally { await f1.stop(); await f2.stop(); }
});

test('follow codex (I1): a nested codex exec\'s report is dropped — its rollout is not interactive, or a new prompt shows the agent stayed', async () => {
  const env = fresh();
  const now = Date.now();
  const r = run({ host: 'codex', cwd: env.work, since: now - 60000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const cache = M.cachePath(env.vault, TERM);
  const a = codexFile(env, `a-${ID_A}`);
  try {
    report(env, TERM, ID_A, now - 50000);
    fs.writeFileSync(a, metaLine(ID_A, env.work, iso(now - 50000)) + codexUser('main', now - 49000));
    assert.ok(await waitFor(() => readClaim(env, TERM)?.file === a));
    // the agent runs `codex exec …` through its shell: that run's SessionStart overwrites the report
    report(env, TERM, ID_D, now - 1000);
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_D));
    const execLine = (id, ts) => `${JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id, cwd: env.work, timestamp: ts, source: 'exec' } })}\n`;
    fs.writeFileSync(codexFile(env, `d-${ID_D}`), execLine(ID_D, iso(now - 1000)) + codexUser('the exec prompt', now - 900));
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_A), 'dropped: not a terminal\'s own conversation');
    // an exec that writes no rollout (--ephemeral): pending until the main conversation gets a new prompt
    report(env, TERM, ID_C, Date.now());
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_C));
    fs.appendFileSync(a, codexUser('next prompt in main'));
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_A), 'dropped on the new prompt');
    assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'next prompt in main')));
    assert.deepEqual(sessionIds(cache), [ID_A]);
    assert.equal(readEvents(cache).some((e) => e.text === 'the exec prompt'), false);
  } finally { await r.stop(); }
});

test('follow codex: a report naming the session a follower given an id already shows (Resume, a chip restart) adds nothing', async () => {
  const env = fresh();
  const now = Date.now();
  fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now - 3600000)) + codexUser('hello', now - 3590000));
  const r = run({ host: 'codex', id: ID_A, cwd: env.work, since: now - 1000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const cache = M.cachePath(env.vault, TERM);
  try {
    assert.ok(await waitFor(() => readEvents(cache).some((e) => e.text === 'hello')));
    report(env, TERM, ID_A, Date.now());
    await sleep(500);
    assert.equal(readEvents(cache).filter((e) => e.text === 'hello').length, 1, 'the transcript is not read again');
    assert.deepEqual(sessionIds(cache), [ID_A]);
  } finally { await r.stop(); }
});

test('follow codex: a terminal with no report never takes, nor is unsure of, the rollout a neighbour\'s report named', async () => {
  const env = fresh();
  const now = Date.now();
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 10000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 8000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  const c1 = M.cachePath(env.vault, TERM);
  const c2 = M.cachePath(env.vault, TERM2);
  try {
    report(env, TERM, ID_A, now - 9000);
    assert.ok(await waitFor(() => readClaim(env, TERM)?.session === ID_A));
    await sleep(100); // T2's next scan reads T1's claim
    fs.writeFileSync(codexFile(env, `a-${ID_A}`), metaLine(ID_A, env.work, iso(now - 9000)) + codexUser('one'));
    assert.ok(await waitFor(() => readEvents(c1).some((e) => e.text === 'one')));
    await sleep(500);
    assert.deepEqual(sessionIds(c2), []);
    assert.deepEqual(errors(c2), [], 'no "Can\'t tell" either');
  } finally { await f1.stop(); await f2.stop(); }
});

test('pickCodexRollout (D9): a closed terminal\'s rollouts stay claimed until one grows after its close', () => {
  const t = me({ since: 100000, file: 'b', mtimeMs: 150000 });
  const beginOf = () => 160000;
  const a = [cand('a', 50000, 170000)]; // an older rollout last appended at 170 s, after my last append
  assert.deepEqual(M.pickCodexRollout(a, { me: t, beginOf }), { file: 'a', id: 'id-a' }, 'without the hold: R17b takes it');
  assert.equal(M.pickCodexRollout(a, { me: t, beginOf, closed: [{ held: ['a'], closedAt: 175000 }] }), null, 'held by the closed terminal');
  assert.deepEqual(M.pickCodexRollout([cand('a', 50000, 190000)], { me: t, beginOf, closed: [{ held: ['a'], closedAt: 175000 }] }), { file: 'a', id: 'id-a' }, 'grown after the close: resumed somewhere');
});

test('follow codex (D9): closing a terminal leaves its conversation to no quiet neighbour', async () => {
  const env = fresh();
  const now = Date.now();
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 120000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 117000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  const c2 = M.cachePath(env.vault, TERM2);
  const a = codexFile(env, `a-${ID_A}`);
  const b = codexFile(env, `b-${ID_B}`);
  let stopped1 = false;
  try {
    report(env, TERM, ID_A, now - 110000);
    report(env, TERM2, ID_B, now - 108000);
    fs.writeFileSync(a, metaLine(ID_A, env.work, iso(now - 110000)) + codexUser('a1', now - 109000));
    fs.writeFileSync(b, metaLine(ID_B, env.work, iso(now - 108000)) + codexUser('b1', now - 107000));
    assert.ok(await waitFor(() => readClaim(env, TERM)?.file === a && readClaim(env, TERM2)?.file === b));
    setMtime(b, now - 50000); // T2 has been quiet
    fs.appendFileSync(a, codexUser('a2', now - 10000)); // T1 worked until it closed
    await sleep(100);
    await f1.stop();
    stopped1 = true;
    const closed = JSON.parse(fs.readFileSync(path.join(env.vault, 'brain', '_index', 'code', `${TERM}.closed.json`), 'utf8'));
    assert.deepEqual([closed.cwd, closed.held], [env.work, [a]]);
    await sleep(600);
    assert.deepEqual(sessionIds(c2), [ID_B], 'T2 stays on its own conversation');
    assert.deepEqual(errors(c2), []);
  } finally { if (!stopped1) await f1.stop(); await f2.stop(); }
});

test('follow codex: a rollout that shows a moment before its terminal\'s report writes no "Can\'t tell" on either side', async () => {
  const env = fresh();
  const now = Date.now();
  const a = codexFile(env, `a-${ID_A}`);
  fs.writeFileSync(a, metaLine(ID_A, env.work, iso(now - 59000)) + codexUser('a1', now - 58000));
  setMtime(a, now - 30000);
  const f1 = run({ host: 'codex', cwd: env.work, since: now - 60000, terminal: TERM, vault: env.vault, dirs: env.dirs.codex });
  const f2 = run({ host: 'codex', cwd: env.work, since: now - 1000, terminal: TERM2, vault: env.vault, dirs: env.dirs.codex });
  const c1 = M.cachePath(env.vault, TERM);
  const c2 = M.cachePath(env.vault, TERM2);
  try {
    assert.ok(await waitFor(() => readClaim(env, TERM)?.file === a));
    // Codex writes T2's rollout at its first prompt; its SessionStart hook reports it a moment later.
    fs.writeFileSync(codexFile(env, `b-${ID_B}`), metaLine(ID_B, env.work, iso(now)) + codexUser('b1', now));
    await sleep(200); // a scan or two on each side sees the rollout unclaimed
    report(env, TERM2, ID_B, Date.now());
    assert.ok(await waitFor(() => readEvents(c2).some((e) => e.text === 'b1')));
    await sleep(600);
    assert.deepEqual([...errors(c1), ...errors(c2)], []);
    assert.deepEqual(sessionIds(c1), [ID_A]);
  } finally { await f1.stop(); await f2.stop(); }
});
