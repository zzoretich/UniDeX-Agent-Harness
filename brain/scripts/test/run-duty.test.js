'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'persona', 'run-duty.sh');
// local-first A4: run-duty.sh asks persona/chief.js, which checks the claude CLI is signed in (`claude auth status --json`,
// free) before a duty starts. Every fake claude answers it first; FAKE_SIGNED_OUT=1 makes it report no login.
const FAKE_AUTH = '[ "$1" = auth ] && { [ -n "${FAKE_SIGNED_OUT:-}" ] && echo \'{"loggedIn":false}\' || echo \'{"loggedIn":true}\'; exit 0; }';

/** A vault with one duty, a STATE.md and a fake `claude` that prints a result JSON and
 *  journals only when FAKE_JOURNAL is set. Never touches the real claude binary. */
function sandbox() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'persona', 'duties'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'persona', 'duties', 'testduty.md'), 'ascii fixture duty\n');
  fs.writeFileSync(path.join(vault, 'persona', 'IDENTITY.md'), '# Atlas\n');
  fs.writeFileSync(path.join(vault, 'persona', 'STATE.md'), '# Persona State\n## Flags\n## Priorities\n');
  const fake = path.join(vault, 'fake-claude');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    FAKE_AUTH,
    '[ -n "${FAKE_ARGS:-}" ] && printf "%s\\n" "$@" > "$FAKE_ARGS"',
    '[ -n "${FAKE_JOURNAL:-}" ] && { mkdir -p "$(dirname "$FAKE_JOURNAL")"; printf "\\n## 09:00 — duty: testduty\\n- status: OK\\n" >> "$FAKE_JOURNAL"; }',
    '[ -n "${FAKE_TAMPER:-}" ] && { mkdir -p "$(dirname "$FAKE_TAMPER")"; echo tampered >> "$FAKE_TAMPER"; }',
    'echo "{\\"type\\":\\"result\\",\\"result\\":\\"done\\",\\"total_cost_usd\\":0.0123,\\"usage\\":{\\"input_tokens\\":10,\\"output_tokens\\":5},\\"duration_ms\\":100}"',
    '',
  ].join('\n'), { mode: 0o755 });
  const logDir = path.join(vault, 'logs');
  const env = {
    ...process.env,
    AOS_VAULT: vault,
    AOS_CONFIG: path.join(vault, 'no-agenticos.json'),
    AOS_NODE: process.execPath,
    PERSONA_CLAUDE_BIN: fake,
    PERSONA_LOG_DIR: logDir,
    PERSONA_TIMEOUT: '20',
  };
  delete env.AOS_HEADLESS;
  // execution amendment 2026-09-15 (A5): the runner names the journal by the LOCAL day (`date +%Y-%m-%d`), so the
  // test must too — toISOString() is UTC and disagrees for the last hours of every local day (4/7 red each evening).
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { vault, env, logDir, journal: path.join(vault, 'persona', 'journal', `${day}.md`) };
}
// final review Minor 14 (tests-8): a hung runner must fail the test, not hang the lane. 60 s is ~60× the
// slowest real sub-run here (the 1 s PERSONA_TIMEOUT watchdog case), so it can never fire on a green run.
function run(args, env) { return spawnSync('sh', [RUNNER, ...args], { env, encoding: 'utf8', timeout: 60000 }); }

test('dry-run prints the invocation (binary, model, effort, tools, budget, json output, MCP/session flags) and executes nothing', () => {
  const s = sandbox();
  const r = run(['testduty', '--dry-run'], s.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--model\nclaude-opus-5-5$/m, 'local-first A4: the Chief of Staff model by default');
  assert.match(r.stdout, /^--effort\nmedium$/m);
  assert.match(r.stdout, /^--allowedTools$/m);
  assert.match(r.stdout, /^--max-budget-usd\n2$/m, 'perDutyUsd default without a --check run');
  assert.match(r.stdout, /^--append-system-prompt$/m);
  assert.match(r.stdout, /brain\/scripts\/persona\/ledger\.js:\*\)/, 'duties may append to the proposal ledger');
  assert.match(r.stdout, /brain\/scripts\/persona\/reflect\.js:\*\)/, 'the weekly reflect (no tools: in its routine file) may read the evidence pack');
  assert.match(r.stdout, /^--strict-mcp-config$/m);          // execution amendment 2026-09-15 (A25)
  assert.match(r.stdout, /^--no-session-persistence$/m);     // execution amendment 2026-09-15 (A25)
  assert.ok(!r.stdout.includes('bypassPermissions'));
  assert.ok(!r.stdout.includes('Bash(git:*)'), 'git is scoped to status/log/diff — never push');   // execution amendment 2026-09-15 (A26)
  assert.ok(!r.stdout.includes('Bash(git add') && !r.stdout.includes('Bash(git commit'), 'a duty never commits — docs/chief-of-staff.md');   // final review F3/safety-5
  assert.ok(!fs.existsSync(s.logDir), 'dry-run writes no logs');
  // execution amendment 2026-09-15 (A24): without PERSONA_CLAUDE_BIN the runner takes agenticos.json's claude.bin
  // (contract §2 addendum) before the PATH lookup; the first printed line is the resolved binary.
  const cfg = path.join(s.vault, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ vault: s.vault, claude: { model: 'haiku', bin: s.env.PERSONA_CLAUDE_BIN } }, null, 2));
  // final review F8/spec-7 ([ledger:147] ii): PATH/HOME are pinned so that if the PERSONA_CLAUDE_BIN guard
  // ever regressed, this sub-run could not resolve the developer's real `claude` and make a live billed call.
  const viaCfg = { ...s.env, AOS_CONFIG: cfg, PATH: '/usr/bin:/bin', HOME: s.vault }; delete viaCfg.PERSONA_CLAUDE_BIN;
  assert.equal(run(['testduty', '--dry-run'], viaCfg).stdout.split('\n')[0], s.env.PERSONA_CLAUDE_BIN, 'claude.bin from agenticos.json is honored before the PATH lookup');
  // A pre-2.0 vault's persona.model is an explicit null: it keeps the model it ran on (claude.model), never a flat scan of
  // agenticos.json for the first "model" key.
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ persona: { model: null }, reasoner: { model: 'claude-opus-5' } }));
  assert.match(run(['testduty', '--dry-run'], viaCfg).stdout, /^--model\nhaiku$/m, 'null persona.model → claude.model');
  fs.writeFileSync(path.join(s.vault, 'persona', 'answers.json'), JSON.stringify({ name: 'Atlas', dutyModel: 'sonnet' }));
  assert.match(run(['testduty', '--dry-run'], viaCfg).stdout, /^--model\nsonnet$/m, 'the interview answer comes before claude.model');
});

