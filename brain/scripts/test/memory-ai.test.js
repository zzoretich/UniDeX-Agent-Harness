'use strict';
// lib/memory-ai.js (brain-ai A5–A7, A12): the merge's hook chain and the sweep's reasoner on the background models, one
// fake per host (Claude at the claudeCall seam billing a ledger row as the real one does; Codex through the real
// codexCall with a fake spawn; Ollama with its chat stubbed), provider none, a cap at resolve and mid-call, the
// estimate per host, the labels and the sentences. No network and no model: every CLI is a fake and every ping is too.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-memory-ai-test-')));
const VAULT = path.join(TMP, 'vault');
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = VAULT;
process.env.AOS_CONFIG = path.join(TMP, 'agenticos.json');
process.env.CODEX_HOME = path.join(TMP, 'codex-home');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const AI = require('../lib/memory-ai.js');
const P = require('../sdk/lib/provider.js');
const { recordSpend, spendToday, reasonSpendToday, SPEND_PATH, ProviderUnavailable, HOOK_EXCLUDE, REASON_ROWS } = require('../sdk/lib/spend-ledger.js');
const codexCli = require('../sdk/lib/codex-cli.js');
const codexPricing = require('../sdk/lib/codex-pricing.js');
const ollama = require('../sdk/lib/ollama.js');
const { role } = require('../sdk/lib/models.js');

const CONFIG = path.join(VAULT, 'brain', 'config.json');
const CODEX_TOML = path.join(process.env.CODEX_HOME, 'config.toml');
const never = (what) => async () => { throw new Error(`${what} must not be called`); };
const REPLY = { title: 'Merged', description: 'One memory from two.', body: 'The merged body.' };
const SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['title', 'description', 'body'],
  properties: { title: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' } },
});
const CODEX_ONLY = { hosts: { claude: { enabled: false }, codex: { enabled: true } } };

function setConfig(vaultCfg = {}, userCfg = {}) {
  fs.writeFileSync(CONFIG, JSON.stringify(vaultCfg));
  fs.writeFileSync(process.env.AOS_CONFIG, JSON.stringify(userCfg));
}
const spendRows = () => { try { return fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const dropState = () => { try { fs.unlinkSync(P.STATE_PATH); } catch { /* none */ } };

/** A fake `claude -p` at the claudeCall seam: records its options and bills the ledger as the real one does. */
function fakeClaude(calls, reply = REPLY, usd = 0.0042) {
  return async (o) => {
    calls.push(o);
    recordSpend({ feature: o.feature, provider: 'claude', model: o.model, usd, inputTokens: 1200, outputTokens: 300, ms: 5 });
    return { text: JSON.stringify(reply), structured: reply, usd, usage: { input_tokens: 1200, output_tokens: 300 }, ms: 5 };
  };
}

/** A fake `codex exec` at the spawn seam (codex-cli.js runs for real): records argv, cwd, what the cwd held and stdin. */
function fakeCodexSpawn(calls, { reply = REPLY, code = 0, stderr = '', usage = { input_tokens: 3000, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0 } } = {}) {
  return (bin, args, opts) => {
    const si = args.indexOf('--output-schema');
    const rec = { bin, args, cwd: opts.cwd, cwdEntries: fs.readdirSync(opts.cwd), schema: si === -1 ? null : JSON.parse(fs.readFileSync(args[si + 1], 'utf8')), stdin: '' };
    calls.push(rec);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (c) => { rec.stdin += c; });
    child.kill = () => {};
    const events = (code === 0 ? [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: JSON.stringify(reply) } },
      { type: 'turn.completed', usage },
    ] : [{ type: 'thread.started', thread_id: 't1' }]).map((e) => JSON.stringify(e)).join('\n') + '\n';
    setImmediate(() => { child.stdout.end(events); child.stderr.end(stderr); setImmediate(() => child.emit('close', code)); });
    return child;
  };
}

