'use strict';
/**
 * hostSessions.js — which workspace each Claude Code and Codex session belongs to (spaces-redesign D20, D21, D25, D34;
 * first written for the workspace hub's D2).
 *
 *   collectHostSessions(opts) → { sessions, byCwd, windowDays, scannedAt, … }
 *     Lists both hosts' transcripts through lib/host.js sessionFiles, whether or not agenticos.json enables the host
 *     (a Claude-only machine still lists the Codex threads it has, with Resume off: spec §4's matrix, D31), and reads
 *     them only through the lib/transcript.js seams (sessionHead, sessionTail, fileTouches), into an incremental
 *     cache (D25):
 *       brain/_index/session-index.json  { schema: 1, files: { <abs path>: { host, format, size, mtime, offset, head,
 *                                          title, titleSource, touches, touchCwd, lastAt } } }
 *     An unchanged file is not opened again; an appended one has its tail and only its new lines read. Rows whose file
 *     is no longer under hostDirs(h).sessions/archived are dropped, so a new hosts.codex.home empties the Codex rows; a
 *     host that is off keeps its rows (the plan's "dropped when the host is off" gave way to spec §4's matrix and D31).
 *     Codex subagents a thread spawned (thread_spawn) fold into the thread at the top of their chain; other subagent
 *     rollouts (guardian, review) are dropped. Claude's <id>/subagents/ are never listed, so what a Claude subagent
 *     edits earns no files credit (D34). Two transcripts naming one session id (Claude's small stub files) count once.
 *     byCwd keeps today's shape: every session counted per start folder.
 *
 *   attachSessions(workspaces, collected, opts) → outside rows
 *     Gives each workspace sessions = { claude, codex, total, lastAt, windowDays, recent[] } and returns the start
 *     folders no workspace claimed, minus infrastructure (D21). `collected` is collectHostSessions()'s result or its
 *     byCwd (the call scan-vault.js and cli/workspace.js make today); anything else, or an options object in its place,
 *     collects afresh, as does a result collected for another vault than opts.vault.
 *       recent[]  { id, host, format, kind, title, titleSource, startedAt, lastAt, cwd (the start cwd), startExists, via,
 *                   resumable, reason }
 *                 kind ∈ interactive | headless | team; titleSource ∈ custom | ai | index | prompt | null
 *       outside   { cwd, claude, codex, total, lastAt, exists, match (a workspace whose name is the folder's, compared as
 *                   slugs), git ({ root, branch } of its repository, never the vault's), worktrees (linked worktrees
 *                   folded into this row) }
 *
 * Attribution (D20), first match wins, recorded on each row as `via`:
 *   team      a team seat: its id in persona/teams/<team>/runs.jsonl, credited through its board item's `path`
 *   cwd       the start cwd inside a root (the folder, `repo:`, `aliases:`), the longest root winning
 *   worktree  the nearest .git file's `gitdir: <main>/.git/worktrees/<id>`, <main> inside a root; else, the folder
 *             gone, by name: workspaces/_worktrees/<team>/<item>/… through that team's board item, then the item
 *             segment by name; the older _worktrees/<item>/… by item id, then by name. "By name" is the longest
 *             workspace name (aliases included) the item segment equals or starts with followed by "-"; a team id or a
 *             member folder is never matched by name. Then <repo>.worktrees/* and workspaces/.worktrees/<ws>/*
 *   files     a session started in the vault outside its workspaces: the workspace its file edits and reads touched
 *             most (at least 3 touches and no tie; workspaces.attributeByFiles)
 * workspaces/_worktrees is never a target. Slug decoding (projects.js decodeRuntimeCwd) is only the last fallback, for
 * a Claude transcript whose head names no cwd.
 *
 * Counts cover the last workspaces.idleDays days on both hosts (sessions.windowDays), so a pruned Claude history and a
 * long Codex one span the same days (D34); lastAt and recent (newest first, workspaces.recentSessions rows) show what
 * remains. A recent row's `resumable` follows spec §4: a lowercase UUID equal to the file name's id, and each `false`
 * carries the reason the page shows.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VAULT, safeStat, listDir, iso } = require('./util');
const { decodeRuntimeCwd } = require('./projects');
const { HOSTS, hostDirs, sessionFiles } = require('../lib/host.js');
const { sessionHead, sessionTail, fileTouches, readSessionIndex } = require('../lib/transcript.js');

const RUNTIME_CWD_RE = /^[A-Z]--|^-(Users|home|var|tmp|opt|etc|root|mnt)-/;
const SCHEMA = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const HEAD_BYTES = 256 * 1024; // sessionHead's window: a file still smaller than this has its head read again as it grows
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ITEM_SHAPE_RE = /^[^-].*-\d+$/; // a board item id as teams name them: <name>-NN
const SUBAGENT_HOPS = 8; // how far a nested Codex subagent's parents are followed
const SMALL_FILE_BYTES = 4096; // a .git file or HEAD: anything larger is not one
const WORKTREES_SUFFIX = '.worktrees';
// The OS temp folders a job or a scratch run starts in (D21); os.tmpdir() and its realpath join them at run time.
const TEMP_DIRS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

/** Why a recent row cannot be resumed from the page (spec §4's table). */
const REASONS = {
  headless: 'Headless run: start a new session in Code',
  archived: 'Archived in Codex',
  team: 'A team seat\'s run: it belongs to its board item, not to a terminal',
  noId: 'The transcript names no session id, so it cannot be resumed by id',
  idMismatch: 'Its session id is not the lowercase id in its file name, so resuming by id could open another thread',
};

