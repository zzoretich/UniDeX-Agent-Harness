'use strict';
// statusline.js render tee: a per-terminal copy of what render printed, for the Code chat (readTee in lib/code-mirror.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SL = require('../statusline.js');
const { readTee } = require('../lib/code-mirror.js');

const NOW = new Date('2026-11-09T19:00:00Z');
const TERM = '3f2b8c1e-5d4a-4b7e-9c10-2a6f8d9e0b11';
const CFG = { statusline: { segments: ['needs-you', 'runs', 'spend', 'health'], links: true, subagents: true, refreshSeconds: 5, codexItems: [] } };
const PAYLOAD = (extra = {}) => JSON.stringify({ session_id: 'sess-1', transcript_path: '/work/demo/t.jsonl', model: { display_name: 'Opus 5.5' }, workspace: { current_dir: '/work/demo' }, ...extra });

function machine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-tee-'));
  const claudeDir = path.join(root, 'claude');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  const userConfigFile = path.join(claudeDir, 'agenticos.json');
  const userCfg = { vault, claudeConfigDir: claudeDir };
  fs.writeFileSync(userConfigFile, JSON.stringify(userCfg));
  return { root, vault, claudeDir, userConfigFile, userCfg, teeDir: path.join(vault, 'brain', '_index', 'statusline') };
}

async function render(m, { terminal, payload = PAYLOAD() } = {}) {
  const out = [];
  const env = { CLAUDE_CONFIG_DIR: m.claudeDir, AOS_NO_SPAWN: '1', ...(terminal === undefined ? {} : { AOS_TERMINAL: terminal }) };
  const code = await SL.main(['render'], {
    stdout: (s) => out.push(s), stderr: () => {}, env, now: () => NOW, vault: m.vault, cfg: CFG,
    userConfigFile: m.userConfigFile, userCfg: m.userCfg, stdin: async () => payload, cwd: m.vault,
    spawnSyncFn: () => ({ status: 1, stdout: '' }), spawnFn: () => ({ on() {}, unref() {} }),
  });
  return { code, out: out.join('') };
}

test('tee: writes the printed status line, the session id and the time for a valid terminal', async () => {
  const m = machine();
  const r = await render(m, { terminal: TERM });
  assert.equal(r.code, 0);
  assert.match(r.out, /Opus 5\.5/);
  const tee = readTee(m.vault, TERM);
  assert.equal(tee.ansi, r.out);
  assert.equal(tee.session_id, 'sess-1');
  assert.equal(tee.transcript_path, '/work/demo/t.jsonl');
  assert.equal(tee.at, NOW.toISOString());
});

test('tee: a bad session id is recorded as null', async () => {
  const m = machine();
  await render(m, { terminal: TERM, payload: PAYLOAD({ session_id: '../x' }) });
  assert.equal(readTee(m.vault, TERM).session_id, null);
});

test('tee: no AOS_TERMINAL writes nothing', async () => {
  const m = machine();
  const r = await render(m);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(m.teeDir), false);
});

test('tee: a bad AOS_TERMINAL writes nothing and prints the same', async () => {
  const m = machine();
  const good = await render(m, { terminal: TERM });
  const bad = await render(m, { terminal: '../x' });
  assert.equal(bad.code, 0);
  assert.equal(bad.out, good.out);
  assert.deepEqual(fs.readdirSync(m.teeDir), [`${TERM}.json`]);
});

test('tee: an unwritable index changes neither the output nor the exit code', async () => {
  const m = machine();
  const good = await render(m);
  fs.writeFileSync(m.teeDir, 'a file where the directory should be');
  const r = await render(m, { terminal: TERM });
  assert.equal(r.code, 0);
  assert.equal(r.out, good.out);
});