/** Claude signed in, Ollama down, Codex never asked. */
const claudeDeps = (calls, extra = {}) => ({
  ping: async () => false, resolveClaudeBin: () => '/fake/bin/claude', loginProbe: async () => true, claudeCall: fakeClaude(calls),
  resolveCodexBin: never('codex bin'), codexLoginProbe: never('codex login'), codexCall: never('codex'), ...extra,
});
/** No claude at all, Codex signed in and run for real against a fake spawn. */
const codexDeps = (spawns, spawnOpts = {}, extra = {}) => ({
  ping: async () => false, resolveClaudeBin: () => null, loginProbe: never('claude login'), claudeCall: never('claude'),
  resolveCodexBin: () => '/fake/bin/codex', codexLoginProbe: async () => true,
  codexCall: (o) => codexCli.codexCall({ ...o, bin: '/fake/bin/codex', spawnFn: fakeCodexSpawn(spawns, spawnOpts) }),
  ...extra,
});
const nobody = {
  ping: never('ping'), resolveClaudeBin: never('claude bin'), loginProbe: never('claude login'), claudeCall: never('claude'),
  resolveCodexBin: never('codex bin'), codexLoginProbe: never('codex login'), codexCall: never('codex'),
};

/** The Codex temp cwd: empty when codex starts, in the OS temp folder, never the vault, gone afterwards. */
function assertCodexCwd(s) {
  assert.deepEqual(s.cwdEntries, [], 'the cwd is empty when codex starts');
  assert.ok(path.resolve(s.cwd).startsWith(path.resolve(os.tmpdir())), s.cwd);
  assert.ok(!path.resolve(s.cwd).startsWith(VAULT), 'never the vault');
  assert.equal(fs.existsSync(s.cwd), false, 'removed after the call');
}

const realOllamaChat = ollama.chat;
beforeEach(() => {
  P.resetProviderCache();
  for (const f of [P.STATE_PATH, SPEND_PATH, CODEX_TOML]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  setConfig();
  ollama.chat = never('ollama chat');
});
afterEach(() => { ollama.chat = realOllamaChat; });

test('the constants: a feature, an overhead, a timeout and an output cap per kind; the sweep is reasoner spend, the merge hook spend', async () => {
  assert.deepEqual(AI.KINDS, ['merge', 'sweep']);
  assert.deepEqual(AI.FEATURES, { merge: 'memory-merge', sweep: 'reason:memory-sweep' });
  assert.deepEqual(AI.OVERHEAD, { claude: 600, codex: 20_000, ollama: 0, none: 0 });
  assert.deepEqual(AI.TIMEOUT_MS, { merge: 90_000, sweep: 120_000 });
  assert.deepEqual(AI.NUM_PREDICT, { merge: 2_000, sweep: 3_000 });
  assert.ok(REASON_ROWS.test(AI.FEATURES.sweep) && HOOK_EXCLUDE.test(AI.FEATURES.sweep), 'the reasoner cap counts the sweep, the hook cap never does');
  assert.ok(!HOOK_EXCLUDE.test(AI.FEATURES.merge), 'the merge counts against the hook cap');
  for (const fn of [AI.resolve, AI.estimate, AI.call]) await assert.rejects(() => fn('chat', { deps: nobody }), TypeError);
  assert.throws(() => AI.capFor('chat', 'claude'), TypeError);
});

test('provider none: merge and sweep are off with reason forced; no probe, no call, nothing billed', async () => {
  setConfig({ provider: 'none' });
  for (const kind of ['merge', 'sweep']) {
    const est = await AI.estimate(kind, { chars: 4000, outTokens: 500, deps: nobody });
    assert.deepEqual(est, { available: false, reason: 'forced', provider: 'none', model: null, tokensIn: 1000, tokensOut: 500, usd: 0, cap: null }, kind);
    assert.equal(AI.reasonSentence(est), 'No model provider is set up.');
    const r = await AI.resolve(kind, { deps: nobody });
    assert.deepEqual([r.available, r.reason, r.provider, r.model], [false, 'forced', 'none', null]);
    await assert.rejects(() => AI.call(kind, { prompt: 'x', schema: SCHEMA, deps: nobody }), (e) => {
      assert.ok(e instanceof ProviderUnavailable);
      assert.deepEqual([e.code, e.provider, e.reason, e.message], ['PROVIDER_NONE', 'none', 'forced', 'no model provider (forced)']);
      assert.equal(AI.reasonSentence(e), 'No model provider is set up.');
      return true;
    });
  }
  assert.deepEqual(spendRows(), []);
});

test('merge on Claude: the hook chain on claude.model, the per-call cap, 90 s, the schema, no --effort; the real cost and the cap re-read after', async () => {
  setConfig({ claude: { model: 'haiku', perCallUsd: 0.04, perDayUsd: 0.6 } });
  recordSpend({ feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 0.1, inputTokens: 1, outputTokens: 1, ms: 1 });
  recordSpend({ feature: 'reason:ask', provider: 'claude', model: 'claude-opus-5', usd: 1, inputTokens: 1, outputTokens: 1, ms: 1 });
  const calls = [];
  const r = await AI.call('merge', { system: 'S', prompt: 'P', schema: SCHEMA, deps: claudeDeps(calls) });
  assert.equal(calls.length, 1, 'one model call');
  const c = calls[0];
  assert.deepEqual([c.model, c.maxBudgetUsd, c.timeoutMs, c.feature, c.system, c.prompt, c.effort], ['haiku', 0.04, 90_000, 'memory-merge', 'S', 'P', undefined]);
  assert.deepEqual(c.schema, SCHEMA);
  assert.deepEqual(r, {
    text: JSON.stringify(REPLY), provider: 'claude', model: 'haiku', usd: 0.0042, estimated: false,
    cap: { family: 'hook', perDayUsd: 0.6, spentToday: 0.1042, perCallUsd: 0.04 },
  });
  const rows = spendRows().filter((x) => x.feature === 'memory-merge');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'claude');
  await AI.call('merge', { prompt: 'P', schema: SCHEMA, timeoutMs: 5000, deps: claudeDeps(calls) });
  assert.equal(calls[1].timeoutMs, 5000, 'a caller\'s timeout wins');
});

