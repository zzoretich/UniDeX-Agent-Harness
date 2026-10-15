'use strict';
/**
 * codex-pricing.js — per-million-token rates used to ESTIMATE Codex spend. Codex reports tokens,
 * never dollars, on both the `codex exec --json` usage block and the rollout's token_count events,
 * so every USD figure derived here is an estimate: verify against the published OpenAI price list
 * before trusting it. Unknown model ids fall back to the longest matching prefix (a dated or suffixed
 * id inherits its family's rate), then to DEFAULT_MODEL. Reasoning tokens are part of output_tokens
 * and are billed as output; cached input is billed at CACHED_MULT of the input rate.
 *
 * gpt-6-sol (the Chief of Staff's Codex model, local-first A4) was checked on 2026-10-15 against OpenAI's published
 * price list, https://developers.openai.com/api/docs/pricing (Standard tier, short context ≤ 272K input tokens):
 * $2.00 input, $0.20 cached input (a tenth, CACHED_MULT), $10.00 output per million. Above 272K input tokens it is
 * billed at $4.00 / $15.00, which this table does not model. Without its row, a duty on gpt-6-sol was estimated at the
 * gpt-5 default and counted that way against persona.perDayUsd.
 */
const RATES_AS_OF = '2026-09-21';
const DEFAULT_MODEL = 'gpt-5';
const CACHED_MULT = 0.1;
const MODELS = {
  'gpt-5': { in: 1.25, out: 10.0 },
  'gpt-5-codex': { in: 1.25, out: 10.0 },
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'gpt-5-nano': { in: 0.05, out: 0.40 },
  'gpt-4.1': { in: 2.0, out: 8.0 },
  'gpt-4.1-mini': { in: 0.40, out: 1.60 },
  'o3': { in: 2.0, out: 8.0 },
  'o4-mini': { in: 1.10, out: 4.40 },
  'gpt-6-sol': { in: 2.0, out: 10.0 },
};

/** The rate entry for a model id: exact → longest prefix → default. Also says which entry answered. */
function rateFor(model) {
  const id = String(model || '').trim().toLowerCase();
  if (id && MODELS[id]) return { model: id, ...MODELS[id], matched: 'exact' };
  let best = null;
  for (const k of Object.keys(MODELS)) {
    if (id.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  if (best) return { model: best, ...MODELS[best], matched: 'prefix' };
  return { model: DEFAULT_MODEL, ...MODELS[DEFAULT_MODEL], matched: 'default' };
}

/** USD for one usage block ({ inputTokens, cachedInputTokens, outputTokens }), rounded to 6 places. */
function priceUsd(model, usage = {}) {
  const r = rateFor(model);
  const cached = Math.max(0, Number(usage.cachedInputTokens) || 0);
  const input = Math.max(0, (Number(usage.inputTokens) || 0) - cached);
  const output = Math.max(0, Number(usage.outputTokens) || 0);
  const usd = (input * r.in + cached * r.in * CACHED_MULT + output * r.out) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

module.exports = { priceUsd, rateFor, MODELS, DEFAULT_MODEL, CACHED_MULT, RATES_AS_OF };
