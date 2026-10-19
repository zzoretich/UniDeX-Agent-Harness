#!/usr/bin/env node
'use strict';
/**
 * tick.js — the hourly tick (docs/design/specs/2026-09-22-persona-tick-design.md; local-first A5). Since 2.0 the
 * hourly routine is this script's local triage, and the Chief of Staff's model runs only when it is worth waking:
 *
 *   --triage   (the `tick` routine, kind command, every hour) records the recheck confirmations, then compares the change
 *              signature below with the one it last triaged. Unchanged (or back to what the Chief of Staff last saw): it
 *              stops there — no hosted call, no local call. A real change goes to the local model through provider.js
 *              (the background provider, used only when it is the local engine) as a small JSON decision
 *              { wake, reason }; when the local model is down or answers nonsense, any real change wakes. One journal
 *              line either way (`## HH:MM — tick triage: …`). Waking starts the hosted `tick` duty itself, through
 *              run-duty.sh exactly like a scheduled duty (the routine file's budgetUsd and tools become PERSONA_MAX_USD and
 *              PERSONA_TOOLS), and exits with its code. Refused under AOS_HEADLESS=1: a duty never starts another duty.
 *
 * The duty it wakes is persona/duties/tick.md (read-only tools); run-duty.sh calls two verbs around that model run (and
 * a pre-2.0 vault whose tick routine is still `kind: duty` runs it hourly through them, so precheck still skips quiet
 * hours there):
 *
 *   precheck   first records the recheck confirmations (spec 2026-09-22-persona-earned-autonomy-design D2: recheck.js
 *              `record`, at most once per local day, never fatal), then compares a signature of the vault's inputs with
 *              the one recorded at the last beat and exits 3 when nothing changed — the runner then skips the model
 *              call (one duty-log line, no journal entry).
 *   beat       after the duty met its contract: records the beat and the signature the next precheck compares with,
 *              then (spec 2026-09-22-persona-reflect-daily-design D7) starts `reflect-daily` early — detached, through
 *              routines/run-routine.js with trigger `early` — when the queue holds persona.tick.earlyReflect.corrections
 *              (3) corrections or duty failures weighing persona.tick.earlyReflect.dutyFailures (2), a queued failure of
 *              duty s weighing max(1, its failStreak in brain/_index/routines.json). At most once per local day, and only
 *              while brain/routines/reflect-daily.md exists and is enabled.
 *
 * and the model calls two more:
 *
 *   signals    the candidates since the last beat, each with a type and a source pointer, computed here so the model
 *              spends its budget on judgement (queue or drop), not on discovery:
 *                correction    a feedback memory or draft written since the last beat
 *                duty-failure  a beat the watchdog marked failed or missed since the last beat
 *                repo-stall    a tracked repo (persona/repos.json) whose .planning/STATE.md idled past the threshold
 *                regressed     an approved proposal the ledger marked regressed since the last beat
 *                flag-aged     a `- [ ] <date>` flag in STATE.md older than persona.tick.flagAgeDays (default 7)
 *   queue <type> --source <ptr> [--note <text>]
 *              appends one line to <vault>/persona/queue.jsonl — { schema: 1, ts, type, source, note, by: "tick" } —
 *              unless the same (type, source) is already queued. Slice 3's daily reflect drains the queue.
 *
 * Signature (v2, local-first A5) — what can make the Chief of Staff's next run worth paying for, never a clock:
 *   routines     each routine's status (ok | failed | missed | off | invalid, the tick itself left out): a failure or a
 *                miss is a change, a run time never is (the heartbeat, the briefing and the tick run every half hour)
 *   repos        each tracked repo's HEAD (branch and commit) from persona/repos.json — except the vault's own repo,
 *                whose commits are the 30-minute backups: it contributes `memory` (its memory files) instead
 *   corrections  feedback memories and their drafts (names and mtimes) — the corrections the tick queues
 *   proposals    persona/proposals/*.md;  flags  the open `- [ ]` lines under ## Flags in STATE.md;
 *   inbox        unread, unarchived notifications at an alert level (breaking, alert)
 * Each content key is { n, h }: a count and a short hash of the sorted entries. The tick's own writes (journal,
 * STATE.md's tick line and Sitrep block, queue.jsonl) are in none of them, so a run never wakes the next one; `beat`
 * promotes the signature precheck saw, so a change that landed during the run still does. A pre-2.0 signature (no `v`)
 * reads as a first run.
 *
 * State: brain/_index/persona-tick.json (schema 1; triage adds lastTriage { at, signature, wake, reason, by, changes },
 * triages, wakes, localCalls). Every path and the model, provider and duty starter are injectable; --root <vault> for the
 * CLI. Exit codes: precheck 3 = unchanged; 2 = usage or an invalid queue call; --triage the woken duty's exit, else 0;
 * 0 otherwise (a failure inside precheck or beat is reported on stderr and exits 0 so the duty still runs). Under
 * AOS_HEADLESS=1 (a duty) --root must be the vault, or it exits 2 (lib/pin-root.js, spec 2026-09-23-duty-write-scope-design D3).
 */
