'use strict';
/**
 * local-agent.js — the built-in local agent runner (local-first A7). A prompt routine with `engine: local` runs here, on
 * the local engine — Ollama's /api/chat, or an OpenAI-compatible server's /chat/completions (local.engine), both with
 * `tools` — instead of through a host CLI: it needs neither Claude Code nor Codex, and spends nothing.
 *
 *   resolveLocal({ cfg, model, deps })  →  { ok, reason, detail, lc, model }
 *     Is the engine up with the model pulled? The routine's `model` must be served as named; with none, the workhorse
 *     (provider.js pickLocalModel: a tier-picked tag may give way to another pulled tier model). Down or not pulled →
 *     ok false with reason `local-down` and the detail; run-routine.js records a skip (no spend, the next fire retries).
 *   runLocalAgent({ routine, cfg, vault, lc, model, timeoutMs, deps })  →  { status: 'ok' | 'error' | 'timeout', final,
 *     error, turns, toolCalls, wrote: [rel], refused: [{ tool, path, why }], journal: [line], engine, model,
 *     usage: { inputTokens, outputTokens }, ms }
 *     The system prompt is a short preamble (the vault, the tools, the write scope, "end with a final message") and the
 *     routine's body; the loop runs until the model answers without a tool call, for at most `maxTurns` model turns
 *     (default 24) and the routine's wall clock. Each turn's tool calls run in order (MAX_CALLS_PER_TURN; arguments
 *     validated, a bad call answered with its error so the model can correct it). One timer bounds the whole run: at
 *     the deadline the request in flight is aborted and the run ends as a timeout, whatever it is waiting on. A turn's
 *     results share TURN_RESULT_CHARS (each at most RESULT_CHARS), so the current turn always fits; the history is kept
 *     within CONTEXT_CHARS by eliding earlier turns' results, then long arguments of calls already made. Every call,
 *     refusal and failure is a journal line (run-routine.js writes them to the routine log). Each model turn counts one
 *     local call in local-usage.json (A18). The final message goes where `output` says: the log (always), `notify` (an
 *     info item in the Notifications tab), or a vault-relative .md file it is appended to.
 *
 * Tools (vault-scoped: paths are vault-relative; absolute paths, `..`, dot-folders, anything but a regular file or a
 * folder, and symlinks that resolve outside the vault — or, for a write, into a refused area or out of the routine's
 * writes — are refused; real paths come from realpath.native, so a case or Unicode variant is checked as the file it
 * opens):
 *   read_file  { path, offset?, limit? }   a window of a text file's lines (READ_LINES by default), files ≤ READ_MAX_BYTES
 *   list_files { path?, recursive? }       entries under a folder, folders with a trailing /, at most LIST_MAX
 *   grep       { text, path?, ignore_case? }   plain text (not a regular expression: nothing to backtrack, and small
 *                                          models write poor ones) in the text files under `path`; `file:line: text`, at
 *                                          most GREP_MAX_MATCHES, files ≤ GREP_FILE_MAX_BYTES, GREP_MAX_MS a call
 *   write_file { path, content, append? }  only where the routine's `writes` entries allow (a folder entry with a trailing
 *                                          /, a file, or a glob with * ** ?), the real path too, AND never in
 *                                          persona/duty-guard.js's guarded or executable areas (its refusal() rule) nor
 *                                          what feeds hosted sessions (routines-store.js localDenied: persona/,
 *                                          brain/memory/, brain/_index/, MEMORY.md, AGENTICOS.md, CLAUDE.md, AGENTS.md),
 *                                          each applied to every entry and every target, real path included;
 *                                          ≤ WRITE_MAX_BYTES
 *   notify     { title, body?, level? }    an info or alert item from the routine (lib/notifications.js, the store
 *                                          `aos notify` writes), at most NOTIFY_MAX a run
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_TIMEOUT_SEC = 1800;
const MAX_CALLS_PER_TURN = 8;
/** The serving window: fixed, so every turn reuses the loaded model (ollama.js sizeContextWindow on why). */
const NUM_CTX = 16384;
const NUM_PREDICT = 2048;
/** The history's size in characters (about three per token) and one tool result's share of it. */
const CONTEXT_CHARS = 36_000;
const RESULT_CHARS = 8_000;
/** What one turn's results may take together, shared by its calls: the current turn always fits the history. */
const TURN_RESULT_CHARS = 16_000;
/** An argument of a call already made longer than this is elided when the history is over its budget. */
const ARG_KEEP_CHARS = 200;
const READ_MAX_BYTES = 2 * 1024 * 1024;
const READ_LINES = 400;
const LIST_MAX = 200;
const WALK_MAX_FILES = 5_000;
const GREP_MAX_MATCHES = 100;
const GREP_FILE_MAX_BYTES = 1024 * 1024;
const GREP_LINE_CHARS = 200;
const GREP_MAX_MS = 5_000;
const WRITE_MAX_BYTES = 256 * 1024;
const NOTIFY_MAX = 3;
const ELIDED = '[elided: an earlier tool result, to stay within the context budget]';

