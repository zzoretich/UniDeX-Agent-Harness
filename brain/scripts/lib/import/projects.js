'use strict';
/**
 * import/projects.js — past project folders proposed as workspaces (install-import B9), and the session collection the
 * digest queue shares.
 *
 *   collect(opts)          workspaces + both hosts' sessions (collectors/hostSessions.js, which reads transcripts only
 *                          through lib/host.js and lib/transcript.js) + attachSessions over the import window: the
 *                          outside rows, and `workspaceOf` (host:id → the workspace each session is credited to, by
 *                          hostSessions' D20 rules). A dry run reads session-index.json and writes a temp copy, never
 *                          the vault's.
 *   propose(collected)     the outside rows inside a git repository, grouped by its root (a worktree already folds into
 *                          its main repository's row), proposed when the root has ≥ 3 sessions in the window or any
 *                          session in the last 14 days. Each is named after the repository: a new workspace
 *                          (`action: new`, `repo:` set to the root), or, when a workspace of that name exists, a link to it
 *                          (`action: link`: its `repo:` when it has none, else an `aliases:` entry). A folder outside any
 *                          repository, or gone from disk, stays an outside row.
 *   apply(proposals, …)    creates or links only the accepted ones, through cli/workspace.js's verbs (`new`, `set`,
 *                          `adopt --into`; injected as `workspace`), with one snapshot refresh at the end. `accept` lists
 *                          ids (`~/…` repo paths), slugs or `{ id, name }` to rename a new one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./common.js');

const DAY = 24 * 60 * 60 * 1000;
const MIN_SESSIONS = 3;
const RECENT_DAYS = 14;
const ALL_DAYS = 36500;

function slugify(name) { return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function msOf(v) { const ms = Date.parse(typeof v === 'string' ? v : ''); return Number.isFinite(ms) ? ms : 0; }

/**
 * opts: { vault, cfg (merged), userConfig, env, home, now, windowDays (Infinity = all), tmpDirs, gitCeiling,
 *         dryRun (no session-index write) }. → { workspaces, collected, outside, workspaceOf, windowDays }
 */
