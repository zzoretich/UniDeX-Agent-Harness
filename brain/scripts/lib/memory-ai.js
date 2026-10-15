'use strict';
/**
 * memory-ai.js — the Brain hub's one seam to a model (brain-hub D21, D22; brain-ai A5–A7, A12): who would answer a
 * merge draft or a consolidation sweep, what one call would cost before it is made, and the call itself with what it
 * cost after. lib/memory-merge.js (mergeDraft) and lib/memory-sweep.js (sweep) both go through it, and their tests
 * replace it whole (`opts.ai`). It writes nothing of its own: a call's resolve may refresh provider-state.json (as any
 * resolve does; an estimate's never does) and a real call appends its spend-ledger row.
 *
 *   resolve(kind, { deps })   → { available, reason, provider, model, p, meter } (off: capHost, the host whose cap
 *            stopped it, when a cap did); no model call but the provider's login probe (estimate skips even that).
 *     merge  the hook chain (A7, feature `memory-merge`): Ollama, else a logged-in `claude` on claude.model under the
 *            hook caps (--max-budget-usd claude.perCallUsd, claude.perDayUsd), else Codex when it is a configured host
 *            (codex.model at codex.effort, codex.perDayUsd); `aos provider` pins one.
 *     sweep  the reasoner role (A6, feature `reason:memory-sweep`: the reasoner's caps and ledger family, D22) on the
 *            background models through provider.js `hostOpts`: claude.model with no --effort, else codex.model (else
 *            the model in Codex's own config.toml, else no -m: Codex's own default) at codex.effort. Under provider
 *            local it runs on the local engine alone (local-first A15; provider.js resolveLocalOnly), which
 *            lib/memory-sweep.js sends brain-hub's duplicates and clusters in chunks within the model's context; off
 *            with `local-down` or `local-model-missing` when it cannot answer. Elsewhere, a sweep nobody hosted could
 *            answer while Ollama is up runs on Ollama the same way (the old `ollama-only` refusal is gone); one
 *            resolving to none for another reason (a host signed out, a cap, `none`) is off with that reason, so a
 *            signed-out host still says to sign in.
 *   `host` ('claude' | 'codex', on resolve, estimate and call): "Run once on Claude/Codex" (local-first A3): that host
 *            only, under the caps it always has (merge: the hook chain's, provider.js mode claude/codex; sweep: the
 *            reasoner's), whatever the provider says. A button offers it only when the local engine is down and the
 *            estimate's `once` lists the host.
 *   estimate(kind, { chars, outTokens, deps, host }) → Estimate { available, reason, provider, model, tokensIn,
 *            tokensOut, usd, cap, once } (A5): tokensIn = ceil(chars / 4) + OVERHEAD[provider], all priced as fresh input;
 *            `once` (off for a local reason only, else []) lists the hosts that could run it once, each as an Estimate;
 *            tokensOut = outTokens (default NUM_PREDICT[kind], the most a call may write); priced by model-pricing.js.
 *            Off: usd 0, provider none, and the cap that stopped it when a cap did. No call, nothing billed: it resolves
 *            with provider.js `deps.unbilled`, so Claude's login probe (a real `claude -p` call) never runs and no
 *            provider state is written; a login cache older than a day reads as signed in when `claude` is installed,
 *            and the real call that follows checks it (and says so when it is not).
 *   call(kind, { system, prompt, schema, timeoutMs, numPredict, deps, host }) → { text, provider, model, usd, estimated, cap }:
 *            one call (TIMEOUT_MS and NUM_PREDICT per kind unless given; the schema also goes as Ollama's `format`).
 *            usd is Claude's own total_cost_usd, else Codex's priced tokens (estimated: true), else 0 (Ollama); cap is
 *            re-read after the call, for "today $y of $z". It throws provider.js's ProviderUnavailable unchanged
 *            (PROVIDER_NONE · PROVIDER_CAP · PROVIDER_UNREACHABLE); the PROVIDER_NONE it raises itself for a provider
 *            that cannot answer carries `reason` (and, for a cap, the `cap` that stopped it), and any other failure is
 *            tagged with the `provider` that failed.
 *   capFor(kind, provider, { deps }) → the cap a call there counts against: { family, perDayUsd, spentToday,
 *            perCallUsd } (perCallUsd null under Codex, which has no per-call flag), null for Ollama and none.
 *   who(p) → { provider, model }: the label "drafted by <model> · <Provider>" (Ollama's model is the workhorse tag).
 *   reasonSentence(reason | error | estimate, cfg) → the sentence the page shows (the plan's Shapes): "No model
 *            provider is set up.", "Today's model cap is reached ($0.50, claude.perDayUsd).", "Claude Code is not
 *            signed in.", "Codex is not signed in.", "<Provider> did not answer.", "The model's reply could not be
 *            read." (reason `bad-reply`), the local engine's two ("The local model is not answering…", "…not
 *            downloaded yet…"), and `ollama-only`'s own (an older runtime's sweep refusal; this one never gives it).
 *
 * The usage is caught by wrapping deps.claudeCall / deps.codexCall around the provider (the lib/workspace-draft.js
 * precedent), never by diffing the ledger, which races with hooks (A5). A Codex call runs with a fresh, empty temp
 * folder as its cwd, gone afterwards, so its read-only sandbox starts nowhere near the vault.
 *
 * provider.js, config.js and the CLIs fix the vault when first required (paths.js): the caller points AOS_VAULT at the
 * vault before a verb runs (as `aos workspace draft` does), and this module requires them only when a function runs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dayCap } = require('./settings-schema.js');

const KINDS = Object.freeze(['merge', 'sweep']);
const FEATURES = Object.freeze({ merge: 'memory-merge', sweep: 'reason:memory-sweep' });
// Input tokens a call costs beyond its prompt (A5): Claude's system prompt and schema; Codex's own agent preamble. A
// one-shot `codex exec --ephemeral` gets no prompt-cache hit: a live check's merge draft and sweep billed 26.5k and 28.9k
// input tokens, none cached, for prompts of about 1.5k and 4k, so the preamble is about 25k, priced as fresh input.
const OVERHEAD = Object.freeze({ claude: 600, codex: 25_000, ollama: 0, none: 0 });
// A12: the page waits 150 s; the runtime gives up first.
const TIMEOUT_MS = Object.freeze({ merge: 90_000, sweep: 120_000 });
const NUM_PREDICT = Object.freeze({ merge: 2_000, sweep: 3_000 });
// The daily-cap reasons, and the config key each cap family's message names.
const CAP_REASONS = new Set(['daily-cap', 'reasoner-daily-cap']);
const CAP_KEYS = Object.freeze({ hook: 'claude.perDayUsd', codex: 'codex.perDayUsd', reasoner: 'reasoner.perDayUsd', 'reasoner-codex': 'reasoner.perDayUsd' });
// A reasoner resolution that only says nobody could answer: with Ollama up, the sweep runs there (A15). A signed-out host
// keeps its own reason (its sentence says to sign in), Ollama or not.
const NOBODY = new Set(['no-provider']);
const OLLAMA_TTL_MS = 60_000; // provider.js's cache of the Ollama ping
const NAMES = Object.freeze({ claude: 'Claude', codex: 'Codex', ollama: 'Ollama' });
const SENTENCE = Object.freeze({
  none: 'No model provider is set up.',
  claude: 'Claude Code is not signed in.',
  codex: 'Codex is not signed in.',
  ollama: 'Only Ollama is available, and a local model cannot hold the whole brain.',
  'local-down': 'The local model is not answering (start Ollama, or your local engine).',
  'local-model-missing': 'The local model is not downloaded yet (aos local pull).',
  bad: "The model's reply could not be read.",
});

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new TypeError(`memory-ai: unknown kind "${kind}" (merge | sweep)`);
  return kind;
}
const loadConfig = () => require('./config.js').loadConfig();
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(require('../sdk/lib/provider.js').STATE_PATH, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

/** codex.effort when it is a level `codex exec` takes, else low (provider.js codexEffort). */
function codexEffort(cfg) {
  const e = cfg.codex && cfg.codex.effort;
  return require('../sdk/lib/codex-cli.js').EFFORTS.includes(e) ? e : 'low';
}

