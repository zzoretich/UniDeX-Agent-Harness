'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT; delete process.env.BRAIN_VAULT;
// `aos memory merge-draft | merge | unmerge | sweep` end to end (spec 2026-10-12-brain-hub-ai A1–A11; plan PR 4 Mechanics):
// cli/memory.js → lib/memory-merge.js / lib/memory-sweep.js → the REAL lib/memory-ai.js → provider.js, with each host
// faked only at its own seam (Claude at claudeCall, billing the ledger as the real one does; Codex through the real
// codexCall with a fake spawn; Ollama with ollama.chat replaced), provider none, a cap, and the argument rules. No
// network and no model: every CLI is a fake and every ping is too.
//
// provider.js, config.js and the spend ledger fix the vault when first required (lib/paths.js), so this file keeps one
// vault and resets its files before each test.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RT = path.join(ROOT, 'brain', 'scripts');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mem-ai-cli-')));
const HOME = path.join(TMP, 'home');
const VAULT = path.join(HOME, 'Vault');
const CFG_DIR = path.join(HOME, '.claude');
const USER_CFG = path.join(CFG_DIR, 'agenticos.json');
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
fs.mkdirSync(CFG_DIR, { recursive: true });
process.env.AOS_VAULT = VAULT;
process.env.AOS_CONFIG = USER_CFG;
process.env.CLAUDE_CONFIG_DIR = CFG_DIR;
process.env.CODEX_HOME = path.join(HOME, '.codex');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const M = require('./memory.js');
const P = require(path.join(RT, 'sdk', 'lib', 'provider.js'));
const { recordSpend, SPEND_PATH } = require(path.join(RT, 'sdk', 'lib', 'spend-ledger.js'));
const codexCli = require(path.join(RT, 'sdk', 'lib', 'codex-cli.js'));
const codexPricing = require(path.join(RT, 'sdk', 'lib', 'codex-pricing.js'));
const modelPricing = require(path.join(RT, 'sdk', 'lib', 'model-pricing.js'));
const ollama = require(path.join(RT, 'sdk', 'lib', 'ollama.js'));
const { role } = require(path.join(RT, 'sdk', 'lib', 'models.js'));
const mergeLib = require(path.join(RT, 'lib', 'memory-merge.js'));
const sweepLib = require(path.join(RT, 'lib', 'memory-sweep.js'));

// ── the vault ──

const A = 'brain/memory/feedback/small-diffs.md'; // the oldest: the winner of a merge
const B = 'brain/memory/feedback/small-prs.md';
const C = 'brain/memory/projects/release-1-0.md';
const D = 'brain/memory/reference/ports.md';
const TEXT = {
  [A]: '---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-09-01\nupdated: 2026-09-01\ndescription: Keep each diff small\nsource: auto-wrap\nreviewed: true\npin: true\n---\n\n# Small diffs\n\nKeep each diff small enough to review in one sitting.\n',
  [B]: '---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-09-20\nupdated: 2026-09-20\ndescription: One change per PR\nsource: auto-wrap\nreviewed: false\n---\n\n# Small PRs\n\nOne change per pull request; split the rest.\n',
  [C]: '---\ntype: memory\ntags: [memory/projects, status/active]\ncreated: 2026-10-01\nupdated: 2026-10-01\ndescription: Shipped 1.0\nreviewed: true\n---\n\n# Release 1.0\n\nShipped on the first.\n',
  [D]: '---\ntype: memory\ntags: [memory/reference, status/active]\ncreated: 2026-10-05\nupdated: 2026-10-05\ndescription: Ports in use\nreviewed: true\n---\n\n# Ports\n\nThe app listens on 4242.\n',
};
const INDEX = `# Index\n\n## Feedback\n- [Small diffs](${A}) — Keep each diff small\n- [Small PRs](${B}) — One change per PR\n\n## Project\n- [Release 1.0](${C}) — Shipped 1.0\n\n## Reference\n- [Ports](${D}) — Ports in use\n`;
const CODEX_ONLY = { hosts: { claude: { enabled: false }, codex: { enabled: true } } };

