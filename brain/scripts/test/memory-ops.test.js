'use strict';
// lib/memory-ops.js (brain-hub D5–D7, D13, spec §6): byte-for-byte frontmatter edits, the MEMORY.md line kept in step,
// the trail, and every refusal (bad path, link, outside, changed file, gone memory).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ops = require('../lib/memory-ops.js');
const { removeIndexLine, upsertIndexLine } = require('../lib/memory-index.js');

const put = (v, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), text);
};
const read = (v, rel) => fs.readFileSync(path.join(v, rel), 'utf8');
const FB = 'brain/memory/feedback/graphify-first.md';
const PR = 'brain/memory/projects/pulse-1-5-0.md';
const RULE = '---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-09-30\nupdated: 2026-09-30\nsource: auto-wrap\nsession: abc\nreviewed: false\n---\n\n# Graphify first\n\nAsk the graph tools before reading files.\n';
const PROJECT = '---\ntype: memory\ntags: [memory/projects, status/active]\ncreated: 2026-10-09\nupdated: 2026-10-09\n---\n\n# Pulse 1.5.0\n\nShipped the cockpit.\n';
const INDEX = '# Index\n\n## Feedback\n- [Graphify first](brain/memory/feedback/graphify-first.md) — ask the graph first\n\n## Projects\n- [Pulse 1.5.0](brain/memory/projects/pulse-1-5-0.md) — shipped the cockpit\n';

function fixture(prefix = 'mops-') {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  put(v, 'brain/_index/.keep', '');
  put(v, FB, RULE);
  put(v, PR, PROJECT);
  put(v, 'MEMORY.md', INDEX);
  return v;
}
const trail = (v) => read(v, 'brain/_index/promote-log.jsonl').trim().split('\n').map((l) => JSON.parse(l));

test('checkPath takes brain/memory/<type>/<slug>.md for the four types only', () => {
  assert.deepEqual(ops.checkPath(FB), { rel: FB, type: 'feedback', slug: 'graphify-first' });
  for (const bad of ['brain/memory/feedback/README.md', 'brain/memory/feedback/_drafts/x.md', 'brain/memory/other/x.md',
    'brain/memory/feedback/../user/x.md', '/abs/brain/memory/feedback/x.md', 'brain/memory/feedback/x.txt', '', null]) {
    assert.throws(() => ops.checkPath(bad), { code: 'BAD_PATH' }, String(bad));
  }
});

test('keep flips reviewed and nothing else, logs the trail, and is idempotent', () => {
  const v = fixture();
  assert.deepEqual(ops.keep(v, [FB, PR]), { kept: [FB, PR], already: [] });
  assert.equal(read(v, FB), RULE.replace('reviewed: false', 'reviewed: true'));
  assert.ok(read(v, PR).includes('reviewed: true\n---'), 'a memory without the key gets it');
  assert.deepEqual(ops.keep(v, [FB]), { kept: [], already: [FB] });
  assert.deepEqual(trail(v).map((r) => [r.action, r.path]), [['kept', FB], ['kept', PR]]);
});

test('a bad path anywhere refuses the whole call before anything is written', () => {
  const v = fixture();
  assert.throws(() => ops.keep(v, [FB, 'brain/memory/feedback/missing.md']), { code: 'NOT_FOUND' });
  assert.equal(read(v, FB), RULE);
});

test('set changes pin, status and description; --expect refuses a changed file; dry run writes nothing', () => {
  const v = fixture();
  const h = ops.readMemory(v, FB).hash;
  const dry = ops.setFields(v, FB, { pin: true }, { expect: h, dryRun: true });
  assert.equal(dry.written, false);
  assert.match(dry.text, /^pin: true$/m);
  assert.equal(read(v, FB), RULE);
  const r = ops.setFields(v, FB, { pin: true, description: 'Ask the graph_* tools first' }, { expect: h });
  assert.equal(r.written, true);
  assert.match(read(v, FB), /^pin: true\ndescription: Ask the graph_\* tools first\n---/m);
  assert.match(read(v, 'MEMORY.md'), /- \[Graphify first\]\(brain\/memory\/feedback\/graphify-first\.md\) — Ask the graph_\* tools first\n/);
  assert.throws(() => ops.setFields(v, FB, { pin: false }, { expect: h }), { code: 'CHANGED' });
  ops.setFields(v, PR, { status: 'complete' });
  assert.match(read(v, PR), /^tags: \[memory\/projects, status\/complete\]$/m);
  ops.setFields(v, FB, { pin: false });
  assert.doesNotMatch(read(v, FB), /^pin:/m);
});

