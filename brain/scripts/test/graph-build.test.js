'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// BRAIN_VAULT must be set BEFORE graph-build.js (and paths.js beneath it) loads: the lock lives in its brain/_index.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-build-'));
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = VAULT;
const GB = require('../graph-build.js');

// The same stand-in the CLI tests install through the fake uv (spec 2026-09-23-graphify §5).
const FAKE = path.resolve(__dirname, '..', '..', '..', 'cli', 'fixtures', 'fake-graphify.sh');
const OUT = path.join(VAULT, 'brain', 'graphify-out');
const LOG = path.join(VAULT, 'fake-graphify.log');
const KNOBS = ['FAKE_GRAPHIFY_EXIT', 'FAKE_GRAPHIFY_STDERR', 'FAKE_GRAPHIFY_SLEEP', 'ANTHROPIC_API_KEY'];

function rep() {
  return { counts: {}, wrote: [], status: null, reason: null,
    skip(r) { this.status = 'skipped'; this.reason = r; }, disable(r) { this.status = 'disabled'; this.reason = r; } };
}
const cfg = (over = {}) => ({ graph: { enabled: true, out: 'brain/graphify-out', timeoutSec: 30, bin: FAKE, ...over } });
const build = (c = cfg(), report = rep()) => GB.buildStructural({ report, cfg: c, vault: VAULT });

beforeEach(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.rmSync(LOG, { force: true });
  for (const k of KNOBS) delete process.env[k];
  process.env.FAKE_GRAPHIFY_LOG = LOG;
});

test('off, or no runnable graphify, is a disabled stage that never spawns', async () => {
  let r = rep();
  assert.deepEqual(await build(cfg({ enabled: false }), r), { status: 'disabled', reason: 'graph off' });
  assert.equal(r.status, 'disabled');
  r = rep();
  assert.deepEqual(await build(cfg({ bin: undefined }), r), { status: 'disabled', reason: 'graphify missing' });
  const plain = path.join(VAULT, 'not-executable');
  fs.writeFileSync(plain, '#!/bin/sh\n');
  assert.equal((await build(cfg({ bin: plain }))).reason, 'graphify missing');
  assert.ok(!fs.existsSync(LOG), 'graphify never ran');
});

test('a structural pass runs `update <vault>` into GRAPHIFY_OUT with backups off and writes the marker', async () => {
  const report = rep();
  const r = await build(cfg(), report);
  assert.equal(r.status, 'ok');
  assert.equal(r.out, OUT);
  assert.equal(r.nodes, 5);
  assert.equal(r.mode, 'structural');
  assert.equal(fs.readFileSync(LOG, 'utf8'), `update ${VAULT} | out=${OUT} nobackup=1 apikey=\n`);
  assert.deepEqual(report.counts, { nodes: 5, edges: 5, communities: 2 });
  assert.deepEqual(report.wrote, [path.join('brain', 'graphify-out', 'graph.json')]);
  const m = JSON.parse(fs.readFileSync(path.join(OUT, '.aos-graph.json'), 'utf8'));
  assert.equal(m.schema, 1);
  assert.equal(m.lastSemantic, null);
  assert.equal(m.builtAt, m.lastStructural);
  assert.ok(!fs.existsSync(path.join(OUT, 'graph.json.prev')), 'nothing to keep on the first run');
  await build();
  assert.ok(fs.existsSync(path.join(OUT, 'graph.json.prev')), 'the last good graph is kept before each run');
});

test('graphify never sees API keys, so its backend auto-detect cannot pick a paid backend', async () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  await build();
  assert.match(fs.readFileSync(LOG, 'utf8'), / apikey=\n$/);
  const env = GB.childEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'x', SOME_API_TOKEN: 'x', AWS_PROFILE: 'p', AZURE_OPENAI_ENDPOINT: 'e' }, '/o');
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', GRAPHIFY_OUT: '/o', GRAPHIFY_NO_BACKUP: '1' });
});