class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };

// ── the vault and its paths ─────────────────────────────────────────────────────────────────────────────────────────

/** realpath.native: the canonical name, case included (plain realpathSync keeps the case it was given). */
function realpath(p) { return fs.realpathSync.native(p); }

function realRoot(vault) {
  try { return realpath(path.resolve(vault)); } catch { return path.resolve(vault); }
}

/** A path the model gave → { rel, abs } under `root` (the vault's real path), or Refused. `allowRoot` lets '' or '.'
 *  name the vault itself (list_files, grep). */
function vaultPath(root, p, { allowRoot = false } = {}) {
  if (p === undefined || p === null) { if (allowRoot) return { rel: '', abs: root }; refuse('path is required'); }
  if (typeof p !== 'string') refuse('path must be a string');
  const s = p.trim().replace(/\\/g, '/');
  if (s.includes('\0')) refuse('a NUL in the path');
  if (s === '' || s === '.' || s === './') { if (allowRoot) return { rel: '', abs: root }; refuse('path is required'); }
  if (s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:/.test(s)) refuse('an absolute path: paths are relative to the vault');
  const rel = path.posix.normalize(s).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const segs = rel.split('/');
  if (segs.includes('..')) refuse('a path leaving the vault');
  if (rel === '.' || rel === '') { if (allowRoot) return { rel: '', abs: root }; refuse('path is required'); }
  if (segs.some((x) => x.startsWith('.'))) refuse('a dot-folder or dot-file');
  return { rel, abs: path.join(root, ...segs) };
}

/** The vault-relative real path of `abs` — its deepest existing ancestor resolved, the rest appended — or null when that
 *  lands outside `root` (a symlink out of the vault). */
function realRel(root, abs) {
  let p = abs;
  const rest = [];
  for (;;) {
    let real;
    try { real = realpath(p); } catch {
      const up = path.dirname(p);
      if (up === p) return null;
      rest.unshift(path.basename(p));
      p = up;
      continue;
    }
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    const head = path.relative(root, real).split(path.sep).filter(Boolean);
    return [...head, ...rest].join('/');
  }
}

/** For a read: the path, inside the vault through any symlink, with no dot segment on its real path either. */
function readable(root, p, opts) {
  const v = vaultPath(root, p, opts);
  const real = realRel(root, v.abs);
  if (real === null) refuse('it resolves outside the vault');
  if (real.split('/').some((x) => x.startsWith('.'))) refuse('it resolves into a dot-folder');
  return v;
}

// ── the write scope ─────────────────────────────────────────────────────────────────────────────────────────────────

const GLOB = /[*?]/;

/** A glob (`*` within a segment, `**` across segments, `?` one character) → a RegExp over vault-relative paths. */
function globRe(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; re += '(?:[^/]+/)*'; } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * The routine's `writes` entries → { rules: [{ entry, test(rel) }], refused: [{ entry, why }] }. A folder (trailing /,
 * or an existing folder) allows everything under it, a file itself, a glob what it matches. Each entry is checked with
 * duty-guard's refusal() — on its folder part for a glob — so no entry can name, hold or sit in a guarded or executable
 * area, the vault itself, a dot-folder or a path out of the vault; then with routines-store.js localDenied(), so none
 * reaches what feeds hosted sessions. Both compare folded paths (case and Unicode variants).
 */
