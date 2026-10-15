'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccli-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = TMP;
process.env.CLAUDECODE = '1'; // inherited from a hook child in real life; must be stripped
const cli = require('../sdk/lib/claude-cli.js');
const { SPEND_PATH, ProviderUnavailable } = require('../sdk/lib/spend-ledger.js');

// Fake child process: emits the given stdout/stderr then 'close' with `code`.
// hang:true never closes (for the timeout test); kill() records the signal.
function fakeSpawn(reply, calls) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts, killed: null });
    const rec = calls[calls.length - 1];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (sig) => { rec.killed = sig; };
    if (!reply.hang) {
      setImmediate(() => {
        child.stdout.end(reply.stdout || '');
        child.stderr.end(reply.stderr || '');
        setImmediate(() => child.emit('close', reply.code ?? 0));
      });
    }
    return child;
  };
}

const OK_REPLY = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_api_ms: 2911, session_id: 'abc',
  result: '{"word":"pong"}', total_cost_usd: 0.0034,
  usage: { input_tokens: 1505, output_tokens: 185, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  structured_output: { word: 'pong' },
});

beforeEach(() => { try { fs.unlinkSync(SPEND_PATH); } catch {} });

test('buildArgs reproduces the measured recipe exactly', () => {
  assert.deepEqual(
    cli.buildArgs({ prompt: 'ping', model: 'haiku', system: 'S', schema: { type: 'object' }, maxBudgetUsd: 0.05 }),
    ['-p', 'ping', '--model', 'haiku', '--tools', '', '--setting-sources', '', '--strict-mcp-config',
      '--no-session-persistence', '--system-prompt', 'S', '--json-schema', '{"type":"object"}',
      '--max-budget-usd', '0.05', '--output-format', 'json']);
  const noSchema = cli.buildArgs({ prompt: 'p', model: 'haiku', system: '', maxBudgetUsd: 0.01 });
  assert.ok(!noSchema.includes('--json-schema'));
  assert.ok(!noSchema.includes('--bare'));
});

test('headlessEnv sets AOS_HEADLESS and strips CLAUDECODE', () => {
  const env = cli.headlessEnv({ CLAUDECODE: '1', HOME: '/home/alice' });
  assert.equal(env.AOS_HEADLESS, '1');
  assert.equal(env.HOME, '/home/alice');
  assert.ok(!('CLAUDECODE' in env));
});

test('claudeCall parses the result, spawns headless in the vault, and ledgers the spend', async () => {
  const calls = [];
  const out = await cli.claudeCall({
    system: 'S', prompt: 'ping', schema: { type: 'object' }, model: 'haiku', maxBudgetUsd: 0.05,
    feature: 'probe-test', bin: '/x/claude', spawnFn: fakeSpawn({ stdout: OK_REPLY }, calls),
  });
  assert.equal(out.text, '{"word":"pong"}');
  assert.deepEqual(out.structured, { word: 'pong' });
  assert.equal(out.usd, 0.0034);
  assert.equal(out.usage.input_tokens, 1505);
  assert.equal(out.ms, 2911);
  assert.equal(calls[0].bin, '/x/claude');
  assert.equal(calls[0].args[0], '-p');
  assert.equal(calls[0].opts.cwd, TMP);
  assert.equal(calls[0].opts.env.AOS_HEADLESS, '1');
  assert.ok(!('CLAUDECODE' in calls[0].opts.env));
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
  const rows = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feature, 'probe-test');
  assert.equal(rows[0].provider, 'claude');
  assert.equal(rows[0].model, 'haiku');
  assert.equal(rows[0].usd, 0.0034);
  assert.equal(rows[0].inputTokens, 1505);
  assert.equal(rows[0].outputTokens, 185);
});

test('"Not logged in" → ProviderUnavailable PROVIDER_UNREACHABLE, nothing ledgered', async () => {
  const calls = [];
  await assert.rejects(
    () => cli.claudeCall({ prompt: 'p', bin: '/x/claude', spawnFn: fakeSpawn({ stdout: 'Not logged in · Please run /login', code: 1 }, calls) }),
    (e) => e instanceof ProviderUnavailable && e.code === 'PROVIDER_UNREACHABLE' && e.provider === 'claude');
  assert.ok(!fs.existsSync(SPEND_PATH));
});

