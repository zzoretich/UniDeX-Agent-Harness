'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AOS = path.join(ROOT, 'cli', 'aos.js');
const FAKE_CLAUDE = path.join(ROOT, 'cli', 'fixtures', 'fake-claude.sh');
const FAKE_NPM = path.join(ROOT, 'cli', 'fixtures', 'fake-npm.sh');
const FAKE_OLLAMA = path.join(ROOT, 'cli', 'fixtures', 'fake-ollama.sh');
const FAKE_UV = path.join(ROOT, 'cli', 'fixtures', 'fake-uv.sh');
const GRAPHIFY_PIN = require('./graph-cmd.js').PIN;

/** Isolated sandbox: temp HOME + CLAUDE_CONFIG_DIR, fakes for claude and npm. Nothing touches ~/.claude. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cli-'));
  const home = path.join(dir, 'home');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  // mandatory-prereqs D3/D6: the install gate wants Ollama present; point the seam at the fixture so the positive path is
  // exercised on a runner that has none. python3 is real. Obsidian is no prerequisite (workbench-app D1).
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    AOS_CLAUDE_BIN: FAKE_CLAUDE,
    AOS_NPM_BIN: FAKE_NPM,
    AOS_OLLAMA_BIN: FAKE_OLLAMA,
    // graphify spec D1: uv is a prerequisite too; the fake installs a fake graphify into the sandboxed ~/.local/share.
    AOS_UV_BIN: FAKE_UV,
    FAKE_UV_LOG: path.join(dir, 'uv.log'),
    FAKE_CLAUDE_LOG: path.join(dir, 'claude.log'),
    FAKE_NPM_LOG: path.join(dir, 'npm.log'),
    FAKE_NPM_NODE_MODULES: path.join(ROOT, 'node_modules'),
    // No test may contact Ollama: doctor/init probe an endpoint nothing listens on (config.ollama > env > default).
    OLLAMA_PORT: '1',
    // …and once init has written agenticos.json (config outranks env) the probe is skipped outright.
    AOS_SKIP_OLLAMA_PROBE: '1',
    // The developer's real codex CLI must never be detected: these tests are the Claude-only install. The Codex host
    // tests below override this with AOS_CODEX_BIN (the fake) and a sandboxed CODEX_HOME.
    AOS_NO_CODEX: '1',
  };
  delete env.AOS_VAULT; delete env.BRAIN_VAULT; delete env.AOS_CONFIG; delete env.CLAUDE_PROJECT_DIR;
  delete env.XDG_DATA_HOME;   // the graphify tool dir must land under the sandboxed HOME
  return { dir, home, cfg, vault: path.join(dir, 'vault'), env, log: (f) => { try { return fs.readFileSync(env[f], 'utf8'); } catch { return ''; } } };
}
function aos(sb, args, extraEnv = {}) {
  return spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', env: { ...sb.env, ...extraEnv }, cwd: ROOT });
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('no command prints usage and exits 2; unknown command exits 2', () => {
  const sb = sandbox();
  const none = aos(sb, []);
  assert.equal(none.status, 2);
  assert.match(none.stdout + none.stderr, /aos init/);
  assert.equal(aos(sb, ['frobnicate']).status, 2);
});

test('doctor without agenticos.json fails that check and exits 1', () => {
  const sb = sandbox();
  const r = aos(sb, ['doctor']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+agenticos\.json/);
  assert.match(r.stdout, /ok\s+node >= 20/);
  assert.match(r.stdout, /ok\s+claude login/);
  assert.match(r.stdout, /info\s+ollama reachable\s+127\.0\.0\.1:1 not probed \(AOS_SKIP_OLLAMA_PROBE=1\)/);
  assert.doesNotMatch(r.stdout, /^(?:ok|FAIL|warn|info)\s+obsidian/m, 'Obsidian is no longer a doctor row');
  assert.match(r.stdout, new RegExp(`ok\\s+ollama installed\\s+${reEsc(FAKE_OLLAMA)}`));
  // install-import B1: only the cost module runs python3, so doctor does not ask about it while cost is off.
  assert.doesNotMatch(r.stdout, /python3/);
  assert.match(r.stdout, new RegExp(`ok\\s+uv installed\\s+${reEsc(FAKE_UV)}`));
});

// mandatory-prereqs D2/D3/D5: each prerequisite has one env seam; '' means absent. init refuses before writing anything
// (and --provider none does not waive it), doctor turns the row into a FAIL and exits 1. Since install-import B1 that is
// uv alone (with Node): Ollama is a warning and python3 only --cost's (below).
const PREREQ_CASES = [
  { env: { AOS_UV_BIN: '' }, initMsg: /uv not found — install it \(docs\.astral\.sh\/uv\)/, row: /FAIL\s+uv installed\s+not found/ },
];
for (const c of PREREQ_CASES) {
  const name = Object.keys(c.env)[0];
  test(`init refuses when ${name} says the tool is absent, even with --provider none, and writes nothing`, () => {
    const sb = sandbox();
    const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes'], c.env);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, c.initMsg);
    assert.ok(!fs.existsSync(sb.vault), 'no vault was created');
    assert.ok(!fs.existsSync(path.join(sb.cfg, 'agenticos.json')), 'no config was written');
    assert.doesNotMatch(sb.log('FAKE_CLAUDE_LOG'), /plugin install/, 'the plugin was not installed');
  });
  test(`doctor fails the ${name} row and exits 1 when the tool is absent`, () => {
    const sb = sandbox();
    const r = aos(sb, ['doctor'], c.env);
    assert.equal(r.status, 1);
    assert.match(r.stdout, c.row);
  });
}

test('install-import B1: without Ollama, init warns and installs; doctor\'s ollama row is a warn', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes'], { AOS_OLLAMA_BIN: '' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /ollama not found — background work waits for it; install it from ollama\.com \(the UniDeX app's setup installs it\), then run aos doctor/);
  assert.match(r.stdout, /preflight: ollama absent · uv /);
  assert.doesNotMatch(r.stdout, /preflight: ollama 127\.0\.0\.1/, 'no reachability line without an Ollama');
  assert.ok(fs.existsSync(path.join(sb.cfg, 'agenticos.json')));
  const d = aos(sb, ['doctor'], { AOS_OLLAMA_BIN: '' });
  assert.match(d.stdout, /warn\s+ollama installed\s+not found — background work waits for it/);
  assert.doesNotMatch(d.stdout, /FAIL\s+ollama/);
});

test('install-import B1: init never asks for python3 unless --cost, which still needs 3.9 and names what it found', () => {
  const sb = sandbox();
  const noPy = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes'], { AOS_PYTHON_BIN: '' });
  assert.equal(noPy.status, 0, noPy.stdout + noPy.stderr);
  assert.doesNotMatch(noPy.stdout + noPy.stderr, /python3/);
  const sb2 = sandbox();
  const oldPy = path.join(sb2.dir, 'old-python3');
  fs.writeFileSync(oldPy, '#!/bin/sh\necho "Python 3.8.2"\n', { mode: 0o755 });
  const r = aos(sb2, ['init', '--vault', sb2.vault, '--no-obsidian', '--provider', 'none', '--cost', '--yes'], { AOS_PYTHON_BIN: oldPy });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--cost: python3 >= 3\.9 is required — found 3\.8/);
  assert.ok(!fs.existsSync(sb2.vault), 'nothing was written');
  // With cost on, doctor asks for python3 again.
  const cfg = path.join(sb.cfg, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...readJson(cfg), cost: { enabled: true } }, null, 2));
  assert.match(aos(sb, ['doctor'], { AOS_PYTHON_BIN: '' }).stdout, /FAIL\s+python3 >= 3\.9\s+python3 not found on PATH — the cost module needs it/);
});

test('install-import B2: init --host none installs the vault and runtime with no host, no plugin and no Chief of Staff', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--host', 'none', '--vault', sb.vault, '--no-obsidian', '--yes'], { AOS_NO_CLAUDE: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /preflight: hosts none \(Sessions and the Chief of Staff wait for one\)/);
  assert.match(r.stdout, /persona: no host yet, so no Chief of Staff/);
  assert.doesNotMatch(r.stdout, /run the Chief of Staff interview|install agenticos@/);
  assert.match(r.stdout, /Add a host when you have one: .*aos hosts add claude \(or aos hosts add codex\)\. It keeps every file\./);
  assert.doesNotMatch(r.stdout, /CLAUDE\.md|\/hooks/, 'no host steps');
  assert.equal(sb.log('FAKE_CLAUDE_LOG'), '', 'claude was never run');
  const cfg = readJson(path.join(sb.cfg, 'agenticos.json'));
  assert.deepEqual([cfg.hosts.claude.enabled, cfg.hosts.codex.enabled], [false, false]);
  assert.ok(fs.existsSync(path.join(sb.vault, 'brain', 'scripts', 'bin', 'aos')));
  assert.ok(!fs.existsSync(path.join(sb.vault, 'persona', 'IDENTITY.md')));
  // doctor on it: no host rows, an info row saying what waits, and no failure.
  const d = aos(sb, ['doctor'], { AOS_NO_CLAUDE: '1' });
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /info\s+hosts\s+none yet — Sessions and the Chief of Staff wait for one/);
  assert.doesNotMatch(d.stdout, /^(?:ok|FAIL|warn)\s+(?:claude|codex|plugin installed|MCP declared)/m);
  // A host added later: init again with it keeps the files and turns it on.
  const add = aos(sb, ['init', '--host', 'claude', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.equal(readJson(path.join(sb.cfg, 'agenticos.json')).hosts.claude.enabled, true);
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /plugin install agenticos@agenticos-workbench/);
});

test('inspection F7: init refuses a --host that drops a host the install has wired, and writes nothing', () => {
  const sb = sandbox();
  assert.equal(aos(sb, ['init', '--host', 'claude', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']).status, 0);
  const cfgFile = path.join(sb.cfg, 'agenticos.json');
  const before = fs.readFileSync(cfgFile, 'utf8');
  fs.writeFileSync(sb.env.FAKE_CLAUDE_LOG, '');
  const none = aos(sb, ['init', '--host', 'none', '--vault', sb.vault, '--no-obsidian', '--yes']);
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stderr, /--host none would turn off claude, which this install has wired, and init never unwires a host: keep it with --host claude, or remove it first with aos uninstall --host claude/);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), before, 'agenticos.json is untouched');
  const swap = aos(sb, ['init', '--host', 'codex', '--vault', sb.vault, '--no-obsidian', '--yes']);
  assert.equal(swap.status, 1);
  assert.match(swap.stderr, /--host codex would turn off claude, .*keep it with --host both, or remove it first with aos uninstall --host claude/);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), before);
  assert.doesNotMatch(sb.log('FAKE_CLAUDE_LOG'), /plugin (install|uninstall)/, 'nothing was wired or unwired');
  // Keeping every host it has (auto, or the same set) still runs.
  assert.equal(aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']).status, 0);
});

test('init with no host available names --host none', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--yes'], { AOS_NO_CLAUDE: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /claude CLI not found — install Claude Code, pass --host codex, or pass --host none/);
});

test('a non-empty seam that points at a missing path counts as absent (D3)', () => {
  const { ollamaBin, pythonBin } = require('./aos.js');
  const gone = path.join(os.tmpdir(), 'aos-nowhere-' + process.pid);
  const saved = { ...process.env };
  try {
    process.env.AOS_OLLAMA_BIN = gone; process.env.AOS_PYTHON_BIN = '';
    assert.equal(ollamaBin(), null);
    assert.equal(pythonBin(), null);
    process.env.AOS_OLLAMA_BIN = FAKE_OLLAMA; delete process.env.AOS_PYTHON_BIN;
    assert.equal(ollamaBin(), FAKE_OLLAMA);
    assert.equal(pythonBin(), 'python3');
  } finally {
    for (const k of ['AOS_OLLAMA_BIN', 'AOS_PYTHON_BIN']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

// workbench-app D1: the Workbench is the app, so init neither needs Obsidian nor writes into .obsidian/. --no-obsidian
// and --terminal are still accepted (a script written for an older release keeps working) and do nothing.
test('init needs no Obsidian, installs no HUD into the vault, and accepts --no-obsidian and --terminal as no-ops', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--terminal', '--provider', 'none', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^preflight: ollama \S+fake-ollama\.sh · uv /m, 'python3 is --cost\'s alone (install-import B1)');
  assert.doesNotMatch(r.stdout, /preflight: obsidian|Obsidian plugin bundle|Community plugins/);
  assert.match(r.stdout, /terminal: nothing to install — the UniDeX app brings its own terminal/);
  assert.match(r.stdout, /Open the UniDeX app \(macOS, Apple silicon; download it from https:\/\/github\.com\/zzoretich\/UniDeX-Agent-Harness\/releases\/latest\)/);
  assert.doesNotMatch(r.stdout, /arrives with 1\.0|build it from app\//, 'the download exists now');
  assert.ok(!fs.existsSync(path.join(sb.vault, '.obsidian', 'plugins')), 'no HUD bundle in the vault');
  assert.ok(!fs.existsSync(path.join(sb.vault, '.obsidian', 'daily-notes.json')), 'no Obsidian Daily Notes setting');
  assert.doesNotMatch(aos(sb, ['help']).stdout, /--no-obsidian|--terminal|terminal install/, 'the no-ops are not advertised');
});

test('doctor warns (not fails) when ollama is installed but not answering', () => {
  const sb = sandbox();
  const r = aos(sb, ['doctor'], { AOS_SKIP_OLLAMA_PROBE: '0' });
  assert.match(r.stdout, /warn\s+ollama reachable\s+127\.0\.0\.1:1 not answering — run `ollama serve`/);
  assert.match(r.stdout, /ok\s+ollama installed/);
});

test('status and provider need a config; provider validates its argument', () => {
  const sb = sandbox();
  assert.equal(aos(sb, ['status']).status, 1);
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({
    vault: sb.vault, node: process.execPath, provider: 'auto', claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 },
  }, null, 2));
  fs.mkdirSync(path.join(sb.vault, 'brain', '_index'), { recursive: true });
  const day = new Date();
  const ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).toISOString();
  // Contract §3: `duty:<name>` rows are the persona's (persona.perDayUsd), every other row is a hook call
  // (claude.perDayUsd). The $2 duty row must not land on the hook line.
  fs.writeFileSync(path.join(sb.vault, 'brain', '_index', 'provider-spend.jsonl'),
    `${JSON.stringify({ ts, feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 0.01 })}\n` +
    `${JSON.stringify({ ts, feature: 'duty:monitor', provider: 'claude', model: 'haiku', usd: 2 })}\n` +
    `${JSON.stringify({ ts, feature: 'reason:ask', provider: 'claude', model: 'claude-opus-5', usd: 0.3 })}\n` +
    `${JSON.stringify({ ts, feature: 'cross-review:review', provider: 'codex', model: 'gpt-6-astra', usd: 1.25 })}\n` +
    `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', feature: 'x', provider: 'claude', model: 'haiku', usd: 5 })}\n`);
  // Real ledger shape (lib/pipeline-report.js): { version, pipelines: { name: { lastRun, history } } }.
  fs.writeFileSync(path.join(sb.vault, 'brain', '_index', 'pipelines.json'), JSON.stringify({
    version: 1,
    pipelines: {
      'scan-vault': { lastRun: { startedAt: '2026-09-04T09:59:58.000Z', endedAt: '2026-09-04T10:00:00.000Z', durationMs: 2000, status: 'ok', error: null, wrote: [], counts: {}, pid: 1, provider: 'none', reason: null }, history: [] },
      'auto-cost': { lastRun: { startedAt: '2026-09-04T10:00:01.000Z', endedAt: '2026-09-04T10:00:01.000Z', durationMs: 0, status: 'disabled', error: null, wrote: [], counts: {}, pid: 1, provider: null, reason: 'cost disabled' }, history: [] },
      'auto-wrap': { lastRun: null, history: [] },
    },
  }));
  const st = aos(sb, ['status']);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /provider\s+mode=auto resolved=never resolved/);
  assert.match(st.stdout, /spend\s+today \(hooks\) \$0\.0100 \/ cap \$0\.5 \(claude\.perDayUsd\)/);
  assert.match(st.stdout, /spend\s+today \(duties\) \$2\.0000 \/ cap \$6/);
  assert.match(st.stdout, /spend\s+today \(reasoner\) \$0\.3000 \/ cap \$5/);
  assert.match(st.stdout, /spend\s+today \(cross-review\) \$1\.2500 \/ cap \$10/);
  assert.match(st.stdout, /^reasoner\s+model=claude-opus-5 provider=claude effort=medium$/m);
  assert.ok(!/today \(hooks\) \$2\./.test(st.stdout), 'duty spend never counts against the hook cap');
  assert.ok(!/today \(hooks\) \$0\.31/.test(st.stdout), 'reasoner spend never counts against the hook cap');
  assert.match(st.stdout, /scan-vault\s+ok\s+none\s+2026-09-04T10:00:00/);
  assert.match(st.stdout, /auto-cost\s+disabled\s+-.*cost disabled/);
  assert.match(st.stdout, /auto-wrap\s+never/);
  assert.ok(!/^\s+(version|pipelines)\s/m.test(st.stdout), 'ledger envelope keys are not printed as rows');
  assert.match(st.stdout, /^claude\s+bin=.*login=unprobed$/m);

  // Under the codex provider the hook calls are capped by codex.perDayUsd (provider.js codexBudget), and status says so.
  const withCodex = { ...readJson(path.join(sb.cfg, 'agenticos.json')), codex: { perDayUsd: 0.3 } };
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify(withCodex, null, 2));
  fs.writeFileSync(path.join(sb.vault, 'brain', '_index', 'provider-state.json'), JSON.stringify({ name: 'codex', reason: 'auto', checkedAt: ts }));
  assert.match(aos(sb, ['status']).stdout, /spend\s+today \(hooks\) \$0\.0100 \/ cap \$0\.3 \(codex\.perDayUsd\)/);
  // A Codex-only config: the reasoner is answered by Codex (provider.js resolveProviderForRole), on reasoner.codexModel.
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ ...withCodex, hosts: { claude: { enabled: false }, codex: { enabled: true } }, reasoner: { codexModel: 'gpt-5' } }, null, 2));
  assert.match(aos(sb, ['status']).stdout, /^reasoner\s+model=gpt-5 provider=codex effort=medium$/m);

  assert.equal(aos(sb, ['provider', 'bogus']).status, 2);
  const set = aos(sb, ['provider', 'ollama']);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(readJson(path.join(sb.cfg, 'agenticos.json')).provider, 'ollama');
  assert.equal(aos(sb, ['provider']).stdout.trim(), 'ollama');
});

test('parseArgs handles value flags, --no-flags, booleans and positionals', () => {
  const { parseArgs } = require('./aos.js');
  const a = parseArgs(['init', '--vault', '/tmp/v', '--no-obsidian', '--yes', '--persona-json', 'p.json', 'extra']);
  assert.equal(a.cmd, 'init');
  assert.deepEqual(a.sub, ['extra']);
  assert.deepEqual(a.flags, { vault: '/tmp/v', obsidian: false, yes: true, personaJson: 'p.json' });
  assert.throws(() => parseArgs(['init', '--vault']), /needs a value/);
  const eq = parseArgs(['init', '--vault=/tmp/v', '--provider=none', '--dry-run']);
  assert.deepEqual(eq.flags, { vault: '/tmp/v', provider: 'none', dryRun: true });
  assert.throws(() => parseArgs(['init', '--vault=']), /needs a value/);
  assert.throws(() => parseArgs(['init', '--dry-rnu']), /unknown flag --dry-rnu/);
  assert.throws(() => parseArgs(['init', '--no-cost']), /unknown flag --no-cost/);
  // `aos routines hosts --refresh` (host-routines D4): a boolean flag the dispatcher forwards to cli/routines.js.
  assert.deepEqual(parseArgs(['routines', 'hosts', '--refresh', '--json']), { cmd: 'routines', sub: ['hosts'], flags: { refresh: true, json: true } });
  assert.deepEqual(parseArgs(['routines', 'import-cloud', '-']).sub, ['import-cloud', '-']);
  // A single-dash token is a usage error, not a positional: `aos init -y` must not silently start an interactive install.
  assert.throws(() => parseArgs(['init', '-y']), /unknown flag -y/);
});

test('aos workspace: its flags parse, reach cli/workspace.js, and --dry-run passes only for `workspace set` (spaces-redesign D28)', () => {
  const { parseArgs } = require('./aos.js');
  assert.deepEqual(parseArgs(['workspace', 'set', 'alpha', '--set', '{"pinned":true}', '--expect', 'none', '--dry-run', '--json']),
    { cmd: 'workspace', sub: ['set', 'alpha'], flags: { set: '{"pinned":true}', expect: 'none', dryRun: true, json: true } });
  assert.deepEqual(parseArgs(['workspace', 'new', 'kite', '--git', '--pin', '--empty', '--json']).flags, { git: true, pin: true, empty: true, json: true });
  assert.deepEqual(parseArgs(['workspace', 'adopt', '~/code/x', '--into', 'alpha', '--json']).flags, { into: 'alpha', json: true });
  assert.deepEqual(parseArgs(['workspace', 'which', '--cwd=/somewhere']).flags, { cwd: '/somewhere' });
  assert.throws(() => parseArgs(['workspace', 'set', 'alpha', '--set']), /--set needs a value/);
  assert.throws(() => parseArgs(['workspace', 'rename', 'a', '-b']), /unknown flag -b/);

  const sb = sandbox();
  const vault = path.join(sb.dir, 'vault');
  fs.mkdirSync(path.join(vault, 'workspaces', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  const env = { AOS_VAULT: vault, CODEX_HOME: path.join(sb.home, '.codex') };
  // The forwarder hands every flag to cli/workspace.js, which holds each verb to its own.
  const set = aos(sb, ['workspace', 'set', 'alpha', '--set', '{"pinned":true}', '--expect', 'none', '--dry-run', '--json'], env);
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual([JSON.parse(set.stdout).dryRun, JSON.parse(set.stdout).text], [true, '---\npinned: true\n---\n']);
  assert.ok(!fs.existsSync(path.join(vault, 'workspaces', 'alpha', 'workspace.md')));
  const which = aos(sb, ['workspace', 'which', '--cwd', path.join(vault, 'workspaces', 'alpha'), '--json'], env);
  assert.deepEqual(JSON.parse(which.stdout), { name: 'alpha', slug: 'alpha', via: 'cwd' });
  const dry = aos(sb, ['workspace', 'archive', 'alpha', '--dry-run', '--json'], env);
  assert.equal(dry.status, 2);
  assert.match(dry.stderr, /--dry-run is only supported by `aos workspace set`/);
  assert.ok(fs.existsSync(path.join(vault, 'workspaces', 'alpha')), 'a refused --dry-run moves nothing');
  const headless = aos(sb, ['workspace', 'archive', 'alpha', '--json'], { ...env, AOS_HEADLESS: '1' });
  assert.equal(headless.status, 1);
  assert.match(headless.stderr, /^aos: aos workspace archive moves a folder, and a headless run \(AOS_HEADLESS=1/);
});

test('mcpProbe rejects at once on an initialize error and on an early server exit (no timeout wait)', async () => {
  const { mcpProbe } = require('./aos.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mcpprobe-'));
  const vault = path.join(dir, 'vault');
  const binDir = path.join(vault, 'brain', 'scripts', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'aos');
  const prevConfig = process.env.AOS_CONFIG;
  process.env.AOS_CONFIG = path.join(dir, 'no-such-config.json');
  try {
    fs.writeFileSync(scriptPath,
      '#!/bin/sh\nread line\necho \'{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"boom"}}\'\nexit 0\n');
    fs.chmodSync(scriptPath, 0o755);
    let t0 = Date.now();
    await assert.rejects(mcpProbe({ vault, timeoutMs: 5000 }), /initialize: boom/);
    assert.ok(Date.now() - t0 < 4000, 'initialize error should reject immediately, not wait out the timeout');

    fs.writeFileSync(scriptPath,
      '#!/bin/sh\nread line\necho \'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"agenticos","version":"0"}}}\'\nexit 0\n');
    fs.chmodSync(scriptPath, 0o755);
    t0 = Date.now();
    await assert.rejects(mcpProbe({ vault, tool: 'recall', args: {}, timeoutMs: 5000 }), /exited 0 before answering/);
    assert.ok(Date.now() - t0 < 4000, 'early exit should reject immediately, not wait out the timeout');
  } finally {
    if (prevConfig === undefined) delete process.env.AOS_CONFIG; else process.env.AOS_CONFIG = prevConfig;
  }
});

test('init --dry-run prints the numbered plan and writes nothing', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--dry-run', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('[dry-run] '));
  assert.deepEqual(lines.map((l) => l.replace(/^\[dry-run\] (\d+)\. (\S+).*/, '$1 $2')),
    ['1 copy', '2 vendor', '3 write', '4 install', '5 register', '6 run', '7 first']);
  assert.ok(!fs.existsSync(sb.vault));
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'agenticos.json')));
  assert.equal(sb.log('FAKE_NPM_LOG'), '');
});

