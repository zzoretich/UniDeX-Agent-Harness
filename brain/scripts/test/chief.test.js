'use strict';
// persona/chief.js — run-duty.sh's helper (local-first A4): one tab-separated line for the shell, exit 3 when no host can
// start the duty. The resolution itself is lib/headless.js resolveChief (test/headless.test.js has its matrix).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../persona/chief.js');

const HELPER = path.join(__dirname, '..', 'persona', 'chief.js');

async function call(argv, answer) {
  const out = []; const err = [];
  const code = await C.main(argv, { resolve: async () => answer, cfg: {}, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join(''), err: err.join('') };
}

test('a resolved host is one tab-separated line: host, binary, model, effort, Codex home, reason', async () => {
  const r = await call(['--resolve'], { host: 'codex', bin: '/x/codex', model: 'gpt-6-sol', effort: 'medium', home: '/c/home', reason: 'failover: claude signed out', skipped: [] });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'codex\t/x/codex\tgpt-6-sol\tmedium\t/c/home\tfailover: claude signed out\n');
  const blank = await call(['--resolve'], { host: 'codex', bin: '/x/codex', model: null, effort: 'low', home: null, reason: 'auto', skipped: [] });
  assert.equal(blank.out, 'codex\t/x/codex\t\tlow\t\tauto\n', 'no model means no -m: the user\'s own Codex default');
});

test('no host: exit 3 with the reason and each host\'s why; --json prints the whole answer; usage is exit 2', async () => {
  const waiting = { host: null, reason: 'waiting-for-host', skipped: [{ host: 'claude', why: 'signed out' }, { host: 'codex', why: 'CLI not found' }] };
  const r = await call(['--resolve'], waiting);
  assert.equal(r.code, C.EXIT_SKIP);
  assert.equal(r.out, 'waiting-for-host\tclaude: signed out; codex: CLI not found\n');
  assert.equal((await call(['--resolve'], { host: null, reason: 'waiting-for-host', skipped: [] })).out, 'waiting-for-host\tno host enabled\n');
  const j = await call(['--resolve', '--json'], waiting);
  assert.equal(j.code, 3);
  assert.deepEqual(JSON.parse(j.out), waiting);
  assert.equal((await call([], waiting)).code, 2);
  const boom = [];
  assert.equal(await C.main(['--resolve'], { resolve: async () => { throw new Error('no config'); }, err: (s) => boom.push(s) }), 1);
  assert.match(boom.join(''), /chief: no config/);
});

test('end to end: a vault with a signed-in claude resolves claude-opus-5-5; signed out with no other host it waits', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-chief-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  const claude = path.join(vault, 'fake-claude');
  fs.writeFileSync(claude, '#!/bin/sh\n[ "$1" = auth ] && { [ -n "${FAKE_SIGNED_OUT:-}" ] && echo \'{"loggedIn":false}\' || echo \'{"loggedIn":true}\'; exit 0; }\nexit 1\n', { mode: 0o755 });
  const env = { PATH: '/usr/bin:/bin', HOME: vault, AOS_VAULT: vault, AOS_CONFIG: path.join(vault, 'none.json'), PERSONA_CLAUDE_BIN: claude };
  const ok = spawnSync(process.execPath, [HELPER, '--resolve'], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `claude\t${claude}\tclaude-opus-5-5\tmedium\t\tauto\n`);
  const routine = spawnSync(process.execPath, [HELPER, '--resolve'], { encoding: 'utf8', env: { ...env, PERSONA_MODEL: 'sonnet', PERSONA_EFFORT: 'low' } });
  assert.equal(routine.stdout.split('\t').slice(2, 4).join(' '), 'sonnet low', 'a duty routine\'s own model and effort');
  const out = spawnSync(process.execPath, [HELPER, '--resolve'], { encoding: 'utf8', env: { ...env, FAKE_SIGNED_OUT: '1' } });
  assert.equal(out.status, 3);
  assert.equal(out.stdout, 'waiting-for-host\tclaude: signed out\n');
});
