'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, parseInsightReply, generateInsight } = require('../collectors/workspaceInsights');

test('buildPrompt includes name, status, objectives, subproject names', () => {
  const entry = {
    name: 'SN Claude Skills', status: 'active', summary: 'skill factory',
    objectives: [{ text: 'Ship onboarding' }],
    subprojects: [{ name: 'factory', status: 'active' }],
    next: { text: null }, lastEvent: { ageDays: 2 },
  };
  const p = buildPrompt(entry);
  assert.match(p, /SN Claude Skills/);
  assert.match(p, /active/);
  assert.match(p, /Ship onboarding/);
  assert.match(p, /factory/);
});

test('parseInsightReply extracts INSIGHT and NEXT, NONE -> null', () => {
  const r = parseInsightReply('INSIGHT: Momentum is good.\nNEXT: Unblock QA.');
  assert.equal(r.insight, 'Momentum is good.');
  assert.equal(r.next, 'Unblock QA.');
  const r2 = parseInsightReply('INSIGHT: Steady.\nNEXT: NONE');
  assert.equal(r2.next, null);
});

test('generateInsight returns unavailable when the chat fn throws (offline)', async () => {
  const entry = { name: 'X', status: 'active', summary: '', objectives: [], subprojects: [], next: { text: null }, lastEvent: { ageDays: 0 } };
  const res = await generateInsight(entry, { chatFn: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(res.insight.status, 'unavailable');
  assert.equal(res.insight.text, null);
});

test('generateInsight puts the model\'s next on the insight, never on the entry (spaces-redesign D23)', async () => {
  const entry = { name: 'X', status: 'active', summary: '', objectives: [], subprojects: [], next: { text: null, source: 'derived', from: null }, lastEvent: { ageDays: 0 } };
  const before = JSON.stringify(entry);
  const res = await generateInsight(entry, {
    chatFn: async () => 'INSIGHT: All good.\nNEXT: Ship it.',
    model: 'qwen3.5:9b',
  });
  assert.equal(res.insight.status, 'ok');
  assert.equal(res.insight.text, 'All good.');
  assert.equal(res.insight.model, 'qwen3.5:9b');
  assert.equal(res.insight.next, 'Ship it.');
  assert.equal('next' in res, false, 'no next comes back to assign to the workspace');
  assert.equal(JSON.stringify(entry), before, 'the entry is untouched');
  const none = await generateInsight(entry, { chatFn: async () => 'INSIGHT: Steady.\nNEXT: NONE', model: 'm' });
  assert.equal(none.insight.next, null);
  const offline = await generateInsight(entry, { chatFn: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(offline.insight.next, null);
});

test('the insight\'s next is carried forward with the insight while its inputs are unchanged (spaces-redesign D23)', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { collectWorkspaces, finalizeWorkspaces } = require('../collectors/workspaces');
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ins-carry-'));
  fs.mkdirSync(path.join(vault, 'workspaces', 'w'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'workspaces', 'w', 'README.md'), '# W\n\nA real summary.\n');
  const scan = (prev) => finalizeWorkspaces(collectWorkspaces({ vault }), { vault, prev, cfg: {}, now: Date.parse('2026-10-09T12:00:00Z') });
  const [first] = scan([]);
  first.insight = (await generateInsight(first, { chatFn: async () => 'INSIGHT: Quiet.\nNEXT: Write the plan.', model: 'm' })).insight;
  assert.equal(first.next.text, null);
  const [again] = scan([first]);
  assert.equal(again.insight.next, 'Write the plan.');
  assert.equal(again.next.text, null, 'the suggestion never becomes the workspace\'s next');
  fs.writeFileSync(path.join(vault, 'workspaces', 'w', 'README.md'), '# W\n\nA different summary.\n');
  const [changed] = scan([first]);
  assert.equal(changed.insight.status, 'unavailable', 'changed inputs drop the cached insight and its next');
});

const NONE = { name: 'none', reason: 'forced', capabilities: { chat: false, embed: false, structured: false }, chat: async () => { throw new Error('must not be called'); } };
const ENTRY = { name: 'X', status: 'idle', summary: '', objectives: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], subprojects: [], next: { text: null, source: 'derived' }, lastEvent: { ageDays: 12 }, inputHash: 'h1' };

test('provider none → heuristic insight, status ok, model heuristic', async () => {
  const res = await generateInsight(ENTRY, { provider: NONE });
  assert.equal(res.insight.status, 'ok');
  assert.equal(res.insight.model, 'heuristic');
  assert.equal(res.insight.text, 'Stalled 12d · 3 objectives open · next step unset');
  assert.equal(res.insight.inputHash, 'h1');
  assert.equal(res.insight.next, null);
  assert.equal('next' in res, false);
});

test('provider claude → heuristic unless scan.insightsUnderClaude is on', async () => {
  const fs = require('fs');
  const { PATHS } = require('../lib/paths.js');
  let calls = 0;
  const CLAUDE = { name: 'claude', reason: 'forced', capabilities: { chat: true, embed: false, structured: true }, chat: async () => { calls++; return 'INSIGHT: Claude says.\nNEXT: NONE'; } };
  fs.writeFileSync(PATHS.CONFIG_JSON, JSON.stringify({ provider: 'none' }));
  const off = await generateInsight(ENTRY, { provider: CLAUDE });
  assert.equal(off.insight.model, 'heuristic');
  assert.equal(calls, 0);
  fs.writeFileSync(PATHS.CONFIG_JSON, JSON.stringify({ provider: 'none', scan: { insightsUnderClaude: true } }));
  const on = await generateInsight(ENTRY, { provider: CLAUDE });
  assert.equal(calls, 1);
  assert.equal(on.insight.text, 'Claude says.');
  assert.equal(on.insight.model, 'haiku');
  fs.writeFileSync(PATHS.CONFIG_JSON, JSON.stringify({ provider: 'none' }));
});

test('provider codex → heuristic unless scan.insightsUnderCodex is on; the insight names the codex model', async () => {
  const fs = require('fs');
  const { PATHS } = require('../lib/paths.js');
  let calls = 0;
  const CODEX = { name: 'codex', reason: 'forced', model: 'gpt-5-mini', capabilities: { chat: true, embed: false, structured: true }, chat: async () => { calls++; return 'INSIGHT: Codex says.\nNEXT: NONE'; } };
  fs.writeFileSync(PATHS.CONFIG_JSON, JSON.stringify({ provider: 'none', scan: { insightsUnderClaude: true } }));
  assert.equal((await generateInsight(ENTRY, { provider: CODEX })).insight.model, 'heuristic', 'the Claude opt-in does not open Codex');
  assert.equal(calls, 0);
  fs.writeFileSync(PATHS.CONFIG_JSON, JSON.stringify({ provider: 'none', scan: { insightsUnderCodex: true } }));
  const on = await generateInsight(ENTRY, { provider: CODEX });
  assert.equal(calls, 1);
  assert.equal(on.insight.text, 'Codex says.');
  assert.equal(on.insight.model, 'gpt-5-mini');
  fs.writeFileSync(PATHS.CONFIG_JSON, JSON.stringify({ provider: 'none' }));
});

test('provider ollama → chats with the workhorse tag and the feature label', async () => {
  let seen;
  const OLLAMA = { name: 'ollama', reason: 'forced', capabilities: { chat: true, embed: true, structured: true }, chat: async (o) => { seen = o; return 'INSIGHT: Fine.\nNEXT: Ship.'; } };
  const res = await generateInsight(ENTRY, { provider: OLLAMA });
  assert.equal(res.insight.text, 'Fine.');
  assert.equal(seen.feature, 'workspace-insights');
  assert.equal(res.insight.model, require('../sdk/lib/models.js').role('workhorse').tag);
});

// local-first A3: the local engine failing mid-scan gives the heuristic insight, never an empty one.
test('generateInsight on the local engine that fails: the heuristic insight', async () => {
  const entry = { name: 'demo', inputHash: 'h', status: 'active', commits: [], sessions: [], files: [], workspaceMd: null };
  const local = { name: 'ollama', engine: 'ollama', model: 'qwen3.5:4b', chat: async () => { throw new Error('socket hang up'); } };
  const res = await generateInsight(entry, { provider: local });
  assert.equal(res.insight.model, 'heuristic');
  const hosted = { name: 'ollama', chat: async () => { throw new Error('socket hang up'); } };
  assert.equal((await generateInsight(entry, { provider: hosted })).insight.status, 'unavailable', 'auto\'s Ollama keeps today\'s behaviour');
});
