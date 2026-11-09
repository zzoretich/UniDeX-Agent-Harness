'use strict';
// transcript-events.js: a host's on-disk transcript becomes session-events.js's events (spec 2026-11-09-code-chat). The
// fixtures keep the entry shapes of Claude Code 2.1.318 and codex-cli 0.167.0 with invented text, ids and paths.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../lib/transcript-events.js');
const E = require('../lib/session-events.js');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'code-chat', name), 'utf8');
const kinds = (events) => events.map((e) => e.kind);

test('claude: prompt, tools, plan and an end_turn done, in order', () => {
  const ev = M.eventsOfText(fx('claude-2.1.318.jsonl'), 'claude');
  assert.deepEqual(ev.map((e) => e.kind), ['session', 'prompt', 'text', 'tool', 'tool_result', 'plan', 'tool', 'tool_result', 'text', 'done']);
  assert.equal(ev.find((e) => e.kind === 'tool').toolKind, 'read');
  assert.equal(ev[1].text, 'Add a greeting to hello.js');
  assert.deepEqual(ev.find((e) => e.kind === 'plan').items.map((i) => i.status), ['active', 'pending']);
  assert.deepEqual(ev.at(-1), { t: ev.at(-1).t, kind: 'done', ok: true, usd: null, estimated: false });
  assert.match(ev[0].t, /^2026-11-09T15:00:\d\d\.000Z$/);
});

test('claude: slash-command envelopes, isMeta and sidechain entries make no events', () => {
  const m = M.createTranscriptMapper('claude');
  const user = (extra) => ({ type: 'user', sessionId: 's1', message: { role: 'user', content: 'hi' }, ...extra });
  assert.deepEqual(m.push(user({ isMeta: true })), []);
  assert.deepEqual(m.push(user({ isSidechain: true })), []);
  assert.deepEqual(m.push({ type: 'summary', summary: 'x', leafUuid: 'u' }), []);
  assert.equal(m.state.sessionId, null);
  assert.deepEqual(kinds(m.push(user({ message: { role: 'user', content: 'real' } }))), ['session', 'prompt']);
  assert.deepEqual(m.push(user({ message: { role: 'user', content: '<command-name>/clear</command-name>' } })), []);
  assert.deepEqual(m.push(user({ message: { role: 'user', content: [{ type: 'text', text: '<local-command-stdout>ok</local-command-stdout>' }] } })), []);
});

