'use strict';
// collectors/hostSessions.js (spaces-redesign D20, D21, D25, D34): sessions read through the host.js and transcript.js
// seams into brain/_index/session-index.json, credited to workspaces in D20's order, with recent rows, kinds,
// resumability and titles, and the outside list filtered (D21). Every world is a temp vault with its own Claude config
// folder (agenticos.json's claudeConfigDir, no CLAUDE_CONFIG_DIR) and Codex home (hosts.codex.home).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectHostSessions, attachSessions, insideDir, REASONS } = require('../collectors/hostSessions');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const at = (days, hours = 0) => new Date(NOW - days * DAY - hours * HOUR).toISOString();
let seq = 0;
const uuid = () => `0199aaaa-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function world({ claude = true, codex = true, workspaces = {} } = {}) {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hs-')));
  const vault = path.join(T, 'vault');
  const home = path.join(T, 'home');
  const claudeDir = path.join(T, 'claude-config');
  const codexHome = path.join(T, 'codex-home');
  for (const d of [path.join(vault, 'brain', '_index'), path.join(vault, 'workspaces'), home, claudeDir, codexHome]) fs.mkdirSync(d, { recursive: true });
  const cfg = {
    hosts: { claude: { enabled: claude }, codex: { enabled: codex, home: codexHome } },
    claudeConfigDir: claudeDir,
    workspaces: { idleDays: 30, recentSessions: 12, attributeByFiles: true, ...workspaces },
  };
  // env {}: no CLAUDE_CONFIG_DIR or CODEX_HOME, so hostDirs follows agenticos.json alone. tmpDirs stands in for the OS
  // temp folders, which hold this very test; gitCeiling keeps a .git above the world (a temp folder in a checkout) out.
  const opts = { vault, cfg, env: {}, home, tmpDirs: [path.join(T, 'tmp')], now: NOW, gitCeiling: T };
  const W = (n) => path.join(vault, 'workspaces', n);
  const ws = (name, extra = {}) => {
    fs.mkdirSync(W(name), { recursive: true });
    return { name, path: `workspaces/${name}`, absPath: W(name), ...extra };
  };
  return { T, vault, home, claudeDir, codexHome, cfg, opts, W, ws };
}

function writeLines(file, lines, mtimeIso) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeIso) { const t = new Date(mtimeIso); fs.utimesSync(file, t, t); }
  return file;
}

/** A Claude Code transcript, projects/<slug>/<fileId>.jsonl; the slug is deliberately not decodable to the cwd. */
function claudeSession(w, { id = uuid(), fileId = id, slug, cwd, ts = at(1), entrypoint = 'cli', prompt = 'Wire the parser', agentSetting = false, before = [], after = [] } = {}) {
  const dir = slug || (cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : 'no-cwd');
  const file = path.join(w.claudeDir, 'projects', dir, `${fileId}.jsonl`);
  const lines = [
    ...(agentSetting ? [{ type: 'agent-setting', agentSetting: 'default', sessionId: id }] : []),
    ...before,
    { type: 'user', sessionId: id, cwd, timestamp: ts, entrypoint, version: '2.1.0', message: { role: 'user', content: prompt } },
    ...after.map((e) => ({ sessionId: id, timestamp: ts, ...e })),
  ];
  return { id, file: writeLines(file, lines, ts), cwd };
}
const claudeTool = (cwd, name, filePath) => ({ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${++seq}`, name, input: { file_path: filePath } }] } });

/** A Codex rollout under sessions/YYYY/MM/DD (or archived_sessions/), its session_meta first. */
function codexSession(w, { id = uuid(), cwd, ts = at(1), source = 'cli', archived = false, prompt = 'Fix the tide parser', home = w.codexHome, metaExtra = {}, extra = [] } = {}) {
  const dir = archived ? path.join(home, 'archived_sessions') : path.join(home, 'sessions', '2026', '10', '01');
  const file = path.join(dir, `rollout-2026-10-01T10-00-00-${id}.jsonl`);
  const lines = [
    { timestamp: ts, type: 'session_meta', payload: { id, timestamp: ts, cwd, originator: 'codex_cli_rs', cli_version: '0.162.0', source, ...metaExtra } },
    { timestamp: ts, type: 'turn_context', payload: { cwd } },
    ...(prompt ? [{ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }] : []),
    ...extra.map((e) => ({ timestamp: ts, ...e })),
  ];
  return { id, file: writeLines(file, lines, ts), cwd };
}
const codexPatch = (paths) => ({ type: 'event_msg', payload: { type: 'patch_apply_end', call_id: `call-${++seq}`, success: true, changes: Object.fromEntries(paths.map((p) => [p, { type: 'update' }])) } });

function scan(w, list, extra = {}) {
  const opts = { ...w.opts, ...extra };
  const collected = collectHostSessions(opts);
  const outside = attachSessions(list, collected, opts);
  return { collected, outside };
}
const counts = (s) => ({ claude: s.claude, codex: s.codex, total: s.total });
const vias = (ws) => ws.sessions.recent.map((r) => r.via);
const readIndex = (w) => JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'session-index.json'), 'utf8'));

