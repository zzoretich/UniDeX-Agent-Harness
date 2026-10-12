'use strict';
// lib/memory-fix.js (`aos memory fix <kind>`, brain-hub D20, plan PR 3 Mechanics): per kind, a dry run leaves the vault
// byte for byte and logs nothing, the real run changes exactly what the dry run listed and logs each field's before and
// after, a second run has nothing to do, archived and superseded memories and links are never touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fix, KINDS, changesHash } = require('../lib/memory-fix.js');
const ops = require('../lib/memory-ops.js');
const { buildBrainHub } = require('../brain-hub.js');

const put = (v, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), text);
};
const read = (v, rel) => fs.readFileSync(path.join(v, rel), 'utf8');
const P = (type, slug) => `brain/memory/${type}/${slug}.md`;
const TRAIL = 'brain/_index/promote-log.jsonl';
const LONG = `${'A long index line that keeps going '.repeat(8)}past two hundred characters.`;

function mem({ type, title, source = 'auto-wrap', status = 'active', description = `about ${title}`, extra = '', eol = '\n' }) {
  const lines = ['---', 'type: memory', `tags: [memory/${type}, status/${status}]`, 'created: 2026-10-01', 'updated: 2026-10-01',
    ...(source ? [`source: ${source}`] : []), 'session: s1', 'reviewed: true', ...(description ? [`description: ${description}`] : []),
    ...(extra ? [extra] : []), '---', '', `# ${title}`, '', `The body of ${title}.`, ''];
  return lines.join(eol);
}

const FILES = {
  // sources
  [P('feedback', 'legacy-label')]: mem({ type: 'feedback', title: 'Legacy label', source: 'session' }),
  [P('feedback', 'in-session-label')]: mem({ type: 'feedback', title: 'In-session label', source: 'in-session', eol: '\r\n' }),
  [P('projects', 'wrap-label')]: mem({ type: 'projects', title: 'Wrap label', source: 'wrap' }),
  [P('reference', 'auto-label')]: mem({ type: 'reference', title: 'Auto label' }),
  // types: a host's auto-memory shape, an old type value, block tags, the singular project tag
  [P('user', 'old-shape')]: '---\nname: old-shape\ndescription: a host auto-memory\nmetadata:\n  type: user\n---\n\n# Old shape\n\nBody.\n',
  [P('feedback', 'old-type-value')]: '---\ntype: feedback\ntags: [feedback/tooling]\ndescription: the old type value\n---\n\n# Old type value\n\nBody.\n',
  [P('reference', 'old-block-tags')]: '---\ntype: reference\ntags:\n  - reference/tooling\n  - status/active\ndescription: block tags\n---\n\n# Old block tags\n\nBody.\n',
  [P('projects', 'old-singular')]: '---\ntype: project\ntags: [memory/project, status/active]\ndescription: singular tag\n---\n\n# Old singular\n\nBody.\n',
  // descriptions
  [P('feedback', 'no-desc')]: mem({ type: 'feedback', title: 'No desc', description: '' }),
  [P('feedback', 'long-desc')]: mem({ type: 'feedback', title: 'Long desc', description: '' }),
  // index: two missing lines (one with a bracketed title and no description), one misfiled
  [P('projects', 'not-indexed')]: mem({ type: 'projects', title: 'Not indexed' }),
  [P('reference', 'bracket-title')]: mem({ type: 'reference', title: 'Use [x] wisely', description: '' }),
  [P('reference', 'tide-tables')]: mem({ type: 'reference', title: 'Tide tables' }),
  // never touched: archived and superseded, whatever they carry
  [P('reference', 'gone')]: '---\ntype: reference\ntags: [memory/reference, status/archived]\nsource: session\n---\n\n# Gone\n\nBody.\n',
  [P('feedback', 'replaced')]: mem({ type: 'feedback', title: 'Replaced', source: 'wrap', status: 'superseded', description: '', extra: `superseded_by: ${P('feedback', 'legacy-label')}` }),
  // drafts: one left behind by an approved memory, one whose memory is superseded, one with no memory
  // (approved: the same title as the live rule; a draft that only shares a slug is a new rule nobody reviewed yet)
  'brain/memory/feedback/_drafts/legacy-label.md': '---\ntags: [memory/feedback, status/draft]\nsession: s9\n---\n\n# Legacy label\n\nbody\n',
  'brain/memory/feedback/_drafts/in-session-label.md': '---\ntags: [memory/feedback, status/draft]\n---\n\n# In-session label, and when the branch is frozen\n\nbody\n',
  'brain/memory/feedback/_drafts/replaced.md': '---\ntags: [memory/feedback, status/draft]\n---\n\n# Replaced draft\n\nbody\n',
  'brain/memory/feedback/_drafts/brand-new.md': '---\ntags: [memory/feedback, status/draft]\n---\n\n# Brand new\n\nbody\n',
  'MEMORY.md': [
    '# Memory Index', '', '## Feedback',
    `- [Legacy label](${P('feedback', 'legacy-label')}) — a legacy label`,
    `- [In-session label](${P('feedback', 'in-session-label')}) — an in-session label`,
    `- [Old type value](${P('feedback', 'old-type-value')}) — the old type value`,
    `- [No desc](${P('feedback', 'no-desc')}) — ask the graph first: always`,
    `- [Long desc](${P('feedback', 'long-desc')}) — ${LONG}`,
    '', '## Reference',
    `- [Auto label](${P('reference', 'auto-label')}) — auto-wrap stays`,
    `- [Old block tags](${P('reference', 'old-block-tags')}) — block tags`,
    `- [Gone line](${P('reference', 'no-such-file')}) — a broken line`,
    '', '## Projects',
    `- [Wrap label](${P('projects', 'wrap-label')}) — a wrap label`,
    `- [Old singular](${P('projects', 'old-singular')}) — singular tag`,
    '', '## User',
    `- [Old shape](${P('user', 'old-shape')}) — a host auto-memory`,
    '', '## Patterns',
    `- [Tide tables](${P('reference', 'tide-tables')}) — under the wrong heading`,
    '',
  ].join('\n'),
};

