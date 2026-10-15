'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The vault must exist BEFORE paths.js loads (pipeline-report.js resolves PATHS.INDEX at require time).
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-vault-'));
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
fs.mkdirSync(path.join(VAULT, 'brain', 'routines'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
process.env.BRAIN_VAULT = VAULT;
delete process.env.AOS_VAULT;

const store = require('../lib/routines-store.js');
const { withReport, readLedgerFile } = require('../lib/pipeline-report.js');
const { parseClaudeJson, rowFrom } = require('../persona/record-spend.js');
const { runRoutine, promptArgs } = require('../routines/run-routine.js');

const ROUTINES = path.join(VAULT, 'brain', 'routines');
const STATE = path.join(VAULT, 'brain', '_index', 'routines.json');
const LOGS = path.join(VAULT, 'logs');

const base = { schema: 1, name: 'T', schedule: '0 9 * * *', enabled: true };
function put(slug, extra, body = '') { store.write({ slug, ...base, ...extra, body }, { dir: ROUTINES }); }

/** Injected deps: a scripted spawn, an in-memory ledger, a fixed clock. */
function deps(over = {}) {
  const calls = [];
  const ledger = [];
  let t = new Date('2026-09-21T13:00:00.000Z').getTime();
  const d = {
    vault: VAULT,
    store: { read: (slug) => store.read(slug, { dir: ROUTINES }), patchState: (slug, m) => store.patchState(slug, m, { file: STATE }) },
    config: () => ({ claude: { model: 'haiku' }, routines: { enabled: true, perRunUsd: 2, perDayUsd: 6, tools: 'Read,Glob' } }),
    withReport,
    spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: 'ok\n', stderr: '' }; },
    recordSpend: (row) => { ledger.push(row); return row; },
    routineSpendToday: () => ledger.reduce((s, r) => s + r.usd, 0),
    claudeBin: () => '/fake/claude',
    parseClaudeJson, rowFrom,
    now: () => new Date((t += 1500)),
    env: { PATH: '/usr/bin:/bin', HOME: VAULT, CLAUDECODE: '1' },
    logDir: LOGS,
    out: '', err: '',
    stdout(s) { d.out += s; },
    stderr(s) { d.err += s; },
    calls, ledger,
    ...over,
  };
  return d;
}
const state = () => store.readState({ file: STATE });

beforeEach(() => {
  for (const f of fs.readdirSync(ROUTINES)) fs.unlinkSync(path.join(ROUTINES, f));
  try { fs.unlinkSync(STATE); } catch {}
  fs.rmSync(LOGS, { recursive: true, force: true });
});

test('unknown or invalid slug → exit 2, nothing recorded', async () => {
  const d = deps();
  assert.equal(await runRoutine('nope', { deps: d }), 2);
  assert.match(d.err, /no routine "nope"/);
  fs.writeFileSync(path.join(ROUTINES, 'broken.md'), '---\nschema: 1\nname: x\nkind: prompt\nschedule: "0 99 * * *"\nenabled: true\n---\nhi\n');
  assert.equal(await runRoutine('broken', { deps: d }), 2);
  assert.match(d.err, /invalid: schedule/);
  assert.deepEqual(state().routines, {});
  assert.equal(d.calls.length, 0);
});

test('disabled routine → exit 0, skip recorded, no spawn', async () => {
  put('off', { kind: 'command', argv: ['true'], enabled: false });
  const d = deps();
  assert.equal(await runRoutine('off', { deps: d }), 0);
  assert.equal(d.calls.length, 0);
  assert.equal(state().routines.off.lastSkipReason, 'routine disabled');
  assert.equal(state().routines.off.lastRunAt, null);
});

test('routines.enabled=false in config is a global kill switch', async () => {
  put('cmd', { kind: 'command', argv: ['true'] });
  const d = deps({ config: () => ({ routines: { enabled: false } }) });
  assert.equal(await runRoutine('cmd', { deps: d }), 0);
  assert.equal(d.calls.length, 0);
  assert.match(state().routines.cmd.lastSkipReason, /disabled in config/);
});