test('a torn graph.json is deleted and rebuilt once (graphify refuses it even with --force)', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'graph.json'), 'x');
  const report = rep();
  const r = await build(cfg(), report);
  assert.equal(r.status, 'ok');
  assert.equal(report.counts.recovered, 1);
  assert.equal(fs.readFileSync(LOG, 'utf8').trim().split('\n').length, 2);
});

test('a failing graphify is an error with its last stderr line; an empty vault is a skip', async () => {
  process.env.FAKE_GRAPHIFY_EXIT = '3';
  process.env.FAKE_GRAPHIFY_STDERR = 'boom';
  await assert.rejects(build(), /graphify update exited 3: boom/);
  process.env.FAKE_GRAPHIFY_EXIT = '1';
  process.env.FAKE_GRAPHIFY_STDERR = 'No code files found - nothing to rebuild.';
  const report = rep();
  assert.deepEqual(await build(cfg(), report), { status: 'skipped', reason: 'nothing to graph' });
  assert.equal(report.status, 'skipped');
});

test('graph.timeoutSec kills a hung graphify', async () => {
  process.env.FAKE_GRAPHIFY_SLEEP = '5';
  await assert.rejects(build(cfg({ timeoutSec: 1 })), /graphify update timed out after 1s/);
});

// The graph lock names its owner; only a dead owner or one past its own deadline is broken (the 0.11.0 bug: a structural
// scan's 3-minute idea of "stale" broke a live 30-minute semantic run's lock).
const hold = (o = {}) => fs.writeFileSync(GB.LOCK, JSON.stringify({
  schema: 1, mode: 'semantic', pid: process.pid, startedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
  until: new Date(Date.now() + 23 * 60_000).toISOString(), ...o,
}));
const deadPid = () => require('child_process').spawnSync(process.execPath, ['-e', '']).pid;

test('a live semantic pass 7 minutes in keeps its lock: the structural pass skips and names it', async () => {
  try {
    hold();
    const report = rep();
    const r = await build(cfg(), report);
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /^semantic pass running since \d\d:\d\d$/);
    assert.equal(report.reason, r.reason);
    assert.ok(!fs.existsSync(LOG), 'graphify did not run');
    assert.equal(JSON.parse(fs.readFileSync(GB.LOCK, 'utf8')).mode, 'semantic', 'the live owner\'s lock is intact');
  } finally { fs.rmSync(GB.LOCK, { force: true }); }
});

test('a lock whose owner died, or whose own deadline passed, is broken and taken; ours is released after', async () => {
  try {
    hold({ pid: deadPid() });
    assert.equal((await build()).status, 'ok');
    assert.ok(!fs.existsSync(GB.LOCK), 'released');
    hold({ until: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await build()).status, 'ok');
    assert.ok(!fs.existsSync(GB.LOCK));
  } finally { fs.rmSync(GB.LOCK, { force: true }); }
});

test('an unreadable lock is honoured for a minute (caught mid-write), then broken', async () => {
  try {
    fs.writeFileSync(GB.LOCK, '');
    const r = await build();
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /^another graph build running since \d\d:\d\d$/);
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(GB.LOCK, old, old);
    assert.equal((await build()).status, 'ok');
  } finally { fs.rmSync(GB.LOCK, { force: true }); }
});

test('a pass releases only its own lock, never one a waiter took after its deadline', async () => {
  try {
    const r = await GB.withGraphLock('structural', 1000, async () => {
      assert.equal(GB.lockOwner().mode, 'structural');
      hold({ mode: 'semantic', pid: process.ppid, id: 'theirs' });   // someone else's lock now (a different live process)
      return 7;
    });
    assert.deepEqual(r, { value: 7 });
    assert.equal(JSON.parse(fs.readFileSync(GB.LOCK, 'utf8')).mode, 'semantic', 'left in place');
    const busy = await GB.withGraphLock('structural', 1000, async () => assert.fail('must not run'));
    assert.equal(busy.busy.mode, 'semantic');
  } finally { fs.rmSync(GB.LOCK, { force: true }); }
});

