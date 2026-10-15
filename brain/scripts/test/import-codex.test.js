'use strict';
// The importer on a Codex-only machine (install-import B3, B8–B10): AGENTS.md by rule, config.toml's MCP servers,
// rollouts in the window (exec runs left out), no Claude rows; `--from` limits the hosts, `--since all` widens the
// window, a proposal is linked to an existing workspace of the same name, and the digest takes the model's workspace
// when attribution found none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeWorld, fakeEngine } = require('./import-world.js');

const w = makeWorld({ claude: false });
process.env.AOS_VAULT = w.vault;
// cli/workspace.js's own scan (adopt --into checks the folder is an outside row) reads this process's Codex home.
process.env.CODEX_HOME = w.codexHome;
const { runImport } = require('../lib/import/index.js');
const D = require('../lib/import/digest.js');
const W = require('../../../cli/workspace.js');

const V = (rel) => path.join(w.vault, rel);
const json = (rel) => JSON.parse(fs.readFileSync(V(rel), 'utf8'));
const eng = fakeEngine({ classify: (o, n) => Array.from({ length: n }, () => 'feedback') });
const base = {
  vault: w.vault, cfg: {}, userConfig: { ...w.userConfig, hosts: { claude: { enabled: false }, codex: { enabled: true, home: w.codexHome } } }, env: w.env,
  home: w.home, tmpDirs: w.tmpDirs, gitCeiling: w.gitCeiling, provider: eng.provider, workspace: W,
  wsOpts: { vault: w.vault, configDir: w.claudeDir, env: { AOS_CONFIG: path.join(w.T, 'no-config.json') }, home: w.home, tmpDirs: w.tmpDirs },
};

test('--from codex: only Codex is read; a proposal named like an existing workspace links to it', async () => {
  // A workspace called beta already exists, without a repo: the beta repository is proposed as its repo:.
  await W.main(['new', 'beta', '--json'], { ...base.wsOpts, io: { log() {}, error() {} }, rescan: false });
  const dry = await runImport({ ...base, from: ['codex'], dryRun: true });
  assert.deepEqual(Object.keys(dry.hosts), ['codex']);
  assert.deepEqual(dry.hosts.codex.instructions, { files: 1, rules: 2, new: 2, skipped: [] });
  assert.equal(dry.hosts.codex.sessions, 2);
  // beta has two sessions in the window, alpha one eight days ago: both pass (beta and alpha are both recent).
  assert.deepEqual(dry.projects.proposals.map((p) => [p.id, p.action, p.into || null, p.link || null]), [['~/code/beta', 'link', 'beta', 'repo'], ['~/code/alpha', 'new', null, null]]);
  const r = await runImport({ ...base, from: ['codex'], accept: ['~/code/beta'] });
  assert.equal(r.written, 2);
  assert.ok(fs.existsSync(V('brain/memory/feedback/use-pnpm-not-npm-in-every.md')));
  assert.deepEqual(r.projects.linked, [{ id: '~/code/beta', into: 'beta', how: 'repo', repo: '~/code/beta' }]);
  assert.deepEqual(r.projects.created, [], 'alpha was not accepted');
  assert.ok(!fs.existsSync(V('workspaces/alpha')));
  assert.match(fs.readFileSync(V('workspaces/beta/workspace.md'), 'utf8'), /^repo: ~\/code\/beta$/m);
  const m = json('brain/_index/mcp-servers.json');
  assert.deepEqual(m.servers.map((s) => s.name), ['issue-tracker', 'web fetch']);
  const st = json('brain/_index/import-state.json');
  assert.deepEqual(st.digest.hosts, ['codex']);
  assert.deepEqual(st.digest.queue.map((q) => [q.host, q.workspace]).sort(), [['codex', null], ['codex', 'beta']].sort());
  assert.ok(st.digest.queue.every((q) => q.file.includes(`${path.sep}rollout-`)));
});

test('--since all reaches older sessions; --only limits the kinds', async () => {
  w.codexSession({ cwd: w.repos.beta, days: 200, prompt: 'An old refactor' });
  const r = await runImport({ ...base, from: ['codex'], since: 'all', only: ['sessions'] });
  assert.equal(r.sessions.added, 1);
  assert.equal(r.hosts.codex.instructions, undefined);
  assert.equal(r.mcp, null);
  assert.equal(r.projects, null);
  await assert.rejects(runImport({ ...base, since: 'soon', dryRun: true }), /--since takes <n>d or all/);
});

test('the digest takes the model\'s workspace when attribution found none, only from the listed ones', async () => {
  const pick = fakeEngine({ digest: () => ({ summary: 'Worked on beta.', workspace: 'beta', memories: [] }) });
  const r = await D.runDigest({ vault: w.vault, provider: pick.provider, deferOnBattery: () => false, config: () => ({}), home: w.home });
  assert.equal(r.status, 'done');
  const dg = json('brain/_index/session-digests.json').sessions;
  assert.equal(dg.length, 3);
  assert.ok(dg.every((s) => s.host === 'codex' && s.workspace === 'beta' && /^codex resume /.test(s.resume)));
  assert.equal((fs.readFileSync(V('workspaces/beta/history.md'), 'utf8').match(/^- \d{2}:\d{2} /gm) || []).length, 3);
});

test('a workspace of the same name that already has a repo: gets the folder as an alias (adopt --into)', async () => {
  await W.main(['new', 'alpha', '--json'], { ...base.wsOpts, io: { log() {}, error() {} }, rescan: false });
  await W.main(['set', 'alpha', '--set', JSON.stringify({ repo: '~/notes' }), '--json'], { ...base.wsOpts, io: { log() {}, error() {} }, rescan: false });
  const dry = await runImport({ ...base, from: ['codex'], dryRun: true, only: ['projects'] });
  const p = dry.projects.proposals.find((x) => x.id === '~/code/alpha');
  assert.deepEqual([p.action, p.into, p.link], ['link', 'alpha', 'alias']);
  const r = await runImport({ ...base, from: ['codex'], only: ['projects'], accept: [{ id: '~/code/alpha', name: 'ignored-for-a-link' }, 'nope'] });
  assert.deepEqual(r.projects.linked, [{ id: '~/code/alpha', into: 'alpha', how: 'alias', repo: '~/code/alpha' }]);
  assert.deepEqual(r.projects.unknown, ['nope']);
  assert.match(fs.readFileSync(V('workspaces/alpha/workspace.md'), 'utf8'), /^aliases:\n {2}- ~\/code\/alpha$/m);
});