const abs = (rel) => path.join(VAULT, ...rel.split('/'));
const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const exists = (rel) => fs.existsSync(abs(rel));
const trail = () => { try { return read('brain/_index/promote-log.jsonl').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const spendRows = () => { try { return fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** The vault's config (brain/config.json) and the user's (agenticos.json), as provider.js reads them. */
function setConfig(vaultCfg = {}, userCfg = {}) {
  fs.writeFileSync(abs('brain/config.json'), JSON.stringify(vaultCfg));
  fs.writeFileSync(USER_CFG, JSON.stringify({ vault: VAULT, ...userCfg }));
}

let io = null;
let scripts = [];
beforeEach(() => {
  for (const rel of ['brain/memory', 'brain/_index']) fs.rmSync(abs(rel), { recursive: true, force: true });
  fs.mkdirSync(abs('brain/_index'), { recursive: true });
  for (const [rel, text] of Object.entries(TEXT)) { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text); }
  fs.writeFileSync(abs('MEMORY.md'), INDEX);
  try { fs.unlinkSync(path.join(process.env.CODEX_HOME, 'config.toml')); } catch { /* none */ }
  setConfig();
  P.resetProviderCache();
  ollama.chat = never('ollama chat');
  io = { lines: [], log(m) { this.lines.push(String(m)); }, warn(m) { this.lines.push(`warning: ${m}`); } };
  scripts = [];
});
const realOllamaChat = ollama.chat;
afterEach(() => { ollama.chat = realOllamaChat; });

/** cli/memory.js main, in process: build-brain-md is a stand-in (its own process for real), the host seams are `deps`. */
const opts = (deps) => ({
  configDir: CFG_DIR, home: HOME, vault: VAULT, io, providerDeps: deps,
  runScript: (name, args) => { scripts.push([name, ...args]); return { ok: true }; },
});
/** One verb with --json: exit 0 and the one object it prints. */
async function json(args, deps) {
  const start = io.lines.length;
  assert.equal(await M.main([...args, '--json'], opts(deps)), 0, args.join(' '));
  return JSON.parse(io.lines.slice(start).join('\n'));
}
/** A usage error (exit 2), refused before anything is read or called. */
const usage = (args, re) => assert.rejects(M.main(args, opts(nobody)), (e) => e instanceof M.UsageError && re.test(e.message), args.join(' '));
/** A refusal (`aos: <message>`, exit 1): any error but a usage error. */
const refusal = (args, deps, re) => assert.rejects(M.main(args, opts(deps)), (e) => !(e instanceof M.UsageError) && re.test(e.message), args.join(' '));

// ── the hosts, each faked at its own seam ──

function never(what) { return async () => { throw new Error(`${what} must not be called`); }; }
const MERGED = { title: 'Small diffs and PRs', description: 'Keep each diff and each PR small', body: 'Keep each diff small enough to review in one sitting.\n\nOne change per pull request; split the rest.' };

/** `claude -p` at the claudeCall seam: records its options and bills the ledger as the real one does. */
function fakeClaude(calls, reply, usd = 0.0042) {
  return async (o) => {
    calls.push(o);
    recordSpend({ feature: o.feature, provider: 'claude', model: o.model, usd, inputTokens: 1200, outputTokens: 300, ms: 5 });
    const r = typeof reply === 'function' ? reply(o) : reply;
    return { text: JSON.stringify(r), structured: r, usd, usage: { input_tokens: 1200, output_tokens: 300 }, ms: 5 };
  };
}
/** `codex exec` at the spawn seam (codex-cli.js runs for real): records argv, the cwd and what it held, the schema, stdin. */
function fakeCodexSpawn(calls, reply) {
  return (bin, args, o) => {
    const si = args.indexOf('--output-schema');
    const rec = { args, cwd: o.cwd, cwdEntries: fs.readdirSync(o.cwd), schema: si === -1 ? null : JSON.parse(fs.readFileSync(args[si + 1], 'utf8')), stdin: '' };
    calls.push(rec);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (c) => { rec.stdin += c; });
    child.kill = () => {};
    const events = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: JSON.stringify(reply) } },
      { type: 'turn.completed', usage: { input_tokens: 3000, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0 } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    setImmediate(() => { child.stdout.end(events); child.stderr.end(''); setImmediate(() => child.emit('close', 0)); });
    return child;
  };
}
const nobody = {
  ping: never('ping'), resolveClaudeBin: never('claude bin'), loginProbe: never('claude login'), claudeCall: never('claude'),
  resolveCodexBin: never('codex bin'), codexLoginProbe: never('codex login'), codexCall: never('codex'),
};
/** Claude signed in, Ollama down, Codex never asked. */
const claudeDeps = (calls, reply, extra = {}) => ({
  ...nobody, ping: async () => false, resolveClaudeBin: () => '/fake/bin/claude', loginProbe: async () => true, claudeCall: fakeClaude(calls, reply), ...extra,
});
/** No claude at all, Codex signed in and run for real against a fake spawn. */
const codexDeps = (spawns, reply, extra = {}) => ({
  ...nobody, ping: async () => false, resolveClaudeBin: () => null, resolveCodexBin: () => '/fake/bin/codex', codexLoginProbe: async () => true,
  codexCall: (o) => codexCli.codexCall({ ...o, bin: '/fake/bin/codex', spawnFn: fakeCodexSpawn(spawns, reply) }), ...extra,
});
/** Only Ollama: up, and Claude has no binary. */
const ollamaDeps = { ...nobody, ping: async () => true, resolveClaudeBin: () => null };

/** The temp cwd a Codex call ran in: empty when codex started, in the OS temp folder, never the vault, gone after. */
function assertCodexCwd(s) {
  assert.deepEqual(s.cwdEntries, []);
  assert.ok(path.resolve(s.cwd).startsWith(fs.realpathSync(os.tmpdir())) || path.resolve(s.cwd).startsWith(path.resolve(os.tmpdir())), s.cwd);
  assert.ok(!path.resolve(s.cwd).startsWith(VAULT));
  assert.equal(fs.existsSync(s.cwd), false);
}

const ESTIMATE_KEYS = ['available', 'cap', 'model', 'provider', 'reason', 'tokensIn', 'tokensOut', 'usd'];
const DRAFT_KEYS = ['baseHashes', 'cap', 'estimated', 'fields', 'generatedAt', 'mode', 'model', 'provider', 'reason', 'sources', 'truncated', 'type', 'usd', 'winner'];
const keys = (o) => Object.keys(o).sort();
const untouched = () => {
  for (const [rel, text] of Object.entries(TEXT)) assert.equal(read(rel), text, `${rel} unchanged`);
  assert.equal(read('MEMORY.md'), INDEX, 'MEMORY.md unchanged');
};

// ── merge-draft ──

test('merge-draft --estimate on Claude: the Mechanics\' shape, the oldest as winner, haiku priced under the hook cap; no call, nothing written', async () => {
  const calls = [];
  // An estimate never pays for Claude's login probe (a real `claude -p` call), and records no provider state.
  try { fs.unlinkSync(P.STATE_PATH); } catch { /* none */ }
  const e = await json(['merge-draft', B, A, '--estimate'], claudeDeps(calls, MERGED, { loginProbe: never('claude login') }));
  assert.equal(fs.existsSync(P.STATE_PATH), false, 'no provider-state.json');
  assert.deepEqual(keys(e), ['baseHashes', 'byHand', 'estimate', 'sources', 'truncated', 'type', 'winner']);
  assert.deepEqual([e.winner, e.type, e.truncated], [A, 'feedback', false]);
  assert.deepEqual(e.sources.map((s) => keys(s)), [0, 1].map(() => ['chars', 'created', 'hash', 'path', 'title', 'truncated', 'type']));
  assert.deepEqual(e.sources.map((s) => [s.path, s.title, s.type, s.created, s.hash, s.truncated]), [
    [B, 'Small PRs', 'feedback', '2026-09-20', sha(TEXT[B]), false], [A, 'Small diffs', 'feedback', '2026-09-01', sha(TEXT[A]), false],
  ], 'in the order given (merge --expect\'s order)');
  assert.deepEqual(e.baseHashes, [sha(TEXT[B]), sha(TEXT[A])]);
  assert.deepEqual(e.byHand, {
    title: 'Small diffs', description: 'Keep each diff small',
    body: 'Keep each diff small enough to review in one sitting.\n\n## From Small PRs\n\nOne change per pull request; split the rest.',
  });
  const est = e.estimate;
  assert.deepEqual(keys(est), ESTIMATE_KEYS);
  assert.deepEqual([est.available, est.reason, est.provider, est.model], [true, null, 'claude', 'haiku']);
  assert.ok(est.tokensIn > 600 && est.tokensOut > 0 && est.tokensOut <= 2000, JSON.stringify(est));
  assert.equal(est.usd, modelPricing.priceUsd('claude', 'haiku', { inputTokens: est.tokensIn, cachedInputTokens: 0, outputTokens: est.tokensOut }));
  assert.deepEqual(est.cap, { family: 'hook', perDayUsd: 0.5, spentToday: 0, perCallUsd: 0.05 });
  assert.deepEqual(calls, [], 'no model call');
  assert.deepEqual(spendRows(), []);
  untouched();
});

test('merge-draft on Claude, then merge with its fields and hashes, then unmerge: the files, MEMORY.md, the trail, the record', async () => {
  const calls = [];
  const d = await json(['merge-draft', A, B], claudeDeps(calls, MERGED));
  assert.deepEqual(keys(d), DRAFT_KEYS);
  assert.deepEqual([d.mode, d.reason, d.provider, d.model, d.usd, d.estimated], ['ai', null, 'claude', 'haiku', 0.0042, false]);
  assert.deepEqual(d.cap, { family: 'hook', perDayUsd: 0.5, spentToday: 0.0042, perCallUsd: 0.05 }, 'the cap re-read after the call');
  assert.deepEqual(d.fields, MERGED);
  assert.ok(!Number.isNaN(Date.parse(d.generatedAt)));
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].feature, calls[0].model, calls[0].maxBudgetUsd, calls[0].effort, calls[0].timeoutMs], ['memory-merge', 'haiku', 0.05, undefined, 90_000]);
  assert.deepEqual(calls[0].schema, mergeLib.MERGE_SCHEMA);
  assert.match(calls[0].prompt, /^=== brain\/memory\/feedback\/small-diffs\.md \(feedback, created 2026-09-01\) ===$/m);
  assert.deepEqual(spendRows().map((r) => [r.feature, r.provider]), [['memory-merge', 'claude']], 'the one ledger row is the call\'s');
  untouched();

  // Save: --into the draft's fields, --expect its baseHashes in path order.
  const m = await json(['merge', A, B, '--into', JSON.stringify(d.fields), '--expect', d.baseHashes.join(',')]);
  assert.deepEqual(keys(m), ['brainMd', 'hash', 'path', 'record', 'superseded']);
  assert.deepEqual([m.path, m.superseded, m.brainMd], [A, [B], { ok: true }]);
  assert.match(m.record, /^\d{8}-\d{6}-[0-9a-f]{8}$/);
  const won = read(A);
  assert.equal(m.hash, sha(won));
  assert.match(won, /^description: Keep each diff and each PR small$/m);
  assert.match(won, /^reviewed: true$/m);
  assert.match(won, /^pin: true$/m);
  assert.ok(won.endsWith(`\n# ${MERGED.title}\n\n${MERGED.body}\n`), won);
  assert.match(read(B), /^superseded_by: brain\/memory\/feedback\/small-diffs\.md$/m);
  assert.match(read(B), /status\/superseded/);
  const idx = read('MEMORY.md');
  assert.ok(idx.includes(`- [${MERGED.title}](${A}) — ${MERGED.description}\n`), idx);
  assert.ok(!idx.includes(B), 'the loser\'s line is gone');
  const rec = JSON.parse(read(`brain/_index/memory-merges/${m.record}.json`));
  assert.deepEqual([rec.winner, rec.before.text, rec.after.hash, rec.sources, rec.undoneAt], [A, TEXT[A], m.hash, [
    { path: A, hash: sha(TEXT[A]) }, { path: B, hash: sha(TEXT[B]), before: { text: TEXT[B], hash: sha(TEXT[B]) }, after: { hash: sha(read(B)) } },
  ], null]);
  assert.deepEqual(rec.index, { before: { text: INDEX, hash: sha(INDEX) }, after: { hash: sha(read('MEMORY.md')) } });
  const rows = trail();
  assert.deepEqual(rows.map((r) => [r.action, r.path]), [['merged', A], ['superseded', B]]);
  assert.deepEqual([rows[0].from, rows[0].record, rows[0].hash], [[B], m.record, m.hash]);
  assert.deepEqual([rows[1].by, rows[1].record], [A, m.record]);
  assert.deepEqual(scripts, [['build-brain-md.js']], 'BRAIN.md rebuilt once');

  // Undo: pinned to the merged memory's hash; everything back byte for byte.
  const u = await json(['unmerge', A, '--expect', m.hash]);
  assert.deepEqual(keys(u), ['brainMd', 'hash', 'indexExactly', 'path', 'record', 'restored', 'restoredExactly']);
  assert.deepEqual([u.path, u.restored, u.restoredExactly, u.indexExactly, u.record, u.hash, u.brainMd], [A, [B], [B], true, m.record, sha(TEXT[A]), { ok: true }]);
  assert.equal(read(A), TEXT[A]);
  assert.equal(read(B), TEXT[B], 'the other one byte for byte too');
  assert.equal(read('MEMORY.md'), INDEX, 'MEMORY.md as it was');
  assert.ok(JSON.parse(read(`brain/_index/memory-merges/${m.record}.json`)).undoneAt);
  assert.deepEqual(trail().slice(2).map((r) => [r.action, r.path]), [['unmerged', A], ['restored', B]]);
  // Nothing left to undo.
  await refusal(['unmerge', A, '--expect', sha(TEXT[A]), '--json'], nobody, /no merge to undo/);
});

