'use strict';
// `aos migrate` (local-first A9, install-import B12): what an upgrade from before 2.0 records pending, local-first's apply
// with its backup (both config files, the Chief of Staff's models, the shipped tick.md only while untouched, the schedules
// re-rendered), decline and undo, the import's apply, and the upgrade's one question on a TTY (an injected terminal: the
// answer, or none asked when there is no TTY). Every effect is faked at its seam: no schedule, model or host is reached.
delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('./migrations.js');
const { CHIEF } = require('../brain/scripts/sdk/lib/models.js');

const ROOT = path.resolve(__dirname, '..');
const TICK_19 = fs.readFileSync(path.join(__dirname, 'fixtures', 'tick-1.9.md'), 'utf8');
const TICK_20 = fs.readFileSync(path.join(ROOT, 'vault-template', 'persona', 'routines', 'tick.md'), 'utf8');
const NOW = new Date('2026-10-15T12:00:00Z');

/** A 1.9 install as `aos upgrade` leaves it: agenticos.json as buildUserConfig wrote it, brain/config.json with the 1.9
 *  defaults materialized and what the Chief of Staff ran on pinned (pinPrevious: persona.failover false). */
function world({ tick = TICK_19, user = {}, vault = {} } = {}) {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-migrate-')));
  const cfgDir = path.join(T, 'cfg');
  const v = path.join(T, 'vault');
  for (const d of [cfgDir, path.join(v, 'brain', '_index'), path.join(v, 'brain', 'routines')]) fs.mkdirSync(d, { recursive: true });
  const cfgFile = path.join(cfgDir, 'agenticos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ version: '1.9.0', vault: v, provider: 'auto', claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 }, persona: { enabled: true }, ...user }, null, 2));
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'auto', persona: { enabled: true, runner: 'auto', model: null, codexModel: null, failover: false, perDayUsd: 6 }, ...vault }, null, 2));
  if (tick !== null) fs.writeFileSync(path.join(v, M.TICK_REL), tick);
  fs.writeFileSync(path.join(v, 'brain', '_index', 'provider-state.json'), '{"name":"claude"}\n');
  const calls = { installs: 0, notices: [] };
  const opts = {
    env: { CLAUDE_CONFIG_DIR: cfgDir }, configDir: cfgDir, now: NOW, io: { log: () => {} },
    isInstalled: () => true, installSchedules: () => { calls.installs++; return { labels: ['com.agenticos.tick'] }; },
    notify: (p) => { calls.notices.push(p); return true; },
  };
  const read = (rel) => fs.readFileSync(path.join(v, rel), 'utf8');
  return { T, v, cfgDir, cfgFile, opts, calls, read, user: () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')), vcfg: () => JSON.parse(read('brain/config.json')), state: () => M.readState(v) };
}
const io = () => { const lines = []; return { lines, log: (l) => lines.push(String(l)) }; };

test('the shipped tick hashes name the files releases before 2.0 put in brain/routines/', () => {
  assert.ok(M.SHIPPED_TICKS.includes(M.sha256(TICK_19)), 'the 1.9 tick.md');
  assert.ok(!M.SHIPPED_TICKS.includes(M.sha256(TICK_20)), 'never the 2.0 one');
  assert.match(TICK_20, /^kind: command$/m);
  assert.equal(M.shippedTick(), TICK_20);
});

test('flags: one action, --chief only with local-first --apply, no undo for import (usage errors)', () => {
  assert.deepEqual(M.parse([]), { id: null, action: 'status', json: false, chief: false, accept: null });
  assert.deepEqual(M.parse(['local-first', '--apply', '--chief', '--json']), { id: 'local-first', action: 'apply', json: true, chief: true, accept: null });
  assert.deepEqual(M.parse(['import', '--apply', '--accept', '["~/code/a"]']).accept, ['~/code/a']);
  for (const [argv, re] of [
    [['local-first', '--apply', '--decline'], /one or the other/], [['nope'], /no migration nope/], [['--apply'], /needs a migration/],
    [['local-first', '--chief'], /--chief goes with local-first --apply/], [['import', '--undo'], /no --undo/],
    [['local-first', '--accept', '[]', '--apply'], /--accept goes with import --apply/], [['local-first', '--bogus'], /unknown flag/],
    [['local-first', 'import'], /usage/],
  ]) assert.throws(() => M.parse(argv), re, argv.join(' '));
});

