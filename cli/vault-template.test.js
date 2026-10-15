'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const T = path.resolve(__dirname, '..', 'vault-template');
const read = (rel) => fs.readFileSync(path.join(T, rel), 'utf8');
const h2s = (text) => text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));

test('MEMORY.md has the five fixed H2s, each followed by a blank line', () => {
  const m = read('MEMORY.md');
  assert.match(m, /^# Memory Index\n/);
  assert.deepEqual(h2s(m), ['User', 'Feedback (how to work)', 'Project', 'Reference', 'Patterns']);
  for (const h of h2s(m)) assert.ok(m.includes(`## ${h}\n\n`), `blank line after ${h}`);
  assert.ok(!/^- \[/m.test(m), 'no entries shipped');
});

test('SESSION.md is byte-identical to wrap-session.js resetSessionWM() apart from the date', () => {
  const s = read('brain/_index/SESSION.md');
  const expected = `---
type: session
updated: 2026-09-04
---

# Current Session Working Memory

> Ephemeral — cleared/promoted at session end. Max ~400 tokens.
> Use this to track context within the current conversation.

## Active Task

## Key Context This Session

## Decisions Made

## Things to Remember

## Promote to Memory on Close
`;
  assert.equal(s.replace(/^updated: .*$/m, 'updated: 2026-09-04'), expected);
});

test('BRAIN.md placeholder and the three MOCs', () => {
  assert.equal(read('brain/_index/BRAIN.md'), '# BRAIN\n\n_compiled on first scan_\n');
  for (const [file, title] of [['MOC-reference.md', 'Reference'], ['MOC-projects.md', 'Projects'], ['MOC-patterns.md', 'Patterns']]) {
    assert.equal(read(`brain/_index/${file}`), `# ${title}\n\n## Manual index\n`);
  }
});

test('scanner-config.json and brain/config.json', () => {
  assert.deepEqual(JSON.parse(read('brain/_index/scanner-config.json')), {
    extraProjectRoots: [], autoSweepOrphans: false, orphanUuidMinAgeMinutes: 60, sweepTransientResidue: false,
    transientResiduePatterns: [], allowedOrphanHooks: [], fileMapBudgetPerScan: 40,
  });
  assert.deepEqual(JSON.parse(read('brain/config.json')), {});
});

test('profile example, READMEs, daily-note template', () => {
  const body = read('brain/memory/user/profile.md').replace(/^---\n[\s\S]*?\n---\n/, '');
  const firstPara = body.split(/\n\s*\n/).map((b) => b.trim()).find((b) => b && !b.startsWith('#'));
  assert.ok(firstPara && firstPara.length > 40 && firstPara.length < 400, 'first paragraph becomes BRAIN.md ## Who');
  for (const d of ['feedback', 'projects', 'reference']) assert.match(read(`brain/memory/${d}/README.md`), /^# /);
  assert.match(read('brain/patterns/README.md'), /^# /);
  const dn = read('templates/daily-note.md');
  assert.ok(dn.includes('{{date}}'));
  assert.ok(dn.includes('## Claude Code Sessions'));
  assert.ok(!dn.includes('<%'), 'core-plugin syntax only');
  // The three export-allowlisted templates (spec §8.1): core syntax, an H1 from {{title}}, no Templater/Dataview.
  for (const [file, h2] of [['meeting-note.md', '## Action items'], ['decision-record.md', '## Decision'], ['project-note.md', '## Next steps']]) {
    const t = read(`templates/${file}`);
    assert.ok(t.includes('# {{title}}'), `${file}: {{title}} H1`);
    assert.ok(t.includes('{{date}}'), `${file}: {{date}}`);
    assert.ok(t.includes(h2), `${file}: ${h2}`);
    assert.ok(!/<%|dataview/i.test(t), `${file}: core-plugin syntax only`);
  }
});

test('AGENTICOS.md sections; the vault is plain, with no editor settings seeded', () => {
  assert.deepEqual(h2s(read('AGENTICOS.md')), ['Memory System (3-file rule)', 'Capture vocabulary', 'Conventions', 'Providers', 'Routines']);
  // The Workbench is the app (workbench-app D1); a vault opened in Obsidian anyway gets Obsidian's own defaults.
  assert.ok(!fs.existsSync(path.join(T, '.obsidian')), 'no .obsidian/ in the template');
  assert.ok(!/Obsidian/.test(read('AGENTICOS.md').replace(/\.obsidian\//g, '')), 'AGENTICOS.md names no editor');
});

test('AGENTICOS.md fits the Codex conventions block uncut', () => {
  // brain/scripts/inject-conventions.js cuts the file off past MAX_CHARS (9000) when it injects it into a Codex session.
  const n = read('AGENTICOS.md').trim().length;
  assert.ok(n <= 9000, `AGENTICOS.md is ${n} characters; a Codex session would see it cut off past 9000`);
});

test('TODO.md seeds an empty list with Open and Done', () => {
  const t = read('TODO.md');
  assert.match(t, /^# To-Do\n/);
  assert.deepEqual(h2s(t), ['Open', 'Done']);
  assert.ok(!/^- \[/m.test(t), 'no items in the seed');
});

test('_gitignore carries the spec rules and is stored without the dot', () => {
  const g = read('_gitignore');
  for (const line of ['brain/_index/*', '!brain/_index/scanner-config.json', '!brain/_index/MOC-*.md', 'persona/journal/', 'persona/STATE.md', 'persona/answers.json', 'persona/autoapply.json', 'persona/DISABLED', 'persona/flag-closer/', '.obsidian/workspace.json', '.obsidian/plugins/*/data.json', '.obsidian/plugins/*/node_modules/']) {
    assert.ok(g.split('\n').includes(line), `missing rule ${line}`);
  }
  assert.ok(!fs.existsSync(path.join(T, '.gitignore')));
  // graphify spec D8: the graph is a derived cache (and a hand-built one moved aside by aos stays out of git too).
  for (const line of ['brain/graphify-out/', 'brain/graphify-out.pre-aos/']) assert.ok(g.split('\n').includes(line), `missing rule ${line}`);
});

test('.graphifyignore keeps code, caches, the graph itself and templates out of the vault graph', () => {
  const rules = read('.graphifyignore').split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(rules, ['workspaces/', 'brain/scripts/', 'brain/_index/', 'brain/graphify-out/', 'brain/graphify-out.pre-aos/', 'brain/archive/', 'templates/', '.obsidian/']);
});

test('brain/routines seeds the three duty routines (valid, guarded, enabled), the briefing and import-digest commands and a README', () => {
  const store = require('../brain/scripts/lib/routines-store.js');
  const listed = store.list({ dir: path.join(T, 'brain', 'routines') }).filter((r) => r.slug !== 'import-digest');
  assert.deepEqual(store.list({ dir: path.join(T, 'brain', 'routines') }).map((r) => r.slug), ['briefing', 'import-digest', 'monitor', 'reflect', 'sitrep']);
  // The history digest (install-import B10): a command on from the start, which turns itself off when nothing is queued.
  const digest = store.read('import-digest', { dir: path.join(T, 'brain', 'routines') });
  assert.deepEqual([digest.errors, digest.kind, digest.guarded, digest.enabled, digest.schedule], [[], 'command', false, true, '*/30 * * * *']);
  assert.deepEqual(digest.argv, ['{{NODE}}', '{{VAULT}}/brain/scripts/lib/import/digest.js']);
  // Pulse's briefing writer (spec 2026-10-08-pulse-cockpit-design P6): a model-gated command, every 30 minutes in the day.
  const briefing = listed[0];
  assert.deepEqual(briefing.errors, []);
  assert.equal(briefing.kind, 'command');
  assert.equal(briefing.guarded, false);
  assert.equal(briefing.enabled, true);
  assert.equal(briefing.schedule, '*/30 7-22 * * *');
  assert.deepEqual(briefing.argv, ['{{NODE}}', '{{VAULT}}/brain/scripts/persona/briefing.js']);
  const all = listed.slice(1);
  for (const r of all) {
    assert.deepEqual(r.errors, [], r.slug);
    assert.equal(r.kind, 'duty', r.slug);
    assert.equal(r.guarded, true, r.slug);
    assert.equal(r.enabled, true, r.slug);
    assert.match(r.body, new RegExp(`persona/duties/${r.slug}\\.md`), `${r.slug}: body points at its duty prompt`);
  }
  // The cadences the static plists carried before routines existed — a migrated vault keeps its times.
  assert.deepEqual(all.map((r) => r.schedule), ['0 13 * * *', '0 18 * * 0', '45 7 * * 1-5']);
  assert.match(read('brain/routines/README.md'), /^# /);
});

test('persona/routines seeds the watchdog heartbeat (command), the hourly tick (local triage command waking a 0.50 USD read-only duty) and the nightly reflect (duty, 0.50 USD)', () => {
  const store = require('../brain/scripts/lib/routines-store.js');
  const all = store.list({ dir: path.join(T, 'persona', 'routines') });
  assert.deepEqual(all.map((r) => [r.slug, r.kind, r.schedule, r.enabled]), [['heartbeat', 'command', '*/30 * * * *', true], ['reflect-daily', 'duty', '0 22 * * *', true], ['tick', 'command', '0 * * * *', true]]);
  for (const r of all) assert.deepEqual(r.errors, [], r.slug);
  const daily = all.find((r) => r.slug === 'reflect-daily');
  assert.equal(daily.guarded, true);
  assert.equal(daily.budgetUsd, 0.5);
  assert.equal(daily.timeoutSec, 900);
  assert.match(daily.tools, /Bash\(\{\{NODE\}\} \{\{VAULT\}\}\/brain\/scripts\/persona\/reflect\.js:\*\)/);
  assert.match(daily.tools, /Bash\(\{\{NODE\}\} \{\{VAULT\}\}\/brain\/scripts\/persona\/ledger\.js:\*\)/);
  assert.ok(!/git (add|commit|push)/.test(daily.tools), 'the daily reflect never commits');
  assert.match(daily.body, /persona\/duties\/reflect-daily\.md/);
  assert.match(read('persona/duties/reflect-daily.md'), /reflect\.js inputs --days 7/);
  assert.match(read('persona/duties/reflect-daily.md'), /at most two proposals/i);
  assert.ok(!read('persona/duties/reflect-daily.md').includes('brain/reflections'), 'the nightly pass writes no weekly reflection');
  assert.match(read('persona/STATE.template.md'), /- reflect-daily: never/);
  assert.match(read('persona/proposals/README.md'), /surface: <product proposals only/);
  const tick = all.find((r) => r.slug === 'tick');
  assert.equal(tick.guarded, true);
  // local-first A5: the hourly routine is tick.js's local triage; it starts the hosted duty itself, with this budget and allowlist.
  assert.deepEqual(tick.argv, ['{{NODE}}', '{{VAULT}}/brain/scripts/persona/tick.js', '--triage', '--root', '{{VAULT}}']);
  assert.equal(tick.budgetUsd, 0.5);
  assert.equal(tick.timeoutSec, 900);
  assert.equal(tick.budgetUsd, require('../brain/scripts/persona/tick.js').TICK_DUTY.budgetUsd, 'tick.js falls back to the same budget');
  assert.equal(tick.tools, require('../brain/scripts/persona/tick.js').TICK_DUTY.tools, 'and the same allowlist');
  assert.match(tick.tools, /^Read,Glob,Grep,Bash\(date:\*\),Bash\(\{\{NODE\}\} \{\{VAULT\}\}\/brain\/scripts\/persona\/tick\.js:\*\)/);
  assert.ok(!/git/.test(tick.tools), 'the tick never runs git');
  assert.match(tick.body, /persona\/duties\/tick\.md/);
  assert.match(read('persona/duties/tick.md'), /tick\.js signals/);
  assert.match(read('persona/STATE.template.md'), /- tick: never/);
});
