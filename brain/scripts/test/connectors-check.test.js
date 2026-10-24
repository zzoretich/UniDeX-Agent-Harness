'use strict';
// connectors-tab D10, D11, D12: the live check per host — the hosts' own lists, the runtime's own probes (a real
// stdio server, test/fixtures/mcp-fixture-server.js), what is never started, one check at a time, no secret written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const K = require('../lib/connectors/check.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-fixture-server.js');
const NODE = process.execPath;
const SECRET = 'sk-checkSECRET0123456789abcdefXYZ';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}

/** `slow` adds a server that never answers (each run then waits out its probe timeout). */
function world({ slow = false } = {}) {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-check-')));
  const home = path.join(T, 'home');
  const claudeDir = path.join(home, '.claude');
  const codexHome = path.join(home, '.codex');
  const vault = path.join(T, 'vault');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  write(path.join(home, '.claude.json'), {
    mcpServers: {
      good: { command: NODE, args: [FIXTURE, 'ok'] },
      tokened: { command: NODE, args: [FIXTURE, 'ok', 'tokened'], env: { FIXTURE_TOKEN: '${FIX_TOKEN}' } },
      ...(slow ? { slow: { command: NODE, args: [FIXTURE, 'slow'] } } : {}),
      crash: { command: NODE, args: [FIXTURE, 'crash'] },
      needs: { command: NODE, args: [FIXTURE, 'ok', '${MISSING_VAR}'] },
      remote: { type: 'http', url: 'https://remote.example.com/mcp' },
      odd: { command: 'odd-mcp' },
      unlisted: { command: NODE, args: [FIXTURE, 'ok', 'unlisted'] },
    },
    claudeAiMcpEverConnected: ['claude.ai Mail', 'claude.ai Gone'],
  });
  write(path.join(codexHome, 'config.toml'), [
    '[mcp_servers.good]', `command = ${JSON.stringify(NODE)}`, `args = [${JSON.stringify(FIXTURE)}, "ok"]`, '',
    '[mcp_servers.sleepy]', 'command = "sleepy-mcp"', '',
    '[mcp_servers.ghost]', 'command = "ghost-mcp"', '',
    '[mcp_servers.oauth]', 'url = "https://oauth.example.com/mcp"', '',
    '[plugins."mail@curated"]', 'enabled = true', '',
  ].join('\n'));
  const mail = path.join(codexHome, 'plugins', 'cache', 'curated', 'mail', '1.0.0');
  write(path.join(mail, '.codex-plugin', 'plugin.json'), { name: 'mail', apps: './.app.json', interface: { displayName: 'Mail' } });
  write(path.join(mail, '.app.json'), { apps: { mail: { id: 'connector_1' } } });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, FIX_TOKEN: SECRET };
  const userConfig = { claudeConfigDir: claudeDir, hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  return { T, home, vault, env, userConfig };
}

const CLAUDE_LIST = [
  'Checking MCP server health…', '',
  `good: ${NODE} ${FIXTURE} ok - ✔ Connected`,
  `slow: ${NODE} ${FIXTURE} slow - ✔ Connected`,
  `crash: ${NODE} ${FIXTURE} crash - ✘ Failed to connect — exit 3`,
  `needs: ${NODE} - ✔ Connected`,
  'remote: https://remote.example.com/mcp (HTTP) - ! Needs authentication',
  'odd: odd-mcp - ⚠ Something new',
  'claude.ai Mail: https://mail.example.com/mcp - ✔ Connected',
  'claude.ai Fresh: https://fresh.example.com/mcp - ✔ Connected',
].join('\n');
const CODEX_LIST = JSON.stringify([
  { name: 'good', enabled: true, disabled_reason: null, transport: { type: 'stdio' }, auth_status: 'unsupported' },
  { name: 'sleepy', enabled: false, disabled_reason: 'turned off in config', transport: { type: 'stdio' }, auth_status: 'unsupported' },
  { name: 'oauth', enabled: true, transport: { type: 'streamable_http' }, auth_status: 'not_logged_in' },
]);

function fakeRun({ claude = { status: 0, stdout: CLAUDE_LIST }, codex = { status: 0, stdout: CODEX_LIST }, login = { status: 0, stdout: 'Logged in using ChatGPT' } } = {}) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([path.basename(bin), ...args]);
    if (bin.endsWith('claude')) return { stderr: '', timedOut: false, ...claude };
    if (args[0] === 'login') return { stderr: '', timedOut: false, ...login };
    return { stderr: '', timedOut: false, ...codex };
  };
  return { run, calls };
}

/** The real SDK probe for stdio; HTTP never leaves the process. */
function probeSpy() {
  const seen = [];
  const probe = async (launch, o) => {
    seen.push(launch);
    if (launch.transport !== 'stdio') return { ok: false, tools: null, error: 'HTTP 401 Unauthorized', auth: true };
    return K.sdkProbe(launch, o);
  };
  return { probe, seen };
}

