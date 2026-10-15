'use strict';
// `aos mcp copy` (install-import B6): one MCP server made available on the other host, per direction, against fake
// `claude` and `codex` CLIs that record their argv and write the entry the way the real ones do. The dry run shows the
// exact command with every secret it recognises hidden, and a hash the real run must name (--expect); a real run backs the
// target's file up first, outside the vault (~/.local/share/unidex/backups/mcp, 0600), under a lock per target host, runs
// the host's own CLI with the real values, and lists both hosts again into mcp-servers.json; refusals write nothing.
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
const SECRET = { env: 'tok-fixture-secret-0001', arg: 'key-fixture-secret-0002', shaped: 'sk-fixture0003', header: 'Bearer fixture-secret-0004', dotted: 'tok-fixture-secret-0005' };
const STAMP = /\d{8}T\d{9}Z/;

/** A fake host CLI: logs its argv as one JSON line, then adds the server where the real CLI would. */
function fakeCli(dir, host) {
  const file = path.join(dir, host);
  const body = host === 'claude'
    ? `const [, , mcp, verb, scopeFlag, scope, name, json] = process.argv;
if (process.env.FAKE_FAIL) { process.stderr.write('could not add: ' + json + '\\n'); process.exit(3); }
// Claude Code's own rule: .claude.json inside CLAUDE_CONFIG_DIR when it is set, else beside the default folder, in home.
const cfg = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(process.env.HOME, '.claude.json');
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
    // Names Codex declares in its other forms (below): the copy must see them as already there.
    j.mcpServers['inline-one'] = { type: 'stdio', command: 'inline-mcp' };
    j.mcpServers['dotted-one'] = { type: 'stdio', command: 'dotted-mcp' };
    fs.writeFileSync(cj, JSON.stringify(j, null, 2));
  }
  if (codex) {
    fs.appendFileSync(path.join(w.codexHome, 'config.toml'), `\n[mcp_servers.notes-db]\ncommand = "notes-mcp"\nargs = ["--token", "${SECRET.arg}", "--db", "notes.sqlite"]\nenv = { DB_PASSWORD = "${SECRET.env}" }\nstartup_timeout_sec = 20\n\n[mcp_servers.notes-db.http_headers]\nX = "y"\n`
      // A server as an inline table under [mcp_servers], one as dotted keys there, one with a dotted env key in its own
      // table, and one turned off.
      + `\n[mcp_servers]\ninline-one = { command = "inline-mcp", args = ["-v"], env = { LEVEL = "2" } }\ndotted-one.command = "dotted-mcp"\n`
      + `\n[mcp_servers.half-env]\ncommand = "half-mcp"\nenv.API_KEY = "${SECRET.dotted}"\n`
      + `\n[mcp_servers.paused]\ncommand = "paused-mcp"\nenabled = false\n`);
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
  const backups = path.join(w.home, '.local', 'share', 'unidex', 'backups', 'mcp');
  return { w, env, aos, calls, cj, backups, toml: path.join(w.codexHome, 'config.toml') };
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
  assert.deepEqual(M.parseMcpArgs(['copy', 'x', '--to=codex', '--dry-run', '--json']), { verb: 'copy', name: 'x', to: 'codex', dryRun: true, json: true, expect: null });
  assert.throws(() => M.parseMcpArgs(['copy', 'x', '--to', 'codex', '--expect', 'abc']), /--expect takes the 64-character hash a dry run printed/);
  assert.throws(() => M.parseMcpArgs(['copy', 'x', '--to', 'codex', '--dry-run', '--expect', 'a'.repeat(64)]), /--expect is for the real run/);
});

test('Claude Code → Codex, dry run: the exact `codex mcp add` with the secrets hidden, the hash the real run names, and nothing written', () => {
  const { w, aos, calls, toml, backups } = setup();
  const before = tree(w.vault);
  const tomlBefore = fs.readFileSync(toml, 'utf8');
  const r = aos(['copy', 'vault', '--to', 'codex', '--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.match(j.expect, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...j, backup: j.backup.replace(STAMP, 'STAMP'), expect: 'HASH' }, {
    ok: true, dryRun: true, name: 'vault', from: 'claude', to: 'codex', transport: 'stdio',
    command: "codex mcp add vault --env 'API_TOKEN=<redacted>' --env 'LOG_LEVEL=<redacted>' -- /opt/tools/vault-mcp --stdio '--api-key=<redacted>' '<redacted>'",
    source: '~/.claude/.claude.json', file: '~/.codex/config.toml', backup: '~/.local/share/unidex/backups/mcp/codex-config.toml-STAMP.bak',
    dropped: ['cwd'], expect: 'HASH',
  });
  noSecrets(r.stdout + r.stderr, 'the dry run');
  assert.deepEqual(calls(), [], 'no CLI ran');
  assert.deepEqual(tree(w.vault), before);
  assert.equal(fs.readFileSync(toml, 'utf8'), tomlBefore);
  assert.ok(!fs.existsSync(backups), 'no backup folder for a dry run');
  // The same plan gives the same hash.
  assert.equal(JSON.parse(aos(['copy', 'vault', '--to', 'codex', '--dry-run', '--json']).stdout).expect, j.expect);
  // Without --json: the same, in lines.
  const t = aos(['copy', 'vault', '--to', 'codex', '--dry-run']);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^would make vault \(stdio\) from Claude Code available on Codex$/m);
  assert.match(t.stdout, /^ {2}not carried over: cwd$/m);
  assert.match(t.stdout, new RegExp(`^ {2}confirm with: --expect ${j.expect}$`, 'm'));
  noSecrets(t.stdout, 'the dry run\'s lines');
});

test('Claude Code → Codex, for real: tied to its dry run, the backup outside the vault first (0600 in a 0700 folder), the real values to codex, both hosts listed again', () => {
  const { w, aos, calls, toml, backups } = setup();
  const original = fs.readFileSync(toml, 'utf8');
  const plan = JSON.parse(aos(['copy', 'vault', '--to', 'codex', '--dry-run', '--json']).stdout);
  // A hash that is not this plan's: refused, nothing runs, nothing is backed up.
  const wrong = aos(['copy', 'vault', '--to', 'codex', '--expect', 'f'.repeat(64), '--json']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /^aos: mcp copy: vault's config or its command changed since the dry run: run the dry run again$/m);
  assert.deepEqual(calls(), []);
  assert.ok(!fs.existsSync(backups));
  const r = aos(['copy', 'vault', '--to', 'codex', '--expect', plan.expect, '--json']);
  assert.equal(r.status, 0, r.stderr);
  noSecrets(r.stdout + r.stderr, 'the run');
  const j = JSON.parse(r.stdout);
  assert.equal(j.dryRun, false);
  assert.equal(j.listed, true);
  const [call] = calls();
  assert.deepEqual(call.argv, ['mcp', 'add', 'vault', '--env', `API_TOKEN=${SECRET.env}`, '--env', 'LOG_LEVEL=warn', '--', '/opt/tools/vault-mcp', '--stdio', `--api-key=${SECRET.arg}`, SECRET.shaped]);
  assert.equal(call.CODEX_HOME, w.codexHome);
  assert.match(j.backup, /^~\/\.local\/share\/unidex\/backups\/mcp\/codex-config\.toml-\d{8}T\d{9}Z\.bak$/);
  const bak = path.join(w.home, j.backup.slice(2));
  assert.equal(fs.readFileSync(bak, 'utf8'), original, 'the backup is the file as it was');
  assert.equal(fs.statSync(bak).mode & 0o777, 0o600);
  assert.equal(fs.statSync(backups).mode & 0o777, 0o700);
  assert.ok(!fs.existsSync(path.join(w.vault, 'brain', '_index', 'backups')), 'nothing backed up inside the vault');
  const listed = JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'mcp-servers.json'), 'utf8'));
  assert.deepEqual(listed.servers.filter((s) => s.name === 'vault').map((s) => [s.host, s.command]), [['claude', '/opt/tools/vault-mcp'], ['codex', '/opt/tools/vault-mcp']]);
  noSecrets(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'mcp-servers.json'), 'utf8'), 'mcp-servers.json');
  // Again: Codex has it now, so nothing runs.
  const again = aos(['copy', 'vault', '--to', 'codex']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /^aos: mcp copy: Codex already has an MCP server named vault \(~\/\.codex\/config\.toml\); nothing to do$/m);
  assert.equal(calls().length, 1);
});

test('the source changing after its dry run refuses the real run that names the old hash', () => {
  const { aos, calls, cj } = setup();
  const plan = JSON.parse(aos(['copy', 'vault', '--to', 'codex', '--dry-run', '--json']).stdout);
  const j = JSON.parse(fs.readFileSync(cj, 'utf8'));
  j.mcpServers.vault.args.push('--extra');
  fs.writeFileSync(cj, JSON.stringify(j, null, 2));
  const r = aos(['copy', 'vault', '--to', 'codex', '--expect', plan.expect]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /changed since the dry run: run the dry run again/);
  assert.deepEqual(calls(), []);
});

test('Codex → Claude Code: the .env sub-table and inline env carried, add-json at user scope, what Claude cannot take named', () => {
  const { w, aos, calls, cj, backups } = setup();
  const dry = aos(['copy', 'notes-db', '--to', 'claude', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const d = JSON.parse(dry.stdout);
  assert.equal(d.command, `claude mcp add-json --scope user notes-db '{"type":"stdio","command":"notes-mcp","args":["--token","<redacted>","--db","notes.sqlite"],"env":{"DB_PASSWORD":"<redacted>"}}'`);
  assert.deepEqual(d.dropped, ['http_headers', 'startup_timeout_sec']);
  assert.equal(d.file, '~/.claude/.claude.json');
  noSecrets(dry.stdout, 'the dry run');
  const issue = aos(['copy', 'issue-tracker', '--to', 'claude', '--json']);
  assert.equal(issue.status, 0, issue.stderr);
  const run = aos(['copy', 'notes-db', '--to', 'claude', '--expect', d.expect, '--json']);
  assert.equal(run.status, 0, run.stderr);
  const [first, second] = calls();
  assert.deepEqual(first.argv, ['mcp', 'add-json', '--scope', 'user', 'issue-tracker', JSON.stringify({ type: 'stdio', command: '/opt/tools/issue-mcp', args: ['--stdio'], env: { LOG_LEVEL: 'warn' } })]);
  assert.deepEqual(JSON.parse(second.argv[5]), { type: 'stdio', command: 'notes-mcp', args: ['--token', SECRET.arg, '--db', 'notes.sqlite'], env: { DB_PASSWORD: SECRET.env } });
  // The file read and backed up is inside the folder, so the folder is named and Claude Code writes that same file.
  assert.equal(second.CLAUDE_CONFIG_DIR, w.claudeDir);
  assert.ok(JSON.parse(fs.readFileSync(cj, 'utf8')).mcpServers['notes-db']);
  const names = fs.readdirSync(backups).filter((n) => n.endsWith('.bak'));
  assert.equal(names.length, 2, names.join(', '));
  assert.ok(names.every((n) => /^claude-claude\.json-\d{8}T\d{9}Z(-\d+)?\.bak$/.test(n)), names.join(', '));
  const listed = JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'mcp-servers.json'), 'utf8')).servers;
  assert.deepEqual(listed.filter((s) => s.name === 'notes-db').map((s) => s.host), ['claude', 'codex']);
});

test('with .claude.json beside the default ~/.claude, Claude Code runs without CLAUDE_CONFIG_DIR and writes that file', () => {
  const { w, aos, calls } = setup();
  const beside = path.join(w.home, '.claude.json');
  fs.writeFileSync(beside, JSON.stringify({ numStartups: 1, mcpServers: {} }));
  const dry = aos(['copy', 'issue-tracker', '--to', 'claude', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).file, '~/.claude.json');
  const r = aos(['copy', 'issue-tracker', '--to', 'claude', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls()[0].CLAUDE_CONFIG_DIR, null);
  assert.ok(JSON.parse(fs.readFileSync(beside, 'utf8')).mcpServers['issue-tracker']);
  assert.match(JSON.parse(r.stdout).backup, /^~\/\.local\/share\/unidex\/backups\/mcp\/claude-claude\.json-\d{8}T\d{9}Z\.bak$/);
});

test("Codex's other forms: an inline table under [mcp_servers] is read; dotted keys are refused as a source and count as there; a dotted env key is named as not carried", () => {
  const { aos, calls, cj } = setup();
  // From Codex: Claude Code lacks both names for this part.
  const withBoth = fs.readFileSync(cj, 'utf8');
  const j = JSON.parse(withBoth);
  delete j.mcpServers['inline-one'];
  delete j.mcpServers['dotted-one'];
  fs.writeFileSync(cj, JSON.stringify(j, null, 2));
  const inline = aos(['copy', 'inline-one', '--to', 'claude', '--dry-run', '--json']);
  assert.equal(inline.status, 0, inline.stderr);
  assert.equal(JSON.parse(inline.stdout).command, `claude mcp add-json --scope user inline-one '{"type":"stdio","command":"inline-mcp","args":["-v"],"env":{"LEVEL":"<redacted>"}}'`);
  const dotted = aos(['copy', 'dotted-one', '--to', 'claude', '--dry-run']);
  assert.equal(dotted.status, 1);
  assert.match(dotted.stderr, /Codex declares dotted-one in a form aos mcp copy does not read \(dotted keys\): write it as an \[mcp_servers\.dotted-one\] table/);
  const half = JSON.parse(aos(['copy', 'half-env', '--to', 'claude', '--dry-run', '--json']).stdout);
  assert.deepEqual(half.dropped, ['env.API_KEY']);
  assert.ok(!half.command.includes(SECRET.dotted));
  // Copying to Codex: a name it declares in any form is already there, so `codex mcp add` never overwrites it.
  fs.writeFileSync(cj, withBoth);
  for (const name of ['inline-one', 'dotted-one']) {
    const r = aos(['copy', name, '--to', 'codex']);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, new RegExp(`Codex already has an MCP server named ${name}`), name);
  }
  assert.deepEqual(calls(), []);
});

test('a server turned off on its host is not copied on as if it were on', () => {
  const { aos, calls } = setup();
  const r = aos(['copy', 'paused', '--to', 'claude', '--dry-run']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /paused is turned off on Codex: turn it on there first, or add it to Claude Code yourself/);
  assert.deepEqual(calls(), []);
});

test('a remote server goes to Claude Code with its headers and URL secrets hidden in the dry run; to Codex it is refused with what to do', () => {
  const { aos, calls } = setup();
  const dry = aos(['copy', 'remote', '--to', 'codex', '--dry-run']);
  assert.equal(dry.status, 1);
  assert.match(dry.stderr, /remote \(http\) server, and `codex mcp add` takes a command to run: add it in Codex's config.toml/);
  // Codex's remote server, the other way: a URL is what Claude Code's JSON takes.
  const back = M.targetCommand('claude', 'remote', M.normalize('claude', { type: 'http', url: 'https://u:pw-fixture-u1@example.com/sk-fixture0099/v1?key=q-fixture-1', headers: { Authorization: SECRET.header } }));
  assert.equal(back.shown[5], '{"type":"http","url":"https://<redacted>@example.com/<redacted>/v1?key=<redacted>","headers":{"Authorization":"<redacted>"}}');
  assert.equal(JSON.parse(back.argv[5]).url, 'https://u:pw-fixture-u1@example.com/sk-fixture0099/v1?key=q-fixture-1', 'the real command keeps the URL');
  for (const s of [SECRET.header, 'pw-fixture-u1', 'sk-fixture0099', 'q-fixture-1']) assert.ok(back.secrets.includes(s), s);
  assert.deepEqual(calls(), []);
});

test('refusals write nothing: a host that is off, an unknown or own name, a name the CLIs reject, no CLI', () => {
  const off = setup({ hosts: { claude: true, codex: false } });
  const before = tree(off.w.vault);
  const r = off.aos(['copy', 'vault', '--to', 'codex', '--dry-run']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Codex is off on this Mac: `aos hosts add codex` turns it on/);
  const { aos, calls, backups } = setup();
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
  assert.ok(!fs.existsSync(backups), 'no backup for a refusal');
});

test('a failing CLI: its own words shown with the secrets scrubbed, the backup kept and named', () => {
  const { aos, backups } = setup();
  const r = aos(['copy', 'vault', '--to', 'codex'], { FAKE_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^aos: mcp copy: codex mcp add failed \(could not add mcp add vault --env API_TOKEN=<redacted> --env LOG_LEVEL=<redacted> -- \/opt\/tools\/vault-mcp --stdio <redacted> <redacted>\); the backup is ~\/\.local\/share\/unidex\/backups\/mcp\/codex-config\.toml-\d{8}T\d{9}Z\.bak$/m);
  noSecrets(r.stdout + r.stderr, 'the failure');
  assert.equal(fs.readdirSync(backups).filter((n) => n.endsWith('.bak')).length, 1);
});

test('secrets in arguments: secret-named flags and KEY=value, header values, URL credentials, queries and token-like path segments, token shapes; plain words stay', () => {
  const args = [
    '--stdio', '--token', 'abc123', '--password=hunter2', 'API_KEY=xyz', 'LOG_LEVEL=warn', 'sk-fixture0003', '--db', 'notes.sqlite', '--auth', '--verbose',
    'postgresql://user:pw-fixture-d1@example.com:5432/app', '-H', 'Authorization: Bearer tok-fixture-h1', '--header', 'X-Api-Key: key-fixture-h2',
    'https://api.example.com/v1?token=tok-fixture-q1&mode=ro', '--key', 'key-fixture-k1', '-p', 'pw-fixture-p1', 'Authorization: Bearer tok-fixture-h3',
    'https://mcp.example.com/sk-fixture0099/sse', '--endpoint=https://u:pw-fixture-e1@example.com/x', 'plain.txt',
  ];
  const r = M.redactArgs(args);
  assert.deepEqual(r.shown, [
    '--stdio', '--token', '<redacted>', '--password=<redacted>', 'API_KEY=<redacted>', 'LOG_LEVEL=warn', '<redacted>', '--db', 'notes.sqlite', '--auth', '--verbose',
    'postgresql://<redacted>@example.com:5432/app', '-H', 'Authorization: <redacted>', '--header', 'X-Api-Key: <redacted>',
    'https://api.example.com/v1?token=<redacted>&mode=<redacted>', '--key', '<redacted>', '-p', '<redacted>', 'Authorization: <redacted>',
    'https://mcp.example.com/<redacted>/sse', '--endpoint=https://<redacted>@example.com/x', 'plain.txt',
  ]);
  // Everything hidden also feeds the scrub of a failing CLI's own output.
  const echoed = `error: could not start ${args.join(' ')}`;
  const scrubbed = M.scrub(echoed, r.secrets);
  for (const s of ['abc123', 'hunter2', 'xyz', 'sk-fixture0003', 'pw-fixture-d1', 'tok-fixture-h1', 'key-fixture-h2', 'tok-fixture-q1', 'key-fixture-k1', 'pw-fixture-p1', 'tok-fixture-h3', 'sk-fixture0099', 'pw-fixture-e1']) {
    assert.ok(!scrubbed.includes(s), `the scrub left ${s}`);
  }
  assert.match(scrubbed, /notes\.sqlite/);
});

test('backups: millisecond stamps, never overwritten (a second in the same millisecond gets its own name), the newest ten per host kept', () => {
  const { w } = setup();
  const file = path.join(w.codexHome, 'config.toml');
  const t = Date.UTC(2026, 9, 1, 0, 0, 0, 123);
  const a = M.backup(w.home, 'codex', file, t);
  const b = M.backup(w.home, 'codex', file, t);
  assert.notEqual(a, b);
  assert.match(path.basename(a), /^codex-config\.toml-20261001T000000123Z\.bak$/);
  assert.match(path.basename(b), /^codex-config\.toml-20261001T000000123Z-2\.bak$/);
  for (let i = 1; i <= 12; i++) M.backup(w.home, 'codex', file, t + i);
  const dir = M.backupDir(w.home);
  assert.equal(dir, path.join(w.home, '.local', 'share', 'unidex', 'backups', 'mcp'));
  const kept = fs.readdirSync(dir).filter((n) => n.endsWith('.bak')).sort();
  assert.equal(kept.length, M.KEEP_BACKUPS);
  assert.equal(kept[kept.length - 1], 'codex-config.toml-20261001T000000135Z.bak');
  assert.equal(M.backup(w.home, 'claude', path.join(w.T, 'missing.json'), Date.now()), null, 'nothing to back up');
});

test('one copy per target host at a time: a copy while another holds the lock is refused, writing nothing', () => {
  const { env, calls, backups } = setup();
  fs.mkdirSync(backups, { recursive: true });
  // Another live copy to Codex: this process holds the lock until well after the test.
  fs.writeFileSync(path.join(backups, 'codex-copy.lock'), JSON.stringify({ pid: process.pid, id: 'other', until: new Date(Date.now() + 60_000).toISOString() }));
  const lines = [];
  assert.throws(() => M.main(['copy', 'vault', '--to', 'codex'], {
    env, home: env.HOME, io: { log: (l) => lines.push(l) }, lockTimeoutMs: 50,
    claudeBin: () => env.AOS_CLAUDE_BIN, codexBin: () => env.AOS_CODEX_BIN,
  }), /another copy to Codex is running: try again in a moment/);
  assert.deepEqual(calls(), []);
  assert.deepEqual(fs.readdirSync(backups).filter((n) => n.endsWith('.bak')), []);
  // Claude Code's lock is its own.
  assert.equal(M.main(['copy', 'issue-tracker', '--to', 'claude', '--json'], {
    env, home: env.HOME, io: { log: (l) => lines.push(l) }, lockTimeoutMs: 50,
    claudeBin: () => env.AOS_CLAUDE_BIN, codexBin: () => env.AOS_CODEX_BIN,
  }), 0);
});