test('merge on Codex: codex exec through the real codexCall in an empty temp folder, codex.model at codex.effort; priced tokens, marked estimated', async () => {
  setConfig({ codex: { model: 'gpt-5-mini' }, reasoner: { codexModel: 'gpt-5', effort: 'high' } }, CODEX_ONLY);
  const spawns = [];
  const r = await AI.call('merge', { system: 'S', prompt: 'P', schema: SCHEMA, deps: codexDeps(spawns) });
  assert.equal(spawns.length, 1);
  const s = spawns[0];
  assertCodexCwd(s);
  assert.ok(s.args.includes('read-only'));
  assert.deepEqual(s.args.slice(s.args.indexOf('-m'), s.args.indexOf('-m') + 2), ['-m', 'gpt-5-mini']);
  assert.ok(s.args.includes('model_reasoning_effort="low"'), 'codex.effort (default low), never reasoner.effort');
  assert.deepEqual(s.schema, codexCli.strictSchema(SCHEMA), 'the strict schema reaches --output-schema');
  assert.ok(s.stdin.startsWith('S\n\n---\n\nP'));
  const usd = codexPricing.priceUsd('gpt-5-mini', { inputTokens: 3000, cachedInputTokens: 0, outputTokens: 200 });
  assert.equal(usd, 0.00115);
  assert.deepEqual(r, {
    text: JSON.stringify(REPLY), provider: 'codex', model: 'gpt-5-mini', usd, estimated: true,
    cap: { family: 'codex', perDayUsd: 0.5, spentToday: usd, perCallUsd: null },
  });
  const rows = spendRows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].feature, rows[0].provider, rows[0].model], ['memory-merge', 'codex', 'gpt-5-mini']);
});

test('merge on Ollama: the schema as format, 2,000 tokens, 90 s, the configured address; the workhorse model, nothing billed, no cap', async () => {
  setConfig({ ollama: { host: '127.0.0.9', port: 4242 } });
  const calls = [];
  ollama.chat = async (o) => { calls.push(o); return JSON.stringify(REPLY); };
  const r = await AI.call('merge', { system: 'S', prompt: 'P', schema: SCHEMA, deps: { ...nobody, ping: async () => true } });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.deepEqual([c.numPredict, c.timeoutMs, c.feature, c.system, c.prompt, c.host, c.port], [2000, 90_000, 'memory-merge', 'S', 'P', '127.0.0.9', 4242]);
  assert.deepEqual(c.format, SCHEMA);
  assert.deepEqual(r, { text: JSON.stringify(REPLY), provider: 'ollama', model: role('workhorse').tag, usd: 0, estimated: false, cap: null });
  assert.deepEqual(spendRows(), []);
});