// ── small helpers ──

function num(v, d) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d; }
function str(v) { return typeof v === 'string' && v ? v : null; }
function abs(p) { return typeof p === 'string' && p && path.isAbsolute(p) ? path.resolve(p) : null; }
function real(p) { try { return fs.realpathSync(p); } catch { return null; } }
/** A path and its realpath when that differs, so a symlinked vault or /tmp → /private/tmp still compare. */
function variants(p) {
  const a = abs(p);
  if (!a) return [];
  const r = real(a);
  return r && r !== a ? [a, r] : [a];
}
function isDir(p) { const st = p ? safeStat(p) : null; return !!(st && st.isDirectory()); }
function expandHome(p, home) { return typeof p === 'string' && (p === '~' || p.startsWith('~/')) ? path.join(home, p.slice(1)) : p; }
function msOf(v) { const ms = Date.parse(typeof v === 'string' ? v : ''); return Number.isFinite(ms) ? ms : 0; }

function insideDir(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}
function insideAny(p, roots) { return roots.some((r) => insideDir(p, r)); }
function strictlyInsideAny(p, roots) { return roots.some((r) => p !== r && insideDir(p, r)); }

/**
 * A small regular file's text (a .git file, a HEAD) or null: never a link, a FIFO or anything over SMALL_FILE_BYTES, so a
 * folder named by transcript data cannot hang or flood the scan.
 */
function readSmall(file) {
  let fd = null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > SMALL_FILE_BYTES) return null;
    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(SMALL_FILE_BYTES);
    const n = fs.readSync(fd, buf, 0, SMALL_FILE_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object' && !Array.isArray(r)) rows.push(r); } catch { /* a torn append */ }
  }
  return rows;
}

function loadCfg() { try { return require('../lib/config.js').loadConfig(); } catch { return {}; } }

/**
 * The workspaces.* keys this collector reads (D30), validated as workspaces.js finalizeWorkspaces validates them (whole
 * days, at least 1), so the count window and the idle threshold are always the same number.
 */
function settings(cfg) {
  const w = (cfg && cfg.workspaces) || {};
  const int = (v, d) => (Number.isInteger(v) && v >= 1 ? v : d);
  return { windowDays: int(w.idleDays, 30), recentSessions: int(w.recentSessions, 12), attributeByFiles: w.attributeByFiles !== false };
}

// ── the incremental cache (D25) ──

function readCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.schema === SCHEMA && j.files && typeof j.files === 'object' && !Array.isArray(j.files)) return j;
  } catch { /* missing or damaged: rebuilt */ }
  return { schema: SCHEMA, files: {} };
}

function writeCache(file, files) {
  if (!file || !isDir(path.dirname(file))) return;
  try { require('../lib/fsx.js').writeAtomic(file, JSON.stringify({ schema: SCHEMA, files }) + '\n'); } catch { /* the next scan retries */ }
}

/** A custom title (a rename) beats an AI one wherever it was read; otherwise the newer read wins. */
function pickTitle(cur, next) {
  if (next && next.title && next.titleSource === 'custom') return { title: next.title, titleSource: 'custom' };
  if (cur && cur.title && cur.titleSource === 'custom') return { title: cur.title, titleSource: 'custom' };
  if (next && next.title) return { title: next.title, titleSource: next.titleSource || null };
  return cur && cur.title ? { title: cur.title, titleSource: cur.titleSource || null } : { title: null, titleSource: null };
}