test('init refuses the config dir, a dir with settings.json, and the home dir', () => {
  const sb = sandbox();
  for (const bad of [sb.cfg, path.join(sb.cfg, 'vault'), sb.home]) {
    const r = aos(sb, ['init', '--vault', bad, '--no-obsidian', '--provider', 'none', '--yes']);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /refusing/);
  }
  const withSettings = path.join(sb.dir, 'other');
  fs.mkdirSync(withSettings, { recursive: true });
  fs.writeFileSync(path.join(withSettings, 'settings.json'), '{}');
  assert.match(aos(sb, ['init', '--vault', withSettings, '--no-obsidian', '--provider', 'none', '--yes']).stderr, /settings\.json/);
});

test('init into a temp vault: seed set, vendored runtime, agenticos.json, plugin calls, launcher link', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const v = sb.vault;
  for (const rel of ['MEMORY.md', 'AGENTICOS.md', '.gitignore', 'brain/config.json', 'brain/_index/SESSION.md', 'brain/_index/BRAIN.md',
    'brain/_index/MOC-reference.md', 'brain/_index/MOC-projects.md', 'brain/_index/MOC-patterns.md', 'brain/_index/scanner-config.json',
    'brain/memory/user/profile.md', 'brain/memory/feedback/README.md', 'brain/memory/projects/README.md', 'brain/memory/reference/README.md',
    'brain/patterns/README.md', 'templates/daily-note.md', 'templates/meeting-note.md', 'templates/decision-record.md', 'templates/project-note.md',
    'brain/routines/README.md', 'brain/routines/briefing.md', 'brain/routines/import-digest.md', 'brain/routines/monitor.md', 'brain/routines/reflect.md', 'brain/routines/sitrep.md',
    'brain/scripts/lib/import/index.js', 'brain/scripts/lib/import/digest.js', 'brain/scripts/cli/import.js', 'brain/scripts/cli/hosts.js',
    'brain/scripts/package.json', 'brain/scripts/config.default.json', 'brain/scripts/lib/paths.js', 'brain/scripts/sdk/mcp-server.js',
    'brain/scripts/cli/aos.js', 'brain/scripts/cli/routines.js', 'brain/scripts/routines/run-routine.js', 'brain/scripts/bin/aos', 'brain/scripts/node_modules']) {
    assert.ok(fs.existsSync(path.join(v, rel)), `missing ${rel}`);
  }
  assert.ok(!fs.existsSync(path.join(v, '_gitignore')));
  assert.ok(!fs.existsSync(path.join(v, '.obsidian')), 'the vault is plain: no Obsidian settings seeded (workbench-app D1)');
  assert.ok(!fs.existsSync(path.join(v, 'persona', 'identity.template.md')), 'vault-template/persona/ is not seeded raw (A8)');
  assert.ok(!fs.existsSync(path.join(v, 'brain', 'scripts', 'test')), 'tests are not vendored');
  assert.ok(!fs.existsSync(path.join(v, 'brain', 'scripts', 'package-lock.json')), 'no lockfile is vendored (contract §4.3)');
  assert.ok(fs.statSync(path.join(v, 'brain', 'scripts', 'bin', 'aos')).mode & 0o100, 'launcher is executable');
  assert.match(fs.readFileSync(path.join(v, 'brain', '_index', 'SESSION.md'), 'utf8'), new RegExp(`^updated: ${new Date().getFullYear()}-`, 'm'));
  assert.equal(readJson(path.join(v, 'brain', 'config.json')).dailyNote.layout, '{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md');

  const cfg = readJson(path.join(sb.cfg, 'agenticos.json'));
  assert.deepEqual(Object.keys(cfg), ['version', 'vault', 'node', 'claudeConfigDir', 'provider', 'claude', 'ollama', 'telemetry', 'cost', 'persona', 'graph', 'hosts']);
  // Design D1: a Claude-only install records exactly that; the Codex home is remembered for a later --host codex.
  assert.deepEqual(cfg.hosts, { claude: { enabled: true, configDir: sb.cfg, bin: FAKE_CLAUDE }, codex: { enabled: false, home: path.join(sb.home, '.codex') } });
  assert.equal(cfg.vault, v);
  // D12: Homebrew's stable opt link when this Node runs from the Cellar, else the running Node itself.
  assert.equal(cfg.node, require('./node-path.js').stableNode(process.execPath));
  assert.equal(cfg.claudeConfigDir, sb.cfg);
  assert.equal(cfg.provider, 'none');
  // Contract §2: claude.bin records the resolved CLI (the sandbox's fake); the caps are unchanged — a subset check now.
  assert.equal(cfg.claude.model, 'haiku');
  assert.equal(cfg.claude.perCallUsd, 0.05);
  assert.equal(cfg.claude.perDayUsd, 0.5);
  assert.equal(cfg.claude.bin, FAKE_CLAUDE);
  assert.deepEqual(cfg.cost, { enabled: false });
  assert.deepEqual(cfg.persona, { enabled: true });
  // graphify spec D2: the pinned graphify in a tool dir of our own, recorded; the seed ignore file; step 9's scan built the graph.
  const graphBin = path.join(sb.home, '.local', 'share', 'agenticos', 'graphify', 'bin', 'graphify');
  assert.deepEqual(cfg.graph, { enabled: true, bin: graphBin });
  assert.match(sb.log('FAKE_UV_LOG'), new RegExp(`^tool install --python >=3\\.10 graphifyy\\[ollama\\]==${reEsc(GRAPHIFY_PIN)}$`, 'm'));
  assert.ok(fs.existsSync(path.join(v, '.graphifyignore')), '.graphifyignore seeded');
  assert.equal(readJson(path.join(v, 'brain', 'graphify-out', 'graph.json')).nodes.length, 5, 'the first scan built the graph');
  assert.equal(readJson(path.join(v, 'brain', 'graphify-out', '.aos-graph.json')).mode, 'structural');
  assert.match(fs.readFileSync(path.join(v, '.gitignore'), 'utf8'), /^brain\/graphify-out\/$/m);

  // Contract §4.3: exactly one `npm install --omit=dev` in the vendored runtime; no lockfile step, no `npm ci`.
  const npmLog = sb.log('FAKE_NPM_LOG');
  assert.deepEqual(npmLog.trim().split('\n'), ['install --omit=dev --no-audit --no-fund'], 'one npm install, no ci/lockfile step');
  const claudeLog = sb.log('FAKE_CLAUDE_LOG');
  assert.match(claudeLog, /^plugin marketplace add zzoretich\/UniDeX-Agent-Harness$/m);
  assert.match(claudeLog, /^plugin install agenticos@agenticos-workbench$/m);
  assert.equal(fs.readlinkSync(path.join(sb.home, '.local', 'bin', 'aos')), path.join(v, 'brain', 'scripts', 'bin', 'aos'));
  assert.ok(fs.existsSync(path.join(v, 'brain', '_index', 'recall-index.json')), 'recall --warm ran');
  assert.match(fs.readFileSync(path.join(v, 'brain', '_index', 'BRAIN.md'), 'utf8'), /^## Who$/m);
  assert.match(r.stdout, new RegExp(`@${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/AGENTICOS\\.md`));
  // final review Minor 13 (tests-7): the Plan-3-era "not installed in this phase" alternative is dead —
  // cli/persona-cmd.js:53's SKIP_MSG is the only branch reachable here (--yes, stdin a pipe, no
  // --persona-json, and agenticos.json says persona.enabled true so aos.js:613 is not taken).
  assert.match(r.stdout + r.stderr, /skipping the interview \(run `aos persona` later\)/);

  // Idempotent: a second init keeps user files and does not duplicate the seed.
  fs.appendFileSync(path.join(v, 'MEMORY.md'), '- [Kept](brain/memory/reference/kept.md) — user line\n');
  // …including live working memory: only a freshly seeded SESSION.md gets today's date stamped into it.
  const sessionPath = path.join(v, 'brain', '_index', 'SESSION.md');
  fs.writeFileSync(sessionPath, fs.readFileSync(sessionPath, 'utf8').replace(/^updated: .*$/m, 'updated: 2000-01-01'));
  const again = aos(sb, ['init', '--vault', v, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(fs.readFileSync(path.join(v, 'MEMORY.md'), 'utf8'), /Kept/);
  assert.match(fs.readFileSync(sessionPath, 'utf8'), /^updated: 2000-01-01$/m, 'a re-run never rewrites working memory');
  assert.equal(sb.log('FAKE_UV_LOG').trim().split('\n').length, 1, 'graphify at the pin is kept, not reinstalled');

  // A re-run without --provider keeps the mode already set (e.g. by `aos provider ollama`), rather than resetting to auto.
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  const setOllama = readJson(cfgPath);
  setOllama.provider = 'ollama';
  fs.writeFileSync(cfgPath, JSON.stringify(setOllama, null, 2) + '\n');
  const keepProvider = aos(sb, ['init', '--vault', v, '--no-obsidian', '--yes']);
  assert.equal(keepProvider.status, 0, keepProvider.stderr);
  assert.equal(readJson(cfgPath).provider, 'ollama');
});

// execution amendment 2026-09-15 (A2): extras/cost/analyze_transcript.py ships from Plan 5 Task 1 on, so --cost
// takes the python3 >= 3.9 preflight (cli/aos.js:646) and enables cost. python3 is on PATH here and on both CI images.
test('init --cost enables cost once the analyzer is shipped (python3 >= 3.9)', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--cost', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!/not shipped in this phase/.test(r.stderr), 'the analyzer is shipped: no warning');
  assert.equal(readJson(path.join(sb.cfg, 'agenticos.json')).cost.enabled, true);
  assert.ok(fs.existsSync(path.join(sb.vault, 'brain', 'scripts', 'cost', 'analyze_transcript.py')), 'init --cost installs the analyzer (Task 11)');
});

test('init with --from-local uses the local path as the marketplace source', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(sb.log('FAKE_CLAUDE_LOG'), new RegExp(`^plugin marketplace add ${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('init keeps going and prints the checklist when the plugin install fails', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes'], { FAKE_CLAUDE_FAIL_INSTALL: '1' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /plugin install failed/);
  const v = sb.vault;
  assert.match(r.stdout, new RegExp(`@${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/AGENTICOS\\.md`));
  assert.ok(fs.existsSync(path.join(v, 'brain', '_index', 'recall-index.json')), 'recall --warm ran');
});

function initialized() {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  fs.writeFileSync(sb.env.FAKE_CLAUDE_LOG, '');
  return sb;
}

test('doctor passes on an initialized vault when the plugin is installed (MCP probe over stdio)', () => {
  const sb = initialized();
  const r = aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok\s+MCP server answers\s+serverInfo\.name=agenticos/);
  assert.match(r.stdout, new RegExp(`ok\\s+graphify ${reEsc(GRAPHIFY_PIN)}\\s+.*agenticos/graphify/bin/graphify`));
  assert.match(r.stdout, /ok\s+graph fresh\s+built \d+s ago · 5 nodes · 5 edges/);
  assert.match(r.stdout, /warn\s+workbench app\s+not registered yet — open the UniDeX app once$/m);
  assert.doesNotMatch(r.stdout, /^(?:ok|FAIL|warn|info)\s+obsidian/m);
  // cross-review spec D6: a Claude-only machine gets a warn row naming the same-provider fallback, never a failure.
  assert.match(r.stdout, /warn\s+cross-review\s+same-provider only: codex CLI not found — the skill offers a labelled same-provider review$/m);
  // local-first A4: the persona row names the Chief of Staff's host and model, and the failover host (none on Claude only).
  assert.match(r.stdout, /ok\s+persona runner\s+claude · claude-opus-5-5 \(medium\) \(.+\); failover: none$/m);
  assert.match(r.stdout, /all checks passed/);
});

test('chiefRow: the CoS host, model, effort and failover host; a moved duty says why; no host says how to fix it', () => {
  const { chiefRow } = require('./aos.js');
  const cx = (h) => (h === 'codex' ? ' (estimated)' : '');
  assert.equal(chiefRow({ host: 'claude', bin: '/b/claude', model: 'claude-opus-5-5', effort: 'medium', reason: 'auto', failover: [{ host: 'codex', model: 'gpt-6-sol' }] }, cx),
    'claude · claude-opus-5-5 (medium) (/b/claude); failover: codex · gpt-6-sol');
  assert.equal(chiefRow({ host: 'codex', bin: '/b/codex', model: null, effort: 'low', reason: 'failover: claude signed out', failover: [] }, cx),
    'codex · your Codex default (low) (/b/codex) (estimated) (failover: claude signed out); failover: none');
  assert.match(chiefRow({ host: null, reason: 'waiting-for-host', skipped: [{ host: 'claude', why: 'signed out' }] }),
    /^none \(waiting-for-host: claude: signed out\); duties are skipped until a host can start them/);
  assert.equal(chiefRow({ host: null, reason: 'daily-cap', skipped: [{ host: null, why: 'today\'s duty spend 6.00 of 6 USD (persona.perDayUsd)' }] }),
    'none today (daily-cap: today\'s duty spend 6.00 of 6 USD (persona.perDayUsd)); duties are skipped on both hosts until tomorrow');
});

// workbench-app D11: the app records itself in brain/_index/hud-host.json; doctor names it, or says to open it once.
test('doctor shows the Workbench app the vault was last opened with', () => {
  const sb = initialized();
  const marker = path.join(sb.vault, 'brain', '_index', 'hud-host.json');
  fs.writeFileSync(marker, JSON.stringify({ schema: 1, host: 'app', name: 'AgenticOS Workbench', version: '1.0.0', at: new Date().toISOString() }));
  const r = aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok\s+workbench app\s+AgenticOS Workbench 1\.0\.0$/m);
  fs.writeFileSync(marker, JSON.stringify({ schema: 1, host: 'app', name: 'AgenticOS Workbench', version: 'dev' }));
  assert.match(aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') }).stdout, /warn\s+workbench app\s+not registered yet/, 'a version it cannot order is no record');
});

// D12: a versioned Homebrew path goes with the next `brew upgrade`; doctor says how to record the stable link.
test('doctor warns on a node path recorded inside Homebrew\'s Cellar', () => {
  const sb = initialized();
  const cellar = path.join(sb.dir, 'brew', 'Cellar', 'node', '25.1.0', 'bin');
  fs.mkdirSync(cellar, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(cellar, 'node'));
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  const recorded = readJson(cfgPath).node;
  assert.doesNotMatch(aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') }).stdout, /node path/, recorded);
  fs.writeFileSync(cfgPath, JSON.stringify({ ...readJson(cfgPath), node: path.join(cellar, 'node') }, null, 2));
  const r = aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') });
  assert.match(r.stdout, /warn\s+node path\s+a versioned Homebrew Cellar path — re-run `aos upgrade` to record the stable link$/m);
  assert.match(r.stdout, /ok\s+node in config/);
});

test('doctor warns when AOS_VAULT points at a directory that does not exist', () => {
  const sb = initialized();
  const bad = path.join(sb.dir, 'nope');
  const r = aos(sb, ['doctor'], { AOS_VAULT: bad, FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /warn\s+AOS_VAULT env\s+.*does not exist/);
  assert.match(r.stdout, /all checks passed/);
});

/** A hand-written agenticos.json whose claude.bin is `bin`, with the env knob and PATH out of the way so only the
 *  recorded path — or the fallback chain after it — can produce a CLI. Nothing here is initialized (no plugin, no MCP). */
function recordedSandbox(bin) {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({
    vault: sb.vault, node: process.execPath, provider: 'auto', claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5, bin },
  }, null, 2));
  const emptyBin = path.join(sb.dir, 'empty-bin');
  fs.mkdirSync(emptyBin);
  // AOS_CLAUDE_BIN='' is falsy → ignored; a PATH without /bin makes `command -v claude` (and `sh`) unfindable.
  return { sb, env: { AOS_CLAUDE_BIN: '', PATH: emptyBin } };
}

test('doctor and status prefer the claude.bin recorded in agenticos.json over the PATH probe (contract §2)', () => {
  const { sb, env } = recordedSandbox(FAKE_CLAUDE);
  const st = aos(sb, ['status'], env);
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, new RegExp(`^claude\\s+bin=${reEsc(FAKE_CLAUDE)} `, 'm'));
  const dr = aos(sb, ['doctor'], env);
  assert.match(dr.stdout, new RegExp(`ok\\s+claude CLI\\s+${reEsc(FAKE_CLAUDE)}`));
  assert.match(dr.stdout, /ok\s+claude login/);
  assert.doesNotMatch(dr.stdout, /claude\.bin/, 'no warning while the recorded path is executable');
});

test('doctor warns on a recorded claude.bin that is no longer executable and falls back to the probe chain', () => {
  const { sb, env } = recordedSandbox(path.join(os.tmpdir(), `aos-no-such-claude-${process.pid}`));
  const dr = aos(sb, ['doctor'], env);
  assert.match(dr.stdout, /FAIL\s+claude CLI\s+not found on PATH or in ~\/\.local\/bin/);
  assert.match(dr.stdout, /warn\s+claude\.bin\s+\S+ is not an executable file/);
  // With the env knob back, the chain finds the fake and the warning stays.
  const again = aos(sb, ['doctor'], { PATH: env.PATH });
  assert.match(again.stdout, new RegExp(`ok\\s+claude CLI\\s+${reEsc(FAKE_CLAUDE)}`));
  assert.match(again.stdout, /warn\s+claude\.bin/);
});

test('upgrade re-records claude.bin and clears the cached provider probe only when the path changed', () => {
  const sb = initialized();
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  assert.equal(readJson(cfgPath).claude.bin, FAKE_CLAUDE, 'init recorded the sandbox fake');
  const moved = path.join(sb.dir, 'moved-claude.sh');
  fs.copyFileSync(FAKE_CLAUDE, moved);
  fs.chmodSync(moved, 0o755);
  const state = path.join(sb.vault, 'brain', '_index', 'provider-state.json');
  const now = new Date().toISOString();
  const seed = (bin) => fs.writeFileSync(state, JSON.stringify({ checkedAt: now, name: 'none', reason: 'forced', claude: { loggedIn: false, checkedAt: now, bin } }));
  seed(FAKE_CLAUDE);
  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT], { AOS_CLAUDE_BIN: moved });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readJson(cfgPath).claude.bin, moved);
  assert.match(r.stdout, /claude\.bin now \S+ \(was \S+\); cached provider probe cleared/);
  // The stale probe is gone (the rebuild step may have written a fresh, claude-less state file under provider none;
  // the file-local readJson throws on a missing file, hence the existsSync guard).
  const st = fs.existsSync(state) ? readJson(state) : null;
  assert.ok(!st || !st.claude, `stale claude probe should be gone: ${JSON.stringify(st)}`);
  // Same path again: the cache is left alone.
  seed(moved);
  const same = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT], { AOS_CLAUDE_BIN: moved });
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.doesNotMatch(same.stdout, /cached provider probe cleared/);
  assert.equal(readJson(state).claude.bin, moved, 'unchanged path → cache kept');
});

test('upgrade re-vendors the runtime, migrates config, keeps memory', () => {
  const sb = initialized();
  const memory = path.join(sb.vault, 'brain', 'memory', 'reference', 'keep-me.md');
  fs.writeFileSync(memory, '# Keep me\n');
  const vendored = path.join(sb.vault, 'brain', 'scripts', 'lib', 'paths.js');
  fs.writeFileSync(vendored, '// stale copy\n');
  const dry = aos(sb, ['upgrade', '--dry-run', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(dry.status, 2, dry.stderr);
  assert.match(dry.stderr, /--dry-run is only supported by `aos init`/);
  assert.ok(fs.readFileSync(vendored, 'utf8').includes('stale copy'), 'a rejected --dry-run runs nothing');
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  const cfg = readJson(cfgPath);
  delete cfg.telemetry;
  cfg.version = '0.0.1';
  cfg.provider = 'ollama';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const vaultCfg = path.join(sb.vault, 'brain', 'config.json');
  fs.writeFileSync(vaultCfg, JSON.stringify({ scan: { fileMapBudget: 7 } }));

  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!fs.readFileSync(vendored, 'utf8').includes('stale copy'), 'runtime re-vendored');
  assert.ok(fs.existsSync(memory), 'memory untouched');
  const after = readJson(cfgPath);
  assert.equal(after.version, readJson(path.join(ROOT, 'package.json')).version);
  assert.equal(after.provider, 'ollama', 'user value kept');
  assert.deepEqual(after.telemetry, { enabled: true, redact: true, retentionDays: 30 }, 'missing key migrated');
  const vc = readJson(vaultCfg);
  assert.equal(vc.scan.fileMapBudget, 7);
  assert.equal(vc.scan.embedBudget, 40);
  assert.match(r.stdout, /Memory, notes and persona were not touched/);
  assert.doesNotMatch(r.stdout, /Obsidian/, 'a vault with no Obsidian-era plugin folder hears nothing about it');
});

// install-and-update I1/I2: the app's payload is a release tree that carries its runtime's dependencies. A copy of the
// parts init and upgrade read, plus payload.json and a stand-in node_modules; its own cli/aos.js finds it as the repo.
function releaseTree(sb, { deps = { 'fake-dep/index.js': 'module.exports = "from the payload";\n' }, manifest = { schema: 1, version: '9.9.9', runtimeDeps: true } } = {}) {
  const tree = path.join(sb.dir, 'payload');
  const skip = /(^|\/)(node_modules|test|fixtures|rehearsal|package-lock\.json)(\/|$)|\.test\.js$/;
  for (const rel of ['package.json', '.claude-plugin', '.agents', 'brain/scripts', 'cli', 'plugin', 'vault-template', 'extras']) {
    fs.cpSync(path.join(ROOT, rel), path.join(tree, rel), { recursive: true, filter: (src) => !skip.test(path.relative(ROOT, src)) });
  }
  if (manifest) fs.writeFileSync(path.join(tree, 'payload.json'), JSON.stringify(manifest));
  for (const [rel, text] of Object.entries(deps)) {
    const f = path.join(tree, 'brain', 'scripts', 'node_modules', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return { tree, aos: (args, env = {}) => spawnSync(process.execPath, [path.join(tree, 'cli', 'aos.js'), ...args], { encoding: 'utf8', env: { ...sb.env, ...env }, cwd: sb.dir }) };
}

test('init from a release tree copies its runtime dependencies and never runs npm', () => {
  const sb = sandbox();
  const { tree, aos: run } = releaseTree(sb);
  const r = run(['init', '--vault', sb.vault, '--provider', 'none', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`preflight: node v[\\d.]+ · checkout ${reEsc(fs.realpathSync(tree))} \\(v[\\d.]+\\)`), 'the tree its own CLI sits in is the source');
  const nm = path.join(sb.vault, 'brain', 'scripts', 'node_modules');
  assert.equal(fs.readFileSync(path.join(nm, 'fake-dep', 'index.js'), 'utf8'), 'module.exports = "from the payload";\n');
  assert.ok(!fs.lstatSync(nm).isSymbolicLink(), 'a real copy, not a link into the app bundle');
  assert.doesNotMatch(sb.log('FAKE_NPM_LOG'), /install/, 'npm was never called');
  assert.deepEqual(fs.readdirSync(path.join(sb.vault, 'brain', 'scripts')).filter((n) => n.startsWith('node_modules.')), [], 'no staging folder left behind');
  // The plugin still comes from GitHub, as the terminal install's does (I3): no --from-local, no marketplace in the bundle.
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin marketplace add zzoretich\/UniDeX-Agent-Harness$/m);
});

test('upgrade from a release tree swaps node_modules whole: what the old tree had and the new one lacks is gone', () => {
  const sb = sandbox();
  const first = releaseTree(sb, { deps: { 'old-dep/index.js': 'old\n', 'kept-dep/index.js': 'v1\n' } });
  assert.equal(first.aos(['init', '--vault', sb.vault, '--provider', 'none', '--yes']).status, 0);
  fs.rmSync(first.tree, { recursive: true, force: true });
  const { aos: run } = releaseTree(sb, { deps: { 'kept-dep/index.js': 'v2\n', 'new-dep/index.js': 'new\n' } });
  const r = run(['upgrade']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const nm = path.join(sb.vault, 'brain', 'scripts', 'node_modules');
  assert.deepEqual(fs.readdirSync(nm).sort(), ['kept-dep', 'new-dep']);
  assert.equal(fs.readFileSync(path.join(nm, 'kept-dep', 'index.js'), 'utf8'), 'v2\n');
  assert.doesNotMatch(sb.log('FAKE_NPM_LOG'), /install/);
  assert.deepEqual(fs.readdirSync(path.join(sb.vault, 'brain', 'scripts')).filter((n) => n.startsWith('node_modules.')), []);
});

test('releaseTreeDeps: only a payload.json saying runtimeDeps, with the folder present, skips npm', () => {
  const { releaseTreeDeps } = require('./aos.js');
  const sb = sandbox();
  assert.equal(releaseTreeDeps(ROOT), null, 'a checkout installs with npm');
  const { tree } = releaseTree(sb);
  assert.equal(releaseTreeDeps(tree), path.join(tree, 'brain', 'scripts', 'node_modules'));
  fs.writeFileSync(path.join(tree, 'payload.json'), JSON.stringify({ schema: 1, runtimeDeps: false }));
  assert.equal(releaseTreeDeps(tree), null, 'a payload built with --skip-deps');
  fs.writeFileSync(path.join(tree, 'payload.json'), JSON.stringify({ schema: 2, runtimeDeps: true }));
  assert.equal(releaseTreeDeps(tree), null, 'a schema this CLI does not know');
  fs.writeFileSync(path.join(tree, 'payload.json'), JSON.stringify({ schema: 1, runtimeDeps: true }));
  fs.rmSync(path.join(tree, 'brain', 'scripts', 'node_modules'), { recursive: true });
  assert.equal(releaseTreeDeps(tree), null, 'the folder is missing');
});

// workbench-app D1, D12: upgrade installs no HUD into the vault, says once where an Obsidian-era Workbench went (and
// leaves its folder alone), and records Homebrew's stable Node link.
test('upgrade installs no HUD, points an Obsidian-era install at the app, and records the stable node path', () => {
  const sb = initialized();
  const old = path.join(sb.vault, '.obsidian', 'plugins', 'agentic-os');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'main.js'), '// the Obsidian-era HUD\n');
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ ...readJson(cfgPath), node: '/somewhere/old/node' }, null, 2));
  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const said = r.stdout.split('\n').filter((l) => /UniDeX app/.test(l));
  assert.equal(said.length, 1, r.stdout);
  assert.match(said[0], /^The Workbench is now the UniDeX app for macOS \(https:\/\/github\.com\/zzoretich\/UniDeX-Agent-Harness\/releases\/latest\); once you use the app, you can remove the old Obsidian plugin folder .*\.obsidian\/plugins\/agentic-os\.$/);
  assert.equal(fs.readFileSync(path.join(old, 'main.js'), 'utf8'), '// the Obsidian-era HUD\n', 'the old folder is left alone');
  assert.deepEqual(fs.readdirSync(old), ['main.js'], 'nothing new installed into it');
  assert.equal(readJson(cfgPath).node, require('./node-path.js').stableNode(process.execPath));
});

// graphify spec D3/§4.1: upgrade reinstalls only on a version drift, seeds a missing .graphifyignore, and moves a graph no
// aos build wrote aside exactly once; the index rebuild that follows writes a fresh, marked graph.
test('upgrade reinstalls graphify only on a version drift and moves a hand-built graph aside once', () => {
  const sb = initialized();
  const binDir = path.join(sb.home, '.local', 'share', 'agenticos', 'graphify', 'bin');
  fs.writeFileSync(path.join(binDir, '.fake-graphify-version'), '0.9.1\n');
  fs.rmSync(path.join(sb.vault, '.graphifyignore'));
  const gi = path.join(sb.vault, '.gitignore');
  fs.writeFileSync(gi, fs.readFileSync(gi, 'utf8').replace(/^brain\/graphify-out(\.pre-aos)?\/\n/gm, ''));   // a vault seeded before the graph
  const out = path.join(sb.vault, 'brain', 'graphify-out');
  fs.rmSync(path.join(out, '.aos-graph.json'));
  fs.writeFileSync(sb.env.FAKE_UV_LOG, '');
  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(sb.log('FAKE_UV_LOG'), new RegExp(`^tool install --python >=3\\.10 --reinstall graphifyy\\[ollama\\]==${reEsc(GRAPHIFY_PIN)}$`, 'm'));
  assert.match(r.stdout, new RegExp(`graph: graphify updated 0\\.9\\.1 → ${reEsc(GRAPHIFY_PIN)}.*seeded \\.graphifyignore.*moved a hand-built graph to brain/graphify-out\\.pre-aos`));
  assert.ok(fs.existsSync(path.join(sb.vault, '.graphifyignore')));
  assert.match(fs.readFileSync(gi, 'utf8'), /^brain\/graphify-out\/\nbrain\/graphify-out\.pre-aos\/$/m, 'the graph rules are back in .gitignore');
  assert.ok(fs.existsSync(path.join(sb.vault, 'brain', 'graphify-out.pre-aos', 'graph.json')), 'moved aside, not deleted');
  assert.ok(fs.existsSync(path.join(out, '.aos-graph.json')), 'the rebuild wrote a marked graph');

  fs.writeFileSync(sb.env.FAKE_UV_LOG, '');
  const again = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(sb.log('FAKE_UV_LOG'), '', 'graphify at the pin is kept');
  assert.deepEqual(fs.readdirSync(path.join(sb.vault, 'brain')).filter((f) => f.startsWith('graphify-out.pre-aos')), ['graphify-out.pre-aos'], 'moved once');
});

test('upgrade without uv warns about a graphify that needs installing and still finishes (upgrade is never gated)', () => {
  const sb = initialized();
  fs.writeFileSync(path.join(sb.home, '.local', 'share', 'agenticos', 'graphify', 'bin', '.fake-graphify-version'), '0.9.1\n');
  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT], { AOS_UV_BIN: '' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, new RegExp(`warning: graph: uv not found .*graphify 0\\.9\\.1 is not the pinned ${reEsc(GRAPHIFY_PIN)}`));
  const doc = aos(sb, ['doctor'], { AOS_UV_BIN: '', FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') });
  assert.equal(doc.status, 1);
  assert.match(doc.stdout, /FAIL\s+uv installed\s+not found/);
  assert.match(doc.stdout, new RegExp(`warn\\s+graphify ${reEsc(GRAPHIFY_PIN)}\\s+installed 0\\.9\\.1, pinned`));
});

test('aos graph: status names the pin and the graph; off/on toggle graph.enabled; build rebuilds', () => {
  const sb = initialized();
  const st = aos(sb, ['graph']);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, new RegExp(`^graphify\\s+${reEsc(GRAPHIFY_PIN)} · `, 'm'));
  assert.match(st.stdout, /^graph\s+on · structural · built \d+s ago · brain\/graphify-out$/m);
  assert.match(st.stdout, /^5 nodes · 5 edges · 2 communities$/m);
  assert.match(st.stdout, /\*\*Hubs:\*\* AGENTICOS \(3\)/);
  assert.equal(aos(sb, ['graph', 'off']).status, 0);
  assert.equal(readJson(path.join(sb.cfg, 'agenticos.json')).graph.enabled, false);
  const doc = aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') });
  assert.match(doc.stdout, /info\s+graph fresh\s+graph off \(aos graph on\)/);
  const off = aos(sb, ['graph', 'build']);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /^graph: disabled \(graph off\)$/m);
  assert.equal(aos(sb, ['graph', 'on']).status, 0);
  const b = aos(sb, ['graph', 'build']);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /^graph: 5 nodes · 5 edges · 2 communities in \d+ ms → brain\/graphify-out$/m);
  assert.equal(aos(sb, ['graph', 'frobnicate']).status, 2);
});

// graphify spec D5/D6/D10/D11: under provider none the foreground pass refuses; switched on it runs extract through the
// vendored shim to the (fake) claude, ledgers a graph: row, and status, aos graph and doctor all show it.
test('aos graph build --semantic: a provider opt-out refuses; switched on, it runs through the shim and shows everywhere', () => {
  const sb = initialized();
  const refused = aos(sb, ['graph', 'build', '--semantic', '--yes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /provider is none, so no model reads the notes — `aos graph semantic on` allows the semantic pass anyway/);
  assert.match(aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') }).stdout, /info\s+graph semantic\s+off under provider none/);
  assert.equal(aos(sb, ['graph', 'semantic', 'on']).status, 0);
  const envLog = path.join(sb.dir, 'claude-env.log');
  const r = aos(sb, ['graph', 'build', '--semantic', '--yes'], { FAKE_CLAUDE_ENV_LOG: envLog });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^graph: semantic pass done · 3 nodes · 1 concepts · 1 inferred edges · \$0\.0040 in \d+ s$/m);
  assert.equal(fs.readFileSync(envLog, 'utf8'), 'MAX_THINKING_TOKENS=0 AOS_HEADLESS=1 CLAUDECODE= ANTHROPIC_API_KEY=\n');
  assert.match(aos(sb, ['status']).stdout, /^spend      today \(graph\) \$0\.0040 \/ cap \$1$/m);
  assert.match(aos(sb, ['graph']).stdout, /^semantic   on \(every 24 h\) · Claude \(haiku, on your login\) · last run \d+s ago · 1 concepts · today \$0\.0040 of \$1$/m);
  assert.match(aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') }).stdout, /ok\s+graph semantic\s+last run \d+s ago · 1 concepts · today \$0\.00 of \$1/);
  assert.equal(aos(sb, ['graph', 'status', '--semantic']).status, 2);
});

test('upgrade seeds brain/routines/ once and re-renders installed legacy duty plists through run-routine.js', () => {
  const sb = initialized();
  fs.rmSync(path.join(sb.vault, 'brain', 'routines'), { recursive: true, force: true });   // a vault from before routines existed
  const agents = path.join(sb.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  for (const f of ['com.agenticos.monitor.plist', 'com.agenticos.sitrep.plist', 'com.agenticos.ollama.plist']) fs.writeFileSync(path.join(agents, f), '<plist/>\n');
  // Fakes for the two OS schedulers (cli/schedule.js AOS_*_BIN seams): nothing here may touch the real launchd or crontab.
  const launchLog = path.join(sb.dir, 'launchctl.log');
  const fakeLaunchctl = path.join(sb.dir, 'fake-launchctl');
  fs.writeFileSync(fakeLaunchctl, `#!/bin/sh\necho "$@" >> ${JSON.stringify(launchLog)}\n`, { mode: 0o755 });
  const fakeCrontab = path.join(sb.dir, 'fake-crontab');
  fs.writeFileSync(fakeCrontab, '#!/bin/sh\n[ "$1" = "-l" ] && { echo "no crontab for test" >&2; exit 1; }\ncat > /dev/null\n', { mode: 0o755 });
  const env = { AOS_LAUNCHCTL_BIN: fakeLaunchctl, AOS_CRONTAB_BIN: fakeCrontab };

  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT], env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /seeded brain\/routines\/ \(briefing, import-digest, monitor, reflect, sitrep\)/);
  const store = require('../brain/scripts/lib/routines-store.js');
  const dir = path.join(sb.vault, 'brain', 'routines');
  assert.deepEqual(store.list({ dir }).map((x) => [x.slug, x.kind, x.guarded, x.errors.length]), [['briefing', 'command', false, 0], ['import-digest', 'command', false, 0], ['monitor', 'duty', true, 0], ['reflect', 'duty', true, 0], ['sitrep', 'duty', true, 0]]);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
  if (process.platform === 'darwin') {
    assert.match(r.stdout, /schedules re-rendered: com\.agenticos\.briefing, com\.agenticos\.import-digest, com\.agenticos\.monitor, com\.agenticos\.reflect, com\.agenticos\.sitrep/);
    for (const d of ['briefing', 'import-digest', 'monitor', 'reflect', 'sitrep']) {
      assert.match(fs.readFileSync(path.join(agents, `com.agenticos.${d}.plist`), 'utf8'), /run-routine\.js/, `${d} plist rendered from the routine file`);
    }
    assert.equal(fs.readFileSync(path.join(agents, 'com.agenticos.ollama.plist'), 'utf8'), '<plist/>\n', 'the Ollama supervisor is untouched');
    assert.equal(fs.readFileSync(launchLog, 'utf8').split('\n').filter((l) => l.startsWith('load ')).length, 5);
    const st = store.readState({ file: path.join(sb.vault, 'brain', '_index', 'routines.json') });
    assert.deepEqual(Object.keys(st.synced).sort(), ['briefing', 'import-digest', 'monitor', 'reflect', 'sitrep']);
  } else {
    assert.match(r.stdout, /no schedules installed/);
  }

  // Second upgrade: brain/routines/ is the owner's now — a deleted routine is not re-seeded, and its schedule goes.
  fs.unlinkSync(path.join(dir, 'reflect.md'));
  fs.writeFileSync(launchLog, '');
  const again = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT], env);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.ok(!/seeded brain\/routines/.test(again.stdout), 'seeded only once');
  assert.ok(!fs.existsSync(path.join(dir, 'reflect.md')), 'the owner\'s deletion sticks');
  if (process.platform === 'darwin') {
    assert.match(again.stdout, /schedules re-rendered: com\.agenticos\.briefing, com\.agenticos\.import-digest, com\.agenticos\.monitor, com\.agenticos\.sitrep \(removed com\.agenticos\.reflect\.plist\)/);
    assert.ok(!fs.existsSync(path.join(agents, 'com.agenticos.reflect.plist')));
  }
});

