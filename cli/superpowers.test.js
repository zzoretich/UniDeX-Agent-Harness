'use strict';
delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./superpowers.js');

function fake(host, initial = null, failure = false) {
  const calls = [];
  let plugin = initial;
  const run = (_bin, args) => {
    calls.push(args);
    if (args[0] === 'plugin' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(host === 'claude' ? (plugin ? [plugin] : []) : { installed: plugin ? [plugin] : [] }), stderr: '' };
    if (failure) return { status: 1, stdout: '', stderr: 'catalog unavailable' };
    plugin = host === 'claude' ? { id: S.SELECTORS.claude, enabled: true, version: '7.0.1' } : { pluginId: S.SELECTORS.codex, installed: true, enabled: true, version: '7.0.1' };
    return { status: 0, stdout: JSON.stringify({ version: '7.0.1' }), stderr: '' };
  };
  return { calls, run };
}

for (const host of ['claude', 'codex']) {
  test(`${host}: installs missing official plugin and reports version`, () => {
    const f = fake(host);
    const result = S.ensure({ host, bin: host, mode: 'plugin', run: f.run });
    assert.equal(result.state, 'installed');
    assert.equal(result.version, '7.0.1');
    assert.deepEqual(f.calls[1].slice(0, 3), ['plugin', host === 'claude' ? 'install' : 'add', S.SELECTORS[host]]);
  });
  test(`${host}: preserves already installed and disabled plugin`, () => {
    for (const enabled of [true, false]) {
      const plugin = host === 'claude' ? { id: S.SELECTORS[host], enabled, version: '6.0.0' } : { pluginId: S.SELECTORS[host], installed: true, enabled, version: '6.0.0' };
      const f = fake(host, plugin);
      const result = S.ensure({ host, bin: host, mode: 'plugin', run: f.run });
      assert.equal(result.state, enabled ? 'installed' : 'disabled');
      assert.equal(f.calls.length, 1);
    }
  });
  test(`${host}: failure is visible and recoverable`, () => {
    const f = fake(host, null, true);
    const result = S.ensure({ host, bin: host, mode: 'plugin', run: f.run });
    assert.equal(result.state, 'failed');
    assert.match(result.detail, /catalog unavailable/);
    assert.match(result.command, /superpowers@/);
  });
}
test('old Codex direct wiring is an explicit compatibility gap', () => {
  const f = fake('codex');
  const result = S.ensure({ host: 'codex', bin: 'codex', mode: 'direct', run: f.run });
  assert.equal(result.state, 'unsupported');
  assert.equal(f.calls.length, 0);
});


test('Codex remote catalog outage is unknown, not a missing plugin to overwrite', () => {
  const calls = [];
  const run = (_bin, args) => { calls.push(args); return { status: 0, stdout: '{"installed":[],"available":[]}', stderr: 'Warning: failed to list remote marketplace plugins' }; };
  const result = S.ensure({ host: 'codex', bin: 'codex', mode: 'plugin', run });
  assert.equal(result.state, 'unknown');
  assert.equal(calls.length, 1);
});