test('command kind: argv spawned directly in the vault, no shell, state + ledger + log written', async () => {
  put('scan', { kind: 'command', argv: ['node', 'brain/scripts/scan-vault.js', '--quiet'], timeoutSec: 30 });
  const d = deps();
  assert.equal(await runRoutine('scan', { deps: d }), 0);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].cmd, 'node');
  assert.deepEqual(d.calls[0].args, ['brain/scripts/scan-vault.js', '--quiet']);
  assert.equal(d.calls[0].opts.cwd, VAULT);
  assert.equal(d.calls[0].opts.timeout, 30_000);
  assert.equal(d.calls[0].opts.shell, undefined);
  const e = state().routines.scan;
  assert.equal(e.lastExit, 0);
  assert.equal(e.failStreak, 0);
  assert.equal(e.lastTrigger, 'scheduled');
  assert.equal(e.lastCostUsd, null);
  assert.equal(e.lastError, null);
  assert.equal(e.lastRunAt, '2026-09-21T13:00:01.500Z');
  assert.equal(e.lastDurationMs, 1500);
  const led = readLedgerFile().pipelines['routine:scan'].lastRun;
  assert.equal(led.status, 'ok');
  assert.equal(led.provider, 'local');
  const log = fs.readFileSync(path.join(LOGS, 'routine-scan.log'), 'utf8');
  assert.match(log, /^\[2026-09-21T13:00:01\.500Z\] routine=scan kind=command trigger=scheduled exit=0\nok\n$/);
});

test('failure: non-zero exit mirrored, failStreak increments then resets, stderr tail kept, pipelines row is error', async () => {
  put('flaky', { kind: 'command', argv: ['sh', '-c', 'exit 3'] });
  const d = deps({ spawn: () => ({ status: 3, stdout: '', stderr: 'boom\n' }) });
  assert.equal(await runRoutine('flaky', { deps: d }), 3);
  assert.equal(state().routines.flaky.failStreak, 1);
  assert.equal(state().routines.flaky.lastError, 'boom');
  assert.equal(await runRoutine('flaky', { deps: d, trigger: 'manual' }), 3);
  assert.equal(state().routines.flaky.failStreak, 2);
  assert.equal(state().routines.flaky.lastTrigger, 'manual');
  assert.equal(readLedgerFile().pipelines['routine:flaky'].lastRun.status, 'error');
  assert.match(d.err, /flaky failed \(exit 3\): boom/);
  const ok = deps();
  assert.equal(await runRoutine('flaky', { deps: ok }), 0);
  assert.equal(state().routines.flaky.failStreak, 0);
  assert.equal(state().routines.flaky.lastError, null);
});

test('missing binary → 127; timeout signal → 124 with a timed-out message', async () => {
  put('gone', { kind: 'command', argv: ['no-such-binary-xyz'] });
  const enoent = Object.assign(new Error('spawn no-such-binary-xyz ENOENT'), { code: 'ENOENT' });
  assert.equal(await runRoutine('gone', { deps: deps({ spawn: () => ({ status: null, stdout: '', stderr: '', error: enoent }) }) }), 127);
  put('slow', { kind: 'command', argv: ['sleep', '99'], timeoutSec: 5 });
  assert.equal(await runRoutine('slow', { deps: deps({ spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }) }) }), 124);
  assert.equal(state().routines.slow.lastError, 'timed out after 5s');
});

test('duty kind: delegates to run-duty.sh with the inherited env, ledgered as persona', async () => {
  put('monitor', { kind: 'duty', guarded: true });
  const d = deps();
  assert.equal(await runRoutine('monitor', { deps: d }), 0);
  assert.equal(d.calls[0].cmd, 'sh');
  assert.deepEqual(d.calls[0].args, [path.join(VAULT, 'brain', 'scripts', 'persona', 'run-duty.sh'), 'monitor']);
  assert.equal(d.calls[0].opts.env.CLAUDECODE, '1', 'duty env is passed through untouched (run-duty.sh does its own unset)');
  assert.equal(d.calls[0].opts.env.AOS_HEADLESS, undefined);
  assert.equal(readLedgerFile().pipelines['routine:monitor'].lastRun.provider, 'persona');
  assert.equal(d.ledger.length, 0, 'the duty runner ledgers its own duty:* row');
  assert.equal(d.calls[0].opts.env.PERSONA_MAX_USD, undefined, 'no budgetUsd → the runner\'s own default');
  assert.equal(d.calls[0].opts.env.PERSONA_TOOLS, undefined);
  assert.equal(d.calls[0].opts.env.PERSONA_MODEL, undefined, 'no model → the schedule\'s PERSONA_MODEL');
  assert.equal(d.calls[0].opts.env.PERSONA_EFFORT, undefined);
});

