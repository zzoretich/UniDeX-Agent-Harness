'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;
const GC = require('./graph-cmd.js');

const FAKE_UV = path.join(__dirname, 'fixtures', 'fake-uv.sh');
const FAKE_GRAPHIFY = path.join(__dirname, 'fixtures', 'fake-graphify.sh');
const TEMPLATE = path.join(__dirname, '..', 'vault-template', '.graphifyignore');
const quiet = { log() {}, error() {} };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aos-graph-')); }
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
/** A config dir with agenticos.json, a vault, and a tool home — the three places install() touches. */
function world() {
  const dir = tmp();
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'brain'), { recursive: true });
  const configDir = path.join(dir, 'cfg');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ vault, graph: { enabled: true } }, null, 2));
  return { dir, vault, configDir, home: path.join(dir, 'share', 'agenticos', 'graphify'), uvLog: path.join(dir, 'uv.log') };
}
const cfgOf = (w) => JSON.parse(fs.readFileSync(path.join(w.configDir, 'agenticos.json'), 'utf8'));
/** A fake graphify that reports `version`, placed where install() would put it. */
function placeGraphify(home, version) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(FAKE_GRAPHIFY, path.join(bin, 'graphify'));
  fs.chmodSync(path.join(bin, 'graphify'), 0o755);
  fs.writeFileSync(path.join(bin, '.fake-graphify-version'), `${version}\n`);
  return path.join(bin, 'graphify');
}

test('uvBin: AOS_UV_BIN empty means absent, a missing path is absent, an existing path is used', () => {
  withEnv({ AOS_UV_BIN: '' }, () => assert.equal(GC.uvBin(), null));
  withEnv({ AOS_UV_BIN: path.join(os.tmpdir(), `no-uv-${process.pid}`) }, () => assert.equal(GC.uvBin(), null));
  withEnv({ AOS_UV_BIN: FAKE_UV }, () => assert.equal(GC.uvBin(), FAKE_UV));
});

test('the tool dir lives under XDG_DATA_HOME (else ~/.local/share), in agenticos/graphify', () => {
  withEnv({ XDG_DATA_HOME: '/x/data' }, () => assert.equal(GC.toolHome(), path.join('/x/data', 'agenticos', 'graphify')));
  withEnv({ XDG_DATA_HOME: undefined }, () => assert.equal(GC.toolHome(), path.join(os.homedir(), '.local', 'share', 'agenticos', 'graphify')));
  assert.deepEqual(GC.toolDirs('/h'), { home: '/h', tools: path.join('/h', 'tools'), bin: path.join('/h', 'bin'), graphify: path.join('/h', 'bin', 'graphify') });
});

test('install: a fresh machine gets the pin through uv into our own tool dirs, recorded as graph.bin', () => {
  const w = world();
  const r = withEnv({ FAKE_UV_LOG: w.uvLog }, () => GC.install({ vault: w.vault, configDir: w.configDir, uv: FAKE_UV, template: TEMPLATE, io: quiet, home: w.home }));
  assert.equal(r.action, `installed ${GC.PIN}`);
  assert.equal(r.bin, path.join(w.home, 'bin', 'graphify'));
  assert.equal(fs.readFileSync(w.uvLog, 'utf8'), `tool install --python >=3.10 graphifyy==${GC.PIN}\n`);
  assert.deepEqual(cfgOf(w).graph, { enabled: true, bin: r.bin });
  assert.equal(GC.installedVersion(r.bin), GC.PIN);
  assert.ok(r.seeded && fs.existsSync(path.join(w.vault, '.graphifyignore')));

  // At the pin: no uv call at all, and uv is not even needed.
  fs.writeFileSync(w.uvLog, '');
  const again = GC.install({ vault: w.vault, configDir: w.configDir, uv: null, template: TEMPLATE, io: quiet, home: w.home });
  assert.equal(again.action, `kept ${GC.PIN}`);
  assert.equal(fs.readFileSync(w.uvLog, 'utf8'), '');
  assert.equal(again.seeded, false, 'an existing .graphifyignore is the owner\'s');
});

