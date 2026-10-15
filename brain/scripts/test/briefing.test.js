'use strict';
// persona/briefing.js (spec 2026-10-08-pulse-cockpit-design P6, P7). No model is called: the provider is a fake.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../persona/briefing.js');

const NOW = new Date(2026, 9, 8, 19, 24);
let vault;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'persona'), { recursive: true });
});
afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

const FACTS = {
  schema: 1, persona: 'Beacon', hash: 'h1',
  needsYou: [{ tier: 0, area: 'proposals', kind: 'proposal', tone: 'gate', title: 'Tidy the memory index', since: '2026-09-22', ref: 'x.md' }],
  summary: { routines: { total: 12, failing: 0 } },
};
const REPLY = { text: 'Good evening. The “Tidy the memory index” proposal has waited 16 days, and 2 more need you. 12 routines green.' };

/** Deps with a fake provider; `over` replaces any of them. Records the chat calls. */
function deps(over = {}) {
  const calls = [];
  const { provider: fake, ...rest } = over;
  const provider = fake || { name: 'claude', model: 'haiku', chat: async (o) => { calls.push(o); return JSON.stringify(REPLY); } };
  return {
    calls,
    deps: {
      vault, now: () => NOW, config: () => ({ persona: { enabled: true, briefing: { enabled: true, staleHours: 3 } } }),
      facts: () => FACTS, dutySpend: () => 0.5, caps: () => ({ perDayUsd: 6, perDutyUsd: 2 }), provider: async () => provider,
      ...rest,
    },
  };
}
const out = () => JSON.parse(fs.readFileSync(B.outPath(vault), 'utf8'));

test('writes the paragraph: one duty:briefing call asking only for text; the mentions are the item words found in it', async () => {
  const d = deps();
  const r = await B.run({ deps: d.deps });
  assert.deepEqual(r, { status: 'ok', reason: null, wrote: true });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].feature, 'duty:briefing');
  assert.deepEqual(d.calls[0].schema, B.REPLY_SCHEMA);
  assert.match(d.calls[0].system, /You are Beacon, the user's Chief of Staff/);
  assert.match(d.calls[0].prompt, /Time: evening\./);
  assert.match(d.calls[0].prompt, /"say":"the “Tidy the memory index” proposal","area":"proposals","waiting":"16 days"/);
  assert.match(d.calls[0].prompt, /fine: \[\{"say":"12 routines green","area":"routines"\}\]/);
  const o = out();
  assert.equal(o.status, 'ok');
  assert.equal(o.text, REPLY.text);
  assert.deepEqual(o.mentions, [
    { phrase: 'The “Tidy the memory index” proposal', area: 'proposals' },
    { phrase: '2 more', area: 'needs' },
    { phrase: '12 routines green', area: 'routines' },
  ]);
  assert.equal(o.provider, 'claude');
  assert.equal(o.model, 'haiku');
  assert.equal(o.factsHash, 'h1');
  assert.equal(o.persona, 'Beacon');
  assert.equal(o.generatedAt, NOW.toISOString());
  assert.ok(!fs.existsSync(path.join(vault, 'brain', '_index', 'briefing.lock')), 'the lock is released');
});

test('unchanged facts make no call; --force does', async () => {
  const d = deps();
  await B.run({ deps: d.deps });
  assert.deepEqual(await B.run({ deps: d.deps }), { status: 'unchanged', wrote: false });
  assert.equal(d.calls.length, 1);
  assert.equal((await B.run({ deps: d.deps, force: true })).status, 'ok');
  assert.equal(d.calls.length, 2);
});

test('nothing runs or is written while the persona is off (config or persona/DISABLED) or the briefing is off', async () => {
  const off = deps({ config: () => ({ persona: { enabled: false } }) });
  assert.deepEqual(await B.run({ deps: off.deps }), { status: 'off', reason: 'persona-off', wrote: false });
  fs.writeFileSync(path.join(vault, 'persona', 'DISABLED'), '');
  const disabled = deps();
  assert.equal((await B.run({ deps: disabled.deps })).reason, 'persona-off');
  fs.unlinkSync(path.join(vault, 'persona', 'DISABLED'));
  const briefingOff = deps({ config: () => ({ persona: { enabled: true, briefing: { enabled: false } } }) });
  assert.deepEqual(await B.run({ deps: briefingOff.deps }), { status: 'off', reason: 'briefing-off', wrote: false });
  assert.equal(off.calls.length + disabled.calls.length + briefingOff.calls.length, 0);
  assert.ok(!fs.existsSync(B.outPath(vault)));
});

