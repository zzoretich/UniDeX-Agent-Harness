'use strict';
// lib/memory-hygiene.js (brain-hub D12, D20): the findings brain-hub.json lists and `aos memory fix` acts on, from rows.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const hyg = require('../lib/memory-hygiene.js');

const row = (path, o = {}) => {
  const [, type, slug] = /^brain\/memory\/([a-z]+)\/(.+)\.md$/.exec(path);
  return { path, type, slug, kind: 'memory', description: 'd', source: 'auto-wrap', live: true, hasFrontmatter: true, ...o };
};

test('readIndexLines reads each bullet with its heading, description and line; entryOf and headingOf agree', () => {
  const raw = '# Index\n- [Top](brain/memory/user/top.md) — before any heading\n## Feedback (how to work)\n- [A](brain/memory/feedback/a.md) — one: two\n- [A again](brain/memory/feedback/a.md)\nnot a bullet\n##  Projects  \n- [P](brain/memory/projects/p.md) — p';
  const lines = hyg.readIndexLines(raw);
  assert.deepEqual(lines.get('brain/memory/user/top.md'), [{ heading: '', description: 'before any heading', line: '- [Top](brain/memory/user/top.md) — before any heading' }]);
  assert.deepEqual(lines.get('brain/memory/feedback/a.md').map((e) => [e.heading, e.description]), [['Feedback (how to work)', 'one: two'], ['Feedback (how to work)', '']]);
  assert.equal(lines.get('brain/memory/projects/p.md')[0].heading, 'Projects');
  assert.deepEqual(hyg.entryOf('- [T](brain/memory/reference/r.md) — d'), { title: 'T', path: 'brain/memory/reference/r.md', description: 'd' });
  assert.equal(hyg.entryOf('- [a]b](brain/memory/reference/r.md) — d'), null, 'a bracket in the title never reads back');
  assert.equal(hyg.headingOf('### Not ours'), null);
  assert.equal(hyg.readIndexLines(null).size, 0);
});

test('ownHeading prefix-matches as the index writer does: Project matches Projects, Feedback its long form', () => {
  assert.ok(hyg.ownHeading('projects', 'Projects'));
  assert.ok(hyg.ownHeading('feedback', 'Feedback (how to work)'));
  assert.ok(!hyg.ownHeading('reference', 'Patterns'));
  assert.ok(!hyg.ownHeading('user', ''));
});

test('findHygiene: legacy sources counted, old type shape, copyable descriptions, index lines and leftover drafts', () => {
  const live = [
    row('brain/memory/feedback/a.md', { source: 'session', description: null }),
    row('brain/memory/feedback/b.md', { kind: 'feedback', source: null }),
    row('brain/memory/reference/c.md', { kind: null, hasFrontmatter: false }),
    row('brain/memory/projects/d.md', { source: 'manual-wrap' }),
  ];
  const gone = row('brain/memory/reference/e.md', { live: false });
  const byPath = new Map([...live, gone].map((m) => [m.path, m]));
  const indexLines = hyg.readIndexLines([
    '## Feedback', '- [A](brain/memory/feedback/a.md) — from the index', '- [B](brain/memory/feedback/b.md) — b',
    '## Reference', '- [D](brain/memory/projects/d.md) — misfiled', '- [E](brain/memory/reference/e.md) — gone but there',
    '- [X](brain/memory/reference/x.md) — broken', '- [Draft](brain/memory/feedback/_drafts/z.md) — not a memory path',
  ].join('\n'));
  const h = hyg.findHygiene({ live, byPath, indexLines, drafts: [{ slug: 'a' }, { slug: 'b' }, { slug: 'e' }, { slug: 'new' }] });
  assert.deepEqual(h, {
    sources: { session: 1, '(none)': 1, 'auto-wrap': 1, 'manual-wrap': 1 },
    oldType: ['brain/memory/feedback/b.md'],
    noDescription: ['brain/memory/feedback/a.md'],
    unindexed: ['brain/memory/reference/c.md'],
    misfiled: ['brain/memory/projects/d.md'],
    brokenIndex: ['brain/memory/reference/x.md'],
    leftoverDrafts: ['a', 'b'],
  });
  assert.deepEqual(live.filter(hyg.legacySource).map((m) => m.path), ['brain/memory/feedback/a.md']);
  assert.deepEqual([hyg.LEGACY_SOURCES, hyg.CANON_SOURCE], [['session', 'in-session', 'wrap'], 'manual-wrap']);
});
