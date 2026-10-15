'use strict';
/**
 * local-config.js — the local engine's settings (local-first A8, A11), pure: no vault, no network, no state. provider.js
 * resolves the engine with them (is it up, is the model pulled); lib/headless.js names the graph pass's target with them
 * without loading provider.js.
 *
 *   localCfg(cfg) → { engine, url, net, workhorse, embedder, hostedFallback }
 *     engine     'ollama' | 'openai' (local.engine)
 *     url        local.url, else Ollama at ollama.host:ollama.port, or LM Studio's http://127.0.0.1:1234/v1 for openai
 *     net        { host, port } for ollama.js (local.url's when it is set and parses; a bad URL reads as unreachable)
 *     workhorse  models.js role('workhorse'), embedder role('embedder')
 *   openaiBase(lc) → the OpenAI-compatible base URL the engine answers at: Ollama's own `<url>/v1`, a server's url as is.
 */
const { role } = require('./models.js');

function localCfg(cfg) {
  const l = (cfg && cfg.local) || {};
  const engine = l.engine === 'openai' ? 'openai' : 'ollama';
  const o = (cfg && cfg.ollama) || {};
  const set = typeof l.url === 'string' && l.url.trim() ? l.url.trim().replace(/\/+$/, '') : null;
  const url = set || (engine === 'openai' ? 'http://127.0.0.1:1234/v1' : `http://${o.host || '127.0.0.1'}:${o.port || 11434}`);
  let net = { host: o.host, port: o.port };
  if (engine === 'ollama' && set) {
    try { const u = new URL(set); net = { host: u.hostname, port: Number(u.port) || 11434 }; } catch { /* a bad URL reads as unreachable */ net = { host: '0.0.0.0', port: 9 }; }
  }
  return { engine, url, net, workhorse: role('workhorse', cfg), embedder: role('embedder', cfg), hostedFallback: l.hostedFallback === true };
}

function openaiBase(lc) {
  return lc.engine === 'openai' ? lc.url : `${lc.url.replace(/\/v1$/, '')}/v1`;
}

module.exports = { localCfg, openaiBase };