test('recordPending: an upgrade from before 2.0.0 records both once; from 2.0.0 none; an unreadable version counts as older', () => {
  const w = world();
  assert.deepEqual(M.recordPending({ vault: w.v, from: '1.9.0', now: NOW }), ['local-first', 'import']);
  assert.deepEqual(w.state().migrations.map((m) => [m.id, m.state, m.since, m.from]), [['local-first', 'pending', '2.0.0', '1.9.0'], ['import', 'pending', '2.0.0', '1.9.0']]);
  assert.deepEqual(M.recordPending({ vault: w.v, from: '1.9.0', now: NOW }), [], 'never one already recorded');
  M.decline(M.resolveCtx(w.opts), 'local-first');
  assert.deepEqual(M.recordPending({ vault: w.v, from: '1.8.0', now: NOW }), [], 'a declined one stays declined');
  const w2 = world();
  assert.deepEqual(M.recordPending({ vault: w2.v, from: '2.0.0', now: NOW }), []);
  assert.equal(fs.existsSync(path.join(w2.v, 'brain', '_index', 'migrations.json')), false, 'nothing to record, nothing written');
  assert.deepEqual(M.recordPending({ vault: w2.v, from: '2.1.3', now: NOW }), []);
  const w3 = world();
  assert.deepEqual(M.recordPending({ vault: w3.v, from: undefined, now: NOW }), ['local-first', 'import']);
});

test('pinPrevious: an upgrade from before 2.0.0 writes 1.9\'s value of each setting 2.0 would move, only where brain/config.json lacks it', () => {
  const w = world();
  const file = path.join(w.v, 'brain', 'config.json');
  const put = (j) => fs.writeFileSync(file, JSON.stringify(j, null, 2));
  assert.deepEqual(M.PRE_2_0, { provider: 'auto', 'persona.model': null, 'persona.codexModel': null, 'persona.failover': false });
  // As one 1.9.0 vault was found: no persona block, no provider.
  put({ claude: { model: 'haiku' }, persona: undefined });
  assert.deepEqual(M.pinPrevious({ vault: w.v, from: '1.9.0' }), ['provider', 'persona.model', 'persona.codexModel', 'persona.failover']);
  assert.deepEqual(w.vcfg(), { claude: { model: 'haiku' }, provider: 'auto', persona: { model: null, codexModel: null, failover: false } });
  assert.deepEqual(M.pinPrevious({ vault: w.v, from: '1.9.0' }), [], 'once pinned, nothing more');
  // 1.9's own materialized defaults and the owner's values are kept; only what the file lacks is written.
  put({ provider: 'ollama', persona: { enabled: true, model: 'sonnet', codexModel: null, effort: 'low' } });
  assert.deepEqual(M.pinPrevious({ vault: w.v, from: '1.8.2' }), ['persona.failover']);
  assert.deepEqual(w.vcfg(), { provider: 'ollama', persona: { enabled: true, model: 'sonnet', codexModel: null, effort: 'low', failover: false } });
  // From 2.0.0 on, nothing: a new install's defaults are its own.
  put({ persona: {} });
  for (const from of ['2.0.0', '2.1.0']) assert.deepEqual(M.pinPrevious({ vault: w.v, from }), []);
  assert.deepEqual(w.vcfg(), { persona: {} });
  // An unreadable version counts as older; a missing file is a 1.9 vault on its defaults.
  assert.equal(M.pinPrevious({ vault: w.v, from: undefined }).length, 4);
  fs.rmSync(file);
  assert.equal(M.pinPrevious({ vault: w.v, from: 'garbage' }).length, 4);
  assert.deepEqual(w.vcfg().persona, { model: null, codexModel: null, failover: false });
  // A file it cannot read is refused and left as it is.
  for (const bad of ['{ not json', '[1, 2]']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => M.pinPrevious({ vault: w.v, from: '1.9.0' }), (e) => e instanceof M.Refused && /refusing to touch/.test(e.message));
    assert.equal(fs.readFileSync(file, 'utf8'), bad);
  }
});

