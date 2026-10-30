#!/usr/bin/env node
'use strict';
/**
 * duty-guard.js — what a duty may write, and a check that it wrote nothing else it could reach
 * (docs/design/specs/2026-09-23-duty-write-scope-design.md). run-duty.sh calls it around every duty, on both hosts.
 *
 *   node duty-guard.js scope --host claude [--duty <slug>] [--tools <list>] [--writes <list>]
 *        two lines: the --allowedTools value (D1: bare Write/Edit and every Edit(…)/Write(…) rule dropped, one absolute
 *        Edit(//…) rule per write-scope entry added; D2: git log/diff/show and unrestricted Bash dropped) and the
 *        --disallowedTools value (the guarded and executable areas, git's --output). Relative Edit rules are not used:
 *        they did not match through a symlinked vault path in a live probe, so each rule names both the vault path as
 *        configured and its realpath.
 *   node duty-guard.js scope --host codex [--duty <slug>] [--writes <list>] [--dry-run]
 *        one directory per line for `codex exec --add-dir` (D4): every write-scope directory outside persona/ (the run's
 *        -C root), created when missing (not on --dry-run). A file entry grants its folder: Codex roots are directories.
 *        A built-in file entry whose folder is refused (MEMORY.md: its folder is the vault) is left out without a
 *        refusal line; `check` backfills its index lines instead.
 *   node duty-guard.js snapshot <slug>
 *        copies the guarded persona files (D6) to <config home>/agenticos-duty-guard/<slug>/ (D7: outside every duty's
 *        reach — Codex's sandbox can write $TMPDIR, neither host's duty can write the config home). Exit 0, or 1.
 *   node duty-guard.js check <slug> [--keep <dir>]
 *        after the duty: every added, changed or removed guarded file is restored and the duty's version kept under
 *        <dir>/guard-<slug>-<stamp>/ (default <vault>/persona/journal/logs); ledger.jsonl keeps the lines it had plus
 *        appended `filed` events only. A restore adds a flag under `## Flags` in STATE.md and one OS notification.
 *        On a clean check for a duty whose built-in writes hold brain/memory/feedback/, every feedback memory changed
 *        since the snapshot and not linked from MEMORY.md gets its `## Feedback` line (`indexed`, or `indexError`, in
 *        the JSON; spec 2026-09-28-reflect-memory-writes-design D3/D4).
 *        Prints one JSON line; exit 0 clean, 4 restored, 5 no snapshot.
 *
 * The write scope (D5) is DEFAULT_WRITES, the duty's DUTY_WRITES (--duty) and a routine's `writes:` entries
 * (PERSONA_WRITES). An entry that is the vault, holds or sits in a guarded or executable area, or has a dot-segment is
 * refused on stderr and left out.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 1;
const EXIT_RESTORED = 4;
const EXIT_NO_SNAPSHOT = 5;
/** Vault-relative; a trailing / marks a folder. The built-in duties' writes, so an un-reseeded vault keeps working.
 *  Not the playbook: it is the Chief of Staff's own routing, an instruction, so a duty proposes a change to it
 *  (spec 2026-10-24-persona-learning-loop-design D2) and lib/write-areas.js guards it. */
const DEFAULT_WRITES = ['persona/journal/', 'persona/STATE.md', 'persona/proposals/', 'brain/reflections/', 'brain/_index/sitrep.md'];
/** The feedback-memory folder; a duty with it among its built-in writes gets each new memory indexed by `check`. */
const FEEDBACK_DIR = 'brain/memory/feedback/';
/** Per-duty built-in writes on top of DEFAULT_WRITES (spec 2026-09-28-reflect-memory-writes-design D1/D2): in the
 *  runtime, not the routine files, because brain/routines/ is seeded once and an upgrade never rewrites it. Empty since
 *  spec 2026-10-24-persona-learning-loop-design D2: a feedback rule is an instruction, so the reflect duties propose one
 *  instead of writing it. The duty that writes observations (the user model, D6) registers its entries here. */
