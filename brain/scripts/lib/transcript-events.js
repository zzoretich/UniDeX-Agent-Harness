'use strict';
/**
 * transcript-events.js — a host's on-disk transcript becomes the same events as a headless turn (session-events.js),
 * so the Code tab's chat view reads a live terminal session the way the Sessions pane reads an app session
 * (spec 2026-11-09-code-chat). Claude: ~/.claude/projects/**\/<id>.jsonl; Codex: ~/.codex/sessions/**\/rollout-*.jsonl.
 *
 *   createTranscriptMapper(host, { model })  →  { push(entry) → events[], state: { sessionId, model } }
 *     push takes one parsed JSONL entry at a time and keeps what it needs between entries (the first session id, codex
 *     exec/MCP pairing by call_id, the last token total, the turn); an unknown or malformed entry makes no events, never
 *     throws.
 *   eventsOfText(text, host)  →  events[]     a whole transcript at once
 *
 *   Events are session-events.js's, plus  prompt  { text }  what the user typed. `t` is the entry's timestamp, else null.
 *   Every event carries `turn`: 0 before the first prompt, then the number of prompts so far. `session` and `done` carry
 *   `model` (null while none is known); when the model changes, a new `session` event with the same id names it (a
 *   reader treats a session event with the id it has as a model update, not a new conversation).
 *
 *   claude: user (a string, or text and image blocks) → prompt, when a person typed it: no `origin` or origin human,
 *           promptSource not system, and not only <bash-input|bash-stdout|bash-stderr|system-reminder> blocks or a
 *           slash-command envelope (transcript.js isRealPrompt). Its text loses leading and trailing <system-reminder>
 *           blocks (R21). [Request interrupted by user…] → done not ok.
 *           tool_result blocks → tool_result (a TodoWrite's is dropped, its plan event says it all). assistant →
 *           claudeBlocks; stop_reason end_turn → done, once per message.id and only from an entry with a block event
 *           (Claude Code 2.1.318 writes a final message's thinking and its text as two end_turn entries); max_tokens or
 *           refusal → done not ok. An API error (isApiErrorMessage, model <synthetic>) → error, then done not ok; a
 *           <synthetic> model is never the model. isSidechain, isMeta, isCompactSummary, isVisibleInTranscriptOnly and
 *           summary entries are skipped.
 *   codex:  session_meta → session (the first only). Codex 0.165+ writes event_msg item_completed with an item
 *           (UserMessage, AgentMessage, CommandExecution, McpToolCall, FileChange); older rollouts wrote user_message,
 *           agent_message and exec_command / patch_apply / mcp_tool_call begin and end. Both map. turn_context names the
 *           model; token_count → usage (estimated), task_complete → done, turn_aborted → done not ok. A function_call
 *           update_plan → plan is a legacy fallback: no codex 0.163–0.167 rollout on record has one.
 */
const { parseJsonl, textOf, isRealPrompt, CODEX_ENVELOPE_RE } = require('./transcript.js');
const { summary, claudeBlocks, PLAN_STATUS } = require('./session-events.js');
const { priceUsd } = require('../sdk/lib/codex-pricing.js');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// What a Claude user entry can hold that is not the person's words: Claude Code's ! command blocks and reminders.
const CLAUDE_BLOCK_RE = /<(bash-input|bash-stdout|bash-stderr|system-reminder)>[\s\S]*?<\/\1>/g;
const INTERRUPT_RE = /^\[Request interrupted by user/;
// R21: reminders Claude Code puts before or after the person's words; a block between words stays.
const LEADING_REMINDER_RE = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/;
const TRAILING_REMINDER_RE = /\s*<system-reminder>(?:(?!<system-reminder>)[\s\S])*?<\/system-reminder>\s*$/;

/** A prompt's text without its leading and trailing <system-reminder> blocks (R21). */
function withoutReminders(text) {
  let s = text;
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(LEADING_REMINDER_RE, ''); }
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(TRAILING_REMINDER_RE, ''); }
  return s.trim();
}
const SYNTHETIC = '<synthetic>';

