'use strict';
/**
 * transcript.js — one reader for both hosts' session transcripts.
 *
 *   Claude Code  projects/<slug>/<id>.jsonl: one entry per message; `type` or `role` is
 *                user|assistant; `message.content` is a string or content blocks, and an
 *                assistant `tool_use` block names the tool and carries its input.
 *   Codex CLI    sessions/YYYY/MM/DD/rollout-*.jsonl: `{ timestamp, type, payload }` records.
 *                Messages are response_item/message with role user|assistant|developer
 *                (developer = injected context, skipped). Codex's code mode wraps tool calls in
 *                scripts, so tool activity is read from the event_msg records instead:
 *                patch_apply_end (edits, one per changed path), exec_command_end (shell) and
 *                mcp_tool_call_end (MCP). Token usage is event_msg/token_count.
 *
 * Output is host-neutral: { format, turns, toolUses, usage, userTurns, prompts, meta }.
 *   turns     [{ role, text, meta }]  meta = Claude's isMeta envelopes (kept for turn counting)
 *   userTurns every user-role entry (Claude's tool results and envelopes included)
 *   prompts   only what the user typed: isRealPrompt() turns (spec 2026-09-24-summary-throttle D1)
 *   toolUses  [{ name, kind, filePath }]  kind ∈ edit | read | bash | mcp | other
 *   usage     { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens } | null
 *
 * The session-index seams (spaces-redesign D20, D25) read a bounded slice of a file instead of all of it:
 *   sessionHead(file, maxBytes = 256 KB)  → { format, id, startCwd, startedAt, kind, parentId, subagent, title,
 *                                            titleSource, firstPrompt } | null (unreadable)
 *       kind ∈ interactive | headless | subagent. Claude: entrypoint `sdk-*` → headless, anything else interactive
 *       (Claude's subagents live in <id>/subagents/ and are never listed). Codex: source cli/vscode → interactive,
 *       exec/mcp → headless, { subagent } → subagent with parentId set only for thread_spawn (fold it into the
 *       parent) and null otherwise, e.g. guardian (drop it); `subagent` names which.
 *   sessionTail(file)                     → { title, titleSource, lastAt } | null: the last 64 KB, grown once to
 *       256 KB when a Claude tail holds no custom-title/ai-title entry. titleSource ∈ custom | ai | null (Codex
 *       rollouts carry no title: readSessionIndex() reads its session_index.jsonl thread names).
 *   fileTouches(file, fromOffset = 0)     → { touches: { [absPath]: count }, offset, cwd, reset } | null: what a
 *       session touched from fromOffset on, for crediting a vault-root session to a workspace. Claude: the
 *       file_path of each FILE_TOOLS use plus each entry's cwd. Codex: the changes keys of patch_apply_end (and of
 *       item_completed FileChange items, which newer CLIs write instead) plus each turn_context.cwd; reads through
 *       shell commands carry no path. `offset` stops after the last complete line, so a line still being written
 *       is read next time; pass it back as fromOffset (and `cwd` as opts.cwd) to read only what was appended.
 *   mcpCalls(file, fromOffset = 0)        → { calls: [{ server, tool, at }], offset, reset } | null: the MCP tool calls
 *       from fromOffset on (connectors-tab D13), read the way fileTouches reads. Claude: tool_use blocks named
 *       mcp__<server>__<tool>; Codex: event_msg mcp_tool_call_end's invocation { server, tool }. Each call once, by its
 *       tool_use id or call_id; `at` is its line's timestamp (ms), null when it has none.
 */
const fs = require('fs');
const path = require('path');

const FILE_TOOLS = { Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read' };
// Codex injects these as user-role messages; they are not the user's words.
const CODEX_ENVELOPE_RE = /^<(environment_context|permissions instructions|user_instructions|app_instructions|skill|turn_aborted)\b/;

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* not a JSON line */ }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join(' ');
  if (content && typeof content === 'object') return content.text || '';
  return '';
}

function kindOf(name) {
  if (FILE_TOOLS[name]) return FILE_TOOLS[name];
  if (name === 'Bash') return 'bash';
  if (/^mcp__/.test(String(name))) return 'mcp';
  return 'other';
}

