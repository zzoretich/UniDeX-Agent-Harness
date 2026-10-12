'use strict';
// brain-hub.js prunes merge records older than 30 days on each writing build (brain-ai A2; lib/memory-merge.js
// pruneRecords): a young record stays, a dry run deletes nothing, and a record folder that is a link never costs the hub.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildBrainHub } = require('../brain-hub.js');
const { RECORD_DIR } = require('../lib/memory-merge.js');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const DAY = 86_400_000;
const put = (v, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), text);
};
const MEM = 'brain/memory/feedback/small-diffs.md';

function fixture() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'mmerge-hub-'));
  put(v, 'brain/_index/.keep', '');
  put(v, MEM, '---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-09-01\nreviewed: true\n---\n\n# Small diffs\n\nKeep diffs small.\n');
  put(v, 'MEMORY.md', `# Index\n\n## Feedback\n- [Small diffs](${MEM}) — keep diffs small\n`);
  return v;
}
function record(v, id, daysAgo) {
  put(v, `${RECORD_DIR}/${id}.json`, JSON.stringify({
    schema: 1, id, at: new Date(NOW - daysAgo * DAY).toISOString(), winner: MEM,
    before: { text: '', hash: '' }, after: { hash: '' }, sources: [], undoneAt: null,
  }));
}
const records = (v) => fs.readdirSync(path.join(v, RECORD_DIR)).sort();

test('a writing build prunes records older than 30 days and keeps the young ones; a dry run deletes nothing', () => {
  const v = fixture();
  record(v, '20260901-000000-aaaaaaaa', 41);
  record(v, '20261001-000000-bbbbbbbb', 11);
  put(v, `${RECORD_DIR}/README.md`, 'not a record\n');
  buildBrainHub({ vault: v, now: NOW, write: false });
  assert.deepEqual(records(v), ['20260901-000000-aaaaaaaa.json', '20261001-000000-bbbbbbbb.json', 'README.md']);
  const hub = buildBrainHub({ vault: v, now: NOW });
  assert.equal(hub.counts.memories, 1);
  assert.deepEqual(records(v), ['20261001-000000-bbbbbbbb.json', 'README.md']);
  assert.ok(fs.existsSync(path.join(v, 'brain/_index/brain-hub.json')));
});

test('a record folder that is a link is refused, its target untouched, and the hub is still written', (t) => {
  const v = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mmerge-hub-out-'));
  const id = '20200101-000000-cccccccc';
  fs.writeFileSync(path.join(outside, `${id}.json`), JSON.stringify({ schema: 1, id, at: '2020-01-01T00:00:00Z' }));
  fs.symlinkSync(outside, path.join(v, RECORD_DIR));
  const errors = t.mock.method(console, 'error', () => {});
  assert.doesNotThrow(() => buildBrainHub({ vault: v, now: NOW }));
  assert.ok(fs.existsSync(path.join(outside, `${id}.json`)));
  assert.ok(fs.existsSync(path.join(v, 'brain/_index/brain-hub.json')));
  assert.ok(errors.mock.calls.some((c) => /merge records/.test(c.arguments.join(' '))), 'the failure is logged, not thrown');
});