const done = (st, t, ok, estimated) => ({ t, kind: 'done', ok, usd: null, estimated, model: st.model });

/** A model the transcript names: a session event with the same id when it is new and the session is known. */
function setModel(st, model, t, out) {
  if (typeof model !== 'string' || !model || model === SYNTHETIC || model === st.model) return;
  st.model = model;
  if (st.sessionId) out.push({ t, kind: 'session', id: st.sessionId, model });
}

/** A Claude user entry's words are a prompt only when a person typed them (module comment). */
function claudePrompt(e, text) {
  if (isObj(e.origin) && e.origin.kind !== 'human') return false;
  if (e.promptSource === 'system') return false;
  if (!text.replace(CLAUDE_BLOCK_RE, '').trim()) return false;
  return isRealPrompt({ role: 'user', text, meta: false });
}

function claudeUser(e, st, t) {
  const content = e.message && e.message.content;
  const out = [];
  const parts = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        if (!st.planIds.has(b.tool_use_id)) out.push({ t, kind: 'tool_result', id: b.tool_use_id || null, ok: !b.is_error, summary: summary(b.content) });
      } else if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'image') parts.push('[image]');
    }
  }
  const text = withoutReminders(parts.join('\n'));
  if (INTERRUPT_RE.test(text)) out.push(done(st, t, false, false));
  else if (claudePrompt(e, text)) out.push({ t, kind: 'prompt', text });
  return out;
}

