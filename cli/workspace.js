'use strict';
/**
 * workspace.js — `aos workspace <verb>` over <vault>/workspaces/ (workspace hub spec D3; spaces-redesign D15–D18, D28).
 *   list [--json]                    every workspace with status and per-host session counts, then the working
 *                                    directories sessions ran in outside workspaces/; --json prints the snapshot's
 *                                    entries whole, hidden ones (`_` folders, _archive/) included
 *   which [--cwd <path>] [--json]    the workspace a folder belongs to (default: this process's folder), by D20's roots
 *                                    (the folder, `repo:`, `aliases:`) and worktree walk: { name, slug, via }, all null
 *                                    outside any workspace (or in a hidden one)
 *   new <name> [--git] [--pin] [--empty] [--json]
 *                                    workspaces/<slug>/ with README.md, CLAUDE.md and AGENTS.md stubs; --git runs
 *                                    `git init` there, --pin writes `pinned: true`, --empty writes nothing at all (a
 *                                    `git clone … .` goes there next, then `stubs <slug> --pin`)
 *   stubs <name> [--pin] [--json]    the stubs a workspace lacks, never overwriting or writing through a link
 *   adopt <path> --into <ws> [--json]
 *                                    record an outside folder under <ws>'s `aliases:`, so its sessions count there;
 *                                    nothing moves (D16). The path must be a current outside row's folder
 *   adopt <path> [--name <slug>]     move a project folder into workspaces/ and add the missing stubs (terminals only)
 *   archive <ws> [--json]            workspaces/<ws> → workspaces/_archive/<ws>, its map too; project notes' status tag
 *                                    flips to status/archived; its Sessions threads stay, read-only (D17)
 *   restore <ws> [--json]            workspaces/_archive/<ws> → workspaces/<ws>, the reverse of archive
 *   rename <ws> <new-name> [--json]  the folder, its map and its Sessions threads move; `aliases:` keeps the old name
 *   hide <path> | unhide <path> [--json]
 *                                    an outside folder into or out of brain/_index/workspaces-hidden.json (D21)
 *   draft <ws> [--json]              a summary, objectives and next step for workspace.md, for review: no workspace file
 *                                    is written (D13, D14; lib/workspace-draft.js)
 *   set <ws> --set <json> [--expect <hash>] [--dry-run] [--json]
 *                                    allow-listed workspace.md keys (status, pinned, objectives, summary, next, repo),
 *                                    refused when the file's hash is not --expect (D18; lib/workspace-manifest.js)
 *
 * Safety (spaces-redesign §6): names resolve to direct children of workspaces/ (of _archive/ for restore); a new name
 * is free, not reserved, not `scratch` and not held by an archived workspace; paths are absolute or `~/`, outside the
 * vault, not `/` or home, neither inside nor containing either host's config folder (lib/host.js hostDirs), and adopt's
 * and hide's must be the folder of a current outside row, unhide's a stored entry. The verbs write only under
 * workspaces/** and brain/_index/**, plus one exception: the `status/` tag line of a project note in
 * brain/memory/projects/ linked by `workspace:` or its exact slug (never through a symlink). Folders move only between
 * workspaces/ and workspaces/_archive/; nothing is deleted. archive, restore and rename refuse a running team item, a
 * Sessions turn left unfinished in the last 30 minutes and a repository with linked git worktrees; every moving verb
 * (adopt's move form included) refuses a headless run (AOS_HEADLESS=1). Each write is atomic and follows no link, and
 * each verb that writes refreshes the snapshot's workspaces and outside rows (no model call).
 *
 * Slugs are lowercase kebab-case. CLAUDE.md and AGENTS.md carry the same text: Claude Code reads the first, Codex reads
 * the second, and neither can include the other. Runs from the checkout and from the vendored copy. Zero dependencies;
 * every external effect is injectable (opts).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERBS = ['list', 'which', 'new', 'stubs', 'adopt', 'archive', 'restore', 'rename', 'hide', 'unhide', 'draft', 'set'];
const RESERVED = new Set(['_archive', 'research']);
// The terminal deck's shared place (terminalLaunch.ts SCRATCH): never made, renamed, archived or restored here.
const SCRATCH = 'scratch';
const ARCHIVE = '_archive';
const REPO = path.join(__dirname, '..');
// A new name as the page passes it (surfaces.ts KEBAB): rename takes only this; new slugifies for terminal use.
const KEBAB_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// set --expect (surfaces.ts HASH): workspace.md's sha256 as `draft` read it, or `none` for a workspace without one.
const HASH_RE = /^(?:none|[0-9a-f]{16,64})$/;
const LINE_BREAKS = /[\0\n\r\u2028\u2029]/;
// A Sessions turn whose prompt has no `done` after it and is younger than this is taken as running (spec §6).
const TURN_WINDOW_MS = 30 * 60 * 1000;
const THREAD_TAIL_BYTES = 1024 * 1024;
const MAX_TEXT = 256 * 1024;
const SMALL = 4096;

// The flags each verb takes (spaces-redesign §4: the page's rules fix their order; a terminal may give any order).
const VALUE_FLAGS = new Map([['name', 'name'], ['into', 'into'], ['cwd', 'cwd'], ['set', 'set'], ['expect', 'expect']]);
const BOOL_FLAGS = new Map([['json', 'json'], ['git', 'git'], ['pin', 'pin'], ['empty', 'empty'], ['dry-run', 'dryRun']]);
const VERB_FLAGS = {
  list: ['json'], which: ['json', 'cwd'], new: ['json', 'git', 'pin', 'empty'], stubs: ['json', 'pin'],
  adopt: ['json', 'name', 'into'], archive: ['json'], restore: ['json'], rename: ['json'], hide: ['json'], unhide: ['json'],
  draft: ['json'], set: ['json', 'set', 'expect', 'dryRun'],
};
// How many words each verb takes after its own: [min, max]; new joins its words into one name.
const VERB_ARGS = {
  list: [0, 0], which: [0, 0], new: [1, Infinity], stubs: [1, 1], adopt: [1, 1], archive: [1, 1], restore: [1, 1],
  rename: [2, 2], hide: [1, 1], unhide: [1, 1], draft: [1, 1], set: [1, 1],
};
const USAGE = {
  list: 'aos workspace list [--json]',
  which: 'aos workspace which [--cwd <path>] [--json]',
  new: 'aos workspace new <name> [--git] [--pin] [--empty] [--json]',
  stubs: 'aos workspace stubs <name> [--pin] [--json]',
  adopt: 'aos workspace adopt <path> --into <workspace> [--json] | adopt <path> [--name <slug>]',
  archive: 'aos workspace archive <workspace> [--json]',
  restore: 'aos workspace restore <archived workspace> [--json]',
  rename: 'aos workspace rename <workspace> <new-name> [--json]',
  hide: 'aos workspace hide <path> [--json]',
  unhide: 'aos workspace unhide <path> [--json]',
  draft: 'aos workspace draft <workspace> [--json]',
  set: 'aos workspace set <workspace> --set <json> [--expect <hash>] [--dry-run] [--json]',
};

class UsageError extends Error {}

function resolveScript(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(REPO, 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return p;
  throw new Error(`${rel} not found beside cli/workspace.js — run \`aos upgrade\``);
}
function resolveModule(rel) { return require(resolveScript(rel)); }
const manifestLib = () => resolveModule('lib/workspace-manifest.js');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function exists(p) { return fs.existsSync(p); }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }
// The native realpath: on a case-insensitive file system (macOS) it answers the case stored on disk, so `~/.CLAUDE` and
// `~/VAULT` compare as the host config folder and the vault they are (spaces-redesign §6).
function realOrNull(p) { try { return fs.realpathSync.native(p); } catch { return null; } }
function readdirSafe(p) { try { return fs.readdirSync(p); } catch { return []; } }
/** Whether `child` is `parent` or inside it (lexically). */
function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function insideDir(child, parent) { return within(path.resolve(child), path.resolve(parent)); }
/**
 * A path as given (resolved) and as its real path, so macOS's /var and /private/var compare as one folder. A path that
 * does not exist (a vanished folder, a board item's path) takes its nearest existing parent's real path.
 */