function addTouches(into, from) {
  for (const [p, n] of Object.entries(from || {})) into[p] = (into[p] || 0) + (Number(n) || 0);
  return into;
}

/** Whether a record's transcript is the file named for its session id (not a stub that carries another's). */
function ownFile(rec) {
  return !!(rec.headId && rec.fileId && rec.headId.toLowerCase() === rec.fileId.toLowerCase());
}

/** Fold `from`'s later time and its touches into `into`. */
function foldInto(into, from) {
  if (msOf(from.lastAt) > msOf(into.lastAt)) into.lastAt = from.lastAt;
  if (from.touches) into.touches = addTouches({ ...(into.touches || {}) }, from.touches);
}

/** The last resort for a Claude transcript whose head names no cwd: its projects/<slug> folder decoded. */
function slugCwd(f) {
  if (f.host !== 'claude') return null;
  const slug = path.basename(path.dirname(f.file));
  return RUNTIME_CWD_RE.test(slug) ? decodeRuntimeCwd(slug) : null;
}

/**
 * The cache row for one listed transcript, reusing `old` when the file is unchanged and reading only what was appended
 * when it grew. → { row, changed }
 */
function indexFile(f, old, { wantTouches }) {
  const format = f.host === 'codex' ? 'codex' : 'claude';
  const same = !!(old && old.host === f.host && typeof old.size === 'number');
  let row = old;
  let changed = false;
  if (!same || old.size !== f.size || old.mtime !== f.mtimeMs) {
    changed = true;
    // Shorter than before: rewritten, so read it all again.
    const fresh = !same || f.size < old.size;
    row = fresh
      ? { host: f.host, format, size: 0, mtime: 0, offset: 0, head: null, title: null, titleSource: null, touches: null, touchCwd: null, lastAt: null }
      : { ...old };
    if (!row.head || row.size < HEAD_BYTES) {
      const h = sessionHead(f.file, HEAD_BYTES, { format });
      if (h) row.head = h;
    }
    let t = fresh && row.head ? pickTitle(null, row.head) : { title: row.title, titleSource: row.titleSource };
    const tail = sessionTail(f.file, { format });
    if (tail) {
      t = pickTitle(t, tail);
      row.lastAt = tail.lastAt;
    }
    row.title = t.title;
    row.titleSource = t.titleSource;
    row.size = f.size;
    row.mtime = f.mtimeMs;
    row.format = format;
  }
  const cwd = (row.head && row.head.startCwd) || slugCwd(f);
  if (wantTouches(cwd)) {
    // Read once from the start, then only what was appended; an offset past the end means the file was rewritten.
    const from = row.touches && Number.isInteger(row.offset) && row.offset <= f.size ? row.offset : 0;
    if (!row.touches || from < f.size) {
      const r = fileTouches(f.file, from, { cwd: from ? row.touchCwd : null, format });
      // A last line still being written (no newline yet) is read again next time; until it ends, nothing changed, so
      // the cache is not rewritten on every scan.
      const moved = r && (!row.touches || r.reset || r.offset !== row.offset || (r.cwd || null) !== (row.touchCwd || null)
        || Object.keys(r.touches || {}).length > 0);
      if (moved) {
        if (row === old) row = { ...old };
        row.touches = from && !r.reset ? addTouches({ ...row.touches }, r.touches) : r.touches;
        row.offset = r.offset;
        row.touchCwd = r.cwd || null;
        changed = true;
      }
    }
  }
  return { row, changed };
}

// ── what the vault records about sessions: team seats (team) ──

/** Every team's board (item id → its latest row) and the seat sessions its runs.jsonl names (D34: both providers). */
function teamRecords(vault) {
  const boards = new Map();
  const seats = new Map();
  if (!vault) return { boards, seats };
  const root = path.join(vault, 'persona', 'teams');
  for (const team of listDir(root).sort()) {
    const dir = path.join(root, team);
    if (!isDir(dir)) continue;
    const board = new Map();
    for (const r of readJsonl(path.join(dir, 'board.jsonl'))) if (typeof r.id === 'string') board.set(r.id, r);
    boards.set(team, board);
    for (const r of readJsonl(path.join(dir, 'runs.jsonl'))) {
      const id = str(r.session);
      if (!id) continue;
      const it = board.get(r.item);
      seats.set(id.toLowerCase(), { team, item: str(r.item), member: str(r.member), path: it ? str(it.path) : null });
    }
  }
  return { boards, seats };
}

// ── collect ──