test('merge refuses a source changed since the draft (CHANGED, nothing written); unmerge refuses after an edit', async () => {
  const e = await json(['merge-draft', A, B, '--estimate'], claudeDeps([], MERGED));
  fs.appendFileSync(abs(B), '\nEdited.\n');
  const edited = read(B);
  await refusal(['merge', A, B, '--into', JSON.stringify(MERGED), '--expect', e.baseHashes.join(','), '--json'], nobody, /small-prs\.md changed since it was read: open the merge again/);
  assert.equal(read(A), TEXT[A]);
  assert.equal(read(B), edited);
  assert.equal(read('MEMORY.md'), INDEX);
  assert.ok(!exists('brain/_index/memory-merges'), 'no record either');

  const m = await json(['merge', A, B, '--into', JSON.stringify(MERGED), '--expect', `${sha(TEXT[A])},${sha(edited)}`]);
  fs.appendFileSync(abs(A), '\nLater.\n');
  await refusal(['unmerge', A, '--expect', m.hash, '--json'], nobody, /changed since the merge: undo it by hand/);
  await refusal(['unmerge', A, '--expect', sha(read(A)), '--json'], nobody, /changed since the merge/);
  // --into is held to the reply's rules, refusing rather than cutting (BAD_FIELD, exit 1).
  fs.writeFileSync(abs(A), TEXT[A]);
  for (const into of [{ ...MERGED, title: 't'.repeat(121) }, { ...MERGED, description: '' }, { ...MERGED, body: '---\n' }, { ...MERGED, extra: 'x' }]) {
    await refusal(['merge', A, C, '--into', JSON.stringify(into), '--expect', `${sha(TEXT[A])},${sha(TEXT[C])}`, '--json'], nobody, /title|description|body|cannot hold/);
  }
});

