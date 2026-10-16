'use strict';
// A test file run without the test environment (plain `node --test <file>`, or `node <file>`) once resolved the owner's
// real vault through ~/.claude/agenticos.json and wrote into it. lib/test-guard.js makes the resolvers throw first. Here
// a fake owner's home (its agenticos.json naming its vault) stands in for the real one, and nothing may land in it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../lib/test-guard.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ESCAPE = path.join(__dirname, 'fixtures', 'test-guard', 'escape.test.js');

/** A fake owner: HOME with ~/.claude/agenticos.json naming a vault, and an environment with no test setup at all. */
function owner() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-guard-home-')));
  const vault = path.join(home, 'AgenticOS');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'agenticos.json'), JSON.stringify({ vault }));
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir() };
  return { home, vault, env, escaped: path.join(vault, 'brain', 'memory', 'feedback', 'escaped.md') };
}

test('a test file run without the test environment throws before it touches the vault, under node --test and run directly', () => {
  for (const argv of [['--test', ESCAPE], [ESCAPE]]) {
    const o = owner();
    const r = spawnSync(process.execPath, argv, { cwd: ROOT, env: o.env, encoding: 'utf8' });
    assert.notEqual(r.status, 0, argv.join(' '));
    assert.match(r.stdout + r.stderr, /refusing to resolve the vault and agenticos\.json: this test runs without the test environment/, argv.join(' '));
    assert.match(r.stdout + r.stderr, /npm run test:one -- <file>/);
    assert.ok(!fs.existsSync(o.escaped), `${argv.join(' ')}: nothing written into the vault`);
    assert.deepEqual(fs.readdirSync(o.vault).sort(), ['brain'], 'the vault is as it was');
  }
});

test('with the test environment but no vault of its own, a test still never resolves the default agenticos.json', () => {
  const o = owner();
  const r = spawnSync(process.execPath, ['--require', path.join(ROOT, 'tools', 'test-env.js'), '--test', ESCAPE], { cwd: ROOT, env: o.env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /refusing to resolve the vault through the default agenticos\.json in a test/);
  assert.ok(!fs.existsSync(o.escaped));
});

test('npm run test:one runs it in a temp vault: the owner\'s is untouched', () => {
  const o = owner();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'test-one.js'), ESCAPE], { cwd: ROOT, env: o.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(o.escaped));
});

test('guardTestEnv: inert outside the test runner and with the test environment; throws under it without', () => {
  const run = { env: { NODE_TEST_CONTEXT: 'child-v8' }, argv: ['node', 'x.js'], execArgv: [] };
  assert.throws(() => G.guardTestEnv('the vault', run), (e) => e instanceof G.UnsafeTestEnv && /refusing to resolve the vault/.test(e.message));
  assert.doesNotThrow(() => G.guardTestEnv('the vault', { ...run, env: { NODE_TEST_CONTEXT: 'child-v8', AOS_TEST_ENV_CLEAN: '1' } }));
  assert.doesNotThrow(() => G.guardTestEnv('the vault', { env: {}, argv: ['node', '/opt/aos/cli/aos.js', 'doctor'], execArgv: [] }), 'production');
  assert.equal(G.underTestRunner({ env: {}, argv: ['node', 'x.test.js'], execArgv: [] }), true, 'a test file run directly');
  assert.equal(G.underTestRunner({ env: {}, argv: ['node', 'x.js'], execArgv: ['--test'] }), true);
  assert.equal(G.underTestRunner({ env: {}, argv: ['node', 'x.js'], execArgv: [] }), false);
});
