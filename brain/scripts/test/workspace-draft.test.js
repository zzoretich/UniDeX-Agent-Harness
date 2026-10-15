'use strict';
// lib/workspace-draft.js (spaces-redesign D13, D14): the sources, the strict schema, one provider.js call per host with
// fakes (none, claude, codex, ollama; a Codex-enabled vault whose logged-in claude answers), the labelled heuristic,
// and Save with Status on auto. No network and no model: every CLI is a fake, and Ollama's chat is stubbed.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-draft-test-')));
const VAULT = path.join(TMP, 'vault');
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
fs.mkdirSync(path.join(VAULT, 'workspaces'), { recursive: true });
process.env.BRAIN_VAULT = VAULT;
process.env.AOS_CONFIG = path.join(TMP, 'agenticos.json');

const D = require('../lib/workspace-draft.js');
const M = require('../lib/workspace-manifest.js');
const P = require('../sdk/lib/provider.js');
const { recordSpend, SPEND_PATH, ProviderUnavailable } = require('../sdk/lib/spend-ledger.js');
const codexCli = require('../sdk/lib/codex-cli.js');
const ollama = require('../sdk/lib/ollama.js');
const { role } = require('../sdk/lib/models.js');

const CONFIG = path.join(VAULT, 'brain', 'config.json');
const never = (what) => async () => { throw new Error(`${what} must not be called`); };
const REPLY = { summary: 'A drafted summary.', objectives: ['Ship the dialog', 'Write the docs'], next: 'Open the PR' };

// These cases drive the auto chain with each host faked at its seam: a case that names no provider runs on auto, not
// 2.0's shipped default `local` (local-first A10), which would ask whatever engine answers on this machine.
function setConfig(vaultCfg = {}, userCfg = {}) {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'auto', ...vaultCfg }));
  fs.writeFileSync(process.env.AOS_CONFIG, JSON.stringify(userCfg));
}

let seq = 0;
/** A fresh workspace with the source-filter fixture: what may be read, and what never may. */
function fixture({ manifest = '---\ntype: project\nsummary: Old summary\n---\n# Demo\n' } = {}) {
  const name = `demo-${++seq}`;
  const dir = path.join(VAULT, 'workspaces', name);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const repo = path.join(TMP, `code-${seq}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'REPO-FOLDER-SECRET\n');
  const outside = path.join(TMP, `outside-${seq}.md`);
  fs.writeFileSync(outside, 'LINKED-SECRET\n');
  const files = {
    'workspace.md': manifest.replace('---\n# Demo', `repo: ${repo}\n---\n# Demo`),
    'README.md': '# Demo\n\nA demo project for drafting.\n\n## Objectives\n\n- Ship it\n- [x] Already done\n\n## Next\n\n- Readme next step\n',
    'HANDOFF-demo.md': '# Handoff 2026-10-09\n\n## Now\n\nHalfway through.\n\n## Next\n\n- Handoff next step\n',
    'CLAUDE.md': 'Same instructions.\n',
    'AGENTS.md': 'Same instructions.\n',
    'notes.txt': 'plain text notes\n',
    'big.md': `BIG-HEAD\n${'x'.repeat(20 * 1024)}\nBIG-TAIL\n`,
    '.env': 'DOT-ENV-SECRET\n',
    '.env.local': 'DOT-ENV-LOCAL-SECRET\n',
    '.hidden.md': 'DOT-FILE-SECRET\n',
    '.credentials.json': '{"t":"CREDENTIALS-SECRET"}',
    'auth.json': '{"t":"AUTH-SECRET"}',
    'server.pem': 'PEM-SECRET\n',
    'deploy.key': 'KEY-SECRET\n',
    'id_ed25519': 'SSH-SECRET\n',
    'id_rsa.pub': 'SSH-PUB-SECRET\n',
    'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x42, 0x49, 0x4e]),
    'sub/deep.md': 'SUBFOLDER-SECRET\n',
  };
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
  fs.symlinkSync(outside, path.join(dir, 'link.md'));
  fs.symlinkSync(path.join(dir, 'missing.md'), path.join(dir, 'dangling.md'));
  return { name, dir, repo };
}
const SECRETS = ['REPO-FOLDER-SECRET', 'LINKED-SECRET', 'DOT-ENV-SECRET', 'DOT-ENV-LOCAL-SECRET', 'DOT-FILE-SECRET', 'CREDENTIALS-SECRET',
  'AUTH-SECRET', 'PEM-SECRET', 'KEY-SECRET', 'SSH-SECRET', 'SSH-PUB-SECRET', 'SUBFOLDER-SECRET', 'BIG-TAIL'];