function fixture(prefix = 'mfix-') {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  put(v, 'brain/_index/.keep', '');
  for (const [rel, text] of Object.entries(FILES)) put(v, rel, text);
  return v;
}

/** Every file under the vault: rel → text (links as `-> target`). */
function snapshot(v) {
  const out = new Map();
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(v, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.set(r, `-> ${fs.readlinkSync(path.join(v, r))}`);
      else if (e.isDirectory()) walk(r);
      else out.set(r, fs.readFileSync(path.join(v, r), 'utf8'));
    }
  };
  walk('');
  return out;
}
/** The files that differ between two snapshots (changed, added or removed), the trail aside. */
function diff(a, b) {
  const out = new Set();
  for (const k of new Set([...a.keys(), ...b.keys()])) if (k !== TRAIL && a.get(k) !== b.get(k)) out.add(k);
  return [...out].sort();
}
const fixed = (v) => (fs.existsSync(path.join(v, TRAIL)) ? read(v, TRAIL).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.action === 'fixed') : []);

/** A dry run writes nothing; the real run changes exactly those files, with the same changes; then nothing is left. */
function roundTrip(kind, prefix) {
  const v = fixture(prefix);
  const before = snapshot(v);
  const dry = fix(v, kind, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(diff(before, snapshot(v)), [], `${kind}: a dry run writes nothing`);
  assert.equal(fs.existsSync(path.join(v, TRAIL)), false, `${kind}: a dry run logs no trail row`);
  const real = fix(v, kind);
  assert.equal(real.dryRun, false);
  assert.deepEqual(real.changes, dry.changes, `${kind}: the real run makes the dry run's changes`);
  assert.equal(real.expect, dry.expect, `${kind}: the same changes, the same hash`);
  assert.equal(real.files, dry.files);
  const files = kind === 'index' ? (dry.changes.length ? ['MEMORY.md'] : []) : [...new Set(dry.changes.map((c) => c.path))].sort();
  assert.deepEqual(diff(before, snapshot(v)), files, `${kind}: only the files it named changed`);
  assert.equal(real.files, files.length);
  const again = snapshot(v);
  assert.deepEqual(fix(v, kind).changes, [], `${kind}: a second run has nothing to do`);
  assert.deepEqual(fix(v, kind, { dryRun: true }), { kind, dryRun: true, changes: [], files: 0, expect: changesHash([]) });
  assert.deepEqual(diff(again, snapshot(v)), []);
  // Archived and superseded memories never change, whatever they carry.
  assert.equal(read(v, P('reference', 'gone')), FILES[P('reference', 'gone')]);
  assert.equal(read(v, P('feedback', 'replaced')), FILES[P('feedback', 'replaced')]);
  return { v, dry, real };
}

test('the five kinds, in the order the page lists them', () => {
  assert.deepEqual(KINDS, ['sources', 'types', 'descriptions', 'index', 'drafts']);
  assert.throws(() => fix(fixture(), 'everything'), { code: 'BAD_KIND' });
});

test('sources: session, in-session and wrap become manual-wrap; auto-wrap stays; CRLF kept', () => {
  const { v, dry } = roundTrip('sources', 'mfix-src-');
  assert.deepEqual(dry.changes, [
    { path: P('feedback', 'in-session-label'), action: 'source', before: 'in-session', after: 'manual-wrap' },
    { path: P('feedback', 'legacy-label'), action: 'source', before: 'session', after: 'manual-wrap' },
    { path: P('projects', 'wrap-label'), action: 'source', before: 'wrap', after: 'manual-wrap' },
  ]);
  assert.equal(read(v, P('feedback', 'legacy-label')), FILES[P('feedback', 'legacy-label')].replace('source: session', 'source: manual-wrap'));
  assert.equal(read(v, P('feedback', 'in-session-label')), FILES[P('feedback', 'in-session-label')].replace('source: in-session\r\n', 'source: manual-wrap\r\n'));
  assert.match(read(v, P('reference', 'auto-label')), /^source: auto-wrap$/m);
  const rows = fixed(v);
  assert.equal(rows.length, 3, 'one row per changed memory');
  const row = rows.find((r) => r.path === P('feedback', 'legacy-label'));
  assert.deepEqual({ ...row, ts: 'T' }, {
    ts: 'T', session: 's1', action: 'fixed', slug: 'legacy-label', type: 'feedback', title: 'Legacy label', path: P('feedback', 'legacy-label'),
    kind: 'sources', changes: [{ field: 'source', before: 'session', after: 'manual-wrap' }],
  });
});

test('types: type: memory replaced or first, and the tags it lacks; name, description and metadata stay', () => {
  const { v, dry } = roundTrip('types', 'mfix-types-');
  assert.deepEqual(dry.changes, [
    { path: P('user', 'old-shape'), action: 'type', before: null, after: 'memory' },
    // No status is invented: status/active would put an old project into BRAIN.md's Active context unasked.
    { path: P('user', 'old-shape'), action: 'tags', before: null, after: '[memory/user]' },
    { path: P('feedback', 'old-type-value'), action: 'type', before: 'feedback', after: 'memory' },
    { path: P('feedback', 'old-type-value'), action: 'tags', before: '[feedback/tooling]', after: '[feedback/tooling, memory/feedback]' },
    { path: P('projects', 'old-singular'), action: 'type', before: 'project', after: 'memory' },
    { path: P('reference', 'old-block-tags'), action: 'type', before: 'reference', after: 'memory' },
    { path: P('reference', 'old-block-tags'), action: 'tags', before: '[reference/tooling, status/active]', after: '[reference/tooling, status/active, memory/reference]' },
  ]);
  assert.equal(read(v, P('user', 'old-shape')),
    '---\ntype: memory\ntags: [memory/user]\nname: old-shape\ndescription: a host auto-memory\nmetadata:\n  type: user\n---\n\n# Old shape\n\nBody.\n');
  assert.equal(read(v, P('feedback', 'old-type-value')),
    '---\ntype: memory\ntags: [feedback/tooling, memory/feedback]\ndescription: the old type value\n---\n\n# Old type value\n\nBody.\n');
  assert.equal(read(v, P('reference', 'old-block-tags')),
    '---\ntype: memory\ntags:\n  - reference/tooling\n  - status/active\n  - memory/reference\ndescription: block tags\n---\n\n# Old block tags\n\nBody.\n');
  assert.equal(read(v, P('projects', 'old-singular')), FILES[P('projects', 'old-singular')].replace('type: project\n', 'type: memory\n'));
  const row = fixed(v).find((r) => r.path === P('feedback', 'old-type-value'));
  assert.equal(row.kind, 'types');
  assert.deepEqual(row.changes, [
    { field: 'type', before: 'feedback', after: 'memory' },
    { field: 'tags', before: '[feedback/tooling]', after: '[feedback/tooling, memory/feedback]' },
  ]);
  assert.deepEqual(buildBrainHub({ vault: v, cfg: {}, write: false }).hygiene.oldType, [], 'the hub finds nothing left');
});

test('descriptions: the MEMORY.md line\'s, one line and at most 200 characters', () => {
  const { v, dry } = roundTrip('descriptions', 'mfix-desc-');
  const clipped = LONG.slice(0, 200).trimEnd();
  assert.deepEqual(dry.changes, [
    { path: P('feedback', 'long-desc'), action: 'description', before: null, after: clipped },
    { path: P('feedback', 'no-desc'), action: 'description', before: null, after: 'ask the graph first: always' },
  ]);
  // `: ` inside would not be strict YAML plain: quoted on disk (memory-ops yamlValue), the text itself to every reader.
  assert.match(read(v, P('feedback', 'no-desc')), /^description: "ask the graph first: always"\n---\n/m);
  assert.equal(ops.describe(ops.readMemory(v, P('feedback', 'no-desc'))).description, 'ask the graph first: always');
  assert.equal(ops.describe(ops.readMemory(v, P('feedback', 'long-desc'))).description, clipped);
  assert.equal(fixed(v).length, 2);
  // A memory with no index line has nothing to copy: it is the index fix's to add.
  assert.doesNotMatch(read(v, P('reference', 'bracket-title')), /^description:/m);
});

test('index: a broken line out, a misfiled one moved with its text, missing ones added under their headings', () => {
  const { v, dry } = roundTrip('index', 'mfix-index-');
  const notIndexed = `- [Not indexed](${P('projects', 'not-indexed')}) — about Not indexed`;
  // The title as /wrap writes it: brackets read back (memory-hygiene entryOf), so they stay.
  const bracket = `- [Use [x] wisely](${P('reference', 'bracket-title')}) — The body of Use [x] wisely.`;
  const broken = `- [Gone line](${P('reference', 'no-such-file')}) — a broken line`;
  const tide = `- [Tide tables](${P('reference', 'tide-tables')}) — under the wrong heading`;
  assert.deepEqual(dry.changes, [
    { path: 'MEMORY.md', action: 'index-remove', before: broken, after: null, reason: 'missing' },
    { path: P('reference', 'tide-tables'), action: 'index-move', before: 'Patterns', after: 'Reference' },
    { path: P('projects', 'not-indexed'), action: 'index-add', before: null, after: notIndexed },
    { path: P('reference', 'bracket-title'), action: 'index-add', before: null, after: bracket },
  ]);
  assert.equal(dry.files, 1, 'MEMORY.md counts once');
  const idx = read(v, 'MEMORY.md');
  assert.ok(idx.includes(`## Reference\n- [Auto label](${P('reference', 'auto-label')}) — auto-wrap stays\n- [Old block tags](${P('reference', 'old-block-tags')}) — block tags\n${tide}\n${bracket}\n\n## Projects\n`), idx);
  assert.ok(idx.includes(`- [Old singular](${P('projects', 'old-singular')}) — singular tag\n${notIndexed}\n\n## User`), idx);
  assert.ok(idx.endsWith('## Patterns\n'));
  assert.ok(!idx.includes('no-such-file'));
  const rows = fixed(v);
  assert.deepEqual(rows.map((r) => [r.path, r.slug, r.kind]), [
    [P('reference', 'tide-tables'), 'tide-tables', 'index'],
    [P('projects', 'not-indexed'), 'not-indexed', 'index'],
    [P('reference', 'bracket-title'), 'bracket-title', 'index'],
    ['MEMORY.md', undefined, 'index'],
  ]);
  assert.deepEqual(rows[0].changes, [{ field: 'index-move', before: 'Patterns', after: 'Reference' }]);
  assert.deepEqual(rows[3].changes, [{ field: 'index-remove', before: broken, after: null, reason: 'missing' }]);
  assert.equal(rows[3].type, 'reference');
  assert.equal(rows[3].title, 'Gone line');
  const h = buildBrainHub({ vault: v, cfg: {}, write: false }).hygiene;
  assert.deepEqual([h.unindexed, h.misfiled, h.brokenIndex], [[], [], []], 'the hub finds nothing left');
});

test('index: a misfiled copy beside one under its own heading goes, shown as removed; a missing MEMORY.md is created', () => {
  const v = fixture('mfix-index-dup-');
  const own = `- [Legacy label](${P('feedback', 'legacy-label')}) — a legacy label`;
  const copy = `- [Legacy label copy](${P('feedback', 'legacy-label')}) — the copy`;
  put(v, 'MEMORY.md', `${read(v, 'MEMORY.md')}\n## Projects again\n${copy}\n`);
  const dryDup = fix(v, 'index', { dryRun: true });
  const r = fix(v, 'index', { expect: dryDup.expect });
  // The preview names the line that goes, with its text: nothing is deleted unseen (fixes are not undoable).
  assert.ok(r.changes.some((c) => c.path === 'MEMORY.md' && c.action === 'index-remove' && c.before === copy && c.reason === 'duplicate'));
  assert.ok(!r.changes.some((c) => c.path === P('feedback', 'legacy-label') && c.action === 'index-move'));
  const idx = read(v, 'MEMORY.md');
  assert.equal(idx.split('\n').filter((l) => l.includes(`(${P('feedback', 'legacy-label')})`)).join('\n'), own, 'one line left, the one under its heading');

  // An archived memory's line under another heading goes instead of moving (D5: a retired memory has no line); its
  // file is not touched, and the hub then lists nothing the fix leaves.
  const retired = fixture('mfix-index-retired-');
  const goneLine = `- [Gone](${P('reference', 'gone')}) — archived, left behind`;
  put(retired, 'MEMORY.md', `${read(retired, 'MEMORY.md')}${goneLine}\n`);
  const rr = fix(retired, 'index');
  assert.ok(rr.changes.some((c) => c.path === 'MEMORY.md' && c.action === 'index-remove' && c.before === goneLine && c.reason === 'retired'));
  assert.ok(!read(retired, 'MEMORY.md').includes(P('reference', 'gone')));
  assert.equal(read(retired, P('reference', 'gone')), FILES[P('reference', 'gone')]);
  const goneRow = fixed(retired).find((r) => r.path === 'MEMORY.md' && r.title === 'Gone');
  assert.deepEqual([goneRow.slug, goneRow.type, goneRow.changes], [undefined, 'reference', [{ field: 'index-remove', before: goneLine, after: null, reason: 'retired' }]]);
  assert.deepEqual(buildBrainHub({ vault: retired, cfg: {}, write: false }).hygiene.misfiled, []);
  assert.deepEqual(fix(retired, 'index').changes, []);

  const bare = fixture('mfix-index-none-');
  fs.unlinkSync(path.join(bare, 'MEMORY.md'));
  const dry = fix(bare, 'index', { dryRun: true });
  assert.equal(fs.existsSync(path.join(bare, 'MEMORY.md')), false);
  assert.equal(dry.files, 1);
  fix(bare, 'index');
  assert.match(read(bare, 'MEMORY.md'), /^# Index\n\n## User\n- \[Old shape\]\(brain\/memory\/user\/old-shape\.md\) — a host auto-memory\n\n## Feedback\n/);
  assert.deepEqual(fix(bare, 'index').changes, []);
});

test('drafts: a draft whose rule is live is removed; one whose memory is superseded, has none, or only shares a slug, is kept', () => {
  const { v, dry } = roundTrip('drafts', 'mfix-drafts-');
  assert.deepEqual(dry.changes, [{ path: 'brain/memory/feedback/_drafts/legacy-label.md', action: 'draft-remove', before: 'Legacy label', after: null }]);
  assert.ok(fs.existsSync(path.join(v, 'brain/memory/feedback/_drafts/in-session-label.md')), 'a new rule whose slug collides is never removed');
  assert.equal(fs.existsSync(path.join(v, 'brain/memory/feedback/_drafts/legacy-label.md')), false);
  assert.ok(fs.existsSync(path.join(v, 'brain/memory/feedback/_drafts/replaced.md')));
  assert.ok(fs.existsSync(path.join(v, 'brain/memory/feedback/_drafts/brand-new.md')));
  assert.equal(read(v, P('feedback', 'legacy-label')), FILES[P('feedback', 'legacy-label')], 'the memory itself stays');
  const [row] = fixed(v);
  assert.deepEqual({ ...row, ts: 'T' }, {
    ts: 'T', session: 's9', action: 'fixed', kind: 'drafts', slug: 'legacy-label', type: 'feedback', title: 'Legacy label',
    path: 'brain/memory/feedback/_drafts/legacy-label.md', changes: [{ field: 'draft-remove', before: 'Legacy label', after: null }],
  });
});

test('links are never written through: a linked memory is left out, its line kept; a linked MEMORY.md refuses', () => {
  const v = fixture('mfix-link-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mfix-out-'));
  const target = path.join(outside, 'target.md');
  const text = '---\ntype: feedback\nsource: session\n---\n\n# Linked\n\nBody.\n';
  fs.writeFileSync(target, text);
  fs.symlinkSync(target, path.join(v, P('feedback', 'linked')));
  put(v, 'MEMORY.md', `${read(v, 'MEMORY.md')}- [Linked](${P('feedback', 'linked')}) — a link\n`);
  for (const kind of KINDS) {
    const r = fix(v, kind);
    assert.ok(!r.changes.some((c) => c.path === P('feedback', 'linked') || (c.before || '').includes('feedback/linked.md')), kind);
  }
  assert.equal(fs.readFileSync(target, 'utf8'), text);
  assert.ok(read(v, 'MEMORY.md').includes(`(${P('feedback', 'linked')})`), 'its index line is not "broken": a file is there');

  const v2 = fixture('mfix-link-idx-');
  const idx = read(v2, 'MEMORY.md');
  fs.writeFileSync(path.join(outside, 'MEMORY.md'), idx);
  fs.unlinkSync(path.join(v2, 'MEMORY.md'));
  fs.symlinkSync(path.join(outside, 'MEMORY.md'), path.join(v2, 'MEMORY.md'));
  for (const kind of ['index', 'descriptions']) {
    assert.throws(() => fix(v2, kind, { dryRun: true }), { code: 'UNSAFE' }, kind);
    assert.throws(() => fix(v2, kind), { code: 'UNSAFE' }, kind);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'MEMORY.md'), 'utf8'), idx);
  assert.equal(fs.existsSync(path.join(v2, TRAIL)), false);
});