test('a structural pass keeps the semantic stamp of an earlier model pass', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '.aos-graph.json'), JSON.stringify({ schema: 1, lastSemantic: '2026-09-22T00:00:00.000Z' }));
  const r = await build();
  assert.equal(r.mode, 'semantic');
  assert.equal(r.lastSemantic, '2026-09-22T00:00:00.000Z');
});

// ── semantic pass (D5, D6, D10, D11): fake graphify `extract` → the real shim (bin/graph-shim/claude → graph-claude.js)
//    → the fake claude. The shim's node starts with the vault as cwd, so the runner's relative NODE_OPTIONS preload is
//    dropped for these tests (the shim needs none of test/setup.js).
const FAKE_CLAUDE = path.resolve(__dirname, '..', '..', '..', 'cli', 'fixtures', 'fake-claude.sh');
const CLAUDE_LOG = path.join(VAULT, 'fake-claude.log');
const CLAUDE_ENV_LOG = path.join(VAULT, 'fake-claude-env.log');
const { SPEND_PATH } = require('../sdk/lib/spend-ledger.js');
const scfg = (sem = {}, over = {}) => ({
  provider: 'auto', claude: { model: 'haiku' }, ...over,
  graph: { enabled: true, out: 'brain/graphify-out', timeoutSec: 30, bin: FAKE, semantic: { enabled: 'auto', everyHours: 24, perDayUsd: 1, perCallUsd: 0.25, tokenBudget: 20000, timeoutSec: 30, ...sem } },
});
const CLAUDE_RUNNER = { host: 'claude', bin: FAKE_CLAUDE };
const semantic = (c = scfg(), opts = {}) => GB.buildSemantic({ report: rep(), cfg: c, vault: VAULT, runner: CLAUDE_RUNNER, ...opts });
const skip = (c, opts = {}) => GB.semanticSkip(c, { vault: VAULT, runner: CLAUDE_RUNNER, ...opts });
const savedNodeOptions = process.env.NODE_OPTIONS;

beforeEach(() => {
  for (const f of [SPEND_PATH, CLAUDE_LOG, CLAUDE_ENV_LOG]) fs.rmSync(f, { force: true });
  for (const k of ['FAKE_CLAUDE_P_EXIT', 'FAKE_CLAUDE_USD', 'AOS_NO_SPAWN']) delete process.env[k];
  process.env.FAKE_CLAUDE_LOG = CLAUDE_LOG;
  process.env.FAKE_CLAUDE_ENV_LOG = CLAUDE_ENV_LOG;
  delete process.env.NODE_OPTIONS;
});
test.after(() => { if (savedNodeOptions !== undefined) process.env.NODE_OPTIONS = savedNodeOptions; });

test('semantic gates: provider opt-out, off switch, force, a runner CLI, due time, budget', () => {
  assert.deepEqual(skip(scfg({}, { provider: 'none' })), { status: 'disabled', reason: 'provider none' });
  assert.deepEqual(skip(scfg({}, { provider: 'ollama' })), { status: 'disabled', reason: 'provider ollama' });
  assert.deepEqual(skip(scfg({}, { provider: 'local' })), { status: 'disabled', reason: 'provider local' }, 'local never spends in the background (local-first A1)');
  assert.equal(skip(scfg({ enabled: true }, { provider: 'none' })), null, 'an explicit on overrides the provider');
  assert.deepEqual(skip(scfg({}, { provider: 'none' }), { force: true }), { status: 'disabled', reason: 'provider none' }, 'force never overrides a provider opt-out');
  assert.deepEqual(skip(scfg({ enabled: false })), { status: 'disabled', reason: 'semantic off' });
  assert.equal(skip(scfg({ enabled: false }), { force: true }), null, 'the foreground command runs even with the background pass off');
  assert.deepEqual(skip(scfg(), { runner: null }), { status: 'disabled', reason: 'no claude or codex CLI' });
  assert.equal(skip(scfg({}, { provider: 'codex' }), { runner: { host: 'codex', bin: '/x/codex' } }), null, 'provider codex keeps the pass on (D11)');
  assert.deepEqual(skip(cfg({ enabled: false })), { status: 'disabled', reason: 'graph off' });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '.aos-graph.json'), JSON.stringify({ schema: 1, lastSemanticRun: new Date(Date.now() - 3_600_000).toISOString() }));
  assert.deepEqual(skip(scfg()), { status: 'skipped', reason: 'not due' });
  assert.equal(skip(scfg({ everyHours: 0.5 })), null, 'due again after everyHours');
  assert.equal(skip(scfg(), { force: true }), null);
  fs.writeFileSync(SPEND_PATH, JSON.stringify({ ts: new Date().toISOString(), feature: 'graph:semantic', usd: 1 }) + '\n');
  assert.deepEqual(skip(scfg(), { force: true }), { status: 'skipped', reason: 'graph budget reached' });
});