test('merge-draft on Codex: codex exec in an empty temp folder on codex.model at codex.effort, the strict schema; priced tokens, estimated', async () => {
  setConfig({ codex: { model: 'gpt-5-mini' } }, CODEX_ONLY);
  const spawns = [];
  const e = await json(['merge-draft', A, B, '--estimate'], codexDeps(spawns, MERGED));
  assert.deepEqual([e.estimate.available, e.estimate.provider, e.estimate.model], [true, 'codex', 'gpt-5-mini']);
  assert.equal(e.estimate.usd, codexPricing.priceUsd('gpt-5-mini', { inputTokens: e.estimate.tokensIn, cachedInputTokens: 0, outputTokens: e.estimate.tokensOut }));
  assert.deepEqual(e.estimate.cap, { family: 'codex', perDayUsd: 0.5, spentToday: 0, perCallUsd: null }, 'no per-call cap under Codex');
  assert.deepEqual(spawns, []);

  const d = await json(['merge-draft', A, B], codexDeps(spawns, MERGED));
  assert.equal(spawns.length, 1);
  const s = spawns[0];
  assertCodexCwd(s);
  assert.ok(s.args.includes('read-only'));
  assert.deepEqual(s.args.slice(s.args.indexOf('-m'), s.args.indexOf('-m') + 2), ['-m', 'gpt-5-mini']);
  assert.ok(s.args.includes('model_reasoning_effort="low"'));
  assert.deepEqual(s.schema, codexCli.strictSchema(mergeLib.MERGE_SCHEMA));
  const usd = codexPricing.priceUsd('gpt-5-mini', { inputTokens: 3000, cachedInputTokens: 0, outputTokens: 200 });
  assert.deepEqual([d.mode, d.provider, d.model, d.usd, d.estimated, d.fields], ['ai', 'codex', 'gpt-5-mini', usd, true, MERGED]);
  assert.deepEqual(d.cap, { family: 'codex', perDayUsd: 0.5, spentToday: usd, perCallUsd: null });
  assert.deepEqual(spendRows().map((r) => [r.feature, r.provider, r.model]), [['memory-merge', 'codex', 'gpt-5-mini']]);
  untouched();
});