test('no brain/_index refuses every kind, dry run included', () => {
  const v = fixture('mfix-noidx-');
  fs.rmSync(path.join(v, 'brain/_index'), { recursive: true });
  for (const kind of KINDS) assert.throws(() => fix(v, kind, { dryRun: true }), { code: 'NO_INDEX' }, kind);
});

// A strict YAML reader (Obsidian's Properties) where one is installed: js-yaml comes with the lint tooling.
let strictYaml = null;
try { strictYaml = require('js-yaml'); } catch { /* the exact-text checks below stand alone */ }
const fmOf = (text) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
const hubOf = (v) => buildBrainHub({ vault: v, cfg: {}, write: false }).hygiene;

test('index: a memory whose title has brackets (a [[wiki-link]] /wrap kept) reads as indexed; nothing is added twice', () => {
  const v = fixture('mfix-bracket-');
  const rel = P('feedback', 'link-agenticos-workbench-decisions');
  put(v, rel, mem({ type: 'feedback', title: 'link [[agenticos-workbench]] decisions in daily notes', description: '' }));
  // memory-writer.js writes the raw title into MEMORY.md, brackets and all.
  const line = `- [link [[agenticos-workbench]] decisions in daily notes](${rel}) — link decisions in daily notes`;
  put(v, 'MEMORY.md', read(v, 'MEMORY.md').replace('## Reference', `${line}\n\n## Reference`));
  assert.ok(!hubOf(v).unindexed.includes(rel));
  const before = read(v, 'MEMORY.md');
  const r = fix(v, 'index');
  assert.ok(!r.changes.some((c) => c.path === rel), 'no index-add for a memory that has its line');
  assert.equal(read(v, 'MEMORY.md').split('\n').filter((l) => l.includes(`](${rel})`)).length, 1);
  assert.ok(read(v, 'MEMORY.md').includes(line));
  assert.notEqual(before, '');
  // A hand-typed ` - ` for the dash, and a bullet that links the memory after some text, are its line too.
  const w = fixture('mfix-loose-');
  put(w, 'MEMORY.md', read(w, 'MEMORY.md')
    .replace('## Projects', `- see also [Not indexed](${P('projects', 'not-indexed')})\n\n## Projects`)
    .replace('## User', `- [Use [x] wisely](${P('reference', 'bracket-title')}) - typed by hand\n\n## User`));
  const h = hubOf(w);
  assert.ok(!h.unindexed.includes(P('projects', 'not-indexed')) && !h.unindexed.includes(P('reference', 'bracket-title')));
  assert.ok(!fix(w, 'index', { dryRun: true }).changes.some((c) => c.action === 'index-add'));
});

