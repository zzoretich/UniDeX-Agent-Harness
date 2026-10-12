'use strict';
/**
 * memory.js — `aos memory <verb>` over <vault>/brain/memory (spec 2026-10-11-brain-hub D13): every action the Brain hub
 * takes, for the Workbench page and for either host's sessions.
 *   list [--json]                     every memory (path, title, status, pin, reviewed, source, session, hash), the
 *                                     feedback drafts and the counts
 *   keep <path>… [--json]             reviewed: true (D4)
 *   set <path> --set <json> [--expect <hash>] [--dry-run] [--json]
 *                                     pin (true/false), status (active, complete, paused) or description, refused when the
 *                                     file's hash is not --expect (D17)
 *   archive <path>… [--json]          status/archived, out of MEMORY.md, recall and BRAIN.md; nothing deleted (D5, D6)
 *   restore <path>… [--json]          an archived or superseded memory back, with its MEMORY.md line (D5, D7)
 *   supersede <path> --by <path> [--json]
 *                                     status/superseded and superseded_by: the other memory carries it now (D7)
 *   draft approve|reject <slug> [--json]
 *                                     a feedback draft into the store, or rejected for good (feedback-apply.js's writes)
 *   notdup <path> <path> [--json]     the hub stops flagging the pair as duplicates (D11)
 *   fix <kind> [--dry-run] [--json]   a hygiene fix, no model (D20; lib/memory-fix.js): sources, types, descriptions,
 *                                     index or drafts, each acting on what brain-hub.json's hygiene lists; --dry-run
 *                                     prints the same changes and writes nothing (the page shows it before it asks)
 *
 * Safety (spec §6) lives in brain/scripts/lib/memory-ops.js: a path is brain/memory/<type>/<slug>.md for one of the four
 * types, read and written only as a regular file inside plain vault folders, and nothing is deleted except a draft that
 * is approved or rejected, or one `fix drafts` finds left behind. set, archive, restore, supersede and a real `fix types`
 * or `fix index` rebuild BRAIN.md in its own process (paths.js fixes the vault per process). No argument starts with
 * `-`. Runs from the checkout and from the vendored copy; zero dependencies; every external effect is injectable (opts).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERBS = ['list', 'keep', 'set', 'archive', 'restore', 'supersede', 'draft', 'notdup', 'fix'];
const REPO = path.join(__dirname, '..');
const VALUE_FLAGS = new Map([['set', 'set'], ['expect', 'expect'], ['by', 'by']]);
const BOOL_FLAGS = new Map([['json', 'json'], ['dry-run', 'dryRun']]);
const VERB_FLAGS = {
  list: ['json'], keep: ['json'], set: ['json', 'set', 'expect', 'dryRun'], archive: ['json'], restore: ['json'],
  supersede: ['json', 'by'], draft: ['json'], notdup: ['json'], fix: ['json', 'dryRun'],
};
const VERB_ARGS = {
  list: [0, 0], keep: [1, Infinity], set: [1, 1], archive: [1, Infinity], restore: [1, Infinity], supersede: [1, 1],
  draft: [2, 2], notdup: [2, 2], fix: [1, 1],
};
const USAGE = {
  list: 'aos memory list [--json]',
  keep: 'aos memory keep <path>… [--json]',
  set: 'aos memory set <path> --set <json> [--expect <hash>] [--dry-run] [--json]',
  archive: 'aos memory archive <path>… [--json]',
  restore: 'aos memory restore <path>… [--json]',
  supersede: 'aos memory supersede <path> --by <path> [--json]',
  draft: 'aos memory draft approve|reject <slug> [--json]',
  notdup: 'aos memory notdup <path> <path> [--json]',
  fix: 'aos memory fix sources|types|descriptions|index|drafts [--dry-run] [--json]',
};

class UsageError extends Error {}

function resolveScript(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(REPO, 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return p;
  throw new Error(`${rel} not found beside cli/memory.js — run \`aos upgrade\``);
}
function resolveModule(rel) { return require(resolveScript(rel)); }
const opsLib = () => resolveModule('lib/memory-ops.js');

function emit(io, json, obj, lines) {
  if (json) io.log(JSON.stringify(obj, null, 2));
  else for (const l of lines) io.log(l);
}

/** Library refusals read as `aos: <message>` (exit 1); a bad path is a usage error (exit 2). */
async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && e.code === 'BAD_PATH') throw new UsageError(e.message);
    throw e;
  }
}

