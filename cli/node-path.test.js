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

test('stableNode: a versioned Node that is gone becomes its link while the link is there (the upgrade already ran)', () => {
  const b = brew({ version: '25.1.0', opt: '25.2.0' });
  fs.rmSync(path.join(b.prefix, 'Cellar', 'node', '25.1.0'), { recursive: true });
  assert.equal(stableNode(b.cellar), b.opt, 'brew upgrade deleted 25.1.0; opt runs 25.2.0, the one Node left');
  const gone = brew();
  fs.rmSync(path.join(gone.prefix, 'Cellar'), { recursive: true });
  assert.equal(stableNode(gone.cellar), gone.cellar, 'nothing behind the link either: unchanged');
  const u = unidex({ version: 'v24.21.0', current: 'v24.22.0' });
  fs.rmSync(path.dirname(path.dirname(u.versioned)), { recursive: true });
  assert.equal(stableNode(u.versioned), u.current, 'the app moved current on and removed the old Node');
});

// The duty files hold the path inside backticks, a Bash(...) allowlist entry, quotes, after `=`, before a full stop, or
// bare; a text regex must find each of those and nothing that only looks like one.
test('cellarPathsIn / replaceCellarPaths: every versioned Cellar node in a text, as a duty file holds it, and nothing else', () => {
  const { cellarPathsIn, replaceCellarPaths, CELLAR_RE } = require('./node-path.js');
  const stable = '/opt/homebrew/opt/node/bin/node';
  const a = '/opt/homebrew/Cellar/node/25.1.0/bin/node';
  const b = '/usr/local/Cellar/node@22/22.20.0/bin/node';
  const c = '/home/linuxbrew/.linuxbrew/Cellar/node/24.9.0/bin/node';
  const cases = [
    [`1. Run \`${a} <vault>/brain/scripts/persona/tick.js signals\` — keep the JSON.`, `1. Run \`${stable} <vault>/brain/scripts/persona/tick.js signals\` — keep the JSON.`],
    [`tools: "Read,Bash(${b} <vault>/brain/scripts/persona/ledger.js:*),Bash(node x:*)"`, `tools: "Read,Bash(${stable} <vault>/brain/scripts/persona/ledger.js:*),Bash(node x:*)"`],
    [c, stable], [`AOS_NODE=${a}`, `AOS_NODE=${stable}`], [`see ${a}.`, `see ${stable}.`], [`"${a}" '${a}'`, `"${stable}" '${stable}'`],
    [`${a} ${a}`, `${stable} ${stable}`],
    // left alone: the stable link, a file beside the node, a longer name, a path glued to a word, a relative one
    [stable, stable], [a.replace(/bin\/node$/, 'README.md'), a.replace(/bin\/node$/, 'README.md')],
    [`${a}.js ${a}-gyp ${a}/x`, `${a}.js ${a}-gyp ${a}/x`], [`x${a}`, `x${a}`], ['Cellar/node/25.1.0/bin/node', 'Cellar/node/25.1.0/bin/node'],
  ];
  for (const [input, expected] of cases) assert.equal(replaceCellarPaths(input, stable), expected, input);
  const text = cases.map((k) => k[0]).join('\n');
  assert.deepEqual(cellarPathsIn(text), [a, b, c], 'distinct, in order of first appearance');
  for (const p of cellarPathsIn(text)) assert.match(p, CELLAR_RE, `${p}: a path CELLAR_RE accepts whole`);
  assert.equal(replaceCellarPaths(text, stable), cases.map((k) => k[1]).join('\n'));
  assert.equal(replaceCellarPaths('nothing here', stable), 'nothing here');
  assert.equal(replaceCellarPaths(a, '$& $1'), '$& $1', 'the replacement is literal');
  assert.deepEqual(cellarPathsIn(''), []);
});
