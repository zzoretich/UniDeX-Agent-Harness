'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AOS = path.resolve(__dirname, '..', 'plugin', 'bin', 'aos');

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); }
function fakeVault() {
  const v = tmp('vault');
  fs.mkdirSync(path.join(v, 'brain', 'scripts', 'sdk'), { recursive: true });
  fs.writeFileSync(path.join(v, 'brain', 'scripts', 'inject-context.js'),
    "console.log('ran inject-context vault=' + process.env.AOS_VAULT + ' config=' + process.env.AOS_CONFIG + ' args=' + process.argv.slice(2).join(','));\nprocess.exit(Number(process.argv[2] || 0));\n");
  fs.writeFileSync(path.join(v, 'brain', 'scripts', 'sdk', 'mcp-server.js'), "console.log('ran mcp-server');\n");
  return v;
}
function fakeNode(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'node');
  fs.writeFileSync(p, `#!/bin/sh\necho "${marker} $1"\n`);
  fs.chmodSync(p, 0o755);
  return p;
}
function writeConfig(cfgDir, obj) {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'agenticos.json'), JSON.stringify(obj, null, 2) + '\n');
}
function run(args, env) {
  // Absolute /bin/sh: Node resolves the spawned executable against options.env.PATH, and the node-resolution
  // test passes a PATH holding only sed/head (no `sh`) — a bare 'sh' there is ENOENT and r.stdout is undefined.
  return spawnSync('/bin/sh', [AOS, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: env.HOME || tmp('home'), ...env } });
}
/** A PATH holding only what the launcher itself needs (sed, head), so `command -v node` is host-independent. */
function toolsDir() {
  const dir = tmp('tools');
  for (const t of ['sed', 'head']) {
    const real = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(real, path.join(dir, t));
  }
  return dir;
}

test('missing config: exit 0, no output (stderr line only with AOS_DEBUG=1)', () => {
  const cfgDir = tmp('cfg');
  const quiet = run(['inject-context'], { CLAUDE_CONFIG_DIR: cfgDir });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
  const loud = run(['inject-context'], { CLAUDE_CONFIG_DIR: cfgDir, AOS_DEBUG: '1' });
  assert.equal(loud.status, 0);
  assert.match(loud.stderr, /no config/);
});

test('unknown name: exit 64 with a stderr line', () => {
  const cfgDir = tmp('cfg');
  writeConfig(cfgDir, { vault: fakeVault(), node: process.execPath });
  const r = run(['bogus-script'], { CLAUDE_CONFIG_DIR: cfgDir });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /aos: unknown script bogus-script/);
});

test('config node wins; AOS_VAULT and AOS_CONFIG are exported; args and exit code pass through', () => {
  const cfgDir = tmp('cfg');
  const vault = fakeVault();
  writeConfig(cfgDir, { vault, node: process.execPath });
  const ok = run(['inject-context', '0', 'extra'], { CLAUDE_CONFIG_DIR: cfgDir });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), `ran inject-context vault=${vault} config=${path.join(cfgDir, 'agenticos.json')} args=0,extra`);
  const seven = run(['inject-context', '7'], { CLAUDE_CONFIG_DIR: cfgDir });
  assert.equal(seven.status, 7);
});

test('AOS_CONFIG overrides the config location', () => {
  const vault = fakeVault();
  const file = path.join(tmp('alt'), 'custom.json');
  // Pretty-printed like writeConfig(): the launcher's json_str is a line-anchored sed, one key per line.
  fs.writeFileSync(file, JSON.stringify({ vault, node: process.execPath }, null, 2) + '\n');
  const r = run(['mcp-server'], { CLAUDE_CONFIG_DIR: tmp('empty'), AOS_CONFIG: file });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'ran mcp-server');
});