test('install: a drifted version is reinstalled with --reinstall', () => {
  const w = world();
  placeGraphify(w.home, '0.9.1');
  fs.mkdirSync(path.join(w.home, 'tools'), { recursive: true });
  const r = withEnv({ FAKE_UV_LOG: w.uvLog }, () => GC.install({ vault: w.vault, configDir: w.configDir, uv: FAKE_UV, io: quiet, home: w.home }));
  assert.equal(r.action, `updated 0.9.1 → ${GC.PIN}`);
  assert.equal(fs.readFileSync(w.uvLog, 'utf8'), `tool install --python >=3.10 --reinstall graphifyy==${GC.PIN}\n`);
});

test('install refuses without uv, on a failed uv run, and when the result is not the pin — recording nothing', () => {
  const w = world();
  assert.throws(() => GC.install({ vault: w.vault, configDir: w.configDir, uv: null, io: quiet, home: w.home }), new RegExp(`uv not found .*graphify ${GC.PIN.replace(/\./g, '\\.')} is not installed`));
  withEnv({ FAKE_UV_FAIL: '1' }, () => assert.throws(() => GC.install({ vault: w.vault, configDir: w.configDir, uv: FAKE_UV, io: quiet, home: w.home }), /uv tool install graphifyy==.* failed: error: fake uv install failure/));
  withEnv({ FAKE_UV_INSTALLS_VERSION: '0.0.1' }, () => assert.throws(() => GC.install({ vault: w.vault, configDir: w.configDir, uv: FAKE_UV, io: quiet, home: w.home }), /reports 0\.0\.1 after the install, expected/));
  assert.deepEqual(cfgOf(w).graph, { enabled: true }, 'graph.bin is never recorded for a failed install');
});

test('ensureGitignore appends only the missing graph rules, once, and never creates a .gitignore', () => {
  const w = world();
  const g = { out: 'brain/graphify-out' };
  assert.deepEqual(GC.ensureGitignore(w.vault, g), [], 'no .gitignore: not ours to create');
  assert.ok(!fs.existsSync(path.join(w.vault, '.gitignore')));
  fs.writeFileSync(path.join(w.vault, '.gitignore'), '**/graphify-out/\nbrain/graphify-out/');   // no trailing newline
  assert.deepEqual(GC.ensureGitignore(w.vault, g), ['brain/graphify-out.pre-aos/']);
  assert.equal(fs.readFileSync(path.join(w.vault, '.gitignore'), 'utf8'),
    '**/graphify-out/\nbrain/graphify-out/\n# the vault knowledge graph (aos graph) is a derived cache, rebuilt from the notes\nbrain/graphify-out.pre-aos/\n');
  assert.deepEqual(GC.ensureGitignore(w.vault, g), [], 'idempotent');
  assert.deepEqual(GC.ensureGitignore(w.vault, { out: 'graph' }), ['graph/', 'graph.pre-aos/'], 'follows graph.out');
});

test('moveAside: a graph without our marker is renamed once; a marked graph and an empty dir stay', () => {
  const w = world();
  const g = { out: 'brain/graphify-out' };
  const out = path.join(w.vault, 'brain', 'graphify-out');
  assert.equal(GC.moveAside(w.vault, g), null, 'nothing there');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, GC.MARKER), '{}');
  fs.writeFileSync(path.join(out, 'graph.json'), '{"nodes":[]}');
  assert.equal(GC.moveAside(w.vault, g), null, 'ours');
  fs.rmSync(path.join(out, GC.MARKER));
  assert.equal(GC.moveAside(w.vault, g), `${out}.pre-aos`);
  assert.ok(fs.existsSync(path.join(`${out}.pre-aos`, 'graph.json')));
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'graph.json'), '{"nodes":[]}');
  assert.match(GC.moveAside(w.vault, g), /graphify-out\.pre-aos-\d+$/, 'never overwrites an earlier move');
});

