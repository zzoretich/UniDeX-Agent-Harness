'use strict';
/**
 * mcp.js — `aos mcp copy <name> --to claude|codex [--dry-run] [--expect <hash>] [--json]`: make one MCP server of one
 * host available on the other, per item and on request (install-import B6; the Workbench's Skills ▸ MCP servers runs it
 * on a click).
 *
 *   1. The server's full config is read at run time from the SOURCE host's own file, never from the vault's listing
 *      (brain/_index/mcp-servers.json keeps the program alone): Claude Code's user-scope `mcpServers` in .claude.json
 *      (lib/import/mcp.js claudeUserFile), or Codex's config.toml, where lib/import/mcp.js codexServerMap reads every
 *      form a server may take. A Codex server declared by dotted keys (whose values are not read) or in more than one
 *      form is refused as a source, and any form counts as "already there" as a target, so `codex mcp add` never
 *      overwrites one. A server turned off on its host is refused: neither CLI's add takes an off state.
 *   2. The target command is the host's own CLI: `claude mcp add-json --scope user <name> <json>`, or
 *      `codex mcp add <name> [--env K=V]… -- <command> [args…]` (the form cli/codex-host.js mcpAddArgs uses). A stdio
 *      server goes either way; a remote one (http, sse) only to Claude Code, whose JSON takes a URL: Codex's `mcp add`
 *      takes a command, so that copy is refused with what to do instead. What the target cannot express (a working
 *      folder, timeouts, Codex's env_vars, tool filters, dotted keys, headers taken from the environment) is named in
 *      `dropped`.
 *   3. `--dry-run` writes nothing in the vault or a host's config (it makes this install's key once, below). It prints
 *      that command with these hidden: every environment and header value; in a URL, its credentials, every query value
 *      and a token-like path segment (lib/import/mcp.js maskUrl); the value of a flag or `KEY=` whose name has a secret
 *      word (lib/import/mcp.js secretName: token, secret, pass, password, key, auth, credential, cookie, session, … as
 *      whole words of the name; `--name`, `-name` and `--name=`), and of `-p`, `-k`, `-t`; a `-H`/`--header` value
 *      (`--header=` too) and an `Authorization:`-style argument; inside a JSON argument, every secret-named key's value
 *      and every token-like string; each word of an argument with spaces (`sh -c "…"`), by these same rules; and any
 *      value, or `:`/`=`-separated part of one, that looks like a token (tokenLike: a known prefix, 32+ hex digits or
 *      lowercase letters and digits, or 20+ characters of mixed-case base64). That is recognition by name and shape: a
 *      secret that has neither (a short lowercase password after a flag named otherwise) is shown as written. The dry
 *      run also prints `expect`, an HMAC-SHA256 under this install's own key (~/.local/share/unidex/keys/mcp-plan.key,
 *      0600) of the source entry and the exact target command; the Workbench shows the dry run, and its confirm runs the
 *      copy with `--expect <hash>`, which is refused when either changed since.
 *   4. A real run holds a lock per target host (two copies never rewrite one config at once), checks again, backs the
 *      target's config file up OUTSIDE the vault (~/.local/share/unidex/backups/mcp/: each component a real folder this
 *      user owns, never a link; the folder 0700, files 0600, created exclusively with a millisecond stamp, the newest 10
 *      per host kept: each holds every server's secrets, and the Workbench's page never reads that folder), runs the
 *      command, checks the target lists the server, and lists both hosts again into mcp-servers.json. A failing CLI's
 *      own output is shown with every value hidden above replaced.
 *   Refused, writing nothing: a name either CLI would reject (letters, digits, `-` and `_` only), the vault's own
 *   `agenticos` server, a server the source does not declare (or declares in a form not read) or the target already
 *   has, one turned off, a target host that is off in agenticos.json (`aos hosts add <host>`), a target CLI that is not
 *   installed, a stale `--expect`, and a copy to a host another copy holds.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOSTS = ['claude', 'codex'];
const HOST_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const USAGE = 'aos mcp copy <name> --to claude|codex [--dry-run] [--expect <hash>] [--json]';
/** What both CLIs accept as a server name (and the Workbench's surface rule), at most 64 characters. */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const OWN = 'agenticos';
const KEEP_BACKUPS = 10;
const RUN_TIMEOUT_MS = 60 * 1000;
const LOCK_TIMEOUT_MS = 10 * 1000;
const HIDDEN = '<redacted>';
/** Short flags whose value is taken as a secret (-p a password, -k a key, -t a token): hiding a port too is the price. */
const SECRET_SHORT = new Set(['-p', '-P', '-k', '-K', '-t', '-T']);
const HEADER_FLAGS = new Set(['-H', '--header', '--headers', '--http-header']);
/** `Name: value`, as a header is written in an argument. */
const HEADER_ARG = /^([A-Za-z0-9-]+)\s*:\s*(\S[\s\S]*)$/;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;
/** Keys each host's entry may carry that the copy itself handles. */
const CARRIED = {
  claude: new Set(['type', 'transport', 'command', 'args', 'env', 'url', 'headers', 'disabled', 'enabled']),
  codex: new Set(['command', 'args', 'env', 'url', 'enabled', 'type', 'transport']),
};

