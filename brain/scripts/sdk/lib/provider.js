'use strict';
/**
 * provider.js — the one model abstraction. Every script asks for a provider and never
 * for Ollama or Claude directly.
 *
 *   ollama  → config.ollama.{host,port}, default 127.0.0.1:11434 (chat + embed)
 *   claude  → headless `claude -p --model <cfg>` via claude-cli.js (chat only; capped + ledgered)
 *   codex   → headless `codex exec` via codex-cli.js (chat only; capped + ledgered, spend estimated)
 *   none    → chat/embed throw ProviderUnavailable('PROVIDER_NONE'); callers fall back to heuristics
 *
 * `local` (the default for new installs, local-first A1/A10): the local engine — Ollama, or an OpenAI-compatible server
 * (`local.engine: openai`, e.g. LM Studio) — when it answers AND serves the workhorse (cached 60 s in state.local); the
 * provider is still named `ollama`, with `engine` saying which server. Otherwise none with reason `local-down` (nothing
 * answers) or `local-model-missing` (not pulled), which callers treat as "queue or go heuristic", never a failure. Only
 * with `local.hostedFallback: true` does it then try the hosted legs below, under the same hook caps. Local calls cost
 * nothing and are counted in brain/_index/local-usage.json, not the spend ledger (local-first A18).
 *
 * `auto`: Ollama ping (2 s, cached 60 s) → claude if the binary resolves and
 * `claude auth status` says signed in (cached 24 h; no model call, local-first A16) → codex, but only when Codex is a configured host
 * (hosts.codex.enabled, or a recorded codex.bin) and `codex login status` says logged in (cached
 * 24 h) → none. Both CLIs share the hook cap: codex.perDayUsd governs codex.* spend the same way
 * claude.perDayUsd governs claude.* spend, against the same hook ledger sum. A provider whose day is over budget
 * resolves to none with reason 'daily-cap' — "budget" is claude.perDayUsd against hook spend
 * only: spendToday() skips the persona's duty:* rows (persona.perDayUsd), the reasoner's
 * reason:* rows (reasoner.perDayUsd) and prompt routines' routine:* rows (routines.perDayUsd).
 *
 * Roles (models.js) can override the chain: getProviderForRole('reasoner') resolves a hosted model
 * — built with the reasoner's own caps (reasoner.perCallUsd, reasoner.perDayUsd) — even while Ollama
 * is up. Claude first (reasoner.model) when Claude Code is a host and logged in, else Codex
 * (reasoner.codexModel → codex.model → the user's Codex default) when Codex is configured and
 * logged in; an explicit `provider: codex` puts Codex first (spec 2026-09-23-codex-parity-gaps D1).
 * `provider: none` still wins: it means nothing calls a model. Every other role gets the global provider.
 * Under `provider: local` the reasoner features (Vault chat, ask, reflect-week, consolidate-memory; AI_FEATURES) follow
 * their own switch `ai.<feature>` (local-first A2): `local`, the default, answers on the local engine and never a host
 * (down: none with the local reason, and the button that asked may offer a host once); `host` keeps the hosted
 * reasoner above. A caller that names a host (`prefer`) always gets that host. Other providers ignore `ai.*`.
 * Codex calls that pass no effort use codex.effort (default low): the user's own Codex default may be
 * a slow, expensive one, and a background summary needs none of it.
 *
 * State lives in brain/_index/provider-state.json, spend in
 * brain/_index/provider-spend.jsonl (spend-ledger.js).
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../../lib/paths.js');
const { loadConfig } = require('../../lib/config.js');
const ollama = require('./ollama.js');
const embedModule = require('./embed.js');
const claudeCli = require('./claude-cli.js');
const codexCli = require('./codex-cli.js');
const openaiCompat = require('./openai-compat.js');
const { role, providerFor, thinkFor, LOCAL_TIERS } = require('./models.js');
const { dayCap } = require('../../lib/settings-schema.js');
const { ProviderUnavailable, recordSpend, spendToday, reasonSpendToday, routineSpendToday, SPEND_PATH } = require('./spend-ledger.js');
const { recordLocalCall } = require('./local-usage.js');
// The local engine's settings (local-first A8, A11): engine, address, workhorse and embedder roles (local-config.js).
const { localCfg } = require('./local-config.js');

const STATE_PATH = path.join(PATHS.INDEX, 'provider-state.json');
const OLLAMA_TTL_MS = 60_000;
const CLAUDE_TTL_MS = 24 * 60 * 60 * 1000;

function readState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); return s && typeof s === 'object' ? s : {}; }
  catch { return {}; }
}
function writeState(st) {
  try {
    require('../../lib/fsx.js').writeAtomic(STATE_PATH, JSON.stringify(st, null, 2) + '\n');
  } catch { /* state is a cache; losing it only costs a re-probe */ }
}
function isFresh(entry, ttlMs, now) {
  return !!(entry && entry.checkedAt && (now - Date.parse(entry.checkedAt)) < ttlMs);
}

