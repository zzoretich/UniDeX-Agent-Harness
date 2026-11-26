'use strict';
/**
 * host-catalog.js — what each agent CLI says it can run: its models, with the effort levels each takes, and the
 * commands a prompt may start with (spec 2026-10-07-sessions-ux U3–U5, U8). The app's Code composer and Routines build
 * their model menus and the `/` menu from this, so no model list is kept by hand. Nothing here calls a model:
 *
 *   claude: one `initialize` control request to `claude -p --input-format stream-json --output-format stream-json`
 *           (the path the Agent SDK's supportedModels() and supportedCommands() take); the process is ended as soon as
 *           it answers. Its aliases (default, opus, sonnet, …) are the current models; full ids are the older ones.
 *   codex:  `codex debug models` (models with visibility "list", by priority; the first three are current), the default
 *           model and effort from <codex home>/config.toml, and the skills `codex debug prompt-input` lists (Codex runs
 *           a skill named `$name` in a prompt).
 * Only models and commands are kept: the initialize answer also names the account, and that is never read out of it.
 * A host that does not answer keeps working on its aliases (FALLBACK) with `ok: false` and the reason (U4).
 *
 *   fetchCatalog({ cfg, env, hosts, cwd, run, spawnFn, timeoutMs, now })  →  { schema, fetchedAt, hosts: { <host>: entry } }
 *     entry: { ok, reason?, version, fetchedAt, defaultModel, defaultEffort, models: [{ id, name, description, efforts,
 *     main }], commands: [{ name, insert, description, hint }] }. A host that is off (off: true) or has no binary gets
 *     ok:false and no process at all.
 *   claudeEntry(answer, version) / codexEntry(modelsJson, promptInput, defaults, version)  — the parsers (tests)
 *   loadCatalog(file) / saveCatalog(file, cat) / isFresh(cat, now)  — the cache, brain/_index/host-catalog.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./headless.js');
const { codexHome } = require('./host.js');

const SCHEMA = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20000;
const DESC_MAX = 200;
/** How many of Codex's listed models are current; the rest fold under "Older models". */
const CODEX_CURRENT = 3;

/** The levels each host's CLI takes for a session turn. */
const EFFORTS = H.SESSION_EFFORTS;

/** A host's models when it does not answer: Claude's aliases always resolve; Codex falls back to its own default. */
const FALLBACK = {
  claude: [
    { id: 'default', name: 'Default', description: "Claude Code's default model", efforts: EFFORTS.claude, main: true },
    { id: 'opus', name: 'Opus', description: 'The latest Opus', efforts: EFFORTS.claude, main: true },
    { id: 'fable', name: 'Fable', description: 'The latest Fable', efforts: EFFORTS.claude, main: true },
    { id: 'sonnet', name: 'Sonnet', description: 'The latest Sonnet', efforts: EFFORTS.claude, main: true },
    { id: 'haiku', name: 'Haiku', description: 'The latest Haiku', efforts: EFFORTS.claude, main: true },
  ],
  codex: [],
};

const str = (v) => (typeof v === 'string' ? v : '');
const clip = (v) => { const s = str(v).replace(/\s+/g, ' ').trim(); return s.length > DESC_MAX ? `${s.slice(0, DESC_MAX - 1)}…` : s; };
const levels = (list, host) => (Array.isArray(list) ? list.map((l) => (l && typeof l === 'object' ? l.effort : l)).filter((l) => EFFORTS[host].includes(l)) : []);

function emptyEntry(host, reason, { version = null, now = new Date(), defaults = {} } = {}) {
  const models = host === 'codex' && defaults.model
    ? [{ id: defaults.model, name: defaults.model, description: 'Your Codex default', efforts: EFFORTS.codex, main: true }]
    : FALLBACK[host].map((m) => ({ ...m, efforts: [...m.efforts] }));
  return {
    ok: false, reason, version, fetchedAt: now.toISOString(), defaultModel: host === 'codex' ? defaults.model || null : null,
    defaultEffort: host === 'codex' ? defaults.effort || null : null, models, commands: [],
  };
}

