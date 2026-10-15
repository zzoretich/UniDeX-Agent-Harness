'use strict';
/**
 * models.js — single source of truth for the model roles.
 * Roles: workhorse (background hooks/jobs, Ollama), reasoner (deep Q&A / reflection,
 * headless Claude), embedder (vector recall, Ollama), claude (the hook fallback when
 * Ollama is away), codex (the hook fallback when Claude is away too and Codex is a
 * configured host). Callers ask for a role, never a tag, and `providerFor(role)` says
 * which provider serves it — provider.js routes on that.
 *
 * Tag precedence per role: env override → config key → DEFAULTS below.
 *   workhorse  BRAIN_MODEL      →  local.model     (default qwen3.5:9b; under provider local by RAM tier, local-first A12:
 *                                                   qwen3.5:4b under 12 GB, else qwen3.5:9b)
 *   reasoner   BRAIN_REASONER   →  reasoner.model  (default claude-opus-5)
 *   embedder   BRAIN_EMBEDDER   →  local.embedder  (default qwen3-embedding:0.6b)
 *   claude     AOS_CLAUDE_MODEL →  claude.model    (default haiku)
 *   codex      AOS_CODEX_MODEL  →  codex.model     (default null = the user's Codex default)
 * Env is read lazily on every call. The Mac's memory is os.totalmem(), or AOS_TOTALMEM (bytes) where a test pins it.
 */
const os = require('os');

const GB = 1024 ** 3;
/** local-first A12: the workhorse a Mac of this much memory runs well, first match wins; the app's wizard pulls the same. */
const LOCAL_TIERS = [{ belowGb: 12, tag: 'qwen3.5:4b' }, { belowGb: Infinity, tag: 'qwen3.5:9b' }];
/** The workhorse outside provider local: every Mac, as before 2.0. */
const LARGE_TAG = 'qwen3.5:9b';
/** At or above this much memory the workhorse stays loaded between calls; below it Ollama unloads it after 5 minutes. */
const RESIDENT_GB = 24;

function totalMemBytes() {
  const pinned = Number(process.env.AOS_TOTALMEM);
  return Number.isFinite(pinned) && pinned > 0 ? pinned : os.totalmem();
}
function workhorseForMemory(bytes = totalMemBytes()) {
  return LOCAL_TIERS.find((t) => bytes < t.belowGb * GB).tag;
}
function workhorseKeepAlive(bytes = totalMemBytes()) {
  return bytes >= RESIDENT_GB * GB ? -1 : '5m';
}
/** local.keepAlive → Ollama's keep_alive: a number, a whole-number string as a number ("-1" → -1), a duration as is; else null. */
function parseKeepAlive(k) {
  if (typeof k === 'number') return Number.isFinite(k) ? k : null;
  if (typeof k !== 'string' || !k.trim()) return null;
  const t = k.trim();
  return /^-?\d+$/.test(t) ? Number(t) : t;
}

// cfgField names the key inside the cfgKey block that holds the tag (default `model`). The workhorse's null tag and null
// keepAlive are resolved in role(): by tier under provider local, else the 9b kept loaded (`local.keepAlive` overrides).
const DEFAULTS = {
  workhorse: { tag: null, env: 'BRAIN_MODEL', cfgKey: 'local', cfgField: 'model', keepAlive: null, effort: false, numCtxCap: 32768, provider: 'ollama' },
  // The reasoner is a Claude model id (pinned, not the floating `opus` alias). keepAlive and
  // numCtxCap are Ollama concepts and stay null; `effort` maps onto `claude -p --effort`.
  reasoner:  { tag: 'claude-opus-5', env: 'BRAIN_REASONER', cfgKey: 'reasoner', keepAlive: null, effort: true, numCtxCap: null, provider: 'claude' },
  // The embedder is small (about 0.6 GB) and recall's query embed has a 5 s budget, so it stays loaded on every tier.
  embedder:  { tag: 'qwen3-embedding:0.6b', env: 'BRAIN_EMBEDDER', cfgKey: 'local', cfgField: 'embedder', keepAlive: -1, effort: false, numCtxCap: null, provider: 'ollama' },
  claude:    { tag: 'haiku', env: 'AOS_CLAUDE_MODEL', cfgKey: 'claude', keepAlive: null, effort: false, numCtxCap: null, provider: 'claude' },
  // A null tag means "pass no -m": codex exec then uses whatever model the user's Codex config selects.
  codex:     { tag: null, env: 'AOS_CODEX_MODEL', cfgKey: 'codex', keepAlive: null, effort: false, numCtxCap: null, provider: 'codex' },
};

const EFFORTS = ['low', 'medium', 'high'];

/** Merged config, or {} when no vault resolves (plain-node tests, extras run outside a vault). */
function readConfig(cfg) {
  if (cfg) return cfg;
  try { return require('../../lib/config.js').loadConfig(); } catch { return {}; }
}

/** Which provider serves a role: 'ollama' for workhorse/embedder, 'claude' for reasoner/claude, 'codex' for codex. */
function providerFor(name) {
  const d = DEFAULTS[name];
  if (!d) throw new Error('unknown model role: ' + name);
  return d.provider;
}

/**
 * role(name, cfg?) — { role, tag, keepAlive, effort, numCtxCap, provider }. `cfg` is the merged
 * config (loaded when omitted); only roles with a cfgKey consult it.
 */
function role(name, cfg) {
  const d = DEFAULTS[name];
  if (!d) throw new Error('unknown model role: ' + name);
  let tag = process.env[d.env];
  let source = tag ? 'env' : null;
  let keepAlive = d.keepAlive;
  if (d.cfgKey) {
    const c = readConfig(cfg);
    const block = c[d.cfgKey];
    const field = d.cfgField || 'model';
    if (!tag && block && typeof block[field] === 'string' && block[field].trim()) { tag = block[field].trim(); source = 'config'; }
    if (name === 'workhorse') {
      // The RAM tiers and the tiered residency belong to provider local (local-first A12): an install on auto keeps the
      // 9b it pulled and the always-loaded workhorse it had, whatever the Mac's memory.
      const local = c.provider === 'local';
      keepAlive = parseKeepAlive(block && block.keepAlive) ?? (local ? workhorseKeepAlive() : -1);
      if (!tag) { tag = local ? workhorseForMemory() : LARGE_TAG; source = local ? 'tier' : 'default'; }
    }
  }
  return { role: name, tag: tag || d.tag, source: source || 'default', keepAlive, effort: d.effort, numCtxCap: d.numCtxCap, provider: d.provider };
}

// Effort for a call: the workhorse is hard-false (a hybrid thinking model burns its budget
// otherwise — standing feedback rule); the reasoner takes 'low'|'medium'|'high', defaulting
// to reasoner.effort in config, then 'medium'; everything else false.
function thinkFor(name, effort, cfg) {
  if (name === 'workhorse') return false;
  const r = role(name, cfg);
  if (!r.effort) return false;
  if (EFFORTS.includes(effort)) return effort;
  const block = readConfig(cfg).reasoner;
  const fromCfg = block && String(block.effort || '').toLowerCase();
  return EFFORTS.includes(fromCfg) ? fromCfg : 'medium';
}

module.exports = { role, thinkFor, providerFor, EFFORTS, LOCAL_TIERS, RESIDENT_GB, totalMemBytes, workhorseForMemory, workhorseKeepAlive };