function compileWrites(entries, root) {
  const { refusal } = require('../persona/duty-guard.js');
  const { localDenied } = require('./routines-store.js');
  const rules = [], refused = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = String(raw);
    const s = entry.trim().replace(/\\/g, '/');
    const dir = s.endsWith('/');
    const body = path.posix.normalize(s.replace(/\/+$/, '') || '.').replace(/^(\.\/)+/, '');
    if (GLOB.test(body)) {
      const segs = body.split('/');
      const fixed = segs.slice(0, segs.findIndex((x) => GLOB.test(x))).join('/');
      const why = refusal(fixed) || localDenied(s);
      if (why) { refused.push({ entry, why }); continue; }
      const re = globRe(dir ? `${body}/**` : body);
      rules.push({ entry, test: (rel) => re.test(rel) });
      continue;
    }
    const why = refusal(body) || localDenied(s);
    if (why) { refused.push({ entry, why }); continue; }
    let isDir = dir;
    if (!isDir) { try { isDir = fs.statSync(path.join(root, ...body.split('/'))).isDirectory(); } catch { /* a file to come */ } }
    rules.push({ entry, test: isDir ? (rel) => rel.startsWith(`${body}/`) : (rel) => rel === body });
  }
  return { rules, refused };
}

/** For a write: `p` inside the vault, allowed by a rule (when `rules` is given) on its path and its real path, neither
 *  in a refused area (duty-guard's refusal, then localDenied); the target, when it exists, is a regular file. */
function writable(root, p, rules) {
  const { refusal } = require('../persona/duty-guard.js');
  const { localDenied } = require('./routines-store.js');
  const v = vaultPath(root, p);
  const why = refusal(v.rel) || localDenied(v.rel);
  if (why) refuse(why);
  if (rules && !rules.some((r) => r.test(v.rel))) refuse('outside this routine\'s writes');
  let st = null;
  try { st = fs.lstatSync(v.abs); } catch { /* new file */ }
  if (st && st.isSymbolicLink()) refuse('a symlink');
  if (st && st.isDirectory()) refuse('a folder');
  if (st && !st.isFile()) refuse('not a regular file');
  // The real path — symlinked folders resolved, case and Unicode canonical — must pass every rule as well.
  const real = realRel(root, v.abs);
  if (real === null) refuse('it resolves outside the vault');
  if (real !== v.rel) {
    const whyReal = refusal(real) || localDenied(real);
    if (whyReal) refuse(`it resolves to ${real}: ${whyReal}`);
    if (rules && !rules.some((r) => r.test(real))) refuse(`it resolves to ${real}, outside this routine's writes`);
  }
  return v;
}

// ── tool helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

function isBinary(buf) { return buf.subarray(0, 8192).includes(0); }

function clip(text, n) {
  const s = String(text);
  return s.length > n ? `${s.slice(0, n)}\n[truncated: ${s.length - n} more characters]` : s;
}

/** Files and folders under `abs` (no dot entries, no symlinks), depth-first, sorted; stops after `max` files. */
function walk(abs, rel, { recursive, max, onFile, onDir }) {
  let n = 0;
  const visit = (a, r) => {
    let names;
    try { names = fs.readdirSync(a, { withFileTypes: true }); } catch { return; }
    names.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const d of names) {
      if (n >= max) return;
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
      const childRel = r ? `${r}/${d.name}` : d.name;
      const childAbs = path.join(a, d.name);
      if (d.isDirectory()) {
        if (onDir) onDir(childRel);
        if (recursive) visit(childAbs, childRel);
      } else if (d.isFile()) { n++; if (onFile(childRel, childAbs) === false) { n = max; return; } }
    }
  };
  visit(abs, rel);
  return n;
}

/** Checks `args` against a tool's { required, types }; returns the problem or null. Unknown keys are ignored. */
function checkArgs(args, spec) {
  for (const k of spec.required) if (args[k] === undefined || args[k] === null || args[k] === '') return `${k} is required`;
  for (const [k, t] of Object.entries(spec.types)) {
    const v = args[k];
    if (v === undefined || v === null) continue;
    if (t === 'integer' ? !(Number.isInteger(v) && v >= 0) : typeof v !== t) return `${k} must be ${t === 'integer' ? 'a whole number' : `a ${t}`}`;
  }
  return null;
}

