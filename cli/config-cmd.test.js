'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./config-cmd.js');
const DEFAULTS = require('../brain/scripts/config.default.json');

const NOW = new Date('2026-09-24T12:00:00.000Z');

/** A vault seeded like `aos init` leaves it: the full default brain/config.json, and the keys init writes in agenticos.json. */
function world({ machine = {}, vaultCfg = DEFAULTS, persona = true, obsidian = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-config-cli-'));
  const configDir = path.join(base, 'cfg');
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  if (persona) fs.mkdirSync(path.join(vault, 'persona'));
  if (obsidian) fs.mkdirSync(path.join(vault, '.obsidian'));
  const machineFile = path.join(configDir, 'agenticos.json');
  fs.writeFileSync(machineFile, `${JSON.stringify({
    version: '0.16.0', vault, node: process.execPath, provider: 'auto',
    claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 }, telemetry: { enabled: true, redact: true, retentionDays: 30 },
    cost: { enabled: false }, persona: { enabled: true }, graph: { enabled: true },
    hosts: { claude: { enabled: true }, codex: { enabled: false } }, ...machine,
  }, null, 2)}\n`);
  const vaultFile = path.join(vault, 'brain', 'config.json');
  if (vaultCfg) fs.writeFileSync(vaultFile, JSON.stringify(vaultCfg, null, 2));
  const logs = []; const errs = [];
  const io = { log: (m) => logs.push(String(m)), error: (m) => errs.push(String(m)) };
  const calls = [];
  const costCmd = {
    enable: async (o) => { calls.push(['enable', o.yes]); const c = JSON.parse(fs.readFileSync(machineFile, 'utf8')); c.cost.enabled = true; fs.writeFileSync(machineFile, JSON.stringify(c)); o.io.log('cost: enabled (python3 3.12)'); },
    disable: (o) => { calls.push(['disable']); const c = JSON.parse(fs.readFileSync(machineFile, 'utf8')); c.cost.enabled = false; fs.writeFileSync(machineFile, JSON.stringify(c)); o.io.log('cost: disabled'); },
  };
  const opts = { configDir, io, now: NOW, env: { CODEX_HOME: path.join(base, 'codex') }, costCmd };
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  return {
    base, vault, configDir, machineFile, vaultFile, opts, logs, errs, calls,
    machine: () => read(machineFile), vaultJson: () => read(vaultFile),
    out: () => logs.join('\n'), reset: () => { logs.length = 0; errs.length = 0; },
    run: (...argv) => C.main(argv, opts),
  };
}

test('list: every setting by section, its source file, * on a changed value, read-only machine keys', async () => {
  const w = world({ machine: { provider: 'claude' } });
  assert.equal(await w.run('list'), 0);
  const out = w.out();
  assert.match(out, /^agenticos\.json {5}.*agenticos\.json$/m);
  assert.match(out, /^Provider & models$/m);
  assert.match(out, /\* provider\s+claude\s+agenticos\.json$/m);
  assert.match(out, / {2}codex\.effort\s+low\s+brain\/config\.json$/m);
  assert.match(out, /^Hosts & install$/m);
  assert.match(out, /vault\s+\S+vault\s+agenticos\.json \(read-only\)$/m);
  assert.match(out, /hosts\.codex\.home\s+—\s+— \(read-only\)$/m, 'a machine key not in the file');
});

test('list --json: schema 1, the files, the sections and one row per setting with value, source and default', async () => {
  const w = world();
  await w.run('list', '--json');
  const j = JSON.parse(w.out());
  assert.equal(j.schema, 1);
  assert.deepEqual(j.files, { machine: w.machineFile, vault: w.vaultFile });
  assert.ok(j.sections.some((s) => s.id === 'spend'));
  const row = j.settings.find((r) => r.key === 'claude.perDayUsd');
  assert.deepEqual(
    { value: row.value, source: row.source, default: row.default, min: row.min, risk: row.risk, changed: row.changed, readonly: row.readonly },
    { value: 0.5, source: 'machine', default: 0.5, min: 0, risk: 'spend', changed: false, readonly: false });
  assert.equal(j.settings.length, 128);
});

test('get: the value alone (JSON for non-strings), --json the row; an unknown key or a group is a BadValue with a hint', async () => {
  const w = world();
  await w.run('get', 'provider'); await w.run('get', 'graph.semantic.enabled'); await w.run('get', 'recallRoots');
  assert.deepEqual(w.logs, ['auto', 'auto', JSON.stringify(DEFAULTS.recallRoots)]);
  w.reset();
  await w.run('get', 'codex.model', '--json');
  assert.equal(JSON.parse(w.out()).source, 'vault');
  w.reset();
  assert.equal(await w.run('get', 'telemetry.enabeld'), 2);
  assert.match(w.errs[0], /unknown setting "telemetry\.enabeld" \(did you mean telemetry\.enabled\?\)/);
  assert.equal(await w.run('get', 'ollama'), 2);
  assert.match(w.errs[1], /ollama is a group; name one of: ollama\.host, ollama\.port/);
});

test('set (D4): writes the file that holds the key — agenticos.json for init\'s keys, brain/config.json otherwise', async () => {
  const w = world();
  assert.equal(await w.run('set', 'telemetry.enabled', 'off'), 0);
  assert.equal(w.machine().telemetry.enabled, false);
  assert.equal(w.vaultJson().telemetry.enabled, true, 'the vault copy is left alone: agenticos.json wins');
  assert.match(w.logs[0], /^telemetry\.enabled: true → false {2}\(agenticos\.json\)$/);
  await w.run('set', 'codex.perDayUsd', '0');
  assert.equal(w.vaultJson().codex.perDayUsd, 0, 'a 0 daily cap is accepted (D10)');
  assert.equal(w.machine().codex, undefined);
  const machineText = fs.readFileSync(w.machineFile, 'utf8');
  assert.match(machineText, /^ {2}"vault": ".*",$/m, 'still one key per line for the launcher');
  assert.deepEqual(fs.readdirSync(w.configDir), ['agenticos.json'], 'no tmp file left');
});

test('set: a key in neither file goes to the vault file; a vaultOnly key always does, and leaves .obsidian/ alone', async () => {
  const w = world({ vaultCfg: { provider: 'none' }, machine: { dailyNote: { layout: 'ignored/{dd}.md' } } });
  // The Workbench is the app now (workbench-app D1): an Obsidian folder left in the vault is the user's, never rewritten.
  const obsidianDaily = path.join(w.vault, '.obsidian', 'daily-notes.json');
  fs.writeFileSync(obsidianDaily, JSON.stringify({ template: 'Templates/Day', folder: 'old' }));
  await w.run('set', 'graph.semantic.enabled', 'false');
  assert.deepEqual(w.vaultJson().graph, { semantic: { enabled: false } });
  await w.run('set', 'dailyNote.layout', 'Journal/{yyyy}-{MM}-{dd}.md');
  assert.equal(w.vaultJson().dailyNote.layout, 'Journal/{yyyy}-{MM}-{dd}.md');
  assert.equal(w.machine().dailyNote.layout, 'ignored/{dd}.md', 'agenticos.json is not the file its reader uses');
  assert.deepEqual(JSON.parse(fs.readFileSync(obsidianDaily, 'utf8')), { template: 'Templates/Day', folder: 'old' }, 'untouched');
  assert.doesNotMatch(w.out(), /Obsidian|daily-notes/);
});

test('set provider clears the cached probe; persona.enabled moves persona/DISABLED with it (D7, D8)', async () => {
  const w = world();
  const state = path.join(w.vault, 'brain', '_index', 'provider-state.json');
  fs.writeFileSync(state, '{"name":"claude"}');
  await w.run('set', 'provider', 'none');
  assert.equal(fs.existsSync(state), false);
  assert.match(w.out(), /cleared the cached provider probe/);
  const flag = path.join(w.vault, 'persona', 'DISABLED');
  await w.run('set', 'persona.enabled', 'false');
  assert.equal(w.machine().persona.enabled, false);
  assert.match(fs.readFileSync(flag, 'utf8'), /^disabled 2026-09-24T12:00:00\.000Z by aos config$/m);
  await w.run('set', 'persona.enabled', 'true');
  assert.equal(fs.existsSync(flag), false);
  assert.match(w.out(), /resumed scheduled duties/);
});

test('list notes duties paused by `aos persona off` while persona.enabled is true', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.vault, 'persona', 'DISABLED'), 'disabled\n');
  await w.run('list');
  assert.match(w.out(), /^note: persona\.enabled: scheduled duties are paused/m);
});

