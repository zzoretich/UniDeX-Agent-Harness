'use strict';
/**
 * local.js — `aos local` (spec 2026-10-14-local-first A8, A12, A13, A18): the local engine background work runs on.
 *   (none) | status [--json]  the engine and its address, whether it answers, the models pulled, this Mac's tier, the
 *                             model background work runs on now (or why none), and today's local calls
 *   pull [model…]             download this Mac's workhorse and embedder (or the models named) through Ollama
 *   use <model>               local.model = <model>, through `aos config set`; warns when it is not pulled
 * Runs from the checkout (node cli/aos.js) and from the vendored <vault>/brain/scripts/cli/ (the aos launcher): lib/ is
 * looked up next to this file first, then in the checkout. AOS_SKIP_OLLAMA_PROBE=1 (tests, offline rehearsals) skips
 * asking the engine.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const USAGE = 'usage: aos local [status [--json] | pull [model…] | use <model>]';
const GB = 1024 ** 3;

class UsageError extends Error {}

function resolveModule(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(REPO, 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return require(p);
  throw new Error(`${rel} not found beside cli/local.js — run \`aos upgrade\``);
}

/** Point the runtime at the vault before its modules load (lib/paths.js fixes it on first require). */
function runtime(opts) {
  const ctx = require('./workspace.js').resolveCtx(opts);
  process.env.AOS_VAULT = ctx.vault;
  return {
    ctx,
    cfg: resolveModule('lib/config.js').loadConfig(),
    P: resolveModule('sdk/lib/provider.js'),
    M: resolveModule('sdk/lib/models.js'),
    O: resolveModule('sdk/lib/ollama.js'),
    U: resolveModule('sdk/lib/local-usage.js'),
  };
}

const skipped = (env) => env.AOS_SKIP_OLLAMA_PROBE === '1';

/** Everything `status` shows, as one object (the --json shape). */
async function report(opts = {}) {
  const env = opts.env || process.env;
  const { cfg, P, M, O, U } = runtime(opts);
  const lc = P.localCfg(cfg);
  const memGb = Math.round((M.totalMemBytes() / GB) * 10) / 10;
  const probed = !skipped(env);
  const list = probed ? await (opts.deps && opts.deps.localModels ? opts.deps.localModels(lc) : P.listLocalModels(lc)) : null;
  const pulled = Array.isArray(list) ? list : [];
  const has = (tag) => pulled.some((m) => O.sameModel(m, tag));
  const running = Array.isArray(list) ? P.pickLocalModel(lc.workhorse, pulled) : null;
  const why = !probed ? 'not probed (AOS_SKIP_OLLAMA_PROBE=1)'
    : !Array.isArray(list) ? `nothing answers at ${lc.url}`
      : !running ? `${lc.workhorse.tag} is not pulled — aos local pull` : null;
  return {
    provider: cfg.provider || 'auto',
    engine: lc.engine,
    url: lc.url,
    reachable: Array.isArray(list),
    probed,
    memoryGb: memGb,
    tier: M.workhorseForMemory(),
    workhorse: { tag: lc.workhorse.tag, source: lc.workhorse.source, pulled: has(lc.workhorse.tag), running, keepAlive: lc.workhorse.keepAlive },
    embedder: { tag: lc.embedder.tag, pulled: has(lc.embedder.tag) },
    hostedFallback: lc.hostedFallback,
    models: pulled,
    why,
    today: U.localUsageToday(),
  };
}

function statusLines(r) {
  const yes = (b) => (b ? 'yes' : 'no');
  const lines = [
    `provider   ${r.provider}${r.provider === 'local' ? (r.hostedFallback ? ' (Claude/Codex when local is down)' : ' (never spends)') : ' — background work is local only with provider local (aos provider local)'}`,
    `engine     ${r.engine} at ${r.url} · ${r.probed ? (r.reachable ? 'answering' : 'not answering') : 'not probed'}`,
    `this Mac   ${r.memoryGb} GB · tier ${r.tier}`,
    `workhorse  ${r.workhorse.tag} (${r.workhorse.source}) · pulled ${yes(r.workhorse.pulled)} · keep loaded ${r.workhorse.keepAlive === -1 ? 'always' : r.workhorse.keepAlive}`,
    `embedder   ${r.embedder.tag} · pulled ${yes(r.embedder.pulled)}${r.embedder.pulled ? '' : ' (recall uses keyword search)'}`,
    `running on ${r.workhorse.running || `nothing: ${r.why}`}`,
    `today      ${r.today.calls} local call${r.today.calls === 1 ? '' : 's'}${r.today.calls ? ` · ${Math.round(r.today.ms / 1000)} s` : ''}`,
  ];
  if (r.models.length) lines.push(`pulled     ${r.models.join(', ')}`);
  return lines;
}

async function statusVerb(opts) {
  const r = await report(opts);
  if (opts.json) opts.io.log(JSON.stringify(r, null, 2));
  else for (const l of statusLines(r)) opts.io.log(l);
  return 0;
}

/** Ollama's /api/pull for each model, a line per status change and per 10% of a download. */
async function pullVerb(models, opts) {
  const { cfg, P, O } = runtime(opts);
  const lc = P.localCfg(cfg);
  if (lc.engine !== 'ollama') throw new Error(`the local engine is ${lc.engine} at ${lc.url}: download models in that server's own app`);
  const wanted = models.length ? models : [lc.workhorse.tag, lc.embedder.tag];
  const pull = (opts.deps && opts.deps.pull) || O.pull;
  for (const model of wanted) {
    opts.io.log(`pulling ${model}…`);
    let last = '';
    let tenth = -1;
    await pull(model, {
      ...lc.net,
      onProgress: (m) => {
        if (m.total && m.completed != null) {
          const t = Math.floor((m.completed / m.total) * 10);
          if (t !== tenth) { tenth = t; opts.io.log(`  ${t * 10}% of ${(m.total / 1e9).toFixed(1)} GB`); }
        } else if (m.status && m.status !== last) { last = m.status; opts.io.log(`  ${m.status}`); }
      },
    });
  }
  opts.io.log(`done: ${wanted.join(', ')}`);
  return 0;
}

async function useVerb(model, opts) {
  if (!model) throw new UsageError(USAGE);
  const code = await require('./config-cmd.js').main(['set', 'local.model', model], { io: opts.io, env: opts.env });
  if (code !== 0) return code;
  const r = await report(opts);
  if (r.probed && r.reachable && !r.workhorse.pulled) opts.io.log(`note: ${model} is not pulled yet — aos local pull ${model}`);
  return 0;
}

async function main(argv, opts = {}) {
  const io = opts.io || console;
  const [verb = 'status', ...args] = argv.filter((a) => a !== '--json');
  const o = { ...opts, io, json: argv.includes('--json'), env: opts.env || process.env };
  switch (verb) {
    case 'status': if (args.length) throw new UsageError(USAGE); return statusVerb(o);
    case 'pull': return pullVerb(args, o);
    case 'use': if (args.length !== 1) throw new UsageError(USAGE); return useVerb(args[0], o);
    default: throw new UsageError(USAGE);
  }
}

module.exports = { main, report, statusLines, UsageError, USAGE };