test('at the daily duty cap: skipped, no call, and the last good paragraph is kept', async () => {
  await B.run({ deps: deps().deps });
  const capped = deps({ dutySpend: () => 6, facts: () => ({ ...FACTS, hash: 'h2' }) });
  assert.deepEqual(await B.run({ deps: capped.deps }), { status: 'skipped', reason: 'daily-cap', wrote: true });
  assert.equal(capped.calls.length, 0);
  const o = out();
  assert.equal(o.status, 'skipped');
  assert.equal(o.text, REPLY.text, 'the last good text stays');
  assert.equal(o.generatedAt, NOW.toISOString());
  assert.equal(o.factsHash, 'h1', 'the hash stays the one the text was written for');
  const zero = deps({ caps: () => ({ perDayUsd: 0, perDutyUsd: 2 }) });
  assert.equal((await B.run({ deps: zero.deps })).reason, 'daily-cap', 'a $0 cap never spends');
});

test('provider none: skipped with its reason; a cap or none thrown mid-call is skipped too', async () => {
  const none = deps({ provider: { name: 'none', reason: 'claude-not-logged-in', chat: async () => { throw new Error('unreachable'); } } });
  assert.deepEqual(await B.run({ deps: none.deps }), { status: 'skipped', reason: 'claude-not-logged-in', wrote: true });
  const capErr = Object.assign(new Error('cap'), { code: 'PROVIDER_CAP' });
  const capped = deps({ provider: { name: 'codex', model: null, chat: async () => { throw capErr; } } });
  assert.equal((await B.run({ deps: capped.deps, force: true })).reason, 'daily-cap');
  assert.equal(out().status, 'skipped');
});

test('a failed call or an unreadable reply is failed (the routine exits 1), keeping the last good text', async () => {
  await B.run({ deps: deps().deps });
  const boom = deps({ provider: { name: 'claude', model: 'haiku', chat: async () => { throw new Error('timeout after 80000 ms'); } } });
  assert.deepEqual(await B.run({ deps: boom.deps, force: true }), { status: 'failed', reason: 'timeout after 80000 ms', wrote: true });
  assert.equal(out().text, REPLY.text);
  const junk = deps({ provider: { name: 'ollama', model: null, chat: async () => 'I cannot do that.' } });
  assert.equal((await B.run({ deps: junk.deps, force: true })).reason, 'unreadable reply');
  assert.equal(out().status, 'failed');
});

test('a run already in flight makes the next one stop; a lock left by a dead run is taken over', async () => {
  const lockFile = path.join(vault, 'brain', '_index', 'briefing.lock');
  fs.writeFileSync(lockFile, '{}');
  const d = deps();
  assert.deepEqual(await B.run({ deps: d.deps }), { status: 'busy', wrote: false });
  const old = (Date.now() - 10 * 60e3) / 1000;
  fs.utimesSync(lockFile, old, old);
  const later = deps({ now: () => new Date() });
  assert.equal((await B.run({ deps: later.deps })).status, 'ok');
});

test('parseReply: plain JSON, JSON inside other text, and nothing usable', () => {
  assert.deepEqual(B.parseReply('{"text":"  Two   spaces.  "}'), { text: 'Two spaces.' });
  assert.deepEqual(B.parseReply('Here it is:\n```json\n{"text":"Hi there."}\n```'), { text: 'Hi there.' });
  assert.equal(B.parseReply('{"text":""}'), null);
  assert.equal(B.parseReply('no json here'), null);
});

test('the words for an item: a proposal\'s title is quoted, one named "... Proposal" not doubled; a long flag is cut at a word', () => {
  assert.equal(B.sayOf({ kind: 'proposal', title: 'Workbench 1.0 Proposal' }), 'the “Workbench 1.0 Proposal”');
  assert.equal(B.sayOf({ kind: 'proposal', title: 'Weekly digest' }), 'the “Weekly digest” proposal');
  assert.equal(B.sayOf({ kind: 'proposal', title: 'An idea with loose ends' }), 'the “An idea with loose ends” proposal');
  const flag = B.sayOf({ kind: 'flag', title: 'Bash denied in unattended runs drops duty writes and reads; root cause: no tools allowlist for the duty' });
  assert.ok(flag.length <= 71 && flag.endsWith('…'), flag);
  assert.equal(B.sayOf({ kind: 'error', title: '2 hook paths are missing' }), '2 hook paths are missing');
});

test('mentions: any case, in text order, overlapping finds keep the first, missing words are skipped', () => {
  const items = [{ say: 'the Weekly digest proposal', area: 'proposals' }, { say: 'weekly digest', area: 'health' }, { say: 'not there', area: 'todo' }];
  assert.deepEqual(B.mentionsFor('Good morning. 3 others wait; The Weekly Digest proposal first.', items, [{ say: 'pipelines healthy', area: 'health' }]), [
    { phrase: '3 others', area: 'needs' },
    { phrase: 'The Weekly Digest proposal', area: 'proposals' },
  ]);
});