/** ollama.chat opts → one prompt string for `claude -p`. */
function messagesToPrompt(opts) {
  if (opts.prompt != null && opts.prompt !== '') return String(opts.prompt);
  return (Array.isArray(opts.messages) ? opts.messages : []).map((m) => `${m.role}: ${m.content}`).join('\n');
}

/** cfg.ollama ({ host, port }) rides along on every call so config, not just env, picks the address. */
function makeOllama(reason, cfg) {
  const net = (cfg && cfg.ollama) || {};
  return {
    name: 'ollama', reason,
    capabilities: { chat: true, embed: true, structured: true },
    chat: (opts = {}) => ollama.chat({ ...net, ...opts }),
    // postEmbed is the raw HTTP path; embed.js's default postFn routes back through getProvider().
    embed: (texts, opts = {}) => embedModule.embed(texts, { ...net, ...opts, postFn: opts.postFn || embedModule.postEmbed }),
    ping: () => ollama.ping(2000, net),
  };
}

/**
 * The two Claude budgets. `hookBudget` is what the auto chain hands out (claude.*, hook spend);
 * `reasonerBudget` is the reasoner role's (reasoner.*, reason:* spend). A budget carries the
 * model, both caps, the ledger sum that governs the daily cap, and the config key named in the
 * cap error so the message says which knob to turn.
 */
function hookBudget(cfg, deps = {}) {
  return {
    model: cfg.claude.model, perCallUsd: cfg.claude.perCallUsd, perDayUsd: cfg.claude.perDayUsd,
    spent: deps.spendToday || spendToday, capKey: 'claude.perDayUsd', label: 'daily hook cap', effort: undefined,
  };
}
function reasonerBudget(cfg, deps = {}) {
  const r = cfg.reasoner || {};
  return {
    model: role('reasoner', cfg).tag, perCallUsd: Number(r.perCallUsd) || 0.5, perDayUsd: dayCap(r.perDayUsd, 5),
    spent: deps.reasonSpendToday || reasonSpendToday, capKey: 'reasoner.perDayUsd', label: 'daily reasoner cap',
    effort: thinkFor('reasoner', undefined, cfg),
  };
}

function makeClaude(reason, budget, deps = {}) {
  const call = deps.claudeCall || claudeCli.claudeCall;
  return {
    name: 'claude', reason, model: budget.model,
    capabilities: { chat: true, embed: false, structured: true },
    async chat(opts = {}) {
      if (budget.spent() >= budget.perDayUsd) {
        throw new ProviderUnavailable('PROVIDER_CAP', `${budget.label} of ${budget.perDayUsd} USD reached (${budget.capKey})`, 'claude');
      }
      const schema = opts.schema || (opts.format === 'json' ? { type: 'object' } : undefined);
      // `effort` is only meaningful for the reasoner: the caller's dial, else the budget's default.
      const effort = !budget.fixedEffort && claudeCli.EFFORTS.includes(opts.think) ? opts.think : budget.effort;
      const r = await call({
        system: opts.system || '', prompt: messagesToPrompt(opts), schema,
        model: budget.model, maxBudgetUsd: budget.perCallUsd, effort,
        timeoutMs: opts.timeoutMs || 120000, feature: opts.feature || 'unknown',
      });
      if (schema && r.structured != null) return JSON.stringify(r.structured);
      return r.text;
    },
    embed: () => Promise.reject(new ProviderUnavailable('PROVIDER_NONE', 'the claude provider has no embeddings', 'claude')),
    ping: async () => true,
  };
}