test('local-first --apply --chief: both files go local, the CoS models land, tick.md becomes 2.0, the schedules re-render', () => {
  const w = world();
  M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
  const userBefore = w.user();
  const r = M.applyLocalFirst(M.resolveCtx(w.opts), { chief: true }, w.opts);
  assert.equal(r.state, 'applied');
  const u = w.user();
  const vc = w.vcfg();
  assert.deepEqual([u.provider, u.ai], ['local', { chat: 'local', ask: 'local', reflectWeek: 'local', consolidate: 'local' }]);
  assert.deepEqual([vc.provider, vc.ai], ['local', { chat: 'local', ask: 'local', reflectWeek: 'local', consolidate: 'local' }]);
  assert.deepEqual([vc.persona.model, vc.persona.codexModel, vc.persona.failover], [CHIEF.claude, CHIEF.codex, true], 'A4: the models and the failover move together');
  assert.deepEqual([vc.persona.runner, vc.persona.perDayUsd], ['auto', 6], 'the rest of persona is kept');
  assert.equal(u.persona.model, undefined, 'agenticos.json named no CoS model, so brain/config.json carries it');
  assert.deepEqual([u.claude, u.version, u.vault], [userBefore.claude, '1.9.0', w.v], 'nothing else in agenticos.json moves');
  assert.equal(w.read(M.TICK_REL), TICK_20);
  assert.equal(r.tick, 'rewrite');
  assert.equal(w.calls.installs, 1);
  assert.equal(fs.existsSync(path.join(w.v, 'brain', '_index', 'provider-state.json')), false, 'the cached resolution is dropped');
  const e = w.state().migrations.find((m) => m.id === 'local-first');
  assert.deepEqual([e.state, e.chief, e.tick, e.backup], ['applied', true, 'rewrite', r.backup]);
  assert.match(r.backup, /^brain\/_index\/migrations\/local-first-2026-10-15T12-00-00-000Z\.json$/);
  const b = JSON.parse(w.read(r.backup));
  assert.deepEqual(b.files.user, {
    provider: { had: true, value: 'auto', set: 'local' }, 'ai.chat': { had: false, set: 'local' }, 'ai.ask': { had: false, set: 'local' },
    'ai.reflectWeek': { had: false, set: 'local' }, 'ai.consolidate': { had: false, set: 'local' },
  });
  assert.deepEqual(b.files.vault['persona.model'], { had: true, value: null, set: CHIEF.claude });
  assert.deepEqual(b.files.vault['persona.failover'], { had: true, value: false, set: true });
  assert.deepEqual(b.tick, { file: M.TICK_REL, before: TICK_19, after: TICK_20 });
  // Applied again: nothing more (no write, no re-render).
  const again = M.applyLocalFirst(M.resolveCtx(w.opts), { chief: true }, w.opts);
  assert.deepEqual([again.state, again.changed, again.backup], ['applied', [], r.backup]);
  assert.match(again.lines[0], /^already applied/);
  assert.equal(w.calls.installs, 1);
});

