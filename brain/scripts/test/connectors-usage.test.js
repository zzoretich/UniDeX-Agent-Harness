'use strict';
// connectors-tab D13: MCP usage from both hosts' transcripts, incremental, mapped to discovered names; built-ins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const U = require('../lib/connectors/usage.js');
const T = require('../lib/transcript.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function claudeLine(id, name, msAgo) {
  return JSON.stringify({ type: 'assistant', timestamp: iso(msAgo), message: { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id, name, input: {} }] } });
}
function codexLine(id, server, tool, msAgo) {
  return JSON.stringify({ timestamp: iso(msAgo), type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: id, invocation: { server, tool, arguments: {} }, result: { Ok: {} } } });
}
function put(file, lines, mtimeMsAgo = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const t = new Date(NOW - mtimeMsAgo);
  fs.utimesSync(file, t, t);
  return file;
}

function world() {
  const T0 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-usage-')));
  const claudeDir = path.join(T0, 'claude');
  const codexHome = path.join(T0, 'codex');
  const vault = path.join(T0, 'vault');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  const proj = path.join(claudeDir, 'projects', '-work-alpha');
  const main = put(path.join(proj, 'sess-1.jsonl'), [
    claudeLine('t1', 'mcp__claude_ai_Mail__search', 2 * DAY),
    claudeLine('t1', 'mcp__claude_ai_Mail__search', 2 * DAY), // the same block written twice: one call
    claudeLine('t2', 'mcp__plugin_helper_helper__run', 1 * DAY),
    claudeLine('t3', 'mcp__docs__lookup', 0),
    claudeLine('t4', 'mcp__claude-in-chrome__navigate', 0),
    claudeLine('t5', 'mcp__docs__lookup', 40 * DAY), // before the window
    claudeLine('t6', 'Read', 0), // not MCP
  ]);
  put(path.join(proj, 'sess-1', 'subagents', 'agent-a.jsonl'), [claudeLine('s1', 'mcp__docs__lookup', 0)]);
  put(path.join(proj, 'sess-1', 'subagents', 'workflows', 'wf_1', 'agent-b.jsonl'), [claudeLine('s2', 'mcp__docs__fetch', 0)]);
  put(path.join(proj, 'sess-2.jsonl'), [claudeLine('u1', 'mcp__docs__lookup', 3 * DAY)], 3 * DAY);
  put(path.join(proj, 'ancient.jsonl'), [claudeLine('a1', 'mcp__docs__lookup', 50 * DAY)], 50 * DAY);
  const rollout = put(path.join(codexHome, 'sessions', '2026', '10', '20', 'rollout-2026-10-20T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.jsonl'), [
    JSON.stringify({ timestamp: iso(0), type: 'session_meta', payload: { id: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', cwd: '/w' } }),
    codexLine('c1', 'fetcher', 'get', 0),
    codexLine('c1', 'fetcher', 'get', 0),
    codexLine('c2', 'agenticos', 'memory_list', 0),
  ]);
  const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome };
  const userConfig = { claudeConfigDir: claudeDir, hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  const rows = [
    { host: 'claude', name: 'claude.ai Mail' }, { host: 'claude', name: 'plugin:helper:helper' }, { host: 'claude', name: 'docs' },
    { host: 'codex', name: 'fetcher' }, { host: 'codex', name: 'agenticos' },
  ];
  return { T0, vault, env, userConfig, rows, main, rollout, proj };
}

const run = (w, extra = {}) => U.collectUsage({ vault: w.vault, userConfig: w.userConfig, env: w.env, now: NOW, days: 30, rows: w.rows, ...extra });
const find = (r, host, name) => r.rows.find((x) => x.host === host && x.name === name);

test('usage: calls per server mapped to discovered names; unmatched keys are built-ins; each call once', () => {
  const w = world();
  const r = run(w);
  assert.equal(find(r, 'claude', 'claude.ai Mail').calls, 1);
  assert.equal(find(r, 'claude', 'plugin:helper:helper').calls, 1);
  const docs = find(r, 'claude', 'docs');
  assert.equal(docs.calls, 4, 'main 1 + two subagents + sess-2; the 40-day-old call is out');
  assert.equal(docs.sessions, 2, 'subagents count as their session');
  assert.deepEqual(docs.perTool, { lookup: 3, fetch: 1 });
  assert.equal(docs.builtin, false);
  const chrome = find(r, 'claude', 'claude-in-chrome');
  assert.deepEqual([chrome.builtin, chrome.calls, chrome.key], [true, 1, 'claude-in-chrome']);
  assert.equal(find(r, 'codex', 'fetcher').calls, 1, 'a call_id written twice is one call');
  assert.equal(find(r, 'codex', 'agenticos').perTool.memory_list, 1);
  assert.equal(r.rows.find((x) => x.host === 'claude' && x.name === 'Read'), undefined);
});

test('usage: per-day buckets end today (UTC), oldest first; lastUsed is the newest call', () => {
  const w = world();
  const docs = find(run(w), 'claude', 'docs');
  assert.equal(docs.perDay.length, 30);
  assert.equal(docs.perDay[29], 3, 'today: main + two subagents');
  assert.equal(docs.perDay[26], 1, 'three days ago');
  assert.equal(docs.lastUsed, iso(0));
});

test('usage: incremental — an appended file is read from where it stopped, a rewritten one again, an old one dropped', () => {
  const w = world();
  run(w);
  const idx = JSON.parse(fs.readFileSync(U.indexFile(w.vault), 'utf8'));
  assert.equal(idx.schema, 1);
  assert.ok(!Object.keys(idx.files).some((f) => f.endsWith('ancient.jsonl')), 'a file last written before the window is not kept');
  const before = idx.files[w.main].offset;
  assert.equal(before, fs.statSync(w.main).size);

  // Append one call: only it is read (the bytes before the offset are never parsed again).
  fs.appendFileSync(w.main, claudeLine('t9', 'mcp__docs__lookup', 0) + '\n');
  const t = new Date(NOW);
  fs.utimesSync(w.main, t, t);
  const spy = [];
  const orig = T.mcpCalls;
  T.mcpCalls = (file, from, o) => { spy.push([path.basename(file), from]); return orig(file, from, o); };
  try {
    const r2 = run(w);
    assert.equal(find(r2, 'claude', 'docs').calls, 5);
    assert.deepEqual(spy, [['sess-1.jsonl', before]], 'unchanged files are not opened; the appended one from its offset');
  } finally { T.mcpCalls = orig; }

  // Rewritten shorter: counted from the start again.
  fs.writeFileSync(w.main, claudeLine('z1', 'mcp__docs__lookup', 0) + '\n');
  fs.utimesSync(w.main, t, t);
  const r3 = run(w);
  assert.equal(find(r3, 'claude', 'docs').calls, 4, '1 (rewritten main) + two subagents + sess-2');
  assert.equal(find(r3, 'claude', 'claude.ai Mail'), undefined);
});

test('usage: a line still being written (no newline) is read next time; a window roll drops old days', () => {
  const w = world();
  fs.appendFileSync(w.main, claudeLine('p1', 'mcp__docs__lookup', 0)); // no trailing newline
  const t = new Date(NOW);
  fs.utimesSync(w.main, t, t);
  assert.equal(find(run(w), 'claude', 'docs').calls, 4);
  fs.appendFileSync(w.main, '\n');
  fs.utimesSync(w.main, t, t);
  assert.equal(find(run(w), 'claude', 'docs').calls, 5);
  // Ten days later the 2-day-old Mail call is still in a 30-day window, and out of a 5-day one.
  const later = run(w, { now: NOW + 10 * DAY, days: 5 });
  assert.equal(find(later, 'claude', 'claude.ai Mail'), undefined);
});

test('usage: only enabled hosts are read; nothing to read writes empty rows', () => {
  const w = world();
  const r = run(w, { userConfig: { ...w.userConfig, hosts: { claude: { enabled: true }, codex: { enabled: false } } } });
  assert.ok(r.rows.every((x) => x.host === 'claude'));
  const empty = U.collectUsage({ vault: w.vault, userConfig: { hosts: { claude: { enabled: true } } }, env: { CLAUDE_CONFIG_DIR: path.join(w.T0, 'none') }, now: NOW });
  assert.deepEqual(empty.rows, []);
  assert.equal(JSON.parse(fs.readFileSync(U.outFile(w.vault), 'utf8')).schema, 1);
});

test('mcpCalls: Claude tool_use and Codex mcp_tool_call_end, from an offset, skipping torn lines', () => {
  const w = world();
  const all = T.mcpCalls(w.rollout, 0, { format: 'codex' });
  assert.deepEqual(all.calls.map((c) => `${c.server}/${c.tool}`), ['fetcher/get', 'agenticos/memory_list']);
  const tail = T.mcpCalls(w.main, 0, { format: 'claude' });
  assert.equal(tail.calls.length, 5);
  assert.equal(T.mcpCalls(w.main, tail.offset, { format: 'claude' }).calls.length, 0);
  assert.equal(T.mcpCalls(w.main, tail.offset + 10, { format: 'claude' }).reset, true);
  assert.equal(T.mcpCalls(path.join(w.T0, 'missing.jsonl')), null);
  assert.equal(U.callKey('claude.ai Team Drive'), 'claude_ai_Team_Drive');
  assert.equal(U.callKey('plugin:a:b'), 'plugin_a_b');
});