test('set refuses unknown keys, bad values and archived memories', () => {
  const v = fixture();
  for (const f of [{}, { title: 'x' }, { pin: 'yes' }, { status: 'archived' }, { description: 'two\nlines' }, { description: 'x'.repeat(201) }, []]) {
    assert.throws(() => ops.setFields(v, FB, f), { code: 'BAD_FIELD' }, JSON.stringify(f));
  }
  ops.archive(v, [PR]);
  assert.throws(() => ops.setFields(v, PR, { pin: true }), { code: 'GONE' });
});

test('archive keeps the description, records the status before, removes the index line; restore puts both back', () => {
  const v = fixture();
  ops.setFields(v, PR, { status: 'complete' });
  assert.deepEqual(ops.archive(v, [PR], { date: '2026-10-11' }), { archived: [PR], already: [] });
  const text = read(v, PR);
  assert.match(text, /^tags: \[memory\/projects, status\/archived\]$/m);
  assert.match(text, /^description: shipped the cockpit$/m);
  assert.match(text, /^status_before: complete$/m);
  assert.match(text, /^archived: 2026-10-11$/m);
  assert.ok(!read(v, 'MEMORY.md').includes(PR));
  assert.deepEqual(ops.archive(v, [PR]), { archived: [], already: [PR] });
  assert.deepEqual(ops.restore(v, [PR]), { restored: [PR], already: [] });
  const back = read(v, PR);
  assert.match(back, /^tags: \[memory\/projects, status\/complete\]$/m);
  assert.doesNotMatch(back, /^(status_before|archived):/m);
  assert.equal((read(v, 'MEMORY.md').match(/pulse-1-5-0\.md/g) || []).length, 1, 'one line, under its heading');
  assert.match(read(v, 'MEMORY.md'), /## Projects\n- \[Pulse 1\.5\.0\]\(brain\/memory\/projects\/pulse-1-5-0\.md\) — shipped the cockpit/);
  assert.deepEqual(trail(v).map((r) => r.action), ['set', 'archived', 'restored']);
});

test('supersede points at the winner, refuses itself and a gone winner; restore clears it', () => {
  const v = fixture();
  put(v, 'brain/memory/feedback/graph-tools-first.md', RULE.replace('# Graphify first', '# Graph tools first'));
  const WIN = 'brain/memory/feedback/graph-tools-first.md';
  assert.throws(() => ops.supersede(v, FB, FB), { code: 'BAD_PATH' });
  assert.deepEqual(ops.supersede(v, FB, WIN), { path: FB, by: WIN, already: false });
  assert.match(read(v, FB), /^superseded_by: brain\/memory\/feedback\/graph-tools-first\.md$/m);
  assert.match(read(v, FB), /status\/superseded/);
  assert.throws(() => ops.supersede(v, WIN, FB), { code: 'GONE' });
  ops.restore(v, [FB]);
  assert.doesNotMatch(read(v, FB), /superseded/);
});

test('CRLF files, block-list tags and unknown keys keep every other byte', () => {
  const v = fixture();
  const crlf = '---\r\ntype: memory\r\ntags:\r\n  - memory/reference\r\n  - status/active\r\nodd: [keep, me]\r\nreviewed: false\r\n---\r\n\r\n# Old style\r\n\r\nBody.\r\n';
  const REF = 'brain/memory/reference/old-style.md';
  put(v, REF, crlf);
  ops.keep(v, [REF]);
  assert.equal(read(v, REF), crlf.replace('reviewed: false', 'reviewed: true'));
  ops.archive(v, [REF]);
  const t = read(v, REF);
  assert.match(t, /\r\n  - status\/archived\r\n/);
  assert.match(t, /odd: \[keep, me\]\r\n/);
  assert.ok(t.endsWith('# Old style\r\n\r\nBody.\r\n'));
});

test('a zero-indent block list (tags:\\n- a, as PyYAML writes it) reads its status and is edited at its own indent', () => {
  const v = fixture();
  const REF = 'brain/memory/reference/flush.md';
  put(v, REF, '---\ntype: memory\ntags:\n- memory/reference\n- status/active\nreviewed: false\n---\n\n# Flush\n\nBody.\n');
  assert.equal(ops.describe(ops.readMemory(v, REF)).status, 'active');
  ops.archive(v, [REF]);
  assert.match(read(v, REF), /^tags:\n- memory\/reference\n- status\/archived\nreviewed: false\n/m);
  assert.equal(ops.describe(ops.readMemory(v, REF)).live, false);
  const GONE = 'brain/memory/reference/flush-archived.md';
  put(v, GONE, '---\ntype: memory\ntags:\n- memory/reference\n- status/archived\n---\n\n# Flush archived\n\nBody.\n');
  assert.equal(ops.describe(ops.readMemory(v, GONE)).live, false, 'an archived zero-indent memory is not live');
});

test('a symlinked memory, a symlinked type folder and a linked MEMORY.md are refused, never written through', () => {
  const v = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mops-out-'));
  fs.writeFileSync(path.join(outside, 'target.md'), RULE);
  fs.symlinkSync(path.join(outside, 'target.md'), path.join(v, 'brain/memory/feedback/linked.md'));
  assert.throws(() => ops.keep(v, ['brain/memory/feedback/linked.md']), { code: 'UNSAFE' });
  assert.equal(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), RULE);

  const v2 = fixture('mops-dir-');
  fs.mkdirSync(path.join(outside, 'reference'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'reference', 'x.md'), RULE);
  fs.symlinkSync(path.join(outside, 'reference'), path.join(v2, 'brain/memory/reference'));
  assert.throws(() => ops.keep(v2, ['brain/memory/reference/x.md']), { code: 'UNSAFE' });
  assert.equal(fs.readFileSync(path.join(outside, 'reference', 'x.md'), 'utf8'), RULE);
  assert.deepEqual(ops.listMemories(v2).map((m) => m.path).sort(), [FB, PR], 'a linked type folder is not listed');

  const v3 = fixture('mops-idx-');
  fs.writeFileSync(path.join(outside, 'MEMORY.md'), INDEX);
  fs.unlinkSync(path.join(v3, 'MEMORY.md'));
  fs.symlinkSync(path.join(outside, 'MEMORY.md'), path.join(v3, 'MEMORY.md'));
  assert.throws(() => ops.archive(v3, [PR]), { code: 'UNSAFE' });
  assert.equal(fs.readFileSync(path.join(outside, 'MEMORY.md'), 'utf8'), INDEX);
});

