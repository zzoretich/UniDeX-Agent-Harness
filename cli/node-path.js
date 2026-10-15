'use strict';
/**
 * node-path.js — the Node path AgenticOS records in agenticos.json and renders into the routine schedules
 * (spec 2026-10-05-workbench-app-design D12). Zero dependencies.
 *
 * Homebrew runs Node from a versioned folder, <prefix>/Cellar/<formula>/<version>/bin/node, which `brew upgrade` deletes,
 * so a recorded Cellar path breaks every hook and schedule on the next upgrade. Homebrew also keeps a stable link,
 * <prefix>/opt/<formula>/bin/node, that follows the installed version: record that one instead, but only when it
 * resolves to the very binary that is running, so the recorded Node is never a different version.
 *
 * The app's wizard installs a Node of its own the same way (install-import B1): ~/.local/share/unidex/node/<version>,
 * with a `current` link the app moves when it brings a newer one. A node run through that link reports the versioned
 * path, so record `current/bin/node` instead, under the same rule.
 */
const fs = require('fs');

const CELLAR_RE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;
const UNIDEX_RE = /^(.*\/unidex\/node)\/([^/]+)\/bin\/node$/;

/** The stable link for a versioned node (Homebrew's opt, the app's current) when one resolves to the same file. */
function stableLink(execPath) {
  const p = String(execPath || '');
  const m = CELLAR_RE.exec(p);
  if (m) return `${m[1]}/opt/${m[2]}/bin/node`;
  const u = UNIDEX_RE.exec(p);
  return u && u[2] !== 'current' ? `${u[1]}/current/bin/node` : null;
}

/** The stable link for a versioned node when it resolves to the same file; otherwise execPath unchanged. */
function stableNode(execPath, fsImpl = fs) {
  const link = stableLink(execPath);
  if (!link) return execPath;
  try {
    if (!fsImpl.existsSync(link)) return execPath;
    return fsImpl.realpathSync(link) === fsImpl.realpathSync(execPath) ? link : execPath;
  } catch { return execPath; }
}

/** True for a path inside Homebrew's versioned Cellar: one `brew upgrade` away from missing. */
function isCellarPath(p) { return typeof p === 'string' && p.includes('/Cellar/'); }

module.exports = { stableNode, isCellarPath, CELLAR_RE, UNIDEX_RE };
