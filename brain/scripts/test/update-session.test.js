'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isJunkSummary, renderLastSession, renderWorkingMemory, summaryPolicy, summaryMarkerName, parseSummaryMarker, shouldSummarize } = require('../update-session.js');

// ── throttle (spec 2026-09-24-summary-throttle) ──
const MIN = 60000;
const POLICY = { everyPrompts: 10, minMinutes: 15 };

test('shouldSummarize waits for everyPrompts new prompts and minMinutes since the last summary', () => {
  const fresh = { prompts: 0, at: 0 };
  assert.equal(shouldSummarize({ prompts: 9, last: fresh, now: 100 * MIN, ...POLICY }), false);
  assert.equal(shouldSummarize({ prompts: 10, last: fresh, now: 100 * MIN, ...POLICY }), true);
  const last = { prompts: 10, at: 100 * MIN };
  assert.equal(shouldSummarize({ prompts: 25, last, now: 110 * MIN, ...POLICY }), false, '15 prompts but only 10 minutes');
  assert.equal(shouldSummarize({ prompts: 25, last, now: 115 * MIN, ...POLICY }), true);
  assert.equal(shouldSummarize({ prompts: 19, last, now: 200 * MIN, ...POLICY }), false, 'an hour later but 9 prompts');
  assert.equal(shouldSummarize({ prompts: 0, last: fresh, now: 100 * MIN, everyPrompts: 1, minMinutes: 0 }), false);
});

test('shouldSummarize counts from zero when the transcript started over', () => {
  assert.equal(shouldSummarize({ prompts: 10, last: { prompts: 40, at: 0 }, now: 100 * MIN, ...POLICY }), true);
  assert.equal(shouldSummarize({ prompts: 4, last: { prompts: 40, at: 0 }, now: 100 * MIN, ...POLICY }), false);
});

test('one marker per session, and a payload without session_id falls back to the day', () => {
  assert.equal(summaryMarkerName({ session_id: 'abc-123' }, '2026-09-24'), '.last-summary-abc-123');
  assert.equal(summaryMarkerName({ sessionId: 'xyz' }, '2026-09-24'), '.last-summary-xyz');
  assert.notEqual(summaryMarkerName({ session_id: 'a' }), summaryMarkerName({ session_id: 'b' }));
  assert.equal(summaryMarkerName({}, '2026-09-24'), '.last-summary-2026-09-24');
  assert.equal(summaryMarkerName(null, '2026-09-24'), '.last-summary-2026-09-24');
});

test('parseSummaryMarker reads { prompts, at } and starts an old bare-number marker over', () => {
  assert.deepEqual(parseSummaryMarker('{"prompts":12,"at":1727190000000}'), { prompts: 12, at: 1727190000000 });
  assert.deepEqual(parseSummaryMarker('306'), { prompts: 0, at: 0 });
  assert.deepEqual(parseSummaryMarker(''), { prompts: 0, at: 0 });
  assert.deepEqual(parseSummaryMarker('not json'), { prompts: 0, at: 0 });
});

test('summaryPolicy reads summary.* and falls back to 10 prompts / 15 minutes', () => {
  assert.deepEqual(summaryPolicy({ summary: { everyPrompts: 5, minMinutes: 0 } }), { everyPrompts: 5, minMinutes: 0 });
  assert.deepEqual(summaryPolicy({}), POLICY);
  assert.deepEqual(summaryPolicy({ summary: { everyPrompts: 0, minMinutes: -1 } }), POLICY);
  assert.deepEqual(summaryPolicy({ summary: { everyPrompts: '10', minMinutes: 'x' } }), POLICY);
});

const GOOD = '*   Shipped the P0 repair pass and committed plugin source.\n*   Decided cost re-anchors monthly via cost-budget.js.\n*   Open thread: verify pty rebuild on next Obsidian update.';
const JUNK1 = '- The provided session log contains empty `user:` fields with no actual conversation captured.\n- No code files were built, modified, or changed.\n- Summary reflects an empty state rather than completed work.';
const JUNK2 = '';