/** Every file under the vault's workspaces/ with its bytes' hash (links by target), to prove nothing was written. */
function tree(root) {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      const rel = path.relative(root, p);
      if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(p); } else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}
const indexFiles = () => fs.readdirSync(path.join(VAULT, 'brain', '_index')).sort();
const spendRows = () => { try { return fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** A fake `claude -p` at the claudeCall seam: records its options and bills the ledger as the real one does. */
function fakeClaude(calls, reply = REPLY) {
  return async (o) => {
    calls.push(o);
    recordSpend({ feature: o.feature, provider: 'claude', model: o.model, usd: 0.002, inputTokens: 100, outputTokens: 20, ms: 5 });
    return typeof reply === 'string' ? { text: reply, structured: null, usd: 0.002, usage: {}, ms: 5 } : { text: JSON.stringify(reply), structured: reply, usd: 0.002, usage: {}, ms: 5 };
  };
}

/** A fake `codex exec` at the spawn seam (codex-cli.js runs for real): records argv, cwd and what the cwd held. */
function fakeCodexSpawn(calls, reply = REPLY) {
  return (bin, args, opts) => {
    const si = args.indexOf('--output-schema');
    const rec = { bin, args, cwd: opts.cwd, cwdEntries: fs.readdirSync(opts.cwd), schema: si === -1 ? null : JSON.parse(fs.readFileSync(args[si + 1], 'utf8')), stdin: '' };
    calls.push(rec);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (c) => { rec.stdin += c; });
    child.kill = () => {};
    const events = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: JSON.stringify(reply) } },
      { type: 'turn.completed', usage: { input_tokens: 2000, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0 } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    setImmediate(() => { child.stdout.end(events); child.stderr.end(''); setImmediate(() => child.emit('close', 0)); });
    return child;
  };
}