test('doctorRows: missing binary fails, drift warns, marker age decides freshness, off is info', () => {
  const w = world();
  const now = Date.parse('2026-09-23T12:00:00Z');
  let rows = GC.doctorRows({ cfg: { graph: {} }, vault: w.vault, now });
  assert.deepEqual(rows[0], { name: `graphify ${GC.PIN}`, ok: false, detail: 'not installed — run aos upgrade', level: 'fail' });
  assert.deepEqual(rows[1], { name: 'graph fresh', ok: false, detail: 'no graph yet — run aos graph build', level: 'warn' });

  const bin = placeGraphify(w.home, '0.9.1');
  rows = GC.doctorRows({ cfg: { graph: { bin } }, vault: w.vault, now });
  assert.deepEqual(rows[0], { name: `graphify ${GC.PIN}`, ok: false, detail: `installed 0.9.1, pinned ${GC.PIN} — run aos upgrade`, level: 'warn' });

  fs.writeFileSync(path.join(w.home, 'bin', '.fake-graphify-version'), `${GC.PIN}\n`);
  const out = path.join(w.vault, 'brain', 'graphify-out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, GC.MARKER), JSON.stringify({ lastStructural: '2026-09-23T09:00:00Z', nodes: 5, edges: 4 }));
  rows = GC.doctorRows({ cfg: { graph: { bin } }, vault: w.vault, now });
  assert.equal(rows[0].ok, true);
  assert.deepEqual(rows[1], { name: 'graph fresh', ok: true, detail: 'built 3h ago · 5 nodes · 4 edges', level: 'warn' });

  fs.writeFileSync(path.join(out, GC.MARKER), JSON.stringify({ lastStructural: '2026-09-01T12:00:00Z', nodes: 5, edges: 4 }));
  rows = GC.doctorRows({ cfg: { graph: { bin } }, vault: w.vault, now });
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].detail, /built 22d ago .* older than 7 days, run aos graph build$/);

  rows = GC.doctorRows({ cfg: { graph: { bin, enabled: false } }, vault: w.vault, now });
  assert.deepEqual(rows[1], { name: 'graph fresh', ok: false, detail: 'graph off (aos graph on)', level: 'info' });
});

test('removeTools removes only a …/agenticos/graphify dir', () => {
  const w = world();
  fs.mkdirSync(w.home, { recursive: true });
  assert.equal(GC.removeTools(path.join(w.dir, 'share')), null, 'not ours');
  assert.ok(fs.existsSync(w.home));
  assert.equal(GC.removeTools(w.home), w.home);
  assert.ok(!fs.existsSync(w.home));
  assert.equal(GC.removeTools(w.home), null, 'already gone');
});

test('run: usage is exit 2; without a config it is exit 1; on/off write graph.enabled', async () => {
  const w = world();
  const errs = [];
  const io = { log() {}, error: (m) => errs.push(m) };
  assert.equal(await GC.run(['frobnicate'], { configDir: w.configDir, io }), 2);
  assert.equal(await GC.run(['on', 'extra'], { configDir: w.configDir, io }), 2);
  assert.equal(await GC.run(['status'], { configDir: path.join(w.dir, 'nowhere'), io }), 1);
  assert.match(errs.pop(), /no agenticos\.json .* \(run `aos init` first\)/);
  assert.equal(await GC.run(['off'], { configDir: w.configDir, io }), 0);
  assert.equal(cfgOf(w).graph.enabled, false);
  assert.equal(await GC.run(['on'], { configDir: w.configDir, io }), 0);
  assert.equal(cfgOf(w).graph.enabled, true);
});

// ── semantic pass (D5, D10, D11) ──────────────────────────────────────────────
test('graphConfig deep-merges graph.semantic and reads the provider by config precedence', () => {
  const w = world();
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'), JSON.stringify({ provider: 'ollama', graph: { semantic: { perDayUsd: 2 } } }));
  const g = GC.graphConfig({ vault: w.vault, userCfg: { graph: { semantic: { enabled: false } } } });
  assert.equal(g.semantic.enabled, false);
  assert.equal(g.semantic.perDayUsd, 2, 'a nested user key never wipes the rest of graph.semantic');
  assert.equal(g.semantic.everyHours, 24, 'defaults fill in');
  assert.equal(g.provider, 'ollama');
  assert.equal(GC.graphConfig({ vault: w.vault, userCfg: { provider: 'claude' } }).provider, 'claude', 'agenticos.json wins');
});

