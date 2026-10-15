'use strict';
/**
 * ollama.js — local LLM chat helper.
 * Talks to Ollama's /api/chat. Default model is the workhorse role (qwen3.5:9b; override via BRAIN_MODEL).
 * Strips qwen's <think>…</think> reasoning blocks from the returned content.
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
 * becomes keep_alive so callers control residency per role.
 */
function buildChatBody(opts = {}) {
  const { system, prompt, messages, model = MODEL, numPredict = 2048, think = false, format, keepAlive } = opts;
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
  };
}

/**
 * chat({ system, prompt, messages, model, numPredict, timeoutMs }) -> Promise<string>
 */
function chat(opts = {}) {
  const { timeoutMs = 180000 } = opts;
  const { host, port } = endpoint(opts);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(buildChatBody(opts));

    const req = http.request({
      hostname: host,
      port,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`ollama HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const parsed = JSON.parse(data);
          resolve(stripThink(parsed.message && parsed.message.content));
        } catch (e) {
          reject(new Error('ollama parse error: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ollama timeout')); });
    req.write(body);
    req.end();
  });
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

module.exports = { chat, ping, tags, pull, sameModel, endpoint, stripThink, sizeContextWindow, buildChatBody, MODEL, HOST, PORT };