/** A Claude `initialize` control response (the whole line, or its inner response) → an entry. */
function claudeEntry(answer, version = null, now = new Date()) {
  const r = answer && answer.response && answer.response.response ? answer.response.response : answer;
  const raw = r && Array.isArray(r.models) ? r.models : null;
  if (!raw || !raw.length) return emptyEntry('claude', 'Claude Code listed no models', { version, now });
  const models = [];
  for (const m of raw) {
    const id = str(m && m.value).trim();
    if (!id || id.startsWith('-') || models.some((x) => x.id === id)) continue;
    models.push({ id, name: clip(m.displayName) || id, description: clip(m.description), efforts: levels(m.supportedEffortLevels, 'claude'), main: !/^claude-/.test(id) });
  }
  const commands = [];
  for (const c of Array.isArray(r.commands) ? r.commands : []) {
    const name = str(c && c.name).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]*$/.test(name) || commands.some((x) => x.name === name)) continue;
    commands.push({ name, insert: `/${name} `, description: clip(c.description), hint: clip(c.argumentHint) || null });
  }
  return { ok: true, version, fetchedAt: now.toISOString(), defaultModel: null, defaultEffort: null, models, commands };
}

/** `[...]` top-level `key = "value"` lines of a config.toml (before its first table). */
function topLevelToml(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The user's Codex default model and effort, from <home>/config.toml; nulls when unreadable. */
function codexDefaults(home) {
  let text = '';
  try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return { model: null, effort: null }; }
  const t = topLevelToml(text);
  return { model: t.model || null, effort: EFFORTS.codex.includes(t.model_reasoning_effort) ? t.model_reasoning_effort : null };
}

/** The skills block of `codex debug prompt-input` → commands. Paths are never kept. */
function codexSkills(promptInput) {
  const texts = [];
  const walk = (v) => { if (typeof v === 'string') texts.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(promptInput);
  const out = [];
  for (const t of texts) {
    const at = t.indexOf('### Available skills');
    if (at < 0) continue;
    for (const line of t.slice(at).split('\n').slice(1)) {
      if (/^\s*(#|<\/)/.test(line)) break;
      const m = /^- ([A-Za-z0-9][A-Za-z0-9:_.-]*): (.*?)(?: \(file: [^)]*\))?\s*$/.exec(line);
      if (m && !out.some((x) => x.name === m[1])) out.push({ name: m[1], insert: `$${m[1]} `, description: clip(m[2]), hint: null });
    }
  }
  return out;
}

/** `codex debug models` JSON, prompt-input JSON (or null) and the config defaults → an entry. */
function codexEntry(modelsJson, promptInput, defaults = {}, version = null, now = new Date()) {
  const raw = modelsJson && Array.isArray(modelsJson.models) ? modelsJson.models : null;
  if (!raw) return emptyEntry('codex', 'Codex listed no models', { version, now, defaults });
  const listed = raw.filter((m) => m && m.visibility === 'list' && str(m.slug) && !str(m.slug).startsWith('-'))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
  if (!listed.length) return emptyEntry('codex', 'Codex listed no models', { version, now, defaults });
  const models = listed.map((m, i) => ({
    id: m.slug, name: clip(m.display_name) || m.slug, description: clip(m.description).replace(/\.$/, ''),
    efforts: levels(m.supported_reasoning_levels, 'codex'), main: i < CODEX_CURRENT,
  }));
  return {
    ok: true, version, fetchedAt: now.toISOString(), defaultModel: defaults.model || null, defaultEffort: defaults.effort || null,
    models, commands: promptInput ? codexSkills(promptInput) : [],
  };
}

/** Runs `bin args` to its end, or kills it at the limit: { code, stdout, stderr, timedOut }. */
function runToEnd(spawnFn, bin, args, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnFn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: null, stdout: '', stderr: String(e.message || e), timedOut: false }); }
    let stdout = '', stderr = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ code: null, stdout, stderr, timedOut: true }); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => finish({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut: false }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

/** Sends one initialize request and resolves with its answer (or null) as soon as it arrives, then ends the process. */
function claudeInitialize(spawnFn, bin, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
    try { child = spawnFn(bin, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ answer: null, reason: String(e.message || e) }); }
    let buf = '', stderr = '', done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ answer: null, reason: `Claude Code did not answer in ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    child.stdout.on('data', (c) => {
      buf += c;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j && j.type === 'control_response' && j.response && j.response.request_id === 'catalog') {
          finish(j.response.subtype === 'success' ? { answer: j, reason: null } : { answer: null, reason: str(j.response.error) || 'Claude Code refused the request' });
        }
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => finish({ answer: null, reason: e.message }));
    child.on('close', (code) => finish({ answer: null, reason: `Claude Code exited (${code})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}` }));
    if (child.stdin) {
      child.stdin.on('error', () => { /* it may exit first; close decides */ });
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } })}\n`);
    }
  });
}

