'use strict';
// sdk/ask.js's keyword fallback (buildContextLegacy) leaves out archived and superseded notes, as recall does
// (brain-hub plan, PR 2 follow-ups; D5, D7).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-ctx-'));
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
  fs.writeFileSync(path.join(TMP, rel), text);
};
put('brain/config.json', JSON.stringify({ provider: 'none' }));
put('MEMORY.md', '# Index\n');
put('brain/memory/projects/heron-live.md', '---\ntype: memory\ntags: [memory/projects, status/active]\n---\n\n# Heron migration\n\nThe heron migration runs in three waves.\n');
put('brain/memory/projects/heron-pilot.md', '---\ntype: memory\ntags: [memory/projects, status/archived]\narchived: 2026-10-01\n---\n\n# Heron pilot\n\nThe heron migration pilot, archived.\n');
put('brain/memory/reference/heron-notes.md', '---\ntype: memory\ntags:\n  - memory/reference\n  - status/superseded\nsuperseded_by: brain/memory/projects/heron-live.md\n---\n\n# Heron notes\n\nOld heron migration notes.\n');
put('brain/patterns/heron-pattern.md', '---\ntype: pattern\ntags:\n  - pattern\n  - status/archived\n---\n\n# Heron pattern\n\nA retired heron migration pattern.\n');
put('brain/patterns/wave-pattern.md', '---\ntype: pattern\n---\n\n# Wave pattern\n\nShip a migration in waves, heron style.\n');
process.env.BRAIN_VAULT = TMP;
const { buildContextLegacy } = require('../sdk/ask.js');

test('buildContextLegacy inlines live memories and patterns only', () => {
  const ctx = buildContextLegacy('heron migration');
  const paths = [...ctx.matchAll(/^### (\S+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(paths, ['brain/memory/projects/heron-live.md', 'brain/patterns/wave-pattern.md']);
  assert.ok(!ctx.includes('archived'), 'no archived text reaches the prompt');
  assert.ok(!ctx.includes('Old heron migration notes'), 'no superseded text reaches the prompt');
});
