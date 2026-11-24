'use strict';
// lib/teams.js and team.js (spec 2026-09-28-agent-teams-design): the TEAM.md subset and its line rewrites, the board's
// compare-and-set, the channel, the user's decisions (refused headless, D4), the killed-run sweep, wait, and the CLI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('../lib/teams.js');
const { main } = require('../team.js');

const TEMPLATES = path.join(__dirname, '..', '..', '..', 'vault-template', 'persona', 'teams');
const TEAM_MD = `---
type: team
id: dev
name: Dev
lead: lead
reportsTo: chief
gates: [discuss, ship]
budget: {mode: per-phase, default: 25}
members:
  - id: lead
    name: Lead
    role: Manager
    agent: seat-lead
    provider: claude
    model: inherit
    effort: inherit
    stage: [all]
    paused: false
  - id: builder
    name: Builder
    role: Builds
    agent: seat-builder
    provider: claude
    model: claude-sonnet-5
    effort: high
    stage: [execute]
    paused: false
  - id: reviewer
    name: Reviewer
    role: Reviews
    agent: seat-reviewer
    provider: opposite
    model: inherit
    effort: high
    stage: [verify]
    paused: false
---

# Dev
`;

function world() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  const root = T.teamsRoot(vault);
  fs.mkdirSync(path.join(root, 'dev'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dev', 'TEAM.md'), TEAM_MD);
  const t = () => T.readTeam(root, 'dev');
  return { vault, root, t };
}
const INTERACTIVE = {};
const HEADLESS = { AOS_HEADLESS: '1' };
const AT_GATE = { id: 'x-01', title: 'X', stage: 'discuss', owner: 'lead', status: 'gate', gate: { name: 'discuss', state: 'pending' } };
async function cli(w, argv, opts = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), vault: w.vault, cfg: {}, env: INTERACTIVE, ...opts });
  return { code, out: out.join(''), err: err.join('') };
}

test('TEAM.md: the subset parses, stages default to the five-stage flow, and a foreign line is refused', () => {
  const w = world();
  const t = w.t();
  assert.deepEqual([t.id, t.lead, t.reportsTo, t.members.length, t.gates], ['dev', 'lead', 'chief', 3, ['discuss', 'ship']]);
  assert.deepEqual(t.stages, T.DEFAULT_STAGES);
  assert.deepEqual(t.budget, { mode: 'per-phase', default: 25 });
  assert.deepEqual(t.members[1].stage, ['execute']);
  assert.throws(() => T.parseFrontmatter('---\nmembers:\n  - id: a\n  weird line\n---\n'), /unsupported TEAM.md line/);
  assert.deepEqual(T.listTeams(w.root), ['dev']);
});