// collectHostSessions() remembers its result against its byCwd, so attachSessions(workspaces, byCwd), today's call,
// gets the sessions behind those counts.
const COLLECTED = new WeakMap();

/**
 * opts: { vault, cfg (merged config; default loadConfig()), userConfig (for hostDirs; default cfg), env, now (ms),
 *         indexFile (default <vault>/brain/_index/session-index.json; null keeps no cache) }
 */
function collectHostSessions(opts = {}) {
  const vault = opts.vault === undefined ? VAULT : opts.vault;
  const cfg = opts.cfg || loadCfg();
  const userConfig = opts.userConfig === undefined ? cfg : opts.userConfig;
  const env = opts.env || process.env;
  const now = num(opts.now, Date.now());
  const set = settings(cfg);
  const indexPath = opts.indexFile !== undefined ? opts.indexFile : vault ? path.join(vault, 'brain', '_index', 'session-index.json') : null;
  const prev = indexPath ? readCache(indexPath) : { schema: SCHEMA, files: {} };

  const vaultRoots = variants(vault);
  const wsRoots = variants(vault && path.join(vault, 'workspaces'));
  // Only a session started in the vault outside its workspaces can earn the files credit, so only its touches are read.
  const wantTouches = (cwd) => set.attributeByFiles && !!abs(cwd) && insideAny(abs(cwd), vaultRoots) && !strictlyInsideAny(abs(cwd), wsRoots);

  const configDirs = [];
  const listed = [];
  let codexIndex = null;
  for (const host of HOSTS) {
    const dirs = hostDirs(host, { env, userConfig });
    configDirs.push(dirs.configDir);
    // A host that is off is still read (spec §4's matrix, D31): its threads show with Resume off, and a machine that
    // never ran it has no transcripts to list. The workspace hub read both hosts the same way.
    for (const f of sessionFiles(host, { dirs })) listed.push(f);
    if (host === 'codex') codexIndex = readSessionIndex(dirs.index);
  }

  const files = {};
  let dirty = Object.keys(prev.files).length !== listed.length;
  for (const f of listed) {
    const old = prev.files[f.file];
    const { row, changed } = indexFile(f, old, { wantTouches });
    files[f.file] = row;
    if (changed || !old) dirty = true;
  }
  if (dirty && indexPath) writeCache(indexPath, files);

  const teams = teamRecords(vault);
  const byKey = new Map();
  const keyless = [];
  const subagents = [];
  for (const f of listed) {
    const row = files[f.file];
    const head = row.head || {};
    const headId = str(head.id);
    const rec = {
      file: f.file, host: f.host, format: row.format, id: headId || f.id, headId, fileId: f.id, archived: !!f.archived,
      kind: head.kind || 'interactive', startedAt: head.startedAt || null, lastAt: row.lastAt || iso(f.mtimeMs),
      startCwd: str(head.startCwd) || slugCwd(f), title: row.title || null, titleSource: row.title ? row.titleSource : null,
      touches: row.touches || null, team: null,
    };
    if (rec.kind === 'subagent') { subagents.push({ rec, parentId: str(head.parentId) }); continue; }
    if (!rec.title && rec.host === 'codex' && codexIndex && rec.id && codexIndex[rec.id]) {
      rec.title = codexIndex[rec.id].title;
      rec.titleSource = 'index';
    }
    if (!rec.title && head.firstPrompt) { rec.title = head.firstPrompt; rec.titleSource = 'prompt'; }
    const key = rec.id ? `${rec.host}:${rec.id.toLowerCase()}` : null;
    if (!key) { keyless.push(rec); continue; }
    const twin = byKey.get(key);
    if (!twin) { byKey.set(key, rec); continue; }
    // Two transcripts name one session (Claude writes small stub files whose entries carry another session's id): one
    // record, the file named for that id, with the other's time and touches folded in.
    const keep = ownFile(rec) && !ownFile(twin) ? rec : twin;
    const other = keep === rec ? twin : rec;
    foldInto(keep, other);
    if (!keep.title && other.title) { keep.title = other.title; keep.titleSource = other.titleSource; }
    byKey.set(key, keep);
  }
  const sessions = [...byKey.values(), ...keyless];
  for (const rec of sessions) {
    const key = rec.id ? rec.id.toLowerCase() : null;
    rec.team = key ? teams.seats.get(key) || null : null;
  }
  // A Codex thread_spawn subagent is part of its parent's work: its time and touches fold into the thread at the top
  // of its chain (a subagent's own subagents climb through it). A guardian (no parent) and a subagent whose chain
  // reaches no listed thread are dropped.
  const subByKey = new Map();
  for (const sa of subagents) if (sa.rec.id) subByKey.set(`${sa.rec.host}:${sa.rec.id.toLowerCase()}`, sa);
  for (const { rec, parentId } of subagents) {
    let pid = parentId;
    for (let hop = 0; pid && hop < SUBAGENT_HOPS; hop++) {
      const k = `${rec.host}:${pid.toLowerCase()}`;
      if (byKey.has(k)) { foldInto(byKey.get(k), rec); break; }
      pid = subByKey.has(k) ? subByKey.get(k).parentId : null;
    }
  }
  sessions.sort((a, b) => msOf(b.lastAt) - msOf(a.lastAt));

  const byCwd = {};
  for (const s of sessions) {
    if (!s.startCwd) continue;
    const e = byCwd[s.startCwd] || (byCwd[s.startCwd] = { claude: 0, codex: 0, lastAt: null });
    e[s.host] += 1;
    if (s.lastAt && (!e.lastAt || msOf(s.lastAt) > msOf(e.lastAt))) e.lastAt = s.lastAt;
  }
  const result = {
    sessions, byCwd, windowDays: set.windowDays, scannedAt: new Date().toISOString(),
    settings: set, vault, now, configDirs, boards: teams.boards,
  };
  COLLECTED.set(byCwd, result);
  return result;
}