test('persona.enabled false with no persona folder writes the key only', async () => {
  const w = world({ persona: false });
  await w.run('set', 'persona.enabled', 'false');
  assert.equal(fs.existsSync(path.join(w.vault, 'persona')), false);
});

test('set cost.enabled hands off to cost-cmd enable --yes / disable (D7)', async () => {
  const w = world();
  await w.run('set', 'cost.enabled', 'true');
  assert.deepEqual(w.calls, [['enable', true]]);
  assert.equal(w.machine().cost.enabled, true);
  assert.match(w.out(), /cost\.enabled: false → true {2}\(agenticos\.json\)\n {2}cost: enabled/);
  await w.run('set', 'cost.enabled', 'false');
  assert.deepEqual(w.calls[1], ['disable']);
  w.reset();
  await w.run('set', 'cost.enabled', 'true', '--dry-run');
  assert.equal(w.calls.length, 2, 'a dry run delegates nothing');
  assert.match(w.out(), /would run `aos cost enable --yes`/);
});

test('followUps: claude.model and the sharing keys print next: lines; --json returns them', async () => {
  const w = world();
  await w.run('set', 'claude.model', 'sonnet');
  assert.match(w.out(), /^next: aos routines sync \(the schedules carry the duty model\)$/m);
  w.reset();
  await w.run('set', 'skills.exclude', '["deploy"]', '--json');
  const j = JSON.parse(w.out());
  assert.deepEqual(j.value, ['deploy']);
  assert.deepEqual(j.followUps.map((f) => f.command), ['aos skills sync']);
  assert.equal(j.file, w.vaultFile);
});

