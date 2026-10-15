'use strict';
/**
 * openai-compat.js — the local engine when it is not Ollama (local-first A8): any server that speaks the OpenAI API
 * (LM Studio, llama.cpp's server, vLLM) at `local.url`, e.g. http://127.0.0.1:1234/v1. Chat, embeddings and the model
 * list; no key (a local server needs none). provider.js wraps it as the `ollama` provider with engine `openai`, so every
 * caller that asks "is this the local model?" keeps working.
 */
const http = require('http');
const https = require('https');
const { stripThink } = require('./ollama.js');

/** POST/GET `<base>/<path>` with a JSON body; resolves the parsed reply, rejects with the status and a short body. */
function request(base, pathname, { method = 'GET', body, timeoutMs = 120000 } = {}) {
  const url = new URL(String(base).replace(/\/+$/, '') + pathname);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) return reject(new Error(`local engine HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('local engine parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('local engine timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** models(url, timeoutMs) -> Promise<string[] | null>: the served model ids, or null when nothing answers. */
async function models(url, timeoutMs = 2000) {
  try {
    const r = await request(url, '/models', { timeoutMs });
    return Array.isArray(r && r.data) ? r.data.map((m) => m && m.id).filter((id) => typeof id === 'string') : [];
  } catch { return null; }
}

/**
 * buildChatBody(opts) -> the /chat/completions body. Pure — exported for tests. `format: 'json'` asks for a JSON object;
 * a schema object asks for that schema (non-strict: local servers differ in how much of JSON Schema they enforce).
 */
function buildChatBody(opts = {}) {
  const { system, prompt, messages, model, numPredict = 2048, format } = opts;
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  if (system) msgs.unshift({ role: 'system', content: system });
  if (prompt) msgs.push({ role: 'user', content: prompt });
  const body = { model, messages: msgs, max_tokens: numPredict, stream: false, temperature: 0 };
  if (format === 'json') body.response_format = { type: 'json_object' };
  else if (format && typeof format === 'object') body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema: format, strict: false } };
  return body;
}

/** chat({ url, model, system, prompt, messages, format, numPredict, timeoutMs }) -> Promise<string> */
async function chat(opts = {}) {
  const r = await request(opts.url, '/chat/completions', { method: 'POST', body: buildChatBody(opts), timeoutMs: opts.timeoutMs || 180000 });
  const msg = r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message;
  return stripThink(msg && msg.content);
}

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const len = Math.sqrt(s) || 1;
  return v.map((x) => x / len);
}

/** embed(texts, { url, model, timeoutMs }) -> Promise<number[][]>, unit-normalized like embed.js. */
async function embed(texts, opts = {}) {
  const input = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || ''));
  if (!input.length) return [];
  const r = await request(opts.url, '/embeddings', { method: 'POST', body: { model: opts.model, input }, timeoutMs: opts.timeoutMs || 120000 });
  const data = Array.isArray(r && r.data) ? r.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0)) : [];
  if (data.length !== input.length || !data.every((d) => Array.isArray(d.embedding))) throw new Error('local engine embed: wrong number of embeddings in reply');
  return data.map((d) => normalize(d.embedding));
}

module.exports = { models, chat, embed, buildChatBody, request };