test('the sweep on Claude: the reasoner\'s caps on claude.model with no --effort, 120 s, 3,000 tokens; never Ollama; the hook cap untouched', async () => {
  setConfig({ claude: { model: 'haiku' }, reasoner: { model: 'claude-opus-5', effort: 'high', perCallUsd: 0.4, perDayUsd: 3 } });
  const calls = [];
  const r = await AI.call('sweep', { system: 'S', prompt: 'P', schema: SCHEMA, deps: claudeDeps(calls, { ping: async () => true }) });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.deepEqual([c.model, c.effort, c.maxBudgetUsd, c.timeoutMs, c.feature], ['haiku', undefined, 0.4, 120_000, 'reason:memory-sweep']);
  assert.deepEqual(r, {
    text: JSON.stringify(REPLY), provider: 'claude', model: 'haiku', usd: 0.0042, estimated: false,
    cap: { family: 'reasoner', perDayUsd: 3, spentToday: 0.0042, perCallUsd: 0.4 },
  });
  assert.equal(spendToday(), 0, 'a reason:* row never counts against the hook cap');
  assert.equal(reasonSpendToday(), 0.0042);
});

test('the sweep on Codex: codex.model at codex.effort, never reasoner.codexModel or reasoner.effort; the reasoner cap, estimated', async () => {
  setConfig({ codex: { model: 'gpt-5-mini', effort: 'minimal' }, reasoner: { codexModel: 'gpt-5', effort: 'high', perDayUsd: 3 } }, CODEX_ONLY);
  const spawns = [];
  const r = await AI.call('sweep', { system: 'S', prompt: 'P', schema: SCHEMA, deps: codexDeps(spawns) });
  assert.equal(spawns.length, 1);
  const s = spawns[0];
  assertCodexCwd(s);
  assert.deepEqual(s.args.slice(s.args.indexOf('-m'), s.args.indexOf('-m') + 2), ['-m', 'gpt-5-mini']);
  assert.ok(s.args.includes('model_reasoning_effort="minimal"'));
  const usd = codexPricing.priceUsd('gpt-5-mini', { inputTokens: 3000, outputTokens: 200 });
  assert.deepEqual(r, {
    text: JSON.stringify(REPLY), provider: 'codex', model: 'gpt-5-mini', usd, estimated: true,
    cap: { family: 'reasoner-codex', perDayUsd: 3, spentToday: usd, perCallUsd: null },
  });
  const rows = spendRows();
  assert.deepEqual([rows.length, rows[0].feature, rows[0].provider], [1, 'reason:memory-sweep', 'codex']);
  assert.equal(spendToday(), 0);
});

test('the sweep with no codex.model runs Codex\'s own default model (its config.toml), never reasoner.codexModel', async () => {
  setConfig({ reasoner: { codexModel: 'gpt-5' } }, CODEX_ONLY);
  fs.writeFileSync(CODEX_TOML, 'model = "gpt-5-codex"\n\n[profiles.x]\nmodel = "o3"\n');
  const spawns = [];
  const r = await AI.call('sweep', { prompt: 'P', schema: SCHEMA, deps: codexDeps(spawns) });
  assert.deepEqual(spawns[0].args.slice(spawns[0].args.indexOf('-m'), spawns[0].args.indexOf('-m') + 2), ['-m', 'gpt-5-codex']);
  assert.ok(spawns[0].args.includes('model_reasoning_effort="low"'));
  assert.equal(r.model, 'gpt-5-codex');
  fs.unlinkSync(CODEX_TOML);
  dropState();
  const bare = [];
  const est = await AI.estimate('sweep', { chars: 400, deps: codexDeps(bare) });
  assert.equal(est.model, 'gpt-5', 'nothing names a background model: provider.js keeps the reasoner\'s');
});