async function runCheck(w, extra = {}) {
  const r = fakeRun(extra.runs);
  const p = probeSpy();
  const live = await K.check({
    vault: w.vault, userConfig: w.userConfig, env: w.env, home: w.home,
    cfg: { connectors: { probeTimeoutSec: 2, probeConcurrency: 3 } },
    claudeBin: () => '/usr/bin/claude', codexBin: () => '/usr/bin/codex', run: r.run, probe: p.probe, ...extra.opts,
  });
  const at = (host, name) => live.rows.find((x) => x.host === host && x.name === name);
  return { live, at, calls: r.calls, seen: p.seen };
}

test('check: Claude Code statuses from its own list; tools from the runtime\'s probe of what it connected', async () => {
  const w = world({ slow: true });
  const { live, at } = await runCheck(w, { opts: { cfg: { connectors: { probeTimeoutSec: 1, probeConcurrency: 4 } } } });
  assert.deepEqual(live.hosts.claude, { enabled: true, ran: true });
  const good = at('claude', 'good');
  assert.equal(good.status, 'connected');
  assert.deepEqual(good.tools.map((t) => t.name).sort(), ['fetch', 'lookup']);
  assert.equal(good.tools.find((t) => t.name === 'lookup').summary, 'Look a thing up.', 'the first line only');
  assert.ok(good.tools.find((t) => t.name === 'fetch').summary.length <= 200);
  assert.deepEqual([at('claude', 'crash').status, at('claude', 'crash').detail], ['failed', 'exit 3']);
  assert.equal(at('claude', 'remote').status, 'needs-auth');
  assert.deepEqual([at('claude', 'odd').status, at('claude', 'odd').detail], ['unknown', 'Something new']);
  const slow = at('claude', 'slow');
  assert.equal(slow.status, 'connected', 'the host said so; only the tools are missing');
  assert.match(slow.toolsError, /no answer in 1 s/);
  assert.equal(at('claude', 'tokened').tools.length, 2, 'a ${VAR} in env is filled in from the environment');
  assert.match(at('claude', 'needs').toolsError, /needs \$MISSING_VAR/);
  assert.equal(at('claude', 'unlisted').status, 'connected', 'a server the list leaves out is probed itself');
});

test('check: claude.ai connectors — listed ones carried, a new one added, one gone from the list is off', async () => {
  const w = world();
  const { at } = await runCheck(w);
  assert.equal(at('claude', 'claude.ai Mail').status, 'connected');
  assert.equal(at('claude', 'claude.ai Fresh').kind, 'connector');
  assert.deepEqual([at('claude', 'claude.ai Gone').status, at('claude', 'claude.ai Gone').detail], ['off', 'not on this account any more']);
});

test('check: Codex statuses — probed, off, declared but not loaded, needs sign-in; apps through the ChatGPT sign-in', async () => {
  const w = world();
  const { at, calls } = await runCheck(w);
  assert.equal(at('codex', 'good').status, 'connected');
  assert.equal(at('codex', 'good').tools.length, 2);
  assert.deepEqual([at('codex', 'sleepy').status, at('codex', 'sleepy').detail], ['off', 'turned off in config']);
  assert.deepEqual([at('codex', 'ghost').status, at('codex', 'ghost').detail], ['off', 'declared, but Codex does not load it']);
  assert.deepEqual([at('codex', 'oauth').status, at('codex', 'oauth').detail], ['needs-auth', 'codex mcp login oauth']);
  assert.deepEqual([at('codex', 'mail').kind, at('codex', 'mail').status], ['connector', 'connected']);
  assert.deepEqual(calls.map((c) => c.join(' ')), ['claude mcp list', 'codex mcp list --json', 'codex login status']);
  const signedOut = await runCheck(w, { runs: { login: { status: 1, stdout: 'Not logged in' } } });
  assert.equal(signedOut.at('codex', 'mail').status, 'needs-auth');
});

test('check: never starts what its host would not (D11); identical entries start once; a missing variable is not started', async () => {
  const w = world();
  const { seen } = await runCheck(w);
  const keys = seen.map((l) => JSON.stringify(l));
  assert.equal(new Set(keys).size, keys.length, 'one probe per identical entry');
  assert.equal(seen.filter((l) => l.args && l.args[1] === 'ok' && l.args.length === 2).length, 1, 'good on both hosts starts once');
  assert.ok(!seen.some((l) => l.args && l.args[1] === 'crash'), 'failed in the host\'s own list: not started');
  assert.ok(!seen.some((l) => l.url && l.url.includes('remote')), 'needs auth: not started');
  assert.ok(!seen.some((l) => l.command === 'sleepy-mcp' || l.command === 'ghost-mcp'));
  assert.ok(!seen.some((l) => l.args && l.args.includes('')), 'the entry naming an unset variable never ran');
});

