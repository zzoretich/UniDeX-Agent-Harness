'use strict';
// lib/memory-merge.js (brain-ai A1, A2, A4, A5, A8, A9; plan PR 4 "Merge rules"): the draft per mode through a fake AI
// seam (an answer, each provider error, an unreadable reply), the no-model prefill, the prompt's cuts, escaping, merge's
// exact writes and refusals, unmerge byte for byte and its refusal after an edit, and the record prune. No model, no
// network: every call goes to the fake `ai` object.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mm = require('../lib/memory-merge.js');
const ops = require('../lib/memory-ops.js');
const { ProviderUnavailable } = require('../sdk/lib/spend-ledger.js');

const A = 'brain/memory/feedback/small-diffs.md';
const B = 'brain/memory/feedback/small-diffs-in-review.md';
const C = 'brain/memory/projects/review-rules.md';
const TEXT_A = '---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-09-01\nupdated: 2026-09-01\nsource: auto-wrap\nsession: s1\nreviewed: false\ndescription: keep diffs small\n---\n\n# Small diffs\n\nKeep each diff small.\n\nWhy: reviewers read every line.\n';
const TEXT_B = '---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-09-20\nupdated: 2026-09-20\nsource: auto-wrap\nsession: s2\nreviewed: true\npin: true\ndescription: reviewers want small diffs\n---\n\n# Small diffs in review\n\nSplit a review over 400 lines.\n';
// No created: sorts last.
const TEXT_C = '---\ntype: memory\ntags: [memory/projects, status/active]\nreviewed: false\ndescription: the review rules\n---\n\n# Review rules\n\nOne approval, then merge.\n';
const INDEX = `# Index\n\n## Feedback\n- [Small diffs](${A}) — keep diffs small\n- [Small diffs in review](${B}) — reviewers want small diffs\n\n## Projects\n- [Review rules](${C}) — the review rules\n`;
const BODY_A = 'Keep each diff small.\n\nWhy: reviewers read every line.';
const NOW = new Date('2026-10-12T10:20:30.000Z');
const LATER = new Date('2026-10-13T08:00:00.000Z');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const put = (v, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), text);
};
const read = (v, rel) => fs.readFileSync(path.join(v, rel), 'utf8');
const trail = (v) => {
  const f = path.join(v, 'brain/_index/promote-log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

function fixture(prefix = 'mmerge-') {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  put(v, 'brain/_index/.keep', '');
  put(v, A, TEXT_A);
  put(v, B, TEXT_B);
  put(v, C, TEXT_C);
  put(v, 'MEMORY.md', INDEX);
  return v;
}
const hashes = (v, rels) => rels.map((r) => sha(read(v, r)));

/** Every file under the vault (a link as its target), so "nothing written" is checked whole. */
function snapshot(v, skip = () => false) {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(v, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      const st = fs.lstatSync(path.join(abs, name));
      if (st.isSymbolicLink()) out[r] = `link -> ${fs.readlinkSync(path.join(abs, name))}`;
      else if (st.isDirectory()) { out[`${r}/`] = 'dir'; walk(r); } else out[r] = fs.readFileSync(path.join(abs, name), 'utf8');
    }
  };
  walk('');
  return out;
}

const CAP = { family: 'hook', perDayUsd: 0.5, spentToday: 0.12, perCallUsd: 0.05 };
const EST = { available: true, reason: null, provider: 'claude', model: 'haiku', tokensIn: 1200, tokensOut: 300, usd: 0.0042, cap: CAP };
const SENTENCES = {
  PROVIDER_NONE: 'No model provider is set up.',
  PROVIDER_CAP: "Today's model cap is reached ($0.50, claude.perDayUsd).",
  PROVIDER_UNREACHABLE: 'Codex did not answer.',
};
/** The AI seam as lib/memory-ai.js shapes it: estimate, call, reasonSentence; every call recorded. */
function fakeAi({ reply = '', error = null, estimate = EST, provider = 'claude', usd = 0.0042 } = {}) {
  const calls = [];
  return {
    calls,
    async estimate(kind, o) { calls.push({ fn: 'estimate', kind, ...o }); return estimate; },
    async call(kind, o) {
      calls.push({ fn: 'call', kind, ...o });
      if (error) throw error;
      return { text: reply, provider, model: 'haiku', usd, estimated: provider === 'codex', cap: CAP };
    },
    reasonSentence(e) { return SENTENCES[e && e.code] || 'The model did not answer.'; },
  };
}
const DEPS = { marker: 'the provider deps pass through' };

test('merge-draft --estimate: the oldest wins, sources keep their order, the no-model prefill, no call, nothing written', async () => {
  const v = fixture();
  const before = snapshot(v);
  const ai = fakeAi();
  const r = await mm.mergeDraft(v, [C, B, A], { estimate: true, ai, deps: DEPS });
  assert.deepEqual(Object.keys(r), ['winner', 'type', 'sources', 'baseHashes', 'byHand', 'truncated', 'estimate']);
  assert.equal(r.winner, A);
  assert.equal(r.type, 'feedback');
  assert.deepEqual(r.baseHashes, hashes(v, [C, B, A]));
  assert.deepEqual(r.sources.map((s) => s.path), [C, B, A]);
  assert.deepEqual(r.sources[2], { path: A, title: 'Small diffs', type: 'feedback', created: '2026-09-01', hash: sha(TEXT_A), chars: BODY_A.length, truncated: false });
  assert.equal(r.sources[0].created, null);
  assert.deepEqual(r.byHand, {
    title: 'Small diffs', description: 'keep diffs small',
    body: `${BODY_A}\n\n## From Small diffs in review\n\nSplit a review over 400 lines.\n\n## From Review rules\n\nOne approval, then merge.`,
  });
  assert.equal(r.truncated, false);
  assert.deepEqual(r.estimate, EST);
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].fn, 'estimate');
  assert.equal(ai.calls[0].kind, 'merge');
  assert.equal(ai.calls[0].deps, DEPS);
  assert.ok(ai.calls[0].outTokens > 0 && ai.calls[0].outTokens <= mm.NUM_PREDICT);
  assert.deepEqual(snapshot(v), before);

  // The estimate counts exactly what a draft sends: the system prompt and the user prompt.
  const ai2 = fakeAi({ reply: JSON.stringify({ title: 't', description: 'd', body: 'b' }) });
  await mm.mergeDraft(v, [C, B, A], { ai: ai2 });
  assert.equal(ai.calls[0].chars, mm.SYSTEM.length + ai2.calls[0].prompt.length);
});