test('merge-draft on Ollama: the workhorse model, the schema as its format, $0 and no cap', async () => {
  const chats = [];
  ollama.chat = async (o) => { chats.push(o); return JSON.stringify(MERGED); };
  const e = await json(['merge-draft', A, B, '--estimate'], ollamaDeps);
  assert.deepEqual([e.estimate.available, e.estimate.provider, e.estimate.model, e.estimate.usd, e.estimate.cap], [true, 'ollama', role('workhorse').tag, 0, null]);
  assert.deepEqual(chats, []);
  const d = await json(['merge-draft', A, B], ollamaDeps);
  assert.equal(chats.length, 1);
  assert.deepEqual([chats[0].feature, chats[0].numPredict, chats[0].timeoutMs], ['memory-merge', 2000, 90_000]);
  assert.deepEqual(chats[0].format, mergeLib.MERGE_SCHEMA);
  assert.deepEqual([d.mode, d.provider, d.model, d.usd, d.estimated, d.cap, d.fields], ['ai', 'ollama', role('workhorse').tag, 0, false, null, MERGED]);
  assert.deepEqual(spendRows(), []);
});

test('merge-draft with provider none: the estimate is off (forced) and the draft is by hand with the reason; no probe, no call', async () => {
  setConfig({ provider: 'none' });
  const e = await json(['merge-draft', A, B, '--estimate'], nobody);
  assert.deepEqual(e.estimate, { available: false, reason: 'forced', provider: 'none', model: null, tokensIn: e.estimate.tokensIn, tokensOut: e.estimate.tokensOut, usd: 0, cap: null });
  // In a terminal (no --json) it says why in the page's words.
  const start = io.lines.length;
  assert.equal(await M.main(['merge-draft', A, B, '--estimate'], opts(nobody)), 0);
  assert.deepEqual(io.lines.slice(start), [`merge into ${A} (feedback)`, '  no model call possible: No model provider is set up.']);
  const d = await json(['merge-draft', A, B], nobody);
  assert.deepEqual(keys(d), DRAFT_KEYS);
  assert.deepEqual([d.mode, d.reason, d.provider, d.model, d.usd, d.estimated, d.cap], ['by-hand', 'No model provider is set up.', 'none', null, 0, false, null]);
  assert.deepEqual(d.fields, e.byHand, 'fields = byHand (A4)');
  assert.deepEqual(spendRows(), []);
  untouched();
  // The by-hand draft saves through the same merge.
  const m = await json(['merge', A, B, '--into', JSON.stringify(d.fields), '--expect', d.baseHashes.join(',')]);
  assert.equal(m.path, A);
  assert.match(read(A), /## From Small PRs/);
});

test('merge-draft with the hook cap reached: off at resolve, and by hand mid-call; the sentence names the cap', async () => {
  const sentence = "Today's model cap is reached ($0.50, claude.perDayUsd).";
  const e = await json(['merge-draft', A, B, '--estimate'], claudeDeps([], MERGED, { claudeCall: never('claude'), spendToday: () => 0.5 }));
  assert.deepEqual([e.estimate.available, e.estimate.reason, e.estimate.provider], [false, 'daily-cap', 'none']);
  assert.deepEqual(e.estimate.cap, { family: 'hook', perDayUsd: 0.5, spentToday: 0.5, perCallUsd: 0.05 });
  P.resetProviderCache();
  const atResolve = await json(['merge-draft', A, B], claudeDeps([], MERGED, { claudeCall: never('claude'), spendToday: () => 0.5 }));
  assert.deepEqual([atResolve.mode, atResolve.reason, atResolve.provider], ['by-hand', sentence, 'none']);
  // The day's spend crosses the cap between the resolve and the call: provider.js refuses before spawning.
  let n = 0;
  const mid = await json(['merge-draft', A, B], claudeDeps([], MERGED, { claudeCall: never('claude'), spendToday: () => (n++ ? 0.6 : 0) }));
  assert.deepEqual([mid.mode, mid.reason, mid.provider, mid.usd], ['by-hand', sentence, 'claude', 0]);
  assert.deepEqual([mid.cap.family, mid.cap.perDayUsd], ['hook', 0.5]);
  assert.deepEqual(mid.fields, e.byHand);
  assert.deepEqual(spendRows(), []);
  untouched();
});

test('merge-draft with an unreadable reply: by hand, but the call\'s provider, model and cost stay on the answer', async () => {
  const calls = [];
  const d = await json(['merge-draft', A, B], claudeDeps(calls, { title: '', description: 'x', body: '' }));
  assert.deepEqual([d.mode, d.reason, d.provider, d.model, d.usd], ['by-hand', "The model's reply could not be read.", 'claude', 'haiku', 0.0042]);
  assert.equal(calls.length, 1);
  untouched();
});

// ── sweep ──

const SWEPT = {
  suggestions: [
    { kind: 'merge', paths: [A, B], title: 'Small changes', description: '', why: 'Both say keep changes small.' },
    { kind: 'archive', paths: [C], title: '', description: '', why: 'Shipped and done.' },
    { kind: 'retitle', paths: [D], title: 'Ports the app uses', description: 'The app listens on 4242', why: 'The title says more.' },
  ],
};
const cardIds = (r) => r.suggestions.map((c) => [c.kind, c.paths]);

test('sweep --estimate and a real run on Claude: claude.model with no --effort under the reasoner cap; the cards stored; dismiss is for good', async () => {
  const calls = [];
  const e = await json(['sweep', '--estimate'], claudeDeps(calls, SWEPT, { loginProbe: never('claude login') }));
  assert.deepEqual(keys(e), ['considered', 'estimate', 'of', 'scope']);
  assert.deepEqual([e.scope, e.considered, e.of], [null, 4, 4]);
  assert.deepEqual(keys(e.estimate), ESTIMATE_KEYS);
  assert.deepEqual([e.estimate.available, e.estimate.provider, e.estimate.model, e.estimate.tokensOut], [true, 'claude', 'haiku', 1600]);
  assert.equal(e.estimate.usd, modelPricing.priceUsd('claude', 'haiku', { inputTokens: e.estimate.tokensIn, cachedInputTokens: 0, outputTokens: 1600 }));
  assert.deepEqual(e.estimate.cap, { family: 'reasoner', perDayUsd: 5, spentToday: 0, perCallUsd: 0.5 });
  assert.deepEqual(calls, []);
  assert.ok(!exists(sweepLib.SWEEP_PATH), 'an estimate writes nothing');

  const r = await json(['sweep'], claudeDeps(calls, SWEPT));
  assert.deepEqual(keys(r), ['run', 'suggestions']);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].feature, calls[0].model, calls[0].effort, calls[0].maxBudgetUsd, calls[0].timeoutMs], ['reason:memory-sweep', 'haiku', undefined, 0.5, 120_000]);
  assert.deepEqual(calls[0].schema, sweepLib.SCHEMA);
  assert.match(calls[0].system, /At most 20 cards/);
  assert.deepEqual(keys(r.run), ['at', 'considered', 'estimated', 'id', 'model', 'of', 'provider', 'scope', 'suggestions', 'usd']);
  assert.deepEqual([r.run.scope, r.run.provider, r.run.model, r.run.usd, r.run.estimated, r.run.considered, r.run.of, r.run.suggestions], [null, 'claude', 'haiku', 0.0042, false, 4, 4, 3]);
  assert.deepEqual(cardIds(r), [['merge', [A, B]], ['archive', [C]], ['retitle', [D]]]);
  for (const c of r.suggestions) {
    assert.deepEqual(keys(c), ['description', 'hashes', 'id', 'kind', 'paths', 'run', 'scope', 'state', 'title', 'why']);
    assert.deepEqual([c.id, c.run, c.scope, c.state], [sweepLib.cardId(c.kind, c.paths), r.run.id, null, 'open']);
    assert.deepEqual(c.hashes, c.paths.map((p) => sha(TEXT[p])));
  }
  const file = JSON.parse(read(sweepLib.SWEEP_PATH));
  assert.deepEqual([file.schema, file.runs, file.suggestions], [1, [r.run], r.suggestions]);
  assert.deepEqual(spendRows().map((x) => [x.feature, x.provider]), [['reason:memory-sweep', 'claude']]);
  untouched();

  // Dismiss: for good, said when it already was, and never suggested again.
  const id = r.suggestions[1].id;
  assert.deepEqual(await json(['sweep', 'dismiss', id]), { dismissed: id, already: false });
  assert.deepEqual(await json(['sweep', 'dismiss', id]), { dismissed: id, already: true });
  await refusal(['sweep', 'dismiss', '0123456789ab', '--json'], nobody, /no sweep card 0123456789ab/);
  const again = await json(['sweep'], claudeDeps(calls, SWEPT));
  assert.deepEqual(cardIds(again), [['merge', [A, B]], ['retitle', [D]]], 'the dismissed archive card is not re-suggested');
  const after = JSON.parse(read(sweepLib.SWEEP_PATH));
  assert.deepEqual(after.runs.map((x) => x.id), [again.run.id, r.run.id]);
  assert.deepEqual(after.suggestions.filter((c) => c.state === 'dismissed').map((c) => c.id), [id]);
  assert.equal(after.suggestions.length, 3, 'the open cards of the scope were replaced, the dismissed one kept');
});