const realOllamaChat = ollama.chat;
beforeEach(() => {
  P.resetProviderCache();
  for (const f of [P.STATE_PATH, SPEND_PATH]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  setConfig();
});
afterEach(() => { ollama.chat = realOllamaChat; });

test('the schema is strict, as codex exec needs it, and asks for no status', () => {
  const s = D.DRAFT_SCHEMA;
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
  assert.deepEqual(Object.keys(s.properties).sort(), ['next', 'objectives', 'summary']);
  assert.ok(!('status' in s.properties));
  assert.deepEqual(codexCli.strictSchema(s), JSON.parse(JSON.stringify(s)), 'already strict: the Codex conversion changes nothing');
  assert.equal(D.TIMEOUT_MS, 90_000);
  assert.ok(!/status/i.test(D.SYSTEM), 'the prompt never asks for a status');
});

test('the credential pattern is the app read-scope one, copied exactly', (t) => {
  const file = path.join(__dirname, '..', '..', '..', 'app', 'src', 'main', 'policy', 'read-scope.ts');
  if (!fs.existsSync(file)) return t.skip('the app source is not beside this runtime (a vendored copy)');
  const m = /const CREDENTIALS = (\/.*\/[a-z]*);/.exec(fs.readFileSync(file, 'utf8'));
  assert.ok(m, 'read-scope.ts still declares CREDENTIALS');
  assert.equal(String(D.CREDENTIALS), m[1]);
});

test('sources: top-level regular text files only; never a dot-file, a credential name, a link, a folder, a binary or the repo: folder', () => {
  const { dir } = fixture();
  const sources = D.collectSources(dir);
  const names = sources.map((s) => s.name);
  assert.deepEqual(names, ['workspace.md', 'HANDOFF-demo.md', 'README.md', 'CLAUDE.md', 'big.md', 'notes.txt'],
    'manifest and notes first; AGENTS.md is the same text as CLAUDE.md and is left out');
  const big = sources.find((s) => s.name === 'big.md');
  assert.equal(big.truncated, true);
  assert.equal(big.bytes, D.MAX_SOURCE_BYTES);
  assert.ok(sources.every((s) => Buffer.byteLength(s.text) <= D.MAX_SOURCE_BYTES));
  const prompt = D.buildPrompt('demo', sources);
  assert.match(prompt, /=== big\.md \(first 16 KB\) ===\nBIG-HEAD/);
  assert.match(prompt, /A demo project for drafting\./);
  for (const s of SECRETS) assert.ok(!prompt.includes(s), `${s} never reaches the prompt`);
  // Credential names in any case, and the usual key files.
  for (const n of ['.credentials.json', 'AUTH.JSON', '.env', '.env.production', 'cert.PEM', 'x.key', 'x.p12', 'x.pfx', 'id_rsa', 'id_ecdsa.pub']) {
    assert.ok(D.CREDENTIALS.test(n), n);
  }
  assert.ok(!D.CREDENTIALS.test('README.md'));
});

test('sources stop at 12 files and 96 KB in all', () => {
  const name = `many-${++seq}`;
  const dir = path.join(VAULT, 'workspaces', name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `n${String(i).padStart(2, '0')}.md`), `note ${i}\n`);
  assert.equal(D.collectSources(dir).length, D.MAX_SOURCES);
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `n${String(i).padStart(2, '0')}.md`), `${i}`.repeat(15 * 1024));
  const total = D.collectSources(dir).reduce((n, s) => n + s.bytes, 0);
  assert.ok(total <= D.MAX_TOTAL_BYTES, `${total}`);
});

test('provider none: the labelled heuristic from the same files, with the reason; no model call, no spend, no workspace write', async () => {
  setConfig({ provider: 'none' });
  const { name } = fixture();
  const before = tree(path.join(VAULT, 'workspaces'));
  const d = await D.draftWorkspace(name, { vault: VAULT, providerDeps: { claudeCall: never('claude'), codexCall: never('codex'), ping: never('ping') } });
  assert.equal(d.provider, 'heuristic');
  assert.equal(d.model, null);
  assert.equal(d.reason, 'the model provider is set to none (forced)');
  assert.deepEqual(d.fields, { summary: 'Old summary', objectives: ['Ship it'], next: 'Handoff next step' });
  assert.deepEqual(Object.keys(d), ['provider', 'model', 'reason', 'generatedAt', 'sources', 'fields', 'file', 'baseHash']);
  assert.equal(d.file, `workspaces/${name}/workspace.md`);
  assert.equal(d.baseHash, M.readManifest(path.join(VAULT, 'workspaces', name)).hash);
  assert.ok(d.sources.includes('README.md') && !d.sources.includes('.env'));
  assert.deepEqual(tree(path.join(VAULT, 'workspaces')), before);
  assert.deepEqual(spendRows(), []);
});

