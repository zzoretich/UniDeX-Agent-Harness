'use strict';
// Unit tests for brain/scripts/sdk/lib/models.js — the role table and its precedence rules.
// Moved out of test/live/: nothing here needs Ollama.
const test = require('node:test');
const assert = require('node:assert/strict');
const { role, thinkFor, providerFor, EFFORTS, LOCAL_TIERS, workhorseForMemory } = require('../sdk/lib/models.js');

const ENV = ['BRAIN_MODEL', 'BRAIN_REASONER', 'BRAIN_EMBEDDER', 'AOS_CLAUDE_MODEL'];
function clearEnv() { for (const k of ENV) delete process.env[k]; }
const NO_CFG = {}; // passing a cfg skips the vault lookup, so defaults are exactly DEFAULTS

test('defaults: 9b workhorse, Opus 5 reasoner on claude, 0.6b embedder', () => {
  clearEnv();
  assert.equal(role('workhorse', NO_CFG).tag, 'qwen3.5:9b');
  assert.equal(role('workhorse', NO_CFG).keepAlive, -1);
  assert.equal(role('workhorse', NO_CFG).numCtxCap, 32768);
  assert.equal(role('reasoner', NO_CFG).tag, 'claude-opus-5');
  assert.equal(role('reasoner', NO_CFG).keepAlive, null);
  assert.equal(role('reasoner', NO_CFG).numCtxCap, null);
  assert.equal(role('embedder', NO_CFG).tag, 'qwen3-embedding:0.6b');
  assert.equal(role('embedder', NO_CFG).keepAlive, -1);
  assert.equal(role('claude', NO_CFG).tag, 'haiku');
});

test('RAM tiers (local-first A12): 4b under 12 GB, 9b from 12 GB; the workhorse stays loaded from 24 GB', (t) => {
  clearEnv();
  const saved = process.env.AOS_TOTALMEM;
  t.after(() => { process.env.AOS_TOTALMEM = saved; });
  const GB = 1024 ** 3;
  const LOCAL = { provider: 'local' };
  for (const [gb, tag, keep] of [[8, 'qwen3.5:4b', '5m'], [11.9, 'qwen3.5:4b', '5m'], [12, 'qwen3.5:9b', '5m'], [16, 'qwen3.5:9b', '5m'], [24, 'qwen3.5:9b', -1], [64, 'qwen3.5:9b', -1]]) {
    process.env.AOS_TOTALMEM = String(gb * GB);
    assert.equal(role('workhorse', LOCAL).tag, tag, `${gb} GB`);
    assert.equal(role('workhorse', LOCAL).source, 'tier');
    assert.equal(role('workhorse', LOCAL).keepAlive, keep, `${gb} GB`);
    assert.equal(workhorseForMemory(gb * GB), tag);
    assert.equal(role('embedder', LOCAL).keepAlive, -1, 'the embedder stays loaded on every tier');
    // Outside provider local nothing moves: the 9b, always loaded, whatever the memory.
    assert.equal(role('workhorse', { provider: 'auto' }).tag, 'qwen3.5:9b');
    assert.equal(role('workhorse', NO_CFG).keepAlive, -1);
    assert.equal(role('workhorse', NO_CFG).source, 'default');
  }
  process.env.AOS_TOTALMEM = 'junk';
  assert.ok(['qwen3.5:4b', 'qwen3.5:9b'].includes(role('workhorse', LOCAL).tag), 'junk falls back to os.totalmem()');
  assert.deepEqual(LOCAL_TIERS.map((x) => x.tag), ['qwen3.5:4b', 'qwen3.5:9b']);
});

test('local.model, local.embedder and local.keepAlive override the tier; env still wins (local-first A11)', () => {
  clearEnv();
  const cfg = { provider: 'local', local: { model: 'qwen3.5:27b', embedder: 'nomic-embed-text', keepAlive: '30m' } };
  assert.equal(role('workhorse', cfg).source, 'config');
  assert.equal(role('workhorse', cfg).tag, 'qwen3.5:27b');
  assert.equal(role('workhorse', cfg).keepAlive, '30m');
  assert.equal(role('workhorse', { local: { keepAlive: 0 } }).keepAlive, 0, 'a numeric 0 unloads at once');
  assert.equal(role('workhorse', { local: { keepAlive: '-1' } }).keepAlive, -1, 'the settings picker\'s "-1" reaches Ollama as a number');
  assert.equal(role('embedder', cfg).tag, 'nomic-embed-text');
  assert.equal(role('workhorse', { local: { model: '  ', keepAlive: null } }).tag, 'qwen3.5:9b', 'blank falls to the tier');
  process.env.BRAIN_MODEL = 'llama3.2';
  process.env.BRAIN_EMBEDDER = 'mxbai-embed-large';
  assert.equal(role('workhorse', cfg).tag, 'llama3.2');
  assert.equal(role('embedder', cfg).tag, 'mxbai-embed-large');
  clearEnv();
});

test('providerFor: the reasoner and the hook fallback are claude, the rest ollama', () => {
  assert.equal(providerFor('workhorse'), 'ollama');
  assert.equal(providerFor('embedder'), 'ollama');
  assert.equal(providerFor('reasoner'), 'claude');
  assert.equal(providerFor('claude'), 'claude');
  assert.equal(role('reasoner', NO_CFG).provider, 'claude');
  assert.throws(() => providerFor('nope'), /unknown model role/);
  assert.throws(() => role('nope'), /unknown model role/);
});