test('isJunkSummary keeps real summaries', () => {
  assert.equal(isJunkSummary(GOOD), false);
});

test('isJunkSummary rejects empty-log boilerplate and blanks', () => {
  assert.equal(isJunkSummary(JUNK1), true);
  assert.equal(isJunkSummary(JUNK2), true);
});

test('renderLastSession replaces the section WITHOUT accumulating trailing blank lines', () => {
  const brain = '# BRAIN\n\n## Active context\n- stuff\n\n## Last Session\n- **Date**: 2026-08-01\n- **Auto-summary**: old\n' + '\n'.repeat(120);
  const out = renderLastSession(brain, GOOD, '2026-08-05');
  assert.ok(out.includes('- **Date**: 2026-08-05'));
  assert.ok(!out.includes('old'));
  assert.ok(out.endsWith('.md\n') === false); // sanity: no path garbage
  assert.ok(!/\n{3,}$/.test(out), 'must not end with piles of blank lines');
  // idempotent: re-rendering does not grow the file
  assert.equal(renderLastSession(out, GOOD, '2026-08-05').length, out.length);
});

test('renderWorkingMemory fills Key Context between its heading and the next section', () => {
  const sess = '# Current Session Working Memory\n\n## Active Task\n\n## Key Context This Session\n\n## Decisions Made\n\n## Things to Remember\n';
  const out = renderWorkingMemory(sess, GOOD, '8/5/2026, 14:00:00');
  assert.ok(out.includes('## Key Context This Session'));
  assert.ok(out.includes('Shipped the P0 repair pass'));
  assert.ok(out.indexOf('## Decisions Made') > out.indexOf('Shipped the P0 repair pass'));
  // idempotent: second write replaces, not appends
  const out2 = renderWorkingMemory(out, GOOD, '8/5/2026, 15:00:00');
  assert.equal((out2.match(/Shipped the P0 repair pass/g) || []).length, 1);
});

// --- live incident 2026-08-07: the last-10-raw-entries window fed qwen mostly
// tool-results/command envelopes; it truthfully described the garbage and the
// blocklist missed the paraphrase, so the junk landed in BRAIN.md + daily note ---

const LIVE_HALLUCINATION = [
  '*   Session text contains only metadata headers (date/prompt fields) with no actual user or assistant conversation logs.',
  '*   No code, features, or architectural changes were built based on the absence of interaction history in this block.',
  '*   Critical decisions remain undocumented as there were no instructions provided to drive specific outcomes.',
  '*   Open threads regarding project scope and execution are undefined due to missing context in the provided session data.',
].join('\n');

test('isJunkSummary rejects the 2026-08-07 live hallucination verbatim', () => {
  assert.equal(isJunkSummary(LIVE_HALLUCINATION), true);
});

test('isJunkSummary still keeps a real summary that MENTIONS metadata work', () => {
  const real = '*   Fixed the transcript parser to skip metadata headers before costing.\n*   Decided num_ctx auto-sizes per request.\n*   Open thread: reload Obsidian for the rebuilt plugin.';
  assert.equal(isJunkSummary(real), false);
});

const { conversationTail } = require('../update-session.js');

function userEntry(text) { return { type: 'user', message: { content: [{ type: 'text', text }] } }; }
function assistantEntry(text) { return { type: 'assistant', message: { content: [{ type: 'text', text }] } }; }
function toolResultEntry() {
  return { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'raw tool output' }] }] } };
}

test('conversationTail keeps real dialogue and drops empty/tool-result entries', () => {
  const t = [
    userEntry('fix the scanner please'),
    assistantEntry('on it — reading the code'),
    toolResultEntry(),           // extracted text is empty → dropped
    { type: 'system', content: 'hook noise' },
    assistantEntry('fixed and tested'),
  ];
  const out = conversationTail(t);
  assert.match(out, /user: fix the scanner please/);
  assert.match(out, /assistant: fixed and tested/);
  assert.ok(!/tool output/.test(out), 'tool_result bodies must not leak in');
  assert.ok(!/hook noise/.test(out), 'non-dialogue entry types are dropped');
});

