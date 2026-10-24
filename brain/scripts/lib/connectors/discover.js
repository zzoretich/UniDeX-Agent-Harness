'use strict';
/**
 * connectors/discover.js — every MCP server and connector each enabled host can use, from files alone (connectors-tab
 * D7, D8, D11): no spawn, no network and no model call, so scan-vault.js runs it on every refresh.
 *
 *   discover({ vault, userConfig, env, home, hosts, live }) → { hosts: { <h>: { enabled, rows: n } }, rows }
 *   row: { host, name, kind: 'server' | 'connector', transport, command | url, scope, file, enabled,
 *          plugin?, workspace?, approval?, own?, displayName?, connectorId?, unverified? }
 *     `command` is the program alone and `url` has its credentials, query and token-like segments out (lib/import/mcp.js
 *     serverRow): arguments, environment and headers are never read into a row. `file` is `~/…` under home.
 *
 *   Claude Code
 *     user      `mcpServers` at the top of .claude.json (lib/import/mcp.js claudeUserFile)
 *     local     `projects[<folder>].mcpServers` in .claude.json, for each workspace folder (and its `repo:` folder)
 *     project   `<folder>/.mcp.json`; approval `approved` when .claude.json's `projects[<folder>]` lists it in
 *               enabledMcpjsonServers (or enableAllProjectMcpServers is true there), `off` when it lists it in
 *               disabledMcpjsonServers, else `pending`: the check never starts a pending one (D11)
 *     plugin    enabled plugins' servers (plugins.js), named `plugin:<plugin>:<server>` as `claude mcp list` names them
 *     account   claude.ai connectors, which are in no file: the names the last check saw (`live`), else, before any
 *               check, .claude.json's `claudeAiMcpEverConnected`, marked `unverified`
 *   Codex
 *     user      config.toml's `[mcp_servers.*]` in every form (lib/import/mcp.js codexServerMap)
 *     project   `<folder>/.codex/config.toml`, read only when config.toml's `[projects."<folder>"]` has
 *               trust_level = "trusted" (D11)
 *     plugin    enabled plugins' `.mcp.json` servers (plugins.js)
 *     account   enabled plugins' `.app.json` apps (ChatGPT connectors), named by the plugin's display name
 *   The vault's own `agenticos` server is listed with `own: true` (the board shows it; no action takes it).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../host.js');
const S = require('../skills.js');
const M = require('../import/mcp.js');
const C = require('../import/common.js');
const P = require('./plugins.js');

const CLAUDE_AI = 'claude.ai ';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

/** `~/…` for a path under home, else the path; null stays null. */
function shown(p, home) { return p ? C.tilde(p, home) : null; }

/** A path written in a workspace.md: `~/…` under home, a relative one under the workspace. */
function expand(p, home, base) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

/**
 * The folders whose project-scoped servers count: each `workspaces/<name>` (not `_` folders) and the `repo:` folder its
 * workspace.md names. → [{ workspace, dir }]
 */
function workspaceFolders(vault, home) {
  const root = path.join(vault, 'workspaces');
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')).map((e) => e.name); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    const dir = path.join(root, name);
    out.push({ workspace: name, dir });
    const md = C.readRegular(path.join(dir, 'workspace.md'), 64 * 1024);
    const fm = md && /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
    const repo = fm && /^repo:\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/m.exec(fm[1]);
    if (repo) {
      const r = expand(repo[1].trim(), home, dir);
      if (r !== dir) out.push({ workspace: name, dir: r });
    }
  }
  return out;
}

/** Which of `names` .claude.json's entry for a folder approves (listed or all), turns off, or leaves pending. */
function approvalOf(entry, name) {
  if (!isObj(entry)) return 'pending';
  if (Array.isArray(entry.disabledMcpjsonServers) && entry.disabledMcpjsonServers.includes(name)) return 'off';
  if (entry.enableAllProjectMcpServers === true) return 'approved';
  if (Array.isArray(entry.enabledMcpjsonServers) && entry.enabledMcpjsonServers.includes(name)) return 'approved';
  return 'pending';
}