// Spec 2026-09-22-persona-reflect-daily-design D7: the tick starts the daily reflect early through this entrypoint; the
// trigger is recorded so `aos routines list` can tell an early run from the 22:00 one.
test('duty kind: the early trigger (tick-started reflect) is recorded, and main() maps --early to it', async () => {
  put('reflect-daily', { kind: 'duty', guarded: true, budgetUsd: 0.5 });
  const d = deps();
  assert.equal(await runRoutine('reflect-daily', { deps: d, trigger: 'early' }), 0);
  assert.equal(state().routines['reflect-daily'].lastTrigger, 'early');
  assert.equal(d.calls[0].opts.env.PERSONA_MAX_USD, '0.5');
  assert.ok(require('../routines/run-routine.js').TRIGGERS.includes('early'));
  assert.equal(await runRoutine('reflect-daily', { deps: deps(), trigger: 'bogus' }), 0);
  assert.equal(state().routines['reflect-daily'].lastTrigger, 'scheduled', 'an unknown trigger still falls back');
});

test('duty kind: budgetUsd and tools in the routine file reach run-duty.sh as PERSONA_MAX_USD and PERSONA_TOOLS, placeholders expanded', async () => {
  put('tick', { kind: 'duty', guarded: true, budgetUsd: 0.05, tools: 'Read,Glob,Bash({{NODE}} {{VAULT}}/brain/scripts/persona/tick.js:*)' });
  const d = deps();
  assert.equal(await runRoutine('tick', { deps: d }), 0);
  assert.equal(d.calls[0].opts.env.PERSONA_MAX_USD, '0.05');
  assert.equal(d.calls[0].opts.env.PERSONA_TOOLS, `Read,Glob,Bash(${process.execPath} ${VAULT}/brain/scripts/persona/tick.js:*)`);
  assert.equal(d.calls[0].opts.env.CLAUDECODE, '1', 'the rest of the env is still passed through');
});

test('duty kind: writes in the routine file reach run-duty.sh as PERSONA_WRITES (spec 2026-09-23-duty-write-scope-design D5)', async () => {
  put('sitrep', { kind: 'duty', writes: ['notes/inbox/', 'TODO.md'] });
  const d = deps();
  assert.equal(await runRoutine('sitrep', { deps: d }), 0);
  assert.equal(d.calls[0].opts.env.PERSONA_WRITES, 'notes/inbox/,TODO.md');
});

test('duty kind: model and effort in the routine file override the schedule\'s PERSONA_MODEL and PERSONA_EFFORT (spec 2026-09-24-duty-model-settings-design D1)', async () => {
  put('reflect', { kind: 'duty', guarded: true, model: 'sonnet', effort: 'high' });
  const d = deps({ env: { PATH: '/usr/bin:/bin', HOME: VAULT, PERSONA_MODEL: 'haiku', PERSONA_EFFORT: 'medium' } });
  assert.equal(await runRoutine('reflect', { deps: d }), 0);
  assert.equal(d.calls[0].opts.env.PERSONA_MODEL, 'sonnet');
  assert.equal(d.calls[0].opts.env.PERSONA_EFFORT, 'high');
  put('tick', { kind: 'duty', guarded: true, effort: 'low' });
  const t = deps({ env: { PATH: '/usr/bin:/bin', HOME: VAULT, PERSONA_MODEL: 'haiku', PERSONA_EFFORT: 'medium' } });
  assert.equal(await runRoutine('tick', { deps: t }), 0);
  assert.equal(t.calls[0].opts.env.PERSONA_MODEL, 'haiku', 'a key the routine leaves out keeps the schedule\'s value');
  assert.equal(t.calls[0].opts.env.PERSONA_EFFORT, 'low');
});