test('index: a CRLF MEMORY.md reads as indexed, a fix with nothing to do leaves it byte for byte, and lines keep CRLF', () => {
  const v = fixture('mfix-crlf-');
  const lf = read(v, 'MEMORY.md');
  // Only the findings the LF fixture has: two missing lines, one misfiled, one broken.
  put(v, 'MEMORY.md', lf.replace(/\n/g, '\r\n'));
  const h = hubOf(v);
  assert.deepEqual(h.unindexed.sort(), [P('projects', 'not-indexed'), P('reference', 'bracket-title')], 'the described lines read');
  assert.deepEqual(h.noDescription.sort(), [P('feedback', 'long-desc'), P('feedback', 'no-desc')]);
  const dry = fix(v, 'index', { dryRun: true });
  const lfDry = fix(fixture('mfix-crlf-lf-'), 'index', { dryRun: true });
  assert.deepEqual(dry.changes, lfDry.changes, 'the same changes as the LF file');
  fix(v, 'index', { expect: dry.expect });
  const after = read(v, 'MEMORY.md');
  assert.doesNotMatch(after, /(^|[^\r])\n/, 'every line still ends CRLF, the added and moved ones too');
  assert.equal(after.split('\r\n').filter((l) => l.includes(`](${P('reference', 'auto-label')})`)).length, 1, 'nothing duplicated');
  // Nothing left to do: a second run leaves the file byte for byte.
  assert.deepEqual(fix(v, 'index').changes, []);
  assert.equal(read(v, 'MEMORY.md'), after);
  const clean = hubOf(v);
  assert.deepEqual([clean.unindexed, clean.misfiled, clean.brokenIndex], [[], [], []]);
});