/** 'codex' when the first records carry Codex's { type, payload } envelope; 'claude' otherwise. */
function detectFormat(entries) {
  for (const e of entries.slice(0, 10)) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'session_meta') return 'codex';
    if (e.payload && typeof e.payload === 'object' && (e.type === 'response_item' || e.type === 'event_msg' || e.type === 'turn_context')) return 'codex';
  }
  return 'claude';
}

// Claude Code writes slash commands and their output as user entries in these envelopes.
const CLAUDE_ENVELOPE_RE = /^<(command-name|command-message|command-args|local-command)/;

/** A turn the user typed: a user turn with text that is not Claude's isMeta, a slash-command envelope or a tool
 *  result (a tool_result-only entry flattens to ''). Codex's injected envelopes never become turns. */
function isRealPrompt(turn) {
  if (!turn || turn.role !== 'user' || turn.meta) return false;
  const text = String(turn.text || '').trim();
  return !!text && !CLAUDE_ENVELOPE_RE.test(text);
}

function parseClaude(entries) {
  const turns = [];
  const toolUses = [];
  let userTurns = 0;
  let prompts = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const role = e.type || e.role;
    if (role === 'user') userTurns++;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = (e.message && e.message.content) ?? e.content ?? '';
    if (role === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue;
        const filePath = b.input && typeof b.input.file_path === 'string' ? b.input.file_path : null;
        toolUses.push({ name: b.name, kind: kindOf(b.name), filePath });
      }
    }
    const turn = { role, text: textOf(content), meta: !!e.isMeta };
    if (isRealPrompt(turn)) prompts++;
    turns.push(turn);
  }
  return { format: 'claude', turns, toolUses, usage: null, userTurns, prompts, meta: null };
}

function parseCodex(entries) {
  const turns = [];
  const toolUses = [];
  let usage = null;
  let userTurns = 0;
  let prompts = 0;
  let meta = null;
  for (const r of entries) {
    if (!r || typeof r !== 'object' || !r.payload || typeof r.payload !== 'object') continue;
    const p = r.payload;
    if (r.type === 'session_meta') {
      meta = { id: p.id || p.session_id || null, cwd: p.cwd || null, cliVersion: p.cli_version || null, source: p.source || null };
      continue;
    }
    if (r.type === 'response_item' && p.type === 'message') {
      if (p.role !== 'user' && p.role !== 'assistant') continue;
      const text = textOf(p.content);
      if (p.role === 'user' && CODEX_ENVELOPE_RE.test(text.trim())) continue;
      if (p.role === 'user') userTurns++;
      const turn = { role: p.role, text, meta: false };
      if (isRealPrompt(turn)) prompts++;
      turns.push(turn);
      continue;
    }
    if (r.type !== 'event_msg') continue;
    switch (p.type) {
      case 'patch_apply_end':
        for (const f of Object.keys(p.changes || {})) toolUses.push({ name: 'apply_patch', kind: 'edit', filePath: f });
        break;
      case 'exec_command_end':
        toolUses.push({ name: 'Bash', kind: 'bash', filePath: null });
        break;
      case 'mcp_tool_call_end': {
        const inv = p.invocation || {};
        toolUses.push({ name: `mcp__${inv.server || 'unknown'}__${inv.tool || 'unknown'}`, kind: 'mcp', filePath: null });
        break;
      }
      case 'token_count': {
        const u = p.info && p.info.total_token_usage;
        if (u) {
          usage = {
            inputTokens: u.input_tokens || 0,
            cachedInputTokens: u.cached_input_tokens || 0,
            outputTokens: u.output_tokens || 0,
            reasoningOutputTokens: u.reasoning_output_tokens || 0,
            totalTokens: u.total_tokens || 0,
          };
        }
        break;
      }
      default:
        break;
    }
  }
  return { format: 'codex', turns, toolUses, usage, userTurns, prompts, meta };
}

/** Parsed JSONL entries of either host → the host-neutral shape. */
function parseEntries(entries, { format } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  return (format || detectFormat(list)) === 'codex' ? parseCodex(list) : parseClaude(list);
}

