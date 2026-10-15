'use strict';
/**
 * ollama.js — local LLM chat helper.
 * Talks to Ollama's /api/chat. Default model is the workhorse role (qwen3.5:9b; override via BRAIN_MODEL).
 * Strips qwen's <think>…</think> reasoning blocks from the returned content.
 * chat() answers with the text; chatMessage() with the whole assistant turn, tool calls included (local-first A7: the
 * local agent runner, lib/local-agent.js, sends `tools` and reads `message.tool_calls`).
 */
const http = require('http');

const { role } = require('./models.js');
const MODEL = role('workhorse').tag; // same BRAIN_MODEL env semantics as before

/**
 * endpoint({ host, port }) -> where to reach Ollama. Explicit opts win (provider.js threads
 * config.ollama through every call), then OLLAMA_HOST/OLLAMA_PORT, then the local default.
 */
function endpoint(opts = {}) {
  return {
    host: opts.host || process.env.OLLAMA_HOST || '127.0.0.1',
    port: Number(opts.port || process.env.OLLAMA_PORT || 11434),
  };
}

// Resolved once at load for legacy readers; live callers go through endpoint(opts).
const { host: HOST, port: PORT } = endpoint();

function stripThink(s) {
  return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Sizes the serving context window to the request. Ollama's default num_ctx
 * (4096) silently CLIPS longer prompts — a 50KB transcript tail evaluates as
 * ~2K tokens and generation starts at the window edge, truncating replies
 * mid-JSON (live failures 2026-08-07: 576-578-char cut replies). chars/3
 * over-estimates tokens for English+code, which is the safe direction; capped
 * at 32K so small callers never allocate monster KV caches by accident.
 * Rounded to 4096 buckets: every DISTINCT num_ctx forces Ollama to reload the
 * model, so interleaved pipelines (heartbeat, wrap, file-map) should land on
 * as few window sizes as possible.
 */
function sizeContextWindow(promptChars, numPredict) {
  const needed = Math.ceil(promptChars / 3) + numPredict;
  return Math.min(32768, Math.max(4096, Math.ceil(needed / 4096) * 4096));
}

/**
 * buildChatBody(opts) -> the exact /api/chat request body. Pure — exported for
 * tests. think passes through unchanged (false for qwen think-off, or an
 * effort string 'low'|'medium'|'high' for a model with a think dial). keepAlive (when given)
 * becomes keep_alive so callers control residency per role. `tools` (function definitions in the
 * OpenAI shape Ollama takes: { type: 'function', function: { name, description, parameters } }) is
 * sent only when non-empty.
 */
function buildChatBody(opts = {}) {
  const { system, prompt, messages, model = MODEL, numPredict = 2048, think = false, format, keepAlive, tools } = opts;
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  if (system) msgs.unshift({ role: 'system', content: system });
  if (prompt) msgs.push({ role: 'user', content: prompt });
  const promptChars = msgs.reduce((n, m) => n + String(m.content || '').length, 0);
  const numCtx = opts.numCtx || sizeContextWindow(promptChars, numPredict);
  return {
    model,
    messages: msgs,
    stream: false,
    think,
    options: { num_predict: numPredict, num_ctx: numCtx },
    ...(format ? { format } : {}),
    ...(keepAlive != null ? { keep_alive: keepAlive } : {}),
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
  };
}

/**
 * The tool calls of an assistant message, normalized for both engines (openai-compat.js shares it):
 * [{ id, name, args, argError }]. Ollama sends `arguments` as an object, an OpenAI-compatible server as a JSON string;
 * a string that does not parse, or arguments that are not an object, leave args null with argError saying why.
 */
function normalizeToolCalls(list) {
  if (!Array.isArray(list)) return [];
  return list.map((c, i) => {
    const fn = (c && c.function) || {};
    let args = fn.arguments;
    let argError = null;
    if (typeof args === 'string') {
      try { args = args.trim() ? JSON.parse(args) : {}; } catch { args = null; argError = 'arguments are not valid JSON'; }
    }
    if (args == null && !argError) args = {};
    if (!argError && (typeof args !== 'object' || Array.isArray(args))) { args = null; argError = 'arguments must be an object'; }
    return { id: c && typeof c.id === 'string' && c.id ? c.id : null, index: i, name: typeof fn.name === 'string' ? fn.name : '', args, argError };
  });
}

/** A chat reply larger than this is cut off and rejected: no answer the callers use comes near it. */
const CHAT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * POST /api/chat; resolves the parsed reply. `timeoutMs` is an idle timeout (no byte for that long), and with
 * `wallClock` also the most the whole request may take; `opts.signal` (an AbortSignal) destroys it. A reply over
 * CHAT_MAX_BYTES is rejected.
 */
function postChat(opts, { wallClock = false } = {}) {
  const { timeoutMs = 180000, signal } = opts;
  const { host, port } = endpoint(opts);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(buildChatBody(opts));
    let settled = false;
    let timer = null;
    let req = null;
    const onAbort = () => { if (req) req.destroy(); finish(reject, new Error('ollama request aborted')); };
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };

    req = http.request({
      hostname: host,
      port,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > CHAT_MAX_BYTES) { req.destroy(); return finish(reject, new Error(`ollama reply over ${CHAT_MAX_BYTES} bytes`)); }
        chunks.push(c);
      });
      res.on('error', (e) => finish(reject, e));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          return finish(reject, new Error(`ollama HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          finish(resolve, JSON.parse(data));
        } catch (e) {
          finish(reject, new Error('ollama parse error: ' + e.message));
        }
      });
    });

    req.on('error', (e) => finish(reject, e));
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(reject, new Error('ollama timeout')); });
    if (wallClock) timer = setTimeout(() => { req.destroy(); finish(reject, new Error('ollama timeout')); }, timeoutMs);
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    req.write(body);
    req.end();
  });
}

/**
 * chat({ system, prompt, messages, model, numPredict, timeoutMs }) -> Promise<string>
 */
async function chat(opts = {}) {
  const parsed = await postChat(opts);
  return stripThink(parsed && parsed.message && parsed.message.content);
}

/**
 * chatMessage({ messages, tools, model, numPredict, numCtx, timeoutMs, signal, ... }) -> Promise<{ content, toolCalls,
 * message, usage: { inputTokens, outputTokens }, doneReason }>: one assistant turn, within `timeoutMs` of wall clock.
 * `message` is the reply as Ollama sent it, to append to the history as is; a tool result goes back as
 * toolMessage(call, text).
 */
async function chatMessage(opts = {}) {
  const parsed = await postChat(opts, { wallClock: true });
  const message = (parsed && parsed.message) || { role: 'assistant', content: '' };
  return {
    content: stripThink(message.content),
    toolCalls: normalizeToolCalls(message.tool_calls),
    message: { role: 'assistant', content: String(message.content || ''), ...(Array.isArray(message.tool_calls) && message.tool_calls.length ? { tool_calls: message.tool_calls } : {}) },
    usage: { inputTokens: Number(parsed && parsed.prompt_eval_count) || 0, outputTokens: Number(parsed && parsed.eval_count) || 0 },
    doneReason: (parsed && parsed.done_reason) || null,
  };
}

/** The history entry carrying one tool call's result back to Ollama. */
function toolMessage(call, content) {
  return { role: 'tool', content: String(content), tool_name: call.name, ...(call.id ? { tool_call_id: call.id } : {}) };
}

/**
 * ping(timeoutMs, { host, port }) -> Promise<boolean>. Liveness probe against /api/tags.
 * Never throws — a dead or absent listener resolves false.
 *
 * Added 2026-08-14: the Mac rebooted mid-generation and launchd took ~55s to get
 * :11434 serving again. Every pipeline that fired in that window discovered the
 * outage as an ECONNREFUSED *mid-run* and threw its work away. Callers that can
 * afford to wait (auto-wrap's detached SessionEnd worker) should poll this
 * first instead.
 */
function ping(timeoutMs = 2000, opts = {}) {
  const { host, port } = endpoint(opts);
  return new Promise((resolve) => {
    const req = http.request({ hostname: host, port, path: '/api/tags', method: 'GET' }, (res) => {
      res.resume(); // drain, so the socket closes instead of leaking the agent
      resolve(!!res.statusCode && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * tags(timeoutMs, { host, port }) -> Promise<string[] | null>: the names of the pulled models (`qwen3.5:9b`), or null
 * when nothing answers. The same request as ping(), read instead of drained (local-first A13: ready means pulled).
 */
function tags(timeoutMs = 2000, opts = {}) {
  const { host, port } = endpoint(opts);
  return new Promise((resolve) => {
    const req = http.request({ hostname: host, port, path: '/api/tags', method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) return resolve(null);
        try {
          const list = JSON.parse(data).models;
          resolve(Array.isArray(list) ? list.map((m) => m && (m.name || m.model)).filter((n) => typeof n === 'string') : []);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** `qwen3.5` and `qwen3.5:latest` name the same model; every other tag is compared as written. */
function sameModel(a, b) {
  const n = (s) => (String(s).includes(':') ? String(s) : `${s}:latest`);
  return !!a && !!b && n(a) === n(b);
}

/**
 * pull(model, { host, port, onProgress, timeoutMs }) -> Promise<void>: Ollama's /api/pull, streamed. onProgress gets
 * each line ({ status, completed?, total? }); a line carrying `error` rejects. The timeout is per idle gap, not total.
 */
function pull(model, opts = {}) {
  const { host, port } = endpoint(opts);
  const idleMs = opts.timeoutMs || 120000;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, stream: true });
    const req = http.request({
      hostname: host, port, path: '/api/pull', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => reject(new Error(`ollama pull HTTP ${res.statusCode}: ${data.slice(0, 200)}`)));
        return;
      }
      let buf = '';
      let failed = null;
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.error) failed = new Error(`ollama pull: ${msg.error}`);
          else if (opts.onProgress) { try { opts.onProgress(msg); } catch { /* a progress printer never fails the pull */ } }
        }
      });
      res.on('end', () => (failed ? reject(failed) : resolve()));
    });
    req.on('error', reject);
    req.setTimeout(idleMs, () => { req.destroy(); reject(new Error('ollama pull: no progress for ' + Math.round(idleMs / 1000) + ' s')); });
    req.write(body);
    req.end();
  });
}

module.exports = { chat, chatMessage, toolMessage, normalizeToolCalls, CHAT_MAX_BYTES, ping, tags, pull, sameModel, endpoint, stripThink, sizeContextWindow, buildChatBody, MODEL, HOST, PORT };
