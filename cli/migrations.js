'use strict';
/**
 * migrations.js — `aos migrate`: the choices an upgrade to 2.0 asks once (local-first A9 and §4 "Migration";
 * install-import B12).
 *
 *   aos migrate [--status] [--json]                                     every migration and its state
 *   aos migrate local-first [--status | --apply [--chief] | --decline | --undo] [--json]
 *   aos migrate import [--status | --apply | --decline] [--accept <json list>] [--json]
 *
 * MIGRATIONS = [{ id, since }] generalizes NEW_ROUTINES' `ctx.from` gating (cli/aos.js): `aos upgrade` from a version
 * before `since` (an unreadable one counts as older) records the migration `pending` in brain/_index/migrations.json
 * ({ schema: 1, migrations: [{ id, state, since, from, at, … }] }), never one already recorded, whatever its state. On a
 * TTY the upgrade asks about local-first once; otherwise it prints the commands (B12: and `aos import`). The app's
 * launch sequence (tour C11) shows the Go-local card for a pending local-first and runs this verb through the `migrate`
 * surface. States: pending → applying → applied | declined; applied → undone (--undo); declined or undone → applied
 * (Settings). `applying` is written, with the backup's path, before the first config write: an apply that stops half
 * way (an error, Ctrl-C, the app's timeout) is resumed by the next --apply on that same backup, and --undo or --decline
 * put back what it had changed.
 *
 * Until the owner answers, nothing the install runs may change (A9): the same upgrade pins it first (pinPrevious, before
 * the runtime is re-vendored or anything writes the new version). Each setting whose 2.0 default would change what runs
 * (PRE_2_0) is written into brain/config.json with its 1.9 value where that file does not set it, so neither the new
 * defaults the upgrade merges in nor the vendored config.default.json lib/config.js layers beneath the file move it.
 *
 * local-first --apply (A9): backs up every key it touches, and tick.md when it rewrites it, to
 *   brain/_index/migrations/local-first-<ts>.json, then sets `provider: local` and `ai.{chat,ask,reflectWeek,consolidate}:
 *   local` in BOTH agenticos.json and brain/config.json. --chief moves the Chief of Staff (A4): its models from the chief
 *   role (sdk/lib/models.js CHIEF: persona.model, persona.codexModel) and `persona.failover: true`, in brain/config.json,
 *   and in agenticos.json only where it names them (that file wins). The tick routine (brain/routines/tick.md) becomes the shipped 2.0 one (`kind: command`,
 *   `tick.js --triage`) only while it is byte for byte a tick.md a release shipped before 2.0; an edited one is kept and a
 *   notification says why. The installed schedules are re-rendered (they bake the duty model). No other routine is
 *   touched. Applied again (a key changed by hand since), it sets what no longer holds and keeps the first backup, so
 *   undo still goes back to before the migration. --decline records the choice and changes nothing. --undo puts each
 *   backed-up key back as it was (a key that was absent is removed again) while it still holds the value apply set; a
 *   key changed since is kept and named, as tick.md is kept once changed since; then it re-renders.
 * import --apply: the import's fast phases and the digest queue, as `aos import` runs them (cli/import.js runWith), with
 *   no workspace created unless --accept names it; --decline records it. A plain `aos import` settles it too.
 *
 * Runs from the checkout and from the vendored copy (<vault>/brain/scripts/cli); zero dependencies; every effect
 * injectable through opts (env, configDir, vault, now, io, schedule seams, notify, importer).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SCHEMA = 1;
/** id → the release that added it. An upgrade from before `since` records it pending. */
const MIGRATIONS = Object.freeze([
  Object.freeze({ id: 'local-first', since: '2.0.0' }),   // local-first A9
  Object.freeze({ id: 'import', since: '2.0.0' }),        // install-import B12
]);
const IDS = MIGRATIONS.map((m) => m.id);
const STATES = ['pending', 'applying', 'applied', 'declined', 'undone'];
const ACTIONS = ['status', 'apply', 'decline', 'undo'];
const USAGE = 'aos migrate [local-first|import] [--status | --apply [--chief] | --decline | --undo] [--accept <json list>] [--json]';
/** local-first A2: the AI features that follow `ai.<feature>` under provider local. */
const AI_KEYS = ['ai.chat', 'ai.ask', 'ai.reflectWeek', 'ai.consolidate'];
/** SHA-256 of every tick.md a release shipped before 2.0 (vault-template/persona/routines/tick.md at v0.7.0–v0.13.0 and
 *  at v0.14.0–v1.9.0). The persona interview copies it verbatim into brain/routines/, so an untouched one matches. */
