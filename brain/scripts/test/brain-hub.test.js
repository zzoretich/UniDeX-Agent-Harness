'use strict';
// brain/_index/brain-hub.json (brain-hub D11, D12): counts, session batches, duplicates and clusters (with and without
// an embed index), hygiene findings and "looks shipped", built from a temp vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildBrainHub, findDuplicates, findClusters, jaccard } = require('../brain-hub.js');
const { buildRecallIndex, saveIndex } = require('../sdk/lib/recall.js');
const usage = require('../lib/memory-usage.js');

const SID = '2f25a8d9-0000-4000-8000-000000000001';
const put = (v, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), text);
};
function mem({ type = 'feedback', title, body, status = 'active', reviewed = 'false', session = SID, kind = 'memory', extra = '' }) {
  return `---\ntype: ${kind}\ntags: [memory/${type}, status/${status}]\ncreated: 2026-10-11\nupdated: 2026-10-11\nsource: auto-wrap\nsession: ${session}\nreviewed: ${reviewed}\n${extra}---\n\n# ${title}\n\n${body}\n`;
}
const BODIES = {
  picker: 'When a decision is the user\'s to make, present it as an option picker with two to four options and the recommended one first.',
  ci: 'Gitleaks flags email-shaped strings in commits; the hosted macOS runners have a 1024 pixel screen; Linux truncates mtimes.',
  tide: 'The tide parser reads the harbour tables and caches chart tiles for offline use on the boat.',
  resume: 'Resume a Codex thread with codex resume and the folder flag so it never prompts for the folder.',
  scans: 'The harness close waits for the detached scan to finish before deleting the fixture vault.',
  release: 'Released the Pulse cockpit with the briefing band in the app update.',
};

function fixture(prefix) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  put(v, 'brain/_index/.keep', '');
  put(v, 'brain/memory/feedback/present-decisions-as-option-pickers.md', mem({ title: 'Present decisions as option pickers', body: BODIES.picker }));
  put(v, 'brain/memory/feedback/present-decisions-as-an-option-picker.md', mem({ title: 'Present decisions as an option picker', body: BODIES.picker + ' Use pickers for merges too.', session: 'in-session' }));
  put(v, 'brain/memory/reference/unidex-ci-gotchas.md', mem({ type: 'reference', title: 'UniDeX CI gotchas', body: BODIES.ci, kind: 'reference' }));
  put(v, 'brain/memory/reference/tide-tables.md', mem({ type: 'reference', title: 'Tide tables', body: BODIES.tide, reviewed: 'true' }));
  put(v, 'brain/memory/feedback/codex-resume-folder.md', mem({ title: 'Codex resume -C', body: BODIES.resume }));
  put(v, 'brain/memory/feedback/close-waits-for-scans.md', mem({ title: 'Close waits for detached scans', body: BODIES.scans }));
  put(v, 'brain/memory/projects/pulse-cockpit-1-5-0.md', mem({ type: 'projects', title: 'Pulse Cockpit 1.5.0 Release', body: BODIES.release, reviewed: 'true' }));
  put(v, 'brain/memory/projects/brain-hub.md', mem({ type: 'projects', title: 'Brain hub', body: 'The hub is being designed.', reviewed: 'true' }));
  put(v, 'brain/memory/reference/old-note.md', mem({ type: 'reference', title: 'An archived note', body: BODIES.tide, status: 'archived' }));
  put(v, 'brain/memory/feedback/_drafts/codex-resume-folder.md', '---\ntags: [memory/feedback, status/draft]\ndescription: left behind\n---\n\n# Codex resume -C\n\nbody\n');
  put(v, 'brain/patterns/one.md', '# One\n');
  put(v, 'brain/reflections/2026-40.md', '# Week\n');
  put(v, 'MEMORY.md', [
    '# Memory Index', '', '## Feedback',
    '- [Present decisions as option pickers](brain/memory/feedback/present-decisions-as-option-pickers.md) — pickers for decisions',
    '- [Present decisions as an option picker](brain/memory/feedback/present-decisions-as-an-option-picker.md) — pickers again',
    '- [Codex resume -C](brain/memory/feedback/codex-resume-folder.md) — no folder prompt',
    '- [Close waits](brain/memory/feedback/close-waits-for-scans.md) — close waits for scans',
    '', '## Reference',
    '- [UniDeX CI gotchas](brain/memory/reference/unidex-ci-gotchas.md) — gitleaks, 1024 px, mtimes',
    '- [Gone](brain/memory/reference/no-such-file.md) — a broken line',
    '', '## Projects',
    '- [Pulse Cockpit 1.5.0 Release](brain/memory/projects/pulse-cockpit-1-5-0.md) — shipped the cockpit',
    '- [Brain hub](brain/memory/projects/brain-hub.md) — designing the hub',
    '', '## Patterns',
    '- [Tide tables](brain/memory/reference/tide-tables.md) — under the wrong heading',
    '',
  ].join('\n'));
  put(v, 'brain/_index/session-index.json', JSON.stringify({ schema: 1, files: { [`/x/${SID}.jsonl`]: { host: 'claude', head: { id: SID, title: 'Spaces redesign wrap-up' }, title: 'Spaces redesign wrap-up' } } }));
  put(v, 'brain/_index/promote-log.jsonl', `${JSON.stringify({ ts: '2026-10-11T04:36:00.000Z', session: SID, action: 'written', slug: 'close-waits-for-scans', type: 'feedback', title: 'Close waits' })}\n`);
  saveIndex(buildRecallIndex({ vault: v, now: Date.parse('2026-10-11T12:00:00Z') }), v);
  return v;
}

