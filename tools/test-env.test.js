'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
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

test('scrub on a plain object makes no folder and sets no TMPDIR', () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('aos-testrun-')).length;
  const env = { PATH: '/bin' };
  scrub(env);
  assert.equal('TMPDIR' in env, false);
  assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('aos-testrun-')).length, before);
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

// The temp root: the top-level runner makes one folder for the run's fixtures and removes it at exit. Each child below
// gets a fresh base as its temp folder, so the real one is not part of any assertion.
const ROOT_NAME = /^aos-testrun-(\d+)-[A-Za-z0-9]{6}$/;
function freshBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tenv-base-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
function topEnv(base) {
  const env = { ...process.env, TMPDIR: base };
  delete env[MARKER];
  return env;
}
function run(code, env) {
  return spawnSync(process.execPath, ['--require', PRELOAD, '-e', code], { encoding: 'utf8', env });
}
const MAKE = "const fs = require('fs'), os = require('os'), path = require('path');" +
  "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-')); fs.writeFileSync(path.join(d, 'f'), 'x');";

test('as a preload: the top-level process gets a temp root of its own, and it is gone when the process ends', (t) => {
  const base = freshBase(t);
  const r = run(MAKE + "process.stdout.write(JSON.stringify({ tmp: os.tmpdir(), pid: process.pid }))", topEnv(base));
  assert.equal(r.status, 0, r.stderr);
  const { tmp, pid } = JSON.parse(r.stdout);
  assert.equal(path.dirname(tmp), base);
  const m = ROOT_NAME.exec(path.basename(tmp));
  assert.ok(m, tmp);
  assert.equal(m[1], String(pid));
  assert.deepEqual(fs.readdirSync(base), []);
});

test('as a preload: a child of a marked process keeps its parent\'s temp folder and removes nothing', (t) => {
  const base = freshBase(t);
  const r = run(MAKE + "process.stdout.write(os.tmpdir())", { ...process.env, TMPDIR: base, [MARKER]: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, base);
  const left = fs.readdirSync(base);
  assert.equal(left.length, 1);
  assert.ok(left[0].startsWith('x-'));
});

test('as a preload: a child\'s exit does not remove the run\'s root', (t) => {
  const base = freshBase(t);
  const code = "const { spawnSync } = require('child_process');" +
    "const c = spawnSync(process.execPath, ['--require', " + JSON.stringify(PRELOAD) + ", '-e', " + JSON.stringify(MAKE) + "], { env: process.env });" +
    "if (c.status !== 0) throw new Error(String(c.stderr));" +
    "require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'after'), 'x'); process.stdout.write('ok');";
  const r = run(code, topEnv(base));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ok');
  assert.deepEqual(fs.readdirSync(base), []);
});

test('as a preload: a root a killed run left is removed at the next start, a running one\'s stays', (t) => {
  const base = freshBase(t);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const mk = (name) => { fs.mkdirSync(path.join(base, name)); fs.writeFileSync(path.join(base, name, 'f'), 'x'); };
  mk('aos-testrun-' + dead + '-abcdef');
  mk('aos-testrun-' + process.pid + '-abcdef');
  mk('aos-testrun-notapid-abcdef');
  fs.writeFileSync(path.join(base, 'aos-testrun-' + dead + '-zzzzzz'), 'x');
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'x');
  fs.symlinkSync(target, path.join(base, 'aos-testrun-' + dead + '-linked'));
  const r = run("process.stdout.write('ok')", topEnv(base));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(base).sort(), [
    'aos-testrun-' + dead + '-linked', 'aos-testrun-' + dead + '-zzzzzz', 'aos-testrun-' + process.pid + '-abcdef',
    'aos-testrun-notapid-abcdef', 'target',
  ].sort());
  assert.ok(fs.existsSync(path.join(target, 'keep')));
});

test('as a preload: when the root cannot be made the run goes on with the temp folder as it was', (t) => {
  const base = freshBase(t);
  const missing = path.join(base, 'does-not-exist');
  const r = run("process.stdout.write(require('os').tmpdir())", topEnv(missing));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, missing);
  const lines = r.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /temp root could not be made/);
});