test('--dry-run writes nothing and runs no side effect', async () => {
  const w = world();
  const state = path.join(w.vault, 'brain', '_index', 'provider-state.json');
  fs.writeFileSync(state, '{}');
  const before = [fs.readFileSync(w.machineFile, 'utf8'), fs.readFileSync(w.vaultFile, 'utf8')];
  await w.run('set', 'provider', 'none', '--dry-run');
  await w.run('unset', 'claude.model', '--dry-run');
  assert.deepEqual([fs.readFileSync(w.machineFile, 'utf8'), fs.readFileSync(w.vaultFile, 'utf8')], before);
  assert.equal(fs.existsSync(state), true);
  assert.match(w.logs[0], /^\(dry run\) provider: auto → none {2}\(would write agenticos\.json\)$/);
  assert.match(w.out(), /would remove it from agenticos\.json and brain\/config\.json/);
});

test('unset removes the key from both files and prunes; the default applies; nothing to remove says so', async () => {
  const w = world({ machine: { graph: { enabled: true, semantic: { enabled: false } } } });
  await w.run('unset', 'graph.semantic.enabled');
  assert.deepEqual(w.machine().graph, { enabled: true }, 'the emptied semantic object is pruned');
  assert.equal(w.vaultJson().graph.semantic.enabled, undefined);
  assert.match(w.logs[0], /^graph\.semantic\.enabled: false → auto$/);
  w.reset();
  await w.run('unset', 'graph.semantic.enabled');
  assert.equal(w.logs[0], 'graph.semantic.enabled is not set in either file; the default applies: auto');
});

test('refusals: a read-only key (D6) and a headless run (D9) throw Refused; reads still work headless', async () => {
  const w = world();
  await assert.rejects(() => w.run('set', 'hosts.codex.enabled', 'true'), (e) => e instanceof C.Refused && /aos init --host codex\|both/.test(e.message));
  await assert.rejects(() => w.run('unset', 'vault'), C.Refused);
  w.opts.env = { AOS_HEADLESS: '1' };
  await assert.rejects(() => w.run('set', 'telemetry.redact', 'false'), (e) => e instanceof C.Refused && /headless run/.test(e.message));
  await assert.rejects(() => w.run('unset', 'dailyNote.layout'), C.Refused);
  assert.equal(await w.run('get', 'telemetry.redact'), 0);
  assert.equal(w.machine().telemetry.redact, true);
});

test('bad values exit 2 with the reason; usage mistakes throw UsageError', async () => {
  const w = world();
  assert.equal(await w.run('set', 'claude.perCallUsd', '0'), 2);
  assert.match(w.errs[0], /must be more than 0/);
  assert.equal(await w.run('set', 'provider', 'gpt'), 2);
  assert.equal(await w.run('set', 'recallRoots', 'brain/memory'), 2);
  assert.match(w.errs[2], /takes JSON/);
  await assert.rejects(() => w.run('set', 'provider'), C.UsageError);
  await assert.rejects(() => w.run('frobnicate'), C.UsageError);
  await assert.rejects(() => w.run('get', 'provider', 'extra'), /too many arguments/);
  await assert.rejects(() => w.run('list', '--dry-run'), /--dry-run is only supported/);
});

test('an unparseable config file is refused, never replaced', async () => {
  const w = world();
  fs.writeFileSync(w.vaultFile, '{"provider": ');
  await assert.rejects(() => w.run('set', 'codex.effort', 'high'), /not valid JSON.*nothing was written/);
  assert.equal(fs.readFileSync(w.vaultFile, 'utf8'), '{"provider": ');
});

test('no vault configured is a refusal that names aos init', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-config-none-'));
  await assert.rejects(() => C.main(['list'], { configDir, env: {}, io: { log() {}, error() {} } }), (e) => e instanceof C.Refused && /aos init/.test(e.message));
});