test('prompt kind: claude -p argv, headless env, ledger row routine:<slug>, cost recorded', async () => {
  put('brief', { kind: 'prompt', model: 'sonnet', effort: 'low', budgetUsd: 0.5 }, 'Write the brief.\n');
  const json = JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.0421, usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 900 });
  const d = deps({ spawn: (cmd, args, opts) => { d.calls.push({ cmd, args, opts }); return { status: 0, stdout: `noise\n${json}\n`, stderr: '' }; } });
  assert.equal(await runRoutine('brief', { deps: d }), 0);
  const c = d.calls[0];
  assert.equal(c.cmd, '/fake/claude');
  assert.deepEqual(c.args, ['-p', 'Write the brief.\n', '--model', 'sonnet', '--effort', 'low', '--allowedTools', 'Read,Glob',
    '--max-budget-usd', '0.5', '--output-format', 'json', '--strict-mcp-config', '--no-session-persistence']);
  assert.equal(c.opts.env.AOS_HEADLESS, '1');
  assert.equal(c.opts.env.CLAUDECODE, undefined);
  assert.equal(c.opts.cwd, VAULT);
  assert.equal(d.ledger.length, 1);
  assert.equal(d.ledger[0].feature, 'routine:brief');
  assert.equal(d.ledger[0].model, 'sonnet');
  assert.equal(d.ledger[0].usd, 0.0421);
  assert.equal(state().routines.brief.lastCostUsd, 0.0421);
  assert.equal(readLedgerFile().pipelines['routine:brief'].lastRun.counts.usd, 0.0421);
});

test('prompt kind: defaults come from config (claude.model, routines.perRunUsd, routines.tools)', () => {
  const args = promptArgs({ body: 'b' }, { claude: { model: 'haiku' }, routines: { perRunUsd: 1.25, tools: 'Read' } });
  assert.deepEqual(args.slice(0, 9), ['-p', 'b', '--model', 'haiku', '--effort', 'medium', '--allowedTools', 'Read', '--max-budget-usd']);
  assert.equal(args[9], '1.25');
  assert.equal(promptArgs({ body: 'b' }, {})[3], 'haiku');
  assert.equal(promptArgs({ body: 'b' }, {})[7], 'Read,Glob,Grep');
});

test('prompt kind: the daily cap trips on routine:* spend only and skips without spawning', async () => {
  put('brief', { kind: 'prompt' }, 'x');
  const d = deps({ routineSpendToday: () => 6.0 });
  assert.equal(await runRoutine('brief', { deps: d }), 0);
  assert.equal(d.calls.length, 0);
  assert.match(state().routines.brief.lastSkipReason, /daily cap reached \(6\.00 of 6 USD\)/);
  const under = deps({ routineSpendToday: () => 5.99, spawn: (cmd, args) => { under.calls.push({ cmd, args }); return { status: 0, stdout: '{}', stderr: '' }; } });
  assert.equal(await runRoutine('brief', { deps: under }), 0);
  assert.equal(under.calls.length, 1);
});

test('prompt kind: no claude binary → exit 1 with a clear message; is_error result → exit 1', async () => {
  put('brief', { kind: 'prompt' }, 'x');
  const d = deps({ claudeBin: () => null });
  assert.equal(await runRoutine('brief', { deps: d }), 1);
  assert.match(d.err, /no runner for prompt routines \(claude CLI not found\)/);
  const bad = JSON.stringify({ type: 'result', is_error: true, result: 'budget exceeded', total_cost_usd: 0.01 });
  const e = deps({ spawn: () => ({ status: 0, stdout: bad, stderr: '' }) });
  assert.equal(await runRoutine('brief', { deps: e }), 1);
  assert.equal(state().routines.brief.lastError, 'budget exceeded');
  assert.equal(state().routines.brief.failStreak, 1);
});

test('--dry-run prints the invocation and executes nothing; the prompt body is elided', async () => {
  put('brief', { kind: 'prompt' }, 'secret body');
  const d = deps();
  assert.equal(await runRoutine('brief', { deps: d, dryRun: true }), 0);
  assert.equal(d.calls.length, 0);
  assert.match(d.out, /^\/fake\/claude\n-p\n<brief body>\n--model\nhaiku\n/);
  assert.ok(!d.out.includes('secret body'));
  assert.deepEqual(state().routines, {});
});

test('command kind: {{NODE}} and {{VAULT}} in argv expand to this node and the vault; anything else stays literal', async () => {
  put('wd', { kind: 'command', argv: ['{{NODE}}', '{{VAULT}}/brain/scripts/persona/watchdog.js', '--keep-{{X}}'] });
  const d = deps();
  assert.equal(await runRoutine('wd', { dryRun: true, deps: d }), 0);
  assert.equal(d.out, `${process.execPath}\n${VAULT}/brain/scripts/persona/watchdog.js\n--keep-{{X}}\n`);
  const d2 = deps({ node: '/opt/n/bin/node' });
  assert.equal(await runRoutine('wd', { deps: d2 }), 0);
  assert.equal(d2.calls[0].cmd, '/opt/n/bin/node');
  assert.deepEqual(d2.calls[0].args, [`${VAULT}/brain/scripts/persona/watchdog.js`, '--keep-{{X}}']);
  assert.equal(d2.calls[0].opts.cwd, VAULT);
});

