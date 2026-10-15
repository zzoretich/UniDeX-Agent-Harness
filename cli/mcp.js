'use strict';
/**
 * mcp.js — `aos mcp copy <name> --to claude|codex [--dry-run] [--json]`: make one MCP server of one host available on
 * the other, per item and on request (install-import B6; the Workbench's Skills ▸ MCP servers runs it on a click).
 *
 *   1. The server's full config is read at run time from the SOURCE host's own file, never from the vault's listing
 *      (brain/_index/mcp-servers.json keeps the program alone): Claude Code's user-scope `mcpServers` in .claude.json
 *      (lib/import/mcp.js claudeUserFile), or Codex's `[mcp_servers.<name>]` table, its `.env` sub-table or inline
 *      `env = { … }`, in <codex home>/config.toml.
 *   2. The target command is the host's own CLI: `claude mcp add-json --scope user <name> <json>`, or
 *      `codex mcp add <name> [--env K=V]… -- <command> [args…]` (the form cli/codex-host.js mcpAddArgs uses). A stdio
 *      server goes either way; a remote one (http, sse) only to Claude Code, whose JSON takes a URL: Codex's `mcp add`
 *      takes a command, so that copy is refused with what to do instead. What the target cannot express (a working
 *      folder, timeouts, Codex's env_vars, tool filters, headers taken from the environment) is named in `dropped`.
 *   3. `--dry-run` prints that command with every secret hidden (environment and header values, a URL's query and
 *      credentials, an argument that names or looks like a token) and writes nothing; the Workbench shows it before the
 *      user confirms. A real run backs the target's config file up first (brain/_index/backups/mcp/, mode 0600, the
 *      newest 10 per host kept: the file holds secrets, and brain/_index is never tracked), then runs the command, checks
 *      the target lists the server, and lists both hosts again into mcp-servers.json.
 *   Refused, writing nothing: a name either CLI would reject (letters, digits, `-` and `_` only), the vault's own
 *   `agenticos` server, a server the source does not declare or the target already has, a target host that is off in
 *   agenticos.json (`aos hosts add <host>`), or a target CLI that is not installed. Secret values never reach stdout,
 *   stderr or the vault: a failing CLI's own output is scrubbed of them before it is shown.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOSTS = ['claude', 'codex'];
const HOST_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const USAGE = 'aos mcp copy <name> --to claude|codex [--dry-run] [--json]';
/** What both CLIs accept as a server name (and the Workbench's surface rule), at most 64 characters. */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OWN = 'agenticos';
const KEEP_BACKUPS = 10;
const RUN_TIMEOUT_MS = 60 * 1000;
const HIDDEN = '<redacted>';
// An argument is hidden when its flag (or KEY= name) says it holds a secret, or when it looks like a known token.
const SECRET_NAME = /(token|secret|passw|pwd|api[-_]?key|apikey|auth|credential|bearer|private[-_]?key|access[-_]?key|cookie|session)/i;
const SECRET_SHAPE = /^(sk-|sk_|rk_|pk_live|gh[pousr]_|github_pat_|glpat-|xox[abpsr]-|AKIA[0-9A-Z]{8}|AIza[0-9A-Za-z_-]{10}|eyJ[A-Za-z0-9_-]{8,}\.)/;
/** Keys each host's entry may carry that the copy itself handles. */
const CARRIED = {
  claude: new Set(['type', 'transport', 'command', 'args', 'env', 'url', 'headers']),
  codex: new Set(['command', 'args', 'env', 'url', 'enabled', 'type', 'transport']),
};

class UsageError extends Error {}
class Refused extends Error {}

