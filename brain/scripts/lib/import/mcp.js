'use strict';
/**
 * import/mcp.js — both hosts' MCP servers, listed (install-import B3, B6; the writes come later and only on click).
 *
 *   Claude Code  user scope: `mcpServers` at the top of .claude.json — inside a config folder of its own
 *                (CLAUDE_CONFIG_DIR), ~/.claude.json beside the default ~/.claude (claudeUserFile)
 *   Codex        `[mcp_servers.<name>]` tables of <codex home>/config.toml (each table read with agent-translate's TOML
 *                reader; a sub-table such as `.env` is not a server)
 *
 * → brain/_index/mcp-servers.json { schema: 1, updatedAt, servers: [{ name, host, transport, command | url, scope,
 *   enabled }] }. `command` is the program alone (`~/…` under home), never its arguments or environment, and a URL loses
 *   its credentials, query and fragment and has a token-like path segment hidden (cleanUrl): arguments, env, headers
 *   and URLs can hold secrets, and the list is for showing. A run for one host replaces that host's rows and keeps the
 *   other's. The vault's own `agenticos` server is left out (it is on every host the install wired). Host config is
 *   never written here. Project-scoped servers are out of scope.
 *
 * Codex declares a server in any form TOML allows: an `[mcp_servers.<name>]` table (with `.env` and other sub-tables),
 * an inline table under `[mcp_servers]` or in a top-level `mcp_servers = { … }`, or dotted keys
 * (`<name>.command = …`). codexServerMap reads every form, so a name is never missed; the listing shows what it can of
 * each (a dotted form's values are not read), and `aos mcp copy` (cli/mcp.js) refuses a dotted or doubly declared one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./common.js');

const MAX_FILE = 4 * 1024 * 1024;
const OWN = 'agenticos';

function outFile(vault) { return path.join(vault, 'brain', '_index', 'mcp-servers.json'); }

/**
 * Where Claude Code keeps its user-scope settings file: <config dir>/.claude.json for a config folder of its own (what
 * CLAUDE_CONFIG_DIR makes), ~/.claude.json beside the default ~/.claude (that file inside it when only it exists).
 */
function claudeUserFile({ dirs, home = os.homedir() }) {
  const dir = path.resolve(dirs.configDir);
  const inside = path.join(dir, '.claude.json');
  // Claude Code's own rule: only its default folder (the home's `.claude`) keeps the file beside it, in home.
  if (path.dirname(dir) !== path.resolve(home) || path.basename(dir) !== '.claude') return inside;
  const beside = path.join(home, '.claude.json');
  return fs.existsSync(beside) || !fs.existsSync(inside) ? beside : inside;
}

const HIDDEN = '<redacted>';
/** Known token prefixes (an argument or a path segment that starts so is a secret). */
const TOKEN_SHAPE = /^(sk-|sk_|rk_|pk_live|gh[pousr]_|github_pat_|glpat-|xox[abpsr]-|AKIA[0-9A-Z]{8}|AIza[0-9A-Za-z_-]{10}|eyJ[A-Za-z0-9_-]{8,}\.)/;
/** Words that make a name (a flag, a KEY=, a header, a JSON key, a path segment) say that its value is a secret. */
const SECRET_WORDS = new Set([
  'token', 'tokens', 'secret', 'secrets', 'pass', 'passwd', 'password', 'passwords', 'passphrase', 'pwd', 'key', 'keys', 'apikey',
  'auth', 'authorization', 'credential', 'credentials', 'creds', 'bearer', 'cookie', 'cookies', 'session', 'signature', 'sig', 'jwt', 'pat',
]);
/** A word that ends so is one too: accesstoken, clientsecret, dbpassword, xapikey, privatekey. */
const SECRET_ENDINGS = ['token', 'secret', 'password', 'passwd', 'apikey', 'privatekey', 'accesskey'];

/**
 * Whether a name says its value is a secret: its words (split at -, _, . and other separators and at camelCase), one of
 * which is a secret word or ends like one. `pass` and `api_key` are; `passthrough` and `author` are not.
 */
function secretName(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => SECRET_WORDS.has(w) || SECRET_ENDINGS.some((e) => w.length > e.length && w.endsWith(e)));
}

/**
 * Whether a bare value looks like a token: a known prefix; 32 or more hex digits; 32 or more lowercase letters and digits
 * with no separator; or 20 or more characters of base64 or URL-safe base64 with a digit, a lowercase and an uppercase
 * letter (a package name or a path has separators or one case; one that starts with / or ~ is a path).
 */
function tokenLike(v) {
  const s = String(v);
  if (TOKEN_SHAPE.test(s)) return true;
  if (/^[0-9a-fA-F]{32,}$/.test(s) || /^[a-z0-9]{32,}$/.test(s)) return true;
  return s.length >= 20 && !/^[/~.]/.test(s) && /^[A-Za-z0-9+/_.~-]+={0,2}$/.test(s) && /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}
/** A URL with an authority: `scheme://host…` (a header such as `Authorization: Bearer x` is not one). */
const URL_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+$/;