test('local-first --apply without --chief keeps the CoS models; agenticos.json gets them only where it names them', () => {
  const w = world();
  M.applyLocalFirst(M.resolveCtx(w.opts), { chief: false }, w.opts);
  assert.deepEqual([w.vcfg().persona.model, w.vcfg().persona.codexModel, w.vcfg().persona.failover], [null, null, false]);
  const w2 = world({ user: { persona: { enabled: true, model: 'sonnet', failover: false } } });
  M.applyLocalFirst(M.resolveCtx(w2.opts), { chief: true }, w2.opts);
  assert.equal(w2.user().persona.model, CHIEF.claude, 'the file that wins moves too');
  assert.equal(w2.user().persona.failover, true);
  assert.equal(w2.user().persona.codexModel, undefined);
});

test('an edited tick.md is kept and a notification says why; a missing one is left missing; a 2.0 one is current', () => {
  const edited = `${TICK_19}\nMy own note.\n`;
  const w = world({ tick: edited });
  const r = M.applyLocalFirst(M.resolveCtx(w.opts), { chief: true }, w.opts);
  assert.equal(r.tick, 'kept');
  assert.equal(w.read(M.TICK_REL), edited);
  assert.equal(w.calls.notices.length, 1);
  assert.equal(w.calls.notices[0].title, 'Your tick routine was kept as it is');
  assert.match(w.calls.notices[0].body, /never overwrites a routine you edited/);
  assert.match(w.calls.notices[0].body, /brain\/scripts\/persona\/templates\/routines\/tick\.md/);
  assert.equal(JSON.parse(w.read(r.backup)).tick, null);
  assert.equal(M.applyLocalFirst(M.resolveCtx(world({ tick: null }).opts), {}, world().opts).tick, 'missing');
  const cur = world({ tick: TICK_20 });
  assert.equal(M.applyLocalFirst(M.resolveCtx(cur.opts), {}, cur.opts).tick, 'current');
  assert.equal(cur.calls.notices.length, 0);
});

test('the notification goes to the Notifications tab when nothing stands in for it', () => {
  const w = world({ tick: 'kind: duty\n' });
  const { notify: _notify, ...opts } = w.opts;
  M.applyLocalFirst(M.resolveCtx(opts), { chief: true }, opts);
  const dir = path.join(w.v, 'brain', 'notifications', '2026');
  const items = fs.readdirSync(dir);
  assert.equal(items.length, 1);
  assert.match(fs.readFileSync(path.join(dir, items[0]), 'utf8'), /^from: "aos"$/m);
});

test('--undo puts every key back as it was, tick.md too while it is the one apply wrote; then nothing to undo', () => {
  const w = world();
  const userBefore = fs.readFileSync(w.cfgFile, 'utf8');
  const vaultBefore = w.read('brain/config.json');
  M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
  const ctx = M.resolveCtx(w.opts);
  M.applyLocalFirst(ctx, { chief: true }, w.opts);
  const u = M.undoLocalFirst(ctx, w.opts);
  assert.equal(u.state, 'undone');
  assert.deepEqual(w.user(), JSON.parse(userBefore), 'agenticos.json as it was: ai.* removed again');
  assert.deepEqual(w.vcfg(), JSON.parse(vaultBefore));
  assert.equal(w.read(M.TICK_REL), TICK_19);
  assert.equal(w.calls.installs, 2);
  assert.throws(() => M.undoLocalFirst(ctx, w.opts), /nothing to undo/);
  // Undone → applied again from Settings, then the tick edited by hand: undo leaves the edit.
  M.applyLocalFirst(ctx, { chief: true }, w.opts);
  fs.writeFileSync(path.join(w.v, M.TICK_REL), `${TICK_20}\nmine\n`);
  const again = M.undoLocalFirst(ctx, w.opts);
  assert.match(again.lines.join('\n'), /changed since going local, so it was left as it is/);
  assert.equal(w.read(M.TICK_REL), `${TICK_20}\nmine\n`);
});