test('cwd: workspace names with -, _, . and spaces; a first line with no cwd; the slug is never decoded; one 30-day window', () => {
  const w = world();
  const list = ['my-app', 'snake_case', 'dot.name', 'with space'].map((n) => w.ws(n));
  fs.mkdirSync(path.join(w.W('my-app'), 'src'));
  const first = claudeSession(w, { cwd: path.join(w.W('my-app'), 'src'), agentSetting: true, ts: at(0, 3) });
  claudeSession(w, { cwd: w.W('snake_case') });
  claudeSession(w, { cwd: path.join(w.W('dot.name'), 'a.b') });
  claudeSession(w, { cwd: w.W('with space') });
  codexSession(w, { cwd: w.W('my-app'), ts: at(2) });
  codexSession(w, { cwd: w.W('my-app'), ts: at(40) }); // older than workspaces.idleDays: not counted, still listed
  const { outside } = scan(w, list);
  assert.deepEqual(counts(list[0].sessions), { claude: 1, codex: 1, total: 2 });
  assert.equal(list[0].sessions.windowDays, 30);
  assert.equal(list[0].sessions.lastAt, at(0, 3));
  assert.deepEqual(vias(list[0]), ['cwd', 'cwd', 'cwd']);
  assert.deepEqual(list[0].sessions.recent[0], {
    id: first.id, host: 'claude', format: 'claude', kind: 'interactive', title: 'Wire the parser', titleSource: 'prompt',
    startedAt: at(0, 3), lastAt: at(0, 3), cwd: path.join(w.W('my-app'), 'src'), startExists: true, via: 'cwd', resumable: true, reason: null,
  });
  assert.equal(list[0].sessions.recent[2].lastAt, at(40), 'recent shows what remains past the window');
  for (const ws of list.slice(1)) assert.deepEqual(counts(ws.sessions), { claude: 1, codex: 0, total: 1 }, ws.name);
  assert.deepEqual(outside, []);
});