test('claude: one call with the strict schema, 90 s, the per-call cap and the sources inline; labelled claude; only provider state and the ledger change', async () => {
  const { name } = fixture();
  const calls = [];
  const before = tree(path.join(VAULT, 'workspaces'));
  const indexBefore = indexFiles();
  const d = await D.draftWorkspace(name, {
    vault: VAULT,
    now: () => new Date('2026-10-10T09:00:00.000Z'),
    providerDeps: { ping: async () => false, resolveClaudeBin: () => '/fake/bin/claude', loginProbe: async () => true, claudeCall: fakeClaude(calls), codexCall: never('codex') },
  });
  assert.equal(calls.length, 1, 'one model call');
  const c = calls[0];
  assert.deepEqual(c.schema, D.DRAFT_SCHEMA);
  assert.equal(c.feature, 'workspace-draft');
  assert.equal(c.timeoutMs, 90_000);
  assert.equal(c.model, 'haiku');
  assert.equal(c.maxBudgetUsd, 0.05);
  assert.match(c.prompt, /=== README\.md ===\n# Demo/);
  for (const s of SECRETS) assert.ok(!c.prompt.includes(s), s);
  assert.equal(d.provider, 'claude');
  assert.equal(d.model, 'haiku');
  assert.equal(d.reason, 'claude-logged-in');
  assert.equal(d.generatedAt, '2026-10-10T09:00:00.000Z');
  assert.deepEqual(d.fields, REPLY);
  assert.deepEqual(tree(path.join(VAULT, 'workspaces')), before, 'no workspace file written');
  const added = indexFiles().filter((f) => !indexBefore.includes(f));
  assert.deepEqual(added.sort(), ['provider-spend.jsonl', 'provider-state.json']);
  const rows = spendRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feature, 'workspace-draft');
});

test('codex: the one-shot runs codex exec with an empty temp folder as its cwd, gone afterwards; labelled codex', async () => {
  setConfig({}, { hosts: { claude: { enabled: false }, codex: { enabled: true } } });
  const { name } = fixture();
  const spawns = [];
  const d = await D.draftWorkspace(name, {
    vault: VAULT,
    providerDeps: {
      ping: async () => false, resolveClaudeBin: () => null, loginProbe: never('claude login'), claudeCall: never('claude'),
      resolveCodexBin: () => '/fake/bin/codex', codexLoginProbe: async () => true,
      codexCall: (o) => codexCli.codexCall({ ...o, bin: '/fake/bin/codex', spawnFn: fakeCodexSpawn(spawns) }),
    },
  });
  assert.equal(spawns.length, 1);
  const s = spawns[0];
  assert.deepEqual(s.cwdEntries, [], 'the cwd is empty when codex starts');
  assert.ok(path.resolve(s.cwd).startsWith(path.resolve(os.tmpdir())), s.cwd);
  assert.ok(!path.resolve(s.cwd).startsWith(VAULT), 'never the vault');
  assert.equal(fs.existsSync(s.cwd), false, 'removed after the call');
  assert.ok(s.args.includes('read-only'));
  assert.deepEqual(s.schema, JSON.parse(JSON.stringify(D.DRAFT_SCHEMA)), 'the strict schema reaches --output-schema unchanged');
  assert.match(s.stdin, /A demo project for drafting\./);
  for (const secret of SECRETS) assert.ok(!s.stdin.includes(secret), secret);
  assert.equal(d.provider, 'codex');
  assert.equal(d.reason, 'codex-logged-in');
  assert.deepEqual(d.fields, REPLY);
  const rows = spendRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feature, 'workspace-draft');
  assert.equal(rows[0].provider, 'codex');
});

test('ollama: the schema goes as format, the label names the workhorse model, nothing is billed', async () => {
  const { name } = fixture();
  const calls = [];
  ollama.chat = async (o) => { calls.push(o); return JSON.stringify(REPLY); };
  const d = await D.draftWorkspace(name, { vault: VAULT, providerDeps: { ping: async () => true, claudeCall: never('claude'), codexCall: never('codex') } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].format, D.DRAFT_SCHEMA);
  assert.equal(calls[0].timeoutMs, 90_000);
  assert.equal(d.provider, 'ollama');
  assert.equal(d.model, role('workhorse').tag);
  assert.equal(d.reason, 'ollama-reachable');
  assert.deepEqual(d.fields, REPLY);
  assert.deepEqual(spendRows(), []);
});

