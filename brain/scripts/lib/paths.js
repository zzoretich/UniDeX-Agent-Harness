'use strict';
/**
 * paths.js — the ONLY vault resolver. Resolution order:
 *   1. AOS_VAULT env (BRAIN_VAULT accepted as a legacy alias)
 *   2. "vault" in <claudeConfigDir>/agenticos.json (AOS_CONFIG overrides that file's path)
 *   3. walk up from this file (at most 8 levels) until a dir has brain/_index (the one marker every
 *      vault-template vault carries; a CLAUDE.md + brain/ checkout is NOT a vault)
 *   4. throw VaultNotFound — hook scripts catch it (lib/hook-entry.js) and exit 0
 * There is no personal fallback. Depth-independent: works from brain/scripts/* and brain/scripts/sdk/lib/*.
 * Under the Node test runner it resolves nothing real (lib/test-guard.js): without the test environment it throws
 * UnsafeTestEnv, and with it a test still names its vault or config (AOS_VAULT / BRAIN_VAULT, AOS_CONFIG or
 * CLAUDE_CONFIG_DIR; test/setup.js does), never the owner's default agenticos.json.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

class VaultNotFound extends Error {
  constructor(msg) { super(msg); this.name = 'VaultNotFound'; this.code = 'VAULT_NOT_FOUND'; }
}

function claudeConfigDir() {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}
function configFile() {
  return path.resolve(process.env.AOS_CONFIG || path.join(claudeConfigDir(), 'agenticos.json'));
}
function readUserConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return null; }
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function looksLikeVault(dir) {
  return isDir(path.join(dir, 'brain', '_index'));
}

function detectVault() {
  const env = process.env.AOS_VAULT || process.env.BRAIN_VAULT;
  if (env && isDir(env)) return path.resolve(env);
  const cfg = readUserConfig();
  if (cfg && typeof cfg.vault === 'string' && isDir(cfg.vault)) return path.resolve(cfg.vault);
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (looksLikeVault(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new VaultNotFound('no AgenticOS vault found: set AOS_VAULT, write agenticos.json, or run `aos init`');
}

const guard = require('./test-guard.js');
if (guard.underTestRunner()) {
  guard.guardTestEnv('the vault and agenticos.json');
  const e = process.env;
  if (!e.AOS_VAULT && !e.BRAIN_VAULT && !e.AOS_CONFIG && !e.CLAUDE_CONFIG_DIR) {
    throw new guard.UnsafeTestEnv('refusing to resolve the vault through the default agenticos.json in a test: a test names its own (AOS_VAULT, or AOS_CONFIG / CLAUDE_CONFIG_DIR). brain/scripts tests get one from test/setup.js: run them with `npm test` or `npm run test:one -- <file>`.');
  }
}

const USER_CONFIG = readUserConfig() || {};
const VAULT = detectVault();
const CLAUDE_CONFIG_DIR = path.resolve(USER_CONFIG.claudeConfigDir || claudeConfigDir());

const PATHS = {
  VAULT,
  CLAUDE_CONFIG_DIR,
  PROJECTS: path.join(CLAUDE_CONFIG_DIR, 'projects'),
  BRAIN: path.join(VAULT, 'brain'),
  INDEX: path.join(VAULT, 'brain', '_index'),
  CONFIG_JSON: path.join(VAULT, 'brain', 'config.json'),
  MEMORY_DIR: path.join(VAULT, 'brain', 'memory'),
  PATTERNS: path.join(VAULT, 'brain', 'patterns'),
  REFLECTIONS: path.join(VAULT, 'brain', 'reflections'),
  SCRIPTS: path.join(VAULT, 'brain', 'scripts'),
  AGENT_RUNS: path.join(VAULT, 'brain', '_index', 'agent-runs'),
  BRAIN_MD: path.join(VAULT, 'brain', '_index', 'BRAIN.md'),
  SESSION_MD: path.join(VAULT, 'brain', '_index', 'SESSION.md'),
  SNAPSHOT_JSON: path.join(VAULT, 'brain', '_index', 'snapshot.json'),
  MEMORY_INDEX: path.join(VAULT, 'MEMORY.md'),
  PERSONA: path.join(VAULT, 'persona'),
  ROUTINES: path.join(VAULT, 'brain', 'routines'),
  ROUTINES_STATE: path.join(VAULT, 'brain', '_index', 'routines.json'),
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DEFAULT_LAYOUT = '{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md';

/** Daily-note layout from <vault>/brain/config.json (dailyNote.layout), else the default.
 *  The Obsidian plugin reads the same key from brain/config.json (its src/data/dailyNote.ts
 *  twin is replaced in a later phase) — one owner, no drift. */
