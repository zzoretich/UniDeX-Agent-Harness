'use strict';
// sessions.js bin: the binary a Code launch runs, as the app's main process asks for it before it spawns the CLI as a
// terminal's own process (agent-computer D18). The same resolution a Chat turn's `args` uses (headless.resolveBin).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'lib', 'sessions.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sessions-bin-'));
const exe = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p; };
const CLAUDE = exe('claude');
const CODEX = exe('codex');

function vault(cfg) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sessions-bin-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(v, 'AGENTICOS.md'), '# vault\n');
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify(cfg));
  // An empty PATH: `command -v` finds nothing, so only the recorded binary answers.
  return { ...process.env, AOS_VAULT: v, PATH: '/nonexistent' };
}
const cli = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });

test('CLI: bin prints the binary the runtime resolves for each host', () => {
  const env = vault({ hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true, bin: CODEX } } });
  const claude = cli(['bin', 'claude'], env);
  assert.equal(claude.status, 0, claude.stderr);
  assert.deepEqual(JSON.parse(claude.stdout), { ok: true, bin: CLAUDE });
  assert.deepEqual(JSON.parse(cli(['bin', 'codex'], env).stdout), { ok: true, bin: CODEX });
});

test('CLI: bin says so when no binary resolves, and refuses a host it does not know', () => {
  const env = { ...vault({ hosts: { claude: { enabled: true, bin: path.join(dir, 'gone') } } }), AOS_NO_CODEX: '1' };
  const none = cli(['bin', 'codex'], env);
  assert.equal(none.status, 3);
  assert.deepEqual(JSON.parse(none.stdout), { ok: false, reason: 'no codex binary found' });
  const bad = cli(['bin', 'nohost'], env);
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  assert.equal(cli(['bin'], env).status, 2);
});