test('a semantic pass runs extract through the shim: isolated, headless, no thinking, one ledger row, a semantic marker', async () => {
  const r = await semantic();
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'semantic');
  assert.equal(r.concepts, 1);
  assert.equal(r.inferred, 1);
  assert.equal(r.semanticIncomplete, false);
  assert.equal(r.semanticUsd, 0.004);
  assert.equal(fs.readFileSync(LOG, 'utf8'), `extract ${VAULT} --backend claude-cli --token-budget 20000 --allow-partial | out=${OUT} nobackup=1 apikey=\n`);
  const call = fs.readFileSync(CLAUDE_LOG, 'utf8').trim();
  assert.match(call, /^-p --output-format json --no-session-persistence --json-schema \{"type":"object"\} --tools {2}--setting-sources {2}--strict-mcp-config --system-prompt .* --model haiku --max-budget-usd 0\.25$/);
  assert.equal(call.split('--model').length, 2, 'graphify\'s own --model is replaced, not doubled');
  assert.equal(fs.readFileSync(CLAUDE_ENV_LOG, 'utf8'), 'MAX_THINKING_TOKENS=0 AOS_HEADLESS=1 CLAUDECODE= ANTHROPIC_API_KEY=\n');
  const rows = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => [x.feature, x.model, x.usd]), [['graph:semantic', 'haiku', 0.004]]);
  const m = JSON.parse(fs.readFileSync(path.join(OUT, '.aos-graph.json'), 'utf8'));
  assert.equal(m.lastSemantic, m.builtAt);
  assert.ok(m.lastSemanticRun);
  assert.equal(m.lastSemanticError, null);
  assert.deepEqual(skip(scfg()), { status: 'skipped', reason: 'not due' });
});

