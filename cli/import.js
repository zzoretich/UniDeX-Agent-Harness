'use strict';
/**
 * import.js — `aos import`: bring a user's Claude Code and Codex history into the vault (install-import B2–B10, B15).
 *
 *   aos import [--from claude|codex|all] [--since 90d|all] [--only instructions,memories,projects,mcp,sessions]
 *              [--accept <json list>] [--dry-run] [--json]
 *
 * The work is the runtime's (brain/scripts/lib/import/: scan → instructions → memories → projects → mcp, then the
 * sessions queued for the import-digest routine); this verb resolves the vault, passes cli/workspace.js in for the
 * proposals the user accepted, and, when it turned the digest routine on, re-renders the installed schedules (as
 * `aos routines enable` would). `--dry-run` writes nothing and prints the scan: counts per host and kind and the proposed
 * workspaces (`--json` for the app's wizard). `--accept` names the proposals to create, by id (the `~/…` repository
 * path the scan prints) or slug, or as `{ "id": …, "name": … }` to rename one; without it a real run creates none and
 * says so. Runs from the checkout and from the vendored copy; zero dependencies; every effect injectable (opts).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const KINDS = ['instructions', 'memories', 'projects', 'mcp', 'sessions'];
const HOST_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const USAGE = 'aos import [--from claude|codex|all] [--since 90d|all] [--only instructions,memories,projects,mcp,sessions] [--accept <json list>] [--dry-run] [--json]';

class UsageError extends Error {}

function resolveScript(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(REPO, 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return p;
  throw new Error(`${rel} not found beside cli/import.js — run \`aos upgrade\``);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

/** The flags (`--x value`, `--x=value`, booleans), refusing anything else: a typo never starts a real import. */
function parseImportArgs(argv) {
  const flags = {};
  const words = [];
  const VALUES = new Set(['from', 'since', 'only', 'accept']);
  const BOOLS = new Map([['dry-run', 'dryRun'], ['json', 'json']]);
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) { words.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (VALUES.has(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new UsageError(`aos import: --${name} needs a value`);
      flags[name] = String(v);
    } else if (BOOLS.has(name) && eq === -1) flags[BOOLS.get(name)] = true;
    else throw new UsageError(`aos import: unknown flag ${a} (${USAGE})`);
  }
  if (words.length) throw new UsageError(`aos import takes no words (${USAGE})`);
  const from = flags.from || 'all';
  if (!['claude', 'codex', 'all'].includes(from)) throw new UsageError('aos import: --from takes claude, codex or all');
  const since = flags.since || '90d';
  if (since !== 'all' && !/^\d{1,5}d$/.test(since)) throw new UsageError('aos import: --since takes <n>d (90d) or all');
  const only = flags.only ? flags.only.split(',').map((s) => s.trim()).filter(Boolean) : KINDS;
  const bad = only.filter((k) => !KINDS.includes(k));
  if (bad.length) throw new UsageError(`aos import: --only takes ${KINDS.join(',')} (not ${bad.join(',')})`);
  let accept = null;
  if (flags.accept !== undefined) {
    try { accept = JSON.parse(flags.accept); } catch { throw new UsageError('aos import: --accept takes a JSON list, e.g. \'["~/code/app"]\''); }
    if (!Array.isArray(accept) || !accept.every((x) => typeof x === 'string' || (isPlainObject(x) && typeof x.id === 'string'))) {
      throw new UsageError('aos import: --accept takes a JSON list of ids (strings) or { "id", "name" } objects');
    }
    if (flags.dryRun) throw new UsageError('aos import: --accept creates workspaces, which --dry-run never does');
  }
  return { from: from === 'all' ? ['claude', 'codex'] : [from], since, only, accept, dryRun: !!flags.dryRun, json: !!flags.json };
}

function resolveCtx(opts = {}) {
  const env = opts.env || process.env;
  const configDir = path.resolve(opts.configDir || require(resolveScript('lib/host.js')).claudeConfigDir(env));
  const configFile = path.resolve(env.AOS_CONFIG || path.join(configDir, 'agenticos.json'));
  const user = readJson(configFile) || {};
  const configured = String(opts.vault || env.AOS_VAULT || user.vault || '').trim();
  if (!configured) throw new Error('no vault configured (run `aos init` first)');
  const vault = path.resolve(configured);
  if (!fs.existsSync(path.join(vault, 'brain', '_index'))) throw new Error(`${vault} is not a vault (no brain/_index) — run \`aos init\``);
  // lib/host.js hostDirs reads agenticos.json's claudeConfigDir, else the config dir this command read.
  const userConfig = { ...user, claudeConfigDir: user.claudeConfigDir || configDir };
  const defaults = readJson(resolveScript('config.default.json')) || {};
  const cfg = deepMerge(deepMerge(defaults, readJson(path.join(vault, 'brain', 'config.json')) || {}), userConfig);
  return { env, configDir, configFile, user, userConfig, vault, cfg, home: path.resolve(opts.home || os.homedir()) };
}

