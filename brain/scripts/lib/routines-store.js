'use strict';
/**
 * routines-store.js — the routine files (<vault>/brain/routines/<slug>.md) and their run state
 * (<vault>/brain/_index/routines.json). Zero dependencies; every path is injectable for tests.
 *
 * A routine file is YAML-ish frontmatter plus a body:
 *   schema: 1 · name · kind (duty|prompt|command) · schedule (5-field cron, see lib/cron.js) · enabled
 *   guarded (bool) · engine (prompt; local|claude|codex, local-first A6: where it runs — without it, routines.runner
 *   decides as before) · model, effort (prompt, duty; `model` names a model of the routine's engine, and a Claude model
 *   when it has none) · budgetUsd (prompt, duty) · maxTurns (prompt; the local agent's turn limit, default 24) · tools
 *   (duty; the PERSONA_TOOLS allowlist, `{{NODE}}`/`{{VAULT}}` expanded by the runner) · writes (duty: flow array of
 *   vault-relative paths the duty may write on top of the default scope, persona/duty-guard.js; prompt: the paths or
 *   globs the local agent's write_file may write, and nothing else, lib/local-agent.js) · output (prompt; where the
 *   local agent's final message goes: log, notify, or a vault-relative .md file it is appended to) · argv (command;
 *   flow array of strings) · timeoutSec · tags (flow array)
 * The frontmatter subset here is deliberately small — scalars (string, number, boolean, null),
 * quoted strings, and single-line flow arrays — and the writer only ever emits that subset, so a
 * file the HUD wrote is always a file the runtime can read (and vice versa; src/data/routines.ts
 * mirrors this parser and both are checked against test/fixtures/routines/*).
 *
 * State file: { schema: 1, routines: { <slug>: { lastRunAt, lastExit, lastCostUsd, lastDurationMs,
 * failStreak, lastTrigger, lastError } }, synced: { <slug>: fingerprint }, syncedAt }.
 * Next-run and "missed" are never stored; readers compute them from the schedule (spec D6).
 */
const fs = require('fs');
const path = require('path');
const cron = require('./cron.js');
const fsx = require('./fsx.js');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const KINDS = ['duty', 'prompt', 'command'];
const EFFORTS = ['low', 'medium', 'high'];
/** Where a prompt routine runs (local-first A6): the local agent runner, or one host's CLI. */
const ENGINES = ['local', 'claude', 'codex'];
const MAX_TURNS_LIMIT = 200;
const KEY_ORDER = ['schema', 'name', 'kind', 'schedule', 'enabled', 'guarded', 'engine', 'model', 'effort', 'budgetUsd', 'maxTurns', 'tools', 'writes', 'output', 'argv', 'timeoutSec', 'tags'];
const STATE_SCHEMA = 1;

function defaultDir() { return require('./paths.js').PATHS.ROUTINES; }
function defaultStateFile() { return require('./paths.js').PATHS.ROUTINES_STATE; }

// ---------- frontmatter ----------

function parseScalar(text) {
  const t = text.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return t;
}

/** Splits a single-line flow array `[a, "b, c", 'd']` on commas outside quotes. */
function parseFlowArray(text) {
  const inner = text.trim().slice(1, -1);
  const items = [];
  let cur = '', quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) { cur += inner[++i]; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") { quote = ch; cur += ch; }
    else if (ch === ',') { items.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '' || items.length) items.push(cur);
  return items.map(parseScalar).filter(v => v !== null);
}

function parseFrontmatter(content) {
  const text = String(content || '');
  if (!text.startsWith('---')) return { frontmatter: {}, body: text, hasFrontmatter: false };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { frontmatter: {}, body: text, hasFrontmatter: false };
  const block = text.slice(4, end);
  const fm = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const val = m[2].trim();
    fm[m[1]] = val.startsWith('[') && val.endsWith(']') ? parseFlowArray(val) : parseScalar(val);
  }
  const body = text.slice(end + 4).replace(/^(\r?\n)+/, '');   // leading blank lines are layout, not body
  return { frontmatter: fm, body, hasFrontmatter: true };
}