test('graphify never sees an API key; the shim hands it back to the real CLI', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  try {
    await semantic();
    assert.match(fs.readFileSync(LOG, 'utf8'), / apikey=\n$/);
    assert.match(fs.readFileSync(CLAUDE_ENV_LOG, 'utf8'), /ANTHROPIC_API_KEY=set$/m);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

test('a failed model call leaves the pass incomplete, not failed; a failed extract is recorded and waits everyHours', async () => {
  process.env.FAKE_CLAUDE_P_EXIT = '1';
  const partial = await semantic();
  assert.equal(partial.status, 'ok');
  assert.equal(partial.semanticIncomplete, true);
  assert.equal(partial.concepts, 0);
  assert.ok(!fs.existsSync(SPEND_PATH), 'nothing billed, nothing ledgered');
  delete process.env.FAKE_CLAUDE_P_EXIT;
  fs.rmSync(OUT, { recursive: true, force: true });
  process.env.FAKE_GRAPHIFY_EXIT = '2';
  process.env.FAKE_GRAPHIFY_STDERR = 'extract blew up';
  await assert.rejects(semantic(), /graphify extract exited 2: extract blew up/);
  const m = JSON.parse(fs.readFileSync(path.join(OUT, '.aos-graph.json'), 'utf8'));
  assert.equal(m.lastSemanticError, 'graphify extract exited 2: extract blew up');
  assert.deepEqual(skip(scfg()), { status: 'skipped', reason: 'not due' }, 'no retry storm: a failure waits everyHours too');
});

test('spawnSemantic starts a detached --semantic worker, and AOS_NO_SPAWN stops it', () => {
  const calls = [];
  const spawnFn = (bin, args, opts) => { calls.push({ bin, args, opts }); return { unref() { calls[calls.length - 1].unref = true; } }; };
  assert.equal(GB.spawnSemantic({ spawnFn }), true);
  assert.deepEqual(calls[0].args.slice(1), ['--semantic', '--quiet']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.env.AOS_DETACHED, '1');
  assert.equal(calls[0].unref, true);
  process.env.AOS_NO_SPAWN = '1';
  assert.equal(GB.spawnSemantic({ spawnFn }), false);
  assert.equal(calls.length, 1);
});

test('a structural pass keeps the semantic run stamp, so the daily pass stays not-due across scans (0.11.2)', async () => {
  const r = await semantic();
  assert.equal(r.status, 'ok');
  const before = JSON.parse(fs.readFileSync(path.join(OUT, '.aos-graph.json'), 'utf8'));
  assert.equal((await build()).status, 'ok');
  const after = JSON.parse(fs.readFileSync(path.join(OUT, '.aos-graph.json'), 'utf8'));
  for (const k of ['lastSemanticRun', 'lastSemantic', 'semanticUsd', 'concepts', 'inferred']) assert.deepEqual(after[k], before[k], k);
  assert.equal(after.mode, 'semantic');
  assert.deepEqual(skip(scfg()), { status: 'skipped', reason: 'not due' }, 'a scan right after a run does not start another');
});

// ── the same pass under Codex (spec 2026-09-23-codex-parity-gaps D3/D4): fake graphify → the real shim → fake codex exec.
const FAKE_CODEX = path.resolve(__dirname, '..', '..', '..', 'cli', 'fixtures', 'fake-codex.sh');
test('under the codex runner the shim answers graphify through codex exec: read-only, hooks off, low effort, one graph:semantic row', async () => {
  const args = path.join(VAULT, 'fake-codex-args.log');
  const stdin = path.join(VAULT, 'fake-codex-stdin.log');
  Object.assign(process.env, { FAKE_ARGS: args, FAKE_CODEX_STDIN: stdin, FAKE_CODEX_REPLY: '{"nodes":[],"edges":[]}' });
  try {
    const report = rep();
    const r = await GB.buildSemantic({ report, cfg: scfg({}, { provider: 'codex' }), vault: VAULT, runner: { host: 'codex', bin: FAKE_CODEX } });
    assert.equal(r.status, 'ok');
    assert.equal(r.concepts, 1, 'graphify saw a successful call');
    assert.equal(report.provider, 'codex');
    const argv = fs.readFileSync(args, 'utf8').trim().split('\n');
    assert.equal(argv[0], 'exec');
    for (const a of ['--ephemeral', 'read-only', 'features.hooks=false', 'model_reasoning_effort="low"', '--json']) assert.ok(argv.includes(a), `argv has ${a}`);
    assert.equal(argv[argv.length - 1], '-', 'the prompt on stdin');
    assert.match(fs.readFileSync(stdin, 'utf8'), /Reply only with the JSON[\s\S]*Extract a knowledge graph from these notes\./);
    const rows = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.feature === 'graph:semantic');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, 'codex');
    assert.equal(rows[0].inputTokens, 1200);
  } finally {
    for (const k of ['FAKE_ARGS', 'FAKE_CODEX_STDIN', 'FAKE_CODEX_REPLY']) delete process.env[k];
  }
});

test('a semantic daily cap of 0 means no spend (spec 2026-09-24-aos-config D10), even with nothing spent today', () => {
  fs.rmSync(SPEND_PATH, { force: true });
  assert.deepEqual(skip(scfg({ perDayUsd: 0 }), { force: true }), { status: 'skipped', reason: 'graph budget reached' });
  assert.equal(skip(scfg({ perDayUsd: 'x' }), { force: true }), null, 'a non-numeric cap takes the $1 default');
});
