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

test('a routine that turns itself off takes its schedule out: aos routines sync --if-installed, last (install-import B10)', async () => {
  put('import-digest', { kind: 'command', argv: ['{{NODE}}', 'digest.js'] });
  const resyncs = [];
  const d = deps({
    // The digest's last run: its queue empty, it writes `enabled: false` into its own routine file.
    spawn: (cmd, args) => { d.calls.push({ cmd, args }); const r = store.read('import-digest', { dir: ROUTINES }); store.write({ ...r, enabled: false }, { dir: ROUTINES }); return { status: 0, stdout: 'import-digest: done, and the routine is off\n', stderr: '' }; },
    resync: (o) => { resyncs.push({ ...o, recorded: !!state().routines['import-digest'] }); return true; },
  });
  d.calls = [];
  assert.equal(await runRoutine('import-digest', { deps: d }), 0);
  assert.equal(resyncs.length, 1);
  assert.equal(resyncs[0].slug, 'import-digest');
  assert.equal(resyncs[0].vault, VAULT);
  assert.equal(resyncs[0].logFile, path.join(LOGS, 'routine-import-digest.log'));
  assert.equal(resyncs[0].recorded, true, 'after the run is recorded: unloading its own schedule may stop this process');
  assert.match(d.out, /import-digest turned itself off; taking its schedule out \(aos routines sync --if-installed\)/);
  // A routine that stays on, or one that was already off (a skip), re-renders nothing.
  put('alpha', { kind: 'command', argv: ['true'] });
  const on = deps({ resync: (o) => { resyncs.push(o); return true; } });
  assert.equal(await runRoutine('alpha', { deps: on }), 0);
  assert.equal(await runRoutine('import-digest', { deps: on }), 0);
  assert.equal(resyncs.length, 1);
  // A resync that could not start says what to run instead.
  put('import-digest', { kind: 'command', argv: ['true'] });
  const failing = deps({
    spawn: () => { const r = store.read('import-digest', { dir: ROUTINES }); store.write({ ...r, enabled: false }, { dir: ROUTINES }); return { status: 0, stdout: '', stderr: '' }; },
    resync: () => { throw new Error('no cli'); },
  });
  assert.equal(await runRoutine('import-digest', { deps: failing }), 0);
  assert.match(failing.out, /turned itself off; run aos routines sync to take its schedule out/);
});

test('resyncSchedules starts `aos routines sync --if-installed` detached, its output in the routine log', () => {
  const { resyncSchedules, cliPath } = require('../routines/run-routine.js');
  assert.equal(cliPath(), path.resolve(__dirname, '..', '..', '..', 'cli', 'aos.js'), 'the checkout\'s CLI (the vault has its vendored copy beside routines/)');
  fs.mkdirSync(LOGS, { recursive: true });
  const logFile = path.join(LOGS, 'routine-x.log');
  const seen = [];
  const child = { on() { return child; }, unref() { seen.push('unref'); } };
  const ok = resyncSchedules({ vault: VAULT, env: { PATH: '/usr/bin', HOME: VAULT }, logFile }, (cmd, args, opts) => { seen.push({ cmd, args, opts }); return child; });
  assert.equal(ok, true);
  assert.equal(seen[0].cmd, process.execPath);
  assert.deepEqual(seen[0].args, [cliPath(), 'routines', 'sync', '--if-installed']);
  assert.equal(seen[0].opts.detached, true);
  assert.equal(seen[0].opts.cwd, VAULT);
  assert.equal(seen[0].opts.env.AOS_VAULT, VAULT);
  assert.equal(typeof seen[0].opts.stdio[1], 'number', 'stdout to the routine log');
  assert.equal(seen[1], 'unref');
  assert.ok(fs.existsSync(logFile));
});