const thinkingOnly = (content) => content.length > 0 && content.every((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'));

/** Whether an assistant entry closes its turn, once per message.id (module comment): done's ok, or null. */
function closes(m, blocks, st) {
  const sr = m.stop_reason;
  let ok;
  if (sr === 'end_turn') { if (!blocks.length) return null; ok = true; }
  else if (sr === 'max_tokens' || sr === 'refusal') { if (thinkingOnly(m.content)) return null; ok = false; }
  else return null;
  if (typeof m.id === 'string' && m.id) {
    if (st.closedId === m.id) return null;
    st.closedId = m.id;
  }
  return ok;
}

function claudeEntry(e, st, t) {
  if (e.type !== 'user' && e.type !== 'assistant') return [];
  const out = [];
  const m = isObj(e.message) ? e.message : null;
  const apiError = e.type === 'assistant' && e.isApiErrorMessage === true;
  // The first session event names the model the entry carries, so it is not followed by an update at once.
  const model = e.type === 'assistant' && m && !apiError ? m.model : null;
  if (typeof e.sessionId === 'string' && e.sessionId && !st.sessionId) {
    st.sessionId = e.sessionId;
    if (typeof model === 'string' && model && model !== SYNTHETIC) st.model = model;
    out.push({ t, kind: 'session', id: st.sessionId, model: st.model });
  } else setModel(st, model, t, out);
  if (e.type === 'user') return out.concat(claudeUser(e, st, t));
  if (!m || !Array.isArray(m.content)) return out;
  if (apiError) {
    out.push({ t, kind: 'error', message: summary(textOf(m.content)) || 'API error' }, done(st, t, false, false));
    return out;
  }
  for (const b of m.content) if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.id) st.planIds.add(b.id);
  const blocks = claudeBlocks(m.content, t);
  out.push(...blocks);
  const ok = closes(m, blocks, st);
  if (ok !== null) out.push(done(st, t, ok, false));
  return out;
}

/** An exec command as one line: codex's parsed command when it has one, else the argv (a shell wrapper's script alone). */
function commandOf(command, parsed) {
  if (Array.isArray(parsed) && parsed[0] && typeof parsed[0].cmd === 'string') return parsed[0].cmd;
  if (Array.isArray(command)) return command.length > 2 && /(^|\/)(ba|z)?sh$/.test(String(command[0])) ? String(command[command.length - 1]) : command.join(' ');
  return typeof command === 'string' ? command : '';
}

/** A patch's changes (an object by path, or a list) → the patch event's files. */
function patchFiles(changes) {
  const kindOf = (c) => String((c && (c.type || c.kind)) || 'update');
  if (Array.isArray(changes)) return changes.map((c) => ({ path: String((c && c.path) || ''), change: kindOf(c) }));
  if (isObj(changes)) return Object.entries(changes).map(([path, c]) => ({ path, change: kindOf(c) }));
  return [];
}

const mcpName = (server, tool) => `mcp__${server || 'mcp'}__${tool || 'call'}`;
/** An MCP result ({ Ok: { content, isError } } | { Err } | { content }) → { ok, text }. */
function mcpOutcome(result, error) {
  if (error) return { ok: false, text: error.message || error };
  if (isObj(result) && 'Err' in result) return { ok: false, text: result.Err };
  const body = isObj(result) && 'Ok' in result ? result.Ok : result;
  return { ok: !(isObj(body) && body.isError), text: isObj(body) ? body.content : body };
}

function codexItem(item, t) {
  const text = (c) => textOf(c).trim();
  switch (item.type) {
    case 'AgentMessage': return text(item.content) ? [{ t, kind: 'text', text: text(item.content) }] : [];
    case 'UserMessage': {
      const p = text(item.content);
      return p && !CODEX_ENVELOPE_RE.test(p) ? [{ t, kind: 'prompt', text: p }] : [];
    }
    case 'CommandExecution':
      return [
        { t, kind: 'tool', id: item.id || null, name: 'shell', toolKind: 'bash', summary: summary(commandOf(item.command, item.parsed_cmd)), filePath: null },
        { t, kind: 'tool_result', id: item.id || null, ok: item.status === 'completed' && (item.exit_code === undefined || item.exit_code === 0), summary: summary(item.aggregated_output) },
      ];
    case 'McpToolCall': {
      const r = mcpOutcome(item.result, item.error);
      return [
        { t, kind: 'tool', id: item.id || null, name: mcpName(item.server, item.tool), toolKind: 'mcp', summary: summary(item.arguments), filePath: null },
        { t, kind: 'tool_result', id: item.id || null, ok: item.status === 'completed' && r.ok, summary: summary(r.text) },
      ];
    }
    case 'FileChange': {
      const files = patchFiles(item.changes);
      return files.length ? [{ t, kind: 'patch', files }] : [];
    }
    default: return [];
  }
}

function codexUsage(info, st, t) {
  const last = isObj(info) && isObj(info.last_token_usage) ? info.last_token_usage : null;
  const total = isObj(info) && isObj(info.total_token_usage) ? num(info.total_token_usage.total_tokens) : 0;
  if (!last || (total && total === st.lastTotal)) return [];
  st.lastTotal = total;
  const usage = { inputTokens: num(last.input_tokens), cachedInputTokens: num(last.cached_input_tokens), outputTokens: num(last.output_tokens) };
  return [{ t, kind: 'usage', in: usage.inputTokens, out: usage.outputTokens, cached: usage.cachedInputTokens, usd: priceUsd(st.model, usage), estimated: true }];
}

function codexEvent(p, st, t) {
  const call = (id) => (id ? String(id) : null);
  switch (p.type) {
    case 'item_completed': return isObj(p.item) ? codexItem(p.item, t) : [];
    case 'user_message': {
      const s = String(p.message || '').trim();
      return s && !CODEX_ENVELOPE_RE.test(s) ? [{ t, kind: 'prompt', text: s }] : [];
    }
    case 'agent_message': return typeof p.message === 'string' && p.message ? [{ t, kind: 'text', text: p.message }] : [];
    case 'exec_command_begin': {
      const id = call(p.call_id);
      if (id) st.open.add(id);
      return [{ t, kind: 'tool', id, name: 'shell', toolKind: 'bash', summary: summary(commandOf(p.command, p.parsed_cmd)), filePath: null }];
    }
    case 'exec_command_end': {
      const id = call(p.call_id);
      const out = [];
      if (!id || !st.open.delete(id)) out.push({ t, kind: 'tool', id, name: 'shell', toolKind: 'bash', summary: summary(commandOf(p.command, p.parsed_cmd)), filePath: null });
      out.push({ t, kind: 'tool_result', id, ok: p.exit_code === undefined || p.exit_code === 0, summary: summary(p.aggregated_output || p.stdout || p.stderr) });
      return out;
    }
    case 'patch_apply_begin': {
      const files = patchFiles(p.changes);
      return files.length ? [{ t, kind: 'patch', files }] : [];
    }
    case 'mcp_tool_call_begin': {
      const id = call(p.call_id);
      const inv = isObj(p.invocation) ? p.invocation : {};
      if (id) st.open.add(id);
      return [{ t, kind: 'tool', id, name: mcpName(inv.server, inv.tool), toolKind: 'mcp', summary: summary(inv.arguments), filePath: null }];
    }
    case 'mcp_tool_call_end': {
      const id = call(p.call_id);
      const inv = isObj(p.invocation) ? p.invocation : {};
      const r = mcpOutcome(p.result, null);
      const out = [];
      if (!id || !st.open.delete(id)) out.push({ t, kind: 'tool', id, name: mcpName(inv.server, inv.tool), toolKind: 'mcp', summary: summary(inv.arguments), filePath: null });
      out.push({ t, kind: 'tool_result', id, ok: r.ok, summary: summary(r.text) });
      return out;
    }
    case 'token_count': return codexUsage(p.info, st, t);
    case 'task_complete': return [done(st, t, true, true)];
    case 'turn_aborted': return [done(st, t, false, true)];
    default: return [];
  }
}

/** A function_call update_plan → a plan event (arguments is a JSON string: { plan: [{ step, status }] }). A legacy
 *  fallback: none of the codex 0.163–0.167 rollouts on record has one. */
function codexPlan(p, t) {
  let args = p.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return []; } }
  const steps = isObj(args) && Array.isArray(args.plan) ? args.plan : [];
  const items = steps.map((s) => ({ text: summary((s && s.step) || ''), status: PLAN_STATUS[s && s.status] || 'pending' })).filter((i) => i.text);
  return items.length ? [{ t, kind: 'plan', items }] : [];
}

