'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fdrafts-'));
for (const d of ['brain/_index', 'brain/memory/feedback/_drafts']) {
  fs.mkdirSync(path.join(TMP, d), { recursive: true });
}
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
fs.writeFileSync(path.join(TMP, 'MEMORY.md'), '# Index\n');
process.env.BRAIN_VAULT = TMP;
const {
  METRICS_PATH, logEvent, readEvents, writeDraft, listDrafts,
  applyDraft, rejectDraft, activeRuleTitles,
} = require('../lib/feedback-drafts.js');

const DRAFT = {
  title: 'Ask before force-pushing any branch',
  description: 'user reverted an unrequested force push this session',
  body: 'Never force-push without an explicit ask.\n\n**Why:** rewrote a shared branch.\n\n**How to apply:** plain push; if rejected, ask.\n\n**Evidence:** "I did not ask you to force push"',
  session: 'sess-d1',
};

beforeEach(() => {
  fs.rmSync(path.join(TMP, 'brain', 'memory', 'feedback'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts'), { recursive: true });
  try { fs.unlinkSync(METRICS_PATH); } catch {}
  try { fs.unlinkSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl')); } catch {}
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'), '# Index\n');
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('writeDraft creates a full-rule-format file and listDrafts round-trips it', () => {
  const { draftPath, slug } = writeDraft(DRAFT);
  assert.equal(slug, 'ask-before-force-pushing-any-branch');
  const raw = fs.readFileSync(draftPath, 'utf8');
  assert.match(raw, /tags: \[memory\/feedback, status\/draft\]/);
  assert.match(raw, /source: feedback-autoloop/);
  assert.match(raw, /session: sess-d1/);
  assert.match(raw, /# Ask before force-pushing any branch/);
  assert.match(raw, /\*\*Why:\*\*/);
  assert.match(raw, /\*\*How to apply:\*\*/);
  const [d] = listDrafts();
  assert.equal(d.title, DRAFT.title);
  assert.equal(d.description, DRAFT.description);
  assert.equal(d.session, 'sess-d1');
  assert.match(d.body, /\*\*Evidence:\*\*/);
  assert.throws(() => writeDraft(DRAFT), /draft already exists/);
});

test('applyDraft promotes through memory-writer and deletes the draft', () => {
  writeDraft(DRAFT);
  const res = applyDraft('ask-before-force-pushing-any-branch');
  assert.equal(res.memoryPath, 'brain/memory/feedback/ask-before-force-pushing-any-branch.md');
  assert.ok(fs.existsSync(path.join(TMP, res.memoryPath)));
  assert.equal(listDrafts().length, 0);
  assert.match(fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf8'), /Ask before force-pushing/);
  assert.equal(readEvents({ sinceDays: 1 }).filter((r) => r.event === 'applied').length, 1);
});

test('applyDraft logs a written trail row with its time, so the hub sorts the rule by its approval; nothing else changes', () => {
  const { DRAFTS_DIR, parseDraft } = require('../lib/feedback-drafts.js');
  const { writeMemory } = require('../lib/memory-writer.js');
  const slug = 'ask-before-force-pushing-any-branch';
  writeDraft(DRAFT);
  const draft = parseDraft(path.join(DRAFTS_DIR, `${slug}.md`));
  const before = Date.now();
  const res = applyDraft(slug);
  const after = Date.now();
  assert.deepEqual(res, { memoryPath: `brain/memory/feedback/${slug}.md`, slug, indexUpdated: true });

  const rows = fs.readFileSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  const { ts, ...rest } = rows[0];
  assert.deepEqual(rest, { session: 'sess-d1', action: 'written', slug, type: 'feedback', title: DRAFT.title, path: res.memoryPath });
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(ts) >= before && Date.parse(ts) <= after, 'the row carries the approval time');

  // brain-hub.js reads the row: the rule's batch is dated by the approval, not by the draft's created day.
  const { buildBrainHub } = require('../brain-hub.js');
  const batch = buildBrainHub({ vault: TMP, write: false }).batches.find((b) => b.paths.includes(res.memoryPath));
  assert.deepEqual(batch.paths, [res.memoryPath]);
  assert.equal(batch.at, ts);

  // The rule is byte for byte what memory-writer writes for the same fields, its MEMORY.md line and its event as before.
  const twin = writeMemory({ type: 'feedback', slug: 'twin-rule', title: draft.title, description: draft.description, body: draft.body, source: 'feedback-autoloop', session: draft.session });
  assert.equal(fs.readFileSync(path.join(TMP, res.memoryPath), 'utf8'), fs.readFileSync(path.join(TMP, twin.memoryPath), 'utf8'));
  assert.ok(fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf8').includes(`- [${DRAFT.title}](${res.memoryPath}) — ${DRAFT.description}`));
  assert.deepEqual(readEvents({ sinceDays: 1 }).map((r) => [r.event, r.slug, r.session, r.title]), [['applied', slug, 'sess-d1', DRAFT.title]]);
});

test('rejectDraft deletes, trail-logs reverted, and logs a rejected event', () => {
  writeDraft(DRAFT);
  rejectDraft('ask-before-force-pushing-any-branch');
  assert.equal(listDrafts().length, 0);
  const { revertedSlugs } = require('../lib/promote-log.js');
  assert.ok(revertedSlugs().has('ask-before-force-pushing-any-branch'));
  assert.equal(readEvents({ sinceDays: 1 }).filter((r) => r.event === 'rejected').length, 1);
});

test('activeRuleTitles reads H1s of active rules and ignores _drafts', () => {
  fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'feedback', 'some-rule.md'),
    '---\ntype: memory\n---\n\n# Lead with the recommendation\n\nbody\n');
  writeDraft(DRAFT);
  assert.deepEqual(activeRuleTitles(), ['Lead with the recommendation']);
  // A rule retired in the Brain tab no longer covers a correction (brain-hub D5, D7), inline or block-list tags alike.
  fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'feedback', 'retired-rule.md'),
    '---\ntype: memory\ntags: [memory/feedback, status/archived]\n---\n\n# A retired rule\n');
  fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'feedback', 'merged-rule.md'),
    '---\ntype: memory\ntags:\n  - memory/feedback\n  - status/superseded\n---\n\n# A merged rule\n');
  assert.deepEqual(activeRuleTitles(), ['Lead with the recommendation']);
});

test('readEvents filters by age and survives corrupt lines', () => {
  logEvent({ event: 'captured', session: 's', title: 'x' });
  fs.appendFileSync(METRICS_PATH, 'not json\n');
  const old = JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', event: 'captured', title: 'old' });
  fs.appendFileSync(METRICS_PATH, old + '\n');
  const rows = readEvents({ sinceDays: 7 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'x');
});