function plural(n, one, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

/** Why the local model is not ready, in words (provider.js reasons). */
function why(reason) {
  const words = {
    forced: 'provider is none', 'local-down': 'the local engine does not answer',
    'local-model-missing': 'its model is not pulled: aos local pull', 'claude-not-used': 'the provider is Claude Code, a hosted model',
    'codex-not-used': 'the provider is Codex, a hosted model',
  };
  return words[reason] || reason;
}

function scanLines(r) {
  const out = [];
  out.push(`${r.dryRun ? 'import scan (nothing written)' : 'import'}: ${r.windowDays ? `the last ${r.windowDays} days` : 'all history'} of ${r.from.map((h) => HOST_LABEL[h]).join(' and ')}`);
  for (const h of r.from) {
    const x = r.hosts[h];
    if (!x.present) { out.push(`  ${HOST_LABEL[h]} (${x.configDir}): nothing on disk`); continue; }
    const parts = [];
    if (x.instructions) parts.push(`${plural(x.instructions.files, 'instruction file')} (${plural(x.instructions.rules, 'rule')}${x.instructions.new !== undefined ? `, ${x.instructions.new} new` : ''})`);
    if (x.memories && h === 'claude') parts.push(`${plural(x.memories.files, 'memory file')}${x.memories.new !== undefined ? ` (${x.memories.new} new)` : ''}`);
    if (x.sessions !== undefined) parts.push(`${plural(x.sessions, 'session')} to digest`);
    if (x.mcp) parts.push(`${plural(x.mcp.servers, 'MCP server')}`);
    out.push(`  ${HOST_LABEL[h]} (${x.configDir}): ${parts.join(' · ') || 'nothing to import'}`);
  }
  const ins = r.only.includes('instructions');
  const ses = r.only.includes('sessions');
  if (ins || ses) {
    const what = r.engine.ready
      ? [ins && 'rules are sorted by type', ses && 'the digest runs'].filter(Boolean).join(', and ')
      : [ins && 'each instruction file imports as one note', ses && 'the digest waits until it is'].filter(Boolean).join(', and ');
    out.push(r.engine.ready ? `  local model: ready${r.engine.model ? ` (${r.engine.model})` : ''}: ${what}` : `  local model: not ready (${why(r.engine.reason)}): ${what}`);
  }
  const p = r.projects;
  if (p && p.proposals.length) {
    out.push(`proposed workspaces (${p.proposals.length}):`);
    for (const x of p.proposals) {
      out.push(`  ${x.id}  →  ${x.action === 'new' ? `new workspace ${x.slug}` : `link to workspace ${x.into} (${x.link === 'repo' ? 'repo:' : 'aliases:'})`}  · ${x.reason}; claude ${x.claude}, codex ${x.codex}`);
    }
  } else if (p) out.push('proposed workspaces: none');
  return out;
}

function resultLines(r) {
  const out = [];
  const p = r.projects;
  if (p) {
    for (const c of p.created || []) out.push(`  created workspaces/${c.slug} (repo: ${c.repo})`);
    for (const l of p.linked || []) out.push(`  linked ${l.repo} to ${l.into} (${l.how === 'repo' ? 'repo:' : 'aliases:'})`);
    for (const f of p.failed || []) out.push(`  could not create ${f.id}: ${f.reason}`);
    for (const u of p.unknown || []) out.push(`  --accept named ${u}, which is not a proposal`);
    if (p.note) out.push(`  ${p.proposals.length} proposed, none created: pass --accept '${JSON.stringify(p.proposals.map((x) => x.id))}' (or a subset) to create them`);
  }
  if (r.mcp && r.mcp.file) out.push(`  MCP servers listed in ${r.mcp.file} (host configs untouched)`);
  if (r.written) out.push(`  ${plural(r.written, 'memory', 'memories')} written for Brain ▸ Review (reviewed: false)`);
  if (r.sessions) {
    out.push(r.sessions.queued
      ? `  ${plural(r.sessions.queued, 'session')} queued for the import-digest routine (every 30 minutes on the local model${r.engine.ready ? '' : `, once it is ready: ${why(r.engine.reason)}`})`
      : '  no sessions to digest');
  }
  return out;
}

/**
 * The import-digest routine was just turned on: re-render the installed schedules so it fires (nothing when none are
 * installed; `aos routines sync` installs them). → a line to print.
 */
function scheduleDigest(ctx, opts = {}) {
  const S = opts.schedule || require('./schedule.js');
  const platform = opts.platform || process.platform;
  try {
    if (!(opts.isInstalled || S.isInstalled)({ platform, vault: ctx.vault })) {
      return 'the import-digest routine is on; no schedules are installed here, so run `aos routines sync` (or `aos routines run import-digest` now)';
    }
    const { scheduleVarsFor } = require('./routines.js');
    const { stableNode } = require('./node-path.js');
    const vars = scheduleVarsFor({ vault: ctx.vault, configDir: ctx.configDir, node: stableNode(ctx.user.node || process.execPath), cfg: ctx.user });
    const r = (opts.installSchedules || S.installSchedules)({ vars, platform, warn: () => {} });
    return r.unsupported ? `scheduling is not supported on ${r.platform}; run \`aos routines run import-digest\`` : 'the import-digest routine is on and scheduled';
  } catch (e) {
    return `the import-digest routine is on; scheduling it failed (${e.message}): run \`aos routines sync\``;
  }
}

/**
 * Run the import from parsed options (cli/hosts.js calls this too). opts: io, env, configDir, vault, home, provider,
 * tmpDirs, gitCeiling, schedule seams. → { code, report }
 */
async function runWith(args, opts = {}) {
  const io = opts.io || console;
  const ctx = resolveCtx(opts);
  // The runtime's writers resolve the vault through lib/paths.js: this one, whatever the shell exported.
  process.env.AOS_VAULT = ctx.vault;
  const { runImport } = require(resolveScript('lib/import/index.js'));
  const W = opts.workspace || require('./workspace.js');
  const report = await runImport({
    vault: ctx.vault, cfg: ctx.cfg, userConfig: ctx.userConfig, env: ctx.env, home: ctx.home, now: opts.now,
    from: args.from, only: args.only, since: args.since, dryRun: args.dryRun, accept: args.accept,
    workspace: W, wsOpts: { vault: ctx.vault, configDir: ctx.configDir, env: ctx.env, home: ctx.home, ...(opts.tmpDirs ? { tmpDirs: opts.tmpDirs } : {}) },
    provider: opts.provider, tmpDirs: opts.tmpDirs, gitCeiling: opts.gitCeiling,
    log: args.json ? null : (l) => io.log(`- ${l}`),
  });
  if (report.sessions && report.sessions.routineChanged) report.sessions.schedule = scheduleDigest(ctx, opts);
  if (args.json) io.log(JSON.stringify(report, null, 2));
  else {
    for (const l of scanLines(report)) io.log(l);
    if (!report.dryRun) {
      for (const l of resultLines(report)) io.log(l);
      if (report.sessions && report.sessions.schedule) io.log(`  ${report.sessions.schedule}`);
    } else if (report.projects && report.projects.proposals.length) {
      io.log(`run \`aos import\` to import; add --accept '${JSON.stringify(report.projects.proposals.map((x) => x.id))}' (or a subset) to create the workspaces`);
    }
  }
  return { code: 0, report };
}

/** `argv` = the words after `aos import`. → exit code */
async function main(argv, opts = {}) {
  const args = parseImportArgs(argv);
  const { code } = await runWith(args, opts);
  // install-import B12: the upgrade to 2.0 printed `aos import`; a real run from both hosts settles that choice, so the
  // app's launch sequence does not offer it again (cli/migrations.js).
  if (!args.dryRun && args.from.length === 2) {
    try { require('./migrations.js').settle(resolveCtx(opts).vault, 'import', 'applied', opts.now || new Date()); } catch { /* no vault: nothing to settle */ }
  }
  return code;
}

module.exports = { main, runWith, parseImportArgs, resolveCtx, scheduleDigest, scanLines, resultLines, UsageError, KINDS, USAGE };