test('PERSONA_MODEL, PERSONA_EFFORT and PERSONA_MAX_USD override the defaults', () => {
  const s = sandbox();
  const r = run(['testduty', '--dry-run'], { ...s.env, PERSONA_MODEL: 'sonnet', PERSONA_EFFORT: 'high', PERSONA_MAX_USD: '0.5' });
  assert.match(r.stdout, /^--model\nsonnet$/m);
  assert.match(r.stdout, /^--effort\nhigh$/m);
  assert.match(r.stdout, /^--max-budget-usd\n0\.5$/m);
});

test('unknown duty exits 1 with a message; kill switch exits 0 without an invocation', () => {
  const s = sandbox();
  const bad = run(['no-such-duty', '--dry-run'], s.env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown duty 'no-such-duty'/);
  fs.writeFileSync(path.join(s.vault, 'persona', 'DISABLED'), 'x');
  const off = run(['testduty', '--dry-run'], s.env);
  assert.equal(off.status, 0);
  assert.match(off.stdout, /DISABLED/);
  assert.ok(!off.stdout.includes('--model'));
});

// final review Minor 7 (safety-9 = spec-12): the PERSONA_CLAUDE_BIN guard sits BELOW the kill switch and
// the unknown-duty check, so a stale non-executable override cannot turn either of those two exits into a
// misconfiguration failure. A disabled persona must exit 0 no matter what the override points at.
test('the kill switch and the unknown-duty check both outrank a stale non-executable PERSONA_CLAUDE_BIN', () => {
  const s = sandbox();
  const stale = path.join(s.vault, 'stale-claude');
  fs.writeFileSync(stale, '#!/bin/sh\necho should never run\n', { mode: 0o644 });
  // Same PATH/HOME hardening as the sub-runs above (final review F8): if the guard regressed to a
  // fall-through, this sub-run still could not resolve a developer's real `claude`.
  const env = { ...s.env, PERSONA_CLAUDE_BIN: stale, PATH: '/usr/bin:/bin', HOME: s.vault };

  const unknown = run(['no-such-duty', '--dry-run'], env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown duty 'no-such-duty'/);
  assert.ok(!unknown.stderr.includes('not executable'), 'the unknown-duty check runs before the binary guard');

  fs.writeFileSync(path.join(s.vault, 'persona', 'DISABLED'), 'x');
  const off = run(['testduty', '--dry-run'], env);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /DISABLED/);
  assert.ok(!off.stderr.includes('not executable'), 'a disabled persona exits 0 whatever the override points at');
  assert.ok(!off.stdout.includes('--model'), 'nothing is invoked');
});

