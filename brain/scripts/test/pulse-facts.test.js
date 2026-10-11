'use strict';
// lib/pulse-facts.js (spec 2026-10-08-pulse-cockpit-design P8, P9). The fixture vault is shared with the Workbench's
// obsidian-plugin/src/data/pulseFacts.test.ts, which checks the TypeScript twin gives the same facts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PF = require('../lib/pulse-facts.js');

const VAULT = path.join(__dirname, 'fixtures', 'pulse-vault');
const NOW = new Date(2026, 9, 8, 19, 24);   // local time: the fixture's times carry no offset

const factsOf = (vault = VAULT, now = NOW) => PF.facts(PF.read(vault, { now }), now);

test('the fixture: needs-you in tier order (broken, decisions, stale, breaking, unread, review), oldest first inside a tier, undated last', () => {
  const f = factsOf();
  assert.equal(f.schema, 1);
  assert.equal(f.persona, 'Beacon');
  assert.deepEqual(f.needsYou.map((n) => [n.tier, n.kind, n.title]), [
    [0, 'error', '2 hook references in settings.json point to non-existent files'],
    [1, 'proposal', 'Tidy the memory index'],
    [1, 'flag', 'Duty writes denied in unattended runs'],
    [1, 'proposal', 'Weekly digest'],
    [1, 'gate', 'lab gate: Ship the landing page'],
    [1, 'flag', 'Duty log rotated twice in one day'],
    [1, 'drafts', '2 feedback drafts waiting for review'],
    [2, 'overdue', '1 overdue to-do'],
    [2, 'routine', 'sitrep failed 2 times in a row'],
    [2, 'pipeline', 'auto-cost failed'],
    [2, 'pipeline', 'build-brain-md is stale'],
    [3, 'breaking', 'Vault backup: push failed'],
    [4, 'unread', '2 unread: The Evening News, Thursday brief'],
    [4, 'today', '1 to-do due today'],
    [5, 'review', '1 memory written today, not yet reviewed'],
  ]);
  for (const n of f.needsYou) assert.ok(PF.AREAS.includes(n.area), n.area);
  assert.deepEqual(f.needsYou.map((n) => n.tone), ['danger', 'gate', 'warn', 'gate', 'gate', 'warn', 'gate', 'warn', 'danger', 'danger', 'warn', 'danger', 'info', 'info', 'off']);
});

test('the fixture: the summary per area', () => {
  const s = factsOf().summary;
  assert.deepEqual(s.health, { errors: 1, warnings: 2, notes: 1, pipelines: { total: 12, ok: 1, neutral: 9, stale: 1, failed: 1 } });
  assert.deepEqual(s.decisions, { proposals: 2, gates: 1, flags: 2, drafts: 2, oldestDays: 16 });
  assert.deepEqual(s.notifications, { total: 4, unread: 3, breaking: 1, alerts: 0, latest: { title: 'The Evening News', from: 'news', created: '2026-10-08T18:01:00' } });
  assert.deepEqual(s.todo, { open: 4, done: 1, overdue: 1, today: 1 });
  assert.deepEqual(s.routines, { total: 2, failing: 1 });
  assert.deepEqual(s.memory, { writtenToday: 2, pendingReview: 1, drafts: 2 });
  assert.deepEqual(s.workspaces, { total: 3, active: 2 });   // the fixture's _spikes and _archive/old-chart are hidden (spaces-redesign D22)
  assert.deepEqual(s.spend, { usd: 0.41, calls: 2 });   // today's rows only
});

test('a routine:<slug> pipeline row never counts as a pipeline (Routines judge it by its fail streak)', () => {
  const f = PF.facts({ pipelines: { 'routine:reflect': { lastRun: { startedAt: '2026-10-04T18:00:00', status: 'ok' } } } }, NOW);
  assert.equal(f.summary.health.pipelines.total, Object.keys(PF.PIPELINE_STALE_MS).length);
  assert.equal(f.needsYou.length, 0);
});

test('pipeline health follows the Workbench classifier: running past 10 minutes died, disabled and skipped are neutral, null windows never go stale', () => {
  const now = NOW.getTime();
  const at = (minAgo) => new Date(now - minAgo * 60e3).toISOString();
  assert.equal(PF.pipelineHealth('scan-vault', { lastRun: { startedAt: at(11), status: 'running' } }, now), 'died');
  assert.equal(PF.pipelineHealth('scan-vault', { lastRun: { startedAt: at(5), status: 'running' } }, now), 'ok');
  assert.equal(PF.pipelineHealth('scan-vault', { lastRun: { startedAt: at(50), status: 'ok' } }, now), 'stale');
  assert.equal(PF.pipelineHealth('file-map', { lastRun: { startedAt: at(60 * 24 * 9), status: 'ok' } }, now), 'ok');
  assert.equal(PF.pipelineHealth('embed-vault', { lastRun: { startedAt: at(1), status: 'disabled' } }, now), 'neutral');
  assert.equal(PF.pipelineHealth('graph-semantic', { lastRun: { startedAt: at(1), status: 'skipped' } }, now), 'neutral');
  assert.equal(PF.pipelineHealth('some-new-stage', { lastRun: { startedAt: at(61), status: 'ok' } }, now), 'stale');
  assert.equal(PF.pipelineHealth('scan-vault', undefined, now), 'neutral');
});