test('upgrade from before 1.5.0 adds the briefing routine to an owned brain/routines/ and schedules it; a later deletion sticks', () => {
  const sb = initialized();
  const dir = path.join(sb.vault, 'brain', 'routines');
  const cfgFile = path.join(sb.cfg, 'agenticos.json');
  const recorded = (version) => fs.writeFileSync(cfgFile, JSON.stringify({ ...readJson(cfgFile), version }, null, 2));
  // A vault last upgraded at 1.4.1: brain/routines/ is the owner's, and it has no briefing routine (1.5.0 added it).
  fs.unlinkSync(path.join(dir, 'briefing.md'));
  recorded('1.4.1');
  const agents = path.join(sb.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.agenticos.monitor.plist'), '<plist/>\n');   // its schedules are installed
  const fakeLaunchctl = path.join(sb.dir, 'fake-launchctl');
  fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const fakeCrontab = path.join(sb.dir, 'fake-crontab');
  fs.writeFileSync(fakeCrontab, '#!/bin/sh\n[ "$1" = "-l" ] && { echo "no crontab for test" >&2; exit 1; }\ncat > /dev/null\n', { mode: 0o755 });
  const env = { AOS_LAUNCHCTL_BIN: fakeLaunchctl, AOS_CRONTAB_BIN: fakeCrontab };

  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT], env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /added the briefing routine \(new in 1\.5\.0\): brain\/routines\/briefing\.md/);
  assert.equal(fs.readFileSync(path.join(dir, 'briefing.md'), 'utf8'), fs.readFileSync(path.join(ROOT, 'vault-template', 'brain', 'routines', 'briefing.md'), 'utf8'));
  if (process.platform === 'darwin') {
    assert.match(r.stdout, /schedules re-rendered: com\.agenticos\.briefing, /);
    assert.match(fs.readFileSync(path.join(agents, 'com.agenticos.briefing.plist'), 'utf8'), /run-routine\.js/);
  } else {
    assert.match(r.stdout, /no schedules installed/);
  }

  // A vault already on 1.5.0 whose owner deleted the routine keeps it deleted.
  fs.unlinkSync(path.join(dir, 'briefing.md'));
  recorded('1.5.0');
  const again = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT], env);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.doesNotMatch(again.stdout, /added the briefing routine/);
  assert.ok(!fs.existsSync(path.join(dir, 'briefing.md')), 'the owner\'s deletion sticks');
});

