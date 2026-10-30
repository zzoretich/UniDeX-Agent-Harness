'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../persona/proposal.js');

const NAME = '2026-10-30-better-routing.md';
function world(change, recheck = 'grep old persona/PLAYBOOK.md', parent = null) {
  const root = parent ? path.join(parent, 'vault') : fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-guard-'));
  fs.mkdirSync(path.join(root, 'persona', 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(root, 'persona', 'PLAYBOOK.md'), 'old route\n');
  const proposal = path.join(root, 'persona', 'proposals', NAME);
  const undoRoot = path.join(root, '..', `proposal-undo-${path.basename(root)}`);
  const front = ['---', 'slug: better-routing', `recheck: ${recheck}`, 'changes: |',
    ...JSON.stringify([change], null, 2).split('\n').map((line) => `  ${line}`), '---', '', '## What', 'Replace the route.', ''].join('\n');
  fs.writeFileSync(proposal, front);
  return { root, proposal, target: path.join(root, 'persona', 'PLAYBOOK.md'), undoRoot };
}
function replace() { return { path: 'persona/PLAYBOOK.md', op: 'replace', base: P.hash(Buffer.from('old route\n')), content: 'new route\n' }; }

test('preview pins the exact proposal and target hashes; apply changes only the reviewed bytes', () => {
  const w = world(replace());
  const preview = P.preview(w.root, NAME);
  assert.equal(preview.changes[0].before, 'old route\n');
  assert.equal(preview.changes[0].content, 'new route\n');
  const result = P.apply(w.root, NAME, preview.digest, { runRecipe: () => 'gone', undoRoot: w.undoRoot });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(w.target, 'utf8'), 'new route\n');
  assert.ok(fs.existsSync(path.join(w.undoRoot, require('crypto').createHash('sha256').update(path.resolve(w.root)).digest('hex').slice(0, 24), result.undoId, 'manifest.json')));
  assert.equal(fs.existsSync(w.proposal), false);
  assert.equal(P.recentUndos(w.root, { undoRoot: w.undoRoot })[0].undoId, result.undoId);
  P.undo(w.root, result.undoId, { undoRoot: w.undoRoot });
  assert.equal(fs.readFileSync(w.target, 'utf8'), 'old route\n');
  assert.equal(fs.existsSync(w.proposal), true);
});

test('a stale target or changed proposal is refused without writing', () => {
  const w = world(replace());
  const preview = P.preview(w.root, NAME);
  fs.writeFileSync(w.target, 'someone edited this\n');
  assert.throws(() => P.apply(w.root, NAME, preview.digest), /stale base/);
  assert.equal(fs.readFileSync(w.target, 'utf8'), 'someone edited this\n');
  fs.writeFileSync(w.target, 'old route\n');
  fs.appendFileSync(w.proposal, 'extra note\n');
  assert.throws(() => P.apply(w.root, NAME, preview.digest), /changed since review/);
});

test('failed verification restores the prior file automatically', () => {
  const w = world(replace());
  const digest = P.preview(w.root, NAME).digest;
  assert.throws(() => P.apply(w.root, NAME, digest, { runRecipe: () => 'present', undoRoot: w.undoRoot }), /verification present/);
  assert.equal(fs.readFileSync(w.target, 'utf8'), 'old route\n');
  assert.ok(fs.existsSync(w.proposal));
});

test('legacy prose, symlinks, duplicate and non-instruction paths cannot apply', () => {
  const w = world(replace());
  fs.writeFileSync(w.proposal, '---\nslug: better-routing\nrecheck: true\n---\n## What\nchange this\n');
  assert.throws(() => P.preview(w.root, NAME), /legacy proposal needs an exact diff/);
  const bad = { path: 'persona/STATE.md', op: 'replace', base: P.hash(Buffer.from('x')), content: 'y' };
  assert.throws(() => P.parseChanges({ changes: JSON.stringify([bad]) }), /not an instruction file/);
  const directory = { path: 'persona/teams/new-team', op: 'create', base: null, content: 'wrong place' };
  assert.throws(() => P.parseChanges({ changes: JSON.stringify([directory]) }), /not an instruction file/);
  assert.throws(() => P.parseChanges({ changes: JSON.stringify([replace(), replace()]) }), /duplicate change path/);
  const x = world(replace());
  fs.rmSync(x.target);
  fs.symlinkSync('/tmp/elsewhere', x.target);
  assert.throws(() => P.preview(x.root, NAME), /symlink in target path/);
});

test('reject binds the reviewed proposal digest and leaves instruction files intact', () => {
  const w = world(replace());
  const digest = P.read(w.root, NAME).digest;
  const result = P.reject(w.root, NAME, digest, { undoRoot: w.undoRoot });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(w.proposal), false);
  assert.equal(fs.readFileSync(w.target, 'utf8'), 'old route\n');
});

