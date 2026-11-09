'use strict';
// lib/hud-host.js (spec 2026-10-05-workbench-app-design D11): the app's marker in the vault, and the agenticos://
// links the status line and the proposal pages build.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../lib/hud-host.js');

function vault(marker) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-host-'));
  if (marker !== undefined) {
    fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
    fs.writeFileSync(path.join(v, H.MARKER_REL), typeof marker === 'string' ? marker : JSON.stringify(marker));
  }
  return v;
}
const APP = { schema: 1, host: 'app', name: 'AgenticOS Workbench', version: '1.0.0', at: '2026-10-05T12:00:00.000Z' };

test('readMarker: the app\'s record, with exactly the five fields', () => {
  assert.equal(H.MARKER_REL, 'brain/_index/hud-host.json');
  assert.deepEqual(H.readMarker(vault({ ...APP, extra: 'ignored' })), APP);
  assert.deepEqual(H.readMarker(vault({ ...APP, version: '1.2.3-beta.1' })), { ...APP, version: '1.2.3-beta.1' });
  assert.deepEqual(H.readMarker(vault({ schema: 1, host: 'app', version: '1.0.0' })), { schema: 1, host: 'app', name: null, version: '1.0.0', at: null });
});

test('readMarker: computerSocket comes back when it is a string and is otherwise left out (agent-computer D26)', () => {
  assert.deepEqual(H.readMarker(vault({ ...APP, computerSocket: '/tmp/x/bridge.sock' })), { ...APP, computerSocket: '/tmp/x/bridge.sock' });
  for (const computerSocket of ['', 1, null, {}]) assert.deepEqual(H.readMarker(vault({ ...APP, computerSocket })), APP, String(computerSocket));
});

test('readMarker: computer "off" or "failed" comes back without a socket, and nothing else does (agent-computer D26)', () => {
  assert.deepEqual(H.readMarker(vault({ ...APP, computer: 'off' })), { ...APP, computer: 'off' });
  assert.deepEqual(H.readMarker(vault({ ...APP, computer: 'failed' })), { ...APP, computer: 'failed' });
  for (const computer of ['on', '', 1, true, null, {}]) assert.deepEqual(H.readMarker(vault({ ...APP, computer })), APP, String(computer));
  assert.deepEqual(H.readMarker(vault({ ...APP, computerSocket: '/tmp/x/bridge.sock', computer: 'off' })), { ...APP, computerSocket: '/tmp/x/bridge.sock' }, 'a socket wins');
});

test("readMarker: the app's pid when it is a positive integer; alive() believes a marker without one, or a pid that answers", () => {
  assert.deepEqual(H.readMarker(vault({ ...APP, pid: 4242 })), { ...APP, pid: 4242 });
  for (const pid of [0, -1, 1.5, '4242', null]) assert.deepEqual(H.readMarker(vault({ ...APP, pid })), APP, String(pid));
  const kill = (code) => () => { if (code) { const e = new Error(code); e.code = code; throw e; } };
  assert.equal(H.alive({ ...APP }, kill('ESRCH')), true, 'an older app wrote no pid');
  assert.equal(H.alive({ ...APP, pid: 4242 }, kill(null)), true);
  assert.equal(H.alive({ ...APP, pid: 4242 }, kill('ESRCH')), false, 'gone: a crash left the marker');
  assert.equal(H.alive({ ...APP, pid: 4242 }, kill('EPERM')), true, "another user's process is there");
  assert.equal(H.alive(null), true);
});

test('readMarker: null for no vault, no file, a torn file, another schema or host, or a version it cannot order', () => {
  assert.equal(H.readMarker(null), null);
  assert.equal(H.readMarker(vault()), null);
  assert.equal(H.readMarker(vault('{ torn')), null);
  assert.equal(H.readMarker(vault('null')), null);
  assert.equal(H.readMarker(vault({ ...APP, schema: 2 })), null);
  assert.equal(H.readMarker(vault({ ...APP, host: 'obsidian' })), null);
  for (const version of ['', '1.0', 'v1.0.0', 'latest', 1]) assert.equal(H.readMarker(vault({ ...APP, version })), null, String(version));
});

test('links: a Workbench tab and a vault file, each value encoded', () => {
  const l = H.links();
  assert.equal(l.tab('agent-teams'), 'agenticos://workbench?tab=agent-teams');
  assert.equal(l.tab('a&b=c'), 'agenticos://workbench?tab=a%26b%3Dc');
  assert.equal(l.file('persona/STATE.md'), 'agenticos://note?file=persona%2FSTATE.md');
  assert.equal(l.file('notes/a b#1.md'), 'agenticos://note?file=notes%2Fa%20b%231.md');
  // The app parses these with URL and URLSearchParams (app/src/main/protocol.ts): the values come back unchanged.
  const u = new URL(l.file('notes/a b#1.md'));
  assert.equal(u.protocol, 'agenticos:');
  assert.equal(u.hostname, 'note');
  assert.equal(u.searchParams.get('file'), 'notes/a b#1.md');
  assert.equal(new URL(l.tab('settings')).hostname, 'workbench');
});