const fs = require('fs');
const path = require('path');
const { assertPinned } = require('../lib/pin-root.js');

const SCHEMA = 1;
const TYPES = ['correction', 'duty-failure', 'repo-stall', 'regressed', 'flag-aged'];
const EXIT_UNCHANGED = 3;
const DEFAULT_FLAG_AGE_DAYS = 7;
const DEFAULT_EARLY_REFLECT = { corrections: 3, dutyFailures: 2 };
const REFLECT_DAILY = 'reflect-daily';
const DEFAULT_STALL_DAYS = 4;
const FIRST_RUN_WINDOW_MS = 24 * 3600e3;
const DAY_MS = 86400e3;
const FLAG_RE = /^- \[ \] (\d{4}-\d{2}-\d{2}) (.+)$/;
const SIG_VERSION = 2;
const SELF = 'tick';
const ALERTS = ['breaking', 'alert'];
const CONTENT_KEYS = ['corrections', 'memory', 'proposals', 'flags', 'inbox'];
/** The woken duty's budget and allowlist when the tick routine file names none (the template carries the same). Opus 5.5
 *  bills about 4× Haiku 4.5, and a working tick cost about 0.06 USD on Haiku, so 0.50 leaves room (local-first A4). */
const TICK_DUTY = {
  budgetUsd: 0.5,
  tools: 'Read,Glob,Grep,Bash(date:*),Bash({{NODE}} {{VAULT}}/brain/scripts/persona/tick.js:*),Bash({{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js summary:*)',
  timeoutSec: 900,
};
const TRIAGE_FEATURE = 'tick-triage';
const DECISION_SCHEMA = { type: 'object', properties: { wake: { type: 'boolean' }, reason: { type: 'string' } }, required: ['wake', 'reason'], additionalProperties: false };
const TRIAGE_SYSTEM = [
  'You triage the hourly check of a Chief of Staff agent that watches a user\'s projects. Something changed since it last ran.',
  'Decide whether the change merits waking it now: a run on a hosted model that costs money, where it reads the signals and',
  'queues what its nightly reflection should look at. Wake for: a routine that started failing or went missing, a new',
  'correction (a feedback memory or draft), a new or changed open flag, a new alert in the inbox, a new or changed proposal,',
  'new commits in a tracked repo that may need attention, or candidates that are not queued yet. Do not wake for: a routine',
  'that recovered, churn with nothing to act on, or candidates that are all queued already.',
  'Answer with JSON only: {"wake": true or false, "reason": "<one short line, under 120 characters>"}.',
].join(' ');

function defaultDeps(root) {
  const vault = root || require('../lib/paths.js').PATHS.VAULT;
  let config = () => ({});
  try { ({ loadConfig: config } = require('../lib/config.js')); } catch { /* no config module: defaults */ }
  return { vault, config, now: () => new Date() };
}

function files(deps) {
  const v = deps.vault;
  return {
    state: path.join(v, 'brain', '_index', 'persona-tick.json'),
    heartbeat: path.join(v, 'brain', '_index', 'persona-heartbeat.json'),
    queue: path.join(v, 'persona', 'queue.jsonl'),
    ledger: path.join(v, 'persona', 'ledger.jsonl'),
    stateMd: path.join(v, 'persona', 'STATE.md'),
    repos: path.join(v, 'persona', 'repos.json'),
    journal: path.join(v, 'persona', 'journal'),
    routines: path.join(v, 'brain', '_index', 'routines.json'),
    routinesDir: path.join(v, 'brain', 'routines'),
    feedback: path.join(v, 'brain', 'memory', 'feedback'),
    drafts: path.join(v, 'brain', 'memory', 'feedback', '_drafts'),
    proposals: path.join(v, 'persona', 'proposals'),
  };
}

