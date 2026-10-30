'use strict';
/** Deterministic proposal change sets. The Workbench UI supplies the reviewed file digest to apply(). */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { instructionKind, fold } = require('../lib/write-areas.js');
const Ledger = require('./ledger.js');
const { hostInstructionRoots } = require('./duty-guard.js');

const NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,60}\.md$/;
const SHA_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_FILE = 256 * 1024;
const OPS = new Set(['create', 'patch', 'replace', 'delete']);
const HOST_IDS = new Set(['claude-skills', 'codex-skills', 'claude-agents', 'codex-agents']);
function vaultInstructionFile(rel) {
  if (!instructionKind(rel)) return false;
  if (['CLAUDE.md', 'AGENTS.md', 'AGENTICOS.md', 'persona/IDENTITY.md', 'persona/PLAYBOOK.md'].includes(rel)) return true;
  if (/^persona\/(?:duties|routines)\/[^/]+\.md$/.test(rel)) return true;
  if (/^persona\/teams\/[^/]+\/TEAM\.md$/.test(rel)) return true;
  if (/^brain\/memory\/feedback\/[^/]+\.md$/.test(rel) && rel !== 'brain/memory/feedback/README.md') return true;
  if (/^persona\/[^/]+\/(?:IDENTITY|PLAYBOOK)\.md$/.test(rel)) return true;
  if (/^persona\/[^/]+\/(?:duties|routines)\/[^/]+\.md$/.test(rel)) return true;
  return /^persona\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(rel);
}
function hostPath(rel) {
  const parts = rel.split('/');
  if (parts[0] !== 'host' || !HOST_IDS.has(parts[1])) return null;
  const file = parts[parts.length - 1];
  if (parts[1].endsWith('-skills')) return parts.length >= 4 && file === 'SKILL.md' ? { id: parts[1], subpath: parts.slice(2).join('/') } : null;
  return parts.length === 3 && (/\.md$/.test(file) && parts[1] === 'claude-agents' || /\.toml$/.test(file) && parts[1] === 'codex-agents')
    ? { id: parts[1], subpath: file } : null;
}
function hash(data) { return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`; }
function fileFor(root, name) {
  if (!NAME_RE.test(name)) throw new Error('invalid proposal file name');
  return path.join(root, 'persona', 'proposals', name);
}
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('proposal has no frontmatter');
  const lines = match[1].split(/\r?\n/);
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error(`invalid quoted frontmatter value: ${kv[1]}`); }
    }
    if (value === '|') {
      const block = [];
      while (i + 1 < lines.length && /^  /.test(lines[i + 1])) block.push(lines[++i].slice(2));
      value = block.join('\n');
    }
    fields[kv[1]] = value;
  }
  return fields;
}
function parseChanges(fields) {
  if (!fields.changes) return null;
  let changes;
  try { changes = JSON.parse(fields.changes); } catch { throw new Error('changes must be a JSON array in frontmatter'); }
  if (!Array.isArray(changes) || !changes.length || changes.length > 20) throw new Error('changes must contain 1 to 20 entries');
  const seen = new Set();
  for (const change of changes) {
    if (!change || typeof change !== 'object' || !OPS.has(change.op)) throw new Error('invalid change operation');
    if (typeof change.path !== 'string' || !change.path || change.path.includes('\\') || change.path.includes('\0') ||
        path.posix.isAbsolute(change.path) || path.posix.normalize(change.path) !== change.path ||
        change.path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('invalid change path');
    if (!vaultInstructionFile(change.path) && !hostPath(change.path)) throw new Error(`not an instruction file: ${change.path}`);
    const key = fold(change.path);
    if (seen.has(key)) throw new Error(`duplicate change path: ${change.path}`);
    seen.add(key);
    if (change.op === 'create') {
      if (change.base !== null || typeof change.content !== 'string') throw new Error('create needs base:null and content');
    } else if (!SHA_RE.test(change.base)) throw new Error('existing file change needs a sha256 base');
    if (change.op === 'replace' && typeof change.content !== 'string') throw new Error('replace needs content');
    if (change.op === 'patch' && (typeof change.old !== 'string' || !change.old || typeof change.new !== 'string')) throw new Error('patch needs exact old and new text');
    for (const field of ['content', 'old', 'new']) if (typeof change[field] === 'string' && Buffer.byteLength(change[field]) > MAX_FILE) throw new Error('change content too large');
  }
  return changes;
}
function read(root, name) {
  const file = fileFor(root, name);
  const raw = fs.readFileSync(file);
  if (raw.length > MAX_FILE * 2) throw new Error('proposal too large');
  const fields = frontmatter(raw.toString('utf8'));
  const slug = name.slice(11, -3);
  if (fields.slug !== slug) throw new Error('proposal slug does not match file name');
  return { file, name, slug, raw, digest: hash(raw), fields, changes: parseChanges(fields) };
}
function safeTarget(root, rel, hostRoots = hostInstructionRoots(root)) {
  const host = hostPath(rel);
  const spec = host && hostRoots.find((r) => r.id === host.id);
  if (host && !spec) throw new Error(`host instruction root is not configured: ${host.id}`);
  const base = path.resolve(spec ? spec.dir : root);
  if (host && host.id.endsWith('-skills') && fs.existsSync(path.join(base, path.posix.dirname(host.subpath), '.aos-mirror.json'))) {
    throw new Error('edit the source skill, not its generated mirror');
  }
  let current = base;
  for (const part of (host ? host.subpath : rel).split('/')) {
    current = path.join(current, part);
    let st;
    try { st = fs.lstatSync(current); } catch { continue; }
    if (st.isSymbolicLink()) throw new Error(`symlink in target path: ${rel}`);
  }
  return current;
}
function plan(root, proposal, { hostRoots = hostInstructionRoots(root) } = {}) {
  if (!proposal.changes) throw new Error('legacy proposal needs an exact diff before approval');
  const entries = [];
  for (const change of proposal.changes) {
    const target = safeTarget(root, change.path, hostRoots);
    let before = null;
    try {
      const st = fs.lstatSync(target);
      if (!st.isFile()) throw new Error(`not a regular file: ${change.path}`);
      before = fs.readFileSync(target);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (change.op === 'create' ? before !== null : before === null || hash(before) !== change.base) throw new Error(`stale base: ${change.path}`);
    let after = null;
    if (change.op === 'create' || change.op === 'replace') after = Buffer.from(change.content, 'utf8');
    if (change.op === 'patch') {
      const text = before.toString('utf8');
      const first = text.indexOf(change.old);
      if (first < 0 || text.indexOf(change.old, first + change.old.length) >= 0) throw new Error(`patch text is absent or repeated: ${change.path}`);
      after = Buffer.from(text.slice(0, first) + change.new + text.slice(first + change.old.length), 'utf8');
    }
    if (after && after.length > MAX_FILE) throw new Error(`result too large: ${change.path}`);
    entries.push({ path: change.path, target, op: change.op, before, after, afterHash: after ? hash(after) : null });
  }
  return entries;
}
function preview(root, name, options = {}) {
  const proposal = read(root, name);
  const entries = plan(root, proposal, options);
  return { name, slug: proposal.slug, digest: proposal.digest, recheck: proposal.fields.recheck || null,
    changes: entries.map((e) => ({ path: e.path, op: e.op, base: e.before ? hash(e.before) : null, after: e.afterHash,
      before: e.before ? e.before.toString('utf8') : null, content: e.after ? e.after.toString('utf8') : null })) };
}
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.proposal-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
}
function restore(entries) {
  for (const e of [...entries].reverse()) {
    if (e.before === null) fs.rmSync(e.target, { force: true });
    else writeAtomic(e.target, e.before);
  }
}
function gitCommit(root, paths, message) {
  const { spawnSync } = require('child_process');
  const safe = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', root];
  const opts = { encoding: 'utf8', timeout: 15000 };
  const inside = spawnSync('git', [...safe, 'rev-parse', '--is-inside-work-tree'], opts);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  // A vault can live inside a larger repository (the app's disposable fixture does).
  // Never stage its files in that parent: only a repository rooted at the vault is ours.
  const top = spawnSync('git', [...safe, 'rev-parse', '--show-toplevel'], opts);
  if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(root)) return null;
  const included = [];
  const newPaths = [];
  try {
    for (const rel of paths) {
      if (spawnSync('git', [...safe, 'ls-files', '--error-unmatch', '--', rel], { stdio: 'ignore', timeout: 15000 }).status === 0) {
        included.push(rel);
      } else if (fs.existsSync(path.join(root, rel))) {
        // Intent-to-add makes a new instruction file available to commit --only without
        // staging its contents or sweeping unrelated entries from the user's index.
        const add = spawnSync('git', [...safe, 'add', '-N', '--', rel], opts);
        if (add.status !== 0) throw new Error(`vault add failed: ${(add.stderr || add.stdout || '').trim().slice(0, 300)}`);
        newPaths.push(rel);
        included.push(rel);
      }
    }
    if (!included.length) return null;
    const result = spawnSync('git', [...safe, 'commit', '--only', '-m', message, '--', ...included], opts);
    if (result.status !== 0) throw new Error(`vault commit failed: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
    const head = spawnSync('git', [...safe, 'rev-parse', 'HEAD'], opts);
    return head.status === 0 ? head.stdout.trim() : null;
  } catch (e) {
    if (newPaths.length) spawnSync('git', [...safe, 'reset', '-q', '--', ...newPaths], { stdio: 'ignore', timeout: 15000 });
    throw e;
  }
}
function readMaybe(file) {
  try { return fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function restoreMaybe(file, data) { if (data === null) fs.rmSync(file, { force: true }); else writeAtomic(file, data); }
function undoBase(root, override) {
  const base = override || path.join(os.homedir(), '.local', 'state', 'agenticos', 'proposal-undo');
  return path.join(base, crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24));
}
function lockPath(root, override) { return path.join(undoBase(root, override), '.lock'); }
function withLock(root, fn, override) {
  const lock = lockPath(root, override);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const fd = fs.openSync(lock, 'wx');
  try { return fn(path.dirname(lock)); } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}
function apply(root, name, reviewedDigest, { runRecipe = Ledger.runRecipe, now = new Date(), undoRoot, hostRoots = hostInstructionRoots(root) } = {}) {
  if (process.env.AOS_HEADLESS === '1') throw new Error('automatic duties cannot approve proposals');
  const proposal = read(root, name);
  if (!SHA_RE.test(reviewedDigest) || proposal.digest !== reviewedDigest) throw new Error('proposal changed since review');
  if (!['self', 'vault'].includes(proposal.fields.kind || 'self')) throw new Error('only instruction proposals can apply');
  if (!proposal.fields.recheck) throw new Error('proposal has no recheck');
  return withLock(root, (undoDir) => {
    const fresh = read(root, name);
    if (fresh.digest !== reviewedDigest) throw new Error('proposal changed since review');
    const entries = plan(root, fresh, { hostRoots });
    const ledgerFile = path.join(root, 'persona', 'ledger.jsonl');
    const oldLedger = readMaybe(ledgerFile);
    const undoId = `${proposal.slug}-${now.toISOString().replace(/[:.]/g, '-')}`;
    const undo = path.join(undoDir, undoId);
    fs.mkdirSync(undo, { recursive: false });
    const manifest = { schema: 1, name, slug: proposal.slug, digest: proposal.digest, at: now.toISOString(), status: 'prepared',
      proposal: proposal.raw.toString('base64'),
      changes: entries.map((e) => ({ path: e.path, before: e.before ? e.before.toString('base64') : null, after: e.afterHash })) };
    fs.writeFileSync(path.join(undo, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    let changed = false;
    try {
      for (const e of entries) { if (e.after === null) fs.rmSync(e.target); else writeAtomic(e.target, e.after); changed = true; }
      const result = runRecipe(proposal.fields.recheck, root);
      if (result !== 'gone') throw new Error(`verification ${result}`);
      Ledger.append({ event: 'approved', slug: proposal.slug, kind: proposal.fields.kind || 'self',
        target: proposal.fields.target || null, by: 'user', recheck: proposal.fields.recheck }, { file: ledgerFile, now });
      fs.rmSync(proposal.file);
      const paths = [...entries.filter((e) => !hostPath(e.path)).map((e) => e.path), 'persona/ledger.jsonl', `persona/proposals/${name}`];
      manifest.commit = gitCommit(root, paths, `persona: apply approved proposal ${proposal.slug}`);
      manifest.status = 'applied';
      fs.writeFileSync(path.join(undo, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      return { ok: true, slug: proposal.slug, digest: proposal.digest, undoId, commit: manifest.commit,
        changed: entries.map((e) => e.path) };
    } catch (e) {
      if (changed) restore(entries);
      restoreMaybe(ledgerFile, oldLedger);
      restoreMaybe(proposal.file, proposal.raw);
      fs.writeFileSync(path.join(undo, 'failure.txt'), `${e.message}\n`);
      throw e;
    }
  }, undoRoot);
}
function reject(root, name, reviewedDigest, { now = new Date(), undoRoot } = {}) {
  if (process.env.AOS_HEADLESS === '1') throw new Error('automatic duties cannot reject proposals');
  return withLock(root, () => {
    const proposal = read(root, name);
    if (!SHA_RE.test(reviewedDigest) || proposal.digest !== reviewedDigest) throw new Error('proposal changed since review');
    const ledgerFile = path.join(root, 'persona', 'ledger.jsonl');
    const oldLedger = readMaybe(ledgerFile);
    try {
      Ledger.append({ event: 'rejected', slug: proposal.slug, kind: proposal.fields.kind || 'self',
        target: proposal.fields.target || null, by: 'user' }, { file: ledgerFile, now });
      fs.rmSync(proposal.file);
      const commit = gitCommit(root, ['persona/ledger.jsonl', `persona/proposals/${name}`], `persona: reject proposal ${proposal.slug}`);
      return { ok: true, slug: proposal.slug, commit };
    } catch (e) {
      restoreMaybe(ledgerFile, oldLedger);
      restoreMaybe(proposal.file, proposal.raw);
      throw e;
    }
  }, undoRoot);
}
function recentUndos(root, { undoRoot } = {}) {
  const dir = path.dirname(lockPath(root, undoRoot));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'manifest.json'), 'utf8'));
      return m.status === 'applied' ? [{ undoId: e.name, slug: m.slug, at: m.at, changes: m.changes.map((c) => c.path) }] : [];
    } catch { return []; }
  }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
}
function undo(root, undoId, { now = new Date(), undoRoot, hostRoots = hostInstructionRoots(root) } = {}) {
  if (process.env.AOS_HEADLESS === '1') throw new Error('automatic duties cannot undo proposals');
  if (!/^[a-z0-9][a-z0-9-]{1,60}-\d{4}-\d{2}-\d{2}T[0-9-]+Z$/.test(undoId)) throw new Error('invalid undo id');
  return withLock(root, (undoDir) => {
    const dir = path.join(undoDir, undoId);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (manifest.status !== 'applied') throw new Error('proposal is not applied');
    const proposalFile = fileFor(root, manifest.name);
    if (fs.existsSync(proposalFile)) throw new Error('proposal file exists again');
    const entries = manifest.changes.map((e) => {
      const target = safeTarget(root, e.path, hostRoots);
      const current = readMaybe(target);
      if ((current ? hash(current) : null) !== e.after) throw new Error(`file changed since approval: ${e.path}`);
      return { ...e, target, current, before: e.before === null ? null : Buffer.from(e.before, 'base64') };
    });
    const ledgerFile = path.join(root, 'persona', 'ledger.jsonl');
    const oldLedger = readMaybe(ledgerFile);
    try {
      for (const e of [...entries].reverse()) restoreMaybe(e.target, e.before);
      writeAtomic(proposalFile, Buffer.from(manifest.proposal, 'base64'));
      Ledger.append({ event: 'undone', slug: manifest.slug, by: 'user', note: 'approved change reverted' }, { file: ledgerFile, now });
      const paths = [...entries.filter((e) => !hostPath(e.path)).map((e) => e.path), 'persona/ledger.jsonl', `persona/proposals/${manifest.name}`];
      const commit = gitCommit(root, paths, `persona: undo approved proposal ${manifest.slug}`);
      manifest.status = 'undone'; manifest.undoCommit = commit; manifest.undoneAt = now.toISOString();
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      return { ok: true, slug: manifest.slug, undoId, commit };
    } catch (e) {
      for (const entry of entries) restoreMaybe(entry.target, entry.current);
      fs.rmSync(proposalFile, { force: true });
      restoreMaybe(ledgerFile, oldLedger);
      throw e;
    }
  }, undoRoot);
}
module.exports = { hash, frontmatter, parseChanges, read, safeTarget, plan, preview, apply, reject, recentUndos, undo };