test('rewrites touch one member line, add a missing key, and round-trip every scalar', () => {
  for (const v of ['claude-sonnet-5', 'inherit', 'has: a colon', 'true', '42', true, 3, 'Reviews the work on the other provider']) {
    assert.deepEqual(T.parseScalar(T.formatScalar(v)), v, String(v));
  }
  let text = T.rewriteMember(TEAM_MD, 'builder', 'provider', 'codex');
  assert.equal(text.split('\n').filter((l, i) => l !== TEAM_MD.split('\n')[i]).length, 1, 'one line changed');
  text = T.rewriteMember(text, 'reviewer', 'skills', 'none');
  const fm = T.parseFrontmatter(text);
  assert.equal(fm.members[1].provider, 'codex');
  assert.equal(fm.members[2].skills, 'none');
  text = T.addMemberBlock(text, { id: 'new', name: 'New', stage: ['all'], paused: false });
  assert.deepEqual(T.parseFrontmatter(text).members.map((m) => m.id), ['lead', 'builder', 'reviewer', 'new']);
  text = T.removeMemberBlock(text, 'builder');
  assert.deepEqual(T.parseFrontmatter(text).members.map((m) => m.id), ['lead', 'reviewer', 'new']);
  assert.match(text, /\n# Dev\n$/, 'the body is untouched');
  assert.throws(() => T.rewriteMember(TEAM_MD, 'nobody', 'model', 'x'), /nobody is not a member/);
});

test('put: only the lead writes, each row carries its own time and writer, and --expect is a compare-and-set', () => {
  const w = world();
  assert.throws(() => T.put(w.t(), { from: 'builder', json: JSON.stringify(AT_GATE) }), T.Refusal);
  const before = Date.now();
  const row = T.put(w.t(), { from: 'lead', json: JSON.stringify({ ...AT_GATE, ts: '1999-01-01T00:00:00Z' }) });
  assert.ok(Date.parse(row.ts) >= before);
  assert.deepEqual([row.by, row.schema, row.budget.usd], ['lead', 1, 25], 'a new item gets the default budget');
  // The 2026-09-24 incident: a second approval from a stale read must not drag an item back.
  const t0 = w.t();
  T.withBoard(t0, () => T.writeItem(t0, { id: 'x-01', stage: 'execute', owner: 'builder', status: 'working', gate: { name: 'discuss', state: 'approved' } }, { by: 'fixture', existing: T.boardItems(t0).get('x-01') }));
  const lines = () => fs.readFileSync(path.join(w.t().dir, 'board.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  const n = lines();
  assert.throws(() => T.put(w.t(), { from: 'lead', expect: '{"status":"gate","gate":{"state":"pending"}}', json: '{"id":"x-01","stage":"plan"}' }),
    /--expect failed on x-01: status is "working"; gate is \{"name":"discuss","state":"approved"\}; nothing written/);
  assert.equal(lines(), n);
  assert.equal(T.put(w.t(), { from: 'lead', expect: '{"gate":{"state":"approved"},"note":null}', json: '{"id":"x-01","title":"Y"}' }).title, 'Y', 'partial nested match; a missing key matches null');
  assert.throws(() => T.put(w.t(), { from: 'lead', expect: '{"owner":["builder","x"]}', json: '{"id":"x-01"}' }), /--expect failed/);
  assert.throws(() => T.put(w.t(), { from: 'lead', expect: '{status', json: '{"id":"x-01"}' }), T.UsageError);
  assert.throws(() => T.put(w.t(), { from: 'lead', json: '{"id":"x-01","owner":"stranger"}' }), /owner stranger is not on dev/);
  assert.throws(() => T.put(w.t(), { from: 'lead', json: '{"id":"x-01","stage":"launch"}' }), /stage must be one of/);
});

test('post: signed by a member, the user or dispatch, on an item that exists', () => {
  const w = world();
  T.put(w.t(), { from: 'lead', json: JSON.stringify(AT_GATE) });
  const r = T.post(w.t(), { from: 'builder', item: 'x-01', kind: 'handoff', text: 'Spec done at $40; reviewer next.' });
  assert.equal(r.text, 'Spec done at $40; reviewer next.');
  assert.equal(T.post(w.t(), { from: 'user', text: 'hello @lead' }).from, 'user');
  assert.equal(T.post(w.t(), { from: 'chief', text: 'the one the lead reports to may post' }).from, 'chief');
  assert.throws(() => T.post(w.t(), { from: 'stranger', text: 'x' }), T.UsageError);
  assert.throws(() => T.post(w.t(), { from: 'builder', kind: 'shout', text: 'x' }), T.UsageError);
  assert.throws(() => T.post(w.t(), { from: 'builder', item: 'nope-01', text: 'x' }), T.Refusal);
  assert.equal(T.post(w.t(), { from: 'builder', text: 'x'.repeat(5000) }).text.length, 4000);
  assert.deepEqual(T.tail(w.t(), { item: 'x-01' }).map((p) => p.kind), ['handoff']);
});

test('gate approve moves the item past its stage to the lead; redirect needs a note; both need --expect and a person', () => {
  const w = world();
  T.put(w.t(), { from: 'lead', json: JSON.stringify(AT_GATE) });
  const expect = JSON.stringify({ status: 'gate', gate: { state: 'pending' } });
  assert.throws(() => T.decideGate(w.t(), { item: 'x-01', verb: 'approve', expect, env: HEADLESS }), /user's decision, and a headless run cannot record it/);
  assert.throws(() => T.decideGate(w.t(), { item: 'x-01', verb: 'approve', env: INTERACTIVE }), /--expect is required/);
  assert.throws(() => T.decideGate(w.t(), { item: 'x-01', verb: 'redirect', expect, env: INTERACTIVE }), /needs --note/);
  const row = T.decideGate(w.t(), { item: 'x-01', verb: 'approve', usd: '40', note: 'go', expect, env: INTERACTIVE });
  assert.deepEqual([row.stage, row.owner, row.status, row.gate.state, row.gate.by, row.gate.note, row.budget.usd, row.by],
    ['plan', 'lead', 'working', 'approved', 'user', 'go', 40, 'user']);
  assert.match(T.tail(w.t()).pop().text, /^Discuss gate approved by the user at \$40: go; @lead takes the next step$/);
  assert.throws(() => T.decideGate(w.t(), { item: 'x-01', verb: 'approve', expect, env: INTERACTIVE }), /--expect failed/, 'a stale card');
  assert.throws(() => T.decideGate(w.t(), { item: 'x-01', verb: 'approve', expect: '{}', env: INTERACTIVE }), /no gate is pending on x-01/);
  T.put(w.t(), { from: 'lead', json: '{"id":"x-01","stage":"verify","status":"gate","gate":{"name":"ship","state":"pending"}}' });
  const red = T.decideGate(w.t(), { item: 'x-01', verb: 'redirect', note: 'fix the contrast', expect: '{}', env: INTERACTIVE });
  assert.deepEqual([red.stage, red.gate.name, red.gate.state, red.owner], ['verify', 'ship', 'redirected', 'lead']);
});

test('budget, pause, set and members are the user\'s: presets only, and never from a headless run', () => {
  const w = world();
  T.put(w.t(), { from: 'lead', json: JSON.stringify({ ...AT_GATE, status: 'paused', gate: null }) });
  assert.throws(() => T.setBudget(w.t(), { item: 'x-01', usd: 60, expect: '{}', env: HEADLESS }), T.Refusal);
  fs.mkdirSync(T.runningDir(w.t()), { recursive: true });
  fs.writeFileSync(path.join(T.runningDir(w.t()), 'held.json'), JSON.stringify({ run: 'held', member: 'builder', item: 'x-01', provider: 'claude', pid: process.pid, host: 'another-machine.local', reservedUsd: 50 }));
  assert.throws(() => T.setBudget(w.t(), { item: 'x-01', usd: 30, expect: '{}', env: INTERACTIVE }), /cannot go below \$50/, 'AT-R5');
  fs.rmSync(T.runningDir(w.t()), { recursive: true });
  const b = T.setBudget(w.t(), { item: 'x-01', usd: 60, expect: '{"status":"paused"}', env: INTERACTIVE });
  assert.deepEqual([b.budget.usd, b.status], [60, 'working']);
  assert.throws(() => T.setBudget(w.t(), { item: 'x-01', usd: -1, expect: '{}', env: INTERACTIVE }), T.UsageError);

  T.setPaused(w.t(), { paused: true, env: INTERACTIVE });
  assert.equal(w.t().disabled, true);
  T.setPaused(w.t(), { paused: false, env: INTERACTIVE });
  assert.equal(w.t().disabled, false);
  T.setPaused(w.t(), { memberId: 'builder', paused: true, env: INTERACTIVE });
  assert.equal(T.member(w.t(), 'builder').paused, true);
  assert.throws(() => T.setPaused(w.t(), { memberId: 'builder', paused: false, env: HEADLESS }), T.Refusal);

  T.setMember(w.t(), { memberId: 'builder', key: 'provider', value: 'codex', env: INTERACTIVE });
  T.setMember(w.t(), { memberId: 'builder', key: 'model', value: 'claude-opus-5-5', env: INTERACTIVE });
  assert.deepEqual([T.member(w.t(), 'builder').provider, T.member(w.t(), 'builder').model], ['codex', 'claude-opus-5-5']);
  assert.throws(() => T.setMember(w.t(), { memberId: 'builder', key: 'model', value: 'my-own-model', env: INTERACTIVE }), /model must be one of/);
  assert.throws(() => T.setMember(w.t(), { memberId: 'builder', key: 'voice', value: 'x', env: INTERACTIVE }), /set takes provider, model, effort/);
  assert.throws(() => T.setMember(w.t(), { memberId: 'lead', key: 'provider', value: 'opposite', env: INTERACTIVE }), /no opposite provider/);
  assert.throws(() => T.setMember(w.t(), { memberId: 'builder', key: 'effort', value: 'low', env: HEADLESS }), T.Refusal);
});

test('members: added by picking an agent either host defines, removed only when they own nothing open', () => {
  const w = world();
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-claude-'));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-codex-'));
  fs.mkdirSync(path.join(claudeDir, 'agents')); fs.mkdirSync(path.join(codexDir, 'agents'));
  fs.writeFileSync(path.join(claudeDir, 'agents', 'dev-writer.md'), '---\nname: dev-writer\n---\nWrites.\n');
  fs.writeFileSync(path.join(codexDir, 'agents', 'tester.toml'), 'name = "tester"\ndeveloper_instructions = "Tests."\n');
  const dirs = { claudeDir, codexDir };
  assert.deepEqual(T.addMember(w.t(), { agent: 'dev-writer', env: INTERACTIVE, ...dirs }), { team: 'dev', member: 'writer', agent: 'dev-writer' });
  assert.equal(T.member(w.t(), 'writer').provider, 'claude');
  T.addMember(w.t(), { agent: 'tester', env: INTERACTIVE, ...dirs });
  assert.equal(T.member(w.t(), 'tester').provider, 'codex');
  assert.throws(() => T.addMember(w.t(), { agent: 'tester', env: INTERACTIVE, ...dirs }), /already has a member tester/);
  assert.throws(() => T.addMember(w.t(), { agent: 'ghost', env: INTERACTIVE, ...dirs }), /no agent named ghost/);
  assert.throws(() => T.addMember(w.t(), { agent: 'dev-writer', env: HEADLESS, ...dirs }), T.Refusal);
  T.put(w.t(), { from: 'lead', json: '{"id":"w-01","owner":"writer","status":"working"}' });
  assert.throws(() => T.removeMember(w.t(), { memberId: 'writer', env: INTERACTIVE }), /still owns w-01/);
  assert.throws(() => T.removeMember(w.t(), { memberId: 'lead', env: INTERACTIVE }), /lead cannot be removed/);
  T.removeMember(w.t(), { memberId: 'tester', env: INTERACTIVE });
  assert.deepEqual(w.t().members.map((m) => m.id), ['lead', 'builder', 'reviewer', 'writer']);
});

test('init seeds the shipped example team, which parses, and never overwrites a team', () => {
  const w = world();
  const r = T.initTeam(w.root, { templatesDir: TEMPLATES });
  const ex = T.readTeam(w.root, 'example');
  assert.equal(r.team, 'example');
  assert.deepEqual(ex.members.map((m) => [m.id, m.provider]), [['lead', 'claude'], ['builder', 'claude'], ['reviewer', 'opposite']]);
  assert.throws(() => T.initTeam(w.root, { templatesDir: TEMPLATES }), /already exists/);
  T.initTeam(w.root, { templatesDir: TEMPLATES, id: 'docs' });
  assert.equal(T.readTeam(w.root, 'docs').id, 'docs');
});

// ── the killed-run sweep and wait (D7, D11) ──

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
function marker(t, m) {
  fs.mkdirSync(T.runningDir(t), { recursive: true });
  fs.writeFileSync(path.join(T.runningDir(t), `${m.run}.json`), JSON.stringify({ schema: 1, team: 'dev', ...m }));
}
const markers = (t) => { try { return fs.readdirSync(T.runningDir(t)).sort(); } catch { return []; } };

test('a marker whose dispatcher is gone becomes one killed row and one blocker, exactly once', () => {
  const w = world();
  T.put(w.t(), { from: 'lead', json: '{"id":"x-01","owner":"builder","status":"working"}' });
  fs.mkdirSync(path.join(w.vault, 'workspaces', '_worktrees', 'x-01', 'builder'), { recursive: true });
  const pid = deadPid();
  marker(w.t(), { run: 'x-01-builder-a', member: 'builder', item: 'x-01', provider: 'claude', pid, host: os.hostname(),
    startedAt: new Date(Date.now() - 42 * 60000).toISOString(), log: 'workspaces/_worktrees/.logs/x-01-builder-a', worktree: 'workspaces/_worktrees/x-01/builder' });
  assert.equal(T.reapKilledRuns(w.t()).length, 1);
  assert.equal(T.reapKilledRuns(w.t()).length, 0);
  const runs = T.readJsonl(path.join(w.t().dir, 'runs.jsonl'));
  assert.deepEqual(runs.map((r) => [r.run, r.status, r.usd]), [['x-01-builder-a', 'killed', null]]);
  assert.ok(runs[0].ms >= 42 * 60000);
  const blockers = T.tail(w.t()).filter((p) => p.from === 'dispatch');
  assert.equal(blockers.length, 1);
  assert.match(blockers[0].text, new RegExp(`^builder's claude run on x-01 was killed: its dispatcher \\(pid ${pid}\\) is gone 42\\.\\d min after the run started`));
  assert.match(blockers[0].text, /Worktree workspaces\/_worktrees\/x-01\/builder is still there; log workspaces\/_worktrees\/\.logs\/x-01-builder-a\.\*$/);
  assert.deepEqual(markers(w.t()), []);
});

test('the sweep skips another host, closes a reused pid, and only tidies a run that already has its row', () => {
  const w = world();
  const sleeper = spawn('sleep', ['30']); // alive, but not a dispatcher: the dead one's pid was reused
  try {
    const m = { member: 'builder', item: 'x-01', provider: 'claude', host: os.hostname(), startedAt: new Date().toISOString(), log: 'l', worktree: 'w' };
    marker(w.t(), { ...m, run: 'elsewhere', host: 'another-machine.local', pid: deadPid() });
    marker(w.t(), { ...m, run: 'reused', pid: sleeper.pid });
    marker(w.t(), { ...m, run: 'reused-started', pid: sleeper.pid, pidStart: Date.parse('2020-01-01T00:00:00Z') });
    marker(w.t(), { ...m, run: 'live', pid: process.pid, pidStart: T.processStart(process.pid) });
    marker(w.t(), { ...m, run: 'closed', pid: deadPid() });
    fs.writeFileSync(path.join(w.t().dir, 'runs.jsonl'), JSON.stringify({ schema: 1, member: 'builder', item: 'x-01', run: 'closed', status: 'ok' }) + '\n');
    T.reapKilledRuns(w.t());
    assert.deepEqual(T.readJsonl(path.join(w.t().dir, 'runs.jsonl')).map((r) => `${r.run}:${r.status}`).sort(), ['closed:ok', 'reused-started:killed', 'reused:killed']);
    assert.deepEqual(markers(w.t()), ['elsewhere.json', 'live.json'], 'a live dispatcher is known by its start time, whatever its command line');
  } finally { sleeper.kill(); }
});

test('wait returns the seat\'s run when its row lands, ignoring older runs and other seats', () => {
  const w = world();
  const runsFile = path.join(w.t().dir, 'runs.jsonl');
  const since = new Date().toISOString();
  const old = new Date(Date.now() - 3600e3).toISOString();
  fs.writeFileSync(runsFile, [
    { member: 'builder', item: 'x-01', provider: 'claude', startedAt: old, status: 'ok', run: 'old' },
    { member: 'reviewer', item: 'x-01', provider: 'codex', startedAt: since, status: 'ok', run: 'other-seat' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  let polls = 0;
  const sleep = () => {
    polls++;
    if (polls === 2) fs.appendFileSync(runsFile, JSON.stringify({ member: 'builder', item: 'x-01', provider: 'claude', startedAt: new Date().toISOString(), ms: 90000, usd: 1.25, status: 'ok', commits: 2, merged: true, posted: 'handoff', run: 'new' }) + '\n');
  };
  marker(w.t(), { run: 'new', member: 'builder', item: 'x-01', provider: 'claude', pid: process.pid, host: 'another-machine.local', startedAt: new Date().toISOString() });
  const r = T.waitForRun(w.t(), { item: 'x-01', member: 'builder', since, sleep, pollMs: 0 });
  assert.equal(r.code, 0);
  assert.equal(r.row.run, 'new');
  assert.equal(T.runLine(r.row), 'builder on x-01 via claude: ok after 1.5 min · $1.25 · 2 commit(s) · posted handoff');
});

test('wait gives up when no run of that seat starts, and records a killed run it finds', () => {
  const w = world();
  const t0 = Date.now();
  const none = T.waitForRun(w.t(), { item: 'x-01', member: 'builder', timeoutMin: 0.002, pollMs: 5, sleep: (ms) => { const end = Date.now() + ms; while (Date.now() < end); } });
  assert.equal(none.code, 1);
  assert.match(none.err, /no run of builder on x-01 started since/);
  assert.ok(Date.now() - t0 < 2000);
  T.put(w.t(), { from: 'lead', json: '{"id":"x-01","owner":"builder","status":"working"}' });
  marker(w.t(), { run: 'gone', member: 'builder', item: 'x-01', provider: 'claude', pid: deadPid(), host: os.hostname(), startedAt: new Date().toISOString(), log: 'l', worktree: 'w' });
  const r = T.waitForRun(w.t(), { item: 'x-01', member: 'builder', since: new Date(Date.now() - 1000).toISOString(), sleep: () => {} });
  assert.deepEqual([r.code, r.row.status, r.row.usd], [0, 'killed', null]);
});

test('member status: working from a live marker, blocked from the board, paused, idle; last run and cost', () => {
  const w = world();
  T.put(w.t(), { from: 'lead', json: '{"id":"x-01","owner":["builder","reviewer"],"status":"blocked"}' });
  marker(w.t(), { run: 'r1', member: 'builder', item: 'x-01', provider: 'claude', pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(w.t().dir, 'runs.jsonl'), JSON.stringify({ member: 'reviewer', item: 'x-01', status: 'failed', ms: 60000, usd: 0.5, ts: 't' }) + '\n');
  T.setPaused(w.t(), { memberId: 'lead', paused: true, env: INTERACTIVE });
  const s = Object.fromEntries(T.memberStatus(w.t()).map((m) => [m.id, [m.status, m.item, m.lastRun && m.lastRun.usd]]));
  assert.deepEqual(s, { lead: ['paused', null, null], builder: ['working', 'x-01', null], reviewer: ['blocked', 'x-01', 0.5] });
  assert.deepEqual(T.pendingGates(w.t()), []);
});

function agentDirs() {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-claude-'));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-codex-'));
  fs.mkdirSync(path.join(claudeDir, 'agents')); fs.mkdirSync(path.join(codexDir, 'agents'));
  fs.writeFileSync(path.join(claudeDir, 'agents', 'dev-writer.md'), '---\nname: dev-writer\n---\nWrites.\n');
  return { claudeDir, codexDir };
}

test('new: a team with the picked lead as its only member, the template\'s gates and budget, parsed back by readTeam', () => {
  const w = world();
  const dirs = agentDirs();
  assert.deepEqual(T.newTeam(w.root, { id: 'field', name: 'Field Research', lead: 'dev-writer', templatesDir: TEMPLATES, env: INTERACTIVE, ...dirs }),
    { team: 'field', member: 'dev-writer', agent: 'dev-writer', dir: path.join(w.root, 'field') });
  const t = T.readTeam(w.root, 'field');
  assert.equal(t.name, 'Field Research');
  assert.equal(t.lead, 'dev-writer');
  assert.deepEqual(t.gates, ['discuss', 'ship']);
  assert.equal(t.budget.default, 10);
  assert.equal(t.members.length, 1);
  assert.deepEqual([t.members[0].role, t.members[0].stage, t.members[0].provider], ['Team lead', ['all'], 'claude']);
});

test('new: --parent sets parent and reportsTo the parent\'s lead', () => {
  const w = world();
  T.newTeam(w.root, { id: 'field', name: 'Field', lead: 'dev-writer', parent: 'dev', templatesDir: TEMPLATES, env: INTERACTIVE, ...agentDirs() });
  const t = T.readTeam(w.root, 'field');
  assert.deepEqual([t.parent, t.reportsTo], ['dev', 'lead']);
});

test('new: refused headless, for an unknown agent, a taken id, a bad id, a missing parent, an empty or multi-line name', () => {
  const w = world();
  const base = { id: 'field', name: 'Field', lead: 'dev-writer', templatesDir: TEMPLATES, env: INTERACTIVE, ...agentDirs() };
  assert.throws(() => T.newTeam(w.root, { ...base, env: HEADLESS }), T.Refusal);
  assert.throws(() => T.newTeam(w.root, { ...base, lead: 'ghost' }), /no agent named ghost/);
  assert.throws(() => T.newTeam(w.root, { ...base, id: 'dev' }), /already exists/);
  assert.throws(() => T.newTeam(w.root, { ...base, id: 'Field' }), T.UsageError);
  assert.throws(() => T.newTeam(w.root, { ...base, parent: 'nope' }), /no team nope/);
  assert.throws(() => T.newTeam(w.root, { ...base, name: '  ' }), T.UsageError);
  assert.throws(() => T.newTeam(w.root, { ...base, name: 'a\nb' }), T.UsageError);
  assert.equal(fs.existsSync(path.join(w.root, 'field')), false);
});

test('the CLI: new prints the team it made; a missing --lead is exit 2', async () => {
  const w = world();
  const dirs = agentDirs();
  const r = await cli(w, ['new', 'field', '--name', 'Field', '--lead', 'dev-writer'], { dirs });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /created persona\/teams\/field\//);
  assert.equal((await cli(w, ['new', 'other', '--name', 'Other'], { dirs })).code, 2);
});

test('the CLI: list, status --json, usage is exit 2, a refusal is exit 1, and a gate goes through --expect', async () => {
  const w = world();
  assert.match((await cli(w, ['list'])).out, /^team\s+lead\s+members/);
  assert.equal((await cli(w, ['nope'])).code, 2);
  assert.equal((await cli(w, ['post', 'dev', '--from', 'builder', '--bogus', 'x', 'hi'])).code, 2);
  assert.equal((await cli(w, ['status', 'ghost'])).code, 1);
  assert.equal((await cli(w, ['dispatch', 'dev', 'builder', 'x-01', '--dry-run', '--detach'])).code, 2);
  assert.match((await cli(w, ['put', 'dev', '--from', 'lead', JSON.stringify(AT_GATE)])).out, /^created x-01: discuss\/gate → lead/);
  assert.equal((await cli(w, ['post', 'dev', '--from', 'builder', '--item', 'x-01', 'costs', '$40', 'so', 'far'])).code, 0);
  const s = JSON.parse((await cli(w, ['status', 'dev', '--json'])).out);
  assert.deepEqual(s.pendingGates.map((g) => [g.id, g.gate]), [['x-01', 'discuss']]);
  const ts = T.boardItems(w.t()).get('x-01').ts;
  const headless = await cli(w, ['gate', 'approve', 'dev', 'x-01', '--expect', JSON.stringify({ ts }), '--usd', '40'], { env: HEADLESS });
  assert.equal(headless.code, 1);
  const ok = await cli(w, ['gate', 'approve', 'dev', 'x-01', '--expect', JSON.stringify({ ts }), '--usd', '40']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^discuss gate approved on x-01: now plan\/working with lead/);
  assert.equal((await cli(w, ['gate', 'approve', 'dev', 'x-01', '--expect', JSON.stringify({ ts })])).code, 1, 'the rendered card is stale now');
  assert.match((await cli(w, ['tail', 'dev', '--item', 'x-01'])).out, /costs \$40 so far/);
});

test('list: an unreadable TEAM.md is a row with its error, and --json carries the presets set accepts', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.root, 'broken'));
  fs.writeFileSync(path.join(w.root, 'broken', 'TEAM.md'), '---\nid: broken\ntags:\n  - one\n---\n');
  const r = await cli(w, ['list', '--json']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.teams.map((t) => [t.team, t.error || null]), [['broken', 'unsupported TEAM.md line: - one'], ['dev', null]]);
  assert.deepEqual([j.presets.provider, j.presets.effort], [T.PROVIDERS, T.EFFORTS]);
  assert.deepEqual(j.presets.model, T.presetsFor('model'));
  assert.ok(j.presets.model.includes('inherit') && j.presets.model.includes('claude-sonnet-5'));
  const S = require('../lib/settings-schema.js');
  assert.deepEqual(j.presets.models, { claude: S.CLAUDE_MODELS, codex: S.CODEX_MODELS });
  assert.match((await cli(w, ['list'])).out, /broken\s+unreadable: unsupported TEAM\.md line: - one/);
});

test('put never records the user\'s decisions or dispatch\'s bookkeeping, even as the lead (AT-01)', () => {
  const w = world();
  T.put(w.t(), { from: 'lead', json: JSON.stringify(AT_GATE) });
  const refused = (patch, re) => assert.throws(() => T.put(w.t(), { from: 'lead', json: JSON.stringify({ id: 'x-01', ...patch }) }), re);
  refused({ gate: { name: 'discuss', state: 'approved' } }, /approved gate is the user's decision/);
  refused({ gate: { name: 'discuss', state: 'redirected', note: 'x' } }, /redirected gate is the user's decision/);
  refused({ budget: { usd: 500 } }, /phase budget is the user's decision/);
  refused({ budget: { spentUsd: 0.01 } }, /recorded by dispatch/);
  refused({ builders: { claude: ['builder'] } }, /builders are recorded by dispatch/);
  refused({ gate: null, status: 'working' }, /waits on the user at the discuss gate/);
  refused({ status: 'working' }, /stay until the user decides/);
  assert.equal(T.put(w.t(), { from: 'lead', json: '{"id":"x-01","title":"renamed","budget":{"usd":25}}' }).title, 'renamed', 'other fields and a repeated budget are fine');
});

test('an item\'s snapshots never share a ts, so an --expect of the last one seen catches any change', () => {
  const w = world();
  const now = new Date('2026-09-28T12:00:00.000Z');
  const seen = T.put(w.t(), { from: 'lead', json: JSON.stringify(AT_GATE), now });
  const same = T.put(w.t(), { from: 'lead', json: '{"id":"x-01","added":"in the same millisecond"}', now });
  assert.equal(same.ts, '2026-09-28T12:00:00.001Z');
  assert.throws(() => T.decideGate(w.t(), { item: 'x-01', verb: 'approve', expect: JSON.stringify(seen), env: INTERACTIVE, now }), /--expect failed on x-01: ts is/);
  const back = T.put(w.t(), { from: 'lead', json: '{"id":"x-01","title":"after a clock step back"}', now: new Date('2026-09-28T11:00:00.000Z') });
  assert.equal(back.ts, '2026-09-28T12:00:00.002Z');
  assert.equal(T.put(w.t(), { from: 'lead', json: '{"id":"x-02"}', now }).ts, now.toISOString(), 'another item keeps its own clock');
});

test('the sweep stops a seat that outlived its killed dispatcher (AT-08)', async () => {
  const w = world();
  T.put(w.t(), { from: 'lead', json: '{"id":"x-01","owner":"builder","status":"working"}' });
  // A real orphan: the shell that starts it exits, so init reaps it (a child of this process would linger as a zombie).
  const pid = Number(require('child_process').execFileSync('sh', ['-c', `"${process.execPath}" -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e5)" >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).trim());
  await new Promise((r) => setTimeout(r, 300)); // it ignores SIGTERM (AT-R6)
  const seat = { pid };
  const pidStart = T.processStart(seat.pid);
  marker(w.t(), { run: 'orphaned', member: 'builder', item: 'x-01', provider: 'claude', pid: deadPid(), host: os.hostname(), startedAt: new Date().toISOString(), log: 'l', worktree: 'w', seatPid: seat.pid, seatStart: pidStart });
  T.reapKilledRuns(w.t(), { seatGraceMs: 300 });
  assert.match(T.tail(w.t()).pop().text, new RegExp(`Its seat \\(pid ${seat.pid}\\) was still running and was stopped`));
  assert.throws(() => process.kill(pid, 0), 'the seat is gone: SIGKILL after it ignored SIGTERM');
});

test('gate approval with --usd honours what live runs hold (AT-REV-06)', () => {
  const w = world();
  T.put(w.t(), { from: 'lead', json: JSON.stringify(AT_GATE) });
  fs.mkdirSync(T.runningDir(w.t()), { recursive: true });
  fs.writeFileSync(path.join(T.runningDir(w.t()), 'held.json'), JSON.stringify({ run: 'held', member: 'builder', item: 'x-01', provider: 'claude', pid: process.pid, host: 'another-machine.local', reservedUsd: 30 }));
  assert.throws(() => T.decideGate(w.t(), { item: 'x-01', verb: 'approve', usd: 20, expect: '{}', env: INTERACTIVE }), /cannot go below \$30/);
  assert.equal(T.decideGate(w.t(), { item: 'x-01', verb: 'approve', usd: 40, expect: '{}', env: INTERACTIVE }).budget.usd, 40);
});