function readJson(file, what) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    console.error(`[tick] ${file} is not a JSON object — treating ${what} as empty`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[tick] ${file} unreadable: ${e.message} — treating ${what} as empty`);
  }
  return null;
}
function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') out.push(r); else bad++; } catch { bad++; }
  }
  if (bad) console.error(`[tick] ${file}: skipped ${bad} unreadable line(s)`);
  return out;
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readState(deps) {
  const s = readJson(files(deps).state, 'the tick state');
  return s && s.schema === SCHEMA ? s : { schema: SCHEMA, lastBeatAt: null, lastSignature: null, lastPrecheckAt: null, pending: null, beats: 0, skipped: 0, lastEarlyReflectAt: null };
}
function writeState(deps, s) { writeAtomic(files(deps).state, JSON.stringify(s, null, 2) + '\n'); }

function mtime(file) { try { return Math.round(fs.statSync(file).mtimeMs); } catch { return null; } }
/** persona/repos.json — the sitrep's shape: { stall_threshold_days?, repos?: [{ name, path }] }. */
function loadRepos(deps) {
  const cfg = readJson(files(deps).repos, 'the repo list') || {};
  const repos = Array.isArray(cfg.repos) ? cfg.repos.filter(r => r && typeof r.name === 'string' && typeof r.path === 'string') : [];
  const threshold = Number.isFinite(cfg.stall_threshold_days) && cfg.stall_threshold_days > 0 ? cfg.stall_threshold_days : DEFAULT_STALL_DAYS;
  return { threshold, repos };
}

function realpath(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
/** A repo's git dir: .git itself, or the one a worktree's .git file points at. */
function gitDir(repo) {
  const dotgit = path.join(repo, '.git');
  try { if (fs.statSync(dotgit).isDirectory()) return dotgit; } catch { return null; }
  const m = /^gitdir:\s*(.+)$/m.exec(readText(dotgit) || '');
  return m ? path.resolve(repo, m[1].trim()) : null;
}
/** `<ref>@<sha>` (or a detached sha) from the repo's files — no git process. null when it is not a repo. */
function repoHead(repo) {
  const dir = gitDir(repo);
  if (!dir) return null;
  const head = (readText(path.join(dir, 'HEAD')) || '').trim();
  if (!head) return null;
  const m = /^ref:\s*(.+)$/.exec(head);
  if (!m) return head.slice(0, 40);
  const ref = m[1].trim();
  const common = (() => { const c = (readText(path.join(dir, 'commondir')) || '').trim(); return c ? path.resolve(dir, c) : dir; })();
  for (const d of [dir, common]) { const sha = (readText(path.join(d, ref)) || '').trim(); if (sha) return `${ref}@${sha}`; }
  const packed = (readText(path.join(common, 'packed-refs')) || '').split('\n').find((l) => l.endsWith(` ${ref}`));
  return packed ? `${ref}@${packed.split(' ')[0]}` : `${ref}@?`;
}
/** Tracked repos' HEADs, the vault's own repo left out (its commits are the backups): { repos, vaultTracked }. */
function repoHeads(deps) {
  const vault = realpath(deps.vault);
  const repos = {};
  let vaultTracked = false;
  for (const r of loadRepos(deps).repos) {
    if (realpath(r.path) === vault) { vaultTracked = true; continue; }
    repos[r.name] = repoHead(r.path);
  }
  return { repos, vaultTracked };
}

/** `rel:mtime` for each *.md under dir (recursive when asked; dot entries skipped), sorted. */
function listing(deps, dir, { recursive = false } = {}) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive) walk(f); continue; }
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.toLowerCase() === 'readme.md') continue;
      out.push(`${rel(deps, f)}:${mtime(f)}`);
    }
  };
  walk(dir);
  return out.sort();
}
/** { n, h }: how many entries, and a short hash of them (sorted, deduped). */
function digest(list) {
  const items = [...new Set(list)].sort();
  return { n: items.length, h: require('crypto').createHash('sha1').update(items.join('\n')).digest('hex').slice(0, 12) };
}
/** The open `- [ ]` lines under ## Flags (the watchdog's, run-duty.sh's and the user's), trimmed. */
function openFlags(deps) {
  const text = readText(files(deps).stateMd) || '';
  const sec = text.split(/^## Flags\s*$/m)[1];
  return sec ? sec.split(/^## /m)[0].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- [ ]')) : [];
}
/** Unread, unarchived notifications at an alert level (lib/notifications.js), by id. */
function inboxIds(deps) {
  try {
    return require('../lib/notifications.js').list(deps.vault, { unread: true }).items.filter((i) => ALERTS.includes(i.level)).map((i) => i.id);
  } catch (e) { console.error(`[tick] inbox unreadable: ${e.message}`); return []; }
}
/**
 * Each routine's status, the tick's own left out: invalid | off | failed (its last exit, the duty log included) | missed
 * (the watchdog's beat, 45 minutes' grace, so a long run is never a miss) | ok. Run times never enter.
 */
function routineStatuses(deps) {
  const f = files(deps);
  let rows = [];
  try {
    rows = require('../lib/routines-store.js').overview({ dir: f.routinesDir, file: f.routines, logDir: path.join(deps.vault, 'persona', 'journal', 'logs'), now: deps.now() });
  } catch (e) { console.error(`[tick] routines unreadable: ${e.message}`); }
  const hb = readJson(f.heartbeat, 'the heartbeat');
  const beats = hb && hb.beats && typeof hb.beats === 'object' ? hb.beats : {};
  const out = {};
  for (const r of rows) {
    if (r.slug === SELF) continue;
    const beat = beats[r.slug] || {};
    out[r.slug] = r.errors && r.errors.length ? 'invalid'
      : !r.enabled ? 'off'
        : r.last && typeof r.last.exit === 'number' && r.last.exit !== 0 ? 'failed'
          : beat.status === 'missed' ? 'missed' : 'ok';
  }
  return out;
}

/** The change signature (see the header). Pure apart from reads. */
function signature(deps) {
  const f = files(deps);
  const { repos, vaultTracked } = repoHeads(deps);
  return {
    v: SIG_VERSION,
    routines: routineStatuses(deps),
    repos,
    corrections: digest([...listing(deps, f.feedback), ...listing(deps, f.drafts)]),
    memory: vaultTracked ? digest(listing(deps, path.join(deps.vault, 'brain', 'memory'), { recursive: true })) : null,
    proposals: digest(listing(deps, f.proposals)),
    flags: digest(openFlags(deps)),
    inbox: digest(inboxIds(deps)),
  };
}
const sameDigest = (a, b) => (a && a.h) === (b && b.h) && (a && a.n) === (b && b.n);
/** The keys that differ between two signatures: `routines.<slug>`, `repos.<name>`, then the content keys. */
function diff(prev, cur) {
  if (!prev || prev.v !== SIG_VERSION) return ['first-run'];
  const out = [];
  for (const group of ['routines', 'repos']) {
    const a = prev[group] || {}, b = cur[group] || {};
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) if (a[k] !== b[k]) out.push(`${group}.${k}`);
  }
  for (const k of CONTENT_KEYS) if (!sameDigest(prev[k], cur[k])) out.push(k);
  return out;
}
/** diff() keys as words for the journal and the local model: "routine sitrep: ok → failed", "open flags: 3 (was 2)". */
function describe(prev, cur, keys) {
  const was = (o, k) => (o && o[k] ? o[k].n : 0);
  const words = { corrections: 'corrections', memory: 'memory files', proposals: 'proposals', flags: 'open flags', inbox: 'unread alerts' };
  return keys.map((k) => {
    if (k === 'first-run') return 'first triage';
    const [group, name] = k.split(/\.(.*)/s);
    if (group === 'routines') {
      const a = prev && prev.routines && prev.routines[name], b = cur.routines[name];
      return !a ? `new routine ${name} (${b})` : !b ? `routine ${name} removed` : `routine ${name}: ${a} → ${b}`;
    }
    if (group === 'repos') {
      const a = prev && prev.repos && prev.repos[name], b = cur.repos[name];
      const branch = (x) => String(x || '').split('@')[0];
      return !a ? `repo ${name} tracked` : !b ? `repo ${name} unreadable` : branch(a) !== branch(b) ? `repo ${name}: switched to ${branch(b).replace(/^refs\/heads\//, '')}` : `repo ${name}: new commits`;
    }
    return `${words[k]}: ${cur[k] ? cur[k].n : 0} (was ${was(prev, k)})`;
  });
}