test('codex runner: the body goes on stdin, the spend is estimated from the event stream, dry-run shows the argv (codex-parity D4/D5)', async () => {
  put('cx', { kind: 'prompt', effort: 'high' }, 'Summarise the vault.');
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 500 } }),
  ].join('\n') + '\n';
  process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-codex-home-'));
  const { rowFromCodex, parseCodexEvents } = require('../persona/record-spend.js');
  const d = deps({
    runner: (cfg) => ({ host: 'codex', bin: '/fake/codex', model: cfg.codex && cfg.codex.model || null, reason: 'auto' }),
    config: () => ({ claude: { model: 'haiku' }, codex: { model: 'gpt-5-mini' }, routines: { enabled: true, perRunUsd: 2, perDayUsd: 6, tools: 'Read,Glob' } }),
    spawn: (cmd, args, opts) => { d.calls.push({ cmd, args, opts }); return { status: 0, stdout: events, stderr: '' }; },
    rowFromCodex, parseCodexEvents,
  });
  assert.equal(await runRoutine('cx', { deps: d, dryRun: true }), 0);
  assert.match(d.out, /^\/fake\/codex\nexec\n-\n--skip-git-repo-check\n--ephemeral\n-s\nworkspace-write\n-c\nfeatures\.hooks=false\n--json\n-o\n.*aos-routine-cx-.*\n-m\ngpt-5-mini\n-c\nmodel_reasoning_effort="high"\n<cx body on stdin>\n$/);
  assert.equal(d.calls.length, 0);
  assert.equal(await runRoutine('cx', { deps: d }), 0);
  assert.equal(d.calls.length, 1);
  const c = d.calls[0];
  assert.equal(c.cmd, '/fake/codex');
  assert.equal(c.opts.input, 'Summarise the vault.\n');
  assert.equal(c.opts.stdio[0], 'pipe');
  assert.equal(c.opts.env.AOS_HEADLESS, '1');
  assert.equal(c.opts.env.CLAUDECODE, undefined);
  assert.ok(!c.args.includes('--allowedTools') && !c.args.includes('--max-budget-usd'), 'no Claude-only flags reach codex');
  assert.equal(d.ledger.length, 1);
  assert.equal(d.ledger[0].provider, 'codex');
  assert.equal(d.ledger[0].model, 'gpt-5-mini');
  assert.equal(d.ledger[0].inputTokens, 1000);
  assert.ok(d.ledger[0].usd > 0, 'priced from the usage block');
  assert.equal(state().routines.cx.lastExit, 0);
  assert.equal(state().routines.cx.lastCostUsd, d.ledger[0].usd);
  assert.equal(readLedgerFile().pipelines['routine:cx'].lastRun.provider, 'codex');
  // a failed turn: the error text from the stream becomes lastError
  const bad = deps({
    runner: () => ({ host: 'codex', bin: '/fake/codex', model: null, reason: 'auto' }),
    spawn: () => ({ status: 1, stdout: JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }) + '\n', stderr: '' }),
    rowFromCodex, parseCodexEvents,
  });
  assert.equal(await runRoutine('cx', { deps: bad }), 1);
  assert.equal(state().routines.cx.lastError, 'quota exceeded');
  assert.equal(bad.ledger[0].usd, 0);
  assert.equal(bad.ledger[0].model, 'codex-default');
});

// ── local-first A6/A7: a prompt routine that names its engine ──