test('node resolution order: config → PATH → probe list (AOS_NODE_CANDIDATES) → none exits 0', () => {
  const cfgDir = tmp('cfg');
  const vault = fakeVault();
  const home = tmp('home');
  const tools = toolsDir();
  const configNode = fakeNode(path.join(home, 'cfgnode'), 'CONFIG_NODE');
  fakeNode(path.join(home, 'pathnode'), 'PATH_NODE');
  const nvmNode = fakeNode(path.join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin'), 'NVM_NODE');
  // PATH never contains a real node: only the fake (when wanted) plus sed/head for the launcher itself.
  const withPathNode = `${path.join(home, 'pathnode')}:${tools}`;

  writeConfig(cfgDir, { vault, node: configNode });
  assert.match(run(['inject-context'], { CLAUDE_CONFIG_DIR: cfgDir, HOME: home, PATH: withPathNode }).stdout, /^CONFIG_NODE /);

  writeConfig(cfgDir, { vault });
  assert.match(run(['inject-context'], { CLAUDE_CONFIG_DIR: cfgDir, HOME: home, PATH: withPathNode }).stdout, /^PATH_NODE /);

  // Probe list: AOS_NODE_CANDIDATES replaces the built-in list, so a system node (/usr/local/bin/node on the
  // owner's machine, /usr/bin/node on CI runners) can never win this step.
  const probed = run(['inject-context'], { CLAUDE_CONFIG_DIR: cfgDir, HOME: home, PATH: tools, AOS_NODE_CANDIDATES: `/nonexistent/node:${nvmNode}` });
  assert.match(probed.stdout, /^NVM_NODE /);

  const none = run(['inject-context'], { CLAUDE_CONFIG_DIR: cfgDir, HOME: tmp('barehome'), PATH: tools, AOS_NODE_CANDIDATES: '/nonexistent/node' });
  assert.equal(none.status, 0);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /node not found/);
});

test('every contract name maps to a script path under brain/scripts', () => {
  const src = fs.readFileSync(AOS, 'utf8');
  const expected = {
    'inject-context': 'inject-context.js', 'update-session': 'update-session.js', 'telemetry-hook': 'telemetry-hook.js',
    'heartbeat-writer': 'heartbeat-writer.js', 'auto-cost': 'auto-cost.js', 'auto-wrap': 'auto-wrap.js',
    'scan-vault': 'scan-vault.js', 'build-brain-md': 'build-brain-md.js', 'wrap-session': 'wrap-session.js',
    'mcp-server': 'sdk/mcp-server.js', ask: 'sdk/ask.js', standup: 'sdk/standup.js', 'reflect-week': 'sdk/reflect-week.js',
    'consolidate-memory': 'sdk/consolidate-memory.js', compress: 'sdk/compress.js', 'map-workspace': 'map-workspace.js',
    'regen-insight': 'regen-workspace-insight.js', 'cost-budget': 'cost-budget.js', recall: 'sdk/recall-cli.js',
    'feedback-apply': 'feedback-apply.js',
    'sitrep-state': 'persona/sitrep-state.js', 'record-spend': 'persona/record-spend.js', interview: 'persona/interview.js',
    'run-routine': 'routines/run-routine.js', 'skills-sync': 'skills-sync.js', team: 'team.js', statusline: 'statusline.js',
  };
  for (const [name, script] of Object.entries(expected)) {
    assert.ok(src.includes(`${name}) SCRIPT=${script} ;;`), `missing map entry ${name} → ${script}`);
  }
  // run-duty is a POSIX sh script (contract §4.1): exec'd with sh, never with node; args pass through.
  assert.ok(src.includes('run-duty) exec sh "$VAULT/brain/scripts/persona/run-duty.sh" "$@" ;;'), 'run-duty exec with sh');
  assert.ok(src.includes('doctor|status|upgrade|uninstall|persona|cost|graph|routines|skills|agents|config|superpowers|workspace|memory|terminal|provider|local|import|hosts|migrate|mcp|update-check|update-status|update-notice) SCRIPT=cli/aos.js'), 'maintenance names reach cli/aos.js');
});

test('run-duty is exec\'d with sh and receives AOS_VAULT/AOS_CONFIG plus its args', () => {
  const cfgDir = tmp('cfg');
  const vault = fakeVault();
  fs.mkdirSync(path.join(vault, 'brain', 'scripts', 'persona'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'scripts', 'persona', 'run-duty.sh'), '#!/bin/sh\necho "ran run-duty vault=$AOS_VAULT args=$*"\nexit 3\n');
  writeConfig(cfgDir, { vault, node: process.execPath });
  const r = run(['run-duty', 'monitor', '--dry'], { CLAUDE_CONFIG_DIR: cfgDir });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.trim(), `ran run-duty vault=${vault} args=monitor --dry`);
});