function readTurns(text, opts) { return parseEntries(parseJsonl(text), opts); }

function readTranscriptFile(transcriptPath, opts) {
  if (!transcriptPath) return parseEntries([], opts);
  let text = '';
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return parseEntries([], opts); }
  return readTurns(text, opts);
}

/**
 * The model that answered in a session, from the transcript (codex-parity D6): Claude Code writes
 * `message.model` on every assistant entry; Codex names it in turn_context.payload.model (and, on
 * newer CLIs, session_meta.payload.model). null when neither is present. Fixture-tested on both.
 */
function sessionModel(entries, { format } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const fmt = format || detectFormat(list);
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (fmt === 'codex') {
      const p = e.payload && typeof e.payload === 'object' ? e.payload : null;
      if (p && (e.type === 'turn_context' || e.type === 'session_meta') && typeof p.model === 'string' && p.model) return p.model;
      continue;
    }
    if ((e.type === 'assistant' || e.role === 'assistant') && e.message && typeof e.message.model === 'string' && e.message.model) return e.message.model;
  }
  return null;
}

function sessionModelFile(transcriptPath, opts) {
  if (!transcriptPath) return null;
  try { return sessionModel(parseJsonl(fs.readFileSync(transcriptPath, 'utf8')), opts); } catch { return null; }
}

/** "role: text" lines, one per spoken turn — the shape the extractors and summarizers consume. */
function flattenTurns(parsed, { maxChars = 0 } = {}) {
  const out = [];
  for (const t of parsed.turns) {
    if (t.meta) continue;
    const text = String(t.text || '').trim();
    if (!text) continue;
    out.push(`${t.role}: ${maxChars > 0 ? text.slice(0, maxChars) : text}`);
  }
  return out.join('\n');
}

// ── The session-index seams (spaces-redesign D20, D25; module comment) ──────────────────────────────────────────

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 256 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const PROMPT_CHARS = 80;
const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
// A Codex record line begins with its envelope; enough to tell the format when the first line is too long to parse.
const CODEX_LINE_RE = /^\{"timestamp":"[^"]*","type":"(?:session_meta|response_item|event_msg|turn_context|compacted)"/;
// What Codex injects as user-role text before the user's first words: CODEX_ENVELOPE_RE's tags, any other leading
// tag (<recommended_plugins>, <in-app-browser-context …>) and the AGENTS.md block. Only for picking the first prompt.
const CODEX_INJECTED_RE = /^(?:<[A-Za-z][\w -]*(?:>|\s)|# AGENTS\.md instructions\b)/;

/** Up to `length` bytes of `file` from `start`, with the file's size; null when it cannot be read. */
function readSlice(file, start, length) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const want = Math.max(0, Math.min(length, size - start));
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buf, got, want - got, start + got);
      if (!n) break;
      got += n;
    }
    return { buf: buf.subarray(0, got), size };
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

/**
 * The JSON entries of a byte slice. `cutStart`: the slice begins mid-file, so its first line is partial;
 * `toEof`: the slice reaches the end of the file, so its last line counts even without a newline.
 */
function sliceEntries(buf, { cutStart, toEof }) {
  const lines = buf.toString('utf8').split('\n');
  if (cutStart) lines.shift();
  if (!toEof) lines.pop();
  return parseJsonl(lines.join('\n'));
}

function isoOf(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Whitespace collapsed, cut to `n` characters (code points, so an emoji is never split). */
function cutText(s, n = PROMPT_CHARS) {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, n).join('').trimEnd();
}

function str(v) { return typeof v === 'string' && v ? v : null; }

/** 'codex' or 'claude' for a transcript file: a rollout-*.jsonl name, else its first bytes. */
function fileFormat(file) {
  if (ROLLOUT_RE.test(path.basename(String(file || '')))) return 'codex';
  const r = readSlice(file, 0, 8 * 1024);
  if (!r) return 'claude';
  if (CODEX_LINE_RE.test(r.buf.toString('utf8'))) return 'codex';
  return detectFormat(sliceEntries(r.buf, { cutStart: false, toEof: r.buf.length >= r.size }));
}

