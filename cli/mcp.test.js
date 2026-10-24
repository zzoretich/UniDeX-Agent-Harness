'use strict';
// `aos mcp copy` (install-import B6, connectors-tab D20) and `aos mcp park|unpark|remove|add` (connectors-tab D16–D18,
// A1, A2), per host, against fake `claude` and `codex` CLIs that record their argv and change the entry the way the real
// ones do. The dry run shows the exact command with every secret it recognises hidden, and a hash the real run must name
// (--expect); a real run backs the host's file up first, outside the vault (~/.local/share/unidex/backups/mcp, 0600),
// under a lock per host, runs the host's own CLI with the real values, and lists the hosts again; park keeps the exact
// entry in a 0600 stash (~/.local/share/unidex/parked/mcp) that Turn on puts back; add takes secrets as names alone;
// refusals write nothing.
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

/**
 * A fake host CLI: logs its argv as one JSON line, then changes the server where the real CLI would: Claude Code's
 * `mcp add-json --scope user <name> <json>` and `mcp remove <name> --scope user` in .claude.json; Codex's `mcp add <name>
 * [--env K=V]… -- <cmd> [args…]`, `mcp add <name> --url <url> [--bearer-token-env-var V]` and `mcp remove <name>` in
 * config.toml.
 */
function fakeCli(dir, host) {
  const file = path.join(dir, host);
  const body = host === 'claude'
    ? String.raw`const a = process.argv.slice(2);
// Claude Code's own rule: .claude.json inside CLAUDE_CONFIG_DIR when it is set, else beside the default folder, in home.
const cfg = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(process.env.HOME, '.claude.json');
const j = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8')) : {};
if (a[1] === 'remove') {
  if (process.env.FAKE_FAIL) { process.stderr.write('could not remove ' + a[2] + '\n'); process.exit(3); }
  if (!j.mcpServers || !j.mcpServers[a[2]]) { process.stderr.write('No user-scoped MCP server found with name: ' + a[2] + '\n'); process.exit(1); }
  delete j.mcpServers[a[2]];
} else {
  if (process.env.FAKE_FAIL) { process.stderr.write('could not add: ' + a[5] + '\n'); process.exit(3); }
  j.mcpServers = { ...(j.mcpServers || {}), [a[4]]: JSON.parse(a[5]) };
}
fs.writeFileSync(cfg, JSON.stringify(j, null, 2));`
    : String.raw`const a = process.argv.slice(2);
if (process.env.FAKE_FAIL) { process.stderr.write('could not ' + a[1] + ' ' + a.join(' ') + '\n'); process.exit(3); }
const toml = path.join(process.env.CODEX_HOME, 'config.toml');
const name = a[2];
if (a[1] === 'remove') {
  const head = new RegExp('^\\s*\\[mcp_servers\\.' + name + '(\\.[^\\]]*)?\\]\\s*$');
  let skip = false;
  const out = [];
  for (const l of fs.readFileSync(toml, 'utf8').split('\n')) { if (/^\s*\[/.test(l)) skip = head.test(l); if (!skip) out.push(l); }
  fs.writeFileSync(toml, out.join('\n'));
} else if (a[3] === '--url') {
  fs.appendFileSync(toml, '\n[mcp_servers.' + name + ']\nurl = ' + JSON.stringify(a[4]) + '\n' + (a[5] === '--bearer-token-env-var' ? 'bearer_token_env_var = ' + JSON.stringify(a[6]) + '\n' : ''));
} else {
  const cut = a.indexOf('--');
  const env = [];
  for (let i = 3; i < cut; i += 2) env.push(a[i + 1]);
  fs.appendFileSync(toml, '\n[mcp_servers.' + name + ']\ncommand = ' + JSON.stringify(a[cut + 1]) + '\nargs = ' + JSON.stringify(a.slice(cut + 2)) + '\n'
    + (env.length ? '\n[mcp_servers.' + name + '.env]\n' + env.map((kv) => kv.split('=')[0] + ' = ' + JSON.stringify(kv.slice(kv.indexOf('=') + 1))).join('\n') + '\n' : ''));
}`;
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

test('usage: copy, a name and --to claude|codex; list and check take only --json; anything else exits 2', () => {
  const { aos } = setup();
  for (const [args, msg] of [
    [[], /aos mcp copy <name> --to claude\|codex/],
    [['copy'], /aos mcp copy <name>/],
    [['sync'], /aos mcp list \[--json\]/],
    [['list', 'vault'], /aos mcp list takes only --json/],
    [['check', '--to', 'codex'], /aos mcp check takes only --json/],
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

test('a remote server goes to Claude Code with its headers and URL secrets hidden; to Codex as `codex mcp add --url` (D20), a header it cannot take named with bearer_token_env_var', () => {
  const { aos, calls, toml } = setup();
  const dry = aos(['copy', 'remote', '--to', 'codex', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const d = JSON.parse(dry.stdout);
  assert.equal(d.command, "codex mcp add remote --url 'https://mcp.example.com/v1?key=<redacted>'");
  assert.deepEqual(d.dropped, ['headers.Authorization']);
  assert.match(d.note, /takes no header values: to send a token, name the variable that holds it with bearer_token_env_var = "NAME" under \[mcp_servers\.remote\]/);
  noSecrets(dry.stdout, 'the dry run');
  assert.deepEqual(calls(), []);
  const human = aos(['copy', 'remote', '--to', 'codex', '--dry-run']);
  assert.match(human.stdout, /^ {2}not carried over: headers\.Authorization$/m);
  assert.match(human.stdout, /^ {2}note: {4}`codex mcp add` takes no header values/m);
  const run = aos(['copy', 'remote', '--to', 'codex', '--expect', d.expect, '--json']);
  assert.equal(run.status, 0, run.stderr);
  noSecrets(run.stdout + run.stderr, 'the run');
  assert.deepEqual(calls()[0].argv, ['mcp', 'add', 'remote', '--url', 'https://mcp.example.com/v1?key=q']);
  assert.match(fs.readFileSync(toml, 'utf8'), /\[mcp_servers\.remote\]\nurl = "https:\/\/mcp\.example\.com\/v1\?key=q"/);
  assert.ok(!fs.readFileSync(toml, 'utf8').includes(SECRET.header), 'the header value never reaches Codex');
  assert.equal(JSON.parse(run.stdout).listed, true);
  // Codex's remote server, the other way: a URL is what Claude Code's JSON takes.
  const back = M.targetCommand('claude', 'remote', M.normalize('claude', { type: 'http', url: 'https://u:pw-fixture-u1@example.com/sk-fixture0099/v1?key=q-fixture-1', headers: { Authorization: SECRET.header } }));
  assert.equal(back.shown[5], '{"type":"http","url":"https://<redacted>@example.com/<redacted>/v1?key=<redacted>","headers":{"Authorization":"<redacted>"}}');
  assert.equal(JSON.parse(back.argv[5]).url, 'https://u:pw-fixture-u1@example.com/sk-fixture0099/v1?key=q-fixture-1', 'the real command keeps the URL');
  for (const s of [SECRET.header, 'pw-fixture-u1', 'sk-fixture0099', 'q-fixture-1']) assert.ok(back.secrets.includes(s), s);
});

test('D20 and A1 in the copy: a `Bearer ${VAR}` header is Codex\'s --bearer-token-env-var; an SSE server is refused for Codex; a `${VAR}` value is A1\'s env_vars line; Codex\'s bearer_token_env_var is Claude Code\'s header', () => {
  const remote = M.normalize('claude', { type: 'http', url: 'https://charts.example.com/mcp', headers: { Authorization: 'Bearer ${CHARTS_TOKEN}' } });
  const c = M.targetCommand('codex', 'charts', remote);
  assert.deepEqual(c.argv, ['mcp', 'add', 'charts', '--url', 'https://charts.example.com/mcp', '--bearer-token-env-var', 'CHARTS_TOKEN']);
  assert.deepEqual([c.dropped, c.note], [[], null]);
  assert.throws(() => M.targetCommand('codex', 'feed', M.normalize('claude', { type: 'sse', url: 'https://feed.example.com/sse' })), /feed is a remote \(sse\) server, and `codex mcp add --url` takes a streamable HTTP server only/);
  const stdio = M.normalize('claude', { type: 'stdio', command: 'gh-mcp', env: { GITHUB_TOKEN: '${GH}', LOG_LEVEL: 'warn' } });
  const s = M.targetCommand('codex', 'gh', stdio);
  assert.deepEqual(s.argv, ['mcp', 'add', 'gh', '--env', 'LOG_LEVEL=warn', '--', 'gh-mcp']);
  assert.deepEqual(s.paste, ['GITHUB_TOKEN']);
  assert.equal(M.envVarsLine(s.paste), 'env_vars = ["GITHUB_TOKEN"]');
  // A variable's name is shown as written: it is no secret.
  assert.equal(M.targetCommand('claude', 'gh', stdio).shown[5], '{"type":"stdio","command":"gh-mcp","env":{"GITHUB_TOKEN":"${GH}","LOG_LEVEL":"<redacted>"}}');
  const fromCodex = M.targetCommand('claude', 'charts', M.normalize('codex', { url: 'https://charts.example.com/mcp', bearer_token_env_var: 'CHARTS_TOKEN' }));
  assert.deepEqual(JSON.parse(fromCodex.argv[5]), { type: 'http', url: 'https://charts.example.com/mcp', headers: { Authorization: 'Bearer ${CHARTS_TOKEN}' } });
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
  // Every fixture value is built here, so the source holds nothing a secret scanner reads as one.
  const v = (tag) => ['fx', tag, 'value'].join('-');
  const at = (user, pass, host) => [user, ':', pass, '@', host].join('');
  const header = (name, value) => [name, value].join(': ');
  const args = [
    '--stdio', '--token', v('t1'), `--password=${v('p0')}`, `API_KEY=${v('k0')}`, 'LOG_LEVEL=warn', ['sk', 'fixture0003'].join('-'), '--db', 'notes.sqlite', '--auth', '--verbose',
    `postgresql://${at('user', v('d1'), 'example.com:5432')}/app`, '-H', header('Authorization', `Bearer ${v('h1')}`), '--header', header('X-Api-Key', v('h2')),
    `https://api.example.com/v1?token=${v('q1')}&mode=ro`, '--key', v('k1'), '-p', v('p1'), header('Authorization', `Bearer ${v('h3')}`),
    `https://mcp.example.com/${['sk', 'fixture0099'].join('-')}/sse`, `--endpoint=https://${at('u', v('e1'), 'example.com')}/x`, 'plain.txt',
  ];
  const r = M.redactArgs(args);
  assert.deepEqual(r.shown, [
    // `--auth` is secret-named, so what follows it is hidden, whatever it starts with (third review 4).
    '--stdio', '--token', '<redacted>', '--password=<redacted>', 'API_KEY=<redacted>', 'LOG_LEVEL=warn', '<redacted>', '--db', 'notes.sqlite', '--auth', '<redacted>',
    'postgresql://<redacted>@example.com:5432/app', '-H', 'Authorization: <redacted>', '--header', 'X-Api-Key: <redacted>',
    'https://api.example.com/v1?token=<redacted>&mode=<redacted>', '--key', '<redacted>', '-p', '<redacted>', 'Authorization: <redacted>',
    'https://mcp.example.com/<redacted>/sse', '--endpoint=https://<redacted>@example.com/x', 'plain.txt',
  ]);
  // Everything hidden also feeds the scrub of a failing CLI's own output.
  const echoed = `error: could not start ${args.join(' ')}`;
  const scrubbed = M.scrub(echoed, r.secrets);
  for (const s of [v('t1'), v('p0'), v('k0'), ['sk', 'fixture0003'].join('-'), v('d1'), v('h1'), v('h2'), v('q1'), v('k1'), v('p1'), v('h3'), ['sk', 'fixture0099'].join('-'), v('e1')]) {
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

test('re-review C: header values after =, single-dash long flags, bare and nested long tokens, pass, shell strings, JSON values, short path keys', () => {
  const T = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'; // a 40-character random-looking token
  const H = '0123456789abcdef0123456789abcdef01234567'; // a 40-character hex token
  const args = [
    '--header=Authorization: Bearer tok-fixture-r1', '-token', 'tok-fixture-r2', '-api-key', 'key-fixture-r3', T, H, `--x=abc:${T}`,
    'DB_PASS=pw-fixture-r4', '--pass', 'pw-fixture-r5', '--passthrough', 'plain-value', 'sh', '-c', 'run --token tok-fixture-r6 --verbose',
    '--config', '{"apiKey":"key-fixture-r7","region":"eu","nested":{"secret":"s-fixture-r8"}}', 'https://h.example.com/v1/0123456789abcdef',
    'docs-search-mcp', '/usr/local/lib/node_modules/server-filesystem/dist/index.js',
  ];
  const r = M.redactArgs(args);
  assert.deepEqual(r.shown, [
    '--header=Authorization: <redacted>', '-token', '<redacted>', '-api-key', '<redacted>', '<redacted>', '<redacted>', '--x=abc:<redacted>',
    'DB_PASS=<redacted>', '--pass', '<redacted>', '--passthrough', 'plain-value', 'sh', '-c', 'run --token <redacted> --verbose',
    '--config', '{"apiKey":"<redacted>","region":"eu","nested":{"secret":"<redacted>"}}', 'https://h.example.com/v1/<redacted>',
    'docs-search-mcp', '/usr/local/lib/node_modules/server-filesystem/dist/index.js',
  ]);
  const scrubbed = M.scrub(`failed: ${args.join(' ')}`, r.secrets);
  for (const s of ['tok-fixture-r1', 'tok-fixture-r2', 'key-fixture-r3', T, H, 'pw-fixture-r4', 'pw-fixture-r5', 'tok-fixture-r6', 'key-fixture-r7', 's-fixture-r8', '0123456789abcdef']) {
    assert.ok(!scrubbed.includes(s), `the scrub left ${s}`);
  }
  assert.match(scrubbed, /plain-value/);
});

test('re-review B: the backup folder is made only of real folders this user owns; a planted link is refused, nothing written through it', () => {
  const { w, aos, calls } = setup();
  // Someone else's link where the backups go: ~/.local/share/unidex/backups -> a folder outside home.
  const planted = path.join(w.T, 'planted');
  fs.mkdirSync(planted, { recursive: true });
  fs.mkdirSync(path.join(w.home, '.local', 'share', 'unidex'), { recursive: true });
  fs.symlinkSync(planted, path.join(w.home, '.local', 'share', 'unidex', 'backups'));
  const r = aos(['copy', 'vault', '--to', 'codex']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /~\/\.local\/share\/unidex\/backups is not a folder of your own \(a link\): aos mcp keeps its backups only in real folders you own/);
  assert.deepEqual(fs.readdirSync(planted), [], 'nothing written through the link');
  assert.deepEqual(calls(), []);
  assert.throws(() => M.backup(w.home, 'codex', path.join(w.codexHome, 'config.toml'), Date.now()), /not a folder of your own/);
});

test('re-review D: the dry run\'s hash is an HMAC under a per-install key (0600, created once), never a plain hash of the values', () => {
  const { w, aos } = setup();
  const j = JSON.parse(aos(['copy', 'vault', '--to', 'codex', '--dry-run', '--json']).stdout);
  const keyFile = path.join(w.home, '.local', 'share', 'unidex', 'keys', 'mcp-plan.key');
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(keyFile)).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(keyFile).length, 32);
  const key = fs.readFileSync(keyFile);
  // Not a plain sha256 of what it covers, and the same key gives the same hash.
  const p = { name: 'vault', from: 'claude', to: 'codex' };
  assert.notEqual(j.expect, require('crypto').createHash('sha256').update('x').digest('hex'));
  assert.equal(JSON.parse(aos(['copy', 'vault', '--to', 'codex', '--dry-run', '--json']).stdout).expect, j.expect);
  assert.equal(M.planHash({ ...p, server: {}, argv: [] }, key), M.planHash({ ...p, server: {}, argv: [] }, key));
  assert.notEqual(M.planHash({ ...p, server: {}, argv: [] }, key), M.planHash({ ...p, server: {}, argv: [] }, Buffer.alloc(32, 1)));
  // A key file that is a link, or that others can read, is refused rather than used.
  fs.rmSync(keyFile);
  fs.writeFileSync(path.join(w.T, 'other.key'), Buffer.alloc(32, 2));
  fs.symlinkSync(path.join(w.T, 'other.key'), keyFile);
  const linked = aos(['copy', 'vault', '--to', 'codex', '--dry-run']);
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /mcp-plan\.key is not a key file of your own/);
  fs.rmSync(keyFile);
  fs.writeFileSync(keyFile, Buffer.alloc(32, 3), { mode: 0o644 });
  fs.chmodSync(keyFile, 0o644);
  assert.match(aos(['copy', 'vault', '--to', 'codex', '--dry-run']).stderr, /mcp-plan\.key is not a key file of your own/);
});

test('third review 1–4: quoted shell strings, the command itself, flag pairs in a JSON array, a dash-led secret, short secrets in the scrub', () => {
  const v = (tag) => ['fx', tag, 'value'].join('-');
  const header = (name, value) => [name, value].join(': ');
  // 1. A shell string with a quoted header: tokenized as a shell would, the header's value hidden, re-quoted for showing.
  const sh = `curl -H '${header('Authorization', `Bearer ${v('s1')}`)}' --header "${header('X-Api-Key', v('s2'))}" https://x.example.com`;
  const r1 = M.redactArgs(['sh', '-c', sh]);
  assert.equal(r1.shown[2], "curl -H 'Authorization: <redacted>' --header 'X-Api-Key: <redacted>' https://x.example.com/");
  // A string whose quotes do not close is hidden whole.
  assert.deepEqual(M.redactArgs(['sh', '-c', `echo 'unclosed ${v('s3')}`]).shown, ['sh', '-c', '<redacted>']);
  // 2. The command itself: `env KEY=<v> node`.
  const s = M.normalize('claude', { type: 'stdio', command: `env API_KEY=${v('c1')} node`, args: ['server.js'] });
  const tc = M.targetCommand('codex', 'cmd', s);
  assert.equal(tc.shown[4], 'env API_KEY=<redacted> node');
  const tj = M.targetCommand('claude', 'cmd', s);
  assert.equal(JSON.parse(tj.shown[5]).command, 'env API_KEY=<redacted> node');
  // 3. Flag pairs inside a JSON array.
  assert.equal(M.redactArgs(['--args', `["--token","${v('j1')}","--db","notes.sqlite"]`]).shown[1], '["--token","<redacted>","--db","notes.sqlite"]');
  // 4. After a secret-named flag the next argument is hidden whatever it starts with.
  assert.deepEqual(M.redactArgs(['--token', '-ab', '--auth', '--verbose']).shown, ['--token', '<redacted>', '--auth', '<redacted>']);
  // Everything hidden reaches the scrub, in its JSON-escaped form too (add-json's own echo), and a short one as a whole word.
  const all = M.redactArgs(['sh', '-c', sh, '--token', 'ab', '--args', `["--token","${v('j1')}"]`]);
  const echoed = `failed: ${JSON.stringify({ args: ['sh', '-c', sh] })} --token ab and "about" ${v('j1')}`;
  const out = M.scrub(`${echoed} ${tc.secrets.length ? `env API_KEY=${v('c1')}` : ''}`, [...all.secrets, ...tc.secrets]);
  for (const x of [v('s1'), v('s2'), v('j1'), v('c1')]) assert.ok(!out.includes(x), `the scrub left ${x}`);
  assert.match(out, / <redacted> and "about"/, 'a two-letter secret goes as a whole word, not inside another');
});

test('third review 5: parallel first dry runs share one key and agree on the hash', async () => {
  const { spawn } = require('child_process');
  for (let trial = 0; trial < 6; trial++) {
    const { w, env } = setup();
    const runs = await Promise.all([0, 1, 2, 3].map(() => new Promise((resolve) => {
      const c = spawn(process.execPath, [AOS, 'mcp', 'copy', 'vault', '--to', 'codex', '--dry-run', '--json'], { env });
      let out = '';
      let err = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { err += d; });
      c.on('close', (code) => resolve({ code, out, err }));
    })));
    for (const r of runs) assert.equal(r.code, 0, `trial ${trial}: ${r.err}`);
    assert.equal(new Set(runs.map((r) => JSON.parse(r.out).expect)).size, 1, `trial ${trial}: one key, one hash`);
    const dir = path.join(w.home, '.local', 'share', 'unidex', 'keys');
    assert.deepEqual(fs.readdirSync(dir), ['mcp-plan.key'], 'no temp file left behind');
  }
});

// ── aos mcp list | check (connectors-tab D8, D10, D15) ──────────────────────

test('list: every server and connector of both hosts into the caches, from files alone; no secret in the output or the vault', () => {
  const { w, aos, calls } = setup();
  const r = aos(['list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const names = out.rows.map((x) => `${x.host}:${x.name}`);
  for (const n of ['claude:vault', 'claude:remote', 'codex:notes-db', 'codex:inline-one', 'codex:paused']) assert.ok(names.includes(n), n);
  assert.equal(out.rows.find((x) => x.host === 'codex' && x.name === 'paused').enabled, false);
  assert.deepEqual(Object.keys(out.hosts).sort(), ['claude', 'codex']);
  for (const f of ['connectors.json', 'connectors-usage.json', 'mcp-servers.json']) assert.ok(fs.existsSync(path.join(w.vault, 'brain', '_index', f)), f);
  assert.equal(calls().length, 0, 'list starts nothing: no host CLI ran');
  noSecrets(r.stdout + r.stderr, 'aos mcp list');
  for (const f of ['connectors.json', 'connectors-usage.json', 'mcp-servers.json']) noSecrets(fs.readFileSync(path.join(w.vault, 'brain', '_index', f), 'utf8'), f);
  const human = aos(['list']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /MCP servers and connectors \(Claude Code \d+, Codex \d+\)/);
});

test('check: the hosts\' own lists and the probe, written to connectors-live.json; the list then carries a new claude.ai connector', async () => {
  const { w, env } = setup();
  const seen = [];
  const run = async (bin, args) => {
    seen.push([bin, ...args].join(' '));
    if (bin === 'claude') return { status: 0, stdout: 'vault: /opt/tools/vault-mcp - ✔ Connected\nremote: https://mcp.example.com/v1 (HTTP) - ! Needs authentication\nclaude.ai Notes: https://n - ✔ Connected\n', stderr: '' };
    if (args[0] === 'login') return { status: 0, stdout: 'Logged in', stderr: '' };
    return { status: 0, stdout: JSON.stringify([{ name: 'notes-db', enabled: true, auth_status: 'unsupported' }, { name: 'paused', enabled: false, disabled_reason: 'off' }]), stderr: '' };
  };
  const probe = async () => ({ ok: true, tools: [{ name: 'one', summary: 'One tool.' }] });
  const r = await M.checkNow({ env, home: w.home, run, probe, claudeBin: () => 'claude', codexBin: () => 'codex' });
  assert.equal(r.ok, true);
  const at = (h, n) => r.rows.find((x) => x.host === h && x.name === n);
  assert.deepEqual([at('claude', 'vault').status, at('claude', 'vault').tools.length], ['connected', 1]);
  assert.equal(at('claude', 'remote').status, 'needs-auth');
  assert.equal(at('codex', 'notes-db').status, 'connected');
  assert.equal(at('codex', 'paused').status, 'off');
  assert.deepEqual(seen, ['claude mcp list', 'codex mcp list --json']);
  const live = JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'connectors-live.json'), 'utf8'));
  assert.equal(live.schema, 1);
  noSecrets(JSON.stringify(live), 'connectors-live.json');
  const listed = JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'connectors.json'), 'utf8'));
  assert.ok(listed.rows.some((x) => x.name === 'claude.ai Notes' && x.kind === 'connector'), 'the list after the check knows the new connector');
});

test('check: one at a time — a check while another holds the lock is refused (exit 1 through aos)', async () => {
  const { w, env, aos } = setup();
  const lock = path.join(w.vault, 'brain', '_index', 'connectors-live.json.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, id: 'held', until: new Date(Date.now() + 60000).toISOString() }));
  await assert.rejects(() => M.checkNow({ env, home: w.home, claudeBin: () => null, codexBin: () => null }), (e) => e instanceof M.Refused && /already running/.test(e.message));
  const r = aos(['check', '--json']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mcp check: a check is already running/);
});

// ── aos mcp park | unpark | remove | add (connectors-tab D16–D18, A1, A2) ──

const PARKED = (w) => path.join(w.home, '.local', 'share', 'unidex', 'parked', 'mcp');
const listed = (w) => JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'connectors.json'), 'utf8')).rows;
const dry = (aos, args) => { const r = aos([...args, '--dry-run', '--json']); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`); return JSON.parse(r.stdout); };

/** A Claude Code plugin with a server, a Codex plugin with a server and a ChatGPT app, and a workspace's own server. */
function plugins(w) {
  const write = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof j === 'string' ? j : JSON.stringify(j, null, 2)); };
  const root = path.join(w.claudeDir, 'plugins', 'cache', 'market', 'helper', '1.0.0');
  write(path.join(root, '.mcp.json'), { helper: { command: 'helper-mcp' } });
  write(path.join(w.claudeDir, 'plugins', 'installed_plugins.json'), { plugins: { 'helper@market': [{ installPath: root }] } });
  const settings = path.join(w.claudeDir, 'settings.json');
  const prev = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, 'utf8')) : {};
  write(settings, { ...prev, enabledPlugins: { 'helper@market': true } });
  fs.appendFileSync(path.join(w.codexHome, 'config.toml'), '\n[plugins."tools@curated"]\nenabled = true\n\n[plugins."mail@curated"]\nenabled = true\n');
  const tools = path.join(w.codexHome, 'plugins', 'cache', 'curated', 'tools', '0.2.0');
  write(path.join(tools, '.codex-plugin', 'plugin.json'), { name: 'tools', mcpServers: './.mcp.json', interface: { displayName: 'Tools' } });
  write(path.join(tools, '.mcp.json'), { mcpServers: { toolbox: { command: 'toolbox-mcp' } } });
  const mail = path.join(w.codexHome, 'plugins', 'cache', 'curated-remote', 'mail', '0.1.0');
  write(path.join(mail, '.codex-plugin', 'plugin.json'), { name: 'mail', apps: './.app.json', interface: { displayName: 'Mail' } });
  write(path.join(mail, '.app.json'), { apps: { mail: { id: 'connector_abc' } } });
  write(path.join(w.vault, 'workspaces', 'alpha', '.mcp.json'), { mcpServers: { 'proj-one': { command: 'proj-mcp' } } });
}

test('usage: park, unpark and remove take a name and --host; add takes --to, a command or a URL, and secrets as $VAR names only', () => {
  const { aos } = setup();
  for (const [args, msg] of [
    [['park', 'x'], /aos mcp park: --host takes claude or codex/],
    [['park', 'x', '--host', 'cursor'], /--host takes claude or codex/],
    [['unpark', 'x', '--to', 'codex'], /aos mcp unpark takes --host, --dry-run, --expect and --json, not --to/],
    [['remove', 'x', '--host', 'codex', '--command', 'y'], /not --command/],
    [['copy', 'x', '--host', 'codex'], /aos mcp copy takes --to, --dry-run, --expect and --json, not --host/],
    [['add', 'x', '--to', 'claude'], /give --command \(a local server\) or --url \(a remote one\)/],
    [['add', 'x', '--to', 'cursor', '--command', 'y'], /--to takes claude, codex or both/],
    [['add', 'x', '--to', 'claude', '--command', 'y', '--url', 'https://h.example.com'], /give --command .* or --url/],
    [['add', 'x', '--to', 'claude', '--url', 'https://h.example.com', '--arg', 'z'], /--arg is for a local server/],
    [['add', 'x', '--to', 'claude', '--url', 'https://h.example.com', '--env', 'K=$V'], /a remote server takes its secret as --bearer-env/],
    [['add', 'x', '--to', 'claude', '--command', 'y', '--bearer-env', '$V'], /--bearer-env is for a remote server/],
    [['add', 'x', '--to', 'claude', '--command', 'y', '--env', 'K=$V', '--env', 'K=$W'], /--env K is given twice/],
    [['add', 'x', '--to', 'claude', '--command', 'y', '--command', 'z'], /--command is given twice/],
  ]) {
    const r = aos(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, msg, args.join(' '));
  }
  // A value where a variable's name belongs (the shell expanded it, or it was typed): refused, and never echoed.
  for (const args of [['--env', `API_TOKEN=${SECRET.env}`], ['--env', 'API_TOKEN=$'], ['--env', 'API_TOKEN'], ['--env', `${SECRET.env}=$V`]]) {
    const r = aos(['add', 'x', '--to', 'claude', '--command', 'y', ...args]);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /--env takes KEY=\$VAR|takes the name of a variable, \$NAME, never its value/);
    noSecrets(r.stderr, 'the refusal');
  }
  const bearer = aos(['add', 'x', '--to', 'codex', '--url', 'https://h.example.com/mcp', '--bearer-env', SECRET.env]);
  assert.equal(bearer.status, 2);
  assert.match(bearer.stderr, /--bearer-env takes the name of a variable, \$NAME, never its value/);
  noSecrets(bearer.stderr, 'the refusal');
  assert.deepEqual(M.parseMcpArgs(['add', 'gh', '--to', 'both', '--command', 'npx', '--arg', '-y', '--arg=--stdio', '--env', 'GITHUB_TOKEN=$GH', '--dry-run', '--json']), {
    verb: 'add', name: 'gh', to: 'both', command: 'npx', args: ['-y', '--stdio'], url: null, env: [{ key: 'GITHUB_TOKEN', var: 'GH' }], bearerEnv: null, dryRun: true, json: true, expect: null,
  });
  assert.deepEqual(M.parseMcpArgs(['park', 'x', '--host', 'codex', '--expect', 'a'.repeat(64)]), { verb: 'park', name: 'x', host: 'codex', dryRun: false, json: false, expect: 'a'.repeat(64) });
});

test('Claude Code: park keeps the exact entry in a 0600 stash outside the vault and runs `claude mcp remove --scope user`; Turn on puts it back unchanged and drops the stash', () => {
  const { w, aos, calls, cj, backups } = setup();
  const original = JSON.parse(fs.readFileSync(cj, 'utf8')).mcpServers.remote;
  const before = fs.readFileSync(cj, 'utf8');
  const d = dry(aos, ['park', 'remote', '--host', 'claude']);
  assert.deepEqual({ ...d, backup: d.backup.replace(STAMP, 'STAMP'), expect: 'HASH' }, {
    ok: true, dryRun: true, verb: 'park', name: 'remote', host: 'claude', transport: 'http', command: 'claude mcp remove remote --scope user',
    file: '~/.claude/.claude.json', backup: '~/.local/share/unidex/backups/mcp/claude-claude.json-STAMP.bak', stash: '~/.local/share/unidex/parked/mcp/claude-remote.json', expect: 'HASH',
  });
  assert.deepEqual(calls(), []);
  assert.ok(!fs.existsSync(path.join(w.home, '.local', 'share', 'unidex', 'parked')), 'a dry run makes no stash folder');
  assert.ok(!fs.existsSync(backups));
  const wrong = aos(['park', 'remote', '--host', 'claude', '--expect', 'f'.repeat(64)]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /^aos: mcp park: remote's config or its command changed since the dry run: run the dry run again$/m);
  const r = aos(['park', 'remote', '--host', 'claude', '--expect', d.expect, '--json']);
  assert.equal(r.status, 0, r.stderr);
  noSecrets(r.stdout + r.stderr, 'the park');
  assert.equal(JSON.parse(r.stdout).removed, true);
  assert.deepEqual(calls().map((c) => c.argv), [['mcp', 'remove', 'remote', '--scope', 'user']]);
  assert.equal(calls()[0].CLAUDE_CONFIG_DIR, w.claudeDir);
  assert.ok(!JSON.parse(fs.readFileSync(cj, 'utf8')).mcpServers.remote, 'Claude Code no longer has it');
  const stash = path.join(PARKED(w), 'claude-remote.json');
  assert.equal(fs.statSync(stash).mode & 0o777, 0o600);
  for (const d2 of [PARKED(w), path.dirname(PARKED(w))]) assert.equal(fs.statSync(d2).mode & 0o777, 0o700);
  const body = JSON.parse(fs.readFileSync(stash, 'utf8'));
  assert.deepEqual([body.schema, body.host, body.name, body.file, body.entry], [1, 'claude', 'remote', '~/.claude/.claude.json', original]);
  const bak = path.join(w.home, JSON.parse(r.stdout).backup.slice(2));
  assert.equal(fs.readFileSync(bak, 'utf8'), before, 'the backup is the file as it was');
  // Listed again: a parked row, off, with the cleaned URL and nothing of its headers.
  const row = listed(w).find((x) => x.host === 'claude' && x.name === 'remote');
  assert.deepEqual([row.scope, row.enabled, row.parked, row.url], ['user', false, true, 'https://mcp.example.com/v1']);
  noSecrets(fs.readFileSync(path.join(w.vault, 'brain', '_index', 'connectors.json'), 'utf8'), 'connectors.json');
  assert.ok(!fs.readdirSync(w.vault, { recursive: true }).some((f) => String(f).includes('parked')), 'nothing parked inside the vault');
  // Parked already: park again names unpark; Turn on's dry run shows the exact add-json with its secrets hidden.
  assert.match(aos(['park', 'remote', '--host', 'claude']).stderr, /remote is parked: `aos mcp unpark remote --host claude` puts it back on Claude Code/);
  const u = dry(aos, ['unpark', 'remote', '--host', 'claude']);
  assert.equal(u.command, `claude mcp add-json --scope user remote '{"type":"http","url":"https://mcp.example.com/v1?key=<redacted>","headers":{"Authorization":"<redacted>"}}'`);
  assert.equal(u.stash, '~/.local/share/unidex/parked/mcp/claude-remote.json');
  noSecrets(JSON.stringify(u), 'the unpark dry run');
  const on = aos(['unpark', 'remote', '--host', 'claude', '--expect', u.expect, '--json']);
  assert.equal(on.status, 0, on.stderr);
  noSecrets(on.stdout + on.stderr, 'the unpark');
  assert.equal(JSON.parse(on.stdout).listed, true);
  assert.deepEqual(JSON.parse(calls()[1].argv[5]), original, 'the entry exactly as it was');
  assert.deepEqual(JSON.parse(fs.readFileSync(cj, 'utf8')).mcpServers.remote, original);
  assert.ok(!fs.existsSync(stash), 'the stash goes once Claude Code lists it');
  assert.equal(listed(w).find((x) => x.host === 'claude' && x.name === 'remote').parked, undefined);
  assert.match(aos(['unpark', 'remote', '--host', 'claude']).stderr, /Claude Code has no parked MCP server named remote/);
  const human = aos(['park', 'docs-search', '--host', 'claude', '--dry-run']);
  assert.match(human.stdout, /^would park docs-search \(stdio\) on Claude Code$/m);
  assert.match(human.stdout, /^ {2}stash: {3}~\/\.local\/share\/unidex\/parked\/mcp\/claude-docs-search\.json \(its exact entry, 0600; `aos mcp unpark docs-search --host claude` puts it back\)$/m);
});

test('Codex: park runs `codex mcp remove` and Turn on `codex mcp add` with the real values; env_vars comes back as A1\'s paste line', () => {
  const { w, aos, calls, toml } = setup();
  fs.appendFileSync(toml, '\n[mcp_servers.gh]\ncommand = "gh-mcp"\nenv_vars = ["GH_TOKEN"]\n');
  const d = dry(aos, ['park', 'issue-tracker', '--host', 'codex']);
  assert.deepEqual([d.command, d.file, d.stash], ['codex mcp remove issue-tracker', '~/.codex/config.toml', '~/.local/share/unidex/parked/mcp/codex-issue-tracker.json']);
  const r = aos(['park', 'issue-tracker', '--host', 'codex', '--expect', d.expect, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls()[0].argv, ['mcp', 'remove', 'issue-tracker']);
  assert.equal(calls()[0].CODEX_HOME, w.codexHome);
  assert.ok(!/issue-tracker/.test(fs.readFileSync(toml, 'utf8')), 'the table and its .env are gone');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(PARKED(w), 'codex-issue-tracker.json'), 'utf8')).entry, { command: '/opt/tools/issue-mcp', args: ['--stdio'], env: { LOG_LEVEL: 'warn' } });
  assert.deepEqual(listed(w).filter((x) => x.name === 'issue-tracker').map((x) => [x.host, x.parked, x.enabled, x.command]), [['codex', true, false, '/opt/tools/issue-mcp']]);
  const u = dry(aos, ['unpark', 'issue-tracker', '--host', 'codex']);
  assert.equal(u.command, "codex mcp add issue-tracker --env 'LOG_LEVEL=<redacted>' -- /opt/tools/issue-mcp --stdio");
  assert.equal(u.paste, undefined);
  const on = aos(['unpark', 'issue-tracker', '--host', 'codex', '--expect', u.expect, '--json']);
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(calls()[1].argv, ['mcp', 'add', 'issue-tracker', '--env', 'LOG_LEVEL=warn', '--', '/opt/tools/issue-mcp', '--stdio']);
  assert.ok(!fs.existsSync(path.join(PARKED(w), 'codex-issue-tracker.json')));
  // env_vars: `codex mcp add` takes no variable names, so Turn on carries the line to paste.
  const g = JSON.parse(aos(['park', 'gh', '--host', 'codex', '--json']).stdout);
  assert.equal(g.removed, true);
  const gu = dry(aos, ['unpark', 'gh', '--host', 'codex']);
  assert.deepEqual([gu.command, gu.paste, gu.pasteUnder, gu.pasteFile], ['codex mcp add gh -- gh-mcp', 'env_vars = ["GH_TOKEN"]', '[mcp_servers.gh]', '~/.codex/config.toml']);
  assert.match(gu.pasteNote, /^Codex passes each of these to the server from its own environment, by that name$/);
  const human = aos(['unpark', 'gh', '--host', 'codex', '--dry-run']);
  assert.match(human.stdout, /^ {2}paste: {3}env_vars = \["GH_TOKEN"\]$/m);
});

test('park and remove refuse what is not the user\'s own server (D17), what park could not put back, a server off or the vault\'s own; refusals write nothing', () => {
  const { w, aos, calls, backups } = setup();
  plugins(w);
  for (const [args, msg] of [
    [['park', 'helper', '--host', 'claude'], /helper comes from the Claude Code plugin helper: turn the plugin off with `claude plugin disable helper` \(that turns off its skills too\)/],
    [['remove', 'toolbox', '--host', 'codex'], /toolbox comes from the Codex plugin tools, and Codex has no command that turns one off: turn the plugin off in Codex's plugin settings/],
    [['park', 'mail', '--host', 'codex'], /mail is a ChatGPT app of the Codex plugin mail: turn it off in ChatGPT's connector settings/],
    [['park', 'proj-one', '--host', 'claude'], /proj-one is the workspace alpha's own \(project, .*\.mcp\.json\): aos mcp park takes user-scope servers only/],
    [['park', 'agenticos', '--host', 'codex'], /the vault's own server/],
    [['remove', 'nope', '--host', 'claude'], /Claude Code declares no user-scope MCP server named nope \(~\/\.claude\/\.claude\.json\)/],
    [['park', 'vault', '--host', 'claude'], /Claude Code's CLI could not put vault back as it is \(it cannot take cwd\), so it is not parked: `aos mcp remove vault --host claude` removes it/],
    [['park', 'notes-db', '--host', 'codex'], /Codex's CLI could not put notes-db back as it is \(it cannot take http_headers, startup_timeout_sec\)/],
    [['park', 'paused', '--host', 'codex'], /paused is turned off on Codex already/],
    [['park', 'dotted-one', '--host', 'codex'], /Codex declares dotted-one in a form aos mcp park does not read \(dotted keys\)/],
    [['unpark', 'docs-search', '--host', 'claude'], /Claude Code has no parked MCP server named docs-search/],
  ]) {
    const r = aos(args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, msg, args.join(' '));
  }
  const off = setup({ hosts: { claude: true, codex: false } });
  assert.match(off.aos(['park', 'issue-tracker', '--host', 'codex']).stderr, /Codex is off on this Mac: `aos hosts add codex` turns it on/);
  assert.deepEqual(calls(), []);
  assert.ok(!fs.existsSync(backups));
  assert.ok(!fs.existsSync(PARKED(w)));
});

test('remove: no stash, the backup kept; a failing CLI keeps the server and leaves no stash behind; one write per host at a time', () => {
  const { w, env, aos, calls, cj, toml, backups } = setup();
  const d = dry(aos, ['remove', 'vault', '--host', 'claude']);
  assert.equal(d.stash, undefined);
  assert.equal(d.command, 'claude mcp remove vault --scope user');
  const r = aos(['remove', 'vault', '--host', 'claude', '--expect', d.expect, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).removed, true);
  assert.ok(!JSON.parse(fs.readFileSync(cj, 'utf8')).mcpServers.vault);
  assert.equal(fs.readdirSync(backups).filter((n) => n.endsWith('.bak')).length, 1);
  assert.ok(!fs.existsSync(PARKED(w)));
  noSecrets(r.stdout + r.stderr, 'the remove');
  const nd = aos(['remove', 'notes-db', '--host', 'codex', '--json']);
  assert.equal(nd.status, 0, nd.stderr);
  assert.ok(!/notes-db/.test(fs.readFileSync(toml, 'utf8')), 'the table and its sub-tables are gone');
  // A failing remove during a park: the server stays, the stash goes again, the backup is named.
  const fail = aos(['park', 'issue-tracker', '--host', 'codex'], { FAKE_FAIL: '1' });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /^aos: mcp park: codex mcp remove failed \(could not remove mcp remove issue-tracker\); the backup is ~\/\.local\/share\/unidex\/backups\/mcp\/codex-config\.toml-\d{8}T\d{9}Z\.bak$/m);
  assert.deepEqual(fs.readdirSync(PARKED(w)), []);
  assert.match(fs.readFileSync(toml, 'utf8'), /\[mcp_servers\.issue-tracker\]/);
  // Another write to Codex holds its lock: refused, nothing run.
  fs.writeFileSync(path.join(backups, 'codex-copy.lock'), JSON.stringify({ pid: process.pid, id: 'other', until: new Date(Date.now() + 60_000).toISOString() }));
  const n = calls().length;
  assert.throws(() => M.main(['park', 'issue-tracker', '--host', 'codex'], {
    env, home: env.HOME, io: { log: () => {} }, lockTimeoutMs: 50, claudeBin: () => env.AOS_CLAUDE_BIN, codexBin: () => env.AOS_CODEX_BIN,
  }), /another change to Codex's MCP servers is running: try again in a moment/);
  assert.equal(calls().length, n);
});

test('the stash is kept only in real folders of the user\'s own: a planted link is refused, and a stash others can read is not used', () => {
  const { w, aos, calls } = setup();
  const planted = path.join(w.T, 'planted');
  fs.mkdirSync(planted, { recursive: true });
  fs.mkdirSync(path.join(w.home, '.local', 'share', 'unidex'), { recursive: true });
  fs.symlinkSync(planted, path.join(w.home, '.local', 'share', 'unidex', 'parked'));
  const r = aos(['park', 'docs-search', '--host', 'claude']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /~\/\.local\/share\/unidex\/parked is not a folder of your own \(a link\): aos mcp keeps its parked servers only in real folders you own/);
  assert.deepEqual(fs.readdirSync(planted), []);
  assert.deepEqual(calls(), []);
  fs.rmSync(path.join(w.home, '.local', 'share', 'unidex', 'parked'));
  fs.mkdirSync(PARKED(w), { recursive: true, mode: 0o700 });
  const f = path.join(PARKED(w), 'claude-ghost.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, host: 'claude', name: 'ghost', entry: { command: 'ghost-mcp' } }));
  fs.chmodSync(f, 0o644);
  assert.match(aos(['unpark', 'ghost', '--host', 'claude']).stderr, /claude-ghost\.json is not a stash of your own \(others can read it\)/);
  fs.chmodSync(f, 0o600);
  assert.equal(dry(aos, ['unpark', 'ghost', '--host', 'claude']).command, `claude mcp add-json --scope user ghost '{"command":"ghost-mcp"}'`);
  // A host that has the name again: Turn on is refused, the stash kept.
  const j = JSON.parse(fs.readFileSync(path.join(w.claudeDir, '.claude.json'), 'utf8'));
  j.mcpServers.ghost = { command: 'other' };
  fs.writeFileSync(path.join(w.claudeDir, '.claude.json'), JSON.stringify(j));
  assert.match(aos(['unpark', 'ghost', '--host', 'claude']).stderr, /Claude Code already has an MCP server named ghost \(~\/\.claude\/\.claude\.json\): remove it first, or keep it and delete ~\/\.local\/share\/unidex\/parked\/mcp\/claude-ghost\.json/);
  assert.ok(fs.existsSync(f));
});

test('add to both hosts: Claude Code gets ${VAR} in add-json (A2), Codex the command with no environment and the env_vars line to paste (A1); both backed up and listed', () => {
  const { w, aos, calls, cj, toml } = setup();
  const args = ['add', 'gh-tools', '--to', 'both', '--command', 'npx', '--arg', '-y', '--arg', 'gh-mcp', '--env', 'GITHUB_TOKEN=$GH'];
  const d = dry(aos, args);
  assert.deepEqual({ ...d, hosts: d.hosts.map((h) => ({ ...h, backup: h.backup.replace(STAMP, 'STAMP') })), expect: 'HASH' }, {
    ok: true, dryRun: true, verb: 'add', name: 'gh-tools', to: 'both', transport: 'stdio', secrets: ['GITHUB_TOKEN ← $GH'],
    hosts: [
      { host: 'claude', command: `claude mcp add-json --scope user gh-tools '{"type":"stdio","command":"npx","args":["-y","gh-mcp"],"env":{"GITHUB_TOKEN":"\${GH}"}}'`, file: '~/.claude/.claude.json', backup: '~/.local/share/unidex/backups/mcp/claude-claude.json-STAMP.bak' },
      {
        host: 'codex', command: 'codex mcp add gh-tools -- npx -y gh-mcp', file: '~/.codex/config.toml', backup: '~/.local/share/unidex/backups/mcp/codex-config.toml-STAMP.bak',
        paste: 'env_vars = ["GITHUB_TOKEN"]', pasteUnder: '[mcp_servers.gh-tools]', pasteFile: '~/.codex/config.toml',
        pasteNote: 'Codex passes each of these to the server from its own environment, by that name: set GITHUB_TOKEN from $GH where Codex starts',
      },
    ],
    expect: 'HASH',
  });
  assert.deepEqual(calls(), []);
  const r = aos([...args, '--expect', d.expect, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const [c1, c2] = calls();
  assert.deepEqual(c1.argv.slice(0, 5), ['mcp', 'add-json', '--scope', 'user', 'gh-tools']);
  assert.deepEqual(JSON.parse(c1.argv[5]), { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: '${GH}' } });
  assert.deepEqual(c2.argv, ['mcp', 'add', 'gh-tools', '--', 'npx', '-y', 'gh-mcp']);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.hosts.map((h) => [h.host, h.listed, /\d{8}T\d{9}Z\.bak$/.test(h.backup)]), [['claude', true, true], ['codex', true, true]]);
  assert.equal(JSON.parse(fs.readFileSync(cj, 'utf8')).mcpServers['gh-tools'].env.GITHUB_TOKEN, '${GH}');
  assert.match(fs.readFileSync(toml, 'utf8'), /\[mcp_servers\.gh-tools\]\ncommand = "npx"/);
  assert.deepEqual(listed(w).filter((x) => x.name === 'gh-tools').map((x) => x.host), ['claude', 'codex']);
  // Again: both have it now.
  assert.match(aos(args).stderr, /Claude Code already has an MCP server named gh-tools/);
  const human = aos(['add', 'gh-two', '--to', 'codex', '--command', 'gh-mcp', '--env', 'GH_TOKEN=$GH_TOKEN', '--dry-run']);
  assert.match(human.stdout, /^would add gh-two \(stdio\) to Codex$/m);
  assert.match(human.stdout, /^ {2}secrets: GH_TOKEN ← \$GH_TOKEN \(names only/m);
  assert.match(human.stdout, /^ {4}paste: {3}env_vars = \["GH_TOKEN"\]$/m);
});

test('add a remote server: Claude Code\'s `Authorization: Bearer ${VAR}` header, Codex\'s --bearer-token-env-var; refusals (a name either has, parked, the vault\'s own, a host off, credentials in the URL) write nothing', () => {
  const { w, aos, calls } = setup();
  const args = ['add', 'charts', '--to', 'both', '--url', 'https://charts.example.com/mcp', '--bearer-env', '$CHARTS_TOKEN'];
  const d = dry(aos, args);
  assert.deepEqual(d.hosts.map((h) => h.command), [
    `claude mcp add-json --scope user charts '{"type":"http","url":"https://charts.example.com/mcp","headers":{"Authorization":"Bearer \${CHARTS_TOKEN}"}}'`,
    'codex mcp add charts --url https://charts.example.com/mcp --bearer-token-env-var CHARTS_TOKEN',
  ]);
  assert.deepEqual(d.secrets, ['Authorization ← Bearer $CHARTS_TOKEN']);
  const r = aos([...args, '--expect', d.expect, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(calls()[0].argv[5]), { type: 'http', url: 'https://charts.example.com/mcp', headers: { Authorization: 'Bearer ${CHARTS_TOKEN}' } });
  assert.deepEqual(calls()[1].argv, ['mcp', 'add', 'charts', '--url', 'https://charts.example.com/mcp', '--bearer-token-env-var', 'CHARTS_TOKEN']);
  const n = calls().length;
  fs.mkdirSync(PARKED(w), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(PARKED(w), 'codex-kept.json'), JSON.stringify({ schema: 1, host: 'codex', name: 'kept', entry: { command: 'k' } }), { mode: 0o600 });
  for (const [a, msg] of [
    [['add', 'docs-search', '--to', 'claude', '--command', 'x'], /Claude Code already has an MCP server named docs-search \(~\/\.claude\/\.claude\.json\)/],
    [['add', 'issue-tracker', '--to', 'both', '--command', 'x'], /Codex already has an MCP server named issue-tracker/],
    [['add', 'kept', '--to', 'codex', '--command', 'x'], /kept is parked on Codex: `aos mcp unpark kept --host codex` puts it back/],
    [['add', 'agenticos', '--to', 'claude', '--command', 'x'], /the vault's own server/],
    [['add', 'web fetch', '--to', 'claude', '--command', 'x'], /is not a server name both CLIs take/],
    [['add', 'x', '--to', 'claude', '--url', 'https://u:pw-fixture-a1@h.example.com/mcp'], /https:\/\/<redacted>@h\.example\.com\/mcp carries credentials: give the token's variable with --bearer-env/],
    [['add', 'x', '--to', 'claude', '--url', 'ftp://h.example.com/mcp'], /is not an http or https URL/],
  ]) {
    const x = aos(a);
    assert.equal(x.status, 1, `${a.join(' ')}: ${x.stderr}`);
    assert.match(x.stderr, msg, a.join(' '));
    assert.ok(!x.stderr.includes('pw-fixture-a1'));
  }
  const off = setup({ hosts: { claude: true, codex: false } });
  assert.match(off.aos(['add', 'x', '--to', 'both', '--command', 'x']).stderr, /Codex is off on this Mac/);
  assert.deepEqual(off.calls(), []);
  assert.equal(calls().length, n);
});
