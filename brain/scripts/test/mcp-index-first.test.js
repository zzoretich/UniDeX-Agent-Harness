'use strict';
// feedback_rules / memory_list / session_recall return an index first and stay small (spec 2026-09-24-mcp-index-first).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mif-'));
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
  fs.writeFileSync(path.join(TMP, rel), text);
};
const memory = (updated, h1, body) => `---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-09-01\nupdated: ${updated}\n---\n\n# ${h1}\n\n${body}\n`;

put('brain/config.json', JSON.stringify({ provider: 'none' }));
put('brain/memory/feedback/keep-terminal-on.md', memory('2026-09-24', 'Keep the terminal on', 'The embedded terminal stays on.\n\n**Why:** the owner said so.'));
put('brain/memory/feedback/old-rule.md', memory('2026-09-02', 'An older rule', '**Always** run the gate before a push.\n\nMore text.'));
put('brain/memory/feedback/_drafts/unreviewed.md', memory('2026-09-25', 'An unreviewed draft', 'Not a rule yet.'));
put('brain/memory/projects/settings-tab.md', memory('2026-09-20', 'Settings tab', 'Phase 3 is left.').replace('memory/feedback', 'memory/projects'));
put('MEMORY.md', [
  '# Memory Index', '',
  '## Feedback (how to work)',
  '- [Terminal stays on](brain/memory/feedback/keep-terminal-on.md) — Owner decision: keep terminalEmbedded on',
  '', '## Project', '',
].join('\n'));
const NOTE = 'x'.repeat(29990) + '\nlast line\n';
put('2026/2026-09-September/2026-09-20.md', NOTE);

const SERVER = path.join(__dirname, '..', 'sdk', 'mcp-server.js');

async function call(name, args = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') },
  });
  const client = new Client({ name: 'mcp-index-first-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name, arguments: args });
    return res.content[0].text;
  } finally { await client.close(); }
}

test('feedback_rules returns an index of the active rules, newest first, drafts left out', async () => {
  const text = await call('feedback_rules');
  assert.ok(!text.includes('\n'), 'compact JSON');
  const out = JSON.parse(text);
  assert.equal(out.count, 2);
  assert.equal(out.shown, 2);
  assert.deepEqual(out.rules, [
    { path: 'brain/memory/feedback/keep-terminal-on.md', title: 'Keep the terminal on', description: 'Owner decision: keep terminalEmbedded on', updated: '2026-09-24' },
    { path: 'brain/memory/feedback/old-rule.md', title: 'An older rule', description: 'Always run the gate before a push.', updated: '2026-09-02' },
  ]);
  assert.ok(!text.includes('_drafts'), 'no draft in the index');
});

test('feedback_rules full: true carries each rule\'s text, and limit keeps the newest', async () => {
  const full = JSON.parse(await call('feedback_rules', { full: true }));
  assert.match(full.rules[0].content, /^---\ntype: memory/);
  assert.match(full.rules[1].content, /More text\./);
  const one = JSON.parse(await call('feedback_rules', { limit: 1 }));
  assert.equal(one.count, 2);
  assert.equal(one.shown, 1);
  assert.equal(one.rules[0].path, 'brain/memory/feedback/keep-terminal-on.md');
  assert.equal(one.rules[0].content, undefined);
});

test('memory_list is an index grouped by type, drafts left out, with type and limit filters', async () => {
  const all = JSON.parse(await call('memory_list'));
  assert.equal(all.total, 3);
  assert.deepEqual(Object.keys(all.byType).sort(), ['feedback', 'projects']);
  assert.deepEqual(Object.keys(all.byType.projects[0]).sort(), ['description', 'path', 'title', 'updated']);
  const projects = JSON.parse(await call('memory_list', { type: 'projects' }));
  assert.equal(projects.total, 1);
  assert.equal(projects.byType.projects[0].title, 'Settings tab');
  const newest = JSON.parse(await call('memory_list', { limit: 1 }));
  assert.equal(newest.shown, 1);
  assert.deepEqual(Object.keys(newest.byType), ['feedback']);
});

test('session_recall caps a long note and says how to read the rest', async () => {
  const capped = await call('session_recall', { date: '2026-09-20' });
  assert.equal(capped.startsWith('x'.repeat(24000)), true);
  assert.match(capped, /…\[truncated: 24000 of 30001 characters; call session_recall with maxChars: 30001 for all of it\]$/);
  assert.equal(await call('session_recall', { date: '2026-09-20', maxChars: 30001 }), NOTE);
});

test('feedback_rules leaves out a rule archived or superseded in the Brain tab (brain-hub D5, D7)', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mif-retired-'));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), text); };
  write('brain/config.json', JSON.stringify({ provider: 'none' }));
  write('brain/memory/feedback/live-rule.md', memory('2026-10-01', 'A live rule', 'Still applies.'));
  write('brain/memory/feedback/archived-rule.md', memory('2026-10-02', 'An archived rule', 'Retired.').replace('status/active', 'status/archived').replace('---\n\n#', 'archived: 2026-10-11\n---\n\n#'));
  write('brain/memory/feedback/merged-rule.md', memory('2026-10-03', 'A superseded rule', 'Folded into the live one.').replace('status/active', 'status/superseded').replace('---\n\n#', 'superseded_by: brain/memory/feedback/live-rule.md\n---\n\n#'));
  write('MEMORY.md', '# Memory Index\n\n## Feedback (how to work)\n- [A live rule](brain/memory/feedback/live-rule.md) — still applies\n');
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, AOS_VAULT: vault, AOS_CONFIG: path.join(vault, 'none.json') } });
  const client = new Client({ name: 'mcp-index-first-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const out = JSON.parse((await client.callTool({ name: 'feedback_rules', arguments: {} })).content[0].text);
    assert.equal(out.count, 1);
    assert.deepEqual(out.rules.map((r) => r.path), ['brain/memory/feedback/live-rule.md']);
  } finally { await client.close(); }
});