function variants(p) {
  const abs = path.resolve(p);
  const out = new Set([abs]);
  const tail = [];
  for (let head = abs; ;) {
    const r = realOrNull(head);
    if (r) { out.add(path.join(r, ...tail)); break; }
    const up = path.dirname(head);
    if (up === head) break;
    tail.unshift(path.basename(head));
    head = up;
  }
  return [...out];
}
/** `a` inside `b` in any spelling of either. */
function insideAnySpelling(a, b) { const vb = variants(b); return variants(a).some((x) => vb.some((y) => within(x, y))); }
function overlaps(a, b) { return insideAnySpelling(a, b) || insideAnySpelling(b, a); }
function samePath(a, b) { const vb = variants(b); return variants(a).some((x) => vb.includes(x)); }
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function expandHome(p, home) { return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p; }
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}
/** A small regular file's text, never through a link; null otherwise. */
function readSmall(file, max = SMALL) {
  const st = lstatOrNull(file);
  if (!st || !st.isFile() || st.size > max) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * A runtime folder of the vault by its vault-relative path (spaces-redesign §6): every part below the vault a plain
 * directory, never a link or a file, and its real path the vault's own. So a `workspace-maps/_archive -> ~/.claude`, a
 * `brain/memory -> elsewhere` or a linked `brain/_index/sessions` never takes a verb's write out of the vault. `make`
 * creates a missing part with a plain mkdir (its parent was just checked). → the real path, or null when a part is
 * missing (and not made); throws when a part is a link or a file, or the folder resolves elsewhere.
 */
function runtimeDir(ctx, rel, { make = false } = {}) {
  const segs = rel.split('/');
  const realVault = fs.realpathSync(ctx.vault);
  let cur = ctx.vault;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st = lstatOrNull(cur);
    if (!st && make) {
      try { fs.mkdirSync(cur); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
      st = lstatOrNull(cur);
    }
    if (!st) return null;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${segs.slice(0, i + 1).join('/')} is not a plain folder (a link or a file): refusing to write through it`);
  }
  const real = fs.realpathSync(cur);
  if (real !== path.join(realVault, ...segs)) throw new Error(`${rel} resolves outside the vault`);
  return real;
}

function resolveCtx(opts = {}) {
  const H = resolveModule('lib/host.js');
  const env = opts.env || process.env;
  const configDir = opts.configDir || H.claudeConfigDir(env);
  const cfg = readJson(env.AOS_CONFIG || path.join(configDir, 'agenticos.json')) || {};
  // Test the configured value before resolving it: path.resolve('') is the cwd, so comparing the resolved path with it
  // refused every run from the vault root (`aos workspace new <name>` there said "no vault configured").
  const configured = String(opts.vault || env.AOS_VAULT || cfg.vault || '').trim();
  if (!configured) throw new Error('no vault configured (run `aos init` first)');
  const vault = path.resolve(configured);
  const home = path.resolve(opts.home || os.homedir());
  // Both hosts' config folders through lib/host.js hostDirs (spaces-redesign §6): agenticos.json's claudeConfigDir,
  // else the config dir this command read; hosts.codex.home, else CODEX_HOME, else ~/.codex.
  const userConfig = { ...cfg, claudeConfigDir: cfg.claudeConfigDir || configDir };
  const claudeDir = H.hostDirs('claude', { env, userConfig }).configDir;
  const codexHome = H.hostDirs('codex', { env, userConfig }).configDir;
  // tmpDirs: the temp folders the outside list drops (hostSessions.js D21); a test seam, since tests live in one.
  const tmpDirs = Array.isArray(opts.tmpDirs) ? opts.tmpDirs : undefined;
  return { configDir, cfg, vault, workspacesDir: path.join(vault, 'workspaces'), claudeDir, codexHome, home, env, tmpDirs };
}

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
/** `_archive` and `research` are the vault's own folders under workspaces/, whatever the user typed. */
function isReserved(name, slug) {
  return RESERVED.has(slug) || RESERVED.has(String(name || '').trim().toLowerCase()) || RESERVED.has('_' + slug);
}
/** A reserved name or Scratch: never made, renamed, archived or restored by these verbs (spec §6). */
function heldName(name) {
  const slug = slugify(name);
  return isReserved(name, slug) || slug === SCRATCH;
}
function titleOf(slug) { return slug.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' '); }
function shorten(p, home) {
  if (!home || typeof p !== 'string') return p;
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}
/** How a folder is written into a file: `~/…` under home, else absolute (spaces-redesign D16). */
function storedForm(abs, home) {
  const rel = path.relative(home, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : abs;
}
function refuseHeadless(env, what) {
  if (env && env.AOS_HEADLESS === '1') {
    throw new Error(`${what} moves a folder, and a headless run (AOS_HEADLESS=1: a duty, routine or background job) never does; ask the user to run it`);
  }
}

// ── stubs ──

/** The three stubs. CLAUDE.md and AGENTS.md are identical on purpose. */
function stubs(slug) {
  const title = titleOf(slug);
  const instructions = [
    `# ${title} — project instructions`,
    '',
    `This is the \`workspaces/${slug}/\` workspace of an AgenticOS vault. Project notes, plans and status live here;`,
    'durable knowledge goes to the vault\'s memory through `/remember` and `/wrap` (Claude Code) or `$agenticos:remember` and',
    '`$agenticos:wrap` (Codex; `$remember` and `$wrap` when Codex is wired directly).',
    '',
    '<!-- CLAUDE.md and AGENTS.md carry the same text: Claude Code reads the first, Codex the second. Edit both. -->',
    '',
  ].join('\n');
  return {
    'README.md': `# ${title}\n\nOne line about what this project is.\n\n## Objectives\n\n- \n\n## Next step\n\n- \n`,
    'CLAUDE.md': instructions,
    'AGENTS.md': instructions,
  };
}

/** A file created only when nothing is at `p` (a dangling link counts as something): false when something was. */
function createExclusive(p, data) {
  let fd;
  try { fd = fs.openSync(p, 'wx'); } catch (e) { if (e && e.code === 'EEXIST') return false; throw e; }
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
  return true;
}

/** A regular file's text in `dir` when lstat says regular and its realpath is inside `dir`; null for a link or else. */
function regularText(dir, name, max = MAX_TEXT) {
  const file = path.join(dir, name);
  const st = lstatOrNull(file);
  if (!st || !st.isFile() || st.size > max) return null;
  const real = realOrNull(file);
  const realDir = realOrNull(dir);
  if (!real || !realDir || path.dirname(real) !== realDir) return null;
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
}

/**
 * Write the stubs that are missing (spaces-redesign §6): each is created with 'wx', so an existing file, folder or link
 * (dangling or not) is never overwritten or written through. When exactly one instruction file exists and it is a
 * regular file inside the folder, the other mirrors it; one that is a link is never mirrored, and the missing one gets
 * the stub text instead.
 */
function completeStubs(dir, slug) {
  const written = [];
  const s = stubs(slug);
  const hasClaude = !!lstatOrNull(path.join(dir, 'CLAUDE.md'));
  const hasAgents = !!lstatOrNull(path.join(dir, 'AGENTS.md'));
  if (hasClaude !== hasAgents) {
    const [from, to] = hasClaude ? ['CLAUDE.md', 'AGENTS.md'] : ['AGENTS.md', 'CLAUDE.md'];
    const text = regularText(dir, from);
    if (text !== null && createExclusive(path.join(dir, to), text)) written.push(`${to} (mirrored from ${from})`);
  }
  for (const name of Object.keys(s)) if (createExclusive(path.join(dir, name), s[name])) written.push(name);
  return written;
}

// ── output ──

function emit(io, json, obj, lines) {
  if (json) io.log(JSON.stringify(obj, null, 2));
  else for (const l of lines) io.log(l);
}

// ── scans ──

/** The merged config as lib/config.js builds it for this vault and the agenticos.json this command read (D30). */
function mergedCfg(ctx) {
  const { DEFAULTS, deepMerge } = resolveModule('lib/config.js');
  return structuredClone(deepMerge(deepMerge(DEFAULTS, readJson(path.join(ctx.vault, 'brain', 'config.json')) || {}), ctx.cfg));
}

function attachOpts(ctx) { return { vault: ctx.vault, home: ctx.home, ...(ctx.tmpDirs ? { tmpDirs: ctx.tmpDirs } : {}) }; }

/** A fresh scan of the workspaces and both hosts' sessions, as scan-vault.js runs it (no model call). */
function freshScan(ctx, { prev = [], finalize = true } = {}) {
  process.env.AOS_VAULT = ctx.vault;
  const { collectWorkspaces, finalizeWorkspaces } = resolveModule('collectors/workspaces.js');
  const { collectHostSessions, attachSessions } = resolveModule('collectors/hostSessions.js');
  const cfg = mergedCfg(ctx);
  const workspaces = collectWorkspaces({ vault: ctx.vault, home: ctx.home });
  // Host folders through lib/host.js hostDirs: agenticos.json's claudeConfigDir, else the config dir this command used.
  const userConfig = { ...cfg, claudeConfigDir: cfg.claudeConfigDir || ctx.configDir };
  const collected = collectHostSessions({ vault: ctx.vault, cfg, userConfig, indexFile: path.join(ctx.vault, 'brain', '_index', 'session-index.json') });
  const outside = attachSessions(workspaces, collected, attachOpts(ctx));
  // Status, activity and git read the attached sessions, as in scan-vault.js (spaces-redesign D11).
  if (finalize) finalizeWorkspaces(workspaces, { vault: ctx.vault, cfg, prev });
  return { workspaces, outside, collected };
}

/** Workspaces with sessions: from the last snapshot when it has hostSessions, else a fresh scan. */
function workspaceRows(ctx) {
  const snap = readJson(path.join(ctx.vault, 'brain', '_index', 'snapshot.json'));
  if (snap && Array.isArray(snap.workspaces) && snap.hostSessions) {
    return { workspaces: snap.workspaces, outside: snap.hostSessions.outsideWorkspaces || [], source: 'snapshot', scannedAt: snap.scannedAt };
  }
  const { workspaces, outside } = freshScan(ctx, { prev: snap && Array.isArray(snap.workspaces) ? snap.workspaces : [] });
  return { workspaces, outside, source: 'scan', scannedAt: new Date().toISOString() };
}

/**
 * After a verb writes: the snapshot's workspaces and outside rows rescanned in place, under the snapshot lock, as
 * regen-workspace-insight.js patches its insight. No model call: an insight whose inputs changed is regenerated by the
 * next full scan. Nothing happens before the first scan has written a snapshot. Never fails the verb.
 */
async function refreshSnapshot(ctx, opts = {}) {
  if (opts.rescan === false) return false;
  const file = path.join(ctx.vault, 'brain', '_index', 'snapshot.json');
  // Never through a linked brain/ or brain/_index (spaces-redesign §6): no refresh then, as before the first scan.
  try { if (!runtimeDir(ctx, 'brain/_index')) return false; } catch { return false; }
  const snap = readJson(file);
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return false;
  try {
    const { workspaces, outside, collected } = freshScan(ctx, { prev: Array.isArray(snap.workspaces) ? snap.workspaces : [] });
    const { withLock } = resolveModule('lib/snapshotLock.js');
    const fsx = resolveModule('lib/fsx.js');
    let wrote = false;
    await withLock(path.join(ctx.vault, 'brain', '_index', '.snapshot.lock'), async () => {
      const cur = readJson(file);
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return;
      cur.workspaces = workspaces;
      cur.hostSessions = { ...(cur.hostSessions || {}), byCwd: collected.byCwd, scannedAt: collected.scannedAt, windowDays: collected.windowDays, outsideWorkspaces: outside };
      fsx.writeAtomic(file, JSON.stringify(cur, null, 2));
      wrote = true;
    });
    return wrote;
  } catch (e) {
    if ((ctx.env || process.env).AOS_DEBUG === '1') process.stderr.write(`[aos workspace] rescan failed: ${e && e.message}\n`);
    return false;
  }
}

/** Whether `abs` is the folder of an outside row: the snapshot's, else a fresh look through the session index (vanished folders included). */
function isOutsideRow(ctx, abs) {
  const hit = (rows) => Array.isArray(rows) && rows.some((r) => r && typeof r.cwd === 'string' && path.isAbsolute(r.cwd) && samePath(r.cwd, abs));
  const snap = readJson(path.join(ctx.vault, 'brain', '_index', 'snapshot.json'));
  if (snap && snap.hostSessions && hit(snap.hostSessions.outsideWorkspaces)) return true;
  // The session index may know a folder the last scan has not listed yet.
  try { return hit(freshScan(ctx, { finalize: false }).outside); } catch { return false; }
}

// ── list ──

function ago(isoStr, now = Date.now()) {
  if (!isoStr) return 'never';
  const d = Math.floor((now - Date.parse(isoStr)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
}

function listWorkspaces(ctx, { io = console, json = false, now = Date.now() } = {}) {
  const { workspaces, outside, source, scannedAt } = workspaceRows(ctx);
  if (json) {
    // Every entry whole, hidden ones included (they carry `hidden`; consumers filter on it): spaces-redesign D22.
    io.log(JSON.stringify({
      source, scannedAt,
      workspaces: workspaces.map((w) => ({ ...w, sessions: w.sessions || { claude: 0, codex: 0, total: 0, lastAt: null } })),
      outsideWorkspaces: outside,
    }, null, 2));
    return 0;
  }
  const shown = workspaces.filter((w) => !w.hidden);
  if (!shown.length) io.log(`no workspaces under ${ctx.workspacesDir} (aos workspace new <name>)`);
  for (const w of shown) {
    const s = w.sessions || { claude: 0, codex: 0, lastAt: null };
    io.log(`${w.name.padEnd(28)} ${String(w.status || '-').padEnd(8)} claude ${String(s.claude).padStart(3)}  codex ${String(s.codex).padStart(3)}  ${ago(s.lastAt, now)}`);
  }
  const hidden = workspaces.length - shown.length;
  if (hidden) io.log(`(${hidden} hidden: _ folders and _archive/; --json lists them)`);
  if (outside.length) {
    io.log('');
    io.log(`outside workspaces/ (${outside.length}):`);
    for (const o of outside) io.log(`  ${shorten(o.cwd, ctx.home).padEnd(48)} claude ${String(o.claude).padStart(3)}  codex ${String(o.codex).padStart(3)}  ${ago(o.lastAt, now)}   aos workspace adopt ${shorten(o.cwd, ctx.home)} --into <workspace>`);
  }
  io.log(`(${source === 'snapshot' ? `from the snapshot of ${scannedAt}` : 'fresh scan'})`);
  return 0;
}

// ── which ──

const WHICH_PROBE = 'aos-workspace-which';

/**
 * The workspace a folder belongs to (spaces-redesign D20, D27): the folder goes through the attribution the scan uses,
 * as a session that started there, so the roots (the workspace folder, `repo:`, `aliases:`, the longest winning) and the
 * worktree walk (a .git file's main repository, <repo>.worktrees/*, the team seats' layouts) answer exactly as they do
 * for the counts. A hidden workspace (an `_` folder, _archive/) is no workspace here. → { name, slug, via }.
 */
function whichWorkspace(ctx, cwd) {
  process.env.AOS_VAULT = ctx.vault;
  const { collectWorkspaces } = resolveModule('collectors/workspaces.js');
  const { attachSessions } = resolveModule('collectors/hostSessions.js');
  const list = collectWorkspaces({ vault: ctx.vault, home: ctx.home });
  const at = new Date().toISOString();
  const probe = { id: WHICH_PROBE, host: 'claude', format: 'claude', kind: 'interactive', startCwd: cwd, startedAt: at, lastAt: at, title: null, touches: null };
  attachSessions(list, { vault: ctx.vault, sessions: [probe], configDirs: [] }, attachOpts(ctx));
  for (const ws of list) {
    const row = ws.sessions && Array.isArray(ws.sessions.recent) ? ws.sessions.recent.find((r) => r.id === WHICH_PROBE) : null;
    if (!row) continue;
    if (ws.hidden) break;
    return { name: ws.name, slug: slugify(ws.label || ws.name), via: row.via };
  }
  return { name: null, slug: null, via: null };
}

function whichVerb(ctx, { io, json, cwd }) {
  const dir = path.resolve(expandHome(cwd || process.cwd(), ctx.home));
  const r = whichWorkspace(ctx, dir);
  emit(io, json, r, [r.name ? `${r.name}  (#ws/${r.slug}, by ${r.via})` : `${shorten(dir, ctx.home)} is in no workspace`]);
  return 0;
}

// ── new and stubs ──

function gitInit(dir, opts) {
  const run = opts.spawnSync || spawnSync;
  const r = run('git', ['init', '--quiet'], { cwd: dir, env: { ...(opts.env || process.env), GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', timeout: 15_000 });
  if (r && r.status === 0) return null;
  return (r && r.error && r.error.message) || String((r && r.stderr) || '').trim().split('\n').pop() || `git exited ${r && r.status}`;
}

async function newWorkspace(ctx, name, opts = {}) {
  const io = opts.io || console;
  const slug = slugify(name);
  if (!slug) throw new UsageError('aos workspace new <name>: the name must contain a letter or digit');
  if (isReserved(name, slug)) throw new UsageError(`aos workspace new: "${slug}" is reserved (${[...RESERVED].join(', ')})`);
  if (slug === SCRATCH) throw new UsageError('aos workspace new: "scratch" is the terminal deck\'s shared place');
  if (opts.empty && (opts.git || opts.pin)) {
    throw new UsageError('aos workspace new --empty leaves the folder empty for `git clone … .`; add the stubs and the pin after it with `aos workspace stubs <name> --pin`');
  }
  // workspaces/ as a plain folder of the vault, made when missing; a link there refuses (spaces-redesign §6).
  let root;
  try { root = manifestLib().workspacesRoot(ctx.vault, { make: true }); } catch (e) { throw new Error(`refusing to make workspaces/${slug}: ${e.message}`); }
  const target = path.join(root, slug);
  if (lstatOrNull(target)) throw new Error(`workspaces/${slug} already exists`);
  if (lstatOrNull(path.join(root, ARCHIVE, slug))) {
    throw new Error(`"${slug}" is held by an archived workspace (workspaces/_archive/${slug}): restore it, or pick another name`);
  }
  fs.mkdirSync(target); // not recursive: something that appeared meanwhile is an error, never reused
  const written = opts.empty ? [] : completeStubs(target, slug);
  const gitError = opts.git ? gitInit(target, opts) : null;
  if (opts.pin) {
    manifestLib().setManifest(target, { pinned: true });
    written.push('workspace.md');
  }
  const rescanned = await refreshSnapshot(ctx, opts);
  const out = {
    ok: true, name: slug, slug, path: `workspaces/${slug}`, dir: target, written,
    git: !!opts.git && !gitError, ...(gitError ? { gitError } : {}), pinned: !!opts.pin, empty: !!opts.empty, rescanned,
  };
  emit(io, opts.json, out, [
    `created ${target}`,
    ...written.map((w) => `  ${w}`),
    ...(opts.git ? [gitError ? `  git init failed: ${gitError}` : '  git init'] : []),
    opts.empty
      ? `an empty folder: clone into it (git clone -- <url> .), then run \`aos workspace stubs ${slug} --pin\``
      : 'open a terminal there and start `claude` or `codex`; both read their instruction file from the workspace root',
  ]);
  return 0;
}

async function stubsVerb(ctx, name, opts = {}) {
  const io = opts.io || console;
  const WM = manifestLib();
  const dir = WM.workspaceDir(ctx.vault, name);
  const written = completeStubs(dir, slugify(name) || 'workspace');
  if (opts.pin) {
    const cur = WM.readManifest(dir);
    if (cur.refused) throw new WM.ManifestError(cur.refused, 'UNSAFE');
    if (!cur.manifest.pinned) { WM.setManifest(dir, { pinned: true }); written.push('workspace.md (pinned)'); }
  }
  const rescanned = written.length ? await refreshSnapshot(ctx, opts) : false;
  emit(io, opts.json, { ok: true, name, path: `workspaces/${name}`, written, pinned: !!opts.pin, rescanned },
    written.length ? [`workspaces/${name}:`, ...written.map((w) => `  + ${w}`)] : [`workspaces/${name} has every stub`]);
  return 0;
}

// ── adopt ──

/**
 * A folder named on the command line for adopt --into, hide or unhide (spaces-redesign §6): absolute or `~/`, no line
 * break or NUL, normalized; not `/` or home; outside the vault; neither inside nor containing either host's config
 * folder. → its absolute path, or an Error naming the rule.
 */
function checkOutsidePath(ctx, raw, verb) {
  if (typeof raw !== 'string' || !raw) throw new UsageError(USAGE[verb]);
  if (LINE_BREAKS.test(raw)) throw new Error(`aos workspace ${verb}: the path holds a line break or NUL`);
  if (!raw.startsWith('/') && !raw.startsWith('~/')) throw new Error(`aos workspace ${verb}: give the folder as ~/… or a full path, not ${JSON.stringify(raw)}`);
  const abs = path.resolve(expandHome(raw, ctx.home));
  const shown = shorten(abs, ctx.home);
  if (abs === path.parse(abs).root) throw new Error('refusing the filesystem root');
  if (samePath(abs, ctx.home)) throw new Error('refusing the home folder');
  if (insideAnySpelling(abs, ctx.vault)) throw new Error(`refusing ${shown}: it is inside the vault`);
  if (insideAnySpelling(ctx.vault, abs)) throw new Error(`refusing ${shown}: it contains the vault`);
  for (const [label, dir] of [['the Claude config dir', ctx.claudeDir], ['the Codex home', ctx.codexHome]]) {
    if (dir && overlaps(abs, dir)) throw new Error(`refusing ${shown}: it is inside or contains ${label}`);
  }
  return abs;
}

/** An `aliases:` value as an absolute folder: `~/…`, absolute, or relative to the vault (`workspaces/<old>`). */
function aliasAbs(ctx, a) {
  const s = String(a).trim();
  if (!s) return null;
  if (s === '~' || s.startsWith('~/')) return path.resolve(expandHome(s, ctx.home));
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(ctx.vault, s);
}
/** `aliases:` with `value` added, unless an entry already names the same folder: then null (nothing to write). */
function withAlias(ctx, aliases, value) {
  const list = (Array.isArray(aliases) ? aliases : []).filter((a) => typeof a === 'string' && a.trim());
  const want = aliasAbs(ctx, value);
  if (list.some((a) => { const p = aliasAbs(ctx, a); return !!p && samePath(p, want); })) return null;
  return [...list, value];
}

/** adopt <path> --into <ws> (D16): the folder becomes an alias of <ws>; nothing moves, renames, copies or removes. */
async function adoptInto(ctx, source, into, opts = {}) {
  const io = opts.io || console;
  if (opts.name !== undefined) throw new UsageError('aos workspace adopt: --name names a moved folder; with --into the folder stays where it is');
  const abs = checkOutsidePath(ctx, source, 'adopt');
  const WM = manifestLib();
  const dir = WM.workspaceDir(ctx.vault, into);
  const shown = shorten(abs, ctx.home);
  const cur = WM.readManifest(dir);
  if (cur.refused) throw new WM.ManifestError(cur.refused, 'UNSAFE');
  const alias = storedForm(abs, ctx.home);
  const next = withAlias(ctx, cur.manifest.aliases, alias);
  // A folder the user hid was an outside row when it was hidden, and still may be adopted.
  if (next && !isHiddenEntry(ctx, abs) && !isOutsideRow(ctx, abs)) {
    throw new Error(`${shown} is not a folder sessions ran in outside workspaces/ (\`aos workspace list\` shows them)`);
  }
  const res = next ? WM.setManifest(dir, { aliases: next }) : { changed: false };
  const rescanned = res.changed ? await refreshSnapshot(ctx, opts) : false;
  emit(io, opts.json, { ok: true, name: into, path: `workspaces/${into}`, folder: abs, alias, changed: !!res.changed, file: `workspaces/${into}/workspace.md`, rescanned },
    [res.changed ? `${shown} is now an alias of ${into}: its sessions count there; nothing moved` : `${shown} is already an alias of ${into}`]);
  return 0;
}

/** Move `source` into workspaces/<slug>/ (terminals only). Refuses anything that is not a plain project directory. */
async function adoptWorkspace(ctx, source, opts = {}) {
  if (opts.into !== undefined) return adoptInto(ctx, source, opts.into, opts);
  const { name, io = console, rename = fs.renameSync, copy = fs.cpSync, remove = fs.rmSync } = opts;
  if (!source) throw new UsageError(USAGE.adopt);
  refuseHeadless(opts.env || ctx.env, 'aos workspace adopt <path> (without --into)');
  const src = path.resolve(expandHome(source, ctx.home));
  if (!isDir(src)) throw new Error(`${src} is not a directory`);
  if (src === path.parse(src).root) throw new Error('refusing a filesystem root');
  if (samePath(src, ctx.home)) throw new Error('refusing the home directory');
  for (const [label, dir] of [['the Claude config dir', ctx.claudeDir], ['the Codex home', ctx.codexHome]]) {
    if (overlaps(src, dir)) throw new Error(`refusing ${src}: it is inside or contains ${label} ${dir}`);
  }
  if (insideDir(src, ctx.workspacesDir)) throw new Error(`${src} is already under ${ctx.workspacesDir}`);
  if (insideDir(src, ctx.vault)) throw new Error(`refusing ${src}: it is inside the vault; move it by hand if it belongs in workspaces/`);
  if (insideDir(ctx.vault, src)) throw new Error(`refusing ${src}: it contains the vault`);
  const slug = slugify(name || path.basename(src));
  if (!slug) throw new UsageError('aos workspace adopt: pass --name <slug>; the folder name has no letters or digits');
  if (isReserved(name || path.basename(src), slug) || slug === SCRATCH) throw new UsageError(`aos workspace adopt: "${slug}" is reserved (${[...RESERVED, SCRATCH].join(', ')})`);
  let root;
  try { root = manifestLib().workspacesRoot(ctx.vault, { make: true }); } catch (e) { throw new Error(`refusing to adopt into workspaces/: ${e.message}`); }
  const target = path.join(root, slug);
  if (lstatOrNull(target)) throw new Error(`${target} already exists; pass --name <other-slug>`);
  if (lstatOrNull(path.join(root, ARCHIVE, slug))) throw new Error(`"${slug}" is held by an archived workspace; pass --name <other-slug>`);
  try {
    rename(src, target);
  } catch (e) {
    if (e && e.code !== 'EXDEV') throw e;
    copy(src, target, { recursive: true, preserveTimestamps: true });
    remove(src, { recursive: true, force: true });
  }
  const written = completeStubs(target, slug);
  const rescanned = await refreshSnapshot(ctx, opts);
  const repo = exists(path.join(target, '.git'));
  emit(io, opts.json, { ok: true, name: slug, path: `workspaces/${slug}`, from: src, moved: true, written, rescanned }, [
    `adopted ${src}`,
    `  → ${target}`,
    ...written.map((w) => `  + ${w}`),
    ...(repo ? ['  (a git repository of its own; the vault\'s git ignores nested repos)'] : []),
    'note: Codex asks once to trust the new path; the old path\'s trust entry in its config.toml is harmless',
  ]);
  return 0;
}

// ── archive, restore, rename: what stops a move ──

/** Every team run whose marker is in persona/teams/<team>/running/, with the folder its board item names. */
function runningTeamItems(ctx) {
  const out = [];
  const root = path.join(ctx.vault, 'persona', 'teams');
  for (const team of readdirSafe(root).sort()) {
    const dir = path.join(root, team);
    const markers = readdirSafe(path.join(dir, 'running')).filter((n) => n.endsWith('.json'));
    if (!markers.length) continue;
    const board = new Map();
    let text = '';
    try { text = fs.readFileSync(path.join(dir, 'board.jsonl'), 'utf8'); } catch { /* no board */ }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && typeof r.id === 'string') board.set(r.id, r); } catch { /* skipped */ }
    }
    for (const n of markers) {
      const m = readJson(path.join(dir, 'running', n));
      if (!m || typeof m !== 'object') continue;
      // A dead dispatcher's marker on this machine is left for the team's sweep (teams.js reapKilledRuns): not running.
      if (m.host === os.hostname() && Number.isInteger(m.pid) && !pidAlive(m.pid)) continue;
      const it = typeof m.item === 'string' ? board.get(m.item) : null;
      const p = it && typeof it.path === 'string' && it.path ? path.resolve(ctx.vault, expandHome(it.path, ctx.home)) : null;
      out.push({ team, item: typeof m.item === 'string' ? m.item : n.replace(/\.json$/, ''), path: p });
    }
  }
  return out;
}

/** The titles of the Sessions threads in brain/_index/sessions/<name>/ with a turn left unfinished in the last 30 minutes. */
function runningTurns(ctx, name, nowMs) {
  const dir = path.join(ctx.vault, 'brain', '_index', 'sessions', name);
  const out = [];
  for (const f of readdirSafe(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const file = path.join(dir, f);
    const st = lstatOrNull(file);
    if (!st || !st.isFile()) continue;
    let text = '';
    let cut = false;
    let title = f.replace(/\.jsonl$/, '');
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const head = Buffer.alloc(Math.min(st.size, 64 * 1024));
        fs.readSync(fd, head, 0, head.length, 0);
        try { const meta = JSON.parse(head.toString('utf8').split('\n')[0]); if (meta && typeof meta.title === 'string' && meta.title) title = meta.title; } catch { /* untitled */ }
        const len = Math.min(st.size, THREAD_TAIL_BYTES);
        const tail = Buffer.alloc(len);
        fs.readSync(fd, tail, 0, len, st.size - len);
        text = tail.toString('utf8');
        cut = len < st.size;
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    // The newest `done` or `prompt` decides: a prompt with no done after it, younger than the window, is running.
    let verdict = null;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= (cut ? 1 : 0); i--) {
      if (!lines[i].includes('"kind"')) continue;
      let r;
      try { r = JSON.parse(lines[i]); } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      if (r.kind === 'done') { verdict = false; break; }
      if (r.kind === 'prompt') {
        // The prompt's time or the file's: a long turn still appending its events keeps the file fresh.
        const t = Date.parse(r.t || '');
        verdict = Math.max(Number.isFinite(t) ? t : 0, st.mtimeMs) > nowMs - TURN_WINDOW_MS;
        break;
      }
    }
    // A turn whose output outgrew the tail: no prompt and no done in sight, so the file's age decides.
    if (verdict === null && cut) verdict = st.mtimeMs > nowMs - TURN_WINDOW_MS;
    if (verdict) out.push(title);
  }
  return out;
}

/** A repository's linked worktrees ({ list }), or { self } when the folder is itself a linked worktree; null if neither. */
function linkedWorktrees(dir) {
  const g = path.join(dir, '.git');
  const st = lstatOrNull(g);
  if (!st) return null;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(g) || '');
    const w = m && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(path.resolve(dir, m[1]));
    return w ? { self: w[1] } : null;
  }
  if (!st.isDirectory()) return null;
  const wdir = path.join(g, 'worktrees');
  const list = readdirSafe(wdir).sort().map((id) => {
    const gd = readSmall(path.join(wdir, id, 'gitdir'));
    return gd && gd.trim() ? path.dirname(path.resolve(wdir, id, gd.trim())) : id;
  });
  return list.length ? { list } : null;
}

/** The refusals every move shares (spec §6): a running team item, an unfinished Sessions turn, linked worktrees.
 *  `threads`: the name its Sessions threads are kept under (Restore's original name). */
function refuseBusy(ctx, name, dir, manifest, nowMs, threads = name) {
  const WM = manifestLib();
  const roots = [dir, WM.repoPath(manifest.repo, ctx.vault, ctx.home), ...(manifest.aliases || []).map((a) => aliasAbs(ctx, a))].filter(Boolean);
  const team = runningTeamItems(ctx).filter((r) => r.path && roots.some((root) => insideAnySpelling(r.path, root)));
  if (team.length) throw new Error(`refusing to move ${name}: a team run is working on it (${team.map((t) => `${t.team}/${t.item}`).join(', ')}); let it finish first`);
  const turns = runningTurns(ctx, threads, nowMs);
  if (turns.length) throw new Error(`refusing to move ${name}: a Sessions turn there has not finished (${turns.map((t) => JSON.stringify(t)).join(', ')}); let it finish, or stop it in Sessions`);
  const wt = linkedWorktrees(dir);
  if (wt && wt.self) {
    throw new Error(`refusing to move ${name}: it is a linked git worktree of ${shorten(wt.self, ctx.home)}, and moving it breaks git's link; move it by hand and run \`git worktree repair\` in it`);
  }
  if (wt && wt.list) {
    throw new Error(`refusing to move ${name}: its repository has linked worktrees (${wt.list.map((p) => shorten(p, ctx.home)).join(', ')}), and moving it breaks git's links to them; remove them first (git worktree remove), or move it by hand and run \`git worktree repair\` in each`);
  }
}

// ── archive, restore, rename: what moves ──

const MAPS = 'brain/_index/workspace-maps';
const mapsRel = (archived) => (archived ? `${MAPS}/${ARCHIVE}` : MAPS);

/**
 * Move `src` to `dst` without ever writing over anything (spaces-redesign §6): a hard link then the unlink, so a file,
 * folder or link at `dst` fails with EEXIST. On a file system without hard links, a rename after one more look.
 */
function moveNoClobber(src, dst) {
  try {
    fs.linkSync(src, dst);
  } catch (e) {
    if (e && e.code === 'EEXIST') throw new Error(`${path.basename(dst)} already exists where it goes: refusing to write over it`);
    if (lstatOrNull(dst)) throw new Error(`${path.basename(dst)} already exists where it goes: refusing to write over it`);
    fs.renameSync(src, dst);
    return;
  }
  fs.unlinkSync(src);
}

/**
 * What a move does with a workspace's map (D17), checked before anything is written: null when it has none (no regular
 * file at the source). Both maps folders must be plain folders of the vault (runtimeDir: a linked workspace-maps or
 * workspace-maps/_archive refuses), and the destination must be free: a map is never written over.
 */
function planMap(ctx, from, to) {
  const srcDir = runtimeDir(ctx, mapsRel(from.archived));
  const src = srcDir ? path.join(srcDir, `${from.name}.json`) : null;
  const st = src ? lstatOrNull(src) : null;
  if (!st || !st.isFile()) return null;
  const dstRel = mapsRel(to.archived);
  const dstDir = runtimeDir(ctx, dstRel);
  if (dstDir && lstatOrNull(path.join(dstDir, `${to.name}.json`))) throw new Error(`${dstRel}/${to.name}.json already exists: move it away first`);
  return { src, dstRel, dstName: `${to.name}.json`, dst: null };
}

/** The planned map move, its destination folder made (a plain mkdir) and checked again. */
function applyMap(ctx, plan) {
  if (!plan) return false;
  const dst = path.join(runtimeDir(ctx, plan.dstRel, { make: true }), plan.dstName);
  moveNoClobber(plan.src, dst);
  plan.dst = dst;
  return true;
}

/** A failed move puts its map back (best effort). */
function revertMap(plan) {
  if (!plan || !plan.dst) return;
  try { moveNoClobber(plan.dst, plan.src); } catch { /* best effort: running the verb again finishes it */ }
}

/** A frontmatter `workspace:` value as a name, as the HUD reads it (memories.ts workspaceKey). */
function workspaceKey(raw) {
  if (raw == null) return null;
  let v = String(raw).trim();
  const q = /^(["'])(.*)\1$/.exec(v);
  if (q) v = q[2].trim();
  const link = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(v);
  if (link) v = link[1].trim();
  v = v.replace(/^workspaces\//, '').replace(/\/+$/, '').trim();
  return v || null;
}

const statusTag = (word) => new RegExp(`(^|[\\s,\\[\\-'"])status/${word}(?=$|[\\s,\\]'"])`);

/**
 * A workspace's former names (D17, D27), as the HUD's spacesModel formerNames reads them: each `aliases:` folder under
 * the vault's workspaces/ (what Rename and Archive record) gives its folder name, `_archive/<n>` gives <n>.
 */
function formerNames(ctx, aliases, self) {
  const out = [];
  const root = path.join(ctx.vault, 'workspaces');
  for (const a of Array.isArray(aliases) ? aliases : []) {
    const p = typeof a === 'string' ? aliasAbs(ctx, a) : null;
    const rel = p ? path.relative(root, p) : '';
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const segs = rel.split(path.sep);
    const n = segs[0] === ARCHIVE ? segs[1] : segs[0];
    if (!n || n.startsWith('_') || n.startsWith('.') || n === self || out.includes(n)) continue;
    // A name a folder holds now is that workspace's, not a former name of this one: a cloned workspace.md may list any
    // `workspaces/<n>` alias, and a freed name may have been taken again (spaces-redesign D17).
    if (lstatOrNull(path.join(root, n)) || lstatOrNull(path.join(root, ARCHIVE, n))) continue;
    out.push(n);
  }
  return out;
}

/**
 * The one write outside workspaces/ and brain/_index/ (spaces-redesign §6, D17, D27): in brain/memory/projects/, each
 * note linked to one of `names` (the workspace's name, then its former ones) by `workspace:` or by its exact slug, that
 * is a regular file (never a link) inside that folder, has `status/<from>` replaced by `status/<to>` on the first
 * frontmatter line carrying it, and nothing else. `only` limits it to those notes (Restore's record, a rollback);
 * `dryRun` writes nothing. → the notes changed (or that would be), vault-relative.
 */
function flipProjectNotes(ctx, names, from, to, only = null, { dryRun = false } = {}) {
  // brain/memory/projects as a plain folder of the vault: a link anywhere on the way (brain/memory -> elsewhere) means
  // no note is flipped, never one written outside (spaces-redesign §6).
  let dir = null;
  try { dir = runtimeDir(ctx, 'brain/memory/projects'); } catch { return []; }
  if (!dir) return [];
  const slugs = (Array.isArray(names) ? names : [names]).map(slugify).filter(Boolean);
  if (!slugs.length) return [];
  const fsx = resolveModule('lib/fsx.js');
  const changed = [];
  for (const f of readdirSafe(dir).sort()) {
    if (!f.endsWith('.md')) continue;
    const rel = `brain/memory/projects/${f}`;
    if (only && !only.includes(rel)) continue;
    const text = regularText(dir, f, 1024 * 1024);
    if (text === null) continue;
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) continue;
    const ws = /^workspace:[ \t]*(.*)$/m.exec(m[1]);
    const key = ws ? workspaceKey(ws[1]) : null;
    const linked = (!!key && slugs.includes(slugify(key))) || slugs.includes(f.slice(0, -3).toLowerCase());
    if (!linked) continue;
    const open = text.startsWith('---\r\n') ? 5 : 4;
    const close = m.index + m[0].length - 3;
    const lines = text.slice(open, close).split(/(?<=\n)/);
    const re = statusTag(from);
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) continue;
    lines[i] = lines[i].replace(re, `$1status/${to}`);
    if (dryRun) { changed.push(rel); continue; }
    // writeAtomic renames a temp file over the note: a link appearing there now is replaced, never written through.
    fsx.writeAtomic(path.join(dir, f), text.slice(0, open) + lines.join('') + text.slice(close));
    changed.push(rel);
  }
  return changed;
}

/** build-brain-md, so BRAIN.md's active projects follow the flipped tags. Its own process: paths.js fixes the vault per process. */
function runBrainMd(ctx, opts) {
  if (typeof opts.runScript === 'function') return opts.runScript('build-brain-md.js', []);
  try {
    const r = spawnSync(process.execPath, [resolveScript('build-brain-md.js')], {
      env: { ...(opts.env || process.env), AOS_VAULT: ctx.vault }, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) return { ok: true };
    return { ok: false, error: (r.error && r.error.message) || String(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

function threadsDir(ctx, name) { return path.join(ctx.vault, 'brain', '_index', 'sessions', name); }
function threadCount(ctx, name) { return readdirSafe(threadsDir(ctx, name)).filter((n) => n.endsWith('.jsonl')).length; }

/** Rewrite each thread's meta line (line one) from `workspace: from` to `to`, atomically; the rest is kept byte for byte. */
function rewriteThreadMeta(dir, from, to, only = null) {
  const fsx = resolveModule('lib/fsx.js');
  const done = [];
  for (const f of readdirSafe(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    if (only && !only.includes(f)) continue;
    const file = path.join(dir, f);
    const st = lstatOrNull(file);
    if (!st || !st.isFile()) continue;
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    const nl = buf.indexOf(0x0a);
    let meta;
    try { meta = JSON.parse((nl === -1 ? buf : buf.subarray(0, nl)).toString('utf8')); } catch { continue; }
    if (!meta || meta.kind !== 'meta' || meta.workspace !== from) continue;
    const line = Buffer.from(JSON.stringify({ ...meta, workspace: to }), 'utf8');
    fsx.writeAtomic(file, nl === -1 ? line : Buffer.concat([line, buf.subarray(nl)]));
    // A new meta line is no activity: the file keeps its times, so a turn left unfinished long ago still reads as old.
    try { fs.utimesSync(file, st.atime, st.mtime); } catch { /* times are a courtesy */ }
    done.push(f);
  }
  return done;
}

/** What Rename does with brain/_index/sessions/<from>/; refused before anything moves when a name would collide. */
function planThreads(ctx, from, to) {
  let root = null;
  try { root = runtimeDir(ctx, 'brain/_index/sessions'); } catch (e) { throw new Error(`refusing to rename ${from}: ${e.message}`); }
  if (!root) return { src: threadsDir(ctx, from), dst: threadsDir(ctx, to), names: [], merge: false, none: true };
  const src = path.join(root, from);
  const dst = path.join(root, to);
  const sst = lstatOrNull(src);
  if (!sst) return { src, dst, names: [], merge: false, none: true };
  if (!sst.isDirectory()) throw new Error(`refusing to rename ${from}: brain/_index/sessions/${from} is not a folder`);
  const dstSt = lstatOrNull(dst);
  if (dstSt && !dstSt.isDirectory()) throw new Error(`refusing to rename ${from}: brain/_index/sessions/${to} is not a folder`);
  const names = readdirSafe(src).sort();
  const clash = dstSt ? names.filter((n) => lstatOrNull(path.join(dst, n))) : [];
  if (clash.length) throw new Error(`refusing to rename ${from}: brain/_index/sessions/${to} already holds ${clash.join(', ')}`);
  return { src, dst, names, merge: !!dstSt, none: false };
}

function moveThreads(plan) {
  if (plan.none) return [];
  if (!plan.merge) { fs.renameSync(plan.src, plan.dst); return plan.names; }
  for (const n of plan.names) fs.renameSync(path.join(plan.src, n), path.join(plan.dst, n));
  try { fs.rmdirSync(plan.src); } catch { /* not empty: something arrived meanwhile, and stays */ }
  return plan.names;
}

/** An existing workspace for a move: its folder and manifest (a symlinked workspace.md refuses the move); reserved names refused. */
function movable(ctx, name, verb, { archived = false } = {}) {
  const WM = manifestLib();
  if (typeof name !== 'string' || !name) throw new UsageError(USAGE[verb]);
  if (heldName(name)) throw new Error(`refusing to ${verb} "${name}": it is reserved (${[...RESERVED, SCRATCH].join(', ')})`);
  // workspaceDir matches the name exactly as the folder is spelled, so the check above ran on the name on disk (§6).
  let dir;
  try { dir = WM.workspaceDir(ctx.vault, name, { archived }); } catch (e) {
    if (e && e.code === 'UNSAFE') throw new Error(`refusing to ${verb} ${name}: ${e.message}`);
    throw e;
  }
  const cur = WM.readManifest(dir);
  if (cur.refused) throw new Error(`refusing to ${verb} ${name}: ${cur.refused}`);
  return { dir, cur };
}

async function archiveWorkspace(ctx, name, opts = {}) {
  const io = opts.io || console;
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  refuseHeadless(opts.env || ctx.env, 'aos workspace archive');
  const { dir, cur } = movable(ctx, name, 'archive');
  refuseBusy(ctx, name, dir, cur.manifest, nowMs);
  const WM = manifestLib();
  // workspaces/_archive and the maps' _archive as plain folders of the vault; a link or a file there refuses (§6).
  let root;
  let archMaps;
  try {
    root = WM.workspacesRoot(ctx.vault, { archived: true, make: true });
    archMaps = runtimeDir(ctx, mapsRel(true));
  } catch (e) { throw new Error(`refusing to archive ${name}: ${e.message}`); }
  const day = localDay(nowMs);
  // A dated suffix when the name is taken in _archive/ (spec §4), by a folder or by a map left there.
  const taken = (d) => !!lstatOrNull(path.join(root, d)) || (!!archMaps && !!lstatOrNull(path.join(archMaps, `${d}.json`)));
  let dest = name;
  for (let n = 1; taken(dest); n++) dest = n === 1 ? `${name}-${day}` : `${name}-${day}-${n}`;
  let map;
  try { map = planMap(ctx, { archived: false, name }, { archived: true, name: dest }); } catch (e) { throw new Error(`refusing to archive ${name}: ${e.message}`); }
  const names = [name, ...formerNames(ctx, cur.manifest.aliases, name)];
  const planned = flipProjectNotes(ctx, names, 'active', 'archived', null, { dryRun: true });
  // Archive's record (D17): the notes it flips and, under a dated name, the name it came from, so Restore undoes exactly
  // this and nothing more (a note archived before stays archived). A run cut short and run again keeps the first record.
  const prior = cur.manifest.archived ? WM.listField(cur.text, 'archivedNotes') : [];
  const record = [...new Set([...prior, ...planned])];
  // The folder moves last, so a run cut short is safe to run again: `archived:`, the record and the alias are harmless on
  // a live folder (the scan reads `archived:` only under _archive/, and drops an alias of the folder itself), and the map
  // and the tags are put back if the move fails. The alias keeps the sessions that ran in workspaces/<n> on this entry.
  const aliases = withAlias(ctx, cur.manifest.aliases, `workspaces/${name}`);
  WM.setManifest(dir, { archived: day, archivedNotes: record, archivedFrom: dest === name ? null : name, ...(aliases ? { aliases } : {}) });
  applyMap(ctx, map);
  const notes = flipProjectNotes(ctx, names, 'active', 'archived', planned);
  try {
    fs.renameSync(dir, path.join(root, dest));
  } catch (e) {
    revertMap(map);
    if (notes.length) { try { flipProjectNotes(ctx, names, 'archived', 'active', notes); } catch { /* best effort */ } }
    throw new Error(`could not move workspaces/${name} into _archive/: ${e.message}`);
  }
  const brainMd = notes.length ? runBrainMd(ctx, opts) : null;
  const rescanned = await refreshSnapshot(ctx, opts);
  const threads = threadCount(ctx, name);
  emit(io, opts.json, {
    ok: true, name, archivedAs: `${ARCHIVE}/${dest}`, path: `workspaces/${ARCHIVE}/${dest}`, archived: day, map: !!map, notes, brainMd, threads, rescanned,
  }, [
    `archived workspaces/${name} → workspaces/${ARCHIVE}/${dest}`,
    ...(map ? ['  its map moved to workspace-maps/_archive/'] : []),
    ...notes.map((n) => `  ${n}: status/archived`),
    ...(threads ? [`  ${threads} Sessions thread${threads === 1 ? '' : 's'} stay, read-only until it is restored`] : []),
    `restore it with: aos workspace restore ${dest}`,
  ]);
  return 0;
}

/**
 * The name an archived folder goes back to (D17): Archive's `archivedFrom:` when it archived under a dated name and
 * that name is a valid, unreserved workspace name; else the folder's own name.
 */
function restoreTarget(cur, name) {
  const WM = manifestLib();
  const from = WM.listField(cur.text, 'archivedFrom')[0];
  return typeof from === 'string' && from !== name && WM.WS_RE.test(from) && !heldName(from) ? from : name;
}

async function restoreWorkspace(ctx, name, opts = {}) {
  const io = opts.io || console;
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  refuseHeadless(opts.env || ctx.env, 'aos workspace restore');
  // movable checks workspaces/ and workspaces/_archive as plain folders of the vault, as archive does (§6).
  const { dir, cur } = movable(ctx, name, 'restore', { archived: true });
  const WM = manifestLib();
  const target = restoreTarget(cur, name);
  const root = WM.workspacesRoot(ctx.vault);
  if (lstatOrNull(path.join(root, target))) throw new Error(`refusing to restore ${name}: workspaces/${target} already exists`);
  refuseBusy(ctx, target, dir, cur.manifest, nowMs, target);
  let map;
  try { map = planMap(ctx, { archived: true, name }, { archived: false, name: target }); } catch (e) { throw new Error(`refusing to restore ${name}: ${e.message}`); }
  const names = [target, ...formerNames(ctx, cur.manifest.aliases, target)];
  // Only what Archive flipped (its `archivedNotes:` record): a note that was archived before stays archived.
  const record = WM.listField(cur.text, 'archivedNotes');
  applyMap(ctx, map);
  const notes = record.length ? flipProjectNotes(ctx, names, 'archived', 'active', record) : [];
  const moved = path.join(root, target);
  try {
    fs.renameSync(dir, moved);
  } catch (e) {
    revertMap(map);
    if (notes.length) { try { flipProjectNotes(ctx, names, 'active', 'archived', notes); } catch { /* best effort */ } }
    throw new Error(`could not move workspaces/_archive/${name} back: ${e.message}`);
  }
  // Archive's marks go once the folder is back (a live folder ignores them, so a run cut short is harmless).
  try { WM.setManifest(moved, { archived: null, archivedNotes: null, archivedFrom: null }); } catch { /* harmless leftovers */ }
  const brainMd = notes.length ? runBrainMd(ctx, opts) : null;
  const rescanned = await refreshSnapshot(ctx, opts);
  const threads = threadCount(ctx, target);
  emit(io, opts.json, { ok: true, name: target, path: `workspaces/${target}`, ...(target !== name ? { restoredFrom: `${ARCHIVE}/${name}` } : {}), map: !!map, notes, brainMd, threads, rescanned }, [
    `restored workspaces/${ARCHIVE}/${name} → workspaces/${target}`,
    ...(map ? ['  its map moved back'] : []),
    ...notes.map((n) => `  ${n}: status/active`),
  ]);
  return 0;
}

async function renameWorkspace(ctx, name, next, opts = {}) {
  const io = opts.io || console;
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  refuseHeadless(opts.env || ctx.env, 'aos workspace rename');
  if (typeof next !== 'string' || !KEBAB_RE.test(next)) {
    throw new Error(`refusing to rename ${name}: the new name must be lowercase kebab-case, as ${JSON.stringify(slugify(next) || 'my-project')} (at most 64 characters)`);
  }
  if (heldName(next)) throw new Error(`refusing to rename ${name}: "${next}" is reserved (${[...RESERVED, SCRATCH].join(', ')})`);
  const { dir, cur } = movable(ctx, name, 'rename');
  if (next === name) throw new Error(`${name} already has that name`);
  const WM = manifestLib();
  const root = WM.workspacesRoot(ctx.vault);
  if (lstatOrNull(path.join(root, next))) throw new Error(`refusing to rename ${name}: workspaces/${next} already exists`);
  if (lstatOrNull(path.join(root, ARCHIVE, next))) throw new Error(`refusing to rename ${name}: "${next}" is held by an archived workspace (workspaces/_archive/${next})`);
  refuseBusy(ctx, name, dir, cur.manifest, nowMs);
  const plan = planThreads(ctx, name, next);
  let map;
  try { map = planMap(ctx, { archived: false, name }, { archived: false, name: next }); } catch (e) { throw new Error(`refusing to rename ${name}: ${e.message}`); }
  // The folder moves last (the plan's Risks): every earlier step is safe to repeat, so a run cut short is finished by
  // running it again. The scan drops an alias of the folder itself until the folder moves.
  const aliases = withAlias(ctx, cur.manifest.aliases, `workspaces/${name}`);
  if (aliases) WM.setManifest(dir, { aliases });
  applyMap(ctx, map);
  const moved = moveThreads(plan);
  // Each moved thread's meta line names the new workspace, so its next turn resolves it (D17); a thread that an earlier
  // run cut short moved without rewriting is caught here too.
  const rewritten = rewriteThreadMeta(plan.dst, name, next);
  const target = path.join(root, next);
  try {
    fs.renameSync(dir, target);
  } catch (e) {
    try {
      rewriteThreadMeta(plan.dst, next, name, rewritten);
      if (moved.length && !plan.merge) fs.renameSync(plan.dst, plan.src);
      else if (moved.length) { fs.mkdirSync(plan.src, { recursive: true }); for (const n of moved) fs.renameSync(path.join(plan.dst, n), path.join(plan.src, n)); }
    } catch { /* best effort: running it again finishes the rename */ }
    revertMap(map);
    throw new Error(`could not move workspaces/${name} to workspaces/${next}: ${e.message}`);
  }
  const rescanned = await refreshSnapshot(ctx, opts);
  const threadsMoved = moved.filter((n) => n.endsWith('.jsonl')).length;
  // A repository of its own gets a new path: Codex asks once to trust it, as after adopt's move (host parity).
  const repo = exists(path.join(target, '.git'));
  emit(io, opts.json, {
    ok: true, from: name, name: next, path: `workspaces/${next}`, alias: `workspaces/${name}`, map: !!map,
    threads: { moved: threadsMoved, rewritten: rewritten.length }, rescanned,
  }, [
    `renamed workspaces/${name} → workspaces/${next} (aliases: keeps workspaces/${name})`,
    ...(map ? ['  its map moved'] : []),
    ...(threadsMoved ? [`  ${threadsMoved} Sessions thread${threadsMoved === 1 ? '' : 's'} moved and renamed`] : []),
    ...(repo ? ['note: Codex asks once to trust the new path; the old path\'s trust entry in its config.toml is harmless'] : []),
  ]);
  return 0;
}

// ── hide, unhide ──

function hiddenFile(ctx) { return path.join(ctx.vault, 'brain', '_index', 'workspaces-hidden.json'); }

/** brain/_index/workspaces-hidden.json's entries as written: strings (a `{ path }` object reads as its path). */
function readHiddenList(text) {
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  const list = Array.isArray(j) ? j : j && Array.isArray(j.paths) ? j.paths : [];
  return list.map((p) => (p && typeof p === 'object' ? p.path : p)).filter((p) => typeof p === 'string' && p);
}

/** brain/_index/workspaces-hidden.json's text when it is a regular file; never read through a link (null then). */
function hiddenText(ctx) { return readSmall(hiddenFile(ctx), 1024 * 1024); }

/** Whether brain/_index/workspaces-hidden.json holds `abs`. */
function isHiddenEntry(ctx, abs) {
  const text = hiddenText(ctx);
  if (text === null) return false;
  return readHiddenList(text).some((p) => { const e = expandHome(p, ctx.home); return path.isAbsolute(e) && samePath(path.resolve(e), abs); });
}

async function hideVerb(ctx, raw, opts = {}) {
  const io = opts.io || console;
  const unhide = !!opts.unhide;
  const verb = unhide ? 'unhide' : 'hide';
  const abs = checkOutsidePath(ctx, raw, verb);
  const shown = shorten(abs, ctx.home);
  const file = hiddenFile(ctx);
  // An entry names this folder when it reads as the same absolute path (collectors/hostSessions.js readHidden's rule).
  const named = (p) => { const e = expandHome(p, ctx.home); return path.isAbsolute(e) && samePath(path.resolve(e), abs); };
  const stored = isHiddenEntry(ctx, abs);
  if (unhide && !stored) throw new Error(`${shown} is not hidden`);
  if (!unhide && !stored && !isOutsideRow(ctx, abs)) {
    throw new Error(`${shown} is not a folder sessions ran in outside workspaces/ (\`aos workspace list\` shows them)`);
  }
  // brain/_index as a plain folder of the vault (spaces-redesign §6); the file itself is replaced atomically, so a link
  // there is replaced, and what it points at is neither read nor written.
  try { runtimeDir(ctx, 'brain/_index', { make: true }); } catch (e) { throw new Error(`refusing to ${verb} ${shown}: ${e.message}`); }
  const fsx = resolveModule('lib/fsx.js');
  let changed = false;
  fsx.updateSync(file, () => {
    const text = hiddenText(ctx);
    const list = readHiddenList(text);
    const has = list.some(named);
    if (unhide ? !has : has) return text;
    changed = true;
    const paths = unhide ? list.filter((p) => !named(p)) : [...list, storedForm(abs, ctx.home)];
    return JSON.stringify({ schema: 1, paths }, null, 2) + '\n';
  });
  const rescanned = changed ? await refreshSnapshot(ctx, opts) : false;
  emit(io, opts.json, { ok: true, path: storedForm(abs, ctx.home), hidden: !unhide, changed, file: 'brain/_index/workspaces-hidden.json', rescanned },
    [changed ? `${shown} is ${unhide ? 'shown again' : 'hidden'} in the outside list` : `${shown} was already ${unhide ? 'shown' : 'hidden'}`]);
  return 0;
}

// ── draft, set ──

async function draftVerb(ctx, name, opts = {}) {
  const io = opts.io || console;
  // provider.js and paths.js resolve the vault when they are first required.
  process.env.AOS_VAULT = ctx.vault;
  const D = resolveModule('lib/workspace-draft.js');
  const r = await D.draftWorkspace(name, { vault: ctx.vault, ...(opts.draft || {}) });
  emit(io, opts.json, r, [
    `draft for ${r.file} (${r.provider === 'heuristic' ? `heuristic: ${r.reason}` : `${r.provider}${r.model ? ` · ${r.model}` : ''}`}); nothing written`,
    `summary: ${r.fields.summary || '(none)'}`,
    'objectives:', ...(r.fields.objectives.length ? r.fields.objectives.map((x) => `  - ${x}`) : ['  (none)']),
    `next: ${r.fields.next || '(none)'}`,
    `sources: ${r.sources.join(', ') || '(none)'}`,
    `save with: aos workspace set ${name} --set '<json>' --expect ${r.baseHash}`,
  ]);
  return 0;
}

async function setVerb(ctx, name, opts = {}) {
  const io = opts.io || console;
  const WM = manifestLib();
  if (typeof opts.set !== 'string') throw new UsageError(`${USAGE.set}: --set is required`);
  if (opts.expect !== undefined && !HASH_RE.test(opts.expect)) throw new UsageError('aos workspace set: --expect takes the hash `draft` printed (64 hex characters), or none');
  const dir = WM.workspaceDir(ctx.vault, name);
  const fields = WM.validateSetFields(opts.set, { vault: ctx.vault, home: ctx.home, configDirs: [ctx.claudeDir, ctx.codexHome] });
  const r = WM.setManifest(dir, fields, { expect: opts.expect, dryRun: !!opts.dryRun });
  const rescanned = r.written ? await refreshSnapshot(ctx, opts) : false;
  const out = {
    ok: true, name, file: `workspaces/${name}/workspace.md`, fields, changed: r.changed, written: r.written, dryRun: !!opts.dryRun,
    // --dry-run: the exact file after (`text`) and as it is now (`beforeText`, null without one), for the Draft's preview.
    before: r.before, hash: r.hash, ...(opts.dryRun ? { text: r.text, beforeText: r.beforeText } : {}), rescanned,
  };
  emit(io, opts.json, out, opts.dryRun
    ? [`workspaces/${name}/workspace.md would read:`, r.text]
    : [r.written ? `workspaces/${name}/workspace.md: ${Object.keys(fields).join(', ')} set` : `workspaces/${name}/workspace.md already says that`]);
  return 0;
}

// ── main ──

function parseWorkspaceArgs(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) {
      // No argument starts with `-` (spec §4): a stray `-x` is never a name or a path.
      if (a.startsWith('-')) throw new UsageError(`aos workspace: unknown flag ${a}`);
      words.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (VALUE_FLAGS.has(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new UsageError(`aos workspace: --${name} needs a value`);
      flags[VALUE_FLAGS.get(name)] = String(v);
    } else if (BOOL_FLAGS.has(name) && eq === -1) {
      flags[BOOL_FLAGS.get(name)] = true;
    } else {
      throw new UsageError(`aos workspace: unknown flag ${a}`);
    }
  }
  return { words, flags };
}

async function main(argv, opts = {}) {
  const io = opts.io || console;
  const { words, flags } = parseWorkspaceArgs(argv);
  const verb = words[0] || 'list';
  if (!VERBS.includes(verb)) throw new UsageError(`aos workspace: unknown verb "${verb}" (${VERBS.join(' | ')})`);
  for (const k of Object.keys(flags)) {
    if (VERB_FLAGS[verb].includes(k)) continue;
    throw new UsageError(k === 'dryRun'
      ? 'aos workspace: --dry-run is only supported by `aos workspace set`'
      : `aos workspace ${verb}: --${k} is not one of its flags (${USAGE[verb]})`);
  }
  const args = words.slice(1);
  const [min, max] = VERB_ARGS[verb];
  if (args.length < min) throw new UsageError(USAGE[verb]);
  if (args.length > max) throw new UsageError(`${USAGE[verb]}: too many arguments`);
  const ctx = resolveCtx(opts);
  const o = { ...opts, io, json: !!flags.json, env: opts.env || ctx.env };
  switch (verb) {
    case 'list': return listWorkspaces(ctx, { io, json: !!flags.json, now: opts.now });
    case 'which': return whichVerb(ctx, { ...o, cwd: flags.cwd });
    case 'new': return newWorkspace(ctx, args.join(' '), { ...o, git: !!flags.git, pin: !!flags.pin, empty: !!flags.empty });
    case 'stubs': return stubsVerb(ctx, args[0], { ...o, pin: !!flags.pin });
    case 'adopt': return adoptWorkspace(ctx, args[0], { ...o, name: flags.name, into: flags.into });
    case 'archive': return archiveWorkspace(ctx, args[0], o);
    case 'restore': return restoreWorkspace(ctx, args[0], o);
    case 'rename': return renameWorkspace(ctx, args[0], args[1], o);
    case 'hide': return hideVerb(ctx, args[0], o);
    case 'unhide': return hideVerb(ctx, args[0], { ...o, unhide: true });
    case 'draft': return draftVerb(ctx, args[0], o);
    case 'set': return setVerb(ctx, args[0], { ...o, set: flags.set, expect: flags.expect, dryRun: !!flags.dryRun });
    default: return 2;
  }
}

module.exports = {
  VERBS, RESERVED, SCRATCH, KEBAB_RE, HASH_RE, UsageError, main, resolveCtx, slugify, stubs, completeStubs, newWorkspace,
  adoptWorkspace, listWorkspaces, whichWorkspace, flipProjectNotes, runningTurns, linkedWorktrees, ago,
  // The importer (install-import B9) creates several workspaces with rescan: false, then refreshes the snapshot once.
  refreshSnapshot,
};