/** The Codex hook budget: codex.* keys, the same hook ledger sum, its own cap key in the error. */
function codexEffort(cfg) {
  const e = cfg.codex && cfg.codex.effort;
  return codexCli.EFFORTS.includes(e) ? e : 'low';
}
function codexBudget(cfg, deps = {}) {
  const c = cfg.codex || {};
  return {
    model: role('codex', cfg).tag, perCallUsd: Number(c.perCallUsd) || 0.05, perDayUsd: dayCap(c.perDayUsd, 0.5),
    spent: deps.spendToday || spendToday, capKey: 'codex.perDayUsd', label: 'daily hook cap', effort: codexEffort(cfg),
  };
}
/** The reasoner on Codex: the reasoner's caps and ledger family, reasoner.codexModel (else codex.model), reasoner.effort. */
function reasonerCodexBudget(cfg, deps = {}) {
  const r = cfg.reasoner || {};
  const model = (typeof r.codexModel === 'string' && r.codexModel) || role('codex', cfg).tag;
  const effort = codexCli.EFFORTS.includes(r.effort) ? r.effort : 'medium';
  return {
    model, perCallUsd: Number(r.perCallUsd) || 0.5, perDayUsd: dayCap(r.perDayUsd, 5),
    spent: deps.reasonSpendToday || reasonSpendToday, capKey: 'reasoner.perDayUsd', label: 'daily reasoner cap', effort,
  };
}
/** Claude Code as a host: enabled, or a config that predates `hosts` (Claude only). */
function claudeHostEnabled(cfg) {
  const h = cfg.hosts && cfg.hosts.claude;
  return !cfg.hosts || !!(h && h.enabled !== false);
}

/** Codex joins the auto chain only when `aos init --host codex` wired it (or a codex.bin was recorded). */
function codexConfigured(cfg) {
  const h = cfg.hosts && cfg.hosts.codex;
  return !!((h && h.enabled) || (cfg.codex && cfg.codex.bin));
}

function makeCodex(reason, budget, deps = {}) {
  const call = deps.codexCall || codexCli.codexCall;
  return {
    name: 'codex', reason, model: budget.model,
    capabilities: { chat: true, embed: false, structured: true },
    async chat(opts = {}) {
      if (budget.spent() >= budget.perDayUsd) {
        throw new ProviderUnavailable('PROVIDER_CAP', `${budget.label} of ${budget.perDayUsd} USD reached (${budget.capKey})`, 'codex');
      }
      const schema = opts.schema || (opts.format === 'json' ? { type: 'object' } : undefined);
      const effort = !budget.fixedEffort && codexCli.EFFORTS.includes(opts.think) ? opts.think : budget.effort;
      const r = await call({
        system: opts.system || '', prompt: messagesToPrompt(opts), schema,
        model: budget.model, effort,
        timeoutMs: opts.timeoutMs || 120000, feature: opts.feature || 'unknown',
      });
      if (schema && r.structured != null) return JSON.stringify(r.structured);
      return r.text;
    },
    embed: () => Promise.reject(new ProviderUnavailable('PROVIDER_NONE', 'the codex provider has no embeddings', 'codex')),
    ping: async () => true,
  };
}