const { resolveRunner } = require('../lib/headless.js');
const BINS = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bins-'));
const fakeBin = (name) => { const p = path.join(BINS, name); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p; };
const CLAUDE_BIN = fakeBin('claude');
const CODEX_BIN = fakeBin('codex');
const HOSTS = {
  claude: { claude: { enabled: true, bin: CLAUDE_BIN }, codex: { enabled: false, bin: CODEX_BIN } },
  codex: { claude: { enabled: false, bin: CLAUDE_BIN }, codex: { enabled: true, bin: CODEX_BIN } },
  both: { claude: { enabled: true, bin: CLAUDE_BIN }, codex: { enabled: true, bin: CODEX_BIN } },
  none: { claude: { enabled: false }, codex: { enabled: false } },
};
/** deps on a machine with these hosts, the real runner resolution over fake binaries. */
function hostDeps(mode, over = {}) {
  const cfg = { claude: { model: 'haiku' }, hosts: HOSTS[mode], routines: { enabled: true, perRunUsd: 2, perDayUsd: 6, tools: 'Read,Glob', ...(over.routines || {}) } };
  const { rowFromCodex, parseCodexEvents } = require('../persona/record-spend.js');
  return deps({
    config: () => cfg,
    runner: (c, host) => resolveRunner({ cfg: c, kind: 'routines', env: { PATH: '/usr/bin:/bin' }, lookup: () => null, candidates: false, host }),
    rowFromCodex, parseCodexEvents,
    ...over.deps,
  });
}
const localOk = { ok: true, reason: 'local-ready', lc: { engine: 'ollama', url: 'http://127.0.0.1:11434' }, model: 'qwen3.5:9b' };
const agentResult = (over = {}) => ({ status: 'ok', final: 'Wrote the digest.', error: null, turns: 3, toolCalls: 4, wrote: ['notes/d.md'], refused: [], journal: ['turn 1: list_files notes → ok (12 chars)'], engine: 'ollama', model: 'qwen3.5:9b', usage: { inputTokens: 900, outputTokens: 90 }, ms: 4200, ...over });

test('engine local: the local agent runs in process — one $0 ollama ledger row, the journal and the final message in the log, no cap', async () => {
  put('digest', { kind: 'prompt', engine: 'local', writes: ['notes/'], maxTurns: 6, timeoutSec: 60 }, 'Digest the notes.');
  let got = null;
  const d = hostDeps('none', { deps: {
    routineSpendToday: () => 99,   // the prompt cap is for hosted spend: a local run is never capped
    resolveLocal: async (cfg, model) => { assert.equal(model, null); return localOk; },
    localAgent: async (opts) => { got = opts; return agentResult(); },
  } });
  assert.equal(await runRoutine('digest', { deps: d }), 0);
  assert.equal(d.calls.length, 0, 'nothing spawned');
  assert.equal(got.routine.slug, 'digest');
  assert.equal(got.model, 'qwen3.5:9b');
  assert.equal(got.timeoutMs, 60_000);
  assert.equal(got.vault, VAULT);
  assert.deepEqual(d.ledger, [{ feature: 'routine:digest', provider: 'ollama', model: 'qwen3.5:9b', usd: 0, inputTokens: 900, outputTokens: 90, ms: 4200 }]);
  const e = state().routines.digest;
  assert.deepEqual([e.lastExit, e.lastCostUsd, e.lastError, e.failStreak], [0, 0, null, 0]);
  const led = readLedgerFile().pipelines['routine:digest'].lastRun;
  assert.equal(led.provider, 'ollama');
  assert.deepEqual([led.counts.turns, led.counts.tools, led.counts.usd], [3, 4, 0]);
  const log = fs.readFileSync(path.join(LOGS, 'routine-digest.log'), 'utf8');
  assert.match(log, /^\[[^\]]+\] routine=digest kind=prompt engine=local trigger=scheduled exit=0 usd=0\nengine=ollama model=qwen3\.5:9b turns=3 tools=4 wrote=notes\/d\.md\nturn 1: list_files notes → ok \(12 chars\)\n--- final ---\nWrote the digest\.\n$/);
});

test('engine local: the engine down or the model not pulled is a skip with reason local-down — nothing run, spent or ledgered', async () => {
  put('digest', { kind: 'prompt', engine: 'local', model: 'qwen3.5:4b' }, 'x');
  let asked = null;
  const d = hostDeps('both', { deps: {
    resolveLocal: async (cfg, model) => { asked = model; return { ok: false, reason: 'local-down', detail: 'qwen3.5:4b is not pulled on Ollama at http://127.0.0.1:11434 (aos local pull qwen3.5:4b)' }; },
    localAgent: async () => { throw new Error('must not run'); },
  } });
  assert.equal(await runRoutine('digest', { deps: d }), 0);
  assert.equal(asked, 'qwen3.5:4b');
  assert.equal(d.calls.length, 0, 'never the hosts instead');
  assert.deepEqual(d.ledger, []);
  const e = state().routines.digest;
  assert.equal(e.lastRunAt, null, 'not a run: the next fire retries');
  assert.equal(e.lastSkipReason, 'local-down: qwen3.5:4b is not pulled on Ollama at http://127.0.0.1:11434 (aos local pull qwen3.5:4b)');
  assert.match(d.out, /digest skipped — local-down: /);
});

