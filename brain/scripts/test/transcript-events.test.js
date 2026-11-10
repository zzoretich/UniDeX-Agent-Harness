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

test('claude: five turns in order — tools and a plan, an interrupt, a thinking>text final message, an API error, one still open', () => {
  const ev = M.eventsOfText(fx('claude-2.1.318.jsonl'), 'claude');
  assert.deepEqual(kinds(ev), [
    'session', 'prompt', 'session', 'text', 'tool', 'tool_result', 'plan', 'tool', 'tool_result', 'text', 'done',
    'prompt', 'tool', 'tool_result', 'done',
    'prompt', 'text', 'done',
    'prompt', 'error', 'done',
    'prompt',
  ]);
  assert.equal(ev.find((e) => e.kind === 'tool').toolKind, 'read');
  assert.equal(ev[1].text, 'Add a greeting to hello.js');
  assert.deepEqual(ev.find((e) => e.kind === 'plan').items.map((i) => i.status), ['active', 'pending']);
  assert.deepEqual(ev[10], { t: '2026-11-09T15:00:36.000Z', kind: 'done', ok: true, usd: null, estimated: false, model: 'claude-sonnet-5', turn: 1 });
  assert.match(ev[0].t, /^2026-11-09T15:00:\d\d\.000Z$/);
  assert.deepEqual(ev.filter((e) => e.kind === 'prompt').map((e) => e.text), ['Add a greeting to hello.js', 'Now print a goodbye too', 'Print a goodbye after the greeting', 'Run it once more', 'What does hello.js print now?']);
});

test('claude (F3): every event carries its turn — 0 before the first prompt, +1 per prompt; done carries the model', () => {
  const ev = M.eventsOfText(fx('claude-2.1.318.jsonl'), 'claude');
  assert.ok(ev.every((e) => Number.isInteger(e.turn)), 'a turn on every event');
  assert.equal(ev[0].turn, 0, 'the session event comes before the first prompt');
  assert.deepEqual(ev.filter((e) => e.kind === 'prompt').map((e) => e.turn), [1, 2, 3, 4, 5]);
  const dones = ev.filter((e) => e.kind === 'done');
  assert.deepEqual(dones.map((e) => [e.turn, e.ok, e.model]), [[1, true, 'claude-sonnet-5'], [2, false, 'claude-sonnet-5'], [3, true, 'claude-sonnet-5'], [4, false, 'claude-sonnet-5']], 'one done per turn');
  for (const e of ev) { if (e.kind !== 'session' && e.kind !== 'prompt') assert.equal(e.turn, ev.slice(0, ev.indexOf(e)).filter((x) => x.kind === 'prompt').length, `${e.kind} carries the current turn`); }
});

test('claude (F3, R19): model on session events; a change mid-conversation is a new session event with the same id', () => {
  const ev = M.eventsOfText(fx('claude-2.1.318.jsonl'), 'claude');
  const sessions = ev.filter((e) => e.kind === 'session');
  assert.deepEqual(sessions.map((e) => [e.id, e.model, e.turn]), [['3f2a9c10-5b7e-4d21-8a6c-0e1d2c3b4a59', null, 0], ['3f2a9c10-5b7e-4d21-8a6c-0e1d2c3b4a59', 'claude-sonnet-5', 1]]);
  const m = M.createTranscriptMapper('claude');
  const asst = (model, id) => ({ type: 'assistant', sessionId: 's1', message: { model, id, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } });
  assert.deepEqual(m.push(asst('claude-a', 'm1')).map((e) => [e.kind, e.model]), [['session', 'claude-a'], ['text', undefined], ['done', 'claude-a']], 'the first entry: one session event, with its model');
  assert.deepEqual(kinds(m.push(asst('claude-a', 'm2'))), ['text', 'done'], 'the same model: no session event');
  assert.deepEqual(m.push(asst('claude-b', 'm3')).map((e) => [e.kind, e.id ?? null, e.model]), [['session', 's1', 'claude-b'], ['text', null, undefined], ['done', null, 'claude-b']]);
});