test('index: two misfiled lines of one memory: one moves, the other is listed as removed in the dry run and the trail', () => {
  const v = fixture('mfix-two-misfiled-');
  const rel = P('feedback', 'legacy-label');
  const first = `- [Legacy label](${rel}) — first wording`;
  const second = `- [Legacy label](${rel}) — a second, different line`;
  put(v, 'MEMORY.md', read(v, 'MEMORY.md')
    .replace(`- [Legacy label](${rel}) — a legacy label\n`, '')
    .replace('## Projects\n', `## Projects\n${first}\n`)
    .replace('## Reference\n', `## Reference\n${second}\n`));
  const dry = fix(v, 'index', { dryRun: true });
  // The first in file order (under Reference) moves; the other (under Projects) goes, listed with its text.
  const mine = dry.changes.filter((c) => c.path === rel || (c.before || '').includes(`](${rel})`));
  assert.deepEqual(mine.sort((a, b) => a.action.localeCompare(b.action)), [
    { path: rel, action: 'index-move', before: 'Reference', after: 'Feedback' },
    { path: 'MEMORY.md', action: 'index-remove', before: first, after: null, reason: 'duplicate' },
  ]);
  fix(v, 'index', { expect: dry.expect });
  const rows = fixed(v);
  assert.ok(rows.some((r) => r.path === 'MEMORY.md' && r.changes.some((c) => c.field === 'index-remove' && c.before === first && c.reason === 'duplicate')));
  const idx = read(v, 'MEMORY.md');
  assert.ok(idx.includes(second) && !idx.includes(first), 'the moved line kept its text; the other is gone');
  assert.ok(idx.indexOf(second) > idx.indexOf('## Feedback') && idx.indexOf(second) < idx.indexOf('## Reference'), 'under its own heading');
  assert.equal(read(v, 'MEMORY.md').split('\n').filter((l) => l.includes(`](${rel})`)).length, 1);
});