const SHIPPED_TICKS = Object.freeze([
  'f42ee5c97e74eff2e7b3ebbe40bc55210f7597f94c0837cdd77f984f07ff081c',
  '2f4c411ac864fbfceec14bd22a1c8f43142d03cf5a680840bfed816eb14665a4',
]);
const TICK_REL = 'brain/routines/tick.md';
/**
 * What an install from before 2.0 runs on, for each setting whose 2.0 default would change it (local-first A9): 1.9's
 * defaults for them. A null model keeps the chain a duty ran on (sdk/lib/models.js chiefModel: the interview's answer,
 * then claude.model; codex.model, then the Codex default); failover off keeps a duty on its own host (lib/headless.js
 * resolveChief: under auto the first enabled host installed, as before 2.0, and a signed-out one waits instead of moving).
 * local-first --apply moves `provider`, --chief the three persona keys; --undo puts them back.
 */
const PRE_2_0 = Object.freeze({ provider: 'auto', 'persona.model': null, 'persona.codexModel': null, 'persona.failover': false });

class UsageError extends Error {}
class Refused extends Error {}

// ── files ─────────────────────────────────────────────────────────────────────
function resolveModule(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(REPO, 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return require(p);
  throw new Error(`${rel} not found beside cli/migrations.js — run \`aos upgrade\``);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
/** A file the user owns: missing is `fallback`, unparseable is refused (never replaced; cli/aos.js readJsonStrict). */
function readJsonStrict(file, fallback = null) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Refused(`refusing to touch unreadable ${file}: ${e.message}`);
  }
  try { return JSON.parse(raw); } catch (e) { throw new Refused(`refusing to touch unparseable ${file}: ${e.message}`); }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const writeJson = (file, obj) => writeAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** a.b.c in an object: { had, value }. */
function getKey(obj, key) {
  let cur = obj;
  for (const part of key.split('.')) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return { had: false };
    cur = cur[part];
  }
  return { had: true, value: cur };
}
function setKey(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}
/** Removes a.b.c, and each parent it leaves empty. */
function deleteKey(obj, key) {
  const parts = key.split('.');
  const chain = [obj];
  for (const p of parts.slice(0, -1)) {
    const next = chain[chain.length - 1][p];
    if (!isPlainObject(next)) return;
    chain.push(next);
  }
  delete chain[chain.length - 1][parts[parts.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) if (!Object.keys(chain[i]).length) delete chain[i - 1][parts[i - 1]];
}

/** The vault, agenticos.json and the config dir, as every aos verb resolves them (cli/workspace.js resolveCtx). */
function resolveCtx(opts = {}) {
  const env = opts.env || process.env;
  const configDir = path.resolve(opts.configDir || resolveModule('lib/host.js').claudeConfigDir(env));
  const configFile = path.resolve(env.AOS_CONFIG || path.join(configDir, 'agenticos.json'));
  const user = readJson(configFile) || {};
  const configured = String(opts.vault || env.AOS_VAULT || user.vault || '').trim();
  if (!configured) throw new Refused('no vault configured (run `aos init` first)');
  const vault = path.resolve(configured);
  if (!fs.existsSync(path.join(vault, 'brain', '_index'))) throw new Refused(`${vault} is not a vault (no brain/_index) — run \`aos init\``);
  return { env, configDir, configFile, vault, now: opts.now || new Date() };
}

// ── state ─────────────────────────────────────────────────────────────────────
const statePath = (vault) => path.join(vault, 'brain', '_index', 'migrations.json');

/** migrations.json, cleaned: unknown ids and states are dropped (a later release may add some; it rewrites them). */
function readState(vault) {
  const j = readJson(statePath(vault));
  const list = j && Array.isArray(j.migrations) ? j.migrations : [];
  return { schema: SCHEMA, migrations: list.filter((m) => isPlainObject(m) && IDS.includes(m.id) && STATES.includes(m.state)) };
}
function writeState(vault, st) { writeJson(statePath(vault), { schema: SCHEMA, migrations: st.migrations }); }
function entryOf(st, id) { return st.migrations.find((m) => m.id === id) || null; }
/** Sets a migration's record (its fields replace the old ones, `id` and `since` kept). */
function record(vault, id, fields, now) {
  const st = readState(vault);
  const since = MIGRATIONS.find((m) => m.id === id).since;
  const prev = entryOf(st, id);
  const next = { ...(prev || { id, since }), ...fields, id, since, at: now.toISOString() };
  st.migrations = [...st.migrations.filter((m) => m.id !== id), next].sort((a, b) => IDS.indexOf(a.id) - IDS.indexOf(b.id));
  writeState(vault, st);
  return next;
}

/**
 * `aos upgrade`: records each migration whose `since` is after the version the vault was on (`from`; missing or
 * unreadable counts as older) and that migrations.json does not list yet. → the ids recorded now.
 */
function recordPending({ vault, from, now = new Date() }) {
  const { cmpSemver } = require('./update-check.js');
  const st = readState(vault);
  const added = [];
  for (const { id, since } of MIGRATIONS) {
    if (entryOf(st, id)) continue;
    const c = from ? cmpSemver(from, since) : null;
    if (c !== null && c >= 0) continue;
    st.migrations.push({ id, state: 'pending', since, from: from || null, at: now.toISOString() });
    added.push(id);
  }
  if (added.length) writeState(vault, st);
  return added;
}

/**
 * `aos upgrade`, right after recordPending and before anything else: from a version before local-first's `since` (missing
 * or unreadable counts as older), writes each PRE_2_0 key that brain/config.json does not set, with its 1.9 value. A key
 * the file sets (the owner's, or 1.9's own materialized default) is never touched, and from 2.0.0 on nothing is. An
 * unreadable or unparseable file is refused (Refused) before anything is written, as the defaults merge refuses it.
 * → the keys pinned now.
 */
function pinPrevious({ vault, from }) {
  const { cmpSemver } = require('./update-check.js');
  const c = from ? cmpSemver(from, MIGRATIONS.find((m) => m.id === 'local-first').since) : null;
  if (c !== null && c >= 0) return [];
  const file = path.join(vault, 'brain', 'config.json');
  const doc = readJsonStrict(file, {});
  if (!isPlainObject(doc)) throw new Refused(`refusing to touch ${file}: it is not a JSON object`);
  const pinned = Object.keys(PRE_2_0).filter((k) => !getKey(doc, k).had);
  for (const k of pinned) setKey(doc, k, PRE_2_0[k]);
  if (pinned.length) writeJson(file, doc);
  return pinned;
}

/** A pending migration becomes applied (`aos import` without --migrate settles the import this way). → whether it did. */
function settle(vault, id, state = 'applied', now = new Date()) {
  const e = entryOf(readState(vault), id);
  if (!e || e.state !== 'pending') return false;
  record(vault, id, { state }, now);
  return true;
}

// ── schedules and notices ─────────────────────────────────────────────────────
/** Re-renders the installed schedules from the routine files (cli/hosts.js rerenderSchedules); a line saying what happened. */
function rerender(ctx, opts = {}) {
  const S = opts.schedule || require('./schedule.js');
  const platform = opts.platform || process.platform;
  try {
    if (!(opts.isInstalled || S.isInstalled)({ platform, vault: ctx.vault })) return 'no schedules installed; nothing to re-render (aos routines sync installs them)';
    const { scheduleVarsFor } = require('./routines.js');
    const { stableNode } = require('./node-path.js');
    const cfg = readJson(ctx.configFile) || {};
    const vars = scheduleVarsFor({ vault: ctx.vault, configDir: ctx.configDir, node: stableNode(cfg.node || process.execPath), cfg });
    const r = (opts.installSchedules || S.installSchedules)({ vars, platform, warn: () => {} });
    return r.unsupported ? `scheduling is not supported on ${r.platform}` : `schedules re-rendered: ${(r.labels || []).join(', ') || 'none'}`;
  } catch (e) {
    return `re-rendering the schedules failed (${e.message}): run \`aos routines sync\``;
  }
}

/** One Notifications item from `aos` (lib/notifications.js), best effort. */
function notify(ctx, p, opts = {}) {
  if (opts.notify) return opts.notify(p);
  try {
    const N = resolveModule('lib/notifications.js');
    N.post({ from: 'aos', level: 'info', ...p }, { vault: ctx.vault, now: ctx.now });
    return true;
  } catch { return false; }
}

// ── local-first ───────────────────────────────────────────────────────────────
/** The shipped 2.0 tick routine: beside this file in the vendored runtime, else the checkout's template. */
function shippedTick() {
  for (const p of [path.join(__dirname, '..', 'persona', 'templates', 'routines', 'tick.md'), path.join(REPO, 'vault-template', 'persona', 'routines', 'tick.md')]) {
    try { return fs.readFileSync(p, 'utf8'); } catch { /* next */ }
  }
  return null;
}

/** What apply does to tick.md: { action: 'rewrite' | 'current' | 'kept' | 'missing' | 'unshipped', before?, after? }. */
function tickPlan(vault) {
  const file = path.join(vault, TICK_REL);
  let before;
  try { before = fs.readFileSync(file, 'utf8'); } catch { return { action: 'missing' }; }
  const after = shippedTick();
  if (after === null) return { action: 'unshipped' };
  if (before === after) return { action: 'current' };
  if (SHIPPED_TICKS.includes(sha256(before))) return { action: 'rewrite', before, after };
  return { action: 'kept' };
}

/** The Chief of Staff's models (the chief role, local-first A4/A11). */
function chiefModels() { return resolveModule('sdk/lib/models.js').CHIEF; }

/** The keys local-first sets, per file. `user` is agenticos.json, `vault` brain/config.json. */
function plannedKeys({ chief, user }) {
  const base = { provider: 'local' };
  for (const k of AI_KEYS) base[k] = 'local';
  const vault = { ...base };
  const mine = { ...base };
  if (chief) {
    // A4: the Chief of Staff's move is its two models and the failover between the hosts (off since the upgrade, PRE_2_0).
    const C = chiefModels();
    const moved = { 'persona.model': C.claude, 'persona.codexModel': C.codex, 'persona.failover': true };
    Object.assign(vault, moved);
    // agenticos.json wins over brain/config.json: where it names one of them, it gets the new value too.
    for (const [k, v] of Object.entries(moved)) if (getKey(user, k).had) mine[k] = v;
  }
  return { user: mine, vault };
}

const FILE_NAME = { user: 'agenticos.json', vault: 'brain/config.json' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const backupOf = (ctx, rel) => {
  const b = readJson(path.join(ctx.vault, rel));
  if (!b || b.id !== 'local-first' || !isPlainObject(b.files)) throw new Refused(`the backup ${rel} is missing or unreadable; nothing was changed`);
  return b;
};

function applyLocalFirst(ctx, { chief = false } = {}, opts = {}) {
  const prev = entryOf(readState(ctx.vault), 'local-first');
  const files = { user: ctx.configFile, vault: path.join(ctx.vault, 'brain', 'config.json') };
  const docs = { user: fs.existsSync(ctx.configFile) ? readJsonStrict(ctx.configFile, {}) : null, vault: readJsonStrict(files.vault, {}) || {} };
  const plan = plannedKeys({ chief, user: docs.user || {} });
  const tick = tickPlan(ctx.vault);

  // The backup: one taken by an apply that stopped half way, or by the one that applied, is kept (it holds the values
  // from before the migration); a key this run sets for the first time is added to it now, before it changes.
  const resumed = !!(prev && (prev.state === 'applying' || prev.state === 'applied') && prev.backup);
  const backupRel = resumed ? prev.backup : `brain/_index/migrations/local-first-${ctx.now.toISOString().replace(/[:.]/g, '-')}.json`;
  const backup = resumed ? backupOf(ctx, backupRel) : { schema: SCHEMA, id: 'local-first', at: ctx.now.toISOString(), chief: false, files: {}, tick: null };
  let grew = !resumed;
  for (const which of ['user', 'vault']) {
    if (!docs[which]) continue;
    const keys = backup.files[which] = isPlainObject(backup.files[which]) ? backup.files[which] : {};
    for (const [k, v] of Object.entries(plan[which])) if (!keys[k]) { keys[k] = { ...getKey(docs[which], k), set: v }; grew = true; }
  }
  if (tick.action === 'rewrite' && !backup.tick) { backup.tick = { file: TICK_REL, before: tick.before, after: tick.after }; grew = true; }
  if (chief && !backup.chief) { backup.chief = true; grew = true; }
  // Nothing changes unless the backup is on disk, and the state names it before the first write.
  if (grew) writeJson(path.join(ctx.vault, backupRel), backup);
  if (!prev || prev.state !== 'applied') record(ctx.vault, 'local-first', { state: 'applying', backup: backupRel }, ctx.now);

  const changed = [];
  for (const which of ['user', 'vault']) {
    const doc = docs[which];
    if (!doc) continue;
    let touched = false;
    for (const [k, v] of Object.entries(plan[which])) {
      const cur = getKey(doc, k);
      if (cur.had && same(cur.value, v)) continue;
      setKey(doc, k, v);
      touched = true;
      changed.push(`${FILE_NAME[which]} ${k} = ${v}`);
    }
    if (touched) writeJson(files[which], doc);
  }
  // The provider's cached resolution was for the old provider (`aos provider` clears it the same way).
  if (changed.length) { try { fs.unlinkSync(path.join(ctx.vault, 'brain', '_index', 'provider-state.json')); } catch { /* none yet */ } }

  const lines = [];
  if (tick.action === 'rewrite') {
    writeAtomic(path.join(ctx.vault, TICK_REL), tick.after);
    lines.push(`${TICK_REL}: now the 2.0 tick (it triages on this Mac, tick.js --triage, and wakes the Chief of Staff only for a real change)`);
  } else if (tick.action === 'kept') {
    lines.push(`${TICK_REL}: kept as you edited it — see the notification`);
    if (!prev || prev.state !== 'applied') {
      notify(ctx, {
        title: 'Your tick routine was kept as it is',
        body: [
          `Going local updated your settings, but not \`${TICK_REL}\`: it is not the file an earlier release shipped, so it has your changes, and a migration never overwrites a routine you edited.`,
          '',
          'The 2.0 tick triages the hourly check on this Mac (`kind: command`, running `tick.js --triage`) and wakes the Chief of Staff only when something really changed, so a quiet hour costs nothing. Yours keeps running as before.',
          '',
          `To take the new one, compare yours with \`brain/scripts/persona/templates/routines/tick.md\` and copy what you want into \`${TICK_REL}\`, then run \`aos routines sync\`.`,
        ].join('\n'),
        tags: ['migration'],
      }, opts);
    }
  } else if (tick.action === 'current') lines.push(`${TICK_REL}: already the 2.0 tick`);
  const moved = changed.length > 0 || tick.action === 'rewrite';
  const schedules = moved || !prev || prev.state !== 'applied' ? rerender(ctx, opts) : 'nothing changed, so the schedules were left as they are';
  lines.push(schedules);
  if (!moved && prev && prev.state === 'applied') lines.unshift('already applied: every setting still holds (aos migrate local-first --undo puts the earlier ones back)');
  const rec = record(ctx.vault, 'local-first', { state: 'applied', chief: !!backup.chief, backup: backupRel, tick: tick.action }, ctx.now);
  return { id: 'local-first', state: rec.state, chief: !!backup.chief, changed, backup: backupRel, tick: tick.action, schedules, lines };
}

/**
 * Puts back what the backup holds: a key only while it still holds the value apply set (one still at its value from
 * before is left alone; one changed since is kept and named), tick.md only while it is the one apply wrote.
 */
function restoreBackup(ctx, backup) {
  const files = { user: ctx.configFile, vault: path.join(ctx.vault, 'brain', 'config.json') };
  const restored = [];
  const kept = [];
  for (const which of ['user', 'vault']) {
    const keys = backup.files[which];
    if (!isPlainObject(keys)) continue;
    const doc = readJsonStrict(files[which], null);
    if (!doc) continue;
    let touched = false;
    for (const [k, was] of Object.entries(keys)) {
      if (!was) continue;
      const cur = getKey(doc, k);
      const before = was.had ? cur.had && same(cur.value, was.value) : !cur.had;
      if (before) continue;
      // A backup from before `set` was recorded restores as it always did.
      if ('set' in was && !(cur.had && same(cur.value, was.set))) { kept.push(`${FILE_NAME[which]} ${k} (changed since going local)`); continue; }
      if (was.had) setKey(doc, k, was.value);
      else deleteKey(doc, k);
      touched = true;
      restored.push(`${FILE_NAME[which]} ${k} ${was.had ? `= ${JSON.stringify(was.value)}` : 'removed'}`);
    }
    if (touched) writeJson(files[which], doc);
  }
  if (restored.length) { try { fs.unlinkSync(path.join(ctx.vault, 'brain', '_index', 'provider-state.json')); } catch { /* none */ } }
  const lines = [];
  if (backup.tick && typeof backup.tick.before === 'string') {
    const file = path.join(ctx.vault, TICK_REL);
    let now = null;
    try { now = fs.readFileSync(file, 'utf8'); } catch { /* gone */ }
    if (now === backup.tick.after) { writeAtomic(file, backup.tick.before); lines.push(`${TICK_REL}: the tick you had before`); }
    else if (now !== backup.tick.before) lines.push(`${TICK_REL}: changed since going local, so it was left as it is`);
  }
  return { restored, kept, lines };
}

function undoLocalFirst(ctx, opts = {}) {
  const e = entryOf(readState(ctx.vault), 'local-first');
  if (!e || !['applied', 'applying'].includes(e.state) || !e.backup) throw new Refused('nothing to undo: local-first is not applied (aos migrate local-first --status)');
  const r = restoreBackup(ctx, backupOf(ctx, e.backup));
  const schedules = rerender(ctx, opts);
  const rec = record(ctx.vault, 'local-first', { state: 'undone' }, ctx.now);
  return { id: 'local-first', state: rec.state, restored: r.restored, kept: r.kept, backup: e.backup, schedules, lines: [...r.kept.map((k) => `kept ${k}`), ...r.lines, schedules] };
}

// ── import ────────────────────────────────────────────────────────────────────
async function applyImport(ctx, { accept = null, json = false } = {}, opts = {}) {
  const I = opts.importer || require('./import.js');
  const args = { from: ['claude', 'codex'], since: '90d', only: I.KINDS, accept, dryRun: false, json: false };
  const quiet = { log: () => {} };
  const { code, report } = await I.runWith(args, { ...opts, env: ctx.env, configDir: ctx.configDir, vault: ctx.vault, io: json ? quiet : (opts.io || console) });
  if (code !== 0) throw new Refused(`aos import stopped (exit ${code}); the import is still pending`);
  const rec = record(ctx.vault, 'import', { state: 'applied' }, ctx.now);
  return { id: 'import', state: rec.state, report: json ? report : undefined, lines: [] };
}

// ── the verb ──────────────────────────────────────────────────────────────────
function decline(ctx, id, opts = {}) {
  const e = entryOf(readState(ctx.vault), id);
  if (e && e.state === 'applied') throw new Refused(`${id} is applied${id === 'local-first' ? ': aos migrate local-first --undo puts your settings back' : ''}`);
  const lines = [];
  let restored = [];
  // An apply that stopped half way: what it changed goes back first, so "keep my settings" keeps them.
  if (e && e.state === 'applying' && e.backup) {
    const r = restoreBackup(ctx, backupOf(ctx, e.backup));
    restored = r.restored;
    lines.push(...r.kept.map((k) => `kept ${k}`), ...r.lines, rerender(ctx, opts));
  }
  const rec = record(ctx.vault, id, { state: 'declined' }, ctx.now);
  lines.unshift(id === 'local-first' ? 'kept your settings; Settings ▸ Local engine can go local later' : 'no import; `aos import` brings your history in whenever you like');
  return { id, state: rec.state, restored, lines };
}

function statusRows(vault) {
  const st = readState(vault);
  return MIGRATIONS.map(({ id, since }) => entryOf(st, id) || { id, since, state: null });
}

function parse(argv) {
  const flags = { json: false, chief: false, accept: null };
  const words = [];
  let action = null;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) { words.push(a); continue; }
    const name = a.slice(2);
    if (ACTIONS.includes(name)) {
      if (action && action !== name) throw new UsageError(`aos migrate: --${action} and --${name} are one or the other (${USAGE})`);
      action = name;
    } else if (name === 'json') flags.json = true;
    else if (name === 'chief') flags.chief = true;
    else if (name === 'accept') {
      const v = argv[++i];
      if (v === undefined || v === '') throw new UsageError('aos migrate: --accept needs a value');
      try { flags.accept = JSON.parse(v); } catch { throw new UsageError('aos migrate: --accept takes a JSON list, e.g. \'["~/code/app"]\''); }
      if (!Array.isArray(flags.accept)) throw new UsageError('aos migrate: --accept takes a JSON list');
    } else throw new UsageError(`aos migrate: unknown flag ${a} (${USAGE})`);
  }
  if (words.length > 1) throw new UsageError(`usage: ${USAGE}`);
  const id = words[0] || null;
  if (id && !IDS.includes(id)) throw new UsageError(`aos migrate: no migration ${id} (${IDS.join(', ')})`);
  if (!id && action && action !== 'status') throw new UsageError(`aos migrate --${action} needs a migration: ${IDS.join(' or ')}`);
  if (flags.chief && !(id === 'local-first' && action === 'apply')) throw new UsageError('aos migrate: --chief goes with local-first --apply');
  if (flags.accept && !(id === 'import' && action === 'apply')) throw new UsageError('aos migrate: --accept goes with import --apply');
  if (id === 'import' && action === 'undo') throw new UsageError('aos migrate import has no --undo: archive imported memories in Brain ▸ Review');
  return { id, action: action || 'status', ...flags };
}