test('conversationTail drops slash-command envelopes and isMeta entries', () => {
  const t = [
    userEntry('<command-name>/wrap</command-name>\n<command-message>wrap</command-message>'),
    { ...userEntry('meta helper line'), isMeta: true },
    userEntry('real question about the build'),
  ];
  const out = conversationTail(t);
  assert.ok(!/command-name/.test(out));
  assert.ok(!/meta helper line/.test(out));
  assert.match(out, /real question about the build/);
});

test('conversationTail fills its budget from the END of the conversation', () => {
  const t = [];
  for (let i = 0; i < 200; i++) t.push(userEntry(`turn ${i} ` + 'x'.repeat(400)));
  const out = conversationTail(t);
  assert.ok(out.length <= 12000 + 500, `bounded input, got ${out.length}`);
  assert.match(out, /turn 199/, 'newest messages included');
  assert.ok(!/turn 0 /.test(out), 'oldest messages dropped first');
});

// ---- provider paths (Plan 2) ----
const fs = require('fs');
const { PATHS } = require('../lib/paths.js');
const { summaryCycle } = require('../update-session.js');

const TEMPLATE = '# Current Session Working Memory\n\n## Active Task\n\n## Key Context This Session\n\n## Decisions Made\n\n## Things to Remember\n';
function fakeReport() {
  return { wrote: [], counts: {}, provider: null, reason: null, status: null,
    skip(r) { this.status = 'skipped'; this.reason = r; }, disable(r) { this.status = 'disabled'; this.reason = r; } };
}
const NONE = { name: 'none', reason: 'forced', capabilities: { chat: false, embed: false, structured: false }, chat: async () => { throw new Error('must not be called'); } };
const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n');
const U = (text) => ({ type: 'user', message: { content: [{ type: 'text', text }] } });
const A = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('provider none: heuristic Key Context lands in SESSION.md, ledger ok with provider none', async () => {
  fs.writeFileSync(PATHS.SESSION_MD, TEMPLATE);
  const text = jsonl(U('please fix the scanner'), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/home/alice/v/scan-vault.js' } }] } });
  const report = fakeReport();
  const out = await summaryCycle({ transcript: [], transcriptText: text, provider: NONE, report });
  assert.equal(out.status, 'ok');
  assert.equal(report.provider, 'none');
  assert.equal(report.status, null);
  assert.equal(report.counts.written, 1);
  const session = fs.readFileSync(PATHS.SESSION_MD, 'utf8');
  assert.match(session, /- Asked: please fix the scanner/);
  assert.match(session, /Files touched: scan-vault\.js/);
  assert.ok(session.indexOf('## Decisions Made') > session.indexOf('Asked: please fix'));
});

test('provider none with no dialogue: skipped / no-signal, SESSION.md untouched', async () => {
  fs.writeFileSync(PATHS.SESSION_MD, TEMPLATE);
  const report = fakeReport();
  const out = await summaryCycle({ transcript: [], transcriptText: jsonl(A('hi')), provider: NONE, report });
  assert.equal(out.status, 'skipped');
  assert.equal(report.status, 'skipped');
  assert.equal(report.reason, 'no-signal');
  assert.equal(fs.readFileSync(PATHS.SESSION_MD, 'utf8'), TEMPLATE);
});

test('provider claude: summarize runs through provider.chat with the feature label and writes BRAIN.md', async () => {
  fs.writeFileSync(PATHS.SESSION_MD, TEMPLATE);
  fs.writeFileSync(PATHS.BRAIN_MD, '# BRAIN\n\n## Last Session\n- **Date**: 2026-01-01\n- **Auto-summary**: old\n');
  let seen;
  const CLAUDE = { name: 'claude', reason: 'forced', capabilities: { chat: true, embed: false, structured: true },
    chat: async (o) => { seen = o; return '- Fixed the scanner budget\n- Decided to keep BM25\n- Open: rebuild the plugin'; } };
  const transcript = [U('fix the scanner budget'), A('done, kept BM25')];
  const report = fakeReport();
  const out = await summaryCycle({ transcript, transcriptText: jsonl(...transcript), provider: CLAUDE, report, date: '2026-09-04' });
  assert.equal(out.status, 'ok');
  assert.equal(report.provider, 'claude');
  assert.equal(seen.feature, 'session-summary');
  assert.ok(!('format' in seen) && !('schema' in seen), 'summary is unstructured');
  assert.match(fs.readFileSync(PATHS.BRAIN_MD, 'utf8'), /Auto-summary\*\*: - Fixed the scanner budget/);
  assert.match(fs.readFileSync(PATHS.SESSION_MD, 'utf8'), /Decided to keep BM25/);
});

test('a provider at its daily cap is skipped / daily-cap, not no-summary', async () => {
  fs.writeFileSync(PATHS.SESSION_MD, TEMPLATE);
  const CAPPED = { name: 'claude', reason: 'forced', capabilities: { chat: true, embed: false, structured: true },
    chat: async () => { throw Object.assign(new Error('cap'), { code: 'PROVIDER_CAP' }); } };
  const transcript = [U('x'), A('y')];
  const report = fakeReport();
  const out = await summaryCycle({ transcript, transcriptText: jsonl(...transcript), provider: CAPPED, report });
  assert.equal(out.status, 'skipped');
  assert.equal(report.reason, 'daily-cap');
  assert.equal(report.counts.skipped, 1);
});

test('any other provider failure surfaces as an error instead of a silent skip', async () => {
  fs.writeFileSync(PATHS.SESSION_MD, TEMPLATE);
  const BROKEN = { name: 'claude', reason: 'forced', capabilities: { chat: true, embed: false, structured: true },
    chat: async () => { throw new Error('boom'); } };
  const transcript = [U('x'), A('y')];
  const report = fakeReport();
  await assert.rejects(
    () => summaryCycle({ transcript, transcriptText: jsonl(...transcript), provider: BROKEN, report }),
    /boom/);
});

test('a junk model summary is skipped / junk-summary', async () => {
  fs.writeFileSync(PATHS.SESSION_MD, TEMPLATE);
  const JUNKY = { name: 'ollama', reason: 'forced', capabilities: { chat: true, embed: true, structured: true },
    chat: async () => '- The log was empty\n- No actual conversation captured' };
  const transcript = [U('x'), A('y')];
  const report = fakeReport();
  const out = await summaryCycle({ transcript, transcriptText: jsonl(...transcript), provider: JUNKY, report });
  assert.equal(out.status, 'skipped');
  assert.equal(report.reason, 'junk-summary');
  assert.equal(report.counts.skipped, 1);
});

// local-first A3: under provider local the Stop summary never reaches a host; the engine down (at resolve or mid-call)
// is the heuristic Key Context.
test('the local engine down at resolve, or failing mid-call: the heuristic summary, never an error', async () => {
  const text = jsonl(U('please fix the scanner'), A('fixed'));
  fs.writeFileSync(PATHS.SESSION_MD, TEMPLATE);
  let report = fakeReport();
  let out = await summaryCycle({ transcript: [], transcriptText: text, provider: { ...NONE, reason: 'local-down' }, report });
  assert.deepEqual([out.status, report.provider, report.counts.localDown], ['ok', 'none', 1]);
  assert.match(fs.readFileSync(PATHS.SESSION_MD, 'utf8'), /- Asked: please fix the scanner/);

  fs.writeFileSync(PATHS.SESSION_MD, TEMPLATE);
  report = fakeReport();
  const gone = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  const LOCAL = { name: 'ollama', engine: 'ollama', reason: 'local-ready', capabilities: { chat: true }, chat: async () => { throw gone; } };
  const transcript = [U('please fix the scanner'), A('fixed')];
  out = await summaryCycle({ transcript, transcriptText: jsonl(...transcript), provider: LOCAL, report });
  assert.deepEqual([out.status, report.provider, report.counts.localDown], ['ok', 'none', 1]);
  assert.match(fs.readFileSync(PATHS.SESSION_MD, 'utf8'), /- Asked: please fix the scanner/);
});
