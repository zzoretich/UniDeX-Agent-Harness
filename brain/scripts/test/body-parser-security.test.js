const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('body-parser drains trailing compressed bytes without crashing or disconnecting raw consumers', () => {
  const child = spawnSync(process.execPath, ['--max-old-space-size=128',
    path.join(__dirname, 'fixtures/body-parser-compressed.cjs')], {
    encoding: 'utf8', timeout: 8000, maxBuffer: 128 * 1024,
    env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test' },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `parser child signal: ${child.signal}`);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    decoded: { kind: 'dummy' }, rejectedStatus: 400,
    after: { after: 'alive' }, rawConsumerComplete: true,
  });
});
