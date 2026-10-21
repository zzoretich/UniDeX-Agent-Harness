'use strict';
/**
 * node-path.js — the Node path AgenticOS records in agenticos.json and renders into the routine schedules
 * (spec 2026-10-05-workbench-app-design D12). Zero dependencies.
 *
 * Homebrew runs Node from a versioned folder, <prefix>/Cellar/<formula>/<version>/bin/node, which `brew upgrade` deletes,
 * so a recorded Cellar path breaks every hook and schedule on the next upgrade. Homebrew also keeps a stable link,
 * <prefix>/opt/<formula>/bin/node, that follows the installed version: record that one instead, but only when it
 * resolves to the very binary that is running, so the recorded Node is never a different version. A recorded Node that
 * is already gone (the upgrade ran) has no version left to keep, so its link, the one Node that still runs, stands in.
 *
 * The app's wizard installs a Node of its own the same way (install-import B1): ~/.local/share/unidex/node/<version>,
 * with a `current` link the app moves when it brings a newer one. A node run through that link reports the versioned
 * path, so record `current/bin/node` instead, under the same rule.
 *
 * The persona interview renders `{{NODE}}` into the duty files (persona/duties/*.md) once, and the owner edits them from
 * then on; before this module they got the versioned path. CELLAR_TEXT_RE finds every such path inside a text, and
 * replaceCellarPaths puts the recorded Node in its place and nothing else (cli/migrations.js repairDutyNode).
 */
const fs = require('fs');

const CELLAR_RE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;
const UNIDEX_RE = /^(.*\/unidex\/node)\/([^/]+)\/bin\/node$/;
/**
 * CELLAR_RE's shape anywhere in a text: a path that starts at its own `/` (not inside a longer word or path), holds no
 * whitespace, quote or bracket, ends in /Cellar/<formula>/<version>/bin/node, and is not the start of a longer name
 * (node.js, node-gyp, node/…). A prefix with whitespace never matches: Homebrew refuses such a prefix.
 */
const CELLAR_TEXT_RE = /(?<![\w.@+~/-])\/(?:[^\s/`'"()]+\/)*Cellar\/[^\s/]+\/[^\s/]+\/bin\/node(?![\w/-]|\.\w)/g;

/** The stable link for a versioned node (Homebrew's opt, the app's current) when one resolves to the same file. */
function stableLink(execPath) {
  const p = String(execPath || '');
  const m = CELLAR_RE.exec(p);
  if (m) return `${m[1]}/opt/${m[2]}/bin/node`;
  const u = UNIDEX_RE.exec(p);
  return u && u[2] !== 'current' ? `${u[1]}/current/bin/node` : null;
}

/**
 * The stable link for a versioned node when it resolves to the same file, or when that node is gone and the link is
 * there (brew upgrade deleted the folder; the app moved `current` on); otherwise execPath unchanged.
 */
function stableNode(execPath, fsImpl = fs) {
  const link = stableLink(execPath);
  if (!link) return execPath;
  try {
    if (!fsImpl.existsSync(link)) return execPath;
    if (!fsImpl.existsSync(execPath)) return link;
    return fsImpl.realpathSync(link) === fsImpl.realpathSync(execPath) ? link : execPath;
  } catch { return execPath; }
}

/** True for a path inside Homebrew's versioned Cellar: one `brew upgrade` away from missing. */
function isCellarPath(p) { return typeof p === 'string' && p.includes('/Cellar/'); }

/** The distinct versioned Cellar nodes in a text, in order of first appearance. */
function cellarPathsIn(text) { return [...new Set(String(text).match(CELLAR_TEXT_RE) || [])]; }

/** `text` with `node` in place of every versioned Cellar node in it, every other character as it was. */
function replaceCellarPaths(text, node) { return String(text).replace(CELLAR_TEXT_RE, () => node); }

module.exports = { stableNode, isCellarPath, cellarPathsIn, replaceCellarPaths, CELLAR_RE, CELLAR_TEXT_RE, UNIDEX_RE };
