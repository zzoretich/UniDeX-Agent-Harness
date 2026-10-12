'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'brain', 'memory', 'feedback'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
fs.writeFileSync(path.join(TMP, 'MEMORY.md'), '# Memory Index\n\n## User\n\n## Feedback (how to work)\n\n## Project\n\n## Reference\n\n## Patterns\n');
fs.writeFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), '---\ntype: session\n---\n\n# Current Session Working Memory\n\n## Active Task\n\n## Key Context This Session\n\n## Decisions Made\n\n## Things to Remember\n\n## Promote to Memory on Close\n');
const SERVER = path.join(__dirname, '..', 'sdk', 'mcp-server.js');

async function withClient(fn, extraEnv) {
  const headless = extraEnv && extraEnv.AOS_HEADLESS;
  const transport = new StdioClientTransport({
    command: process.execPath,
    // The child sets AOS_HEADLESS itself: test/setup.js is preloaded in the child too (inherited NODE_OPTIONS)
    // and deletes an inherited AOS_HEADLESS, so passing it through env would never reach the server.
    args: headless ? ['-e', `process.env.AOS_HEADLESS='1'; require(${JSON.stringify(SERVER)})`] : [SERVER],
    env: { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json'), ...extraEnv },
  });
  const client = new Client({ name: 'wrap-session-test', version: '0.0.0' });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}

test('the server lists wrap_session next to the fifteen read tools', async () => {
  await withClient(async (client) => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['brief_read', 'feedback_rules', 'graph_neighbors', 'graph_overview', 'graph_path', 'graph_query', 'memory_list', 'memory_read',
      'memory_search', 'pattern_list', 'recall', 'routine_list', 'session_list', 'session_recall', 'snapshot_read', 'wrap_session']);
  });
});

test('wrap_session writes a memory, a MEMORY.md line, SESSION.md sections, a draft, and a ledger entry', async () => {
  const out = await withClient(async (client) => {
    const res = await client.callTool({ name: 'wrap_session', arguments: {
      sessionId: 'sess-tool-1',
      facts: ['Wired the provider layer', 'Suite stayed green'],
      decisions: ['Chose skipped over ok for empty cycles'],
      feedback: [], threads: ['Plan 3 next'],
      candidates: [{ type: 'feedback', title: 'Prefer skipped over ok for empty cycles',
        description: 'an empty cycle must not render as a green success',
        body: 'Report skipped when nothing was written.\n**Why:** green lies.\n**How to apply:** report.skip(reason).' }],
      corrections: [{ quote: 'no, never mark an empty run ok', rule: 'Never record an empty cycle as ok', why: 'the dashboard showed green for a run that wrote nothing' }],
    } });
    return JSON.parse(res.content[0].text);
  });
  assert.deepEqual(Object.keys(out).sort(), ['drafts', 'reasons', 'skipped', 'written']);
  assert.equal(out.written, 1);
  assert.equal(out.drafts, 1);
  assert.ok(fs.existsSync(path.join(TMP, 'brain', 'memory', 'feedback', 'prefer-skipped-over-ok-for-empty.md')));
  assert.match(fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf8'), /## Feedback \(how to work\)\n- \[Prefer skipped over ok for empty cycles\]\(brain\/memory\/feedback\/prefer-skipped-over-ok-for-empty\.md\) — an empty cycle/);
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.match(session, /## Key Context This Session\n\n- Wired the provider layer/);
  assert.match(session, /## Open Threads\n\n- Plan 3 next/);
  assert.match(session, /## Pending Feedback Drafts/);
  assert.ok(fs.existsSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts', 'never-record-an-empty-cycle-as.md')));
  const ledger = JSON.parse(fs.readFileSync(path.join(TMP, 'brain', '_index', 'pipelines.json'), 'utf8'));
  assert.equal(ledger.pipelines['auto-wrap'].lastRun.status, 'ok');
  assert.equal(ledger.pipelines['auto-wrap'].lastRun.provider, 'in-session');
  assert.equal(ledger.pipelines['auto-wrap'].lastRun.counts.written, 1);
  // The Brain hub's cache follows the wrap (brain-hub plan, PR 2 follow-ups): Review shows the memory before a scan.
  const hub = JSON.parse(fs.readFileSync(path.join(TMP, 'brain', '_index', 'brain-hub.json'), 'utf8'));
  assert.ok(hub.batches.some((b) => b.paths.includes('brain/memory/feedback/prefer-skipped-over-ok-for-empty.md')));
  assert.equal(hub.counts.drafts, 1, 'built after the draft was written');
  assert.ok(ledger.pipelines['auto-wrap'].lastRun.wrote.includes('brain/_index/brain-hub.json'));
});

test('wrap_session rejects a malformed candidate type', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'wrap_session', arguments: {
      facts: [], decisions: [], feedback: [], threads: [],
      candidates: [{ type: 'pattern', title: 't', description: 'd', body: 'b' }],
    } });
    assert.equal(res.isError, true);
  });
});

test('wrap_session refuses under AOS_HEADLESS=1 without exiting the server', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'wrap_session', arguments: {
      facts: [], decisions: [], feedback: [], threads: [], candidates: [],
    } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /AOS_HEADLESS/);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['brief_read', 'feedback_rules', 'graph_neighbors', 'graph_overview', 'graph_path', 'graph_query', 'memory_list', 'memory_read',
      'memory_search', 'pattern_list', 'recall', 'routine_list', 'session_list', 'session_recall', 'snapshot_read', 'wrap_session']);
  }, { AOS_HEADLESS: '1' });
});