// ── the tools ───────────────────────────────────────────────────────────────────────────────────────────────────────

const TOOL_SPECS = {
  read_file: { required: ['path'], types: { path: 'string', offset: 'integer', limit: 'integer' } },
  list_files: { required: [], types: { path: 'string', recursive: 'boolean' } },
  grep: { required: ['text'], types: { text: 'string', path: 'string', ignore_case: 'boolean' } },
  write_file: { required: ['path'], types: { path: 'string', content: 'string', append: 'boolean' } },
  notify: { required: ['title'], types: { title: 'string', body: 'string', level: 'string' } },
};

/** The function definitions sent to the engine (OpenAI shape; Ollama takes the same). */
function toolDefs({ canWrite }) {
  const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  const str = (description) => ({ type: 'string', description });
  const defs = [
    fn('read_file', 'Read a text file in the vault. Returns its lines with line numbers; use offset and limit for a long file.',
      { path: str('Vault-relative path, e.g. notes/today.md'), offset: { type: 'integer', description: 'First line to return (1-based); default 1' }, limit: { type: 'integer', description: `How many lines; default ${READ_LINES}` } }, ['path']),
    fn('list_files', 'List the files and folders in a vault folder (folders end with /).',
      { path: str('Vault-relative folder; empty for the vault root'), recursive: { type: 'boolean', description: 'Include everything below it' } }, []),
    fn('grep', 'Search the text files under a vault folder for a piece of text (plain text, not a pattern). Returns file:line: text.',
      { text: str('The text to find, as written'), path: str('Vault-relative folder or file; empty for the whole vault'), ignore_case: { type: 'boolean', description: 'Match regardless of case' } }, ['text']),
  ];
  if (canWrite) {
    defs.push(fn('write_file', 'Write a text file in the vault (only where this routine may write). Replaces the file unless append is true.',
      { path: str('Vault-relative path'), content: str('The text to write'), append: { type: 'boolean', description: 'Add to the end instead of replacing' } }, ['path', 'content']));
  }
  defs.push(fn('notify', `Post a short notification to the user (at most ${NOTIFY_MAX} per run).`,
    { title: str('One line, at most 160 characters'), body: str('Optional details (Markdown)'), level: { type: 'string', enum: ['info', 'alert'], description: 'alert also raises a desktop banner; default info' } }, ['title']));
  return defs;
}

