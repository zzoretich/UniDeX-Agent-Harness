'use strict';
/**
 * openai-compat.js — the local engine when it is not Ollama (local-first A8): any server that speaks the OpenAI API
 * (LM Studio, llama.cpp's server, vLLM) at `local.url`, e.g. http://127.0.0.1:1234/v1. Chat, embeddings and the model
 * list; no key (a local server needs none). provider.js wraps it as the `ollama` provider with engine `openai`, so every
 * caller that asks "is this the local model?" keeps working. chatMessage() is one assistant turn with tool calls, the
 * same shape as ollama.js's, for the local agent runner (local-first A7).
 */
const http = require('http');
const https = require('https');
const { stripThink, normalizeToolCalls } = require('./ollama.js');

/** A chat reply larger than this is cut off and rejected (embeddings and the model list are not capped). */
const CHAT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * POST/GET `<base>/<path>` with a JSON body; resolves the parsed reply, rejects with the status and a short body.
 * `timeoutMs` is an idle timeout, and with `wallClock` also the most the whole request may take; `maxBytes` caps the
 * reply; `signal` (an AbortSignal) destroys it.
 */
function request(base, pathname, { method = 'GET', body, timeoutMs = 120000, wallClock = false, maxBytes = Infinity, signal } = {}) {
  const url = new URL(String(base).replace(/\/+$/, '') + pathname);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let req = null;
    const onAbort = () => { if (req) req.destroy(); finish(reject, new Error('local engine request aborted')); };
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    req = lib.request(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); return finish(reject, new Error(`local engine reply over ${maxBytes} bytes`)); }
        chunks.push(c);
      });
      res.on('error', (e) => finish(reject, e));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) return finish(reject, new Error(`local engine HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { finish(resolve, JSON.parse(data)); } catch (e) { finish(reject, new Error('local engine parse error: ' + e.message)); }
      });
    });
    req.on('error', (e) => finish(reject, e));
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(reject, new Error('local engine timeout')); });
    if (wallClock) timer = setTimeout(() => { req.destroy(); finish(reject, new Error('local engine timeout')); }, timeoutMs);
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
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
 * `tools` (function definitions) is sent with tool_choice auto only when non-empty.
 */
function buildChatBody(opts = {}) {
  const { system, prompt, messages, model, numPredict = 2048, format, tools } = opts;
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  if (system) msgs.unshift({ role: 'system', content: system });
  if (prompt) msgs.push({ role: 'user', content: prompt });
  const body = { model, messages: msgs, max_tokens: numPredict, stream: false, temperature: 0 };
  if (format === 'json') body.response_format = { type: 'json_object' };
  else if (format && typeof format === 'object') body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema: format, strict: false } };
  if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  return body;
}

/** chat({ url, model, system, prompt, messages, format, numPredict, timeoutMs }) -> Promise<string> */
async function chat(opts = {}) {
  const r = await request(opts.url, '/chat/completions', { method: 'POST', body: buildChatBody(opts), timeoutMs: opts.timeoutMs || 180000, maxBytes: CHAT_MAX_BYTES });
  const msg = r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message;
  return stripThink(msg && msg.content);
}

/**
 * chatMessage({ url, model, messages, tools, numPredict, timeoutMs, signal }) -> Promise<{ content, toolCalls, message,
 * usage, doneReason }>, as ollama.js chatMessage: `timeoutMs` is wall clock. A tool call the server sent without an id gets `call_<n>` (in `message` too),
 * so its result can name it.
 */
async function chatMessage(opts = {}) {
  const r = await request(opts.url, '/chat/completions', { method: 'POST', body: buildChatBody(opts), timeoutMs: opts.timeoutMs || 180000, wallClock: true, maxBytes: CHAT_MAX_BYTES, signal: opts.signal });
  const choice = r && Array.isArray(r.choices) && r.choices[0];
  const msg = (choice && choice.message) || {};
  const raw = Array.isArray(msg.tool_calls) ? msg.tool_calls.map((c, i) => ({ ...c, id: c && typeof c.id === 'string' && c.id ? c.id : `call_${i}` })) : [];
  const usage = (r && r.usage) || {};
  return {
    content: stripThink(msg.content),
    toolCalls: normalizeToolCalls(raw),
    message: { role: 'assistant', content: msg.content == null ? null : String(msg.content), ...(raw.length ? { tool_calls: raw } : {}) },
    usage: { inputTokens: Number(usage.prompt_tokens) || 0, outputTokens: Number(usage.completion_tokens) || 0 },
    doneReason: (choice && choice.finish_reason) || null,
  };
}

/** The history entry carrying one tool call's result back to the server. */
function toolMessage(call, content) {
  return { role: 'tool', tool_call_id: call.id, content: String(content) };
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

module.exports = { models, chat, chatMessage, toolMessage, embed, buildChatBody, request, CHAT_MAX_BYTES };