/** `argv` = the words after `aos migrate`. → exit code */
async function main(argv, opts = {}) {
  const io = opts.io || console;
  const a = parse(argv);
  const ctx = resolveCtx(opts);
  let out;
  if (a.action === 'status') {
    const rows = statusRows(ctx.vault).filter((r) => !a.id || r.id === a.id);
    if (a.json) io.log(JSON.stringify(a.id ? rows[0] : { schema: SCHEMA, migrations: rows }, null, 2));
    else for (const r of rows) io.log(`${r.id.padEnd(12)} ${r.state || 'not recorded'}${r.at ? `  ${r.at}` : ''}${r.state === 'applied' && r.backup ? `  (backup ${r.backup})` : ''}`);
    return 0;
  }
  if (a.action === 'decline') out = decline(ctx, a.id, opts);
  else if (a.id === 'local-first') out = a.action === 'apply' ? applyLocalFirst(ctx, { chief: a.chief }, opts) : undoLocalFirst(ctx, opts);
  else out = await applyImport(ctx, { accept: a.accept, json: a.json }, opts);
  if (a.json) { const { lines, ...rest } = out; io.log(JSON.stringify({ ...rest, notes: lines }, null, 2)); return 0; }
  io.log(`${out.id}: ${out.state}`);
  for (const c of out.changed || []) io.log(`  ${c}`);
  for (const r of out.restored || []) io.log(`  ${r}`);
  for (const l of out.lines || []) io.log(`  ${l}`);
  if (out.backup && a.action === 'apply') io.log(`  backup: ${out.backup} (aos migrate local-first --undo)`);
  return 0;
}

