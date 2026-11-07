'use strict';
/**
 * hud-host.js — where the Workbench runs and how to link into it (spec 2026-10-05-workbench-app-design D11). Pure:
 * no writes, no network.
 *
 * The UniDeX app records itself in <vault>/brain/_index/hud-host.json each time it starts, so doctor and
 * the update check can see which app version the vault is used with without knowing where the app is installed.
 * Links into the Workbench are agenticos:// URLs, which the app registers: one helper builds them for the status
 * line and the proposal pages, so the two never disagree.
 */
const fs = require('fs');
const path = require('path');

const MARKER_REL = 'brain/_index/hud-host.json';
const SCHEMA = 1;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The app's record in the vault, or null. A marker that does not parse, names another schema or host, or carries no
 * orderable version counts as absent: the update check must never compare against a version it cannot order.
 */
function readMarker(vault) {
  if (!vault) return null;
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(vault, MARKER_REL), 'utf8')); } catch { return null; }
  if (!m || typeof m !== 'object' || m.schema !== SCHEMA || m.host !== 'app') return null;
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) return null;
  const marker = {
    schema: m.schema,
    host: m.host,
    name: typeof m.name === 'string' && m.name ? m.name : null,
    version: m.version,
    at: typeof m.at === 'string' ? m.at : null,
  };
  // agent-computer D26: where the app's computer bridge listens, when it does.
  if (typeof m.computerSocket === 'string' && m.computerSocket) marker.computerSocket = m.computerSocket;
  return marker;
}

/** Link builders: a Workbench tab by rail id, and a vault file by its vault-relative path. */
function links() {
  return {
    tab: (id) => `agenticos://workbench?tab=${encodeURIComponent(id)}`,
    file: (rel) => `agenticos://note?file=${encodeURIComponent(rel)}`,
  };
}

module.exports = { MARKER_REL, SCHEMA, readMarker, links };