/** The title entries Claude Code writes (custom-title from a rename, ai-title generated); a custom title wins. */
function claudeTitle(entries) {
  let custom = null;
  let ai = null;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) custom = e.customTitle.trim();
    else if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) ai = e.aiTitle.trim();
  }
  if (custom) return { title: custom, titleSource: 'custom' };
  if (ai) return { title: ai, titleSource: 'ai' };
  return { title: null, titleSource: null };
}

function claudeHead(entries) {
  let id = null;
  let startCwd = null;
  let startedAt = null;
  let entrypoint = null;
  let firstPrompt = null;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    // The first line may carry no cwd at all (agent-setting, custom-title, queue-operation): keep reading.
    if (!id) id = str(e.sessionId);
    if (!startCwd) startCwd = str(e.cwd);
    if (!startedAt) startedAt = isoOf(e.timestamp);
    if (!entrypoint) entrypoint = str(e.entrypoint);
    if (!firstPrompt && (e.type === 'user' || e.role === 'user')) {
      const content = (e.message && e.message.content) ?? e.content ?? '';
      const turn = { role: 'user', text: textOf(content), meta: !!e.isMeta };
      if (isRealPrompt(turn)) firstPrompt = cutText(turn.text);
    }
  }
  const kind = entrypoint && /^sdk-/.test(entrypoint) ? 'headless' : 'interactive';
  return { format: 'claude', id, startCwd, startedAt, kind, parentId: null, subagent: null, ...claudeTitle(entries), firstPrompt };
}

/** spaces-redesign §4: cli/vscode interactive, exec (and mcp) headless; a subagent folds (thread_spawn) or drops. */
function codexKind(meta) {
  const source = meta && meta.source;
  if (source && typeof source === 'object' && source.subagent !== undefined) {
    const sa = source.subagent;
    if (sa && typeof sa === 'object' && sa.thread_spawn && typeof sa.thread_spawn === 'object') {
      return { kind: 'subagent', subagent: 'thread_spawn', parentId: str(sa.thread_spawn.parent_thread_id) || str(meta.parent_thread_id) };
    }
    const name = typeof sa === 'string' ? sa : sa && typeof sa === 'object' ? (str(sa.other) || Object.keys(sa)[0]) : null;
    return { kind: 'subagent', subagent: name || 'other', parentId: null };
  }
  if (source === 'exec' || source === 'mcp') return { kind: 'headless', subagent: null, parentId: null };
  return { kind: 'interactive', subagent: null, parentId: null };
}

function codexHead(entries) {
  let meta = null;
  let metaAt = null;
  let turnCwd = null;
  let firstAt = null;
  let firstPrompt = null;
  for (const r of entries) {
    if (!r || typeof r !== 'object') continue;
    const p = r.payload && typeof r.payload === 'object' ? r.payload : null;
    if (!firstAt) firstAt = isoOf(r.timestamp);
    if (!p) {
      // A pre-envelope rollout's first line is the meta itself.
      if (!meta && str(r.id)) { meta = r; metaAt = isoOf(r.timestamp); }
      continue;
    }
    // Only the first session_meta is this session's: a forked rollout repeats its source thread's after it.
    if (r.type === 'session_meta') { if (!meta) { meta = p; metaAt = isoOf(p.timestamp) || isoOf(r.timestamp); } continue; }
    if (r.type === 'turn_context' && !turnCwd) turnCwd = str(p.cwd);
    if (!firstPrompt && r.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const text = textOf(p.content).trim();
      if (text && !CODEX_ENVELOPE_RE.test(text) && !CODEX_INJECTED_RE.test(text)) firstPrompt = cutText(text);
    }
  }
  const k = codexKind(meta);
  return {
    format: 'codex',
    id: meta ? str(meta.id) || str(meta.session_id) : null,
    startCwd: (meta && str(meta.cwd)) || turnCwd,
    startedAt: metaAt || firstAt,
    kind: k.kind,
    parentId: k.parentId,
    subagent: k.subagent,
    title: null,
    titleSource: null,
    firstPrompt,
  };
}