// ── attach ──

/**
 * The git checkout a folder sits in, without running git: { root, main, worktree } or null. Never home or `/`, and
 * never at or above `ceiling` when one is given (a test's own root).
 */
function gitInfoOf(dir, home, ceiling) {
  const start = abs(dir);
  if (!start || !isDir(start)) return null;
  for (let d = start; ; d = path.dirname(d)) {
    if (d === home || d === path.dirname(d)) return null; // a dotfiles repo at home is not this folder's project
    if (ceiling && !(d !== ceiling && insideDir(d, ceiling))) return null;
    const g = path.join(d, '.git');
    let st = null;
    try { st = fs.lstatSync(g); } catch { /* keep walking */ }
    if (st && st.isDirectory()) return { root: d, main: d, worktree: false };
    if (st && st.isFile()) {
      const text = readSmall(g);
      if (text == null) return null;
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      const gitdir = m ? path.resolve(d, m[1]) : null;
      const w = gitdir && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
      return w ? { root: d, main: w[1], worktree: true } : { root: d, main: d, worktree: false };
    }
  }
}

function branchOf(repo) {
  const head = readSmall(path.join(repo, '.git', 'HEAD'));
  const m = head && /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim());
  return m ? m[1] : null;
}

/** brain/_index/workspaces-hidden.json: the outside folders the user hid (D21, D30), { schema: 1, paths: [...] }. */
function readHidden(vault, home) {
  if (!vault) return [];
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(vault, 'brain', '_index', 'workspaces-hidden.json'), 'utf8')); } catch { return []; }
  const list = Array.isArray(j) ? j : j && Array.isArray(j.paths) ? j.paths : [];
  return list.map((p) => (p && typeof p === 'object' ? p.path : p)).map((p) => abs(expandHome(p, home))).filter(Boolean);
}

/** The second argument as collected sessions: a collectHostSessions() result, its byCwd, or else a fresh collect. */
function resolveCollected(data, opts) {
  const known = data && typeof data === 'object' ? (Array.isArray(data.sessions) ? data : COLLECTED.get(data)) : null;
  // Collected for another vault (paths.js resolved one vault, the caller names another): collect for the caller's.
  if (known && (opts.vault === undefined || abs(opts.vault) === abs(known.vault))) return { collected: known, opts };
  if (known) return { collected: collectHostSessions(opts), opts };
  // attachSessions(workspaces, opts): an options object where the sessions would go (no key is a path).
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [];
  const asOpts = keys.length > 0 && !keys.some((k) => /^([A-Za-z]:)?[\\/]/.test(k)) && !Object.keys(opts).length;
  const o = asOpts ? data : opts;
  return { collected: collectHostSessions(o), opts: o };
}

/**
 * Give each workspace its `sessions` and return the start folders that belong to no workspace (module comment).
 * opts: { vault, home, tmpDirs (the temp folders to drop; default the OS ones), ignore (extra exact paths), now,
 *         gitCeiling (no .git is looked for at or above it; a test's root) }
 */
