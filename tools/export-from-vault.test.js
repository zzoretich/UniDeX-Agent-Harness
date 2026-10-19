'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, applyScrubs, loadTable, assertSafeDest } = require('./export-from-vault.js');
const { execFileSync, spawnSync } = require('child_process');

// The owner's real table is gitignored (tools/export-scrubs.local.js), so these tests exercise the export with a
// neutral fixture table. Every value here is synthetic; none is a privacy-gate term.
const TABLE = {
  ALLOWLIST: [
    { from: 'brain/scripts', to: 'brain/scripts' },
    { from: 'skills/demo-skill/scripts', to: 'plugin/skills/demo-skill/scripts' },
    { from: 'notes/overview.md', to: 'docs/overview.md' },
    { from: 'not/in/the/vault', to: 'never' },
  ],
  EXCLUDE: [/(^|\/)node_modules(\/|$)/, /(^|\/)package-lock\.json$/, /^test\/retired\.test\.js$/],
  SCRUBS: [
    { file: 'brain/scripts/lib/drafts.js', from: /awaiting [A-Z][a-z]+'s batch approval/, to: "awaiting the owner's batch approval" },
    { file: ['plugin/skills/demo-skill/scripts/a.js', 'plugin/skills/demo-skill/scripts/b.js'], from: /Demo Review/g, to: 'Persona Review' },
    { file: 'docs/overview.md', from: 'Casey', to: 'the owner' },
    { file: 'hud/styles.css', from: 'never exported', to: 'x' },
  ],
};
const EXPORT = path.join(__dirname, 'export-from-vault.js');
const NONE = path.join(os.tmpdir(), 'aos-no-such-terms-file');

function fixtureVault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), body); };
  w('brain/scripts/lib/drafts.js', "// draft rules awaiting Casey's batch approval\nmodule.exports = {};\n");
  w('brain/scripts/node_modules/dep/index.js', 'module.exports = 1;\n');
  w('brain/scripts/package-lock.json', '{}');
  w('brain/scripts/test/retired.test.js', '// kept out by EXCLUDE\n');
  w('skills/demo-skill/scripts/a.js', "const t = 'Demo Review';\n");
  w('skills/demo-skill/scripts/b.js', "const u = 'Demo Review, Demo Review';\n");
  w('notes/overview.md', '# Overview by Casey\n');
  w('notes/private.md', 'never exported');
  return v;
}

function tmpDest() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dest-')); }

test('plan copies only allowlisted files and skips excluded ones', () => {
  const r = plan({ source: fixtureVault(), dest: tmpDest(), force: false, table: TABLE });
  assert.deepEqual(r.copy.map(c => c.file).sort(), [
    'brain/scripts/lib/drafts.js',
    'docs/overview.md',
    'plugin/skills/demo-skill/scripts/a.js',
    'plugin/skills/demo-skill/scripts/b.js',
  ]);
  assert.ok(r.skip.some(s => s.file === 'not/in/the/vault' && s.reason === 'missing in source'));
});