test('--decline records the choice and changes nothing; a declined one can still be applied, an applied one not declined', () => {
  const w = world();
  M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
  const files = () => [fs.readFileSync(w.cfgFile, 'utf8'), w.read('brain/config.json'), w.read(M.TICK_REL)];
  const before = files();
  const ctx = M.resolveCtx(w.opts);
  assert.equal(M.decline(ctx, 'local-first').state, 'declined');
  assert.deepEqual(files(), before);
  assert.equal(w.calls.installs, 0);
  assert.equal(M.applyLocalFirst(ctx, { chief: false }, w.opts).state, 'applied');
  assert.throws(() => M.decline(ctx, 'local-first'), /--undo puts your settings back/);
});

test('import --apply runs the import from both hosts and records it; import --decline records only', async () => {
  const w = world();
  M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
  const seen = [];
  const importer = { KINDS: ['instructions', 'memories', 'projects', 'mcp', 'sessions'], runWith: async (args, o) => { seen.push({ args, vault: o.vault }); return { code: 0, report: { ok: true } }; } };
  const out = io();
  assert.equal(await M.main(['import', '--apply', '--accept', '["~/code/a"]', '--json'], { ...w.opts, io: out, importer }), 0);
  assert.deepEqual(seen, [{ args: { from: ['claude', 'codex'], since: '90d', only: importer.KINDS, accept: ['~/code/a'], dryRun: false, json: false }, vault: w.v }]);
  assert.deepEqual(JSON.parse(out.lines.join('\n')), { id: 'import', state: 'applied', report: { ok: true }, notes: [] });
  const w2 = world();
  assert.equal(await M.main(['import', '--decline'], { ...w2.opts, importer }), 0);
  assert.equal(w2.state().migrations[0].state, 'declined');
  assert.equal(M.settle(w2.v, 'import'), false, 'only a pending one settles');
});

test('status lists every migration, recorded or not', async () => {
  const w = world();
  let out = io();
  await M.main(['--status', '--json'], { ...w.opts, io: out });
  assert.deepEqual(JSON.parse(out.lines.join('\n')).migrations.map((m) => [m.id, m.state]), [['local-first', null], ['import', null]]);
  M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
  out = io();
  await M.main(['local-first'], { ...w.opts, io: out });
  assert.match(out.lines[0], /^local-first {2}pending {2}2026-10-15T12:00:00\.000Z$/);
});

test('the upgrade asks once on a TTY: Enter goes local with the CoS models, n keeps the settings, l leaves it pending', async () => {
  for (const [answer, state, ran] of [['', 'applied', 'apply'], ['y', 'applied', 'apply'], ['n', 'declined', 'decline'], ['l', 'pending', null]]) {
    const w = world();
    const added = M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
    const out = io();
    const asked = [];
    const r = await M.offer(added, { ...w.opts, io: out, isTTY: true, vault: w.v, ask: async (q) => { asked.push(q); return answer; } });
    assert.deepEqual([r.asked, r.ran], [true, ran], `answer ${JSON.stringify(answer)}`);
    assert.deepEqual(asked, ['Go local now? [Y]es / [n]o, keep my settings / [l]ater: ']);
    assert.equal(w.state().migrations.find((m) => m.id === 'local-first').state, state);
    if (state === 'applied') assert.equal(w.vcfg().persona.model, CHIEF.claude);
    // What stays pending is printed: the import always (B12), local-first after "later".
    assert.match(out.lines.join('\n'), /^ {2}aos import {2,}/m);
    assert.equal(/aos migrate local-first --apply --chief/.test(out.lines.join('\n')), state === 'pending');
  }
});

test('no TTY: nothing is asked, the commands are printed; a later upgrade that recorded nothing asks nothing', async () => {
  const w = world();
  const added = M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
  const out = io();
  const ask = async () => { throw new Error('must not ask'); };
  const r = await M.offer(added, { ...w.opts, io: out, isTTY: false, vault: w.v, ask });
  assert.equal(r.asked, false);
  const text = out.lines.join('\n');
  assert.match(text, /aos migrate local-first --apply --chief {3}go local, and move the Chief of Staff to claude-opus-5-5 \/ gpt-6-sol/);
  assert.match(text, /aos migrate local-first --decline {9}keep my settings/);
  assert.match(text, /^ {2}aos import /m);
  const later = await M.offer([], { ...w.opts, io: io(), isTTY: true, vault: w.v, ask });
  assert.equal(later.asked, false, 'asked once: only by the upgrade that recorded it');
});