test('the hub lists only what a fix acts on: a memory with no frontmatter, a link and a file too big to read', () => {
  const v = fixture('mfix-agree-');
  // No frontmatter, and a BOM before ---: the descriptions fix has no block to write into.
  put(v, P('reference', 'plain-note'), '# Plain note\n\nNo frontmatter here.\n');
  put(v, P('reference', 'bom-note'), `\uFEFF${mem({ type: 'reference', title: 'Bom note', description: '' })}`);
  // A link, and a file over memory-ops' 1 MB: listMemories reads neither, and the index fix removes neither line.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mfix-agree-out-'));
  fs.writeFileSync(path.join(outside, 't.md'), mem({ type: 'reference', title: 'Linked' }));
  fs.symlinkSync(path.join(outside, 't.md'), path.join(v, P('reference', 'linked-note')));
  put(v, P('reference', 'big-note'), `${mem({ type: 'reference', title: 'Big' })}${'x'.repeat(1024 * 1024)}\n`);
  put(v, 'MEMORY.md', read(v, 'MEMORY.md').replace('## Projects', [
    `- [Plain note](${P('reference', 'plain-note')}) — a described line`,
    `- [Bom note](${P('reference', 'bom-note')}) — a described line`,
    `- [Linked](${P('reference', 'linked-note')}) — a link`,
    `- [Big](${P('reference', 'big-note')}) — too big to read`,
    '', '## Projects'].join('\n')));
  const h = hubOf(v);
  for (const slug of ['plain-note', 'bom-note']) assert.ok(!h.noDescription.includes(P('reference', slug)), slug);
  for (const slug of ['linked-note', 'big-note']) assert.ok(!h.brokenIndex.includes(P('reference', slug)), slug);
  // Every path the hub lists for a kind is in that kind's dry run.
  const dryPaths = (kind) => new Set(fix(v, kind, { dryRun: true }).changes.flatMap((c) => [c.path, ...((c.before || '').match(/brain\/memory\/[^)]+\.md/g) || [])]));
  const desc = dryPaths('descriptions');
  for (const p of h.noDescription) assert.ok(desc.has(p), p);
  const idx = dryPaths('index');
  for (const p of [...h.unindexed, ...h.misfiled, ...h.brokenIndex]) assert.ok(idx.has(p), p);
});

