'use strict';
// The importer's pieces (install-import B8–B10): rules out of an instruction file, the host's auto-memory shape, both
// hosts' MCP listings (no secrets), the daily-note and history writers, the reply check, the window, the battery probe,
// the duplicate check and the routine file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-import-units-')));
const VAULT = path.join(TMP, 'vault');
for (const d of ['brain/_index', 'brain/memory/feedback', 'brain/memory/reference', 'brain/routines']) fs.mkdirSync(path.join(VAULT, d), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'MEMORY.md'), '# Index\n');
process.env.AOS_VAULT = VAULT;

const C = require('../lib/import/common.js');
const I = require('../lib/import/instructions.js');
const M = require('../lib/import/memories.js');
const X = require('../lib/import/mcp.js');
const D = require('../lib/import/digest.js');
const { windowDays } = require('../lib/import/index.js');
const { onBattery, deferOnBattery } = require('../lib/power.js');

const FIX = path.join(__dirname, 'fixtures', 'import');

test('splitRules: a rule per top-level bullet, numbered item or paragraph, under its headings; @includes and comments never copied', () => {
  const rules = I.splitRules([
    '@/somewhere/AGENTICOS.md',
    '# Working with me',
    '- Always run the tests first.',
    '- Keep diffs small:',
    '  - one change each',
    '',
    'A paragraph that is a rule',
    'over two lines.',
    '## Tools',
    '1. Deploy with make deploy',
    '<!-- not a rule -->',
    '```sh',
    'make deploy-staging',
    '```',
    '* ok',
  ].join('\n'));
  assert.deepEqual(rules.map((r) => [r.heading, r.text]), [
    ['Working with me', 'Always run the tests first.'],
    ['Working with me', 'Keep diffs small:\n  - one change each'],
    ['Working with me', 'A paragraph that is a rule\nover two lines.'],
    ['Working with me › Tools', 'Deploy with make deploy'],
    ['Working with me › Tools', '```sh\nmake deploy-staging\n```'],
  ]);
  assert.doesNotMatch(I.cleanText('@/v/AGENTICOS.md\nkeep me\n<!-- x -->'), /AGENTICOS|<!--/);
});

test('the auto-memory shape: name, description and type at the top or under metadata:', () => {
  const top = M.parseAutoMemory(fs.readFileSync(path.join(FIX, 'claude-config/projects/-code-alpha/memory/prefers-small-prs.md'), 'utf8'));
  assert.equal(top.name, 'Prefers small pull requests');
  assert.equal(top.type, 'feedback');
  assert.match(top.body, /^\nKeep each pull request/);
  const nested = M.parseAutoMemory(fs.readFileSync(path.join(FIX, 'claude-config/projects/-code-alpha/memory/staging-deploy.md'), 'utf8'));
  assert.equal(nested.type, 'reference');
  const c = M.candidateOf('---\nname: "Quoted: name"\ntype: project\n---\n# Quoted: name\n\nBody text here.\n', 'x.md');
  assert.deepEqual(c, { type: 'projects', title: 'Quoted: name', description: 'Body text here.', body: 'Body text here.' });
  assert.equal(M.candidateOf('---\nname: Empty\ntype: user\n---\n', 'x.md'), null);
  assert.equal(M.candidateOf('no frontmatter at all, still a note', 'plain-note.md').title, 'plain note');
  assert.equal(M.candidateOf('---\ntype: weird\n---\nbody', 'y.md').type, 'reference');
});