test('through cli/aos.js: aos migrate local-first --apply --chief --json, refusals exit 1, bad flags exit 2', () => {
  const w = world();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: w.cfgDir, HOME: w.T };
  delete env.AOS_VAULT; delete env.AOS_CONFIG;
  // No schedules under this HOME: isInstalled finds none on either platform (no plists, an empty crontab stand-in).
  const fakeCrontab = path.join(w.T, 'crontab');
  fs.writeFileSync(fakeCrontab, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const aos = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'aos.js'), 'migrate', ...args], { encoding: 'utf8', env: { ...env, AOS_CRONTAB_BIN: fakeCrontab } });
  const r = aos('local-first', '--apply', '--chief', '--json');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.id, j.state, j.chief, j.tick], ['local-first', 'applied', true, 'rewrite']);
  assert.match(j.schedules, /no schedules installed/);
  assert.equal(w.vcfg().provider, 'local');
  const undo = aos('local-first', '--undo');
  assert.equal(undo.status, 0, undo.stderr);
  assert.match(undo.stdout, /^local-first: undone$/m);
  const refused = aos('local-first', '--undo');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /nothing to undo/);
  const bad = aos('local-first', '--apply', '--undo');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /one or the other/);
  assert.equal(aos('--dry-run').status, 2, '--dry-run is not a migrate flag');
});

// ── review fixes (PR 9 #141) ──────────────────────────────────────────────────
const entry = (w, id) => w.state().migrations.find((m) => m.id === id);
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('an apply stopped after its first write is resumed on the same backup; undo then puts back what was there before', { skip: asRoot && 'root ignores the read-only folder' }, () => {
  const w = world();
  M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
  const userBefore = w.user();
  const vaultBefore = w.vcfg();
  const ctx = M.resolveCtx(w.opts);
  const brain = path.join(w.v, 'brain');
  fs.chmodSync(brain, 0o555);   // brain/config.json cannot be replaced; agenticos.json (written first) can
  try { assert.throws(() => M.applyLocalFirst(ctx, { chief: true }, w.opts)); } finally { fs.chmodSync(brain, 0o755); }
  const stopped = entry(w, 'local-first');
  assert.equal(stopped.state, 'applying', 'recorded before the first write');
  assert.ok(stopped.backup);
  assert.equal(w.user().provider, 'local', 'half applied: the first file was written');
  const r = M.applyLocalFirst(ctx, { chief: true }, w.opts);
  assert.deepEqual([r.state, r.backup], ['applied', stopped.backup], 'a retry never takes a second snapshot');
  assert.equal(JSON.parse(w.read(r.backup)).files.user.provider.value, 'auto', 'the backup holds the value from before the first try');
  M.undoLocalFirst(ctx, w.opts);
  assert.deepEqual([w.user(), w.vcfg()], [userBefore, vaultBefore]);
});

test('declining an apply that stopped half way puts the settings back first, then records declined', { skip: asRoot && 'root ignores the read-only folder' }, () => {
  const w = world();
  M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
  const userBefore = w.user();
  const ctx = M.resolveCtx(w.opts);
  fs.chmodSync(path.join(w.v, 'brain'), 0o555);
  try { assert.throws(() => M.applyLocalFirst(ctx, { chief: true }, w.opts)); } finally { fs.chmodSync(path.join(w.v, 'brain'), 0o755); }
  const d = M.decline(ctx, 'local-first');
  assert.equal(d.state, 'declined');
  assert.deepEqual(w.user(), userBefore, 'nothing half-local is left behind a "keep my settings"');
});

