'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { VAULT, safeStat, listDir, exists, iso, runGit, lastCommit, gitState, recentCommits, vaultPathCommits, workspaceFile } = require('./util');
const { stripMd } = require('./projects');
// The manifest parser and `repo:` rule live in lib/workspace-manifest.js, shared with the `aos workspace` verbs that
// write workspace.md, so what a verb writes is what this scan reads (spaces-redesign D18, D28).
const { parseManifest, repoPath } = require('../lib/workspace-manifest.js');

const NOISE_DIRS = new Set([
  'node_modules', 'assets', 'images', 'img', 'scripts', 'bin', 'docs',
  'tests', 'test', 'src', 'dist', 'build', 'archive', '.git', '.obsidian',
  'coverage', 'tmp', '.cache',
]);
// CLAUDE.md is Claude Code's instruction file, AGENTS.md is Codex CLI's: either marks a project (workspace hub D1).
const PROJECT_MARKERS = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'STATUS.md', 'PLAN.md'];
// A dated HANDOFF-<slug>.md ranks where HANDOFF.md does (spaces-redesign D23).
const DOC_RANK = ['STATUS.md', 'HANDOFF.md', 'PLAN.md', 'PROGRESS.md', 'README.md'];
const MAX_DOCS = 5;
const MAX_READ = 256 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

// spaces-redesign D22: `_archive/` holds archived workspaces (entries keyed `_archive/<n>`), `_worktrees/` holds team
// seats (infrastructure, no entry); any other `_` folder is listed hidden.
const ARCHIVE_DIR = '_archive';
const WORKTREES_DIR = '_worktrees';
const HANDOFF_FILE = /^handoff.*\.md$/i;