test('upgrade from before 2.0.0 adds the import-digest routine (install-import B10); from 2.0.0 on a deletion sticks', () => {
  const sb = initialized();
  const dir = path.join(sb.vault, 'brain', 'routines');
  const cfgFile = path.join(sb.cfg, 'agenticos.json');
  const recorded = (version) => fs.writeFileSync(cfgFile, JSON.stringify({ ...readJson(cfgFile), version }, null, 2));
  fs.unlinkSync(path.join(dir, 'import-digest.md'));
  recorded('1.9.0');
  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /added the import-digest routine \(new in 2\.0\.0\): brain\/routines\/import-digest\.md/);
  assert.equal(fs.readFileSync(path.join(dir, 'import-digest.md'), 'utf8'), fs.readFileSync(path.join(ROOT, 'vault-template', 'brain', 'routines', 'import-digest.md'), 'utf8'));
  fs.unlinkSync(path.join(dir, 'import-digest.md'));
  recorded('2.0.0');
  const again = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.doesNotMatch(again.stdout, /added the import-digest routine/);
  assert.ok(!fs.existsSync(path.join(dir, 'import-digest.md')));
});

test('upgrade from before 2.0.0 records local-first and import pending and, with no TTY, prints the commands (local-first A9, B12)', () => {
  const sb = initialized();
  const cfgFile = path.join(sb.cfg, 'agenticos.json');
  const recorded = (version) => fs.writeFileSync(cfgFile, JSON.stringify({ ...readJson(cfgFile), version }, null, 2));
  const migrations = path.join(sb.vault, 'brain', '_index', 'migrations.json');
  recorded('1.9.0');
  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^- record what this release asks you once \(aos migrate\)\n {3}pending: local-first, import$/m);
  assert.deepEqual(readJson(migrations).migrations.map((m) => [m.id, m.state, m.from]), [['local-first', 'pending', '1.9.0'], ['import', 'pending', '1.9.0']]);
  assert.match(r.stdout, /aos migrate local-first --apply --chief {3}go local/);
  assert.match(r.stdout, /^ {2}aos import {2,}/m);
  assert.equal(readJson(cfgFile).provider, 'none', 'nothing applied without an answer');
  // The next upgrade records nothing new and still says what is waiting; from 2.0.0 nothing is recorded at all.
  const again = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.match(again.stdout, /^ {3}nothing new$/m);
  assert.match(again.stdout, /aos migrate local-first --decline/);
  fs.rmSync(migrations);
  recorded('2.0.0');
  const fresh = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(fresh.status, 0, fresh.stderr + fresh.stdout);
  assert.ok(!fs.existsSync(migrations));
  assert.match(fresh.stdout, /^ {3}nothing new$/m);
  assert.doesNotMatch(fresh.stdout, /aos migrate local-first|aos import/);
});

