'use strict';
// connectors-tab D7, D8, D11: every source each host reads, files only, per host; secrets never in a row.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../lib/connectors/discover.js');
const P = require('../lib/connectors/plugins.js');

const MARK = 'sk-connectorsSECRET0123456789abcdef';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  return file;
}

/** A home with both hosts' config, plugins in each, and a vault with workspaces that declare their own servers. */
function world({ ever = ['claude.ai Mail', 'claude.ai Calendar', 'not a connector'] } = {}) {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-conn-')));
  const home = path.join(T, 'home');
  const claudeDir = path.join(home, '.claude');
  const codexHome = path.join(home, '.codex');
  const vault = path.join(T, 'vault');
  const alpha = path.join(vault, 'workspaces', 'alpha');
  const beta = path.join(vault, 'workspaces', 'beta');
  const gamma = path.join(vault, 'workspaces', 'gamma');
  const repo = path.join(home, 'code', 'alpha-repo');
  write(path.join(alpha, 'workspace.md'), '---\nsummary: x\nrepo: ~/code/alpha-repo\n---\n# alpha\n');
  write(path.join(alpha, '.mcp.json'), { mcpServers: { approved: { command: 'approved-mcp', env: { API_KEY: MARK } }, waiting: { command: 'waiting-mcp' }, refused: { command: 'refused-mcp' } } });
  write(path.join(repo, '.mcp.json'), { 'repo-tool': { type: 'http', url: `https://repo.example.com/mcp?key=${MARK}` } });
  write(path.join(vault, 'workspaces', '_hidden', '.mcp.json'), { mcpServers: { hidden: { command: 'hidden-mcp' } } });
  write(path.join(beta, '.codex', 'config.toml'), '[mcp_servers.beta-local]\ncommand = "beta-mcp"\n');
  write(path.join(gamma, '.codex', 'config.toml'), '[mcp_servers.untrusted]\ncommand = "untrusted-mcp"\n');

  // Claude Code: .claude.json beside the default config folder.
  write(path.join(home, '.claude.json'), {
    mcpServers: {
      docs: { command: 'docs-mcp', args: ['--token', MARK], env: { TOKEN: MARK } },
      tracker: { type: 'http', url: `https://${MARK}@tracker.example.com/mcp`, headers: { Authorization: `Bearer ${MARK}` } },
      agenticos: { command: 'sh', args: ['aos', 'mcp-server'] },
    },
    projects: {
      [alpha]: { mcpServers: { 'alpha-local': { command: 'alpha-local-mcp' } }, enabledMcpjsonServers: ['approved'], disabledMcpjsonServers: ['refused'] },
    },
    claudeAiMcpEverConnected: ever,
  });
  const pluginRoot = path.join(claudeDir, 'plugins', 'cache', 'market', 'helper', '1.0.0');
  write(path.join(pluginRoot, '.mcp.json'), { helper: { command: '${CLAUDE_PLUGIN_ROOT}/bin/helper', env: { SECRET: MARK } } });
  const offRoot = path.join(claudeDir, 'plugins', 'cache', 'market', 'dormant', '1.0.0');
  write(path.join(offRoot, '.mcp.json'), { dormant: { command: 'dormant-mcp' } });
  const inlineRoot = path.join(claudeDir, 'plugins', 'cache', 'market', 'inline', '1.0.0');
  write(path.join(inlineRoot, '.claude-plugin', 'plugin.json'), { name: 'inline', mcpServers: { inline: { url: 'https://inline.example.com/mcp' } } });
  write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), {
    plugins: {
      'helper@market': [{ installPath: pluginRoot }],
      'dormant@market': [{ installPath: offRoot }],
      'inline@market': [{ installPath: inlineRoot }],
    },
  });
  write(path.join(claudeDir, 'settings.json'), { enabledPlugins: { 'helper@market': true, 'dormant@market': false, 'inline@market': true } });

  // Codex: config.toml with servers, a trusted and an untrusted project, and plugins.
  write(path.join(codexHome, 'config.toml'), [
    'model = "x"',
    `[projects.${JSON.stringify(beta)}]`, 'trust_level = "trusted"', '',
    `[projects.${JSON.stringify(gamma)}]`, 'trust_level = "untrusted"', '',
    '[mcp_servers.fetcher]', 'command = "fetch-mcp"', `args = ["--api-key", "${MARK}"]`, '',
    '[mcp_servers.fetcher.env]', `TOKEN = "${MARK}"`, '',
    '[mcp_servers.sleepy]', 'command = "sleepy-mcp"', 'enabled = false', '',
    '[plugins."tools@curated"]', 'enabled = true', '',
    '[plugins."mail@curated"]', 'enabled = true', '',
    '[plugins."gone@curated"]', 'enabled = false', '',
  ].join('\n'));
  const cache = path.join(codexHome, 'plugins', 'cache');
  const tools = path.join(cache, 'curated', 'tools', '0.2.0');
  write(path.join(tools, '.codex-plugin', 'plugin.json'), { name: 'tools', mcpServers: './.mcp.json', interface: { displayName: 'Tools' } });
  write(path.join(tools, '.mcp.json'), { mcpServers: { toolbox: { command: 'toolbox-mcp', cwd: '.', env_vars: ['HOME'] } } });
  const mail = path.join(cache, 'curated-remote', 'mail', '0.1.0');
  write(path.join(mail, '.codex-plugin', 'plugin.json'), { name: 'mail', apps: './.app.json', interface: { displayName: 'Mail' } });
  write(path.join(mail, '.app.json'), { apps: { mail: { id: 'connector_abc' } } });
  const gone = path.join(cache, 'curated', 'gone', '1.0.0');
  write(path.join(gone, '.codex-plugin', 'plugin.json'), { name: 'gone', mcpServers: './.mcp.json' });
  write(path.join(gone, '.mcp.json'), { mcpServers: { goner: { command: 'goner' } } });

  const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome };
  const userConfig = { claudeConfigDir: claudeDir, hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  return { T, home, claudeDir, codexHome, vault, alpha, beta, gamma, repo, env, userConfig };
}

