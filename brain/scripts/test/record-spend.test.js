'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseClaudeJson, rowFrom, check, dutySpendFrom } = require('../persona/record-spend.js');

const RESULT = '{"type":"result","result":"done","total_cost_usd":0.0123,"usage":{"input_tokens":1505,"output_tokens":185},"duration_api_ms":2911}';

test('parseClaudeJson takes the last JSON object line and ignores noise', () => {
  assert.equal(parseClaudeJson(`warming up\n${RESULT}\n`).total_cost_usd, 0.0123);
  assert.equal(parseClaudeJson('{"a":1}\nnot json\n{"b":2}').b, 2);
  assert.equal(parseClaudeJson('nothing here'), null);
  assert.equal(parseClaudeJson(''), null);
});

test('rowFrom maps claude -p json output onto the provider ledger row shape', () => {
  const row = rowFrom(JSON.parse(RESULT), { feature: 'duty:monitor', model: 'haiku' });
  assert.equal(row.feature, 'duty:monitor');
  assert.equal(row.provider, 'claude');
  assert.equal(row.model, 'haiku');
  assert.equal(row.usd, 0.0123);
  assert.equal(row.inputTokens, 1505);
  assert.equal(row.outputTokens, 185);
  assert.equal(row.ms, 2911);
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/);
  const empty = rowFrom(null, { feature: 'x', model: 'm' });
  assert.deepEqual([empty.usd, empty.inputTokens, empty.outputTokens, empty.ms], [0, 0, 0, 0]);
});

test('check allows below the daily cap and refuses at or above it', () => {
  assert.deepEqual(check({ spendToday: () => 2, perDayUsd: 6 }), { allowed: true, spentToday: 2, perDayUsd: 6 });
  assert.equal(check({ spendToday: () => 6, perDayUsd: 6 }).allowed, false);
  assert.equal(check({ spendToday: () => 9, perDayUsd: 6 }).allowed, false);
});

test('dutySpendFrom sums only today\'s duty:* rows and skips bad lines', () => {
  const now = new Date().toISOString();
  const text = [
    JSON.stringify({ ts: now, feature: 'duty:monitor', provider: 'claude', model: 'haiku', usd: 0.5 }),
    JSON.stringify({ ts: now, feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 3 }),   // hook spend: not a duty
    JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', feature: 'duty:sitrep', usd: 9 }),                     // another day
    JSON.stringify({ ts: now, feature: 'duty:reflect', usd: '0.25' }),
    'not json',
    '',
  ].join('\n');
  assert.equal(dutySpendFrom(text), 0.75);
  assert.equal(dutySpendFrom(''), 0);
});

test('dutySpendFrom per host (local-first A4): each provider\'s duty rows; a row without one is a Claude row', () => {
  const now = new Date().toISOString();
  const text = [
    JSON.stringify({ ts: now, feature: 'duty:monitor', provider: 'claude', usd: 0.5 }),
    JSON.stringify({ ts: now, feature: 'duty:tick', provider: 'codex', usd: 1.25 }),
    JSON.stringify({ ts: now, feature: 'duty:sitrep', usd: 0.25 }),
  ].join('\n');
  assert.equal(dutySpendFrom(text, new Date(), 'claude'), 0.75);
  assert.equal(dutySpendFrom(text, new Date(), 'codex'), 1.25);
  assert.equal(dutySpendFrom(text), 2);
});

// final review F6/spec-8: an explicit persona.perDayUsd/perDutyUsd of 0 used to fall through the `||`
// defaults (0 || 6 → 6) instead of being honoured — the user asking for "$0/day" silently got $6/day.
test('record-spend.js --check honours an explicit zero cap: exit 3 for perDayUsd:0, and for perDutyUsd:0', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'record-spend-vault-'));
  const cfgFile = path.join(vault, 'brain', 'config.json');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  const script = path.join(__dirname, '..', 'persona', 'record-spend.js');
  const env = { ...process.env, AOS_VAULT: vault, AOS_CONFIG: path.join(vault, 'no-agenticos.json') };

  fs.writeFileSync(cfgFile, JSON.stringify({ persona: { perDayUsd: 0 } }));
  const r1 = spawnSync(process.execPath, [script, '--check'], { env, encoding: 'utf8' });
  assert.equal(r1.status, 3, r1.stderr);
  const out1 = JSON.parse(r1.stdout);
  assert.equal(out1.perDayUsd, 0);
  assert.equal(out1.allowed, false);

  fs.writeFileSync(cfgFile, JSON.stringify({ persona: { perDutyUsd: 0 } }));
  const r2 = spawnSync(process.execPath, [script, '--check'], { env, encoding: 'utf8' });
  assert.equal(r2.status, 3, r2.stderr);
  const out2 = JSON.parse(r2.stdout);
  assert.equal(out2.perDutyUsd, 0);
  assert.equal(out2.allowed, false);

  fs.rmSync(vault, { recursive: true, force: true });
});

test('a codex --json event stream is recognised and priced as an estimate; claude output is untouched (codex-parity D5)', () => {
  process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-codex-home-'));
  const { parseCodexEvents, rowFromCodex } = require('../persona/record-spend.js');
  const stream = [
    'stray line',
    JSON.stringify({ type: 'thread.started', thread_id: 't' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'warn: bypass' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 100, reasoning_output_tokens: 20 } }),
  ].join('\n');
  const ev = parseCodexEvents(stream);
  assert.equal(ev.isCodex, true);
  assert.deepEqual(ev.usage, { inputTokens: 2000, cachedInputTokens: 500, outputTokens: 100, reasoningOutputTokens: 20 });
  assert.deepEqual(ev.errors, ['warn: bypass']);
  assert.equal(parseCodexEvents('{"type":"result","total_cost_usd":0.1}').isCodex, false);
  assert.equal(parseCodexEvents('').isCodex, false);
  const row = rowFromCodex(stream, { feature: 'duty:tick', model: 'gpt-5', ms: 42 });
  assert.equal(row.provider, 'codex');
  assert.equal(row.feature, 'duty:tick');
  assert.equal(row.model, 'gpt-5');
  assert.equal(row.inputTokens, 2000);
  assert.equal(row.outputTokens, 100);
  assert.equal(row.ms, 42);
  assert.ok(row.usd > 0 && row.usd < 0.1, `estimate in range: ${row.usd}`);
  const none = rowFromCodex('{"type":"turn.failed"}', { feature: 'duty:x', model: null });
  assert.equal(none.usd, 0);
  assert.equal(none.inputTokens, 0);
  // the CLI: --file with a codex stream appends a codex row
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-codex-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  const f = path.join(vault, 'out.json');
  fs.writeFileSync(f, stream);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'persona', 'record-spend.js'), '--file', f, '--feature', 'duty:tick', '--model', 'gpt-5'], { encoding: 'utf8', env: { ...process.env, AOS_VAULT: vault, AOS_CONFIG: path.join(vault, 'none.json') } });
  assert.equal(r.status, 0, r.stderr);
  const written = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(written.provider, 'codex');
  assert.equal(written.inputTokens, 2000);
});
