'use strict';
/**
 * qwen.js — higher-level model helpers: summarize (map-reduce chunking), extract
 * (structured JSON), classify, reason. All helpers accept an injectable chatFn for
 * offline testing; the default chat goes through sdk/lib/provider.js, so the same
 * code runs on Ollama, headless Claude, or throws ProviderUnavailable with no model.
 * summarize/extract/classify are workhorse calls (the global provider); reason() is the
 * reasoner role's (getProviderForRole: headless Claude), with the workhorse as its fallback.
 */
const chat = (opts) => require('./provider.js').getProvider(opts.feature).then((p) => p.chat(opts));
/** The workhorse as a fallback chat, or null when the global provider is not Ollama (nothing local to fall back to). */
async function workhorseFallback(feature) {
  const g = await require('./provider.js').getProvider(feature);
  return g.name === 'ollama' ? (o) => g.chat(o) : null;
}
const { parseAgentJson } = require('./json-extract.js');
const { role, thinkFor } = require('./models.js');

class QwenEmptyError extends Error {
  constructor(msg) { super(msg || 'qwen returned empty response'); this.name = 'QwenEmptyError'; }
}

const DEFAULT_MAX_CHARS = 12000;

function splitOversized(block, maxChars) {
  const out = [];
  let buf = '';
  for (const line of String(block).split(/\n/)) {
    if (line.length > maxChars) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars));
      continue;
    }
    if (buf && (buf + '\n' + line).length > maxChars) { out.push(buf); buf = line; }
    else { buf = buf ? buf + '\n' + line : line; }
  }
  if (buf) out.push(buf);
  return out;
}

function chunkText(text, maxChars = DEFAULT_MAX_CHARS) {
  const s = String(text || '');
  if (!s.trim()) return [];
  if (s.length <= maxChars) return [s];
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf) { chunks.push(buf); buf = ''; } };
  for (const para of s.split(/\n\n+/)) {
    if (para.length > maxChars) { flush(); chunks.push(...splitOversized(para, maxChars)); continue; }
    if (buf && (buf + '\n\n' + para).length > maxChars) { flush(); buf = para; }
    else { buf = buf ? buf + '\n\n' + para : para; }
  }
  flush();
  return chunks;
}

async function callWithRetry(chatFn, args) {
  let reply = await chatFn(args);
  if (!reply || !String(reply).trim()) reply = await chatFn(args); // the workhorse sometimes returns empty
  if (!reply || !String(reply).trim()) throw new QwenEmptyError();
  return String(reply).trim();
}

function summarizeSystem({ style, maxWords, focus }) {
  const styleHint = {
    bullets: 'Output terse markdown bullets.',
    prose: 'Output a tight prose paragraph.',
    outline: 'Output a nested outline.',
  }[style] || 'Output terse markdown bullets.';
  return [
    'You compress text. Preserve facts, names, numbers, decisions, and action items.',
    styleHint,
    focus ? `Focus on: ${focus}` : '',
    `Keep it under ${maxWords} words. No preamble, no meta-commentary, no emoji.`,
  ].filter(Boolean).join(' ');
}

async function summarizeOnce(text, o) {
  const system = summarizeSystem(o);
  return callWithRetry(o.chatFn, { system, prompt: text, numPredict: 1024, timeoutMs: o.timeoutMs });
}

async function summarize(text, opts = {}) {
  const o = {
    style: opts.style || 'bullets',
    maxWords: opts.maxWords || 150,
    focus: opts.focus || null,
    chatFn: opts.chatFn || chat,
    maxChars: opts.maxChars || DEFAULT_MAX_CHARS,
    timeoutMs: opts.timeoutMs,
  };
  const s = String(text || '');
  if (!s.trim()) return '';
  let current = s;
  while (current.length > o.maxChars) {
    const summaries = [];
    for (const c of chunkText(current, o.maxChars)) summaries.push(await summarizeOnce(c, o));
    const joined = summaries.join('\n\n');
    if (joined.length >= current.length) break; // no-progress guard
    current = joined;
  }
  return summarizeOnce(current, o);
}