test('counts leave archived memories out and count drafts, patterns and reflections', () => {
  const v = fixture('bh-counts-');
  const hub = buildBrainHub({ vault: v, cfg: {}, now: Date.parse('2026-10-11T12:00:00Z') });
  assert.equal(hub.schema, 1);
  assert.deepEqual(hub.counts, {
    memories: 8, byType: { user: 0, feedback: 4, projects: 2, reference: 2 }, unreviewed: 5, drafts: 1, patterns: 1, reflections: 1, archived: 1, superseded: 0,
  });
  assert.ok(fs.existsSync(path.join(v, 'brain/_index/brain-hub.json')));
});

test('batches group unreviewed memories by session, titled from the session index, newest first', () => {
  const v = fixture('bh-batches-');
  const hub = buildBrainHub({ vault: v, cfg: {}, now: Date.parse('2026-10-11T12:00:00Z'), write: false });
  const real = hub.batches.find((b) => b.session === SID);
  assert.equal(real.title, 'Spaces redesign wrap-up');
  assert.equal(real.host, 'claude');
  assert.equal(real.paths.length, 4);
  assert.equal(real.at, '2026-10-11T04:36:00.000Z', 'the trail\'s written time');
  assert.ok(real.lead);
  const inSession = hub.batches.find((b) => b.key.startsWith('in-session'));
  assert.match(inSession.title, /^In-session wrap · 2026-10-11$/);
  assert.deepEqual(inSession.paths, ['brain/memory/feedback/present-decisions-as-an-option-picker.md']);
  assert.equal(fs.existsSync(path.join(v, 'brain/_index/brain-hub.json')), false, 'write: false writes nothing');
});

test('without an embed index the near-identical pair is flagged on text and title, and nothing unrelated is', () => {
  const v = fixture('bh-dups-');
  const hub = buildBrainHub({ vault: v, cfg: {}, write: false });
  assert.deepEqual(hub.dups.map((d) => [d.a, d.b]), [[
    'brain/memory/feedback/present-decisions-as-an-option-picker.md',
    'brain/memory/feedback/present-decisions-as-option-pickers.md',
  ]]);
  assert.equal(hub.dups[0].meaning, null);
  assert.ok(hub.dups[0].score >= 0.8);
});