test('claude: image blocks add [image]; the first sessionId alone is a session event; the model is learned', () => {
  const m = M.createTranscriptMapper('claude', { model: 'seed' });
  const ev = m.push({ type: 'user', sessionId: 's1', message: { content: [{ type: 'text', text: 'look at this' }, { type: 'image', source: { type: 'base64' } }] } });
  assert.deepEqual(kinds(ev), ['session', 'prompt']);
  assert.equal(ev[1].text, 'look at this\n[image]');
  assert.equal(ev[0].t, null);
  assert.deepEqual(kinds(m.push({ type: 'user', sessionId: 's1', message: { content: 'again' } })), ['prompt']);
  m.push({ type: 'assistant', sessionId: 's1', message: { model: 'claude-x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'tool_use' } });
  assert.deepEqual([m.state.sessionId, m.state.model], ['s1', 'claude-x']);
});

test('codex: envelopes skipped; the item_completed forms map; usage dedupes; task_complete closes the turn', () => {
  const ev = M.eventsOfText(fx('codex-0.167.0.jsonl'), 'codex');
  assert.equal(ev[0].kind, 'session');
  assert.ok(ev.some((e) => e.kind === 'tool' && e.toolKind === 'bash'));
  assert.equal(ev.at(-1).kind, 'done');
  assert.deepEqual(kinds(ev), ['session', 'prompt', 'text', 'plan', 'tool', 'tool_result', 'usage', 'patch', 'tool', 'tool_result', 'text', 'usage', 'done']);
  assert.equal(ev.find((e) => e.kind === 'prompt').text, 'Add a greeting to hello.js');
  assert.equal(ev.find((e) => e.kind === 'tool').summary, 'cat hello.js');
  assert.deepEqual(ev.find((e) => e.kind === 'patch').files, [{ path: '/work/demo/hello.js', change: 'update' }]);
  assert.equal(ev.find((e) => e.kind === 'tool' && e.toolKind === 'mcp').name, 'mcp__demo__lint');
  const u = ev.find((e) => e.kind === 'usage');
  assert.deepEqual([u.in, u.out, u.cached, u.estimated], [9000, 60, 8000, true]);
});

test('codex: older begin/end events pair by call_id; envelopes, an abort and a bad entry', () => {
  const m = M.createTranscriptMapper('codex', { model: 'gpt-5.5' });
  const ev = (type, payload) => m.push({ timestamp: '2026-11-09T15:00:00.000Z', type: 'event_msg', payload: { type, ...payload } });
  assert.deepEqual(ev('user_message', { message: '<environment_context>\n</environment_context>' }), []);
  assert.deepEqual(kinds(ev('user_message', { message: 'run it' })), ['prompt']);
  const begin = ev('exec_command_begin', { call_id: 'c1', command: ['/bin/bash', '-lc', 'npm test'] });
  assert.deepEqual([begin[0].kind, begin[0].id, begin[0].toolKind, begin[0].summary], ['tool', 'c1', 'bash', 'npm test']);
  const end = ev('exec_command_end', { call_id: 'c1', exit_code: 1, aggregated_output: 'boom' });
  assert.deepEqual(end.map((e) => [e.kind, e.id, e.ok]), [['tool_result', 'c1', false]]);
  assert.deepEqual(kinds(ev('exec_command_end', { call_id: 'c2', exit_code: 0, stdout: 'ok' })), ['tool', 'tool_result']);
  assert.equal(ev('mcp_tool_call_begin', { call_id: 'm1', invocation: { server: 's', tool: 't', arguments: {} } })[0].name, 'mcp__s__t');
  const mend = ev('mcp_tool_call_end', { call_id: 'm1', invocation: { server: 's', tool: 't' }, result: { Err: 'nope' } });
  assert.deepEqual(mend.map((e) => [e.kind, e.ok, e.summary]), [['tool_result', false, 'nope']]);
  assert.deepEqual(ev('patch_apply_begin', { call_id: 'p1', changes: { '/work/demo/a.txt': { type: 'add', content: 'x' } } })[0].files, [{ path: '/work/demo/a.txt', change: 'add' }]);
  assert.deepEqual(ev('agent_message', { message: 'done' }).map((e) => e.kind), ['text']);
  assert.equal(ev('turn_aborted', { reason: 'interrupted' })[0].ok, false);
  assert.deepEqual(ev('task_complete', {}).map((e) => [e.kind, e.ok]), [['done', true]]);
  assert.deepEqual(m.push({ type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: '{"plan":[{"step":"a","status":"completed"}]}' } }).map((e) => e.items), [[{ text: 'a', status: 'done' }]]);
});

test('codex: only the first session_meta is the session; the model comes from turn_context', () => {
  const m = M.createTranscriptMapper('codex');
  assert.deepEqual(kinds(m.push({ type: 'session_meta', payload: { id: 'a' } })), ['session']);
  assert.deepEqual(m.push({ type: 'session_meta', payload: { id: 'b' } }), []);
  m.push({ type: 'turn_context', payload: { model: 'gpt-5.5' } });
  assert.deepEqual([m.state.sessionId, m.state.model], ['a', 'gpt-5.5']);
});

test('push never throws: unknown, malformed and non-object entries make no events', () => {
  for (const host of ['claude', 'codex']) {
    const m = M.createTranscriptMapper(host);
    for (const bad of [null, undefined, 5, 'x', [], {}, { type: 'user' }, { type: 'assistant', message: 7 }, { type: 'event_msg', payload: 3 }, { type: 'event_msg', payload: { type: 'item_completed', item: 'x' } }, { type: 'event_msg', payload: { type: 'token_count', info: 9 } }]) {
      assert.deepEqual(m.push(bad), []);
    }
  }
  assert.throws(() => M.createTranscriptMapper('other'), /no such host/);
});

test('session-events: mapClaude output is unchanged after the claudeBlocks refactor', () => {
  const line = (o) => JSON.stringify(o) + '\n';
  const text = line({ type: 'assistant', session_id: 'a1b2', message: { content: [
    { type: 'text', text: 'Reading the parser first.' },
    { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'src/tide.js' } },
    { type: 'tool_use', id: 'tu2', name: 'TodoWrite', input: { todos: [{ content: 'Fix it', status: 'in_progress' }] } },
  ] } });
  const p = E.createParser('claude', { now: () => new Date('2026-10-07T15:00:00.000Z') });
  const T = '2026-10-07T15:00:00.000Z';
  assert.deepEqual(p.push(text), [
    { t: T, kind: 'session', id: 'a1b2' },
    { t: T, kind: 'text', text: 'Reading the parser first.' },
    { t: T, kind: 'tool', id: 'tu1', name: 'Read', toolKind: 'read', summary: '{"file_path":"src/tide.js"}', filePath: 'src/tide.js' },
    { t: T, kind: 'plan', items: [{ text: 'Fix it', status: 'active' }] },
  ]);
  assert.deepEqual(E.claudeBlocks([{ type: 'text', text: 'hi' }, null, { type: 'thinking' }], T), [{ t: T, kind: 'text', text: 'hi' }]);
});