test('an upgrade that stops part way still leaves the 2.0 question pending, and the re-run keeps it', () => {
  const sb = initialized();
  const cfgFile = path.join(sb.cfg, 'agenticos.json');
  const migrations = path.join(sb.vault, 'brain', '_index', 'migrations.json');
  const vaultCfg = path.join(sb.vault, 'brain', 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...readJson(cfgFile), version: '1.9.0' }, null, 2));
  const good = fs.readFileSync(vaultCfg, 'utf8');
  // Unparseable: the step that pins what a 1.9 install runs on refuses it (as the defaults merge would), right after the
  // record and before the runtime is re-vendored or agenticos.json gets the new version.
  fs.writeFileSync(vaultCfg, '{ not json');
  const failed = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.notEqual(failed.status, 0, 'the upgrade stopped');
  assert.match(failed.stderr, /refusing to touch unparseable/);
  assert.deepEqual(readJson(migrations).migrations.map((m) => [m.id, m.state, m.from]), [['local-first', 'pending', '1.9.0'], ['import', 'pending', '1.9.0']],
    'recorded before anything wrote the new version');
  assert.equal(readJson(cfgFile).version, '1.9.0', 'nothing wrote the new version, so the re-run still pins');
  assert.equal(fs.readFileSync(vaultCfg, 'utf8'), '{ not json', 'the file it could not read is left as it was');
  fs.writeFileSync(vaultCfg, good);
  const again = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.deepEqual(readJson(migrations).migrations.map((m) => m.state), ['pending', 'pending']);
  assert.match(again.stdout, /aos migrate local-first --apply --chief/);
});

