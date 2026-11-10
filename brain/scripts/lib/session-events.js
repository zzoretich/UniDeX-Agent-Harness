'use strict';
/**
 * session-events.js — one event shape for a turn of an app session, whichever host ran it (spec
 * 2026-10-07-unidex-sessions S7, §4.2). The app pipes the turn's stdout through it (lib/sessions.js events) and stores
 * and shows only what comes out, so the page never parses a host's format and never reads a transcript.
 *
 *   createParser(host, { model, now })  →  { push(chunk) → events[], end() → events[], state }
 *     push takes stdout as it arrives (any chunking; a line split across chunks waits for its end); end flushes the
 *     last line and, when the host never said the turn was over (killed, crashed), closes it as failed.
 *     state: { hostSessionId, usd, estimated, done }
 *
 *   An event is { t, kind, ... }:
 *     session      { id }                                    the id that resumes the thread (claude session_id, codex thread_id)
 *     text         { text }                                  what the agent says
 *     tool         { id, name, toolKind, summary, filePath } toolKind ∈ edit | read | bash | mcp | other (transcript.js)
 *     tool_result  { id, ok, summary }
 *     patch        { files: [{ path, change }] }             files a codex turn changed (claude edits are edit tools)
 *     plan         { items: [{ text, status }] }             the agent's to-do list, whole each time it changes: claude's
 *                                                            TodoWrite input, codex's todo_list item; status ∈ pending |
 *                                                            active | done (spec 2026-10-07-sessions-ux U10)
 *     usage        { in, out, cached, usd, estimated }       claude's cost is its own; codex's is estimated (codex-pricing.js)
 *     error        { message }
 *     done         { ok, usd, estimated }                    always the last event of a turn
 *
 *   claude: `-p --output-format stream-json --verbose` (system/init, assistant, user with tool_result, result).
 *   codex:  `exec --json` (thread.started, item.started / item.completed, turn.completed, turn.failed, error), the
 *           stream sdk/lib/codex-cli.js also reads.
 */
const { kindOf } = require('./transcript.js');
const { priceUsd } = require('../sdk/lib/codex-pricing.js');

const SUMMARY_MAX = 400;

function clip(s, n = SUMMARY_MAX) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A short one-line view of a tool's input or output. */
function summary(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return clip(value);
  if (Array.isArray(value)) {
    const text = value.map((v) => (typeof v === 'string' ? v : (v && v.text) || '')).join(' ').trim();
    if (text) return clip(text);
  }
  try { return clip(JSON.stringify(value)); } catch { return ''; }
}

const PLAN_STATUS = { completed: 'done', in_progress: 'active', pending: 'pending' };

/** Claude's TodoWrite input → plan items, or null when it holds no list. */
function claudePlan(input) {
  const todos = input && Array.isArray(input.todos) ? input.todos : null;
  if (!todos) return null;
  return todos.map((d) => ({ text: clip((d && (d.content || d.activeForm)) || '', 200), status: PLAN_STATUS[d && d.status] || 'pending' })).filter((i) => i.text);
}

/** Codex's todo_list item → plan items. */
function codexPlan(item) {
  return (Array.isArray(item.items) ? item.items : []).map((d) => ({ text: clip((d && d.text) || '', 200), status: d && d.completed ? 'done' : 'pending' })).filter((i) => i.text);
}

const filePathOf = (input) => (input && typeof input === 'object' && (input.file_path || input.notebook_path || input.path)) || null;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Claude assistant content blocks → events (text, plan, tool); shared by the stream-json and transcript mappers. */
function claudeBlocks(content, t) {
  const out = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!b) continue;
    const plan = b.type === 'tool_use' && b.name === 'TodoWrite' ? claudePlan(b.input) : null;
    if (b.type === 'text' && b.text) out.push({ t, kind: 'text', text: String(b.text) });
    else if (plan) out.push({ t, kind: 'plan', items: plan });
    else if (b.type === 'tool_use') out.push({ t, kind: 'tool', id: b.id || null, name: String(b.name || ''), toolKind: kindOf(b.name), summary: summary(b.input), filePath: filePathOf(b.input) });
  }
  return out;
}

/** Claude stream-json: one parsed line → events. */
function mapClaude(msg, st, t) {
  const out = [];
  const sid = msg.session_id;
  if (sid && !st.hostSessionId) { st.hostSessionId = String(sid); out.push({ t, kind: 'session', id: st.hostSessionId }); }
  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    out.push(...claudeBlocks(msg.message.content, t));
  } else if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
    for (const b of msg.message.content) {
      if (b && b.type === 'tool_result') out.push({ t, kind: 'tool_result', id: b.tool_use_id || null, ok: !b.is_error, summary: summary(b.content) });
    }
  } else if (msg.type === 'result') {
    const u = msg.usage || {};
    const usd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null;
    out.push({ t, kind: 'usage', in: num(u.input_tokens), out: num(u.output_tokens), cached: num(u.cache_read_input_tokens), usd, estimated: false });
    const ok = !msg.is_error && msg.subtype === 'success';
    if (!ok) out.push({ t, kind: 'error', message: String(msg.result || msg.subtype || 'the turn failed') });
    st.usd = usd; st.estimated = false; st.done = true;
    out.push({ t, kind: 'done', ok, usd, estimated: false });
  }
  return out;
}