/** build-brain-md in its own process, so BRAIN.md follows a pin or a status (cli/workspace.js runBrainMd). */
function runBrainMd(ctx, opts) {
  if (typeof opts.runScript === 'function') return opts.runScript('build-brain-md.js', []);
  try {
    const r = spawnSync(process.execPath, [resolveScript('build-brain-md.js')], {
      env: { ...(opts.env || process.env), AOS_VAULT: ctx.vault }, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) return { ok: true };
    return { ok: false, error: (r.error && r.error.message) || String(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── verbs ──

function listVerb(ctx, o) {
  const ops = opsLib();
  const memories = ops.listMemories(ctx.vault).map((m) => ({
    path: m.path, type: m.type, title: m.title, description: m.description, status: m.status, live: m.live, pin: m.pin,
    reviewed: m.reviewed === null ? null : m.reviewed === 'true', source: m.source, session: m.session,
    created: m.created, updated: m.updated, supersededBy: m.supersededBy, hash: m.hash,
  }));
  const drafts = ops.listDrafts(ctx.vault);
  const live = memories.filter((m) => m.live);
  const counts = {
    memories: live.length, unreviewed: live.filter((m) => m.reviewed === false).length, drafts: drafts.length,
    archived: memories.filter((m) => m.status === 'archived').length, superseded: memories.filter((m) => m.status === 'superseded').length,
  };
  emit(o.io, o.json, { schema: 1, memories, drafts, counts }, [
    `${counts.memories} memories · ${counts.unreviewed} to review · ${counts.drafts} drafts · ${counts.archived} archived · ${counts.superseded} superseded`,
    ...live.filter((m) => m.reviewed === false).slice(0, 20).map((m) => `  to review  ${m.path}  ${m.title}`),
  ]);
  return 0;
}

function keepVerb(ctx, paths, o) {
  const r = opsLib().keep(ctx.vault, paths);
  emit(o.io, o.json, r, [`kept ${r.kept.length}${r.already.length ? ` (${r.already.length} already kept)` : ''}`, ...r.kept.map((p) => `  ${p}`)]);
  return 0;
}

function setVerb(ctx, rel, o) {
  if (o.set === undefined) throw new UsageError(USAGE.set);
  let fields;
  try { fields = JSON.parse(o.set); } catch { throw new UsageError('aos memory set: --set takes a JSON object, e.g. {"pin":true}'); }
  const ops = opsLib();
  if (o.expect !== undefined && !ops.HASH_RE.test(o.expect)) throw new UsageError('aos memory set: --expect takes a hash as `aos memory list --json` prints it');
  const r = ops.setFields(ctx.vault, rel, fields, { expect: o.expect === undefined ? null : o.expect, dryRun: !!o.dryRun });
  const brainMd = r.written ? runBrainMd(ctx, o) : null;
  emit(o.io, o.json, { ...r, brainMd }, o.dryRun
    ? [`${r.path} would read:`, r.text]
    : [r.written ? `${r.path}: ${r.fields.join(', ')} set` : `${r.path} already says that`]);
  return 0;
}

function retireVerb(ctx, paths, o, kind) {
  const ops = opsLib();
  const r = kind === 'archive' ? ops.archive(ctx.vault, paths) : ops.restore(ctx.vault, paths);
  const done = kind === 'archive' ? r.archived : r.restored;
  const brainMd = done.length ? runBrainMd(ctx, o) : null;
  emit(o.io, o.json, { ...r, brainMd }, [
    `${kind === 'archive' ? 'archived' : 'restored'} ${done.length}${r.already.length ? ` (${r.already.length} already ${kind === 'archive' ? 'out' : 'live'})` : ''}`,
    ...done.map((p) => `  ${p}`),
  ]);
  return 0;
}

function supersedeVerb(ctx, rel, o) {
  if (o.by === undefined) throw new UsageError(USAGE.supersede);
  const r = opsLib().supersede(ctx.vault, rel, o.by);
  const brainMd = r.already ? null : runBrainMd(ctx, o);
  emit(o.io, o.json, { ...r, brainMd }, [r.already ? `${r.path} is already out` : `${r.path} superseded by ${r.by}`]);
  return 0;
}

/** Approve or reject through feedback-apply.js (one copy of the draft logic), after the same file checks as a memory. */
function draftVerb(ctx, action, slug, o) {
  if (action !== 'approve' && action !== 'reject') throw new UsageError(USAGE.draft);
  const ops = opsLib();
  if (!ops.SLUG_RE.test(slug)) throw new UsageError(`aos memory draft: not a draft name: ${slug}`);
  const dir = ops.plainDir(ctx.vault, 'brain/memory/feedback/_drafts');
  if (!dir || ops.readRegular(path.join(dir, `${slug}.md`), `feedback/_drafts/${slug}.md`) === null) {
    throw new Error(`no such draft: ${slug} (aos memory list --json names them)`);
  }
  const run = typeof o.runScript === 'function'
    ? o.runScript('feedback-apply.js', [`--${action}`, slug])
    : spawnSync(process.execPath, [resolveScript('feedback-apply.js'), `--${action}`, slug], {
      env: { ...(o.env || process.env), AOS_VAULT: ctx.vault }, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  if (run.status !== 0) throw new Error(String(run.stderr || '').trim().replace(/^error: /, '') || `feedback-apply.js exited ${run.status}`);
  const out = String(run.stdout || '').trim();
  const applied = /^applied: (.+)$/m.exec(out);
  const obj = action === 'approve' ? { approved: applied ? applied[1].trim() : null, slug } : { rejected: slug };
  emit(o.io, o.json, obj, [action === 'approve' ? `approved ${slug} → ${obj.approved}` : `rejected ${slug}: it is never drafted again`]);
  return 0;
}

function notdupVerb(ctx, a, b, o) {
  const ops = opsLib();
  const A = ops.readMemory(ctx.vault, a).rel;
  const B = ops.readMemory(ctx.vault, b).rel;
  if (A === B) throw new UsageError('aos memory notdup: two different memories');
  const pair = [A, B].sort();
  const dir = ops.plainDir(ctx.vault, 'brain/_index');
  if (!dir) throw new Error('brain/_index is missing: run `aos init` or `aos upgrade`');
  let added = false;
  resolveModule('lib/fsx.js').updateSync(path.join(dir, 'memory-notdup.json'), (raw) => {
    let doc = null;
    try { doc = raw ? JSON.parse(raw) : null; } catch { doc = null; }
    const pairs = doc && doc.schema === 1 && Array.isArray(doc.pairs) ? doc.pairs.filter((p) => Array.isArray(p) && p.length === 2) : [];
    if (pairs.some((p) => p[0] === pair[0] && p[1] === pair[1])) return raw;
    added = true;
    return JSON.stringify({ schema: 1, pairs: [...pairs, pair].sort((x, y) => (x.join('\n') < y.join('\n') ? -1 : 1)) }, null, 2) + '\n';
  }, { timeoutMs: 5000 });
  emit(o.io, o.json, { pair, added }, [added ? `${pair[0]} and ${pair[1]}: not duplicates` : 'already marked as not duplicates']);
  return 0;
}

/** One hygiene fix (D20): the changes it made, or with --dry-run would make; BRAIN.md follows a real types or index fix. */
function fixVerb(ctx, kind, o) {
  const r = resolveModule('lib/memory-fix.js').fix(ctx.vault, kind, { dryRun: !!o.dryRun });
  // types can add status/active (Active context) and index rewrites MEMORY.md: BRAIN.md is built from both.
  const brainMd = !r.dryRun && (kind === 'types' || kind === 'index') && r.files > 0 ? runBrainMd(ctx, o) : null;
  const show = (v) => (v === null || v === undefined ? '(none)' : v);
  emit(o.io, o.json, { ...r, brainMd }, [
    !r.changes.length ? `${kind}: nothing to fix` : `${r.dryRun ? 'would change' : 'changed'} ${r.files} file${r.files === 1 ? '' : 's'}`,
    ...r.changes.map((c) => `  ${c.path}  ${c.action}: ${show(c.before)} → ${show(c.after)}`),
    ...(brainMd && !brainMd.ok ? [`BRAIN.md was not rebuilt: ${brainMd.error}`] : []),
  ]);
  return 0;
}

// ── main ──

function parseMemoryArgs(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) {
      // No argument starts with `-` (as aos workspace): a stray `-x` is never a path or a slug.
      if (a.startsWith('-')) throw new UsageError(`aos memory: unknown flag ${a}`);
      words.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (VALUE_FLAGS.has(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new UsageError(`aos memory: --${name} needs a value`);
      flags[VALUE_FLAGS.get(name)] = String(v);
    } else if (BOOL_FLAGS.has(name) && eq === -1) {
      flags[BOOL_FLAGS.get(name)] = true;
    } else {
      throw new UsageError(`aos memory: unknown flag ${a}`);
    }
  }
  return { words, flags };
}

async function main(argv, opts = {}) {
  const io = opts.io || console;
  const { words, flags } = parseMemoryArgs(argv);
  const verb = words[0] || 'list';
  if (!VERBS.includes(verb)) throw new UsageError(`aos memory: unknown verb "${verb}" (${VERBS.join(' | ')})`);
  for (const k of Object.keys(flags)) {
    if (VERB_FLAGS[verb].includes(k)) continue;
    throw new UsageError(k === 'dryRun'
      ? 'aos memory: --dry-run is only supported by `aos memory set` and `aos memory fix`'
      : `aos memory ${verb}: --${k} is not one of its flags (${USAGE[verb]})`);
  }
  const args = words.slice(1);
  const [min, max] = VERB_ARGS[verb];
  if (args.length < min) throw new UsageError(USAGE[verb]);
  if (args.length > max) throw new UsageError(`${USAGE[verb]}: too many arguments`);
  if (verb === 'fix') {
    const kinds = resolveModule('lib/memory-fix.js').KINDS;
    if (!kinds.includes(args[0])) throw new UsageError(`aos memory fix: unknown kind "${args[0]}" (${kinds.join(' | ')})`);
  }
  // The vault as `aos workspace` resolves it (AOS_VAULT, else agenticos.json): workspace.js sits beside this file in the
  // checkout's cli/ and in the vault's vendored brain/scripts/cli/.
  const ctx = require('./workspace.js').resolveCtx(opts);
  const o = { ...opts, ...flags, io, json: !!flags.json, env: opts.env || ctx.env };
  return guarded(() => {
    switch (verb) {
      case 'list': return listVerb(ctx, o);
      case 'keep': return keepVerb(ctx, args, o);
      case 'set': return setVerb(ctx, args[0], o);
      case 'archive': return retireVerb(ctx, args, o, 'archive');
      case 'restore': return retireVerb(ctx, args, o, 'restore');
      case 'supersede': return supersedeVerb(ctx, args[0], o);
      case 'draft': return draftVerb(ctx, args[0], args[1], o);
      case 'notdup': return notdupVerb(ctx, args[0], args[1], o);
      case 'fix': return fixVerb(ctx, args[0], o);
      default: return 2;
    }
  });
}

module.exports = { VERBS, USAGE, UsageError, main, parseMemoryArgs };
