const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// These are semantic installation-root contracts: workspace overrides alone are ignored by npm.
test('root and independently installed runtime enforce matching patched transitive floors', () => {
  const root = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(path.join(__dirname, '../brain/scripts/package.json'), 'utf8'));
  const required = { 'proxy-addr': [2, 0, 8] };
  assert.deepEqual(root.overrides, runtime.overrides, 'payload/CLI install root must enforce the root policy');
  for (const [name, floor] of Object.entries(required)) {
    const range = root.overrides?.[name];
    assert.equal(typeof range, 'string', `${name} must have an enforced floor in both roots`);
    assert.match(range, /^\^\d+\.\d+\.\d+$/, `${name} must remain on its approved compatible major`);
    const actual = range.slice(1).split('.').map(Number);
    assert.equal(actual[0], floor[0], `${name} approved major`);
    assert.ok(actual[1] > floor[1] || (actual[1] === floor[1] && actual[2] >= floor[2]), `${name} floor must be patched`);
  }
});