// local-first A9: an upgrade from 1.9 changes nothing the Chief of Staff runs until the Go-local card moves it. The vault is
// shaped as a real 1.9.0 one was found: no persona block in brain/config.json, claude.model set by hand, the interview's
// effort, the 1.9 tick a duty. The duty is resolved the way run-duty.sh resolves it (the vendored persona/chief.js), both
// as the schedules bake it and as a run by hand or `aos doctor` sees it.
test('upgrade from 1.9 keeps the Chief of Staff\'s model, effort and host (no failover) until --chief moves them; --undo returns them', () => {
  const sb = initialized();
  const cfgFile = path.join(sb.cfg, 'agenticos.json');
  const vaultCfgFile = path.join(sb.vault, 'brain', 'config.json');
  const user = readJson(cfgFile);
  fs.writeFileSync(cfgFile, JSON.stringify({ ...user, version: '1.9.0', claude: { ...user.claude, model: 'claude-sonnet-5' } }, null, 2));
  const v19 = readJson(vaultCfgFile);
  for (const k of ['persona', 'local', 'ai', 'provider']) delete v19[k];
  fs.writeFileSync(vaultCfgFile, JSON.stringify(v19, null, 2));
  fs.mkdirSync(path.join(sb.vault, 'persona'), { recursive: true });
  fs.writeFileSync(path.join(sb.vault, 'persona', 'answers.json'), JSON.stringify({ name: 'Atlas', dutyEffort: 'high', schedule: true }));
  fs.copyFileSync(path.join(ROOT, 'cli', 'fixtures', 'tick-1.9.md'), path.join(sb.vault, 'brain', 'routines', 'tick.md'));
  // What 1.9.0 ran every duty on: its schedules baked PERSONA_MODEL = persona.model → the interview's dutyModel →
  // claude.model, PERSONA_EFFORT = persona.effort → dutyEffort → medium (cli/schedule.js dutyRunDefaults at v1.9.0), on the
  // first enabled host whose CLI resolved (lib/headless.js resolveRunner at v1.9.0), and never anywhere else.
  const RAN_19 = { host: 'claude', model: 'claude-sonnet-5', effort: 'high' };
  const fakeCodex = path.join(ROOT, 'cli', 'fixtures', 'fake-codex.sh');
  const env = (extra = {}) => ({ ...sb.env, AOS_VAULT: sb.vault, AOS_CONFIG: cfgFile, ...extra });
  const chief = (extra) => {
    const r = spawnSync(process.execPath, [path.join(sb.vault, 'brain', 'scripts', 'persona', 'chief.js'), '--resolve', '--json'], { encoding: 'utf8', env: env(extra), cwd: sb.vault });
    const j = JSON.parse(r.stdout);
    return { host: j.host, model: j.model, effort: j.effort, reason: j.reason, primary: j.primary, failover: j.failover.map((f) => `${f.host} · ${f.model}`) };
  };
  /** What the next `aos routines sync` bakes into a duty's schedule (cli/routines.js scheduleVarsFor), as run-duty.sh gets it. */
  const baked = () => {
    const vars = require('./routines.js').scheduleVarsFor({ vault: sb.vault, configDir: sb.cfg, node: process.execPath, cfg: readJson(cfgFile) });
    return { PERSONA_MODEL: vars.MODEL, PERSONA_EFFORT: vars.EFFORT };
  };
  const ran = (extra) => { const c = chief(extra); return { host: c.host, model: c.model, effort: c.effort }; };

  const up = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  assert.deepEqual(ran(), RAN_19, 'a duty run by hand');
  assert.deepEqual(ran(baked()), RAN_19, 'a scheduled duty');
  assert.match(aos(sb, ['doctor']).stdout, /persona runner\s+claude · claude-sonnet-5 \(high\) \(.+\); failover: none$/m);
  const vc = readJson(vaultCfgFile);
  assert.deepEqual([vc.provider, vc.persona.model, vc.persona.codexModel, vc.persona.failover], ['auto', null, null, false], '1.9\'s values, not 2.0\'s defaults');
  assert.equal(vc.persona.perDayUsd, 6, 'the rest of the new defaults still arrive');
  assert.match(up.stdout, /^ {3}kept until you answer, in brain\/config\.json: provider = "auto", persona\.model = null, persona\.codexModel = null, persona\.failover = false$/m);

  // Both hosts (Codex added later): a signed-out Claude still holds the duty — it waits, as 1.9 never ran it on Codex.
  const both = readJson(cfgFile);
  both.hosts.codex = { enabled: true, bin: fakeCodex, home: path.join(sb.dir, 'codex') };
  fs.writeFileSync(cfgFile, JSON.stringify(both, null, 2));
  const twoHosts = { AOS_NO_CODEX: '', AOS_CODEX_BIN: fakeCodex };
  assert.deepEqual(chief(twoHosts).failover, [], 'no failover host named');
  const out = chief({ ...twoHosts, FAKE_CLAUDE_LOGGED_OUT: '1' });
  assert.deepEqual([out.host, out.reason, out.primary], [null, 'waiting-for-host', 'claude'], 'never moved to Codex');

  // The card's "Move the Chief of Staff": the CoS models and the failover; Undo puts back what the upgrade kept.
  const apply = aos(sb, ['migrate', 'local-first', '--apply', '--chief', '--json']);
  assert.equal(apply.status, 0, apply.stderr + apply.stdout);
  assert.deepEqual(ran(twoHosts), { host: 'claude', model: 'claude-opus-5-5', effort: 'high' }, 'moved; the interview\'s effort stays');
  assert.deepEqual(ran(baked()), { host: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  const moved = chief({ ...twoHosts, FAKE_CLAUDE_LOGGED_OUT: '1' });
  assert.deepEqual([moved.host, moved.model, moved.reason], ['codex', 'gpt-6-sol', 'auto'], 'with the move, a signed-out Claude hands the duty to Codex');
  const undo = aos(sb, ['migrate', 'local-first', '--undo', '--json']);
  assert.equal(undo.status, 0, undo.stderr + undo.stdout);
  const back = readJson(vaultCfgFile).persona;
  assert.deepEqual([back.model, back.codexModel, back.failover], [null, null, false]);
  assert.deepEqual(ran(twoHosts), RAN_19);
  assert.deepEqual(ran(baked()), RAN_19);
  assert.equal(chief({ ...twoHosts, FAKE_CLAUDE_LOGGED_OUT: '1' }).host, null, 'and it waits for its own host again');
});

test('init over an install from before 2.0 pins what it runs on, as upgrade does; over a 2.0 one, or a new vault, nothing', () => {
  const sb = initialized();
  const cfgFile = path.join(sb.cfg, 'agenticos.json');
  const vaultCfgFile = path.join(sb.vault, 'brain', 'config.json');
  const shape19 = (version) => {
    fs.writeFileSync(cfgFile, JSON.stringify({ ...readJson(cfgFile), version }, null, 2));
    const v = readJson(vaultCfgFile);
    delete v.persona;
    fs.writeFileSync(vaultCfgFile, JSON.stringify(v, null, 2));
  };
  const init = () => aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  shape19('1.9.0');
  const r = init();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /kept what this install runs on, in brain\/config\.json: persona\.model = null, persona\.codexModel = null, persona\.failover = false/);
  assert.deepEqual(readJson(vaultCfgFile).persona, { model: null, codexModel: null, failover: false });
  shape19('2.0.0');
  const again = init();
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.doesNotMatch(again.stdout, /kept what this install runs on/);
  assert.equal(readJson(vaultCfgFile).persona, undefined, 'a 2.0 install\'s defaults are its own');
  const fresh = sandbox();
  const n = aos(fresh, ['init', '--vault', fresh.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(n.status, 0, n.stderr);
  assert.doesNotMatch(n.stdout, /kept what/);
  assert.equal(readJson(path.join(fresh.vault, 'brain', 'config.json')).persona.model, 'claude-opus-5-5', 'a new install starts on the chief role');
});

test('the migrate flags are refused outside aos migrate (usage, exit 2)', () => {
  const sb = sandbox();
  for (const args of [['doctor', '--undo'], ['upgrade', '--apply'], ['status', '--chief'], ['doctor', '--decline'], ['provider', '--status']]) {
    const r = aos(sb, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${args[1]} is only for \`aos migrate\``));
  }
});

// A marketplace added from a local checkout (`aos init --from-local`) has no clone under plugins/marketplaces/: plain
// `aos upgrade` vendors from the directory the claude CLI reports and refreshes the plugin from it.
test('plain aos upgrade through the vendored CLI follows a directory marketplace, and refreshes the plugin from it', () => {
  const sb = initialized();
  const vendored = path.join(sb.vault, 'brain', 'scripts', 'cli', 'aos.js');
  const up = (args, env = {}) => spawnSync(process.execPath, [vendored, 'upgrade', '--no-obsidian', ...args], { encoding: 'utf8', env: { ...sb.env, ...env }, cwd: sb.dir });
  const lost = up([]);
  assert.equal(lost.status, 2, 'no marketplace known and no clone: the old error');
  assert.match(lost.stderr, /cannot locate the AgenticOS-Workbench checkout/);
  fs.writeFileSync(sb.env.FAKE_CLAUDE_LOG, '');
  const r = up([], { FAKE_MARKETPLACE_DIR: ROOT });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`upgrading ${reEsc(sb.vault)} from ${reEsc(ROOT)}`));
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin marketplace update agenticos-workbench\nplugin update agenticos@agenticos-workbench$/m);
  fs.writeFileSync(sb.env.FAKE_CLAUDE_LOG, '');
  assert.equal(up(['--from-local', ROOT], { FAKE_MARKETPLACE_DIR: ROOT }).status, 0);
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin update agenticos@agenticos-workbench$/m, '--from-local naming the marketplace directory refreshes the plugin too');
  fs.writeFileSync(sb.env.FAKE_CLAUDE_LOG, '');
  assert.equal(up(['--from-local', ROOT], { FAKE_MARKETPLACE_DIR: sb.dir }).status, 0);
  assert.doesNotMatch(sb.log('FAKE_CLAUDE_LOG'), /^plugin update/m, 'another checkout leaves the installed plugin alone');
});

test('upgradeReexecTarget: the checkout\'s own CLI runs in place; any other copy re-execs it; no CLI → null', () => {
  const { upgradeReexecTarget } = require('./aos.js');
  assert.equal(upgradeReexecTarget(ROOT, AOS), null);
  assert.equal(upgradeReexecTarget(ROOT, path.join(os.tmpdir(), 'vault', 'brain', 'scripts', 'cli', 'aos.js')), AOS);
  assert.equal(upgradeReexecTarget(fs.mkdtempSync(path.join(os.tmpdir(), 'no-cli-')), AOS), null);
});

test('aos upgrade run through the vendored CLI re-execs the checkout\'s cli/aos.js once, so a new upgrade step runs the first time', () => {
  const sb = initialized();
  const vendored = path.join(sb.vault, 'brain', 'scripts', 'cli', 'aos.js');
  // Simulate the vault's copy being one release behind: it lacks the routines migration and prints a marker instead.
  fs.writeFileSync(vendored, fs.readFileSync(vendored, 'utf8').replace("await act('seed brain/routines/ and re-render the installed schedules', () => migrateRoutines(ctx));", "out.log('STALE-VENDORED-UPGRADE');"));
  fs.rmSync(path.join(sb.vault, 'brain', 'routines'), { recursive: true, force: true });
  const r = spawnSync(process.execPath, [vendored, 'upgrade', '--no-obsidian', '--from-local', ROOT], { encoding: 'utf8', env: sb.env, cwd: ROOT });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /upgrade: running the checkout's cli\/aos\.js/);
  assert.ok(!r.stdout.includes('STALE-VENDORED-UPGRADE'), 'the stale copy never reaches its own upgrade body');
  assert.match(r.stdout, /seeded brain\/routines\/ \(briefing, import-digest, monitor, reflect, sitrep\)/, 'the new step ran on the first upgrade');
  assert.equal((r.stdout.match(/upgrading /g) || []).length, 1, 'exactly one upgrade runs (no loop)');
  assert.ok(!fs.readFileSync(vendored, 'utf8').includes('STALE-VENDORED-UPGRADE'), 're-vendored on the way');
  // Run directly from the checkout: no re-exec line.
  const direct = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(direct.status, 0, direct.stderr);
  assert.ok(!/running the checkout/.test(direct.stdout));
});