test('MCP: both hosts listed without arguments, env, headers, credentials, query or fragment; agenticos and project scope left out', () => {
  const home = path.join(TMP, 'home-mcp');
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  // What a real config may hold beside a server's name is written here at run time, from a random marker: the repository
  // keeps no credential-shaped value, and the listing must carry none of them.
  const marker = require('crypto').randomBytes(8).toString('hex');
  const withSecrets = (base) => {
    const u = new URL(base);
    u.username = 'reader';
    u.password = marker;
    u.searchParams.set('key', marker);
    u.hash = `frag-${marker}`;
    return u.toString();
  };
  const claudeJson = JSON.parse(fs.readFileSync(path.join(FIX, 'claude-config', '.claude.json'), 'utf8'));
  claudeJson.mcpServers['docs-search'].args.push('--token', marker);
  claudeJson.mcpServers['docs-search'].env.API_KEY = marker;
  claudeJson.mcpServers.tracker.url = withSecrets(claudeJson.mcpServers.tracker.url);
  claudeJson.mcpServers.tracker.headers = { Authorization: `Bearer ${marker}` };
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify(claudeJson));
  fs.writeFileSync(path.join(codexDir, 'config.toml'), fs.readFileSync(path.join(FIX, 'codex-home', 'config.toml'), 'utf8')
    .replace('url = "https://fetch.example.com/mcp"', `url = ${JSON.stringify(withSecrets('https://fetch.example.com/mcp'))}`)
    .replace('args = ["--stdio"]', `args = ["--stdio", "--token", ${JSON.stringify(marker)}]`)
    .replace('LOG_LEVEL = "warn"', `TOKEN = ${JSON.stringify(marker)}`));
  const c = X.listServers('claude', { dirs: { configDir: claudeDir }, home });
  assert.deepEqual(c.servers, [
    { name: 'docs-search', host: 'claude', transport: 'stdio', command: 'npx', scope: 'user', enabled: true },
    { name: 'tracker', host: 'claude', transport: 'http', url: 'https://localhost:8443/mcp', scope: 'user', enabled: true },
  ]);
  const x = X.listServers('codex', { dirs: { configDir: codexDir }, home });
  assert.deepEqual(x.servers, [
    { name: 'issue-tracker', host: 'codex', transport: 'stdio', command: '/opt/tools/issue-mcp', scope: 'user', enabled: true },
    { name: 'web fetch', host: 'codex', transport: 'http', url: 'https://fetch.example.com/mcp', scope: 'user', enabled: false },
  ]);
  assert.ok(!JSON.stringify([c, x]).includes(marker), 'no argument, environment value, header, credential, query or fragment');
  assert.equal(X.cleanUrl(withSecrets('https://localhost:8443/mcp')), 'https://localhost:8443/mcp');
  assert.equal(X.cleanUrl('not a url'), null);
  // The default config folder keeps the file beside it; a folder of its own keeps it inside.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { beside: { command: path.join(home, 'bin', 'tool') } } }));
  assert.equal(X.claudeUserFile({ dirs: { configDir: claudeDir }, home }), path.join(home, '.claude.json'));
  assert.deepEqual(X.listServers('claude', { dirs: { configDir: claudeDir }, home }).servers.map((s) => [s.name, s.command]), [['beside', '~/bin/tool']]);
  assert.equal(X.claudeUserFile({ dirs: { configDir: path.join(TMP, 'own-cfg') }, home }), path.join(TMP, 'own-cfg', '.claude.json'));
  assert.deepEqual(X.listServers('codex', { dirs: { configDir: path.join(TMP, 'no-codex') }, home }).servers, []);
});

test('writeServers keeps the other host\'s rows and writes schema 1', () => {
  X.writeServers(VAULT, ['claude', 'codex'], { claude: [{ name: 'a', host: 'claude' }], codex: [{ name: 'b', host: 'codex' }] });
  X.writeServers(VAULT, ['codex'], { codex: [{ name: 'c', host: 'codex' }] });
  const j = JSON.parse(fs.readFileSync(X.outFile(VAULT), 'utf8'));
  assert.equal(j.schema, 1);
  assert.deepEqual(j.servers.map((s) => `${s.host}:${s.name}`), ['claude:a', 'codex:c']);
});

