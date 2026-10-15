'use strict';
// `aos hosts add <host>` (install-import B2): one more host wired into an existing install, through init's own steps,
// with the other host left as it was, that host's fast import phases and the schedules re-rendered; refused, writing
// nothing, when there is no vault or the host's CLI is missing or signed out. Fake claude and codex CLIs only.
delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AOS = path.join(ROOT, 'cli', 'aos.js');
const F = (n) => path.join(ROOT, 'cli', 'fixtures', n);
const IMPORT_FIX = path.join(ROOT, 'brain', 'scripts', 'test', 'fixtures', 'import');

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hosts-')));
  const home = path.join(dir, 'home');
  const cfg = path.join(dir, 'cfg');
  const codexHome = path.join(dir, 'codex');
  for (const d of [home, cfg, codexHome]) fs.mkdirSync(d, { recursive: true });
  const env = {
    ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codexHome,
    AOS_CLAUDE_BIN: F('fake-claude.sh'), AOS_CODEX_BIN: F('fake-codex.sh'), AOS_NPM_BIN: F('fake-npm.sh'), AOS_OLLAMA_BIN: F('fake-ollama.sh'), AOS_UV_BIN: F('fake-uv.sh'),
    FAKE_UV_LOG: path.join(dir, 'uv.log'), FAKE_CLAUDE_LOG: path.join(dir, 'claude.log'), FAKE_CODEX_LOG: path.join(dir, 'codex.log'),
    FAKE_CODEX_STATE: path.join(dir, 'codex-mcp.state'), FAKE_NPM_LOG: path.join(dir, 'npm.log'), FAKE_NPM_NODE_MODULES: path.join(ROOT, 'node_modules'),
    OLLAMA_PORT: '1', AOS_SKIP_OLLAMA_PROBE: '1',
  };
  for (const k of ['AOS_VAULT', 'BRAIN_VAULT', 'AOS_CONFIG', 'CLAUDE_PROJECT_DIR', 'XDG_DATA_HOME', 'AOS_NO_CODEX', 'AOS_NO_CLAUDE']) delete env[k];
  const sb = { dir, home, cfg, codexHome, vault: path.join(dir, 'vault'), env, cfgFile: path.join(cfg, 'agenticos.json') };
  sb.aos = (args, extra = {}) => spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', env: { ...env, ...extra }, cwd: ROOT });
  sb.log = (k) => { try { return fs.readFileSync(env[k], 'utf8'); } catch { return ''; } };
  return sb;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('a Claude Code install adds Codex: wired as a plugin, both hosts on, AGENTS.md and config.toml imported', () => {
  const sb = sandbox();
  const init = sb.aos(['init', '--host', 'claude', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  fs.copyFileSync(path.join(IMPORT_FIX, 'codex-home', 'AGENTS.md'), path.join(sb.codexHome, 'AGENTS.md'));
  fs.copyFileSync(path.join(IMPORT_FIX, 'codex-home', 'config.toml'), path.join(sb.codexHome, 'config.toml'));
  const before = readJson(sb.cfgFile);
  assert.deepEqual([before.hosts.claude.enabled, before.hosts.codex.enabled], [true, false]);
  const r = sb.aos(['hosts', 'add', 'codex']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const cfg = readJson(sb.cfgFile);
  assert.equal(cfg.vault, sb.vault, 'the recorded vault, never the default');
  assert.deepEqual([cfg.hosts.claude.enabled, cfg.hosts.codex.enabled, cfg.hosts.codex.install, cfg.hosts.codex.bin], [true, true, 'plugin', F('fake-codex.sh')]);
  assert.equal(cfg.hosts.claude.bin, before.hosts.claude.bin, 'the other host is untouched');
  assert.match(sb.log('FAKE_CODEX_LOG'), /^plugin add agenticos@agenticos-workbench --json$/m);
  assert.match(r.stdout, /^hosts add codex: .*fake-codex\.sh$/m);
  assert.match(r.stdout, /^- instructions \(Codex\): 1 written/m, 'whole file: no local model under provider none');
  assert.match(r.stdout, /^- mcp: 2 on Codex listed$/m);
  assert.match(r.stdout, /^- no schedules installed; nothing to re-render/m);
  assert.match(r.stdout, /run \/hooks, and trust the agenticos@agenticos-workbench entries once/);
  assert.match(r.stdout, /Bring in its session history: aos import --from codex$/m);
  assert.doesNotMatch(r.stdout, /sessions queued/, 'the digest is not queued by hosts add');
  const ref = fs.readdirSync(path.join(sb.vault, 'brain', 'memory', 'reference')).find((f) => f.startsWith('codex-global-instructions'));
  assert.ok(ref, 'AGENTS.md became one reference memory');
  assert.match(fs.readFileSync(path.join(sb.vault, 'brain', 'memory', 'reference', ref), 'utf8'), /source: import:codex/);
  const servers = readJson(path.join(sb.vault, 'brain', '_index', 'mcp-servers.json')).servers;
  assert.deepEqual(servers.map((s) => s.name), ['issue-tracker', 'web fetch']);
  assert.ok(!fs.existsSync(path.join(sb.vault, 'brain', '_index', 'import-state.json')) || !readJson(path.join(sb.vault, 'brain', '_index', 'import-state.json')).digest);
});

test('a Codex install adds Claude Code: the plugin installed, both hosts on', () => {
  const sb = sandbox();
  const init = sb.aos(['init', '--host', 'codex', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  fs.writeFileSync(path.join(sb.cfg, 'CLAUDE.md'), '- Always run the tests before saying it is done.\n');
  const r = sb.aos(['hosts', 'add', 'claude', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin marketplace add .*$/m);
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin install agenticos@agenticos-workbench$/m);
  const cfg = readJson(sb.cfgFile);
  assert.deepEqual([cfg.hosts.claude.enabled, cfg.hosts.codex.enabled, cfg.hosts.claude.bin], [true, true, F('fake-claude.sh')]);
  assert.match(r.stdout, /^- instructions \(Claude Code\): 1 written/m);
  assert.match(r.stdout, /Add this line to your CLAUDE\.md .* if it is not there yet:\n\s+@.*AGENTICOS\.md/);
});

test('refused, writing nothing: no vault, a missing CLI, a signed-out CLI, a bad verb', () => {
  const sb = sandbox();
  const none = sb.aos(['hosts', 'add', 'codex']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no vault in .*agenticos\.json — run `aos init` first/);
  const init = sb.aos(['init', '--host', 'claude', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const cfgBefore = fs.readFileSync(sb.cfgFile, 'utf8');
  const missing = sb.aos(['hosts', 'add', 'codex'], { AOS_NO_CODEX: '1' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /codex CLI not found — install Codex CLI, then run `aos hosts add codex`/);
  const out = sb.aos(['hosts', 'add', 'codex'], { FAKE_CODEX_LOGGED_OUT: '1' });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /codex is not signed in — run `codex login`/);
  const claudeOut = sb.aos(['hosts', 'add', 'claude'], { FAKE_CLAUDE_LOGGED_OUT: '1' });
  assert.equal(claudeOut.status, 1);
  assert.match(claudeOut.stderr, /claude is not signed in — run `claude auth login`/);
  const claudeMissing = sb.aos(['hosts', 'add', 'claude'], { AOS_NO_CLAUDE: '1' });
  assert.equal(claudeMissing.status, 1);
  assert.match(claudeMissing.stderr, /claude CLI not found/);
  assert.equal(fs.readFileSync(sb.cfgFile, 'utf8'), cfgBefore, 'agenticos.json untouched by every refusal');
  assert.doesNotMatch(sb.log('FAKE_CODEX_LOG'), /plugin add/);
  for (const args of [['hosts'], ['hosts', 'add'], ['hosts', 'add', 'cursor'], ['hosts', 'remove', 'codex'], ['hosts', 'add', 'codex', 'extra']]) {
    const r = sb.aos(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /aos hosts add <claude\|codex>/);
  }
});
