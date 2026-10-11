'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
// `aos memory` (spec 2026-10-11-brain-hub D13): argument rules, JSON shapes and exit codes, end to end on a temp vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('./memory.js');

const ROOT = path.resolve(__dirname, '..');
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mem-cli-cfg-'));
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mem-cli-codex-'));

const FB = 'brain/memory/feedback/graphify-first.md';
const PR = 'brain/memory/projects/pulse-1-5-0.md';
const RULE = '---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-09-30\nupdated: 2026-09-30\nsource: auto-wrap\nsession: abc\nreviewed: false\n---\n\n# Graphify first\n\nAsk the graph tools first.\n';
const PROJECT = '---\ntype: memory\ntags: [memory/projects, status/active]\ncreated: 2026-10-09\nupdated: 2026-10-09\nreviewed: false\n---\n\n# Pulse 1.5.0\n\nShipped.\n';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mem-cli-'));
  const cfg = path.join(dir, 'home', '.claude');
  const vault = path.join(dir, 'home', 'Vault');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), text); };
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agenticos.json'), JSON.stringify({ vault }));
  put('brain/_index/.keep', '');
  put(FB, RULE);
  put(PR, PROJECT);
  put('MEMORY.md', `# Index\n\n## Feedback\n- [Graphify first](${FB}) — ask the graph first\n\n## Projects\n- [Pulse 1.5.0](${PR}) — shipped\n`);
  const lines = [];
  const scripts = [];
  const io = { log: (m) => lines.push(String(m)), warn: (m) => lines.push('warning: ' + m) };
  // runScript: build-brain-md and feedback-apply stand-ins (each runs in its own process for real; the CLI test checks the call).
  const runScript = (name, args) => { scripts.push([name, ...args]); return name === 'feedback-apply.js' ? { status: 0, stdout: `applied: brain/memory/feedback/${args[1]}.md\n`, stderr: '' } : { ok: true }; };
  return { vault, put, lines, scripts, opts: { configDir: cfg, home: path.join(dir, 'home'), io, vault, runScript } };
}
const read = (sb, rel) => fs.readFileSync(path.join(sb.vault, rel), 'utf8');

async function json(sb, args) {
  const start = sb.lines.length;
  assert.equal(await M.main([...args, '--json'], sb.opts), 0);
  return JSON.parse(sb.lines.slice(start).join('\n'));
}

test('list prints every memory with its hash, the drafts and the counts', async () => {
  const sb = sandbox();
  sb.put('brain/memory/feedback/_drafts/pending.md', '---\ndescription: d\n---\n\n# Pending\n');
  const out = await json(sb, ['list']);
  assert.equal(out.schema, 1);
  assert.deepEqual(out.counts, { memories: 2, unreviewed: 2, drafts: 1, archived: 0, superseded: 0 });
  const fb = out.memories.find((m) => m.path === FB);
  assert.equal(fb.reviewed, false);
  assert.equal(fb.title, 'Graphify first');
  assert.match(fb.hash, /^[0-9a-f]{64}$/);
  assert.equal(out.drafts[0].slug, 'pending');
});

test('keep, set with --expect, archive, restore and supersede, each with its JSON', async () => {
  const sb = sandbox();
  assert.deepEqual(await json(sb, ['keep', FB, PR]), { kept: [FB, PR], already: [] });
  const hash = (await json(sb, ['list'])).memories.find((m) => m.path === FB).hash;
  const set = await json(sb, ['set', FB, '--set', '{"pin":true}', '--expect', hash]);
  assert.equal(set.written, true);
  assert.deepEqual(set.brainMd, { ok: true });
  assert.match(read(sb, FB), /^pin: true$/m);
  const arch = await json(sb, ['archive', PR]);
  assert.deepEqual(arch.archived, [PR]);
  assert.ok(!read(sb, 'MEMORY.md').includes(PR));
  assert.deepEqual((await json(sb, ['restore', PR])).restored, [PR]);
  sb.put('brain/memory/feedback/graph-tools.md', RULE.replace('# Graphify first', '# Graph tools'));
  const sup = await json(sb, ['supersede', FB, '--by', 'brain/memory/feedback/graph-tools.md']);
  assert.deepEqual([sup.path, sup.by], [FB, 'brain/memory/feedback/graph-tools.md']);
  assert.deepEqual(sb.scripts.map((s) => s[0]), ['build-brain-md.js', 'build-brain-md.js', 'build-brain-md.js', 'build-brain-md.js'], 'every status or pin change rebuilds BRAIN.md; keep does not');
});