// ── aos upgrade ───────────────────────────────────────────────────────────────
/** The commands the upgrade prints for what is pending (B12: and `aos import`). */
function pendingLines(ids) {
  const C = chiefModels();
  const out = [];
  if (ids.includes('local-first')) {
    out.push('Background work can now run on this Mac\'s local model, never spending (the app asks at its next launch):');
    out.push(`  aos migrate local-first --apply --chief   go local, and move the Chief of Staff to ${C.claude} / ${C.codex}`);
    out.push('  aos migrate local-first --apply           go local, and keep the Chief of Staff\'s model');
    out.push('  aos migrate local-first --decline         keep my settings');
  }
  if (ids.includes('import')) {
    out.push('Bring your Claude Code and Codex history into the vault (instructions, memories, MCP servers, past sessions):');
    out.push('  aos import                                 (aos import --dry-run shows what it would bring; aos migrate import --decline skips it)');
  }
  return out;
}

/**
 * After `aos upgrade`: when it recorded local-first just now (`added`) and runs on a TTY, asks about it once (Enter goes
 * local, A9's default) and applies (with the Chief of Staff's models) or declines it; whatever is still pending, it
 * prints the commands for. opts: isTTY, ask(question) → answer, io, and apply's seams. → { asked, answer, ran }
 */