test('uninstall --keep-vault removes config, plugin, launcher link, duty schedules; keeps the vault and the Ollama supervisor', () => {
  const sb = initialized();
  // Schedules live under $HOME (sandboxed): two of Plan 5's duty labels plus Plan 2's Ollama supervisor label.
  const agents = path.join(sb.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  for (const f of ['com.agenticos.monitor.plist', 'com.agenticos.sitrep.plist', 'com.agenticos.ollama.plist']) fs.writeFileSync(path.join(agents, f), '<plist/>\n');
  const r = aos(sb, ['uninstall', '--keep-vault', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'agenticos.json')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.local', 'bin', 'aos')));
  assert.ok(fs.existsSync(path.join(sb.vault, 'MEMORY.md')));
  assert.ok(!fs.existsSync(path.join(agents, 'com.agenticos.monitor.plist')), 'duty schedule removed');
  assert.ok(!fs.existsSync(path.join(agents, 'com.agenticos.sitrep.plist')), 'duty schedule removed');
  assert.ok(fs.existsSync(path.join(agents, 'com.agenticos.ollama.plist')), 'Ollama supervisor (Plan 2, extras/ollama) is not ours to remove');
  const log = sb.log('FAKE_CLAUDE_LOG');
  assert.match(log, /^plugin uninstall agenticos@agenticos-workbench$/m);
  assert.match(log, /^plugin marketplace remove agenticos-workbench$/m);
  assert.deepEqual(fs.readdirSync(sb.cfg), []);
  assert.ok(!fs.existsSync(path.join(sb.home, '.local', 'share', 'agenticos', 'graphify')), 'the graphify tool dir is ours and goes');
  assert.match(r.stdout, /removed .*agenticos\/graphify$/m);
});

test('uninstall deletes the vault only with the typed confirmation', () => {
  const sb = initialized();
  const kept = aos(sb, ['uninstall', '--yes']);
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(fs.existsSync(sb.vault), 'no confirmation → kept');
  // --yes is "accept defaults, no prompts", and the default is to keep: it never prompts and never deletes.
  assert.match(kept.stdout, /--yes never deletes/);
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault: sb.vault, node: process.execPath }));
  const gone = aos(sb, ['uninstall', '--yes'], { AOS_CONFIRM_DELETE: sb.vault });
  assert.equal(gone.status, 0, gone.stderr);
  assert.ok(!fs.existsSync(sb.vault));
});

test('persona on/off toggle the kill switch; persona and cost subcommands are wired', () => {
  const sb = initialized();
  assert.equal(aos(sb, ['persona', 'off']).status, 0);
  assert.ok(fs.existsSync(path.join(sb.vault, 'persona', 'DISABLED')));
  assert.equal(aos(sb, ['persona', 'on']).status, 0);
  assert.ok(!fs.existsSync(path.join(sb.vault, 'persona', 'DISABLED')));
  const interview = aos(sb, ['persona']);                       // stdin is a pipe: no terminal, no --persona-json, no answers.json
  assert.equal(interview.status, 1);
  assert.match(interview.stdout + interview.stderr, /no --persona-json and no terminal/);
  const rename = aos(sb, ['persona', 'rename', 'Atlas']);        // nothing to rename yet
  assert.equal(rename.status, 1);
  assert.match(rename.stderr, /no persona to rename/);
  const seeded = aos(sb, ['persona', '--persona-json', path.join(ROOT, 'cli', 'fixtures', 'persona.json')]);
  assert.equal(seeded.status, 0, seeded.stderr);
  assert.match(fs.readFileSync(path.join(sb.vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Atlas$/m);
  // final review Minor 19 (tests-13) / tests-1: ~/Library/LaunchAgents only exists on darwin, so the old
  // check was vacuously true on Linux. cli/persona-cmd.js:84 is the only place that prints the
  // "persona: scheduled " prefix, and that prefix is platform-independent — but the labels it prints
  // differ: com.agenticos.<duty> on darwin, # com.agenticos.<duty> on linux (cli/schedule.js:22/:130).
  assert.ok(!/^persona: scheduled /m.test(seeded.stdout + seeded.stderr), 'fixture says schedule: false — no launchd plists, no crontab lines, on any platform');
  assert.ok(!fs.existsSync(path.join(sb.home, 'Library', 'LaunchAgents')), 'no plists on darwin');
  // final review Minor 13 (tests-7): the analyzer has shipped in extras/cost since Plan 5 Task 1 (ruling A2),
  // so the "not installed in this phase" branch is dead — assert the one outcome that can happen.
  const cost = aos(sb, ['cost', 'enable'], { AOS_REPO_HINT: ROOT });
  assert.equal(cost.status, 0, cost.stderr);
  assert.match(cost.stdout, /cost: enabled \(python3 /);
  assert.equal(aos(sb, ['cost', 'disable']).status, 0);
  assert.equal(readJson(path.join(sb.cfg, 'agenticos.json')).cost.enabled, false);
  assert.match(aos(sb, ['cost']).stdout, /cost disabled/);
  assert.equal(aos(sb, ['terminal']).status, 2);
  const term = aos(sb, ['terminal', 'install']);
  assert.equal(term.status, 0, term.stderr);
  assert.match(term.stdout, /nothing to install — the UniDeX app brings its own terminal/);
});

test('uninstall warns when the claude CLI cannot remove the plugin, and refuses to delete a structurally invalid vault', () => {
  const sb = initialized();
  const warned = aos(sb, ['uninstall', '--keep-vault', '--yes'], { AOS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /claude plugin uninstall agenticos@agenticos-workbench failed/);
  assert.match(warned.stderr, /claude plugin marketplace remove agenticos-workbench failed/);
  assert.ok(fs.existsSync(path.join(sb.vault, 'MEMORY.md')), 'vault kept');
  // A config that names the home directory must never be deleted, even with the automation confirmation set.
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault: sb.home, node: process.execPath }));
  const refused = aos(sb, ['uninstall', '--yes'], { AOS_CONFIRM_DELETE: sb.home });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing the home directory/);
  assert.ok(fs.existsSync(path.join(sb.home, '.local')), 'home directory intact');
});

test('uninstall refuses to delete a directory that contains the Claude config dir, and a directory without vault markers', () => {
  const sb = initialized();
  // sb.dir is the parent of the sandbox HOME, the Claude config dir and the vault: deleting it would take the
  // config dir with it, so the structural guard must refuse even with the automation confirmation set.
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault: sb.dir, node: process.execPath }));
  const refused = aos(sb, ['uninstall', '--yes'], { AOS_CONFIRM_DELETE: sb.dir });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /contains the Claude config dir/);
  assert.ok(fs.existsSync(path.join(sb.vault, 'MEMORY.md')), 'nothing was deleted');

  // A structurally fine directory that is not a vault this installer built is refused too.
  const plain = path.join(sb.dir, 'not-a-vault');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'notes.txt'), 'mine\n');
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault: plain, node: process.execPath }));
  const notAVault = aos(sb, ['uninstall', '--yes'], { AOS_CONFIRM_DELETE: plain });
  assert.equal(notAVault.status, 1);
  assert.match(notAVault.stderr, /not an AgenticOS vault/);
  assert.ok(fs.existsSync(path.join(plain, 'notes.txt')), 'the directory is left alone');
});

// final review F7 (= safety-6), applied to cli/aos.js's own handling of the same file: `init` used to
// replace a corrupt brain/config.json with the defaults, and `upgrade` used to merge the defaults over
// `{}` — both silently discarding everything the user had configured. Both now refuse.
test('init and upgrade refuse an unparseable brain/config.json instead of replacing it', () => {
  const corrupt = '{ "dailyNote": { "layout": "custom"\n';

  const fresh = sandbox();
  fs.mkdirSync(path.join(fresh.vault, 'brain'), { recursive: true });
  const freshCfg = path.join(fresh.vault, 'brain', 'config.json');
  fs.writeFileSync(freshCfg, corrupt);
  const r = aos(fresh, ['init', '--vault', fresh.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /refusing to touch unparseable .*config\.json/);
  assert.equal(fs.readFileSync(freshCfg, 'utf8'), corrupt, 'the corrupt file is byte-identical');
  assert.ok(!fs.existsSync(path.join(fresh.vault, 'MEMORY.md')), 'the refusal precedes the seed copy');
  assert.ok(!fs.existsSync(path.join(fresh.cfg, 'agenticos.json')), 'nothing past the seed step ran');

  const sb = initialized();
  const cfgFile = path.join(sb.vault, 'brain', 'config.json');
  fs.writeFileSync(cfgFile, corrupt);
  const up = aos(sb, ['upgrade']);
  assert.equal(up.status, 1, up.stdout);
  assert.match(up.stderr, /refusing to touch unparseable .*config\.json/);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), corrupt, 'upgrade never merges defaults over a file it could not read');
});

// ── Codex host (design D1/D3/D4): --host both, the partial uninstall, and the upgrade re-wire ──────────
const FAKE_CODEX = path.join(ROOT, 'cli', 'fixtures', 'fake-codex.sh');
/** The Claude-only sandbox plus a fake codex and a sandboxed Codex home (AOS_NO_CODEX lifted). */
function twoHostSandbox() {
  const sb = sandbox();
  delete sb.env.AOS_NO_CODEX;
  sb.codexHome = path.join(sb.dir, 'codex');
  fs.mkdirSync(sb.codexHome, { recursive: true });
  Object.assign(sb.env, { AOS_CODEX_BIN: FAKE_CODEX, CODEX_HOME: sb.codexHome, FAKE_CODEX_LOG: path.join(sb.dir, 'codex.log'), FAKE_CODEX_STATE: path.join(sb.dir, 'codex-mcp.state') });
  return sb;
}