/** Is headless Codex usable? Binary + `codex login status`, cached 24 h in state.codex. Mutates state. */
async function resolveCodexLogin(state, now, iso, deps) {
  const resolveBin = deps.resolveCodexBin || codexCli.resolveCodexBin;
  const probe = deps.codexLoginProbe || codexCli.loginProbe;
  if (isFresh(state.codex, CLAUDE_TTL_MS, now)) {
    return { loggedIn: !!state.codex.loggedIn, bin: state.codex.bin || null };
  }
  const bin = resolveBin();
  const loggedIn = bin ? await probe({ bin, timeoutMs: deps.probeTimeoutMs || 10_000 }) : false;
  state.codex = { loggedIn, checkedAt: iso, bin };
  return { loggedIn, bin };
}

/** The codex leg of the chain: login → cap → provider, else none with the reason that fits. */
async function resolveCodex(state, now, iso, cfg, deps, okReason, fallbackReason) {
  const { loggedIn, bin } = await resolveCodexLogin(state, now, iso, deps);
  if (!loggedIn) return makeNone(bin ? 'codex-not-logged-in' : fallbackReason);
  const budget = codexBudget(cfg, deps);
  if (budget.spent() >= budget.perDayUsd) return makeNone('daily-cap', 'codex');
  return makeCodex(okReason, budget, deps);
}

/** No provider. A daily cap's none names the host whose cap it is (`host`), which its reason does not say. */
function makeNone(reason, host = null) {
  const refuse = () => Promise.reject(new ProviderUnavailable('PROVIDER_NONE', `no model provider (${reason})`, 'none'));
  return {
    name: 'none', reason, host,
    capabilities: { chat: false, embed: false, structured: false },
    chat: refuse, embed: refuse, ping: async () => false,
  };
}

/**
 * Is headless Claude usable? Binary + login probe, cached 24 h in state.claude. The probe runs
 * inside hooks (SessionEnd included), so it is capped well below loginProbe's own 60 s default:
 * a login that has not answered in 10 s is a "no" for this run, and the cache means the wait is
 * paid at most once a day. Mutates `state.claude`; the caller writes the state file.
 *
 * `deps.unbilled` (lib/memory-ai.js estimate, brain-ai A5: "no call, nothing billed") never runs the probe: a cache older
 * than a day reads as signed in when the binary resolves, and is left as it is (the caller writes no state either), so
 * the next real resolve probes and says otherwise. The probe is `claude auth status` now (local-first A16), no longer a
 * billed call, but an estimate still spawns nothing.
 */
async function resolveClaudeLogin(state, now, iso, deps) {
  const resolveBin = deps.resolveClaudeBin || claudeCli.resolveClaudeBin;
  const probe = deps.loginProbe || claudeCli.loginProbe;
  if (isFresh(state.claude, CLAUDE_TTL_MS, now)) {
    return { loggedIn: !!state.claude.loggedIn, bin: state.claude.bin || null };
  }
  const bin = resolveBin();
  if (deps.unbilled) return { loggedIn: !!bin, bin };
  const loggedIn = bin ? await probe({ bin, timeoutMs: deps.probeTimeoutMs || 10_000 }) : false;
  state.claude = { loggedIn, checkedAt: iso, bin };
  return { loggedIn, bin };
}

/** The models the local engine serves, or null when it does not answer (one request either way). */
function listLocalModels(lc) {
  return lc.engine === 'openai' ? openaiCompat.models(lc.url, 2000) : ollama.tags(2000, lc.net);
}

/**
 * The workhorse to run (local-first A13): the role's tag when it is pulled. A tag picked by the RAM tier may give way to
 * another tier's model that is pulled (an 8 GB Mac that already has the 9b keeps using it); a tag the user named
 * (local.model or BRAIN_MODEL) never silently does. null when nothing usable is pulled.
 */
function pickLocalModel(workhorse, models) {
  if (models.some((m) => ollama.sameModel(m, workhorse.tag))) return workhorse.tag;
  if (workhorse.source !== 'tier') return null;
  const other = LOCAL_TIERS.map((t) => t.tag).reverse().find((t) => models.some((m) => ollama.sameModel(m, t)));
  return other || null;
}