const DUTY_WRITES = {};
/** D6: what decides what runs and what is trusted (GUARDED; the ledger, LEDGER, is guarded separately: append-only,
 *  `filed` only), and what no duty writes on top of it (EXECUTABLE: code, schedules, other projects). They and the
 *  refusal rule live in lib/write-areas.js, which the routine editors check a duty's `writes` against before it runs. */
const { GUARDED, LEDGER, EXECUTABLE, fold, refusal, instructionKind, normEntry: norm, dutyWritesRefusal } = require('../lib/write-areas.js');
/** The vault's own dot-folders (git, Obsidian, each host's project settings) — never the user's config dir. */
const DENY_DOT_DIRS = ['.git/', '.obsidian/', '.claude/', '.codex/', '.agents/'];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const GIT_WRITE_OUT = 'Bash(git *--output*)';
const DROP_BASH = /^Bash\((git (log|diff|show)\b.*|\*|:\*)\)$/;

// ── scope ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Splits an allowedTools list on commas outside parentheses; a rule keeps its inner spaces (Bash(node <path>:*)). */
function splitTools(list) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(list || '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function toolName(rule) { const i = rule.indexOf('('); return i === -1 ? rule : rule.slice(0, i); }


/** The daily-note folder for `now`, vault-relative, or null when the layout puts notes at the vault root. */
function dailyNoteDir(vault, now = new Date()) {
  const { dailyNoteLayoutFor, formatLayout } = require('../lib/paths.js');
  const rel = path.posix.dirname(formatLayout(dailyNoteLayoutFor(vault), now).replace(/\\/g, '/'));
  return rel === '.' ? null : `${rel}/`;
}

/** A duty's built-in writes (DUTY_WRITES), or none; own keys only, so a slug like `constructor` gets none. */
function dutyWrites(duty) { return Object.prototype.hasOwnProperty.call(DUTY_WRITES, duty) ? DUTY_WRITES[duty] : []; }

/** D5: DEFAULT_WRITES + today's daily-note folder + the duty's DUTY_WRITES + `writes`, each checked; returns
 *  { entries: [{rel, dir, builtIn}], refused }. `builtIn` marks every entry that is not the routine's own. */
function writeScope({ vault, writes = '', duty = '', now = new Date() } = {}) {
  const raw = [...DEFAULT_WRITES];
  const daily = dailyNoteDir(vault, now);
  if (daily) raw.push(daily);
  raw.push(...dutyWrites(duty));
  const builtIns = raw.length;
  for (const w of String(writes || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const isDir = w.endsWith('/') || (() => { try { return fs.statSync(path.join(vault, w)).isDirectory(); } catch { return false; } })();
    raw.push(isDir && !w.endsWith('/') ? `${w}/` : w);
  }
  const entries = [], refused = [], seen = new Set();
  raw.forEach((r, i) => {
    const e = { ...norm(r), builtIn: i < builtIns };
    const why = dutyWritesRefusal(r);
    if (why) { refused.push({ entry: r, why }); return; }
    const key = `${e.rel}${e.dir ? '/' : ''}`;
    if (!seen.has(key)) { seen.add(key); entries.push(e); }
  });
  return { entries, refused };
}

/** The vault as configured and its realpath (deduplicated): Claude matches a rule against the path the model wrote. */
function vaultForms(vault) {
  const abs = path.resolve(vault);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* not there: the configured form is all there is */ }
  return real === abs ? [abs] : [abs, real];
}

function editRule(abs, rel, dir) { return `Edit(/${abs}/${rel}${dir ? '/**' : ''})`; }

/** D1 + D2: { allowed, denied } for a Claude duty. */
function claudeTools({ vault, tools = '', writes = '', duty = '', now = new Date() } = {}) {
  const { entries, refused } = writeScope({ vault, writes, duty, now });
  const kept = splitTools(tools).filter((r) => !WRITE_TOOLS.has(toolName(r)) && r !== 'Bash' && !DROP_BASH.test(r));
  const forms = vaultForms(vault);
  const allowed = [...kept];
  for (const abs of forms) for (const e of entries) allowed.push(editRule(abs, e.rel, e.dir));
  const denied = [GIT_WRITE_OUT];
  for (const abs of forms) {
    for (const g of [...GUARDED, LEDGER, ...EXECUTABLE, ...DENY_DOT_DIRS]) {
      const e = norm(g);
      denied.push(editRule(abs, e.rel, e.dir));
    }
  }
  return { allowed: allowed.join(','), denied: denied.join(','), refused };
}

/** D4: absolute folders for `codex exec --add-dir`, outside persona/ (the -C root); created when missing. A built-in
 *  file whose folder is refused (MEMORY.md) is left out quietly: `check` backfills it (reflect-memory-writes D3). */
function codexDirs({ vault, writes = '', duty = '', now = new Date(), mkdir = true } = {}) {
  const { entries, refused } = writeScope({ vault, writes, duty, now });
  const dirs = [];
  for (const e of entries) {
    const rel = e.dir ? e.rel : path.posix.dirname(e.rel);
    if (rel === 'persona' || rel.startsWith('persona/')) continue;
    const why = refusal(rel);
    if (why && e.builtIn && !e.dir) continue;
    if (why) { refused.push({ entry: `${rel}/ (folder of ${e.rel})`, why }); continue; }
    const abs = path.join(path.resolve(vault), ...rel.split('/'));
    if (dirs.includes(abs)) continue;
    if (mkdir) fs.mkdirSync(abs, { recursive: true });
    dirs.push(abs);
  }
  return { dirs, refused };
}

// ── snapshot / check ────────────────────────────────────────────────────────────────────────────────────────────────

/** The folder holding agenticos.json (AOS_CONFIG, else the config dir lib/host.js names) — the same on both hosts. */
function configHome(env = process.env) {
  const cfg = env.AOS_CONFIG || path.join(require('../lib/host.js').claudeConfigDir(env), 'agenticos.json');
  return path.dirname(path.resolve(cfg));
}
function guardDir(slug, home = configHome()) { return path.join(home, 'agenticos-duty-guard', slug); }

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** Every guarded file under `vault` → { rel: 'sha256:<hex>' | 'link:<target>' }. lstat: a symlink is recorded, not followed. */
function listGuarded(vault) {
  const out = {};
  const visit = (rel) => {
    const abs = path.join(vault, ...rel.split('/'));
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(abs)}`;
    else if (st.isDirectory()) for (const n of fs.readdirSync(abs).sort()) visit(`${rel}/${n}`);
    else if (st.isFile()) out[rel] = `sha256:${sha(fs.readFileSync(abs))}`;
  };
  for (const g of [...GUARDED, 'CLAUDE.md', 'AGENTS.md', 'AGENTICOS.md']) visit(g.replace(/\/$/, ''));
  // Dynamic instruction paths cannot be represented as a single guarded folder: feedback drafts,
  // team boards and each agent's state must stay writable. Enumerate just the instruction files.
  const list = (rel) => {
    try { return fs.readdirSync(path.join(vault, ...rel.split('/'))).sort(); } catch { return []; }
  };
  for (const name of list('brain/memory/feedback')) {
    const rel = `brain/memory/feedback/${name}`;
    if (instructionKind(rel)) visit(rel);
  }
  for (const team of list('persona/teams')) {
    const dir = `persona/teams/${team}`;
    try { if (fs.lstatSync(path.join(vault, dir)).isSymbolicLink()) { visit(dir); continue; } } catch { continue; }
    visit(`${dir}/TEAM.md`);
  }
  for (const agent of list('persona')) {
    if (['teams', 'duties', 'routines', 'flag-closer', 'journal', 'proposals'].includes(agent)) continue;
    const agentDir = `persona/${agent}`;
    try { if (fs.lstatSync(path.join(vault, agentDir)).isSymbolicLink()) { visit(agentDir); continue; } } catch { continue; }
    for (const name of ['IDENTITY.md', 'PLAYBOOK.md', 'duties', 'routines', 'skills']) {
      const rel = `persona/${agent}/${name}`;
      if (instructionKind(rel)) visit(rel);
    }
  }
  return out;
}

function copyEntry(fromRoot, toRoot, rel) {
  const src = path.join(fromRoot, ...rel.split('/'));
  const dst = path.join(toRoot, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
  else fs.copyFileSync(src, dst);
}

/** User-owned instruction roots, only when the installed config identifies this vault. */
function hostInstructionRoots(vault, env = process.env) {
  let cfg;
  try {
    const file = env.AOS_CONFIG || path.join(require('../lib/host.js').claudeConfigDir(env), 'agenticos.json');
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const configured = path.resolve(cfg.vault);
    const attached = path.resolve(vault);
    if (configured !== attached && fs.realpathSync(configured) !== fs.realpathSync(attached)) return [];
  } catch { return []; }
  const skills = require('../lib/skills.js').roots({ userCfg: cfg, env, home: env.HOME || require('os').homedir() });
  const agents = require('../lib/agents.js').roots({ userCfg: cfg, env });
  return [
    { id: 'claude-skills', dir: skills.claudeSkills, kind: 'skills' },
    { id: 'codex-skills', dir: skills.codexSkills, kind: 'skills' },
    { id: 'claude-agents', dir: agents.claudeAgents, kind: 'agents' },
    { id: 'codex-agents', dir: agents.codexAgents, kind: 'agents' },
  ];
}

/** Only instruction documents: user skills' SKILL.md and host agent definitions. Never follow a symlink folder. */
function listHostInstructions(root, kind) {
  const out = {};
  const walk = (rel, depth) => {
    const abs = path.join(root, rel);
    let names;
    try { names = fs.readdirSync(abs).sort(); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const next = rel ? `${rel}/${name}` : name;
      const file = path.join(root, next);
      let st;
      try { st = fs.lstatSync(file); } catch { continue; }
      if (kind === 'skills' && st.isDirectory() && depth < 4) { walk(next, depth + 1); continue; }
      const target = kind === 'skills' ? name === 'SKILL.md' : depth === 0 && /\.(md|toml)$/.test(name);
      if (!target || !(st.isFile() || st.isSymbolicLink())) continue;
      out[next] = st.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : `sha256:${sha(fs.readFileSync(file))}`;
    }
  };
  walk('', 0);
  return out;
}

/** Roots are resolved once at snapshot time; a changed root alias is an error, never followed during restore. */
function snapshotHostRoots(roots, dir) {
  const specs = [], files = {};
  for (const root of roots) {
    if (!/^(claude|codex)-(skills|agents)$/.test(root.id) || !['skills', 'agents'].includes(root.kind)) throw new Error('invalid host instruction root');
    const alias = path.resolve(root.dir);
    let real;
    try { real = fs.realpathSync(alias); } catch { real = alias; }
    const spec = { id: root.id, alias, real, kind: root.kind };
    specs.push(spec);
    const found = listHostInstructions(real, root.kind);
    for (const [rel, hash] of Object.entries(found)) {
      const key = `${root.id}/${rel}`;
      files[key] = hash;
      copyEntry(real, path.join(dir, 'host-files', root.id), rel);
    }
  }
  return { roots: specs, files };
}

function checkHostRoots(manifest, snapDir, keepDir) {
  const restored = [];
  const before = manifest.hostFiles || {};
  for (const spec of manifest.hostRoots || []) {
    let actual;
    try { actual = fs.realpathSync(spec.alias); } catch { actual = spec.alias; }
    if (actual !== spec.real) throw new Error(`host instruction root changed: ${spec.id}`);
    const prefix = `${spec.id}/`;
    const current = listHostInstructions(spec.real, spec.kind);
    const after = Object.fromEntries(Object.entries(current).map(([rel, hash]) => [`${prefix}${rel}`, hash]));
    for (const key of Object.keys(after).sort()) {
      if (before[key] === after[key]) continue;
      moveAside(spec.real, path.join(keepDir, 'host', spec.id), key.slice(prefix.length));
      restored.push({ path: `host/${key}`, change: key in before ? 'changed' : 'added' });
    }
    for (const key of Object.keys(before).filter((k) => k.startsWith(prefix)).sort()) {
      if (after[key] === before[key]) continue;
      const rel = key.slice(prefix.length);
      const dst = path.join(spec.real, rel);
      let parent = path.posix.dirname(rel);
      while (parent && parent !== '.') {
        const abs = path.join(spec.real, parent);
        try { if (!fs.lstatSync(abs).isDirectory()) { moveAside(spec.real, path.join(keepDir, 'host', spec.id), parent); break; } } catch { /* created by copyEntry */ }
        parent = path.posix.dirname(parent);
      }
      fs.rmSync(dst, { recursive: true, force: true });
      copyEntry(path.join(snapDir, 'host-files', spec.id), spec.real, rel);
      if (!(key in after)) restored.push({ path: `host/${key}`, change: 'removed' });
    }
  }
  return restored;
}

function snapshot({ vault, slug, dir = guardDir(slug), now = new Date(), hostRoots = [] } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const files = listGuarded(vault);
  for (const rel of Object.keys(files)) copyEntry(vault, path.join(dir, 'files'), rel);
  const ledgerAbs = path.join(vault, ...LEDGER.split('/'));
  const ledger = fs.existsSync(ledgerAbs);
  if (ledger) fs.copyFileSync(ledgerAbs, path.join(dir, 'ledger.jsonl'));
  const host = snapshotHostRoots(hostRoots, dir);
  const manifest = { schema: SCHEMA, slug, at: now.toISOString(), vault: path.resolve(vault), files, ledger, hostRoots: host.roots, hostFiles: host.files };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { schema: SCHEMA, slug, files: Object.keys(files).length, ledger };
}

function moveAside(vault, keepDir, rel) {
  const src = path.join(vault, ...rel.split('/'));
  const dst = path.join(keepDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); } catch { fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
}

/** The ledger rule: the old bytes stay a prefix and only valid `filed` lines were appended; anything else is undone. */
function reconcileLedger(vault, snapDir, keepDir) {
  const abs = path.join(vault, ...LEDGER.split('/'));
  const orig = fs.existsSync(path.join(snapDir, 'ledger.jsonl')) ? fs.readFileSync(path.join(snapDir, 'ledger.jsonl')) : Buffer.alloc(0);
  let cur;
  try { cur = fs.readFileSync(abs); } catch { cur = null; }
  if (cur === null) {
    if (!orig.length) return null;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, orig);
    return 'removed';
  }
  if (cur.length >= orig.length && cur.subarray(0, orig.length).equals(orig)) {
    const tail = cur.subarray(orig.length).toString('utf8');
    const lines = tail.split('\n').filter((l) => l.trim());
    const kept = lines.filter((l) => { try { const r = JSON.parse(l); return r && r.event === 'filed'; } catch { return false; } });
    if (kept.length === lines.length) return null;
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(path.join(keepDir, 'ledger.appended.jsonl'), tail);
    fs.writeFileSync(abs, Buffer.concat([orig, Buffer.from(kept.map((l) => `${l}\n`).join(''))]));
    return 'appended';
  }
  fs.mkdirSync(keepDir, { recursive: true });
  fs.writeFileSync(path.join(keepDir, 'ledger.jsonl'), cur);
  fs.writeFileSync(abs, orig);
  return 'rewritten';
}

function pad(n) { return String(n).padStart(2, '0'); }
function localDay(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function stamp(d) { return `${localDay(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }

/** Inserts `line` right under `## Flags` (run-duty.sh's FAILED slot); no heading → unchanged. */
function flagState(stateFile, line) {
  let text;
  try { text = fs.readFileSync(stateFile, 'utf8'); } catch { return false; }
  const lines = text.split('\n');
  const h = lines.findIndex((l) => /^## Flags\s*$/.test(l));
  if (h === -1) return false;
  lines.splice(h + 1, 0, line);
  const tmp = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, stateFile);
  return true;
}

/** A memory's index label: the first `# ` heading (else the slug), and the frontmatter `description:` (else the first
 *  body line), clipped like memory-writer's. */
function memoryLabel(text, slug) {
  const { deriveDescription } = require('../lib/memory-index.js');
  let body = text, description = '';
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    const d = /^description:[ \t]*(.+)$/m.exec(fm[1]);
    if (d) description = d[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const lines = body.split(/\r?\n/);
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  const title = h1 ? h1.replace(/^#\s+/, '').replace(/\s+/g, ' ').trim() : slug;
  if (!description) description = lines.find((l) => l.trim() && !/^#/.test(l)) || title;
  return { title, description: deriveDescription(description) };
}

/**
 * D3 (reflect-memory-writes): one `## Feedback` line in MEMORY.md for each feedback memory changed since `since` and
 * not linked yet — the index line a Codex duty cannot write (Codex roots are folders; MEMORY.md's is the vault). Regular
 * top-level *.md files only: no symlink, dot-file, README.md or _drafts/. Returns the vault-relative paths it indexed.
 */
function indexFeedback({ vault, since }) {
  const t0 = Date.parse(since);
  if (!Number.isFinite(t0)) return [];
  const dir = path.join(vault, ...FEEDBACK_DIR.split('/'));
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('.') && n !== 'README.md').sort(); } catch { return []; }
  // 2 s of slack: a file system with coarse mtimes can stamp a write made just after the snapshot a little before it.
  const fresh = names.filter((n) => { try { const st = fs.lstatSync(path.join(dir, n)); return st.isFile() && st.mtimeMs >= t0 - 2000; } catch { return false; } });
  if (!fresh.length) return [];
  const { insertIndexLine } = require('../lib/memory-index.js');
  const indexed = [];
  require('../lib/fsx.js').updateSync(path.join(vault, 'MEMORY.md'), (idx) => {
    let text = idx == null ? '# Index\n' : idx;
    for (const name of fresh) {
      const rel = `${FEEDBACK_DIR}${name}`;
      if (text.includes(`](${rel})`)) continue;
      const { title, description } = memoryLabel(fs.readFileSync(path.join(dir, name), 'utf8'), name.slice(0, -3));
      text = insertIndexLine(text, '## Feedback', `- [${title}](${rel}) — ${description}`);
      indexed.push(rel);
    }
    return text;
  }, { timeoutMs: 5000 });
  return indexed;
}

function check({ vault, slug, dir = guardDir(slug), keepRoot = path.join(vault, 'persona', 'journal', 'logs'), now = new Date(), notify } = {}) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return { schema: SCHEMA, slug, error: 'no snapshot' }; }
  const before = manifest.files || {};
  const after = listGuarded(vault);
  const keepDir = path.join(keepRoot, `guard-${slug}-${stamp(now)}`);
  const restored = [];
  // Added or changed: the duty's version moves aside (a file standing where a folder was is caught here too).
  for (const rel of Object.keys(after).sort()) {
    if (before[rel] === after[rel]) continue;
    moveAside(vault, keepDir, rel);
    restored.push({ path: rel, change: rel in before ? 'changed' : 'added' });
  }
  // Changed or removed: the snapshot's version comes back.
  for (const rel of Object.keys(before).sort()) {
    if (after[rel] === before[rel]) continue;
    const dst = path.join(vault, ...rel.split('/'));
    // A parent that became a file (or a symlink) blocks the restore: move it aside first.
    let p = path.dirname(rel);
    while (p && p !== '.') {
      const abs = path.join(vault, ...p.split('/'));
      try { const st = fs.lstatSync(abs); if (!st.isDirectory()) { moveAside(vault, keepDir, p); break; } } catch { /* missing: mkdir below */ }
      p = path.posix.dirname(p);
    }
    fs.rmSync(dst, { recursive: true, force: true });
    copyEntry(path.join(dir, 'files'), vault, rel);
    if (!(rel in after)) restored.push({ path: rel, change: 'removed' });
  }
  const hostRestored = checkHostRoots(manifest, dir, keepDir);
  restored.push(...hostRestored);
  const ledger = reconcileLedger(vault, dir, keepDir);
  if (ledger) restored.push({ path: LEDGER, change: ledger });
  fs.rmSync(dir, { recursive: true, force: true });
  if (!restored.length) {
    const clean = { schema: SCHEMA, slug, restored: [] };
    // D4: the backfill follows a clean check only; manifest.at is the run's start.
    if (dutyWrites(slug).includes(FEEDBACK_DIR)) {
      try {
        const indexed = indexFeedback({ vault, since: manifest.at });
        if (indexed.length) clean.indexed = indexed;
      } catch (e) { clean.indexError = e.message; }
    }
    return clean;
  }
  const names = restored.map((r) => r.path).join(', ');
  flagState(path.join(vault, 'persona', 'STATE.md'), `- [ ] ${localDay(now)} duty '${slug}' wrote guarded file(s) ${names} — restored, its version kept in ${path.relative(vault, keepDir)} (guard)`);
  (notify || ((t, m) => require('./watchdog.js').osNotify(t, m)))('AgenticOS', `duty '${slug}' wrote guarded file(s) — restored`);
  return { schema: SCHEMA, slug, restored, kept: keepDir };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const BOOL_FLAGS = new Set(['dry-run']);
function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && BOOL_FLAGS.has(a.slice(2))) flags[a.slice(2)] = true;
    else if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1] === undefined ? '' : argv[i + 1]; i++; }
    else positional.push(a);
  }
  return { flags, positional };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const USAGE = 'usage: duty-guard.js scope --host claude|codex [--duty <slug>] [--tools <list>] [--writes <list>] [--dry-run] | snapshot <slug> | check <slug> [--keep <dir>]\n';

