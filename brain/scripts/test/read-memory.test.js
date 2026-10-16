'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Its own vault under a temp root, named before paths.js resolves one, so the sibling sharing the vault's name prefix
// (`<vault>-Workbench`) sits in that temp root too, never beside a real vault.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-read-memory-')));
process.env.AOS_VAULT = path.join(ROOT, 'vault');
fs.mkdirSync(path.join(process.env.AOS_VAULT, 'brain', '_index'), { recursive: true });
const { PATHS } = require('../lib/paths.js');
const brain = require('../sdk/lib/brain.js');

test('readMemory reads inside the vault and refuses siblings, .., absolute paths elsewhere and symlinks out', () => {
  const vault = PATHS.VAULT;
  assert.equal(vault, path.join(ROOT, 'vault'), 'the temp vault this file made');
  fs.mkdirSync(path.join(vault, 'brain', 'memory', 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'memory', 'feedback', 'ok.md'), 'inside\n');
  fs.writeFileSync(path.join(vault, '..dotted.md'), 'still inside\n');
  const sibling = `${vault}-Workbench`;
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'secret.md'), 'sibling\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), 'outside\n');
  fs.symlinkSync(outside, path.join(vault, 'brain', 'link-out'));

  assert.equal(brain.readMemory('brain/memory/feedback/ok.md'), 'inside\n');
  assert.equal(brain.readMemory(path.join(vault, 'brain', 'memory', 'feedback', 'ok.md')), 'inside\n');
  assert.equal(brain.readMemory('..dotted.md'), 'still inside\n');
  assert.equal(brain.readMemory(path.join(sibling, 'secret.md')), null, 'a sibling sharing the vault name prefix');
  assert.equal(brain.readMemory(`../${path.basename(sibling)}/secret.md`), null);
  assert.equal(brain.readMemory(path.join(outside, 'secret.md')), null);
  assert.equal(brain.readMemory('brain/link-out/secret.md'), null, 'a symlink out of the vault');
  assert.equal(brain.readMemory(''), null);
  assert.equal(brain.readMemory('.'), null);
});