async function extract(text, opts = {}) {
  const chatFn = opts.chatFn || chat;
  const system = [
    'You extract structured data. Return ONLY valid JSON. No prose, no code fences.',
    opts.instructions || '',
    opts.schema ? 'Desired shape:\n' + JSON.stringify(opts.schema, null, 2) : '',
  ].filter(Boolean).join('\n');
  // format:'json' makes Ollama grammar-constrain decoding — prose/think-block
  // replies become impossible; truncation (numPredict) stays the residual risk.
  const reply = await callWithRetry(chatFn, {
    system,
    prompt: String(text || ''),
    numPredict: opts.numPredict || 1024,
    timeoutMs: opts.timeoutMs,
    format: 'json',
    ...(opts.jsonSchema ? { schema: opts.jsonSchema } : {}),
    ...(opts.feature ? { feature: opts.feature } : {}),
  });
  try {
    return parseAgentJson(reply);
  } catch (e) {
    // The ledger only records the error message — carry evidence of what the
    // model actually said so parse failures are diagnosable after the fact.
    e.message += ` — reply started: ${JSON.stringify(String(reply).slice(0, 160))}`;
    throw e;
  }
}

async function classify(text, opts = {}) {
  const labels = opts.labels || [];
  const multi = !!opts.multi;
  const chatFn = opts.chatFn || chat;
  const system = [
    `Classify the text. Allowed labels: ${labels.join(', ')}.`,
    multi ? 'Return every label that applies, comma-separated.' : 'Return exactly one label.',
    'Return only the label(s). No prose.',
  ].join(' ');
  const reply = await callWithRetry(chatFn, { system, prompt: String(text || ''), numPredict: 64, timeoutMs: opts.timeoutMs });
  const lc = reply.toLowerCase();
  const found = labels.filter((l) => {
    const esc = l.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\W)${esc}(\\W|$)`).test(lc);
  });
  return multi ? found : (found[0] || null);
}

/**
 * reason(prompt, opts) — deep Q&A / reflection via the reasoner role (a Claude model through
 * getProviderForRole, or the local engine for an AI feature switched to it, local-first A2). `think` carries the effort dial; the claude provider turns it into
 * `--effort`. Falls back to the workhorse on the global provider when the reasoner call fails
 * (not logged in, daily cap, timeout) and that provider is Ollama, so interactive commands
 * degrade instead of dying. Set opts.noFallback to propagate the error instead.
 *
 * opts.chatFn / opts.fallbackChatFn inject the two chats; opts.providerName says which provider
 * chatFn belongs to — a non-claude provider cannot serve a Claude model id, so it is sent the
 * workhorse request straight away. opts.feature labels the ledger row (reason:<caller>).
 */
async function reason(prompt, opts = {}) {
  const feature = opts.feature || 'reason:unknown';
  let chatFn = opts.chatFn;
  let providerName = opts.chatFn ? (opts.providerName || 'claude') : null;
  if (!chatFn) {
    // The reasoner's provider, asked first: under provider local an AI feature may resolve to the local engine
    // (local-first A2), which is sent the workhorse request, never a Claude model id.
    const p = await require('./provider.js').getProviderForRole('reasoner', feature);
    chatFn = (o) => p.chat(o);
    providerName = p.name;
  }
  const r = role('reasoner');
  const w = role('workhorse');
  const base = {
    system: opts.system,
    prompt: String(prompt || ''),
    numPredict: opts.numPredict || 2048,
    timeoutMs: opts.timeoutMs || 300000,
    feature,
    ...(opts.format ? { format: opts.format } : {}),
  };
  const reasonerArgs = { ...base, model: r.tag, think: thinkFor('reasoner', opts.effort) };
  // A workhorse request in full: think off, resident, auto-sized context — never a stale
  // think/keepAlive/numCtx left over from the reasoner attempt.
  const workhorseArgs = { ...base, model: w.tag, think: false, keepAlive: w.keepAlive, numCtx: opts.numCtx || undefined };
  const fallback = async () => {
    if (opts.fallbackChatFn) return opts.fallbackChatFn;
    return workhorseFallback(feature);
  };
  if (providerName === 'ollama') return callWithRetry(chatFn, workhorseArgs);
  try {
    return await callWithRetry(chatFn, reasonerArgs);
  } catch (err) {
    if (opts.noFallback) throw err;
    const fb = await fallback();
    if (!fb) throw err;
    process.stderr.write(`[reason] reasoner (${r.tag}) unavailable — falling back to the workhorse (${w.tag}): ${err.message}\n`);
    return callWithRetry(fb, workhorseArgs);
  }
}

module.exports = { summarize, extract, classify, chunkText, reason, summarizeSystem, QwenEmptyError };