async function offer(added, opts = {}) {
  const io = opts.io || console;
  const tty = opts.isTTY !== undefined ? opts.isTTY : !!(process.stdin.isTTY && process.stdout.isTTY);
  const ctx = resolveCtx(opts);
  const pending = () => IDS.filter((id) => { const e = entryOf(readState(ctx.vault), id); return e && e.state === 'pending'; });
  const result = { asked: false, answer: null, ran: null };
  if (tty && added.includes('local-first') && pending().includes('local-first')) {
    const C = chiefModels();
    const ask = opts.ask || defaultAsk;
    result.asked = true;
    io.log('');
    io.log('2.0 runs background work (summaries, memory, insights, the briefing, the AI buttons) on this Mac\'s local model,');
    io.log(`never spending; Sessions and your Chief of Staff stay on Claude Code / Codex (the Chief of Staff on ${C.claude} / ${C.codex}).`);
    const raw = String((await ask('Go local now? [Y]es / [n]o, keep my settings / [l]ater: ')) || '').trim().toLowerCase();
    result.answer = raw === '' || raw === 'y' || raw === 'yes' ? 'yes' : raw === 'n' || raw === 'no' ? 'no' : 'later';
    if (result.answer === 'yes') {
      const r = applyLocalFirst(ctx, { chief: true }, opts);
      result.ran = 'apply';
      io.log(`local-first: applied (backup ${r.backup}; aos migrate local-first --undo puts it back)`);
      for (const l of r.lines) io.log(`  ${l}`);
    } else if (result.answer === 'no') {
      decline(ctx, 'local-first', opts);
      result.ran = 'decline';
      io.log('local-first: kept your settings (Settings ▸ Local engine, or aos migrate local-first --apply, goes local later)');
    }
  }
  const still = pending();
  if (still.length) for (const l of pendingLines(still)) io.log(l);
  return result;
}

function defaultAsk(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

module.exports = {
  MIGRATIONS, IDS, STATES, SHIPPED_TICKS, AI_KEYS, TICK_REL, PRE_2_0, USAGE, UsageError, Refused,
  main, parse, readState, recordPending, pinPrevious, settle, offer, pendingLines, statusRows,
  applyLocalFirst, undoLocalFirst, applyImport, decline, tickPlan, shippedTick, resolveCtx, getKey, setKey, deleteKey, sha256,
};