test('a scoped sweep sends only its paths (lead first), asks for at most 10 cards and keys its cards by scope', async () => {
  const calls = [];
  const e = await json(['sweep', B, A, '--estimate'], claudeDeps(calls, SWEPT));
  assert.deepEqual([e.scope, e.considered, e.of, e.estimate.tokensOut], [{ paths: [B, A] }, 2, 2, 800]);
  const r = await json(['sweep', B, A], claudeDeps(calls, SWEPT));
  assert.match(calls[0].system, /At most 10 cards/);
  assert.ok(calls[0].prompt.includes(A) && calls[0].prompt.includes(B) && !calls[0].prompt.includes(C) && !calls[0].prompt.includes(D));
  const key = sha([A, B].sort().join('\n')).slice(0, 12);
  assert.deepEqual([r.run.scope, r.run.considered, r.run.of], [{ paths: [B, A] }, 2, 2]);
  assert.deepEqual(r.suggestions.map((c) => [c.kind, c.paths, c.scope]), [['merge', [A, B], key]], 'the cards over paths it did not send are dropped');
  assert.equal(sweepLib.scopeKey([B, A]), key);
  // A path twice, or one past 50: a usage error before any call.
  await usage(['sweep', A, A, '--json'], /each memory once/);
  assert.equal(calls.length, 1);
});