function quote(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function serializeScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // Bare when it cannot be misread as another type or as YAML syntax.
  if (/^[A-Za-z][A-Za-z0-9 _./-]*$/.test(s) && !['true', 'false', 'null'].includes(s)) return s;
  return quote(s);
}
function serializeFrontmatter(fm) {
  const keys = [...KEY_ORDER.filter(k => k in fm), ...Object.keys(fm).filter(k => !KEY_ORDER.includes(k))];
  const lines = [];
  for (const k of keys) {
    const v = fm[k];
    if (v === undefined) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.map(serializeScalar).join(', ')}]` : `${k}: ${serializeScalar(v)}`);
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

// ---------- routines ----------

// Where a routine may never write, and why (the runners' own rule, lib/write-areas.js): validate() refuses a `writes`
// entry or an `output` file here, before the routine runs, with the reason its runner would give. LOCAL_DENY and
// localDenied stay exported from here for their older callers.
const { LOCAL_DENY, localDenied, localWritesRefusal, localOutputRefusal, dutyWritesRefusal } = require('./write-areas.js');

function isStringArray(v) { return Array.isArray(v) && v.every(s => typeof s === 'string' && s.length > 0); }
function isMoney(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }
/** A vault-relative path (or glob): not absolute, no `..` segment, no backslash. */
function isVaultRel(p) {
  const s = String(p || '').trim();
  return !!s && !s.startsWith('/') && !s.startsWith('~') && !s.includes('\\') && !s.split('/').includes('..');
}

/** Returns an array of human-readable problems; empty means valid. */
function validate(routine) {
  const errors = [];
  const r = routine || {};
  if (!SLUG_RE.test(String(r.slug || ''))) errors.push('slug must be 2-41 chars of a-z, 0-9 and "-" and start with a letter or digit');
  if (r.schema !== 1) errors.push('schema must be 1');
  if (typeof r.name !== 'string' || !r.name.trim()) errors.push('name is required');
  if (!KINDS.includes(r.kind)) errors.push(`kind must be one of ${KINDS.join(', ')}`);
  if (typeof r.schedule !== 'string' || !r.schedule.trim()) errors.push('schedule is required');
  else { try { cron.parse(r.schedule); } catch (e) { errors.push(`schedule: ${e.message}`); } }
  if (typeof r.enabled !== 'boolean') errors.push('enabled must be true or false');
  if (r.guarded !== undefined && typeof r.guarded !== 'boolean') errors.push('guarded must be true or false');
  if (r.timeoutSec !== undefined && !(Number.isInteger(r.timeoutSec) && r.timeoutSec > 0)) errors.push('timeoutSec must be a positive integer');
  if (r.tags !== undefined && !isStringArray(r.tags)) errors.push('tags must be an array of strings');
  if (r.kind === 'prompt' || r.kind === 'duty') {
    if (r.model !== undefined && (typeof r.model !== 'string' || !r.model.trim())) errors.push('model must be a string');
    if (r.effort !== undefined && !EFFORTS.includes(r.effort)) errors.push(`effort must be one of ${EFFORTS.join(', ')}`);
  }
  if (r.engine !== undefined) {
    if (r.kind !== 'prompt') errors.push('engine is for prompt routines only');
    else if (!ENGINES.includes(r.engine)) errors.push(`engine must be one of ${ENGINES.join(', ')}`);
  }
  if (r.kind === 'prompt') {
    if (typeof r.body !== 'string' || !r.body.trim()) errors.push('a prompt routine needs a body');
    if (r.budgetUsd !== undefined && !isMoney(r.budgetUsd)) errors.push('budgetUsd must be a non-negative number');
    if (r.maxTurns !== undefined && !(Number.isInteger(r.maxTurns) && r.maxTurns > 0 && r.maxTurns <= MAX_TURNS_LIMIT)) errors.push(`maxTurns must be a whole number from 1 to ${MAX_TURNS_LIMIT}`);
    if (r.writes !== undefined && (!isStringArray(r.writes) || r.writes.some(w => !isVaultRel(w) || w.includes(',')))) errors.push('writes must be an array of vault-relative paths or globs (no commas)');
    if (r.output !== undefined && !(r.output === 'log' || r.output === 'notify' || (typeof r.output === 'string' && /\.md$/.test(r.output) && isVaultRel(r.output)))) errors.push('output must be log, notify or a vault-relative .md file');
    // An entry or a file that is a vault-relative path, checked against the rule its runner applies (one message each).
    for (const w of isStringArray(r.writes) ? r.writes.filter(x => isVaultRel(x) && !x.includes(',')) : []) { const why = localWritesRefusal(w); if (why) errors.push(`writes: ${w} is off limits to a local routine (${why})`); }
    if (typeof r.output === 'string' && /\.md$/.test(r.output) && isVaultRel(r.output)) { const why = localOutputRefusal(r.output); if (why) errors.push(`output: ${r.output} is off limits to a local routine (${why})`); }
  }
  if (r.kind === 'duty') {
    if (r.budgetUsd !== undefined && !isMoney(r.budgetUsd)) errors.push('budgetUsd must be a non-negative number');
    if (r.tools !== undefined && (typeof r.tools !== 'string' || !r.tools.trim())) errors.push('tools must be a non-empty string');
    if (r.writes !== undefined && (!isStringArray(r.writes) || r.writes.some(w => !w.trim() || w.includes(',')))) errors.push('writes must be an array of vault-relative paths (no commas)');
    for (const w of isStringArray(r.writes) ? r.writes.filter(x => x.trim() && !x.includes(',')) : []) { const why = dutyWritesRefusal(w); if (why) errors.push(`writes: ${w} is off limits to a duty (${why})`); }
  }
  if (r.kind === 'command') {
    if (!isStringArray(r.argv) || r.argv.length === 0) errors.push('a command routine needs argv: a non-empty array of strings');
  }
  return errors;
}

function fromFile(slug, content) {
  const { frontmatter, body, hasFrontmatter } = parseFrontmatter(content);
  const routine = { slug, ...frontmatter, body };
  const errors = hasFrontmatter ? validate(routine) : ['no frontmatter block'];
  return { ...routine, errors };
}

function toFile(routine) {
  const { slug, body, errors, ...fm } = routine;   // eslint-disable-line no-unused-vars
  const text = String(body || '').replace(/\s+$/, '');
  return serializeFrontmatter(fm) + (text ? `\n${text}\n` : '');
}

/** Every *.md in the routines dir, sorted by slug; invalid files are returned with `errors` so a UI can show them. */
function list({ dir = defaultDir() } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.') && f.toLowerCase() !== 'readme.md'); } catch { return []; }
  return names.sort().map(f => {
    const slug = f.slice(0, -3);
    let content;
    try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return { slug, errors: [`unreadable: ${e.message}`] }; }
    return fromFile(slug, content);
  });
}

function read(slug, { dir = defaultDir() } = {}) {
  if (!SLUG_RE.test(String(slug))) return null;
  let content;
  try { content = fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8'); } catch { return null; }
  return fromFile(slug, content);
}

/** Validates, then writes atomically (tmp + rename). Throws on a validation error. */
function write(routine, { dir = defaultDir() } = {}) {
  const errors = validate(routine);
  if (errors.length) { const e = new Error(`invalid routine: ${errors.join('; ')}`); e.errors = errors; throw e; }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${routine.slug}.md`);
  fsx.writeAtomic(file, toFile(routine));
  return file;
}

