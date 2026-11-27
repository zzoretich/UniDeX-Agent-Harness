'use strict';
// sessions.js: what the app's main process asks the runtime about the host CLIs (catalog, mirror, bin); the Sessions
// tab's turn verbs went with it (remove-sessions D11).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'lib', 'sessions.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sessions-'));
const exe = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p; };
const CLAUDE = exe('claude');

// The commands, as the app runs them, against a throwaway vault.
function vault(cfg) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sessions-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(v, 'AGENTICOS.md'), '# vault\n');
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify(cfg));
  const claudeDir = path.join(v, '.claude-config');
  fs.mkdirSync(claudeDir);
  return { v, env: { ...process.env, AOS_VAULT: v, CLAUDE_CONFIG_DIR: claudeDir } };
}
const cli = (args, env, input) => spawnSync(process.execPath, [SCRIPT, ...args], { env, input, encoding: 'utf8' });

test('CLI: catalog asks no host that is off, saves the answer, then serves the cache while it is fresh', () => {
  const { v, env } = vault({ hosts: { claude: { enabled: false }, codex: { enabled: false } } });
  const r = cli(['catalog'], env);
  assert.equal(r.status, 0, r.stderr);
  const cat = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(cat.hosts).sort(), ['claude', 'codex']);
  assert.deepEqual([cat.hosts.claude.off, cat.hosts.codex.off], [true, true]);
  const file = path.join(v, 'brain', '_index', 'host-catalog.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), cat);
  // A fresh cache is read back as it is, so a marker written into it shows.
  fs.writeFileSync(file, JSON.stringify({ ...cat, marker: 'cached' }));
  assert.equal(JSON.parse(cli(['catalog'], env).stdout).marker, 'cached');
  assert.equal(JSON.parse(cli(['catalog', '--refresh'], env).stdout).marker, undefined, '--refresh asks again');
  assert.equal(cli(['catalog', '--host', 'nohost'], env).status, 2);
});

test('CLI: bin names the recorded binary; the retired turn verbs print the usage and exit 2 (remove-sessions D11)', () => {
  const { env } = vault({ hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: false } } });
  const r = cli(['bin', 'claude'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, bin: CLAUDE });
  assert.equal(cli(['bin', 'sh'], env).status, 2);
  for (const verb of [['args', '{}'], ['events', '--host', 'claude'], ['record', '{"host":"claude","usd":0}']]) {
    const old = cli(verb, env, '');
    assert.equal(old.status, 2, verb[0]);
    assert.match(old.stderr, /^usage: sessions\.js catalog/, verb[0]);
  }
});