function byKey(rows) { return Object.fromEntries(rows.map((r) => [`${r.host}:${r.name}`, r])); }

test('discovery: Claude Code user, local, project (approved, pending, off), plugin and account rows', () => {
  const w = world();
  const d = D.discover({ vault: w.vault, userConfig: w.userConfig, env: w.env, home: w.home });
  const k = byKey(d.rows);
  assert.equal(k['claude:docs'].scope, 'user');
  assert.equal(k['claude:docs'].command, 'docs-mcp');
  assert.equal(k['claude:docs'].file, '~/.claude.json');
  assert.equal(k['claude:tracker'].url, 'https://tracker.example.com/mcp');
  assert.equal(k['claude:agenticos'].own, true);
  assert.deepEqual([k['claude:alpha-local'].scope, k['claude:alpha-local'].workspace], ['local', 'alpha']);
  assert.deepEqual([k['claude:approved'].approval, k['claude:approved'].enabled], ['approved', true]);
  assert.equal(k['claude:waiting'].approval, 'pending');
  assert.deepEqual([k['claude:refused'].approval, k['claude:refused'].enabled], ['off', false]);
  assert.equal(k['claude:repo-tool'].workspace, 'alpha', 'a repo: folder counts for its workspace');
  assert.equal(k['claude:repo-tool'].url, 'https://repo.example.com/mcp');
  assert.ok(!k['claude:hidden'], 'a _ workspace is not read');
  assert.equal(k['claude:plugin:helper:helper'].scope, 'plugin');
  assert.equal(k['claude:plugin:helper:helper'].plugin, 'helper');
  assert.ok(k['claude:plugin:inline:inline'], 'a plugin.json mcpServers object is read');
  assert.ok(!k['claude:plugin:dormant:dormant'], 'a disabled plugin brings nothing');
  assert.deepEqual(['claude.ai Mail', 'claude.ai Calendar'].map((n) => [k[`claude:${n}`].kind, k[`claude:${n}`].unverified, k[`claude:${n}`].displayName]),
    [['connector', true, 'Mail'], ['connector', true, 'Calendar']]);
  assert.ok(!k['claude:not a connector']);
  assert.equal(d.hosts.claude.enabled, true);
});