function attachSessions(workspaces, collected, opts = {}) {
  const r = resolveCollected(collected, opts || {});
  const data = r.collected;
  opts = r.opts || {};
  const list = Array.isArray(workspaces) ? workspaces.filter((w) => w && typeof w === 'object') : [];
  const vault = opts.vault === undefined ? (data.vault === undefined ? VAULT : data.vault) : opts.vault;
  const home = abs(opts.home) || os.homedir();
  const set = data.settings || settings({});
  const now = num(opts.now, num(data.now, Date.now()));
  const cutoff = now - set.windowDays * DAY_MS;
  const vaultRoots = variants(vault);
  const wsRoots = variants(vault && path.join(vault, 'workspaces'));
  const worktreesRoots = wsRoots.map((w) => path.join(w, '_worktrees'));

  // Roots → workspace. A root is never home, `/`, the vault, workspaces/ itself, anything holding the vault, or a
  // folder under workspaces/_worktrees (D20, D22).
  const rootMap = new Map();
  const badRoot = (p) => p === home || p === path.dirname(p) || insideAny(p, worktreesRoots) || vaultRoots.some((v) => insideDir(v, p)) || wsRoots.includes(p);
  for (const ws of list) {
    const own = ws.absPath || (typeof ws.path === 'string' && ws.path ? ws.path : null); // `path` is vault-relative
    const roots = [own, ws.repoPath, ...(Array.isArray(ws.aliases) ? ws.aliases : [])]
      .map((p) => (typeof p === 'string' && p && !path.isAbsolute(p) && !p.startsWith('~') && vault ? path.resolve(vault, p) : expandHome(p, home)));
    for (const root of roots.flatMap(variants)) if (!badRoot(root) && !rootMap.has(root)) rootMap.set(root, ws);
  }
  const bestRoot = (p) => {
    const a = abs(p);
    if (!a) return null;
    for (let d = a; ; d = path.dirname(d)) {
      if (rootMap.has(d)) return rootMap.get(d); // walking up, the first root met is the longest
      if (d === path.dirname(d)) return null;
    }
  };
  // Names for the vanished-worktree rule: each workspace's name (an archived one's label) and its aliases' folder names.
  const names = [];
  for (const ws of list) {
    const own = typeof ws.label === 'string' && ws.label ? ws.label : ws.name;
    const all = [own, ...(Array.isArray(ws.aliases) ? ws.aliases.map((a) => (typeof a === 'string' ? path.basename(a) : null)) : [])];
    for (const n of all) if (typeof n === 'string' && n && n !== '_worktrees') names.push({ name: n, ws, live: !ws.hidden });
  }
  const nameMatch = (seg) => {
    if (!seg) return null;
    let best = null;
    for (const c of names) {
      if (seg !== c.name && !seg.startsWith(`${c.name}-`)) continue;
      if (!best || c.name.length > best.name.length || (c.name.length === best.name.length && c.live && !best.live)) best = c;
    }
    return best ? best.ws : null;
  };
  const boards = data.boards || teamRecords(vault).boards;
  const itemTarget = (it) => (it && str(it.path) && vault ? bestRoot(path.resolve(vault, it.path)) : null);
  const itemById = (id) => {
    for (const board of boards.values()) if (board.has(id)) return board.get(id);
    return null;
  };
  const gitCeiling = abs(opts.gitCeiling);
  const gitMemo = new Map();
  const gitInfo = (p) => {
    if (!gitMemo.has(p)) gitMemo.set(p, gitInfoOf(p, home, gitCeiling));
    return gitMemo.get(p);
  };
  const existsMemo = new Map();
  const exists = (p) => {
    if (!p) return false;
    if (!existsMemo.has(p)) existsMemo.set(p, isDir(p));
    return existsMemo.get(p);
  };
  // <repo>.worktrees/<x>/… → { repo, checkout: <repo>.worktrees/<x> }. As in gitInfoOf, nothing at or above home is the
  // project of a folder under home, so a home that itself sits in some <repo>.worktrees/<x> never folds ~/… into <repo>.
  const homeDepths = variants(home).map((h) => [h, h.split(path.sep).length]);
  const worktreesDirOf = (cwd) => {
    const parts = cwd.split(path.sep);
    const under = homeDepths.find(([h]) => cwd !== h && insideDir(cwd, h));
    for (let i = parts.length - 2; i >= (under ? under[1] : 1); i--) {
      const s = parts[i];
      if (s.length > WORKTREES_SUFFIX.length && s.endsWith(WORKTREES_SUFFIX)) {
        return { repo: [...parts.slice(0, i), s.slice(0, -WORKTREES_SUFFIX.length)].join(path.sep), checkout: parts.slice(0, i + 2).join(path.sep) };
      }
    }
    return null;
  };

  const worktreeTarget = (cwd) => {
    const g = gitInfo(cwd);
    if (g && g.worktree) { const hit = bestRoot(g.main); if (hit) return hit; }
    for (const wsRoot of wsRoots) {
      if (cwd === wsRoot || !insideDir(cwd, wsRoot)) continue;
      const segs = path.relative(wsRoot, cwd).split(path.sep);
      if (segs[0] === '_worktrees') {
        // Which segment is the item depends on the layout; a team id or a member folder is never matched by name, so a
        // team named like a workspace cannot take its seats.
        const [a, b] = segs.slice(1);
        const board = a ? boards.get(a) : null;
        let hit = null;
        // today's _worktrees/<team>/<item>/<member>, then a team folder whose board is gone, then the older
        // _worktrees/<item>/<member>
        if (board) hit = (b && itemTarget(board.get(b))) || nameMatch(b);
        else if (b && ITEM_SHAPE_RE.test(b) && !ITEM_SHAPE_RE.test(a)) hit = itemTarget(itemById(b)) || nameMatch(b);
        else if (a) hit = itemTarget(itemById(a)) || nameMatch(a);
        if (hit) return hit;
      } else if (segs[0] === '.worktrees' && segs[1]) {
        const hit = nameMatch(segs[1]);
        if (hit) return hit;
      }
    }
    const w = worktreesDirOf(cwd);
    return w ? bestRoot(w.repo) : null;
  };

  const filesTarget = (s) => {
    const cwd = abs(s.startCwd);
    if (!set.attributeByFiles || !s.touches || !cwd || !insideAny(cwd, vaultRoots) || strictlyInsideAny(cwd, wsRoots)) return null;
    const tally = new Map();
    for (const [p, n] of Object.entries(s.touches)) {
      const ws = bestRoot(p);
      if (ws) tally.set(ws, (tally.get(ws) || 0) + (Number(n) || 0));
    }
    let best = null;
    let second = 0;
    for (const [ws, n] of tally) {
      if (!best || n > best.n) { if (best) second = Math.max(second, best.n); best = { ws, n }; } else second = Math.max(second, n);
    }
    return best && best.n >= 3 && best.n > second ? best.ws : null;
  };

  /** D20's order. → { ws, via } or null */
  const attribute = (s) => {
    if (s.team) {
      const ws = itemTarget(s.team);
      if (ws) return { ws, via: 'team' };
    }
    const cwd = abs(s.startCwd);
    if (cwd) {
      const ws = bestRoot(cwd);
      if (ws) return { ws, via: 'cwd' };
      const wt = worktreeTarget(cwd);
      if (wt) return { ws: wt, via: 'worktree' };
    }
    const byFiles = filesTarget(s);
    return byFiles ? { ws: byFiles, via: 'files' } : null;
  };

  const buckets = new Map();
  for (const ws of list) buckets.set(ws, []);
  const unclaimed = [];
  for (const s of data.sessions || []) {
    const hit = attribute(s);
    if (hit && buckets.has(hit.ws)) buckets.get(hit.ws).push({ s, via: hit.via });
    else unclaimed.push(s);
  }

  const recentRow = ({ s, via }) => {
    const cwd = abs(s.startCwd) || s.startCwd || null;
    const seat = !!abs(cwd) && insideAny(abs(cwd), worktreesRoots);
    // A session the old Sessions tab ran is the headless host session it was, credited like any other (remove-sessions D5).
    const kind = s.team || seat ? 'team' : s.kind;
    let reason = null;
    if (kind === 'team') reason = REASONS.team;
    else if (s.archived) reason = REASONS.archived;
    else if (s.host === 'claude' && s.kind === 'headless') reason = REASONS.headless;
    // A Codex exec (or mcp) thread resumes by id: `codex resume <id>` takes any recorded session, as
    // --include-non-interactive filters only the picker and --last (codex-cli 0.162.0's help, read 2026-10-10; D34).
    else if (!s.headId) reason = REASONS.noId;
    else if (!UUID_RE.test(s.headId) || s.headId !== s.fileId) reason = REASONS.idMismatch;
    const row = {
      id: s.id, host: s.host, format: s.format, kind, title: s.title, titleSource: s.titleSource,
      startedAt: s.startedAt, lastAt: s.lastAt, cwd, startExists: exists(abs(cwd)), via, resumable: !reason, reason,
    };
    return row;
  };
  for (const ws of list) {
    const rows = buckets.get(ws);
    const out = { claude: 0, codex: 0, total: 0, lastAt: null, windowDays: set.windowDays, recent: [] };
    for (const { s } of rows) {
      if (msOf(s.lastAt) >= cutoff) out[s.host] += 1;
      if (s.lastAt && (!out.lastAt || msOf(s.lastAt) > msOf(out.lastAt))) out.lastAt = s.lastAt;
    }
    out.total = out.claude + out.codex;
    rows.sort((a, b) => msOf(b.s.lastAt) - msOf(a.s.lastAt));
    out.recent = rows.slice(0, set.recentSessions).map(recentRow);
    ws.sessions = out;
  }

  // ── the outside list (D21) ──
  const homes = variants(home);
  const tempRoots = (Array.isArray(opts.tmpDirs) ? opts.tmpDirs : [os.tmpdir(), ...TEMP_DIRS]).flatMap(variants);
  const configRoots = (data.configDirs || []).flatMap(variants);
  const hiddenRoots = readHidden(vault, home).flatMap(variants);
  const ignore = new Set((Array.isArray(opts.ignore) ? opts.ignore : []).map(abs).filter(Boolean));
  // workspaces/_worktrees, dot-folders under workspaces/, the _archive/ folder itself and the terminal deck's reserved
  // Scratch place (workspaces/scratch, terminalLaunch.ts SCRATCH) are infrastructure, never a project to adopt (D21,
  // D22); a vanished _archive/<n> still shows.
  const infraUnderWorkspaces = (cwd) => wsRoots.some((w) => {
    if (cwd === w || !insideDir(cwd, w)) return false;
    const rel = path.relative(w, cwd);
    const top = rel.split(path.sep)[0];
    return top === '_worktrees' || top === 'scratch' || top.startsWith('.') || rel === '_archive';
  });
  const dropped = (cwd) => homes.includes(cwd) || ignore.has(cwd)
    || insideAny(cwd, configRoots) || insideAny(cwd, tempRoots) || insideAny(cwd, hiddenRoots)
    || (insideAny(cwd, vaultRoots) && !strictlyInsideAny(cwd, wsRoots)) || infraUnderWorkspaces(cwd);

  const rows = new Map();
  for (const s of unclaimed) {
    const cwd = abs(s.startCwd);
    if (!cwd || dropped(cwd)) continue;
    // A worktree folds into its main repository's row; so does a vanished <repo>.worktrees/<x> whose <repo> is a repo.
    let key = cwd;
    let checkout = null;
    const g = gitInfo(cwd);
    if (g && g.worktree) { key = g.main; checkout = g.root; } else if (!g && !exists(cwd)) {
      const w = worktreesDirOf(cwd);
      const rg = w ? gitInfo(w.repo) : null;
      if (rg && !rg.worktree && rg.root === w.repo) { key = w.repo; checkout = w.checkout; }
    }
    if (key !== cwd && dropped(key)) continue;
    const row = rows.get(key) || { cwd: key, claude: 0, codex: 0, total: 0, lastAt: null, checkouts: new Set() };
    rows.set(key, row);
    if (msOf(s.lastAt) >= cutoff) row[s.host] += 1;
    row.total = row.claude + row.codex;
    if (s.lastAt && (!row.lastAt || msOf(s.lastAt) > msOf(row.lastAt))) row.lastAt = s.lastAt;
    if (checkout) row.checkouts.add(checkout);
  }
  // `match`: a workspace of the same name, compared as slugs, so a "Field Notes" folder matches field-notes.
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const matchable = new Map();
  for (const ws of list) if (!ws.hidden && typeof ws.name === 'string' && slug(ws.name) && !matchable.has(slug(ws.name))) matchable.set(slug(ws.name), ws.name);
  const outside = [...rows.values()].map((row) => {
    const g = gitInfo(row.cwd);
    const main = g && !vaultRoots.includes(g.main) ? g.main : null; // the vault's own repo is never the row's (D24)
    return {
      cwd: row.cwd, claude: row.claude, codex: row.codex, total: row.total, lastAt: row.lastAt,
      exists: exists(row.cwd),
      match: matchable.get(slug(path.basename(row.cwd))) || null,
      git: main ? { root: main, branch: branchOf(main) } : null,
      worktrees: row.checkouts.size,
    };
  });
  outside.sort((a, b) => (msOf(b.lastAt) - msOf(a.lastAt)) || (b.total - a.total));
  return outside;
}

module.exports = { collectHostSessions, attachSessions, insideDir, RUNTIME_CWD_RE, REASONS };
