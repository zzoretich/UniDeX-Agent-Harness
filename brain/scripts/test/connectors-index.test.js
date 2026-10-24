'use strict';
// connectors-tab D8, D14: the caches a scan refreshes — written only when they change; mcp-servers.json as today.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const X = require('../lib/connectors/index.js');
const M = require('../lib/import/mcp.js');

function world() {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-conn-idx-')));
  const home = path.join(T, 'home');
  const claudeDir = path.join(home, '.claude');
  const codexHome = path.join(home, '.codex');
  const vault = path.join(T, 'vault');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' }, agenticos: { command: 'sh' } } }));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.fetcher]\ncommand = "fetch-mcp"\n');
  const cfg = { claudeConfigDir: claudeDir, hosts: { claude: { enabled: true }, codex: { enabled: true, home: codexHome } }, connectors: { usageDays: 30 } };
  const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome };
  return { T, home, vault, cfg, env };
}

const idx = (w, f) => path.join(w.vault, 'brain', '_index', f);
const mtime = (f) => fs.statSync(f).mtimeMs;

test('refresh: the three caches; mcp-servers.json as the import writes it (the vault\'s own server left out)', () => {
  const w = world();
  const r = X.refresh({ vault: w.vault, cfg: w.cfg, env: w.env, home: w.home, now: Date.parse('2026-10-20T00:00:00Z') });
  assert.deepEqual(r.connectors.rows.map((x) => `${x.host}:${x.name}`), ['claude:agenticos', 'claude:docs', 'codex:fetcher']);
  const c = JSON.parse(fs.readFileSync(X.connectorsFile(w.vault), 'utf8'));
  assert.equal(c.schema, 1);
  assert.equal(c.updatedAt, '2026-10-20T00:00:00.000Z');
  const legacy = JSON.parse(fs.readFileSync(idx(w, 'mcp-servers.json'), 'utf8'));
  assert.deepEqual(legacy.servers.map((s) => `${s.host}:${s.name}`), ['claude:docs', 'codex:fetcher']);
  assert.deepEqual(legacy.servers[0], { name: 'docs', host: 'claude', transport: 'stdio', command: 'docs-mcp', scope: 'user', enabled: true });
  assert.ok(fs.existsSync(idx(w, 'connectors-usage.json')));
});

test('refresh: nothing changed, nothing rewritten (no vault event every scan); a change rewrites', () => {
  const w = world();
  X.refresh({ vault: w.vault, cfg: w.cfg, env: w.env, home: w.home });
  const files = ['connectors.json', 'mcp-servers.json', 'connectors-usage.json'].map((f) => idx(w, f));
  const old = new Date(Date.now() - 60 * 1000);
  for (const f of files) fs.utimesSync(f, old, old);
  const before = files.map(mtime);
  X.refresh({ vault: w.vault, cfg: w.cfg, env: w.env, home: w.home, now: Date.now() + 5000 });
  assert.deepEqual(files.map(mtime), before, 'all three left as they were');
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' }, more: { command: 'more-mcp' } } }));
  X.refresh({ vault: w.vault, cfg: w.cfg, env: w.env, home: w.home });
  assert.notEqual(mtime(files[0]), before[0]);
  assert.notEqual(mtime(files[1]), before[1]);
  assert.ok(M.writeServers(w.vault, ['claude'], { claude: [] }, { ifChanged: true }).written, 'a different listing is written');
});

test('refresh: a host turned off keeps its mcp-servers.json rows (as the import does) and lists none in connectors.json', () => {
  const w = world();
  X.refresh({ vault: w.vault, cfg: w.cfg, env: w.env, home: w.home });
  const off = { ...w.cfg, hosts: { ...w.cfg.hosts, codex: { enabled: false, home: w.cfg.hosts.codex.home } } };
  const r = X.refresh({ vault: w.vault, cfg: off, env: w.env, home: w.home });
  assert.ok(r.connectors.rows.every((x) => x.host === 'claude'));
  assert.equal(r.connectors.hosts.codex.enabled, false);
  const legacy = JSON.parse(fs.readFileSync(idx(w, 'mcp-servers.json'), 'utf8'));
  assert.ok(legacy.servers.some((s) => s.host === 'codex'));
});
