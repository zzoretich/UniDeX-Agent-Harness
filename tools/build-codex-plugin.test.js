'use strict';
// The suite's own environment even when a check runs this file on its own (parity-check: `node --test <file>`), so
// lib/test-guard.js lets it resolve what it needs: a no-op under `npm test`, which preloads it already.
require('./test-env.js');
/**
 * build-codex-plugin.test.js — codex-plugin/ is generated and committed (design 2026-09-23-codex-plugin D2), so the
 * suite holds the committed tree to a fresh build, and the build to what a published plugin promises: nothing that
 * names the building machine, every command and skill exactly once, and no Claude-only idiom left in a skill that
 * Codex hands to the model as written.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, check, write } = require('./build-codex-plugin.js');
const CH = require('../cli/codex-host.js');

const ROOT = path.resolve(__dirname, '..');

test('the committed codex-plugin/ equals a fresh build (fix: npm run build:codex-plugin)', () => {
  assert.deepEqual(check(build()), []);
});

test('the build is byte-stable, and check reports missing, edited, stale and non-executable files', () => {
  const a = build();
  const b = build();
  assert.deepEqual([...a.keys()], [...b.keys()]);
  for (const [k, v] of a) assert.ok(v.equals(b.get(k)), `${k} differs between two builds`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cxp-'));
  write(a, dir);
  assert.deepEqual(check(a, dir), []);
  fs.writeFileSync(path.join(dir, 'skills', 'extra.md'), 'x');
  fs.writeFileSync(path.join(dir, 'skills', 'wrap', 'SKILL.md'), 'edited');
  fs.rmSync(path.join(dir, '.mcp.json'));
  fs.chmodSync(path.join(dir, 'bin', 'aos'), 0o644);
  assert.deepEqual(check(a, dir).sort(), ['differs skills/wrap/SKILL.md', 'missing .mcp.json', 'not executable bin/aos', 'stale skills/extra.md']);
  write(a, dir);
  assert.deepEqual(check(a, dir), [], 'write replaces the tree, stale files included');
});

test('28 skills: the 21 commands and 9 skills of plugin/, cost and wrap merged, each named, described and marked', () => {
  const files = build();
  const skills = [...files.keys()].filter((k) => /^skills\/[^/]+\/SKILL\.md$/.test(k));
  assert.equal(skills.length, 28);
  const expected = new Set([
    ...fs.readdirSync(path.join(ROOT, 'plugin', 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)),
    ...fs.readdirSync(path.join(ROOT, 'plugin', 'skills')),
  ]);
  assert.deepEqual(skills.map((k) => k.split('/')[1]).sort(), [...expected].sort());
  for (const k of skills) {
    const name = k.split('/')[1];
    const text = files.get(k).toString('utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .{10,}`), `${k}: frontmatter`);
    assert.ok(text.includes(CH.PLUGIN_MARKER), `${k}: plugin marker`);
    assert.ok(!text.includes(CH.GENERATED_MARKER), `${k}: carries the direct-install marker`);
    assert.match(text, new RegExp(`Invoke as \`\\$agenticos:${name}\``), `${k}: host note`);
    // Idioms Codex would hand to the model verbatim. A qualified host phrase ("an interactive Claude Code session")
    // names Claude Code on purpose and is allowed; the routines skill's cloud line is one.
    const idiom = /CLAUDE_PLUGIN_ROOT|mcp__plugin_agenticos|\$ARGUMENTS|\b(?:[Aa]|[Tt]he|[Tt]his|[Yy]our|[Ee]ach|[Ee]very) Claude Code session|AskUserQuestion|with the (?:Read|Edit|Write|Glob|Grep) tool|(?:^|[\s(`"'])\/agenticos:|claude plugin install(?![^\n]*Codex)|--host claude\b/.exec(text);
    assert.equal(idiom, null, `${k}: Claude-only idiom left: ${idiom && idiom[0]}`);
  }
  assert.match(files.get('skills/routines/SKILL.md').toString('utf8'), /refreshed from an interactive Claude Code session/, 'Claude Code cloud routines stay Claude Code');
  assert.match(files.get('skills/feedback-review/SKILL.md').toString('utf8'), /question to the user is one message/, 'a skill that asks explains how under Codex');
  const wrap = files.get('skills/wrap/SKILL.md').toString('utf8');
  assert.match(wrap, /## The `\$agenticos:wrap` procedure/, 'the command steps are appended to the skill of the same name');
  assert.match(wrap, /sh "<plugin root>\/bin\/aos" wrap-session/);
  assert.match(wrap, /mcp__agenticos__wrap_session/);
  assert.match(files.get('skills/persona-flag-closer/SKILL.md').toString('utf8'), /SKILL_DIR = <plugin root>\/skills\/persona-flag-closer/);
  assert.ok(files.has('skills/persona-flag-closer/scripts/collect.js'), 'skill scripts travel with the skill');
  assert.match(files.get('skills/remember/SKILL.md').toString('utf8'), /\$\{CLAUDE_CONFIG_DIR:-~\/\.claude\}\/agenticos\.json/, 'the config expression the launcher resolves is kept');
});

test('no generated file names a path on the building machine', () => {
  for (const [k, v] of build()) {
    const s = v.toString('utf8');
    assert.ok(!s.includes(os.homedir()), `${k} names the home directory`);
    assert.ok(!s.includes(ROOT), `${k} names the checkout`);
    assert.ok(!s.includes('aos-codex-plugin-'), `${k} names the build's scratch directory`);
  }
});