test('worktrees: live and vanished in both _worktrees layouts, a beside a-b with an -NN suffix, <repo>.worktrees and .worktrees/<ws>; _worktrees is never a target', () => {
  const w = world();
  const proj = w.ws('proj');
  fs.mkdirSync(path.join(proj.absPath, '.git', 'worktrees'), { recursive: true });
  const proj2 = w.ws('proj2');
  const a = w.ws('a');
  const ab = w.ws('a-b');
  const code = path.join(w.T, 'code', 'app');
  fs.mkdirSync(code, { recursive: true });
  const linked = w.ws('linked', { repoPath: code });
  const legacyEntry = { name: '_worktrees', absPath: w.W('_worktrees') }; // as an older collector listed it
  writeLines(path.join(w.vault, 'persona', 'teams', 'dev', 'board.jsonl'), [
    { schema: 1, id: 'proj2-01', path: 'workspaces/proj2', ts: at(3) },
    { schema: 1, id: 'legacy-07', path: 'workspaces/proj2', ts: at(3) },
  ]);
  const WT = w.W('_worktrees');
  const liveSeat = (rel) => {
    const d = path.join(WT, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.git'), `gitdir: ${path.join(proj.absPath, '.git', 'worktrees', path.basename(rel))}\n`);
    return d;
  };
  const s1 = codexSession(w, { cwd: liveSeat(path.join('dev', 'x-01', 'builder')), source: 'exec', ts: at(1) }); // live, today's layout
  const s2 = claudeSession(w, { cwd: liveSeat(path.join('y-02', 'builder')), entrypoint: 'sdk-cli', ts: at(1, 1) }); // live, older layout
  const s3 = codexSession(w, { cwd: path.join(WT, 'dev', 'proj2-01', 'builder'), source: 'exec' }); // vanished: the team's board
  const s4 = claudeSession(w, { cwd: path.join(WT, 'legacy-07', 'reviewer'), entrypoint: 'sdk-cli' }); // vanished, older layout: item id
  const s5 = codexSession(w, { cwd: path.join(WT, 'a-b-01', 'builder'), source: 'exec' }); // by name: a-b, the longest
  const s6 = codexSession(w, { cwd: path.join(WT, 'a-03', 'builder'), source: 'exec' }); // by name: a
  codexSession(w, { cwd: path.join(WT, 'other', 'zzz-01', 'builder'), source: 'exec' }); // nothing matches: infrastructure, not outside
  const s8 = claudeSession(w, { cwd: path.join(w.T, 'code', 'app.worktrees', 'feat', 'src') }); // <repo>.worktrees/* of a repo: folder
  fs.mkdirSync(path.join(code, 'src'));
  const s10 = claudeSession(w, { cwd: path.join(code, 'src'), ts: at(2) }); // inside the repo: folder itself (spec 2026-10-08 T8)
  const s9 = codexSession(w, { cwd: path.join(w.W('.worktrees'), 'proj', 'sub'), ts: at(1, 2) }); // workspaces/.worktrees/<ws>/*
  const list = [proj, proj2, a, ab, linked, legacyEntry];
  const { outside } = scan(w, list);
  const ids = (ws) => ws.sessions.recent.map((r) => r.id).sort();
  assert.deepEqual(ids(proj), [s1.id, s2.id, s9.id].sort());
  assert.deepEqual(counts(proj.sessions), { claude: 1, codex: 2, total: 3 });
  assert.deepEqual(vias(proj), ['worktree', 'worktree', 'worktree']);
  assert.deepEqual(proj.sessions.recent.map((r) => [r.kind, r.resumable]), [['team', false], ['team', false], ['interactive', true]], 'a seat folder is a team run');
  assert.equal(proj.sessions.recent[0].reason, REASONS.team);
  assert.deepEqual(ids(proj2), [s3.id, s4.id].sort());
  assert.deepEqual(ids(ab), [s5.id]);
  assert.deepEqual(ids(a), [s6.id]);
  assert.deepEqual(ids(linked), [s8.id, s10.id].sort());
  assert.deepEqual(vias(linked), ['worktree', 'cwd']);
  assert.deepEqual(counts(legacyEntry.sessions), { claude: 0, codex: 0, total: 0 }, '_worktrees is never a target');
  assert.deepEqual(outside, []);
});

test('vanished seats: a team named like a workspace never takes its seats; the item segment decides, per layout', () => {
  const w = world();
  const dev = w.ws('dev');
  const menubar = w.ws('menubar');
  const WT = w.W('_worktrees');
  const board = (team, rows) => writeLines(path.join(w.vault, 'persona', 'teams', team, 'board.jsonl'), rows);
  board('dev', [
    { schema: 1, id: 'menubar-01', path: null, ts: at(3) }, // no path on the board (writeItem's default)
    { schema: 1, id: 'menubar-02', path: 'workspaces/deleted', ts: at(3) }, // a path to a workspace that is gone
  ]);
  const s1 = codexSession(w, { cwd: path.join(WT, 'dev', 'menubar-01', 'woz'), source: 'exec', ts: at(1) });
  const s2 = codexSession(w, { cwd: path.join(WT, 'dev', 'menubar-02', 'woz'), source: 'exec', ts: at(1, 1) });
  const s3 = codexSession(w, { cwd: path.join(WT, 'dev-gone', 'menubar-03', 'woz'), source: 'exec', ts: at(1, 2) }); // its team folder removed
  const s4 = claudeSession(w, { cwd: path.join(WT, 'dev-04', 'builder'), entrypoint: 'sdk-cli', ts: at(1, 3) }); // older layout: by the item's name
  claudeSession(w, { cwd: path.join(WT, 'zzz-05', 'menubar'), entrypoint: 'sdk-cli', ts: at(1, 4) }); // older layout: a member named like a workspace
  const { outside } = scan(w, [dev, menubar]);
  const ids = (ws) => ws.sessions.recent.map((r) => r.id).sort();
  assert.deepEqual(ids(menubar), [s1.id, s2.id, s3.id].sort(), 'never the member folder\'s name');
  assert.deepEqual(vias(menubar), ['worktree', 'worktree', 'worktree']);
  assert.deepEqual(ids(dev), [s4.id], 'the team dev took none of its seats');
  assert.deepEqual(outside, [], 'a seat nothing claims is infrastructure, not an outside folder');
});

test('outside: home, both config folders, temp, the vault outside workspaces/ and hidden paths dropped; exists, match, git, worktrees folded', () => {
  const w = world();
  const list = [w.ws('harbor'), w.ws('field-notes'), w.ws('_spikes', { hidden: true })];
  const tmp = path.join(w.T, 'tmp');
  const repo = path.join(w.T, 'code', 'repo');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const wt = path.join(w.T, 'code', 'repo-wt');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  const harborCode = path.join(w.T, 'code', 'Harbor');
  const sketches = path.join(w.home, 'sketches');
  const hiddenDir = path.join(w.T, 'hidden-me');
  for (const d of [harborCode, sketches, hiddenDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(w.vault, 'brain', '_index', 'workspaces-hidden.json'), JSON.stringify({ schema: 1, paths: [hiddenDir] }));
  const gone = path.join(w.T, 'gone', 'proj');
  const deleted = w.W('deleted-one');
  const notes = path.join(w.T, 'docs', 'Field Notes');
  const spikes = path.join(w.T, 'docs', '_spikes');
  // dropped
  claudeSession(w, { cwd: w.home });
  codexSession(w, { cwd: path.join(w.claudeDir, 'plugins', 'x') });
  claudeSession(w, { cwd: path.join(w.codexHome, 'worktrees', 'y') });
  codexSession(w, { cwd: path.join(tmp, 'job-1') });
  claudeSession(w, { cwd: w.vault });
  codexSession(w, { cwd: path.join(w.vault, 'brain') });
  claudeSession(w, { cwd: w.W('') });
  codexSession(w, { cwd: path.join(hiddenDir, 'sub') });
  codexSession(w, { cwd: w.W('_archive') }); // the archive folder itself is infrastructure (D22)
  claudeSession(w, { cwd: path.join(w.W('scratch'), 'notes') }); // the deck's Scratch place, even once it is gone (D21)
  // kept
  claudeSession(w, { cwd: sketches, ts: at(1) });
  codexSession(w, { cwd: gone, ts: at(2) });
  claudeSession(w, { cwd: harborCode, ts: at(3) });
  codexSession(w, { cwd: repo, ts: at(4) });
  claudeSession(w, { cwd: path.join(wt, 'src'), ts: at(4, 1) });
  codexSession(w, { cwd: deleted, ts: at(5) });
  claudeSession(w, { cwd: notes, ts: at(6) });
  claudeSession(w, { cwd: spikes, ts: at(7) });
  const { outside } = scan(w, list);
  assert.deepEqual(outside, [
    { cwd: sketches, claude: 1, codex: 0, total: 1, lastAt: at(1), exists: true, match: null, git: null, worktrees: 0 },
    { cwd: gone, claude: 0, codex: 1, total: 1, lastAt: at(2), exists: false, match: null, git: null, worktrees: 0 },
    { cwd: harborCode, claude: 1, codex: 0, total: 1, lastAt: at(3), exists: true, match: 'harbor', git: null, worktrees: 0 },
    { cwd: repo, claude: 1, codex: 1, total: 2, lastAt: at(4), exists: true, match: null, git: { root: repo, branch: 'main' }, worktrees: 1 },
    { cwd: deleted, claude: 0, codex: 1, total: 1, lastAt: at(5), exists: false, match: null, git: null, worktrees: 0 },
    { cwd: notes, claude: 1, codex: 0, total: 1, lastAt: at(6), exists: false, match: 'field-notes', git: null, worktrees: 0 }, // names compared as slugs
    { cwd: spikes, claude: 1, codex: 0, total: 1, lastAt: at(7), exists: false, match: null, git: null, worktrees: 0 }, // never a hidden entry
  ]);
});

test('outside: a vanished <repo>.worktrees/<x> folds into <repo> only below home, as git is never looked for at or above home', () => {
  const w = world();
  const repo = path.join(w.T, 'code', 'app');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  // A home inside a live checkout of `app` (a fixture built in a worktree): its vanished ~/sketches is no part of `app`.
  const checkout = path.join(w.T, 'code', 'app.worktrees', 'wt');
  const home = path.join(checkout, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const sketches = path.join(home, 'sketches');
  codexSession(w, { cwd: sketches, ts: at(1) });
  claudeSession(w, { cwd: path.join(proj + '.worktrees', 'feat', 'src'), ts: at(2) }); // below home: folds as before
  const { outside } = scan(w, [], { home });
  assert.deepEqual(outside, [
    { cwd: sketches, claude: 0, codex: 1, total: 1, lastAt: at(1), exists: false, match: null, git: null, worktrees: 0 },
    { cwd: proj, claude: 1, codex: 0, total: 1, lastAt: at(2), exists: true, match: null, git: { root: proj, branch: 'main' }, worktrees: 1 },
  ]);
});

test('outside: the OS temp folders are dropped by default; a Claude transcript with no cwd falls back to its decoded slug', () => {
  const w = world();
  const tmpReal = fs.realpathSync(os.tmpdir());
  for (const cwd of ['/tmp/aos-job', '/private/tmp/aos-job', '/var/folders/zz/x/T/job', '/private/var/folders/zz/x/T/job', path.join(os.tmpdir(), 'aos-job'), path.join(tmpReal, 'aos-job-2')]) {
    codexSession(w, { cwd });
  }
  codexSession(w, { cwd: path.join(path.sep, 'opt', 'sample', 'sandbox'), ts: at(1) });
  claudeSession(w, { cwd: undefined, slug: '-opt-sample-scratchpad', ts: at(2) });
  const opts = { ...w.opts };
  delete opts.tmpDirs;
  const outside = attachSessions([], collectHostSessions(opts), opts);
  assert.deepEqual(outside.map((o) => [o.cwd, o.exists]), [[path.join(path.sep, 'opt', 'sample', 'sandbox'), false], [path.join(path.sep, 'opt', 'sample', 'scratchpad'), false]]);
});

test('aliases are roots: a former folder (workspaces/<old>) and a ~/ path re-attribute, by cwd and by worktree name', () => {
  const w = world();
  const c1 = claudeSession(w, { cwd: path.join(w.W('old-name'), 'x') });
  const c2 = codexSession(w, { cwd: path.join(w.home, 'elsewhere', 'sub') });
  const c3 = codexSession(w, { cwd: path.join(w.W('_worktrees'), 'old-name-01', 'builder'), source: 'exec' });
  const bare = [w.ws('new-name')];
  const { outside } = scan(w, bare);
  assert.deepEqual(counts(bare[0].sessions), { claude: 0, codex: 0, total: 0 });
  assert.deepEqual(outside.map((o) => o.cwd).sort(), [path.join(w.W('old-name'), 'x'), path.join(w.home, 'elsewhere', 'sub')].sort());
  const aliased = [w.ws('new-name', { aliases: ['workspaces/old-name', '~/elsewhere'] })];
  const r = scan(w, aliased);
  assert.deepEqual(counts(aliased[0].sessions), { claude: 1, codex: 2, total: 3 });
  const byId = Object.fromEntries(aliased[0].sessions.recent.map((x) => [x.id, x.via]));
  assert.deepEqual(byId, { [c1.id]: 'cwd', [c2.id]: 'cwd', [c3.id]: 'worktree' });
  assert.deepEqual(r.outside, []);
});

test('files: a vault-root session goes to the workspace its touches hit most (>= 3, no tie), per format; attributeByFiles turns it off', () => {
  const w = world();
  const x = w.ws('x');
  const y = w.ws('y');
  const X = (f) => path.join(x.absPath, f);
  const Y = (f) => path.join(y.absPath, f);
  const c = claudeSession(w, { cwd: w.vault, after: [claudeTool(w.vault, 'Edit', X('a.md')), claudeTool(w.vault, 'Write', X('b.md')), claudeTool(w.vault, 'Read', X('a.md')), claudeTool(w.vault, 'Edit', Y('c.md'))] });
  const k = codexSession(w, { cwd: w.vault, extra: [codexPatch([X('a.md'), X('b.md'), X('c.md')])] });
  claudeSession(w, { cwd: w.vault, after: [X('1'), X('2'), X('3'), Y('1'), Y('2'), Y('3')].map((p) => claudeTool(w.vault, 'Edit', p)) }); // a tie
  codexSession(w, { cwd: path.join(w.vault, 'brain'), extra: [codexPatch([X('a.md'), X('b.md')])] }); // two touches: too few
  const inX = codexSession(w, { cwd: x.absPath });
  const list = [x, y];
  const { outside } = scan(w, list);
  assert.deepEqual(counts(x.sessions), { claude: 1, codex: 2, total: 3 });
  assert.deepEqual(Object.fromEntries(x.sessions.recent.map((r) => [r.id, r.via])), { [c.id]: 'files', [k.id]: 'files', [inX.id]: 'cwd' });
  assert.deepEqual(counts(y.sessions), { claude: 0, codex: 0, total: 0 });
  assert.deepEqual(outside, [], 'the unclaimed vault-root sessions are the brain at work, not a stray project');
  const idx = readIndex(w);
  assert.equal(idx.files[inX.file].touches, null, 'a session started in a workspace never has its touches read');
  assert.equal(idx.files[k.file].touches[X('c.md')], 1);
  const off = [w.ws('x'), w.ws('y')];
  scan(w, off, { cfg: { ...w.cfg, workspaces: { ...w.cfg.workspaces, attributeByFiles: false } } });
  assert.deepEqual(counts(off[0].sessions), { claude: 0, codex: 1, total: 1 });
});

test('subagents: a thread_spawn rollout folds into its parent, a guardian and an orphan are dropped; a session_meta over 64 KB still has its cwd', () => {
  const w = world();
  const p = w.ws('p');
  const parent = codexSession(w, { cwd: p.absPath, ts: at(3) });
  codexSession(w, { cwd: p.absPath, ts: at(1), source: { subagent: { thread_spawn: { parent_thread_id: parent.id, depth: 1 } } }, metaExtra: { parent_thread_id: parent.id } });
  codexSession(w, { cwd: p.absPath, ts: at(0, 2), source: { subagent: { other: 'guardian' } }, metaExtra: { parent_thread_id: parent.id } });
  codexSession(w, { cwd: p.absPath, ts: at(0, 1), source: { subagent: { thread_spawn: { parent_thread_id: uuid(), depth: 1 } } } });
  // A nested subagent (depth 2) climbs through its depth-1 parent to the thread at the top, with its touches.
  const vault = codexSession(w, { cwd: w.vault, ts: at(5) });
  const X = (f) => path.join(p.absPath, f);
  const mid = codexSession(w, { cwd: w.vault, ts: at(4, 2), source: { subagent: { thread_spawn: { parent_thread_id: vault.id, depth: 1 } } }, prompt: null });
  codexSession(w, { cwd: w.vault, ts: at(4, 1), source: { subagent: { thread_spawn: { parent_thread_id: mid.id, depth: 2 } } }, prompt: null,
    extra: [codexPatch([X('a.md'), X('b.md'), X('c.md')])] });
  const big = codexSession(w, { cwd: p.absPath, ts: at(2), metaExtra: { base_instructions: { text: 'x'.repeat(70 * 1024) } } });
  assert.ok(fs.readFileSync(big.file, 'utf8').indexOf('\n') > 64 * 1024, 'the first line is longer than the old 64 KB read');
  scan(w, [p]);
  assert.deepEqual(counts(p.sessions), { claude: 0, codex: 3, total: 3 });
  assert.deepEqual(p.sessions.recent.map((r) => [r.id, r.lastAt, r.via]), [[parent.id, at(1), 'cwd'], [big.id, at(2), 'cwd'], [vault.id, at(4, 1), 'files']],
    'the parent moved when its subagent did; the nested subagent\'s edits credited the vault-root thread');
});

test('team: a seat in runs.jsonl is credited through its board item\'s path, for both providers', () => {
  const w = world();
  const tp = w.ws('tp');
  const c = claudeSession(w, { cwd: path.join(w.T, 'seat-claude'), entrypoint: 'sdk-cli', ts: at(1) });
  const x = codexSession(w, { cwd: path.join(w.T, 'seat-codex'), source: 'exec', ts: at(2) });
  const team = path.join(w.vault, 'persona', 'teams', 'dev');
  writeLines(path.join(team, 'board.jsonl'), [{ schema: 1, id: 'demo-01', path: 'workspaces/tp', ts: at(3) }]);
  writeLines(path.join(team, 'runs.jsonl'), [
    { schema: 1, team: 'dev', member: 'builder', item: 'demo-01', provider: 'claude', session: c.id, status: 'ok' },
    { schema: 1, team: 'dev', member: 'platform', item: 'demo-01', provider: 'codex', session: x.id, status: 'ok' },
    { schema: 1, team: 'dev', member: 'reviewer', item: 'demo-01', provider: 'codex', session: null, status: 'failed' },
  ]);
  const { outside } = scan(w, [tp]);
  assert.deepEqual(counts(tp.sessions), { claude: 1, codex: 1, total: 2 });
  assert.deepEqual(tp.sessions.recent.map((r) => [r.id, r.via, r.kind, r.resumable, r.reason]), [
    [c.id, 'team', 'team', false, REASONS.team],
    [x.id, 'team', 'team', false, REASONS.team],
  ]);
  assert.deepEqual(outside, []);
});

test('kind and resumable per row of spec §4, with the UUID equal to the file name\'s id; a session the app ran is a plain headless row (remove-sessions D5)', () => {
  const w = world();
  const k = w.ws('k');
  const rows = {
    claudeCli: claudeSession(w, { cwd: k.absPath, ts: at(0, 1) }),
    claudeSdk: claudeSession(w, { cwd: k.absPath, entrypoint: 'sdk-cli', ts: at(0, 2) }),
    codexCli: codexSession(w, { cwd: k.absPath, source: 'cli', ts: at(0, 3) }),
    codexVscode: codexSession(w, { cwd: k.absPath, source: 'vscode', ts: at(0, 4) }),
    codexExec: codexSession(w, { cwd: k.absPath, source: 'exec', ts: at(0, 5) }),
    codexMcp: codexSession(w, { cwd: k.absPath, source: 'mcp', ts: at(0, 5.5) }),
    codexArchived: codexSession(w, { cwd: k.absPath, source: 'cli', archived: true, ts: at(0, 6) }),
    app: claudeSession(w, { cwd: k.absPath, entrypoint: 'sdk-cli', ts: at(0, 7) }),
    notUuid: claudeSession(w, { id: 'not-a-uuid', cwd: k.absPath, ts: at(0, 8) }),
    mismatch: claudeSession(w, { id: uuid(), fileId: uuid(), cwd: k.absPath, ts: at(0, 9) }),
    upper: claudeSession(w, { id: 'ABCDEF01-0000-4000-8000-000000000001', cwd: k.absPath, ts: at(0, 10) }),
    noId: codexSession(w, { cwd: k.absPath, ts: at(0, 11), metaExtra: { id: undefined } }),
  };
  writeLines(path.join(w.vault, 'brain', '_index', 'sessions', 'k', 'th-1.jsonl'), [
    { schema: 1, kind: 'meta', thread: 'th-1', workspace: 'k', host: 'claude', model: null, effort: null, title: 'Plan the week', created: at(1) },
    { t: at(1), kind: 'prompt', text: 'Plan the week', turn: 1 },
    { t: at(1), kind: 'session', id: rows.app.id, turn: 1 },
  ]);
  scan(w, [k]);
  const nameOf = (id) => Object.keys(rows).find((n) => rows[n].id === id);
  const got = Object.fromEntries(k.sessions.recent.map((r) => [nameOf(r.id), [r.kind, r.via, r.resumable, r.reason]]));
  assert.deepEqual(got, {
    claudeCli: ['interactive', 'cwd', true, null],
    claudeSdk: ['headless', 'cwd', false, REASONS.headless],
    codexCli: ['interactive', 'cwd', true, null],
    codexVscode: ['interactive', 'cwd', true, null],
    codexExec: ['headless', 'cwd', true, null], // codex resume <id> takes any recorded thread (codex-cli 0.162.0)
    codexMcp: ['headless', 'cwd', true, null], // the same rule
    codexArchived: ['interactive', 'cwd', false, REASONS.archived],
    app: ['headless', 'app', false, REASONS.headless],
    notUuid: ['interactive', 'cwd', false, REASONS.idMismatch],
    mismatch: ['interactive', 'cwd', false, REASONS.idMismatch],
    upper: ['interactive', 'cwd', false, REASONS.idMismatch],
    noId: ['interactive', 'cwd', false, REASONS.noId],
  });
  assert.equal(k.sessions.recent.find((r) => r.id === rows.app.id).thread, 'th-1', 'kept until remove-sessions PR 2');
  assert.equal(REASONS.app, undefined, 'no row says to open it in Sessions');
});

test('remove-sessions D5: a Codex exec thread the app ran resumes by id, as any exec thread', () => {
  const w = world();
  const k = w.ws('k');
  const run = codexSession(w, { cwd: k.absPath, source: 'exec', ts: at(0, 1) });
  writeLines(path.join(w.vault, 'brain', '_index', 'sessions', 'k', 'th-2.jsonl'), [
    { schema: 1, kind: 'meta', thread: 'th-2', workspace: 'k', host: 'codex', model: null, effort: null, title: 'Sketch the layer', created: at(1) },
    { t: at(1), kind: 'prompt', text: 'Sketch the layer', turn: 1 },
    { t: at(1), kind: 'session', id: run.id, turn: 1 },
  ]);
  scan(w, [k]);
  const r = k.sessions.recent.find((x) => x.id === run.id);
  assert.deepEqual([r.kind, r.via, r.resumable, r.reason], ['headless', 'app', true, null]);
});

test('titles: custom over ai in the tail, the head\'s when the tail has none, Codex session_index.jsonl, else the first real prompt cut to 80', () => {
  const w = world();
  const t = w.ws('t');
  const ai = claudeSession(w, { cwd: t.absPath, ts: at(0, 1), after: [{ type: 'ai-title', aiTitle: 'Generated in the tail' }] });
  const custom = claudeSession(w, { cwd: t.absPath, ts: at(0, 2), after: [{ type: 'custom-title', customTitle: 'My rename' }, { type: 'ai-title', aiTitle: 'A later guess' }] });
  const pad = Array.from({ length: 300 }, () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(1000) }] } }));
  const headOnly = claudeSession(w, { cwd: t.absPath, ts: at(0, 3), before: [{ type: 'ai-title', aiTitle: 'From the head' }], after: pad });
  assert.ok(fs.statSync(headOnly.file).size > 256 * 1024);
  const named = codexSession(w, { cwd: t.absPath, ts: at(0, 4) });
  writeLines(path.join(w.codexHome, 'session_index.jsonl'), [
    { id: named.id, thread_name: 'Old name', updated_at: at(2) },
    { id: named.id, thread_name: 'Named in Codex', updated_at: at(1) },
  ]);
  const long = `Fix   the tide parser so that ${'every line of the sample table parses '.repeat(4)}`;
  const prompt = codexSession(w, { cwd: t.absPath, ts: at(0, 5), prompt: '<environment_context>\n  <cwd>x</cwd>\n</environment_context>', extra: [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: long }] } }] });
  scan(w, [t]);
  const byId = Object.fromEntries(t.sessions.recent.map((r) => [r.id, [r.title, r.titleSource]]));
  assert.deepEqual(byId[ai.id], ['Generated in the tail', 'ai']);
  assert.deepEqual(byId[custom.id], ['My rename', 'custom']);
  assert.deepEqual(byId[headOnly.id], ['From the head', 'ai']);
  assert.deepEqual(byId[named.id], ['Named in Codex', 'index']);
  assert.deepEqual(byId[prompt.id], [long.replace(/\s+/g, ' ').trim().slice(0, 80).trimEnd(), 'prompt']);
});