test('types: a zero-indent block list gains its tag at that indent; a flow list split over lines is left alone', () => {
  const v = fixture('mfix-zero-');
  put(v, P('projects', 'zero-indent'), '---\ntype: project\ntags:\n- reference/tooling\n- status/active\ndescription: zero indent\n---\n\n# Zero indent\n\nBody.\n');
  put(v, P('projects', 'zero-has'), '---\ntype: project\ntags:\n- memory/projects\n- status/active\n---\n\n# Zero has\n\nBody.\n');
  put(v, P('reference', 'split-flow'), '---\ntype: reference\ntags: [a,\n  b]\n---\n\n# Split flow\n\nBody.\n');
  const dry = fix(v, 'types', { dryRun: true });
  const of = (rel) => dry.changes.filter((c) => c.path === rel);
  assert.deepEqual(of(P('projects', 'zero-indent')), [
    { path: P('projects', 'zero-indent'), action: 'type', before: 'project', after: 'memory' },
    { path: P('projects', 'zero-indent'), action: 'tags', before: '[reference/tooling, status/active]', after: '[reference/tooling, status/active, memory/projects]' },
  ]);
  assert.deepEqual(of(P('projects', 'zero-has')), [{ path: P('projects', 'zero-has'), action: 'type', before: 'project', after: 'memory' }]);
  assert.deepEqual(of(P('reference', 'split-flow')), [{ path: P('reference', 'split-flow'), action: 'type', before: 'reference', after: 'memory' }]);
  fix(v, 'types', { expect: dry.expect });
  assert.equal(read(v, P('projects', 'zero-indent')), '---\ntype: memory\ntags:\n- reference/tooling\n- status/active\n- memory/projects\ndescription: zero indent\n---\n\n# Zero indent\n\nBody.\n');
  assert.equal(read(v, P('projects', 'zero-has')), '---\ntype: memory\ntags:\n- memory/projects\n- status/active\n---\n\n# Zero has\n\nBody.\n');
  assert.equal(read(v, P('reference', 'split-flow')), '---\ntype: memory\ntags: [a,\n  b]\n---\n\n# Split flow\n\nBody.\n');
  // A zero-indent status reads as the status (memory-ops getStatus): still active, so still live.
  assert.equal(ops.describe(ops.readMemory(v, P('projects', 'zero-indent'))).status, 'active');
  if (strictYaml) {
    for (const slug of ['projects/zero-indent', 'projects/zero-has', 'reference/split-flow']) {
      const doc = strictYaml.load(fmOf(read(v, `brain/memory/${slug}.md`)));
      assert.equal(doc.type, 'memory', slug);
      assert.equal(new Set(doc.tags).size, doc.tags.length, `${slug}: no tag twice`);
    }
  }
});