/** The sweep's models per host (A6): the background ones, under the reasoner's caps. */
function sweepHostOpts(cfg) {
  const { role } = require('../sdk/lib/models.js');
  const c = cfg.claude && typeof cfg.claude.model === 'string' && cfg.claude.model.trim() ? cfg.claude.model.trim() : role('claude', cfg).tag;
  // codex.model, else the model Codex's own config names, else null: provider.js then passes no -m (what `codex exec`
  // runs by default). Never the reasoner's reasoner.codexModel.
  const x = role('codex', cfg).tag || require('../sdk/lib/codex-cli.js').defaultModelFromConfig() || null;
  return { claude: { model: c, effort: null }, codex: { model: x, effort: codexEffort(cfg) } };
}

/** deps with claudeCall / codexCall wrapped: each call's cost lands in `meter.last`, and Codex runs in an empty temp cwd. */
function metered(deps, meter) {
  const d = { ...(deps || {}) };
  const claude = d.claudeCall || require('../sdk/lib/claude-cli.js').claudeCall;
  d.claudeCall = async (o) => {
    const r = await claude(o);
    meter.last = { provider: 'claude', usd: Number(r && r.usd) || 0, usage: (r && r.usage) || {}, model: (o && o.model) || null };
    return r;
  };
  const codex = d.codexCall || require('../sdk/lib/codex-cli.js').codexCall;
  d.codexCall = async (o) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-memory-ai-'));
    try {
      const r = await codex({ ...o, cwd });
      meter.last = { provider: 'codex', usd: Number(r && r.usd) || 0, usage: (r && r.usage) || {}, model: (r && r.model) || (o && o.model) || null };
      return r;
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
  return d;
}

/** Is Ollama what this machine has (the sweep then runs there)? Forced ollama says so; auto asks provider.js's cache, else pings. */
async function ollamaUp(cfg, deps = {}) {
  const mode = cfg.provider || 'auto';
  if (mode === 'ollama') return true;
  if (mode !== 'auto') return false;
  const st = readState();
  const now = deps.now ? deps.now() : Date.now();
  if (st.ollama && st.ollama.checkedAt && now - Date.parse(st.ollama.checkedAt) < OLLAMA_TTL_MS) return !!st.ollama.reachable;
  const ping = deps.ping || require('../sdk/lib/ollama.js').ping;
  try { return !!(await ping(2000, cfg.ollama)); } catch { return false; }
}

/** { provider, model } for a resolved provider (the label; Ollama's model is the one that resolved, else the workhorse tag). */
function who(p) {
  const name = p && Object.prototype.hasOwnProperty.call(NAMES, p.name) ? p.name : 'none';
  if (name === 'none') return { provider: 'none', model: null };
  if (name === 'ollama') return { provider: 'ollama', model: (typeof p.model === 'string' && p.model) || require('../sdk/lib/models.js').role('workhorse').tag };
  if (typeof p.model === 'string' && p.model) return { provider: name, model: p.model };
  if (name === 'codex') return { provider: 'codex', model: require('../sdk/lib/codex-cli.js').defaultModelFromConfig() || null };
  return { provider: name, model: null };
}

/** The cap a call on `provider` counts against, with today's spend read as provider.js reads it (deps seams included). */
function capOf(kind, provider, cfg, deps = {}) {
  if (provider !== 'claude' && provider !== 'codex') return null;
  const ledger = require('../sdk/lib/spend-ledger.js');
  if (kind === 'sweep') {
    const r = cfg.reasoner || {};
    return {
      family: provider === 'claude' ? 'reasoner' : 'reasoner-codex', perDayUsd: dayCap(r.perDayUsd, 5),
      spentToday: (deps.reasonSpendToday || ledger.reasonSpendToday)(), perCallUsd: provider === 'claude' ? Number(r.perCallUsd) || 0.5 : null,
    };
  }
  const spentToday = (deps.spendToday || ledger.spendToday)();
  if (provider === 'claude') {
    const c = cfg.claude || {};
    return { family: 'hook', perDayUsd: dayCap(c.perDayUsd, 0.5), spentToday, perCallUsd: Number(c.perCallUsd) || 0.05 };
  }
  return { family: 'codex', perDayUsd: dayCap((cfg.codex || {}).perDayUsd, 0.5), spentToday, perCallUsd: null };
}

function capFor(kind, provider, { deps } = {}) {
  return capOf(checkKind(kind), provider, loadConfig(), deps || {});
}

/**
 * Which host's cap stopped a resolution (a daily-cap reason carries no host): provider.js's order with its cached
 * logins. merge: `provider: codex`, or auto with Claude not signed in, is Codex's cap; else Claude's hook cap. sweep:
 * Codex first under `provider: codex` when it is signed in; else Claude when it is a host and signed in; else Codex.
 */
function cappedHost(kind, cfg) {
  const st = readState();
  const mode = cfg.provider || 'auto';
  const claudeIn = !!(st.claude && st.claude.loggedIn);
  if (kind === 'merge') return mode === 'codex' || (mode === 'auto' && !claudeIn) ? 'codex' : 'claude';
  if (mode === 'codex') return st.codex && st.codex.loggedIn ? 'codex' : 'claude';
  const h = cfg.hosts && cfg.hosts.claude;
  const claudeHost = !cfg.hosts || !!(h && h.enabled !== false);
  return claudeHost && claudeIn ? 'claude' : 'codex';
}

/** The none reasons of the local engine (provider.js resolveLocal): a button may then offer a host once (local-first A3). */
const LOCAL_REASONS = new Set(['local-down', 'local-model-missing']);

/** 'claude' | 'codex' for "Run once on …", else null. */
function onceHost(host) { return host === 'claude' || host === 'codex' ? host : null; }

/** Who would answer `kind` (the module comment); `p` is provider.js's provider, `meter` catches the cost of its call. */
async function resolve(kind, { deps, host } = {}) {
  checkKind(kind);
  const P = require('../sdk/lib/provider.js');
  const meter = { last: null };
  const d = metered(deps, meter);
  const cfg = loadConfig();
  const once = onceHost(host);
  let p;
  if (kind === 'merge') p = await P.resolveProvider({ mode: once || undefined, feature: FEATURES.merge, deps: d });
  else if (once) p = await P.resolveProviderForRole({ role: 'reasoner', feature: FEATURES.sweep, deps: d, prefer: once, hostOpts: sweepHostOpts(cfg) });
  else if ((cfg.provider || 'auto') === 'local') p = await P.resolveLocalOnly(FEATURES.sweep, d);
  else {
    p = await P.resolveProviderForRole({ role: 'reasoner', feature: FEATURES.sweep, deps: d, hostOpts: sweepHostOpts(cfg) });
    // Nobody hosted while Ollama is up: the sweep runs there in chunks (A15) instead of refusing (the old ollama-only).
    if (p && p.name === 'none' && NOBODY.has(p.reason) && await ollamaUp(cfg, deps || {})) {
      const g = await P.resolveProvider({ feature: FEATURES.sweep, deps: d });
      if (g && g.name === 'ollama') p = g;
    }
  }
  const name = p && p.name;
  if (name === 'claude' || name === 'codex' || name === 'ollama') return { available: true, reason: null, ...who(p), p, meter };
  const reason = (p && p.reason) || 'no-provider';
  // A cap's none names its host (provider.js makeNone); cappedHost's guess from the cached logins is the fallback.
  const capHost = p && (p.host === 'claude' || p.host === 'codex') ? p.host : null;
  return { available: false, reason, provider: 'none', model: null, capHost, p, meter };
}

/** What one call would cost (A5), or why none can be made; no call. */
async function estimate(kind, { chars = 0, outTokens, deps, host } = {}) {
  checkKind(kind);
  // Unbilled (provider.js): no login probe, which is a billed call, and no state written.
  const quiet = { ...(deps || {}), unbilled: true };
  const r = await resolve(kind, { deps: quiet, host });
  const cfg = loadConfig();
  const base = Math.ceil(Math.max(0, Number(chars) || 0) / 4);
  const tokensOut = outTokens == null ? NUM_PREDICT[kind] : Math.ceil(Math.max(0, Number(outTokens) || 0));
  if (!r.available) {
    const cap = CAP_REASONS.has(r.reason) ? capOf(kind, r.capHost || cappedHost(kind, cfg), cfg, deps || {}) : null;
    // The local engine is down: what each enabled, signed-in host would cost to run it once (local-first A3).
    const once = [];
    if (!onceHost(host) && LOCAL_REASONS.has(r.reason)) {
      for (const h of ['claude', 'codex']) {
        if (!hostOn(cfg, h)) continue;
        const e = await estimate(kind, { chars, outTokens, deps, host: h });
        if (e.available) once.push(e);
      }
    }
    return { available: false, reason: r.reason, provider: 'none', model: null, tokensIn: base, tokensOut, usd: 0, cap, once };
  }
  const tokensIn = base + OVERHEAD[r.provider];
  const usage = { inputTokens: tokensIn, cachedInputTokens: 0, outputTokens: tokensOut };
  const usd = require('../sdk/lib/model-pricing.js').priceUsd(r.provider, r.model, usage);
  return { available: true, reason: null, provider: r.provider, model: r.model, tokensIn, tokensOut, usd, cap: capOf(kind, r.provider, cfg, deps || {}), once: [] };
}

/** Is `host` an enabled host (`hosts.<h>.enabled`; a config without `hosts` predates Codex: Claude only)? */
function hostOn(cfg, host) {
  const h = cfg.hosts && cfg.hosts[host];
  if (!cfg.hosts) return host === 'claude';
  return !!(h && h.enabled !== false && (host === 'claude' || h.enabled));
}

/**
 * The PROVIDER_NONE a none provider's chat throws (provider.js makeNone), with the reason kept as a field, and for a
 * cap the cap that stopped it (`cap`), so its sentence and "today $y of $z" name the right one.
 */
function unavailable(reason, cap) {
  const { ProviderUnavailable } = require('../sdk/lib/spend-ledger.js');
  const e = new ProviderUnavailable('PROVIDER_NONE', `no model provider (${reason})`, 'none');
  e.reason = reason;
  if (cap) e.cap = cap;
  return e;
}

/** One model call (the module comment). */
async function call(kind, { system = '', prompt = '', schema, timeoutMs, numPredict, deps, host } = {}) {
  checkKind(kind);
  const r = await resolve(kind, { deps, host });
  if (!r.available) throw unavailable(r.reason, r.capHost ? capOf(kind, r.capHost, loadConfig(), deps || {}) : null);
  let text;
  try {
    text = await r.p.chat({
      system, prompt, schema, format: schema, feature: FEATURES[kind],
      timeoutMs: timeoutMs || TIMEOUT_MS[kind], numPredict: numPredict || NUM_PREDICT[kind],
    });
  } catch (e) {
    // Tag who failed, so reasonSentence can say "<Provider> did not answer."; a ProviderUnavailable already says.
    if (e && typeof e === 'object' && !e.provider) { try { e.provider = r.provider; } catch { /* frozen */ } }
    throw e;
  }
  const last = r.meter.last && r.meter.last.provider === r.provider ? r.meter.last : null;
  return {
    text: typeof text === 'string' ? text : String(text == null ? '' : text),
    provider: r.provider,
    model: (r.provider === 'codex' && last && last.model) || r.model,
    usd: r.provider === 'ollama' || !last ? 0 : last.usd,
    estimated: r.provider === 'codex',
    cap: capOf(kind, r.provider, loadConfig(), deps || {}),
  };
}

// ── the sentences ──

function capSentence(perDayUsd, key) {
  return Number.isFinite(perDayUsd) && key ? `Today's model cap is reached (${money(perDayUsd)}, ${key}).` : "Today's model cap is reached.";
}

/** A reason code → its sentence; a cap reason names the cap that stopped it (`cap` when the caller has it, else cfg). */
function sentenceFor(reason, cap, cfg) {
  const r = reason == null ? '' : String(reason);
  if (!r || r === 'forced' || r === 'none' || r === 'no-provider' || r === 'no-codex' || r === 'codex-not-configured' || r === 'claude host disabled') return SENTENCE.none;
  if (CAP_REASONS.has(r)) {
    if (cap && CAP_KEYS[cap.family]) return capSentence(Number(cap.perDayUsd), CAP_KEYS[cap.family]);
    let c = cfg;
    if (!c) { try { c = loadConfig(); } catch { c = null; } }
    if (!c) return capSentence(NaN, null);
    const kind = r === 'reasoner-daily-cap' ? 'sweep' : 'merge';
    const host = cappedHost(kind, c);
    const fam = kind === 'sweep' ? (host === 'claude' ? 'reasoner' : 'reasoner-codex') : host === 'claude' ? 'hook' : 'codex';
    const block = kind === 'sweep' ? c.reasoner : host === 'claude' ? c.claude : c.codex;
    return capSentence(dayCap(block && block.perDayUsd, kind === 'sweep' ? 5 : 0.5), CAP_KEYS[fam]);
  }
  if (r === 'claude-not-logged-in') return SENTENCE.claude;
  if (r === 'codex-not-logged-in') return SENTENCE.codex;
  if (r === 'ollama-only') return SENTENCE.ollama;
  if (LOCAL_REASONS.has(r)) return SENTENCE[r];
  if (r === 'bad-reply') return SENTENCE.bad;
  return `No model call possible (${r}).`;
}

/** A thrown error → its sentence: a reason it carries, a cap's own message, a sign-in, else "<Provider> did not answer." */
function errorSentence(e, cfg) {
  if (typeof e.reason === 'string' && e.reason) return sentenceFor(e.reason, e.cap || null, cfg);
  const msg = String(e.message || '');
  const name = NAMES[e.provider] || 'The model';
  if (e.code === 'PROVIDER_CAP') {
    const m = / of ([\d.]+) USD reached \(([\w.]+)\)/.exec(msg);
    return m ? capSentence(Number(m[1]), m[2]) : capSentence(NaN, null);
  }
  if (e.code === 'PROVIDER_NONE') {
    const m = /^no model provider \((.+)\)$/.exec(msg);
    return m ? sentenceFor(m[1], null, cfg) : SENTENCE.none;
  }
  if (/not logged in/i.test(msg) && (e.provider === 'claude' || e.provider === 'codex')) return SENTENCE[e.provider];
  return `${name} did not answer.`;
}

/** reasonSentence(reason | error | estimate, cfg?) → the page's sentence (the module comment). */
function reasonSentence(x, cfg) {
  if (x && typeof x === 'object' && !(x instanceof Error) && !x.code && 'reason' in x) return sentenceFor(x.reason, x.cap || null, cfg);
  if (x && typeof x === 'object') return errorSentence(x, cfg);
  return sentenceFor(x, null, cfg);
}

module.exports = {
  KINDS, FEATURES, OVERHEAD, TIMEOUT_MS, NUM_PREDICT, CAP_KEYS,
  resolve, estimate, call, capFor, who, reasonSentence,
};