/** The confirmation pass (D2) — a broken recipe or a missing script never stops the tick. */
function recordConfirmations(deps, now) {
  try {
    const recheck = deps.recheck || require('./recheck.js');
    return recheck.record({ root: deps.vault, now });
  } catch (e) {
    console.error(`[tick] confirmations not recorded: ${e.message}`);
    return { recorded: false, error: e.message };
  }
}

/** Runner verb. Records the confirmations, then the pending signature; `changed: false` means the runner skips the model call. */
function precheck({ deps = defaultDeps(), now = deps.now() } = {}) {
  const confirmations = recordConfirmations(deps, now);
  const s = readState(deps);
  const sig = signature(deps);
  const changes = diff(s.lastSignature, sig);
  const changed = changes.length > 0;
  s.lastPrecheckAt = now.toISOString();
  s.pending = changed ? { at: s.lastPrecheckAt, signature: sig, changes } : null;
  if (!changed) s.skipped = (s.skipped || 0) + 1;
  writeState(deps, s);
  return { changed, changes, since: s.lastBeatAt, confirmations };
}

/** Runner verb. Promotes the pending signature (the tick's own writes are in none of its keys); then the early-reflect check. */
function beat({ deps = defaultDeps(), now = deps.now() } = {}) {
  const s = readState(deps);
  const base = s.pending && s.pending.signature ? s.pending.signature : signature(deps);
  s.lastSignature = base;
  s.lastBeatAt = now.toISOString();
  s.beats = (s.beats || 0) + 1;
  s.pending = null;
  const earlyReflect = startEarlyReflect({ deps, now, state: s });
  writeState(deps, s);
  return { lastBeatAt: s.lastBeatAt, beats: s.beats, earlyReflect };
}

// ── triage (local-first A5) ─────────────────────────────────────────────────────────────────────────────────────────