test('doctorRow (D12): info with the changed count; a warn naming unknown keys, bad values and unparseable files', () => {
  const w = world({ machine: { provider: 'claude' } });
  assert.deepEqual(C.doctorRow({ configDir: w.configDir, vault: w.vault, env: {} }),
    { name: 'config', ok: true, detail: '1 setting differs from the defaults — aos config list', level: 'info' });
  fs.writeFileSync(w.vaultFile, JSON.stringify({ telemetry: { enabeld: false }, scan: { fileMapBudget: -3 } }));
  const bad = C.doctorRow({ configDir: w.configDir, vault: w.vault, env: {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.level, 'warn');
  assert.match(bad.detail, /unknown in brain\/config\.json: telemetry\.enabeld; brain\/config\.json: scan\.fileMapBudget must be at least 0/);
  fs.writeFileSync(w.machineFile, '{');
  assert.match(C.doctorRow({ configDir: w.configDir, vault: w.vault, env: {} }).detail, /agenticos\.json does not parse/);
});

test('list --json (spec 2026-09-24-settings-tab D7, D8): host on host-specific rows, spentToday on daily caps from opts.spend', async () => {
  const w = world();
  w.opts.spend = () => ({ hooks: 0.12, duties: 1.9, reasoner: 0, routines: 0, graph: 0.25, crossReview: 0 });
  await w.run('list', '--json');
  const rows = Object.fromEntries(JSON.parse(w.out()).settings.map((r) => [r.key, r]));
  assert.equal(rows['claude.perDayUsd'].spentToday, 0.12);
  assert.equal(rows['codex.perDayUsd'].spentToday, 0.12, 'both hook caps govern the same hook total');
  assert.equal(rows['persona.perDayUsd'].spentToday, 1.9);
  assert.equal(rows['graph.semantic.perDayUsd'].spentToday, 0.25);
  assert.equal(rows['claude.perCallUsd'].spentToday, null, 'a per-call cap has no daily total');
  assert.equal(rows['codex.effort'].host, 'codex');
  assert.equal(rows['crossReview.claudeModel'].host, 'claude');
  assert.equal(rows.provider.host, null);
  w.reset();
  w.opts.spend = () => { throw new Error('ledger unreadable'); };
  await w.run('list', '--json');
  assert.equal(JSON.parse(w.out()).settings.find((r) => r.key === 'claude.perDayUsd').spentToday, null, 'a failed read is null, not an error');
});

test('list --json (spec 2026-09-24-settings-pickers D2, D4): choices, unit, pick and editIn reach the Workbench', async () => {
  const w = world();
  await w.run('list', '--json');
  const rows = Object.fromEntries(JSON.parse(w.out()).settings.map((r) => [r.key, r]));
  assert.equal(rows['persona.perDayUsd'].unit, 'usd');
  assert.ok(rows['persona.perDayUsd'].choices.includes(10));
  assert.equal(rows.recallRoots.pick, 'many');
  assert.equal(rows['skills.exclude'].editIn, 'skills');
  assert.equal(rows.quickLinks.editIn, 'file');
  assert.equal(rows['telemetry.enabled'].choices, null, 'a toggle has no presets');
  assert.equal(rows.vault.choices, null, 'install keys stay read-only');
});

test('Codex model pickers follow the local Codex catalog (models_cache.json), hidden models left out; no cache → the pricing list', async () => {
  const w = world();
  const codexHome = path.join(w.base, 'codex');
  const pick = async () => {
    w.reset();
    await w.run('list', '--json');
    return Object.fromEntries(JSON.parse(w.out()).settings.map((r) => [r.key, r.choices]));
  };
  const S = require('../brain/scripts/lib/settings-schema.js');
  assert.deepEqual((await pick())['codex.model'], S.CODEX_MODELS, 'no Codex cache: the pricing table');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ fetched_at: '2026-09-24T04:00:00Z', models: [
    { slug: 'gpt-6-sol', visibility: 'list' }, { slug: 'codex-auto-review', visibility: 'hide' }, { slug: 'gpt-5.6-terra', visibility: 'list' }, { slug: 'gpt-5.5' },
  ] }));
  const c = await pick();
  for (const k of ['codex.model', 'reasoner.codexModel', 'persona.codexModel', 'routines.codexModel', 'crossReview.codexModel']) {
    assert.deepEqual(c[k], ['gpt-6-sol', 'gpt-5.6-terra', 'gpt-5.5'], k);
  }
  assert.deepEqual(c['claude.model'], S.CLAUDE_MODELS, 'Claude rows are untouched');
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models": ');
  assert.deepEqual((await pick())['codex.model'], S.CODEX_MODELS, 'an unreadable cache falls back');
  w.reset();
  assert.equal(await w.run('set', 'codex.model', 'gpt-6-sol'), 0, 'any Codex model is still settable');
});
