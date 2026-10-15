'use strict';
// The local agent runner (local-first A7) against fake engines on the loopback interface: Ollama's /api/tags and
// /api/chat with `tools`, and an OpenAI-compatible /v1. The vault-scoped tools (traversal, dot-folders and symlink
// escapes refused, size caps), the write scope (the routine's writes AND duty-guard's refusal rule), the loop's limits
// (maxTurns, the wall clock, calls per turn), argument validation, result truncation, and where the final message
// goes. Nothing here reaches a real engine or the network.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const A = require('../lib/local-agent.js');
const ollama = require('../sdk/lib/ollama.js');
const openai = require('../sdk/lib/openai-compat.js');

// ── a fake engine: each /api/chat or /v1/chat/completions request takes the next scripted reply ──
let server, port;
let script = [];
let delayMs = 0;
let tags = ['qwen3.5:9b', 'qwen3-embedding:0.6b'];
const seen = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      seen.push({ url: req.url, body: parsed });
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/tags') return json(200, { models: tags.map((name) => ({ name })) });
      if (req.url === '/v1/models') return json(200, { data: tags.map((id) => ({ id })) });
      if (req.url === '/api/chat' || req.url === '/v1/chat/completions') {
        const next = script.shift();
        const send = () => (typeof next === 'function' ? json(200, next(parsed)) : next ? json(next.status || 200, next.body) : json(500, { error: 'script ran out' }));
        if (delayMs) setTimeout(send, delayMs); else send();
        return;
      }
      json(404, { error: 'no route' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

/** Ollama replies: a tool turn, a final answer. */
const call = (name, args) => ({ function: { name, arguments: args } });
const tools = (...calls) => ({ body: { message: { role: 'assistant', content: '', tool_calls: calls }, prompt_eval_count: 100, eval_count: 10, done: true } });
const answer = (text) => ({ body: { message: { role: 'assistant', content: text }, prompt_eval_count: 200, eval_count: 20, done: true, done_reason: 'stop' } });
/** OpenAI-compatible replies. */
const oaTools = (...calls) => ({ body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 5 } } });
const oaAnswer = (text) => ({ body: { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 8 } } });

// ── a vault ──
let VAULT, OUTSIDE;
const W = (rel, text) => { const p = path.join(VAULT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const R = (rel) => fs.readFileSync(path.join(VAULT, rel), 'utf8');
beforeEach(() => {
  VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'la-vault-'));
  OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'la-outside-'));
  W('notes/a.md', '# A\nfirst line\nTODO: water the plants\n');
  W('notes/sub/b.md', 'nothing here\ntodo lower case\n');
  W('persona/IDENTITY.md', '# Agent\n');
  W('brain/scripts/run.js', '// code\n');
  W('.obsidian/app.json', '{}');
  fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'outside the vault\n');
  script = [];
  delayMs = 0;
  tags = ['qwen3.5:9b', 'qwen3-embedding:0.6b'];
  seen.length = 0;
});

const ollamaCfg = () => ({ local: { engine: 'ollama', url: `http://127.0.0.1:${port}` } });
const openaiCfg = () => ({ local: { engine: 'openai', url: `http://127.0.0.1:${port}/v1` } });
const routine = (over = {}) => ({ slug: 'digest', name: 'Digest', kind: 'prompt', engine: 'local', body: 'List the notes and write a digest.', ...over });

async function run(r, { cfg = ollamaCfg(), timeoutMs, deps = {} } = {}) {
  const res = await A.resolveLocal({ cfg, model: r.model || null });
  assert.equal(res.ok, true, res.detail);
  const posts = [], counts = [];
  const out = await A.runLocalAgent({
    routine: r, cfg, vault: VAULT, lc: res.lc, model: res.model, timeoutMs,
    deps: { postNotification: (p) => { posts.push(p); return { level: p.level }; }, recordLocalCall: (c) => counts.push(c), ...deps },
  });
  return { out, posts, counts };
}
const chats = () => seen.filter((s) => s.url === '/api/chat' || s.url === '/v1/chat/completions');

