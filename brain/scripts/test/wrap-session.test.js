'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wraps-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
const SCRIPT = path.join(__dirname, '..', 'wrap-session.js');
const BRAIN_MD = path.join(TMP, 'brain', '_index', 'BRAIN.md');
const SESSION_MD = path.join(TMP, 'brain', '_index', 'SESSION.md');

// A BRAIN.md carrying the legacy heading: the old updateBrainActive() inserted
// "- [[../sessions/<date>]] — wrapped <date>" right under it on every /wrap.
const BRAIN_BEFORE = '# BRAIN\n\n## Last Session\n_none_\n\n## Session Log Index\n';

function runWrap() {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') },
  });
}

test('a wrap leaves BRAIN.md byte-identical — no sessions/ link, no Session Log Index edit', () => {
  fs.writeFileSync(BRAIN_MD, BRAIN_BEFORE);
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'),
    '# Memory Index\n\n## User\n\n## Feedback (how to work)\n\n## Project\n\n## Reference\n\n## Patterns\n');
  fs.writeFileSync(SESSION_MD, '# Current Session Working Memory\n\n## Things to Remember\n- nothing durable this time\n');
  const r = runWrap();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Wrap complete/);
  const after = fs.readFileSync(BRAIN_MD, 'utf8');
  assert.equal(after, BRAIN_BEFORE, 'BRAIN.md must be byte-identical after a wrap');
  assert.ok(!after.includes('sessions/'));
  assert.ok(!/## Session Log Index\n- /.test(after));
});

test('wrap-session.js source carries no updateBrainActive and no sessions/ path', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!src.includes('updateBrainActive'));
  assert.ok(!src.includes('sessions/'));
  assert.ok(!src.includes('Session Log Index'));
});

// The Brain hub's cache after /wrap promotes something (brain-hub plan, PR 2 follow-ups).
const HUB = path.join(TMP, 'brain', '_index', 'brain-hub.json');
const INDEX = '# Memory Index\n\n## User\n\n## Feedback (how to work)\n\n## Project\n\n## Reference\n\n## Patterns\n';

test('a wrap that promotes a memory leaves a fresh brain-hub.json; one that promotes nothing leaves none', () => {
  fs.rmSync(HUB, { recursive: true, force: true });
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'), INDEX);
  fs.writeFileSync(SESSION_MD, '# Current Session Working Memory\n\n## Things to Remember\n- nothing durable this time\n');
  assert.equal(runWrap().status, 0);
  assert.ok(!fs.existsSync(HUB), 'nothing promoted, no rebuild');

  fs.writeFileSync(SESSION_MD, '# Current Session Working Memory\n\n## Things to Remember\n- reference: The staging bucket keeps uploads for seven days #promote\n');
  const before = Date.now();
  const r = runWrap();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Wrap complete\. Promoted 1 item\(s\)\./);
  assert.equal(r.stderr, '');
  const hub = JSON.parse(fs.readFileSync(HUB, 'utf8'));
  assert.ok(Date.parse(hub.builtAt) >= before);
  const promoted = /→ (brain\/memory\/reference\/\S+\.md)/.exec(r.stdout)[1];
  assert.ok(hub.batches.some((b) => b.paths.includes(promoted)), 'the promoted memory waits in a Review batch');
});

test('a failing rebuild never fails the wrap: it is logged to stderr and the promotion stands', () => {
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'), INDEX);
  fs.rmSync(HUB, { recursive: true, force: true });
  fs.mkdirSync(path.join(HUB, 'in-the-way'), { recursive: true });
  fs.writeFileSync(SESSION_MD, '# Current Session Working Memory\n\n## Things to Remember\n- reference: The nightly export lands in the archive folder #promote\n');
  try {
    const r = runWrap();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Wrap complete\. Promoted 1 item\(s\)\./);
    assert.match(r.stderr, /^brain-hub rebuild failed: /m);
    assert.ok(fs.existsSync(path.join(TMP, /→ (brain\/memory\/reference\/\S+\.md)/.exec(r.stdout)[1])));
  } finally { fs.rmSync(HUB, { recursive: true, force: true }); }
  const { rebuildBrainHub } = require('../wrap-session.js');
  const seen = [];
  assert.equal(rebuildBrainHub((args) => seen.push(args)), true);
  assert.equal(seen[0].vault, require('../lib/paths.js').PATHS.VAULT);
  assert.equal(typeof seen[0].cfg, 'object');
});