/** Is the local engine up with its model pulled? Cached 60 s in state.local (mutated). { ok, reason, lc, model, embedder } */
async function resolveLocal(state, now, iso, cfg, deps) {
  const lc = localCfg(cfg);
  let st = state.local;
  if (!(isFresh(st, OLLAMA_TTL_MS, now) && st.engine === lc.engine && st.url === lc.url)) {
    const list = await (deps.localModels || listLocalModels)(lc);
    st = { engine: lc.engine, url: lc.url, reachable: Array.isArray(list), models: Array.isArray(list) ? list.slice(0, 200) : [], checkedAt: iso };
    state.local = st;
  }
  if (!st.reachable) return { ok: false, reason: 'local-down', lc };
  const model = pickLocalModel(lc.workhorse, st.models);
  if (!model) return { ok: false, reason: 'local-model-missing', lc };
  const embedder = st.models.some((m) => ollama.sameModel(m, lc.embedder.tag)) ? lc.embedder.tag : null;
  return { ok: true, reason: 'local-ready', lc, model, embedder };
}

/**
 * The local engine as a provider. Its name is `ollama` whichever server answers (callers ask `name === 'ollama'` to mean
 * "the local model, free"); `engine` says which. Every call runs on the resolved model unless the caller names a
 * different one, keeps the role's residency, and counts toward local-usage.json (local-first A18).
 */
function makeLocal(r, deps = {}) {
  const { lc, model, embedder } = r;
  const count = deps.recordLocalCall || recordLocalCall;
  const timed = async (feature, fn) => {
    const t0 = Date.now();
    const out = await fn();
    count({ feature, ms: Date.now() - t0 });
    return out;
  };
  // A caller passing the role's own tag (qwen.js does) gets the model that resolved, which may be another tier's.
  const pick = (opts) => (opts.model && opts.model !== lc.workhorse.tag ? opts.model : model);
  const noEmbed = () => Promise.reject(new ProviderUnavailable('PROVIDER_NONE', `the local embedder ${lc.embedder.tag} is not pulled`, 'ollama'));
  const base = { name: 'ollama', engine: lc.engine, reason: r.reason, model, embedder, capabilities: { chat: true, embed: !!embedder, structured: true } };
  if (lc.engine === 'openai') {
    const call = deps.openaiChat || openaiCompat.chat;
    return {
      ...base,
      chat: (opts = {}) => timed(opts.feature || 'unknown', () => call({ ...opts, url: lc.url, model: pick(opts) })),
      embed: (texts, opts = {}) => (embedder ? timed('embed', () => openaiCompat.embed(texts, { ...opts, url: lc.url, model: embedder })) : noEmbed()),
      ping: async () => Array.isArray(await openaiCompat.models(lc.url, 2000)),
    };
  }
  const call = deps.ollamaChat || ollama.chat;
  return {
    ...base,
    chat: (opts = {}) => timed(opts.feature || 'unknown', () => call({ ...lc.net, keepAlive: lc.workhorse.keepAlive, ...opts, model: pick(opts) })),
    embed: (texts, opts = {}) => (embedder
      ? timed('embed', () => embedModule.embed(texts, { ...lc.net, ...opts, model: embedder, postFn: opts.postFn || embedModule.postEmbed }))
      : noEmbed()),
    ping: () => ollama.ping(2000, lc.net),
  };
}

/**
 * local-first A2: the reasoner features with a per-feature engine switch, by the feature label their ledger rows and
 * local-usage rows carry, and the `ai.<key>` that switches each.
 */
const AI_FEATURES = Object.freeze({ 'reason:chat': 'chat', 'reason:ask': 'ask', 'reason:reflect-week': 'reflectWeek', 'reason:consolidate-memory': 'consolidate' });
function aiKeyOf(feature) { return Object.prototype.hasOwnProperty.call(AI_FEATURES, feature) ? AI_FEATURES[feature] : null; }