function makeTools(ctx) {
  const { root, rules, routine } = ctx;
  return {
    read_file(a) {
      const v = readable(root, a.path);
      let st;
      try { st = fs.statSync(v.abs); } catch { refuse('no such file'); }
      if (st.isDirectory()) refuse('a folder: use list_files');
      if (!st.isFile()) refuse('not a regular file');
      if (st.size > READ_MAX_BYTES) refuse(`too large (${st.size} bytes): grep it instead`);
      const buf = fs.readFileSync(v.abs);
      if (isBinary(buf)) refuse('a binary file');
      const lines = buf.toString('utf8').split('\n');
      const from = Math.max(1, a.offset || 1);
      const count = Math.max(1, Math.min(a.limit || READ_LINES, 2000));
      const shown = lines.slice(from - 1, from - 1 + count);
      const width = String(from + shown.length).length;
      const body = shown.map((l, i) => `${String(from + i).padStart(width)}  ${l}`).join('\n');
      const more = from - 1 + shown.length < lines.length ? `\n[lines ${from}-${from + shown.length - 1} of ${lines.length}; offset ${from + shown.length} reads on]` : '';
      return { text: `${v.rel}\n${body}${more}`, path: v.rel };
    },
    list_files(a) {
      const v = readable(root, a.path, { allowRoot: true });
      let st;
      try { st = fs.statSync(v.abs); } catch { refuse('no such folder'); }
      if (!st.isDirectory()) refuse('not a folder');
      const out = [];
      let capped = false;
      walk(v.abs, v.rel, {
        recursive: !!a.recursive, max: WALK_MAX_FILES,
        onDir: (r) => { if (out.length < LIST_MAX) out.push(`${r}/`); else capped = true; },
        onFile: (r) => { if (out.length < LIST_MAX) out.push(r); else { capped = true; return false; } return true; },
      });
      const where = v.rel || '.';
      return { text: out.length ? `${out.join('\n')}${capped ? `\n[more than ${LIST_MAX} entries; list a subfolder]` : ''}` : `${where} is empty`, path: where };
    },
    grep(a) {
      // Plain text, never a regular expression: no pattern can backtrack, and the search stops at GREP_MAX_MS (or the
      // run's deadline), so a call is bounded however large the vault.
      const ic = !!a.ignore_case;
      const needle = ic ? a.text.toLowerCase() : a.text;
      const v = readable(root, a.path, { allowRoot: true });
      let st;
      try { st = fs.statSync(v.abs); } catch { refuse('no such file or folder'); }
      if (!st.isDirectory() && !st.isFile()) refuse('not a regular file');
      const stopAt = Math.min(Date.now() + GREP_MAX_MS, ctx.deadline);
      const hits = [];
      let late = false;
      const scan = (r, abs) => {
        if (Date.now() > stopAt) { late = true; return false; }
        let s;
        try { s = fs.statSync(abs); } catch { return true; }
        if (!s.isFile() || s.size > GREP_FILE_MAX_BYTES) return true;
        let buf;
        try { buf = fs.readFileSync(abs); } catch { return true; }
        if (isBinary(buf)) return true;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if ((ic ? lines[i].toLowerCase() : lines[i]).includes(needle)) {
            hits.push(`${r}:${i + 1}: ${lines[i].trim().slice(0, GREP_LINE_CHARS)}`);
            if (hits.length >= GREP_MAX_MATCHES) return false;
          }
        }
        return true;
      };
      if (st.isDirectory()) walk(v.abs, v.rel, { recursive: true, max: WALK_MAX_FILES, onFile: scan });
      else scan(v.rel, v.abs);
      const where = v.rel || '.';
      const note = hits.length >= GREP_MAX_MATCHES ? `\n[stopped at ${GREP_MAX_MATCHES} matches; narrow the text or the path]` : late ? '\n[stopped: the search ran out of time; narrow the path]' : '';
      return { text: hits.length ? `${hits.join('\n')}${note}` : `no match under ${where}${note}`, path: where };
    },
    write_file(a) {
      if (typeof a.content !== 'string') refuse('content is required');
      const bytes = Buffer.byteLength(a.content);
      if (bytes > WRITE_MAX_BYTES) refuse(`content too large (${bytes} bytes, at most ${WRITE_MAX_BYTES})`);
      const v = writable(root, a.path, rules);
      fs.mkdirSync(path.dirname(v.abs), { recursive: true });
      if (a.append) fs.appendFileSync(v.abs, a.content);
      else {
        const tmp = `${v.abs}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, a.content);
        fs.renameSync(tmp, v.abs);
      }
      ctx.wrote.push(v.rel);
      return { text: `${a.append ? 'appended' : 'wrote'} ${bytes} bytes to ${v.rel}`, path: v.rel };
    },
    notify(a) {
      if (ctx.notified >= NOTIFY_MAX) refuse(`at most ${NOTIFY_MAX} notifications a run`);
      const level = a.level === 'alert' ? 'alert' : 'info';
      const title = String(a.title).replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!title) refuse('title is required');
      const r = ctx.post({ from: routine.slug, level, title, body: typeof a.body === 'string' ? a.body : undefined });
      ctx.notified++;
      return { text: `posted ${r && r.level ? r.level : level}: ${title}`, path: null };
    },
  };
}

// ── the engine ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Is the local engine up with the model pulled? See the module comment. */
async function resolveLocal({ cfg, model = null, deps = {} } = {}) {
  const { localCfg } = require('../sdk/lib/local-config.js');
  const lc = localCfg(cfg || {});
  // provider.js's own: one request for what the engine serves, and the tier rule for the workhorse (local-first A13).
  const listModels = deps.listLocalModels || ((l) => require('../sdk/lib/provider.js').listLocalModels(l));
  const pickModel = deps.pickLocalModel || ((w, m) => require('../sdk/lib/provider.js').pickLocalModel(w, m));
  const { sameModel } = require('../sdk/lib/ollama.js');
  const where = lc.engine === 'openai' ? `the OpenAI-compatible server at ${lc.url}` : `Ollama at ${lc.url}`;
  const list = await listModels(lc);
  if (!Array.isArray(list)) return { ok: false, reason: 'local-down', detail: `${where} is not answering`, lc, model: null };
  if (model) {
    const hit = list.find((m) => sameModel(m, model));
    return hit ? { ok: true, reason: 'local-ready', detail: null, lc, model: hit }
      : { ok: false, reason: 'local-down', detail: `${model} is not pulled on ${where}${lc.engine === 'ollama' ? ` (aos local pull ${model})` : ''}`, lc, model: null };
  }
  const picked = pickModel(lc.workhorse, list);
  return picked ? { ok: true, reason: 'local-ready', detail: null, lc, model: picked }
    : { ok: false, reason: 'local-down', detail: `${lc.workhorse.tag} is not pulled on ${where}${lc.engine === 'ollama' ? ' (aos local pull)' : ''}`, lc, model: null };
}

function engineOf(lc, deps) {
  if (lc.engine === 'openai') {
    const oa = require('../sdk/lib/openai-compat.js');
    return { name: 'openai', turn: (o) => (deps.openaiChatMessage || oa.chatMessage)({ ...o, url: lc.url }), toolMessage: oa.toolMessage };
  }
  const ol = require('../sdk/lib/ollama.js');
  return { name: 'ollama', turn: (o) => (deps.ollamaChatMessage || ol.chatMessage)({ ...lc.net, keepAlive: lc.workhorse.keepAlive, numCtx: NUM_CTX, ...o }), toolMessage: ol.toolMessage };
}

function pad(n) { return String(n).padStart(2, '0'); }
function localStamp(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The preamble the routine's body follows in the system prompt. */
function systemPrompt(routine, { rules, now }) {
  const writes = rules.length
    ? `You may write files with write_file only at: ${rules.map((r) => r.entry).join(', ')} (a trailing / means anything inside that folder). Any other write is refused.`
    : 'This routine may not write files: write_file is not available.';
  return [
    `You are running the scheduled routine "${routine.name || routine.slug}" for the user, on their own computer, with no one watching. Work only through the tools.`,
    `Paths are relative to the user's vault (its root is "."); folders starting with a dot are off limits. It is ${DAYS[now.getDay()]} ${localStamp(now)} local time.`,
    'read_file reads a text file, list_files lists a folder, grep searches text.',
    writes,
    `notify posts a short notification to the user (at most ${NOTIFY_MAX}).`,
    'Keep tool calls few and purposeful. When the routine is done, reply without a tool call: a short final message saying what you did and anything the user should know. Do not ask questions; no one will answer.',
    '',
    '## The routine',
    '',
    String(routine.body || '').trim(),
  ].join('\n');
}

function msgChars(m) {
  return String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}

/** A tool call with every string argument over ARG_KEEP_CHARS elided (Ollama sends arguments as an object, an
 *  OpenAI-compatible server as a JSON string); null when nothing in it is that long. */
function trimCall(c) {
  const fn = (c && c.function) || {};
  const asString = typeof fn.arguments === 'string';
  let args = fn.arguments;
  if (asString) { try { args = JSON.parse(args); } catch { return fn.arguments.length > ARG_KEEP_CHARS ? { ...c, function: { ...fn, arguments: '{}' } } : null; } }
  if (!args || typeof args !== 'object') return null;
  let changed = false;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > ARG_KEEP_CHARS) { out[k] = `[elided: ${v.length} characters]`; changed = true; } else out[k] = v;
  }
  return changed ? { ...c, function: { ...fn, arguments: asString ? JSON.stringify(out) : out } } : null;
}

