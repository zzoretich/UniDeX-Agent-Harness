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
 *   its query and credentials: arguments, env and headers can hold secrets, and the list is for showing. A run for one
 *   host replaces that host's rows and keeps the other's. The vault's own `agenticos` server is left out (it is on every
 *   host the install wired). Host config is never written here. Project-scoped servers are out of scope.
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

/** A URL without its query, fragment or credentials; null when it does not parse. */
function cleanUrl(u) {
  try {
    const x = new URL(String(u));
    x.username = '';
    x.password = '';
    x.search = '';
    x.hash = '';
    return x.toString();
  } catch { return null; }
}

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
    if (name === OWN || !spec || typeof spec !== 'object') continue;
    out.push(row(name, 'claude', spec, opts.home));
  }
  return { file, servers: out };
}

const TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/;
const ANY_TABLE = /^\s*\[/;

function codexServers({ dirs, home }) {
  const file = path.join(dirs.configDir, 'config.toml');
  const text = C.readRegular(file, MAX_FILE);
  const out = [];
  if (text === null) return { file, servers: out };
  const { parseToml } = require('../agent-translate.js');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = TABLE.exec(lines[i]);
    if (!m) continue;
    let name;
    try { name = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] !== undefined ? m[2] : m[3]; } catch { continue; }
    let j = i + 1;
    while (j < lines.length && !ANY_TABLE.test(lines[j])) j++;
    let spec = {};
    try { spec = parseToml(lines.slice(i + 1, j).join('\n')).top; } catch { spec = {}; }
    if (name !== OWN && !out.some((s) => s.name === name)) out.push(row(name, 'codex', spec, home));
    i = j - 1;
  }
  return { file, servers: out };
}

/** The servers one host declares (module comment). */
function listServers(host, opts) {
  return host === 'codex' ? codexServers(opts) : claudeServers(opts);
}

/** Write the listing for `hosts`, keeping the other host's rows. → { file, servers, counts: { host: n } } */
function writeServers(vault, hosts, byHost, { now = new Date() } = {}) {
  const prev = C.readJson(outFile(vault));
  const kept = prev && Array.isArray(prev.servers) ? prev.servers.filter((s) => s && !hosts.includes(s.host)) : [];
  const servers = [...kept, ...hosts.flatMap((h) => byHost[h] || [])]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.host < b.host ? -1 : 1));
  require('../fsx.js').writeAtomic(outFile(vault), JSON.stringify({ schema: C.SCHEMA, updatedAt: now.toISOString(), servers }, null, 2) + '\n');
  return { file: outFile(vault), servers };
}

module.exports = { listServers, writeServers, claudeUserFile, cleanUrl, outFile };
