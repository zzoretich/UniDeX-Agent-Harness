'use strict';
/**
 * connectors/plugins.js — what each host's enabled plugins bring besides skills: MCP servers, and on Codex the
 * connectors (ChatGPT apps) a plugin names in its `.app.json` (connectors-tab D7). Files only.
 *
 *   claudePluginServers(r) → [{ plugin, root, file, servers: { <name>: spec } }]
 *     The plugins lib/skills.js claudePlugins finds installed and enabled. A plugin declares servers in `.mcp.json` at
 *     its root, as a flat `{ <name>: spec }` map or `{ mcpServers: { … } }`, or as `mcpServers` in
 *     .claude-plugin/plugin.json: an object of the same, or a path inside the plugin to a file of either shape.
 *   codexPlugins(r) → [{ plugin, market, root, displayName, file, servers, apps: [{ name, id, displayName }] }]
 *     config.toml's `[plugins."<plugin>@<market>"]` sections whose `enabled` is not false (lib/skills.js
 *     codexEnabledPlugins), each at its newest cached version that has a manifest (an apps-only plugin has no
 *     skills/), with .codex-plugin/plugin.json's `mcpServers` and `apps` paths (default ./.mcp.json, ./.app.json) and
 *     its interface.displayName, which names a plugin's one app.
 *   `r` is lib/skills.js roots(). A path a manifest names outside its plugin's folder is not read.
 */
const fs = require('fs');
const path = require('path');
const S = require('../skills.js');

const MAX_FILE = 1024 * 1024;

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

function readJson(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

/** The servers in an `.mcp.json`-shaped value: `{ mcpServers: { … } }` or a flat map; an entry names a command or a URL. */
function serverMap(j) {
  if (!isObj(j)) return {};
  const m = isObj(j.mcpServers) ? j.mcpServers : j;
  const out = {};
  for (const [name, spec] of Object.entries(m)) {
    if (isObj(spec) && (str(spec.command) || str(spec.url))) out[name] = spec;
  }
  return out;
}

/** A path a manifest names, resolved inside the plugin's folder, else null. */
function inRoot(root, rel) {
  if (!str(rel)) return null;
  const p = path.resolve(root, rel);
  const r = path.relative(path.resolve(root), p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? p : null;
}

function claudePluginServers(r) {
  const out = [];
  for (const p of S.claudePlugins(r)) {
    const manifest = readJson(path.join(p.root, '.claude-plugin', 'plugin.json')) || {};
    let file = path.join(p.root, '.mcp.json');
    let servers = serverMap(readJson(file));
    if (isObj(manifest.mcpServers)) {
      servers = { ...servers, ...serverMap({ mcpServers: manifest.mcpServers }) };
      if (!fs.existsSync(file)) file = path.join(p.root, '.claude-plugin', 'plugin.json');
    } else if (str(manifest.mcpServers)) {
      const f = inRoot(p.root, manifest.mcpServers);
      if (f) { file = f; servers = serverMap(readJson(f)); }
    }
    if (Object.keys(servers).length) out.push({ plugin: p.plugin, root: p.root, file, servers });
  }
  return out;
}

function codexPlugins(r) {
  let toml;
  try { toml = fs.readFileSync(r.codexConfig, 'utf8'); } catch { return []; }
  const out = [];
  for (const p of S.codexEnabledPlugins(toml)) {
    const root = S.codexPluginRoot(r.codexPluginCache, p, (v) => fs.existsSync(path.join(v, '.codex-plugin', 'plugin.json')));
    if (!root) continue;
    const m = readJson(path.join(root, '.codex-plugin', 'plugin.json')) || {};
    const displayName = str(m.interface && m.interface.displayName) || p.plugin;
    const file = inRoot(root, str(m.mcpServers) || './.mcp.json');
    const servers = file ? serverMap(readJson(file)) : {};
    const appFile = inRoot(root, str(m.apps) || './.app.json');
    const appJson = appFile ? readJson(appFile) : null;
    const entries = isObj(appJson && appJson.apps) ? Object.entries(appJson.apps).filter(([, v]) => isObj(v)) : [];
    const apps = entries.map(([name, v]) => ({ name, id: str(v.id), displayName: entries.length === 1 ? displayName : name }));
    if (Object.keys(servers).length || apps.length) out.push({ plugin: p.plugin, market: p.market, root, displayName, file, servers, apps });
  }
  return out;
}

module.exports = { claudePluginServers, codexPlugins, serverMap };