function resolveScript(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(__dirname, '..', 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return p;
  throw new Error(`${rel} not found beside cli/mcp.js — run \`aos upgrade\``);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v.trim() ? v : null; }
function tilde(p, home) { return home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p; }

/** The words and flags after `aos mcp`: `copy <name> --to <host> [--dry-run] [--json]`. */
function parseMcpArgs(argv) {
  const words = [];
  const flags = { dryRun: false, json: false, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) { words.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (name === 'to') {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new UsageError('aos mcp copy: --to needs a value');
      flags.to = String(v);
    } else if (name === 'dry-run' && eq === -1) flags.dryRun = true;
    else if (name === 'json' && eq === -1) flags.json = true;
    else throw new UsageError(`aos mcp: unknown flag ${a} (${USAGE})`);
  }
  const [verb, name, ...rest] = words;
  if (verb !== 'copy' || !name || rest.length) throw new UsageError(USAGE);
  if (!HOSTS.includes(flags.to)) throw new UsageError('aos mcp copy: --to takes claude or codex');
  return { verb, name, to: flags.to, dryRun: flags.dryRun, json: flags.json };
}

// ── the source's full entry ──────────────────────────────────────────────────

/** `name` in a TOML table header: bare, "basic" or 'literal'. → the text, or null. */
function tomlKey(m) {
  if (m === undefined || m === null) return null;
  if (m.startsWith('"')) { try { return JSON.parse(m); } catch { return null; } }
  if (m.startsWith("'")) return m.slice(1, -1);
  return m;
}
const KEY = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)`;
const HEADER = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*(${KEY})(?:\s*\.\s*(${KEY}))?\s*\]\s*(?:#.*)?$`);
const ANY_TABLE = /^\s*\[/;

/**
 * One Codex server's table from config.toml: its keys, its `.env` sub-table merged into `env`, and the other sub-tables
 * by name (never carried). → { spec, subtables } or null when the file does not declare it.
 */
function codexEntry(text, name) {
  const { parseToml } = require(resolveScript('lib/agent-translate.js'));
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let spec = null;
  const env = {};
  const subtables = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]);
    if (!m || tomlKey(m[1]) !== name) continue;
    let j = i + 1;
    while (j < lines.length && !ANY_TABLE.test(lines[j])) j++;
    let top;
    try { top = parseToml(lines.slice(i + 1, j).join('\n')).top; } catch (e) { throw new Refused(`config.toml's [mcp_servers.${name}${m[2] ? `.${tomlKey(m[2])}` : ''}] does not parse: ${e.message}`); }
    const sub = tomlKey(m[2]);
    if (!sub) spec = { ...(spec || {}), ...top };
    else if (sub === 'env') Object.assign(env, top);
    else subtables.push(sub);
    i = j - 1;
  }
  if (!spec) return null;
  if (isPlainObject(spec.env)) Object.assign(env, spec.env);
  delete spec.env;
  if (Object.keys(env).length) spec.env = env;
  return { spec, subtables };
}

/** What the copy carries from an entry: { transport, command, args, env, url, headers, dropped }. */
function normalize(host, raw, subtables = []) {
  const url = str(raw.url);
  const type = str(raw.type) || str(raw.transport);
  const transport = type === 'http' || type === 'sse' || type === 'stdio' ? type : (url ? 'http' : 'stdio');
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const env = {};
  if (isPlainObject(raw.env)) for (const [k, v] of Object.entries(raw.env)) env[k] = String(v);
  const headers = {};
  if (isPlainObject(raw.headers)) for (const [k, v] of Object.entries(raw.headers)) headers[k] = String(v);
  const dropped = [...Object.keys(raw).filter((k) => !CARRIED[host].has(k)), ...subtables].sort();
  return { transport, command: str(raw.command), args, env, url, headers, dropped, disabled: raw.enabled === false || raw.disabled === true };
}

function hostDirsOf(host, ctx) {
  const { hostDirs } = require(resolveScript('lib/host.js'));
  return hostDirs(host, { env: ctx.env, userConfig: ctx.userConfig });
}

/** The file a host keeps its user-scope servers in. */
function configFileOf(host, ctx) {
  const dirs = hostDirsOf(host, ctx);
  if (host === 'codex') return path.join(dirs.configDir, 'config.toml');
  const M = require(resolveScript('lib/import/mcp.js'));
  return M.claudeUserFile({ dirs, home: ctx.home });
}

