'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inter-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'brain', 'memory', 'reference'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'reference', 'routing.md'), '# Routing\n\nmodel routing goes to the cheapest tier\n');
process.env.BRAIN_VAULT = TMP;
process.env.AOS_CONFIG = path.join(TMP, 'none.json');
const { parseMode, renderContextBlock, readWriteFile, localProvider } = require('../sdk/lib/interactive.js');
const SDK = path.join(__dirname, '..', 'sdk');
const ENV = { ...process.env, BRAIN_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') };
const run = (script, args, input) => spawnSync(process.execPath, [path.join(SDK, script), ...args], { encoding: 'utf8', env: ENV, input: input || '' });

test('parseMode: context is the default; write takes a file; local; other args pass through', () => {
  assert.deepEqual(parseMode(['what', 'is', 'up']), { mode: 'context', writeFile: null, rest: ['what', 'is', 'up'] });
  assert.deepEqual(parseMode(['--local', 'q']), { mode: 'local', writeFile: null, rest: ['q'] });
  assert.deepEqual(parseMode(['--write', '/tmp/a.md']), { mode: 'write', writeFile: '/tmp/a.md', rest: [] });
  assert.deepEqual(parseMode(['--write=/tmp/b.md', '--style=prose']), { mode: 'write', writeFile: '/tmp/b.md', rest: ['--style=prose'] });
  assert.deepEqual(parseMode(['--context', '--weeks=2']), { mode: 'context', writeFile: null, rest: ['--weeks=2'] });
});

test('renderContextBlock has the exact fences and the three sections', () => {
  const s = renderContextBlock({ feature: 'ask', system: 'SYS', context: 'CTX', format: 'FMT' });
  assert.ok(s.startsWith('<<<AOS_CONTEXT feature=ask>>>\n'));
  assert.ok(s.endsWith('<<<END>>>\n'));
  assert.match(s, /## System\nSYS\n/);
  assert.match(s, /## Context\nCTX\n/);
  assert.match(s, /## Output format\nFMT\n/);
});

test('readWriteFile reads a file; localProvider refuses provider none with PROVIDER_NONE', async () => {
  const f = path.join(TMP, 'answer.md');
  fs.writeFileSync(f, 'hello');
  assert.equal(readWriteFile(f), 'hello');
  assert.throws(() => readWriteFile(null), /--write needs a file path/);
  await assert.rejects(() => localProvider('ask'), (e) => e.code === 'PROVIDER_NONE');
});

test('ask --context prints the assembled prompt with vault context and exits 0', () => {
  const r = run('ask.js', ['--context', 'what did I decide about model routing']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith('<<<AOS_CONTEXT feature=ask>>>'));
  assert.match(r.stdout, /=== VAULT CONTEXT ===/);
  assert.match(r.stdout, /brain\/memory\/reference\/routing\.md/);
  assert.match(r.stdout, /what did I decide about model routing/);
  assert.ok(r.stdout.trim().endsWith('<<<END>>>'));
});

test('ask --write prints the answer file; ask --local with provider none exits 1 with a stderr reason', () => {
  const f = path.join(TMP, 'ans.md');
  fs.writeFileSync(f, 'The answer.\n');
  const w = run('ask.js', ['--write', f]);
  assert.equal(w.status, 0);
  assert.equal(w.stdout, 'The answer.\n');
  const l = run('ask.js', ['--local', 'anything']);
  assert.equal(l.status, 1);
  assert.match(l.stderr, /no model provider/);
});

test('ask --host/--model/--effort are single arguments, never part of the question; a chosen host that cannot answer exits 1', () => {
  const { askOptions } = require('../sdk/ask.js');
  assert.deepEqual(askOptions(['--local', '--host=codex', '--model=gpt-6-luna', '--effort=low', '- what', 'is due?']), {
    opts: { host: 'codex', model: 'gpt-6-luna', effort: 'low' }, rest: ['--local', '- what', 'is due?'],
  });
  assert.throws(() => askOptions(['--host=ollama']), /--host takes claude or codex/);
  assert.throws(() => askOptions(['--model=--danger']), /--model takes a model id/);
  const r = run('ask.js', ['--local', '--host=codex', 'anything']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /codex cannot answer \(forced\)/, 'provider none here, and no other provider is tried');
  assert.equal(run('ask.js', ['--local', '--host=nope', 'anything']).status, 2);
});

test('compress --context wraps the input text; --write echoes the file', () => {
  const src = path.join(TMP, 'big.log');
  fs.writeFileSync(src, 'line one\nline two\n');
  const c = run('compress.js', [src, '--context', '--style=prose', '--max-words=50']);
  assert.equal(c.status, 0, c.stderr);
  assert.ok(c.stdout.startsWith('<<<AOS_CONTEXT feature=compress>>>'));
  assert.match(c.stdout, /tight prose paragraph/);
  assert.match(c.stdout, /under 50 words/);
  assert.match(c.stdout, /line two/);
  const out = path.join(TMP, 'distillate.md');
  fs.writeFileSync(out, '- distilled\n');
  const w = run('compress.js', ['--write', out]);
  assert.equal(w.status, 0);
  assert.equal(w.stdout, '- distilled\n');
});

test('standup --context prints headings for notes, git and agent activity; --write appends to the daily note', () => {
  const c = run('standup.js', ['--context']);
  assert.equal(c.status, 0, c.stderr);
  assert.ok(c.stdout.startsWith('<<<AOS_CONTEXT feature=standup>>>'));
  assert.match(c.stdout, /## Recent daily notes/);
  assert.match(c.stdout, /## Git \(last 24h\)/);
  assert.match(c.stdout, /## Agent activity/);
  assert.match(c.stdout, /\*\*Did\*\*/);
  const body = path.join(TMP, 'standup.md');
  fs.writeFileSync(body, '**Did**\n- shipped it\n');
  const w = run('standup.js', ['--write', body]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /## Standup — \d\d:\d\d\n\n\*\*Did\*\*\n- shipped it/);
  const { dailyNotePath } = require('../lib/paths.js');
  assert.match(fs.readFileSync(dailyNotePath(new Date()), 'utf8'), /- shipped it/);
});

test('reflect-week --context uses this week\'s notes; --write stores brain/reflections/<week>.md with frontmatter', () => {
  const { dailyNotePath } = require('../lib/paths.js');
  const brain = require('../sdk/lib/brain.js');
  const note = dailyNotePath(new Date());
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.appendFileSync(note, '\n## Claude Code Sessions\n- refactored the provider layer\n');
  const c = run('reflect-week.js', ['--context']);
  assert.equal(c.status, 0, c.stderr);
  assert.ok(c.stdout.startsWith('<<<AOS_CONTEXT feature=reflect-week>>>'));
  assert.match(c.stdout, /refactored the provider layer/);
  assert.match(c.stdout, /## Highlights \(what actually moved\)/);
  const week = brain.isoWeek(new Date());
  const f = path.join(TMP, 'reflection.md');
  fs.writeFileSync(f, '## Highlights (what actually moved)\n- a win\n');
  const w = run('reflect-week.js', ['--write', f]);
  assert.equal(w.status, 0, w.stderr);
  const out = fs.readFileSync(path.join(TMP, 'brain', 'reflections', `${week}.md`), 'utf8');
  assert.match(out, /^---\ntype: reflection\nweek: /);
  assert.match(out, /- a win/);
});

test('consolidate-memory --context lists memory files; --write stores brain/_index/memory-consolidation.md', () => {
  fs.mkdirSync(path.join(TMP, 'brain', 'patterns'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'brain', 'patterns', 'p1.md'), '# P1\n\nsome pattern\n');
  const c = run('consolidate-memory.js', ['--context']);
  assert.equal(c.status, 0, c.stderr);
  assert.ok(c.stdout.startsWith('<<<AOS_CONTEXT feature=consolidate-memory>>>'));
  assert.match(c.stdout, /=== brain\/memory\/reference\/routing\.md \(reference\) ===/);
  assert.match(c.stdout, /=== brain\/patterns\/p1\.md \(pattern\) ===/);
  const f = path.join(TMP, 'consol.md');
  fs.writeFileSync(f, '## Summary\n- total files reviewed: 2\n');
  const w = run('consolidate-memory.js', ['--write', f]);
  assert.equal(w.status, 0, w.stderr);
  const out = fs.readFileSync(path.join(TMP, 'brain', '_index', 'memory-consolidation.md'), 'utf8');
  assert.match(out, /^---\ntype: memory-consolidation-draft\n/);
  assert.match(out, /total files reviewed: 2/);
});

test('each script refuses --local with provider none (exit 1, reason on stderr)', () => {
  for (const s of ['standup.js', 'reflect-week.js', 'consolidate-memory.js']) {
    const r = run(s, ['--local']);
    assert.equal(r.status, 1, `${s}: ${r.stdout}`);
    assert.match(r.stderr, /no model provider/, s);
  }
});

test('localProvider with role reasoner: provider none refuses and names the reasoner and the missing fallback', async () => {
  await assert.rejects(() => localProvider('reason:ask', { role: 'reasoner' }),
    (e) => e.code === 'PROVIDER_NONE' && /reasoner/.test(e.message) && /fallback/.test(e.message));
});

// ── local-first A2, A3: ai.<feature> and the local engine ──
function localVault(local) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'inter-local-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(v, 'brain', 'memory', 'reference'), { recursive: true });
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'local', local }));
  fs.writeFileSync(path.join(v, 'brain', 'memory', 'reference', 'routing.md'), '# Routing\n\nmodel routing goes to the cheapest tier\n');
  return v;
}
const runIn = (v, script, args) => new Promise((resolve) => {
  require('child_process').execFile(process.execPath, [path.join(SDK, script), ...args],
    { encoding: 'utf8', env: { ...ENV, BRAIN_VAULT: v, AOS_VAULT: v } }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
});

test('ask --chat is a flag of its own, never part of the question', () => {
  const { askOptions } = require('../sdk/ask.js');
  assert.deepEqual(askOptions(['--local', '--chat', 'what is due?']), { opts: { chat: true }, rest: ['--local', 'what is due?'] });
});

test('ask --local --chat under provider local: the local engine answers (reason:chat, counted not ledgered); down, it says so and how to run once on a host', async () => {
  const http = require('http');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }] }));
      if (req.url === '/api/embed') { res.statusCode = 404; return res.end('{}'); }
      seen.push(JSON.parse(body));
      res.end(JSON.stringify({ message: { content: 'Routing goes to the cheapest tier (`brain/memory/reference/routing.md`).' }, done: true }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const up = localVault({ url: `http://127.0.0.1:${server.address().port}` });
  try {
    const r = await runIn(up, 'ask.js', ['--local', '--chat', 'how does routing work?']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /cheapest tier/);
    assert.equal(seen[0].model, 'qwen3.5:9b', 'the workhorse, never the reasoner\'s Claude id');
    const usage = JSON.parse(fs.readFileSync(path.join(up, 'brain', '_index', 'local-usage.json'), 'utf8'));
    assert.ok(JSON.stringify(usage).includes('reason:chat'), 'a reason:chat local call');
    assert.equal(fs.existsSync(path.join(up, 'brain', '_index', 'provider-spend.jsonl')), false, 'no spend row');
  } finally {
    server.close();
  }
  const down = localVault({ url: 'http://127.0.0.1:9' });
  const r = await runIn(down, 'ask.js', ['--local', '--chat', 'anything']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the local model cannot answer \(local-down\): start Ollama/);
  assert.match(r.stderr, /--host=claude or --host=codex/);
});

test('reflect-week and consolidate-memory take --host=claude|codex (that host once, never another)', () => {
  assert.equal(run('reflect-week.js', ['--local', '--host=nope']).status, 2);
  const { hostFlag } = require('../sdk/lib/interactive.js');
  assert.deepEqual(hostFlag(['--local', '--host=codex', '--print']), { host: 'codex', rest: ['--local', '--print'] });
  assert.throws(() => hostFlag(['--host=ollama']), /--host takes claude or codex/);
  const r = run('consolidate-memory.js', ['--local', '--host=codex']);
  // Provider none here: the chosen host cannot answer, and nothing stands in for it.
  assert.equal(r.status, 1);
  assert.match(r.stderr, /codex cannot answer \(forced\)|not enough memory files/);
});