test('semanticState: auto follows the provider, true and false override it', () => {
  const st = (enabled, provider) => GC.semanticState({ semantic: { enabled }, provider });
  assert.equal(st('auto', 'auto').on, true);
  assert.equal(st('auto', 'claude').on, true);
  assert.match(st('auto', 'none').why, /^off under provider none/);
  assert.match(st('auto', 'local').why, /^off under provider local/);
  assert.equal(st('auto', 'ollama').on, false);
  assert.equal(st(true, 'none').on, true);
  assert.equal(st(false, 'claude').on, false);
});

test('aos graph semantic on|off|auto writes graph.semantic.enabled; anything else is usage', async () => {
  const w = world();
  const io = { log() {}, error() {} };
  assert.equal(await GC.run(['semantic', 'on'], { configDir: w.configDir, io }), 0);
  assert.equal(cfgOf(w).graph.semantic.enabled, true);
  assert.equal(await GC.run(['semantic', 'off'], { configDir: w.configDir, io }), 0);
  assert.equal(cfgOf(w).graph.semantic.enabled, false);
  assert.equal(await GC.run(['semantic', 'auto'], { configDir: w.configDir, io }), 0);
  assert.equal(cfgOf(w).graph.semantic.enabled, 'auto');
  assert.equal(cfgOf(w).graph.enabled, true, 'the structural switch is untouched');
  assert.equal(await GC.run(['semantic', 'sometimes'], { configDir: w.configDir, io }), 2);
  assert.equal(await GC.run(['semantic'], { configDir: w.configDir, io }), 2);
  assert.equal(await GC.run(['status'], { configDir: w.configDir, io, semantic: true }), 2, '--semantic belongs to build only');
});

test('the graph semantic doctor row: off, not yet run, failed, and ok with concepts and today\'s spend', () => {
  const w = world();
  const bin = placeGraphify(w.home, GC.PIN);
  const out = path.join(w.vault, 'brain', 'graphify-out');
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(w.vault, 'brain', '_index'), { recursive: true });
  const now = Date.parse('2026-09-23T12:00:00Z');
  const marker = (m) => fs.writeFileSync(path.join(out, GC.MARKER), JSON.stringify({ lastStructural: '2026-09-23T11:00:00Z', nodes: 5, edges: 4, ...m }));
  const CLAUDE = { host: 'claude', bin: '/x/claude' };
  // provider auto unless a case names one: 2.0's default `local` turns the pass off (local-first A1), and these cases are about it running.
  const row = (cfg, runner = CLAUDE) => GC.doctorRows({ cfg: { graph: { bin }, provider: 'auto', ...cfg }, vault: w.vault, now, runner }).find((r) => r.name === 'graph semantic');
  marker({});
  assert.deepEqual(row({ provider: 'none' }), { name: 'graph semantic', ok: false, detail: 'off under provider none (aos graph semantic on overrides)', level: 'info' });
  assert.match(row({}).detail, /^not run yet — the next scan starts it \(every 24 h, today \$0\.00 of \$1\)$/);
  assert.match(row({}, { host: 'codex', bin: '/x/codex' }).detail, /today \$0\.00 of \$1 · via codex\)$/);
  assert.deepEqual(row({}, null), { name: 'graph semantic', ok: false, detail: 'needs the claude or codex CLI (the model pass runs through one of them)', level: 'info' });
  marker({ lastSemanticRun: '2026-09-23T09:00:00Z', lastSemanticError: 'graphify extract exited 2: x' });
  assert.deepEqual(row({}), { name: 'graph semantic', ok: false, detail: 'last run failed: graphify extract exited 2: x — aos graph build --semantic', level: 'warn' });
  marker({ lastSemanticRun: '2026-09-23T09:00:00Z', lastSemantic: '2026-09-23T09:05:00Z', concepts: 40, semanticIncomplete: true });
  fs.writeFileSync(path.join(w.vault, 'brain', '_index', 'provider-spend.jsonl'),
    JSON.stringify({ ts: new Date(now).toISOString(), feature: 'graph:semantic', usd: 0.25 }) + '\n' + JSON.stringify({ ts: new Date(now).toISOString(), feature: 'auto-wrap', usd: 0.4 }) + '\n');
  const ok = row({});
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, 'last run 3h ago (partial; the rest follows on the next runs) · 40 concepts · today $0.25 of $1');
  assert.equal(GC.graphSpendToday(w.vault, new Date(now)), 0.25);
});