test('watchdog: a duty that never journals is recorded FAILED, flagged in STATE.md, and its spend is ledgered', () => {
  const s = sandbox();
  const r1 = run(['testduty'], s.env);
  assert.equal(r1.status, 1, r1.stderr);
  assert.match(fs.readFileSync(s.journal, 'utf8'), /- status: FAILED/);
  const state = fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8');
  assert.match(state, /## Flags\n- \[ \] \d{4}-\d{2}-\d{2} duty 'testduty' FAILED/);
  const r2 = run(['testduty'], s.env);
  assert.equal(r2.status, 1);
  const entries = fs.readFileSync(s.journal, 'utf8').match(/duty: testduty/g).length;
  assert.equal(entries, 2, 'the before/after count check catches a same-day repeat failure');
  const ledger = fs.readFileSync(path.join(s.vault, 'brain', '_index', 'provider-spend.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ledger.length, 2);
  const row = JSON.parse(ledger[0]);
  assert.equal(row.feature, 'duty:testduty');
  assert.equal(row.usd, 0.0123);
  assert.match(fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'), /FAILED \(contract unmet\)/);
});

test('a duty that journals succeeds with exit 0', () => {
  const s = sandbox();
  const argsFile = path.join(s.vault, 'claude-args.txt');
  const r = run(['testduty'], { ...s.env, FAKE_JOURNAL: s.journal, FAKE_ARGS: argsFile });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'), /duty=testduty done \(exit 0\)/);
  const args = fs.readFileSync(argsFile, 'utf8');
  assert.match(args, /^--append-system-prompt\nToday is \d{4}-\d{2}-\d{2} \(local time \d{2}:\d{2}\)\. This run's journal file is .*\/persona\/journal\/\d{4}-\d{2}-\d{2}\.md\. Use this date and time for every date you write; timestamps in tool output are UTC\.\n\n# Atlas\n/m, 'the system prompt opens with the date and journal path (a post-midnight duty otherwise journals into yesterday)');
  assert.ok(!fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8').includes('FAILED'));
});

/** A TZ whose local day differs from the UTC day right now: UTC-12 before 12:00 UTC, UTC+14 from then on. */
function offDayTz() {
  const h = new Date().getUTCHours();
  const [tz, offsetH] = h < 12 ? ['Etc/GMT+12', -12] : ['Etc/GMT-14', 14];
  const day = new Date(Date.now() + offsetH * 3600e3).toISOString().slice(0, 10);
  return { tz, day, utcDay: new Date().toISOString().slice(0, 10) };
}

test('the duty prompt arrives with <today YYYY-MM-DD>, <today>, <YYYY-MM-DD> and <HH:MM> filled with the LOCAL day and time', () => {
  const s = sandbox();
  const { tz, day, utcDay } = offDayTz();
  assert.notEqual(day, utcDay);
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'testduty.md'),
    'Append to `journal/<today YYYY-MM-DD>.md`:\n## <HH:MM> — duty: testduty\nSTATE line `<today> OK` · sitrep <YYYY-MM-DD> · keep <date> and <slug>\n');
  const journal = path.join(s.vault, 'persona', 'journal', `${day}.md`);
  const argsFile = path.join(s.vault, 'claude-args.txt');
  const r = run(['testduty'], { ...s.env, TZ: tz, FAKE_JOURNAL: journal, FAKE_ARGS: argsFile });
  assert.equal(r.status, 0, r.stderr);
  const prompt = fs.readFileSync(argsFile, 'utf8').split('\n--model\n')[0];
  assert.ok(prompt.includes(`journal/${day}.md`), 'the journal path names the local day, not the UTC day');
  assert.match(prompt, /^## \d{2}:\d{2} — duty: testduty$/m);
  assert.ok(prompt.includes(`\`${day} OK\``) && prompt.includes(`sitrep ${day}`));
  assert.ok(!/<today|<YYYY-MM-DD>|<HH:MM>/.test(prompt), 'no date placeholder is left for the model to guess');
  assert.ok(prompt.includes('keep <date> and <slug>'), 'other placeholders are left alone');
});

test('an entry filed under the UTC day still meets the contract, with a log line naming the misfiled journal', () => {
  const s = sandbox();
  const { tz, day, utcDay } = offDayTz();
  const utcJournal = path.join(s.vault, 'persona', 'journal', `${utcDay}.md`);
  const r = run(['testduty'], { ...s.env, TZ: tz, FAKE_JOURNAL: utcJournal });
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8');
  assert.match(log, new RegExp(`journal entry landed in .*${utcDay}\\.md \\(the UTC day\\)`));
  assert.match(log, /duty=testduty done \(exit 0\)/);
  assert.ok(!fs.existsSync(path.join(s.vault, 'persona', 'journal', `${day}.md`)), 'no runner FAILED entry in the local journal');
  assert.ok(!fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8').includes('FAILED'));
  // A second run that journals nowhere still fails: the UTC fallback is a before/after delta too.
  const r2 = run(['testduty'], { ...s.env, TZ: tz });
  assert.equal(r2.status, 1);
});

test('the daily duty cap (persona.perDayUsd over duty:* rows) skips the duty with exit 0, a log line and a SKIPPED journal entry', () => {
  const s = sandbox();
  const today = new Date().toISOString();
  fs.writeFileSync(path.join(s.vault, 'brain', '_index', 'provider-spend.jsonl'), [
    JSON.stringify({ ts: today, feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 50, inputTokens: 1, outputTokens: 1, ms: 1 }),  // hook spend: ignored
    JSON.stringify({ ts: today, feature: 'duty:other', provider: 'claude', model: 'haiku', usd: 6, inputTokens: 1, outputTokens: 1, ms: 1 }),        // = perDayUsd (6.0)
    '',
  ].join('\n'));
  const r = run(['testduty'], { ...s.env, FAKE_JOURNAL: s.journal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'), /daily spend cap reached/);
  const journal = fs.readFileSync(s.journal, 'utf8');
  assert.match(journal, /## \d{2}:\d{2} — duty: testduty\n- status: SKIPPED daily-cap/);
  assert.ok(!journal.includes('status: OK'), 'the fake claude never ran');
});

test('hook spend alone never blocks a duty', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'brain', '_index', 'provider-spend.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 50, inputTokens: 1, outputTokens: 1, ms: 1 }) + '\n');
  const r = run(['testduty'], { ...s.env, FAKE_JOURNAL: s.journal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(s.journal, 'utf8'), /- status: OK/);
});

// A49/A50: the watchdog must kill the claude process itself (not a wrapper shell around it), and a SET
// PERSONA_CLAUDE_BIN that is not executable must fail loudly instead of falling through to the PATH lookup.
test('watchdog kills the claude process itself on PERSONA_TIMEOUT; a non-executable PERSONA_CLAUDE_BIN is refused', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'monitor.md'), 'ascii fixture duty\n');
  const pidFile = path.join(s.vault, 'claude.pid');
  const sleeper = path.join(s.vault, 'fake-claude-sleep');
  fs.writeFileSync(sleeper, [
    '#!/bin/sh',
    FAKE_AUTH,
    `echo $$ > "${pidFile}"`,
    'exec sleep 30',
    '',
  ].join('\n'), { mode: 0o755 });

  const isAlive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

  let pid = null;
  try {
    // final review Minor 14 (tests-8): the timing assertion runs INSIDE the try, so a slow runner still
    // reaches the finally below and the `sleep 30` fake is reaped instead of being left running.
    const start = Date.now();
    const r = run(['monitor'], { ...s.env, PERSONA_CLAUDE_BIN: sleeper, PERSONA_TIMEOUT: '1', PATH: '/usr/bin:/bin', HOME: s.vault });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 10000, `runner should return within a few seconds of the 1s timeout, took ${elapsed}ms`);

    assert.ok(fs.existsSync(pidFile), 'the fake claude should have started and recorded its own pid');
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    let alive = isAlive(pid);
    const deadline = Date.now() + 2000;
    while (alive && Date.now() < deadline) alive = isAlive(pid);
    assert.ok(!alive, `claude process ${pid} should be reaped by the watchdog, not orphaned`);

    // No journal entry was written before the timeout killed it: the runner's own duty-contract check
    // treats that as a failure, same as the plain watchdog test above.
    assert.equal(r.status, 1, r.stderr);
    assert.match(fs.readFileSync(s.journal, 'utf8'), /- status: FAILED/);
    assert.match(fs.readFileSync(path.join(s.logDir, 'duty-monitor.log'), 'utf8'), /FAILED \(contract unmet\)/);
  } finally {
    if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }

  fs.rmSync(pidFile, { force: true });
  const notExec = path.join(s.vault, 'not-executable-claude');
  fs.writeFileSync(notExec, '#!/bin/sh\necho should never run\n', { mode: 0o644 });
  // Same hardening as viaCfg above — NOT PATH: '' (that fails `sh` itself with ENOENT and reddens the assertions below).
  const bad = run(['monitor'], { ...s.env, PERSONA_CLAUDE_BIN: notExec, PATH: '/usr/bin:/bin', HOME: s.vault });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not executable/);
  assert.ok(!fs.existsSync(pidFile), 'a misconfigured PERSONA_CLAUDE_BIN must never launch anything');
});

// Spec 2026-09-22-persona-tick-design D3: the tick's helper (persona/tick.js) decides runner-side whether the model
// runs at all. A `precheck` exit 3 skips the run with one log line and no journal entry — and exit 0, so run-routine.js
// still records a run and the watchdog never mistakes an idle hour for a miss. `beat` runs only after the contract passes.
test('tick helper: precheck skips an unchanged vault silently, beat runs after a met contract and not after a failed one', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'tick.md'), 'ascii fixture tick\n');
  // A fake claude that journals the tick entry only when FAKE_JOURNAL is set (the sandbox fake hardcodes testduty).
  const fake = path.join(s.vault, 'fake-tick-claude');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    FAKE_AUTH,
    '[ -n "${FAKE_JOURNAL:-}" ] && { mkdir -p "$(dirname "$FAKE_JOURNAL")"; printf "\\n## 09:00 — duty: tick\\n- status: OK\\n" >> "$FAKE_JOURNAL"; }',
    'echo "{\\"type\\":\\"result\\",\\"result\\":\\"done\\",\\"total_cost_usd\\":0.01,\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1},\\"duration_ms\\":10}"',
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { ...s.env, PERSONA_CLAUDE_BIN: fake };
  const tickState = () => JSON.parse(fs.readFileSync(path.join(s.vault, 'brain', '_index', 'persona-tick.json'), 'utf8'));
  const log = () => fs.readFileSync(path.join(s.logDir, 'duty-tick.log'), 'utf8');

  // 1. first run: a change by definition → the model runs, the contract passes, the beat is recorded
  const r1 = run(['tick'], { ...env, FAKE_JOURNAL: s.journal });
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(log(), /duty=tick done \(exit 0\)/);
  assert.equal(tickState().beats, 1);
  assert.equal(tickState().pending, null);
  assert.equal(fs.readFileSync(s.journal, 'utf8').match(/duty: tick/g).length, 1);

  // 2. nothing changed since the beat → skipped: exit 0, one log line, no new journal entry, no FAILED flag
  const r2 = run(['tick'], { ...env, FAKE_JOURNAL: s.journal });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(log(), /duty=tick skipped: unchanged since the last beat/);
  assert.equal((log().match(/ start$/mg) || []).length, 1, 'the model started once');
  assert.equal(fs.readFileSync(s.journal, 'utf8').match(/duty: tick/g).length, 1, 'a skip writes no journal entry');
  assert.equal(tickState().skipped, 1);
  assert.ok(!fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8').includes('FAILED'));

  // 3. a new feedback draft → the model runs but never journals → FAILED as usual, and the beat is NOT recorded
  const draft = path.join(s.vault, 'brain', 'memory', 'feedback', '_drafts', 'r-1.md');
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, '# Rule\n');
  const r3 = run(['tick'], env);
  assert.equal(r3.status, 1);
  assert.match(fs.readFileSync(s.journal, 'utf8'), /duty: tick\n- status: FAILED/);
  assert.equal(tickState().beats, 1, 'no beat after a failed contract');
  assert.ok(tickState().pending, 'the pending signature waits for a run that meets the contract');
});

// Spec 2026-09-22-persona-reflect-daily-design D2: the daily reflect rides the same seam with reflect.js — precheck skips
// only an empty queue that already drained today; beat drains the queue after the contract passes, never after a failure.
test('reflect-daily helper: precheck skips only when the queue is empty and today drained, beat drains after a met contract', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'reflect-daily.md'), 'ascii fixture nightly reflect\n');
  const fake = path.join(s.vault, 'fake-reflect-claude');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    FAKE_AUTH,
    '[ -n "${FAKE_JOURNAL:-}" ] && { mkdir -p "$(dirname "$FAKE_JOURNAL")"; printf "\\n## 22:00 — duty: reflect-daily\\n- status: OK\\n" >> "$FAKE_JOURNAL"; }',
    '[ -n "${FAKE_QUEUE_DURING_RUN:-}" ] && echo "$FAKE_QUEUE_DURING_RUN" >> "$AOS_VAULT/persona/queue.jsonl"',
    'echo "{\\"type\\":\\"result\\",\\"result\\":\\"done\\",\\"total_cost_usd\\":0.02,\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1},\\"duration_ms\\":10}"',
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { ...s.env, PERSONA_CLAUDE_BIN: fake };
  const queueFile = path.join(s.vault, 'persona', 'queue.jsonl');
  const line = (type, source) => JSON.stringify({ schema: 1, ts: '2026-09-22T10:00:00.000Z', type, source, note: null, by: 'tick' });
  fs.writeFileSync(queueFile, `${line('correction', 'brain/memory/feedback/a.md')}\n${line('duty-failure', 'brain/_index/persona-heartbeat.json#reflect')}\n`);
  const reflectState = () => JSON.parse(fs.readFileSync(path.join(s.vault, 'brain', '_index', 'persona-reflect.json'), 'utf8'));
  const queue = () => fs.readFileSync(queueFile, 'utf8').trim().split('\n').filter(Boolean);
  const log = () => fs.readFileSync(path.join(s.logDir, 'duty-reflect-daily.log'), 'utf8');

  // 1. two signals queued, a line arrives during the run: the run drains the two it saw and keeps the newcomer
  const late = line('repo-stall', 'app:.planning/STATE.md');
  const r1 = run(['reflect-daily'], { ...env, FAKE_JOURNAL: s.journal, FAKE_QUEUE_DURING_RUN: late });
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(log(), /duty=reflect-daily done \(exit 0\)/);
  assert.equal(reflectState().drains, 1);
  assert.deepEqual(reflectState().lastDrain, { count: 2, byType: { correction: 1, 'duty-failure': 1 } });
  assert.deepEqual(queue(), [late], 'the signal queued during the run waits for the next drain');

  // 2. the newcomer is still queued → the model runs again the same day and drains it
  const r2 = run(['reflect-daily'], { ...env, FAKE_JOURNAL: s.journal });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(reflectState().drains, 2);
  assert.equal(queue().length, 0);

  // 3. empty queue, already drained today → skipped: exit 0, one log line, no new journal entry, no FAILED flag
  const r3 = run(['reflect-daily'], { ...env, FAKE_JOURNAL: s.journal });
  assert.equal(r3.status, 0, r3.stderr);
  assert.match(log(), /duty=reflect-daily skipped: queue empty and already drained today/);
  assert.equal(fs.readFileSync(s.journal, 'utf8').match(/duty: reflect-daily/g).length, 2, 'a skip writes no journal entry');
  assert.equal(reflectState().skipped, 1);
  assert.ok(!fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8').includes('FAILED'));

  // 4. a new signal, but the model never journals → FAILED as usual and NOT drained
  fs.appendFileSync(queueFile, line('correction', 'brain/memory/feedback/b.md') + '\n');
  const r4 = run(['reflect-daily'], env);
  assert.equal(r4.status, 1);
  assert.match(fs.readFileSync(s.journal, 'utf8'), /duty: reflect-daily\n- status: FAILED/);
  assert.equal(reflectState().drains, 2, 'no drain after a failed contract');
  assert.equal(queue().length, 1, 'the signal is still queued for the next run');
});

