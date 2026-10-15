'use strict';
// sdk/lib/model-pricing.js (brain-ai A5): Claude's rates pinned to the repo's extras/cost/pricing.json, the aliases and
// prefixes, and priceUsd per provider (Codex through codex-pricing.js, Ollama free). Pure: no vault, no model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MP = require('../sdk/lib/model-pricing.js');
const codexPricing = require('../sdk/lib/codex-pricing.js');

const PRICING = path.join(__dirname, '..', '..', '..', 'extras', 'cost', 'pricing.json');

test('the Claude table is extras/cost/pricing.json: every model, the default, the cache read rate and the date', (t) => {
  if (!fs.existsSync(PRICING)) return t.skip('extras/cost/pricing.json is not beside this runtime (a vendored copy)');
  const file = JSON.parse(fs.readFileSync(PRICING, 'utf8'));
  assert.equal(file.unit, 'per_million_tokens');
  assert.equal(file.currency, 'USD');
  assert.deepEqual(Object.keys(MP.MODELS).sort(), Object.keys(file.models).sort(), 'the same models, none missing, none extra');
  for (const [id, rate] of Object.entries(file.models)) {
    const r = MP.claudeRate(id);
    assert.deepEqual({ model: r.model, in: r.in, out: r.out, matched: r.matched }, { model: id, in: rate.in, out: rate.out, matched: 'exact' }, id);
  }
  assert.equal(MP.DEFAULT_MODEL, file.default_model);
  assert.ok(MP.MODELS[MP.DEFAULT_MODEL], 'the default is a priced model');
  assert.equal(MP.CACHED_MULT, file.cache.read_mult);
  assert.equal(MP.RATES_AS_OF, file.rates_as_of);
  for (const [alias, id] of Object.entries(MP.ALIASES)) assert.ok(file.models[id], `${alias} names a priced model (${id})`);
  for (const [prefix, id] of Object.entries(MP.PREFIXES)) assert.ok(file.models[id], `${prefix} names a priced model (${id})`);
});

test('aliases name their current model: haiku, sonnet, opus (any case, trimmed)', () => {
  assert.deepEqual(MP.claudeRate('haiku'), { model: 'claude-haiku-4-5', in: 1, out: 5, matched: 'alias' });
  assert.deepEqual(MP.claudeRate('sonnet'), { model: 'claude-sonnet-4-6', in: 3, out: 15, matched: 'alias' });
  assert.deepEqual(MP.claudeRate(' Opus '), { model: 'claude-opus-5', in: 5, out: 25, matched: 'alias' });
  assert.equal(MP.claudeRate('Claude-Haiku-4-5').matched, 'exact');
});

test('an unlisted id takes its longest known prefix; anything else the default (Sonnet)', () => {
  const pick = (id) => { const r = MP.claudeRate(id); return [r.model, r.matched]; };
  assert.deepEqual(pick('claude-haiku-4-5-20251001'), ['claude-haiku-4-5', 'prefix'], 'a dated id');
  assert.deepEqual(pick('claude-opus-5[1m]'), ['claude-opus-5', 'prefix'], 'a [1m] suffix');
  assert.deepEqual(pick('claude-opus-4-1'), ['claude-opus-4-8', 'prefix'], 'claude-opus-4 beats claude-opus');
  assert.deepEqual(pick('claude-opus-4-8-20260101'), ['claude-opus-4-8', 'prefix'], 'the listed model beats its family prefix');
  assert.deepEqual(pick('claude-opus-6'), ['claude-opus-5', 'prefix']);
  assert.deepEqual(pick('claude-haiku-3'), ['claude-haiku-4-5', 'prefix']);
  assert.deepEqual(pick('claude-sonnet-5'), ['claude-sonnet-4-6', 'prefix']);
  for (const id of ['gpt-5', '', null, undefined, 'claude', 'claude-instant']) assert.deepEqual(pick(id), ['claude-sonnet-4-6', 'default'], String(id));
});

test('priceUsd on Claude: input, cached input at a tenth, output; 6 places', () => {
  assert.equal(MP.priceUsd('claude', 'haiku', { inputTokens: 1e6, outputTokens: 1e6 }), 6);
  assert.equal(MP.priceUsd('claude', 'claude-opus-5', { inputTokens: 1000, outputTokens: 100 }), 0.0075);
  // The Chief of Staff's Claude model at its own published rate ($4 in, $20 out), not Opus 5's by prefix.
  assert.equal(MP.claudeRate('claude-opus-5-5').matched, 'exact');
  assert.equal(MP.priceUsd('claude', 'claude-opus-5-5', { inputTokens: 1000, outputTokens: 100 }), 0.006);
  // 1,000 input of which 400 cached: 600 at $1 + 400 at $0.10, per million.
  assert.equal(MP.priceUsd('claude', 'haiku', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 0 }), 0.00064);
  assert.equal(MP.priceUsd('claude', 'haiku', { inputTokens: 1, outputTokens: 0 }), 0.000001);
  assert.equal(MP.priceUsd('claude', 'haiku', { inputTokens: 1600, outputTokens: 800 }), 0.0056);
  assert.equal(MP.priceUsd('claude', 'haiku', {}), 0);
  assert.equal(MP.priceUsd('claude', 'haiku'), 0);
  assert.equal(MP.priceUsd('claude', 'haiku', { inputTokens: -5, outputTokens: 'x' }), 0, 'nonsense counts as nothing');
  assert.equal(MP.priceUsd('claude', 'haiku', { inputTokens: 10, cachedInputTokens: 50 }), 0.000005, 'cached beyond input is still billed as cached');
});

test('priceUsd on Codex is codex-pricing.js; Ollama and anything else are free', () => {
  const usage = { inputTokens: 21000, cachedInputTokens: 20000, outputTokens: 800 };
  for (const model of ['gpt-5', 'gpt-5-mini', null, 'gpt-6-luna']) {
    assert.equal(MP.priceUsd('codex', model, usage), codexPricing.priceUsd(model, usage), String(model));
  }
  assert.equal(MP.priceUsd('codex', 'gpt-5-mini', usage), 0.00235);
  assert.equal(MP.priceUsd('ollama', 'qwen3.5:9b', usage), 0);
  assert.equal(MP.priceUsd('none', null, usage), 0);
  assert.equal(MP.priceUsd(undefined, 'haiku', usage), 0);
});

test('the tables cannot be changed by a caller', () => {
  assert.ok(Object.isFrozen(MP.MODELS) && Object.isFrozen(MP.MODELS['claude-haiku-4-5']) && Object.isFrozen(MP.ALIASES) && Object.isFrozen(MP.PREFIXES));
  const r = MP.claudeRate('haiku');
  r.in = 999;
  assert.equal(MP.claudeRate('haiku').in, 1, 'a returned entry is a copy');
});
