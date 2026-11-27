'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../lib/config-write.js');
const S = require('../lib/settings-schema.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfgw-'));

test('readStrict: missing → null; unparseable or not an object → refused, file untouched', () => {
  const d = tmp();
  assert.equal(W.readStrict(path.join(d, 'none.json')), null);
  const bad = path.join(d, 'bad.json');
  fs.writeFileSync(bad, '{"vault": ');
  assert.throws(() => W.readStrict(bad), (e) => e instanceof W.ConfigFileError && /not valid JSON.*nothing was written/.test(e.message));
  assert.equal(fs.readFileSync(bad, 'utf8'), '{"vault": ');
  fs.writeFileSync(bad, '[1,2]');
  assert.throws(() => W.readStrict(bad), /not a JSON object/);
});

test('writeAtomic: 2-space JSON, key order kept, one key per line, no tmp file left behind', () => {
  const d = tmp();
  const f = path.join(d, 'sub', 'agenticos.json');
  W.writeAtomic(f, { version: '1.0.0', vault: '/v', node: '/n', provider: 'auto', hosts: { claude: { enabled: true } } });
  const text = fs.readFileSync(f, 'utf8');
  assert.equal(text, `${JSON.stringify({ version: '1.0.0', vault: '/v', node: '/n', provider: 'auto', hosts: { claude: { enabled: true } } }, null, 2)}\n`);
  assert.match(text, /^ {2}"vault": "\/v",$/m, 'the launcher reads this line with sed');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['agenticos.json']);
});

test('setPath creates parents and refuses a parent that is not an object; unsetPath prunes emptied parents', () => {
  const o = { graph: { enabled: true } };
  W.setPath(o, 'graph.semantic.enabled', false);
  assert.deepEqual(o, { graph: { enabled: true, semantic: { enabled: false } } });
  assert.throws(() => W.setPath({ graph: 'x' }, 'graph.enabled', true), /graph is not an object/);
  assert.equal(W.unsetPath(o, 'graph.semantic.enabled'), true);
  assert.deepEqual(o, { graph: { enabled: true } }, 'the emptied semantic object is pruned');
  assert.equal(W.unsetPath(o, 'graph.semantic.enabled'), false);
  assert.equal(W.unsetPath(o, 'graph.enabled'), true);
  assert.deepEqual(o, {});
  const n = { codex: { model: null } };
  assert.equal(W.hasPath(n, 'codex.model'), true, 'a null value is present');
});

test('resolve: machine over vault over default, as loadConfig merges', () => {
  const e = S.entry('telemetry.enabled');
  assert.deepEqual(W.resolve(e, {}), { value: true, source: 'default' });
  assert.deepEqual(W.resolve(e, { vaultCfg: { telemetry: { enabled: false } } }), { value: false, source: 'vault' });
  assert.deepEqual(W.resolve(e, { vaultCfg: { telemetry: { enabled: false } }, userCfg: { telemetry: { enabled: true } } }), { value: true, source: 'machine' });
  assert.deepEqual(W.resolve(S.entry('codex.model'), { vaultCfg: { codex: { model: null } } }), { value: null, source: 'vault' });
});

test('resolve: a vaultOnly key ignores agenticos.json; an object key merges; a machine key is unset or machine', () => {
  assert.equal(W.resolve(S.entry('dailyNote.layout'), { userCfg: { dailyNote: { layout: 'x/{dd}.md' } } }).source, 'default');
  const r = W.resolve(S.entry('roster.orchestrators'), { vaultCfg: { roster: { orchestrators: { a: { nickname: 'A' } } } }, userCfg: { roster: { orchestrators: { b: {} } } } });
  assert.deepEqual(r, { value: { a: { nickname: 'A' }, b: {} }, source: 'machine' });
  assert.deepEqual(W.resolve(S.entry('hosts.codex.enabled'), {}), { value: null, source: 'unset' });
  assert.deepEqual(W.resolve(S.entry('vault'), { userCfg: { vault: '/v' } }), { value: '/v', source: 'machine' });
});

test('targetFile (D4): the file that holds the key, else the vault file; a vaultOnly key always the vault', () => {
  assert.equal(W.targetFile(S.entry('provider'), { userCfg: { provider: 'auto' } }), 'machine');
  assert.equal(W.targetFile(S.entry('provider'), { userCfg: {} }), 'vault');
  assert.equal(W.targetFile(S.entry('graph.semantic.enabled'), { userCfg: { graph: { enabled: true } } }), 'vault', 'a sibling in agenticos.json is not the key');
  assert.equal(W.targetFile(S.entry('dailyNote.layout'), { userCfg: { dailyNote: { layout: 'x' } } }), 'vault');
});

test('unknownKeys and invalidValues (D12): typos and bad values, while an object setting is free-form inside', () => {
  const cfg = {
    telemetry: { enabeld: false, enabled: 'yes' },
    roster: { orchestrators: { anything: { goes: 1 } } },
    hosts: { claude: { enabled: true }, codex: { enabled: false, weird: 1 } },
    legacy: 1,
  };
  assert.deepEqual(W.unknownKeys(cfg), ['telemetry.enabeld', 'hosts.codex.weird', 'legacy']);
  assert.deepEqual(W.invalidValues(cfg), [{ key: 'telemetry.enabled', message: 'telemetry.enabled must be true or false' }]);
  assert.deepEqual(W.unknownKeys(S.DEFAULTS), [], 'the shipped defaults are all known');
  assert.deepEqual(W.invalidValues(S.DEFAULTS), []);
});

test('D12: dropRetired removes sessions and ai.chat, keeps ai\'s other keys, and says what it removed', () => {
  assert.deepEqual(W.RETIRED_KEYS, ['sessions', 'ai.chat']);
  const o = { sessions: { perDayUsd: 25 }, ai: { chat: 'claude', ask: 'host' }, x: 1 };
  assert.deepEqual(W.dropRetired(o), ['sessions', 'ai.chat']);
  assert.deepEqual(o, { ai: { ask: 'host' }, x: 1 });
  assert.deepEqual(W.dropRetired(o), [], 'nothing left to drop');
  const only = { ai: { chat: 'local' } };
  assert.deepEqual(W.dropRetired(only), ['ai.chat']);
  assert.deepEqual(only, {}, 'an ai object left empty goes too');
});