test('precedence: env beats config beats default, read lazily', () => {
  clearEnv();
  const cfg = { reasoner: { model: 'sonnet' }, claude: { model: 'opus' } };
  assert.equal(role('reasoner', cfg).tag, 'sonnet');
  assert.equal(role('claude', cfg).tag, 'opus');
  process.env.BRAIN_REASONER = 'claude-sonnet-5';
  assert.equal(role('reasoner', cfg).tag, 'claude-sonnet-5');
  process.env.BRAIN_MODEL = 'qwen3.5:27b';
  assert.equal(role('workhorse', cfg).tag, 'qwen3.5:27b');
  clearEnv();
  assert.equal(role('reasoner', cfg).tag, 'sonnet');
  assert.equal(role('reasoner', { reasoner: { model: '  ' } }).tag, 'claude-opus-5', 'blank config value falls through');
});

test('thinkFor: workhorse is always false; reasoner takes the dial, config default, then medium', () => {
  clearEnv();
  assert.equal(thinkFor('workhorse'), false);
  assert.equal(thinkFor('workhorse', 'high'), false);
  assert.equal(thinkFor('embedder', 'high', NO_CFG), false);
  assert.equal(thinkFor('claude', 'high', NO_CFG), false);
  assert.equal(thinkFor('reasoner', undefined, NO_CFG), 'medium');
  assert.equal(thinkFor('reasoner', 'high', NO_CFG), 'high');
  assert.equal(thinkFor('reasoner', 'bogus', NO_CFG), 'medium', 'an unknown level falls back');
  assert.equal(thinkFor('reasoner', undefined, { reasoner: { effort: 'LOW' } }), 'low');
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high']);
});

test('codex role: null tag by default (no -m), AOS_CODEX_MODEL and codex.model override, served by the codex provider', () => {
  clearEnv();
  delete process.env.AOS_CODEX_MODEL;
  assert.equal(role('codex', NO_CFG).tag, null);
  assert.equal(role('codex', NO_CFG).provider, 'codex');
  assert.equal(providerFor('codex'), 'codex');
  assert.equal(role('codex', { codex: { model: 'gpt-5-mini' } }).tag, 'gpt-5-mini');
  process.env.AOS_CODEX_MODEL = 'gpt-5';
  assert.equal(role('codex', { codex: { model: 'gpt-5-mini' } }).tag, 'gpt-5');
  delete process.env.AOS_CODEX_MODEL;
  assert.equal(thinkFor('codex', 'high', NO_CFG), false);
});

test('chief (local-first A4/A11): claude-opus-5-5 / gpt-6-sol, the same pair config.default.json gives a new install', () => {
  const { CHIEF, chiefModel } = require('../sdk/lib/models.js');
  const defaults = require('../config.default.json');
  assert.deepEqual({ ...CHIEF }, { claude: 'claude-opus-5-5', codex: 'gpt-6-sol' });
  assert.equal(defaults.persona.model, CHIEF.claude, 'bump both together');
  assert.equal(defaults.persona.codexModel, CHIEF.codex, 'bump both together');
  assert.equal(defaults.persona.failover, true);
  const env = {};
  assert.deepEqual(chiefModel('claude', defaults, { env }), { host: 'claude', tag: 'claude-opus-5-5', source: 'config' });
  assert.deepEqual(chiefModel('codex', defaults, { env }), { host: 'codex', tag: 'gpt-6-sol', source: 'config' });
  // A pre-2.0 vault (explicit nulls) keeps the chain it ran on.
  const old = { persona: { model: null, codexModel: null }, claude: { model: 'haiku' }, codex: { model: 'gpt-5-mini' } };
  assert.deepEqual(chiefModel('claude', old, { env }), { host: 'claude', tag: 'haiku', source: 'legacy' });
  assert.deepEqual(chiefModel('claude', old, { env, answers: { dutyModel: 'sonnet' } }), { host: 'claude', tag: 'sonnet', source: 'answers' });
  assert.deepEqual(chiefModel('codex', old, { env }), { host: 'codex', tag: 'gpt-5-mini', source: 'legacy' });
  assert.deepEqual(chiefModel('codex', { persona: {} }, { env }), { host: 'codex', tag: null, source: 'default' }, 'null: the user\'s own Codex default');
  assert.deepEqual(chiefModel('claude', {}, { env }), { host: 'claude', tag: 'claude-opus-5-5', source: 'default' });
  assert.equal(chiefModel('claude', old, { env: { PERSONA_MODEL: 'opus' } }).tag, 'opus', 'a duty routine\'s own model');
  assert.equal(chiefModel('codex', defaults, { env: { PERSONA_MODEL: 'opus' } }).tag, 'gpt-6-sol', 'a Claude model never reaches Codex');
  assert.equal(role('chief', NO_CFG).provider, 'claude');
  assert.equal(thinkFor('chief', undefined, { persona: { effort: 'low' } }), 'low');
  assert.throws(() => chiefModel('other', {}), /unknown chief host/);
});