test('the sweep with only Ollama is off (ollama-only) and never calls it; the merge still runs on Ollama', async () => {
  const deps = { ...nobody, ping: async () => true, resolveClaudeBin: () => null };
  const est = await AI.estimate('sweep', { chars: 1000, outTokens: 10, deps });
  assert.deepEqual(est, { available: false, reason: 'ollama-only', provider: 'none', model: null, tokensIn: 250, tokensOut: 10, usd: 0, cap: null });
  assert.equal(AI.reasonSentence(est), 'Only Ollama is available, and a local model cannot hold the whole brain.');
  await assert.rejects(() => AI.call('sweep', { prompt: 'x', deps }), (e) => e.code === 'PROVIDER_NONE' && e.reason === 'ollama-only');
  const merge = await AI.estimate('merge', { chars: 1000, deps });
  assert.deepEqual([merge.available, merge.provider, merge.model, merge.usd, merge.cap], [true, 'ollama', role('workhorse').tag, 0, null]);

  dropState();
  const down = await AI.estimate('sweep', { deps: { ...deps, ping: async () => false } });
  assert.deepEqual([down.reason, AI.reasonSentence(down)], ['no-provider', 'No model provider is set up.']);

  dropState();
  const out = await AI.estimate('sweep', { deps: { ...nobody, ping: async () => false, resolveClaudeBin: () => '/fake/bin/claude', loginProbe: async () => false } });
  assert.deepEqual([out.reason, AI.reasonSentence(out)], ['claude-not-logged-in', 'Claude Code is not signed in.']);

  dropState();
  setConfig({ provider: 'ollama' });
  const forced = await AI.estimate('sweep', { deps: { ...nobody, resolveClaudeBin: () => null } });
  assert.equal(forced.reason, 'ollama-only', 'provider ollama: no ping needed');
});

test('a cap at resolve: off with the cap that stopped it, named in the sentence; no call', async () => {
  // merge on Claude: the hook cap.
  let est = await AI.estimate('merge', { chars: 4000, deps: claudeDeps([], { claudeCall: never('claude'), spendToday: () => 0.5 }) });
  assert.deepEqual(est, {
    available: false, reason: 'daily-cap', provider: 'none', model: null, tokensIn: 1000, tokensOut: 2000, usd: 0,
    cap: { family: 'hook', perDayUsd: 0.5, spentToday: 0.5, perCallUsd: 0.05 },
  });
  const sentence = "Today's model cap is reached ($0.50, claude.perDayUsd).";
  assert.equal(AI.reasonSentence(est), sentence);
  assert.equal(AI.reasonSentence('daily-cap'), sentence, 'the reason alone: provider.js\'s cached login says which host');
  await assert.rejects(() => AI.call('merge', { prompt: 'x', deps: claudeDeps([], { claudeCall: never('claude'), spendToday: () => 0.5 }) }), (e) => {
    assert.deepEqual([e.code, e.reason], ['PROVIDER_NONE', 'daily-cap']);
    assert.equal(AI.reasonSentence(e), sentence);
    return true;
  });

  // merge on Codex: codex.perDayUsd.
  dropState();
  setConfig({ codex: { model: 'gpt-5-mini', perDayUsd: 0.2 } }, CODEX_ONLY);
  est = await AI.estimate('merge', { deps: codexDeps([], {}, { codexCall: never('codex'), spendToday: () => 0.3 }) });
  assert.deepEqual([est.reason, est.cap], ['daily-cap', { family: 'codex', perDayUsd: 0.2, spentToday: 0.3, perCallUsd: null }]);
  assert.equal(AI.reasonSentence(est), "Today's model cap is reached ($0.20, codex.perDayUsd).");
  assert.equal(AI.reasonSentence('daily-cap'), "Today's model cap is reached ($0.20, codex.perDayUsd).");

  // the sweep on Codex, then on Claude: reasoner.perDayUsd.
  dropState();
  est = await AI.estimate('sweep', { deps: codexDeps([], {}, { codexCall: never('codex'), reasonSpendToday: () => 5 }) });
  assert.deepEqual([est.reason, est.cap], ['reasoner-daily-cap', { family: 'reasoner-codex', perDayUsd: 5, spentToday: 5, perCallUsd: null }]);
  dropState();
  setConfig();
  est = await AI.estimate('sweep', { deps: claudeDeps([], { claudeCall: never('claude'), reasonSpendToday: () => 5 }) });
  assert.deepEqual([est.reason, est.cap], ['reasoner-daily-cap', { family: 'reasoner', perDayUsd: 5, spentToday: 5, perCallUsd: 0.5 }]);
  assert.equal(AI.reasonSentence(est), "Today's model cap is reached ($5.00, reasoner.perDayUsd).");
  assert.equal(AI.reasonSentence('reasoner-daily-cap'), "Today's model cap is reached ($5.00, reasoner.perDayUsd).");
  assert.deepEqual(spendRows(), []);
});