test('check: no secret in the cache; the cache is schema 1 and readLive returns it', async () => {
  const w = world();
  const { live } = await runCheck(w);
  const text = fs.readFileSync(K.liveFile(w.vault), 'utf8');
  assert.ok(!text.includes(SECRET));
  assert.ok(text.includes('(token set)') === false, 'only the first line of a description is kept');
  assert.equal(JSON.parse(text).schema, 1);
  assert.deepEqual(K.readLive(w.vault).rows.length, live.rows.length);
});

test('check: a host CLI missing or failing is reported, never thrown; discovery rows stay unknown', async () => {
  const w = world();
  const gone = await runCheck(w, { opts: { claudeBin: () => null } });
  assert.deepEqual(gone.live.hosts.claude, { enabled: true, ran: false, error: 'the claude CLI was not found' });
  assert.equal(gone.at('claude', 'claude.ai Mail').status, 'unknown');
  const broke = await runCheck(w, { runs: { codex: { status: 2, stdout: '', stderr: 'boom' } } });
  assert.equal(broke.live.hosts.codex.ran, false);
  assert.match(broke.live.hosts.codex.error, /boom/);
});

test('check: one at a time — a held lock refuses, a stale one is broken', async () => {
  const w = world();
  const lock = `${K.liveFile(w.vault)}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, id: 'x', until: new Date(Date.now() + 60000).toISOString() }));
  await assert.rejects(() => runCheck(w), K.Busy);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, id: 'y', until: new Date(Date.now() - 1000).toISOString() }));
  const { live } = await runCheck(w);
  assert.ok(live.rows.length);
  assert.ok(!fs.existsSync(lock), 'released after the run');
});

test('parsers and launches: every claude mcp list label; Codex JSON; expansion per host', () => {
  const m = K.parseClaudeList([
    'a: x - ✔ Connected', 'b: x - ! Connected · tools fetch failed', 'c: x - ! Needs authentication',
    'd: x - ✘ Failed to connect — HTTP 429: too many', 'e: x - ⏸ Pending approval (run `claude` to approve)',
    'plugin:p:s: sh run - ✔ Connected', 'claude.ai Mail: https://m - ✔ Connected', 'noise line', 'f: has - a dash - ✘ Failed to connect',
    'g: t - u - ⚠ Something new',
  ].join('\n'));
  assert.deepEqual(Object.fromEntries([...m].map(([k, v]) => [k, `${v.status}|${v.detail}`])), {
    a: 'connected|', b: 'connected|tools fetch failed', c: 'needs-auth|', d: 'failed|HTTP 429: too many',
    e: 'pending|Pending approval (run `claude` to approve)', 'plugin:p:s': 'connected|', 'claude.ai Mail': 'connected|', f: 'failed|failed to connect',
    g: 'unknown|Something new',
  });
  assert.equal(K.parseCodexList('not json'), null);
  assert.equal(K.parseCodexList(CODEX_LIST).get('sleepy').enabled, false);

  const env = { HOME: '/h', TOKEN: 't0k', PASS: 'p' };
  const c = K.launchOf('claude', { spec: { command: '${CLAUDE_PLUGIN_ROOT}/bin/x', args: ['--k', '${TOKEN}', '${NOPE:-dflt}'], env: { A: '${TOKEN}' } }, root: '/plug' }, env);
  assert.deepEqual([c.command, c.args, c.env.A, c.cwd], ['/plug/bin/x', ['--k', 't0k', 'dflt'], 't0k', '/plug']);
  assert.deepEqual(K.launchOf('claude', { spec: { url: 'https://x/${NOPE}' } }, env), { missing: ['NOPE'] });
  const x = K.launchOf('codex', { spec: { command: 'srv', cwd: '.', env_vars: ['PASS', 'ABSENT'], env: { B: '1' } }, root: '/cx' }, env);
  assert.deepEqual([x.cwd, x.env.PASS, x.env.B, 'ABSENT' in x.env], ['/cx', 'p', '1', false]);
  const h = K.launchOf('codex', { spec: { url: 'https://y', bearer_token_env_var: 'TOKEN', env_http_headers: { 'X-Key': 'PASS' } } }, env);
  assert.deepEqual(h.headers, { Authorization: 'Bearer t0k', 'X-Key': 'p' });
  assert.deepEqual(K.launchOf('codex', { spec: { url: 'https://y', bearer_token_env_var: 'NOPE' } }, env), { missing: ['NOPE'] });
  assert.equal(K.launchOf('codex', { spec: { args: ['x'] } }, env), null);
});
