'use strict';
/**
 * model-pricing.js — what a model call costs per provider, for the estimates shown before a call (brain-ai A5): the
 * Brain hub's "about $0.004 · haiku · Claude" before Merge with AI or a sweep. After a call Claude reports its own
 * `total_cost_usd` and that figure wins; Codex reports tokens only, priced by codex-pricing.js (kept there, unchanged);
 * Ollama is local and costs nothing.
 *
 *   claudeRate(model)                   → { model, in, out, matched }: USD per million tokens. An alias (haiku, sonnet,
 *                                         opus) names its current model; else the id itself; else its longest known
 *                                         prefix (a dated, suffixed or "[1m]" id inherits its family's rate); else
 *                                         DEFAULT_MODEL. `matched` says which: alias | exact | prefix | default.
 *   priceUsd(provider, model, usage)    → USD for { inputTokens, cachedInputTokens, outputTokens }, 6 places.
 *                                         claude: input at `in`, cached input at `in` × CACHED_MULT, output at `out`;
 *                                         codex: codex-pricing.priceUsd; ollama (and anything else): 0.
 *
 * `inputTokens` counts every input token, the cached ones included (codex-cli.js parseEvents' convention, which
 * codex-pricing.js prices), so the cached share is billed once, at the cached rate.
 *
 * Claude's rates are a copy of extras/cost/pricing.json (models, default_model, the cache read multiplier, its date):
 * the runtime never reads that file, because extras/ is not vendored into a vault. test/model-pricing.test.js pins
 * this table to it, so a change there fails here until both agree. Verify against Anthropic's published prices before
 * trusting a dollar figure.
 */
const codexPricing = require('./codex-pricing.js');

const RATES_AS_OF = '2026-05-29';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const CACHED_MULT = 0.1;
const MODELS = Object.freeze({
  'claude-opus-5': Object.freeze({ in: 15.0, out: 75.0 }),
  'claude-opus-4-8': Object.freeze({ in: 15.0, out: 75.0 }),
  'claude-opus-4-7': Object.freeze({ in: 15.0, out: 75.0 }),
  'claude-sonnet-4-6': Object.freeze({ in: 3.0, out: 15.0 }),
  'claude-haiku-4-5': Object.freeze({ in: 1.0, out: 5.0 }),
});
// The aliases `claude --model` takes (claude.model defaults to haiku), and what each names today.
const ALIASES = Object.freeze({ haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-5' });
// Family prefixes for an id the table does not list: the family's newest priced model.
const PREFIXES = Object.freeze({
  'claude-haiku': 'claude-haiku-4-5', 'claude-sonnet': 'claude-sonnet-4-6', 'claude-opus': 'claude-opus-5', 'claude-opus-4': 'claude-opus-4-8',
});

const entry = (id, matched) => ({ model: id, ...MODELS[id], matched });

/** The rate entry for a Claude model id or alias (the module comment's order). */
function claudeRate(model) {
  const id = String(model == null ? '' : model).trim().toLowerCase();
  if (ALIASES[id]) return entry(ALIASES[id], 'alias');
  if (id && MODELS[id]) return entry(id, 'exact');
  let best = null;
  for (const k of [...Object.keys(MODELS), ...Object.keys(PREFIXES)]) {
    if (id.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  if (best) return entry(MODELS[best] ? best : PREFIXES[best], 'prefix');
  return entry(DEFAULT_MODEL, 'default');
}

const tokens = (n) => Math.max(0, Number(n) || 0);

/** USD for one call's usage on `provider` (the module comment), rounded to 6 places. */
function priceUsd(provider, model, usage = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  if (provider === 'codex') return codexPricing.priceUsd(model, u);
  if (provider !== 'claude') return 0;
  const r = claudeRate(model);
  const cached = tokens(u.cachedInputTokens);
  const input = Math.max(0, tokens(u.inputTokens) - cached);
  const usd = (input * r.in + cached * r.in * CACHED_MULT + tokens(u.outputTokens) * r.out) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

module.exports = { claudeRate, priceUsd, MODELS, ALIASES, PREFIXES, DEFAULT_MODEL, CACHED_MULT, RATES_AS_OF };