test('a successful result that merely quotes "Not logged in" resolves and is ledgered', async () => {
  const reply = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, duration_api_ms: 12, session_id: 'abc',
    result: 'Reply: Not logged in is a state the CLI reports', total_cost_usd: 0.0021,
    usage: { input_tokens: 10, output_tokens: 4 }, structured_output: { word: 'ok' },
  });
  const out = await cli.claudeCall({
    prompt: 'p', feature: 'quoted-phrase', bin: '/x/claude', spawnFn: fakeSpawn({ stdout: reply }, []),
  });
  assert.equal(out.text, 'Reply: Not logged in is a state the CLI reports');
  assert.deepEqual(out.structured, { word: 'ok' });
  const rows = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feature, 'quoted-phrase');
});

test('a non-zero exit without JSON → plain Error carrying stderr', async () => {
  await assert.rejects(
    () => cli.claudeCall({ prompt: 'p', bin: '/x/claude', spawnFn: fakeSpawn({ stderr: 'boom: bad flag', code: 2 }, []) }),
    (e) => !(e instanceof ProviderUnavailable) && /exited 2/.test(e.message) && /bad flag/.test(e.message));
});

test('a billed is_error result is ledgered, then throws', async () => {
  const bad = JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_budget', result: 'over budget', total_cost_usd: 0.05 });
  await assert.rejects(
    () => cli.claudeCall({ prompt: 'p', feature: 'billed-failure', bin: '/x/claude', spawnFn: fakeSpawn({ stdout: bad }, []) }),
    /over budget/);
  const rows = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usd, 0.05);
  assert.equal(rows[0].feature, 'billed-failure');
  assert.equal(rows[0].provider, 'claude');
});

test('timeout kills the child and rejects', async () => {
  const calls = [];
  await assert.rejects(
    () => cli.claudeCall({ prompt: 'p', bin: '/x/claude', timeoutMs: 20, spawnFn: fakeSpawn({ hang: true }, calls) }),
    /timeout after 20ms/);
  assert.equal(calls[0].killed, 'SIGKILL');
});

test('stream error (stdout/stderr emit error) kills child and rejects, nothing ledgered', async () => {
  const calls = [];
  const streamErrorSpawn = (bin, args, opts) => {
    calls.push({ bin, args, opts, killed: null });
    const rec = calls[calls.length - 1];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (sig) => { rec.killed = sig; };
    setImmediate(() => child.stdout.emit('error', new Error('pipe broke')));
    return child;
  };
  await assert.rejects(
    () => cli.claudeCall({ prompt: 'p', bin: '/x/claude', spawnFn: streamErrorSpawn }),
    /pipe broke/);
  assert.equal(calls[0].killed, 'SIGKILL');
  assert.ok(!fs.existsSync(SPEND_PATH));
});

test('loginProbe: true when auth status says loggedIn; false when it does not, on junk, or with no binary', async () => {
  assert.equal(await cli.loginProbe({ bin: '/x/claude', spawnFn: fakeSpawn({ stdout: '{"loggedIn":true,"authMethod":"x"}' }, []) }), true);
  assert.equal(await cli.loginProbe({ bin: '/x/claude', spawnFn: fakeSpawn({ stdout: '{"loggedIn":false}', code: 1 }, []) }), false);
  assert.equal(await cli.loginProbe({ bin: '/x/claude', spawnFn: fakeSpawn({ stdout: 'Not logged in', code: 1 }, []) }), false);
  const calls = [];
  assert.equal(await cli.loginProbe({ bin: null, lookup: () => null, candidates: [], spawnFn: fakeSpawn({ stdout: OK_REPLY }, calls) }), false);
  assert.equal(calls.length, 0);
});

test('loginProbe asks `auth status`, makes no model call and writes no ledger row (local-first A16)', async () => {
  const calls = [];
  await cli.loginProbe({ bin: '/x/claude', spawnFn: fakeSpawn({ stdout: '{"loggedIn":true}' }, calls) });
  assert.deepEqual(calls[0].args, ['auth', 'status', '--json']);
  assert.equal(calls[0].opts.env.CLAUDECODE, undefined);
  assert.ok(!fs.existsSync(SPEND_PATH));
});