/** The local model's reply → { wake, reason }, or null when it is not a decision (then any real change wakes). */
function parseDecision(text) {
  const t = String(text == null ? '' : text).trim();
  let o = null;
  try { o = JSON.parse(t); } catch {
    const m = /\{[\s\S]*\}/.exec(t);
    if (m) { try { o = JSON.parse(m[0]); } catch { o = null; } }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  let wake = o.wake;
  if (typeof wake === 'string') wake = /^(true|yes)$/i.test(wake.trim()) ? true : /^(false|no)$/i.test(wake.trim()) ? false : null;
  if (typeof wake !== 'boolean') return null;
  const said = typeof o.reason === 'string' ? o.reason.replace(/[\r\n#`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return { wake, reason: said || (wake ? 'the local model says it merits a run' : 'the local model says it can wait') };
}

/**
 * Asks the local model whether `context` merits a Chief of Staff run → { wake, reason, by: 'local' | 'rules', model }.
 * Only the local engine answers (provider.js's background provider when its name is `ollama`, whichever server); a hosted
 * provider, none (local-down, local-model-missing, provider none), an error or a non-decision → wake, by the rules.
 */
async function decide(context, deps) {
  const rules = (why) => ({ wake: true, reason: `${why}: any real change wakes the Chief of Staff`, by: 'rules', model: null });
  let p = null;
  try { p = await (deps.provider ? deps.provider() : require('../sdk/lib/provider.js').getProvider(TRIAGE_FEATURE)); } catch (e) { return rules(`no provider (${String(e.message).slice(0, 80)})`); }
  if (!p || p.name !== 'ollama') return rules(`the local model is unavailable (${!p ? 'no provider' : p.name === 'none' ? p.reason : `background provider ${p.name}`})`);
  let text;
  try {
    text = await p.chat({ system: TRIAGE_SYSTEM, prompt: JSON.stringify(context), format: DECISION_SCHEMA, numPredict: 256, think: false, timeoutMs: 90_000, feature: TRIAGE_FEATURE });
  } catch (e) { return rules(`the local model did not answer (${String(e.message).slice(0, 80)})`); }
  const d = parseDecision(text);
  return d ? { ...d, by: 'local', model: p.model || null } : rules('the local model\'s answer was not a decision');
}

const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** One journal line in persona/journal/<local day>.md: `## HH:MM — tick triage: woke the Chief of Staff — <reason> (…)`. */
function journalTriage(deps, now, d, changes) {
  const shown = changes.slice(0, 4).join(', ') + (changes.length > 4 ? `, +${changes.length - 4} more` : '');
  const who = d.by === 'local' ? `local model${d.model ? ` ${d.model}` : ''}` : 'rules';
  const line = `## ${hhmm(now)} — tick triage: ${d.wake ? 'woke the Chief of Staff' : 'no run'} — ${d.reason} (${who}; changed: ${shown})`;
  const file = path.join(files(deps).journal, `${localDay(now)}.md`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `\n${line}\n`);
  } catch (e) { console.error(`[tick] journal not written: ${e.message}`); }
  return line;
}

function personaOff(deps, cfg) {
  return !!(cfg && cfg.persona && cfg.persona.enabled === false) || fs.existsSync(path.join(deps.vault, 'persona', 'DISABLED'));
}

/** The default duty starter: `sh run-duty.sh tick` beside this script, synchronous, its output passed through. */
function spawnDuty({ cmd, args, env, cwd }) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return typeof r.status === 'number' ? r.status : 1;
}
/**
 * Starts the hosted tick duty the way a scheduled duty starts (routines/run-routine.js plan()): the tick routine file's
 * budgetUsd, tools, writes, model and effort reach run-duty.sh as PERSONA_* — TICK_DUTY's budget and allowlist when the
 * file names none — with PERSONA_TIMEOUT inside the routine's own timeout. Returns the duty's exit code.
 */
function wakeDuty(deps) {
  const f = files(deps);
  let own = null;
  try { own = require('../lib/routines-store.js').read(SELF, { dir: f.routinesDir }); } catch { own = null; }
  if (own && own.errors && own.errors.length) own = null;
  const money = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const duty = {
    slug: SELF, kind: 'duty', enabled: true,
    budgetUsd: own && money(own.budgetUsd) ? own.budgetUsd : TICK_DUTY.budgetUsd,
    tools: own && typeof own.tools === 'string' && own.tools.trim() ? own.tools : TICK_DUTY.tools,
    writes: own && Array.isArray(own.writes) ? own.writes : undefined,
    model: own && typeof own.model === 'string' ? own.model : undefined,
    effort: own && typeof own.effort === 'string' ? own.effort : undefined,
  };
  const node = deps.node || process.execPath;
  const base = { ...(deps.env || process.env), AOS_VAULT: deps.vault };
  if (!base.AOS_NODE) base.AOS_NODE = node;
  const routineSec = own && Number.isInteger(own.timeoutSec) && own.timeoutSec > 0 ? own.timeoutSec : TICK_DUTY.timeoutSec;
  if (!base.PERSONA_TIMEOUT) base.PERSONA_TIMEOUT = String(Math.max(60, routineSec - 120));
  const p = require('../routines/run-routine.js').plan(duty, {}, { vault: deps.vault, env: base, node });
  const args = [path.join(__dirname, 'run-duty.sh'), SELF];
  return (deps.spawnDuty || spawnDuty)({ cmd: p.cmd, args, env: p.env, cwd: deps.vault });
}

/**
 * The hourly triage (header). → { action: 'off' | 'unchanged' | 'stay' | 'woke', changes, decision, exit, line }.
 * `unchanged` makes no model call of any kind.
 */
async function triage({ deps = defaultDeps(), now = deps.now() } = {}) {
  const cfg = deps.config() || {};
  if (personaOff(deps, cfg)) return { action: 'off', changes: [], exit: 0 };
  const confirmations = recordConfirmations(deps, now);
  const s = readState(deps);
  const sig = signature(deps);
  const seen = s.lastTriage && s.lastTriage.signature ? s.lastTriage.signature : null;
  const sinceBeat = diff(s.lastSignature, sig);
  const fresh = seen ? diff(seen, sig) : sinceBeat;
  s.lastPrecheckAt = now.toISOString();
  if (!fresh.length || !sinceBeat.length) {
    // Nothing new since the last look, or back to what the Chief of Staff last saw: no call, no journal line.
    s.skipped = (s.skipped || 0) + 1;
    if (fresh.length) s.lastTriage = { ...(s.lastTriage || {}), signature: sig, at: s.lastPrecheckAt, wake: false, reason: 'back to the last run\'s state', by: 'rules', changes: [] };
    writeState(deps, s);
    return { action: 'unchanged', changes: [], exit: 0, confirmations };
  }
  const changes = describe(seen || s.lastSignature, sig, fresh);
  const candidates = (() => { try { return signals({ deps, now }).candidates; } catch { return []; } })()
    .filter((c) => !c.queued).slice(0, 20).map((c) => ({ type: c.type, title: c.title }));
  const context = { changed: changes, sinceLastRun: describe(s.lastSignature, sig, sinceBeat), candidates, lastRun: s.lastBeatAt || null };
  const decision = await decide(context, deps);
  s.lastTriage = { at: now.toISOString(), signature: sig, wake: decision.wake, reason: decision.reason, by: decision.by, changes: fresh };
  s.triages = (s.triages || 0) + 1;
  if (decision.by === 'local') s.localCalls = (s.localCalls || 0) + 1;
  if (decision.wake) s.wakes = (s.wakes || 0) + 1;
  writeState(deps, s);
  const line = journalTriage(deps, now, decision, changes);
  if (!decision.wake) return { action: 'stay', changes, decision, exit: 0, line };
  const exit = wakeDuty(deps);
  return { action: 'woke', changes, decision, exit, line };
}

function earlyThresholds(cfg) {
  const e = (cfg && cfg.persona && cfg.persona.tick && cfg.persona.tick.earlyReflect) || {};
  const pick = (k) => (Number.isFinite(e[k]) && e[k] > 0 ? e[k] : DEFAULT_EARLY_REFLECT[k]);
  return { corrections: pick('corrections'), dutyFailures: pick('dutyFailures') };
}
/**
 * Pure: should the queue wake the daily reflect now? `entries` are the queue lines, `routinesState` is
 * brain/_index/routines.json (or null). A queued duty failure counts as that duty's fail streak, so one duty failing
 * twice in a row and two duties failing once both reach the default of 2.
 */
function shouldReflectEarly(entries, routinesState, thresholds = DEFAULT_EARLY_REFLECT) {
  const rows = (routinesState && routinesState.routines && typeof routinesState.routines === 'object') ? routinesState.routines : {};
  let corrections = 0, failures = 0;
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'correction') corrections++;
    else if (e.type === 'duty-failure') {
      const slug = String(e.source || '').split('#')[1] || '';
      failures += Math.max(1, Number(rows[slug] && rows[slug].failStreak) || 0);
    }
  }
  if (corrections >= thresholds.corrections) return { trigger: true, reason: `${corrections} corrections queued (threshold ${thresholds.corrections})`, corrections, failures };
  if (failures >= thresholds.dutyFailures) return { trigger: true, reason: `duty failures weigh ${failures} (threshold ${thresholds.dutyFailures})`, corrections, failures };
  return { trigger: false, reason: null, corrections, failures };
}
const pad2 = (n) => String(n).padStart(2, '0');
function localDay(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/** The default starter: run-routine.js next to this script (checkout and vendored copy alike), detached, output ignored. */
function spawnDetached(argv, cwd) {
  const { spawn } = require('child_process');
  const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  return child.pid;
}
/** The D7 decision plus its guards; mutates `state.lastEarlyReflectAt` when it starts a run. Never throws. */
function startEarlyReflect({ deps, now, state }) {
  const f = files(deps);
  try {
    const decision = shouldReflectEarly(readJsonl(f.queue), readJson(f.routines, 'the routine state'), earlyThresholds(deps.config() || {}));
    if (!decision.trigger) return { started: false, reason: 'below threshold', corrections: decision.corrections, failures: decision.failures };
    if (state.lastEarlyReflectAt && localDay(new Date(state.lastEarlyReflectAt)) === localDay(now)) return { started: false, reason: `already started today (${state.lastEarlyReflectAt})`, why: decision.reason };
    const routine = require('../lib/routines-store.js').read(REFLECT_DAILY, { dir: f.routinesDir });
    if (!routine || routine.errors.length) return { started: false, reason: `no valid brain/routines/${REFLECT_DAILY}.md`, why: decision.reason };
    if (!routine.enabled) return { started: false, reason: `${REFLECT_DAILY} is disabled`, why: decision.reason };
    const argv = [deps.node || process.execPath, path.join(__dirname, '..', 'routines', 'run-routine.js'), REFLECT_DAILY, '--early'];
    const pid = (deps.spawnReflect || spawnDetached)(argv, deps.vault);
    state.lastEarlyReflectAt = now.toISOString();
    return { started: true, reason: decision.reason, pid: pid || null, argv };
  } catch (e) {
    console.error(`[tick] early reflect check failed: ${e.message}`);
    return { started: false, reason: `error: ${e.message}` };
  }
}

function listMd(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name).sort(); } catch { return []; }
}
function firstHeading(file) {
  try { const m = /^#\s+(.+)$/m.exec(fs.readFileSync(file, 'utf8')); return m ? m[1].trim().slice(0, 120) : null; } catch { return null; }
}
function rel(deps, file) { return path.relative(deps.vault, file).split(path.sep).join('/'); }

/** Model verb. Candidates since the last beat (the last 24 h on a first run), each flagged when already queued. */
function signals({ deps = defaultDeps(), now = deps.now() } = {}) {
  const s = readState(deps);
  const f = files(deps);
  const cfg = deps.config() || {};
  const tcfg = (cfg.persona && cfg.persona.tick) || {};
  const flagAgeDays = Number.isFinite(tcfg.flagAgeDays) && tcfg.flagAgeDays > 0 ? tcfg.flagAgeDays : DEFAULT_FLAG_AGE_DAYS;
  const sinceMs = Date.parse(s.lastBeatAt);
  const since = Number.isFinite(sinceMs) ? sinceMs : now.getTime() - FIRST_RUN_WINDOW_MS;
  const out = [];

  for (const dir of [f.drafts, f.feedback]) {
    for (const name of listMd(dir)) {
      const file = path.join(dir, name);
      const t = mtime(file);
      if (t === null || t <= since) continue;
      out.push({ type: 'correction', source: rel(deps, file), title: firstHeading(file) || name, at: new Date(t).toISOString() });
    }
  }

  const hb = readJson(f.heartbeat, 'the heartbeat');
  for (const [slug, b] of Object.entries((hb && hb.beats) || {})) {
    if (!b || (b.status !== 'failed' && b.status !== 'missed')) continue;
    const at = Date.parse(b.status === 'missed' ? b.due : b.lastRunAt);
    if (Number.isFinite(at) && at <= since) continue;
    out.push({ type: 'duty-failure', source: `${rel(deps, f.heartbeat)}#${slug}`, title: `duty '${slug}' ${b.status}`, at: Number.isFinite(at) ? new Date(at).toISOString() : null });
  }

  // The sitrep's stall rule (sitrep-state.js detectPlanning): idle .planning/STATE.md past the threshold. A stall is a
  // standing condition, not an event, so it is not filtered by `since`; the queue's dedupe keeps it to one entry.
  const { threshold, repos } = loadRepos(deps);
  for (const r of repos) {
    const stateFile = path.join(r.path, '.planning', 'STATE.md');
    const t = mtime(stateFile);
    if (t === null) continue;
    const idleDays = (now.getTime() - t) / DAY_MS;
    if (idleDays <= threshold) continue;
    out.push({ type: 'repo-stall', source: `${r.name}:.planning/STATE.md`, title: `${r.name} planning idle ${Math.round(idleDays * 10) / 10}d`, at: new Date(t).toISOString() });
  }

  for (const e of readJsonl(f.ledger)) {
    if (e.event !== 'regressed' || typeof e.slug !== 'string') continue;
    const at = Date.parse(e.ts);
    if (Number.isFinite(at) && at <= since) continue;
    out.push({ type: 'regressed', source: `${rel(deps, f.ledger)}#${e.slug}`, title: `approved proposal '${e.slug}' regressed`, at: e.ts || null });
  }

  let stateMd = '';
  try { stateMd = fs.readFileSync(f.stateMd, 'utf8'); } catch { /* no STATE.md */ }
  const sec = stateMd.split(/^## Flags\s*$/m)[1];
  for (const line of sec ? sec.split(/^## /m)[0].split('\n') : []) {
    const m = FLAG_RE.exec(line.trim());
    if (!m) continue;
    const opened = Date.parse(`${m[1]}T00:00:00`);
    if (!Number.isFinite(opened)) continue;
    const ageDays = Math.floor((now.getTime() - opened) / DAY_MS);
    if (ageDays < flagAgeDays) continue;
    out.push({ type: 'flag-aged', source: `${rel(deps, f.stateMd)}#${m[2].slice(0, 80)}`, title: `flag open ${ageDays}d: ${m[2].slice(0, 80)}`, at: new Date(opened).toISOString() });
  }

  const queued = new Set(readJsonl(f.queue).map(q => `${q.type}\u0000${q.source}`));
  for (const c of out) c.queued = queued.has(`${c.type}\u0000${c.source}`);
  return { since: new Date(since).toISOString(), flagAgeDays, stallDays: threshold, candidates: out };
}

/** Model verb. Appends one queue line unless the same (type, source) is already there. Throws on a bad call. */
function queue({ type, source, note, deps = defaultDeps(), now = deps.now() } = {}) {
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
  if (typeof source !== 'string' || !source.trim()) throw new Error('--source <pointer> is required');
  const f = files(deps);
  const existing = readJsonl(f.queue).find(q => q.type === type && q.source === source);
  if (existing) return { duplicate: true, record: existing };
  const record = { schema: SCHEMA, ts: now.toISOString(), type, source, note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : null, by: 'tick' };
  fs.mkdirSync(path.dirname(f.queue), { recursive: true });
  fs.appendFileSync(f.queue, JSON.stringify(record) + '\n');
  return { duplicate: false, record };
}

const VALUE_FLAGS = ['--root', '--source', '--note'];
/** argv minus flags and their values, in order (the interview.js pattern): `queue correction --source x` → ['queue', 'correction']. */
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.includes(argv[i])) { i++; continue; }
    if (String(argv[i]).startsWith('--')) continue;
    out.push(argv[i]);
  }
  return out;
}