test('the sweep on Codex: codex.model at codex.effort under the reasoner cap, in an empty temp folder; estimated', async () => {
  setConfig({ codex: { model: 'gpt-5-mini', effort: 'minimal' }, reasoner: { codexModel: 'gpt-5', effort: 'high' } }, CODEX_ONLY);
  const spawns = [];
  const e = await json(['sweep', '--estimate'], codexDeps(spawns, SWEPT));
  assert.deepEqual([e.estimate.provider, e.estimate.model], ['codex', 'gpt-5-mini']);
  assert.deepEqual(e.estimate.cap, { family: 'reasoner-codex', perDayUsd: 5, spentToday: 0, perCallUsd: null });
  const r = await json(['sweep'], codexDeps(spawns, SWEPT));
  assert.equal(spawns.length, 1);
  assertCodexCwd(spawns[0]);
  assert.deepEqual(spawns[0].args.slice(spawns[0].args.indexOf('-m'), spawns[0].args.indexOf('-m') + 2), ['-m', 'gpt-5-mini']);
  assert.ok(spawns[0].args.includes('model_reasoning_effort="minimal"'), 'codex.effort, never reasoner.effort');
  assert.deepEqual(spawns[0].schema, codexCli.strictSchema(sweepLib.SCHEMA));
  const usd = codexPricing.priceUsd('gpt-5-mini', { inputTokens: 3000, cachedInputTokens: 0, outputTokens: 200 });
  assert.deepEqual([r.run.provider, r.run.model, r.run.usd, r.run.estimated, r.run.suggestions], ['codex', 'gpt-5-mini', usd, true, 3]);
  assert.deepEqual(spendRows().map((x) => [x.feature, x.provider]), [['reason:memory-sweep', 'codex']]);
});

test('the sweep off: Ollama only, provider none and the reasoner cap; --estimate says why, a real run refuses (exit 1) and writes nothing', async () => {
  const off = async (deps, reason, sentence) => {
    P.resetProviderCache();
    try { fs.unlinkSync(P.STATE_PATH); } catch { /* none */ }
    const e = await json(['sweep', '--estimate'], deps);
    assert.deepEqual([e.estimate.available, e.estimate.reason, e.estimate.provider, e.estimate.usd], [false, reason, 'none', 0], reason);
    assert.equal(await M.main(['sweep', '--estimate'], opts(deps)), 0);
    assert.equal(io.lines[io.lines.length - 1], `  no model call possible: ${sentence}`, `${reason}: the terminal says why`);
    await refusal(['sweep', '--json'], deps, new RegExp(`^the sweep needs Claude or Codex \\(${sentence.replace(/[.$()]/g, '\\$&')}\\)$`));
    assert.ok(!exists(sweepLib.SWEEP_PATH), `${reason}: nothing written`);
    return e;
  };
  await off(ollamaDeps, 'ollama-only', 'Only Ollama is available, and a local model cannot hold the whole brain.');
  const capped = await off(claudeDeps([], SWEPT, { claudeCall: never('claude'), reasonSpendToday: () => 5 }), 'reasoner-daily-cap', "Today's model cap is reached ($5.00, reasoner.perDayUsd).");
  assert.deepEqual(capped.estimate.cap, { family: 'reasoner', perDayUsd: 5, spentToday: 5, perCallUsd: 0.5 });
  setConfig({ provider: 'none' });
  await off(nobody, 'forced', 'No model provider is set up.');
  // The merge still runs on Ollama (A7).
  setConfig();
  P.resetProviderCache();
  ollama.chat = async () => JSON.stringify(MERGED);
  assert.equal((await json(['merge-draft', A, B], ollamaDeps)).mode, 'ai');
  assert.deepEqual(spendRows(), []);
  untouched();
});