test('scrubs rewrite the copied content and are reported as applied', () => {
  const r = plan({ source: fixtureVault(), dest: tmpDest(), force: false, table: TABLE });
  const text = file => r.copy.find(c => c.file === file).content.toString('utf8');
  assert.match(text('brain/scripts/lib/drafts.js'), /awaiting the owner's batch approval/);
  assert.equal(text('plugin/skills/demo-skill/scripts/b.js'), "const u = 'Persona Review, Persona Review';\n");
  assert.equal(text('docs/overview.md'), '# Overview by the owner\n');
  assert.equal(r.applied.filter(a => a.file.startsWith('plugin/skills/demo-skill/')).length, 2);
});

test('an existing, different destination file is kept unless force', () => {
  const source = fixtureVault();
  const dest = tmpDest();
  fs.mkdirSync(path.join(dest, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'docs', 'overview.md'), '# edited in the repo\n');
  const kept = plan({ source, dest, force: false, table: TABLE });
  assert.deepEqual(kept.differ.map(d => d.file), ['docs/overview.md']);
  assert.ok(!kept.copy.some(c => c.file === 'docs/overview.md'));
  const forced = plan({ source, dest, force: true, table: TABLE });
  assert.ok(forced.copy.some(c => c.file === 'docs/overview.md'));
});

test('a scrub whose file is never exported is reported unmatched by plan()', () => {
  const r = plan({ source: fixtureVault(), dest: tmpDest(), force: false, table: TABLE });
  assert.ok(r.unmatched.some(u => u.file === 'hud/styles.css'));
  assert.ok(!r.copy.some(c => c.file === 'hud/styles.css'));
});

test('applyScrubs records unmatched scrubs so drift is visible', () => {
  const report = { applied: [], unmatched: [] };
  const out = applyScrubs('brain/scripts/lib/drafts.js', 'nothing to scrub here', report, TABLE.SCRUBS);
  assert.equal(out, 'nothing to scrub here');
  assert.equal(report.unmatched.length, 1);
});

test('the example table has the shape the export reads', () => {
  const t = loadTable(path.join(__dirname, 'export-scrubs.example.js'));
  assert.ok(t.ALLOWLIST.every(e => typeof e.from === 'string' && typeof e.to === 'string'));
  assert.ok(t.EXCLUDE.every(re => re instanceof RegExp));
  assert.ok(t.SCRUBS.every(s => (typeof s.from === 'string' || s.from instanceof RegExp) && s.file));
});

test('assertSafeDest refuses a destination inside the Claude config dir', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    assert.throws(() => assertSafeDest(path.join(cfg, 'repo')), /refusing/);
    assert.throws(() => assertSafeDest(cfg), /refusing/);
    assert.doesNotThrow(() => assertSafeDest(path.join(os.tmpdir(), 'elsewhere')));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

/** A vault whose only allowlisted file carries `term` at a path no scrub targets, a one-entry table file for
 *  --scrubs, and a git-initialised destination (runGate() → listFiles() shells `git ls-files`). */
function leakFixture(term) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-leak-'));
  const rel = 'brain/scripts/lib/leaky.js';
  fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
  fs.writeFileSync(path.join(source, rel), `// unscrubbed: ${term}\nmodule.exports = {};\n`);
  const table = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'table-')), 'export-scrubs.local.js');
  fs.writeFileSync(table, "module.exports = { ALLOWLIST: [{ from: 'brain/scripts', to: 'brain/scripts' }], EXCLUDE: [], SCRUBS: [] };\n");
  const dest = tmpDest();
  execFileSync('git', ['init', '-q'], { cwd: dest });
  return { source, rel, table, dest };
}

// The export CLI with only the private terms a test names, outside CI, and clear of the real config dir.
function exportCli(args, extra = {}) {
  const env = { ...process.env, AOS_PRIVACY_TERMS_FILE: NONE, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')) };
  for (const k of ['CI', 'GITHUB_ACTIONS', 'AOS_PRIVACY_TERMS']) delete env[k];
  return spawnSync(process.execPath, [EXPORT, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
}

test('CLI: a private term that survives scrubbing makes the export exit 1', () => {
  const TERM = 'plover';
  const { source, rel, table, dest } = leakFixture(TERM);
  const r = exportCli(['--source', source, '--dest', dest, '--scrubs', table], { AOS_PRIVACY_TERMS: TERM });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /privacy-gate: [1-9]\d* violation\(s\)/);
  assert.ok(r.stdout.includes(`${rel}:1: [${TERM}]`), r.stdout);
  assert.ok(fs.existsSync(path.join(dest, rel)), 'the leaking file is copied before the gate runs');
});

test('CLI: without a table, or without private terms, the export exits 2 and writes nothing', () => {
  const { source, rel, table, dest } = leakFixture('plover');
  const noTable = exportCli(['--source', source, '--dest', dest, '--scrubs', path.join(os.tmpdir(), 'aos-no-such-table.js')], { AOS_PRIVACY_TERMS: 'plover' });
  assert.equal(noTable.status, 2, noTable.stderr);
  assert.match(noTable.stderr, /export-scrubs\.example\.js/);
  const noTerms = exportCli(['--source', source, '--dest', dest, '--scrubs', table]);
  assert.equal(noTerms.status, 2, noTerms.stderr);
  assert.match(noTerms.stderr, /no private terms loaded/);
  assert.ok(!fs.existsSync(path.join(dest, rel)), 'nothing copied');
});