/** Where an AI feature runs: 'local' (the local engine) only under provider local with `ai.<key>` not `host`; else 'host'. */
function aiEngine(cfg, feature) {
  const key = aiKeyOf(feature);
  if (!key || !cfg || cfg.provider !== 'local') return 'host';
  return cfg.ai && cfg.ai[key] === 'host' ? 'host' : 'local';
}

/**
 * The local engine alone, for work that runs there by choice (ai.<feature>, the sweep): never the hosted legs, whatever
 * local.hostedFallback says (that switch is for unattended work; a button offers a host once instead). Only the local
 * cache in the state file is refreshed: its name and reason keep describing the global provider.
 */
async function resolveLocalOnly(feature, deps = {}) {
  const cfg = loadConfig();
  const now = deps.now ? deps.now() : Date.now();
  const iso = new Date(now).toISOString();
  const state = readState();
  const r = await resolveLocal(state, now, iso, cfg, deps);
  if (!deps.unbilled) writeState(state);
  return r.ok ? makeLocal(r, deps) : makeNone(r.reason);
}

/** The hosted legs of the chain: Claude when logged in and under its cap, else Codex in auto (or local's fallback). */
async function resolveHosted(m, state, now, iso, cfg, deps, budget) {
  const { loggedIn, bin } = await resolveClaudeLogin(state, now, iso, deps);
  const claudeReason = bin ? 'claude-not-logged-in' : 'no-provider';
  if (loggedIn) {
    return budget.spent() >= budget.perDayUsd ? makeNone('daily-cap', 'claude') : makeClaude(m === 'claude' ? 'forced' : 'claude-logged-in', budget, deps);
  }
  if ((m === 'auto' || m === 'local') && codexConfigured(cfg)) return resolveCodex(state, now, iso, cfg, deps, 'codex-logged-in', claudeReason);
  return makeNone(claudeReason);
}

async function resolveProvider({ mode, feature = 'unknown', deps = {} } = {}) {
  const cfg = loadConfig();
  const m = mode || cfg.provider || 'auto';
  const now = deps.now ? deps.now() : Date.now();
  const state = readState();
  const pingFn = deps.ping || ollama.ping;
  const iso = new Date(now).toISOString();
  const budget = hookBudget(cfg, deps);

  let chosen;
  if (m === 'ollama') chosen = makeOllama('forced', cfg);
  else if (m === 'none') chosen = makeNone('forced');
  else if (m === 'codex') chosen = await resolveCodex(state, now, iso, cfg, deps, 'forced', 'no-provider');
  else if (m === 'local') {
    // local-first A1/A3: the local engine, else nothing (the caller queues or goes heuristic) unless the user allowed
    // the hosted legs; a hosted answer keeps the local reason in the state so the HUD can say why it spent.
    const r = await resolveLocal(state, now, iso, cfg, deps);
    if (r.ok) chosen = makeLocal(r, deps);
    else if (r.lc.hostedFallback) {
      chosen = await resolveHosted(m, state, now, iso, cfg, deps, budget);
      // Nobody hosted either: the local reason is the one to fix, unless a hosted cap is what stopped it.
      if (chosen.name === 'none' && chosen.reason !== 'daily-cap') chosen = makeNone(r.reason);
    } else chosen = makeNone(r.reason);
    state.localReason = r.reason;
  } else {
    let ollamaOk = false;
    if (m === 'auto') {
      if (isFresh(state.ollama, OLLAMA_TTL_MS, now)) ollamaOk = !!state.ollama.reachable;
      else {
        ollamaOk = await pingFn(2000, cfg.ollama);
        state.ollama = { reachable: ollamaOk, checkedAt: iso };
      }
    }
    if (ollamaOk) chosen = makeOllama('ollama-reachable', cfg);
    else chosen = await resolveHosted(m, state, now, iso, cfg, deps, budget);
  }
  if (m !== 'local') delete state.localReason;
  state.checkedAt = iso;
  state.name = chosen.name;
  state.reason = chosen.reason;
  state.feature = feature;
  if (chosen.engine) state.engine = chosen.engine; else delete state.engine;
  if (chosen.name === 'ollama' && chosen.model) state.model = chosen.model; else delete state.model;
  // An unbilled resolve (an estimate) may rest on a login it did not check: it records nothing.
  if (!deps.unbilled) writeState(state);
  return chosen;
}