// ── the argument rules (exit 2) ──

test('argument errors are usage errors (exit 2), refused before anything is read or a model asked', async () => {
  const h = sha(TEXT[A]);
  const into = JSON.stringify(MERGED);
  const seven = Array.from({ length: 7 }, (_, i) => `brain/memory/reference/n-${i}.md`);
  await usage(['merge-draft', A, '--json'], /merge-draft <path> <path>/);
  await usage(['merge-draft', ...seven, '--json'], /too many arguments/);
  await usage(['merge', ...seven, '--into', into, '--expect', seven.map(() => h).join(','), '--json'], /too many arguments/);
  await usage(['merge-draft', A, A, '--json'], /each memory once/);
  await usage(['merge', A, A, '--into', into, '--expect', `${h},${h}`, '--json'], /each memory once/);
  await usage(['merge', A, B, '--into', into, '--expect', h, '--json'], /--expect takes one hash per path/);
  await usage(['merge', A, B, '--into', into, '--expect', `${h},${h},${h}`, '--json'], /--expect takes one hash per path/);
  await usage(['merge', A, B, '--into', into, '--expect', `${h},nothex`, '--json'], /--expect takes one hash per path/);
  await usage(['merge', A, B, '--into', 'not json', '--expect', `${h},${h}`, '--json'], /--into takes a JSON object/);
  await usage(['merge', A, B, '--expect', `${h},${h}`, '--json'], /aos memory merge <path>/);
  await usage(['merge', A, B, '--into', into, '--expect', `${h},${h}`, '--estimate', '--json'], /--estimate is not one of its flags/);
  await usage(['unmerge', A, '--expect', 'nothex', '--json'], /--expect takes the merged memory's hash/);
  await usage(['unmerge', A, B, '--expect', h, '--json'], /too many arguments/);
  await usage(['sweep', 'dismiss', 'xyz', '--json'], /the id a sweep printed/);
  await usage(['sweep', 'dismiss', '0123456789AB', '--json'], /the id a sweep printed/);
  await usage(['sweep', 'dismiss', '0123456789ab', '--estimate', '--json'], /--estimate is not a flag of sweep dismiss/);
  await usage(['sweep', ...Array.from({ length: 51 }, (_, i) => `brain/memory/reference/n-${i}.md`), '--json'], /too many arguments/);
  await usage(['merge-draft', A, 'brain/memory/feedback/README.md', '--json'], /./);
  untouched();
  assert.deepEqual(spendRows(), []);
});

test('through cli/aos.js: --into and --estimate are forwarded; a refusal is `aos: …` exit 1, a usage error exit 2 (provider none)', () => {
  setConfig({ provider: 'none' });
  const env = { ...process.env, AOS_VAULT: VAULT, AOS_CONFIG: USER_CFG };
  const aos = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'aos.js'), 'memory', ...a], { env, encoding: 'utf8' });
  const est = aos('merge-draft', A, B, '--estimate', '--json');
  assert.equal(est.status, 0, est.stderr);
  const e = JSON.parse(est.stdout);
  assert.deepEqual([e.winner, e.estimate.available, e.estimate.reason], [A, false, 'forced']);
  const d = aos('merge-draft', A, B, '--json');
  assert.equal(d.status, 0, d.stderr);
  assert.equal(JSON.parse(d.stdout).mode, 'by-hand');
  const sw = aos('sweep', '--json');
  assert.equal(sw.status, 1);
  assert.match(sw.stderr, /^aos: the sweep needs Claude or Codex \(No model provider is set up\.\)$/m);
  const one = aos('merge-draft', A, '--json');
  assert.equal(one.status, 2, one.stderr);
  const m = aos('merge', A, B, '--into', JSON.stringify(e.byHand), '--expect', e.baseHashes.join(','), '--json');
  assert.equal(m.status, 0, m.stderr);
  const merged = JSON.parse(m.stdout);
  assert.deepEqual([merged.path, merged.superseded], [A, [B]]);
  const u = aos('unmerge', A, '--expect', merged.hash, '--json');
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual(JSON.parse(u.stdout).restored, [B]);
  assert.equal(read(A), TEXT[A]);
});
