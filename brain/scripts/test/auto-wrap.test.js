'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'awrap-'));
for (const d of ['brain/_index', 'brain/memory/feedback', 'brain/memory/projects']) {
  fs.mkdirSync(path.join(TMP, d), { recursive: true });
}
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
fs.writeFileSync(path.join(TMP, 'MEMORY.md'), '# Index\n');
fs.writeFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'),
  '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n- (template)\n\n## Things to Remember\n');
process.env.BRAIN_VAULT = TMP;
const { runAutoWrap } = require('../auto-wrap.js');

const GOOD_EXTRACTION = {
  facts: ['Shipped the pipelines ledger', 'All suites green'],
  decisions: ['History ring rescues only killed runs'],
  feedback: [], threads: ['P2 file map next'],
  candidates: [{ type: 'feedback', title: 'Commit immediately after green tests',
    description: 'auto-backup races sweep finished files otherwise',
    body: 'Commit as soon as a gate passes.\n**Why:** vault auto-backup races.\n**How to apply:** stage + commit per task.' }],
};
const goodChat = () => JSON.stringify(GOOD_EXTRACTION);
const junkChat = () => JSON.stringify({ facts: [], decisions: [], feedback: [], threads: [], candidates: [] });

beforeEach(() => {
  try { fs.unlinkSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl')); } catch {}
  for (const f of fs.readdirSync(path.join(TMP, 'brain', 'memory', 'feedback'))) {
    fs.rmSync(path.join(TMP, 'brain', 'memory', 'feedback', f), { recursive: true, force: true });
  }
  try { fs.unlinkSync(path.join(TMP, 'brain', '_index', 'feedback-metrics.jsonl')); } catch {}
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'), '# Index\n');
  // A prior corrections-stage test may have upserted "## Pending Feedback
  // Drafts" into the shared SESSION.md; strip it so tests asserting its
  // absence aren't coupled to run order. Same anchored-section regex as
  // auto-wrap.js's own upsertSection.
  try {
    const sessionPath = path.join(TMP, 'brain', '_index', 'SESSION.md');
    const content = fs.readFileSync(sessionPath, 'utf8');
    fs.writeFileSync(sessionPath, content.replace(/## Pending Feedback Drafts[\s\S]*?(?=\n## |$)/, '').replace(/\n{3,}/g, '\n\n'));
  } catch {}
});

test('a real session writes a memory, a trail entry, and fills SESSION.md', async () => {
  const report = { wrote: [], counts: {} };
  const out = await runAutoWrap({ transcriptText: 'user: build it\nassistant: built it\n'.repeat(40), sessionId: 'sess-t1', chatFn: goodChat, report });
  assert.equal(out.written, 1);
  assert.ok(fs.existsSync(path.join(TMP, 'brain', 'memory', 'feedback', 'commit-immediately-after-green-tests.md')));
  const trail = fs.readFileSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl'), 'utf8');
  assert.match(trail, /"action":"written"/);
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.match(session, /Shipped the pipelines ledger/);
  assert.ok(!/\(template\)/.test(session));
  assert.equal(report.counts.written, 1);
});

test('a junk transcript produces ZERO writes and counts.skipped', async () => {
  const report = { wrote: [], counts: {} };
  const out = await runAutoWrap({ transcriptText: 'hi', sessionId: 'sess-t2', chatFn: junkChat, report });
  assert.equal(out.written, 0);
  assert.ok(!fs.existsSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl')));
  assert.equal(fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf8'), '# Index\n');
});

test('a previously reverted slug is skipped even when re-proposed', async () => {
  const { appendTrail } = require('../lib/promote-log.js');
  appendTrail({ session: 's0', action: 'reverted', slug: 'commit-immediately-after-green-tests', type: 'feedback', title: 'x' });
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t3', chatFn: goodChat, report: { wrote: [], counts: {} } });
  assert.equal(out.written, 0);
  assert.match(out.reasons.join(' '), /reverted/);
});

test('SESSION.md stays within its 400-token budget', async () => {
  const bigChat = () => JSON.stringify({ ...GOOD_EXTRACTION, facts: Array(200).fill('a very long fact line that repeats endlessly to blow the budget wide open') });
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t4', chatFn: bigChat, report: { wrote: [], counts: {} } });
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  const { estimateTokens } = require('../lib/text-budget.js');
  assert.ok(estimateTokens(session) <= 400, `SESSION.md is ${estimateTokens(session)} tokens`);
});

test('within-batch near-duplicate candidates: first written, second gated against it', async () => {
  const dupChat = () => JSON.stringify({
    facts: ['Shipped the pipelines ledger', 'All suites green'],
    decisions: ['History ring rescues only killed runs'],
    feedback: [], threads: ['P2 file map next'],
    candidates: [
      { type: 'feedback', title: 'Commit immediately after green tests pass',
        description: 'auto-backup races sweep finished files otherwise',
        body: 'Commit as soon as a gate passes.\n**Why:** vault auto-backup races.\n**How to apply:** stage + commit per task.' },
      { type: 'feedback', title: 'Commit immediately after green tests today',
        description: 'auto-backup races sweep finished files otherwise too',
        body: 'Commit as soon as a gate passes today.\n**Why:** vault auto-backup races.\n**How to apply:** stage + commit per task now.' },
    ],
  });
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t5', chatFn: dupChat, report: { wrote: [], counts: {} } });
  assert.equal(out.written, 1);
  assert.equal(out.skipped, 1);
  assert.match(out.reasons.join(' '), /near-duplicate/);
});

test('a drifted first extraction gets one harder-framed retry and recovers', async () => {
  let calls = 0;
  const driftThenGoodChat = () => {
    calls++;
    if (calls === 1) return JSON.stringify({ summary: 'wrong shape entirely', hooks_executed: [] });
    return JSON.stringify(GOOD_EXTRACTION);
  };
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t6', chatFn: driftThenGoodChat, report: { wrote: [], counts: {} } });
  assert.equal(calls, 2, 'chatFn should be called twice: once, then a harder-framed retry');
  assert.equal(out.written, 1);
});

test('structured: an honest empty-candidates result is NOT retried; unstructured still retries', async () => {
  const EMPTY = '{"facts":["a"],"decisions":["b"],"feedback":[],"threads":[],"candidates":[]}';
  let structuredCalls = 0;
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-se1', structured: true,
    chatFn: () => { structuredCalls++; return EMPTY; }, report: { wrote: [], counts: {} } });
  assert.equal(structuredCalls, 1, 'a schema-constrained empty answer is final');
  let looseCalls = 0;
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-se2',
    chatFn: () => { looseCalls++; return EMPTY; }, report: { wrote: [], counts: {} } });
  assert.equal(looseCalls, 2, 'without a schema, an empty result still earns one harder-framed retry');
});

test('an unparseable first reply gets the harder-framed retry and recovers', async () => {
  let calls = 0;
  const proseThenGoodChat = () => {
    calls++;
    if (calls === 1) return 'Sorry, there is nothing to extract here.'; // parse failure, not shape drift
    return JSON.stringify(GOOD_EXTRACTION);
  };
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t8', chatFn: proseThenGoodChat, report: { wrote: [], counts: {} } });
  assert.equal(calls, 2, 'chatFn should be called twice: parse failure, then a harder-framed retry');
  assert.equal(out.written, 1);
});

test('two unparseable replies surface the original parse error', async () => {
  const proseChat = () => 'still no json, no matter how you ask';
  await assert.rejects(
    () => runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t9', chatFn: proseChat, report: { wrote: [], counts: {} } }),
    (e) => /no JSON object found/.test(e.message)
  );
});

test('non-string bullet items are coerced, not rendered as [object Object]', async () => {
  const objectBulletChat = () => JSON.stringify({
    facts: ['', 'Shipped the pipelines ledger'],
    decisions: [{ decision: 'History ring rescues only killed runs', why: 'safety' }],
    feedback: [], threads: [],
    candidates: [],
  });
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t7', chatFn: objectBulletChat, report: { wrote: [], counts: {} } });
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.match(session, /History ring rescues only killed runs/);
  assert.ok(!session.includes('[object Object]'), 'must not render [object Object]');
  assert.ok(!/^-\s*$/m.test(session), 'must not leave a blank bullet line');
});

// Regression for the live 2026-08-14 failure (session 5f80f2ce): qwen returned
// {user,context} and {correction,context} objects, which matched none of the
// round-3 preferred keys and were dumped as truncated JSON into SESSION.md.
test('object keys outside the preferred list yield prose, never raw JSON', async () => {
  const unlistedKeyChat = () => JSON.stringify({
    facts: ['Relocated the brief output to cloud storage'],
    decisions: [{ user: 'Clarified "sandbox" as harness-enforced limits', context: 'user questioned loose usage' }],
    feedback: [{ correction: 'Sandbox bounds blast radius, not correctness', context: 'raised during the audit' }],
    threads: [{ nested: { noStringAnywhere: 1 } }],
    candidates: [],
  });
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t10', chatFn: unlistedKeyChat, report: { wrote: [], counts: {} } });
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.match(session, /Clarified "sandbox" as harness-enforced limits/);
  assert.match(session, /Sandbox bounds blast radius, not correctness/);
  assert.ok(!session.includes('{"'), 'must not leak raw JSON into auto-injected brain-context');
  assert.ok(!/noStringAnywhere/.test(session), 'object with no string value is dropped, not dumped');
});

// Fix round 6 regression (found while verifying round 5): budgeting charged the
// previous run's OWN bullets as fixed overhead, so a repeat run dropped every
// section and upsertSection's empty-body contract then deleted both headings.
// Deliberately sized into the pathological zone: the residual alone leaves room
// for the bullets, but residual + a previous run's copy of those same bullets
// does not. Outside that zone the bug is invisible — an oversized base is
// dropped wholesale by fitToBudget, so the sections fit anyway. Verified to FAIL
// against the pre-fix `{name:'base', text: content}` accounting.
test('a repeat run against a populated SESSION.md converges instead of wiping it', async () => {
  const { estimateTokens } = require('../lib/text-budget.js');
  const p = path.join(TMP, 'brain', '_index', 'SESSION.md');

  const chat = () => JSON.stringify({
    facts: [1, 2, 3, 4, 5, 6].map((i) =>
      `Relocated the brief output from the work mail account to a personal mailbox (${i})`),
    decisions: ['Chose the residual-based budget'],
    feedback: [], threads: [], candidates: [],
  });

  // ~200 tokens of overhead auto-wrap does not own, computed so a template
  // change cannot silently move this out of the zone.
  let seed = '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n\n';
  while (estimateTokens(seed) < 200) seed += '- a pre-existing remembered note\n';
  fs.writeFileSync(p, seed);

  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-i1', chatFn: chat, report: { wrote: [], counts: {} } });
  const first = fs.readFileSync(p, 'utf8');
  assert.match(first, /## Key Context This Session/);
  assert.match(first, /to a personal mailbox \(6\)/, 'first run keeps every fact');

  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-i2', chatFn: chat, report: { wrote: [], counts: {} } });
  const second = fs.readFileSync(p, 'utf8');
  assert.match(second, /## Key Context This Session/, 'repeat run must not delete the heading');
  assert.match(second, /to a personal mailbox \(6\)/, 'repeat run must not drop the facts');
  assert.equal(second, first, 'repeat run must converge byte-for-byte');
});

test('the 400-token budget still bites when the residual itself is oversized', async () => {
  const { estimateTokens } = require('../lib/text-budget.js');
  const p = path.join(TMP, 'brain', '_index', 'SESSION.md');
  // Pad a section auto-wrap does NOT own until the residual nearly fills the
  // budget. Computed rather than hard-coded so a template change cannot quietly
  // turn this into a no-op.
  let bloated = '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n\n';
  while (estimateTokens(bloated) < 380) bloated += '- a remembered note that consumes real budget\n';
  fs.writeFileSync(p, bloated);

  const filler = 'this run has no room left in the working-memory budget for another bullet, so it goes. ';
  const chat = () => JSON.stringify({
    facts: [`KEEPME ${filler.repeat(3)}`], decisions: [`KEEPME2 ${filler.repeat(3)}`],
    feedback: [], threads: [], candidates: [],
  });
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-i3', chatFn: chat, report: { wrote: [], counts: {} } });
  const out = fs.readFileSync(p, 'utf8');
  assert.ok(!out.includes('KEEPME'), 'an oversized residual must still push generated bullets out');
  // Heading absent proves writeSessionSections ran and emptied the section,
  // rather than the junk gate skipping it and passing this test for free.
  assert.ok(!out.includes('## Key Context This Session'), 'empty body must remove the heading');
});

test('corrections stage: 2 detections become 2 drafts and a pending SESSION.md section', async () => {
  const correctionChat = () => JSON.stringify({ corrections: [
    { title: 'Use /usr/local/bin/node, never /opt/homebrew',
      description: 'assistant spawned the wrong node binary and had to be corrected',
      body: 'node lives at /usr/local/bin/node.\n\n**Why:** wrong spawn.\n\n**How to apply:** absolute path.\n\n**Evidence:** "node is at /usr/local/bin/node"' },
    { title: 'Ask before force-pushing any branch',
      description: 'user reverted an unrequested force push this session',
      body: 'Never force-push unasked.\n\n**Why:** revert cost.\n\n**How to apply:** plain push; ask first.\n\n**Evidence:** "I did not ask you to force push"' },
  ]});
  const report = { wrote: [], counts: {} };
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-c1', chatFn: goodChat, report, corrections: { enabled: true, chatFn: correctionChat } });
  assert.equal(out.written, 1); // main extraction path untouched
  assert.equal(report.counts.drafted, 2);
  const drafts = fs.readdirSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts')).filter((n) => n.endsWith('.md'));
  assert.equal(drafts.length, 2);
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.match(session, /## Pending Feedback Drafts/);
  assert.match(session, /2 draft feedback rules pending review/);
});

test('corrections stage omitted: no detector call, no pending section', async () => {
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-c2', chatFn: goodChat, report: { wrote: [], counts: {} } });
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.ok(!session.includes('Pending Feedback Drafts'));
});

test('corrections stage failure never breaks the wrap', async () => {
  const boom = () => { throw new Error('ollama down'); };
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-c3', chatFn: goodChat, report: { wrote: [], counts: {} }, corrections: { enabled: true, chatFn: boom } });
  assert.equal(out.written, 1);
});

// ---- provider paths, applyExtraction, wrap status (Plan 2) ----
const { applyExtraction, writeWrapStatus, wrapCycle, EXTRACTION_SCHEMA } = require('../auto-wrap.js');
const { readLedgerFile } = require('../lib/pipeline-report.js');
const q = require('../lib/wrap-queue.js');
const SESSION_PATH = path.join(TMP, 'brain', '_index', 'SESSION.md');
const NONE = { name: 'none', reason: 'forced', capabilities: { chat: false, embed: false, structured: false }, chat: async () => { throw new Error('must not be called'); } };
const CLAUDE = { name: 'claude', reason: 'forced', capabilities: { chat: true, embed: false, structured: true }, chat: async () => JSON.stringify(GOOD_EXTRACTION) };

test('EXTRACTION_SCHEMA is a real JSON Schema and reaches the chat call', async () => {
  assert.equal(EXTRACTION_SCHEMA.type, 'object');
  assert.deepEqual(EXTRACTION_SCHEMA.required, ['facts', 'decisions', 'feedback', 'threads', 'candidates']);
  let seen;
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-sch', chatFn: (o) => { seen = o; return goodChat(); }, report: { wrote: [], counts: {} } });
  assert.deepEqual(seen.schema, EXTRACTION_SCHEMA);
  assert.equal(seen.format, 'json');
});

test('applyExtraction writes memories, fills SESSION.md, and turns explicit corrections into drafts', async () => {
  const report = { wrote: [], counts: {} };
  const out = await applyExtraction({
    extraction: GOOD_EXTRACTION, sessionId: 'sess-ap1', report,
    corrections: [{ quote: 'no, never force push', rule: 'Ask before force-pushing any branch', why: 'an unrequested force push had to be reverted' }],
  });
  assert.equal(out.written, 1);
  assert.equal(out.drafts, 1);
  assert.ok(fs.existsSync(path.join(TMP, 'brain', 'memory', 'feedback', 'commit-immediately-after-green-tests.md')));
  const drafts = fs.readdirSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts'));
  assert.ok(drafts.includes('ask-before-force-pushing-any-branch.md'));
  assert.match(fs.readFileSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts', 'ask-before-force-pushing-any-branch.md'), 'utf8'), /\*\*Evidence:\*\* "no, never force push"/);
  const session = fs.readFileSync(SESSION_PATH, 'utf8');
  assert.match(session, /Shipped the pipelines ledger/);
  assert.match(session, /## Pending Feedback Drafts/);
  assert.equal(report.counts.drafted, 1);
});

test('writeWrapStatus upserts the banner; applyExtraction clears it', async () => {
  fs.writeFileSync(SESSION_PATH, '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n');
  writeWrapStatus('abc123', 'none');
  writeWrapStatus('abc123', 'none');
  const s = fs.readFileSync(SESSION_PATH, 'utf8');
  assert.equal((s.match(/## Wrap Status/g) || []).length, 1);
  assert.match(s, /- Session abc123 not wrapped \(provider: none\) — run \/wrap\./);
  assert.ok(s.indexOf('## Wrap Status') < s.indexOf('## Things to Remember'));
  await applyExtraction({ extraction: GOOD_EXTRACTION, sessionId: 'sess-clear' });
  assert.ok(!fs.readFileSync(SESSION_PATH, 'utf8').includes('## Wrap Status'));
});

test('wrapCycle with provider none: prunes first, writes the banner, ledger disabled/no-provider, no spool, needs-review drafts', async () => {
  fs.writeFileSync(SESSION_PATH, '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n');
  const transcript = path.join(TMP, 'none.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'no, use the other binary for this' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n');
  const order = [];
  const out = await wrapCycle({ transcriptPath: transcript, sessionId: 'sess-none', provider: NONE,
    deps: { pruneQueue: async () => { order.push('prune'); return { dropped: 0 }; }, waitForOllama: async () => { order.push('wait'); return true; } } });
  assert.equal(out.status, 'disabled');
  assert.deepEqual(order, ['prune']);
  const last = readLedgerFile().pipelines['auto-wrap'].lastRun;
  assert.equal(last.status, 'disabled');
  assert.equal(last.reason, 'no-provider');
  assert.equal(last.provider, 'none');
  assert.equal(last.counts.drafted, 1);
  assert.match(fs.readFileSync(SESSION_PATH, 'utf8'), /Session sess-none not wrapped \(provider: none\)/);
  assert.ok(!fs.existsSync(q.QUEUE_PATH), 'nothing is spooled without a provider');
  const drafts = fs.readdirSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts')).filter((n) => n.endsWith('.md'));
  assert.equal(drafts.length, 1);
  assert.match(fs.readFileSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts', drafts[0]), 'utf8'), /status\/needs-review/);
});

test('wrapCycle with provider claude: no Ollama wait, extraction through provider.chat, ledger ok/claude', async () => {
  fs.writeFileSync(SESSION_PATH, '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n');
  const transcript = path.join(TMP, 'claude.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'build it' }] } }) + '\n');
  let waited = false;
  const out = await wrapCycle({ transcriptPath: transcript, sessionId: 'sess-cl', provider: CLAUDE,
    deps: { pruneQueue: async () => ({ dropped: 0 }), waitForOllama: async () => { waited = true; return true; } } });
  assert.equal(out.status, 'ok');
  assert.equal(waited, false);
  const last = readLedgerFile().pipelines['auto-wrap'].lastRun;
  assert.equal(last.status, 'ok');
  assert.equal(last.provider, 'claude');
  assert.equal(last.counts.written, 1);
});

test('wrapCycle with provider ollama that never comes up: ledger skipped/ollama-unreachable and the session is spooled', async () => {
  const transcript = path.join(TMP, 'ollama.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const OLLAMA = { ...CLAUDE, name: 'ollama' };
  const out = await wrapCycle({ transcriptPath: transcript, sessionId: 'sess-ol', provider: OLLAMA,
    deps: { pruneQueue: async () => ({ dropped: 0 }), waitForOllama: async () => false } });
  assert.equal(out.status, 'spooled');
  const last = readLedgerFile().pipelines['auto-wrap'].lastRun;
  assert.equal(last.status, 'skipped');
  assert.equal(last.reason, 'ollama-unreachable');
  assert.ok(q.peek().some((r) => r.sessionId === 'sess-ol'));
  await q.resolve('sess-ol');
});

test('wrap-session.js resets SESSION.md and thereby clears the Wrap Status banner', () => {
  const { spawnSync } = require('child_process');
  writeWrapStatus('sess-ws', 'none');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'wrap-session.js')], { encoding: 'utf8', env: { ...process.env, BRAIN_VAULT: TMP } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.readFileSync(SESSION_PATH, 'utf8').includes('## Wrap Status'));
});

test('wrapCycle with provider none: prefilter draft failures reach the ledger instead of being swallowed', async () => {
  fs.writeFileSync(SESSION_PATH, '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n');
  const draftsDir = path.join(TMP, 'brain', 'memory', 'feedback', '_drafts');
  fs.rmSync(draftsDir, { recursive: true, force: true });
  fs.writeFileSync(draftsDir, 'not a directory'); // writeDraft's mkdirSync now throws EEXIST
  const transcript = path.join(TMP, 'broken-drafts.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'no, use the other binary for this' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n');
  try {
    const out = await wrapCycle({ transcriptPath: transcript, sessionId: 'sess-draftfail', provider: NONE,
      deps: { pruneQueue: async () => ({ dropped: 0 }), waitForOllama: async () => true } });
    assert.equal(out.status, 'disabled');
    const last = readLedgerFile().pipelines['auto-wrap'].lastRun;
    assert.equal(last.status, 'disabled');
    assert.ok(last.counts.draftErrors >= 1);
    assert.equal(last.counts.drafted, undefined);
  } finally {
    fs.rmSync(draftsDir, { recursive: true, force: true });
    fs.mkdirSync(draftsDir, { recursive: true });
  }
});

test('a second wrap of one session reads only what came after the first, and skips when nothing did (no-duplicate-sessions D3)', async () => {
  const transcript = path.join(TMP, 'twice.jsonl');
  const line = (role, text) => JSON.stringify({ type: role, message: { content: [{ type: 'text', text }] } });
  fs.writeFileSync(transcript, [line('user', 'first ask about the ledger'), line('assistant', 'first answer')].join('\n') + '\n');
  const sent = [];
  const COUNTING = { ...CLAUDE, chat: async (o) => { sent.push(JSON.stringify(o)); return JSON.stringify(GOOD_EXTRACTION); } };
  const deps = { pruneQueue: async () => ({ dropped: 0 }), waitForOllama: async () => true };

  assert.equal((await wrapCycle({ transcriptPath: transcript, sessionId: 'sess-twice', provider: COUNTING, deps })).status, 'ok');
  const first = sent.length;
  assert.ok(first > 0);
  assert.ok(sent.some((s) => s.includes('first ask about the ledger')));

  await wrapCycle({ transcriptPath: transcript, sessionId: 'sess-twice', provider: COUNTING, deps });
  assert.equal(sent.length, first, 'nothing new: no model call');
  const last = readLedgerFile().pipelines['auto-wrap'].lastRun;
  assert.equal(last.status, 'skipped');
  assert.equal(last.reason, 'already-wrapped');

  fs.appendFileSync(transcript, [line('user', 'second ask about offsets'), line('assistant', 'second answer')].join('\n') + '\n');
  await wrapCycle({ transcriptPath: transcript, sessionId: 'sess-twice', provider: COUNTING, deps });
  const later = sent.slice(first);
  assert.ok(later.some((s) => s.includes('second ask about offsets')));
  assert.ok(!later.some((s) => s.includes('first ask about the ledger')), 'the wrapped part is not sent again');
});

// ---- the Brain hub's cache after a wrap (brain-hub plan, PR 2 follow-ups) ----
const HUB_PATH = path.join(TMP, 'brain', '_index', 'brain-hub.json');
const MAP_PATH = path.join(TMP, 'brain', '_index', 'brain-map.json');
const STALE_HUB = `${JSON.stringify({ schema: 1, builtAt: '2020-01-01T00:00:00.000Z', counts: { memories: 0 }, batches: [] })}\n`;
const WRITTEN = 'brain/memory/feedback/commit-immediately-after-green-tests.md';

test('a wrap that wrote a memory leaves a fresh brain-hub.json; one that wrote none leaves it alone', async () => {
  fs.writeFileSync(HUB_PATH, STALE_HUB);
  fs.rmSync(MAP_PATH, { force: true });
  const report = { wrote: [], counts: {} };
  const before = Date.now();
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-hub1', chatFn: goodChat, report });
  assert.equal(out.written, 1);
  const hub = JSON.parse(fs.readFileSync(HUB_PATH, 'utf8'));
  assert.ok(Date.parse(hub.builtAt) >= before, 'rebuilt by this wrap');
  assert.ok(hub.counts.memories >= 1);
  assert.ok(hub.batches.some((b) => b.paths.includes(WRITTEN)), 'the new memory waits in a Review batch');
  assert.ok(fs.existsSync(MAP_PATH), 'the map beside it (D19), from the same call');
  assert.deepEqual(report.wrote.filter((p) => p === 'brain/_index/brain-hub.json'), ['brain/_index/brain-hub.json']);
  assert.ok(report.wrote.indexOf('brain/_index/brain-hub.json') > report.wrote.indexOf(WRITTEN));

  fs.writeFileSync(HUB_PATH, STALE_HUB);
  const none = await runAutoWrap({ transcriptText: 'hi', sessionId: 'sess-hub2', chatFn: junkChat, report: { wrote: [], counts: {} } });
  assert.equal(none.written, 0);
  assert.equal(fs.readFileSync(HUB_PATH, 'utf8'), STALE_HUB, 'no memory, no rebuild');
});

test('runAutoWrap rebuilds once, after its corrections stage, with the vault and its config', async () => {
  const correctionChat = () => JSON.stringify({ corrections: [{ title: 'Ask before force-pushing any branch',
    description: 'user reverted an unrequested force push this session',
    body: 'Never force-push unasked.\n\n**Why:** revert cost.\n\n**How to apply:** plain push; ask first.\n\n**Evidence:** "I did not ask you to force push"' }] });
  const calls = [];
  const buildBrainHub = (args) => {
    calls.push({ args, drafts: fs.readdirSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts')).length });
  };
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-hub3', chatFn: goodChat, report: { wrote: [], counts: {} },
    corrections: { enabled: true, chatFn: correctionChat }, deps: { buildBrainHub } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.vault, TMP);
  assert.equal(calls[0].args.cfg.provider, 'none', 'the vault config, as scan-vault passes it');
  assert.equal(calls[0].drafts, 1, 'the corrections stage had written its draft');
});

test('a throwing rebuild never fails the wrap: injected into runAutoWrap and applyExtraction, or a real write error', async () => {
  const boom = () => { throw new Error('hub exploded'); };
  const viaRun = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-hub4', chatFn: goodChat, report: { wrote: [], counts: {} }, deps: { buildBrainHub: boom } });
  assert.equal(viaRun.written, 1);
  const reset = () => {
    fs.rmSync(path.join(TMP, WRITTEN), { force: true });
    fs.writeFileSync(path.join(TMP, 'MEMORY.md'), '# Index\n');
    try { fs.unlinkSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl')); } catch {}
  };
  reset();
  const report = { wrote: [], counts: {} };
  const viaApply = await applyExtraction({ extraction: GOOD_EXTRACTION, sessionId: 'sess-hub5', report, deps: { buildBrainHub: boom } });
  assert.equal(viaApply.written, 1);
  assert.ok(report.wrote.includes(WRITTEN));
  assert.ok(!report.wrote.includes('brain/_index/brain-hub.json'), 'a failed rebuild is not reported as written');

  // The real builder failing, in a child so its stdout is seen whole (the MCP server's stdout is its protocol):
  // brain-hub.json is a folder, so the atomic rename throws; the wrap still writes and prints nothing.
  reset();
  fs.rmSync(HUB_PATH, { recursive: true, force: true });
  fs.mkdirSync(path.join(HUB_PATH, 'in-the-way'), { recursive: true });
  try {
    const { spawnSync } = require('child_process');
    const script = `require(${JSON.stringify(path.join(__dirname, '..', 'auto-wrap.js'))}).applyExtraction({ extraction: ${JSON.stringify(GOOD_EXTRACTION)}, sessionId: 'sess-hub6', report: { wrote: [], counts: {} } })` +
      `.then((o) => process.stderr.write('\\nRESULT ' + JSON.stringify(o) + '\\n'))`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, BRAIN_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(JSON.parse(/^RESULT (.*)$/m.exec(r.stderr)[1]).written, 1);
    assert.ok(fs.existsSync(path.join(TMP, WRITTEN)));
    assert.ok(fs.statSync(HUB_PATH).isDirectory(), 'nothing replaced the folder');
  } finally { fs.rmSync(HUB_PATH, { recursive: true, force: true }); }
});

// ── provider local (local-first A1, A3): the extraction on the local engine; down, the session waits in the spool ──
const P = require('../sdk/lib/provider.js');
const { drainQueue } = require('../auto-wrap.js');
const LOCAL_DOWN = { name: 'none', reason: 'local-down', capabilities: { chat: false, embed: false, structured: false }, chat: async () => { throw new Error('must not be called'); } };
const sessionFile = (name, text) => {
  const t = path.join(TMP, name);
  fs.writeFileSync(t, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text } ] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n') + '\n');
  return t;
};
/** The local engine as provider.js builds it (resolveLocal → makeLocal), answering from `reply` with no server. */
async function localEngine(reply, seen = []) {
  P.resetProviderCache();
  return P.resolveProvider({ mode: 'local', feature: 'auto-wrap', deps: {
    localModels: async () => ['qwen3.5:9b'], recordLocalCall: () => {},
    ollamaChat: async (o) => { seen.push(o); return typeof reply === 'function' ? reply(o) : reply; },
  } });
}

test('the extraction JSON on the local engine: the schema as Ollama\'s format, the workhorse, a memory written', async () => {
  fs.writeFileSync(SESSION_PATH, '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n');
  const seen = [];
  const local = await localEngine(goodChat(), seen);
  assert.deepEqual([local.name, local.engine, local.model], ['ollama', 'ollama', 'qwen3.5:9b']);
  const out = await wrapCycle({ transcriptPath: sessionFile('local-ok.jsonl', 'build the ledger'), sessionId: 'sess-local-ok', provider: local,
    deps: { pruneQueue: async () => ({ dropped: 0 }), waitForOllama: async () => true } });
  assert.equal(out.status, 'ok');
  const extract = seen.find((o) => o.format === 'json' || o.schema);
  assert.deepEqual(extract.schema, EXTRACTION_SCHEMA);
  assert.equal(extract.model, 'qwen3.5:9b');
  assert.equal(extract.feature, 'auto-wrap');
  assert.ok(fs.existsSync(path.join(TMP, 'brain', 'memory', 'feedback', 'commit-immediately-after-green-tests.md')));
  const last = readLedgerFile().pipelines['auto-wrap'].lastRun;
  assert.deepEqual([last.status, last.provider], ['ok', 'ollama']);
});

test('the local engine down: the session is spooled (no hosted call, no prefilter drafts), the banner says it waits', async () => {
  fs.writeFileSync(SESSION_PATH, '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n');
  for (const r of q.peek()) await q.resolve(r.sessionId);
  const out = await wrapCycle({ transcriptPath: sessionFile('local-down.jsonl', 'no, use the other binary for this'), sessionId: 'sess-local-down', provider: LOCAL_DOWN,
    deps: { pruneQueue: async () => ({ dropped: 0 }), waitForOllama: async () => { throw new Error('no wait for a none provider'); } } });
  assert.deepEqual(out, { status: 'spooled', provider: 'none', reason: 'local-down' });
  assert.ok(q.peek().some((r) => r.sessionId === 'sess-local-down'));
  const last = readLedgerFile().pipelines['auto-wrap'].lastRun;
  assert.deepEqual([last.status, last.reason, last.counts.queued], ['skipped', 'local-down', 1]);
  assert.match(fs.readFileSync(SESSION_PATH, 'utf8'), /Session sess-local-down queued: the local model is not answering; it wraps when the model is back/);
  const draftsDir = path.join(TMP, 'brain', 'memory', 'feedback', '_drafts');
  const drafts = fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir).filter((n) => n.endsWith('.md')) : [];
  assert.equal(drafts.length, 0, 'the real wrap will find the correction');
  // local.model not pulled: the same, with its own words.
  await wrapCycle({ transcriptPath: sessionFile('local-missing.jsonl', 'ship it'), sessionId: 'sess-local-missing', provider: { ...LOCAL_DOWN, reason: 'local-model-missing' },
    deps: { pruneQueue: async () => ({ dropped: 0 }) } });
  assert.match(fs.readFileSync(SESSION_PATH, 'utf8'), /queued: the local model is not downloaded yet \(aos local pull\)/);
});

test('the drain: still down, nothing is attempted; back, the spooled sessions wrap and leave the spool', async () => {
  for (const r of q.peek()) await q.resolve(r.sessionId);
  assert.deepEqual(await drainQueue({ provider: LOCAL_DOWN, deps: { pruneQueue: async () => ({ dropped: 0 }) } }), { status: 'empty', wrapped: 0 });
  await q.enqueue({ sessionId: 'sess-wait-1', transcriptPath: sessionFile('wait-1.jsonl', 'build the ledger') });
  const still = await drainQueue({ provider: LOCAL_DOWN, deps: { pruneQueue: async () => ({ dropped: 0 }) } });
  assert.deepEqual(still, { status: 'waiting', reason: 'local-down', wrapped: 0 });
  assert.equal(q.peek().find((r) => r.sessionId === 'sess-wait-1').attempts, 0, 'no attempt spent while it waits');
  const back = await localEngine(goodChat());
  const r = await drainQueue({ provider: back, deps: { pruneQueue: async () => ({ dropped: 0 }) } });
  assert.deepEqual([r.status, r.wrapped, r.provider], ['ok', 1, 'ollama']);
  assert.equal(q.peek().some((x) => x.sessionId === 'sess-wait-1'), false);
});

test('reconcile-sessions starts one drain worker while the spool holds sessions, and none when it is empty', () => {
  const R = require('../reconcile-sessions.js');
  const spawned = [];
  const spawn = (bin, args, opts) => spawned.push({ args, env: opts.env });
  assert.equal(R.drainSpool({ peek: () => [], spawn }), false);
  assert.equal(R.drainSpool({ peek: () => [{ sessionId: 's' }], spawn }), true);
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].args[0], /auto-wrap\.js$/);
  assert.equal(spawned[0].args[1], '--drain');
  assert.equal(spawned[0].env.AUTO_WRAP_DETACHED, '1');
});

test('local-down.js: the line Health and doctor show, from provider-state and the spool, only under provider local', () => {
  const { localWaiting } = require('../lib/local-down.js');
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'local-down-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  const state = (localReason) => fs.writeFileSync(path.join(v, 'brain', '_index', 'provider-state.json'), JSON.stringify({ name: 'none', reason: localReason, localReason }));
  state('local-down');
  fs.writeFileSync(path.join(v, 'brain', '_index', 'auto-wrap-pending.jsonl'), '{"sessionId":"a","transcriptPath":"/x"}\n{"sessionId":"b","transcriptPath":"/y"}\n');
  assert.deepEqual(localWaiting({ cfg: { provider: 'local' }, vault: v }), { reason: 'local-down', queued: 2, line: 'local model down: 2 wraps queued' });
  assert.equal(localWaiting({ cfg: { provider: 'auto' }, vault: v }).line, null, 'other providers: not this signal');
  state('local-model-missing');
  assert.equal(localWaiting({ cfg: { provider: 'local' }, vault: v }).line, 'local model not downloaded: 2 wraps queued');
  state('local-ready');
  assert.deepEqual(localWaiting({ cfg: { provider: 'local' }, vault: v }), { reason: null, queued: 2, line: null });
});
