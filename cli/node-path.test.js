'use strict';
// cli/node-path.js (spec 2026-10-05-workbench-app-design D12): a Homebrew Cellar node is recorded as its stable opt link,
// and the app wizard's own Node (install-import B1) as its `current` link, only when that link resolves to the same binary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stableNode, isCellarPath } = require('./node-path.js');

/** A fake Homebrew prefix: Cellar/<formula>/<version>/bin/node, and opt/<formula> → ../Cellar/<formula>/<version>. */
function brew({ formula = 'node', version = '25.1.0', opt = version } = {}) {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-brew-')));
  for (const v of new Set([version, opt])) {
    const bin = path.join(prefix, 'Cellar', formula, v, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  }
  fs.mkdirSync(path.join(prefix, 'opt'), { recursive: true });
  fs.symlinkSync(path.join('..', 'Cellar', formula, opt), path.join(prefix, 'opt', formula));
  return { prefix, cellar: path.join(prefix, 'Cellar', formula, version, 'bin', 'node'), opt: path.join(prefix, 'opt', formula, 'bin', 'node') };
}

test('stableNode: a Cellar node becomes the opt link that resolves to it', () => {
  const b = brew();
  assert.equal(stableNode(b.cellar), b.opt);
  const versioned = brew({ formula: 'node@22', version: '22.20.0' });
  assert.equal(stableNode(versioned.cellar), versioned.opt, 'a versioned formula has its own opt link');
});

test('stableNode: keeps execPath when the opt link is missing or points at another version', () => {
  const moved = brew({ version: '25.1.0', opt: '25.2.0' });
  assert.equal(stableNode(moved.cellar), moved.cellar, 'opt follows a newer install: recording it would change the Node');
  const noOpt = brew();
  fs.unlinkSync(path.join(noOpt.prefix, 'opt', 'node'));
  assert.equal(stableNode(noOpt.cellar), noOpt.cellar);
});

/** The app wizard's Node: <home>/.local/share/unidex/node/v<version>/bin/node, and current → v<current>. */
function unidex({ version = 'v24.22.0', current = version } = {}) {
  const root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-unidex-'))), '.local', 'share', 'unidex', 'node');
  for (const v of new Set([version, current])) {
    fs.mkdirSync(path.join(root, v, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, v, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
  }
  fs.symlinkSync(current, path.join(root, 'current'));
  return { versioned: path.join(root, version, 'bin', 'node'), current: path.join(root, 'current', 'bin', 'node') };
}

test('stableNode: the app wizard\'s Node is recorded as its current link, which the app moves to a newer one', () => {
  const u = unidex();
  assert.equal(stableNode(u.versioned), u.current);
  assert.equal(stableNode(u.current), u.current, 'already the link');
  const moved = unidex({ version: 'v24.21.0', current: 'v24.22.0' });
  assert.equal(stableNode(moved.versioned), moved.versioned, 'current is another version: recording it would change the Node');
});

test('stableNode: any other path is returned unchanged, and a failing fs never throws', () => {
  for (const p of ['/usr/local/bin/node', path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'node'), '/opt/homebrew/opt/node/bin/node', '', undefined]) {
    assert.equal(stableNode(p), p);
  }
  const boom = { existsSync: () => true, realpathSync: () => { throw new Error('EACCES'); } };
  assert.equal(stableNode('/opt/homebrew/Cellar/node/25.1.0/bin/node', boom), '/opt/homebrew/Cellar/node/25.1.0/bin/node');
  const same = { existsSync: () => true, realpathSync: () => '/same' };
  assert.equal(stableNode('/opt/homebrew/Cellar/node/25.1.0/bin/node', same), '/opt/homebrew/opt/node/bin/node', 'the fs is injectable');
});

test('isCellarPath: only a versioned Cellar path', () => {
  assert.equal(isCellarPath('/opt/homebrew/Cellar/node/25.1.0/bin/node'), true);
  assert.equal(isCellarPath('/opt/homebrew/opt/node/bin/node'), false);
  assert.equal(isCellarPath(null), false);
});
