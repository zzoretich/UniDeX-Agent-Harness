'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./roadmap.js');

const SEED = fs.readFileSync(path.join(__dirname, '../roadmap/roadmap.md'), 'utf8');
const doc = (...items) => `# Roadmap\n\nIntro.\n\n${items.join('\n\n')}\n`;
const PLANNED = '### UDX-002 · Faster start\nstatus: planned · type: improvement · area: cli\n\nStart in under a second.\n\n#### Must\n- Works offline\n\n#### Not\n- No daemon\n\n#### Done when\n- `aos` starts in < 1 s\n\n#### Plan\nCache the config.';

const tmpRoot = (text) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-'));
  fs.mkdirSync(path.join(r, 'roadmap'));
  fs.writeFileSync(path.join(r, 'roadmap/roadmap.md'), text);
  return r;
};

// ---- parse and check (spec 2026-11-11-roadmap-design D2, D3, D9) -----------------------------------------------------

test('the seed parses: one idea, no errors', () => {
  const p = R.parse(SEED);
  assert.deepEqual(p.errors, []);
  const [i] = p.items;
  assert.equal(p.items.length, 1);
  assert.deepEqual([i.id, i.num, i.title, i.status, i.type, i.area, i.release], ['UDX-001', 1, 'Choose your colour scheme', 'idea', 'feature', 'app', null]);
  assert.equal(i.summary, "Let users change UniDeX's colours by picking from a set of schemes: shades of blue, green, pink and more.");
  assert.deepEqual(i.sections, []);
  assert.equal(i.anchor, 'udx-001--choose-your-colour-scheme');
});

test('a planned item keeps its #### sections in order, any name', () => {
  const [i] = R.parse(doc(PLANNED)).items;
  assert.deepEqual(i.sections.map((s) => s.title), ['Must', 'Not', 'Done when', 'Plan']);
  assert.equal(i.sections[0].body, '- Works offline');
  assert.equal(i.summary, 'Start in under a second.');
});

test('every separator form reads the same', () => {
  for (const s of ['·', '-', '–', '—', '|']) {
    const [i] = R.parse(doc(`### UDX-003 ${s} Title here\nstatus: idea ${s} type: function ${s} area: plugins\n\nText.`)).items;
    assert.deepEqual([i.id, i.title, i.status, i.type, i.area], ['UDX-003', 'Title here', 'idea', 'function', 'plugins'], s);
  }
});

test('tolerant input: CRLF, trailing spaces, capitals, blank line before the metadata', () => {
  const p = R.parse(doc('### UDX-004 · Title  \r\n\r\nStatus: Idea · Type: Feature · area: app  \r\n\r\nText.'));
  assert.deepEqual(p.errors, []);
  assert.deepEqual([p.items[0].title, p.items[0].status, p.items[0].type], ['Title', 'idea', 'feature']);
});

test('fences: headings inside a fenced block are prose', () => {
  const p = R.parse(doc('### UDX-005 · T\nstatus: idea · type: feature · area: app\n\nText.\n\n```\n### not an item\n#### not a section\n```'));
  assert.deepEqual(p.errors, []);
  assert.equal(p.items.length, 1);
  assert.deepEqual(p.items[0].sections, []);
});

test('check errors name the line', () => {
  const ok = '### UDX-001 · A\nstatus: idea · type: feature · area: app\n\nText.';
  const cases = [
    [[ok, ok], /UDX-001 is used twice/, 10],
    [['### UDX-1 · Short\nstatus: idea · type: feature · area: app'], /malformed ID/, 5],
    [[ok, '### Something else'], /item heading/, 10],
    [['### UDX-002 · B\n\nJust prose.'], /metadata line/, 7],
    [['### UDX-002 · B\nstatus: maybe · type: feature · area: app'], /unknown status "maybe"/, 6],
    [['### UDX-002 · B\nstatus: idea · area: app'], /missing type/, 6],
    [['### UDX-002 · B\nstatus: idea · type: feature · area: Two Words'], /area/, 6],
    [['### UDX-002 · B\nstauts: idea · type: feature · area: app'], /unknown key "stauts"/, 6],
    [['### UDX-002 · B\nstatus: idea · type: feature · area: app · release: v2.7.0'], /release only on a shipped item/, 6],
    [['### UDX-002 · B\nstatus: shipped · type: feature · area: app · release: 2.7'], /malformed release/, 6],
    [['### UDX-002 · B\nstatus: planned · type: feature · area: app\n\nText.'], /planned item needs at least one #### section/, 5],
    [['### UDX-002 · \nstatus: idea · type: feature · area: app'], /missing title/, 5],
  ];
  for (const [items, re, line] of cases) {
    const { errors } = R.parse(doc(...items));
    assert.ok(errors.length >= 1, String(re));
    assert.match(errors[0].message, re);
    assert.equal(errors[0].line, line, String(re));
  }
});

test('slug matches GitHub heading anchors', () => {
  assert.equal(R.slug('UDX-001 · Choose your colour scheme'), 'udx-001--choose-your-colour-scheme');
  assert.equal(R.slug('UDX-002 - Faster `aos` start'), 'udx-002---faster-aos-start');
  assert.equal(R.slug("UDX-003 · Don't break: CLI"), 'udx-003--dont-break-cli');
});

test('main check: 0 on the seed, 1 with file:line errors, 2 on usage', () => {
  const run = (text) => {
    const out = []; const errs = [];
    const code = R.main(['check'], { root: tmpRoot(text), log: (s) => out.push(s), err: (s) => errs.push(s) });
    return { code, out: out.join('\n'), err: errs.join('\n') };
  };
  const good = run(SEED);
  assert.equal(good.code, 0, good.err);
  assert.match(good.out, /roadmap: 1 item\(s\), 0 error\(s\)/);
  const bad = run(doc('### UDX-001 · A\nstatus: maybe · type: feature · area: app'));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /roadmap\/roadmap\.md:6: unknown status "maybe"/);
  assert.equal(R.main(['nope'], { root: tmpRoot(SEED), log() {}, err() {} }), 2);
});