test('applied, then the provider changed by hand: apply again puts back what no longer holds, on the first backup', () => {
  const w = world();
  const ctx = M.resolveCtx(w.opts);
  const first = M.applyLocalFirst(ctx, { chief: true }, w.opts);
  fs.writeFileSync(w.cfgFile, JSON.stringify({ ...w.user(), provider: 'ollama' }));
  const again = M.applyLocalFirst(ctx, { chief: true }, w.opts);
  assert.deepEqual([again.state, again.backup, again.changed], ['applied', first.backup, ['agenticos.json provider = local']]);
  assert.equal(w.user().provider, 'local');
  assert.deepEqual(M.applyLocalFirst(ctx, { chief: true }, w.opts).changed, [], 'nothing left to change');
  M.undoLocalFirst(ctx, w.opts);
  assert.equal(w.user().provider, 'auto', 'undo goes back to before the migration, not to the hand edit');
});

test('apply again with --chief after a plain apply adds the CoS keys to the backup, so undo restores them too', () => {
  const w = world();
  const ctx = M.resolveCtx(w.opts);
  M.applyLocalFirst(ctx, { chief: false }, w.opts);
  M.applyLocalFirst(ctx, { chief: true }, w.opts);
  assert.equal(w.vcfg().persona.model, CHIEF.claude);
  M.undoLocalFirst(ctx, w.opts);
  assert.deepEqual([w.vcfg().persona.model, w.vcfg().persona.codexModel], [null, null]);
});

test('undo restores only what still holds the value apply set; a later change is kept and named', () => {
  const w = world();
  const ctx = M.resolveCtx(w.opts);
  M.applyLocalFirst(ctx, { chief: true }, w.opts);
  fs.writeFileSync(path.join(w.v, 'brain', 'config.json'), JSON.stringify({ ...w.vcfg(), ai: { ...w.vcfg().ai, chat: 'host' } }));
  const u = M.undoLocalFirst(ctx, w.opts);
  assert.equal(w.vcfg().ai.chat, 'host', 'the later choice stays');
  assert.equal(w.vcfg().provider, 'auto');
  assert.deepEqual(u.kept, ['brain/config.json ai.chat (changed since going local)']);
});

test('a failed import is not recorded as applied, through aos migrate or a plain aos import', async () => {
  const w = world();
  M.recordPending({ vault: w.v, from: '1.9.0', now: NOW });
  const importer = { KINDS: ['instructions'], runWith: async () => ({ code: 1, report: {} }) };
  await assert.rejects(M.main(['import', '--apply'], { ...w.opts, importer }), /import stopped/);
  assert.equal(entry(w, 'import').state, 'pending');
  const I = require('./import.js');
  assert.equal(await I.main([], { env: { CLAUDE_CONFIG_DIR: w.cfgDir }, configDir: w.cfgDir, runWith: async () => ({ code: 1, report: {} }) }), 1);
  assert.equal(entry(w, 'import').state, 'pending');
});