/**
 * The provider for one role. Roles served by Ollama take the global chain; the reasoner takes
 * headless Claude with its own model and caps whatever the global answer is (Ollama being up
 * does not make a Claude model local). `provider: none` disables it like everything else. The
 * state file's `name`/`reason` keep describing the global provider — only the claude login
 * cache is shared — so the HUD and `aos status` are not misled by a reasoner resolution.
 */
/**
 * The provider for a role. For the reasoner the caller may name the host, model and effort (Vault chat's menu, spec
 * 2026-10-07-sessions-ux U9): `prefer` is the only host tried (no silent move to the other), `model` replaces the
 * role's model, and `effort` (a level that host's CLI takes) is fixed for every call, whatever `think` a caller passes.
 *
 * `hostOpts` ({ claude: { model, effort }, codex: { model, effort } }) names them per host instead (brain-ai A6: the
 * memory sweep runs under the reasoner's caps on the background models, claude.model with no --effort, or codex.model
 * at codex.effort). A host's entry wins over `model` and `effort` for that host, so a Claude alias never reaches Codex:
 * its `model` (a non-empty string) replaces the role's model, null on Codex's entry passes no -m (the user's own Codex
 * default, never reasoner.codexModel), else the role's model stays; its `effort` is a level that
 * host's CLI takes, fixed for every call, or null, which for Claude means no --effort at all (and so no thinking,
 * claude-cli.js) and for Codex keeps the role's level (Codex with none would run at the user's own, maybe costly,
 * default). A host without an entry takes `model` and `effort` as before.
 */
async function resolveProviderForRole({ role: roleName, feature = 'unknown', deps = {}, prefer = null, model = null, effort = null, hostOpts = null } = {}) {
  if (providerFor(roleName) !== 'claude') return resolveProvider({ feature, deps });
  const cfg = loadConfig();
  const mode = cfg.provider || 'auto';
  if (mode === 'none') return makeNone('forced');
  const now = deps.now ? deps.now() : Date.now();
  const iso = new Date(now).toISOString();
  const state = readState();
  const reasoner = roleName === 'reasoner';
  // An unbilled resolve (an estimate) records nothing: resolveClaudeLogin's comment.
  const save = () => { if (!deps.unbilled) writeState(state); };
  const chosen = reasoner && (prefer === 'claude' || prefer === 'codex') ? prefer : null;
  // local-first A2: an AI feature switched to the local engine answers there, with no host behind it; a named host wins.
  if (reasoner && !chosen && aiEngine(cfg, feature) === 'local') return resolveLocalOnly(feature, deps);
  const pin = (budget, host) => {
    const own = hostOpts && typeof hostOpts === 'object' && hostOpts[host] && typeof hostOpts[host] === 'object' ? hostOpts[host] : null;
    const m = own ? own.model : model;
    const e = own ? own.effort : effort;
    if (typeof m === 'string' && m.trim()) budget.model = m.trim();
    // A Codex entry's `model: null` is no -m at all (the user's own Codex default), never the role's reasoner.codexModel.
    else if (own && host === 'codex' && own.model === null) budget.model = null;
    const levels = host === 'codex' ? codexCli.EFFORTS : claudeCli.EFFORTS;
    if (levels.includes(e)) { budget.effort = e; budget.fixedEffort = true; }
    else if (own && e === null && host === 'claude') { budget.effort = undefined; budget.fixedEffort = true; }
    return budget;
  };
  // Claude first unless the user chose Codex for background calls; Codex only for the reasoner, and only when configured.
  const order = chosen ? [chosen] : reasoner && mode === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  const why = [];
  for (const host of order) {
    if (host === 'claude') {
      if (!claudeHostEnabled(cfg) && reasoner) { why.push('claude host disabled'); continue; }
      const budget = reasoner ? pin(reasonerBudget(cfg, deps), 'claude') : hookBudget(cfg, deps);
      const { loggedIn, bin } = await resolveClaudeLogin(state, now, iso, deps);
      if (!loggedIn) { why.push(bin ? 'claude-not-logged-in' : 'no-provider'); continue; }
      save();
      if (budget.spent() >= budget.perDayUsd) return makeNone(`${roleName}-daily-cap`, 'claude');
      return makeClaude(`role:${roleName}`, budget, deps);
    }
    if (!reasoner || !codexConfigured(cfg)) { if (chosen) why.push('codex-not-configured'); continue; }
    const { loggedIn, bin } = await resolveCodexLogin(state, now, iso, deps);
    if (!loggedIn) { why.push(bin ? 'codex-not-logged-in' : 'no-codex'); continue; }
    save();
    const budget = pin(reasonerCodexBudget(cfg, deps), 'codex');
    if (budget.spent() >= budget.perDayUsd) return makeNone(`${roleName}-daily-cap`, 'codex');
    return makeCodex(`role:${roleName}`, budget, deps);
  }
  save();
  if (chosen && why.length) return makeNone(why[0]);
  return makeNone(why.includes('claude-not-logged-in') ? 'claude-not-logged-in' : why.includes('codex-not-logged-in') ? 'codex-not-logged-in' : 'no-provider');
}