test('direct wiring (a Codex CLI without plugins): init --host both wires the plugin and the Codex host; uninstall --host codex removes only the Codex wiring; upgrade re-wires it', () => {
  const sb = twoHostSandbox();
  sb.env.FAKE_CODEX_NO_PLUGINS = '1';
  const skills = path.join(sb.home, '.agents', 'skills');
  const hooks = path.join(sb.codexHome, 'hooks.json');
  const r = aos(sb, ['init', '--host', 'both', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /preflight: hosts claude\+codex .*\(direct wiring\)/);
  assert.match(r.stdout, /hooks written · MCP added · skills 28 generated/);
  assert.match(r.stdout, /run \/hooks, and trust the AgenticOS entries once/);
  assert.match(r.stdout, /use \$wrap at the end/);
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  const cfg = readJson(cfgPath);
  assert.deepEqual(cfg.hosts, {
    claude: { enabled: true, configDir: sb.cfg, bin: FAKE_CLAUDE },
    codex: { enabled: true, home: sb.codexHome, bin: FAKE_CODEX, install: 'direct' },
  });
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin install agenticos@agenticos-workbench$/m);
  assert.match(sb.log('FAKE_CODEX_LOG'), new RegExp(`^mcp add agenticos --env AOS_CONFIG=${cfgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --env AOS_HOST=codex -- sh ${path.join(sb.vault, 'brain', 'scripts', 'bin', 'aos').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} mcp-server$`, 'm'));
  const doc = readJson(hooks);
  assert.deepEqual(Object.keys(doc.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
  assert.match(doc.hooks.Stop[0].hooks[0].command, new RegExp(`^env AOS_HOST=codex AOS_CONFIG='${cfgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' sh '.*bin/aos' update-session$`));
  assert.ok(fs.existsSync(path.join(skills, 'wrap', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(sb.vault, 'brain', 'scripts', 'plugin', 'commands', 'wrap.md')), 'plugin/commands is vendored for the generator');
  assert.ok(fs.existsSync(path.join(sb.vault, 'brain', 'scripts', 'plugin', 'skills', 'recall', 'SKILL.md')), 'plugin/skills is vendored for the generator');

  // doctor: both hosts' rows
  const dr = aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') });
  assert.equal(dr.status, 0, dr.stdout + dr.stderr);
  assert.match(dr.stdout, /ok\s+claude login/);
  assert.match(dr.stdout, /ok\s+plugin installed/);
  assert.match(dr.stdout, /ok\s+codex login/);
  assert.match(dr.stdout, /ok\s+codex hooks\s+5 of 5 events/);
  assert.match(dr.stdout, /ok\s+codex MCP declared/);
  assert.match(dr.stdout, /ok\s+codex skills\s+28 generated/);
  assert.match(dr.stdout, /ok\s+cross-review\s+cross-provider \(claude and codex review each other\)$/m);
  assert.match(aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin'), FAKE_CODEX_LOGGED_OUT: '1' }).stdout,
    /warn\s+cross-review\s+same-provider only: codex CLI not logged in/);
  const st = aos(sb, ['status']);
  assert.match(st.stdout, /^hosts\s+claude, codex$/m);
  assert.match(st.stdout, /^codex\s+bin=/m);

  // partial uninstall: the Codex wiring goes, the plugin, config, launcher and vault stay
  const part = aos(sb, ['uninstall', '--host', 'codex', '--yes']);
  assert.equal(part.status, 0, part.stderr + part.stdout);
  assert.match(part.stdout, /codex host removed: hooks deleted \(5 entries\) · MCP removed · 28 skills deleted/);
  assert.match(part.stdout, /hosts now: claude$/m);
  assert.ok(!fs.existsSync(hooks));
  assert.ok(!fs.existsSync(path.join(skills, 'wrap')));
  assert.equal(readJson(cfgPath).hosts.codex.enabled, false);
  assert.equal(readJson(cfgPath).hosts.claude.enabled, true);
  assert.ok(fs.existsSync(cfgPath));
  assert.ok(fs.existsSync(path.join(sb.home, '.local', 'bin', 'aos')));
  assert.doesNotMatch(sb.log('FAKE_CLAUDE_LOG'), /plugin uninstall/);
  assert.match(sb.log('FAKE_CODEX_LOG'), /^mcp remove agenticos$/m);

  // upgrade with the Codex host off does not re-wire; re-enabling through init does, and upgrade then keeps it wired
  const up1 = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(up1.status, 0, up1.stderr + up1.stdout);
  assert.doesNotMatch(up1.stdout, /re-wire the Codex host/);
  assert.ok(!fs.existsSync(hooks));
  const again = aos(sb, ['init', '--host', 'both', '--vault', sb.vault, '--no-obsidian', '--yes']);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.ok(fs.existsSync(hooks));
  fs.rmSync(path.join(skills, 'remember'), { recursive: true, force: true });
  const up2 = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(up2.status, 0, up2.stderr + up2.stdout);
  assert.match(up2.stdout, /re-wire the Codex host/);
  assert.match(up2.stdout, /hooks unchanged · MCP present · skills 28 regenerated/);
  assert.ok(fs.existsSync(path.join(skills, 'remember', 'SKILL.md')), 'a deleted generated skill comes back on upgrade');

  // a full uninstall takes both hosts down
  const full = aos(sb, ['uninstall', '--keep-vault', '--yes']);
  assert.equal(full.status, 0, full.stderr + full.stdout);
  assert.ok(!fs.existsSync(hooks));
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin uninstall agenticos@agenticos-workbench$/m);
  assert.ok(!fs.existsSync(cfgPath));
});

// ── the Codex plugin (design 2026-09-23-codex-plugin D4–D6) ──────────────────
/** 15 trusted [hooks.state] tables for our plugin's entries, the shape Codex writes after /hooks. */
function trustAllPluginHooks(codexHome) {
  const CH = require('./codex-host.js');
  const keys = CH.HOOKS.flatMap(([event, cmds]) => cmds.map((_, i) => `${event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}:0:${i}`));
  fs.appendFileSync(path.join(codexHome, 'config.toml'), keys.map((k) => `[hooks.state."agenticos@agenticos-workbench:hooks/hooks.json:${k}"]\ntrusted_hash = "sha256:00ff"\n`).join('\n'));
}

test('plugin mode: init --host both installs the agenticos Codex plugin and writes nothing into Codex\'s own config; doctor, status, upgrade, uninstall follow it', () => {
  const sb = twoHostSandbox();
  const skills = path.join(sb.home, '.agents', 'skills');
  const hooks = path.join(sb.codexHome, 'hooks.json');
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  const r = aos(sb, ['init', '--host', 'both', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /preflight: hosts claude\+codex .*\(plugin\)/);
  assert.match(r.stdout, /install the Codex plugin agenticos@agenticos-workbench from the agenticos-workbench marketplace/);
  assert.match(r.stdout, /plugin agenticos@agenticos-workbench 0\.0\.0-fake installed from zzoretich\/UniDeX-Agent-Harness$/m);
  assert.match(r.stdout, /trust the agenticos@agenticos-workbench entries once; they stay trusted across aos upgrade/);
  assert.match(r.stdout, /use \$agenticos:wrap at the end/);
  const log = sb.log('FAKE_CODEX_LOG');
  assert.match(log, /^plugin marketplace add zzoretich\/UniDeX-Agent-Harness --json$/m);
  assert.match(log, /^plugin add agenticos@agenticos-workbench --json$/m);
  assert.doesNotMatch(log, /^mcp add /m, 'no direct MCP registration');
  assert.ok(!fs.existsSync(hooks), 'nothing written into ~/.codex/hooks.json');
  assert.ok(!fs.existsSync(path.join(skills, 'wrap')), 'no generated skills under ~/.agents/skills');
  assert.equal(readJson(cfgPath).hosts.codex.install, 'plugin');
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin install agenticos@agenticos-workbench$/m, 'the Claude Code plugin is untouched');

  // doctor: plugin rows; the untrusted hooks are a warning until /hooks, then ok
  const dr = aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') });
  assert.equal(dr.status, 0, dr.stdout + dr.stderr);
  assert.match(dr.stdout, /ok\s+codex plugin\s+agenticos@agenticos-workbench 0\.0\.0-fake/);
  assert.match(dr.stdout, /warn\s+codex hooks trusted\s+0 of 16 — open codex, run \/hooks/);
  assert.match(dr.stdout, /ok\s+codex MCP declared\s+agenticos from the plugin/);
  assert.doesNotMatch(dr.stdout, /codex direct wiring|codex skills|codex hooks\s+\d/);
  trustAllPluginHooks(sb.codexHome);
  assert.match(aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') }).stdout, /ok\s+codex hooks trusted\s+16 of 16$/m);
  assert.match(aos(sb, ['status']).stdout, /^codex\s+bin=.* install=plugin$/m);

  // upgrade --from-local switches the marketplace to this checkout and reinstalls its version
  const up = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  assert.match(up.stdout, /install or refresh the Codex plugin agenticos@agenticos-workbench, then remove any direct wiring/);
  const version = readJson(path.join(ROOT, 'package.json')).version;
  assert.match(up.stdout, new RegExp(`plugin agenticos@agenticos-workbench ${reEsc(version)} installed from ${reEsc(ROOT)}$`, 'm'));
  assert.doesNotMatch(up.stdout, /trust the agenticos entries/, 'already the plugin: no new trust prompt');
  assert.match(sb.log('FAKE_CODEX_LOG'), new RegExp(`^plugin marketplace remove agenticos-workbench\\nplugin marketplace add ${reEsc(ROOT)} --json$`, 'm'));

  // partial uninstall: the plugin and its marketplace go, the Claude side stays
  const part = aos(sb, ['uninstall', '--host', 'codex', '--yes']);
  assert.equal(part.status, 0, part.stderr + part.stdout);
  assert.match(part.stdout, /codex plugin removed: plugin removed · marketplace removed$/m);
  assert.match(part.stdout, /hosts now: claude$/m);
  assert.match(sb.log('FAKE_CODEX_LOG'), /^plugin remove agenticos@agenticos-workbench$/m);
  assert.equal(readJson(cfgPath).hosts.codex.enabled, false);
  assert.ok(!('install' in readJson(cfgPath).hosts.codex));
  assert.doesNotMatch(sb.log('FAKE_CLAUDE_LOG'), /plugin uninstall/);
});

test('plugin mode: aos upgrade moves a direct install to the plugin and removes every piece of the direct wiring (D5)', () => {
  const sb = twoHostSandbox();
  const skills = path.join(sb.home, '.agents', 'skills');
  const hooks = path.join(sb.codexHome, 'hooks.json');
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  // installed while the Codex CLI had no plugins
  const r = aos(sb, ['init', '--host', 'codex', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes'], { FAKE_CODEX_NO_PLUGINS: '1' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(hooks) && fs.existsSync(path.join(skills, 'wrap', 'SKILL.md')) && fs.existsSync(sb.env.FAKE_CODEX_STATE));
  assert.equal(readJson(cfgPath).hosts.codex.install, 'direct');
  // the CLI now installs plugins
  const up = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  assert.match(up.stdout, / installed from .* · direct wiring removed \(5 hook entries, the MCP registration, 28 skills\)$/m);
  assert.match(up.stdout, /Codex asks once to trust the plugin's hooks: open codex, run \/hooks/);
  assert.ok(!fs.existsSync(hooks));
  assert.ok(!fs.existsSync(path.join(skills, 'wrap')));
  assert.ok(!fs.existsSync(sb.env.FAKE_CODEX_STATE), 'the direct MCP registration is gone');
  assert.equal(readJson(cfgPath).hosts.codex.install, 'plugin');
  const dr = aos(sb, ['doctor']);
  assert.match(dr.stdout, /ok\s+codex plugin/);
  assert.doesNotMatch(dr.stdout, /codex direct wiring/);
  // leftovers written by hand beside the plugin show up in doctor, and the next upgrade clears them
  fs.writeFileSync(hooks, JSON.stringify(require('./codex-host.js').mergeHooks(null, { launcher: '/v/brain/scripts/bin/aos', config: cfgPath })));
  assert.match(aos(sb, ['doctor']).stdout, /warn\s+codex direct wiring\s+still present beside the plugin: 5 hook events in /);
  assert.equal(aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]).status, 0);
  assert.ok(!fs.existsSync(hooks));
  // full uninstall with the plugin in place
  const full = aos(sb, ['uninstall', '--keep-vault', '--yes']);
  assert.equal(full.status, 0, full.stderr + full.stdout);
  assert.match(full.stdout, /codex plugin removed: plugin removed · marketplace removed$/m);
});

test('plugin mode: a plugin install that fails falls back to the direct wiring, and the next upgrade tries the plugin again', () => {
  const sb = twoHostSandbox();
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  const r = aos(sb, ['init', '--host', 'codex', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes'], { FAKE_CODEX_FAIL_PLUGIN: '1' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr + r.stdout, /codex plugin add failed .* run: codex plugin add agenticos@agenticos-workbench/);
  assert.match(r.stderr + r.stdout, /the Codex plugin could not be installed; wiring Codex directly instead/);
  assert.match(r.stdout, /hooks written · MCP added · skills 28 generated/);
  assert.equal(readJson(cfgPath).hosts.codex.install, 'direct');
  assert.match(r.stdout, /run \/hooks, and trust the AgenticOS entries once/, 'the checklist describes what was actually installed');
  const up = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  assert.equal(readJson(cfgPath).hosts.codex.install, 'plugin');
  assert.ok(!fs.existsSync(path.join(sb.codexHome, 'hooks.json')));
});

test('init --host codex refuses without a codex CLI; --host auto picks whatever is installed and logged in', () => {
  const sb = twoHostSandbox();
  const none = aos(sb, ['init', '--host', 'codex', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes'], { AOS_NO_CODEX: '1', AOS_CODEX_BIN: '' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /codex CLI not found/);
  const out = aos(sb, ['init', '--host', 'codex', '--vault', sb.vault, '--no-obsidian', '--yes'], { FAKE_CODEX_LOGGED_OUT: '1' });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /codex is not logged in/);
  assert.equal(aos(sb, ['init', '--host', 'bogus', '--vault', sb.vault, '--yes']).status, 2);
  // auto with both CLIs available → both
  const auto = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(auto.status, 0, auto.stderr + auto.stdout);
  assert.match(auto.stdout, /preflight: hosts claude\+codex/);
  // auto with codex logged out → claude only, and the selection is remembered on a re-run
  const sb2 = twoHostSandbox();
  const claudeOnly = aos(sb2, ['init', '--vault', sb2.vault, '--no-obsidian', '--provider', 'none', '--yes'], { FAKE_CODEX_LOGGED_OUT: '1' });
  assert.equal(claudeOnly.status, 0, claudeOnly.stderr + claudeOnly.stdout);
  assert.match(claudeOnly.stdout, /preflight: hosts claude ·/);
  assert.equal(readJson(path.join(sb2.cfg, 'agenticos.json')).hosts.codex.enabled, false);
  const rerun = aos(sb2, ['init', '--vault', sb2.vault, '--no-obsidian', '--yes']);
  assert.match(rerun.stdout, /preflight: hosts claude ·/, 'a re-run keeps the recorded selection even though codex is now logged in');
});

test('buildUserConfig migrates a pre-hosts config into a Claude-only hosts block and keeps a recorded Codex home', () => {
  const { buildUserConfig } = require('./aos.js');
  const old = { version: '0.3.0', vault: '/v', node: '/n', claudeConfigDir: '/c', provider: 'auto', claude: { model: 'haiku', bin: '/x/claude' } };
  const next = buildUserConfig(old, { vault: '/v', version: '0.5.0', bin: '/x/claude' });
  assert.equal(next.hosts.claude.enabled, true);
  assert.equal(next.hosts.claude.bin, '/x/claude');
  assert.equal(next.hosts.codex.enabled, false);
  assert.ok(next.hosts.codex.home.endsWith('.codex'));
  const kept = buildUserConfig({ ...old, hosts: { claude: { enabled: false }, codex: { enabled: true, home: '/ch', bin: '/x/codex' } } }, { vault: '/v', version: '0.5.0' });
  assert.equal(kept.hosts.claude.enabled, false);
  assert.deepEqual(kept.hosts.codex, { enabled: true, home: '/ch', bin: '/x/codex' });
  const flipped = buildUserConfig(kept, { vault: '/v', version: '0.5.0', hosts: { claude: true, codex: false }, codexBin: null });
  assert.equal(flipped.hosts.claude.enabled, true);
  assert.equal(flipped.hosts.codex.enabled, false);
  assert.ok(!('bin' in flipped.hosts.codex), 'a null codexBin clears the recorded path');
});

test('spendByFamily (spec 2026-09-24-settings-tab D7): today\'s USD per family, the same split `aos status` prints', () => {
  const { spendByFamily } = require('./aos.js');
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-spend-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  const day = new Date();
  const ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).toISOString();
  const row = (feature, usd, when = ts) => `${JSON.stringify({ ts: when, feature, provider: 'claude', usd })}\n`;
  fs.writeFileSync(path.join(vault, 'brain', '_index', 'provider-spend.jsonl'),
    row('session-summary', 0.01) + row('codex-extract', 0.02) + row('duty:monitor', 2) + row('reason:ask', 0.3) + row('routine:inbox', 0.4) +
    row('graph:semantic', 0.5) + row('cross-review:review', 1.25) + row('team:dev:builder', 0.75) + row('session:codex', 0.6) + row('session-summary', 9, '2020-01-01T00:00:00.000Z'));
  assert.deepEqual(spendByFamily(vault), { hooks: 0.03, duties: 2, reasoner: 0.3, routines: 0.4, graph: 0.5, crossReview: 1.25, sessions: 0.6, teams: 0.75 }, 'session-summary is a hook; session:<host> is a session turn');
  assert.deepEqual(spendByFamily(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-spend-none-'))), { hooks: 0, duties: 0, reasoner: 0, routines: 0, graph: 0, crossReview: 0, sessions: 0, teams: 0 });
});

test('output larger than a pipe buffer arrives whole: `aos config list --json` read through a pipe parses', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault: sb.vault, node: process.execPath }, null, 2));
  const r = aos(sb, ['config', 'list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length > 65536, `the list is ${r.stdout.length} bytes: past one 64 KB pipe buffer, as the test needs`);
  assert.ok(JSON.parse(r.stdout).settings.length > 80, 'the whole list, not the first 64 KB');
});