test('tick helper: the budget and allowlist come from the env like any duty (run-routine.js sets them from the routine file)', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'tick.md'), 'ascii fixture tick\n');
  const r = run(['tick', '--dry-run'], { ...s.env, PERSONA_MAX_USD: '0.05', PERSONA_TOOLS: 'Read,Glob,Grep,Bash(node tick.js:*)' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--max-budget-usd\n0\.05$/m);
  assert.match(r.stdout, /^--allowedTools\nRead,Glob,Grep,Bash\(node tick\.js:\*\),Edit\(\/\//m, 'the routine\'s tools, then the write scope');
  assert.ok(!fs.existsSync(path.join(s.vault, 'brain', '_index', 'persona-tick.json')), 'dry-run runs no precheck');
});

// ── duty write scope (spec 2026-09-23-duty-write-scope-design) ──────────────────────────────────────────────────────

/** The value printed after `flag` in a dry-run listing, split into rules. */
function dryValue(stdout, flag) {
  const lines = stdout.split('\n');
  return require('../persona/duty-guard.js').splitTools(lines[lines.indexOf(flag) + 1]);
}

test('claude dry-run: dontAsk, no write tool or git read-out survives, absolute Edit rules for the scope, deny rules for the guarded areas', () => {
  const s = sandbox();
  const tools = 'Read,Write,Edit,Bash,Bash(git log:*),Bash(git status:*)';
  const r = run(['testduty', '--dry-run'], { ...s.env, PERSONA_TOOLS: tools, PERSONA_WRITES: 'notes/inbox/,persona/routines/' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--permission-mode\ndontAsk$/m);
  const allowed = dryValue(r.stdout, '--allowedTools');
  const denied = dryValue(r.stdout, '--disallowedTools');
  assert.deepEqual(allowed.filter((a) => !a.startsWith('Edit(')), ['Read', 'Bash(git status:*)']);
  const real = fs.realpathSync(s.vault);
  assert.ok(allowed.includes(`Edit(/${real}/persona/journal/**)`));
  assert.ok(allowed.includes(`Edit(/${real}/notes/inbox/**)`), 'writes: adds to the scope');
  assert.ok(!allowed.some((a) => a.includes('persona/routines')), 'a guarded writes: entry is refused');
  assert.match(r.stderr, /writes entry 'persona\/routines\/' refused/);
  assert.ok(denied.includes('Bash(git *--output*)'));
  assert.ok(denied.includes(`Edit(/${real}/brain/scripts/**)`) && denied.includes(`Edit(/${real}/persona/routines/**)`));
  assert.ok(!fs.existsSync(s.logDir), 'dry-run still writes no logs');
});

test('a duty that writes a guarded file fails: the file is restored, its version kept, STATE.md flagged, no snapshot left', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.vault, 'persona', 'routines'), { recursive: true });
  const routine = path.join(s.vault, 'persona', 'routines', 'heartbeat.md');
  fs.writeFileSync(routine, 'argv: ["node", "watchdog.js"]\n');
  const r = run(['testduty'], { ...s.env, FAKE_JOURNAL: s.journal, FAKE_TAMPER: routine });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(fs.readFileSync(routine, 'utf8'), 'argv: ["node", "watchdog.js"]\n', 'restored from the snapshot');
  const kept = fs.readdirSync(s.logDir).find((n) => n.startsWith('guard-testduty-'));
  assert.ok(kept, 'the duty\'s version is kept in the log folder');
  assert.match(fs.readFileSync(path.join(s.logDir, kept, 'persona', 'routines', 'heartbeat.md'), 'utf8'), /tampered/);
  assert.match(fs.readFileSync(s.journal, 'utf8'), /- status: FAILED\n- did: runner-detected guard failure \(duty-guard exit 4\)/);
  assert.match(fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8'), /duty 'testduty' wrote guarded file\(s\) persona\/routines\/heartbeat\.md — restored/);
  assert.match(fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'), /FAILED \(guard exit 4\)/);
  assert.ok(!fs.existsSync(path.join(s.vault, 'agenticos-duty-guard', 'testduty')), 'the snapshot (config home = the test vault here) is gone');
});

test('a clean duty leaves the guard silent: exit 0, no flag, no kept copy, no snapshot', () => {
  const s = sandbox();
  const r = run(['testduty'], { ...s.env, FAKE_JOURNAL: s.journal });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.readdirSync(s.logDir).some((n) => n.startsWith('guard-')));
  assert.ok(!fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8').includes('guard'));
  assert.ok(!fs.existsSync(path.join(s.vault, 'agenticos-duty-guard', 'testduty')));
});

test('codex runner: with no claude and a codex host, the duty runs through `codex exec -` (prompt on stdin), journals, and ledgers an estimated codex row (codex-parity D4/D5)', () => {
  const s = sandbox();
  const fakeCodex = path.join(__dirname, '..', '..', '..', 'cli', 'fixtures', 'fake-codex.sh');
  const cfg = path.join(s.vault, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ vault: s.vault, claude: { model: 'haiku' }, hosts: { claude: { enabled: false }, codex: { enabled: true, bin: fakeCodex } } }, null, 2));
  const env = { ...s.env, AOS_CONFIG: cfg, AOS_NO_CLAUDE: '1', PATH: '/usr/bin:/bin', HOME: s.vault };
  delete env.PERSONA_CLAUDE_BIN;
  // local-first A4: a 2.0 install's Codex duty model is the Chief of Staff's, gpt-6-sol (config.default.json).
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  assert.match(run(['testduty', '--dry-run'], env).stdout, /^-m\ngpt-6-sol$/m);
  // A pre-2.0 vault's null persona.codexModel keeps the chain it had: codex.model, then the user's Codex default.
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none', persona: { codexModel: null }, codex: { model: 'gpt-5-mini' } }));
  const dry = run(['testduty', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  const lines = dry.stdout.split('\n');
  assert.equal(lines[0], fakeCodex);
  assert.deepEqual(lines.slice(1, 4), ['exec', '-', '--skip-git-repo-check']);
  assert.match(dry.stdout, /^-m\ngpt-5-mini$/m);
  assert.match(dry.stdout, /^model_reasoning_effort="medium"$/m);
  assert.match(dry.stdout, /on stdin, after persona IDENTITY\.md \+ STATE\.md/);
  assert.ok(!dry.stdout.includes('--max-budget-usd'), 'codex has no per-run budget flag');
  const stdinFile = path.join(s.vault, 'codex-stdin.txt');
  const argsFile = path.join(s.vault, 'codex-args.txt');
  const r = run(['testduty'], { ...env, FAKE_JOURNAL: s.journal, FAKE_CODEX_STDIN: stdinFile, FAKE_ARGS: argsFile });
  assert.equal(r.status, 0, r.stderr + fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'));
  const prompt = fs.readFileSync(stdinFile, 'utf8');
  assert.match(prompt, /^Today is /);
  assert.match(prompt, /# Atlas/);
  assert.match(prompt, /ascii fixture duty/);
  assert.match(fs.readFileSync(argsFile, 'utf8'), /^-s\nworkspace-write$/m);
  const log = fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8');
  assert.match(log, /runner=codex/);
  assert.match(log, /"provider":"codex"/);
  assert.match(log, /"model":"gpt-5-mini"/);
  assert.match(log, /done \(exit 0\)/);
  const ledger = fs.readFileSync(path.join(s.vault, 'brain', '_index', 'provider-spend.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].feature, 'duty:testduty');
  assert.equal(ledger[0].inputTokens, 1200);
  assert.ok(ledger[0].usd > 0);
  // persona.runner=claude pins claude even when codex is the only host, and the codex binary is never taken for it (the
  // flat "bin" scan of 0.5.0 would have picked it). With no claude CLI and only one host there is no failover: the duty
  // waits for a host (exit 0, nothing invoked) — local-first A4.
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none', persona: { runner: 'claude' } }));
  const pinned = run(['testduty', '--dry-run'], env);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout.trim(), 'skipped: waiting-for-host (claude: CLI not found)');
});

test('codex: the workspace is persona/, the user config cannot add roots, and the scope\'s other folders arrive as --add-dir', () => {
  const s = sandbox();
  const fakeCodex = path.join(__dirname, '..', '..', '..', 'cli', 'fixtures', 'fake-codex.sh');
  const cfg = path.join(s.vault, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ vault: s.vault, claude: { model: 'haiku' }, hosts: { claude: { enabled: false }, codex: { enabled: true, bin: fakeCodex } } }, null, 2));
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none', dailyNote: { layout: 'brain/sessions/{yyyy}-{MM}-{dd}.md' } }));
  const env = { ...s.env, AOS_CONFIG: cfg, AOS_NO_CLAUDE: '1', PATH: '/usr/bin:/bin', HOME: s.vault };
  delete env.PERSONA_CLAUDE_BIN;
  const dry = run(['testduty', '--dry-run'], { ...env, PERSONA_WRITES: 'notes/inbox/' });
  assert.equal(dry.status, 0, dry.stderr);
  const persona = path.join(s.vault, 'persona');
  assert.ok(dry.stdout.includes(`-C\n${persona}\n-c\nsandbox_workspace_write.writable_roots=[]\n`));
  for (const d of ['brain/_index', 'brain/reflections', 'brain/sessions', 'notes/inbox']) {
    assert.ok(dry.stdout.includes(`--add-dir\n${path.join(s.vault, d)}\n`), d);
  }
  assert.ok(!fs.existsSync(path.join(s.vault, 'notes')), 'a dry run creates no folder');
  assert.ok(!dry.stdout.includes('--allowedTools'), 'codex has no tool allowlist: the sandbox is the guard');
  const argsFile = path.join(s.vault, 'codex-args.txt');
  const r = run(['testduty'], { ...env, FAKE_JOURNAL: s.journal, FAKE_ARGS: argsFile });
  assert.equal(r.status, 0, r.stderr + fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'));
  const args = fs.readFileSync(argsFile, 'utf8');
  assert.ok(args.includes(`-C\n${persona}\n`) && args.includes(`--add-dir\n${path.join(s.vault, 'brain', 'reflections')}\n`));
  assert.ok(fs.statSync(path.join(s.vault, 'brain', 'sessions')).isDirectory(), 'a real run creates the folders it grants');
});

// ── the reflect duties' feedback memories (spec 2026-09-28-reflect-memory-writes-design) ───────────────────────────

test('reflect on claude: the scope names the feedback folder and MEMORY.md, and a memory the duty did not index is indexed after the run', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'reflect.md'), 'ascii fixture weekly reflect\n');
  fs.writeFileSync(path.join(s.vault, 'MEMORY.md'), '# Index\n\n## Feedback (how to work)\n');
  const fake = path.join(s.vault, 'fake-reflect-claude');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    FAKE_AUTH,
    '[ -n "${FAKE_JOURNAL:-}" ] && { mkdir -p "$(dirname "$FAKE_JOURNAL")"; printf "\\n## 18:00 — duty: reflect\\n- status: OK\\n" >> "$FAKE_JOURNAL"; }',
    '[ -n "${FAKE_MEMORY:-}" ] && { mkdir -p "$(dirname "$FAKE_MEMORY")"; printf "# Promote on repeat\\n\\nA correction seen twice becomes a feedback memory.\\n" > "$FAKE_MEMORY"; }',
    'echo "{\\"type\\":\\"result\\",\\"result\\":\\"done\\",\\"total_cost_usd\\":0.02,\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1},\\"duration_ms\\":10}"',
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { ...s.env, PERSONA_CLAUDE_BIN: fake };
  const dry = run(['reflect', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  const real = fs.realpathSync(s.vault);
  const allowed = dryValue(dry.stdout, '--allowedTools');
  assert.ok(allowed.includes(`Edit(/${real}/brain/memory/feedback/**)`) && allowed.includes(`Edit(/${real}/MEMORY.md)`));
  assert.ok(!dryValue(run(['testduty', '--dry-run'], env).stdout, '--allowedTools').some((a) => a.includes('brain/memory')), 'other duties get none of it');
  const memory = path.join(s.vault, 'brain', 'memory', 'feedback', 'promote-on-repeat.md');
  const r = run(['reflect'], { ...env, FAKE_JOURNAL: s.journal, FAKE_MEMORY: memory });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(s.vault, 'MEMORY.md'), 'utf8'),
    '# Index\n\n## Feedback (how to work)\n- [Promote on repeat](brain/memory/feedback/promote-on-repeat.md) — A correction seen twice becomes a feedback memory.\n');
  assert.match(fs.readFileSync(path.join(s.logDir, 'duty-reflect.log'), 'utf8'), /duty=reflect guard .*"indexed":\["brain\/memory\/feedback\/promote-on-repeat\.md"\]/);
});