test('a Codex-only vault with a logged-in claude CLI is answered by Codex: a host the user did not enable never spends (install-import F1)', async () => {
  setConfig({}, { hosts: { claude: { enabled: false }, codex: { enabled: true } } });
  const { name } = fixture();
  const spawns = [];
  const d = await D.draftWorkspace(name, {
    vault: VAULT,
    providerDeps: {
      ping: async () => false, resolveClaudeBin: never('claude bin'), loginProbe: never('claude login'), claudeCall: never('claude'),
      resolveCodexBin: () => '/fake/bin/codex', codexLoginProbe: async () => true,
      codexCall: (o) => codexCli.codexCall({ ...o, bin: '/fake/bin/codex', spawnFn: fakeCodexSpawn(spawns) }),
    },
  });
  assert.equal(spawns.length, 1);
  assert.equal(d.provider, 'codex');
  assert.equal(d.reason, 'codex-logged-in');
});

test('the cap: an exhausted hook budget, or a cap hit during the call, falls back to the heuristic with the reason', async () => {
  const { name } = fixture();
  const capped = await D.draftWorkspace(name, {
    vault: VAULT,
    providerDeps: { ping: async () => false, resolveClaudeBin: () => '/fake/bin/claude', loginProbe: async () => true, spendToday: () => 9, claudeCall: never('claude') },
  });
  assert.equal(capped.provider, 'heuristic');
  assert.equal(capped.reason, 'the daily model budget is spent (daily-cap)');
  assert.equal(capped.fields.summary, 'Old summary');
  const midway = await D.draftWorkspace(name, {
    vault: VAULT,
    provider: async () => ({ name: 'codex', reason: 'codex-logged-in', model: null, chat: async () => { throw new ProviderUnavailable('PROVIDER_CAP', 'daily hook cap of 0.5 USD reached (codex.perDayUsd)', 'codex'); } }),
  });
  assert.equal(midway.provider, 'heuristic');
  assert.match(midway.reason, /^the daily model budget is spent: daily hook cap of 0\.5 USD reached \(codex\.perDayUsd\)$/);
});

test('a bad reply or a failed call falls back to the heuristic with the reason', async () => {
  const { name } = fixture();
  const run = (reply) => D.draftWorkspace(name, {
    vault: VAULT,
    providerDeps: { ping: async () => false, resolveClaudeBin: () => '/fake/bin/claude', loginProbe: async () => true, claudeCall: fakeClaude([], reply) },
  });
  for (const reply of ['not json at all', { summary: 'x', next: 'y' }, { summary: 'x', objectives: 'one', next: 'y' }, { summary: '', objectives: [], next: '' }]) {
    P.resetProviderCache();
    const d = await run(reply);
    assert.equal(d.provider, 'heuristic', JSON.stringify(reply));
    assert.equal(d.reason, 'the reply from claude was unreadable');
    assert.deepEqual(d.fields, { summary: 'Old summary', objectives: ['Ship it'], next: 'Handoff next step' });
  }
  const failed = await D.draftWorkspace(name, { vault: VAULT, provider: async () => ({ name: 'claude', reason: 'claude-logged-in', model: 'haiku', chat: async () => { throw new Error('claude -p timeout after 90000ms'); } }) });
  assert.equal(failed.provider, 'heuristic');
  assert.equal(failed.reason, 'the claude call failed: claude -p timeout after 90000ms');
});

test('a reply is cleaned to what set accepts: any status dropped, control characters gone, limits kept', () => {
  const long = 'word '.repeat(200);
  const f = D.parseDraftReply(JSON.stringify({
    summary: `Line one\nline two\u2028${long}`, status: 'done', objectives: ['- one', 'one', 7, ...Array.from({ length: 30 }, (_, i) => `goal ${i} ${long}`)], next: '\tDo it\u0000now', extra: 1,
  }));
  assert.deepEqual(Object.keys(f), ['summary', 'objectives', 'next']);
  assert.ok(!/[\u0000-\u001f\u2028]/.test(f.summary + f.next + f.objectives.join('')));
  assert.ok(Array.from(f.summary).length <= M.LIMITS.summary);
  assert.equal(f.objectives.length, M.LIMITS.objectives);
  assert.equal(f.objectives[0], 'one', 'a list marker goes, and a duplicate with it');
  assert.ok(f.objectives.every((o) => Array.from(o).length <= M.LIMITS.objective));
  assert.equal(f.next, 'Do it now');
  assert.doesNotThrow(() => M.validateSetFields(f, { vault: VAULT }));
  assert.deepEqual(D.parseDraftReply('```json\n{"summary":"s","objectives":[],"next":"n"}\n```'), { summary: 's', objectives: [], next: 'n' });
});