test('listMemories and listDrafts read the store, skipping README.md and links', () => {
  const v = fixture();
  put(v, 'brain/memory/feedback/README.md', '# About feedback\n');
  put(v, 'brain/memory/feedback/_drafts/a-draft.md', '---\ntags: [memory/feedback, status/draft]\ndescription: d\nsession: s\n---\n\n# A draft\n');
  const list = ops.listMemories(v);
  assert.deepEqual(list.map((m) => m.path).sort(), [FB, PR]);
  const fb = list.find((m) => m.path === FB);
  assert.equal(fb.title, 'Graphify first');
  assert.equal(fb.reviewed, 'false');
  assert.equal(fb.live, true);
  assert.equal(fb.hash.length, 64);
  assert.deepEqual(ops.listDrafts(v), [{ slug: 'a-draft', title: 'A draft', description: 'd', session: 's', created: null }]);
});

test('upsertIndexLine replaces a memory\'s line in place and never duplicates it; removeIndexLine drops every copy', () => {
  const twice = '## Feedback\n- [A](brain/memory/feedback/a.md) — one\n- [B](brain/memory/feedback/b.md) — two\n- [A](brain/memory/feedback/a.md) — again\n';
  assert.equal(upsertIndexLine(twice, '## Feedback', '- [A2](brain/memory/feedback/a.md) — new', 'brain/memory/feedback/a.md'),
    '## Feedback\n- [A2](brain/memory/feedback/a.md) — new\n- [B](brain/memory/feedback/b.md) — two\n');
  assert.equal(removeIndexLine(twice, 'brain/memory/feedback/a.md'), '## Feedback\n- [B](brain/memory/feedback/b.md) — two\n');
  assert.equal(upsertIndexLine('# Index\n', '## Feedback', '- [C](brain/memory/feedback/c.md) — c', 'brain/memory/feedback/c.md'),
    '# Index\n\n## Feedback\n- [C](brain/memory/feedback/c.md) — c');
});

