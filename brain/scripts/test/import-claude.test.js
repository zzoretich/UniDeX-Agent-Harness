'use strict';
// The importer on a Claude Code-only machine without the local model (install-import B8, B10, B15): CLAUDE.md becomes
// one reference memory, auto-memory keeps its types, nothing is asked of a hosted provider, Codex rows are empty, and
// the digest waits — on battery, with the engine down, or while another run holds the lock — writing and spending
// nothing; a reply that is not JSON gives a title summary, and a connection failure stops the run with the session kept.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeWorld, fakeEngine } = require('./import-world.js');

const w = makeWorld({ codex: false });
process.env.AOS_VAULT = w.vault;
const { runImport } = require('../lib/import/index.js');
const D = require('../lib/import/digest.js');
const W = require('../../../cli/workspace.js');

const V = (rel) => path.join(w.vault, rel);
const json = (rel) => JSON.parse(fs.readFileSync(V(rel), 'utf8'));
let hostedCalls = 0;
// provider `auto` with Claude Code signed in: provider.js would answer `claude`. The importer must not use it.
const hosted = async () => ({ name: 'claude', reason: 'claude-logged-in', capabilities: { chat: true }, chat: async () => { hostedCalls++; return '{}'; } });
const base = {
  vault: w.vault, cfg: {}, userConfig: { ...w.userConfig, hosts: { claude: { enabled: true }, codex: { enabled: false } } }, env: w.env, home: w.home,
  tmpDirs: w.tmpDirs, gitCeiling: w.gitCeiling, workspace: W, wsOpts: { vault: w.vault, configDir: w.claudeDir, env: {}, home: w.home, tmpDirs: w.tmpDirs },
};

