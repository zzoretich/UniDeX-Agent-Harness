'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./changelog.js');

const URL = 'https://github.com/example/repo';
const TEXT = `# Changelog

Intro.

## [Unreleased]

### Fixed
- A fix.

## [0.2.0] — 2026-09-20

### Added
- A thing (#2).

### Upgrading
- Run \`aos upgrade\`.

## [0.1.0] — 2026-09-10

### Added
- The first thing.

[Unreleased]: ${URL}/compare/v0.2.0...HEAD
[0.2.0]: ${URL}/releases/tag/v0.2.0
[0.1.0]: ${URL}/releases/tag/v0.1.0
`;

test('section: a version\'s body up to the next heading, or to the link references for the last one', () => {
  assert.equal(C.section(TEXT, '0.2.0'), '### Added\n- A thing (#2).\n\n### Upgrading\n- Run `aos upgrade`.');
  assert.equal(C.section(TEXT, '0.1.0'), '### Added\n- The first thing.');
  assert.equal(C.section(TEXT, 'Unreleased'), '### Fixed\n- A fix.');
  assert.equal(C.section(TEXT, '0.3.0'), null);
  assert.equal(C.section(TEXT, '0.2'), null, 'no prefix match');
});

test('roll: [Unreleased] becomes the dated version under a fresh empty one; links follow; a second roll changes nothing', () => {
  const r = C.roll(TEXT, '0.3.0', '2026-09-24');
  assert.equal(r.changed, true);
  assert.match(r.text, /\n## \[Unreleased\]\n\n## \[0\.3\.0\] — 2026-09-24\n\n### Fixed\n- A fix\.\n\n## \[0\.2\.0\]/);
  assert.equal(C.section(r.text, 'Unreleased'), '');
  assert.match(r.text, new RegExp(`\\n\\[Unreleased\\]: ${URL}/compare/v0\\.3\\.0\\.\\.\\.HEAD\\n\\[0\\.3\\.0\\]: ${URL}/releases/tag/v0\\.3\\.0\\n\\[0\\.2\\.0\\]:`));
  assert.deepEqual(C.roll(r.text, '0.3.0', '2026-09-25'), { text: r.text, changed: false, message: 'CHANGELOG.md already has [0.3.0]' });
  assert.throws(() => C.roll(r.text, '0.4.0'), /\[Unreleased\] is empty/);
  assert.throws(() => C.roll('# Changelog\n', '0.4.0'), /no ## \[Unreleased\]/);
  assert.match(C.localDate(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('main: notes, check (current = package.json), roll writes the file; missing or empty exits 1, usage 2', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), TEXT);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  const out = []; const errs = [];
  const io = { root, log: (s) => out.push(s), err: (s) => errs.push(s) };
  assert.equal(C.main(['notes', '0.2.0'], io), 0);
  assert.match(out.pop(), /^### Added\n- A thing \(#2\)\./);
  assert.equal(C.main(['check', 'current'], io), 0);
  assert.equal(C.main(['check', '0.9.0'], io), 1);
  assert.match(errs.pop(), /no ## \[0\.9\.0\] section — run: node tools\/changelog\.js roll 0\.9\.0/);
  assert.equal(C.main(['roll', '0.3.0', '--date', '2026-09-24'], io), 0);
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /## \[0\.3\.0\] — 2026-09-24/);
  assert.equal(C.main(['check', 'Unreleased'], io), 2, 'only versions');
  assert.equal(C.main(['roll', '0.4.0'], io), 1, 'nothing unreleased');
  assert.equal(C.main(['nope', '1.0.0'], io), 2);
  assert.equal(C.main(['check', 'v1.0'], io), 2);
});

test('this repo: package.json\'s version has a non-empty section, and every section heading is well formed', () => {
  const root = path.resolve(__dirname, '..');
  const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.ok(C.section(text, version), `CHANGELOG.md has [${version}]`);
  for (const h of text.split('\n').filter((l) => l.startsWith('## '))) {
    assert.match(h, /^## \[(Unreleased|\d+\.\d+\.\d+)\]( — \d{4}-\d{2}-\d{2})?$/, h);
  }
});

// ---- tour markers (tour C3, C13) ------------------------------------------------------------------------------------

const BOOK = {
  schema: 1,
  core: 'core',
  chapters: [
    { id: 'core', steps: [{ id: 'rail' }, { id: 'help' }] },
    { id: 'settings', steps: [{ id: 'local' }, { id: 'row' }] },
  ],
  actions: [{ id: 'first-session' }],
};

const MARKED = `# Changelog

## [Unreleased]

### Upgrading
- Run \`aos upgrade\`; nothing else.

### Added
- **The local engine panel.** It shows the model. <!-- tour: settings.local -->
- **A tour.** Ten stops. <!-- tour: core -->
- **Two places.** <!-- tour: settings.local, core.help -->
- **\`aos local\`** prints it.
  It wraps onto a second line. <!-- no-tour: CLI verb -->

### Changed
- **Sessions follows your hosts.** <!--tour:core.rail-->

### Fixed
- A fix with no marker.

## [0.2.0] — 2026-09-20

### Added
- A released thing with no marker, and one long gone. <!-- tour: gone.step -->

[Unreleased]: ${URL}/compare/v0.2.0...HEAD
[0.2.0]: ${URL}/releases/tag/v0.2.0
`;

test('tourRefs: chapter ids and <chapter>.<step>, the refs What\'s new "Show me" takes; never checklist actions', () => {
  assert.deepEqual([...C.tourRefs(BOOK)].sort(), ['core', 'core.help', 'core.rail', 'settings', 'settings.local', 'settings.row']);
  assert.deepEqual([...C.tourRefs(null)], []);
  assert.deepEqual([...C.tourRefs({ chapters: [null, { id: 'x', steps: 'no' }] })], ['x']);
});

test('markerProblems: every [Unreleased] Added and Changed bullet carries a known tour id or a no-tour reason', () => {
  assert.deepEqual(C.markerProblems(MARKED, C.tourRefs(BOOK)), []);
});

test('markerProblems: a bullet with no marker fails, named by its first words and its line', () => {
  const text = MARKED.replace('**A tour.** Ten stops. <!-- tour: core -->', '**A tour.** Ten stops around the whole Workbench.');
  const p = C.markerProblems(text, C.tourRefs(BOOK));
  assert.equal(p.length, 1);
  assert.match(p[0], /^CHANGELOG\.md:10: \[Unreleased\] ▸ Added "A tour\. Ten stops around the…": no tour marker — end it with <!-- tour: <chapter>\[\.<step>\] --> or <!-- no-tour: <reason> -->/);
});

test('markerProblems: an unknown id fails, naming each unknown one; a checklist action id is not a tour id', () => {
  const text = MARKED.replace('<!-- tour: settings.local, core.help -->', '<!-- tour: settings.local, settings.nope, first-session -->');
  const p = C.markerProblems(text, C.tourRefs(BOOK));
  assert.equal(p.length, 1);
  assert.match(p[0], /^CHANGELOG\.md:11: \[Unreleased\] ▸ Added "Two places\.": unknown tour id settings\.nope, first-session — /);
  assert.match(p[0], /obsidian-plugin\/src\/tour\/steps\.json/);
});

test('markerProblems: an empty reason, an empty id list, two markers or a stray comma fail', () => {
  const refs = C.tourRefs(BOOK);
  const one = (from, to) => C.markerProblems(MARKED.replace(from, to), refs);
  assert.match(one('<!-- no-tour: CLI verb -->', '<!-- no-tour:   -->')[0], /:12: \[Unreleased\] ▸ Added "aos local prints it\. It wraps…": no-tour needs a reason/);
  assert.match(one('<!-- tour: core -->', '<!-- tour: -->')[0], /"A tour\. Ten stops\.": the tour marker names no id/);
  assert.match(one('<!-- tour: core -->', '<!-- tour: core,, core.rail -->')[0], /the tour marker names no id/);
  assert.match(one('<!-- tour: core -->', '<!-- tour: core --> <!-- no-tour: also -->')[0], /2 markers — keep one/);
});

test('markerProblems: only Added and Changed need a marker, but a marker anywhere in [Unreleased] must be right', () => {
  const refs = C.tourRefs(BOOK);
  assert.deepEqual(C.markerProblems(MARKED.replace('- A fix with no marker.', '- A fix. <!-- tour: settings.row -->'), refs), []);
  const p = C.markerProblems(MARKED.replace('- A fix with no marker.', '- A fix. <!-- tour: nowhere -->'), refs);
  assert.equal(p.length, 1);
  assert.match(p[0], /\[Unreleased\] ▸ Fixed "A fix\.": unknown tour id nowhere/);
});

test('markerProblems: released sections are never checked, and no [Unreleased] means nothing to check', () => {
  // [0.2.0] holds an unmarked bullet and an id that no longer exists: neither is reported.
  assert.deepEqual(C.markerProblems(MARKED, C.tourRefs(BOOK)), []);
  assert.deepEqual(C.markerProblems(TEXT.replace(/## \[Unreleased\][\s\S]*?(?=## \[0\.2\.0\])/, ''), new Set()), []);
});

test('stripMarkers: the notes never show a marker; text and other comments stay', () => {
  assert.equal(C.stripMarkers('- **A.** One. <!-- tour: core -->\n- B. <!--no-tour: CLI-->\n- C <!-- a note -->'), '- **A.** One.\n- B.\n- C <!-- a note -->');
});

test('main check: the version\'s section and [Unreleased]\'s markers, all problems at once; notes strips markers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-tour-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  fs.mkdirSync(path.join(root, 'obsidian-plugin/src/tour'), { recursive: true });
  fs.writeFileSync(path.join(root, 'obsidian-plugin/src/tour/steps.json'), JSON.stringify(BOOK));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), MARKED);
  const out = []; const errs = [];
  const io = { root, log: (s) => out.push(s), err: (s) => errs.push(s) };
  assert.equal(C.main(['check', 'current'], io), 0);
  assert.match(out.pop(), /\[0\.2\.0\] present; \[Unreleased\] tour markers ok/);

  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), MARKED.replace(' <!-- tour: core -->', '').replace('<!-- tour: settings.local -->', '<!-- tour: settings.gone -->'));
  assert.equal(C.main(['check', 'current'], io), 1);
  assert.equal(errs.filter((e) => /^CHANGELOG\.md:\d+:/.test(e)).length, 2);
  assert.match(errs.join('\n'), /2 problem\(s\) in \[Unreleased\]'s tour markers \(tour C13\)/);
  errs.length = 0;
  assert.equal(C.main(['check', '0.9.0'], io), 1, 'a missing section and the markers are both reported');
  assert.match(errs.join('\n'), /no ## \[0\.9\.0\] section[\s\S]*no tour marker/);

  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), MARKED);
  assert.equal(C.main(['notes', '0.2.0'], io), 0);
  assert.equal(out.pop(), '### Added\n- A released thing with no marker, and one long gone.');
  assert.equal(C.main(['roll', '0.3.0', '--date', '2026-10-15'], io), 0);
  assert.equal(C.main(['notes', '0.3.0'], io), 0);
  assert.doesNotMatch(out.pop(), /<!--/, 'the rolled section keeps its markers in the file, never in the notes');
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /## \[0\.3\.0\] — 2026-10-15[\s\S]*<!-- tour: settings\.local -->/);

  fs.rmSync(path.join(root, 'obsidian-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), MARKED);
  errs.length = 0;
  assert.equal(C.main(['check', 'current'], io), 1, 'no steps.json: no tour id can be known');
  assert.match(errs[0], /steps\.json: cannot read it/);
});

test('this repo: every [Unreleased] Added and Changed bullet carries a marker steps.json knows', () => {
  const root = path.resolve(__dirname, '..');
  const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const book = JSON.parse(fs.readFileSync(path.join(root, 'obsidian-plugin/src/tour/steps.json'), 'utf8'));
  assert.deepEqual(C.markerProblems(text, C.tourRefs(book)), []);
});