test('build --semantic refuses a provider opt-out, needs --yes off a terminal, and a "no" runs nothing', async () => {
  const w = world();
  const errs = [];
  const logs = [];
  const io = { log: (m) => logs.push(m), error: (m) => errs.push(m) };
  const c = cfgOf(w);
  fs.writeFileSync(path.join(w.configDir, 'agenticos.json'), JSON.stringify({ ...c, provider: 'none' }));
  assert.equal(await GC.run(['build'], { configDir: w.configDir, io, semantic: true, yes: true }), 1);
  assert.match(errs.pop(), /sends note text to a hosted model \(Claude or Codex\) on your login, and provider is none — `aos graph semantic on` allows it anyway/);
  fs.writeFileSync(path.join(w.configDir, 'agenticos.json'), JSON.stringify({ ...c, provider: 'claude' }));
  const runner = { host: 'claude', bin: '/x/claude' };
  assert.equal(await GC.run(['build'], { configDir: w.configDir, io, semantic: true, isTTY: false, runner: null }), 1);
  assert.match(errs.pop(), /needs the claude or codex CLI/);
  assert.equal(await GC.run(['build'], { configDir: w.configDir, io, semantic: true, isTTY: false, runner }), 1);
  assert.match(errs.pop(), /pass --yes/);
  assert.equal(await GC.run(['build'], { configDir: w.configDir, io, semantic: true, isTTY: true, ask: async () => false, runner }), 0);
  assert.equal(logs.pop(), 'graph: not run');
  assert.match(logs.join('\n'), /notes' text to Claude \(haiku, on your login\)/);
  await GC.run(['build'], { configDir: w.configDir, io, semantic: true, isTTY: true, ask: async () => false, runner: { host: 'codex', bin: '/x/codex' } });
  assert.match(logs.join('\n'), /notes' text to Codex \(your Codex default model, on your login\)/);
  assert.match(logs.join('\n'), /today \$0\.0000 of the \$1 graph budget/);
});

test('while a semantic pass holds the graph lock, doctor and status say it is running (not a finished run)', async () => {
  const w = world();
  const bin = placeGraphify(w.home, GC.PIN);
  const out = path.join(w.vault, 'brain', 'graphify-out');
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(w.vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(out, GC.MARKER), JSON.stringify({ lastStructural: new Date().toISOString(), nodes: 5, edges: 4, lastSemanticRun: new Date().toISOString() }));
  const lock = path.join(w.vault, 'brain', '_index', '.graph.lock.json');
  const startedAt = new Date(Date.now() - 8 * 60_000).toISOString();
  fs.writeFileSync(lock, JSON.stringify({ schema: 1, mode: 'semantic', pid: process.pid, startedAt, until: new Date(Date.now() + 60_000).toISOString() }));
  const hm = new Date(startedAt).toTimeString().slice(0, 5);
  const row = GC.doctorRows({ cfg: { graph: { bin }, provider: 'auto' }, vault: w.vault }).find((r) => r.name === 'graph semantic');
  assert.deepEqual(row, { name: 'graph semantic', ok: true, detail: `running since ${hm} · today $0.00 of $1`, level: 'warn' });
  const logs = [];
  fs.writeFileSync(path.join(w.configDir, 'agenticos.json'), JSON.stringify({ vault: w.vault, provider: 'auto', graph: { bin } }));
  assert.equal(await GC.run(['status'], { configDir: w.configDir, io: { log: (m) => logs.push(m), error() {} } }), 0);
  assert.match(logs.join('\n'), new RegExp(`^semantic   on \\(every 24 h, auto\\) · running since ${hm} · never run`, 'm'));
  fs.writeFileSync(lock, JSON.stringify({ schema: 1, mode: 'semantic', pid: process.pid, startedAt, until: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(GC.semanticRunning(w.vault), null, 'past its deadline it is not running');
});
