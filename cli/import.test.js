'use strict';
// `aos import` through cli/aos.js (install-import B7): flags refused before anything runs, the dry run's JSON for the
// wizard, a real run's lines, the digest routine turned on, and its schedule re-rendered only where schedules exist.
delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeWorld } = require('../brain/scripts/test/import-world.js');
const I = require('./import.js');

const AOS = path.join(__dirname, 'aos.js');

function setup(opts) {
  const w = makeWorld(opts);
  const cfgFile = path.join(w.claudeDir, 'agenticos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ version: '1.9.0', vault: w.vault, node: process.execPath, claudeConfigDir: w.claudeDir, provider: 'none', hosts: { claude: { enabled: true, configDir: w.claudeDir }, codex: { enabled: true, home: w.codexHome } } }, null, 2));
  const env = { ...process.env, HOME: w.home, CLAUDE_CONFIG_DIR: w.claudeDir, CODEX_HOME: w.codexHome, AOS_CONFIG: cfgFile, OLLAMA_PORT: '1' };
  delete env.AOS_VAULT;
  return { w, env, aos: (args) => spawnSync(process.execPath, [AOS, 'import', ...args], { encoding: 'utf8', env }) };
}

function tree(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
  walk(dir);
  return out.sort();
}

test('flags are checked before anything runs (exit 2)', () => {
  const { aos } = setup();
  for (const [args, msg] of [
    [['--from', 'cursor'], /--from takes claude, codex or all/],
    [['--since', 'forever'], /--since takes <n>d \(90d\) or all/],
    [['--only', 'memories,history'], /--only takes instructions,memories,projects,mcp,sessions \(not history\)/],
    [['--accept', 'alpha'], /--accept takes a JSON list/],
    [['--accept', '[1]'], /a JSON list of ids/],
    [['--accept', '["~/code/alpha"]', '--dry-run'], /which --dry-run never does/],
    [['now'], /aos import takes no words/],
    [['--bogus'], /unknown flag --bogus/],
  ]) {
    const r = aos(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, msg);
  }
  assert.throws(() => I.parseImportArgs(['--since']), /--since needs a value/);
  assert.deepEqual(I.parseImportArgs(['--from=codex', '--since=all', '--only', 'mcp', '--json']), { from: ['codex'], since: 'all', only: ['mcp'], accept: null, dryRun: false, json: true });
});

test('--dry-run --json prints the scan and writes nothing', () => {
  const { w, aos } = setup();
  const before = tree(w.vault);
  const r = aos(['--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dryRun, true);
  assert.deepEqual(j.engine, { ready: false, provider: 'none', model: null, reason: 'forced' });
  assert.deepEqual([j.hosts.claude.instructions.rules, j.hosts.claude.memories.files, j.hosts.codex.instructions.rules, j.hosts.codex.mcp.servers], [5, 3, 2, 2]);
  assert.deepEqual(tree(w.vault), before);
});

test('a real run prints what it did, turns the digest routine on and says how to schedule it', () => {
  const { w, aos } = setup();
  const r = aos([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^- instructions \(Claude Code\): 1 written, 0 already in the vault \(whole file: no local model\)$/m);
  assert.match(r.stdout, /^- memories \(Claude Code\): 3 written/m);
  assert.match(r.stdout, /^import: the last 90 days of Claude Code and Codex$/m);
  assert.match(r.stdout, /local model: not ready \(provider is none\): each instruction file imports as one note, and the digest waits until it is/);
  assert.match(r.stdout, /^- memories \(Codex\): none to read \(Codex's built-in memories stay Codex's\)$/m);
  assert.match(r.stdout, /5 memories written for Brain ▸ Review \(reviewed: false\)/);
  assert.match(r.stdout, /MCP servers listed in brain\/_index\/mcp-servers\.json \(host configs untouched\)/);
  assert.match(r.stdout, /6 sessions queued for the import-digest routine/);
  assert.match(r.stdout, /no schedules are installed here, so run `aos routines sync`/);
  assert.ok(fs.existsSync(path.join(w.vault, 'brain', 'routines', 'import-digest.md')));
  // --from codex --only mcp touches only the Codex rows
  const again = aos(['--from', 'codex', '--only', 'mcp', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).mcp.servers.map((s) => s.host).sort(), ['claude', 'claude', 'codex', 'codex']);
});

test('no vault: a plain error, exit 1', () => {
  const { env } = setup();
  const r = spawnSync(process.execPath, [AOS, 'import', '--dry-run'], { encoding: 'utf8', env: { ...env, AOS_CONFIG: path.join(env.HOME, 'missing.json') } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no vault configured \(run `aos init` first\)/);
});

test('scheduleDigest re-renders installed schedules, and only those', () => {
  const ctx = { vault: '/v', configDir: '/c', user: { node: process.execPath } };
  let rendered = null;
  const on = I.scheduleDigest(ctx, { isInstalled: () => true, installSchedules: ({ vars }) => { rendered = vars; return { labels: ['com.agenticos.import-digest'] }; }, platform: 'darwin' });
  assert.equal(on, 'the import-digest routine is on and scheduled');
  assert.equal(rendered.VAULT, '/v');
  assert.match(I.scheduleDigest(ctx, { isInstalled: () => false, installSchedules: () => { throw new Error('never'); } }), /no schedules are installed here/);
  assert.match(I.scheduleDigest(ctx, { isInstalled: () => true, installSchedules: () => { throw new Error('launchctl broke'); }, platform: 'darwin' }), /scheduling it failed \(launchctl broke\)/);
});