test('the byHand description falls back to the MEMORY.md line, then the opening; a long title is cut to fit', async () => {
  const v = fixture();
  put(v, A, TEXT_A.replace('description: keep diffs small\n', '').replace('# Small diffs', `# ${'T'.repeat(130)}`));
  let r = await mm.mergeDraft(v, [A, B], { estimate: true, ai: fakeAi() });
  assert.equal(r.byHand.description, 'keep diffs small', 'the index line');
  assert.equal(r.byHand.title, 'T'.repeat(120));
  put(v, 'MEMORY.md', INDEX.replace(`- [Small diffs](${A}) — keep diffs small\n`, ''));
  r = await mm.mergeDraft(v, [A, B], { estimate: true, ai: fakeAi() });
  assert.equal(r.byHand.description, 'Keep each diff small.', 'the opening paragraph');
});

test('merge-draft with a model: the cleaned fields, who answered and the cost; the prompt oldest first; nothing written', async () => {
  const v = fixture();
  const before = snapshot(v);
  const reply = JSON.stringify({ title: '# Small diffs, always', description: 'Keep diffs\nsmall', body: '# Small diffs\r\n\r\nKeep diffs small.\r\nSplit big reviews.\r\n' });
  const ai = fakeAi({ reply });
  const r = await mm.mergeDraft(v, [B, A], { ai, now: NOW, deps: DEPS });
  assert.deepEqual(Object.keys(r), ['winner', 'type', 'sources', 'baseHashes', 'truncated', 'mode', 'reason', 'provider', 'model', 'usd', 'estimated', 'cap', 'fields', 'generatedAt']);
  assert.equal(r.mode, 'ai');
  assert.equal(r.reason, null);
  assert.deepEqual([r.provider, r.model, r.usd, r.estimated, r.cap], ['claude', 'haiku', 0.0042, false, CAP]);
  assert.deepEqual(r.fields, { title: 'Small diffs, always', description: 'Keep diffs small', body: 'Keep diffs small.\nSplit big reviews.' });
  assert.equal(r.generatedAt, NOW.toISOString());
  assert.deepEqual(r.baseHashes, hashes(v, [B, A]));
  const call = ai.calls[0];
  assert.deepEqual([call.fn, call.kind, call.system, call.schema, call.timeoutMs, call.numPredict, call.deps], ['call', 'merge', mm.SYSTEM, mm.MERGE_SCHEMA, 90_000, 2000, DEPS]);
  const blockA = `=== ${A} (feedback, created 2026-09-01) ===\nTitle: Small diffs\nDescription: keep diffs small\n\n${BODY_A}`;
  const blockB = `=== ${B} (feedback, created 2026-09-20) ===\nTitle: Small diffs in review\nDescription: reviewers want small diffs\n\nSplit a review over 400 lines.`;
  assert.ok(call.prompt.includes(`${blockA}\n\n${blockB}`), call.prompt);
  assert.deepEqual(mm.MERGE_SCHEMA, {
    type: 'object', additionalProperties: false, required: ['title', 'description', 'body'],
    properties: { title: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' } },
  });
  assert.deepEqual(snapshot(v), before);

  // A fenced reply reads; one with no description takes the winner's; Codex's cost is marked estimated.
  const fenced = await mm.mergeDraft(v, [A, B], { ai: fakeAi({ reply: '```json\n{"title":"T","description":"","body":"B"}\n```', provider: 'codex' }) });
  assert.deepEqual([fenced.mode, fenced.fields.description, fenced.provider, fenced.estimated], ['ai', 'keep diffs small', 'codex', true]);
});

test('merge-draft without a model (none, a cap, no answer) answers by hand with the reason, and nothing is billed', async () => {
  const v = fixture();
  const est = await mm.mergeDraft(v, [A, B, C], { estimate: true, ai: fakeAi() });
  for (const [code, provider] of [['PROVIDER_NONE', 'none'], ['PROVIDER_CAP', 'claude'], ['PROVIDER_UNREACHABLE', 'codex']]) {
    const r = await mm.mergeDraft(v, [A, B, C], { ai: fakeAi({ error: new ProviderUnavailable(code, 'unavailable', provider) }), now: NOW });
    assert.equal(r.mode, 'by-hand', code);
    assert.equal(r.reason, SENTENCES[code], code);
    assert.deepEqual([r.provider, r.model, r.usd, r.estimated, r.cap], [provider, null, 0, false, null], code);
    assert.deepEqual(r.fields, est.byHand, code);
    assert.equal(r.winner, A);
  }
  // A cap names today's spend: the seam's capFor for the provider that stopped (never asked for none).
  const capped = fakeAi({ error: new ProviderUnavailable('PROVIDER_CAP', 'cap', 'claude') });
  const asked = [];
  capped.capFor = (kind, provider, o) => { asked.push([kind, provider, o.deps]); return { ...CAP, spentToday: 0.5 }; };
  const c = await mm.mergeDraft(v, [A, B], { ai: capped, deps: DEPS });
  assert.deepEqual([c.mode, c.cap], ['by-hand', { ...CAP, spentToday: 0.5 }]);
  assert.deepEqual(asked, [['merge', 'claude', DEPS]]);
  const none = fakeAi({ error: new ProviderUnavailable('PROVIDER_NONE', 'none', 'none') });
  none.capFor = () => { throw new Error('never asked'); };
  assert.equal((await mm.mergeDraft(v, [A, B], { ai: none })).cap, null);

  // A seam with no sentence for the error still answers by hand.
  const bare = fakeAi({ error: new Error('spawn failed') });
  delete bare.reasonSentence;
  const r = await mm.mergeDraft(v, [A, B], { ai: bare });
  assert.deepEqual([r.mode, r.reason, r.provider], ['by-hand', 'The model did not answer.', 'none']);
  assert.equal(trail(v).length, 0);
});

test('an unreadable reply answers by hand: not JSON, an empty title or body, a missing or extra key, a non-string', async () => {
  const v = fixture();
  const est = await mm.mergeDraft(v, [A, B], { estimate: true, ai: fakeAi() });
  for (const reply of ['not json at all', '{"title":"","description":"d","body":"b"}', '{"title":"t","description":"d","body":"  \\n "}',
    '{"title":"t","description":"d","body":"b","status":"active"}', '{"title":"t","description":"d"}', '{"title":"t","description":3,"body":"b"}',
    '["t","d","b"]', '{"title":"#  ","description":"d","body":"b"}', '{"title":"t","description":"d","body":"---\\nonly: frontmatter\\n---\\n"}']) {
    const r = await mm.mergeDraft(v, [A, B], { ai: fakeAi({ reply }) });
    assert.equal(r.mode, 'by-hand', reply);
    assert.equal(r.reason, mm.BAD_REPLY, reply);
    assert.deepEqual(r.fields, est.byHand, reply);
    assert.deepEqual([r.provider, r.usd], ['claude', 0.0042], `${reply}: the call happened, so its cost stays`);
  }
});

test('the prompt cuts each body at 8,000 characters and all blocks at 24,000, newest first; byHand stops at 16,000', async () => {
  const v = fixture();
  const xs = [1, 2, 3, 4].map((n) => `brain/memory/reference/x${n}.md`);
  xs.forEach((p, i) => put(v, p, `---\ntags: [memory/reference, status/active]\ncreated: 2026-09-0${i + 1}\ndescription: d${i + 1}\n---\n\n# X${i + 1}\n\n${String.fromCharCode(97 + i).repeat(10_000)}\n`));
  const ai = fakeAi({ reply: JSON.stringify({ title: 't', description: 'd', body: 'b' }) });
  const r = await mm.mergeDraft(v, [xs[3], xs[0], xs[2], xs[1]], { ai });
  const by = Object.fromEntries(r.sources.map((s) => [s.path, s]));
  assert.equal(r.truncated, true);
  assert.deepEqual(xs.map((p) => by[p].truncated), [true, true, true, true]);
  assert.equal(by[xs[0]].chars, 8000, 'the oldest keeps its 8,000');
  assert.equal(by[xs[1]].chars, 8000);
  assert.ok(by[xs[2]].chars > 7000 && by[xs[2]].chars < 8000, `the next newest is cut to fit (${by[xs[2]].chars})`);
  assert.equal(by[xs[3]].chars, 0, 'the newest is cut first');
  const prompt = ai.calls[0].prompt;
  const blocks = prompt.slice(prompt.indexOf('=== brain/'), prompt.lastIndexOf('\n\n=== end of memories ==='));
  assert.ok(blocks.length <= mm.MAX_PROMPT_CHARS && blocks.length > mm.MAX_PROMPT_CHARS - 10, `all blocks: ${blocks.length}`);
  assert.equal(prompt.split(mm.CUT_MARK).length - 1, 4);
  assert.ok(prompt.includes(`${'a'.repeat(8000)}${mm.CUT_MARK}\n\n=== ${xs[1]}`));

  const two = await mm.mergeDraft(v, [xs[0], A], { estimate: true, ai: fakeAi() });
  assert.deepEqual(two.sources.map((s) => [s.chars, s.truncated]), [[8000, true], [BODY_A.length, false]]);
  const four = await mm.mergeDraft(v, xs, { estimate: true, ai: fakeAi() });
  assert.equal(four.byHand.body.length, mm.LIMITS.body);
  assert.ok(four.byHand.body.startsWith('a'.repeat(10_000) + '\n\n## From X2\n\n'));
});

test('escaping: a title with `: # "` and a body opening with `---` land as one H1, one frontmatter block, one index line', async () => {
  const v = fixture();
  const title = 'Rule: ask # first "now"';
  const description = `Why: it's "safe" # really`;
  const reply = JSON.stringify({ title, description, body: '---\ntitle: injected\ntags: [x]\n---\n# Heading\n\nKeep diffs small.\n' });
  const d = await mm.mergeDraft(v, [A, B], { ai: fakeAi({ reply }) });
  assert.deepEqual(d.fields, { title, description, body: 'Keep diffs small.' });
  mm.merge(v, [A, B], d.fields, d.baseHashes, { now: NOW });
  const text = read(v, A);
  assert.match(text, /^description: 'Why: it''s "safe" # really'$/m);
  assert.ok(text.endsWith(`---\n\n# ${title}\n\nKeep diffs small.\n`), text);
  assert.equal((text.match(/^---$/gm) || []).length, 2, 'one frontmatter block');
  const back = ops.describe(ops.readMemory(v, A));
  assert.deepEqual([back.title, back.description, back.live], [title, description, true]);
  assert.ok(read(v, 'MEMORY.md').includes(`\n- [${title}](${A}) — ${description}\n`));
  let strict = null;
  try { strict = require('js-yaml'); } catch { /* the lint tooling brings it; the checks above stand alone */ }
  if (strict) assert.equal(strict.load(ops.splitFm(text).lines.join('')).description, description);

  // merge's --into drops a lone leading `---` line and a leading H1 the same way.
  const v2 = fixture();
  mm.merge(v2, [A, B], { title: 'T', description: 'D', body: '---\n# T again\nKeep it.' }, hashes(v2, [A, B]), { now: NOW });
  assert.ok(read(v2, A).endsWith('---\n\n# T\n\nKeep it.\n'));
});

test('merge writes the record, the winner, the superseded losers, one MEMORY.md edit and the trail', () => {
  const v = fixture();
  // C without a description: it keeps its MEMORY.md line's while it is out (as supersede keeps one).
  const textC = TEXT_C.replace('description: the review rules\n', '');
  put(v, C, textC);
  const [hA, hB, hC] = hashes(v, [A, B, C]);
  const into = { title: 'Small diffs, always', description: 'Keep diffs small; split reviews over 400 lines', body: 'Keep each diff small.\r\n\r\nSplit a review over 400 lines.\n' };
  const r = mm.merge(v, [A, B, C], into, [hA, hB, hC], { now: NOW });
  const id = `20261012-102030-${sha([A, B, C].join('\n')).slice(0, 8)}`;
  const winner = '---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-09-01\nupdated: 2026-10-12\nsource: auto-wrap\nsession: s1\nreviewed: true\ndescription: Keep diffs small; split reviews over 400 lines\npin: true\n---\n\n# Small diffs, always\n\nKeep each diff small.\n\nSplit a review over 400 lines.\n';
  assert.deepEqual(r, { path: A, superseded: [B, C], record: id, hash: sha(winner) });
  assert.equal(read(v, A), winner);
  assert.equal(read(v, B), TEXT_B.replace('status/active', 'status/superseded')
    .replace('description: reviewers want small diffs\n', `description: reviewers want small diffs\nstatus_before: active\nsuperseded_by: ${A}\n`));
  assert.equal(read(v, C), textC.replace('status/active', 'status/superseded')
    .replace('reviewed: false\n', `reviewed: false\ndescription: the review rules\nstatus_before: active\nsuperseded_by: ${A}\n`));
  assert.equal(read(v, 'MEMORY.md'), `# Index\n\n## Feedback\n- [Small diffs, always](${A}) — Keep diffs small; split reviews over 400 lines\n\n## Projects\n`);
  assert.deepEqual(JSON.parse(read(v, `${mm.RECORD_DIR}/${id}.json`)), {
    schema: 1, id, at: NOW.toISOString(), winner: A, before: { text: TEXT_A, hash: hA, line: `- [Small diffs](${A}) — keep diffs small` }, after: { hash: sha(winner) },
    sources: [{ path: A, hash: hA }, { path: B, hash: hB }, { path: C, hash: hC }], undoneAt: null,
  });
  assert.ok(fs.lstatSync(path.join(v, mm.RECORD_DIR)).isDirectory());
  const rows = trail(v).map(({ ts, ...row }) => { assert.ok(ts); return row; });
  assert.deepEqual(rows, [
    { session: 's1', action: 'merged', slug: 'small-diffs', type: 'feedback', title: 'Small diffs, always', path: A, from: [B, C], record: id, hash: sha(winner) },
    { session: 's2', action: 'superseded', slug: 'small-diffs-in-review', type: 'feedback', title: 'Small diffs in review', path: B, by: A, record: id },
    { session: null, action: 'superseded', slug: 'review-rules', type: 'projects', title: 'Review rules', path: C, by: A, record: id },
  ]);
  for (const p of [B, C]) assert.equal(ops.describe(ops.readMemory(v, p)).supersededBy, A);
});

test('merge refuses before writing anything: a changed source, a hash count, a bad --into, a gone, linked or bare memory', async () => {
  const v = fixture();
  const [hA, hB] = hashes(v, [A, B]);
  const good = { title: 'T', description: 'D', body: 'Body.' };
  const before = snapshot(v);
  assert.throws(() => mm.merge(v, [A, B], good, [hA, 'f'.repeat(64)]), { code: 'CHANGED', message: `${B} changed since it was read: open the merge again` });
  assert.throws(() => mm.merge(v, [A, B], good, [hA]), { code: 'BAD_HASH' });
  assert.throws(() => mm.merge(v, [A, B], good, `${hA},none`), { code: 'BAD_HASH' });
  for (const into of [null, [], { ...good, extra: 'x' }, { title: 'T', body: 'B' }, { ...good, title: 'two\nlines' }, { ...good, title: 'x'.repeat(121) },
    { ...good, title: '  ' }, { ...good, description: 'x'.repeat(201) }, { ...good, description: '' }, { ...good, body: ' \n ' },
    { ...good, body: 'x'.repeat(16_001) }, { ...good, body: 7 }]) {
    assert.throws(() => mm.merge(v, [A, B], into, [hA, hB]), { code: 'BAD_FIELD' }, JSON.stringify(into));
  }
  for (const rels of [[A], [A, A], [A, B, C, A, B, C, A]]) assert.throws(() => mm.merge(v, rels, good, rels.map(() => hA)), { code: 'BAD_PATH' }, rels.join(' '));
  assert.deepEqual(snapshot(v), before);

  // A retired source refuses (GONE) in the draft and in the merge.
  ops.archive(v, [B]);
  const archived = snapshot(v);
  await assert.rejects(mm.mergeDraft(v, [A, B], { estimate: true, ai: fakeAi() }), { code: 'GONE', message: `${B} is archived: restore it first` });
  assert.throws(() => mm.merge(v, [A, B], good, hashes(v, [A, B])), { code: 'GONE' });
  assert.deepEqual(snapshot(v), archived);

  // A memory that is a link, or that has no frontmatter, refuses; the link's target is never read into a write.
  const v2 = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mmerge-out-'));
  fs.writeFileSync(path.join(outside, 'target.md'), TEXT_B);
  const LINK = 'brain/memory/feedback/linked.md';
  fs.symlinkSync(path.join(outside, 'target.md'), path.join(v2, LINK));
  const BARE = 'brain/memory/feedback/bare.md';
  put(v2, BARE, '# Bare\n\nNo frontmatter.\n');
  const before2 = snapshot(v2);
  await assert.rejects(mm.mergeDraft(v2, [A, LINK], { estimate: true, ai: fakeAi() }), { code: 'UNSAFE' });
  assert.throws(() => mm.merge(v2, [A, LINK], good, [sha(TEXT_A), sha(TEXT_B)]), { code: 'UNSAFE' });
  await assert.rejects(mm.mergeDraft(v2, [A, BARE], { estimate: true, ai: fakeAi() }), { code: 'NO_FRONTMATTER', message: /run Health's fixes first/ });
  assert.throws(() => mm.merge(v2, [A, BARE], good, hashes(v2, [A, BARE])), { code: 'NO_FRONTMATTER' });
  assert.deepEqual(snapshot(v2), before2);
  assert.equal(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), TEXT_B);

  // The record is written first: a record folder that is a link refuses, and the winner is untouched.
  const v3 = fixture();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mmerge-rec-'));
  fs.symlinkSync(elsewhere, path.join(v3, mm.RECORD_DIR));
  assert.throws(() => mm.merge(v3, [A, B], good, hashes(v3, [A, B]), { now: NOW }), { code: 'UNSAFE' });
  assert.equal(read(v3, A), TEXT_A);
  assert.equal(read(v3, B), TEXT_B);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('unmerge puts every file back byte for byte, marks the record undone and logs it; a second undo finds nothing', () => {
  const v = fixture();
  const isIndex = (r) => r.startsWith('brain/_index');
  const before = snapshot(v, isIndex);
  const r = mm.merge(v, [B, C, A], { title: 'Merged', description: 'all of it', body: 'Everything.' }, hashes(v, [B, C, A]), { now: NOW });
  assert.equal(r.path, A);
  assert.notDeepEqual(snapshot(v, isIndex), before);
  const u = mm.unmerge(v, A, r.hash, { now: LATER });
  assert.deepEqual(u, { path: A, restored: [B, C], record: r.record, hash: sha(TEXT_A) });
  assert.deepEqual(snapshot(v, isIndex), before, 'the memories and MEMORY.md as they were');
  const rec = JSON.parse(read(v, `${mm.RECORD_DIR}/${r.record}.json`));
  assert.equal(rec.undoneAt, LATER.toISOString());
  assert.equal(rec.before.text, TEXT_A);
  const rows = trail(v);
  assert.deepEqual(rows.map((t) => [t.action, t.path]), [['merged', A], ['superseded', B], ['superseded', C], ['unmerged', A], ['restored', B], ['restored', C]]);
  assert.deepEqual([rows[3].record, rows[3].restored, rows[3].title], [r.record, [B, C], 'Small diffs']);
  assert.equal(rows[4].record, r.record);
  assert.throws(() => mm.unmerge(v, A, sha(TEXT_A)), { code: 'NOT_FOUND', message: `no merge to undo for ${A}` });
});

test('unmerge puts the winner\'s own MEMORY.md line back, even when its title or description is not the file\'s', () => {
  const v = fixture();
  // No description key, and a line whose title and description were written by hand: a rebuild from the text alone would
  // give "[Small diffs] — Keep each diff small." (its H1 and its opening).
  put(v, A, TEXT_A.replace('description: keep diffs small\n', ''));
  const line = `- [Small diffs (the rule)](${A}) — one PR, one idea`;
  put(v, 'MEMORY.md', INDEX.replace(`- [Small diffs](${A}) — keep diffs small`, line));
  const isIndex = (r) => r.startsWith('brain/_index');
  const before = snapshot(v, isIndex);
  const r = mm.merge(v, [A, B], { title: 'Merged', description: 'all of it', body: 'Everything.' }, hashes(v, [A, B]), { now: NOW });
  assert.equal(JSON.parse(read(v, `${mm.RECORD_DIR}/${r.record}.json`)).before.line, line);
  mm.unmerge(v, A, r.hash, { now: LATER });
  assert.deepEqual(snapshot(v, isIndex), before, 'MEMORY.md byte for byte');

  // A record without the line (or with one that is not this memory's) rebuilds it from the old text, as restore does.
  const v2 = fixture();
  const r2 = mm.merge(v2, [A, B], { title: 'Merged', description: 'all of it', body: 'Everything.' }, hashes(v2, [A, B]), { now: NOW });
  const file = path.join(v2, mm.RECORD_DIR, `${r2.record}.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, before: { ...rec.before, line: `- [Other](${C}) — not this one` } }));
  mm.unmerge(v2, A, r2.hash, { now: LATER });
  assert.equal(read(v2, 'MEMORY.md'), INDEX, 'rebuilt from the old title and description key');
});

test('unmerge refuses after an edit and without a merge; a loser restored since is left alone', () => {
  const v = fixture();
  assert.throws(() => mm.unmerge(v, A, 'a'.repeat(64)), { code: 'NOT_FOUND' }, 'no record folder yet');
  const r = mm.merge(v, [A, B, C], { title: 'Merged', description: 'all of it', body: 'Everything.' }, hashes(v, [A, B, C]), { now: NOW });
  assert.throws(() => mm.unmerge(v, B, sha(read(v, B))), { code: 'NOT_FOUND' }, 'B was merged away, not into');
  assert.throws(() => mm.unmerge(v, A, 'none'), { code: 'BAD_HASH' });
  fs.appendFileSync(path.join(v, A), '\nEdited by hand.\n');
  const edited = snapshot(v);
  assert.throws(() => mm.unmerge(v, A, sha(read(v, A))), { code: 'CHANGED', message: `${A} changed since the merge: undo it by hand` });
  assert.throws(() => mm.unmerge(v, A, r.hash), { code: 'CHANGED' });
  assert.deepEqual(snapshot(v), edited);

  // Back to the merged text; B restored by hand meanwhile: the undo restores only C, and B keeps its own line.
  const v2 = fixture();
  const r2 = mm.merge(v2, [A, B, C], { title: 'Merged', description: 'all of it', body: 'Everything.' }, hashes(v2, [A, B, C]), { now: NOW });
  ops.restore(v2, [B]);
  const u = mm.unmerge(v2, A, r2.hash, { now: LATER });
  assert.deepEqual(u.restored, [C]);
  assert.equal(read(v2, A), TEXT_A);
  assert.equal(read(v2, C), TEXT_C);
  assert.equal(ops.describe(ops.readMemory(v2, B)).live, true);
  assert.equal((read(v2, 'MEMORY.md').match(/small-diffs-in-review\.md/g) || []).length, 1);
});

test('pruneRecords removes records older than 30 days and nothing else', () => {
  const v = fixture();
  assert.deepEqual(mm.pruneRecords(v, { now: NOW }), { pruned: [], kept: 0 }, 'no folder: nothing to do');
  const dir = path.join(v, mm.RECORD_DIR);
  fs.mkdirSync(dir);
  const rec = (id, daysAgo) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ schema: 1, id, at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), winner: A, before: { text: '', hash: '' }, after: { hash: '' }, sources: [], undoneAt: null }));
  rec('20260910-000000-aaaaaaaa', 31);
  rec('20260913-000000-bbbbbbbb', 29);
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ schema: 1, id: 'notes', at: '2020-01-01T00:00:00Z' }));
  fs.writeFileSync(path.join(dir, '20200101-000000-cccccccc.json'), '{ not json');
  fs.writeFileSync(path.join(dir, '20200101-000000-dddddddd.json'), JSON.stringify({ schema: 1, id: 'someone-else', at: '2020-01-01T00:00:00Z' }));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mmerge-prune-'));
  fs.writeFileSync(path.join(outside, 'r.json'), JSON.stringify({ schema: 1, id: '20200101-000000-eeeeeeee', at: '2020-01-01T00:00:00Z' }));
  fs.symlinkSync(path.join(outside, 'r.json'), path.join(dir, '20200101-000000-eeeeeeee.json'));
  assert.deepEqual(mm.pruneRecords(v, { now: NOW }), { pruned: ['20260910-000000-aaaaaaaa'], kept: 1 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['20200101-000000-cccccccc.json', '20200101-000000-dddddddd.json', '20200101-000000-eeeeeeee.json', '20260913-000000-bbbbbbbb.json', 'notes.json']);
  assert.ok(fs.existsSync(path.join(outside, 'r.json')), "a link's target is never touched");
  assert.deepEqual(mm.pruneRecords(v, { now: NOW, days: 7 }), { pruned: ['20260913-000000-bbbbbbbb'], kept: 0 });

  // A merge's own record is young until its 30 days pass.
  const r = mm.merge(v, [A, B], { title: 'T', description: 'D', body: 'B.' }, hashes(v, [A, B]), { now: NOW });
  assert.deepEqual(mm.pruneRecords(v, { now: new Date(NOW.getTime() + 30 * 86_400_000) }).pruned, []);
  assert.deepEqual(mm.pruneRecords(v, { now: new Date(NOW.getTime() + 31 * 86_400_000) }).pruned, [r.record]);
  assert.throws(() => mm.unmerge(v, A, r.hash), { code: 'NOT_FOUND' }, 'Undo merge ends with its record');
});