test('discovery: a check\'s claude.ai names replace the ever-connected list and are not unverified', () => {
  const w = world();
  const live = { rows: [{ host: 'claude', name: 'claude.ai Mail', status: 'connected' }, { host: 'claude', name: 'docs', status: 'connected' }] };
  const k = byKey(D.discover({ vault: w.vault, userConfig: w.userConfig, env: w.env, home: w.home, live }).rows);
  assert.ok(k['claude:claude.ai Mail']);
  assert.equal(k['claude:claude.ai Mail'].unverified, undefined);
  assert.ok(!k['claude:claude.ai Calendar'], 'gone from the last check, gone from the list');
});

test('discovery: Codex user (on and off), trusted project only, plugin servers, plugin apps; a disabled plugin brings nothing', () => {
  const w = world();
  const k = byKey(D.discover({ vault: w.vault, userConfig: w.userConfig, env: w.env, home: w.home }).rows);
  assert.deepEqual([k['codex:fetcher'].scope, k['codex:fetcher'].command, k['codex:fetcher'].file], ['user', 'fetch-mcp', '~/.codex/config.toml']);
  assert.equal(k['codex:sleepy'].enabled, false);
  assert.deepEqual([k['codex:beta-local'].scope, k['codex:beta-local'].workspace], ['project', 'beta']);
  assert.ok(!k['codex:untrusted'], 'an untrusted project is not read (D11)');
  assert.deepEqual([k['codex:toolbox'].scope, k['codex:toolbox'].plugin], ['plugin', 'tools']);
  assert.deepEqual([k['codex:mail'].kind, k['codex:mail'].displayName, k['codex:mail'].connectorId], ['connector', 'Mail', 'connector_abc']);
  assert.ok(!k['codex:goner']);
});

test('discovery: no secret reaches a row (env, args, headers, URL credentials and queries)', () => {
  const w = world();
  const d = D.discover({ vault: w.vault, userConfig: w.userConfig, env: w.env, home: w.home });
  assert.ok(d.rows.length > 10);
  assert.ok(!JSON.stringify(d).includes(MARK));
  assert.ok(!JSON.stringify(d).includes(w.home), 'paths under home are ~/…');
});

test('discovery: only enabled hosts are read; a config without hosts reads Claude Code', () => {
  const w = world();
  const codexOnly = D.discover({ vault: w.vault, userConfig: { ...w.userConfig, hosts: { claude: { enabled: false }, codex: { enabled: true } } }, env: w.env, home: w.home });
  assert.ok(codexOnly.rows.every((r) => r.host === 'codex'));
  assert.deepEqual([codexOnly.hosts.claude.enabled, codexOnly.hosts.codex.enabled], [false, true]);
  const legacy = D.discover({ vault: w.vault, userConfig: { claudeConfigDir: w.claudeDir }, env: w.env, home: w.home });
  assert.ok(legacy.rows.length && legacy.rows.every((r) => r.host === 'claude'));
});

test('discovery: missing or broken files leave that source empty, never a throw', () => {
  const w = world();
  fs.writeFileSync(path.join(w.home, '.claude.json'), '{ not json');
  fs.writeFileSync(path.join(w.codexHome, 'config.toml'), '[mcp_servers.half\ncommand = ');
  const d = D.discover({ vault: w.vault, userConfig: w.userConfig, env: w.env, home: w.home });
  assert.ok(Array.isArray(d.rows));
  const bare = D.discover({ vault: path.join(w.T, 'nowhere'), userConfig: { hosts: w.userConfig.hosts }, env: { CLAUDE_CONFIG_DIR: path.join(w.T, 'none'), CODEX_HOME: path.join(w.T, 'none2') }, home: path.join(w.T, 'nohome') });
  assert.deepEqual(bare.rows, []);
});

