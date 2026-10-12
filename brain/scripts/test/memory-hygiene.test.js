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
  // A title with brackets reads back (a [[wiki-link]] /wrap kept in a promoted title): only `](` ends the link text.
  assert.deepEqual(hyg.entryOf('- [link [[agenticos-workbench]] decisions](brain/memory/feedback/x.md) — d'),
    { title: 'link [[agenticos-workbench]] decisions', path: 'brain/memory/feedback/x.md', description: 'd' });
  assert.deepEqual(hyg.entryOf('- [a]b](brain/memory/reference/r.md) — d'), { title: 'a]b', path: 'brain/memory/reference/r.md', description: 'd' });
  assert.deepEqual(hyg.entryOf('- [Use [x]](brain/memory/reference/r.md)'), { title: 'Use [x]', path: 'brain/memory/reference/r.md', description: '' });
  // The bullet's own link is the first: a link inside the description never takes its place.
  assert.equal(hyg.entryOf('- [Plain](brain/memory/user/u.md) — see [x](brain/memory/user/v.md)').path, 'brain/memory/user/u.md');
  assert.equal(hyg.entryOf('- [A](brain/memory/user/a.md) - and [B](brain/memory/user/b.md) — d').path, 'brain/memory/user/a.md');
  // A CRLF line reads as its LF twin, description and all.
  assert.deepEqual(hyg.entryOf('- [T](brain/memory/reference/r.md) — d\r'), { title: 'T', path: 'brain/memory/reference/r.md', description: 'd' });
  // A typed ` - ` for the dash is still that memory's line, with no description to copy.
  assert.deepEqual(hyg.entryOf('- [T](brain/memory/reference/r.md) - typed'), { title: 'T', path: 'brain/memory/reference/r.md', description: '' });
  assert.equal(hyg.entryOf('- see [T](brain/memory/reference/r.md)'), null, 'text before the link: not an entry');
  assert.equal(hyg.entryOf('[T](brain/memory/reference/r.md) — no bullet'), null);
  assert.equal(hyg.headingOf('### Not ours'), null);
  assert.equal(hyg.readIndexLines(null).size, 0);
});

test('readIndexLines reads a CRLF MEMORY.md as its LF twin, keeping each line as written', () => {
  const raw = '# Memory Index\r\n\r\n## Reference\r\n- [A](brain/memory/reference/a.md) — aa\r\n- [B](brain/memory/reference/b.md) — bb\r\n';
  const lines = hyg.readIndexLines(raw);
  assert.deepEqual(lines.get('brain/memory/reference/a.md'), [{ heading: 'Reference', description: 'aa', line: '- [A](brain/memory/reference/a.md) — aa\r' }]);
  assert.equal(lines.get('brain/memory/reference/b.md')[0].description, 'bb');
});

test('linkedPaths: every memory path a bullet links, wherever on the line (memory-index.js linksTo)', () => {
  const raw = '## Notes\n- see also [T](brain/memory/reference/t.md) and [U](brain/memory/user/u.md)\nnot a bullet [V](brain/memory/user/v.md)\n- [W](brain/memory/user/w.md) — w';
  assert.deepEqual([...hyg.linkedPaths(raw)].sort(), ['brain/memory/reference/t.md', 'brain/memory/user/u.md', 'brain/memory/user/w.md']);
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
    row('brain/memory/reference/c.md', { kind: null, hasFrontmatter: false, description: null }),
    row('brain/memory/projects/d.md', { source: 'manual-wrap' }),
  ];
  const gone = row('brain/memory/reference/e.md', { live: false });
  const byPath = new Map([...live, gone].map((m) => [m.path, m]));
  const indexLines = hyg.readIndexLines([
    '## Feedback', '- [A](brain/memory/feedback/a.md) — from the index', '- [B](brain/memory/feedback/b.md) — b',
    '## Reference', '- [D](brain/memory/projects/d.md) — misfiled', '- [E](brain/memory/reference/e.md) — gone but there',
    '- [X](brain/memory/reference/x.md) — broken', '- [Draft](brain/memory/feedback/_drafts/z.md) — not a memory path',
  ].join('\n'));
  for (const m of [...live, gone]) m.title = m.slug.toUpperCase();
  const drafts = [{ slug: 'a', title: 'A' }, { slug: 'b', title: '  b ' }, { slug: 'e', title: 'E' }, { slug: 'new', title: 'NEW' }];
  const h = hyg.findHygiene({ live, byPath, indexLines, drafts });
  assert.deepEqual(h, {
    sources: { session: 1, '(none)': 1, 'auto-wrap': 1, 'manual-wrap': 1 },
    oldType: ['brain/memory/feedback/b.md'],
    noDescription: ['brain/memory/feedback/a.md'],
    unindexed: ['brain/memory/reference/c.md'],
    misfiled: ['brain/memory/projects/d.md'],
    brokenIndex: ['brain/memory/reference/x.md'],
    leftoverDrafts: ['a', 'b'],
  });
  // The findings the fixes act on, and only those: a line to a link or a file too big to read is not broken (the index
  // fix removes only a line with nothing at its path); a bullet linking a memory some other way is its line.
  const withExists = hyg.findHygiene({ live, byPath, indexLines, drafts, exists: (p) => p === 'brain/memory/reference/x.md' });
  assert.deepEqual(withExists.brokenIndex, []);
  const linked = hyg.findHygiene({ live, byPath, indexLines, drafts, linked: new Set(['brain/memory/reference/c.md']) });
  assert.deepEqual(linked.unindexed, []);
  assert.deepEqual(live.filter(hyg.legacySource).map((m) => m.path), ['brain/memory/feedback/a.md']);
  // No frontmatter (or a BOM before ---, which memory-ops splitFm does not read as one): the descriptions fix has no
  // block to write into, so the finding never lists it.
  const bare = row('brain/memory/reference/plain.md', { kind: null, hasFrontmatter: false, description: null });
  const bareLines = hyg.readIndexLines('## Reference\n- [Plain](brain/memory/reference/plain.md) — a described line');
  assert.deepEqual(hyg.findHygiene({ live: [bare], byPath: new Map([[bare.path, bare]]), indexLines: bareLines, drafts: [] }).noDescription, []);
  assert.deepEqual([hyg.LEGACY_SOURCES, hyg.CANON_SOURCE], [['session', 'in-session', 'wrap'], 'manual-wrap']);
});

test('leftoverDrafts: the slug and the title of a live feedback rule; a slug that only collides is a new rule', () => {
  // memory-writer slugify keeps six words: "…without asking when the release branch is frozen" gets the old rule's slug.
  const rule = row('brain/memory/feedback/never-push-to-main-without-asking.md', { title: 'Never push to main without asking' });
  const drafts = [
    { slug: 'never-push-to-main-without-asking', title: 'Never push to main without asking when the release branch is frozen for QA' },
  ];
  const h = hyg.findHygiene({ live: [rule], byPath: new Map([[rule.path, rule]]), indexLines: new Map(), drafts });
  assert.deepEqual(h.leftoverDrafts, [], 'an unreviewed draft is never a leftover');
  drafts[0].title = 'never push to  main without asking';
  assert.deepEqual(hyg.findHygiene({ live: [rule], byPath: new Map([[rule.path, rule]]), indexLines: new Map(), drafts }).leftoverDrafts,
    ['never-push-to-main-without-asking'], 'the same rule, case and spacing aside');
});