function main(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };
  const [verb, type] = positionals(argv);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  try { assertPinned({ root: arg('--root') }); } catch (e) { process.stderr.write(`tick: ${e.message}\n`); return 2; }
  let deps;
  try { deps = defaultDeps(arg('--root')); } catch (e) { process.stderr.write(`tick: ${e.message}\n`); return 0; }
  try {
    switch (verb) {
      case 'precheck': { const r = precheck({ deps }); out(r); return r.changed ? 0 : EXIT_UNCHANGED; }
      case 'beat': out(beat({ deps })); return 0;
      case 'signals': process.stdout.write(JSON.stringify(signals({ deps }), null, 2) + '\n'); return 0;
      case 'status': out(readState(deps)); return 0;
      case 'queue': {
        try { out(queue({ type, source: arg('--source'), note: arg('--note'), deps })); return 0; } catch (e) { process.stderr.write(`tick queue: ${e.message}\n`); return 2; }
      }
      default:
        process.stderr.write('usage: tick.js --triage|precheck|beat|signals|status|queue <type> --source <pointer> [--note <text>] [--root <vault>]\n');
        return 2;
    }
  } catch (e) {
    process.stderr.write(`tick ${verb}: ${e.message}\n`);
    return 0;
  }
}

const isTriage = (argv) => argv.includes('--triage') || positionals(argv)[0] === 'triage';
/** `tick.js --triage [--root <vault>]` (the hourly routine): one JSON line, the woken duty's exit code or 0. */
async function mainTriage(argv, { env = process.env, deps: injected = null } = {}) {
  const i = argv.indexOf('--root');
  const root = i !== -1 ? argv[i + 1] : null;
  // A duty's allowlist names tick.js, so a model inside the tick duty could call this: a duty never starts another one.
  if (env.AOS_HEADLESS === '1') { process.stderr.write('tick: --triage runs from the hourly routine, never inside a duty\n'); return 2; }
  let deps;
  try { deps = injected || defaultDeps(root); } catch (e) { process.stderr.write(`tick: ${e.message}\n`); return 1; }
  try {
    const r = await triage({ deps });
    process.stdout.write(JSON.stringify({ action: r.action, changes: r.changes, decision: r.decision || null, exit: r.exit }) + '\n');
    return r.exit;
  } catch (e) {
    process.stderr.write(`tick triage: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (isTriage(argv)) mainTriage(argv).then((code) => process.exit(code), (e) => { process.stderr.write(`tick: ${e.message}\n`); process.exit(1); });
  else process.exit(main(argv));
}
module.exports = { SCHEMA, TYPES, EXIT_UNCHANGED, DEFAULT_FLAG_AGE_DAYS, DEFAULT_EARLY_REFLECT, SIG_VERSION, TICK_DUTY, DECISION_SCHEMA, TRIAGE_FEATURE, signature, diff, describe, repoHead, precheck, recordConfirmations, beat, signals, queue, triage, decide, parseDecision, wakeDuty, mainTriage, shouldReflectEarly, earlyThresholds, startEarlyReflect, readState, positionals, main };
