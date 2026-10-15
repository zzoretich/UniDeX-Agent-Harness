'use strict';
// `aos mcp copy` (install-import B6): one MCP server made available on the other host, per direction, against fake
// `claude` and `codex` CLIs that record their argv and write the entry the way the real ones do. The dry run shows the
// exact command with every secret hidden and writes nothing; a real run backs the target's file up first (0600), runs the
// host's own CLI with the real values, and lists both hosts again into mcp-servers.json; refusals write nothing.
delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeWorld } = require('../brain/scripts/test/import-world.js');
const M = require('./mcp.js');

const AOS = path.join(__dirname, 'aos.js');
// Values a test checks never leave the run: none of them may appear in stdout, stderr or the vault.
const SECRET = { env: 'tok-fixture-secret-0001', arg: 'key-fixture-secret-0002', shaped: 'sk-fixture0003', header: 'Bearer fixture-secret-0004' };

/** A fake host CLI: logs its argv as one JSON line, then adds the server where the real CLI would. */
function fakeCli(dir, host) {
  const file = path.join(dir, host);
  const body = host === 'claude'
    ? `const [, , mcp, verb, scopeFlag, scope, name, json] = process.argv;
if (process.env.FAKE_FAIL) { process.stderr.write('could not add: ' + json + '\\n'); process.exit(3); }
const cfg = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), '.claude.json');
const j = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8')) : {};
j.mcpServers = { ...(j.mcpServers || {}), [name]: JSON.parse(json) };
fs.writeFileSync(cfg, JSON.stringify(j, null, 2));`
    : `const a = process.argv.slice(2);
if (process.env.FAKE_FAIL) { process.stderr.write('could not add ' + a.join(' ') + '\\n'); process.exit(3); }
const name = a[2];
const cut = a.indexOf('--');
const env = [];
for (let i = 3; i < cut; i += 2) env.push(a[i + 1]);
const toml = '\\n[mcp_servers.' + name + ']\\ncommand = ' + JSON.stringify(a[cut + 1]) + '\\nargs = ' + JSON.stringify(a.slice(cut + 2)) + '\\n'
  + (env.length ? '\\n[mcp_servers.' + name + '.env]\\n' + env.map((kv) => kv.split('=')[0] + ' = ' + JSON.stringify(kv.slice(kv.indexOf('=') + 1))).join('\\n') + '\\n' : '');
fs.appendFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), toml);`;
  fs.writeFileSync(file, `#!${process.execPath}\nconst fs = require('fs'); const path = require('path');\nfs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), CODEX_HOME: process.env.CODEX_HOME || null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null }) + '\\n');\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function setup({ claude = true, codex = true, hosts = { claude: true, codex: true } } = {}) {
  const w = makeWorld({ claude, codex });
  // A server whose environment, arguments and headers hold secrets, on each host.
  const cj = path.join(w.claudeDir, '.claude.json');
  if (claude) {
    const j = JSON.parse(fs.readFileSync(cj, 'utf8'));
    j.mcpServers.vault = { type: 'stdio', command: '/opt/tools/vault-mcp', args: ['--stdio', `--api-key=${SECRET.arg}`, SECRET.shaped], env: { API_TOKEN: SECRET.env, LOG_LEVEL: 'warn' }, cwd: '/opt/tools' };
    j.mcpServers.remote = { type: 'http', url: 'https://mcp.example.com/v1?key=q', headers: { Authorization: SECRET.header } };
    fs.writeFileSync(cj, JSON.stringify(j, null, 2));
  }
  if (codex) {
    fs.appendFileSync(path.join(w.codexHome, 'config.toml'), `\n[mcp_servers.notes-db]\ncommand = "notes-mcp"\nargs = ["--token", "${SECRET.arg}", "--db", "notes.sqlite"]\nenv = { DB_PASSWORD = "${SECRET.env}" }\nstartup_timeout_sec = 20\n\n[mcp_servers.notes-db.http_headers]\nX = "y"\n`);
  }
  const bin = path.join(w.T, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(w.T, 'cli.jsonl');
  const cfgFile = path.join(w.claudeDir, 'agenticos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ version: '1.9.0', vault: w.vault, node: process.execPath, claudeConfigDir: w.claudeDir, provider: 'none', hosts: { claude: { enabled: hosts.claude, configDir: w.claudeDir }, codex: { enabled: hosts.codex, home: w.codexHome } } }, null, 2));
  const env = {
    ...process.env, HOME: w.home, CLAUDE_CONFIG_DIR: w.claudeDir, CODEX_HOME: w.codexHome, AOS_CONFIG: cfgFile,
    AOS_CLAUDE_BIN: fakeCli(bin, 'claude'), AOS_CODEX_BIN: fakeCli(bin, 'codex'), FAKE_LOG: log,
  };
  delete env.AOS_VAULT;
  delete env.AOS_NO_CLAUDE;
  delete env.AOS_NO_CODEX;
  const aos = (args, extra = {}) => spawnSync(process.execPath, [AOS, 'mcp', ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { w, aos, calls, cj, toml: path.join(w.codexHome, 'config.toml') };
}

function tree(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
  walk(dir);
  return out.sort();
}

function noSecrets(text, what) {
  for (const s of Object.values(SECRET)) assert.ok(!String(text).includes(s), `${what} shows a secret: ${s}`);
}

test('usage: copy, a name and --to claude|codex; anything else exits 2', () => {
  const { aos } = setup();
  for (const [args, msg] of [
    [[], /aos mcp copy <name> --to claude\|codex/],
    [['copy'], /aos mcp copy <name>/],
    [['list'], /aos mcp copy <name>/],
    [['copy', 'vault'], /--to takes claude or codex/],
    [['copy', 'vault', '--to', 'cursor'], /--to takes claude or codex/],
    [['copy', 'vault', 'extra', '--to', 'codex'], /aos mcp copy <name>/],
  ]) {
    const r = aos(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, msg);
  }
  assert.throws(() => M.parseMcpArgs(['copy', 'x', '--to']), /--to needs a value/);
  assert.throws(() => M.parseMcpArgs(['copy', 'x', '--to', 'codex', '--force']), /unknown flag --force/);
  assert.deepEqual(M.parseMcpArgs(['copy', 'x', '--to=codex', '--dry-run', '--json']), { verb: 'copy', name: 'x', to: 'codex', dryRun: true, json: true });
});

test('Claude Code → Codex, dry run: the exact `codex mcp add` with every secret hidden, and nothing written', () => {
  const { w, aos, calls, toml } = setup();
  const before = tree(w.vault);
  const tomlBefore = fs.readFileSync(toml, 'utf8');
  const r = aos(['copy', 'vault', '--to', 'codex', '--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual({ ...j, backup: j.backup.replace(/\d{8}T\d{6}Z/, 'STAMP') }, {
    ok: true, dryRun: true, name: 'vault', from: 'claude', to: 'codex', transport: 'stdio',
    command: "codex mcp add vault --env 'API_TOKEN=<redacted>' --env 'LOG_LEVEL=<redacted>' -- /opt/tools/vault-mcp --stdio '--api-key=<redacted>' '<redacted>'",
    source: '~/.claude/.claude.json', file: '~/.codex/config.toml', backup: 'brain/_index/backups/mcp/codex-config.toml-STAMP.bak',
    dropped: ['cwd'], disabled: false,
  });
  noSecrets(r.stdout + r.stderr, 'the dry run');
  assert.deepEqual(calls(), [], 'no CLI ran');
  assert.deepEqual(tree(w.vault), before);
  assert.equal(fs.readFileSync(toml, 'utf8'), tomlBefore);
  // Without --json: the same, in lines.
  const t = aos(['copy', 'vault', '--to', 'codex', '--dry-run']);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^would make vault \(stdio\) from Claude Code available on Codex$/m);
  assert.match(t.stdout, /^ {2}not carried over: cwd$/m);
  noSecrets(t.stdout, 'the dry run\'s lines');
});

test('Claude Code → Codex, for real: backup first (0600), the real values to codex, both hosts listed again', () => {
  const { w, aos, calls, toml } = setup();
  const original = fs.readFileSync(toml, 'utf8');
  const r = aos(['copy', 'vault', '--to', 'codex', '--json']);
  assert.equal(r.status, 0, r.stderr);
  noSecrets(r.stdout + r.stderr, 'the run');
  const j = JSON.parse(r.stdout);
  assert.equal(j.dryRun, false);
  assert.equal(j.listed, true);
  const [call] = calls();
  assert.deepEqual(call.argv, ['mcp', 'add', 'vault', '--env', `API_TOKEN=${SECRET.env}`, '--env', 'LOG_LEVEL=warn', '--', '/opt/tools/vault-mcp', '--stdio', `--api-key=${SECRET.arg}`, SECRET.shaped]);
  assert.equal(call.CODEX_HOME, w.codexHome);
  const bak = path.join(w.vault, j.backup);
  assert.equal(fs.readFileSync(bak, 'utf8'), original, 'the backup is the file as it was');
  assert.equal(fs.statSync(bak).mode & 0o777, 0o600);
  const listed = JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'mcp-servers.json'), 'utf8'));
  assert.deepEqual(listed.servers.filter((s) => s.name === 'vault').map((s) => [s.host, s.command]), [['claude', '/opt/tools/vault-mcp'], ['codex', '/opt/tools/vault-mcp']]);
  noSecrets(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'mcp-servers.json'), 'utf8'), 'mcp-servers.json');
  // Again: Codex has it now, so nothing runs.
  const again = aos(['copy', 'vault', '--to', 'codex']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /^aos: mcp copy: Codex already has an MCP server named vault \(~\/\.codex\/config\.toml\); nothing to do$/m);
  assert.equal(calls().length, 1);
});

test('Codex → Claude Code: the .env sub-table and inline env carried, add-json at user scope, what Claude cannot take named', () => {
  const { w, aos, calls, cj } = setup();
  const dry = aos(['copy', 'notes-db', '--to', 'claude', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const d = JSON.parse(dry.stdout);
  assert.equal(d.command, `claude mcp add-json --scope user notes-db '{"type":"stdio","command":"notes-mcp","args":["--token","<redacted>","--db","notes.sqlite"],"env":{"DB_PASSWORD":"<redacted>"}}'`);
  assert.deepEqual(d.dropped, ['http_headers', 'startup_timeout_sec']);
  assert.equal(d.file, '~/.claude/.claude.json');
  noSecrets(dry.stdout, 'the dry run');
  const issue = aos(['copy', 'issue-tracker', '--to', 'claude', '--json']);
  assert.equal(issue.status, 0, issue.stderr);
  const run = aos(['copy', 'notes-db', '--to', 'claude', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const [first, second] = calls();
  assert.deepEqual(first.argv, ['mcp', 'add-json', '--scope', 'user', 'issue-tracker', JSON.stringify({ type: 'stdio', command: '/opt/tools/issue-mcp', args: ['--stdio'], env: { LOG_LEVEL: 'warn' } })]);
  assert.deepEqual(JSON.parse(second.argv[5]), { type: 'stdio', command: 'notes-mcp', args: ['--token', SECRET.arg, '--db', 'notes.sqlite'], env: { DB_PASSWORD: SECRET.env } });
  // The default ~/.claude is never named to Claude Code: with CLAUDE_CONFIG_DIR set it would keep .claude.json inside.
  assert.equal(second.CLAUDE_CONFIG_DIR, null);
  assert.ok(JSON.parse(fs.readFileSync(cj, 'utf8')).mcpServers['notes-db']);
  const backups = fs.readdirSync(path.join(w.vault, 'brain', '_index', 'backups', 'mcp'));
  assert.ok(backups.length >= 1 && backups.every((n) => /^claude-claude\.json-\d{8}T\d{6}Z\.bak$/.test(n)), backups.join(', '));
  const listed = JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'mcp-servers.json'), 'utf8')).servers;
  assert.deepEqual(listed.filter((s) => s.name === 'notes-db').map((s) => s.host), ['claude', 'codex']);
});

test('a remote server goes to Claude Code with its headers hidden in the dry run; to Codex it is refused with what to do', () => {
  const { aos, calls } = setup();
  const dry = aos(['copy', 'remote', '--to', 'codex', '--dry-run']);
  assert.equal(dry.status, 1);
  assert.match(dry.stderr, /remote \(http\) server, and `codex mcp add` takes a command to run: add it in Codex's config.toml/);
  // Codex's remote server, the other way: a URL is what Claude Code's JSON takes.
  const back = M.targetCommand('claude', 'remote', M.normalize('claude', { type: 'http', url: 'https://mcp.example.com/v1?key=q', headers: { Authorization: SECRET.header } }));
  assert.equal(back.shown[5], '{"type":"http","url":"https://mcp.example.com/v1","headers":{"Authorization":"<redacted>"}}');
  assert.equal(JSON.parse(back.argv[5]).url, 'https://mcp.example.com/v1?key=q', 'the real command keeps the query');
  assert.ok(back.secrets.includes(SECRET.header) && back.secrets.includes('https://mcp.example.com/v1?key=q'));
  assert.deepEqual(calls(), []);
});

test('refusals write nothing: a host that is off, an unknown or own name, a name the CLIs reject, no CLI', () => {
  const off = setup({ hosts: { claude: true, codex: false } });
  const before = tree(off.w.vault);
  const r = off.aos(['copy', 'vault', '--to', 'codex', '--dry-run']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Codex is off on this Mac: `aos hosts add codex` turns it on/);
  const { aos, calls, w } = setup();
  for (const [name, msg] of [
    ['nope', /Claude Code declares no MCP server named nope \(~\/\.claude\/\.claude\.json\)/],
    ['agenticos', /the vault's own server/],
    ['web fetch', /is not a server name both CLIs take/],
  ]) {
    const x = aos(['copy', name, '--to', 'codex']);
    assert.notEqual(x.status, 0, name);
    assert.match(x.stderr, msg, name);
  }
  const nocli = aos(['copy', 'vault', '--to', 'codex'], { AOS_CODEX_BIN: '', AOS_NO_CODEX: '1' });
  assert.equal(nocli.status, 1);
  assert.match(nocli.stderr, /the codex CLI was not found: install Codex, then try again/);
  assert.ok(!M.NAME_RE.test('-x') && !M.NAME_RE.test('a.b') && M.NAME_RE.test('docs_search-2'));
  assert.deepEqual(calls(), []);
  assert.deepEqual(tree(off.w.vault), before);
  assert.ok(!fs.existsSync(path.join(w.vault, 'brain', '_index', 'backups')), 'no backup for a refusal');
});

test('a failing CLI: its own words shown with the secrets scrubbed, the backup kept and named', () => {
  const { w, aos } = setup();
  const r = aos(['copy', 'vault', '--to', 'codex'], { FAKE_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^aos: mcp copy: codex mcp add failed \(could not add mcp add vault --env API_TOKEN=<redacted> --env LOG_LEVEL=<redacted> -- \/opt\/tools\/vault-mcp --stdio --api-key=<redacted> <redacted>\); the backup is brain\/_index\/backups\/mcp\/codex-config\.toml-\d{8}T\d{6}Z\.bak$/m);
  noSecrets(r.stdout + r.stderr, 'the failure');
  assert.equal(fs.readdirSync(path.join(w.vault, 'brain', '_index', 'backups', 'mcp')).length, 1);
});

test('secrets in arguments: a secret-named flag\'s value, KEY=value and token shapes are hidden; plain words are not', () => {
  const r = M.redactArgs(['--stdio', '--token', 'abc123', '--password=hunter2', 'API_KEY=xyz', 'LOG_LEVEL=warn', 'sk-fixture0003', '--db', 'notes.sqlite', '--auth', '--verbose']);
  assert.deepEqual(r.shown, ['--stdio', '--token', '<redacted>', '--password=<redacted>', 'API_KEY=<redacted>', 'LOG_LEVEL=warn', '<redacted>', '--db', 'notes.sqlite', '--auth', '--verbose']);
  assert.deepEqual(r.secrets, ['abc123', 'hunter2', 'xyz', 'sk-fixture0003']);
  assert.equal(M.scrub('failed with abc123 and xyz', r.secrets), 'failed with <redacted> and <redacted>');
});

test('backups: the newest ten per host are kept', () => {
  const { w } = setup();
  const file = path.join(w.codexHome, 'config.toml');
  for (let i = 0; i < 13; i++) M.backup(w.vault, 'codex', file, Date.UTC(2026, 9, 1, 0, 0, i));
  const kept = fs.readdirSync(path.join(w.vault, 'brain', '_index', 'backups', 'mcp')).sort();
  assert.equal(kept.length, M.KEEP_BACKUPS);
  assert.equal(kept[0], 'codex-config.toml-20261001T000003Z.bak');
  assert.equal(M.backup(w.vault, 'claude', path.join(w.T, 'missing.json'), Date.now()), null, 'nothing to back up');
});