function codexEntry(e, st, t) {
  const p = e.payload;
  if (!isObj(p)) return [];
  if (e.type === 'session_meta') {
    // Only the first session_meta is this session's: a forked rollout repeats its source thread's after it.
    const id = p.id || p.session_id;
    if (st.sessionId || !id) return [];
    st.sessionId = String(id);
    if (typeof p.model === 'string' && p.model) st.model = p.model;
    return [{ t, kind: 'session', id: st.sessionId, model: st.model }];
  }
  if (e.type === 'turn_context') { const out = []; setModel(st, p.model, t, out); return out; }
  if (e.type === 'event_msg') return codexEvent(p, st, t);
  if (e.type === 'response_item' && p.type === 'function_call' && p.name === 'update_plan') return codexPlan(p, t);
  return [];
}

function createTranscriptMapper(host, { model = null } = {}) {
  if (host !== 'claude' && host !== 'codex') throw new Error(`transcript-events: no such host ${host}`);
  // sessionId and model are the public state; the rest is the mapper's own bookkeeping between entries.
  const state = { sessionId: null, model: model || null, turn: 0, planIds: new Set(), open: new Set(), lastTotal: 0, closedId: null };
  const map = (entry) => {
    const t = typeof entry.timestamp === 'string' && entry.timestamp ? entry.timestamp : null;
    if (host === 'codex') return codexEntry(entry, state, t);
    if (entry.isSidechain || entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly || entry.type === 'summary') return [];
    return claudeEntry(entry, state, t);
  };
  return {
    state,
    push(entry) {
      try {
        if (!isObj(entry)) return [];
        const events = map(entry);
        for (const ev of events) { if (ev.kind === 'prompt') state.turn++; ev.turn = state.turn; }
        return events;
      } catch { return []; }
    },
  };
}

function eventsOfText(text, host) {
  const mapper = createTranscriptMapper(host);
  return parseJsonl(text).flatMap((e) => mapper.push(e));
}

module.exports = { createTranscriptMapper, eventsOfText };