/**
 * Keeps the history within CONTEXT_CHARS, the system prompt and the first user message always kept, and the current
 * turn's results (from `current`, the index of this turn's assistant message) never elided: first earlier turns' tool
 * results, oldest first; then long arguments of calls already made (a write_file's content), oldest first. Every
 * message counts, assistant calls included. Returns the total.
 */
function fitContext(messages, current = messages.length) {
  let total = messages.reduce((n, m) => n + msgChars(m), 0);
  for (let i = 2; i < current && total > CONTEXT_CHARS; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || m.content === ELIDED) continue;
    total -= msgChars(m) - ELIDED.length;
    messages[i] = { ...m, content: ELIDED };
  }
  for (let i = 2; i < messages.length && total > CONTEXT_CHARS; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    const calls = m.tool_calls.map((c) => trimCall(c) || c);
    if (calls.every((c, k) => c === m.tool_calls[k])) continue;
    const next = { ...m, tool_calls: calls };
    total -= msgChars(m) - msgChars(next);
    messages[i] = next;
  }
  return total;
}

function argText(args) {
  if (!args) return '';
  const p = typeof args.text === 'string' ? JSON.stringify(args.text.slice(0, 60)) : typeof args.path === 'string' ? args.path : typeof args.title === 'string' ? JSON.stringify(args.title.slice(0, 60)) : '';
  return p ? ` ${p}` : '';
}