class UsageError extends Error {}
class Refused extends Error {}

function resolveScript(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(__dirname, '..', 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return p;
  throw new Error(`${rel} not found beside cli/mcp.js — run \`aos upgrade\``);
}
function lib() { return require(resolveScript('lib/import/mcp.js')); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v.trim() ? v : null; }
function tilde(p, home) { return home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p; }

/** The words and flags after `aos mcp`: `copy <name> --to <host> [--dry-run] [--expect <hash>] [--json]`. */
function parseMcpArgs(argv) {
  const words = [];
  const flags = { dryRun: false, json: false, to: null, expect: null };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) { words.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (name === 'to' || name === 'expect') {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new UsageError(`aos mcp copy: --${name} needs a value`);
      flags[name] = String(v);
    } else if (name === 'dry-run' && eq === -1) flags.dryRun = true;
    else if (name === 'json' && eq === -1) flags.json = true;
    else throw new UsageError(`aos mcp: unknown flag ${a} (${USAGE})`);
  }
  const [verb, name, ...rest] = words;
  if (verb !== 'copy' || !name || rest.length) throw new UsageError(USAGE);
  if (!HOSTS.includes(flags.to)) throw new UsageError('aos mcp copy: --to takes claude or codex');
  if (flags.expect !== null && !HASH_RE.test(flags.expect)) throw new UsageError('aos mcp copy: --expect takes the 64-character hash a dry run printed');
  if (flags.expect !== null && flags.dryRun) throw new UsageError('aos mcp copy: --expect is for the real run, after a --dry-run');
  return { verb, name, to: flags.to, dryRun: flags.dryRun, json: flags.json, expect: flags.expect };
}

// ── the source's full entry ──────────────────────────────────────────────────

/** What the copy carries from an entry: { transport, command, args, env, url, headers, dropped, disabled }. */
function normalize(host, raw, extra = []) {
  const url = str(raw.url);
  const type = str(raw.type) || str(raw.transport);
  const transport = type === 'http' || type === 'sse' || type === 'stdio' ? type : (url ? 'http' : 'stdio');
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const env = {};
  if (isPlainObject(raw.env)) for (const [k, v] of Object.entries(raw.env)) env[k] = String(v);
  const headers = {};
  if (isPlainObject(raw.headers)) for (const [k, v] of Object.entries(raw.headers)) headers[k] = String(v);
  const dropped = [...Object.keys(raw).filter((k) => !CARRIED[host].has(k)), ...extra].sort();
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
  return lib().claudeUserFile({ dirs, home: ctx.home });
}

