'use strict';
/**
 * connectors/check.js — the live check (connectors-tab D10, D11, D12): which servers and connectors answer, which need
 * signing in, and the tools each server gives. `aos mcp check` runs it when the Connectors tab opens, every
 * connectors.checkEveryMin minutes while it stays open, and on Check now; it has no timer of its own. No model call.
 *
 *   check(opts) → the live cache, written to brain/_index/connectors-live.json:
 *     { schema, checkedAt, durationMs, hosts: { <h>: { enabled, ran, error? } },
 *       rows: [{ host, name, kind, status, detail, tools: [{ name, summary }] | null, toolsError? }] }
 *     status ∈ connected | failed | needs-auth | pending | off | unknown. `detail` and tool summaries are cut to 200
 *     characters; neither holds an entry's env, headers or arguments (the probe never echoes them).
 *
 *   Claude Code  `claude mcp list` (run in the vault), which health-checks every server Claude Code would start,
 *                claude.ai connectors included. Each line is `<name>: <target> - <glyph> <label>`, read by the glyph:
 *                ✔ connected; ! "Needs authentication" needs-auth, any other ! connected with the label as detail
 *                ("tools fetch failed"); ✘ failed, the text after the dash its detail; ⏸ pending; anything else
 *                unknown with the label kept. A claude.ai connector the list names that discovery did not know is
 *                added (discovery carries the names forward).
 *   Codex        `codex mcp list --json`: `enabled`, `disabled_reason` and `auth_status` (not_logged_in → needs-auth).
 *                A server discovery found in a file that Codex does not list is off: "declared, but Codex does not
 *                load it". Codex's connectors are its ChatGPT sign-in: `codex login status`.
 *   Both         Tools, and Codex's status (Codex has no health check), come from the runtime's own MCP client:
 *                `initialize` and `tools/list` on each server its host would start (D11): enabled, approved, a server
 *                (not a connector), and not one the host's own list called failed, pending or needing auth. Claude
 *                Code entries get `${VAR}` / `${VAR:-default}` and `${CLAUDE_PLUGIN_ROOT}` filled in as Claude Code
 *                does; Codex entries their `env_vars`, `bearer_token_env_var` and `env_http_headers` from the
 *                environment. An entry naming a variable that is not set is not started ("needs $VAR"). At most
 *                probeConcurrency at a time, probeTimeoutSec each; one probe per identical entry (a server copied to
 *                both hosts starts once).
 *   One at a time: a check while another runs is refused (Busy), it never waits.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fsx = require('../fsx.js');
const D = require('./discover.js');

const SCHEMA = 1;
const CUT = 200;
const LIST_TIMEOUT_MS = 90 * 1000;
const LOGIN_TIMEOUT_MS = 15 * 1000;
const MAX_TOOL_PAGES = 10;

class Busy extends Error {}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function cut(s, n = CUT) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function liveFile(vault) { return path.join(vault, 'brain', '_index', 'connectors-live.json'); }

// ── the hosts' own lists ─────────────────────────────────────────────────────

/** `claude mcp list` → Map name → { status, detail }. */
function parseClaudeList(text) {
  const out = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(': ');
    if (colon <= 0) continue;
    const name = line.slice(0, colon);
    // The status follows the first " - " before a glyph Claude Code prints (a target such as `npx x - y` holds none);
    // a line with none of them takes the last " - <char> ", and its label is kept as an unknown status.
    const rest = line.slice(colon + 2);
    const known = /\s-\s([✔✓✘✗!⏸])(?:\s|$)/u.exec(rest);
    let at = known ? known.index : -1;
    if (at === -1) { const all = [...rest.matchAll(/\s-\s(?=\S\s)/gu)]; at = all.length ? all[all.length - 1].index : -1; }
    const m = at === -1 ? null : /^\s-\s(\S)\s*([^]*)$/u.exec(rest.slice(at));
    if (!m) continue;
    const [, glyph, labelRaw] = m;
    const label = labelRaw.trim();
    let status = 'unknown';
    let detail = label;
    if (glyph === '✔' || glyph === '✓') { status = 'connected'; detail = ''; } else if (glyph === '✘' || glyph === '✗') {
      status = 'failed';
      detail = label.replace(/^Failed to connect\s*(?:[—–-]\s*)?/i, '') || 'failed to connect';
    } else if (glyph === '⏸') status = 'pending';
    else if (glyph === '!') {
      if (/needs auth/i.test(label)) { status = 'needs-auth'; detail = ''; } else { status = 'connected'; detail = label.replace(/^Connected\s*[·•-]?\s*/i, ''); }
    }
    out.set(name, { status, detail: cut(detail) });
  }
  return out;
}