/** The source host's entry for `name`. → { file, server } or null. */
function readEntry(host, name, ctx) {
  const file = configFileOf(host, ctx);
  if (host === 'claude') {
    const j = readJson(file);
    const all = j && isPlainObject(j.mcpServers) ? j.mcpServers : {};
    if (!Object.prototype.hasOwnProperty.call(all, name) || !isPlainObject(all[name])) return null;
    return { file, server: normalize('claude', all[name]) };
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const e = codexEntry(text, name);
  return e ? { file, server: normalize('codex', e.spec, e.subtables) } : null;
}

/** Whether `host` declares `name` in its config file. */
function declares(host, name, ctx) { return !!readEntry(host, name, ctx); }

// ── the target command, and what is shown of it ──────────────────────────────

/** Arguments with their secrets hidden. → { shown, secrets } */
function redactArgs(args) {
  const shown = [];
  const secrets = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const kv = /^(--?[A-Za-z0-9_.-]+|[A-Za-z_][A-Za-z0-9_]*)=([\s\S]+)$/.exec(a);
    const prev = i > 0 ? String(args[i - 1]) : '';
    if (kv && SECRET_NAME.test(kv[1])) { shown.push(`${kv[1]}=${HIDDEN}`); secrets.push(kv[2]); continue; }
    if (SECRET_SHAPE.test(a) || (/^--?[A-Za-z0-9_.-]+$/.test(prev) && SECRET_NAME.test(prev) && !a.startsWith('-'))) {
      shown.push(HIDDEN);
      secrets.push(a);
      continue;
    }
    shown.push(a);
  }
  return { shown, secrets };
}

function hideValues(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = HIDDEN;
  return out;
}

/** A URL without its query, fragment or credentials, for showing; null when it does not parse. */
function shownUrl(u) {
  const M = require(resolveScript('lib/import/mcp.js'));
  return M.cleanUrl(u);
}

/** A word as a shell would need it written, for showing. */
function shq(w) { return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, "'\\''")}'`; }

/**
 * The target CLI's arguments (after its binary) and the same with every secret hidden. → { argv, shown, secrets }.
 * Throws Refused when the target cannot take this server.
 */