test('mentions: a quoted title matches with straight quotes or none, as the model wrote it', () => {
  const items = [{ say: 'the “Weekly digest” proposal', area: 'proposals' }];
  assert.deepEqual(B.mentionsFor('Good morning. The "Weekly digest" proposal waits.', items, []), [{ phrase: 'The "Weekly digest" proposal', area: 'proposals' }]);
  assert.deepEqual(B.mentionsFor('Good morning. The Weekly digest proposal waits.', items, []), [{ phrase: 'The Weekly digest proposal', area: 'proposals' }]);
  assert.deepEqual(B.mentionsFor('Good morning. The “weekly digest” proposal waits.', items, []), [{ phrase: 'The “weekly digest” proposal', area: 'proposals' }]);
});

test('mentions: a count the model spelled out still matches ("Two hook paths", "three more")', () => {
  assert.deepEqual(B.mentionsFor('Good evening. Two hook paths are missing, and three more wait.', [{ say: '2 hook paths are missing', area: 'health' }], []), [
    { phrase: 'Two hook paths are missing', area: 'health' },
    { phrase: 'three more', area: 'needs' },
  ]);
});

test('every area a mention may open is a Pulse area, and the reply schema asks for text only', () => {
  assert.deepEqual(B.AREAS, require('../lib/pulse-facts.js').AREAS);
  assert.deepEqual(Object.keys(B.REPLY_SCHEMA.properties), ['text']);
});

// ── provider local (local-first A1, A3, A18) ──
test('on the local engine: free, so never held to the duty cap; the paragraph names the local model', async () => {
  const calls = [];
  const local = { name: 'ollama', engine: 'ollama', model: 'qwen3.5:9b', chat: async (o) => { calls.push(o); return JSON.stringify(REPLY); } };
  const d = deps({ provider: local, dutySpend: () => 99, caps: () => ({ perDayUsd: 6, perDutyUsd: 2 }) });
  const r = await B.run({ deps: d.deps });
  assert.deepEqual(r, { status: 'ok', reason: null, wrote: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].format, B.REPLY_SCHEMA, 'the schema as Ollama\'s format');
  assert.deepEqual([out().provider, out().model], ['ollama', 'qwen3.5:9b']);
  // A cap of 0 (no duty spend at all) does not stop a free paragraph either.
  const zero = deps({ provider: local, caps: () => ({ perDayUsd: 0, perDutyUsd: 2 }) });
  assert.equal((await B.run({ deps: zero.deps, force: true })).status, 'ok');
});

test('the local engine down: skipped with local-down, no call; Pulse then shows the facts alone and the last good text is kept', async () => {
  const d = deps();
  await B.run({ deps: d.deps });
  const down = deps({ provider: { name: 'none', reason: 'local-down', chat: async () => { throw new Error('must not be called'); } } });
  const r = await B.run({ deps: down.deps, force: true });
  assert.deepEqual(r, { status: 'skipped', reason: 'local-down', wrote: true });
  const o = out();
  assert.deepEqual([o.status, o.reason, o.text], ['skipped', 'local-down', REPLY.text]);
});

test('a real local engine answers through provider.js: the briefing JSON from a loopback "Ollama", counted, not ledgered', async () => {
  const http = require('http');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }] }));
      seen.push(JSON.parse(body));
      res.end(JSON.stringify({ message: { content: JSON.stringify(REPLY) }, done: true }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'local', local: { url: `http://127.0.0.1:${server.address().port}` } }));
    // provider.js fixes the vault when first required: the real path runs in its own process, asynchronously so this
    // one can answer it.
    const script = `const B = require(${JSON.stringify(path.join(__dirname, '..', 'persona', 'briefing.js'))});
      B.run({ deps: { ...B.defaultDeps(), facts: () => (${JSON.stringify(FACTS)}) } }).then((r) => process.stdout.write(JSON.stringify(r)));`;
    const r = await new Promise((resolve) => require('child_process').execFile(process.execPath, ['-e', script],
      { env: { ...process.env, AOS_VAULT: vault, BRAIN_VAULT: vault, AOS_CONFIG: path.join(vault, 'none.json'), NODE_OPTIONS: '' } }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
    assert.equal(r.err, null, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'ok');
    assert.equal(seen[0].model, 'qwen3.5:9b');
    assert.equal(out().text, REPLY.text);
    assert.equal(fs.existsSync(path.join(vault, 'brain', '_index', 'provider-spend.jsonl')), false);
    assert.match(fs.readFileSync(path.join(vault, 'brain', '_index', 'local-usage.json'), 'utf8'), /duty:briefing/);
  } finally {
    server.close();
  }
});
