'use strict';
/**
 * config-cmd.js — `aos config <verb>` (spec 2026-09-24-aos-config).
 *   list [--json]                           every setting: its value, the file it comes from, * when it differs from the default
 *   get <key> [--json]                      one value (a string as is, anything else as JSON); --json adds the whole row
 *   set <key> <value> [--dry-run] [--json]  validate, write it to the file that holds it (D4), run its side effects (D7)
 *   unset <key> [--dry-run] [--json]        remove it from both files so the default applies
 * Runs from the checkout (node cli/aos.js) and from the vendored <vault>/brain/scripts/cli/ (the aos launcher): lib/ is
 * looked up next to this file first, then in the checkout. Every external effect is injectable (opts).
 */
const fs = require('fs');
const path = require('path');

const VERBS = ['list', 'get', 'set', 'unset'];
const REPO = path.join(__dirname, '..');

function resolveModule(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(REPO, 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return require(p);
  throw new Error(`${rel} not found beside cli/config-cmd.js — run \`aos upgrade\``);
}
const schema = () => resolveModule('lib/settings-schema.js');
const writer = () => resolveModule('lib/config-write.js');

class UsageError extends Error {}
/** An unknown key or a value its setting refuses: exit 2 with the fix in the message, without the whole usage text. */
class BadValue extends Error {}
/** A refusal the user acts on (a read-only key, a headless run): exit 1, never a usage mistake. */
class Refused extends Error {}

const FILE_LABEL = { machine: 'agenticos.json', vault: 'brain/config.json', default: 'default', unset: '—' };

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function fmt(v) { return v === undefined ? '(unset)' : typeof v === 'string' ? v : JSON.stringify(v); }
/** Long lists and objects are clipped in `list`; strings (paths, models) are shown whole, `get` prints anything whole. */
function clip(s, n = 48) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function table(lines) {
  const widths = [0, 1, 2].map((i) => Math.max(...lines.map((l) => l[i].length)));
  return lines.map((l) => `  ${l.map((c, i) => c.padEnd(widths[i])).join('  ')}`.trimEnd()).join('\n');
}

/**
 * The models the local Codex offers in its own picker: <codex home>/models_cache.json, which Codex refreshes itself, in
 * its order, hidden ones left out. null when there is no readable cache, so the schema's list (the pricing table's)
 * stands. Codex model pickers follow it, so a new Codex model appears without an AgenticOS release.
 */
function codexCatalog(env, userCfg) {
  try {
    const home = resolveModule('lib/host.js').codexHome(env, userCfg);
    const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    const slugs = (Array.isArray(cache && cache.models) ? cache.models : [])
      .filter((m) => m && typeof m.slug === 'string' && m.slug && m.visibility !== 'hide').map((m) => m.slug);
    return slugs.length ? [...new Set(slugs)] : null;
  } catch { return null; }
}

function resolveCtx(opts = {}) {
  const env = opts.env || process.env;
  const configDir = opts.configDir || resolveModule('lib/host.js').claudeConfigDir(env);
  const W = writer();
  const machine = path.resolve(env.AOS_CONFIG || path.join(configDir, 'agenticos.json'));
  const userCfg = W.readStrict(machine);
  const vault = opts.vault || env.AOS_VAULT || (userCfg && userCfg.vault);
  if (!vault) throw new Refused('no vault configured (run `aos init` first)');
  const vaultFile = path.join(vault, 'brain', 'config.json');
  const ctx = { env, configDir, vault, files: { machine, vault: vaultFile }, userCfg: userCfg || {}, vaultCfg: W.readStrict(vaultFile) || {}, spend: null };
  ctx.codexModels = opts.codexModels !== undefined ? opts.codexModels : codexCatalog(env, userCfg);
  // opts.spend(vault) → today's USD per ledger family (cli/aos.js passes the helpers `aos status` uses).
  if (typeof opts.spend === 'function') { try { ctx.spend = opts.spend(vault); } catch { ctx.spend = null; } }
  return ctx;
}

/** One setting as `list --json` and `get --json` print it: the schema entry, the value in force and its source. */
function row(e, ctx) {
  const { value, source } = writer().resolve(e, ctx);
  const def = schema().defaultOf(e);
  const r = {
    key: e.key, section: e.section, label: e.label, help: e.help, type: e.type, values: e.values || null,
    min: e.min ?? null, gt: e.gt ?? null, max: e.max ?? null, int: !!e.int, nullable: !!e.nullable,
    risk: e.risk || null, applies: e.applies, readonly: !!e.readonly, how: e.how || null, host: e.host || null,
    // The Workbench's picker presets, chips and edit buttons (spec 2026-09-24-settings-pickers D2, D4).
    choices: (e.type === 'model' && e.host === 'codex' && ctx.codexModels) || e.choices || null,
    unit: e.unit || null, pick: e.pick || null, editIn: e.editIn || null,
    default: def === undefined ? null : def, value, source, changed: !e.machine && !same(value, def), note: null,
    // Today's spend in the ledger family this daily cap governs (spec 2026-09-24-settings-tab D7); null without a ledger read.
    spentToday: e.spend && ctx.spend && typeof ctx.spend[e.spend] === 'number' ? ctx.spend[e.spend] : null,
  };
  // D8: persona.enabled and persona/DISABLED move together through `aos config`; `aos persona off` pauses duties alone.
  if (e.key === 'persona.enabled' && value !== false && fs.existsSync(path.join(ctx.vault, 'persona', 'DISABLED'))) {
    r.note = 'scheduled duties are paused (persona/DISABLED); `aos persona on` resumes them';
  }
  return r;
}

/** The entry for `key`; an unknown key is a BadValue naming the group's keys or the nearest match. */
function need(key, verb) {
  const S = schema();
  if (!key) throw new UsageError(`aos config ${verb} <key>${verb === 'set' ? ' <value>' : ''}`);
  const e = S.entry(key);
  if (e) return e;
  const group = S.SETTINGS.filter((x) => x.key.startsWith(`${key}.`)).map((x) => x.key);
  if (group.length) throw new BadValue(`${key} is a group; name one of: ${group.join(', ')}`);
  const near = S.SETTINGS.map((x) => x.key).filter((k) => distance(k.toLowerCase(), key.toLowerCase()) <= 2);
  throw new BadValue(`unknown setting "${key}"${near.length ? ` (did you mean ${near.join(' or ')}?)` : ''}; \`aos config list\` shows them all`);
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** D9: a duty, routine or background model call runs with AOS_HEADLESS=1 and never changes its own settings. */
function guardWrite(e, ctx) {
  if (e.readonly) throw new Refused(`${e.key} is written by the installer, not here: ${e.how}`);
  if (ctx.env.AOS_HEADLESS === '1') throw new Refused('settings are never changed from a headless run (AOS_HEADLESS=1); ask the user to change it');
}

function list(ctx, o) {
  const S = schema();
  const rows = S.SETTINGS.map((e) => row(e, ctx));
  if (o.json) { o.io.log(JSON.stringify({ schema: 1, files: ctx.files, sections: S.SECTIONS, settings: rows }, null, 2)); return 0; }
  o.io.log(`agenticos.json     ${ctx.files.machine}\nbrain/config.json  ${ctx.files.vault}\n* differs from the default · \`aos config set <key> <value>\` changes one`);
  for (const sec of S.SECTIONS) {
    const lines = rows.filter((r) => r.section === sec.id).map((r) => [
      `${r.changed ? '*' : ' '} ${r.key}`, r.source === 'unset' ? '—' : typeof r.value === 'string' ? r.value : clip(fmt(r.value)), `${FILE_LABEL[r.source]}${r.readonly ? ' (read-only)' : ''}`,
    ]);
    o.io.log(`\n${sec.label}\n${table(lines)}`);
  }
  for (const r of rows) if (r.note) o.io.log(`\nnote: ${r.key}: ${r.note}`);
  return 0;
}

function get(ctx, key, o) {
  const r = row(need(key, 'get'), ctx);
  o.io.log(o.json ? JSON.stringify(r, null, 2) : fmt(r.value));
  return 0;
}

/** D7: what a change does beyond the file write. Performs it when `apply`; returns what it did (or would do). */
function sideEffects(ctx, e, value, o, apply) {
  const done = [];
  if (e.key === 'provider') {
    const f = path.join(ctx.vault, 'brain', '_index', 'provider-state.json');
    if (fs.existsSync(f)) {
      if (apply) fs.rmSync(f, { force: true });
      done.push('cleared the cached provider probe (the next hook re-resolves)');
    }
  }
  if (e.key === 'persona.enabled') {
    const flag = path.join(ctx.vault, 'persona', 'DISABLED');
    if (value === false && isDir(path.dirname(flag)) && !fs.existsSync(flag)) {
      if (apply) fs.writeFileSync(flag, `disabled ${o.now.toISOString()} by aos config\n`);
      done.push('paused scheduled duties (persona/DISABLED)');
    } else if (value !== false && fs.existsSync(flag)) {
      if (apply) fs.rmSync(flag, { force: true });
      done.push('resumed scheduled duties (removed persona/DISABLED)');
    }
  }
  return done;
}

/** cost.enabled installs or leaves the analyzer: `aos cost enable|disable` own that, so set hands off to them (D7). */
async function delegateCost(ctx, on, o) {
  const C = o.costCmd || require('./cost-cmd.js');
  const said = [];
  const io = { log: (m) => said.push(String(m)), error: (m) => o.io.error(m) };
  if (on) await C.enable({ configDir: ctx.configDir, vault: ctx.vault, yes: true, io });
  else C.disable({ configDir: ctx.configDir, io });
  return said;
}

function report(res, o) {
  if (o.json) { o.io.log(JSON.stringify(res, null, 2)); return; }
  const where = res.file ? `  (${o.dryRun ? 'would write ' : ''}${FILE_LABEL[res.source]})` : '';
  o.io.log(`${o.dryRun ? '(dry run) ' : ''}${res.key}: ${fmt(res.old)} → ${fmt(res.value)}${where}`);
  for (const line of res.effects) o.io.log(`  ${line}`);
  for (const f of res.followUps) o.io.log(`next: ${f.command} (${f.why})`);
}

async function set(ctx, key, text, o) {
  const S = schema();
  const W = writer();
  if (!key || text === undefined) throw new UsageError('aos config set <key> <value>');
  const e = need(key, 'set');
  guardWrite(e, ctx);
  let value;
  try { value = S.parseValue(e, text); } catch (err) { throw new BadValue(err.message); }
  const bad = S.validate(e, value);
  if (bad) throw new BadValue(bad);
  const before = W.resolve(e, ctx);
  let target = W.targetFile(e, ctx);
  const res = { key, old: before.value, value, file: null, source: target, dryRun: o.dryRun, effects: [], followUps: e.followUp && !(key === 'integrations.superpowers.enabled' && value === false) ? [e.followUp] : [] };
  if (e.key === 'cost.enabled') {
    target = 'machine'; // cost-cmd writes cost.enabled into agenticos.json, where `aos init` put it
    res.source = target;
    if (o.dryRun) res.effects.push(value ? 'would run `aos cost enable --yes` (installs the analyzer)' : 'would run `aos cost disable`');
    else res.effects.push(...await delegateCost(ctx, value, o));
  } else if (!o.dryRun) {
    const obj = target === 'machine' ? ctx.userCfg : ctx.vaultCfg;
    W.setPath(obj, key, value);
    W.writeAtomic(ctx.files[target], obj);
  }
  res.file = ctx.files[target];
  res.effects.push(...sideEffects(ctx, e, value, o, !o.dryRun));
  report(res, o);
  return 0;
}

function unset(ctx, key, o) {
  const S = schema();
  const W = writer();
  const e = need(key, 'unset');
  guardWrite(e, ctx);
  const before = W.resolve(e, ctx);
  const removed = [];
  for (const [src, obj] of [['machine', ctx.userCfg], ['vault', ctx.vaultCfg]]) {
    if (!W.hasPath(obj, key)) continue;
    removed.push(src);
    if (o.dryRun) continue;
    W.unsetPath(obj, key);
    W.writeAtomic(ctx.files[src], obj);
  }
  const value = S.defaultOf(e);
  const res = { key, old: before.value, value, file: null, source: 'default', removedFrom: removed.map((s) => ctx.files[s]), dryRun: o.dryRun, effects: [], followUps: [] };
  if (!removed.length) {
    if (o.json) o.io.log(JSON.stringify(res, null, 2));
    else o.io.log(`${key} is not set in either file; the default applies: ${fmt(value)}`);
    return 0;
  }
  res.effects.push(`${o.dryRun ? 'would remove' : 'removed'} it from ${removed.map((s) => FILE_LABEL[s]).join(' and ')}; the default applies`);
  res.effects.push(...sideEffects(ctx, e, value, o, !o.dryRun));
  if (e.followUp && key !== 'integrations.superpowers.enabled') res.followUps.push(e.followUp);
  report(res, o);
  return 0;
}

async function main(argv, opts = {}) {
  const io = opts.io || console;
  const words = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const verb = words[0] || 'list';
  if (!VERBS.includes(verb)) throw new UsageError(`aos config: unknown verb "${verb}" (${VERBS.join(' | ')})`);
  if (flags.has('--dry-run') && verb !== 'set' && verb !== 'unset') throw new UsageError('--dry-run is only supported by `aos config set` and `aos config unset`');
  const most = { list: 1, get: 2, set: 3, unset: 2 }[verb];
  if (words.length > most) throw new UsageError(`aos config ${verb}: too many arguments (quote a value that has spaces)`);
  const ctx = resolveCtx(opts);
  const o = { io, json: flags.has('--json'), dryRun: flags.has('--dry-run'), now: opts.now || new Date(), costCmd: opts.costCmd };
  try {
    switch (verb) {
      case 'list': return list(ctx, o);
      case 'get': return get(ctx, words[1], o);
      case 'set': return await set(ctx, words[1], words[2], o);
      case 'unset': return unset(ctx, words[1], o);
      default: return 2;
    }
  } catch (e) {
    if (!(e instanceof BadValue)) throw e;
    io.error(`aos config: ${e.message}`);
    return 2;
  }
}

/** `aos doctor`'s row (D12): both files parse, no unknown keys, no invalid values; otherwise a warn naming each. */
function doctorRow({ configDir, vault, env = process.env }) {
  const W = writer();
  const files = { machine: path.resolve(env.AOS_CONFIG || path.join(configDir, 'agenticos.json')), vault: path.join(vault, 'brain', 'config.json') };
  const objs = { machine: {}, vault: {} };
  const problems = [];
  for (const src of ['machine', 'vault']) {
    try { objs[src] = W.readStrict(files[src]) || {}; } catch { problems.push(`${FILE_LABEL[src]} does not parse`); continue; }
    const unknown = W.unknownKeys(objs[src]);
    if (unknown.length) problems.push(`unknown in ${FILE_LABEL[src]}: ${unknown.join(', ')}`);
    for (const b of W.invalidValues(objs[src])) problems.push(`${FILE_LABEL[src]}: ${b.message}`);
  }
  if (problems.length) return { name: 'config', ok: false, detail: `${problems.join('; ')} — aos config list`, level: 'warn' };
  const ctx = { vault, userCfg: objs.machine, vaultCfg: objs.vault };
  const changed = schema().SETTINGS.filter((e) => !e.machine && row(e, ctx).changed).length;
  return { name: 'config', ok: true, detail: `${changed} setting${changed === 1 ? ' differs' : 's differ'} from the defaults — aos config list`, level: 'info' };
}

module.exports = { VERBS, UsageError, BadValue, Refused, main, doctorRow, resolveCtx, row, fmt };