test('startExists is false for a start folder that is gone', () => {
  const w = world();
  const g = w.ws('g');
  claudeSession(w, { cwd: path.join(g.absPath, 'removed'), ts: at(0, 1) });
  codexSession(w, { cwd: g.absPath, ts: at(0, 2) });
  scan(w, [g]);
  assert.deepEqual(g.sessions.recent.map((r) => [r.via, r.startExists]), [['cwd', false], ['cwd', true]]);
});

test('session-index.json: schema 1 rows per file, appended lines read incrementally, unchanged files not reopened, a new hosts.codex.home drops its rows, a host turned off keeps them', () => {
  const w = world();
  const x = w.ws('x');
  const X = (f) => path.join(x.absPath, f);
  const c = claudeSession(w, { cwd: w.vault, ts: at(0, 2), after: [claudeTool(w.vault, 'Edit', X('a.md')), claudeTool(w.vault, 'Edit', X('b.md'))] });
  const k = codexSession(w, { cwd: x.absPath, ts: at(0, 3) });
  let list = [w.ws('x')];
  scan(w, list);
  assert.deepEqual(counts(list[0].sessions), { claude: 0, codex: 1, total: 1 }, 'two touches are not enough yet');
  let idx = readIndex(w);
  assert.equal(idx.schema, 1);
  assert.deepEqual(Object.keys(idx.files).sort(), [c.file, k.file].sort());
  const row = idx.files[c.file];
  for (const key of ['host', 'format', 'size', 'mtime', 'offset', 'head', 'title', 'titleSource', 'touches']) assert.ok(key in row, key);
  assert.deepEqual([row.host, row.format, row.offset, row.head.startCwd], ['claude', 'claude', fs.statSync(c.file).size, w.vault]);
  assert.deepEqual(row.touches, { [w.vault]: 3, [X('a.md')]: 1, [X('b.md')]: 1 });

  // An append is read from the stored offset: one more edit tips the files credit.
  fs.appendFileSync(c.file, JSON.stringify({ sessionId: c.id, timestamp: at(0, 1), ...claudeTool(w.vault, 'Edit', X('c.md')) }) + '\n');
  list = [w.ws('x')];
  scan(w, list);
  assert.deepEqual(counts(list[0].sessions), { claude: 1, codex: 1, total: 2 });
  assert.equal(list[0].sessions.recent.find((r) => r.id === c.id).lastAt, at(0, 1), 'the tail was read again');
  idx = readIndex(w);
  assert.deepEqual(idx.files[c.file].touches, { [w.vault]: 4, [X('a.md')]: 1, [X('b.md')]: 1, [X('c.md')]: 1 });
  assert.equal(idx.files[c.file].offset, fs.statSync(c.file).size);

  // Same size and mtime: the cached row stands, whatever the bytes now say.
  const st = fs.statSync(k.file);
  fs.writeFileSync(k.file, 'z'.repeat(st.size - 1) + '\n');
  fs.utimesSync(k.file, new Date(at(0, 3)), new Date(at(0, 3)));
  list = [w.ws('x')];
  scan(w, list);
  assert.equal(list[0].sessions.recent.find((r) => r.host === 'codex').id, k.id);

  // A new Codex home: the old rollouts' rows go, the new home's are read.
  const home2 = path.join(w.T, 'codex-2');
  const k2 = codexSession(w, { cwd: x.absPath, home: home2 });
  const cfg2 = { ...w.cfg, hosts: { ...w.cfg.hosts, codex: { enabled: true, home: home2 } } };
  scan(w, [w.ws('x')], { cfg: cfg2 });
  assert.deepEqual(Object.keys(readIndex(w).files).sort(), [c.file, k2.file].sort());

  // Codex off: its threads still count and keep their rows (spec §4's matrix, D31: shown with Resume off).
  const cfg3 = { ...w.cfg, hosts: { ...w.cfg.hosts, codex: { enabled: false, home: home2 } } };
  list = [w.ws('x')];
  scan(w, list, { cfg: cfg3 });
  assert.deepEqual(Object.keys(readIndex(w).files).sort(), [c.file, k2.file].sort());
  assert.deepEqual(counts(list[0].sessions), { claude: 1, codex: 1, total: 2 });
});