function decode(v) { try { return decodeURIComponent(v); } catch { return v; } }

/** A path segment that looks like a token: tokenLike, a value after a secret-named segment, 16 or more hex digits (a short
 *  key, `/v1/<key>`), or a long run of letters and digits (an API key in the path, `/<key>/sse`). */
function tokenSegment(seg, prev) {
  if (!seg) return false;
  const s = decode(seg);
  if (tokenLike(s) || /^[0-9a-fA-F]{16,}$/.test(s)) return true;
  if (prev && secretName(decode(prev)) && s.length >= 6) return true;
  return s.length >= 20 && /[0-9]/.test(s) && /[A-Za-z]/.test(s) && /^[A-Za-z0-9_.~+=-]+$/.test(s);
}

/**
 * A URL as it may be shown: credentials and a token-like path segment hidden, the fragment out, and the query dropped
 * (`query: 'drop'`, the listing) or each value hidden (`query: 'mask'`, a dry run). → { shown, secrets }, `shown` null
 * when it is not a `scheme://host…` URL; `secrets` are the parts hidden, raw and decoded, for a scrub.
 */
function maskUrl(u, { query = 'drop' } = {}) {
  const text = String(u);
  if (!URL_SHAPE.test(text)) return { shown: null, secrets: [] };
  let x;
  try { x = new URL(text); } catch { return { shown: null, secrets: [] }; }
  if (!x.host) return { shown: null, secrets: [] };
  const secrets = [];
  const add = (v) => { if (v) { secrets.push(v); const d = decode(v); if (d !== v) secrets.push(d); } };
  const auth = !!(x.username || x.password);
  add(x.username);
  add(x.password);
  const segs = x.pathname.split('/');
  const path_ = segs.map((seg, i) => (tokenSegment(seg, segs[i - 1]) ? (add(seg), HIDDEN) : seg)).join('/');
  const pairs = x.search ? x.search.slice(1).split('&').filter(Boolean).map((kv) => { const eq = kv.indexOf('='); return eq === -1 ? [kv, ''] : [kv.slice(0, eq), kv.slice(eq + 1)]; }) : [];
  for (const [, v] of pairs) add(v);
  if (x.hash.length > 1) add(x.hash.slice(1));
  const q = query === 'mask' && pairs.length ? `?${pairs.map(([k, v]) => (v ? `${k}=${HIDDEN}` : k)).join('&')}` : '';
  const shown = `${x.protocol}//${auth && query === 'mask' ? `${HIDDEN}@` : ''}${x.host}${path_}${q}`;
  return { shown, secrets };
}

/** A URL for the listing: no credentials, query or fragment, a token-like path segment hidden; null when it does not parse. */
function cleanUrl(u) { return maskUrl(u, { query: 'drop' }).shown; }

function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

function row(name, host, spec, home) {
  const url = str(spec.url) ? cleanUrl(spec.url) : null;
  const command = str(spec.command);
  const type = str(spec.type) || str(spec.transport) || (url ? 'http' : 'stdio');
  return {
    name, host,
    transport: ['stdio', 'http', 'sse'].includes(type) ? type : (url ? 'http' : 'stdio'),
    ...(url ? { url } : { command: command ? (path.isAbsolute(command) ? C.tilde(command, home) : command) : null }),
    scope: 'user',
    enabled: spec.enabled !== false && spec.disabled !== true,
  };
}

function claudeServers(opts) {
  const file = claudeUserFile(opts);
  const j = C.readJson(file);
  const servers = j && j.mcpServers && typeof j.mcpServers === 'object' && !Array.isArray(j.mcpServers) ? j.mcpServers : {};
  const out = [];
  for (const [name, spec] of Object.entries(servers)) {
    if ((name === OWN && !opts.keepOwn) || !spec || typeof spec !== 'object') continue;
    out.push(row(name, 'claude', spec, opts.home));
  }
  return { file, servers: out };
}

const TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/;
const ANY_TABLE = /^\s*\[/;
const SERVERS = 'mcp_servers';

/**
 * config.toml as its tables: [{ table: null for the top | 'a.b.c', top, dotted }], each parsed with agent-translate's
 * TOML reader. A header line is one the reader parses as a header, and the headers found must be exactly the ones the
 * whole file has (a `[` that opens a line inside a multi-line array is not one). Throws when the file does not parse
 * or cannot be split so.
 */
function codexSections(text) {
  const { parseToml } = require('../agent-translate.js');
  const t = String(text).replace(/\r\n/g, '\n');
  const whole = parseToml(t);
  const out = [{ table: null, lines: [] }];
  for (const line of t.split('\n')) {
    let name;
    if (ANY_TABLE.test(line)) { try { name = parseToml(line).tables[0]; } catch { name = undefined; } }
    if (name !== undefined) out.push({ table: name, lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  if (out.slice(1).map((x) => x.table).join('\n') !== whole.tables.join('\n')) throw new Error('its tables could not be told apart line by line');
  return out.map((x) => ({ table: x.table, ...parseToml(x.lines.join('\n')) }));
}

/**
 * Every server config.toml declares, by name: { name, forms: Set<'table'|'inline'|'dotted'>, spec (the keys read, from a
 * table or an inline table), env (its `.env` sub-table, or an inline table's `env.K` keys), dotted (dotted keys in its
 * own table, whose values are not read), subtables (its other sub-tables) }. Throws when the file does not parse.
 */
function codexServerMap(text) {
  const map = new Map();
  const get = (n) => map.get(n) || map.set(n, { name: n, forms: new Set(), spec: null, env: {}, dotted: [], subtables: [] }).get(n);
  const inline = (n, obj) => {
    const e = get(n);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { e.forms.add('dotted'); return; }
    e.forms.add('inline');
    const spec = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('env.')) e.env[k.slice(4)] = v;
      else if (k.includes('.')) e.dotted.push(k);
      else spec[k] = v;
    }
    e.spec = spec;
  };
  for (const sec of codexSections(text)) {
    if (sec.table === null) {
      const top = sec.top[SERVERS];
      if (top && typeof top === 'object' && !Array.isArray(top)) {
        for (const [k, v] of Object.entries(top)) { if (k.includes('.')) get(k.split('.')[0]).forms.add('dotted'); else inline(k, v); }
      }
      for (const d of sec.dotted) if (d.startsWith(`${SERVERS}.`)) get(d.slice(SERVERS.length + 1).split('.')[0]).forms.add('dotted');
    } else if (sec.table === SERVERS) {
      for (const [k, v] of Object.entries(sec.top)) inline(k, v);
      for (const d of sec.dotted) get(d.split('.')[0]).forms.add('dotted');
    } else if (sec.table.startsWith(`${SERVERS}.`)) {
      const [n, sub, ...rest] = sec.table.slice(SERVERS.length + 1).split('.');
      const e = get(n);
      if (sub === undefined) {
        e.forms.add('table');
        e.spec = { ...(e.spec || {}), ...sec.top };
        e.dotted.push(...sec.dotted);
      } else if (sub === 'env' && !rest.length) {
        Object.assign(e.env, sec.top);
        e.dotted.push(...sec.dotted.map((d) => `env.${d}`));
      } else e.subtables.push([sub, ...rest].join('.'));
    }
  }
  return map;
}

/** The names a config.toml that does not parse declares, from its `[mcp_servers.<name>]` headers alone (best effort). */
function codexHeaderNames(text) {
  const names = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const m = TABLE.exec(line);
    if (!m) continue;
    let name;
    try { name = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] !== undefined ? m[2] : m[3]; } catch { continue; }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function codexServers({ dirs, home, keepOwn = false, file: at = null }) {
  const file = at || path.join(dirs.configDir, 'config.toml');
  const text = C.readRegular(file, MAX_FILE);
  const out = [];
  if (text === null) return { file, servers: out };
  let map = null;
  try { map = codexServerMap(text); } catch { map = null; }
  if (!map) {
    for (const name of codexHeaderNames(text)) if (name !== OWN || keepOwn) out.push(row(name, 'codex', {}, home));
    return { file, servers: out };
  }
  for (const e of map.values()) {
    if (e.name === OWN && !keepOwn) continue;
    out.push(row(e.name, 'codex', { ...(e.spec || {}), ...(Object.keys(e.env).length ? { env: e.env } : {}) }, home));
  }
  return { file, servers: out };
}

/** The servers one host declares (module comment). opts.keepOwn keeps the vault's own server (lib/connectors lists it);
 *  opts.file reads another config.toml (a Codex project's .codex/config.toml). */
function listServers(host, opts) {
  return host === 'codex' ? codexServers(opts) : claudeServers(opts);
}

/** Write the listing for `hosts`, keeping the other host's rows. ifChanged (lib/connectors, on every scan) leaves an
 *  unchanged listing as it is. → { file, servers, written } */
function writeServers(vault, hosts, byHost, { now = new Date(), ifChanged = false } = {}) {
  const prev = C.readJson(outFile(vault));
  const kept = prev && Array.isArray(prev.servers) ? prev.servers.filter((s) => s && !hosts.includes(s.host)) : [];
  const servers = [...kept, ...hosts.flatMap((h) => byHost[h] || [])]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.host < b.host ? -1 : 1));
  if (ifChanged && prev && prev.schema === C.SCHEMA && JSON.stringify(prev.servers) === JSON.stringify(servers)) return { file: outFile(vault), servers, written: false };
  require('../fsx.js').writeAtomic(outFile(vault), JSON.stringify({ schema: C.SCHEMA, updatedAt: now.toISOString(), servers }, null, 2) + '\n');
  return { file: outFile(vault), servers, written: true };
}

module.exports = {
  listServers, writeServers, claudeUserFile, cleanUrl, maskUrl, codexSections, codexServerMap, outFile, HIDDEN, TOKEN_SHAPE, secretName, tokenLike,
  serverRow: row, OWN,
};
