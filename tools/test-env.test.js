'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { scrub, MARKER } = require('./test-env.js');

const PRELOAD = path.join(__dirname, 'test-env.js');
const DIRTY = {
  AOS_HOST: 'codex', AOS_VAULT: '/nowhere', AOS_CONFIG: '/nowhere/agenticos.json', AOS_DEBUG: '1',
  BRAIN_VAULT: '/nowhere', BRAIN_AGENT_REDACT: '0', CLAUDE_PROJECT_DIR: '/nowhere', CLAUDE_CONFIG_DIR: '/nowhere',
  CLAUDECODE: '1', CODEX_HOME: '/nowhere', AUTO_WRAP_DETACHED: '1', AOS_PRIVACY_TERMS: 'kept', LANG_KEEP_ME: 'yes',
};

test('scrub removes every host and runtime variable, keeps the private gate terms and everything else, and marks the env', () => {
  const env = { ...DIRTY, PATH: '/bin' };
  const removed = scrub(env);
  assert.deepEqual(removed.sort(), ['AOS_CONFIG', 'AOS_DEBUG', 'AOS_HOST', 'AOS_VAULT', 'AUTO_WRAP_DETACHED', 'BRAIN_AGENT_REDACT',
    'BRAIN_VAULT', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'CODEX_HOME']);
  assert.deepEqual(env, { AOS_PRIVACY_TERMS: 'kept', LANG_KEEP_ME: 'yes', PATH: '/bin', [MARKER]: '1', AOS_TOTALMEM: String(32 * 1024 ** 3) });
});

test('scrub pins a 32 GB Mac for the local model tiers, replacing the developer\'s own value (local-first A12)', () => {
  const env = { AOS_TOTALMEM: '8' };
  assert.deepEqual(scrub(env), ['AOS_TOTALMEM']);
  assert.equal(env.AOS_TOTALMEM, String(32 * 1024 ** 3));
});

test('a marked environment is left alone, so a child keeps what its test set on purpose', () => {
  const env = { ...DIRTY, [MARKER]: '1' };
  assert.deepEqual(scrub(env), []);
  assert.equal(env.AOS_HOST, 'codex');
});

test('as a preload: the first process scrubs, a child it spawns with its own settings keeps them', () => {
  const show = 'process.stdout.write(JSON.stringify({ host: process.env.AOS_HOST || null, codex: process.env.CODEX_HOME || null, marker: process.env.' + MARKER + ' || null }))';
  const env = { ...DIRTY, PATH: process.env.PATH };
  delete env[MARKER];
  const top = spawnSync(process.execPath, ['--require', PRELOAD, '-e', show], { encoding: 'utf8', env });
  assert.equal(top.status, 0, top.stderr);
  assert.deepEqual(JSON.parse(top.stdout), { host: null, codex: null, marker: '1' });
  const child = spawnSync(process.execPath, ['--require', PRELOAD, '-e', show], { encoding: 'utf8', env: { ...env, [MARKER]: '1' } });
  assert.deepEqual(JSON.parse(child.stdout), { host: 'codex', codex: '/nowhere', marker: '1' });
});