test('withSessionLine: a new note, a note without the section, time order inside it, never twice, the rest untouched', () => {
  const l = (t, id) => `- ${t} **T** · Claude Code — s · \`claude --resume ${id}\``;
  const fresh = D.withSessionLine(null, { day: '2026-10-01', line: l('09:00', 'id-a'), id: 'id-a' });
  assert.equal(fresh, `---\ntype: daily-note\ndate: 2026-10-01\ntags: [daily-note]\n---\n\n# 2026-10-01\n\n## Sessions\n${l('09:00', 'id-a')}\n`);
  const mine = '# 2026-10-01\n\nMy own notes stay.\n\n## Claude Code Sessions\n\n## Session Wrap @ 10:00\n- did things\n';
  const added = D.withSessionLine(mine, { day: '2026-10-01', line: l('09:00', 'id-a'), id: 'id-a' });
  assert.ok(added.startsWith(mine.trimEnd()), 'everything that was there stays, byte for byte');
  assert.match(added, /\n\n## Sessions\n- 09:00 /);
  const two = D.withSessionLine(added, { day: '2026-10-01', line: l('08:00', 'id-b'), id: 'id-b' });
  const three = D.withSessionLine(two, { day: '2026-10-01', line: l('23:00', 'id-c'), id: 'id-c' });
  const section = three.slice(three.indexOf('## Sessions'));
  assert.deepEqual(section.split('\n').filter((x) => x.startsWith('- ')).map((x) => x.slice(2, 7)), ['08:00', '09:00', '23:00']);
  assert.equal(D.withSessionLine(three, { day: '2026-10-01', line: l('09:00', 'id-a'), id: 'id-a' }), three, 'a note naming the id is left alone');
  // A section followed by another heading: the line lands inside it, before that heading.
  const mid = D.withSessionLine('## Sessions\n- 10:00 x\n\n## Later\ntext\n', { day: 'd', line: l('11:00', 'z'), id: 'z' });
  assert.equal(mid, `## Sessions\n- 10:00 x\n${l('11:00', 'z')}\n\n## Later\ntext\n`);
  const crlf = D.withSessionLine('# d\r\n\r\n## Sessions\r\n- 10:00 x\r\n', { day: 'd', line: l('11:00', 'w'), id: 'w' });
  assert.equal(crlf, `# d\r\n\r\n## Sessions\r\n- 10:00 x\r\n${l('11:00', 'w')}\r\n`);
});

test('withHistory: newest day first, the block between its markers replaced, the rest kept', () => {
  const e = (day, time, id, startedAt) => ({ key: `claude:${id}`, id, host: 'claude', day, time, title: `T ${id}`, summary: 'S', startedAt, resume: null });
  const first = D.withHistory(null, 'alpha', [e('2026-10-01', '09:00', 'a', '2026-10-01T09:00:00Z')]);
  assert.match(first, /^# History\n\nPast sessions in the alpha workspace/);
  const edited = first.replace('# History', '# History\n\nMy note above.') + '\nMy note below.\n';
  const next = D.withHistory(edited, 'alpha', [e('2026-10-01', '09:00', 'a', '2026-10-01T09:00:00Z'), e('2026-10-03', '10:00', 'b', '2026-10-03T10:00:00Z')]);
  assert.match(next, /My note above\.[\s\S]*### 2026-10-03\n- 10:00 \*\*T b\*\* · Claude Code — S\n\n### 2026-10-01[\s\S]*My note below\./);
  assert.equal(next.split(D.HISTORY_START).length, 2, 'one block');
});

test('lineFor and resumeOf: the resume command per host, only for a session id that is a UUID', () => {
  const id = '0199bbbb-0000-4000-8000-000000000001';
  assert.equal(D.resumeOf('claude', id), `claude --resume ${id}`);
  assert.equal(D.resumeOf('codex', id), `codex resume ${id}`);
  assert.equal(D.resumeOf('claude', 'not-a-uuid'), null);
  assert.equal(D.lineFor({ time: '09:05', title: 'Fix **it**\nnow', host: 'codex', workspace: 'alpha', summary: 'Did `x`.', resume: null }),
    "- 09:05 **Fix it now** · Codex · alpha — Did 'x'.");
});

test('validReply: a summary is required; the workspace must be one listed; at most three memories', () => {
  assert.equal(D.validReply({ memories: [] }, []), null);
  assert.equal(D.validReply({ summary: '  ' }, []), null);
  const r = D.validReply({ summary: 'Did it.', workspace: 'ghost', memories: [1, {}, {}, {}, {}] }, ['alpha']);
  assert.deepEqual(r, { summary: 'Did it.', workspace: null, memories: [{}, {}, {}] });
  assert.equal(D.validReply({ summary: 'x', workspace: 'alpha', memories: 'no' }, ['alpha']).workspace, 'alpha');
});

test('windowDays: <n>d and all', () => {
  assert.equal(windowDays('90d'), 90);
  assert.equal(windowDays('all'), Infinity);
  assert.equal(windowDays('0d'), null);
  assert.equal(windowDays('3w'), null);
});

test('onBattery: pmset on macOS, power_supply on Linux; local.onBattery run never defers', () => {
  const pm = (out) => () => ({ status: 0, stdout: out });
  assert.equal(onBattery({ platform: 'darwin', exec: pm("Now drawing from 'Battery Power'\n -InternalBattery-0 80%") }), true);
  assert.equal(onBattery({ platform: 'darwin', exec: pm("Now drawing from 'AC Power'") }), false);
  assert.equal(onBattery({ platform: 'darwin', exec: () => { throw new Error('no pmset'); } }), false);
  const sys = path.join(TMP, 'power');
  const supply = (n, files) => { fs.mkdirSync(path.join(sys, n), { recursive: true }); for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(sys, n, f), `${v}\n`); };
  supply('BAT0', { type: 'Battery', status: 'Discharging' });
  supply('AC', { type: 'Mains', online: '0' });
  assert.equal(onBattery({ platform: 'linux', sysDir: sys }), true);
  supply('AC', { type: 'Mains', online: '1' });
  assert.equal(onBattery({ platform: 'linux', sysDir: sys }), false);
  assert.equal(onBattery({ platform: 'win32' }), false);
  const batt = { platform: 'darwin', exec: pm("'Battery Power'") };
  assert.equal(deferOnBattery({ local: { onBattery: 'defer' } }, batt), true);
  assert.equal(deferOnBattery({}, batt), true);
  assert.equal(deferOnBattery({ local: { onBattery: 'run' } }, batt), false);
});

test('Deduper: the same text, a like title and like words are duplicates; a new idea is not', async () => {
  fs.writeFileSync(path.join(VAULT, 'brain/memory/feedback/run-tests.md'),
    '---\ntype: memory\ntags: [memory/feedback, status/active]\n---\n\n# Always run the full test suite\n\nRun the whole test suite before calling a change done.\n');
  fs.writeFileSync(path.join(VAULT, 'brain/memory/reference/gone.md'),
    '---\ntype: memory\ntags: [memory/reference, status/archived]\n---\n\n# Deploy with make\n\nDeploy staging with make deploy-staging.\n');
  const d = new C.Deduper(VAULT);
  assert.deepEqual(await d.check({ title: 'Something else', body: 'Run the whole   test suite before calling a change done.' }),
    { dup: true, reason: 'same text', path: 'brain/memory/feedback/run-tests.md', score: 1 });
  assert.equal((await d.check({ title: 'Always run the full test suite!', body: 'unrelated words entirely' })).reason, 'similar title');
  assert.equal((await d.check({ title: 'Deploy with make', body: 'Deploy staging with make deploy-staging.' })).dup, false, 'an archived memory is no duplicate');
  assert.equal((await d.check({ title: 'Prefer pnpm', body: 'Use pnpm in JavaScript repositories.' })).dup, false);
  d.add({ title: 'Prefer pnpm', body: 'Use pnpm in JavaScript repositories.', path: 'brain/memory/feedback/prefer-pnpm.md' });
  assert.equal((await d.check({ title: 'Package manager', body: 'Use pnpm in JavaScript repositories!' })).dup, true, 'what this run wrote counts too');
});

test('the routine: the template is ROUTINE as the store writes it; setRoutine flips enabled and writes it back when missing', () => {
  const store = require('../lib/routines-store.js');
  const tmpl = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'vault-template', 'brain', 'routines', 'import-digest.md'), 'utf8');
  assert.equal(tmpl, store.toFile({ ...D.ROUTINE }));
  const r = store.fromFile('import-digest', tmpl);
  assert.deepEqual([r.kind, r.enabled, r.errors], ['command', true, []]);
  const dir = path.join(VAULT, 'brain', 'routines');
  assert.deepEqual(D.setRoutine(VAULT, false), { created: false, changed: false, file: null }, 'nothing to turn off');
  assert.equal(D.setRoutine(VAULT, true).created, true);
  assert.equal(fs.readFileSync(path.join(dir, 'import-digest.md'), 'utf8'), tmpl);
  assert.equal(D.setRoutine(VAULT, true).changed, false);
  assert.equal(D.setRoutine(VAULT, false).changed, true);
  assert.equal(store.read('import-digest', { dir }).enabled, false);
});

test('tilde and insideVault: home paths as ~/…, the vault by its real path', () => {
  assert.equal(C.tilde(path.join(TMP, 'h', '.claude', 'CLAUDE.md'), path.join(TMP, 'h')), '~/.claude/CLAUDE.md');
  assert.equal(C.tilde('/opt/x', path.join(TMP, 'h')), '/opt/x');
  fs.symlinkSync(path.join(VAULT, 'MEMORY.md'), path.join(TMP, 'link.md'));
  assert.equal(C.insideVault(path.join(TMP, 'link.md'), VAULT), true);
  assert.equal(C.insideVault(path.join(TMP, 'h'), VAULT), false);
});
