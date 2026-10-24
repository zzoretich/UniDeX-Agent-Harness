'use strict';
/**
 * connectors/index.js — the Connectors tab's caches (connectors-tab D8, D14), refreshed from files alone by
 * scan-vault.js on every scan and by `aos mcp list`; the live check (check.js) is `aos mcp check`.
 *
 *   refresh({ vault, cfg, env, home, now }) → { connectors, usage }
 *     brain/_index/connectors.json        { schema, updatedAt, hosts, rows }   discover.js, with the last check's
 *                                                                                claude.ai names carried in
 *     brain/_index/connectors-usage.json  usage.js's rows (its index beside it)
 *     brain/_index/mcp-servers.json       today's listing, unchanged (user-scope servers, the vault's own left out), so
 *                                          an older app's Skills section keeps working until it is retired (D14)
 *   `cfg` is the merged config (defaults, the vault's config.json, agenticos.json): hosts, claudeConfigDir and
 *   connectors.* are read from it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fsx = require('../fsx.js');
const H = require('../host.js');
const M = require('../import/mcp.js');
const D = require('./discover.js');
const U = require('./usage.js');
const K = require('./check.js');

const SCHEMA = 1;

function connectorsFile(vault) { return path.join(vault, 'brain', '_index', 'connectors.json'); }

/** Write `body` (with updatedAt) unless the file already holds the same body: a scan every 15 minutes must not fire a
 *  vault change, and the Workbench's redraw, when nothing changed. → whether it wrote */
function writeIfChanged(file, body, now) {
  try {
    const rest = { ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    delete rest.updatedAt;
    if (JSON.stringify(rest) === JSON.stringify(body)) return false;
  } catch { /* missing or unreadable: write it */ }
  fsx.writeAtomic(file, JSON.stringify({ schema: body.schema, updatedAt: new Date(now).toISOString(), ...body }, null, 2) + '\n');
  return true;
}

function refresh({ vault, cfg = {}, env = process.env, home = os.homedir(), now = Date.now() } = {}) {
  const userConfig = cfg;
  const live = K.readLive(vault);
  const found = D.discover({ vault, userConfig, env, home, live });
  const body = { schema: SCHEMA, hosts: found.hosts, rows: found.rows };
  writeIfChanged(connectorsFile(vault), body, now);
  const connectors = { schema: SCHEMA, updatedAt: new Date(now).toISOString(), hosts: found.hosts, rows: found.rows };

  const on = H.HOSTS.filter((h) => found.hosts[h] && found.hosts[h].enabled);
  const byHost = {};
  for (const h of on) byHost[h] = M.listServers(h, { env, userConfig, dirs: H.hostDirs(h, { env, userConfig }), home }).servers;
  M.writeServers(vault, on, byHost, { now: new Date(now), ifChanged: true });

  const days = (cfg.connectors && cfg.connectors.usageDays) || 30;
  const usage = U.collectUsage({ vault, userConfig, env, now, days, rows: found.rows, hosts: on });
  return { connectors, usage };
}

module.exports = { refresh, connectorsFile, writeIfChanged, SCHEMA };