test('session-index.json is not rewritten while a transcript\'s last line is still unfinished', () => {
  const w = world();
  const x = w.ws('x');
  const c = claudeSession(w, { cwd: w.vault, ts: at(0, 2), after: [claudeTool(w.vault, 'Edit', path.join(x.absPath, 'a.md'))] });
  fs.appendFileSync(c.file, JSON.stringify({ sessionId: c.id, timestamp: at(0, 1), type: 'assistant' }).slice(0, 40)); // cut mid-write
  scan(w, [w.ws('x')]);
  const file = path.join(w.vault, 'brain', '_index', 'session-index.json');
  const before = readIndex(w).files[c.file];
  assert.ok(before.offset < fs.statSync(c.file).size, 'the unfinished line is not read yet');
  const past = new Date(NOW - DAY);
  fs.utimesSync(file, past, past);
  scan(w, [w.ws('x')]);
  // By age, not to the millisecond: utimes passes seconds as a double, and Linux truncates the nanoseconds, so a past
  // of …672 ms can read back as …671.999. A rewrite would stamp the file with the current time.
  assert.ok(fs.statSync(file).mtimeMs < NOW - DAY / 2, 'nothing changed, so the cache was left alone');
  fs.appendFileSync(c.file, '\n' + JSON.stringify({ sessionId: c.id, timestamp: at(0, 1), ...claudeTool(w.vault, 'Edit', path.join(x.absPath, 'b.md')) }) + '\n');
  scan(w, [w.ws('x')]);
  assert.ok(readIndex(w).files[c.file].touches[path.join(x.absPath, 'b.md')], 'once the line ends, its touches are read');
});