test('claude (F1): a final message written as thinking then text, both end_turn, closes its turn once', () => {
  const m = M.createTranscriptMapper('claude');
  const asst = (content, stop, id = 'msg_1') => m.push({ type: 'assistant', sessionId: 's1', message: { model: 'claude-x', id, content, stop_reason: stop } });
  m.push({ type: 'user', sessionId: 's1', message: { content: 'go' } });
  assert.deepEqual(kinds(asst([{ type: 'thinking', thinking: '', signature: 's' }], 'end_turn')), ['session'], 'a thinking-only end_turn entry: no block event, so no done');
  assert.deepEqual(kinds(asst([{ type: 'text', text: 'done.' }], 'end_turn')), ['text', 'done']);
  assert.deepEqual(kinds(asst([{ type: 'text', text: 'and more' }], 'end_turn')), ['text'], 'one done per message.id');
  assert.deepEqual(kinds(asst([{ type: 'text', text: 'next' }], 'end_turn', 'msg_2')), ['text', 'done'], 'a new message.id closes again');
  assert.deepEqual(asst([{ type: 'text', text: 'cut off' }], 'max_tokens', 'msg_3').map((e) => [e.kind, e.ok]), [['text', undefined], ['done', false]]);
  assert.deepEqual(asst([{ type: 'text', text: 'again' }], 'max_tokens', 'msg_3').map((e) => [e.kind, e.ok]), [['text', undefined]], 'max_tokens: once per message.id too');
  assert.deepEqual(asst([], 'refusal', 'msg_4').map((e) => [e.kind, e.ok]), [['done', false]], 'a refusal closes not ok');
});