test('a cap mid-call: provider.js\'s PROVIDER_CAP comes through unchanged, and its sentence names the cap', async () => {
  // The day's spend crosses the hook cap between the resolve and the call: provider.js refuses before spawning.
  let n = 0;
  await assert.rejects(() => AI.call('merge', { prompt: 'x', deps: claudeDeps([], { claudeCall: never('claude'), spendToday: () => (n++ ? 0.6 : 0) }) }), (e) => {
    assert.ok(e instanceof ProviderUnavailable);
    assert.deepEqual([e.code, e.provider, e.message, e.reason], ['PROVIDER_CAP', 'claude', 'daily hook cap of 0.5 USD reached (claude.perDayUsd)', undefined]);
    assert.equal(AI.reasonSentence(e), "Today's model cap is reached ($0.50, claude.perDayUsd).");
    return true;
  });
  // A PROVIDER_CAP thrown from inside the call (the sweep on Codex) is the same object afterwards.
  dropState();
  setConfig({ reasoner: { perDayUsd: 3 } }, CODEX_ONLY);
  const thrown = new ProviderUnavailable('PROVIDER_CAP', 'daily reasoner cap of 3 USD reached (reasoner.perDayUsd)', 'codex');
  await assert.rejects(() => AI.call('sweep', { prompt: 'x', deps: codexDeps([], {}, { codexCall: async () => { throw thrown; } }) }), (e) => {
    assert.equal(e, thrown);
    assert.equal(AI.reasonSentence(e), "Today's model cap is reached ($3.00, reasoner.perDayUsd).");
    return true;
  });
});

test('a failed call: the error comes through tagged with who failed, and Codex\'s temp folder is gone', async () => {
  await assert.rejects(() => AI.call('merge', { prompt: 'x', deps: claudeDeps([], { claudeCall: async () => { throw new Error('claude -p timeout after 90000ms'); } }) }), (e) => {
    assert.deepEqual([e.message, e.provider, e.code], ['claude -p timeout after 90000ms', 'claude', undefined]);
    assert.equal(AI.reasonSentence(e), 'Claude did not answer.');
    return true;
  });
  dropState();
  setConfig({ codex: { model: 'gpt-5-mini' } }, CODEX_ONLY);
  const spawns = [];
  await assert.rejects(() => AI.call('merge', { prompt: 'x', deps: codexDeps(spawns, { code: 1, stderr: 'Not logged in\n' }) }), (e) => {
    assert.deepEqual([e.code, e.provider], ['PROVIDER_UNREACHABLE', 'codex']);
    assert.equal(AI.reasonSentence(e), 'Codex is not signed in.');
    return true;
  });
  assertCodexCwd(spawns[0]);
  const failed = [];
  await assert.rejects(() => AI.call('merge', { prompt: 'x', deps: codexDeps(failed, { code: 2, stderr: 'boom\n' }) }), (e) => {
    assert.match(e.message, /^codex exec exited 2/);
    assert.equal(e.provider, 'codex');
    assert.equal(AI.reasonSentence(e), 'Codex did not answer.');
    return true;
  });
  assertCodexCwd(failed[0]);
  assert.deepEqual(spendRows(), [], 'no usage block, nothing billed');
});