test('BRAIN.md leaves an archived pin out until it is restored', () => {
  // build-brain-md resolves its vault per process: run it in a child against this fixture.
  const v = fixture('mops-brain-');
  put(v, 'brain/memory/user/profile.md', '---\ntype: memory\ntags: [memory/user, status/active]\n---\n\n# Profile\n\nThe fixture user.\n');
  ops.setFields(v, FB, { pin: true });
  const build = () => require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'build-brain-md.js')], {
    env: { ...process.env, AOS_VAULT: v, AOS_CONFIG: path.join(v, 'none.json') }, encoding: 'utf8',
  });
  assert.equal(build().status, 0);
  assert.match(read(v, 'brain/_index/BRAIN.md'), /\*\*Graphify first\*\*/);
  const sources = JSON.parse(read(v, 'brain/_index/brain-sources.json'));
  assert.deepEqual(sources.sections.rules.paths, [FB]);
  assert.deepEqual(sources.sections.who.paths, ['brain/memory/user/profile.md']);
  assert.deepEqual(sources.sections.active.paths, [PR]);
  ops.archive(v, [FB]);
  assert.equal(build().status, 0);
  assert.doesNotMatch(read(v, 'brain/_index/BRAIN.md'), /Graphify first/);
  assert.deepEqual(JSON.parse(read(v, 'brain/_index/brain-sources.json')).sections.rules.paths, []);
});

test('yamlValue quotes a description only when YAML would read it otherwise, and every reader gets the text back', () => {
  const cases = [
    ['plain words, no quotes', 'plain words, no quotes'], ['1.8.0 shipped', '1.8.0 shipped'],
    ['Rule: ask first', '"Rule: ask first"'], ['ends with:', '"ends with:"'], ['a #tag inside', '"a #tag inside"'],
    ['- a dash first', '"- a dash first"'], ['true', '"true"'], ['42', '"42"'], ['[bracketed]', '"[bracketed]"'],
    ['said "hi": then left', "'said \"hi\": then left'"],
  ];
  for (const [text, want] of cases) {
    assert.equal(ops.yamlValue(text), want, text);
    assert.equal(ops.getKey([`description: ${ops.yamlValue(text)}\n`], 'description'), text, `reads back: ${text}`);
  }
  // Both quote kinds and something YAML needs quoted: single-quoted with `'` doubled, YAML's own escape, which every
  // reader here reads back (memory-ops unquote, the HUD's fmKey, sdk/lib/brain.js) and strict YAML parses as the text.
  const both = [`it's "x": y`, 'Don\'t say "done": verify first', 'Use "x" not \'y\' # always', `[a, 'b', "c"]`];
  for (const text of both) {
    const v = ops.yamlValue(text);
    assert.equal(v, `'${text.replace(/'/g, "''")}'`, text);
    assert.equal(ops.getKey([`description: ${v}\n`], 'description'), text, `reads back: ${text}`);
    assert.equal(require('../sdk/lib/brain.js').parseFrontmatter(`---\ndescription: ${v}\n---\n`).frontmatter.description, text, `sdk reads back: ${text}`);
    let strict = null;
    try { strict = require('js-yaml'); } catch { /* the lint tooling brings it; the checks above stand alone */ }
    if (strict) assert.equal(strict.load(`description: ${v}`).description, text, `strict YAML: ${text}`);
  }
  assert.equal(ops.yamlValue(`it's "x": y`), `'it''s "x": y'`);
});