/** config.toml's servers by name (lib/import/mcp.js codexServerMap), or a Refused naming why it cannot be read. */
function codexMap(file, why) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  try { return lib().codexServerMap(text); } catch (e) { throw new Refused(`${why}: Codex's config.toml does not parse (${e.message})`); }
}

/** The source host's entry for `name`. → { file, server } or null. Throws Refused for a form that is not read. */
function readEntry(host, name, ctx) {
  const file = configFileOf(host, ctx);
  if (host === 'claude') {
    const j = readJson(file);
    const all = j && isPlainObject(j.mcpServers) ? j.mcpServers : {};
    if (!Object.prototype.hasOwnProperty.call(all, name) || !isPlainObject(all[name])) return null;
    return { file, server: normalize('claude', all[name]) };
  }
  const e = codexMap(file, `cannot read ${name}`).get(name);
  if (!e) return null;
  if (e.forms.has('dotted') || e.forms.size > 1) {
    const how = e.forms.has('dotted') ? 'dotted keys' : 'more than one place';
    throw new Refused(`Codex declares ${name} in a form aos mcp copy does not read (${how}): write it as an [mcp_servers.${name}] table`);
  }
  const spec = { ...(e.spec || {}) };
  const env = { ...(isPlainObject(spec.env) ? spec.env : {}), ...e.env };
  delete spec.env;
  if (Object.keys(env).length) spec.env = env;
  return { file, server: normalize('codex', spec, [...e.dotted, ...e.subtables]) };
}

/** Whether `host` declares `name` in its config file, in any form. */
function declares(host, name, ctx) {
  if (host === 'claude') return !!readEntry('claude', name, ctx);
  return codexMap(configFileOf('codex', ctx), `cannot tell whether Codex already has ${name}`).has(name);
}

// ── the target command, and what is shown of it ──────────────────────────────

/** A value that should be hidden, with what to scrub for it (the value, and its last word: `Bearer <token>`). */
function secretParts(v) {
  const out = [v];
  const last = String(v).trim().split(/\s+/).pop();
  if (last && last !== v) out.push(last);
  return out;
}

/** A flag: `--name`, `-name` (Go's long flags) or `-x`. */
const FLAG_NAME = /^-{1,2}([A-Za-z][A-Za-z0-9_.-]*)$/;
/** `name=value`: a flag's (`--name=`, `-name=`) or an environment-style `KEY=`. */
const KV = /^(-{0,2}[A-Za-z_][A-Za-z0-9_.-]*)=([\s\S]+)$/;

/** A header written `Name: value`, its value hidden. → { shown, secrets } */
function hiddenHeader(h) { return { shown: `${h[1]}: ${HIDDEN}`, secrets: [h[0], ...secretParts(h[2])] }; }

/** A JSON value with every secret-named key's value and every token-like or URL string hidden. */
function redactJson(v, secrets, key = null) {
  if (Array.isArray(v)) return v.map((x) => redactJson(x, secrets, key));
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactJson(x, secrets, k);
    return out;
  }
  if (key !== null && lib().secretName(key) && (typeof v === 'string' || typeof v === 'number')) { secrets.push(String(v)); return HIDDEN; }
  if (typeof v !== 'string') return v;
  const r = redactValue(v);
  secrets.push(...r.secrets);
  return r.shown;
}

/**
 * A value on its own (a bare argument, the part after `=`): JSON with its secrets hidden; words of a shell string each
 * redacted as arguments; a URL masked; each `:`- or `=`-separated part that looks like a token hidden; a token hidden.
 * → { shown, secrets }
 */