test('an estimate per host: the tokens with the host\'s overhead, the price, and the cap; no call, nothing billed', async () => {
  // Claude: 4,000 characters → 1,000 tokens + 600; haiku at $1 in, $5 out.
  let e = await AI.estimate('merge', { chars: 4000, outTokens: 800, deps: claudeDeps([], { claudeCall: never('claude') }) });
  assert.deepEqual(e, {
    available: true, reason: null, provider: 'claude', model: 'haiku', tokensIn: 1600, tokensOut: 800, usd: 0.0056,
    cap: { family: 'hook', perDayUsd: 0.5, spentToday: 0, perCallUsd: 0.05 },
  });
  e = await AI.estimate('merge', { chars: 4001, deps: claudeDeps([], { claudeCall: never('claude') }) });
  assert.deepEqual([e.tokensIn, e.tokensOut], [1601, 2000], 'chars round up; no outTokens → the most a merge may write');
  e = await AI.estimate('sweep', { chars: 120_000, outTokens: 3000, deps: claudeDeps([], { claudeCall: never('claude') }) });
  assert.deepEqual([e.provider, e.model, e.tokensIn, e.usd, e.cap], ['claude', 'haiku', 30_600, 0.0456, { family: 'reasoner', perDayUsd: 5, spentToday: 0, perCallUsd: 0.5 }]);

  // Codex: 20,000 overhead tokens priced as cached input; gpt-5-mini at $0.25 in, $2 out.
  dropState();
  setConfig({ codex: { model: 'gpt-5-mini' } }, CODEX_ONLY);
  e = await AI.estimate('merge', { chars: 4000, outTokens: 800, deps: codexDeps([], {}, { codexCall: never('codex') }) });
  assert.deepEqual(e, {
    available: true, reason: null, provider: 'codex', model: 'gpt-5-mini', tokensIn: 21_000, tokensOut: 800, usd: 0.00235,
    cap: { family: 'codex', perDayUsd: 0.5, spentToday: 0, perCallUsd: null },
  });
  e = await AI.estimate('sweep', { chars: 4000, outTokens: 800, deps: codexDeps([], {}, { codexCall: never('codex') }) });
  assert.deepEqual([e.provider, e.model, e.usd, e.cap], ['codex', 'gpt-5-mini', 0.00235, { family: 'reasoner-codex', perDayUsd: 5, spentToday: 0, perCallUsd: null }]);

  // Ollama: local, free, no cap.
  dropState();
  setConfig();
  e = await AI.estimate('merge', { chars: 4000, outTokens: 800, deps: { ...nobody, ping: async () => true } });
  assert.deepEqual(e, { available: true, reason: null, provider: 'ollama', model: role('workhorse').tag, tokensIn: 1000, tokensOut: 800, usd: 0, cap: null });
  assert.deepEqual(spendRows(), []);
});

test('capFor: the cap a call there counts against, read now', () => {
  setConfig({ claude: { perCallUsd: 0.03, perDayUsd: 0.4 }, codex: { perDayUsd: 0.3 }, reasoner: { perCallUsd: 0.7, perDayUsd: 2 } });
  recordSpend({ feature: 'memory-merge', provider: 'claude', model: 'haiku', usd: 0.1, inputTokens: 1, outputTokens: 1, ms: 1 });
  recordSpend({ feature: 'reason:memory-sweep', provider: 'codex', model: 'gpt-5-mini', usd: 0.2, inputTokens: 1, outputTokens: 1, ms: 1 });
  assert.deepEqual(AI.capFor('merge', 'claude'), { family: 'hook', perDayUsd: 0.4, spentToday: 0.1, perCallUsd: 0.03 });
  assert.deepEqual(AI.capFor('merge', 'codex'), { family: 'codex', perDayUsd: 0.3, spentToday: 0.1, perCallUsd: null });
  assert.deepEqual(AI.capFor('sweep', 'claude'), { family: 'reasoner', perDayUsd: 2, spentToday: 0.2, perCallUsd: 0.7 });
  assert.deepEqual(AI.capFor('sweep', 'codex'), { family: 'reasoner-codex', perDayUsd: 2, spentToday: 0.2, perCallUsd: null });
  assert.equal(AI.capFor('merge', 'ollama'), null);
  assert.equal(AI.capFor('sweep', 'none'), null);
  assert.deepEqual(AI.capFor('merge', 'claude', { deps: { spendToday: () => 7 } }).spentToday, 7, 'the provider.js seams are honoured');
});