test('engine local: a failed or timed-out agent run is a failed routine with its reason (exit 1 / 124)', async () => {
  put('digest', { kind: 'prompt', engine: 'local' }, 'x');
  const fail = hostDeps('claude', { deps: { resolveLocal: async () => localOk, localAgent: async () => agentResult({ status: 'error', final: null, error: 'stopped after 24 turns without a final answer (maxTurns)' }) } });
  assert.equal(await runRoutine('digest', { deps: fail }), 1);
  assert.equal(state().routines.digest.lastError, 'stopped after 24 turns without a final answer (maxTurns)');
  assert.equal(state().routines.digest.failStreak, 1);
  assert.equal(readLedgerFile().pipelines['routine:digest'].lastRun.status, 'error');
  assert.equal(fail.ledger[0].usd, 0, 'still one $0 row: the run happened');
  const slow = hostDeps('claude', { deps: { resolveLocal: async () => localOk, localAgent: async () => agentResult({ status: 'timeout', final: null, error: 'timed out after 60s' }) } });
  assert.equal(await runRoutine('digest', { deps: slow }), 124);
  assert.equal(state().routines.digest.lastError, 'timed out after 60s');
  assert.match(fs.readFileSync(path.join(LOGS, 'routine-digest.log'), 'utf8'), /--- error ---\ntimed out after 60s\n$/);
});

test('engine local: --dry-run names the engine, the model and the limits without asking the engine', async () => {
  put('digest', { kind: 'prompt', engine: 'local', model: 'qwen3.5:4b', writes: ['notes/', 'TODO.md'] }, 'secret body');
  const d = hostDeps('none', { deps: { resolveLocal: async () => { throw new Error('no probe on a dry run'); } } });
  assert.equal(await runRoutine('digest', { deps: d, dryRun: true }), 0);
  assert.equal(d.out, 'local-agent\nengine=ollama\nurl=http://127.0.0.1:11434\nmodel=qwen3.5:4b\nmaxTurns=24\nwrites=notes/,TODO.md\n<digest body>\n');
  assert.deepEqual(state().routines, {});
});

test('engine claude / codex: that host on every machine that has it; a routine without engine keeps routines.runner', async () => {
  // both hosts, routines.runner codex: engine claude still runs claude, with its Claude model
  put('cl', { kind: 'prompt', engine: 'claude', model: 'sonnet' }, 'x');
  const a = hostDeps('both', { routines: { runner: 'codex' } });
  assert.equal(await runRoutine('cl', { deps: a, dryRun: true }), 0);
  assert.match(a.out, new RegExp(`^${CLAUDE_BIN}\\n-p\\n<cl body>\\n--model\\nsonnet\\n`));
  // both hosts: engine codex runs codex with the routine's own Codex model
  put('cx', { kind: 'prompt', engine: 'codex', model: 'gpt-6-sol', effort: 'low' }, 'x');
  const b = hostDeps('both');
  assert.equal(await runRoutine('cx', { deps: b, dryRun: true }), 0);
  assert.match(b.out, new RegExp(`^${CODEX_BIN}\\nexec\\n-\\n[\\s\\S]*\\n-m\\ngpt-6-sol\\n-c\\nmodel_reasoning_effort="low"\\n<cx body on stdin>\\n$`));
  // Codex only, no model in the file: routines.codexModel
  const c = hostDeps('codex', { routines: { codexModel: 'gpt-6-luna' } });
  put('cx2', { kind: 'prompt', engine: 'codex' }, 'x');
  assert.equal(await runRoutine('cx2', { deps: c, dryRun: true }), 0);
  assert.match(c.out, /\n-m\ngpt-6-luna\n/);
  // Claude only, no engine: today's resolution, unchanged
  put('plain', { kind: 'prompt' }, 'x');
  const e = hostDeps('claude');
  assert.equal(await runRoutine('plain', { deps: e, dryRun: true }), 0);
  assert.match(e.out, new RegExp(`^${CLAUDE_BIN}\\n-p\\n<plain body>\\n--model\\nhaiku\\n`));
  // Codex only, no engine: auto falls to codex as before, and the Claude alias never reaches it
  put('plain2', { kind: 'prompt', model: 'opus' }, 'x');
  const f = hostDeps('codex');
  assert.equal(await runRoutine('plain2', { deps: f, dryRun: true }), 0);
  assert.match(f.out, new RegExp(`^${CODEX_BIN}\\nexec\\n`));
  assert.ok(!f.out.includes('opus'));
});