test('descriptions: a description with both quote kinds is single-quoted with \'\' doubled, and reads back as written', () => {
  const v = fixture('mfix-quotes-');
  const text = 'Don\'t write "x": ask first';
  put(v, 'MEMORY.md', read(v, 'MEMORY.md').replace('— ask the graph first: always', `— ${text}`));
  fix(v, 'descriptions');
  const raw = read(v, P('feedback', 'no-desc'));
  assert.match(raw, /^description: 'Don''t write "x": ask first'$/m);
  assert.equal(ops.describe(ops.readMemory(v, P('feedback', 'no-desc'))).description, text);
  if (strictYaml) assert.equal(strictYaml.load(fmOf(raw)).description, text);
});

test('--expect: the real run refuses, writing nothing, when the files no longer give the changes the preview showed', () => {
  for (const kind of KINDS) {
    const v = fixture(`mfix-expect-${kind}-`);
    const dry = fix(v, kind, { dryRun: true });
    assert.match(dry.expect, /^[0-9a-f]{32}$/);
    // Another session writes while the dialog is open: one more finding of each kind.
    put(v, P('feedback', 'late-one'), mem({ type: 'feedback', title: 'Late one', source: 'session', description: '', extra: '' }).replace('type: memory', 'type: feedback'));
    put(v, 'MEMORY.md', `${read(v, 'MEMORY.md')}- [Late one](${P('feedback', 'late-one')}) — written meanwhile\n`);
    put(v, 'brain/memory/feedback/_drafts/late-one.md', '---\ntags: [memory/feedback, status/draft]\n---\n\n# Late one\n\nbody\n');
    const before = snapshot(v);
    assert.throws(() => fix(v, kind, { expect: dry.expect }), { code: 'CHANGED' }, kind);
    assert.deepEqual(diff(before, snapshot(v)), [], `${kind}: nothing written`);
    assert.deepEqual(fixed(v), [], `${kind}: no trail row`);
    // A fresh preview's hash goes through.
    const again = fix(v, kind, { dryRun: true });
    assert.ok(fix(v, kind, { expect: again.expect }).changes.length >= 1, kind);
  }
  assert.throws(() => fix(fixture(), 'sources', { expect: 'none' }), { code: 'BAD_HASH' });
});