/** Runs the routine on the local engine. See the module comment. */
async function runLocalAgent({ routine, cfg = {}, vault, lc, model, timeoutMs, deps = {} } = {}) {
  const clock = deps.clock || (() => Date.now());
  const t0 = clock();
  const deadline = t0 + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : (routine.timeoutSec || DEFAULT_TIMEOUT_SEC) * 1000);
  const maxTurns = Number.isInteger(routine.maxTurns) && routine.maxTurns > 0 ? routine.maxTurns : DEFAULT_MAX_TURNS;
  const root = realRoot(vault);
  const journal = [];
  const note = (line) => journal.push(line);
  const { rules, refused: refusedEntries } = compileWrites(routine.writes, root);
  for (const r of refusedEntries) note(`writes entry '${r.entry}' refused: ${r.why}`);
  const engine = engineOf(lc, deps);
  const feature = `routine:${routine.slug}`;
  const count = deps.recordLocalCall || require('../sdk/lib/local-usage.js').recordLocalCall;
  const post = deps.postNotification || ((p) => require('./notifications.js').post(p, {
    vault, cfg, notify: (t, m) => require('../persona/watchdog.js').osNotify(t, m),
  }));
  const ctx = { root, rules, routine, wrote: [], notified: 0, post, deadline: Date.now() + (deadline - t0) };
  const tools = makeTools(ctx);
  const defs = toolDefs({ canWrite: rules.length > 0 });
  const offered = new Set(defs.map((d) => d.function.name));
  const now = new Date(t0);
  const messages = [
    { role: 'system', content: systemPrompt(routine, { rules, now }) },
    { role: 'user', content: 'Run the routine now.' },
  ];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const refused = [];
  let toolCalls = 0, turns = 0, final = null, status = 'ok', error = null;
  const timedOut = () => `timed out after ${Math.round((deadline - t0) / 1000)}s`;

  // One timer for the whole run: at the deadline the request in flight is aborted and the run stops, whatever it waits on.
  const abort = new AbortController();
  let expired = false;
  let timer = null;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => { expired = true; abort.abort(); resolve(); }, Math.max(0, deadline - clock()));
  });
  const EXPIRED = Symbol('expired');

  try {
    while (true) {
      if (turns >= maxTurns) { status = 'error'; error = `stopped after ${maxTurns} turns without a final answer (maxTurns)`; break; }
      const left = deadline - clock();
      if (expired || left <= 0) { status = 'timeout'; error = timedOut(); break; }
      turns++;
      let reply;
      const c0 = clock();
      try {
        reply = await Promise.race([engine.turn({ model, messages, tools: defs, numPredict: NUM_PREDICT, timeoutMs: left, feature, signal: abort.signal }), expiry.then(() => EXPIRED)]);
      } catch (e) {
        if (expired || clock() >= deadline) { status = 'timeout'; error = timedOut(); note(`turn ${turns}: the engine did not answer before the deadline`); }
        else { status = 'error'; error = `${engine.name}: ${e.message}`; note(`turn ${turns}: the engine failed: ${e.message}`); }
        break;
      } finally {
        count({ feature, ms: clock() - c0 });
      }
      if (reply === EXPIRED) { status = 'timeout'; error = timedOut(); note(`turn ${turns}: the engine did not answer before the deadline`); break; }
      usage.inputTokens += reply.usage ? reply.usage.inputTokens : 0;
      usage.outputTokens += reply.usage ? reply.usage.outputTokens : 0;
      const current = messages.length;
      messages.push(reply.message);
      if (!reply.toolCalls.length) { final = reply.content; break; }
      // The turn's results share TURN_RESULT_CHARS, so the current turn always fits the history.
      const share = Math.max(500, Math.min(RESULT_CHARS, Math.floor(TURN_RESULT_CHARS / reply.toolCalls.length)));
      for (let i = 0; i < reply.toolCalls.length; i++) {
        const call = reply.toolCalls[i];
        toolCalls++;
        let result;
        const label = `turn ${turns}: ${call.name || '(no name)'}${argText(call.args)}`;
        try {
          if (expired) refuse('the routine ran out of time');
          if (i >= MAX_CALLS_PER_TURN) refuse(`too many tool calls in one turn (at most ${MAX_CALLS_PER_TURN})`);
          if (!offered.has(call.name)) refuse(`unknown tool "${call.name}"; the tools are ${[...offered].join(', ')}`);
          if (call.argError) refuse(call.argError);
          const bad = checkArgs(call.args, TOOL_SPECS[call.name]);
          if (bad) refuse(bad);
          const out = tools[call.name](call.args);
          result = out.text;
          note(`${label} → ok (${String(out.text).length} chars)`);
        } catch (e) {
          const why = e instanceof Refused ? e.message : `failed: ${e.message}`;
          result = `error: ${why}`;
          if (e instanceof Refused && call.name === 'write_file') refused.push({ tool: call.name, path: call.args && call.args.path, why });
          note(`${label} → ${e instanceof Refused ? 'REFUSED' : 'ERROR'}: ${why}`);
        }
        messages.push(engine.toolMessage(call, clip(result, share)));
      }
      fitContext(messages, current);
    }
  } finally {
    clearTimeout(timer);
  }

  const out = { status, final, error, turns, toolCalls, wrote: ctx.wrote, refused, journal, engine: engine.name, model, usage, ms: clock() - t0 };
  if (status === 'ok') {
    if (!final) note('the model ended without a final message');
    deliver(out, { routine, root, post, note });
  }
  return out;
}