/** `codex mcp list --json` → Map name → { enabled, disabledReason, auth }. */
function parseCodexList(text) {
  const out = new Map();
  let j;
  try { j = JSON.parse(String(text || '')); } catch { return null; }
  const list = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.servers) ? j.servers : null;
  if (!list) return null;
  for (const s of list) {
    if (!isObj(s) || !str(s.name)) continue;
    out.set(s.name, { enabled: s.enabled !== false, disabledReason: str(s.disabled_reason), auth: str(s.auth_status) });
  }
  return out;
}

/** Run a host CLI, never a shell. → Promise<{ status, stdout, stderr, timedOut }> */
function runCli(bin, args, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let child;
    try { child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ status: 127, stdout: '', stderr: String(e.message), timedOut: false }); return; }
    const timer = setTimeout(() => { if (!done) { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(124, true); } }, timeoutMs);
    function finish(status, timedOut = false) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    }
    child.stdout.on('data', (d) => { if (stdout.length < 4 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 64 * 1024) stderr += d; });
    child.on('error', (e) => { stderr += String(e.message); finish(127); });
    child.on('close', (code) => finish(code === null ? 1 : code));
  });
}

// ── an entry as its host would start it ──────────────────────────────────────

/** Claude Code's `${VAR}` and `${VAR:-default}`; a missing variable without a default is recorded in `missing`. */
function expandClaude(value, vars, missing) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, def) => {
    if (vars[name] !== undefined && vars[name] !== '') return vars[name];
    if (def !== undefined) return def;
    missing.add(name);
    return '';
  });
}

function strMap(v) {
  const out = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k] = String(x);
  return out;
}

/**
 * How to start an entry: { transport: 'stdio', command, args, env, cwd } or { transport: 'http'|'sse', url, headers },
 * or { missing: [names] } when it needs variables that are not set, or null when it names nothing to start.
 */
function launchOf(host, { spec, root = null, cwd = null }, env) {
  if (!isObj(spec)) return null;
  const missing = new Set();
  const type = str(spec.type) || str(spec.transport);
  if (host === 'claude') {
    const vars = { ...env, ...(root ? { CLAUDE_PLUGIN_ROOT: root } : {}) };
    const x = (v) => expandClaude(v, vars, missing);
    if (str(spec.url)) {
      const headers = {};
      for (const [k, v] of Object.entries(strMap(spec.headers))) headers[k] = x(v);
      const url = x(spec.url);
      return missing.size ? { missing: [...missing] } : { transport: type === 'sse' ? 'sse' : 'http', url, headers };
    }
    if (!str(spec.command)) return null;
    const command = x(spec.command);
    const args = Array.isArray(spec.args) ? spec.args.map((a) => x(a)) : [];
    const own = {};
    for (const [k, v] of Object.entries(strMap(spec.env))) own[k] = x(v);
    if (missing.size) return { missing: [...missing] };
    return { transport: 'stdio', command, args, env: { ...env, ...own }, cwd: cwd || root || undefined };
  }
  // Codex: no expansion; the environment it passes through is named.
  if (str(spec.url)) {
    const headers = strMap(spec.http_headers);
    const bearer = str(spec.bearer_token_env_var);
    if (bearer) { if (env[bearer]) headers.Authorization = `Bearer ${env[bearer]}`; else missing.add(bearer); }
    for (const [h, name] of Object.entries(strMap(spec.env_http_headers))) { if (env[name]) headers[h] = env[name]; else missing.add(name); }
    return missing.size ? { missing: [...missing] } : { transport: type === 'sse' ? 'sse' : 'http', url: spec.url, headers };
  }
  if (!str(spec.command)) return null;
  const own = strMap(spec.env);
  if (Array.isArray(spec.env_vars)) for (const n of spec.env_vars) if (typeof n === 'string' && env[n] !== undefined) own[n] = env[n];
  // A plugin's `env` may be a list of names to pass through (seen in the wild); take it as env_vars.
  if (Array.isArray(spec.env)) for (const n of spec.env) if (typeof n === 'string' && env[n] !== undefined) own[n] = env[n];
  const base = cwd || root;
  const dir = str(spec.cwd) ? (path.isAbsolute(spec.cwd) ? spec.cwd : path.resolve(base || os.homedir(), spec.cwd)) : base || undefined;
  return { transport: 'stdio', command: spec.command, args: Array.isArray(spec.args) ? spec.args.map(String) : [], env: { ...env, ...own }, cwd: dir };
}

// ── the probe ────────────────────────────────────────────────────────────────

function authError(e) {
  const m = String((e && e.message) || e || '');
  return (e && (e.code === 401 || e.code === 403)) || /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid_token|oauth/i.test(m);
}