// node-path D12: the interview rendered {{NODE}} into the duty files once, as the Node of that day; a versioned Homebrew
// path in them goes with the next `brew upgrade`, and run-duty.sh's allowlist (the schedule's Node) stops matching the
// command in the file. repairDutyNode puts the recorded Node in its place and leaves every other byte, the owner's edits
// included; a file without one is not written; staleDutyNodes is doctor's view of the same files.
test('repairDutyNode: only the versioned Cellar node changes in persona/duties/*.md; edits, bytes and other files stay; idempotent', () => {
  const w = world();
  const duties = path.join(w.v, 'persona', 'duties');
  fs.mkdirSync(duties, { recursive: true });
  const cellar = '/opt/homebrew/Cellar/node/25.1.0/bin/node';
  const other = '/usr/local/Cellar/node@22/22.20.0/bin/node';
  const stable = '/opt/homebrew/opt/node/bin/node';
  const vars = { NODE: cellar, VAULT: w.v, AGENT_NAME: 'Atlas', ADDRESS_AS: 'the owner' };
  const rendered = (name) => Object.entries(vars).reduce((t, [k, v]) => t.split(`{{${k}}}`).join(v), fs.readFileSync(path.join(ROOT, 'vault-template', 'persona', 'duties', name), 'utf8'));
  // tick.md as the interview rendered it, then edited by hand: a step added with the same path, a file beside the node
  // (not one), the stable link already there once, trailing spaces and a CRLF a re-render would lose.
  const tick = `${rendered('tick.md')}\n## Mine\n5. Then \`${cellar} ${w.v}/brain/scripts/persona/ledger.js summary --days 7\`.   \n6. Read ${cellar.replace(/bin\/node$/, 'README.md')} and \`${stable} --version\`.\r\n`;
  assert.ok(tick.includes(`\`${cellar} ${w.v}/brain/scripts/persona/tick.js signals\``), 'the template puts the Node where the duty runs it');
  const sitrep = rendered('sitrep.md').split(cellar).join(stable);     // already on the stable link
  const reflect = rendered('reflect.md').split(cellar).join(other);    // another formula, another prefix
  fs.writeFileSync(path.join(duties, 'tick.md'), tick);
  fs.writeFileSync(path.join(duties, 'sitrep.md'), sitrep);
  fs.writeFileSync(path.join(duties, 'reflect.md'), reflect);
  fs.writeFileSync(path.join(duties, 'notes.txt'), `${cellar}\n`);     // not a duty file
  const untouched = fs.statSync(path.join(duties, 'sitrep.md')).mtimeMs;
  const stale = [{ file: 'persona/duties/reflect.md', paths: [other] }, { file: 'persona/duties/tick.md', paths: [cellar] }];
  assert.deepEqual(M.staleDutyNodes(w.v), stale);
  assert.deepEqual(M.repairDutyNode({ vault: w.v, node: stable }), stale);
  assert.equal(w.read('persona/duties/tick.md'), tick.split(cellar).join(stable), 'that path wherever it is, every other byte kept');
  assert.equal(w.read('persona/duties/reflect.md'), reflect.split(other).join(stable));
  assert.equal(w.read('persona/duties/sitrep.md'), sitrep, 'unchanged');
  assert.equal(fs.statSync(path.join(duties, 'sitrep.md')).mtimeMs, untouched, 'not even rewritten');
  assert.equal(w.read('persona/duties/notes.txt'), `${cellar}\n`);
  assert.deepEqual(M.staleDutyNodes(w.v), []);
  assert.deepEqual(M.repairDutyNode({ vault: w.v, node: stable }), [], 'idempotent');
  assert.equal(w.read('persona/duties/tick.md'), tick.split(cellar).join(stable));
  // The recorded Node is itself the Cellar path the file holds (brew upgrade has not run): nothing to change; another
  // Cellar path still becomes the recorded one, the one Node that exists.
  fs.writeFileSync(path.join(duties, 'tick.md'), tick);
  assert.deepEqual(M.repairDutyNode({ vault: w.v, node: cellar }), []);
  assert.equal(w.read('persona/duties/tick.md'), tick);
  fs.writeFileSync(path.join(duties, 'reflect.md'), reflect);
  assert.deepEqual(M.repairDutyNode({ vault: w.v, node: cellar }), [{ file: 'persona/duties/reflect.md', paths: [other] }]);
  assert.equal(w.read('persona/duties/reflect.md'), reflect.split(other).join(cellar));
  assert.deepEqual(M.repairDutyNode({ vault: w.v, node: '' }), [], 'no Node to put in: nothing');
  // No persona yet: nothing to do, nothing thrown.
  const w2 = world();
  assert.deepEqual(M.staleDutyNodes(w2.v), []);
  assert.deepEqual(M.repairDutyNode({ vault: w2.v, node: stable }), []);
});
