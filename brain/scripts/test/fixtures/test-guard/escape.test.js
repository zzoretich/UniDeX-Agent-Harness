'use strict';
// A test that writes into PATHS.VAULT, as read-memory.test.js did: run on its own (test-guard.test.js spawns it with no
// test environment), it must never get as far as the write.
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

test('writes into the vault it resolves', () => {
  const { PATHS } = require('../../../lib/paths.js');
  fs.mkdirSync(path.join(PATHS.VAULT, 'brain', 'memory', 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(PATHS.VAULT, 'brain', 'memory', 'feedback', 'escaped.md'), 'written by a test\n');
});

test('reads the config dir it resolves', () => {
  require('../../../lib/host.js').claudeConfigDir();
});