function redactValue(a) {
  const L = lib();
  if (/^\s*[[{]/.test(a)) {
    let j;
    try { j = JSON.parse(a); } catch { j = undefined; }
    if (j !== undefined) {
      const secrets = [];
      const shown = JSON.stringify(redactJson(j, secrets));
      return { shown, secrets: secrets.length ? [a, ...secrets] : [] };
    }
  }
  if (/\s/.test(a.trim())) {
    // A shell string (`sh -c "… --token <t>"`): its words, as arguments, separators kept.
    const parts = a.split(/(\s+)/);
    const words = parts.filter((x, i) => i % 2 === 0);
    const r = redactArgs(words);
    let w = 0;
    const shown = parts.map((x, i) => (i % 2 === 0 ? r.shown[w++] : x)).join('');
    return { shown, secrets: shown === a ? [] : [a, ...r.secrets] };
  }
  const u = L.maskUrl(a, { query: 'mask' });
  if (u.shown !== null) return { shown: u.shown, secrets: u.shown === a ? [] : [a, ...u.secrets] };
  if (L.tokenLike(a)) return { shown: HIDDEN, secrets: [a] };
  if (/[:=]/.test(a)) {
    const parts = a.split(/([:=])/);
    const secrets = [];
    const shown = parts.map((x, i) => (i % 2 === 0 && L.tokenLike(x) ? (secrets.push(x), HIDDEN) : x)).join('');
    return { shown, secrets: secrets.length ? [a, ...secrets] : [] };
  }
  return { shown: a, secrets: [] };
}

/** One argument as shown, given the one before it. → { shown, secrets } */
function redactArg(a, prev) {
  const L = lib();
  const flag = prev !== null ? FLAG_NAME.exec(prev) : null;
  if (prev !== null && HEADER_FLAGS.has(prev)) {
    const h = HEADER_ARG.exec(a);
    return h ? hiddenHeader(h) : { shown: HIDDEN, secrets: [a] };
  }
  // The value of a secret-named flag: --token, -token, --api-key, --pass, and the short -p, -k, -t.
  if (flag && !a.startsWith('-') && (SECRET_SHORT.has(prev) || (flag[1].length > 1 && L.secretName(flag[1])))) return { shown: HIDDEN, secrets: [a] };
  const kv = KV.exec(a);
  if (kv) {
    if (HEADER_FLAGS.has(kv[1])) {
      const h = HEADER_ARG.exec(kv[2]);
      if (h) { const r = hiddenHeader(h); return { shown: `${kv[1]}=${r.shown}`, secrets: [a, ...r.secrets] }; }
      return { shown: `${kv[1]}=${HIDDEN}`, secrets: [a, kv[2]] };
    }
    if (L.secretName(kv[1])) return { shown: `${kv[1]}=${HIDDEN}`, secrets: [a, kv[2]] };
    const r = redactValue(kv[2]);
    return { shown: `${kv[1]}=${r.shown}`, secrets: r.shown === kv[2] ? [] : [a, ...r.secrets] };
  }
  const h = HEADER_ARG.exec(a);
  if (h && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(a) && (SECRET_HEADER.test(h[1]) || L.secretName(h[1]))) return hiddenHeader(h);
  return redactValue(a);
}

/** Arguments with their secrets hidden. → { shown, secrets } */
function redactArgs(args) {
  const shown = [];
  const secrets = [];
  args.forEach((a, i) => {
    const r = redactArg(String(a), i > 0 ? String(args[i - 1]) : null);
    shown.push(r.shown);
    secrets.push(...r.secrets);
  });
  return { shown, secrets };
}

function hideValues(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = HIDDEN;
  return out;
}

/** A word as a shell would need it written, for showing. */
function shq(w) { return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, "'\\''")}'`; }

/**
 * The target CLI's arguments (after its binary) and the same with every secret it recognises hidden. → { argv, shown,
 * secrets }. Throws Refused when the target cannot take this server.
 */
function targetCommand(to, name, s) {
  const secrets = [...Object.values(s.env), ...Object.values(s.headers).flatMap(secretParts)].filter(Boolean);
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
      const u = lib().maskUrl(s.url, { query: 'mask' });
      if (u.shown !== s.url) secrets.push(s.url, ...u.secrets);
      json = { type: s.transport, url: s.url, ...(Object.keys(s.headers).length ? { headers: s.headers } : {}) };
      shownJson = { ...json, url: u.shown || HIDDEN, ...(Object.keys(s.headers).length ? { headers: hideValues(s.headers) } : {}) };
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
  for (const s of [...new Set(secrets)].filter((x) => x && x.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(s).join(HIDDEN);
  return out;
}

/**
 * The plan's hash: an HMAC-SHA256, under this install's key (planKey), of the source entry as read and the exact target
 * command, so a confirm runs only what it showed. Keyed, because the page holds the hash and the entry holds secrets: a
 * plain hash of a weak one could be guessed back offline. 64 hex digits either way.
 */
function planHash(p, key) {
  return crypto.createHmac('sha256', key).update(JSON.stringify({ v: 1, name: p.name, from: p.from, to: p.to, server: p.server, argv: p.argv })).digest('hex');
}

// ── this install's own folders: real, and the user's ─────────────────────────

/**
 * ~/<parts…>, each component made (0700) or entered only when it is a real folder (never a link) owned by this user:
 * a planted link would otherwise send a backup of the host's config, or the key, wherever it points. → the folder
 */
function ownDir(home, parts, what) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let cur = path.resolve(home);
  for (const part of parts) {
    cur = path.join(cur, part);
    let st = null;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!st) {
      try { fs.mkdirSync(cur, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      st = fs.lstatSync(cur);
    }
    const why = st.isSymbolicLink() ? 'a link' : !st.isDirectory() ? 'not a folder' : uid !== null && st.uid !== uid ? 'owned by another user' : null;
    if (why) throw new Refused(`${tilde(cur, path.resolve(home))} is not a folder of your own (${why}): aos mcp copy keeps its ${what} only in real folders you own`);
  }
  return cur;
}

/** The folder of this install's keys: ~/.local/share/unidex/keys, 0700 (the Workbench's page never reads it). */
function keyDir(home) { return path.join(home, '.local', 'share', 'unidex', 'keys'); }

/**
 * This install's key for planHash: 32 random bytes in ~/.local/share/unidex/keys/mcp-plan.key, made on first use (0600,
 * created exclusively) and read without following a link; one that is a link, not a regular file of this user's, open to
 * others, or not 32 bytes is refused rather than used.
 */
function planKey(home) {
  const dir = ownDir(home, ['.local', 'share', 'unidex', 'keys'], 'key');
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'mcp-plan.key');
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeSync(fd, crypto.randomBytes(32)); } finally { fs.closeSync(fd); }
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const refuse = (why) => new Refused(`${tilde(file, path.resolve(home))} is not a key file of your own (${why}): remove it, and the next dry run makes a new one`);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch (e) { if (e.code === 'ELOOP') throw refuse('a link'); throw e; }
  try {
    const st = fs.fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!st.isFile()) throw refuse('not a file');
    if (uid !== null && st.uid !== uid) throw refuse('owned by another user');
    if (st.mode & 0o077) throw refuse('others can read it');
    if (st.size !== 32) throw refuse('not 32 bytes');
    const key = Buffer.alloc(32);
    fs.readSync(fd, key, 0, 32, 0);
    return key;
  } finally { fs.closeSync(fd); }
}