/** What the installed schedule depends on: a changed fingerprint means `sync` is due. */
function fingerprint(routine) {
  return `${routine.kind}|${String(routine.schedule || '').trim().replace(/\s+/g, ' ')}|${routine.enabled ? 'on' : 'off'}`;
}

// ---------- state ----------

function emptyState() { return { schema: STATE_SCHEMA, routines: {}, synced: {}, syncedAt: null }; }

function readState({ file = defaultStateFile() } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.routines && typeof parsed.routines === 'object') {
      return { ...emptyState(), ...parsed, schema: STATE_SCHEMA };
    }
  } catch { /* missing or corrupt — start fresh */ }
  return emptyState();
}

const stateText = (state) => JSON.stringify({ ...emptyState(), ...state, schema: STATE_SCHEMA }, null, 2) + '\n';

function writeState(state, { file = defaultStateFile() } = {}) {
  fsx.writeAtomic(file, stateText(state));
}

/**
 * Read-modify-write the whole state under routines.json's lock (spec 2026-09-24-locked-writers D2): two routines
 * finishing together, or a sync recording its fingerprints while a routine records its run, each see the other's
 * write instead of overwriting it. `mutate(state)` changes it in place or returns a replacement.
 */
function updateState(mutate, { file = defaultStateFile() } = {}) {
  let result = null;
  fsx.updateSync(file, (text) => {
    let st = emptyState();
    try {
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === 'object' && parsed.routines && typeof parsed.routines === 'object') st = { ...emptyState(), ...parsed, schema: STATE_SCHEMA };
    } catch { /* corrupt — start fresh, as readState does */ }
    result = mutate(st) || st;
    return stateText(result);
  }, { timeoutMs: 5000 });
  return result;
}

/** Read-modify-write one slug's entry, locked (updateState). `mutate(entry)` may return a replacement. */
function patchState(slug, mutate, opts = {}) {
  const st = updateState((s) => {
    const cur = s.routines[slug] || { lastRunAt: null, lastExit: null, lastCostUsd: null, lastDurationMs: null, failStreak: 0, lastTrigger: null, lastError: null };
    s.routines[slug] = mutate(cur) || cur;
  }, opts);
  return st.routines[slug];
}