test('plugins: both .mcp.json shapes; a manifest path outside the plugin is not read', () => {
  assert.deepEqual(Object.keys(P.serverMap({ mcpServers: { a: { command: 'a' }, junk: 3 } })), ['a']);
  assert.deepEqual(Object.keys(P.serverMap({ b: { url: 'https://b' }, c: { nothing: true } })), ['b']);
  const w = world();
  const root = path.join(w.claudeDir, 'plugins', 'cache', 'market', 'helper', '1.0.0');
  write(path.join(root, '.claude-plugin', 'plugin.json'), { name: 'helper', mcpServers: '../../../../../.claude.json' });
  const k = byKey(D.discover({ vault: w.vault, userConfig: w.userConfig, env: w.env, home: w.home }).rows);
  assert.ok(!k['claude:plugin:helper:docs'], 'an outside path is not followed');
});

test('workspace folders and trust: _ folders skipped, repo: expanded, quoted project headers read', () => {
  const w = world();
  const f = D.workspaceFolders(w.vault, w.home);
  assert.deepEqual(f.map((x) => [x.workspace, path.relative(w.T, x.dir)]), [
    ['alpha', 'vault/workspaces/alpha'], ['alpha', 'home/code/alpha-repo'], ['beta', 'vault/workspaces/beta'], ['gamma', 'vault/workspaces/gamma'],
  ]);
  const t = D.trustedFolders(`[projects."/a/b"]\ntrust_level = "trusted"\n[projects.'/c']\ntrust_level = "trusted"\n[projects."/d"]\ntrust_level = "untrusted"\n`);
  assert.deepEqual([...t], [path.resolve('/a/b'), path.resolve('/c')]);
  assert.equal(D.approvalOf(undefined, 'x'), 'pending');
  assert.equal(D.approvalOf({ enableAllProjectMcpServers: true }, 'x'), 'approved');
});

test('discovery: a parked server (aos mcp park, D16) is a user row, off and parked, per host; its stash\'s secrets never reach it; a name the host declares again, a stash for the other host or one that does not parse is not listed', () => {
  const w = world();
  const dir = D.parkDir(w.home);
  write(path.join(dir, 'claude-quiet.json'), { schema: 1, host: 'claude', name: 'quiet', entry: { type: 'stdio', command: '/opt/tools/quiet-mcp', args: ['--token', MARK], env: { TOKEN: MARK } } });
  write(path.join(dir, 'codex-faraway.json'), { schema: 1, host: 'codex', name: 'faraway', entry: { url: `https://far.example.com/mcp?key=${MARK}`, bearer_token_env_var: 'FAR' } });
  // The host has `docs` again: the user row wins. A stash under another name, and one that does not parse.
  write(path.join(dir, 'claude-docs.json'), { schema: 1, host: 'claude', name: 'docs', entry: { command: 'old-docs' } });
  write(path.join(dir, 'claude-liar.json'), { schema: 1, host: 'codex', name: 'liar', entry: { command: 'x' } });
  write(path.join(dir, 'codex-broken.json'), '{ not json');
  const d = D.discover({ vault: w.vault, userConfig: w.userConfig, env: w.env, home: w.home });
  const parked = d.rows.filter((r) => r.parked);
  assert.deepEqual(parked.map((r) => [r.host, r.name, r.scope, r.enabled, r.command || r.url, r.kind]), [
    ['codex', 'faraway', 'user', false, 'https://far.example.com/mcp', 'server'],
    ['claude', 'quiet', 'user', false, '/opt/tools/quiet-mcp', 'server'],
  ]);
  assert.equal(parked.find((r) => r.name === 'quiet').file, '~/.claude.json');
  assert.equal(parked.find((r) => r.name === 'faraway').file, '~/.codex/config.toml');
  assert.equal(d.rows.filter((r) => r.host === 'claude' && r.name === 'docs').length, 1);
  assert.equal(d.rows.find((r) => r.host === 'claude' && r.name === 'docs').parked, undefined);
  assert.ok(!d.rows.some((r) => r.name === 'liar' || r.name === 'broken'));
  assert.ok(!JSON.stringify(d).includes(MARK));
  const claudeOnly = D.discover({ vault: w.vault, userConfig: { ...w.userConfig, hosts: { claude: { enabled: true }, codex: { enabled: false } } }, env: w.env, home: w.home });
  assert.deepEqual(claudeOnly.rows.filter((r) => r.parked).map((r) => r.name), ['quiet']);
});