function collect(opts) {
  const { vault } = opts;
  const home = opts.home || os.homedir();
  const days = Number.isFinite(opts.windowDays) ? Math.max(1, Math.round(opts.windowDays)) : ALL_DAYS;
  const cfg = { ...(opts.cfg || {}), workspaces: { ...((opts.cfg && opts.cfg.workspaces) || {}), idleDays: days } };
  const { collectWorkspaces } = require('../../collectors/workspaces.js');
  const { collectHostSessions, attachSessions } = require('../../collectors/hostSessions.js');
  const index = path.join(vault, 'brain', '_index', 'session-index.json');
  let indexFile = index;
  let tmp = null;
  if (opts.dryRun) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-import-scan-'));
    indexFile = path.join(tmp, 'session-index.json');
    try { fs.copyFileSync(index, indexFile); } catch { /* no cache yet: read every transcript once */ }
  }
  try {
    const workspaces = collectWorkspaces({ vault, home });
    const collected = collectHostSessions({ vault, cfg, userConfig: opts.userConfig || cfg, env: opts.env || process.env, now: opts.now, indexFile });
    // Every session's workspace, not only the newest recentSessions per workspace.
    const all = { ...collected, settings: { ...collected.settings, recentSessions: Number.MAX_SAFE_INTEGER } };
    const outside = attachSessions(workspaces, all, {
      vault, home, now: opts.now, ...(opts.tmpDirs ? { tmpDirs: opts.tmpDirs } : {}), ...(opts.gitCeiling ? { gitCeiling: opts.gitCeiling } : {}),
    });
    const workspaceOf = new Map();
    for (const ws of workspaces) {
      if (ws.hidden) continue;
      for (const r of (ws.sessions && ws.sessions.recent) || []) if (r.id) workspaceOf.set(`${r.host}:${String(r.id).toLowerCase()}`, ws.name);
    }
    return { workspaces, collected, outside, workspaceOf, windowDays: days };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The proposals (module comment), busiest first. */
function propose({ outside, workspaces, vault, home = os.homedir(), now = Date.now() }) {
  const groups = new Map();
  for (const o of outside || []) {
    const root = o && o.git && o.git.root;
    if (!root || !isDir(root) || C.insideVault(root, vault)) continue;
    const g = groups.get(root) || { root, branch: o.git.branch || null, claude: 0, codex: 0, total: 0, lastAt: null, folders: 0 };
    g.claude += o.claude || 0;
    g.codex += o.codex || 0;
    g.total += o.total || 0;
    g.folders += 1;
    if (o.lastAt && msOf(o.lastAt) > msOf(g.lastAt)) g.lastAt = o.lastAt;
    groups.set(root, g);
  }
  const live = (workspaces || []).filter((w) => w && !w.hidden && typeof w.name === 'string');
  const byName = new Map(live.map((w) => [slugify(w.name), w]));
  const wsRoot = path.join(vault, 'workspaces');
  const held = (slug) => !slug || ['_archive', 'research', 'scratch'].includes(slug) || fs.existsSync(path.join(wsRoot, slug)) || fs.existsSync(path.join(wsRoot, '_archive', slug));
  const taken = new Set();
  const out = [];
  const sorted = [...groups.values()].sort((a, b) => (b.total - a.total) || (msOf(b.lastAt) - msOf(a.lastAt)) || (a.root < b.root ? -1 : 1));
  for (const g of sorted) {
    const recent = !!g.lastAt && now - msOf(g.lastAt) <= RECENT_DAYS * DAY;
    if (g.total < MIN_SESSIONS && !recent) continue;
    const name = slugify(path.basename(g.root)) || 'project';
    const repo = C.tilde(g.root, home);
    const base = {
      id: repo, repo, root: g.root, branch: g.branch, claude: g.claude, codex: g.codex, sessions: g.total, lastAt: g.lastAt,
      reason: g.total >= MIN_SESSIONS ? `${g.total} sessions in the window` : `active in the last ${RECENT_DAYS} days`,
    };
    const match = byName.get(name);
    if (match && !match.archived) {
      out.push({ ...base, action: 'link', into: match.name, slug: slugify(match.name), name: match.name, link: match.repoPath || match.repo ? 'alias' : 'repo' });
      continue;
    }
    let slug = name;
    for (let i = 2; held(slug) || taken.has(slug); i++) slug = `${name}-${i}`;
    taken.add(slug);
    out.push({ ...base, action: 'new', slug, name: slug });
  }
  return out;
}

/** The accepted proposals, each with its final name: [{ p, name }]. An unknown id is reported, not guessed. */
function accepted(proposals, accept) {
  const list = Array.isArray(accept) ? accept : [];
  const picks = [];
  const unknown = [];
  for (const item of list) {
    const id = item && typeof item === 'object' ? item.id : item;
    const p = proposals.find((x) => id === x.id || id === x.slug || id === x.root || id === x.repo);
    if (!p) { unknown.push(String(id)); continue; }
    if (picks.some((q) => q.p === p)) continue;
    const rename = item && typeof item === 'object' && typeof item.name === 'string' && p.action === 'new' ? slugify(item.name) : null;
    picks.push({ p, name: rename || p.slug });
  }
  return { picks, unknown };
}

/**
 * Create or link the accepted proposals (module comment). `workspace` is cli/workspace.js; `wsOpts` the options its
 * main() takes ({ vault, configDir, env, home, tmpDirs }). → { created, linked, failed, unknown }
 */
async function apply(proposals, { accept, workspace: W, wsOpts = {} }) {
  const { picks, unknown } = accepted(proposals, accept);
  const res = { created: [], linked: [], failed: [], unknown };
  const sink = { lines: [], log(l) { this.lines.push(String(l)); }, error(l) { this.lines.push(String(l)); } };
  const run = async (argv) => {
    sink.lines = [];
    await W.main([...argv, '--json'], { ...wsOpts, io: sink, rescan: false });
    try { return JSON.parse(sink.lines.join('\n')); } catch { return null; }
  };
  for (const { p, name } of picks) {
    try {
      if (p.action === 'new') {
        const made = await run(['new', name]);
        const slug = (made && made.slug) || name;
        await run(['set', slug, '--set', JSON.stringify({ repo: p.repo })]);
        res.created.push({ id: p.id, slug, repo: p.repo });
      } else if (p.link === 'repo') {
        await run(['set', p.into, '--set', JSON.stringify({ repo: p.repo })]);
        res.linked.push({ id: p.id, into: p.into, how: 'repo', repo: p.repo });
      } else {
        await run(['adopt', p.repo, '--into', p.into]);
        res.linked.push({ id: p.id, into: p.into, how: 'alias', repo: p.repo });
      }
    } catch (e) {
      res.failed.push({ id: p.id, reason: e && e.message ? e.message : String(e) });
    }
  }
  if ((res.created.length || res.linked.length) && typeof W.refreshSnapshot === 'function') {
    try { await W.refreshSnapshot(W.resolveCtx(wsOpts), {}); } catch { /* the next scan refreshes it */ }
  }
  return res;
}

module.exports = { collect, propose, accepted, apply, MIN_SESSIONS, RECENT_DAYS, ALL_DAYS };