const versionOf = (out) => { const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(String(out || '')); return m ? m[1] : null; };
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function fetchClaude(bin, o) {
  const [init, ver] = await Promise.all([claudeInitialize(o.spawnFn, bin, o), runToEnd(o.spawnFn, bin, ['--version'], { ...o, timeoutMs: Math.min(o.timeoutMs, 10000) })]);
  const version = versionOf(ver.stdout);
  return init.answer ? claudeEntry(init.answer, version, o.now) : emptyEntry('claude', init.reason, { version, now: o.now });
}

async function fetchCodex(bin, o) {
  const defaults = codexDefaults(o.codexHome);
  const [models, prompt, ver] = await Promise.all([
    runToEnd(o.spawnFn, bin, ['debug', 'models'], o),
    runToEnd(o.spawnFn, bin, ['debug', 'prompt-input'], o),
    runToEnd(o.spawnFn, bin, ['--version'], { ...o, timeoutMs: Math.min(o.timeoutMs, 10000) }),
  ]);
  const version = versionOf(ver.stdout);
  const list = models.code === 0 ? parseJson(models.stdout) : null;
  if (!list) {
    const why = models.timedOut ? `codex debug models did not answer in ${Math.round(o.timeoutMs / 1000)} s` : `codex debug models failed${models.stderr.trim() ? `: ${models.stderr.trim().split('\n').pop()}` : ''}`;
    return emptyEntry('codex', why, { version, now: o.now, defaults });
  }
  return codexEntry(list, prompt.code === 0 ? parseJson(prompt.stdout) : null, defaults, version, o.now);
}

/** See the module comment. `run` replaces the per-host fetch (tests). */
async function fetchCatalog({ cfg = {}, env = process.env, hosts = H.HOSTS, cwd = os.homedir(), spawnFn = spawn, timeoutMs = TIMEOUT_MS, now = new Date(), lookup, candidates, run } = {}) {
  const home = H.codexHomeOf(cfg) || codexHome(env);
  const out = { schema: SCHEMA, fetchedAt: now.toISOString(), hosts: {} };
  await Promise.all(hosts.filter((h) => H.HOSTS.includes(h)).map(async (h) => {
    const label = h === 'codex' ? 'Codex' : 'Claude Code';
    if (!H.hostEnabled(cfg, h)) { out.hosts[h] = { ...emptyEntry(h, `${label} is off on this machine`, { now, defaults: h === 'codex' ? codexDefaults(home) : {} }), off: true }; return; }
    const bin = H.resolveBin(h, { cfg, env, lookup, candidates });
    if (!bin) { out.hosts[h] = emptyEntry(h, `no ${h} binary found`, { now, defaults: h === 'codex' ? codexDefaults(home) : {} }); return; }
    const o = { spawnFn, env: H.headlessEnv(env, { codexHome: H.codexHomeOf(cfg) }), cwd, timeoutMs, now, codexHome: home };
    try {
      out.hosts[h] = run ? await run(h, bin, o) : h === 'claude' ? await fetchClaude(bin, o) : await fetchCodex(bin, o);
    } catch (e) {
      out.hosts[h] = emptyEntry(h, String((e && e.message) || e), { now });
    }
  }));
  return out;
}

function loadCatalog(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c && c.schema === SCHEMA && c.hosts && typeof c.hosts === 'object' ? c : null;
  } catch { return null; }
}

function saveCatalog(file, cat) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cat)}\n`);
  fs.renameSync(tmp, file);
}

/** Whether a cached catalog still serves: under MAX_AGE_MS, and every wanted host answered or is off (a host that
 *  failed is asked again on the next look). */
function isFresh(cat, now = new Date(), hosts = H.HOSTS) {
  if (!cat || !cat.fetchedAt) return false;
  const age = now.getTime() - Date.parse(cat.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS && hosts.every((h) => cat.hosts[h] && (cat.hosts[h].ok || cat.hosts[h].off === true));
}

module.exports = {
  fetchCatalog, claudeEntry, codexEntry, codexSkills, codexDefaults, topLevelToml, emptyEntry, loadCatalog, saveCatalog, isFresh,
  claudeInitialize, EFFORTS, FALLBACK, SCHEMA, MAX_AGE_MS,
};