test('"Not duplicates" keeps a pair out', () => {
  const v = fixture('bh-notdup-');
  put(v, 'brain/_index/memory-notdup.json', JSON.stringify({ schema: 1, pairs: [[
    'brain/memory/feedback/present-decisions-as-option-pickers.md', 'brain/memory/feedback/present-decisions-as-an-option-picker.md',
  ]] }));
  assert.deepEqual(buildBrainHub({ vault: v, cfg: {}, write: false }).dups, []);
});

test('an embed index adds meaning: it lifts a pair alike in meaning, and alone (no shared words) never flags one', () => {
  const v = fixture('bh-embed-');
  // Unit vectors: CI gotchas and Close waits point the same way; everything else is spread out.
  const dims = 8;
  const unit = (i) => Array.from({ length: dims }, (_, k) => (k === i ? 1 : 0));
  const near = unit(0);
  const vec = {
    'brain/memory/reference/unidex-ci-gotchas.md': unit(0), 'brain/memory/feedback/close-waits-for-scans.md': near,
    'brain/memory/feedback/present-decisions-as-option-pickers.md': unit(2), 'brain/memory/feedback/present-decisions-as-an-option-picker.md': unit(2),
    'brain/memory/reference/tide-tables.md': unit(3), 'brain/memory/feedback/codex-resume-folder.md': unit(4),
    'brain/memory/projects/pulse-cockpit-1-5-0.md': unit(5), 'brain/memory/projects/brain-hub.md': unit(6),
  };
  const recallIdx = JSON.parse(fs.readFileSync(path.join(v, 'brain/_index/recall-index.json'), 'utf8'));
  const embedIdx = { model: 't', dims, files: {}, chunks: Object.entries(vec).map(([p, x]) => ({ path: p, part: 0, vec: x })) };
  const live = require('../lib/memory-ops.js').listMemories(v).filter((m) => m.live);
  const key = (d) => [d.a, d.b].sort().join(' ~ ');
  const CI = 'brain/memory/feedback/close-waits-for-scans.md ~ brain/memory/reference/unidex-ci-gotchas.md';
  const PICK = 'brain/memory/feedback/present-decisions-as-an-option-picker.md ~ brain/memory/feedback/present-decisions-as-option-pickers.md';
  // dupScore 0.6 puts the cluster edge at 0.5, the most a pair with no shared words can reach on meaning alone.
  const opts = { recallIdx, notdup: new Set(), dupScore: 0.6 };
  const withM = findDuplicates(live, { ...opts, embedIdx });
  const without = findDuplicates(live, { ...opts, embedIdx: null });
  // The scores of every pair, so a pair under the cluster edge reads as 0.
  const score = (r, k) => (r.near.find((d) => key(d) === k) || { score: 0 }).score;
  assert.ok(score(withM, CI) > score(without, CI), 'meaning lifts the pair');
  assert.ok(!withM.pairs.some((d) => key(d) === CI), 'meaning alone (no shared words) is not a duplicate');
  assert.equal(withM.near.find((d) => key(d) === CI).meaning, 1);
  assert.ok(withM.pairs.some((d) => key(d) === PICK), 'the real duplicate still flags with an embed index');
});

test('hygiene finds the old type: shape, copyable descriptions, missing, misfiled and broken index lines and leftover drafts', () => {
  const v = fixture('bh-hyg-');
  const h = buildBrainHub({ vault: v, cfg: {}, write: false }).hygiene;
  assert.deepEqual(h.sources, { 'auto-wrap': 8 });
  assert.deepEqual(h.oldType, ['brain/memory/reference/unidex-ci-gotchas.md']);
  assert.ok(h.noDescription.includes('brain/memory/feedback/codex-resume-folder.md'));
  assert.deepEqual(h.unindexed, []);
  assert.deepEqual(h.misfiled, ['brain/memory/reference/tide-tables.md']);
  assert.deepEqual(h.brokenIndex, ['brain/memory/reference/no-such-file.md']);
  assert.deepEqual(h.leftoverDrafts, ['codex-resume-folder']);
});