// ── backup ───────────────────────────────────────────────────────────────────

/** Where backups go: outside the vault and every folder the Workbench's page reads (app read-scope.ts deniedDirs). */
function backupDir(home) { return path.join(home, '.local', 'share', 'unidex', 'backups', 'mcp'); }

/** A backup's file name at `now`, to the millisecond. */
function backupName(to, file, now, n = 1) {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '');
  return `${to}-${path.basename(file).replace(/^\./, '')}-${stamp}${n > 1 ? `-${n}` : ''}.bak`;
}

/** Make the backups folder, 0700 (and its parent `backups`), each component a real folder of this user's (ownDir). */
function ensureBackupDir(home) {
  const dir = ownDir(home, ['.local', 'share', 'unidex', 'backups', 'mcp'], 'backups');
  for (const d of [path.dirname(dir), dir]) fs.chmodSync(d, 0o700);
  return dir;
}

/** Copy the target's config file into the backups (0600, created exclusively), keeping the newest KEEP_BACKUPS per host. */
function backup(home, to, file, now) {
  if (!fs.existsSync(file)) return null;
  const dir = ensureBackupDir(home);
  let dest = null;
  for (let n = 1; !dest; n++) {
    const p = path.join(dir, backupName(to, file, now, n));
    try { fs.copyFileSync(file, p, fs.constants.COPYFILE_EXCL); dest = p; } catch (e) { if (e.code !== 'EEXIST' || n > 99) throw e; }
  }
  fs.chmodSync(dest, 0o600);
  const mine = fs.readdirSync(dir).filter((n) => n.startsWith(`${to}-`) && n.endsWith('.bak'))
    .sort((a, b) => (a.replace(/\.bak$/, '') < b.replace(/\.bak$/, '') ? -1 : 1));
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

/** What a copy would do now: every check, the command and its hash. Throws Refused. */
function plan(args, ctx, opts) {
  const { name, to } = args;
  const from = to === 'claude' ? 'codex' : 'claude';
  if (!NAME_RE.test(name)) throw new Refused(`${JSON.stringify(name)} is not a server name both CLIs take (letters, digits, - and _, at most 64)`);
  if (name === OWN) throw new Refused('agenticos is the vault\'s own server: `aos init` and `aos hosts add` wire it on each host');
  if (!hostsOn(ctx.user)[to]) throw new Refused(`${HOST_LABEL[to]} is off on this Mac: \`aos hosts add ${to}\` turns it on`);
  const src = readEntry(from, name, ctx);
  if (!src) throw new Refused(`${HOST_LABEL[from]} declares no MCP server named ${name} (${tilde(configFileOf(from, ctx), ctx.home)})`);
  if (src.server.disabled) throw new Refused(`${name} is turned off on ${HOST_LABEL[from]}: turn it on there first, or add it to ${HOST_LABEL[to]} yourself`);
  const target = configFileOf(to, ctx);
  if (declares(to, name, ctx)) throw new Refused(`${HOST_LABEL[to]} already has an MCP server named ${name} (${tilde(target, ctx.home)}); nothing to do`);
  const cmd = targetCommand(to, name, src.server);
  const binOf = to === 'claude' ? opts.claudeBin : opts.codexBin;
  const bin = binOf ? binOf(ctx.user) : null;
  if (!bin) throw new Refused(`the ${to} CLI was not found: install ${HOST_LABEL[to]}, then try again`);
  const hash = planHash({ name, from, to, server: src.server, argv: cmd.argv }, planKey(ctx.home));
  return { name, from, to, src, target, cmd, bin, hash };
}

/**
 * Plan (and, unless dryRun, make) one copy. opts: { env, configDir, vault, home, now, claudeBin(user), codexBin(user),
 * spawn(bin, args, { env }), lockTimeoutMs }. → the report printed with --json.
 */
function copy(args, opts = {}) {
  const I = require('./import.js');
  const ctx = I.resolveCtx(opts);
  const now = opts.now || Date.now();
  const report = (p, extra) => ({
    ok: true, dryRun: !!args.dryRun, name: p.name, from: p.from, to: p.to, transport: p.src.server.transport,
    command: [p.to, ...p.cmd.shown].map(shq).join(' '),
    source: tilde(p.src.file, ctx.home), file: tilde(p.target, ctx.home),
    backup: fs.existsSync(p.target) ? tilde(path.join(backupDir(ctx.home), backupName(p.to, p.target, now)), ctx.home) : null,
    dropped: p.src.server.dropped, expect: p.hash, ...extra,
  });
  if (args.dryRun) return report(plan(args, ctx, opts), {});

  const fsx = require(resolveScript('lib/fsx.js'));
  const checked = () => {
    const p = plan(args, ctx, opts);
    if (args.expect && args.expect !== p.hash) throw new Refused(`${p.name}'s config or its command changed since the dry run: run the dry run again`);
    return p;
  };
  // Checked before the lock's folder is made, so a refusal leaves nothing behind; then again under the lock.
  checked();
  ensureBackupDir(ctx.home);
  const lockFile = path.join(backupDir(ctx.home), `${args.to}-copy`);
  try {
    return fsx.withLockSync(lockFile, () => {
      // What the dry run showed must still be what runs.
      const p = checked();
      const saved = backup(ctx.home, p.to, p.target, now);
      const r = report(p, { backup: saved ? tilde(saved, ctx.home) : null });
      const out = (opts.spawn || defaultSpawn)(p.bin, p.cmd.argv, { env: cliEnv(p.to, ctx) });
      if (out.status !== 0) {
        const said = scrub(`${out.stderr}\n${out.stdout}`, p.cmd.secrets).split('\n').map((l) => l.trim()).filter(Boolean)[0] || `exit ${out.status}`;
        throw new Refused(`${p.to} mcp ${p.to === 'claude' ? 'add-json' : 'add'} failed (${said})${saved ? `; the backup is ${r.backup}` : ''}`);
      }
      // List both hosts again, so the Workbench shows the server on both.
      const L = lib();
      const byHost = {};
      for (const h of HOSTS) byHost[h] = L.listServers(h, { env: ctx.env, userConfig: ctx.userConfig, dirs: hostDirsOf(h, ctx), home: ctx.home }).servers;
      L.writeServers(ctx.vault, HOSTS, byHost, { now: new Date(now) });
      r.listed = byHost[p.to].some((s) => s.name === p.name);
      return r;
    }, { timeoutMs: opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS, staleMs: 3 * RUN_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof fsx.LockBusy) throw new Refused(`another copy to ${HOST_LABEL[args.to]} is running: try again in a moment`);
    throw e;
  }
}

function lines(r) {
  const out = [];
  out.push(`${r.dryRun ? 'would make' : 'made'} ${r.name} (${r.transport}) from ${HOST_LABEL[r.from]} available on ${HOST_LABEL[r.to]}`);
  out.push(`  from:    ${r.source}`);
  out.push(`  writes:  ${r.file}`);
  out.push(`  backup:  ${r.backup || 'none (the file does not exist yet)'}`);
  out.push(`  runs:    ${r.command}`);
  out.push('  (environment and header values, URL credentials, queries and token-like segments, and arguments named or shaped like secrets are hidden here; one it does not recognise is shown as written)');
  if (r.dropped.length) out.push(`  not carried over: ${r.dropped.join(', ')}`);
  if (r.dryRun) out.push(`  confirm with: --expect ${r.expect}`);
  else out.push(r.listed ? '  listed in brain/_index/mcp-servers.json' : `  warning: ${HOST_LABEL[r.to]} does not list it yet; check ${r.file}`);
  return out;
}

/** `argv` = the words after `aos mcp`. → exit code */
function main(argv, opts = {}) {
  const io = opts.io || console;
  const args = parseMcpArgs(argv);
  const r = copy(args, { home: os.homedir(), ...opts });
  if (args.json) io.log(JSON.stringify(r, null, 2));
  else for (const l of lines(r)) io.log(l);
  return 0;
}

module.exports = {
  main, copy, parseMcpArgs, readEntry, normalize, targetCommand, redactArgs, scrub, backup, backupDir, backupName, configFileOf, planHash, planKey, keyDir,
  UsageError, Refused, USAGE, NAME_RE, KEEP_BACKUPS, HIDDEN,
};