test('undo refuses to overwrite a later user edit', () => {
  const w = world(replace());
  const digest = P.preview(w.root, NAME).digest;
  const applied = P.apply(w.root, NAME, digest, { runRecipe: () => 'gone', undoRoot: w.undoRoot });
  fs.writeFileSync(w.target, 'a later edit\n');
  assert.throws(() => P.undo(w.root, applied.undoId, { undoRoot: w.undoRoot }), /file changed since approval/);
  assert.equal(fs.readFileSync(w.target, 'utf8'), 'a later edit\n');
});

test('approval and undo commit only named vault paths, preserving unrelated staged work', () => {
  const { spawnSync } = require('child_process');
  const w = world(replace());
  const git = (...args) => {
    const r = spawnSync('git', ['-C', w.root, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  fs.writeFileSync(path.join(w.root, 'persona', 'ledger.jsonl'), '{"schema":1,"event":"filed","slug":"better-routing"}\n');
  fs.writeFileSync(path.join(w.root, 'unrelated.md'), 'first\n');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('commit', '-qm', 'first');
  fs.writeFileSync(path.join(w.root, 'unrelated.md'), 'staged but unrelated\n');
  git('add', 'unrelated.md');
  const digest = P.preview(w.root, NAME).digest;
  const result = P.apply(w.root, NAME, digest, { runRecipe: () => 'gone', undoRoot: w.undoRoot });
  assert.ok(result.commit);
  assert.deepEqual(git('show', '--pretty=format:', '--name-only', 'HEAD').split('\n').filter(Boolean).sort(),
    ['persona/PLAYBOOK.md', 'persona/ledger.jsonl', `persona/proposals/${NAME}`]);
  assert.match(git('status', '--short'), /^M  unrelated\.md$/m);
  P.undo(w.root, result.undoId, { undoRoot: w.undoRoot });
  assert.match(git('status', '--short'), /^M  unrelated\.md$/m);
});

test('a newly created instruction file is included in the approval commit', () => {
  const { spawnSync } = require('child_process');
  const w = world({ path: 'persona/duties/new.md', op: 'create', base: null, content: 'new duty\n' });
  const git = (...args) => {
    const r = spawnSync('git', ['-C', w.root, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  fs.writeFileSync(path.join(w.root, 'persona', 'ledger.jsonl'), '{"schema":1,"event":"filed","slug":"better-routing"}\n');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('commit', '-qm', 'first');
  const digest = P.preview(w.root, NAME).digest;
  const result = P.apply(w.root, NAME, digest, { runRecipe: () => 'gone', undoRoot: w.undoRoot });
  assert.ok(result.commit);
  assert.equal(git('show', 'HEAD:persona/duties/new.md'), 'new duty');
  P.undo(w.root, result.undoId, { undoRoot: w.undoRoot });
  assert.equal(fs.existsSync(path.join(w.root, 'persona', 'duties', 'new.md')), false);
  assert.equal(git('status', '--short'), '');
});

test('a vault nested inside another repository never stages that parent repository', () => {
  const { spawnSync } = require('child_process');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-parent-repo-'));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', parent, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  git('init', '-q');
  const w = world(replace(), 'grep old persona/PLAYBOOK.md', parent);
  const digest = P.preview(w.root, NAME).digest;
  const result = P.apply(w.root, NAME, digest, { runRecipe: () => 'gone', undoRoot: w.undoRoot });
  assert.equal(result.commit, null);
  assert.equal(git('diff', '--cached', '--name-only'), '');
});

test('a host-owned skill change is reviewed, applied and undone at its configured root', () => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-skill-owner-'));
  const skills = path.join(owner, 'skills');
  const skill = path.join(skills, 'my-skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'old skill\n');
  const rel = 'host/claude-skills/my-skill/SKILL.md';
  const w = world({ path: rel, op: 'replace', base: P.hash(Buffer.from('old skill\n')), content: 'new skill\n' });
  const hostRoots = [{ id: 'claude-skills', dir: skills, kind: 'skills' }];
  const preview = P.preview(w.root, NAME, { hostRoots });
  assert.equal(preview.changes[0].before, 'old skill\n');
  const result = P.apply(w.root, NAME, preview.digest, { hostRoots, undoRoot: w.undoRoot, runRecipe: () => 'gone' });
  assert.equal(fs.readFileSync(skill, 'utf8'), 'new skill\n');
  P.undo(w.root, result.undoId, { hostRoots, undoRoot: w.undoRoot });
  assert.equal(fs.readFileSync(skill, 'utf8'), 'old skill\n');
  fs.writeFileSync(path.join(path.dirname(skill), '.aos-mirror.json'), '{}');
  assert.throws(() => P.preview(w.root, NAME, { hostRoots }), /source skill/);
});