/** The start of a session: who, where, when and what kind, from its first `maxBytes` (module comment). */
function sessionHead(file, maxBytes = HEAD_BYTES, { format } = {}) {
  const r = readSlice(file, 0, maxBytes > 0 ? maxBytes : HEAD_BYTES);
  if (!r) return null;
  const entries = sliceEntries(r.buf, { cutStart: false, toEof: r.buf.length >= r.size });
  const fmt = format || (ROLLOUT_RE.test(path.basename(String(file))) ? 'codex' : detectFormat(entries));
  return fmt === 'codex' ? codexHead(entries) : claudeHead(entries);
}

/** The end of a session: its newest title and when it last moved (module comment). */
function sessionTail(file, { format } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  let fmt = format || (ROLLOUT_RE.test(path.basename(String(file))) ? 'codex' : null);
  let want = TAIL_BYTES;
  let entries = [];
  let title = { title: null, titleSource: null };
  for (;;) {
    const start = Math.max(0, st.size - want);
    const r = readSlice(file, start, st.size - start);
    if (!r) return null;
    entries = sliceEntries(r.buf, { cutStart: start > 0, toEof: true });
    if (!fmt) fmt = detectFormat(entries);
    if (fmt === 'codex') break;
    title = claudeTitle(entries);
    if (title.title || start === 0 || want >= TAIL_MAX_BYTES) break;
    want = TAIL_MAX_BYTES;
  }
  let last = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const ms = Date.parse(typeof e.timestamp === 'string' ? e.timestamp : '');
    if (Number.isFinite(ms) && ms > last) last = ms;
  }
  return { ...title, lastAt: new Date(last || st.mtimeMs).toISOString() };
}

/** What a session touched from `fromOffset` on (module comment). */
function fileTouches(file, fromOffset = 0, opts = {}) {
  let size;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    size = st.size;
  } catch { return null; }
  let start = Number.isInteger(fromOffset) && fromOffset > 0 ? fromOffset : 0;
  let reset = false;
  if (start > size) { start = 0; reset = true; } // the file was rewritten or truncated: read it again
  const format = opts.format || fileFormat(file);
  const touches = {};
  let cwd = str(opts.cwd);
  const seen = new Set();
  const add = (p) => {
    if (typeof p !== 'string' || !p) return;
    const abs = path.isAbsolute(p) ? path.normalize(p) : cwd ? path.resolve(cwd, p) : null;
    if (abs) touches[abs] = (touches[abs] || 0) + 1;
  };
  const changes = (id, obj) => {
    if (id) { if (seen.has(id)) return; seen.add(id); }
    if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) add(k);
  };
  const onClaude = (line) => {
    if (!line.includes('"cwd"') && !line.includes('"tool_use"')) return;
    let e;
    try { e = JSON.parse(line.toString('utf8')); } catch { return; }
    if (!e || typeof e !== 'object') return;
    if (str(e.cwd)) { cwd = e.cwd; add(e.cwd); }
    const content = e.message && e.message.content;
    if ((e.type || e.role) !== 'assistant' || !Array.isArray(content)) return;
    for (const b of content) {
      if (!b || b.type !== 'tool_use' || !FILE_TOOLS[b.name] || !b.input) continue;
      add(b.input.file_path || b.input.notebook_path);
    }
  };
  const onCodex = (line) => {
    if (!line.includes('"turn_context"') && !line.includes('"patch_apply_end"') && !line.includes('"FileChange"')
      && !(cwd === null && line.includes('"session_meta"'))) return;
    let r;
    try { r = JSON.parse(line.toString('utf8')); } catch { return; }
    const p = r && typeof r === 'object' && r.payload && typeof r.payload === 'object' ? r.payload : null;
    if (!p) return;
    if (r.type === 'session_meta') { if (cwd === null) cwd = str(p.cwd); return; } // a base for relative paths, not a touch
    if (r.type === 'turn_context') { if (str(p.cwd)) { cwd = p.cwd; add(p.cwd); } return; }
    if (r.type !== 'event_msg') return;
    if (p.type === 'patch_apply_end') changes(str(p.call_id), p.changes);
    else if (p.type === 'item_completed' && p.item && p.item.type === 'FileChange') changes(str(p.item.id), p.item.changes);
  };
  const offset = eachLine(file, start, size, format === 'codex' ? onCodex : onClaude);
  return { touches, offset, cwd, reset };
}

