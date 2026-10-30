'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thook-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
const CONFIG = path.join(TMP, 'brain', 'config.json');
const SCRIPT = path.join(__dirname, '..', 'telemetry-hook.js');
const LIVE = (sid) => path.join(TMP, 'brain', '_index', 'agent-runs', 'live', `sess-${sid}.ndjson`);

function fire(sid, extraEnv = {}) {
  const payload = { hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Read', tool_input: { file_path: '/home/alice/secret.md' }, tool_response: { ok: true } };
  const env = { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') };
  delete env.BRAIN_AGENT_REDACT; // strip the developer's shell override first, then apply the test's own
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  if (!fs.existsSync(LIVE(sid))) return null;
  return fs.readFileSync(LIVE(sid), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('redaction is on by default: tool name kept, input and output summaries null', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  const events = fire('r1');
  const use = events.find((e) => e.type === 'tool_use_batch');
  const res = events.find((e) => e.type === 'tool_result_batch');
  assert.equal(use.tools[0].name, 'Read');
  assert.equal(use.tools[0].input_summary, null);
  assert.equal(res.results[0].output_summary, null);
  assert.ok(!fs.readFileSync(LIVE('r1'), 'utf8').includes('secret.md'));
});

test('telemetry.redact=false keeps the summaries; BRAIN_AGENT_REDACT=1 still wins', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', telemetry: { redact: false } }));
  const events = fire('r2');
  assert.match(events.find((e) => e.type === 'tool_use_batch').tools[0].input_summary, /secret\.md/);
  const forced = fire('r3', { BRAIN_AGENT_REDACT: '1' });
  assert.equal(forced.find((e) => e.type === 'tool_use_batch').tools[0].input_summary, null);
});

test('telemetry.enabled=false writes nothing', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', telemetry: { enabled: false } }));
  assert.equal(fire('r4'), null);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
});

test('a Codex payload (tool_input / tool_response as JSON strings, apply_patch) is recorded like a Claude one', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', telemetry: { redact: false } }));
  const payload = {
    hook_event_name: 'PostToolUse', session_id: 'cx1', tool_name: 'apply_patch',
    tool_input: JSON.stringify({ command: '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch' }),
    tool_response: 'Exit code: 0\nSuccess. Updated the following files:\nA note.txt\n',
    tool_use_id: 'exec-1', model: 'gpt-x', permission_mode: 'bypassPermissions',
  };
  const env = { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json'), AOS_HOST: 'codex' };
  delete env.BRAIN_AGENT_REDACT;
  const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'PostToolUse prints nothing on either host');
  const events = fs.readFileSync(LIVE('cx1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const use = events.find((e) => e.type === 'tool_use_batch');
  assert.equal(use.tools[0].name, 'apply_patch');
  assert.match(use.tools[0].input_summary, /Add File: note\.txt/);
  assert.equal(use.tools[0].input_length, JSON.stringify(JSON.parse(payload.tool_input)).length);
  const res = events.find((e) => e.type === 'tool_result_batch');
  assert.equal(res.results[0].is_error, false);
  assert.match(res.results[0].output_summary, /Updated the following files/);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
});

test('SessionStart records the host and the model the payload names; SessionEnd carries them into the summary', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  const env = { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json'), AOS_HOST: 'codex' };
  const start = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'cx-m', model: 'gpt-5-mini', source: 'startup' }), encoding: 'utf8', env });
  assert.equal(start.status, 0, start.stderr);
  const header = JSON.parse(fs.readFileSync(LIVE('cx-m'), 'utf8').split('\n')[0]);
  assert.equal(header.host, 'codex');
  assert.equal(header.model, 'gpt-5-mini');
  const end = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'cx-m', reason: 'other' }), encoding: 'utf8', env });
  assert.equal(end.status, 0, end.stderr);
  const runs = fs.readFileSync(path.join(TMP, 'brain', '_index', 'agent-runs', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rec = runs.find((r) => r.session_id === 'cx-m');
  assert.equal(rec.host, 'codex');
  assert.equal(rec.model, 'gpt-5-mini');
  // a Claude Code session has no model in its payload
  const c = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'cc-m' }), encoding: 'utf8', env: { ...env, AOS_HOST: '' } });
  assert.equal(c.status, 0);
  const h2 = JSON.parse(fs.readFileSync(LIVE('cc-m'), 'utf8').split('\n')[0]);
  assert.equal(h2.host, 'claude');
  assert.equal(h2.model, null);
  assert.ok(!('host_pid' in h2) && !('host_started' in h2), 'a Claude Code header records no host process');
});