function claudeRows({ vault, home, dirs, r, live }) {
  const rows = [];
  const userFile = M.claudeUserFile({ dirs, home });
  const json = C.readJson(userFile) || {};
  for (const s of M.listServers('claude', { dirs, home, keepOwn: true }).servers) {
    rows.push({ ...s, kind: 'server', file: shown(userFile, home), ...(s.name === M.OWN ? { own: true } : {}) });
  }
  const projects = isObj(json.projects) ? json.projects : {};
  for (const f of workspaceFolders(vault, home)) {
    const entry = projects[f.dir];
    if (isObj(entry) && isObj(entry.mcpServers)) {
      for (const [name, spec] of Object.entries(entry.mcpServers)) {
        if (isObj(spec)) rows.push({ ...M.serverRow(name, 'claude', spec, home), kind: 'server', scope: 'local', file: shown(userFile, home), workspace: f.workspace });
      }
    }
    const mcpJson = path.join(f.dir, '.mcp.json');
    for (const [name, spec] of Object.entries(P.serverMap(C.readJson(mcpJson)))) {
      const approval = approvalOf(entry, name);
      rows.push({
        ...M.serverRow(name, 'claude', spec, home), kind: 'server', scope: 'project', file: shown(mcpJson, home), workspace: f.workspace, approval,
        ...(approval === 'off' ? { enabled: false } : {}),
      });
    }
  }
  for (const p of P.claudePluginServers(r)) {
    for (const [server, spec] of Object.entries(p.servers)) {
      rows.push({
        ...M.serverRow(`plugin:${p.plugin}:${server}`, 'claude', spec, home), kind: 'server', scope: 'plugin', file: shown(p.file, home), plugin: p.plugin,
        ...(p.plugin === M.OWN && server === M.OWN ? { own: true } : {}),
      });
    }
  }
  // claude.ai connectors: the last check's names, else the ones this account ever connected (unverified).
  const seen = live && Array.isArray(live.rows) ? live.rows.filter((x) => x && x.host === 'claude' && typeof x.name === 'string' && x.name.startsWith(CLAUDE_AI)) : [];
  const names = seen.length ? seen.map((x) => x.name) : (Array.isArray(json.claudeAiMcpEverConnected) ? json.claudeAiMcpEverConnected.filter((n) => typeof n === 'string' && n.startsWith(CLAUDE_AI)) : []);
  for (const name of [...new Set(names)]) {
    rows.push({
      host: 'claude', name, kind: 'connector', transport: 'http', url: null, scope: 'account', file: null, enabled: true,
      displayName: name.slice(CLAUDE_AI.length), ...(seen.length ? {} : { unverified: true }),
    });
  }
  return rows;
}

/** The folders config.toml marks trusted: `[projects."<folder>"]` with trust_level = "trusted". */
function trustedFolders(toml) {
  const out = new Set();
  let cur = null;
  for (const line of String(toml || '').split(/\r?\n/)) {
    const sec = /^\s*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*(?:#.*)?$/.exec(line);
    if (sec) {
      try { cur = sec[1] !== undefined ? JSON.parse(`"${sec[1]}"`) : sec[2]; } catch { cur = null; }
      continue;
    }
    if (/^\s*\[/.test(line)) { cur = null; continue; }
    if (cur && /^\s*trust_level\s*=\s*["']trusted["']/.test(line)) out.add(path.resolve(cur));
  }
  return out;
}

function codexRows({ vault, home, dirs, r }) {
  const rows = [];
  const file = path.join(dirs.configDir, 'config.toml');
  for (const s of M.listServers('codex', { dirs, home, keepOwn: true }).servers) {
    rows.push({ ...s, kind: 'server', file: shown(file, home), ...(s.name === M.OWN ? { own: true } : {}) });
  }
  const trusted = trustedFolders(C.readRegular(file, 4 * 1024 * 1024));
  for (const f of workspaceFolders(vault, home)) {
    if (!trusted.has(path.resolve(f.dir))) continue;
    const local = path.join(f.dir, '.codex', 'config.toml');
    for (const s of M.listServers('codex', { dirs, home, file: local }).servers) {
      rows.push({ ...s, kind: 'server', scope: 'project', file: shown(local, home), workspace: f.workspace });
    }
  }
  for (const p of P.codexPlugins(r)) {
    for (const [server, spec] of Object.entries(p.servers)) {
      rows.push({
        ...M.serverRow(server, 'codex', spec, home), kind: 'server', scope: 'plugin', file: shown(p.file, home), plugin: p.plugin,
        ...(p.plugin === M.OWN && server === M.OWN ? { own: true } : {}),
      });
    }
    for (const a of p.apps) {
      rows.push({
        host: 'codex', name: a.name, kind: 'connector', transport: 'http', url: null, scope: 'account', file: shown(p.file || p.root, home),
        enabled: true, plugin: p.plugin, displayName: a.displayName, ...(a.id ? { connectorId: a.id } : {}),
      });
    }
  }
  return rows;
}

/** Every row of every host `hosts` names (default: the enabled ones). */
function discover({ vault, userConfig = null, env = process.env, home = os.homedir(), hosts = null, live = null } = {}) {
  // A config without `hosts` (pre-0.5.0) names none: Claude Code, as lib/skills.js reads it.
  const on = hosts || (H.enabledHosts(userConfig).length ? H.enabledHosts(userConfig) : ['claude']);
  const r = S.roots({ userCfg: userConfig, env, home });
  const out = { hosts: {}, rows: [] };
  for (const host of H.HOSTS) {
    const enabled = on.includes(host);
    out.hosts[host] = { enabled, rows: 0 };
    if (!enabled) continue;
    const dirs = H.hostDirs(host, { env, userConfig });
    const rows = host === 'codex' ? codexRows({ vault, home, dirs, r }) : claudeRows({ vault, home, dirs, r, live });
    out.hosts[host].rows = rows.length;
    out.rows.push(...rows);
  }
  out.rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return out;
}

module.exports = { discover, workspaceFolders, trustedFolders, approvalOf, CLAUDE_AI };
