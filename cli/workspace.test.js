'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const W = require('./workspace.js');

const ROOT = path.resolve(__dirname, '..');

// A scan reads host folders through the runtime: point them at empty temp folders, never the developer's own.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-cli-cfg-'));
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-cli-codex-'));

/**
 * A temp HOME holding the vault and both hosts' folders. Every sandbox lives under the OS temp folder, which the
 * outside list drops (spaces-redesign D21), so in-process runs pass `tmpDirs: []` to keep their outside rows.
 */
function sandbox(extraCfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-cli-'));
  const home = path.join(dir, 'home');
  const cfg = path.join(home, '.claude');
  const codex = path.join(home, '.codex');
  const vault = path.join(home, 'Vault');
  for (const d of [cfg, path.join(codex, 'sessions'), path.join(vault, 'brain', '_index'), path.join(vault, 'workspaces')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agenticos.json'), JSON.stringify({ vault, hosts: { codex: { enabled: true, home: codex } }, ...extraCfg }));
  const lines = [];
  const io = { log: (m) => lines.push(String(m)), warn: (m) => lines.push('warning: ' + m) };
  // vault: an in-process scan points AOS_VAULT at its own vault (provider.js and paths.js read it), and AOS_VAULT
  // outranks agenticos.json, so each sandbox names its vault.
  return { dir, home, cfg, codex, vault, io, lines, opts: { configDir: cfg, home, io, tmpDirs: [], vault } };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const read = (file) => fs.readFileSync(file, 'utf8');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ws = (sb, ...rel) => path.join(sb.vault, 'workspaces', ...rel);
const idx = (sb, ...rel) => path.join(sb.vault, 'brain', '_index', ...rel);

/** One verb with --json: its exit code is 0 and its one output is the JSON it prints. */
async function json(sb, args, extra = {}) {
  const start = sb.lines.length;
  assert.equal(await W.main([...args, '--json'], { ...sb.opts, ...extra }), 0);
  return JSON.parse(sb.lines.slice(start).join('\n'));
}

/** A snapshot whose outside list holds `cwds` (the rows adopt and hide must name). */
function seedSnapshot(sb, cwds = []) {
  const lastAt = new Date().toISOString();
  write(idx(sb, 'snapshot.json'), JSON.stringify({
    scannedAt: lastAt, workspaces: [],
    hostSessions: { byCwd: {}, outsideWorkspaces: cwds.map((cwd) => ({ cwd, claude: 1, codex: 0, total: 1, lastAt, exists: fs.existsSync(cwd), match: null, git: null, worktrees: 0 })) },
  }));
}

/** A Sessions thread: its meta line, then `records` (spaces-redesign D17; app/src/main/services/sessions.ts). */
function thread(sb, workspace, id, records = [], title = `Thread ${id}`) {
  const meta = { schema: 1, kind: 'meta', thread: id, workspace, host: 'claude', model: null, effort: null, title, created: '2026-10-01T10:00:00.000Z' };
  const file = idx(sb, 'sessions', workspace, `${id}.jsonl`);
  write(file, [meta, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const fakeBrain = (calls) => (script, args) => { calls.push([script, ...args]); return { ok: true }; };

test('slugify follows the kebab-case convention', () => {
  assert.equal(W.slugify('My Project'), 'my-project');
  assert.equal(W.slugify('  BZ Wedding  '), 'bz-wedding');
  assert.equal(W.slugify('1 - Ruflo'), '1-ruflo');
  assert.equal(W.slugify('---'), '');
});

test('new creates the workspace with README, CLAUDE.md and an identical AGENTS.md; reserved and duplicate names are refused', async () => {
  const sb = sandbox();
  assert.equal(await W.main(['new', 'My Project'], sb.opts), 0);
  const dir = path.join(sb.vault, 'workspaces', 'my-project');
  for (const f of ['README.md', 'CLAUDE.md', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'));
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /^# My Project — project instructions/);
  assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /^# My Project\n/);
  assert.match(sb.lines.join('\n'), /created .*my-project/);
  await assert.rejects(() => W.main(['new', 'my project'], sb.opts), /already exists/);
  await assert.rejects(() => W.main(['new', '_archive'], sb.opts), (e) => e instanceof W.UsageError && /reserved/.test(e.message));
  await assert.rejects(() => W.main(['new', '!!!'], sb.opts), (e) => e instanceof W.UsageError);
  await assert.rejects(() => W.main(['frob'], sb.opts), (e) => e instanceof W.UsageError && /unknown verb/.test(e.message));
  await assert.rejects(() => W.main(['list', '--bogus'], sb.opts), (e) => e instanceof W.UsageError && /unknown flag/.test(e.message));
});

test('adopt moves a folder in, mirrors the one instruction file it had, adds the README, and keeps a nested git repo', async () => {
  const sb = sandbox();
  const src = path.join(sb.dir, 'Documents', 'ChatGPT', 'BZ Wedding');
  fs.mkdirSync(path.join(src, '.git'), { recursive: true });
  fs.mkdirSync(path.join(src, 'app'), { recursive: true });
  fs.writeFileSync(path.join(src, 'AGENTS.md'), '# Wedding\n\nUse the wedding skill.\n');
  fs.writeFileSync(path.join(src, 'app', 'index.html'), '<html/>');
  assert.equal(await W.main(['adopt', src], sb.opts), 0);
  const dst = path.join(sb.vault, 'workspaces', 'bz-wedding');
  assert.ok(!fs.existsSync(src));
  assert.ok(fs.existsSync(path.join(dst, 'app', 'index.html')));
  assert.ok(fs.existsSync(path.join(dst, '.git')));
  assert.equal(fs.readFileSync(path.join(dst, 'CLAUDE.md'), 'utf8'), '# Wedding\n\nUse the wedding skill.\n', 'CLAUDE.md mirrors the existing AGENTS.md');
  assert.match(fs.readFileSync(path.join(dst, 'README.md'), 'utf8'), /^# Bz Wedding\n/);
  const out = sb.lines.join('\n');
  assert.match(out, /CLAUDE\.md \(mirrored from AGENTS\.md\)/);
  assert.match(out, /git repository of its own/);
  assert.match(out, /Codex asks once to trust the new path/);
  // --name and the cross-device fallback (rename throws EXDEV → copy + remove)
  const src2 = path.join(sb.dir, 'x20-c');
  fs.mkdirSync(src2); fs.writeFileSync(path.join(src2, 'notes.txt'), 'n');
  const calls = [];
  const exdev = () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  assert.equal(await W.main(['adopt', src2, '--name', 'Voice Chat'], { ...sb.opts, rename: exdev, copy: (a, b, o) => { calls.push(['copy', a, b, o.recursive]); fs.cpSync(a, b, { recursive: true }); }, remove: (a) => { calls.push(['remove', a]); fs.rmSync(a, { recursive: true, force: true }); } }), 0);
  assert.ok(fs.existsSync(path.join(sb.vault, 'workspaces', 'voice-chat', 'notes.txt')));
  assert.ok(!fs.existsSync(src2));
  assert.deepEqual(calls.map((c) => c[0]), ['copy', 'remove']);
  for (const f of ['README.md', 'CLAUDE.md', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(sb.vault, 'workspaces', 'voice-chat', f)), f);
});

test('adopt refuses the vault, its insides, the config dirs, the home dir, a file, and an existing target', async () => {
  const sb = sandbox();
  const plain = path.join(sb.dir, 'plain'); fs.mkdirSync(plain);
  fs.mkdirSync(path.join(sb.vault, 'workspaces', 'plain'));
  await assert.rejects(() => W.main(['adopt', sb.vault], sb.opts), /inside the vault/);
  await assert.rejects(() => W.main(['adopt', path.join(sb.vault, 'brain')], sb.opts), /inside the vault/);
  await assert.rejects(() => W.main(['adopt', path.join(sb.vault, 'workspaces', 'plain')], sb.opts), /already under/);
  await assert.rejects(() => W.main(['adopt', sb.cfg], sb.opts), /Claude config dir/);
  await assert.rejects(() => W.main(['adopt', path.join(sb.codex, 'sessions')], sb.opts), /Codex home/);
  await assert.rejects(() => W.main(['adopt', sb.home], sb.opts), /home directory|contains/);
  await assert.rejects(() => W.main(['adopt', path.join(sb.dir, 'nope')], sb.opts), /not a directory/);
  await assert.rejects(() => W.main(['adopt', plain], sb.opts), /already exists/);
  await assert.rejects(() => W.main(['adopt'], sb.opts), (e) => e instanceof W.UsageError);
  assert.ok(fs.existsSync(plain), 'a refused source is untouched');
});

test('list reads the snapshot when it carries hostSessions, prints per-host counts and the outside list, and has a --json form', async () => {
  const sb = sandbox();
  const day = new Date(); day.setDate(day.getDate() - 2);
  fs.writeFileSync(path.join(sb.vault, 'brain', '_index', 'snapshot.json'), JSON.stringify({
    scannedAt: '2026-09-21T20:00:00.000Z',
    workspaces: [
      { name: 'alpha', status: 'active', sessions: { claude: 12, codex: 3, total: 15, lastAt: day.toISOString() },
        next: { text: 'Merge PR 2', source: 'derived', from: 'HANDOFF-alpha.md › Next' }, git: { kind: 'vault' }, commits: [], hidden: false },
      { name: 'beta', status: 'idle' },
      { name: '_archive/old', label: 'old', status: 'idle', hidden: true, hiddenReason: 'archived' },
    ],
    hostSessions: { byCwd: {}, outsideWorkspaces: [{ cwd: path.join(sb.home, 'Documents', 'Codex', 'x'), claude: 0, codex: 2, total: 2, lastAt: day.toISOString() }] },
  }));
  assert.equal(await W.main(['list'], sb.opts), 0);
  const out = sb.lines.join('\n');
  assert.match(out, /^alpha\s+active\s+claude\s+12\s+codex\s+3\s+2d ago$/m);
  assert.match(out, /^beta\s+idle\s+claude\s+0\s+codex\s+0\s+never$/m);
  assert.match(out, /outside workspaces\/ \(1\):/);
  assert.match(out, /~\/Documents\/Codex\/x\s+claude\s+0\s+codex\s+2\s+2d ago\s+aos workspace adopt ~\/Documents\/Codex\/x/);
  assert.match(out, /from the snapshot of 2026-09-21T20:00:00.000Z/);
  assert.doesNotMatch(out, /_archive\/old/, 'a hidden entry is left out of the table');
  assert.match(out, /\(1 hidden: _ folders and _archive\/; --json lists them\)/);
  sb.lines.length = 0;
  assert.equal(await W.main(['list', '--json'], sb.opts), 0);
  const j = JSON.parse(sb.lines.join('\n'));
  assert.equal(j.source, 'snapshot');
  assert.equal(j.workspaces[0].sessions.total, 15);
  assert.deepEqual(j.workspaces[1].sessions, { claude: 0, codex: 0, total: 0, lastAt: null });
  assert.equal(j.outsideWorkspaces.length, 1);
  // spaces-redesign D22, D23: each entry passes through whole, hidden ones included.
  assert.deepEqual(j.workspaces[0].next, { text: 'Merge PR 2', source: 'derived', from: 'HANDOFF-alpha.md › Next' });
  assert.deepEqual(j.workspaces[0].git, { kind: 'vault' });
  assert.deepEqual(j.workspaces.map((w) => [w.name, w.hidden]), [['alpha', false], ['beta', undefined], ['_archive/old', true]]);
  assert.equal(j.workspaces[2].hiddenReason, 'archived');
});

test('list without a snapshot scans the vault directly, finalizes the entries, and --json passes them through whole', async () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.vault, 'workspaces', 'gamma'));
  fs.writeFileSync(path.join(sb.vault, 'workspaces', 'gamma', 'AGENTS.md'), '# Gamma\n\nA Codex-shaped project.\n\n## Next\n\n- Write the plan\n');
  fs.mkdirSync(path.join(sb.vault, 'workspaces', 'held'));
  fs.writeFileSync(path.join(sb.vault, 'workspaces', 'held', 'workspace.md'), '---\nstatus: parked\npinned: true\n---\n');
  fs.mkdirSync(path.join(sb.vault, 'workspaces', '_spikes'));
  fs.mkdirSync(path.join(sb.vault, 'workspaces', '_worktrees', 'team', 'item', 'member'), { recursive: true });
  const r = await W.main(['list', '--json'], { ...sb.opts, vault: sb.vault });
  assert.equal(r, 0);
  const j = JSON.parse(sb.lines.join('\n'));
  assert.equal(j.source, 'scan');
  assert.deepEqual(j.workspaces.map((w) => w.name), ['held', 'gamma', '_spikes'], 'pinned first, hidden last, no _worktrees entry');
  const [held, gamma, spikes] = j.workspaces;
  // spaces-redesign D11: finalize ran after the sessions were attached.
  assert.deepEqual([held.status, held.statusOverride, held.statusAuto, held.pinned], ['paused', 'paused', 'idle', true]);
  assert.deepEqual([gamma.status, gamma.statusAuto, gamma.statusOverride], ['idle', 'idle', null]);
  assert.deepEqual(gamma.activity, { at: null, ageDays: null, from: null }, 'files just written are not activity');
  assert.deepEqual(gamma.next, { text: 'Write the plan', source: 'derived', from: 'AGENTS.md › Next' });
  assert.equal(typeof gamma.inputHash, 'string');
  assert.equal(gamma.git, null);
  assert.deepEqual(gamma.commits, []);
  assert.deepEqual([spikes.hidden, spikes.hiddenReason], [true, 'underscore']);
  sb.lines.length = 0;
  assert.equal(await W.main(['list'], { ...sb.opts, vault: sb.vault }), 0);
  const out = sb.lines.join('\n');
  assert.match(out, /^held\s+paused\s+claude\s+0\s+codex\s+0\s+never$/m);
  assert.match(out, /^gamma\s+idle\s+/m);
  assert.doesNotMatch(out, /_spikes/);
  assert.match(out, /\(1 hidden: /);
  assert.match(out, /\(fresh scan\)/);
});

test('list without a snapshot counts both hosts through the folders agenticos.json names, and keeps the session index in the vault', async () => {
  const sb = sandbox();
  // Both hosts on, as `aos init --host both` writes them; the Claude folder is the config dir this command read.
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault: sb.vault, hosts: { claude: { enabled: true }, codex: { enabled: true, home: sb.codex } } }));
  const ws = path.join(sb.vault, 'workspaces', 'tide');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'README.md'), '# Tide\n\nTide tables for the harbour.\n');
  const ts = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const jsonl = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
  const cid = '0199bbbb-0000-4000-8000-000000000001';
  const xid = '0199bbbb-0000-4000-8000-000000000002';
  jsonl(path.join(sb.cfg, 'projects', 'tide-slug', `${cid}.jsonl`), [
    { type: 'user', sessionId: cid, cwd: path.join(ws, 'src'), timestamp: ts, entrypoint: 'cli', message: { role: 'user', content: 'Parse the tide table' } },
  ]);
  jsonl(path.join(sb.codex, 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${xid}.jsonl`), [
    { timestamp: ts, type: 'session_meta', payload: { id: xid, timestamp: ts, cwd: ws, originator: 'codex_cli_rs', source: 'cli' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the tide parser' }] } },
  ]);
  assert.equal(await W.main(['list', '--json'], { ...sb.opts, vault: sb.vault }), 0);
  const j = JSON.parse(sb.lines.join('\n'));
  const tide = j.workspaces.find((w) => w.name === 'tide');
  assert.deepEqual([tide.sessions.claude, tide.sessions.codex, tide.sessions.total], [1, 1, 2]);
  assert.deepEqual(tide.sessions.recent.map((r) => [r.host, r.via, r.resumable]).sort(), [['claude', 'cwd', true], ['codex', 'cwd', true]]);
  // spaces-redesign D11: finalize read the attached sessions.
  assert.deepEqual([tide.status, tide.activity.from], ['active', 'session']);
  assert.deepEqual(j.outsideWorkspaces, []);
  assert.ok(fs.existsSync(path.join(sb.vault, 'brain', '_index', 'session-index.json')), 'the incremental cache sits in the vault');
});

test('a run from the vault root finds the configured vault; with none configured it is refused from anywhere', async () => {
  const sb = sandbox();
  // The real path, so the cwd after chdir (macOS reports /private/var for /var) equals the configured vault exactly.
  const vault = fs.realpathSync(sb.vault);
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault, hosts: { codex: { enabled: true, home: sb.codex } } }));
  // A scan in an earlier test sets AOS_VAULT for the collectors; this test reads agenticos.json alone.
  const cwd = process.cwd();
  const envVault = process.env.AOS_VAULT;
  delete process.env.AOS_VAULT;
  try {
    process.chdir(vault);
    assert.equal(W.resolveCtx({ configDir: sb.cfg, home: sb.home }).vault, vault);
    assert.equal(await W.main(['new', 'kelp-watch'], sb.opts), 0);
    assert.ok(fs.existsSync(path.join(vault, 'workspaces', 'kelp-watch', 'README.md')));
    fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ hosts: {} }));
    assert.throws(() => W.resolveCtx({ configDir: sb.cfg, home: sb.home }), /no vault configured/);
    process.chdir(sb.dir);
    assert.throws(() => W.resolveCtx({ configDir: sb.cfg, home: sb.home }), /no vault configured/);
    assert.throws(() => W.resolveCtx({ configDir: sb.cfg, home: sb.home, vault: '  ' }), /no vault configured/);
  } finally {
    process.chdir(cwd);
    if (envVault === undefined) delete process.env.AOS_VAULT; else process.env.AOS_VAULT = envVault;
  }
});

test('ago renders today, 1d ago, Nd ago and never', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  assert.equal(W.ago(null, now), 'never');
  assert.equal(W.ago('2026-09-21T09:00:00.000Z', now), 'today');
  assert.equal(W.ago('2026-09-20T09:00:00.000Z', now), '1d ago');
  assert.equal(W.ago('2026-09-10T09:00:00.000Z', now), '11d ago');
});

// ── spaces-redesign PR 3: the verbs ──

test('which resolves a folder through the roots, aliases and worktree walk the counts use (D20), and null elsewhere', async () => {
  const sb = sandbox();
  fs.mkdirSync(ws(sb, 'alpha', 'src', 'deep'), { recursive: true });
  // An adopted folder: beta's alias.
  write(ws(sb, 'beta', 'workspace.md'), '---\naliases:\n  - ~/code/beta-src\n---\n');
  fs.mkdirSync(path.join(sb.home, 'code', 'beta-src', 'sub'), { recursive: true });
  // A linked worktree of the repository in workspaces/gamma, checked out outside the vault.
  fs.mkdirSync(ws(sb, 'gamma', '.git', 'worktrees', 'feat'), { recursive: true });
  const wt = path.join(sb.home, 'code', 'gamma.worktrees', 'feat');
  write(path.join(wt, '.git'), `gitdir: ${ws(sb, 'gamma', '.git', 'worktrees', 'feat')}\n`);
  // A linked code folder (repo:) and a folder whose name is no slug.
  fs.mkdirSync(path.join(sb.home, 'code', 'delta-repo'), { recursive: true });
  write(ws(sb, 'delta', 'workspace.md'), '---\nrepo: ~/code/delta-repo\n---\n');
  fs.mkdirSync(ws(sb, 'Field Notes'), { recursive: true });
  fs.mkdirSync(ws(sb, '_archive', 'old', 'x'), { recursive: true });
  fs.mkdirSync(ws(sb, '_spikes'), { recursive: true });

  const which = (cwd) => json(sb, ['which', '--cwd', cwd]);
  assert.deepEqual(await which(ws(sb, 'alpha', 'src', 'deep')), { name: 'alpha', slug: 'alpha', via: 'cwd' });
  assert.deepEqual(await which('~/code/beta-src/sub'), { name: 'beta', slug: 'beta', via: 'cwd' }, 'an alias cwd');
  assert.deepEqual(await which(wt), { name: 'gamma', slug: 'gamma', via: 'worktree' }, 'a worktree cwd');
  assert.deepEqual(await which(path.join(sb.home, 'code', 'delta-repo')), { name: 'delta', slug: 'delta', via: 'cwd' });
  assert.deepEqual(await which(ws(sb, 'Field Notes')), { name: 'Field Notes', slug: 'field-notes', via: 'cwd' });
  const none = { name: null, slug: null, via: null };
  assert.deepEqual(await which(sb.vault), none, 'the vault root is no workspace');
  assert.deepEqual(await which(path.join(sb.home, 'elsewhere')), none);
  assert.deepEqual(await which(ws(sb, '_archive', 'old', 'x')), none, 'an archived workspace is no workspace');
  assert.deepEqual(await which(ws(sb, '_spikes')), none, 'nor is a hidden _ folder');
  // Without --cwd: the process's own folder.
  const cwd = process.cwd();
  try {
    process.chdir(ws(sb, 'alpha', 'src'));
    assert.deepEqual(await json(sb, ['which']), { name: 'alpha', slug: 'alpha', via: 'cwd' });
  } finally { process.chdir(cwd); }
  sb.lines.length = 0;
  assert.equal(await W.main(['which', '--cwd', wt], sb.opts), 0);
  assert.match(sb.lines.join('\n'), /^gamma {2}\(#ws\/gamma, by worktree\)$/);
  assert.ok(!fs.existsSync(idx(sb, 'snapshot.json')) && !fs.existsSync(idx(sb, 'session-index.json')), 'which writes nothing');
});

test('new --git --pin --json makes the stubs, runs git init and pins; --empty makes a bare folder; names are checked', async () => {
  const sb = sandbox();
  const calls = [];
  const fakeSpawn = (cmd, args, o) => { calls.push([cmd, args, o.cwd, o.env.GIT_TERMINAL_PROMPT]); return { status: 0, stdout: '', stderr: '' }; };
  const j = await json(sb, ['new', 'Kite Lab', '--git', '--pin'], { spawnSync: fakeSpawn });
  assert.deepEqual({ ...j, dir: null }, {
    ok: true, name: 'kite-lab', slug: 'kite-lab', path: 'workspaces/kite-lab', dir: null,
    written: ['README.md', 'CLAUDE.md', 'AGENTS.md', 'workspace.md'], git: true, pinned: true, empty: false, rescanned: false,
  });
  assert.equal(fs.realpathSync(j.dir), fs.realpathSync(ws(sb, 'kite-lab')));
  // The folder by its real path: workspaces/ was checked as a plain folder of the vault and resolved (spaces-redesign §6).
  assert.deepEqual(calls.map(([c, a, cwd, p]) => [c, a, fs.realpathSync(cwd), p]), [['git', ['init', '--quiet'], fs.realpathSync(ws(sb, 'kite-lab')), '0']]);
  assert.equal(read(ws(sb, 'kite-lab', 'workspace.md')), '---\npinned: true\n---\n');
  assert.equal(read(ws(sb, 'kite-lab', 'CLAUDE.md')), W.stubs('kite-lab')['CLAUDE.md']);
  // A failed git init still makes the workspace and says why.
  const failing = () => ({ status: 128, stdout: '', stderr: 'hint: x\nfatal: boom\n' });
  const f = await json(sb, ['new', 'sail-lab', '--git'], { spawnSync: failing });
  assert.deepEqual([f.git, f.gitError, f.pinned], [false, 'fatal: boom', false]);
  assert.ok(!fs.existsSync(ws(sb, 'sail-lab', 'workspace.md')));
  // --empty: nothing inside, for `git clone … .`.
  const e = await json(sb, ['new', 'clone-me', '--empty']);
  assert.deepEqual([e.written, e.empty, e.git, e.pinned], [[], true, false, false]);
  assert.deepEqual(fs.readdirSync(ws(sb, 'clone-me')), []);
  await assert.rejects(() => W.main(['new', 'x', '--empty', '--pin'], sb.opts), (err) => err instanceof W.UsageError && /--empty/.test(err.message));
  await assert.rejects(() => W.main(['new', 'x', '--empty', '--git'], sb.opts), (err) => err instanceof W.UsageError);
  // Names: taken, reserved, Scratch, held by an archived workspace.
  await assert.rejects(() => W.main(['new', 'kite lab'], sb.opts), /workspaces\/kite-lab already exists/);
  await assert.rejects(() => W.main(['new', 'scratch'], sb.opts), (err) => err instanceof W.UsageError && /scratch/.test(err.message));
  await assert.rejects(() => W.main(['new', 'Research'], sb.opts), (err) => err instanceof W.UsageError && /reserved/.test(err.message));
  await assert.rejects(() => W.main(['new', 'archive'], sb.opts), /reserved/);
  fs.mkdirSync(ws(sb, '_archive', 'held'), { recursive: true });
  await assert.rejects(() => W.main(['new', 'held'], sb.opts), /held by an archived workspace/);
  assert.ok(!fs.existsSync(ws(sb, 'held')));
  // A dangling link where the folder would go counts as taken.
  fs.symlinkSync(path.join(sb.home, 'nowhere'), ws(sb, 'ghost'));
  await assert.rejects(() => W.main(['new', 'ghost'], sb.opts), /already exists/);
  assert.ok(!fs.existsSync(path.join(sb.home, 'nowhere')));
});

test('stubs never overwrite, never write through a dangling or outward link, and never mirror a link', async () => {
  const sb = sandbox();
  const secret = path.join(sb.home, 'secret');
  write(path.join(secret, 'notes.md'), 'private\n');
  // CLAUDE.md is an outward link, AGENTS.md is missing, README.md a dangling link.
  fs.mkdirSync(ws(sb, 'links'), { recursive: true });
  fs.symlinkSync(path.join(secret, 'notes.md'), ws(sb, 'links', 'CLAUDE.md'));
  fs.symlinkSync(path.join(secret, 'missing.md'), ws(sb, 'links', 'README.md'));
  const j = await json(sb, ['stubs', 'links']);
  assert.deepEqual(j.written, ['AGENTS.md'], 'only the missing file, as the stub');
  assert.equal(read(ws(sb, 'links', 'AGENTS.md')), W.stubs('links')['AGENTS.md'], 'the link was not mirrored');
  assert.equal(read(path.join(secret, 'notes.md')), 'private\n');
  assert.ok(!fs.existsSync(path.join(secret, 'missing.md')), 'nothing was written through the dangling link');
  assert.ok(fs.lstatSync(ws(sb, 'links', 'README.md')).isSymbolicLink());
  // AGENTS.md as an outward link, CLAUDE.md missing: the same the other way round.
  fs.mkdirSync(ws(sb, 'links2'), { recursive: true });
  fs.symlinkSync(path.join(secret, 'notes.md'), ws(sb, 'links2', 'AGENTS.md'));
  assert.deepEqual((await json(sb, ['stubs', 'links2'])).written, ['README.md', 'CLAUDE.md']);
  assert.equal(read(ws(sb, 'links2', 'CLAUDE.md')), W.stubs('links2')['CLAUDE.md']);
  // A regular lone instruction file is mirrored; existing files stay as they are.
  write(ws(sb, 'mirror', 'AGENTS.md'), '# Mine\n');
  write(ws(sb, 'mirror', 'README.md'), '# Kept\n');
  assert.deepEqual((await json(sb, ['stubs', 'mirror', '--pin'])).written, ['CLAUDE.md (mirrored from AGENTS.md)', 'workspace.md (pinned)']);
  assert.equal(read(ws(sb, 'mirror', 'CLAUDE.md')), '# Mine\n');
  assert.equal(read(ws(sb, 'mirror', 'README.md')), '# Kept\n');
  assert.equal(read(ws(sb, 'mirror', 'workspace.md')), '---\npinned: true\n---\n');
  assert.deepEqual((await json(sb, ['stubs', 'mirror', '--pin'])).written, [], 'a second run writes nothing');
  // A symlinked workspace.md (outward or dangling) is never read or written through.
  write(path.join(secret, 'ws.md'), '---\nstatus: done\n---\n');
  fs.mkdirSync(ws(sb, 'wslink'), { recursive: true });
  fs.symlinkSync(path.join(secret, 'ws.md'), ws(sb, 'wslink', 'workspace.md'));
  await assert.rejects(() => W.main(['stubs', 'wslink', '--pin'], sb.opts), /symlink/);
  assert.equal(read(path.join(secret, 'ws.md')), '---\nstatus: done\n---\n');
  fs.mkdirSync(ws(sb, 'wsdangling'), { recursive: true });
  fs.symlinkSync(path.join(secret, 'gone.md'), ws(sb, 'wsdangling', 'workspace.md'));
  await assert.rejects(() => W.main(['stubs', 'wsdangling', '--pin'], sb.opts), /symlink/);
  assert.ok(!fs.existsSync(path.join(secret, 'gone.md')));
  await assert.rejects(() => W.main(['stubs', 'nope'], sb.opts), /no such workspace/);
  await assert.rejects(() => W.main(['stubs', '../secret'], sb.opts), /not a workspace name/);
});

test('adopt --into records the folder as an alias and never renames, copies or removes anything', async () => {
  const sb = sandbox();
  fs.mkdirSync(ws(sb, 'alpha'), { recursive: true });
  const proj = path.join(sb.home, 'code', 'proj');
  write(path.join(proj, 'AGENTS.md'), '# Proj\n');
  seedSnapshot(sb, [proj]);
  const boom = () => { throw new Error('nothing may move'); };
  const fakes = { rename: boom, copy: boom, remove: boom };
  const j = await json(sb, ['adopt', '~/code/proj', '--into', 'alpha'], fakes);
  assert.deepEqual({ ...j, folder: null }, { ok: true, name: 'alpha', path: 'workspaces/alpha', folder: null, alias: '~/code/proj', changed: true, file: 'workspaces/alpha/workspace.md', rescanned: true });
  assert.equal(read(ws(sb, 'alpha', 'workspace.md')), '---\naliases:\n  - ~/code/proj\n---\n');
  assert.deepEqual(fs.readdirSync(proj), ['AGENTS.md'], 'the folder is untouched, no stubs added');
  // The rescan attributes the folder's sessions to alpha now, so it leaves the outside list.
  const snap = JSON.parse(read(idx(sb, 'snapshot.json')));
  assert.deepEqual(snap.hostSessions.outsideWorkspaces, []);
  assert.deepEqual(snap.workspaces.find((w) => w.name === 'alpha').aliases.map((a) => fs.realpathSync(a)), [fs.realpathSync(proj)]);
  // Again: already an alias, nothing written. The absolute spelling names the same folder.
  assert.equal((await json(sb, ['adopt', proj, '--into', 'alpha'], fakes)).changed, false);
});

test('adopt --into, hide and unhide check the path: absolute or ~/, outside the vault, not / or home, no host config folder, an outside row', async () => {
  const sb = sandbox();
  // A custom Claude Code config folder (agenticos.json claudeConfigDir), as `aos init` records CLAUDE_CONFIG_DIR.
  const claudeDir = path.join(sb.home, 'custom-claude');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const cfgFile = path.join(sb.cfg, 'agenticos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(read(cfgFile)), claudeConfigDir: claudeDir }));
  fs.mkdirSync(ws(sb, 'alpha'), { recursive: true });
  const other = path.join(sb.home, 'code', 'other');
  fs.mkdirSync(other, { recursive: true });
  seedSnapshot(sb, [path.join(claudeDir, 'projects'), path.join(sb.codex, 'sessions'), other]);
  for (const verb of [['adopt', '--into', 'alpha'], ['hide'], ['unhide']]) {
    const run = (p) => W.main([verb[0], p, ...verb.slice(1)], sb.opts);
    await assert.rejects(() => run('code/other'), /give the folder as ~\/… or a full path/);
    await assert.rejects(() => run('~'), /give the folder/);
    await assert.rejects(() => run('/'), /filesystem root/);
    await assert.rejects(() => run(sb.home), /home folder/);
    await assert.rejects(() => run(`${sb.home}/code/..`), /home folder/, 'normalized first');
    await assert.rejects(() => run(ws(sb, 'alpha')), /inside the vault/);
    await assert.rejects(() => run(path.dirname(sb.vault) + '/Vault/brain'), /inside the vault/);
    await assert.rejects(() => run(path.join(claudeDir, 'projects')), /Claude config dir/, 'the custom claudeConfigDir');
    await assert.rejects(() => run('~/custom-claude'), /Claude config dir/);
    await assert.rejects(() => run(path.join(sb.codex, 'sessions')), /Codex home/);
  }
  // A line break or NUL in the path, refused by the runtime itself (not only by the surface's PATH rule).
  for (const verb of [['adopt', '--into', 'alpha'], ['hide'], ['unhide']]) {
    const run = (p) => W.main([verb[0], p, ...verb.slice(1)], sb.opts);
    await assert.rejects(() => run('/x\ny'), /line break or NUL/);
    await assert.rejects(() => run(path.join(sb.home, 'code', 'a\0b')), /line break or NUL/);
    await assert.rejects(() => run(`${other}\u2028`), /line break or NUL/);
  }
  // A folder no session ran in is not an outside row; unhide needs a stored entry.
  const stranger = path.join(sb.home, 'code', 'stranger');
  fs.mkdirSync(stranger, { recursive: true });
  await assert.rejects(() => W.main(['adopt', stranger, '--into', 'alpha'], sb.opts), /not a folder sessions ran in/);
  await assert.rejects(() => W.main(['hide', stranger], sb.opts), /not a folder sessions ran in/);
  await assert.rejects(() => W.main(['unhide', other], sb.opts), /is not hidden/);
  // --into names an existing workspace, never a path; --name belongs to the move form.
  await assert.rejects(() => W.main(['adopt', other, '--into', 'nope'], sb.opts), /no such workspace/);
  await assert.rejects(() => W.main(['adopt', other, '--into', '../alpha'], sb.opts), /not a workspace name/);
  await assert.rejects(() => W.main(['adopt', other, '--into', 'alpha', '--name', 'x'], sb.opts), (e) => e instanceof W.UsageError);
  assert.ok(!fs.existsSync(ws(sb, 'alpha', 'workspace.md')));
  assert.ok(!fs.existsSync(idx(sb, 'workspaces-hidden.json')));
});

test('adopt (both forms), hide and unhide refuse a folder that contains the vault', async () => {
  const sb = sandbox();
  // The vault one level deeper (home/a/Vault), so a folder between home and the vault exists to be refused.
  const vault = path.join(sb.home, 'a', 'Vault');
  for (const d of [path.join(vault, 'brain', '_index'), path.join(vault, 'workspaces', 'alpha')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault, hosts: { codex: { enabled: true, home: sb.codex } } }));
  const opts = { ...sb.opts, vault };
  seedSnapshot({ ...sb, vault }, [path.join(sb.home, 'a')]);
  await assert.rejects(() => W.main(['adopt', '~/a', '--into', 'alpha'], opts), /contains the vault/);
  await assert.rejects(() => W.main(['hide', '~/a'], opts), /contains the vault/);
  await assert.rejects(() => W.main(['unhide', '~/a'], opts), /contains the vault/);
  // The move form (terminals only) checks the same.
  await assert.rejects(() => W.main(['adopt', path.join(sb.home, 'a')], opts), /contains the vault/);
  assert.ok(fs.existsSync(path.join(vault, 'workspaces', 'alpha')) && !fs.existsSync(path.join(vault, 'workspaces', 'alpha', 'workspace.md')));
  assert.ok(!fs.existsSync(path.join(vault, 'brain', '_index', 'workspaces-hidden.json')));
});

test('remove-sessions D11: rename leaves brain/_index/sessions alone: a thread folder left from Sessions neither moves nor blocks', async () => {
  const sb = sandbox();
  fs.mkdirSync(ws(sb, 'alpha'), { recursive: true });
  const t1 = thread(sb, 'alpha', 't1', [{ t: '2026-10-01T10:00:00.000Z', kind: 'prompt', text: 'x', turn: 1 }]);
  const before = read(t1);
  write(idx(sb, 'sessions', 'gamma'), 'a file\n');
  const r = await json(sb, ['rename', 'alpha', 'gamma']);
  assert.equal(r.threads, undefined, 'no thread count in the answer');
  assert.ok(fs.existsSync(ws(sb, 'gamma')) && !fs.existsSync(ws(sb, 'alpha')), 'the folder moved');
  assert.equal(read(t1), before, 'the old thread file is where it was, unchanged');
  assert.equal(read(idx(sb, 'sessions', 'gamma')), 'a file\n');
});

test('more links: stubs past a dangling CLAUDE.md and an outward README.md, adopt --into and restore past a linked workspace.md, a linked hidden list', async () => {
  const sb = sandbox();
  const secret = path.join(sb.home, 'secret');
  write(path.join(secret, 'readme.md'), '# mine\n');
  write(path.join(secret, 'ws.md'), '---\nstatus: done\n---\n');
  // stubs: CLAUDE.md dangling, README.md outward.
  fs.mkdirSync(ws(sb, 'links3'), { recursive: true });
  fs.symlinkSync(path.join(secret, 'claude.md'), ws(sb, 'links3', 'CLAUDE.md'));
  fs.symlinkSync(path.join(secret, 'readme.md'), ws(sb, 'links3', 'README.md'));
  assert.deepEqual((await json(sb, ['stubs', 'links3'])).written, ['AGENTS.md']);
  assert.ok(!fs.existsSync(path.join(secret, 'claude.md')));
  assert.equal(read(path.join(secret, 'readme.md')), '# mine\n');
  // adopt --into a workspace whose workspace.md is a link.
  fs.mkdirSync(ws(sb, 'wslink'), { recursive: true });
  fs.symlinkSync(path.join(secret, 'ws.md'), ws(sb, 'wslink', 'workspace.md'));
  const x = path.join(sb.home, 'code', 'x');
  fs.mkdirSync(x, { recursive: true });
  seedSnapshot(sb, [x]);
  await assert.rejects(() => W.main(['adopt', '~/code/x', '--into', 'wslink'], sb.opts), /symlink/);
  // restore of an archived workspace whose workspace.md is a link.
  fs.mkdirSync(ws(sb, '_archive', 'old'), { recursive: true });
  fs.symlinkSync(path.join(secret, 'ws.md'), ws(sb, '_archive', 'old', 'workspace.md'));
  await assert.rejects(() => W.main(['restore', 'old'], { ...sb.opts, runScript: fakeBrain([]) }), /refusing to restore old: workspace\.md is a symlink/);
  assert.equal(read(path.join(secret, 'ws.md')), '---\nstatus: done\n---\n');
  assert.ok(fs.existsSync(ws(sb, '_archive', 'old')) && !fs.existsSync(ws(sb, 'old')));
  // hide: a linked workspaces-hidden.json is replaced by a file of its own; what it pointed at is neither read nor written.
  const outsideList = path.join(secret, 'hidden.json');
  write(outsideList, JSON.stringify({ schema: 1, paths: ['~/private/thing'] }));
  fs.symlinkSync(outsideList, idx(sb, 'workspaces-hidden.json'));
  const gone = path.join(sb.home, 'code', 'gone');
  seedSnapshot(sb, [gone]);
  assert.equal((await json(sb, ['hide', '~/code/gone'])).changed, true);
  assert.equal(fs.lstatSync(idx(sb, 'workspaces-hidden.json')).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(read(idx(sb, 'workspaces-hidden.json'))).paths, ['~/code/gone'], 'nothing read through the link');
  assert.equal(read(outsideList), JSON.stringify({ schema: 1, paths: ['~/private/thing'] }));
});

test('adopt --into finds a folder the session index knows before any snapshot lists it', async () => {
  const sb = sandbox();
  fs.mkdirSync(ws(sb, 'alpha'), { recursive: true });
  const fresh = path.join(sb.home, 'code', 'fresh');
  fs.mkdirSync(fresh, { recursive: true });
  const id = '0199cccc-0000-4000-8000-000000000001';
  write(path.join(sb.cfg, 'projects', 'x', `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, cwd: fresh, timestamp: new Date().toISOString(), entrypoint: 'cli', message: { role: 'user', content: 'hi' } }) + '\n');
  assert.equal((await json(sb, ['adopt', '~/code/fresh', '--into', 'alpha'])).alias, '~/code/fresh');
  assert.ok(fs.existsSync(idx(sb, 'session-index.json')), 'read through the incremental session index');
});

test('hide and unhide keep brain/_index/workspaces-hidden.json; a vanished folder can be hidden', async () => {
  const sb = sandbox();
  const gone = path.join(sb.home, 'code', 'gone');
  const proj = path.join(sb.home, 'code', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  seedSnapshot(sb, [gone, proj]);
  const h = await json(sb, ['hide', '~/code/gone']);
  assert.deepEqual(h, { ok: true, path: '~/code/gone', hidden: true, changed: true, file: 'brain/_index/workspaces-hidden.json', rescanned: true });
  assert.deepEqual(JSON.parse(read(idx(sb, 'workspaces-hidden.json'))), { schema: 1, paths: ['~/code/gone'] });
  assert.equal((await json(sb, ['hide', gone])).changed, false, 'already hidden');
  seedSnapshot(sb, [proj]);
  await json(sb, ['hide', proj]);
  // The scan reads the list: the hidden rows leave the outside list.
  const snap = JSON.parse(read(idx(sb, 'snapshot.json')));
  assert.deepEqual(snap.hostSessions.outsideWorkspaces, []);
  const u = await json(sb, ['unhide', '~/code/gone']);
  assert.deepEqual([u.hidden, u.changed], [false, true]);
  assert.deepEqual(JSON.parse(read(idx(sb, 'workspaces-hidden.json'))).paths, ['~/code/proj']);
  await assert.rejects(() => W.main(['unhide', gone], sb.opts), /is not hidden/);
  // An entry written as an absolute path (or as { path }) is the same stored entry.
  write(idx(sb, 'workspaces-hidden.json'), JSON.stringify({ schema: 1, paths: [proj, { path: '~/code/x' }] }));
  assert.equal((await json(sb, ['unhide', '~/code/proj'])).changed, true);
  assert.deepEqual(JSON.parse(read(idx(sb, 'workspaces-hidden.json'))).paths, ['~/code/x']);
  // A hidden folder is out of the outside list, yet it was a row when hidden: it may still be adopted.
  fs.mkdirSync(ws(sb, 'alpha'), { recursive: true });
  seedSnapshot(sb, []);
  assert.equal((await json(sb, ['adopt', '~/code/x', '--into', 'alpha'])).alias, '~/code/x');
});

/** A vault with workspaces/alpha (map, a finished thread, linked project notes) and a snapshot to refresh. */
function archiveWorld() {
  const sb = sandbox();
  write(ws(sb, 'alpha', 'README.md'), '# Alpha\n\nTide tables.\n');
  write(ws(sb, 'alpha', 'workspace.md'), '---\nstatus: paused\n# a comment\naliases:\n  - workspaces/kelp\n---\n\nBody stays.\n');
  write(idx(sb, 'workspace-maps', 'alpha.json'), '{"schema":1,"files":{}}');
  thread(sb, 'alpha', 't1', [{ t: '2026-10-01T10:00:00.000Z', kind: 'prompt', text: 'x' }, { t: '2026-10-01T10:01:00.000Z', kind: 'done', ok: true }]);
  const projects = path.join(sb.vault, 'brain', 'memory', 'projects');
  write(path.join(projects, 'alpha.md'), '---\ntype: memory\ntags: [memory/projects, status/active]\ncreated: 2026-10-01\n---\n\n# Alpha\n\nstatus/active stays in the body.\n');
  write(path.join(projects, 'tide-work.md'), '---\ntype: memory\nworkspace: "workspaces/alpha"\ntags:\n  - memory/projects\n  - status/active\n---\n\n# Tide work\n');
  write(path.join(projects, 'beta.md'), '---\ntype: memory\nworkspace: beta\ntags: [memory/projects, status/active]\n---\n\n# Beta mentions workspaces/alpha/\n');
  // Linked by a former name (alpha was kelp before a Rename): the HUD's confirmation names it, so it flips too.
  write(path.join(projects, 'kelp.md'), '---\ntags: [memory/projects, status/active]\n---\n');
  write(path.join(projects, 'alpha-later.md'), '---\ntags: [memory/projects, status/active-ish]\nworkspace: alpha\n---\n');
  // A symlinked note linked to alpha: never followed, never replaced.
  write(path.join(sb.home, 'notes', 'linked.md'), '---\nworkspace: alpha\ntags: [status/active]\n---\n');
  fs.symlinkSync(path.join(sb.home, 'notes', 'linked.md'), path.join(projects, 'linked.md'));
  seedSnapshot(sb, []);
  return { sb, projects };
}

test('archive moves the folder and its map into _archive/, marks it, flips linked notes\' status tags, rescans', async () => {
  const { sb, projects } = archiveWorld();
  const before = { tide: read(path.join(projects, 'tide-work.md')), beta: read(path.join(projects, 'beta.md')), later: read(path.join(projects, 'alpha-later.md')) };
  const now = Date.parse('2026-10-10T12:00:00Z');
  const day = (() => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const brain = [];
  const j = await json(sb, ['archive', 'alpha'], { now, runScript: fakeBrain(brain) });
  assert.deepEqual(j, {
    ok: true, name: 'alpha', archivedAs: '_archive/alpha', path: 'workspaces/_archive/alpha', archived: day, map: true,
    notes: ['brain/memory/projects/alpha.md', 'brain/memory/projects/kelp.md', 'brain/memory/projects/tide-work.md'], brainMd: { ok: true }, rescanned: true,
  });
  assert.ok(!fs.existsSync(ws(sb, 'alpha')));
  assert.equal(read(ws(sb, '_archive', 'alpha', 'README.md')), '# Alpha\n\nTide tables.\n');
  // Archive's record (D17): the notes it flipped, so Restore undoes exactly that.
  assert.equal(read(ws(sb, '_archive', 'alpha', 'workspace.md')), `---\nstatus: paused\n# a comment\naliases:\n  - workspaces/kelp\n  - workspaces/alpha\narchived: ${day}\narchivedNotes:\n  - brain/memory/projects/alpha.md\n  - brain/memory/projects/kelp.md\n  - brain/memory/projects/tide-work.md\n---\n\nBody stays.\n`);
  assert.equal(read(path.join(projects, 'kelp.md')), '---\ntags: [memory/projects, status/archived]\n---\n');
  assert.ok(fs.existsSync(idx(sb, 'workspace-maps', '_archive', 'alpha.json')) && !fs.existsSync(idx(sb, 'workspace-maps', 'alpha.json')));
  // Only the tag line changed, and only where the note links alpha by workspace: or by its exact slug.
  assert.equal(read(path.join(projects, 'alpha.md')), '---\ntype: memory\ntags: [memory/projects, status/archived]\ncreated: 2026-10-01\n---\n\n# Alpha\n\nstatus/active stays in the body.\n');
  assert.equal(read(path.join(projects, 'tide-work.md')), before.tide.replace('  - status/active\n', '  - status/archived\n'));
  assert.equal(read(path.join(projects, 'beta.md')), before.beta, 'a body mention is no link');
  assert.equal(read(path.join(projects, 'alpha-later.md')), before.later, 'status/active-ish is another tag');
  assert.ok(fs.lstatSync(path.join(projects, 'linked.md')).isSymbolicLink());
  assert.equal(read(path.join(sb.home, 'notes', 'linked.md')), '---\nworkspace: alpha\ntags: [status/active]\n---\n');
  assert.deepEqual(brain, [['build-brain-md.js']]);
  // A thread file left from Sessions is not the verb's (remove-sessions D11): it stays where it was.
  assert.ok(fs.existsSync(idx(sb, 'sessions', 'alpha', 't1.jsonl')));
  const snap = JSON.parse(read(idx(sb, 'snapshot.json')));
  const entry = snap.workspaces.find((w) => w.name === '_archive/alpha');
  assert.deepEqual([entry.hidden, entry.hiddenReason, entry.archived], [true, 'archived', day]);
  // The archived name is held: new and rename refuse it.
  await assert.rejects(() => W.main(['new', 'alpha'], sb.opts), /held by an archived workspace/);

  // Restore reverses it.
  brain.length = 0;
  const r = await json(sb, ['restore', 'alpha'], { runScript: fakeBrain(brain) });
  assert.deepEqual(r, { ok: true, name: 'alpha', path: 'workspaces/alpha', map: true, notes: ['brain/memory/projects/alpha.md', 'brain/memory/projects/kelp.md', 'brain/memory/projects/tide-work.md'], brainMd: { ok: true }, rescanned: true });
  assert.equal(read(ws(sb, 'alpha', 'workspace.md')), '---\nstatus: paused\n# a comment\naliases:\n  - workspaces/kelp\n  - workspaces/alpha\n---\n\nBody stays.\n');
  assert.ok(fs.existsSync(idx(sb, 'workspace-maps', 'alpha.json')));
  assert.equal(read(path.join(projects, 'tide-work.md')), before.tide);
  assert.match(read(path.join(projects, 'alpha.md')), /tags: \[memory\/projects, status\/active\]/);
  assert.deepEqual(brain, [['build-brain-md.js']]);
  const again = JSON.parse(read(idx(sb, 'snapshot.json'))).workspaces.find((w) => w.name === 'alpha');
  assert.equal(again.hidden, false);

  // A name taken in _archive/ gets a dated suffix; restore never lands on an existing workspace.
  fs.mkdirSync(ws(sb, '_archive', 'alpha'), { recursive: true });
  const k = await json(sb, ['archive', 'alpha'], { now, runScript: fakeBrain([]) });
  assert.equal(k.archivedAs, `_archive/alpha-${day}`);
  assert.ok(fs.existsSync(idx(sb, 'workspace-maps', '_archive', `alpha-${day}.json`)));
  fs.mkdirSync(ws(sb, 'alpha'));
  await assert.rejects(() => W.main(['restore', 'alpha'], sb.opts), /workspaces\/alpha already exists/);
  await assert.rejects(() => W.main(['restore', 'nope'], sb.opts), /no such workspace/);
});

test('archive, restore and rename refuse a running team item and linked git worktrees; a thread file left from Sessions is no running turn (remove-sessions D11)', async () => {
  const sb = sandbox();
  const now = Date.now();
  fs.mkdirSync(ws(sb, 'alpha'), { recursive: true });
  // A team run working on alpha (its board item's path), from a live dispatcher on this machine.
  const team = path.join(sb.vault, 'persona', 'teams', 'dev');
  write(path.join(team, 'board.jsonl'), JSON.stringify({ id: 'site-01', path: 'workspaces/alpha/site' }) + '\n');
  write(path.join(team, 'running', 'r1.json'), JSON.stringify({ schema: 1, item: 'site-01', pid: process.pid, host: os.hostname() }));
  for (const args of [['archive', 'alpha'], ['rename', 'alpha', 'alpha-two']]) {
    await assert.rejects(() => W.main(args, sb.opts), /a team run is working on it \(dev\/site-01\)/);
  }
  // A dead dispatcher's marker is the team's to sweep, not a running item.
  write(path.join(team, 'running', 'r1.json'), JSON.stringify({ schema: 1, item: 'site-01', pid: 2 ** 30, host: os.hostname() }));
  // A Sessions thread whose last turn never finished, from minutes ago: Sessions is gone, so nothing runs it and it blocks nothing.
  thread(sb, 'alpha', 't2', [{ t: new Date(now - 5 * 60000).toISOString(), kind: 'prompt', text: 'go' }, { t: new Date(now - 4 * 60000).toISOString(), kind: 'text', text: 'working' }], 'Fix the tide parser');
  // A repository with linked worktrees: moving it would break git's links.
  write(ws(sb, 'alpha', '.git', 'worktrees', 'feat', 'gitdir'), path.join(sb.home, 'code', 'alpha.worktrees', 'feat', '.git') + '\n');
  await assert.rejects(() => W.main(['archive', 'alpha'], sb.opts), (e) => /linked worktrees \(~\/code\/alpha\.worktrees\/feat\)/.test(e.message) && /git worktree repair/.test(e.message));
  // A folder that is itself a linked worktree.
  write(ws(sb, 'wt', '.git'), `gitdir: ${path.join(sb.home, 'code', 'main', '.git', 'worktrees', 'wt')}\n`);
  await assert.rejects(() => W.main(['rename', 'wt', 'wt-two'], sb.opts), /it is a linked git worktree of ~\/code\/main/);
  // An archived workspace with linked worktrees is not restored either.
  write(ws(sb, '_archive', 'old', '.git', 'worktrees', 'x', 'gitdir'), '/somewhere/x/.git\n');
  await assert.rejects(() => W.main(['restore', 'old'], sb.opts), /linked worktrees/);
  assert.ok(fs.existsSync(ws(sb, 'alpha')) && fs.existsSync(ws(sb, 'wt')) && fs.existsSync(ws(sb, '_archive', 'old')), 'nothing moved');
  assert.ok(!fs.existsSync(ws(sb, 'alpha', 'workspace.md')), 'nothing was written before the refusal');
});

test('moving verbs refuse a headless run, reserved names, Scratch and a symlinked workspace.md', async () => {
  const sb = sandbox();
  fs.mkdirSync(ws(sb, 'alpha'), { recursive: true });
  fs.mkdirSync(ws(sb, 'research'), { recursive: true });
  fs.mkdirSync(ws(sb, 'scratch'), { recursive: true });
  fs.mkdirSync(ws(sb, '_archive', 'scratch'), { recursive: true });
  const src = path.join(sb.home, 'code', 'loose');
  fs.mkdirSync(src, { recursive: true });
  const headless = { env: { ...process.env, AOS_HEADLESS: '1' } };
  for (const args of [['archive', 'alpha'], ['restore', 'alpha'], ['rename', 'alpha', 'alpha-two'], ['adopt', src]]) {
    await assert.rejects(() => W.main(args, { ...sb.opts, ...headless }), /AOS_HEADLESS=1/, args.join(' '));
  }
  assert.ok(fs.existsSync(src) && fs.existsSync(ws(sb, 'alpha')));
  for (const args of [['archive', 'research'], ['archive', 'scratch'], ['rename', 'research', 'notes'], ['rename', 'alpha', 'scratch'], ['rename', 'alpha', 'research'], ['restore', 'scratch']]) {
    await assert.rejects(() => W.main(args, sb.opts), /reserved/, args.join(' '));
  }
  await assert.rejects(() => W.main(['archive', '../alpha'], sb.opts), /not a workspace name/);
  await assert.rejects(() => W.main(['archive', '.git'], sb.opts), /not a workspace name/);
  // A workspace folder that is a link is no workspace folder.
  fs.mkdirSync(path.join(sb.home, 'elsewhere'));
  fs.symlinkSync(path.join(sb.home, 'elsewhere'), ws(sb, 'linked'));
  await assert.rejects(() => W.main(['archive', 'linked'], sb.opts), /symlink/);
  // A symlinked workspace.md refuses the move before anything changes.
  write(path.join(sb.home, 'outside.md'), '---\nstatus: active\n---\n');
  fs.symlinkSync(path.join(sb.home, 'outside.md'), ws(sb, 'alpha', 'workspace.md'));
  await assert.rejects(() => W.main(['archive', 'alpha'], sb.opts), /refusing to archive alpha: workspace\.md is a symlink/);
  await assert.rejects(() => W.main(['rename', 'alpha', 'alpha-two'], sb.opts), /symlink/);
  assert.equal(read(path.join(sb.home, 'outside.md')), '---\nstatus: active\n---\n');
  assert.ok(fs.existsSync(ws(sb, 'alpha')) && !fs.existsSync(ws(sb, '_archive', 'alpha')));
});

test('rename moves the folder and its map, and keeps the old name as an alias', async () => {
  const sb = sandbox();
  write(ws(sb, 'alpha', 'README.md'), '# Alpha\n');
  write(idx(sb, 'workspace-maps', 'alpha.json'), '{}');
  seedSnapshot(sb, []);
  const j = await json(sb, ['rename', 'alpha', 'tide-tables']);
  assert.deepEqual(j, { ok: true, from: 'alpha', name: 'tide-tables', path: 'workspaces/tide-tables', alias: 'workspaces/alpha', map: true, rescanned: true });
  assert.ok(!fs.existsSync(ws(sb, 'alpha')) && fs.existsSync(ws(sb, 'tide-tables', 'README.md')));
  assert.equal(read(ws(sb, 'tide-tables', 'workspace.md')), '---\naliases:\n  - workspaces/alpha\n---\n');
  assert.ok(fs.existsSync(idx(sb, 'workspace-maps', 'tide-tables.json')) && !fs.existsSync(idx(sb, 'workspace-maps', 'alpha.json')));
  const entry = JSON.parse(read(idx(sb, 'snapshot.json'))).workspaces.find((w) => w.name === 'tide-tables');
  assert.equal(entry.sessions.recent.length, 0, 'no session ran there, so nothing is credited');
  // The new name: kebab-case only, free, not held by an archived workspace.
  for (const bad of ['Tide Two', 'tide_two', 'tide-', 'a'.repeat(65)]) {
    await assert.rejects(() => W.main(['rename', 'tide-tables', bad], sb.opts), /kebab-case/, bad);
  }
  await assert.rejects(() => W.main(['rename', 'tide-tables', '-tide'], sb.opts), (e) => e instanceof W.UsageError && /unknown flag -tide/.test(e.message));
  fs.mkdirSync(ws(sb, 'beta'));
  fs.mkdirSync(ws(sb, '_archive', 'gone'), { recursive: true });
  await assert.rejects(() => W.main(['rename', 'tide-tables', 'beta'], sb.opts), /workspaces\/beta already exists/);
  await assert.rejects(() => W.main(['rename', 'tide-tables', 'gone'], sb.opts), /held by an archived workspace/);
  await assert.rejects(() => W.main(['rename', 'tide-tables', 'tide-tables'], sb.opts), /already has that name/);
});

test('draft prints fields and a baseHash and writes no workspace file; set saves allow-listed keys against --expect', async () => {
  const sb = sandbox();
  write(ws(sb, 'alpha', 'README.md'), '# Alpha\n\nTide tables for the harbour.\n');
  const asked = [];
  const provider = async () => ({
    name: 'claude', model: 'fake-model', reason: 'forced',
    chat: async (o) => { asked.push(o.feature); return JSON.stringify({ summary: 'Tide tables.', objectives: ['Parse the table'], next: 'Write the parser' }); },
  });
  const d = await json(sb, ['draft', 'alpha'], { draft: { provider } });
  assert.deepEqual({ ...d, generatedAt: null }, {
    provider: 'claude', model: 'fake-model', reason: 'forced', generatedAt: null, sources: ['README.md'],
    fields: { summary: 'Tide tables.', objectives: ['Parse the table'], next: 'Write the parser' }, file: 'workspaces/alpha/workspace.md', baseHash: 'none',
  });
  assert.deepEqual(asked, ['workspace-draft']);
  assert.ok(!fs.existsSync(ws(sb, 'alpha', 'workspace.md')), 'a draft writes no workspace file');
  // Save: --dry-run previews the exact file and writes nothing; then the write, compared against the hash.
  const set = JSON.stringify({ summary: 'Tide tables.', objectives: ['Parse the table'], next: 'Write the parser' });
  const p = await json(sb, ['set', 'alpha', '--set', set, '--expect', d.baseHash, '--dry-run']);
  const text = '---\nsummary: Tide tables.\nobjectives:\n  - Parse the table\nnext: Write the parser\n---\n';
  assert.deepEqual(p, { ok: true, name: 'alpha', file: 'workspaces/alpha/workspace.md', fields: JSON.parse(set), changed: true, written: false, dryRun: true, before: 'none', hash: sha(text), text, beforeText: null, rescanned: false });
  assert.ok(!fs.existsSync(ws(sb, 'alpha', 'workspace.md')));
  const s = await json(sb, ['set', 'alpha', '--set', set, '--expect', 'none']);
  assert.deepEqual([s.written, s.hash, 'text' in s], [true, sha(text), false]);
  assert.equal(read(ws(sb, 'alpha', 'workspace.md')), text);
  // A preview over an existing file carries it as it is, so the dialog marks only the new lines.
  const p2 = await json(sb, ['set', 'alpha', '--set', '{"next":"Ship it"}', '--expect', sha(text), '--dry-run']);
  assert.deepEqual([p2.beforeText, p2.written, p2.text], [text, false, text.replace('next: Write the parser', 'next: Ship it')]);
  // The file changed since the draft read it: refused.
  await assert.rejects(() => W.main(['set', 'alpha', '--set', '{"next":"x"}', '--expect', 'none'], sb.opts), /workspace\.md changed: draft again/);
  // Pin, status and Link code folder ride the same verb; '' clears.
  const proj = path.join(sb.home, 'code', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const t = await json(sb, ['set', 'alpha', '--set', JSON.stringify({ pinned: true, status: 'done', repo: '~/code/proj', next: '' }), '--expect', sha(text)]);
  assert.deepEqual(t.fields, { pinned: true, status: 'done', repo: '~/code/proj', next: null });
  assert.equal(read(ws(sb, 'alpha', 'workspace.md')), '---\nsummary: Tide tables.\nobjectives:\n  - Parse the table\npinned: true\nstatus: done\nrepo: ~/code/proj\n---\n');
  // What set refuses.
  const bad = async (json1, re, extra = []) => assert.rejects(() => W.main(['set', 'alpha', '--set', json1, ...extra], sb.opts), re);
  await bad('{"status":"parked"}', /status must be one of/);
  await bad('{"color":"red"}', /unknown key "color"/);
  await bad('{"aliases":["~/x"]}', /unknown key "aliases"/);
  await bad('not json', /JSON object/);
  await bad('{"pinned":"yes"}', /pinned must be true or false/);
  await bad('{"summary":"a\\nb"}', /control characters/);
  await bad('{"repo":"~/.claude"}', /host config folder/);
  await bad('{"repo":"~/.codex/sessions"}', /host config folder/);
  await bad(`{"repo":${JSON.stringify(sb.vault)}}`, /outside the vault/);
  await bad('{"repo":"~/code/missing"}', /existing folder/);
  await assert.rejects(() => W.main(['set', 'alpha', '--set', '{}', '--expect', 'zz'], sb.opts), (e) => e instanceof W.UsageError && /--expect/.test(e.message));
  await assert.rejects(() => W.main(['set', 'alpha'], sb.opts), (e) => e instanceof W.UsageError && /--set is required/.test(e.message));
  await assert.rejects(() => W.main(['set', '_archive', '--set', '{}'], sb.opts), /not a workspace name/);
});

test('draft and set never read or write through a symlinked workspace.md', async () => {
  const sb = sandbox();
  write(ws(sb, 'alpha', 'README.md'), '# Alpha\n');
  write(path.join(sb.home, 'private.md'), '---\nsummary: private\n---\n');
  fs.symlinkSync(path.join(sb.home, 'private.md'), ws(sb, 'alpha', 'workspace.md'));
  const provider = async () => { throw new Error('no model call for a refused draft'); };
  await assert.rejects(() => W.main(['draft', 'alpha', '--json'], { ...sb.opts, draft: { provider } }), /symlink/);
  await assert.rejects(() => W.main(['set', 'alpha', '--set', '{"pinned":true}', '--expect', 'none'], sb.opts), /symlink/);
  await assert.rejects(() => W.main(['set', 'alpha', '--set', '{"pinned":true}'], sb.opts), /symlink/);
  assert.equal(read(path.join(sb.home, 'private.md')), '---\nsummary: private\n---\n');
  assert.ok(fs.lstatSync(ws(sb, 'alpha', 'workspace.md')).isSymbolicLink());
});

test('each verb takes only its own flags and argument count; no argument starts with a dash', async () => {
  const sb = sandbox();
  fs.mkdirSync(ws(sb, 'alpha'), { recursive: true });
  const usage = (args, re) => assert.rejects(() => W.main(args, sb.opts), (e) => e instanceof W.UsageError && re.test(e.message), args.join(' '));
  await usage(['archive', 'alpha', '--pin'], /--pin is not one of its flags/);
  await usage(['archive', 'alpha', '--dry-run'], /--dry-run is only supported by `aos workspace set`/);
  await usage(['new', 'x', '--into', 'alpha'], /--into is not one of its flags/);
  await usage(['which', '--set', '{}'], /--set is not one of its flags/);
  await usage(['archive'], /aos workspace archive <workspace>/);
  await usage(['archive', 'alpha', 'beta'], /too many arguments/);
  await usage(['rename', 'alpha'], /rename <workspace> <new-name>/);
  await usage(['hide'], /hide <path>/);
  await usage(['archive', '-alpha'], /unknown flag -alpha/);
  await usage(['set', 'alpha', '--set'], /--set needs a value/);
  await usage(['set', 'alpha', '--expect='], /--expect needs a value/);
  await usage(['which', '--cwd'], /--cwd needs a value/);
  await usage(['new', 'x', '--git=yes'], /unknown flag --git=yes/);
  // Value flags in --flag=value form too.
  assert.deepEqual(await json(sb, ['which', `--cwd=${ws(sb, 'alpha')}`]), { name: 'alpha', slug: 'alpha', via: 'cwd' });
});

// ── links on the way (spaces-redesign §6): a linked root or runtime folder never takes a verb out of the vault ──

test('a linked workspace-maps/_archive never moves a map across the vault boundary (archive, restore)', async () => {
  const sb = sandbox();
  // Repro: archive `settings` with workspace-maps/_archive linked to the Claude config folder would have replaced its
  // settings.json with the map, a SessionStart hook in it.
  write(path.join(sb.cfg, 'settings.json'), '{"theme":"dark"}\n');
  fs.mkdirSync(ws(sb, 'settings'), { recursive: true });
  const hooks = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo pwned' }] }] } });
  write(idx(sb, 'workspace-maps', 'settings.json'), hooks);
  fs.symlinkSync(path.relative(idx(sb, 'workspace-maps'), sb.cfg), idx(sb, 'workspace-maps', '_archive'));
  await assert.rejects(() => W.main(['archive', 'settings', '--json'], { ...sb.opts, runScript: fakeBrain([]) }), /refusing to archive settings: brain\/_index\/workspace-maps\/_archive is not a plain folder/);
  assert.equal(read(path.join(sb.cfg, 'settings.json')), '{"theme":"dark"}\n', 'the host config file is untouched');
  assert.equal(read(idx(sb, 'workspace-maps', 'settings.json')), hooks, 'the map stays where it was');
  assert.ok(fs.existsSync(ws(sb, 'settings')) && !fs.existsSync(ws(sb, 'settings', 'workspace.md')), 'refused before anything was written');
  // Repro 2: restore `auth` with the link pointing at the Codex home would have pulled its auth.json into the vault.
  fs.unlinkSync(idx(sb, 'workspace-maps', '_archive'));
  write(path.join(sb.codex, 'auth.json'), '{"token":"t"}\n');
  fs.symlinkSync(sb.codex, idx(sb, 'workspace-maps', '_archive'));
  fs.mkdirSync(ws(sb, '_archive', 'auth'), { recursive: true });
  await assert.rejects(() => W.main(['restore', 'auth', '--json'], { ...sb.opts, runScript: fakeBrain([]) }), /refusing to restore auth: brain\/_index\/workspace-maps\/_archive is not a plain folder/);
  assert.equal(read(path.join(sb.codex, 'auth.json')), '{"token":"t"}\n');
  assert.ok(!fs.existsSync(idx(sb, 'workspace-maps', 'auth.json')) && fs.existsSync(ws(sb, '_archive', 'auth')));
});

test('a linked workspace-maps refuses rename and archive; a map is never written over', async () => {
  const sb = sandbox();
  const elsewhere = path.join(sb.home, 'elsewhere');
  write(path.join(elsewhere, 'gamma.json'), '{"outside":true}');
  fs.mkdirSync(ws(sb, 'gamma'), { recursive: true });
  fs.mkdirSync(idx(sb), { recursive: true });
  fs.symlinkSync(elsewhere, idx(sb, 'workspace-maps'));
  await assert.rejects(() => W.main(['rename', 'gamma', 'delta'], sb.opts), /refusing to rename gamma: brain\/_index\/workspace-maps is not a plain folder/);
  await assert.rejects(() => W.main(['archive', 'gamma'], { ...sb.opts, runScript: fakeBrain([]) }), /workspace-maps is not a plain folder/);
  assert.deepEqual(fs.readdirSync(elsewhere), ['gamma.json']);
  assert.equal(read(path.join(elsewhere, 'gamma.json')), '{"outside":true}');
  assert.ok(fs.existsSync(ws(sb, 'gamma')) && !fs.existsSync(ws(sb, 'delta')));
  // A plain maps folder: a map left at the destination is never replaced. Rename refuses before anything moves…
  fs.unlinkSync(idx(sb, 'workspace-maps'));
  write(idx(sb, 'workspace-maps', 'gamma.json'), '{"mine":1}');
  write(idx(sb, 'workspace-maps', 'delta.json'), '{"stale":1}');
  await assert.rejects(() => W.main(['rename', 'gamma', 'delta'], sb.opts), /workspace-maps\/delta\.json already exists/);
  assert.ok(fs.existsSync(ws(sb, 'gamma')) && !fs.existsSync(ws(sb, 'gamma', 'workspace.md')));
  assert.equal(read(idx(sb, 'workspace-maps', 'delta.json')), '{"stale":1}');
  // …and Archive takes the dated name when a map already holds the plain one in _archive/.
  write(idx(sb, 'workspace-maps', '_archive', 'gamma.json'), '{"old":1}');
  const now = Date.parse('2026-10-10T12:00:00Z');
  const j = await json(sb, ['archive', 'gamma'], { now, runScript: fakeBrain([]) });
  assert.match(j.archivedAs, /^_archive\/gamma-\d{4}-\d{2}-\d{2}$/);
  assert.equal(read(idx(sb, 'workspace-maps', '_archive', 'gamma.json')), '{"old":1}');
  assert.equal(read(idx(sb, 'workspace-maps', '_archive', `${j.archivedAs.slice('_archive/'.length)}.json`)), '{"mine":1}');
});

test('a linked workspaces/ or workspaces/_archive is refused by every verb, so nothing outside the vault is read, made or moved', async () => {
  const sb = sandbox();
  // Repro: with `workspaces -> ..` (the home folder), set wrote ~/Documents/workspace.md, new made ~/evil and archive moved
  // ~/Documents to ~/_archive/Documents.
  write(path.join(sb.home, 'Documents', 'letter.txt'), 'dear\n');
  fs.rmSync(ws(sb), { recursive: true });
  fs.symlinkSync('..', ws(sb));
  const unsafe = /workspaces is not a plain folder/;
  await assert.rejects(() => W.main(['set', 'Documents', '--set', '{"pinned":true}'], sb.opts), unsafe);
  await assert.rejects(() => W.main(['new', 'evil'], sb.opts), unsafe);
  await assert.rejects(() => W.main(['archive', 'Documents'], { ...sb.opts, runScript: fakeBrain([]) }), unsafe);
  await assert.rejects(() => W.main(['rename', 'Documents', 'docs'], sb.opts), unsafe);
  await assert.rejects(() => W.main(['stubs', 'Documents'], sb.opts), unsafe);
  await assert.rejects(() => W.main(['draft', 'Documents', '--json'], { ...sb.opts, draft: { provider: async () => { throw new Error('no model call'); } } }), unsafe);
  const loose = path.join(sb.home, 'code', 'loose');
  fs.mkdirSync(loose, { recursive: true });
  await assert.rejects(() => W.main(['adopt', loose], sb.opts), unsafe);
  assert.deepEqual(fs.readdirSync(path.join(sb.home, 'Documents')), ['letter.txt']);
  assert.ok(!fs.existsSync(path.join(sb.home, 'evil')) && !fs.existsSync(path.join(sb.home, '_archive')) && fs.existsSync(loose));
  // Repro: with `workspaces/_archive -> ../..` (home), restore moved ~/Private (passwords.txt in it) into the vault.
  fs.unlinkSync(ws(sb));
  fs.mkdirSync(ws(sb));
  write(path.join(sb.home, 'Private', 'passwords.txt'), 'hunter2\n');
  fs.symlinkSync(path.join('..', '..'), ws(sb, '_archive'));
  await assert.rejects(() => W.main(['restore', 'Private'], { ...sb.opts, runScript: fakeBrain([]) }), /refusing to restore Private: workspaces\/_archive is not a plain folder/);
  assert.equal(read(path.join(sb.home, 'Private', 'passwords.txt')), 'hunter2\n');
  assert.ok(!fs.existsSync(ws(sb, 'Private')));
  // _archive linked to a folder elsewhere: restore refused, as archive is.
  fs.unlinkSync(ws(sb, '_archive'));
  write(path.join(sb.home, 'elsewhere', 'loot', 'secret.txt'), 's\n');
  fs.symlinkSync(path.join(sb.home, 'elsewhere'), ws(sb, '_archive'));
  await assert.rejects(() => W.main(['restore', 'loot'], { ...sb.opts, runScript: fakeBrain([]) }), /not a plain folder/);
  fs.mkdirSync(ws(sb, 'proj'));
  await assert.rejects(() => W.main(['archive', 'proj'], { ...sb.opts, runScript: fakeBrain([]) }), /workspaces\/_archive is not a plain folder/);
  assert.ok(fs.existsSync(path.join(sb.home, 'elsewhere', 'loot', 'secret.txt')) && fs.existsSync(ws(sb, 'proj')));
  // _archive as a plain file: archive refused too, and nothing moved.
  fs.unlinkSync(ws(sb, '_archive'));
  write(ws(sb, '_archive'), 'not a folder\n');
  await assert.rejects(() => W.main(['archive', 'proj'], { ...sb.opts, runScript: fakeBrain([]) }), /workspaces\/_archive is not a plain folder/);
  assert.ok(fs.existsSync(ws(sb, 'proj')) && !fs.existsSync(ws(sb, 'proj', 'workspace.md')));
});

test('names match the folder exactly: a case or Unicode variant never reaches a reserved folder or Scratch', async () => {
  const sb = sandbox();
  for (const d of ['research', 'scratch', 'foo']) fs.mkdirSync(ws(sb, d), { recursive: true });
  thread(sb, 'foo', 't1', [{ t: '2026-10-01T10:00:00.000Z', kind: 'prompt', text: 'x' }, { t: '2026-10-01T10:00:01.000Z', kind: 'done', ok: true }]);
  // Repro (APFS): `reſearch` and `ſcratch` (U+017F long s) passed the reserved check and found research and scratch by a
  // case-folding lookup; `FOO` found foo and renamed its threads without rewriting their meta line.
  const opts = { ...sb.opts, runScript: fakeBrain([]) };
  for (const args of [['archive', 'reſearch'], ['archive', 'ſcratch'], ['rename', 'ſcratch', 'mine'], ['archive', 'FOO'], ['rename', 'FOO', 'bar'], ['set', 'FOO', '--set', '{"pinned":true}']]) {
    await assert.rejects(() => W.main(args, opts), /no such workspace/, args.join(' '));
  }
  assert.deepEqual(fs.readdirSync(ws(sb)).sort(), ['foo', 'research', 'scratch'], 'nothing moved');
  assert.ok(!fs.existsSync(ws(sb, 'foo', 'workspace.md')));
  assert.equal(JSON.parse(read(idx(sb, 'sessions', 'foo', 't1.jsonl')).split('\n')[0]).workspace, 'foo');
  fs.mkdirSync(ws(sb, '_archive', 'old'), { recursive: true });
  await assert.rejects(() => W.main(['restore', 'OLD'], opts), /no such workspace/);
  assert.ok(fs.existsSync(ws(sb, '_archive', 'old')));
});

test('a case variant of a host config folder or the vault is the folder itself (set repo, adopt --into, hide)', async () => {
  const sb = sandbox();
  fs.mkdirSync(ws(sb, 'foo'), { recursive: true });
  // Only a case-insensitive file system (macOS) finds ~/.CLAUDE; elsewhere it does not exist and is refused as missing.
  const folds = fs.existsSync(path.join(sb.home, '.CLAUDE'));
  const vaultUpper = path.join(sb.home, 'VAULT');
  await assert.rejects(() => W.main(['set', 'foo', '--set', '{"repo":"~/.CLAUDE"}'], sb.opts), folds ? /host config folder/ : /existing folder/);
  await assert.rejects(() => W.main(['set', 'foo', '--set', '{"repo":"~/.Codex"}'], sb.opts), folds ? /host config folder/ : /existing folder/);
  await assert.rejects(() => W.main(['set', 'foo', '--set', JSON.stringify({ repo: vaultUpper })], sb.opts), folds ? /outside the vault/ : /existing folder/);
  await assert.rejects(() => W.main(['set', 'foo', '--set', JSON.stringify({ repo: path.join(vaultUpper, 'workspaces', 'foo') })], sb.opts), folds ? /outside the vault/ : /existing folder/);
  seedSnapshot(sb, [path.join(sb.home, '.CLAUDE'), vaultUpper]);
  if (folds) {
    await assert.rejects(() => W.main(['adopt', '~/.CLAUDE', '--into', 'foo'], sb.opts), /Claude config dir/);
    await assert.rejects(() => W.main(['hide', '~/.CLAUDE'], sb.opts), /Claude config dir/);
    await assert.rejects(() => W.main(['adopt', vaultUpper, '--into', 'foo'], sb.opts), /inside the vault/);
  }
  assert.ok(!fs.existsSync(ws(sb, 'foo', 'workspace.md')));
  assert.ok(!fs.existsSync(idx(sb, 'workspaces-hidden.json')));
});

test('a linked brain/memory or brain/_index/sessions is never written through (archive flips nothing there; rename leaves it alone)', async () => {
  const sb = sandbox();
  fs.mkdirSync(ws(sb, 'foo'), { recursive: true });
  const elsewhere = path.join(sb.home, 'elsewhere');
  const note = '---\ntags: [memory/projects, status/active]\n---\n';
  write(path.join(elsewhere, 'projects', 'foo.md'), note);
  fs.mkdirSync(path.join(sb.vault, 'brain'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(sb.vault, 'brain', 'memory'));
  const j = await json(sb, ['archive', 'foo'], { runScript: fakeBrain([]) });
  assert.deepEqual(j.notes, []);
  assert.equal(read(path.join(elsewhere, 'projects', 'foo.md')), note, 'the note outside the vault is untouched');
  assert.equal(read(ws(sb, '_archive', 'foo', 'workspace.md')).includes('archivedNotes'), false);
  await json(sb, ['restore', 'foo'], { runScript: fakeBrain([]) });
  assert.equal(read(path.join(elsewhere, 'projects', 'foo.md')), note);
  // Threads behind a linked sessions folder (left from Sessions): rename neither reads nor writes them (remove-sessions D11).
  const away = path.join(sb.home, 'away');
  write(path.join(away, 'foo', 't1.jsonl'), JSON.stringify({ schema: 1, kind: 'meta', thread: 't1', workspace: 'foo' }) + '\n');
  fs.symlinkSync(away, idx(sb, 'sessions'));
  await json(sb, ['rename', 'foo', 'bar']);
  assert.deepEqual(fs.readdirSync(away), ['foo']);
  assert.equal(JSON.parse(read(path.join(away, 'foo', 't1.jsonl'))).workspace, 'foo');
  assert.ok(fs.existsSync(ws(sb, 'bar')) && !fs.existsSync(ws(sb, 'foo')));
});

test('restore undoes exactly what archive did: a note archived before stays archived, and a dated archive goes back to its name', async () => {
  const sb = sandbox();
  fs.mkdirSync(ws(sb, 'harbor'), { recursive: true });
  const projects = path.join(sb.vault, 'brain', 'memory', 'projects');
  write(path.join(projects, 'harbor.md'), '---\ntags: [memory/projects, status/archived]\n---\n');
  write(path.join(projects, 'harbor-v1.md'), '---\nworkspace: harbor\ntags: [memory/projects, status/archived]\n---\n');
  write(path.join(projects, 'harbor-v2.md'), '---\nworkspace: harbor\ntags: [memory/projects, status/active]\n---\n');
  write(idx(sb, 'workspace-maps', 'harbor.json'), '{}');
  thread(sb, 'harbor', 't1', [{ t: '2026-10-01T10:00:00.000Z', kind: 'prompt', text: 'x' }, { t: '2026-10-01T10:00:01.000Z', kind: 'done', ok: true }]);
  // The name is taken in _archive/, so Archive moves it under a dated name.
  fs.mkdirSync(ws(sb, '_archive', 'harbor'), { recursive: true });
  const now = Date.parse('2026-10-10T12:00:00Z');
  const a = await json(sb, ['archive', 'harbor'], { now, runScript: fakeBrain([]) });
  const dated = a.archivedAs.slice('_archive/'.length);
  assert.notEqual(dated, 'harbor');
  assert.deepEqual(a.notes, ['brain/memory/projects/harbor-v2.md']);
  const md = read(ws(sb, '_archive', dated, 'workspace.md'));
  assert.match(md, /archivedNotes:\n {2}- brain\/memory\/projects\/harbor-v2\.md\n/);
  assert.match(md, /archivedFrom: harbor\n/);
  // Restore: back to workspaces/harbor (its map with it), and only harbor-v2 wakes.
  const r = await json(sb, ['restore', dated], { runScript: fakeBrain([]) });
  assert.deepEqual(r, { ok: true, name: 'harbor', path: 'workspaces/harbor', restoredFrom: `_archive/${dated}`, map: true, notes: ['brain/memory/projects/harbor-v2.md'], brainMd: { ok: true }, rescanned: false });
  assert.ok(fs.existsSync(ws(sb, 'harbor')) && !fs.existsSync(ws(sb, '_archive', dated)));
  assert.ok(fs.existsSync(idx(sb, 'workspace-maps', 'harbor.json')));
  assert.match(read(path.join(projects, 'harbor.md')), /status\/archived/, 'archived before: stays archived');
  assert.match(read(path.join(projects, 'harbor-v1.md')), /status\/archived/, 'archived before: stays archived');
  assert.match(read(path.join(projects, 'harbor-v2.md')), /status\/active/);
  const back = read(ws(sb, 'harbor', 'workspace.md'));
  assert.doesNotMatch(back, /archived|archivedNotes|archivedFrom/, 'Archive\'s marks are gone');
  // A folder moved into _archive/ by hand carries no record: restore moves it and flips nothing.
  fs.mkdirSync(ws(sb, '_archive', 'byhand'), { recursive: true });
  write(path.join(projects, 'byhand.md'), '---\ntags: [memory/projects, status/archived]\n---\n');
  assert.deepEqual((await json(sb, ['restore', 'byhand'], { runScript: fakeBrain([]) })).notes, []);
  assert.match(read(path.join(projects, 'byhand.md')), /status\/archived/);
  // The original name taken meanwhile: refused, nothing moved.
  await json(sb, ['archive', 'harbor'], { now, runScript: fakeBrain([]) });
  const again = fs.readdirSync(ws(sb, '_archive')).find((n) => n.startsWith('harbor-'));
  fs.mkdirSync(ws(sb, 'harbor'));
  await assert.rejects(() => W.main(['restore', again], sb.opts), /workspaces\/harbor already exists/);
  assert.ok(fs.existsSync(ws(sb, '_archive', again)));
});

test('an alias naming another live workspace is no former name: archive never flips that workspace\'s notes', async () => {
  const sb = sandbox();
  // A cloned workspace.md may list any alias; workspaces/other is a workspace of its own.
  write(ws(sb, 'evil', 'workspace.md'), '---\naliases:\n  - workspaces/other\n  - workspaces/gone\n---\n');
  fs.mkdirSync(ws(sb, 'other'), { recursive: true });
  const projects = path.join(sb.vault, 'brain', 'memory', 'projects');
  write(path.join(projects, 'other.md'), '---\ntags: [memory/projects, status/active]\n---\n');
  write(path.join(projects, 'gone.md'), '---\ntags: [memory/projects, status/active]\n---\n');
  const j = await json(sb, ['archive', 'evil'], { runScript: fakeBrain([]) });
  assert.deepEqual(j.notes, ['brain/memory/projects/gone.md'], 'a freed former name still counts');
  assert.match(read(path.join(projects, 'other.md')), /status\/active/);
});

test('flipProjectNotes changes only the first frontmatter status tag line: CRLF, block lists, quoted tags; the body never', () => {
  const sb = sandbox();
  const projects = path.join(sb.vault, 'brain', 'memory', 'projects');
  write(path.join(projects, 'crlf.md'), '---\r\nworkspace: alpha\r\ntags: [memory/projects, status/active]\r\n---\r\nstatus/active in the body\r\n');
  write(path.join(projects, 'block.md'), '---\nworkspace: "[[alpha]]"\ntags:\n  - memory/projects\n  - "status/active"\n---\n\nstatus/active\n');
  write(path.join(projects, 'quoted.md'), "---\nworkspace: 'workspaces/alpha/'\ntags: ['status/active', x]\n---\n");
  write(path.join(projects, 'body-only.md'), '---\nworkspace: alpha\ntags: [memory/projects]\n---\nstatus/active\n');
  const ctx = W.resolveCtx(sb.opts);
  assert.deepEqual(W.flipProjectNotes(ctx, ['alpha'], 'active', 'archived', null, { dryRun: true }), ['brain/memory/projects/block.md', 'brain/memory/projects/crlf.md', 'brain/memory/projects/quoted.md']);
  assert.match(read(path.join(projects, 'crlf.md')), /status\/active\]/, 'a dry run writes nothing');
  assert.deepEqual(W.flipProjectNotes(ctx, ['alpha'], 'active', 'archived', ['brain/memory/projects/crlf.md']), ['brain/memory/projects/crlf.md']);
  assert.equal(read(path.join(projects, 'crlf.md')), '---\r\nworkspace: alpha\r\ntags: [memory/projects, status/archived]\r\n---\r\nstatus/active in the body\r\n');
  W.flipProjectNotes(ctx, ['alpha'], 'active', 'archived');
  assert.equal(read(path.join(projects, 'block.md')), '---\nworkspace: "[[alpha]]"\ntags:\n  - memory/projects\n  - "status/archived"\n---\n\nstatus/active\n');
  assert.equal(read(path.join(projects, 'quoted.md')), "---\nworkspace: 'workspaces/alpha/'\ntags: ['status/archived', x]\n---\n");
  assert.equal(read(path.join(projects, 'body-only.md')), '---\nworkspace: alpha\ntags: [memory/projects]\n---\nstatus/active\n');
});

// ── containment (spaces-redesign §6): every verb, through cli/aos.js, in a temp vault with a fake HOME ──

/** Every path under `root`, by lstat (links are never followed): type, mode and content hash. */
function walk(root) {
  const out = new Map();
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const rel = path.relative(root, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.set(rel, `link ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) { out.set(rel, 'dir'); visit(p); } else out.set(rel, `file ${st.mode} ${sha(fs.readFileSync(p))}`);
    }
  };
  visit(root);
  return out;
}

test('containment: the verbs change only workspaces/**, brain/_index/** and a linked note\'s status tag line, nothing else under HOME', () => {
  const sb = sandbox({ provider: 'none' });
  const cfgFile = path.join(sb.cfg, 'agenticos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ vault: sb.vault, provider: 'none', hosts: { claude: { enabled: true }, codex: { enabled: true, home: sb.codex } } }, null, 2));
  write(path.join(sb.vault, 'MEMORY.md'), '# Memory\n\n## Project\n\n- [Beta](brain/memory/projects/beta.md) — the beta project\n');
  write(ws(sb, 'alpha', 'README.md'), '# Alpha\n\nTide tables.\n');
  write(ws(sb, 'beta', 'README.md'), '# Beta\n');
  // Links pointing out of the vault, dangling or not: no verb may write through them.
  const secret = path.join(sb.home, 'secret');
  write(path.join(secret, 'notes.md'), 'private\n');
  write(path.join(secret, 'ws.md'), '---\nstatus: done\n---\n');
  fs.symlinkSync(path.join(secret, 'notes.md'), ws(sb, 'alpha', 'CLAUDE.md'));
  fs.symlinkSync(path.join(secret, 'missing.md'), ws(sb, 'alpha', 'AGENTS.md'));
  fs.mkdirSync(ws(sb, 'linked'));
  fs.symlinkSync(path.join(secret, 'ws.md'), ws(sb, 'linked', 'workspace.md'));
  fs.symlinkSync(path.join(secret, 'gone.md'), ws(sb, 'linked', 'README.md'));
  const projects = path.join(sb.vault, 'brain', 'memory', 'projects');
  write(path.join(projects, 'beta.md'), '---\ntype: memory\ntags: [memory/projects, status/active]\n---\n\n# Beta\n');
  fs.symlinkSync(path.join(secret, 'notes.md'), path.join(projects, 'alpha.md'));
  const proj = path.join(sb.home, 'code', 'proj');
  write(path.join(proj, 'main.c'), 'int main(){}\n');
  const gone = path.join(sb.home, 'code', 'gone');
  thread(sb, 'alpha', 't1', [{ t: '2026-10-01T10:00:00.000Z', kind: 'prompt', text: 'x' }, { t: '2026-10-01T10:00:01.000Z', kind: 'done', ok: true }]);
  write(idx(sb, 'workspace-maps', 'alpha.json'), '{"schema":1,"files":{}}');
  write(idx(sb, 'BRAIN.md'), '# seed\n');
  // A folder for adopt's move form (terminals only), with an outward link inside: it moves as a link, never followed.
  const loose = path.join(sb.home, 'code', 'loose');
  write(path.join(loose, 'main.py'), 'print(1)\n');
  fs.symlinkSync(path.join(secret, 'notes.md'), path.join(loose, 'notes-link.md'));
  seedSnapshot(sb, []);
  const betaNote = read(path.join(projects, 'beta.md'));

  const before = walk(sb.dir);
  const env = {
    ...process.env, HOME: sb.home, AOS_VAULT: sb.vault, AOS_CONFIG: cfgFile, CLAUDE_CONFIG_DIR: sb.cfg, CODEX_HOME: sb.codex,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(sb.home, 'none.gitconfig'),
  };
  const aos = (args, ok = true) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'aos.js'), 'workspace', ...args], { cwd: sb.vault, env, encoding: 'utf8' });
    if (ok) assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    else assert.notEqual(r.status, 0, `${args.join(' ')} should be refused`);
    return ok ? JSON.parse(r.stdout) : r.stderr;
  };
  assert.deepEqual(aos(['which', '--cwd', ws(sb, 'alpha'), '--json']), { name: 'alpha', slug: 'alpha', via: 'cwd' });
  assert.equal(aos(['new', 'kite', '--git', '--pin', '--json']).pinned, true);
  aos(['new', 'clone-me', '--empty', '--json']);
  aos(['stubs', 'clone-me', '--pin', '--json']);
  aos(['stubs', 'alpha', '--json']);
  // A rescan drops outside rows under the OS temp folder, where this test lives (D21): seed them again before each use.
  seedSnapshot(sb, [proj]);
  assert.equal(aos(['adopt', proj, '--into', 'alpha', '--json']).alias, '~/code/proj');
  seedSnapshot(sb, [gone]);
  aos(['hide', '~/code/gone', '--json']);
  aos(['unhide', '~/code/gone', '--json']);
  const d = aos(['draft', 'alpha', '--json']);
  assert.equal(d.provider, 'heuristic', 'provider none: no model call');
  aos(['set', 'alpha', '--set', '{"summary":"Tide tables."}', '--expect', d.baseHash, '--dry-run', '--json']);
  aos(['set', 'alpha', '--set', '{"summary":"Tide tables.","status":"active"}', '--expect', d.baseHash, '--json']);
  assert.equal(aos(['archive', 'alpha', '--json']).archivedAs, '_archive/alpha');
  aos(['restore', 'alpha', '--json']);
  const b = aos(['archive', 'beta', '--json']);
  assert.deepEqual(b.notes, ['brain/memory/projects/beta.md']);
  assert.deepEqual(b.brainMd, { ok: true }, 'build-brain-md ran in its own process against this vault');
  assert.notEqual(read(idx(sb, 'BRAIN.md')), '# seed\n', 'BRAIN.md was rebuilt');
  assert.equal(aos(['rename', 'alpha', 'alpha-two', '--json']).name, 'alpha-two');
  assert.equal(aos(['adopt', loose, '--name', 'loose-one', '--json']).moved, true);
  aos(['list', '--json']);
  // Refused verbs change nothing either.
  assert.match(aos(['set', 'linked', '--set', '{"pinned":true}', '--json'], false), /symlink/);
  aos(['stubs', 'linked', '--json']);
  assert.match(aos(['adopt', '~/secret', '--into', 'kite', '--json'], false), /not a folder sessions ran in/);
  assert.match(aos(['hide', '~/.claude', '--json'], false), /Claude config dir/);

  const after = walk(sb.dir);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();
  const vaultRel = path.relative(sb.dir, sb.vault);
  const under = (k, ...dirs) => dirs.some((d) => { const p = path.join(vaultRel, d); return k === p || k.startsWith(p + path.sep); });
  const looseRel = path.relative(sb.dir, loose);
  const fromLoose = (k) => k === looseRel || k.startsWith(looseRel + path.sep);
  const stray = changed.filter((k) => !under(k, 'workspaces', path.join('brain', '_index')) && !fromLoose(k));
  assert.deepEqual(stray, [path.join(vaultRel, 'brain', 'memory', 'projects', 'beta.md')], 'only the linked note outside the two trees (and the adopted folder, moved in)');
  // adopt's move form: the folder is gone from home and reappears whole under workspaces/loose-one, its link a link.
  assert.ok(!fs.existsSync(loose));
  for (const k of [...before.keys()].filter(fromLoose).filter((k) => k !== looseRel)) {
    const into = path.join(vaultRel, 'workspaces', 'loose-one', path.relative(looseRel, k));
    assert.equal(after.get(into), before.get(k), `${k} moved unchanged`);
  }
  // Nothing inside the two trees was deleted either (spec §6, SECURITY.md: the verbs delete nothing): every regular
  // file under workspaces/ is still there somewhere (moves keep the hash; workspace.md and .git/ may change), each map
  // its bytes, and every other brain/_index path still exists, a thread file left from Sessions included (D11: untouched).
  const fileHash = (m, k) => (String(m.get(k) || '').startsWith('file ') ? m.get(k).split(' ')[2] : null);
  const hashesUnder = (m, d, keep = () => true) => [...m.keys()].filter((k) => under(k, d) && keep(k)).map((k) => fileHash(m, k)).filter(Boolean);
  const contains = (big, small) => {
    const n = new Map();
    for (const h of big) n.set(h, (n.get(h) || 0) + 1);
    return small.every((h) => { const c = n.get(h) || 0; n.set(h, c - 1); return c > 0; });
  };
  const wsKeep = (k) => path.basename(k) !== 'workspace.md' && !k.split(path.sep).includes('.git');
  assert.ok(contains(hashesUnder(after, 'workspaces', wsKeep), hashesUnder(before, 'workspaces', wsKeep)), 'no file under workspaces/ disappeared');
  const maps = path.join('brain', '_index', 'workspace-maps');
  assert.ok(contains(hashesUnder(after, maps), hashesUnder(before, maps)), 'no map disappeared');
  const sessions = path.join('brain', '_index', 'sessions');
  const threads = (m) => [...m.keys()].filter((k) => under(k, sessions)).map((k) => [k, m.get(k)]);
  assert.deepEqual(threads(after), threads(before), 'a thread file left from Sessions stays where it was, unchanged');
  const lost = [...before.keys()].filter((k) => under(k, path.join('brain', '_index')) && !under(k, maps) && !after.has(k));
  assert.deepEqual(lost, [], 'no other brain/_index path disappeared');
  // …and in it only the status tag line.
  const was = betaNote.split('\n');
  const now = read(path.join(projects, 'beta.md')).split('\n');
  assert.equal(now.length, was.length);
  assert.deepEqual(now.map((l, i) => (l === was[i] ? null : [was[i], l])).filter(Boolean), [['tags: [memory/projects, status/active]', 'tags: [memory/projects, status/archived]']]);
  if (spawnSync('git', ['--version']).status === 0) assert.ok(changed.some((k) => under(k, path.join('workspaces', 'kite', '.git', 'HEAD'))), 'git init ran in the new workspace');
  // Nothing under HOME outside the vault (but the adopted folder, moved in), and every link target as it was.
  assert.deepEqual(changed.filter((k) => !k.startsWith(vaultRel + path.sep) && !fromLoose(k)), []);
  assert.equal(read(path.join(secret, 'notes.md')), 'private\n');
  assert.equal(read(path.join(secret, 'ws.md')), '---\nstatus: done\n---\n');
  assert.ok(!fs.existsSync(path.join(secret, 'missing.md')) && !fs.existsSync(path.join(secret, 'gone.md')));
});