function main(argv, { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), env = process.env, now = new Date() } = {}) {
  const { flags, positional } = parseArgs(argv);
  const [verb, slug] = positional;
  let vault;
  try { vault = flags.vault || env.AOS_VAULT || require('../lib/paths.js').VAULT; } catch (e) { stderr(`duty-guard: ${e.message}\n`); return 1; }
  try {
    if (verb === 'scope') {
      if (flags.duty !== undefined && !SLUG_RE.test(flags.duty)) { stderr(USAGE); return 2; }
      const duty = flags.duty || '';
      if (flags.host === 'claude') {
        const r = claudeTools({ vault, tools: flags.tools, writes: flags.writes, duty, now });
        for (const x of r.refused) stderr(`duty-guard: writes entry '${x.entry}' refused: ${x.why}\n`);
        stdout(`${r.allowed}\n${r.denied}\n`);
        return 0;
      }
      if (flags.host === 'codex') {
        const r = codexDirs({ vault, writes: flags.writes, duty, now, mkdir: !flags['dry-run'] });
        for (const x of r.refused) stderr(`duty-guard: writes entry '${x.entry}' refused: ${x.why}\n`);
        stdout(r.dirs.map((d) => `${d}\n`).join(''));
        return 0;
      }
      stderr(USAGE); return 2;
    }
    if ((verb === 'snapshot' || verb === 'check') && !SLUG_RE.test(String(slug || ''))) { stderr(USAGE); return 2; }
    const dir = guardDir(slug, configHome(env));
    if (verb === 'snapshot') { stdout(JSON.stringify(snapshot({ vault, slug, dir, now, hostRoots: hostInstructionRoots(vault, env) })) + '\n'); return 0; }
    if (verb === 'check') {
      const r = check({ vault, slug, dir, keepRoot: flags.keep || undefined, now });
      stdout(JSON.stringify(r) + '\n');
      if (r.error) return EXIT_NO_SNAPSHOT;
      return r.restored.length ? EXIT_RESTORED : 0;
    }
  } catch (e) { stderr(`duty-guard ${verb}: ${e.message}\n`); return 1; }
  stderr(USAGE);
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = {
  SCHEMA, EXIT_RESTORED, EXIT_NO_SNAPSHOT, DEFAULT_WRITES, FEEDBACK_DIR, DUTY_WRITES, GUARDED, LEDGER, EXECUTABLE, GIT_WRITE_OUT,
  splitTools, fold, refusal, dailyNoteDir, dutyWrites, writeScope, vaultForms, claudeTools, codexDirs, configHome, guardDir, listGuarded, listHostInstructions, hostInstructionRoots, snapshot,
  memoryLabel, indexFeedback, check, flagState, main,
};