test('who: the label per provider', () => {
  assert.deepEqual(AI.who({ name: 'claude', model: 'haiku' }), { provider: 'claude', model: 'haiku' });
  assert.deepEqual(AI.who({ name: 'codex', model: 'gpt-5-mini' }), { provider: 'codex', model: 'gpt-5-mini' });
  assert.deepEqual(AI.who({ name: 'codex', model: null }), { provider: 'codex', model: null }, 'no model anywhere');
  fs.writeFileSync(CODEX_TOML, 'model = "gpt-5-codex"\n');
  assert.deepEqual(AI.who({ name: 'codex', model: null }), { provider: 'codex', model: 'gpt-5-codex' }, 'Codex\'s own default, as codexCall prices it');
  assert.deepEqual(AI.who({ name: 'ollama' }), { provider: 'ollama', model: role('workhorse').tag });
  for (const p of [{ name: 'none', reason: 'forced' }, null, undefined, { name: 'toString' }]) assert.deepEqual(AI.who(p), { provider: 'none', model: null });
});

test('reasonSentence: the page\'s sentences from reasons, errors and estimates', () => {
  const none = 'No model provider is set up.';
  for (const r of ['forced', 'no-provider', 'none', 'no-codex', 'codex-not-configured', null, '']) assert.equal(AI.reasonSentence(r), none, String(r));
  assert.equal(AI.reasonSentence('claude-not-logged-in'), 'Claude Code is not signed in.');
  assert.equal(AI.reasonSentence('codex-not-logged-in'), 'Codex is not signed in.');
  assert.equal(AI.reasonSentence('bad-reply'), "The model's reply could not be read.");
  assert.equal(AI.reasonSentence('ollama-only'), 'Only Ollama is available, and a local model cannot hold the whole brain.');
  assert.equal(AI.reasonSentence('something-new'), 'No model call possible (something-new).');
  // An estimate (or anything with a reason) names its own cap.
  assert.equal(AI.reasonSentence({ reason: 'daily-cap', cap: { family: 'codex', perDayUsd: 0.2 } }), "Today's model cap is reached ($0.20, codex.perDayUsd).");
  assert.equal(AI.reasonSentence({ reason: 'daily-cap', cap: { family: 'hook', perDayUsd: 1.25 } }), "Today's model cap is reached ($1.25, claude.perDayUsd).");
  assert.equal(AI.reasonSentence({ reason: 'reasoner-daily-cap', cap: { family: 'reasoner-codex', perDayUsd: 5 } }), "Today's model cap is reached ($5.00, reasoner.perDayUsd).");
  assert.equal(AI.reasonSentence({ reason: 'daily-cap', cap: null }, { provider: 'codex', codex: { perDayUsd: 0.75 } }), "Today's model cap is reached ($0.75, codex.perDayUsd).", 'no cap: the cfg given, provider codex');
  // Errors: provider.js's own, the CLIs', anything else.
  const PU = (code, msg, who) => new ProviderUnavailable(code, msg, who);
  assert.equal(AI.reasonSentence(PU('PROVIDER_UNREACHABLE', 'claude CLI: Not logged in (run `claude login`)', 'claude')), 'Claude Code is not signed in.');
  assert.equal(AI.reasonSentence(PU('PROVIDER_UNREACHABLE', 'codex CLI: not logged in (run `codex login`)', 'codex')), 'Codex is not signed in.');
  assert.equal(AI.reasonSentence(PU('PROVIDER_UNREACHABLE', 'claude CLI not found on PATH or in ~/.local/bin', 'claude')), 'Claude did not answer.');
  assert.equal(AI.reasonSentence(PU('PROVIDER_NONE', 'no model provider (codex-not-logged-in)', 'none')), 'Codex is not signed in.', 'provider.js makeNone');
  assert.equal(AI.reasonSentence(PU('PROVIDER_NONE', 'the claude provider has no embeddings', 'claude')), none);
  assert.equal(AI.reasonSentence(PU('PROVIDER_CAP', 'daily hook cap of 0.5 USD reached (codex.perDayUsd)', 'codex')), "Today's model cap is reached ($0.50, codex.perDayUsd).");
  assert.equal(AI.reasonSentence(PU('PROVIDER_CAP', 'over budget', 'claude')), "Today's model cap is reached.");
  assert.equal(AI.reasonSentence(Object.assign(new Error('ollama timeout'), { provider: 'ollama' })), 'Ollama did not answer.');
  assert.equal(AI.reasonSentence(new Error('boom')), 'The model did not answer.');
  assert.equal(AI.reasonSentence(Object.assign(new Error('x'), { reason: 'bad-reply' })), "The model's reply could not be read.");
});