// ── paths ──

test('vaultPath: vault-relative only — absolute, ~, .., dot-folders and NUL are refused; . is the root where allowed', () => {
  const root = fs.realpathSync(VAULT);
  assert.deepEqual(A.vaultPath(root, 'notes/a.md'), { rel: 'notes/a.md', abs: path.join(root, 'notes', 'a.md') });
  assert.equal(A.vaultPath(root, './notes//sub/').rel, 'notes/sub');
  assert.equal(A.vaultPath(root, 'notes/sub/../a.md').rel, 'notes/a.md');
  for (const [p, why] of [['/etc/passwd', /absolute/], ['~/x', /absolute/], ['../x', /leaving the vault/], ['notes/../../x', /leaving the vault/],
    ['.obsidian/app.json', /dot-folder/], ['notes/.hidden', /dot-folder/], ['a\0b', /NUL/], ['', /required/], [42, /string/]]) {
    assert.throws(() => A.vaultPath(root, p), why, JSON.stringify(p));
  }
  assert.deepEqual(A.vaultPath(root, '', { allowRoot: true }), { rel: '', abs: root });
  assert.deepEqual(A.vaultPath(root, undefined, { allowRoot: true }), { rel: '', abs: root });
});

test('readable: a symlink that resolves outside the vault, or into a dot-folder, is refused', () => {
  const root = fs.realpathSync(VAULT);
  fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(VAULT, 'notes', 'leak.md'));
  fs.symlinkSync(OUTSIDE, path.join(VAULT, 'notes', 'out'));
  fs.symlinkSync(path.join(VAULT, '.obsidian'), path.join(VAULT, 'notes', 'cfg'));
  assert.throws(() => A.readable(root, 'notes/leak.md'), /outside the vault/);
  assert.throws(() => A.readable(root, 'notes/out/secret.txt'), /outside the vault/);
  assert.throws(() => A.readable(root, 'notes/cfg/app.json'), /dot-folder/);
  assert.equal(A.readable(root, 'notes/a.md').rel, 'notes/a.md');
});

// ── the write scope ──

test('compileWrites: folders, files and globs; every entry checked with duty-guard\'s refusal rule', () => {
  const root = fs.realpathSync(VAULT);
  const { rules, refused } = A.compileWrites(['notes/digests/', 'TODO.md', 'brain/reflections/*.md', 'journal/**/*.md', 'notes/sub',
    'persona/', 'brain/scripts/x.js', 'brain/', 'workspaces/a/', '.obsidian/', '/abs/', '../out/', '*.md', '**/*.md', 'brain/routines/*.md'], root);
  const ok = (rel) => rules.some((r) => r.test(rel));
  assert.deepEqual(rules.map((r) => r.entry), ['notes/digests/', 'TODO.md', 'brain/reflections/*.md', 'journal/**/*.md', 'notes/sub']);
  assert.deepEqual(refused.map((r) => [r.entry, r.why]), [
    ['persona/', 'it holds a guarded path (persona/IDENTITY.md)'],
    ['brain/scripts/x.js', 'guarded (brain/scripts/)'],
    ['brain/', 'it holds a guarded path (brain/scripts/)'],
    ['workspaces/a/', 'guarded (workspaces/)'],
    ['.obsidian/', 'a dot-folder or dot-file'],
    ['/abs/', 'an absolute path'],
    ['../out/', 'a path leaving the vault'],
    ['*.md', 'the vault itself'],
    ['**/*.md', 'the vault itself'],
    ['brain/routines/*.md', 'guarded (brain/routines/)'],
  ]);
  assert.ok(ok('notes/digests/today.md') && ok('notes/digests/2026/10.md'));
  assert.ok(!ok('notes/digests'), 'a folder entry is what is inside it, not a file of that name');
  assert.ok(ok('TODO.md') && !ok('TODO.md.bak'));
  assert.ok(ok('brain/reflections/week.md') && !ok('brain/reflections/2026/week.md') && !ok('brain/reflections/week.txt'));
  assert.ok(ok('journal/a.md') && ok('journal/2026/10/a.md'));
  assert.ok(ok('notes/sub/b.md'), 'an existing folder without a trailing slash is a folder');
});