/** Call onLine(buffer) for each complete line from `start` to `size`; → the offset after the last complete line. */
function eachLine(file, start, size, onLine) {
  let offset = start;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(1, size - start)));
    let pos = start;
    let carry = null;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (!n) break;
      pos += n;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let from = 0;
      let nl;
      while ((nl = data.indexOf(10, from)) !== -1) {
        if (nl > from) onLine(data.subarray(from, nl));
        from = nl + 1;
      }
      offset = pos - (data.length - from);
      carry = from < data.length ? Buffer.from(data.subarray(from)) : null;
    }
  } catch { /* keep what was read: offset marks the last complete line */ } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
  return offset;
}

/**
 * The MCP tool calls a transcript holds from `fromOffset` on (module comment): Claude `tool_use` blocks named
 * mcp__<server>__<tool>, Codex `mcp_tool_call_end` events, each call once (by its id) with the time its line carries.
 */
function mcpCalls(file, fromOffset = 0, opts = {}) {
  let size;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    size = st.size;
  } catch { return null; }
  let start = Number.isInteger(fromOffset) && fromOffset > 0 ? fromOffset : 0;
  let reset = false;
  if (start > size) { start = 0; reset = true; }
  const format = opts.format || fileFormat(file);
  const calls = [];
  const seen = new Set();
  const take = (id, server, tool, ts) => {
    if (!server || !tool) return;
    if (id) { if (seen.has(id)) return; seen.add(id); }
    const at = Date.parse(typeof ts === 'string' ? ts : '');
    calls.push({ server, tool, at: Number.isFinite(at) ? at : null });
  };
  const onClaude = (line) => {
    if (!line.includes('"mcp__')) return;
    let e;
    try { e = JSON.parse(line.toString('utf8')); } catch { return; }
    const content = e && e.message && e.message.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const m = /^mcp__(.+?)__(.+)$/.exec(b.name);
      if (m) take(str(b.id), m[1], m[2], e.timestamp);
    }
  };
  const onCodex = (line) => {
    if (!line.includes('"mcp_tool_call_end"')) return;
    let r;
    try { r = JSON.parse(line.toString('utf8')); } catch { return; }
    const p = r && r.type === 'event_msg' && r.payload && typeof r.payload === 'object' ? r.payload : null;
    if (!p || p.type !== 'mcp_tool_call_end') return;
    const inv = p.invocation && typeof p.invocation === 'object' ? p.invocation : {};
    take(str(p.call_id), str(inv.server), str(inv.tool), r.timestamp);
  };
  const offset = eachLine(file, start, size, format === 'codex' ? onCodex : onClaude);
  return { calls, offset, reset };
}

/**
 * Codex's thread names: session_index.jsonl rows { id, thread_name, updated_at } → { [id]: { title, updatedAt } }
 * (spaces-redesign D25 titles). A rename appends a row, so the newest row for an id wins. Missing file → {}.
 */
function readSessionIndex(file) {
  const out = Object.create(null);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const row of parseJsonl(text)) {
    if (!row || typeof row !== 'object') continue;
    const id = str(row.id);
    const title = typeof row.thread_name === 'string' ? row.thread_name.trim() : '';
    if (!id || !title) continue;
    const updatedAt = isoOf(row.updated_at);
    const prev = out[id];
    if (prev && prev.updatedAt && updatedAt && updatedAt < prev.updatedAt) continue;
    out[id] = { title, updatedAt };
  }
  return out;
}

module.exports = {
  parseJsonl, textOf, kindOf, detectFormat, isRealPrompt, parseEntries, readTurns, readTranscriptFile, flattenTurns, sessionModel, sessionModelFile, FILE_TOOLS,
  sessionHead, sessionTail, fileTouches, mcpCalls, readSessionIndex,
};
