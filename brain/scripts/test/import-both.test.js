'use strict';
// The importer end to end on a machine with both hosts and the local model up (install-import B3–B10): the dry run
// writes nothing; a real run types rules with the local model, keeps auto-memory types, writes `source: import:<host>`,
// `origin: ~/…`, `reviewed: false`, creates only the accepted workspace, lists MCP servers; a second run writes nothing
// twice; the digest writes the daily notes, the timeline, the digests cache and wrap offsets, then turns itself off; and
// Review shows one batch per host.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeWorld, fakeEngine } = require('./import-world.js');

const w = makeWorld();
process.env.AOS_VAULT = w.vault;
const { runImport } = require('../lib/import/index.js');
const D = require('../lib/import/digest.js');
const W = require('../../../cli/workspace.js');

const eng = fakeEngine();
const base = {
  vault: w.vault, cfg: {}, userConfig: w.userConfig, env: w.env, home: w.home, now: w.now, tmpDirs: w.tmpDirs, gitCeiling: w.gitCeiling,
  provider: eng.provider, workspace: W,
  wsOpts: { vault: w.vault, configDir: w.claudeDir, env: { AOS_CONFIG: path.join(w.T, 'no-config.json') }, home: w.home, tmpDirs: w.tmpDirs },
};
const V = (rel) => path.join(w.vault, rel);
const read = (rel) => fs.readFileSync(V(rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
function memoryFiles() {
  const out = [];
  for (const t of ['user', 'feedback', 'projects', 'reference']) {
    for (const f of fs.readdirSync(V(`brain/memory/${t}`))) out.push(`brain/memory/${t}/${f}`);
  }
  return out.sort();
}
function listTree(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(w.vault, p)); } };
  walk(dir);
  return out.sort();
}

test('the dry run counts per host and kind, proposes the busy repositories and writes nothing', async () => {
  const before = listTree(w.vault);
  const r = await runImport({ ...base, dryRun: true });
  assert.deepEqual(listTree(w.vault), before, 'not one file written, session-index.json included');
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.engine, { ready: true, provider: 'ollama', model: 'qwen-test', reason: 'local-ready' });
  assert.deepEqual(r.hosts.claude.instructions, { files: 1, rules: 5, new: 5, skipped: [] });
  assert.deepEqual(r.hosts.claude.memories, { files: 3, new: 3 });
  assert.equal(r.hosts.claude.sessions, 4, 'three in alpha and one in notes: not the headless run, not the 120-day-old one');
  assert.equal(r.hosts.codex.sessions, 2, 'not the exec run');
  assert.deepEqual([r.hosts.claude.mcp, r.hosts.codex.mcp], [{ servers: 2 }, { servers: 2 }]);
  assert.deepEqual(r.projects.proposals.map((p) => [p.id, p.action, p.slug, p.sessions, p.reason]), [
    ['~/code/alpha', 'new', 'alpha', 5, '5 sessions in the window'],
    ['~/code/beta', 'new', 'beta', 2, 'active in the last 14 days'],
  ]);
  assert.ok(!r.projects.proposals.some((p) => p.id === '~/notes'), 'a folder outside any repository stays an outside row');
  assert.equal(eng.calls.length, 0, 'a scan asks the model nothing');
});