/** The reader-side view for one routine: next fire times, and a health word the HUD and CLI share. */
function health(routine, entry, now = new Date(), { missedGraceMs = 15 * 60_000, synced, syncedAt } = {}) {
  if (routine.errors && routine.errors.length) return 'invalid';
  if (!routine.enabled) return 'off';
  if (synced !== undefined && synced !== fingerprint(routine)) return 'stale';
  if (entry && typeof entry.lastExit === 'number' && entry.lastExit !== 0) return 'failed';
  const last = entry && entry.lastRunAt ? new Date(entry.lastRunAt) : null;
  // Missed: a fire time has passed (plus grace) since the last run — or since the schedules were installed — with no run recorded.
  const from = last || (syncedAt ? new Date(syncedAt) : null);
  if (from) {
    const due = cron.next(routine.schedule, from, 1)[0];
    if (due && now - due > missedGraceMs) return 'missed';
  }
  return 'ok';
}

// ---------- duty log fallback (spec host-routines D1) ----------

function defaultLogDir() { return path.join(require('./paths.js').PATHS.PERSONA, 'journal', 'logs'); }

/** The last completed run persona/run-duty.sh recorded in duty-<slug>.log: the file's mtime is the run end, the last
 *  line's `done (exit N)` the exit. Null when the log is absent, empty, or its last line is a `start` (in flight or crashed). */
function dutyLogLast(slug, { logDir = defaultLogDir() } = {}) {
  if (!SLUG_RE.test(String(slug))) return null;
  const file = path.join(logDir, `duty-${slug}.log`);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || !st.size) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, 4096);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').replace(/\s+$/, '').split('\n');
    const m = /duty=\S+ done \(exit (\d+)\)$/.exec(lines[lines.length - 1]);
    return m ? { at: st.mtime.toISOString(), exit: Number(m[1]) } : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** A duty's state entry, or one synthesized from its log when the log records a run the state file never saw (a run that
 *  bypassed run-routine.js). A log end inside the recorded run's window (start + duration, a minute of slack) is that run. */
function mergeDutyLog(routine, entry, { logDir } = {}) {
  if (!routine || routine.kind !== 'duty') return entry;
  const log = dutyLogLast(routine.slug, { logDir });
  if (!log) return entry;
  if (entry && entry.lastRunAt) {
    const end = Date.parse(entry.lastRunAt) + (Number(entry.lastDurationMs) || 0) + 60_000;
    if (Date.parse(log.at) <= end) return entry;
  }
  const prevStreak = entry && Number.isFinite(entry.failStreak) ? entry.failStreak : 0;
  return {
    ...(entry || {}),
    lastRunAt: log.at, lastExit: log.exit, lastCostUsd: null, lastDurationMs: null,
    failStreak: log.exit === 0 ? 0 : prevStreak + 1, lastTrigger: 'duty-log', lastError: log.exit === 0 ? null : `exit ${log.exit} (from the duty log)`,
  };
}

/** The reader-side view shared by `aos routines list`, the MCP tool, doctor and the HUD: every routine with its
 *  state entry, the next three fire times (ISO) and the health word. Invalid files are included (health "invalid").
 *  A duty's entry is merged with persona/journal/logs/duty-<slug>.log first (mergeDutyLog; `logDir` overrides the location). */
function overview({ dir = defaultDir(), file = defaultStateFile(), logDir, now = new Date() } = {}) {
  const state = readState({ file });
  return list({ dir }).map((r) => {
    const entry = mergeDutyLog(r, state.routines[r.slug] || null, { logDir });
    const valid = r.errors.length === 0;
    const nextRuns = valid && r.enabled ? cron.next(r.schedule, now, 3) : [];
    return {
      slug: r.slug, name: r.name, kind: r.kind, schedule: r.schedule, enabled: !!r.enabled, guarded: !!r.guarded,
      cadence: valid ? cron.describe(r.schedule) : String(r.schedule || ''),
      errors: r.errors,
      next: nextRuns.map(d => d.toISOString()),
      last: entry && entry.lastRunAt ? { at: entry.lastRunAt, exit: entry.lastExit, usd: entry.lastCostUsd, ms: entry.lastDurationMs, trigger: entry.lastTrigger, failStreak: entry.failStreak || 0, error: entry.lastError || null } : null,
      health: health(r, entry, now, { synced: state.synced[r.slug], syncedAt: state.syncedAt }),
    };
  });
}

module.exports = {
  SLUG_RE, KINDS, EFFORTS, ENGINES, MAX_TURNS_LIMIT, KEY_ORDER, STATE_SCHEMA,
  parseFrontmatter, serializeFrontmatter, parseFlowArray,
  validate, fromFile, toFile, list, read, write, fingerprint, localDenied, LOCAL_DENY,
  readState, writeState, updateState, patchState, health, overview,
  dutyLogLast, mergeDutyLog,
};