test('engine claude / codex on a machine without that host: a failed run naming it — never the other host', async () => {
  put('cl', { kind: 'prompt', engine: 'claude' }, 'x');
  const codexOnly = hostDeps('codex');
  assert.equal(await runRoutine('cl', { deps: codexOnly }), 1);
  assert.equal(codexOnly.calls.length, 0, 'codex was not used instead');
  const e = state().routines.cl;
  assert.equal(e.lastExit, 1);
  assert.equal(e.lastError, 'engine claude: claude is not an enabled host — add it (aos hosts add claude) or pick another engine');
  assert.equal(readLedgerFile().pipelines['routine:cl'].lastRun.provider, 'claude');
  assert.equal(readLedgerFile().pipelines['routine:cl'].lastRun.status, 'error');
  assert.match(fs.readFileSync(path.join(LOGS, 'routine-cl.log'), 'utf8'), /routine=cl kind=prompt engine=claude trigger=scheduled exit=1\nengine claude: claude is not an enabled host/);
  put('cx', { kind: 'prompt', engine: 'codex' }, 'x');
  const claudeOnly = hostDeps('claude');
  assert.equal(await runRoutine('cx', { deps: claudeOnly }), 1);
  assert.equal(claudeOnly.calls.length, 0);
  assert.match(state().routines.cx.lastError, /^engine codex: codex is not an enabled host/);
  const noHost = hostDeps('none');
  assert.equal(await runRoutine('cx', { deps: noHost, dryRun: true }), 1);
  assert.match(noHost.out, /cx cannot run — engine codex: codex is not an enabled host/);
  // enabled, but the CLI is gone
  const gone = hostDeps('both', { deps: { runner: (c, host) => resolveRunner({ cfg: { ...c, hosts: { ...HOSTS.both, codex: { enabled: true, bin: '/nowhere/codex' } } }, kind: 'routines', env: { PATH: '/usr/bin:/bin' }, lookup: () => null, candidates: false, host }) } });
  assert.equal(await runRoutine('cx', { deps: gone }), 1);
  assert.equal(gone.calls.length, 0);
  assert.equal(state().routines.cx.lastError, 'engine codex: codex CLI not found — install Codex or pick another engine');
});

test('engine local end to end: run-routine → local-agent → a fake Ollama on the loopback interface', async () => {
  const http = require('http');
  const replies = [
    { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'notes/out.md', content: 'hello\n' } } }] }, prompt_eval_count: 10, eval_count: 2 },
    { message: { role: 'assistant', content: 'Wrote notes/out.md.' }, prompt_eval_count: 20, eval_count: 4 },
  ];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'qwen3.5:9b' }] } : replies.shift()));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    put('e2e', { kind: 'prompt', engine: 'local', writes: ['notes/'] }, 'Write hello to notes/out.md.');
    const counts = [];
    const L = require('../lib/local-agent.js');
    const d = hostDeps('none', { deps: {
      config: () => ({ local: { engine: 'ollama', url: `http://127.0.0.1:${srv.address().port}` }, routines: { enabled: true } }),
      resolveLocal: (cfg, model) => L.resolveLocal({ cfg, model }),
      localAgent: (opts) => L.runLocalAgent({ ...opts, deps: { recordLocalCall: (c) => counts.push(c), postNotification: () => ({}) } }),
    } });
    assert.equal(await runRoutine('e2e', { deps: d }), 0);
    assert.equal(fs.readFileSync(path.join(VAULT, 'notes', 'out.md'), 'utf8'), 'hello\n');
    assert.deepEqual(d.ledger.map((r) => [r.provider, r.usd, r.inputTokens, r.outputTokens]), [['ollama', 0, 30, 6]]);
    assert.equal(counts.length, 2);
    assert.match(fs.readFileSync(path.join(LOGS, 'routine-e2e.log'), 'utf8'), /turn 1: write_file notes\/out\.md → ok \(29 chars\)\n--- final ---\nWrote notes\/out\.md\.\n$/);
  } finally {
    srv.close();
    fs.rmSync(path.join(VAULT, 'notes'), { recursive: true, force: true });
  }
});