test('reflect on codex: the feedback folder arrives as --add-dir, MEMORY.md is left out without a refusal, and the runner writes its index line', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'reflect.md'), 'ascii fixture weekly reflect\n');
  const fakeCodex = path.join(__dirname, '..', '..', '..', 'cli', 'fixtures', 'fake-codex.sh');
  const cfg = path.join(s.vault, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ vault: s.vault, claude: { model: 'haiku' }, hosts: { claude: { enabled: false }, codex: { enabled: true, bin: fakeCodex } } }, null, 2));
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  const env = { ...s.env, AOS_CONFIG: cfg, AOS_NO_CLAUDE: '1', PATH: '/usr/bin:/bin', HOME: s.vault };
  delete env.PERSONA_CLAUDE_BIN;
  const dry = run(['reflect', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes(`--add-dir\n${path.join(s.vault, 'brain', 'memory', 'feedback')}\n`));
  assert.ok(!dry.stdout.includes(`--add-dir\n${s.vault}\n`), 'never the vault itself');
  assert.doesNotMatch(dry.stderr, /refused/);
  const memory = path.join(s.vault, 'brain', 'memory', 'feedback', 'codex-rule.md');
  const r = run(['reflect'], { ...env, FAKE_JOURNAL: s.journal, FAKE_DUTY: 'reflect', FAKE_TAMPER: memory });
  assert.equal(r.status, 0, r.stderr + fs.readFileSync(path.join(s.logDir, 'duty-reflect.log'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(s.vault, 'MEMORY.md'), 'utf8'), '# Index\n\n## Feedback\n- [codex-rule](brain/memory/feedback/codex-rule.md) — tampered');
});