function dailyNoteLayoutFor(vault) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(vault, 'brain', 'config.json'), 'utf8'));
    if (c && c.dailyNote && typeof c.dailyNote.layout === 'string') return c.dailyNote.layout;
  } catch { /* no config → default */ }
  return DEFAULT_LAYOUT;
}
function dailyNoteLayout() { return dailyNoteLayoutFor(VAULT); }
function formatLayout(layout, d) {
  const yyyy = String(d.getFullYear());
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return layout.replace(/\{yyyy\}/g, yyyy).replace(/\{MMMM\}/g, MONTHS[d.getMonth()]).replace(/\{MM\}/g, MM).replace(/\{dd\}/g, dd);
}
function dailyNotePath(d = new Date()) {
  return path.join(VAULT, ...formatLayout(dailyNoteLayout(), d).split('/'));
}

const PLACEHOLDER_RE = /\{yyyy\}|\{MM\}|\{MMMM\}|\{dd\}/g;
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** One '/'-separated layout segment → { regex, groups }: capture-group order is the field order. */
function segmentMatcher(seg) {
  const groups = [];
  let pattern = '';
  let last = 0;
  PLACEHOLDER_RE.lastIndex = 0;
  let m;
  while ((m = PLACEHOLDER_RE.exec(seg)) !== null) {
    pattern += escapeRe(seg.slice(last, m.index));
    if (m[0] === '{yyyy}') { pattern += '(\\d{4})'; groups.push('yyyy'); }
    else if (m[0] === '{MM}') { pattern += '(\\d{2})'; groups.push('MM'); }
    else if (m[0] === '{dd}') { pattern += '(\\d{2})'; groups.push('dd'); }
    else { pattern += `(${MONTHS.join('|')})`; groups.push('MMMM'); }
    last = PLACEHOLDER_RE.lastIndex;
  }
  pattern += escapeRe(seg.slice(last));
  return { regex: new RegExp(`^${pattern}$`), groups };
}
/** Every daily note under `vault` for `layout` (spec §5.3: the walk is derived from the configured layout, never a
 *  hardcoded <year>/<month>/<date>.md). Returns [{ date: 'YYYY-MM-DD', absPath, path }] ascending by date; `path` is
 *  vault-relative with forward slashes. Files at a directory position, or names that do not match their segment, are skipped. */
function listDailyNotes({ vault = VAULT, layout } = {}) {
  const matchers = String(layout || dailyNoteLayoutFor(vault)).split('/').map(segmentMatcher);
  const out = [];
  const walk = (dir, depth, fields) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const last = depth === matchers.length - 1;
    for (const e of entries) {
      if (last ? !e.isFile() : !e.isDirectory()) continue;
      const m = matchers[depth].regex.exec(e.name);
      if (!m) continue;
      const next = { ...fields };
      matchers[depth].groups.forEach((g, i) => { next[g] = m[i + 1]; });
      const full = path.join(dir, e.name);
      if (!last) { walk(full, depth + 1, next); continue; }
      const MM = next.MM || (next.MMMM ? String(MONTHS.indexOf(next.MMMM) + 1).padStart(2, '0') : null);
      if (!next.yyyy || !MM || !next.dd) continue;
      out.push({ date: `${next.yyyy}-${MM}-${next.dd}`, absPath: full, path: path.relative(vault, full).replace(/\\/g, '/') });
    }
  };
  walk(vault, 0, {});
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Claude Code names a transcript folder after the working directory with every non-alphanumeric char → "-". */
function projectSlug(absDir) { return String(absDir).replace(/[^A-Za-z0-9]/g, '-'); }

module.exports = {
  VAULT, PATHS, dailyNotePath, dailyNoteLayout, dailyNoteLayoutFor, listDailyNotes, formatLayout, MONTHS, DEFAULT_LAYOUT,
  projectSlug, detectVault, looksLikeVault, claudeConfigDir, configFile, readUserConfig, VaultNotFound,
};