test('claude (F1): an interrupt closes the turn not ok and is no prompt', () => {
  const m = M.createTranscriptMapper('claude');
  m.push({ type: 'user', sessionId: 's1', message: { content: 'go' } });
  const block = m.push({ type: 'user', sessionId: 's1', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, interruptedMessageId: 'msg_1' });
  assert.deepEqual(block.map((e) => [e.kind, e.ok, e.turn]), [['done', false, 1]]);
  assert.deepEqual(m.push({ type: 'user', sessionId: 's1', message: { content: '[Request interrupted by user for tool use]' } }).map((e) => [e.kind, e.ok]), [['done', false]]);
  const withResult = m.push({ type: 'user', sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'rejected' }, { type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  assert.deepEqual(withResult.map((e) => [e.kind, e.ok]), [['tool_result', false], ['done', false]]);
});

test('claude (F1): an API error is an error then a done not ok, and never the model', () => {
  const ev = M.eventsOfText(fx('claude-2.1.318.jsonl'), 'claude');
  const at = ev.findIndex((e) => e.kind === 'error');
  assert.deepEqual(ev.slice(at, at + 2).map((e) => e.kind), ['error', 'done']);
  assert.equal(ev[at].message, 'API Error: Request rejected (429) · an invented rate limit message');
  assert.deepEqual([ev[at + 1].ok, ev[at + 1].model], [false, 'claude-sonnet-5']);
  assert.equal(ev.filter((e) => e.kind === 'session').at(-1).model, 'claude-sonnet-5', 'no session event for <synthetic>');
  const m = M.createTranscriptMapper('claude', { model: 'claude-x' });
  const long = 'API Error: '.padEnd(1000, 'x');
  const out = m.push({ type: 'assistant', sessionId: 's1', isApiErrorMessage: true, message: { model: '<synthetic>', id: 'e1', content: [{ type: 'text', text: long }], stop_reason: 'stop_sequence' } });
  assert.deepEqual(out.map((e) => e.kind), ['session', 'error', 'done']);
  assert.ok(out[1].message.length <= 400 && out[1].message.startsWith('API Error: '), 'clipped');
  assert.equal(m.state.model, 'claude-x');
  m.push({ type: 'assistant', sessionId: 's1', message: { model: '<synthetic>', id: 'e2', content: [{ type: 'text', text: 'No response requested.' }], stop_reason: 'stop_sequence' } });
  assert.equal(m.state.model, 'claude-x', 'a <synthetic> entry never sets the model');
});

test('claude (F2): only the human words are prompts — task notifications, bash blocks, reminders and compact summaries are not', () => {
  const ev = M.eventsOfText(fx('claude-2.1.318.jsonl'), 'claude');
  for (const p of ev.filter((e) => e.kind === 'prompt')) assert.doesNotMatch(p.text, /task-notification|bash-|system-reminder|continued from a previous/);
  const m = M.createTranscriptMapper('claude');
  const user = (content, extra = {}) => m.push({ type: 'user', sessionId: 's1', message: { role: 'user', content }, ...extra });
  assert.deepEqual(kinds(user('first')), ['session', 'prompt']);
  assert.deepEqual(user('<task-notification>\n<status>completed</status>\n</task-notification>', { origin: { kind: 'task-notification' }, promptSource: 'system' }), []);
  assert.deepEqual(user('typed by a person', { origin: { kind: 'channel' } }), [], 'an origin other than human');
  assert.deepEqual(user('typed by the system', { origin: { kind: 'human' }, promptSource: 'system' }), [], 'promptSource system');
  assert.deepEqual(user('a summary', { isCompactSummary: true, isVisibleInTranscriptOnly: true }), []);
  assert.deepEqual(user('shown only', { isVisibleInTranscriptOnly: true }), []);
  assert.deepEqual(user('<bash-input>ls</bash-input>'), []);
  assert.deepEqual(user('<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>'), []);
  assert.deepEqual(user([{ type: 'text', text: '<system-reminder>\nbe brief\n</system-reminder>' }], { origin: { kind: 'human' }, promptSource: 'sdk' }), []);
  assert.deepEqual(user('<system-reminder>x</system-reminder>\nwhat about this?', { origin: { kind: 'human' }, promptSource: 'queued' }).map((e) => [e.kind, e.turn]), [['prompt', 2]], 'other words beside a block keep it a prompt');
  assert.deepEqual(user('a queued one', { origin: { kind: 'human' }, promptSource: 'queued' }).map((e) => e.turn), [3]);
});

test('claude (R21): leading and trailing <system-reminder> blocks leave a prompt\'s text; one with nothing else is no prompt', () => {
  const ev = M.eventsOfText(fx('claude-2.1.318.jsonl'), 'claude');
  assert.equal(ev.at(-1).text, 'What does hello.js print now?', 'the fixture\'s text+text+text entry');
  const m = M.createTranscriptMapper('claude');
  const prompt = (content) => m.push({ type: 'user', sessionId: 's1', message: { role: 'user', content }, origin: { kind: 'human' }, promptSource: 'sdk' }).filter((e) => e.kind === 'prompt').map((e) => e.text);
  assert.deepEqual(prompt('<system-reminder>\nx\n</system-reminder>\n\n  fix the test  \n<system-reminder>y</system-reminder>\n'), ['fix the test']);
  assert.deepEqual(prompt('<system-reminder>a</system-reminder><system-reminder>b</system-reminder>\nwords'), ['words'], 'several leading blocks');
  assert.deepEqual(prompt('before <system-reminder>kept</system-reminder> after\n<system-reminder>gone</system-reminder>'), ['before <system-reminder>kept</system-reminder> after'], 'a block between words stays');
  assert.deepEqual(prompt('<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>'), [], 'nothing else: no prompt');
  assert.deepEqual(prompt('<system-reminder>a</system-reminder>\n<command-name>/clear</command-name>'), [], 'what is left is a slash-command envelope');
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
  // The plan event comes from a function_call update_plan: a legacy fallback (codex 0.163–0.167 wrote none of the 696 local
  // function_calls as update_plan); the line stays in the fixture so the fallback keeps a test.
  assert.deepEqual(kinds(ev), ['session', 'session', 'prompt', 'text', 'plan', 'tool', 'tool_result', 'usage', 'patch', 'tool', 'tool_result', 'text', 'usage', 'done']);
  assert.deepEqual(ev.filter((e) => e.kind === 'session').map((e) => [e.id, e.model, e.turn]), [['01a00000-0000-7000-8000-00000000d3a0', null, 0], ['01a00000-0000-7000-8000-00000000d3a0', 'gpt-5.5', 0]], 'turn_context names the model: the same id again');
  assert.deepEqual([ev.at(-1).turn, ev.at(-1).model, ev.at(-1).ok], [1, 'gpt-5.5', true]);
  assert.ok(ev.every((e) => Number.isInteger(e.turn)));
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
  // A function_call update_plan: a legacy fallback (no local codex 0.163–0.167 rollout has one).
  assert.deepEqual(m.push({ type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: '{"plan":[{"step":"a","status":"completed"}]}' } }).map((e) => e.items), [[{ text: 'a', status: 'done' }]]);
  for (const envelope of ['<realtime_delegation>\n</realtime_delegation>', '<in-app-browser-context source="x">\n</in-app-browser-context>', '<send_user_message_question_reply>\nyes\n</send_user_message_question_reply>']) {
    assert.deepEqual(ev('user_message', { message: envelope }), [], envelope);
    assert.deepEqual(ev('item_completed', { item: { type: 'UserMessage', content: [{ type: 'text', text: envelope }] } }), [], envelope);
  }
});

test('codex: only the first session_meta is the session; a model from turn_context or the meta is a session event with that id', () => {
  const m = M.createTranscriptMapper('codex');
  assert.deepEqual(m.push({ type: 'session_meta', payload: { id: 'a' } }), [{ t: null, kind: 'session', id: 'a', model: null, turn: 0 }]);
  assert.deepEqual(m.push({ type: 'session_meta', payload: { id: 'b' } }), []);
  assert.deepEqual(m.push({ type: 'turn_context', payload: { model: 'gpt-5.5' } }), [{ t: null, kind: 'session', id: 'a', model: 'gpt-5.5', turn: 0 }]);
  assert.deepEqual(m.push({ type: 'turn_context', payload: { model: 'gpt-5.5' } }), [], 'the same model: nothing');
  assert.deepEqual([m.state.sessionId, m.state.model], ['a', 'gpt-5.5']);
  m.push({ timestamp: '2026-11-09T15:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'go' } });
  assert.deepEqual(m.push({ type: 'turn_context', payload: { model: 'gpt-6' } }).map((e) => [e.kind, e.id, e.model, e.turn]), [['session', 'a', 'gpt-6', 1]], 'a /model mid-conversation');
  assert.deepEqual(m.push({ type: 'event_msg', payload: { type: 'task_complete' } }).map((e) => [e.kind, e.model, e.turn]), [['done', 'gpt-6', 1]]);
  const meta = M.createTranscriptMapper('codex');
  assert.deepEqual(meta.push({ type: 'session_meta', payload: { id: 'c', model: 'gpt-5.5' } }).map((e) => e.model), ['gpt-5.5']);
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

test('claude (E): a max_tokens or refusal stop on a thinking-only entry closes the turn not ok, once per message.id', () => {
  const m = M.createTranscriptMapper('claude');
  const asst = (content, stop, id) => m.push({ type: 'assistant', sessionId: 's1', message: { model: 'claude-x', id, content, stop_reason: stop } });
  const think = [{ type: 'thinking', thinking: 'hmm', signature: 's' }];
  m.push({ type: 'user', sessionId: 's1', message: { content: 'go' } });
  assert.deepEqual(asst(think, 'max_tokens', 'msg_1').filter((e) => e.kind === 'done').map((e) => e.ok), [false], 'max_tokens on thinking only');
  assert.deepEqual(asst(think, 'max_tokens', 'msg_1').filter((e) => e.kind === 'done'), [], 'once per message.id');
  assert.deepEqual(asst([{ type: 'redacted_thinking', data: 'x' }], 'refusal', 'msg_2').filter((e) => e.kind === 'done').map((e) => e.ok), [false], 'a refusal on redacted thinking');
  assert.deepEqual(asst(think, 'end_turn', 'msg_3').filter((e) => e.kind === 'done'), [], 'end_turn still needs a block event');
});

test('claude (C): a 200k whitespace run and 20k unclosed openers map in linear time', () => {
  const m = () => M.createTranscriptMapper('claude');
  const user = (text) => ({ type: 'user', sessionId: 's1', message: { content: [{ type: 'text', text }] } });
  const time = (entry) => { const t = process.hrtime.bigint(); const out = m().push(entry); return { ms: Number(process.hrtime.bigint() - t) / 1e6, out }; };
  const ws = time(user(`hello${' '.repeat(200000)}`));
  assert.ok(ws.ms < 100, `whitespace run took ${ws.ms} ms`);
  assert.deepEqual(ws.out.filter((e) => e.kind === 'prompt').map((e) => e.text), ['hello']);
  const lead = time(user(`${' '.repeat(200000)}<system-reminder>x</system-reminder> hi`));
  assert.ok(lead.ms < 100, `leading whitespace took ${lead.ms} ms`);
  assert.deepEqual(lead.out.filter((e) => e.kind === 'prompt').map((e) => e.text), ['hi']);
  const open = time(user('<bash-stdout>'.repeat(20000)));
  assert.ok(open.ms < 100, `unclosed openers took ${open.ms} ms`);
  const many = time(user(`${'<system-reminder>r</system-reminder>'.repeat(20000)} done`));
  assert.ok(many.ms < 100, `many reminders took ${many.ms} ms`);
  assert.deepEqual(many.out.filter((e) => e.kind === 'prompt').map((e) => e.text), ['done']);
  const blocks = time(user(`${'<bash-stdout>o</bash-stdout>'.repeat(20000)}`));
  assert.ok(blocks.ms < 100, `many closed blocks took ${blocks.ms} ms`);
  assert.deepEqual(blocks.out.filter((e) => e.kind === 'prompt'), [], 'blocks alone are no prompt');
});