test('two transcripts naming one session id count once: the file named for the id is kept, the stub folds in', () => {
  const w = world();
  const d = w.ws('d');
  const real = claudeSession(w, { cwd: d.absPath, ts: at(1) });
  claudeSession(w, { id: real.id, fileId: uuid(), cwd: d.absPath, ts: at(0, 5), prompt: 'stub' }); // a stub carrying the real id
  const thread = claudeSession(w, { cwd: d.absPath, ts: at(2) });
  claudeSession(w, { id: thread.id, fileId: uuid(), cwd: d.absPath, ts: at(2, 1) });
  writeLines(path.join(w.vault, 'brain', '_index', 'sessions', 'd', 'th-9.jsonl'), [
    { schema: 1, kind: 'meta', thread: 'th-9', workspace: 'd', host: 'claude', title: 'x', created: at(3) },
    { t: at(3), kind: 'session', id: thread.id, turn: 1 },
  ]);
  scan(w, [d]);
  assert.deepEqual(counts(d.sessions), { claude: 2, codex: 0, total: 2 });
  assert.deepEqual(d.sessions.recent.map((r) => [r.id, r.lastAt, r.via, r.resumable]), [
    [real.id, at(0, 5), 'cwd', true],
    [thread.id, at(2), 'app', true],
  ]);
});