function targetCommand(to, name, s) {
  const secrets = [...Object.values(s.env), ...Object.values(s.headers)].filter(Boolean);
  if (s.url && shownUrl(s.url) !== s.url) secrets.push(s.url);
  if (to === 'claude') {
    let json;
    let shownJson;
    if (s.transport === 'stdio') {
      if (!s.command) throw new Refused(`${name} names no command to run`);
      const r = redactArgs(s.args);
      secrets.push(...r.secrets);
      json = { type: 'stdio', command: s.command, ...(s.args.length ? { args: s.args } : {}), ...(Object.keys(s.env).length ? { env: s.env } : {}) };
      shownJson = { ...json, ...(s.args.length ? { args: r.shown } : {}), ...(Object.keys(s.env).length ? { env: hideValues(s.env) } : {}) };
    } else {
      if (!s.url) throw new Refused(`${name} is a remote server with no URL`);
      json = { type: s.transport, url: s.url, ...(Object.keys(s.headers).length ? { headers: s.headers } : {}) };
      shownJson = { ...json, url: shownUrl(s.url) || HIDDEN, ...(Object.keys(s.headers).length ? { headers: hideValues(s.headers) } : {}) };
    }
    const head = ['mcp', 'add-json', '--scope', 'user', name];
    return { argv: [...head, JSON.stringify(json)], shown: [...head, JSON.stringify(shownJson)], secrets };
  }
  if (s.transport !== 'stdio') {
    throw new Refused(`${name} is a remote (${s.transport}) server, and \`codex mcp add\` takes a command to run: add it in Codex's config.toml as an [mcp_servers.${name}] table with its url`);
  }
  if (!s.command) throw new Refused(`${name} names no command to run`);
  const bad = Object.keys(s.env).find((k) => !ENV_KEY_RE.test(k));
  if (bad) throw new Refused(`${name}'s environment names ${JSON.stringify(bad)}, which \`codex mcp add --env\` cannot take`);
  const r = redactArgs(s.args);
  secrets.push(...r.secrets);
  const envArgs = Object.entries(s.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const envShown = Object.keys(s.env).flatMap((k) => ['--env', `${k}=${HIDDEN}`]);
  return {
    argv: ['mcp', 'add', name, ...envArgs, '--', s.command, ...s.args],
    shown: ['mcp', 'add', name, ...envShown, '--', s.command, ...r.shown],
    secrets,
  };
}

/** `text` with every secret replaced: a failing CLI's own output is shown only through this. */
function scrub(text, secrets) {
  let out = String(text || '');
  for (const s of [...secrets].filter((x) => x && x.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(s).join(HIDDEN);
  return out;
}

// ── backup ───────────────────────────────────────────────────────────────────

function backupDir(vault) { return path.join(vault, 'brain', '_index', 'backups', 'mcp'); }

/** Where a run backs `file` up, vault-relative, at `now`. */
function backupName(to, file, now) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${to}-${path.basename(file).replace(/^\./, '')}-${stamp}.bak`;
}

/** Copy the target's config file into the vault's backups (mode 0600), keeping the newest KEEP_BACKUPS per host. */
function backup(vault, to, file, now) {
  if (!fs.existsSync(file)) return null;
  const dir = backupDir(vault);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, backupName(to, file, now));
  fs.copyFileSync(file, dest);
  fs.chmodSync(dest, 0o600);
  const mine = fs.readdirSync(dir).filter((n) => n.startsWith(`${to}-`) && n.endsWith('.bak')).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) { try { fs.unlinkSync(path.join(dir, old)); } catch { /* gone */ } }
  return dest;
}

// ── the run ──────────────────────────────────────────────────────────────────

function hostsOn(user) {
  const h = user && user.hosts;
  if (!isPlainObject(h)) return { claude: true, codex: false };
  return { claude: !!(h.claude && h.claude.enabled), codex: !!(h.codex && h.codex.enabled) };
}

/**
 * The environment the target CLI runs with, so it writes the file that was backed up: Codex its home; Claude Code its
 * config folder only when the file is inside it (with CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json there), and
 * none when the file sits beside the default folder.
 */
function cliEnv(to, ctx) {
  const env = { ...ctx.env };
  const dir = hostDirsOf(to, ctx).configDir;
  if (to === 'codex') env.CODEX_HOME = dir;
  else if (path.dirname(configFileOf('claude', ctx)) === path.resolve(dir)) env.CLAUDE_CONFIG_DIR = dir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function defaultSpawn(bin, args, opts) {
  const r = spawnSync(bin, args, { encoding: 'utf8', env: opts.env, timeout: RUN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.error ? String(r.error.message) : r.stderr || '' };
}

/**
 * Plan (and, unless dryRun, make) one copy. opts: { env, configDir, vault, home, now, claudeBin(user), codexBin(user),
 * spawn(bin, args, { env }) }. → the report printed with --json.
 */
function copy(args, opts = {}) {
  const I = require('./import.js');
  const ctx = I.resolveCtx(opts);
  const { name, to, dryRun } = args;
  const from = to === 'claude' ? 'codex' : 'claude';
  if (!NAME_RE.test(name)) throw new Refused(`${JSON.stringify(name)} is not a server name both CLIs take (letters, digits, - and _, at most 64)`);
  if (name === OWN) throw new Refused('agenticos is the vault\'s own server: `aos init` and `aos hosts add` wire it on each host');
  if (!hostsOn(ctx.user)[to]) throw new Refused(`${HOST_LABEL[to]} is off on this Mac: \`aos hosts add ${to}\` turns it on`);
  const src = readEntry(from, name, ctx);
  if (!src) throw new Refused(`${HOST_LABEL[from]} declares no MCP server named ${name} (${tilde(configFileOf(from, ctx), ctx.home)})`);
  const target = configFileOf(to, ctx);
  if (declares(to, name, ctx)) throw new Refused(`${HOST_LABEL[to]} already has an MCP server named ${name} (${tilde(target, ctx.home)}); nothing to do`);
  const cmd = targetCommand(to, name, src.server);
  const binOf = to === 'claude' ? opts.claudeBin : opts.codexBin;
  const bin = binOf ? binOf(ctx.user) : null;
  if (!bin) throw new Refused(`the ${to} CLI was not found: install ${HOST_LABEL[to]}, then try again`);
  const now = opts.now || Date.now();
  const report = {
    ok: true, dryRun: !!dryRun, name, from, to, transport: src.server.transport,
    command: [to, ...cmd.shown].map(shq).join(' '),
    source: tilde(src.file, ctx.home), file: tilde(target, ctx.home),
    backup: fs.existsSync(target) ? path.posix.join('brain/_index/backups/mcp', backupName(to, target, now)) : null,
    dropped: src.server.dropped, disabled: src.server.disabled,
  };
  if (dryRun) return report;

  const saved = backup(ctx.vault, to, target, now);
  report.backup = saved ? path.relative(ctx.vault, saved).split(path.sep).join('/') : null;
  const spawn = opts.spawn || defaultSpawn;
  const r = spawn(bin, cmd.argv, { env: cliEnv(to, ctx) });
  if (r.status !== 0) {
    const said = scrub(`${r.stderr}\n${r.stdout}`, cmd.secrets).split('\n').map((l) => l.trim()).filter(Boolean)[0] || `exit ${r.status}`;
    throw new Refused(`${to} mcp ${to === 'claude' ? 'add-json' : 'add'} failed (${said})${saved ? `; the backup is ${report.backup}` : ''}`);
  }
  // List both hosts again, so the Workbench shows the server on both.
  const M = require(resolveScript('lib/import/mcp.js'));
  const byHost = {};
  for (const h of HOSTS) byHost[h] = M.listServers(h, { env: ctx.env, userConfig: ctx.userConfig, dirs: hostDirsOf(h, ctx), home: ctx.home }).servers;
  M.writeServers(ctx.vault, HOSTS, byHost, { now: new Date(now) });
  report.listed = byHost[to].some((s) => s.name === name);
  return report;
}

function lines(r) {
  const out = [];
  out.push(`${r.dryRun ? 'would make' : 'made'} ${r.name} (${r.transport}) from ${HOST_LABEL[r.from]} available on ${HOST_LABEL[r.to]}`);
  out.push(`  from:    ${r.source}`);
  out.push(`  writes:  ${r.file}`);
  out.push(`  backup:  ${r.backup || 'none (the file does not exist yet)'}`);
  out.push(`  runs:    ${r.command}`);
  out.push('  (environment and header values, URL queries and token-like arguments are hidden here; the command gets them from the source)');
  if (r.dropped.length) out.push(`  not carried over: ${r.dropped.join(', ')}`);
  if (r.disabled) out.push(`  note: it is turned off on ${HOST_LABEL[r.from]}; the copy is on`);
  if (!r.dryRun) out.push(r.listed ? '  listed in brain/_index/mcp-servers.json' : `  warning: ${HOST_LABEL[r.to]} does not list it yet; check ${r.file}`);
  return out;
}

/** `argv` = the words after `aos mcp`. → exit code */
function main(argv, opts = {}) {
  const io = opts.io || console;
  const args = parseMcpArgs(argv);
  const r = copy(args, opts);
  if (args.json) io.log(JSON.stringify(r, null, 2));
  else for (const l of lines(r)) io.log(l);
  return 0;
}

module.exports = {
  main, copy, parseMcpArgs, readEntry, codexEntry, normalize, targetCommand, redactArgs, scrub, backup, backupName, configFileOf,
  UsageError, Refused, USAGE, NAME_RE, KEEP_BACKUPS, HIDDEN,
};