test('set --dry-run prints the text it would write and writes nothing', async () => {
  const sb = sandbox();
  const out = await json(sb, ['set', PR, '--set', '{"status":"complete"}', '--dry-run']);
  assert.equal(out.written, false);
  assert.match(out.text, /status\/complete/);
  assert.equal(read(sb, PR), PROJECT);
  assert.equal(sb.scripts.length, 0);
});

test('draft approve and reject go through feedback-apply.js after the file checks', async () => {
  const sb = sandbox();
  sb.put('brain/memory/feedback/_drafts/one.md', '---\ndescription: d\n---\n\n# One\n');
  assert.deepEqual(await json(sb, ['draft', 'approve', 'one']), { approved: 'brain/memory/feedback/one.md', slug: 'one' });
  assert.deepEqual(sb.scripts, [['feedback-apply.js', '--approve', 'one']]);
  await assert.rejects(M.main(['draft', 'reject', 'missing', '--json'], sb.opts), /no such draft: missing/);
  await assert.rejects(M.main(['draft', 'keep', 'one'], sb.opts), M.UsageError);
  await assert.rejects(M.main(['draft', 'approve', '../x'], sb.opts), M.UsageError);
});

test('draft approve and reject for real: feedback-apply.js runs against this vault, not another', async () => {
  const sb = sandbox();
  const draft = (slug) => sb.put(`brain/memory/feedback/_drafts/${slug}.md`, `---\ntype: memory\ntags: [memory/feedback, status/draft]\nsession: s1\ndescription: a rule worth keeping\n---\n\n# Rule ${slug}\n\nDo the thing.\n`);
  draft('keep-me');
  draft('drop-me');
  const opts = { ...sb.opts, runScript: undefined, env: { ...process.env, AOS_CONFIG: path.join(sb.vault, 'none.json') } };
  const io = []; opts.io = { log: (m) => io.push(m) };
  assert.equal(await M.main(['draft', 'approve', 'keep-me', '--json'], opts), 0);
  assert.equal(JSON.parse(io.join('\n')).approved, 'brain/memory/feedback/keep-me.md');
  assert.match(read(sb, 'brain/memory/feedback/keep-me.md'), /# Rule keep-me/);
  assert.match(read(sb, 'MEMORY.md'), /keep-me\.md\) — a rule worth keeping/);
  assert.equal(await M.main(['draft', 'reject', 'drop-me'], opts), 0);
  assert.equal(fs.existsSync(path.join(sb.vault, 'brain/memory/feedback/_drafts/drop-me.md')), false);
  assert.match(read(sb, 'brain/_index/promote-log.jsonl'), /"action":"reverted","slug":"drop-me"/);
});

test('notdup records a sorted pair once', async () => {
  const sb = sandbox();
  assert.deepEqual(await json(sb, ['notdup', PR, FB]), { pair: [FB, PR], added: true });
  assert.deepEqual(await json(sb, ['notdup', FB, PR]), { pair: [FB, PR], added: false });
  assert.deepEqual(JSON.parse(read(sb, 'brain/_index/memory-notdup.json')), { schema: 1, pairs: [[FB, PR]] });
  await assert.rejects(M.main(['notdup', FB, FB], sb.opts), M.UsageError);
});

test('argument rules: unknown verbs and flags, flags a verb does not take, counts, a leading dash, a bad path', async () => {
  const sb = sandbox();
  for (const argv of [['forget', FB], ['keep'], ['set', FB], ['keep', FB, '--by', PR], ['list', '--dry-run'], ['keep', '-x'],
    ['supersede', FB], ['notdup', FB], ['keep', 'brain/memory/feedback/README.md'], ['set', FB, '--set', 'not json'],
    ['set', FB, '--set', '{"pin":true}', '--expect', 'nothex']]) {
    await assert.rejects(M.main(argv, sb.opts), M.UsageError, argv.join(' '));
  }
  await assert.rejects(M.main(['set', FB, '--set', '{"title":"x"}'], sb.opts), /cannot change title/);
  await assert.rejects(M.main(['keep', 'brain/memory/feedback/missing.md'], sb.opts), /no such memory/);
});

test('the aos command routes `memory` with --by and --dry-run, and prints aos: on a refusal', () => {
  const sb = sandbox();
  const env = { ...process.env, AOS_VAULT: sb.vault, AOS_CONFIG: path.join(sb.vault, '..', '.claude', 'agenticos.json') };
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'aos.js'), 'memory', ...a], { env, encoding: 'utf8' });
  const list = run('list', '--json');
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).counts.memories, 2);
  const dry = run('set', PR, '--set', '{"status":"paused"}', '--dry-run', '--json');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).written, false);
  const miss = run('keep', 'brain/memory/feedback/missing.md');
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /^aos: no such memory/);
  assert.equal(run('keep', 'not/a/path.md').status, 2);
});