test('a Codex header records the Codex process the hook runs under (host_pid, host_started); null when there is none', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  const env = { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json'), AOS_HOST: 'codex' };
  // A process whose executable is named `codex` (a symlink to node) runs the hook as its child, as Codex does.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thook-bin-'));
  const fake = path.join(dir, 'codex');
  fs.symlinkSync(process.execPath, fake);
  const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'cx-p', source: 'startup' });
  const inner = `const r = require('child_process').spawnSync(process.execPath, [${JSON.stringify(SCRIPT)}], { input: ${JSON.stringify(payload)}, encoding: 'utf8' }); process.stdout.write(String(process.pid)); process.exit(r.status);`;
  const run = spawnSync(fake, ['-e', inner], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  const header = JSON.parse(fs.readFileSync(LIVE('cx-p'), 'utf8').split('\n')[0]);
  const outer = require('../lib/host-process.js').findHostProcess('codex');
  assert.equal(header.host_pid, outer?.pid || Number(run.stdout), 'the outermost Codex pid, not the hook\'s own');
  assert.match(header.host_started, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.notEqual(header.pid, header.host_pid);
  // Outside Codex (the test runner is the ancestor chain) both keys are present and null.
  const plain = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'cx-q' }), encoding: 'utf8', env });
  assert.equal(plain.status, 0, plain.stderr);
  const h2 = JSON.parse(fs.readFileSync(LIVE('cx-q'), 'utf8').split('\n')[0]);
  assert.ok('host_pid' in h2 && 'host_started' in h2);
  if (h2.host_pid !== null) assert.ok(Number.isInteger(h2.host_pid), 'only when the tests themselves run inside Codex');
});

test('SessionEnd backfills a null model from the transcript (codex-parity D6); a reconciled end keeps the given ended_at', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  const env = { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') };
  delete env.AOS_HOST;
  const transcript = path.join(TMP, 'cc-b.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-backfilled', content: 'hello' } }),
  ].join('\n') + '\n');
  const start = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'cc-b', transcript_path: transcript }), encoding: 'utf8', env });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(fs.readFileSync(LIVE('cc-b'), 'utf8').split('\n')[0]).model, null);
  const end = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'cc-b', reason: 'other', transcript_path: transcript }), encoding: 'utf8', env });
  assert.equal(end.status, 0, end.stderr);
  const runs = fs.readFileSync(path.join(TMP, 'brain', '_index', 'agent-runs', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(runs.find((r) => r.session_id === 'cc-b').model, 'claude-backfilled');
  // in-process: endRun returns false without a live file, true (with the given end time) when it closes one
  const hook = require('../telemetry-hook.js');
  assert.equal(hook.endRun('never-started', 'reconciled'), false);
});

test('a session that goes on after its run closed is segment 2, with its own run id and timeline (no-duplicate-sessions D4)', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  const env = { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json'), AOS_HOST: '' };
  const send = (payload) => {
    const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
  };
  send({ hook_event_name: 'SessionStart', session_id: 'seg-a' });
  assert.equal(JSON.parse(fs.readFileSync(LIVE('seg-a'), 'utf8').split('\n')[0]).segment, 1);
  send({ hook_event_name: 'SessionEnd', session_id: 'seg-a', reason: 'other' });
  // the session goes on (a reconcile ended it while idle, or a resume): the next event opens a new header
  send({ hook_event_name: 'PostToolUse', session_id: 'seg-a', tool_name: 'Read', tool_input: {}, tool_response: {} });
  const h2 = JSON.parse(fs.readFileSync(LIVE('seg-a'), 'utf8').split('\n')[0]);
  assert.equal(h2.segment, 2);
  assert.equal(h2.id, 'sess-seg-a-s2');
  send({ hook_event_name: 'SessionEnd', session_id: 'seg-a', reason: 'other' });
  const rows = fs.readFileSync(path.join(TMP, 'brain', '_index', 'agent-runs', 'runs.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).filter((r) => r.session_id === 'seg-a');
  assert.deepEqual(rows.map((r) => [r.id, r.segment]), [['sess-seg-a', 1], ['sess-seg-a-s2', 2]]);
  for (const r of rows) {
    assert.ok(fs.existsSync(path.join(TMP, 'brain', '_index', 'agent-runs', r.started_at.slice(0, 10), `${r.id}.json`)), `${r.id} has its own timeline`);
  }
});