test('a real run writes the memories, creates the accepted workspace only, lists MCP and queues the sessions', async () => {
  const lines = [];
  const r = await runImport({ ...base, accept: ['~/code/alpha'], log: (l) => lines.push(l) });
  assert.equal(r.written, 10, '5 Claude rules + 2 Codex rules + 3 auto-memories');
  const files = memoryFiles();
  assert.equal(files.length, 10);
  const backend = read('brain/memory/user/i-am-a-backend-developer-most.md');
  assert.match(backend, /^---\ntype: memory\ntags: \[memory\/user, status\/active\]\n/);
  assert.match(backend, /\nsource: import:claude\nsession: import\nreviewed: false\norigin: "~\/\.claude\/CLAUDE\.md"\n---/);
  assert.match(backend, /_Imported from `~\/\.claude\/CLAUDE\.md` › Working with me\._/);
  assert.match(read('brain/memory/feedback/use-pnpm-not-npm-in-every.md'), /source: import:codex\n[\s\S]*origin: "~\/\.codex\/AGENTS\.md"/);
  // Auto-memory keeps its type (top-level and under metadata:), its name and description.
  assert.match(read('brain/memory/feedback/prefers-small-pull-requests.md'), /origin: "~\/\.claude\/projects\/-code-alpha\/memory\/prefers-small-prs\.md"[\s\S]*# Prefers small pull requests\n\nKeep each pull request/);
  assert.ok(fs.existsSync(V('brain/memory/reference/staging-deploy.md')));
  assert.ok(fs.existsSync(V('brain/memory/user/owner-is-the-on-call-lead.md')));
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, new RegExp(w.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${f} names no absolute home path`);
    assert.doesNotMatch(t, /AGENTICOS\.md/, `${f} carries no @include`);
  }
  assert.match(read('MEMORY.md'), /## Feedback\n[\s\S]*\[Prefers small pull requests\]\(brain\/memory\/feedback\/prefers-small-pull-requests\.md\) — One change per pull request/);
  // Classification asked the local model once per file, with a JSON schema as `format`.
  const asks = eng.calls.filter((c) => c.feature === 'import');
  assert.equal(asks.length, 2);
  assert.equal(asks[0].format.properties.types.items.enum.join(','), 'user,feedback,reference');
  // projects: alpha created with repo:, beta proposed and left
  assert.deepEqual(r.projects.created, [{ id: '~/code/alpha', slug: 'alpha', repo: '~/code/alpha' }]);
  assert.match(read('workspaces/alpha/workspace.md'), /^repo: ~\/code\/alpha$/m);
  assert.ok(fs.existsSync(V('workspaces/alpha/CLAUDE.md')) && fs.existsSync(V('workspaces/alpha/AGENTS.md')));
  assert.ok(!fs.existsSync(V('workspaces/beta')));
  // mcp
  const m = json('brain/_index/mcp-servers.json');
  assert.deepEqual(m.servers.map((s) => `${s.host}:${s.name}`), ['claude:docs-search', 'codex:issue-tracker', 'claude:tracker', 'codex:web fetch']);
  assert.ok(m.servers.every((s) => !('args' in s) && !('env' in s) && !('headers' in s)), 'a listing: no arguments, environment or headers');
  // sessions: queued with the new workspace credited, the routine on
  const st = json('brain/_index/import-state.json');
  assert.equal(st.schema, 1);
  assert.deepEqual(st.phases.map((p) => `${p.phase}:${p.host}:${p.done}`), [
    'instructions:claude:true', 'instructions:codex:true', 'memories:claude:true', 'memories:codex:true', 'projects:all:true', 'mcp:claude:true', 'mcp:codex:true', 'sessions:all:true',
  ]);
  assert.equal(st.digest.queue.length, 6);
  assert.equal(st.digest.total, 6);
  const alpha = st.digest.queue.filter((q) => q.workspace === 'alpha').map((q) => q.key);
  assert.equal(alpha.length, 4, 'the three Claude sessions and the Codex one in alpha, credited through repo:');
  assert.equal(st.digest.queue[0].cwd.startsWith('~/'), true);
  assert.equal(require('../lib/routines-store.js').read('import-digest', { dir: V('brain/routines') }).enabled, true);
  assert.deepEqual(r.sessions, { added: 6, queued: 6, total: 6, routine: 'on', routineChanged: true, engineReady: true });
  assert.ok(lines.some((l) => /^instructions \(Claude Code\): 5 written, 0 already in the vault \(by rule, typed by the local model\)$/.test(l)), lines.join('\n'));
  // Review: one batch per host
  const hub = json('brain/_index/brain-hub.json');
  const batches = hub.batches.filter((b) => b.key.startsWith('import:'));
  assert.deepEqual(batches.map((b) => [b.key, b.title, b.host, b.paths.length]).sort(), [
    ['import:claude', 'Imported from Claude Code', 'claude', 8], ['import:codex', 'Imported from Codex', 'codex', 2],
  ]);
});

test('a second run writes nothing twice and creates nothing without --accept', async () => {
  const before = memoryFiles();
  const r = await runImport({ ...base });
  assert.equal(r.written, 0);
  assert.deepEqual(memoryFiles(), before);
  assert.deepEqual(r.projects.proposals.map((p) => p.id), ['~/code/beta'], 'alpha is a workspace now');
  assert.equal(r.projects.note, 'none created: pass --accept with the ids to create them');
  assert.equal(r.sessions.added, 0);
  assert.equal(r.hosts.claude.instructions.unchanged, 1);
  assert.equal(r.hosts.claude.memories.duplicates, 3);
});

test('the digest writes notes, the timeline, the cache and the wrap offsets, then turns itself off', async () => {
  const before = eng.calls.length;
  const r = await D.runDigest({ vault: w.vault, provider: eng.provider, deferOnBattery: () => false, config: () => ({}), home: w.home, now: () => Date.now() });
  assert.equal(r.status, 'done');
  assert.equal(r.processed, 6);
  assert.match(r.line, /^import-digest: 6 sessions digested, 1 memories for Review; done, and the routine is off$/);
  const asks = eng.calls.slice(before);
  assert.equal(asks.length, 6);
  assert.equal(asks[0].feature, 'import-digest');
  assert.deepEqual(asks[0].format.required, ['summary', 'memories']);
  assert.match(asks[0].prompt, /<transcript>\nuser: /);
  assert.match(asks[0].prompt, /Workspaces: alpha/);
  // session-digests.json, newest first
  const dg = json('brain/_index/session-digests.json');
  assert.equal(dg.schema, 1);
  assert.equal(dg.sessions.length, 6);
  const a1 = dg.sessions.find((s) => s.id === w.sessions.alpha1.id);
  assert.deepEqual([a1.host, a1.workspace, a1.title, a1.summarySource, a1.resume], ['claude', 'alpha', 'Parser fixes', 'model', `claude --resume ${w.sessions.alpha1.id}`]);
  assert.deepEqual(dg.sessions.map((s) => s.startedAt), [...dg.sessions.map((s) => s.startedAt)].sort().reverse());
  // daily note
  const P = require('../lib/paths.js');
  const note = path.join(w.vault, ...P.formatLayout(P.DEFAULT_LAYOUT, new Date(w.sessions.alpha1.ts)).split('/'));
  assert.match(fs.readFileSync(note, 'utf8'), new RegExp(`## Sessions\\n- \\d{2}:\\d{2} \\*\\*Parser fixes\\*\\* · Claude Code · alpha — Fixed a parser bug and added a regression test\\. · \`claude --resume ${w.sessions.alpha1.id}\``));
  // history.md: alpha's four, newest first
  const hist = read('workspaces/alpha/history.md');
  const days = [...hist.matchAll(/^### (\d{4}-\d{2}-\d{2})$/gm)].map((x) => x[1]);
  assert.deepEqual(days, [...days].sort().reverse());
  assert.equal((hist.match(/^- \d{2}:\d{2} /gm) || []).length, 4);
  assert.match(hist, /Codex — .* · `codex resume /);
  // one memory, deduplicated across sessions, from the digest
  const mem = read('brain/memory/feedback/add-a-regression-test-for-parser.md');
  assert.match(mem, /source: import:claude|source: import:codex/);
  assert.match(mem, /reviewed: false/);
  // wrap offsets: every digested session marked at its flattened length, so auto-wrap reads only what comes after
  const { readTranscriptFile, flattenTurns } = require('../lib/transcript.js');
  const offsets = require('../lib/wrap-offsets.js');
  assert.equal(offsets.wrappedChars(w.sessions.alpha1.id), flattenTurns(readTranscriptFile(w.sessions.alpha1.file)).length);
  assert.equal(offsets.hasNewDialogue(offsets.unwrappedPart(flattenTurns(readTranscriptFile(w.sessions.beta1.file)), offsets.wrappedChars(w.sessions.beta1.id))), false);
  // done: the state says so and the routine is off
  const st = json('brain/_index/import-state.json');
  assert.deepEqual([st.digest.done, st.digest.queue.length, st.digest.processed, st.digest.total], [true, 0, 6, 6]);
  assert.equal(st.digest.lastRun.status, 'done');
  assert.equal(require('../lib/routines-store.js').read('import-digest', { dir: V('brain/routines') }).enabled, false);
  // A run with nothing queued says so and asks nothing.
  const idle = await D.runDigest({ vault: w.vault, provider: eng.provider, deferOnBattery: () => false, config: () => ({}), home: w.home });
  assert.equal(idle.status, 'idle');
  assert.equal(eng.calls.length, before + 6);
});

test('an import of sessions already digested queues nothing and leaves the routine off', async () => {
  const r = await runImport({ ...base, only: ['sessions'] });
  assert.deepEqual([r.sessions.added, r.sessions.queued, r.sessions.routineChanged], [0, 0, false]);
  assert.equal(require('../lib/routines-store.js').read('import-digest', { dir: V('brain/routines') }).enabled, false);
});