test('per host: a Codex-only machine, a Claude-only one and a config without hosts all read both hosts (spec §4: threads of a host that is off show with Resume off)', () => {
  for (const hostsCfg of [
    { claude: { enabled: false }, codex: { enabled: true } },
    { claude: { enabled: true }, codex: { enabled: false } },
    undefined,
  ]) {
    const w = world();
    const h = w.ws('h');
    claudeSession(w, { cwd: h.absPath });
    codexSession(w, { cwd: h.absPath });
    const cfg = { ...w.cfg, hosts: hostsCfg && { ...hostsCfg, codex: { ...hostsCfg.codex, home: w.codexHome } } };
    if (!hostsCfg) delete cfg.hosts;
    // Without hosts.codex.home the Codex home comes from CODEX_HOME, which this world sets to its own folder.
    scan(w, [h], { cfg, env: { CODEX_HOME: w.codexHome } });
    assert.deepEqual(counts(h.sessions), { claude: 1, codex: 1, total: 2 }, JSON.stringify(hostsCfg));
    assert.deepEqual(Object.values(readIndex(w).files).map((r) => r.host).sort(), ['claude', 'codex']);
  }
});

test('recent is capped at workspaces.recentSessions, newest first; counts cover workspaces.idleDays (sessions.windowDays)', () => {
  const w = world({ workspaces: { recentSessions: 2, idleDays: 2 } });
  const r = w.ws('r');
  const made = [0.5, 1.5, 2.5, 3.5, 4.5].map((d) => claudeSession(w, { cwd: r.absPath, ts: at(d) }));
  scan(w, [r]);
  assert.deepEqual(counts(r.sessions), { claude: 2, codex: 0, total: 2 });
  assert.equal(r.sessions.windowDays, 2);
  assert.equal(r.sessions.lastAt, at(0.5));
  assert.deepEqual(r.sessions.recent.map((x) => x.id), [made[0].id, made[1].id]);
});