test('with no local model CLAUDE.md imports whole as one reference memory, and the hosted provider is never asked', async () => {
  const r = await runImport({ ...base, provider: hosted });
  assert.deepEqual(r.engine, { ready: false, provider: 'claude', model: null, reason: 'claude-not-used' });
  assert.equal(hostedCalls, 0);
  assert.equal(r.hosts.claude.instructions.mode, 'whole');
  const ref = fs.readFileSync(V('brain/memory/reference/claude-code-global-instructions-claude-md.md'), 'utf8');
  assert.match(ref, /^# Claude Code global instructions \(CLAUDE\.md\)$/m);
  assert.match(ref, /- Always run the full test suite before you say a change is done\./);
  assert.doesNotMatch(ref, /AGENTICOS\.md|personal notes below/);
  assert.match(ref, /no local model was available to sort it into rules/);
  assert.match(ref, /origin: "~\/\.claude\/CLAUDE\.md"/);
  assert.equal(r.written, 4, 'the whole file and three auto-memories');
  assert.deepEqual(r.hosts.codex, { present: true, configDir: '~/.codex', instructions: { files: 0, rules: 0, written: 0, duplicates: 0, unchanged: 0, mode: null, paths: [], skipped: [], new: 0 }, memories: { files: 0, written: 0, duplicates: 0, paths: [], byType: {}, new: 0 }, mcp: { servers: 0 }, sessions: 0 });
  assert.equal(r.sessions.engineReady, null);
  // A later run with the model up does not split the same file again (it is unchanged).
  const again = await runImport({ ...base, provider: fakeEngine().provider, only: ['instructions'] });
  assert.equal(again.written, 0);
  assert.equal(again.hosts.claude.instructions.unchanged, 1);
});

test('the vault\'s own files are never imported: a CLAUDE.md that is a link into the vault is skipped', async () => {
  const w2 = makeWorld({ codex: false });
  fs.writeFileSync(path.join(w.vault, 'linked-instructions.md'), '- a rule that lives in the vault already\n');
  fs.rmSync(path.join(w2.claudeDir, 'CLAUDE.md'));
  fs.symlinkSync(path.join(w.vault, 'linked-instructions.md'), path.join(w2.claudeDir, 'CLAUDE.md'));
  const I = require('../lib/import/instructions.js');
  const C = require('../lib/import/common.js');
  // A link is not a regular file: it is not even listed.
  assert.deepEqual(I.instructionFiles('claude', { configDir: w2.claudeDir }), []);
  assert.equal(C.insideVault(path.join(w2.claudeDir, 'CLAUDE.md'), w.vault), true);
});

test('the digest waits on battery, with the local model down, and behind another run; nothing is read or spent', async () => {
  const st = json('brain/_index/import-state.json');
  assert.equal(st.digest.queue.length, 4);
  let asked = 0;
  const spy = async () => { asked++; return { name: 'none', reason: 'local-down' }; };
  const battery = await D.runDigest({ vault: w.vault, provider: spy, deferOnBattery: () => true, config: () => ({}), home: w.home });
  assert.equal(battery.status, 'deferred');
  assert.equal(asked, 0, 'on battery it does not even look for the model');
  const down = await D.runDigest({ vault: w.vault, provider: spy, deferOnBattery: () => false, config: () => ({}), home: w.home });
  assert.deepEqual([down.status, down.reason, down.left], ['waiting', 'local-down', 4]);
  const host = await D.runDigest({ vault: w.vault, provider: hosted, deferOnBattery: () => false, config: () => ({}), home: w.home });
  assert.equal(host.status, 'waiting');
  assert.match(host.reason, /claude is hosted/);
  assert.equal(hostedCalls, 0);
  assert.ok(!fs.existsSync(V('brain/_index/session-digests.json')));
  assert.equal(json('brain/_index/import-state.json').digest.lastRun.status, 'waiting');
  // Another run holds the lock.
  fs.writeFileSync(V('brain/_index/.import-digest.lock'), JSON.stringify({ pid: process.pid, id: 'other', until: new Date(Date.now() + 60000).toISOString() }));
  const busy = await D.runDigest({ vault: w.vault, provider: fakeEngine().provider, deferOnBattery: () => false, config: () => ({}), home: w.home });
  assert.equal(busy.status, 'busy');
  fs.unlinkSync(V('brain/_index/.import-digest.lock'));
  assert.equal(require('../lib/routines-store.js').read('import-digest', { dir: V('brain/routines') }).enabled, true, 'still on: work remains');
});

test('a connection failure stops the run with the session still queued; a reply that is not JSON gives a title summary', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  const r = await D.runDigest({ vault: w.vault, provider: fakeEngine({ fail: refused }).provider, deferOnBattery: () => false, config: () => ({}), home: w.home });
  assert.deepEqual([r.status, r.processed, r.left], ['ran', 0, 4]);
  assert.match(r.reason, /stopped answering/);
  const junk = fakeEngine({ digest: () => 'not json at all' });
  // A run that is out of time after the first session leaves the rest for the next one.
  let t = 0;
  const clock = () => (t += 6 * 60 * 1000);
  const r2 = await D.runDigest({ vault: w.vault, provider: junk.provider, deferOnBattery: () => false, config: () => ({}), home: w.home, now: clock });
  assert.deepEqual([r2.status, r2.processed, r2.left], ['ran', 1, 3]);
  assert.match(r2.line, /3 left \(the 10-minute budget is used\)/);
  assert.equal(junk.calls.length, 2, 'one retry, then the title');
  const dg = json('brain/_index/session-digests.json').sessions;
  assert.equal(dg.length, 1);
  assert.equal(dg[0].summarySource, 'title');
  assert.deepEqual(dg[0].memories, []);
  const st = json('brain/_index/import-state.json');
  assert.deepEqual([st.digest.processed, st.digest.failed, st.digest.queue.length, st.digest.done], [1, 1, 3, false]);
});

test('a session the model times out on twice gets its title, and the queue moves on', async () => {
  const slow = fakeEngine({ fail: new Error('ollama timeout') });
  const before = json('brain/_index/import-state.json').digest.queue.length;
  let t = 0;
  const r = await D.runDigest({ vault: w.vault, provider: slow.provider, deferOnBattery: () => false, config: () => ({}), home: w.home, now: () => (t += 6 * 60 * 1000) });
  assert.deepEqual([r.processed, r.left], [1, before - 1]);
  assert.equal(slow.calls.length, 2, 'once in full, once shorter');
  assert.equal(json('brain/_index/session-digests.json').sessions.filter((s) => s.summarySource === 'title').length, 2);
});

test('a session an auto-wrap already read gets its line but no memories', async () => {
  const st = json('brain/_index/import-state.json');
  const next = st.digest.queue[0];
  const offsets = require('../lib/wrap-offsets.js');
  offsets.markWrapped(next.id, 10);
  const eng = fakeEngine();
  const r = await D.runDigest({ vault: w.vault, provider: eng.provider, deferOnBattery: () => false, config: () => ({}), home: w.home });
  assert.equal(r.status, 'done');
  const d = json('brain/_index/session-digests.json').sessions.find((s) => s.id === next.id);
  assert.deepEqual(d.memories, []);
  assert.equal(d.summarySource, 'model');
  assert.ok(offsets.wrappedChars(next.id) > 10, 'the mark moves to the whole transcript');
});