test('the hash ignores spend and dates but follows every item and count', () => {
  const inputs = PF.read(VAULT, { now: NOW });
  const base = PF.facts(inputs, NOW).hash;
  assert.equal(PF.facts({ ...inputs, spend: { usd: 9, calls: 40 } }, NOW).hash, base, 'the briefing call itself never makes the facts new');
  assert.notEqual(PF.facts({ ...inputs, drafts: 3 }, NOW).hash, base);
  assert.notEqual(PF.facts({ ...inputs, notifications: inputs.notifications.slice(1) }, NOW).hash, base);
});

test('an empty vault reads as empty facts, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-empty-'));
  try {
    const f = factsOf(dir);
    assert.equal(f.persona, null);
    assert.deepEqual(f.needsYou, []);
    assert.equal(f.summary.todo.open, 0);
    assert.equal(f.summary.notifications.latest, null);
    assert.equal(f.summary.decisions.oldestDays, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hidden workspaces (`_` folders, _archive/) are left out of the counts (spaces-redesign D22)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-hidden-'));
  try {
    fs.mkdirSync(path.join(dir, 'brain', '_index'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'brain', '_index', 'snapshot.json'), JSON.stringify({ workspaces: [
      { name: 'harbor-map', status: 'active', hidden: false },
      { name: 'old-site', status: 'idle' },
      { name: '_spikes', status: 'active', hidden: true, hiddenReason: 'underscore' },
      { name: '_archive/x', label: 'x', status: 'idle', hidden: true, hiddenReason: 'archived' },
    ] }));
    assert.deepEqual(PF.read(dir, { now: NOW }).workspaces, [{ name: 'harbor-map', status: 'active' }, { name: 'old-site', status: 'idle' }]);
    assert.deepEqual(factsOf(dir).summary.workspaces, { total: 2, active: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('to-do items: open, done and the 📅 due date; an indented line is a child, not an item (todos.ts parseTodos)', () => {
  assert.deepEqual(PF.todoItems('- [ ] a 📅 2026-10-01\n* [x] b ✅ 2026-10-02\n  - [ ] a child\nnot an item\n- [X] c'), [
    { done: false, due: '2026-10-01' }, { done: true, due: null }, { done: true, due: null },
  ]);
});

test('a proposal is titled by its first heading, else its slug; filed by its frontmatter, else its file name', () => {
  assert.deepEqual(PF.proposalOf('2026-09-01-x.md', '---\nfiled: 2026-09-02\n---\n\n# Do the thing\n'), { title: 'Do the thing', filed: '2026-09-02' });
  assert.deepEqual(PF.proposalOf('2026-09-01-make-it-so.md', 'no heading'), { title: 'make-it-so', filed: '2026-09-01' });
});

test('a memory written today is pending only while it is live and unreviewed: archive and supersede keep `reviewed: false` (brain-hub D5, D7)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-retired-'));
  try {
    const mem = (slug, tags, extra = '') => `---\ntype: memory\ntags: [memory/feedback, ${tags}]\ncreated: 2026-10-08\nreviewed: false\n${extra}---\n\n# ${slug}\n\nBody.\n`;
    fs.mkdirSync(path.join(dir, 'brain', 'memory', 'feedback'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'brain', '_index'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'brain', 'memory', 'feedback', 'waits.md'), mem('waits', 'status/active'));
    fs.writeFileSync(path.join(dir, 'brain', 'memory', 'feedback', 'archived.md'), mem('archived', 'status/archived', 'status_before: active\narchived: 2026-10-08\n'));
    fs.writeFileSync(path.join(dir, 'brain', 'memory', 'feedback', 'superseded.md'), mem('superseded', 'status/superseded', 'superseded_by: brain/memory/feedback/waits.md\n'));
    // `reviewed: false` in the body is not the frontmatter's.
    fs.writeFileSync(path.join(dir, 'brain', 'memory', 'feedback', 'kept.md'), mem('kept', 'status/active').replace('reviewed: false\n', 'reviewed: true\n').replace('Body.', 'reviewed: false'));
    const rows = ['waits', 'archived', 'superseded', 'kept'].map((slug, i) => JSON.stringify({ ts: `2026-10-08T0${i + 1}:00:00`, action: 'written', slug, type: 'feedback', title: slug }));
    fs.writeFileSync(path.join(dir, 'brain', '_index', 'promote-log.jsonl'), `${rows.join('\n')}\n`);
    const inputs = PF.read(dir, { now: NOW });
    assert.deepEqual(inputs.trail.map((r) => [r.slug, r.pending]), [['waits', true], ['archived', false], ['superseded', false], ['kept', false]]);
    const f = PF.facts(inputs, NOW);
    assert.deepEqual(f.summary.memory, { writtenToday: 4, pendingReview: 1, drafts: 0 });
    assert.deepEqual(f.needsYou.map((n) => n.title), ['1 memory written today, not yet reviewed']);
    assert.equal(PF.pendingReview(null), false);
    assert.equal(PF.pendingReview('reviewed: false\n'), false, 'no frontmatter, no memory');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