// spaces-redesign D23: the placeholder text `aos workspace new` writes (cli/workspace.js stubs()) never counts as a
// summary, an objective or a next step; `<slug>` stands for any workspace name, and backticks are ignored. Mirrored in
// hud/src/data/terminalLaunch.ts, where a drift test pins the copy. The stubs' empty `- ` bullets are
// skipped wherever bullets are read.
const TEMPLATE_TEXT = Object.freeze([
  'One line about what this project is.',
  'This is the `workspaces/<slug>/` workspace of an AgenticOS vault.',
]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEMPLATE_RES = TEMPLATE_TEXT.map((t) => new RegExp('^' + escapeRe(t.replace(/`/g, '')).replace('<slug>', '[^/]+')));

/** Whether a line is stub placeholder text (spaces-redesign D23). */
function isTemplateText(s) {
  if (typeof s !== 'string') return false;
  const v = s.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  return !!v && TEMPLATE_RES.some((re) => re.test(v));
}

// spaces-redesign D11: workspace.md may set the status by hand; these words map onto the three it can set, and any
// other word is ignored (the automatic status stands).
const STATUS_OVERRIDE = new Map([
  ['active', 'active'], ['paused', 'paused'], ['done', 'done'],
  ['shipped', 'done'], ['complete', 'done'],
  ['blocked', 'paused'], ['parked', 'paused'], ['on hold', 'paused'],
]);
const STATUS_ORDER = ['active', 'stalled', 'idle', 'paused', 'done'];

/** A manifest `status:` → 'active' | 'paused' | 'done', or null (spaces-redesign D11). */
function statusOverride(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  return STATUS_OVERRIDE.get(v) || null;
}

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * A manifest's `aliases:` as absolute folders (spaces-redesign D16, D17): `workspaces/<old>` (relative to the vault),
 * `~/…` or absolute. A folder inside the vault counts only under workspaces/ (never workspaces/ itself or _worktrees/),
 * and a relative value must stay there; the filesystem root, the home folder and anything containing the vault are
 * dropped, so an alias can never claim every session. Duplicates and the workspace's own folder are dropped.
 */
function aliasPaths(values, { vault, wsRoot, ownDir, home = os.homedir() }) {
  const out = [];
  const v = path.resolve(vault);
  const ws = path.resolve(wsRoot || path.join(v, 'workspaces'));
  for (const raw of Array.isArray(values) ? values : []) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s || s === '~' || /[\0\n\r]/.test(s)) continue;
    const relative = !s.startsWith('~/') && !path.isAbsolute(s);
    const p = path.resolve(relative ? path.join(v, s) : s.startsWith('~/') ? path.join(home, s.slice(2)) : s);
    if (p === path.parse(p).root || p === path.resolve(home) || within(v, p) || (relative && !within(p, ws))) continue;
    if (within(p, v) && (p === ws || !within(p, ws) || within(p, path.join(ws, WORKTREES_DIR)))) continue;
    if (ownDir && p === path.resolve(ownDir)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

// ── safe reads (spaces-redesign §6) ──────────────────────────────
// A workspace file is read only when lstat says it is a regular file and its real path is inside the workspace, so a
// link (README.md → somewhere private) is never followed into the snapshot.
function workspaceReader(absDir) {
  let real = null;
  try { real = fs.realpathSync(absDir); } catch { /* gone */ }
  const relOk = (rel) => typeof rel === 'string' && !!rel && !/[\0\n\r]/.test(rel) && !path.isAbsolute(rel)
    && !rel.split(/[\\/]/).some((s) => s === '.' || s === '..');
  return {
    /** A regular file → its text (null when missing, a link, outside, or larger than `max`). */
    text(rel, max = MAX_READ) {
      const abs = real && workspaceFile(real, rel);
      if (!abs) return null;
      let fd = null;
      try {
        fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > max) return null;
        return fs.readFileSync(fd, 'utf8');
      } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
    },
    /** A regular file or a folder inside (never a link) → its lstat, else null. */
    lstat(rel) {
      if (!real || !relOk(rel)) return null;
      const abs = path.join(real, rel);
      try {
        const st = fs.lstatSync(abs);
        if (!st.isFile() && !st.isDirectory()) return null;
        const r = fs.realpathSync(abs);
        return r !== real && within(r, real) ? st : null;
      } catch { return null; }
    },
  };
}

function frontmatterOf(text) {
  const out = {};
  const m = typeof text === 'string' && text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// First meaningful body line (skips frontmatter, headings, quotes, hr), markdown-stripped + truncated: projects.js
// firstBodyLine over text already read safely.
function bodyLine(text) {
  if (!text) return null;
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  for (const raw of body.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    if (/^([-*_=])\1{2,}$/.test(line)) continue;
    line = stripMd(line);
    if (!line) continue;
    return line.length > 160 ? line.slice(0, 157) + '…' : line;
  }
  return null;
}

/** `[ ] text` / `[x] text` → { text, done }; anything else is an open item. */
function checkbox(s) {
  const t = String(s == null ? '' : s).trim();
  const m = t.match(/^\[([ xX])\]\s*(.*)$/);
  return m ? { text: m[2].trim(), done: m[1] !== ' ' } : { text: t, done: false };
}

const DOC_DONE = new Set(['done', 'shipped', 'complete', 'superseded']);

/** A key document's mtime, note (frontmatter description, else the first body line) and done flag (spaces-redesign D8). */
function docInfo(reader, rel) {
  const st = reader.lstat(rel);
  if (!st) return { mtime: null, note: null, done: false };
  if (!st.isFile()) return { mtime: iso(st.mtimeMs), note: null, done: false };
  const text = reader.text(rel);
  const fm = frontmatterOf(text);
  const note = (fm.description || '').trim() || bodyLine(text) || null;
  let boxes = 0;
  let open = 0;
  for (const m of String(text || '').matchAll(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/gm)) { boxes++; if (m[1] === ' ') open++; }
  return { mtime: iso(st.mtimeMs), note, done: DOC_DONE.has(String(fm.status || '').trim().toLowerCase()) || (boxes > 0 && open === 0) };
}

function docRank(name) {
  const r = DOC_RANK.indexOf(name);
  if (r !== -1) return r;
  return HANDOFF_FILE.test(name) ? DOC_RANK.indexOf('HANDOFF.md') : 99;
}

function isProjectLike(absChild) {
  if (exists(path.join(absChild, '.git'))) return true;
  return PROJECT_MARKERS.some((mk) => exists(path.join(absChild, mk)));
}

// Returns { isCollection, subprojects[], docs[] }.
// Collection = >=2 project-like child dirs (noise excluded). Otherwise single-project:
// surface up to MAX_DOCS top-level .md files (regular files, never links), ranked by DOC_RANK then recency.
function detectChildren(absDir, relDir, reader = workspaceReader(absDir)) {
  const childDirs = [];
  for (const name of listDir(absDir)) {
    if (NOISE_DIRS.has(name) || name.startsWith('.')) continue;
    const st = safeStat(path.join(absDir, name));
    if (st && st.isDirectory()) childDirs.push(name);
  }
  const projectLike = childDirs.filter((n) => isProjectLike(path.join(absDir, n)));

  if (projectLike.length >= 2) {
    const subprojects = projectLike.sort().map((n) => ({
      name: n,
      path: `${relDir}/${n}`,
      status: null,
      summary: ['README.md', 'STATUS.md', 'CLAUDE.md', 'AGENTS.md']
        .map((f) => bodyLine(reader.text(`${n}/${f}`))).find((l) => l && !isTemplateText(l)) || null,
    }));
    return { isCollection: true, subprojects, docs: [] };
  }

  const mdFiles = [];
  for (const n of listDir(absDir)) {
    if (!n.toLowerCase().endsWith('.md') || n.toLowerCase() === 'workspace.md') continue;
    const st = reader.lstat(n);
    if (st && st.isFile()) mdFiles.push({ n, mtimeMs: st.mtimeMs });
  }
  mdFiles.sort((a, b) => (docRank(a.n) - docRank(b.n)) || (b.mtimeMs - a.mtimeMs) || (a.n < b.n ? -1 : 1));
  const docs = mdFiles.slice(0, MAX_DOCS).map(({ n }) => ({ name: n, path: `${relDir}/${n}`, ...docInfo(reader, n) }));
  return { isCollection: false, subprojects: [], docs };
}

// Bullets under the first "## Objectives" / "## Goals" heading (until next heading).
function extractObjectives(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (inSection) break;
      if (/^(objectives|goals|scope|project\s+scope)\b/i.test(heading[1])) inSection = true;
      continue;
    }
    if (inSection) {
      const b = line.match(/^[-*+]\s+(.*)$/);
      if (b) out.push(b[1].trim());
    }
  }
  return out;
}

/** A bullet's text with markdown and an open checkbox removed; null for a ticked box, an empty bullet or a template. */
function bulletText(s) {
  const c = checkbox(s);
  if (c.done) return null;
  const t = stripMd(c.text);
  return t && !isTemplateText(t) ? t : null;
}

/** A heading's text as a short source label ("Next: phase 2"). */
function headingLabel(h) {
  const t = stripMd(String(h || '')).replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 39) + '…' : t;
}

// First open bullet under the first "## Next" / "## What's Next" / "## TODO" heading → { text, heading }.
function findNext(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (section) break;
      if (/^(next|what['’]?s\s+next|to\s?do|todo)\b/i.test(heading[1])) section = heading[1];
      continue;
    }
    if (section) {
      const b = line.match(/^[-*+]\s+(.*)$/);
      const t = b && bulletText(b[1]);
      if (t) return { text: t, heading: section };
    }
  }
  return null;
}

// findNext's text alone: the first open, non-template bullet under the first Next / What's Next / TODO heading.
function extractNext(text) {
  const r = findNext(text);
  return r ? r.text : null;
}

// ── handoffs (spaces-redesign D6, D23) ───────────────────────────
const NOW_HEADING = /^(now|resume here)\b/i;
const NEXT_HEADING = /^(next\b|what['’]?s next|remaining work)/i;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * A handoff note → { now, next, asOf, nextHeading }: Now is the first body line under a heading that starts with "Now"
 * or "Resume here", Next the first open bullet under one that starts with "Next", "What's next" or "Remaining work";
 * asOf is the date in the Now heading, else the title's. Fenced code is skipped.
 */
function parseHandoff(text) {
  const out = { now: null, next: null, asOf: null, nextHeading: null };
  if (!text) return out;
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  let titleDate = null;
  let nowDate = null;
  let section = null; // { kind: 'now' | 'next', level, title }
  let fence = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (h) {
      const level = h[1].length;
      const title = stripMd(h[2]);
      if (section && level <= section.level) section = null;
      if (level === 1 && titleDate === null) titleDate = (title.match(DATE_RE) || [])[1] || '';
      if (!out.now && NOW_HEADING.test(title)) {
        section = { kind: 'now', level, title };
        nowDate = (title.match(DATE_RE) || [])[1] || null;
      } else if (!out.next && NEXT_HEADING.test(title)) {
        section = { kind: 'next', level, title };
      }
      continue;
    }
    if (!section || !line || /^([-*_=])\1{2,}$/.test(line)) continue;
    if (section.kind === 'now') {
      const t = bulletText(line.replace(/^(>\s*)+/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
      if (!t) continue;
      out.now = t.length > 200 ? t.slice(0, 199) + '…' : t;
      section = null;
    } else {
      const b = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
      const t = b && bulletText(b[1]);
      if (!t) continue;
      out.next = t;
      out.nextHeading = section.title;
      section = null;
    }
    if (out.now && out.next) break;
  }
  out.asOf = nowDate || titleDate || null;
  return out;
}

/** The newest top-level HANDOFF*.md (a regular file inside the workspace) → { file, now, next, asOf, mtime, nextHeading }. */
function readHandoff(absDir, reader) {
  let best = null;
  for (const n of listDir(absDir)) {
    if (!HANDOFF_FILE.test(n)) continue;
    const st = reader.lstat(n);
    if (!st || !st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs || (st.mtimeMs === best.mtimeMs && n < best.name)) best = { name: n, mtimeMs: st.mtimeMs };
  }
  if (!best) return null;
  const text = reader.text(best.name);
  if (text == null) return null;
  const h = parseHandoff(text);
  return { file: best.name, now: h.now, next: h.next, asOf: h.asOf, mtime: iso(best.mtimeMs), nextHeading: h.nextHeading };
}

function daysSince(ms, now = Date.now()) {
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

/**
 * The automatic status (spaces-redesign D11): active when something moved within `activeDays`; stalled when there is a
 * plan but nothing moved for `activeDays` or more; idle after `idleDays`, or with no plan, or with no activity at all.
 */
function statusFromActivity(ageDays, hasPlan, { activeDays = 7, idleDays = 30 } = {}) {
  if (ageDays != null && ageDays < activeDays) return 'active';
  if (hasPlan && ageDays != null && ageDays < idleDays) return 'stalled';
  return 'idle';
}

/** A plan (D11): a next step, a handoff Now or Next, or an open objective. */
function hasPlan(e) {
  return !!(e.next && e.next.text) || !!(e.handoff && (e.handoff.now || e.handoff.next))
    || (Array.isArray(e.objectives) && e.objectives.some((o) => o && !o.done));
}

function computeInputHash(input) {
  const stable = {
    status: input.status || null,
    summary: input.summary || null,
    objectives: (input.objectives || []).map((o) => (typeof o === 'string' ? o : o.text)),
    subprojects: (input.subprojects || []).map((s) => `${s.name}:${s.status || ''}`),
    next: input.next ? input.next.text || input.next : null,
    ageBucket: input.lastEvent && input.lastEvent.ageDays != null
      ? Math.min(input.lastEvent.ageDays, 30) : null,
  };
  return crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

/** The newest commit touching the folder: its own repository's, else the vault's log of that path. */
function lastCommitIn(vault, absDir, relDir) {
  if (exists(path.join(absDir, '.git'))) return lastCommit(absDir, relDir);
  const out = runGit(vault, ['log', '-1', '--no-color', '--format=%cI%x00%s%x00%h', '--', relDir]);
  if (!out || !out.trim()) return null;
  const [ci, subject, hash] = out.trim().split('\x00');
  return ci ? { iso: ci, subject: subject || null, hash: hash || null } : null;
}

const SUMMARY_FILES = ['STATUS.md', 'README.md', 'HANDOFF.md', 'CLAUDE.md', 'AGENTS.md'];
const OBJECTIVE_FILES = ['PLAN.md', 'MASTER-PLAN.md', 'PROGRESS.md', 'README.md', 'STATUS.md', 'CLAUDE.md', 'AGENTS.md'];
const NEXT_FILES = ['STATUS.md', 'PLAN.md', 'README.md', 'CLAUDE.md', 'AGENTS.md'];

function scanOneWorkspace(absDir, relDir, name, opts = {}) {
  const vault = opts.vault || VAULT;
  const reader = workspaceReader(absDir);
  const manifest = parseManifest(reader.text('workspace.md'));

  // last event (git)
  const lc = lastCommitIn(vault, absDir, relDir);
  const stat = safeStat(absDir);
  const lastEvent = lc
    ? { iso: lc.iso, ageDays: daysSince(new Date(lc.iso).getTime()), subject: lc.subject, hash: lc.hash }
    : { iso: stat ? new Date(stat.mtimeMs).toISOString() : null,
        ageDays: stat ? daysSince(stat.mtimeMs) : null, subject: null, hash: null };

  // status: only the hand-set word here; the automatic one needs sessions and commits (finalizeWorkspaces, D11)
  const override = statusOverride(manifest.status);

  // summary (template text never counts, D23)
  let summary = manifest.summary && !isTemplateText(manifest.summary) ? manifest.summary : null;
  const summarySource = summary ? 'manifest' : 'derived';
  let summaryTemplate = !!manifest.summary && !summary;
  if (!summary) {
    for (const f of SUMMARY_FILES) {
      const line = bodyLine(reader.text(f));
      if (!line) continue;
      if (isTemplateText(line)) { summaryTemplate = true; continue; }
      summary = line;
      break;
    }
    if (summary) summaryTemplate = false;
  }

  // objectives, with `- [ ]` / `- [x]` as done
  const objectivesOf = (list, source) => list.map(checkbox)
    .filter((o) => o.text && !isTemplateText(o.text)).map((o) => ({ text: o.text, source, done: o.done }));
  let objectives = objectivesOf(manifest.objectives, 'manifest');
  if (!objectives.length) {
    for (const f of OBJECTIVE_FILES) {
      objectives = objectivesOf(extractObjectives(reader.text(f)), 'derived');
      if (objectives.length) break;
    }
  }

  // children
  let isCollection, subprojects, docs;
  if (manifest.subprojects.length) {
    isCollection = false; docs = [];
    subprojects = manifest.subprojects.map((s) => {
      const line = bodyLine(reader.text(`${s.path}/README.md`));
      return { name: s.name, path: `${relDir}/${s.path}`, status: null, summary: line && !isTemplateText(line) ? line : null };
    });
  } else {
    ({ isCollection, subprojects, docs } = detectChildren(absDir, relDir, reader));
  }
  // A manifest `documents:` list curates KEY DOCUMENTS explicitly (files or dirs),
  // overriding auto-derivation. Each entry's display name is its trailing path segment.
  if (manifest.documents.length) {
    isCollection = false; subprojects = [];
    docs = manifest.documents.map((d) => {
      const rel = d.replace(/\/+$/, '');
      const name = rel.split('/').pop() + (d.endsWith('/') ? '/' : '');
      return { name, path: `${relDir}/${rel}`, ...docInfo(reader, rel) };
    });
  }

  // handoff, then next: the manifest, the handoff's Next, a Next heading, else empty, naming its source; never a
  // commit subject, never the model's guess (D23)
  const ho = readHandoff(absDir, reader);
  let next = null;
  if (manifest.next && !isTemplateText(manifest.next)) {
    next = { text: manifest.next, source: 'manifest', from: 'workspace.md' };
  } else if (ho && ho.next) {
    next = { text: ho.next, source: 'derived', from: `${ho.file} › ${headingLabel(ho.nextHeading)}` };
  } else {
    for (const f of NEXT_FILES) {
      const r = findNext(reader.text(f));
      if (r) { next = { text: r.text, source: 'derived', from: `${f} › ${headingLabel(r.heading)}` }; break; }
    }
  }
  if (!next) next = { text: null, source: 'derived', from: null };
  const handoff = ho ? { file: ho.file, now: ho.now, next: ho.next, asOf: ho.asOf, mtime: ho.mtime } : null;

  const archived = opts.hiddenReason === 'archived';
  const entry = {
    name, label: opts.label || name, path: relDir,
    hidden: !!opts.hiddenReason, hiddenReason: opts.hiddenReason || null,
    archived: archived ? (manifest.archived || true) : false,
    pinned: manifest.pinned === true,
    status: override, statusSource: override ? 'manifest' : 'derived', statusAuto: null, statusOverride: override,
    summary, summarySource, summaryTemplate,
    objectives, isCollection, subprojects, docs, next, handoff, lastEvent,
    insight: { text: null, status: 'unavailable', next: null }, // insight.next is the model's suggestion (D23)
    inputHash: null,
  };
  // Absolute filesystem path of the workspace, recorded at scan time so the
  // plugin's file tree can read files via Node fs directly — robust even when
  // Obsidian opens a symlink-curated vault whose root differs from where the
  // collector ran. Never a hash input.
  entry.absPath = absDir;
  // Former folders (D16, D17), absolute: sessions that ran there count for this workspace.
  entry.aliases = aliasPaths(manifest.aliases, { vault, wsRoot: opts.wsRoot, ownDir: absDir, home: opts.home });
  // A linked code folder (T8): the Term tab starts there, and sessions run there count for this workspace. Never a hash
  // input, like absPath.
  const repo = repoPath(manifest.repo, vault, opts.home);
  if (repo) entry.repoPath = repo;
  return entry;
}

// Sync discovery (spaces-redesign D22): every folder under workspaces/ but dot-folders and _worktrees/; `_` folders are
// hidden, and _archive/'s children are hidden entries keyed `_archive/<n>`. Status, activity, git, the insight hash and
// its carry-forward come later, after the sessions are attached (finalizeWorkspaces); insight *generation* happens
// later still (async, in scan-vault main()).
function collectWorkspaces(opts = {}) {
  const vault = opts.vault || VAULT;
  const dirName = opts.workspacesDirName || 'workspaces';
  const wsRoot = path.join(vault, dirName);
  const scanOpts = { vault, wsRoot, home: opts.home };
  const isDir = (p) => { const st = safeStat(p); return !!st && st.isDirectory(); };
  const out = [];
  for (const name of listDir(wsRoot).sort()) {
    if (name.startsWith('.') || name === WORKTREES_DIR) continue;
    const absDir = path.join(wsRoot, name);
    if (!isDir(absDir)) continue;
    if (name === ARCHIVE_DIR) {
      for (const n of listDir(absDir).sort()) {
        if (n.startsWith('.') || !isDir(path.join(absDir, n))) continue;
        out.push(scanOneWorkspace(path.join(absDir, n), `${dirName}/${ARCHIVE_DIR}/${n}`, `${ARCHIVE_DIR}/${n}`,
          { ...scanOpts, label: n, hiddenReason: 'archived' }));
      }
      continue;
    }
    out.push(scanOneWorkspace(absDir, `${dirName}/${name}`, name, { ...scanOpts, label: name, hiddenReason: name.startsWith('_') ? 'underscore' : null }));
  }
  // An alias naming another live workspace's folder is stale: that folder's sessions are its own.
  const roots = new Set(out.map((e) => path.resolve(e.absPath)));
  for (const e of out) e.aliases = e.aliases.filter((p) => !roots.has(p));
  return out;
}

function wsConfig(cfg) {
  const d = require('../config.default.json').workspaces;
  const w = (cfg && cfg.workspaces) || {};
  const int = (v, dflt, min) => (Number.isInteger(v) && v >= min ? v : dflt);
  return {
    activeDays: int(w.activeDays, d.activeDays, 1),
    idleDays: int(w.idleDays, d.idleDays, 1),
    commits: int(w.commits, d.commits, 0),
    ignoreCommitSubjects: Array.isArray(w.ignoreCommitSubjects) ? w.ignoreCommitSubjects : d.ignoreCommitSubjects,
  };
}

/**
 * Git for one entry (spaces-redesign D24, D11/A2): its own repository, else its `repo:` folder's, else (a folder the
 * vault's git tracks) `{ kind: 'vault' }` with the path's commits minus `ignoreCommitSubjects`. `last` lists the newest
 * commit of each source as activity candidates: the own and `repo:` repositories' newest commit, and for a folder with
 * no repository of its own the vault's newest commit that counts as work there.
 */
function gitFor(e, vault, cfg) {
  const n = cfg.commits;
  const last = [];
  let git = null;
  let commits = [];
  const ownRepo = !!e.absPath && exists(path.join(e.absPath, '.git'));
  for (const dir of [ownRepo ? e.absPath : null, e.repoPath || null]) {
    if (!dir || !exists(path.join(dir, '.git'))) continue;
    const cs = recentCommits(dir, Math.max(n, 1));
    if (cs[0]) last.push(cs[0].iso);
    if (!git) {
      git = gitState(dir);
      if (git) commits = cs.slice(0, n);
    }
  }
  if (!ownRepo && e.path) {
    const vp = vaultPathCommits(vault, e.path, { n, ignoreCommitSubjects: cfg.ignoreCommitSubjects });
    if (vp.activity) last.push(vp.activity.iso);
    if (!git && vp.tracked) { git = { kind: 'vault' }; commits = vp.commits; }
  }
  return { git, commits, last };
}

/** activity { at, ageDays, from }: the newest attributed session or counted commit (D11/A2); never a document mtime. */
function activityOf(e, commitIsos, now) {
  const cands = commitIsos.map((at) => ({ at, from: 'commit' }));
  const s = e.sessions;
  if (s && typeof s === 'object') {
    if (s.lastAt) cands.push({ at: s.lastAt, from: 'session' });
    for (const r of Array.isArray(s.recent) ? s.recent : []) if (r && r.lastAt) cands.push({ at: r.lastAt, from: 'session' });
  }
  let best = null;
  for (const c of cands) {
    const t = Date.parse(c.at);
    if (Number.isNaN(t)) continue;
    if (!best || t > best.t) best = { t, from: c.from };
  }
  return best ? { at: new Date(best.t).toISOString(), ageDays: daysSince(best.t, now), from: best.from } : { at: null, ageDays: null, from: null };
}

function compareEntries(a, b) {
  const rank = (s) => { const i = STATUS_ORDER.indexOf(s); return i === -1 ? STATUS_ORDER.length : i; };
  const at = (e) => (e.activity && e.activity.at ? Date.parse(e.activity.at) : -Infinity);
  return (Number(!!a.hidden) - Number(!!b.hidden))
    || (Number(!!b.pinned) - Number(!!a.pinned))
    || (rank(a.status) - rank(b.status))
    || (at(b) - at(a) || 0)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * After the sessions are attached (spaces-redesign D11, A2): each entry's activity, `statusAuto` against
 * `workspaces.activeDays`/`idleDays`, `status` (the manifest's override wins), `inputHash`, the insight's carry-forward
 * from `prev` (the last snapshot's workspaces; the insight keeps its own `next`, D23), then git, commits and activity,
 * none of them hash inputs. Sorts in place (pinned; active, stalled, idle, paused, done; newest activity; hidden last)
 * and returns the list. `opts.cfg` is the merged config (loaded when omitted); `opts.vault` the vault whose git tracks
 * folders; `opts.now` for tests.
 */
function finalizeWorkspaces(list, opts = {}) {
  const entries = Array.isArray(list) ? list : [];
  const cfg = wsConfig(opts.cfg === undefined ? (() => { try { return require('../lib/config.js').loadConfig(); } catch { return {}; } })() : opts.cfg);
  const vault = opts.vault || VAULT;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const prev = new Map();
  for (const w of opts.prev instanceof Map ? opts.prev.values() : Array.isArray(opts.prev) ? opts.prev : []) if (w && w.name) prev.set(w.name, w);
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const g = gitFor(e, vault, cfg);
    const activity = activityOf(e, g.last, now);
    e.statusAuto = statusFromActivity(activity.ageDays, hasPlan(e), cfg);
    e.status = e.statusOverride || e.statusAuto;
    e.statusSource = e.statusOverride ? 'manifest' : 'derived';
    e.inputHash = computeInputHash(e);
    const old = prev.get(e.name);
    if (old && old.insight && old.insight.inputHash === e.inputHash && old.insight.text) {
      e.insight = old.insight; // unchanged inputs → reuse the cached insight, its suggested next included
    }
    e.activity = activity;
    e.git = g.git;
    e.commits = g.commits;
  }
  entries.sort(compareEntries);
  return entries;
}

module.exports = {
  parseManifest, repoPath, aliasPaths, detectChildren, extractObjectives, extractNext, parseHandoff, bodyLine,
  computeInputHash, statusOverride, statusFromActivity, isTemplateText, TEMPLATE_TEXT, collectWorkspaces, finalizeWorkspaces,
  SUMMARY_FILES, OBJECTIVE_FILES, NEXT_FILES,
};