test('resolveClaudeBin: PATH lookup first, then candidates, else null', () => {
  const exe = path.join(TMP, 'claude');
  fs.writeFileSync(exe, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  assert.equal(cli.resolveClaudeBin({ lookup: () => '/from/path/claude' }), '/from/path/claude');
  assert.equal(cli.resolveClaudeBin({ lookup: () => null, candidates: [path.join(TMP, 'missing'), exe] }), exe);
  assert.equal(cli.resolveClaudeBin({ lookup: () => null, candidates: [path.join(TMP, 'missing')] }), null);
});

test('resolveClaudeBin: agenticos.json claude.bin wins while it is an executable file, else the probe order (contract §2)', () => {
  const exe = path.join(TMP, 'recorded-claude');
  fs.writeFileSync(exe, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  assert.equal(cli.resolveClaudeBin({ recorded: exe, lookup: () => '/from/path/claude' }), exe);
  assert.equal(cli.resolveClaudeBin({ recorded: path.join(TMP, 'gone'), lookup: () => '/from/path/claude' }), '/from/path/claude', 'a recorded path that is gone falls through');
  fs.mkdirSync(path.join(TMP, 'a-dir'));
  assert.equal(cli.resolveClaudeBin({ recorded: path.join(TMP, 'a-dir'), lookup: () => null, candidates: [] }), null, 'a directory is not a CLI');
  // Default: the key is read through loadConfig(), where agenticos.json merges last (AOS_CONFIG names that file here).
  const cfgFile = path.join(TMP, 'agenticos.json');
  const saved = process.env.AOS_CONFIG;
  process.env.AOS_CONFIG = cfgFile;
  try {
    fs.writeFileSync(cfgFile, JSON.stringify({ claude: { bin: exe } }));
    assert.equal(cli.resolveClaudeBin({ lookup: () => '/from/path/claude' }), exe);
    fs.writeFileSync(cfgFile, JSON.stringify({ claude: { model: 'haiku' } }));
    assert.equal(cli.resolveClaudeBin({ lookup: () => '/from/path/claude' }), '/from/path/claude', 'configs written before Plan 4 lack the key');
  } finally { process.env.AOS_CONFIG = saved; }
});

test('buildArgs: a valid effort becomes --effort right after --model; anything else is left off', () => {
  const withEffort = cli.buildArgs({ prompt: 'p', model: 'claude-opus-5', system: '', maxBudgetUsd: 0.5, effort: 'high' });
  assert.deepEqual(withEffort.slice(0, 6), ['-p', 'p', '--model', 'claude-opus-5', '--effort', 'high']);
  for (const bad of [undefined, null, '', 'max', 'MEDIUM', 0]) {
    assert.ok(!cli.buildArgs({ prompt: 'p', model: 'haiku', system: '', maxBudgetUsd: 0.01, effort: bad }).includes('--effort'), `effort=${String(bad)}`);
  }
  assert.deepEqual(cli.EFFORTS, ['low', 'medium', 'high']);
});

test('claudeCall forwards effort to the spawn', async () => {
  const calls = [];
  await cli.claudeCall({ prompt: 'q', model: 'claude-opus-5', maxBudgetUsd: 0.5, effort: 'medium', feature: 'reason:ask', bin: '/x/claude', spawnFn: fakeSpawn({ stdout: OK_REPLY }, calls) });
  const i = calls[0].args.indexOf('--effort');
  assert.ok(i > 0);
  assert.equal(calls[0].args[i + 1], 'medium');
  const rows = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].feature, 'reason:ask');
  assert.equal(rows[0].model, 'claude-opus-5');
});

// graphify spec D12: thinking off for every call that dials no effort; a call that dials one (the reasoner) keeps it.
test('headlessEnv adds MAX_THINKING_TOKENS=0 only when thinking is off', () => {
  assert.ok(!('MAX_THINKING_TOKENS' in cli.headlessEnv({ HOME: '/h' })));
  assert.equal(cli.headlessEnv({ HOME: '/h' }, { thinking: false }).MAX_THINKING_TOKENS, '0');
  assert.deepEqual(cli.ISOLATION_FLAGS, ['--tools', '', '--setting-sources', '', '--strict-mcp-config']);
});

test('claudeCall turns thinking off without an effort and leaves it on with one (D12)', async () => {
  const calls = [];
  await cli.claudeCall({ prompt: 'p', feature: 'hook-test', bin: '/x/claude', spawnFn: fakeSpawn({ stdout: OK_REPLY }, calls) });
  assert.equal(calls[0].opts.env.MAX_THINKING_TOKENS, '0', 'a hook call: no effort, no thinking');
  await cli.claudeCall({ prompt: 'p', feature: 'reason:test', effort: 'medium', model: 'claude-opus-5', bin: '/x/claude', spawnFn: fakeSpawn({ stdout: OK_REPLY }, calls) });
  assert.ok(!('MAX_THINKING_TOKENS' in calls[1].opts.env), 'the reasoner keeps its thinking');
  assert.ok(calls[1].args.includes('--effort'));
});