test('a hand-edited window that is not a whole number of days falls back to the default, as finalizeWorkspaces does', () => {
  for (const bad of [0, 2.5, -1, '7']) {
    const w = world({ workspaces: { idleDays: bad, recentSessions: bad } });
    const r = w.ws('r');
    claudeSession(w, { cwd: r.absPath, ts: at(20) });
    scan(w, [r]);
    assert.equal(r.sessions.windowDays, 30, String(bad));
    assert.deepEqual(counts(r.sessions), { claude: 1, codex: 0, total: 1 }, String(bad));
    assert.equal(r.sessions.recent.length, 1, String(bad));
  }
});

test('attachSessions stays callable as today: with collectHostSessions()\'s byCwd, its whole result, or options alone', () => {
  const w = world();
  const a = w.ws('a');
  claudeSession(w, { cwd: a.absPath });
  const collected = collectHostSessions(w.opts);
  assert.deepEqual(collected.byCwd, { [a.absPath]: { claude: 1, codex: 0, lastAt: at(1) } });
  const forms = [
    (l) => attachSessions(l, collected.byCwd, w.opts), // scan-vault.js and cli/workspace.js today
    (l) => attachSessions(l, collected, w.opts),
    (l) => attachSessions(l, w.opts), // options where the sessions go: collects afresh
    (l) => attachSessions(l, JSON.parse(JSON.stringify(collected.byCwd)), w.opts), // a byCwd read back from snapshot.json
  ];
  const got = forms.map((f) => { const l = [{ ...a }]; const outside = f(l); return { sessions: l[0].sessions, outside }; });
  for (const g of got) assert.deepEqual(g, got[0]);
  assert.deepEqual(counts(got[0].sessions), { claude: 1, codex: 0, total: 1 });
  // Collected for one vault, attached for another (paths.js resolved a different vault): the caller's vault is read.
  const w2 = world();
  const b = w2.ws('b');
  codexSession(w2, { cwd: b.absPath });
  attachSessions([b], collected.byCwd, w2.opts);
  assert.deepEqual(counts(b.sessions), { claude: 0, codex: 1, total: 1 });
});

test('empty or missing folders yield nothing and never throw', () => {
  const w = world();
  const none = collectHostSessions({ ...w.opts, cfg: { ...w.cfg, claudeConfigDir: path.join(w.T, 'nope'), hosts: { claude: { enabled: true }, codex: { enabled: true, home: path.join(w.T, 'nope2') } } } });
  assert.deepEqual([none.sessions, none.byCwd], [[], {}]);
  assert.deepEqual(attachSessions([], none, w.opts), []);
  assert.deepEqual(attachSessions(null, none, w.opts), []);
  const noVault = collectHostSessions({ ...w.opts, vault: null });
  assert.deepEqual(noVault.sessions, []);
});

test('insideDir helper', () => {
  assert.equal(insideDir('/a/b/c', '/a/b'), true);
  assert.equal(insideDir('/a/bc', '/a/b'), false, 'a shared name prefix is not containment');
  assert.equal(insideDir('/a/b', '/a/b'), true);
  assert.equal(insideDir('C:\\Users\\x\\p', 'C:\\Users\\x'), true);
});