test('Save with Status on auto: set sends the drafted keys only, keeps the status: line as it was and the body; a second Save is refused', async () => {
  const { name, dir } = fixture({ manifest: '---\ntype: project\nstatus: paused\n---\n# Demo\n\nBody stays.\n' });
  // The model offers a status anyway: the draft never carries one, so Save on auto leaves the file's own.
  const d = await D.draftWorkspace(name, {
    vault: VAULT,
    providerDeps: { ping: async () => false, resolveClaudeBin: () => '/fake/bin/claude', loginProbe: async () => true, claudeCall: fakeClaude([], { ...REPLY, status: 'done' }) },
  });
  assert.deepEqual(Object.keys(d.fields).sort(), ['next', 'objectives', 'summary'], 'no status in the draft');
  const fields = M.validateSetFields(JSON.stringify(d.fields), { vault: VAULT });
  M.setManifest(dir, fields, { expect: d.baseHash });
  const text = fs.readFileSync(path.join(dir, 'workspace.md'), 'utf8');
  assert.match(text, /^status: paused$/m, 'Status left on auto keeps the status: line byte for byte');
  assert.ok(!/status: done/.test(text), 'the model\'s status is never written');
  assert.match(text, /^type: project$/m);
  assert.match(text, /\n---\n# Demo\n\nBody stays\.\n$/);
  const m = M.parseManifest(text);
  assert.equal(m.status, 'paused');
  assert.equal(m.summary, REPLY.summary);
  assert.deepEqual(m.objectives, REPLY.objectives);
  assert.equal(m.next, REPLY.next);
  assert.throws(() => M.setManifest(dir, fields, { expect: d.baseHash }), (e) => e.code === 'CHANGED' && e.message === 'workspace.md changed: draft again');
});

test('the draft refuses what is not a workspace and a symlinked workspace.md, before any model call', async () => {
  const opts = { vault: VAULT, provider: never('provider') };
  await assert.rejects(() => D.draftWorkspace('../brain', opts), (e) => e.code === 'INVALID');
  await assert.rejects(() => D.draftWorkspace('_archive', opts), (e) => e.code === 'INVALID');
  await assert.rejects(() => D.draftWorkspace('no-such-workspace', opts), (e) => e.code === 'NOT_FOUND');
  const name = `linked-${++seq}`;
  const dir = path.join(VAULT, 'workspaces', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Linked\n');
  const outside = path.join(TMP, `manifest-${seq}.md`);
  fs.writeFileSync(outside, '---\nsummary: OUTSIDE\n---\n');
  fs.symlinkSync(outside, path.join(dir, 'workspace.md'));
  await assert.rejects(() => D.draftWorkspace(name, opts), (e) => e.code === 'UNSAFE' && /symlink/.test(e.message));
});

test('a workspace with nothing readable gets the heuristic without a model call', async () => {
  const name = `empty-${++seq}`;
  const dir = path.join(VAULT, 'workspaces', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  const d = await D.draftWorkspace(name, { vault: VAULT, provider: never('provider') });
  assert.equal(d.provider, 'heuristic');
  assert.equal(d.reason, 'the workspace has no files to draft from');
  assert.deepEqual(d.sources, []);
  assert.deepEqual(d.fields, { summary: '', objectives: [], next: '' });
  assert.equal(d.baseHash, 'none');
});