/** The final message to where `output` says (the log always gets it from run-routine.js). A failure is journalled. */
function deliver(out, { routine, root, post, note }) {
  const where = routine.output;
  if (!out.final || !where || where === 'log') return;
  try {
    if (where === 'notify') {
      post({ from: routine.slug, level: 'info', title: String(routine.name || routine.slug).replace(/\s+/g, ' ').slice(0, 160), body: out.final });
      note('final message posted to Notifications');
      return;
    }
    const v = writable(root, where, null);
    fs.mkdirSync(path.dirname(v.abs), { recursive: true });
    const head = fs.existsSync(v.abs) && fs.statSync(v.abs).size ? '\n' : '';
    fs.appendFileSync(v.abs, `${head}## ${routine.name || routine.slug} — ${localStamp(new Date())}\n\n${out.final.trim()}\n`);
    note(`final message appended to ${v.rel}`);
  } catch (e) {
    note(`final message not delivered to ${where}: ${e.message}`);
  }
}

module.exports = {
  resolveLocal, runLocalAgent, compileWrites, globRe, vaultPath, realRel, readable, writable, toolDefs, systemPrompt, fitContext, trimCall, checkArgs,
  DEFAULT_MAX_TURNS, MAX_CALLS_PER_TURN, NUM_CTX, CONTEXT_CHARS, RESULT_CHARS, TURN_RESULT_CHARS, READ_MAX_BYTES, LIST_MAX, GREP_MAX_MATCHES, WRITE_MAX_BYTES, NOTIFY_MAX, ELIDED,
};