/**
 * local-first A17: under provider local, the hosts' sign-in kept fresh (the HUD shows Sessions while an enabled host is
 * signed in, and provider local never asks a host otherwise; the other providers' resolves keep it already). Each
 * enabled host's cached login is refreshed when older than a day: `claude auth status` and `codex login status`, free
 * (A16), no model call. → { claude, codex } as cached; nothing at all under another provider.
 */
async function refreshHostLogins({ deps = {} } = {}) {
  const cfg = loadConfig();
  if (cfg.provider !== 'local') return { claude: null, codex: null, skipped: true };
  const now = deps.now ? deps.now() : Date.now();
  const iso = new Date(now).toISOString();
  const state = readState();
  const before = JSON.stringify([state.claude, state.codex]);
  if (claudeHostEnabled(cfg)) await resolveClaudeLogin(state, now, iso, deps);
  if (codexConfigured(cfg)) await resolveCodexLogin(state, now, iso, deps);
  if (JSON.stringify([state.claude, state.codex]) !== before) writeState(state);
  return { claude: state.claude || null, codex: state.codex || null };
}

let memo = null;
const roleMemo = new Map();
/** Memoized per process: the first call resolves, later calls share the promise. */
function getProvider(feature = 'unknown') {
  if (!memo) memo = resolveProvider({ feature });
  return memo;
}
/** Memoized per role (and AI feature, whose engine switch may differ: local-first A2) and process. Ollama-served roles
 *  share getProvider()'s promise. */
function getProviderForRole(roleName, feature = 'unknown') {
  if (providerFor(roleName) !== 'claude') return getProvider(feature);
  const key = `${roleName}|${aiKeyOf(feature) || ''}`;
  if (!roleMemo.has(key)) roleMemo.set(key, resolveProviderForRole({ role: roleName, feature }));
  return roleMemo.get(key);
}
function resetProviderCache() { memo = null; roleMemo.clear(); }

module.exports = {
  resolveProvider, getProvider, resolveProviderForRole, getProviderForRole, resetProviderCache, STATE_PATH,
  localCfg, listLocalModels, pickLocalModel, resolveLocalOnly, aiEngine, AI_FEATURES, refreshHostLogins,
  ProviderUnavailable, recordSpend, spendToday, reasonSpendToday, routineSpendToday, SPEND_PATH,
};