test('an active project naming a release reads as shipped; one in flight does not', () => {
  const v = fixture('bh-shipped-');
  assert.deepEqual(buildBrainHub({ vault: v, cfg: {}, write: false }).shipped, [{ path: 'brain/memory/projects/pulse-cockpit-1-5-0.md', why: '1.5.0' }]);
});

test('usage comes from the log and its rollup', () => {
  const v = fixture('bh-usage-');
  usage.logUsage({ vault: v, how: 'recalled', paths: ['brain/memory/reference/tide-tables.md'], host: 'codex', cfg: {}, now: new Date('2026-10-10T00:00:00Z') });
  const u = buildBrainHub({ vault: v, cfg: {}, now: Date.parse('2026-10-11T12:00:00Z'), write: false }).usage;
  assert.equal(u.since, '2026-10-10T00:00:00.000Z');
  assert.equal(u.paths['brain/memory/reference/tide-tables.md'].codex, 1);
});

test('a cluster past twelve splits on stronger pairs instead of becoming one topic-sized group', () => {
  const byPath = new Map();
  const near = [];
  const node = (i) => { const p = `brain/memory/projects/release-${i}.md`; byPath.set(p, { title: `UniDeX release ${i}` }); return p; };
  for (let i = 0; i < 15; i++) near.push({ a: node(i), b: node(i + 1), score: i === 7 ? 0.7 : 0.9 });
  const out = findClusters(near, byPath, 3);
  assert.ok(out.every((c) => c.paths.length <= 12), JSON.stringify(out.map((c) => c.paths.length)));
  assert.equal(out.length, 2);
  assert.equal(out[0].label, 'release unidex');
});

test('title similarity ignores stop words', () => {
  assert.equal(jaccard('The tide parser', 'A tide parser'), 1);
  assert.equal(jaccard('Present decisions', ''), 0);
});

test('batch titles follow the Sessions rule per host: own title, else Codex thread name, else the first prompt', () => {
  const { sessionTitles } = require('../brain-hub.js');
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-hub-titles-'));
  const codexHome = path.join(v, 'codex-home');
  const CX = '01a12293-e107-7c51-be41-345c2e1df22b';
  const CX2 = '01a11ce9-90d8-7682-bb28-0fb6c8c26c12';
  const CL = '2f25a8d9-0000-4000-8000-000000000009';
  put(v, 'brain/_index/session-index.json', JSON.stringify({ schema: 1, files: {
    [`/c/${CX}.jsonl`]: { host: 'codex', title: null, head: { id: CX, title: null, firstPrompt: 'Sketch the depth contours layer' } },
    [`/c/${CX2}.jsonl`]: { host: 'codex', title: null, head: { id: CX2, title: null, firstPrompt: 'Reply with one word:\n  ok' } },
    [`/l/${CL}.jsonl`]: { host: 'claude', title: null, head: { id: CL, title: null, firstPrompt: 'Fix the tide parser' } },
  } }));
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id: CX, thread_name: 'Chart depth layer', updated_at: '2026-10-09T21:40:00Z' })}\n`);
  const t = sessionTitles(v, { cfg: {}, env: { CODEX_HOME: codexHome } });
  assert.deepEqual(t.get(CX), { title: 'Chart depth layer', host: 'codex' });
  assert.deepEqual(t.get(CX2), { title: 'Reply with one word: ok', host: 'codex' });
  assert.deepEqual(t.get(CL), { title: 'Fix the tide parser', host: 'claude' });
  // No Codex index at all: the first prompt still names the batch.
  assert.equal(sessionTitles(v, { cfg: {}, env: { CODEX_HOME: path.join(v, 'none') } }).get(CX).title, 'Sketch the depth contours layer');
});