test('writable: inside writes, never a refused area or through a symlink; a folder or a symlink target is refused', () => {
  const root = fs.realpathSync(VAULT);
  const { rules } = A.compileWrites(['notes/'], root);
  assert.equal(A.writable(root, 'notes/new.md', rules).rel, 'notes/new.md');
  assert.throws(() => A.writable(root, 'other/new.md', rules), /outside this routine's writes/);
  assert.throws(() => A.writable(root, 'persona/IDENTITY.md', rules), /guarded \(persona\/IDENTITY\.md\)/);
  assert.throws(() => A.writable(root, 'notes/sub', rules), /a folder/);
  fs.symlinkSync(path.join(VAULT, 'persona'), path.join(VAULT, 'notes', 'p'));
  assert.throws(() => A.writable(root, 'notes/p/IDENTITY.md', rules), /resolves to persona\/IDENTITY\.md: guarded/);
  fs.symlinkSync(OUTSIDE, path.join(VAULT, 'notes', 'out'));
  assert.throws(() => A.writable(root, 'notes/out/x.md', rules), /outside the vault/);
  fs.symlinkSync(path.join(VAULT, 'notes', 'a.md'), path.join(VAULT, 'notes', 'alias.md'));
  assert.throws(() => A.writable(root, 'notes/alias.md', rules), /a symlink/);
  assert.throws(() => A.writable(root, '.obsidian/x.json', null), /dot-folder/);
});

test('globRe: * within a segment, ** across segments, ? one character, the rest literal', () => {
  assert.ok(A.globRe('a/*.md').test('a/x.md') && !A.globRe('a/*.md').test('a/b/x.md'));
  assert.ok(A.globRe('a/**/x.md').test('a/x.md') && A.globRe('a/**/x.md').test('a/b/c/x.md'));
  assert.ok(A.globRe('a/**').test('a/b/c') && A.globRe('a/?.md').test('a/1.md') && !A.globRe('a/?.md').test('a/12.md'));
  assert.ok(!A.globRe('a/x+y.md').test('a/xxy.md') && A.globRe('a/x+y.md').test('a/x+y.md'));
});

// ── the engine ──

test('resolveLocal: up with the model → ready; down, or the model not pulled → local-down with the detail', async () => {
  const up = await A.resolveLocal({ cfg: ollamaCfg() });
  assert.deepEqual([up.ok, up.reason, up.model], [true, 'local-ready', 'qwen3.5:9b']);
  assert.equal((await A.resolveLocal({ cfg: ollamaCfg(), model: 'qwen3.5:9b' })).model, 'qwen3.5:9b');
  const missing = await A.resolveLocal({ cfg: ollamaCfg(), model: 'llama4:70b' });
  assert.deepEqual([missing.ok, missing.reason], [false, 'local-down']);
  assert.match(missing.detail, /^llama4:70b is not pulled on Ollama at http:\/\/127\.0\.0\.1:\d+ \(aos local pull llama4:70b\)$/);
  tags = ['qwen3-embedding:0.6b'];
  const noWorkhorse = await A.resolveLocal({ cfg: { ...ollamaCfg(), local: { ...ollamaCfg().local, model: 'qwen3.5:9b' } } });
  assert.deepEqual([noWorkhorse.ok, noWorkhorse.reason], [false, 'local-down']);
  assert.match(noWorkhorse.detail, /qwen3\.5:9b is not pulled/);
  const down = await A.resolveLocal({ cfg: { local: { engine: 'ollama', url: 'http://127.0.0.1:9' } } });
  assert.deepEqual([down.ok, down.reason, down.detail], [false, 'local-down', 'Ollama at http://127.0.0.1:9 is not answering']);
  const oaDown = await A.resolveLocal({ cfg: { local: { engine: 'openai', url: 'http://127.0.0.1:9/v1' } } });
  assert.equal(oaDown.detail, 'the OpenAI-compatible server at http://127.0.0.1:9/v1 is not answering');
});

test('ollama.chatMessage / openai-compat.chatMessage: tools in the body, tool calls normalized, usage read', async () => {
  const defs = A.toolDefs({ canWrite: true });
  script = [tools(call('read_file', { path: 'notes/a.md' }))];
  const o = await ollama.chatMessage({ host: '127.0.0.1', port, model: 'qwen3.5:9b', messages: [{ role: 'user', content: 'go' }], tools: defs });
  assert.deepEqual(o.toolCalls, [{ id: null, index: 0, name: 'read_file', args: { path: 'notes/a.md' }, argError: null }]);
  assert.deepEqual(o.usage, { inputTokens: 100, outputTokens: 10 });
  assert.deepEqual(seen.at(-1).body.tools.map((t) => t.function.name), ['read_file', 'list_files', 'grep', 'write_file', 'notify']);
  assert.deepEqual(ollama.toolMessage({ name: 'read_file', id: null }, 'x'), { role: 'tool', content: 'x', tool_name: 'read_file' });
  assert.equal(ollama.buildChatBody({ prompt: 'p' }).tools, undefined, 'no tools, no key: every other caller is unchanged');
  script = [oaTools({ type: 'function', function: { name: 'grep', arguments: '{"pattern":"TODO"}' } }, { type: 'function', function: { name: 'grep', arguments: '{oops' } })];
  const a = await openai.chatMessage({ url: `http://127.0.0.1:${port}/v1`, model: 'm', messages: [{ role: 'user', content: 'go' }], tools: defs });
  assert.deepEqual(a.toolCalls.map((c) => [c.id, c.name, c.args, c.argError]), [['call_0', 'grep', { pattern: 'TODO' }, null], ['call_1', 'grep', null, 'arguments are not valid JSON']]);
  assert.deepEqual(a.message.tool_calls.map((c) => c.id), ['call_0', 'call_1'], 'the generated ids go back in the history too');
  assert.equal(seen.at(-1).body.tool_choice, 'auto');
  assert.deepEqual(openai.toolMessage({ id: 'call_0' }, 'r'), { role: 'tool', tool_call_id: 'call_0', content: 'r' });
  assert.equal(openai.buildChatBody({ prompt: 'p' }).tools, undefined);
});

// ── the loop ──

test('a routine end to end on Ollama: reads, a write inside writes, a refused write, grep, notify, then the final message', async () => {
  script = [
    tools(call('list_files', { path: 'notes', recursive: true }), call('read_file', { path: 'notes/a.md' })),
    tools(call('write_file', { path: 'notes/digests/today.md', content: '# Digest\n- a\n' }), call('write_file', { path: 'persona/IDENTITY.md', content: 'pwned' }), call('grep', { pattern: 'todo', ignore_case: true })),
    tools(call('notify', { title: 'Digest\nready', body: 'see notes/digests/today.md' })),
    answer('<think>done?</think>Wrote the digest; one write was refused.'),
  ];
  const { out, posts, counts } = await run(routine({ writes: ['notes/digests/'], output: 'notify' }));
  assert.equal(out.status, 'ok', out.error);
  assert.equal(out.final, 'Wrote the digest; one write was refused.');
  assert.deepEqual([out.turns, out.toolCalls, out.engine, out.model], [4, 6, 'ollama', 'qwen3.5:9b']);
  assert.deepEqual(out.usage, { inputTokens: 500, outputTokens: 50 });
  assert.equal(R('notes/digests/today.md'), '# Digest\n- a\n');
  assert.equal(R('persona/IDENTITY.md'), '# Agent\n', 'the guarded file is untouched');
  assert.deepEqual(out.wrote, ['notes/digests/today.md']);
  assert.deepEqual(out.refused, [{ tool: 'write_file', path: 'persona/IDENTITY.md', why: 'guarded (persona/IDENTITY.md)' }]);
  assert.deepEqual(out.journal, [
    'turn 1: list_files notes → ok (36 chars)',
    'turn 1: read_file notes/a.md → ok (61 chars)',
    'turn 2: write_file notes/digests/today.md → ok (40 chars)',
    'turn 2: write_file persona/IDENTITY.md → REFUSED: guarded (persona/IDENTITY.md)',
    'turn 2: grep /todo/ → ok (70 chars)',
    'turn 3: notify "Digest\\nready" → ok (25 chars)',
    'final message posted to Notifications',
  ]);
  // The notify tool and the `output: notify` delivery: from the routine's slug, one line titles.
  assert.deepEqual(posts, [
    { from: 'digest', level: 'info', title: 'Digest ready', body: 'see notes/digests/today.md' },
    { from: 'digest', level: 'info', title: 'Digest', body: 'Wrote the digest; one write was refused.' },
  ]);
  // A18: every model turn is one local call, under the routine's feature.
  assert.deepEqual(counts.map((c) => c.feature), ['routine:digest', 'routine:digest', 'routine:digest', 'routine:digest']);
  // What the engine saw: the preamble with the write scope, the body, the tools, the results as tool messages.
  const first = chats()[0].body;
  assert.equal(first.model, 'qwen3.5:9b');
  assert.equal(first.options.num_ctx, A.NUM_CTX);
  assert.match(first.messages[0].content, /You may write files with write_file only at: notes\/digests\//);
  assert.match(first.messages[0].content, /## The routine\n\nList the notes and write a digest\.$/);
  assert.deepEqual(first.messages[1], { role: 'user', content: 'Run the routine now.' });
  assert.deepEqual(first.tools.map((t) => t.function.name), ['read_file', 'list_files', 'grep', 'write_file', 'notify']);
  const second = chats()[1].body.messages;
  assert.deepEqual(second[2].tool_calls.map((c) => c.function.name), ['list_files', 'read_file']);
  assert.deepEqual([second[3].role, second[3].tool_name], ['tool', 'list_files']);
  assert.equal(second[3].content, 'notes/a.md\nnotes/sub/\nnotes/sub/b.md');
  assert.match(second[4].content, /^notes\/a\.md\n1 {2}# A\n2 {2}first line\n3 {2}TODO: water the plants\n4 {2}$/);
  const third = chats()[2].body.messages;
  assert.equal(third.at(-2).content, 'error: guarded (persona/IDENTITY.md)');
  assert.equal(third.at(-1).content, 'notes/a.md:3: TODO: water the plants\nnotes/sub/b.md:2: todo lower case');
});

test('no writes: write_file is not offered, and a call to it is refused as an unknown tool', async () => {
  script = [tools(call('write_file', { path: 'notes/x.md', content: 'x' })), answer('ok')];
  const { out } = await run(routine());
  assert.equal(out.status, 'ok');
  assert.deepEqual(chats()[0].body.tools.map((t) => t.function.name), ['read_file', 'list_files', 'grep', 'notify']);
  assert.match(chats()[0].body.messages[0].content, /This routine may not write files/);
  assert.match(out.journal[0], /REFUSED: unknown tool "write_file"; the tools are read_file, list_files, grep, notify$/);
  assert.equal(fs.existsSync(path.join(VAULT, 'notes', 'x.md')), false);
});

test('a writes entry in a guarded area is refused and journalled before the first turn', async () => {
  script = [answer('nothing to do')];
  const { out } = await run(routine({ writes: ['persona/', 'brain/scripts/'] }));
  assert.deepEqual(out.journal.slice(0, 2), ["writes entry 'persona/' refused: it holds a guarded path (persona/IDENTITY.md)", "writes entry 'brain/scripts/' refused: guarded (brain/scripts/)"]);
  assert.ok(!chats()[0].body.tools.some((t) => t.function.name === 'write_file'), 'no entry left: no write tool');
});

test('arguments are validated; a bad call gets its error back and the run goes on', async () => {
  script = [
    tools(call('read_file', {}), call('read_file', { path: 7 }), call('grep', { pattern: '(a+)+' }), call('grep', { pattern: '[' }), call('list_files', { path: '../' }), call('nope', {}), call('read_file', { path: 'notes/missing.md' }), call('read_file', { path: 'notes/sub' }), call('read_file', { path: 'notes/a.md' })),
    answer('fixed'),
  ];
  const { out } = await run(routine());
  assert.equal(out.status, 'ok');
  const results = chats()[1].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.deepEqual(results, [
    'error: path is required',
    'error: path must be a string',
    'error: a quantified group inside a quantifier: simplify the pattern',
    results[3],
    'error: a path leaving the vault',
    'error: unknown tool "nope"; the tools are read_file, list_files, grep, notify',
    'error: no such file',
    'error: a folder: use list_files',
    `error: too many tool calls in one turn (at most ${A.MAX_CALLS_PER_TURN})`,
  ]);
  assert.match(results[3], /^error: not a valid regular expression: /);
  assert.equal(out.journal.filter((l) => / → (REFUSED|ERROR): /.test(l)).length, 9);
});

test('read_file: line windows, binary and oversized files refused; results cut to RESULT_CHARS', async () => {
  W('notes/long.md', Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`).join('\n'));
  fs.writeFileSync(path.join(VAULT, 'notes', 'img.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  fs.writeFileSync(path.join(VAULT, 'notes', 'huge.md'), Buffer.alloc(A.READ_MAX_BYTES + 1, 0x61));
  script = [tools(call('read_file', { path: 'notes/long.md', offset: 10, limit: 2 }), call('read_file', { path: 'notes/long.md' }), call('read_file', { path: 'notes/img.png' }), call('read_file', { path: 'notes/huge.md' })), answer('ok')];
  const { out } = await run(routine());
  assert.equal(out.status, 'ok');
  const r = chats()[1].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(r[0], `notes/long.md\n10  line 10 ${'x'.repeat(20)}\n11  line 11 ${'x'.repeat(20)}\n[lines 10-11 of 3000; offset 12 reads on]`);
  assert.ok(r[1].length < A.RESULT_CHARS + 60 && /\[truncated: \d+ more characters\]$/.test(r[1]), 'cut to the result budget');
  assert.equal(r[2], 'error: a binary file');
  assert.equal(r[3], `error: too large (${A.READ_MAX_BYTES + 1} bytes): grep it instead`);
});

test('fitContext: the oldest tool results are elided first once the history passes the budget', () => {
  const big = 'y'.repeat(A.RESULT_CHARS);
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  for (let i = 0; i < 8; i++) msgs.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] }, { role: 'tool', content: big });
  const total = A.fitContext(msgs);
  assert.ok(total <= A.CONTEXT_CHARS, `${total}`);
  const tool = msgs.filter((m) => m.role === 'tool');
  assert.equal(tool[0].content, A.ELIDED);
  assert.equal(tool.at(-1).content, big, 'the newest result stays');
});

test('maxTurns: a model that never stops calling tools ends the run as an error', async () => {
  script = Array.from({ length: 5 }, () => tools(call('list_files', {})));
  const { out, counts } = await run(routine({ maxTurns: 3 }));
  assert.deepEqual([out.status, out.turns, out.error], ['error', 3, 'stopped after 3 turns without a final answer (maxTurns)']);
  assert.equal(counts.length, 3);
  assert.equal(chats().length, 3);
});

test('the wall clock: a turn that outlives timeoutSec ends the run as a timeout', async () => {
  delayMs = 1500;
  script = [answer('too late')];
  const { out } = await run(routine({ timeoutSec: 1 }));
  assert.equal(out.status, 'timeout');
  assert.equal(out.error, 'timed out after 1s');
  assert.match(out.journal.at(-1), /^turn 1: the engine failed: ollama timeout$/);
});

test('an engine error ends the run with it; nothing is delivered', async () => {
  script = [{ status: 500, body: { error: 'model failed to load' } }];
  const { out, posts } = await run(routine({ output: 'notify' }));
  assert.equal(out.status, 'error');
  assert.match(out.error, /^ollama: ollama HTTP 500: /);
  assert.deepEqual(posts, []);
});

test('the OpenAI-compatible engine: string arguments, ids on every tool result, the same tools', async () => {
  script = [
    oaTools({ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes/a.md","limit":1}' } }, { type: 'function', function: { name: 'list_files', arguments: '{bad' } }),
    oaAnswer('Read it.'),
  ];
  const { out } = await run(routine(), { cfg: openaiCfg() });
  assert.deepEqual([out.status, out.final, out.engine], ['ok', 'Read it.', 'openai']);
  assert.deepEqual(out.usage, { inputTokens: 130, outputTokens: 13 });
  const m = chats()[1].body.messages;
  assert.deepEqual(m[2].tool_calls.map((c) => c.id), ['c1', 'call_1']);
  assert.deepEqual(m.slice(3).map((x) => [x.role, x.tool_call_id]), [['tool', 'c1'], ['tool', 'call_1']]);
  assert.match(m[3].content, /^notes\/a\.md\n1 {2}# A\n\[lines 1-1 of 4; offset 2 reads on\]$/);
  assert.equal(m[4].content, 'error: arguments are not valid JSON');
});

test('output: a vault-relative .md file gets the final message appended under a heading; a refused file is journalled', async () => {
  W('notes/log.md', '# Log\n');
  script = [answer('First.')];
  let { out } = await run(routine({ output: 'notes/log.md' }));
  assert.match(R('notes/log.md'), /^# Log\n\n## Digest — \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\nFirst\.\n$/);
  assert.equal(out.journal.at(-1), 'final message appended to notes/log.md');
  script = [answer('Second.')];
  ({ out } = await run(routine({ output: 'persona/duties/notes.md' })));
  assert.equal(out.journal.at(-1), 'final message not delivered to persona/duties/notes.md: guarded (persona/duties/)');
  assert.equal(fs.existsSync(path.join(VAULT, 'persona', 'duties', 'notes.md')), false);
  script = [answer('Third.')];
  ({ out } = await run(routine({ output: 'log' })));
  assert.equal(out.journal.length, 0, 'log: only the routine log gets it');
});

test('notify: at most NOTIFY_MAX a run; alert passes through, anything else is info', async () => {
  const many = Array.from({ length: A.NOTIFY_MAX + 1 }, (_, i) => call('notify', { title: `n${i}`, level: i === 0 ? 'alert' : 'breaking' }));
  script = [tools(...many), answer('done')];
  const { posts } = await run(routine());
  assert.deepEqual(posts.map((p) => [p.title, p.level]), [['n0', 'alert'], ['n1', 'info'], ['n2', 'info']]);
  const last = chats()[1].body.messages.at(-1).content;
  assert.equal(last, `error: at most ${A.NOTIFY_MAX} notifications a run`);
});

test('notify through the real store: an item from the routine lands in brain/notifications', async () => {
  script = [tools(call('notify', { title: 'Hello from a routine' })), answer('ok')];
  const res = await A.resolveLocal({ cfg: ollamaCfg() });
  const out = await A.runLocalAgent({ routine: routine(), cfg: { notifications: { osAlert: false } }, vault: VAULT, lc: res.lc, model: res.model, deps: { recordLocalCall: () => {} } });
  assert.equal(out.status, 'ok');
  const N = require('../lib/notifications.js');
  const { items } = N.list(VAULT);
  assert.deepEqual(items.map((i) => [i.from, i.level, i.title]), [['digest', 'info', 'Hello from a routine']]);
});
