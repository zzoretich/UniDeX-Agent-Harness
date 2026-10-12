'use strict';
// sdk/lib/brain.js parseFrontmatter reads a block-list `tags:` as well as an inline one, so isRetired sees a block-list
// status (brain-hub plan, PR 2 follow-ups; D5, D7).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter } = require('../sdk/lib/brain.js');
const { isRetired } = require('../sdk/lib/recall.js');

test('a block list under a key becomes an array, indented or not, quotes stripped', () => {
  const { frontmatter, body } = parseFrontmatter('---\ntype: memory\ntags:\n  - memory/projects\n  - "status/archived"\ncreated: 2026-09-01\n---\n\n# A title\n\nBody.\n');
  assert.deepEqual(frontmatter, { type: 'memory', tags: ['memory/projects', 'status/archived'], created: '2026-09-01' });
  assert.equal(body, '\n# A title\n\nBody.\n');
  const flush = parseFrontmatter('---\ntags:\n- memory/user\n- status/active\nupdated: 2026-10-01\n---\n').frontmatter;
  assert.deepEqual(flush, { tags: ['memory/user', 'status/active'], updated: '2026-10-01' });
});

test('an inline list, a scalar, an empty key and a nested map read as before', () => {
  const { frontmatter } = parseFrontmatter('---\ntags: [memory/feedback, status/active]\ndescription: one line\nempty:\nmetadata:\n  type: user\n  origin: host\nsource: wrap\n---\n');
  assert.deepEqual(frontmatter, { tags: ['memory/feedback', 'status/active'], description: 'one line', empty: '', metadata: '', source: 'wrap' });
});

test('a blank line inside a block list keeps it going; CRLF files read the same', () => {
  assert.deepEqual(parseFrontmatter('---\ntags:\n  - memory/reference\n\n  - status/superseded\n---\n').frontmatter.tags,
    ['memory/reference', 'status/superseded']);
  assert.deepEqual(parseFrontmatter('---\r\ntype: memory\r\ntags:\r\n  - memory/reference\r\n  - status/archived\r\n---\r\n').frontmatter.tags,
    ['memory/reference', 'status/archived']);
});

test('isRetired sees a block-list archived or superseded status, and not a live one', () => {
  const fm = (status) => parseFrontmatter(`---\ntype: memory\ntags:\n  - memory/projects\n  - ${status}\n---\n`).frontmatter;
  assert.equal(isRetired(fm('status/archived')), true);
  assert.equal(isRetired(fm('status/superseded')), true);
  assert.equal(isRetired(fm('status/active')), false);
  assert.equal(isRetired(parseFrontmatter('---\ntags:\n---\n').frontmatter), false);
});