/** initialize + tools/list through the SDK's client. → { ok, tools, error, auth } */
async function sdkProbe(launch, { timeoutMs }) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  let transport;
  if (launch.transport === 'stdio') {
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd, stderr: 'ignore' });
  } else if (launch.transport === 'sse') {
    const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
    transport = new SSEClientTransport(new URL(launch.url), { requestInit: { headers: launch.headers } });
  } else {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    transport = new StreamableHTTPClientTransport(new URL(launch.url), { requestInit: { headers: launch.headers } });
  }
  const client = new Client({ name: 'agenticos-connectors', version: '1.0.0' }, { capabilities: {} });
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); });
  try {
    const work = (async () => {
      await client.connect(transport);
      const tools = [];
      let cursor;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const r = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of (r && r.tools) || []) if (t && str(t.name)) tools.push({ name: t.name, summary: cut(String(t.description || '').split(/\n/)[0]) });
        cursor = r && r.nextCursor;
        if (!cursor) break;
      }
      return tools;
    })();
    const tools = await Promise.race([work, deadline]);
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, tools: null, error: cut(e && e.message ? e.message : String(e)), auth: authError(e) };
  } finally {
    clearTimeout(timer);
    try { await Promise.race([client.close(), new Promise((r) => setTimeout(r, 2000))]); } catch { /* closing */ }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

// ── one at a time ────────────────────────────────────────────────────────────

/** Take `<file>.lock` now or throw Busy (fsx's lock file shape, so a stale one is broken the same way). → release() */
function tryLock(file, staleMs) {
  const lockPath = `${file}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const mine = { pid: process.pid, id: crypto.randomUUID(), until: new Date(Date.now() + staleMs).toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, JSON.stringify(mine)); } finally { fs.closeSync(fd); }
      return () => {
        try { const now = JSON.parse(fs.readFileSync(lockPath, 'utf8')); if (now && now.id === mine.id) fs.unlinkSync(lockPath); } catch { /* gone */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { owner = null; }
      if (owner && fsx.lockHeld(owner)) throw new Busy('a check is already running');
      try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    }
  }
  throw new Busy('a check is already running');
}

// ── the check ────────────────────────────────────────────────────────────────

/**
 * opts: { vault, userConfig, env, home, cfg (connectors.*), claudeBin(user), codexBin(user), run (a runCli stand-in),
 *         probe (an sdkProbe stand-in), now(), write (default true) }
 */
async function check(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const vault = opts.vault;
  const conn = (opts.cfg && opts.cfg.connectors) || {};
  const timeoutMs = Math.max(1, Number(conn.probeTimeoutSec) || 10) * 1000;
  const concurrency = Math.max(1, Math.min(16, Number(conn.probeConcurrency) || 4));
  const run = opts.run || runCli;
  const probe = opts.probe || sdkProbe;
  const now = opts.now || Date.now;
  const started = now();
  const release = vault && opts.write !== false ? tryLock(liveFile(vault), LIST_TIMEOUT_MS + 5 * 60 * 1000) : () => {};
  try {
    let prev = null;
    try { prev = vault ? JSON.parse(fs.readFileSync(liveFile(vault), 'utf8')) : null; } catch { prev = null; }
    const specs = new Map();
    const found = D.discover({ vault, userConfig: opts.userConfig, env, home, live: prev, specs });
    const hosts = {};
    const rows = [];

    // Claude Code's own list.
    let claudeList = null;
    if (found.hosts.claude.enabled) {
      const bin = opts.claudeBin ? opts.claudeBin(opts.userConfig) : null;
      if (!bin) hosts.claude = { enabled: true, ran: false, error: 'the claude CLI was not found' };
      else {
        const r = await run(bin, ['mcp', 'list'], { env, cwd: vault || home, timeoutMs: LIST_TIMEOUT_MS });
        if (r.status === 0) { claudeList = parseClaudeList(r.stdout); hosts.claude = { enabled: true, ran: true }; } else hosts.claude = { enabled: true, ran: false, error: r.timedOut ? 'claude mcp list did not finish' : cut(`claude mcp list failed: ${r.stderr || r.stdout || `exit ${r.status}`}`) };
      }
    } else hosts.claude = { enabled: false, ran: false };

    // Codex's list and sign-in.
    let codexList = null;
    let codexSignedIn = null;
    if (found.hosts.codex.enabled) {
      const bin = opts.codexBin ? opts.codexBin(opts.userConfig) : null;
      if (!bin) hosts.codex = { enabled: true, ran: false, error: 'the codex CLI was not found' };
      else {
        const r = await run(bin, ['mcp', 'list', '--json'], { env, cwd: vault || home, timeoutMs: LIST_TIMEOUT_MS });
        codexList = r.status === 0 ? parseCodexList(r.stdout) : null;
        hosts.codex = codexList ? { enabled: true, ran: true } : { enabled: true, ran: false, error: cut(`codex mcp list --json failed: ${r.stderr || r.stdout || `exit ${r.status}`}`) };
        if (found.rows.some((x) => x.host === 'codex' && x.kind === 'connector')) {
          const l = await run(bin, ['login', 'status'], { env, cwd: home, timeoutMs: LOGIN_TIMEOUT_MS });
          codexSignedIn = l.status === 0 && /logged in/i.test(`${l.stdout}\n${l.stderr}`) && !/not logged in/i.test(`${l.stdout}\n${l.stderr}`);
        }
      }
    } else hosts.codex = { enabled: false, ran: false };

    // Every row's status before any probe, and which need one.
    const todo = [];
    for (const x of found.rows) {
      const r = { host: x.host, name: x.name, kind: x.kind, status: 'unknown', detail: '', tools: null };
      rows.push(r);
      if (x.kind === 'connector') {
        if (x.host === 'claude') {
          const l = claudeList && claudeList.get(x.name);
          if (l) Object.assign(r, l);
          else if (claudeList) { r.status = 'off'; r.detail = 'not on this account any more'; } else r.detail = hosts.claude.error || '';
        } else if (codexSignedIn === true) { r.status = 'connected'; r.detail = 'through your ChatGPT sign-in'; } else if (codexSignedIn === false) { r.status = 'needs-auth'; r.detail = 'codex login'; } else r.detail = (hosts.codex && hosts.codex.error) || '';
        continue;
      }
      if (x.enabled === false) { r.status = 'off'; r.detail = x.parked ? 'parked' : x.approval === 'off' ? 'turned off for this project' : 'turned off'; continue; }
      if (x.approval === 'pending') { r.status = 'pending'; r.detail = 'waiting for approval in Claude Code'; continue; }
      if (x.host === 'claude') {
        const l = claudeList && claudeList.get(x.name);
        if (l) Object.assign(r, l);
        if (l && l.status !== 'connected') continue;
      } else if (codexList) {
        const c = codexList.get(x.name);
        if (!c) { r.status = 'off'; r.detail = 'declared, but Codex does not load it'; continue; }
        if (!c.enabled) { r.status = 'off'; r.detail = c.disabledReason || 'turned off'; continue; }
        if (c.auth === 'not_logged_in') { r.status = 'needs-auth'; r.detail = `codex mcp login ${x.name}`; continue; }
      }
      const spec = specs.get(`${x.host}\t${x.name}`);
      const launch = spec ? launchOf(x.host, spec, env) : null;
      if (!launch) { if (r.status === 'unknown') r.detail = 'nothing to start'; continue; }
      if (launch.missing) { r.toolsError = `needs $${launch.missing.join(', $')}`; if (r.status === 'unknown') { r.status = 'failed'; r.detail = r.toolsError; } continue; }
      todo.push({ r, launch, key: JSON.stringify(launch) });
    }
    // Claude claude.ai connectors the list names that discovery did not know yet.
    if (claudeList) {
      for (const [name, l] of claudeList) {
        if (name.startsWith(D.CLAUDE_AI) && !rows.some((x) => x.host === 'claude' && x.name === name)) rows.push({ host: 'claude', name, kind: 'connector', ...l, tools: null });
      }
    }

    // One probe per identical entry.
    const unique = [...new Map(todo.map((t) => [t.key, t.launch])).entries()];
    const results = new Map();
    await pool(unique, concurrency, async ([key, launch]) => { results.set(key, await probe(launch, { timeoutMs })); });
    for (const t of todo) {
      const p = results.get(t.key);
      if (p.ok) {
        t.r.tools = p.tools;
        if (t.r.status === 'unknown') { t.r.status = 'connected'; t.r.detail = ''; }
      } else if (t.r.status === 'unknown') {
        t.r.toolsError = p.error;
        t.r.status = p.auth ? 'needs-auth' : 'failed';
        t.r.detail = p.error;
      } else {
        // The host connected it with a sign-in of its own (OAuth): the runtime has none, so its tools come from use (D12).
        t.r.toolsError = p.auth ? 'signed in through its host; tools are the ones seen in use' : p.error;
      }
    }

    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
    const live = { schema: SCHEMA, checkedAt: new Date(started).toISOString(), durationMs: Math.max(0, now() - started), hosts, rows };
    if (vault && opts.write !== false) fsx.writeAtomic(liveFile(vault), JSON.stringify(live, null, 2) + '\n');
    return live;
  } finally {
    release();
  }
}

/** The last check's cache, or null. */
function readLive(vault) {
  try { const j = JSON.parse(fs.readFileSync(liveFile(vault), 'utf8')); return j && j.schema === SCHEMA ? j : null; } catch { return null; }
}

module.exports = { check, readLive, liveFile, parseClaudeList, parseCodexList, launchOf, expandClaude, sdkProbe, runCli, tryLock, Busy, SCHEMA };