// local-first A4: the Chief of Staff runs on its hosted model per host, fails over to the other host when the primary
// cannot start, and waits (skipped, not failed) when no host can.
function bothHosts(s) {
  const fakeCodex = path.join(__dirname, '..', '..', '..', 'cli', 'fixtures', 'fake-codex.sh');
  const cfg = path.join(s.vault, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ vault: s.vault, claude: { model: 'haiku', bin: s.env.PERSONA_CLAUDE_BIN }, hosts: { claude: { enabled: true, bin: s.env.PERSONA_CLAUDE_BIN }, codex: { enabled: true, bin: fakeCodex } } }, null, 2));
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  return { fakeCodex, env: { ...s.env, AOS_CONFIG: cfg, PATH: '/usr/bin:/bin', HOME: s.vault } };
}

test('chief: with both hosts the duty runs on Claude · claude-opus-5-5; signed out, it runs on Codex · gpt-6-sol', () => {
  const s = sandbox();
  const { fakeCodex, env } = bothHosts(s);
  const dry = run(['testduty', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout.split('\n')[0], s.env.PERSONA_CLAUDE_BIN);
  assert.match(dry.stdout, /^--model\nclaude-opus-5-5$/m);
  // auto: Claude when it is on and signed in, else Codex — the primary itself, no failover needed.
  const auto = run(['testduty', '--dry-run'], { ...env, FAKE_SIGNED_OUT: '1' });
  assert.equal(auto.stdout.split('\n')[0], fakeCodex);
  assert.match(auto.stdout, /^-m\ngpt-6-sol$/m);
  assert.ok(!auto.stdout.includes('(failover'));
  // persona.runner claude: a signed-out Claude fails over to the other host's CoS model.
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none', persona: { runner: 'claude' } }));
  const moved = run(['testduty', '--dry-run'], { ...env, FAKE_SIGNED_OUT: '1' });
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(moved.stdout.split('\n')[0], fakeCodex);
  assert.match(moved.stdout, /^-m\ngpt-6-sol$/m, 'the other host\'s CoS model, never the Claude one');
  assert.ok(!moved.stdout.includes('claude-opus-5-5'));
  assert.match(moved.stdout, /^\(failover: claude signed out\)$/m);
  // A real run on the failover host journals, ledgers a codex row and logs why it moved.
  const r = run(['testduty'], { ...env, FAKE_SIGNED_OUT: '1', FAKE_JOURNAL: s.journal });
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8');
  assert.match(log, /runner=codex model=gpt-6-sol effort=medium budget=2 \(failover: claude signed out\) start/);
  assert.match(log, /"provider":"codex"/);
  // persona.failover off: the signed-out primary is not replaced, the duty waits.
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none', persona: { runner: 'claude', failover: false } }));
  const off = run(['testduty', '--dry-run'], { ...env, FAKE_SIGNED_OUT: '1' });
  assert.equal(off.stdout.trim(), 'skipped: waiting-for-host (claude: signed out)');
});

test('chief: a host whose day is at persona.perDayUsd fails over to the other host; both capped is SKIPPED daily-cap', () => {
  const s = sandbox();
  const { fakeCodex, env } = bothHosts(s);
  const today = new Date().toISOString();
  const row = (provider, usd) => JSON.stringify({ ts: today, feature: 'duty:other', provider, model: 'm', usd, inputTokens: 1, outputTokens: 1, ms: 1 });
  const ledger = path.join(s.vault, 'brain', '_index', 'provider-spend.jsonl');
  fs.writeFileSync(ledger, row('claude', 6) + '\n');
  const moved = run(['testduty', '--dry-run'], env);
  assert.equal(moved.stdout.split('\n')[0], fakeCodex, 'Claude\'s day is capped; Codex\'s is not');
  assert.match(moved.stdout, /^\(failover: claude daily cap\)$/m);
  fs.appendFileSync(ledger, row('codex', 6) + '\n');
  const r = run(['testduty'], { ...env, FAKE_JOURNAL: s.journal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(s.journal, 'utf8'), /— duty: testduty\n- status: SKIPPED daily-cap\n- did: nothing — today's duty spend is at persona\.perDayUsd on every host \(claude: daily cap; codex: daily cap\)/);
  assert.ok(!fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8').includes('waiting for a host'), 'a capped day is no flag');
});

test('chief: no host can start → SKIPPED waiting-for-host in the journal, one flag a day, exit 0 (skipped, not failed)', () => {
  const s = sandbox();
  const env = { ...s.env, FAKE_SIGNED_OUT: '1' };
  const r1 = run(['testduty'], { ...env, FAKE_JOURNAL: s.journal });
  assert.equal(r1.status, 0, r1.stderr);
  const journal = fs.readFileSync(s.journal, 'utf8');
  assert.match(journal, /## \d{2}:\d{2} — duty: testduty\n- status: SKIPPED waiting-for-host\n- did: nothing — no host can start it \(claude: signed out\)/);
  assert.ok(!journal.includes('status: OK'), 'nothing ran');
  assert.match(fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'), /skipped: waiting for a host \(claude: signed out\)/);
  const run2 = run(['testduty'], env);
  assert.equal(run2.status, 0);
  const state = fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8');
  assert.equal(state.match(/Chief of Staff waiting for a host/g).length, 1, 'flagged once, not once per run');
  assert.match(state, /## Flags\n- \[ \] \d{4}-\d{2}-\d{2} Chief of Staff waiting for a host — duties skipped \(claude: signed out\)/);
});

// local-first A5, end to end: the hourly routine is tick.js --triage. Local model down (provider none here): a real change
// wakes the hosted tick duty through this very runner, with the routine file's budget and allowlist; the next, unchanged
// hour calls nothing at all.
test('tick triage end to end: a real change wakes the tick duty through run-duty.sh; an unchanged hour makes no call', () => {
  const s = sandbox();
  const TICK = path.join(__dirname, '..', 'persona', 'tick.js');
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'tick.md'), 'ascii fixture tick duty\n');
  fs.mkdirSync(path.join(s.vault, 'brain', 'routines'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', '..', 'vault-template', 'persona', 'routines', 'tick.md'), path.join(s.vault, 'brain', 'routines', 'tick.md'));
  fs.writeFileSync(path.join(s.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  const fake = path.join(s.vault, 'fake-claude-tick');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    FAKE_AUTH,
    'printf "%s\\n" "$@" > "$FAKE_ARGS"',
    'printf "\\n## 11:00 — duty: tick\\n- status: OK\\n" >> "$FAKE_JOURNAL"',
    'echo "{\\"type\\":\\"result\\",\\"result\\":\\"done\\",\\"total_cost_usd\\":0.2,\\"usage\\":{\\"input_tokens\\":10,\\"output_tokens\\":5}}"',
    '',
  ].join('\n'), { mode: 0o755 });
  const argsFile = path.join(s.vault, 'tick-args.txt');
  const env = { ...s.env, PERSONA_CLAUDE_BIN: fake, FAKE_ARGS: argsFile, FAKE_JOURNAL: s.journal };
  delete env.NODE_OPTIONS;   // the workspace's relative --require would not resolve from the vault, where the duty runs
  const triage = () => spawnSync(process.execPath, [TICK, '--triage', '--root', s.vault], { env, encoding: 'utf8', timeout: 60000 });
  const r = triage();
  assert.equal(r.status, 0, r.stderr);
  const line = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(line.action, 'woke');
  assert.equal(line.decision.by, 'rules');
  const journal = fs.readFileSync(s.journal, 'utf8');
  assert.match(journal, /— tick triage: woke the Chief of Staff — the local model is unavailable \(forced\): any real change wakes the Chief of Staff \(rules; changed: first triage\)\n/);
  assert.match(journal, /duty: tick\n- status: OK/);
  const args = fs.readFileSync(argsFile, 'utf8');
  assert.match(args, /^--model\nclaude-opus-5-5$/m, 'the Chief of Staff\'s hosted model');
  assert.match(args, /^--max-budget-usd\n0\.5$/m, 'the routine file\'s budgetUsd');
  assert.ok(args.includes(`Bash(${process.execPath} ${s.vault}/brain/scripts/persona/tick.js:*)`), 'its allowlist, expanded');
  assert.ok(!/git/.test(args.split('\n')[args.split('\n').indexOf('--allowedTools') + 1]), 'no git');
  const st = JSON.parse(fs.readFileSync(path.join(s.vault, 'brain', '_index', 'persona-tick.json'), 'utf8'));
  assert.equal(st.beats, 1, 'run-duty.sh recorded the beat after the contract');
  assert.equal(st.wakes, 1);
  // The next hour: nothing changed — no local call, no hosted call, no journal line.
  fs.rmSync(argsFile);
  const quiet = triage();
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(JSON.parse(quiet.stdout.trim()).action, 'unchanged');
  assert.ok(!fs.existsSync(argsFile), 'the hosted model was not started');
  assert.equal(fs.readFileSync(s.journal, 'utf8'), journal);
});