/** Codex exec --json: one parsed line → events. */
function mapCodex(ev, st, t, model) {
  const out = [];
  const item = ev.item && typeof ev.item === 'object' ? ev.item : null;
  if (item && item.type === 'todo_list' && ['item.started', 'item.updated', 'item.completed'].includes(ev.type)) {
    const items = codexPlan(item);
    if (items.length) out.push({ t, kind: 'plan', items });
  } else if (ev.type === 'thread.started' && ev.thread_id) {
    st.hostSessionId = String(ev.thread_id);
    out.push({ t, kind: 'session', id: st.hostSessionId });
  } else if (ev.type === 'item.started' && item) {
    if (item.type === 'command_execution') out.push({ t, kind: 'tool', id: item.id || null, name: 'shell', toolKind: 'bash', summary: summary(item.command), filePath: null });
    else if (item.type === 'mcp_tool_call') out.push({ t, kind: 'tool', id: item.id || null, name: `mcp__${item.server || 'mcp'}__${item.tool || 'call'}`, toolKind: 'mcp', summary: summary(item.arguments), filePath: null });
  } else if (ev.type === 'item.completed' && item) {
    if (item.type === 'agent_message' && typeof item.text === 'string') out.push({ t, kind: 'text', text: item.text });
    else if (item.type === 'command_execution') out.push({ t, kind: 'tool_result', id: item.id || null, ok: item.status === 'completed' && (item.exit_code === undefined || item.exit_code === 0), summary: summary(item.aggregated_output) });
    else if (item.type === 'mcp_tool_call') out.push({ t, kind: 'tool_result', id: item.id || null, ok: item.status === 'completed' && !item.error, summary: summary(item.error ? item.error.message || item.error : item.result) });
    else if (item.type === 'file_change' && Array.isArray(item.changes)) out.push({ t, kind: 'patch', files: item.changes.map((c) => ({ path: String((c && c.path) || ''), change: String((c && c.kind) || 'update') })) });
    else if (item.type === 'error' && item.message) out.push({ t, kind: 'error', message: String(item.message) });
  } else if (ev.type === 'turn.completed') {
    const u = ev.usage || {};
    const usage = { inputTokens: num(u.input_tokens), cachedInputTokens: num(u.cached_input_tokens), outputTokens: num(u.output_tokens) };
    const usd = priceUsd(model, usage);
    out.push({ t, kind: 'usage', in: usage.inputTokens, out: usage.outputTokens, cached: usage.cachedInputTokens, usd, estimated: true });
    st.usd = usd; st.estimated = true; st.done = true;
    out.push({ t, kind: 'done', ok: true, usd, estimated: true });
  } else if (ev.type === 'turn.failed' || ev.type === 'error') {
    out.push({ t, kind: 'error', message: String((ev.error && ev.error.message) || ev.message || ev.type) });
    if (ev.type === 'turn.failed') { st.done = true; out.push({ t, kind: 'done', ok: false, usd: st.usd, estimated: st.estimated }); }
  }
  return out;
}

function createParser(host, { model = null, now = () => new Date() } = {}) {
  if (host !== 'claude' && host !== 'codex') throw new Error(`session-events: no such host ${host}`);
  const state = { hostSessionId: null, usd: null, estimated: host === 'codex', done: false };
  let rest = '';
  const line = (raw) => {
    const s = raw.trim();
    if (!s || state.done) return [];
    let msg;
    try { msg = JSON.parse(s); } catch { return []; }
    if (!msg || typeof msg !== 'object') return [];
    const t = now().toISOString();
    return host === 'claude' ? mapClaude(msg, state, t) : mapCodex(msg, state, t, model);
  };
  return {
    state,
    push(chunk) {
      const lines = (rest + String(chunk)).split('\n');
      rest = lines.pop();
      return lines.flatMap(line);
    },
    end() {
      const out = line(rest);
      rest = '';
      if (!state.done) {
        const t = now().toISOString();
        state.done = true;
        out.push({ t, kind: 'error', message: 'the turn ended before the host finished it' }, { t, kind: 'done', ok: false, usd: state.usd, estimated: state.estimated });
      }
      return out;
    },
  };
}

module.exports = { createParser, summary, claudeBlocks, PLAN_STATUS, SUMMARY_MAX };
