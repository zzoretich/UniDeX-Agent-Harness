#!/usr/bin/env node
'use strict';
/**
 * graph-build.js — keeps the vault knowledge graph current (spec 2026-09-23-graphify D5, D7, D8).
 * Structural pass: `graphify update <vault>` with GRAPHIFY_OUT=<vault>/<graph.out> — no model, no network, about
 * a second or two for a few hundred notes. scan-vault runs it inline as its `graph-build` stage (scan-vault is itself
 * detached when a hook fires it); `aos graph build` runs this file directly.
 *   - one lock for both passes (brain/_index/.graph.lock.json, see withGraphLock): graphify never runs twice at once
 *   - graph.json → graph.json.prev before every run; graphify's own dated backups are off (GRAPHIFY_NO_BACKUP=1)
 *   - "Cannot read … for incremental merge" (a torn graph.json) → delete it and rebuild once (--force does not help)
 *   - the child env drops API-key variables, so graphify's backend auto-detect can never select a paid backend
 * Always the vault root, passed explicitly: another root re-keys every node path (spike, spec §4.7).
 * Semantic pass (D5, D6, D10, D11; `--semantic`): `graphify extract <vault> --backend claude-cli` with the claude shim
 * (bin/graph-shim/claude → graph-claude.js) first on PATH, one call per chunk, --allow-partial, under the same lock.
 * Under provider local or ollama it runs on the local engine instead (local-first A14): graphify's own `ollama` backend
 * (OLLAMA_BASE_URL=<url>/v1, OLLAMA_MODEL=<the pulled workhorse>), or `openai` for an OpenAI-compatible server, one
 * chunk at a time, no shim, no spend and no graph budget; it waits while the engine is down or the model is not pulled
 * (the next scan asks again), and on battery while local.onBattery is `defer` (A18).
 * scan-vault spawns it detached at most every graph.semantic.everyHours; `aos graph build --semantic` runs it with
 * --force (not waiting for it to be due, and running even when the background pass is switched off).
 * Flags: --quiet (no stdout summary) · --semantic [--force].
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PATHS } = require('./lib/paths.js');
const { loadConfig } = require('./lib/config.js');
const { dayCap } = require('./lib/settings-schema.js');
const { withReport } = require('./lib/pipeline-report.js');
const G = require('./sdk/lib/graph.js');
const { graphSpendToday } = require('./sdk/lib/spend-ledger.js');

// One graph lock for both passes (D7): graphify's `extract` takes none of its own. The lock is a JSON file created with
// O_EXCL that names its owner — the pass, its pid, when it started, and the deadline its own timeout sets — so a waiter
// breaks it only when that pid is gone or that deadline has passed, never while a live pass is inside. (0.11.0 judged
// staleness by the WAITER's timeout: a scan's 3-minute structural wait broke a 30-minute semantic run's lock.)
const LOCK = path.join(PATHS.INDEX, '.graph.lock.json');
const UNREADABLE_GRACE_MS = 60_000;   // a lock file caught between create and write (or torn) is honoured this long
const SHIM_DIR = path.join(__dirname, 'bin', 'graph-shim');
const SECRET_ENV = /(_API_KEY|_API_TOKEN)$|^(AWS|AZURE)_/;

function isExecutable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The graph lock's owner ({ mode, pid, startedAt, until }) while a live pass holds it, else null. */
function lockOwner(now = Date.now()) {
  let st;
  let raw;
  try { st = fs.statSync(LOCK); raw = fs.readFileSync(LOCK, 'utf8'); } catch { return null; }
  let o = null;
  try { o = JSON.parse(raw); } catch { o = null; }
  if (!o || typeof o !== 'object') {
    return now - st.mtimeMs < UNREADABLE_GRACE_MS ? { mode: null, pid: null, startedAt: new Date(st.mtimeMs).toISOString(), until: null } : null;
  }
  return pidAlive(o.pid) && now < Date.parse(o.until) ? o : null;
}

/** Runs fn holding the graph lock → { value }; or { busy: owner } without running it while a live pass holds the lock. */
async function withGraphLock(mode, timeoutMs, fn) {
  const mine = { schema: 1, mode, pid: process.pid, id: require('crypto').randomUUID(), startedAt: new Date().toISOString(), until: new Date(Date.now() + timeoutMs + 60_000).toISOString() };
  const create = () => {
    let fd;
    try { fd = fs.openSync(LOCK, 'wx'); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    try { fs.writeSync(fd, JSON.stringify(mine)); } finally { fs.closeSync(fd); }
    return true;
  };
  if (!create()) {
    const held = lockOwner();
    if (held) return { busy: held };
    fs.rmSync(LOCK, { force: true });   // its owner is gone, or past the deadline it set itself
    if (!create()) return { busy: lockOwner() || { mode: null, startedAt: null } };
  }
  try {
    return { value: await fn() };
  } finally {
    // Release only our own lock: past our deadline a waiter may have broken it and taken it.
    try {
      const o = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      if (o.id === mine.id) fs.rmSync(LOCK, { force: true });
    } catch { /* already gone */ }
  }
}

/** "semantic pass running since 16:47" — the skip reason a busy lock gives, for the ledger and the HUD. */
function busyReason(o) {
  const what = o.mode === 'semantic' ? 'semantic pass' : o.mode === 'structural' ? 'structural pass' : 'another graph build';
  const at = Date.parse(o.startedAt || '');
  return `${what} running${at ? ` since ${new Date(at).toTimeString().slice(0, 5)}` : ''}`;
}

/** Why the structural pass will not run for this config ('graph off' | 'graphify missing'), or null. */
function skipReason(cfg) {
  const g = (cfg && cfg.graph) || {};
  if (g.enabled === false) return 'graph off';
  if (!g.bin || !isExecutable(g.bin)) return 'graphify missing';
  return null;
}

/** The env graphify runs with: the caller's, minus credential variables, plus the output dir and no dated backups. */
function childEnv(base, out) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!SECRET_ENV.test(k)) env[k] = v;
  env.GRAPHIFY_OUT = out;
  env.GRAPHIFY_NO_BACKUP = '1';
  return env;
}

function lastLine(s) { return String(s || '').trim().split('\n').filter(Boolean).pop() || ''; }

function structural({ report, g, vault, out, timeoutMs, spawn, now }) {
  fs.mkdirSync(out, { recursive: true });
  const graphFile = path.join(out, 'graph.json');
  if (fs.existsSync(graphFile)) fs.copyFileSync(graphFile, graphFile + '.prev');
  const env = childEnv(process.env, out);
  const t0 = Date.now();
  const update = () => spawn(g.bin, ['update', vault], { cwd: vault, env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  let r = update();
  if (r.status !== 0 && /for incremental merge/.test(r.stderr || '')) {
    fs.rmSync(graphFile, { force: true });
    report.counts.recovered = 1;
    r = update();
  }
  if ((r.error && r.error.code === 'ETIMEDOUT') || r.signal) throw new Error(`graphify update timed out after ${timeoutMs / 1000}s`);
  if (r.error) throw new Error(`graphify could not start: ${r.error.message}`);
  if (r.status !== 0) {
    const msg = lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.status}`;
    if (/nothing to rebuild/i.test(msg)) { report.skip('nothing to graph'); return { status: 'skipped', reason: 'nothing to graph' }; }
    throw new Error(`graphify update exited ${r.status}: ${msg}`);
  }
  const graph = G.loadGraph(graphFile);
  if (!graph) throw new Error(`graphify update left no readable ${graphFile}`);
  const o = G.overview(graph, { hubs: 0, communities: 0 });
  const prev = G.readMarker(out) || {};
  const at = now().toISOString();
  // Every semantic field of the previous marker is kept — above all lastSemanticRun, the due check's clock. (0.11.1 and
  // earlier kept only lastSemantic, so each scan made the daily semantic pass look due again.)
  const marker = {
    ...prev, mode: prev.lastSemantic ? 'semantic' : 'structural', builtAt: at, lastStructural: at,
    lastSemantic: prev.lastSemantic || null, nodes: o.nodes, edges: o.edges, communities: o.communities, ms: Date.now() - t0,
  };
  G.writeMarker(out, marker);
  Object.assign(report.counts, { nodes: o.nodes, edges: o.edges, communities: o.communities });
  report.wrote.push(path.relative(vault, graphFile));
  return { status: 'ok', out, ...marker };
}

/** The `graph-build` stage body: fn(report) for withReport. Resolves to { status, reason? | out, nodes, edges, … }. */
async function buildStructural({ report, cfg = loadConfig(), vault = PATHS.VAULT, spawn = spawnSync, now = () => new Date() } = {}) {
  const why = skipReason(cfg);
  if (why) { report.disable(why); return { status: 'disabled', reason: why }; }
  const g = cfg.graph;
  const out = G.outDir(vault, g);
  const timeoutMs = Math.max(1, Number(g.timeoutSec) || 120) * 1000;
  const r = await withGraphLock('structural', timeoutMs, () => structural({ report, g, vault, out, timeoutMs, spawn, now }));
  if (r.busy) { const why = busyReason(r.busy); report.skip(why); return { status: 'skipped', reason: why }; }
  return r.value;
}

// ── semantic pass ─────────────────────────────────────────────────────────────
/** D11: "auto" follows the provider (an explicit none means no background model calls; under local and ollama the pass
 *  runs on the local engine, local-first A14, so it never reaches a hosted model); true/false override. */
function semanticState(cfg) {
  const v = cfg && cfg.graph && cfg.graph.semantic ? cfg.graph.semantic.enabled : 'auto';
  if (v === true) return { on: true, why: null };
  if (v === false) return { on: false, why: 'semantic off' };
  const p = (cfg && cfg.provider) || 'auto';
  if (p === 'none') return { on: false, why: `provider ${p}` };
  return { on: true, why: null };
}

/** Graphify's token budget per chunk on the local engine: graphify sizes Ollama's context from it, so a chunk past this
 *  would ask a small local model for a context its Mac cannot hold (models.js numCtxCap is 32k). */
const LOCAL_TOKEN_BUDGET = 8000;

/**
 * The local engine's target for one pass (local-first A14): is it up, and which pulled model runs it (provider.js's
 * pickLocalModel: a tier model may give way to another pulled tier model, a named one never does).
 * → { ok: true, engine, url, model } | { ok: false, reason: 'local-down' | 'local-model-missing' }
 */
async function localTarget(cfg, deps = {}) {
  const P = require('./sdk/lib/provider.js');
  const lc = P.localCfg(cfg);
  const list = await (deps.localModels || P.listLocalModels)(lc);
  if (!Array.isArray(list)) return { ok: false, reason: 'local-down' };
  const model = P.pickLocalModel(lc.workhorse, list);
  if (!model) return { ok: false, reason: 'local-model-missing' };
  return { ok: true, engine: lc.engine, url: lc.url, base: require('./sdk/lib/local-config.js').openaiBase(lc), model, keepAlive: lc.workhorse.keepAlive };
}

/**
 * Why the semantic pass will not run now — { status: 'disabled' | 'skipped', reason } — or null when it should.
 * `force` (the foreground command) skips the due check and overrides `semantic off`, never a provider opt-out.
 */
/** The CLI behind the graph shim: lib/headless.js graphRunner (a pin, an explicit provider, else Claude, else Codex). */
function semanticRunner(cfg) { return require('./lib/headless.js').graphRunner(cfg); }

function semanticSkip(cfg, { vault = PATHS.VAULT, now = new Date(), force = false, runner, power } = {}) {
  const why = skipReason(cfg);
  if (why) return { status: 'disabled', reason: why };
  const st = semanticState(cfg);
  if (!st.on && !(force && st.why === 'semantic off')) return { status: 'disabled', reason: st.why };
  const sem = cfg.graph.semantic || {};
  const m = G.readMarker(G.outDir(vault, cfg.graph)) || {};
  const last = Date.parse(m.lastSemanticRun || '');
  if (!force && last && now - last < (Number(sem.everyHours) || 24) * 3_600_000) return { status: 'skipped', reason: 'not due' };
  const r = runner === undefined ? semanticRunner(cfg) : runner;
  if (r && r.host === 'local') {
    // The local engine spends nothing (no graph budget), but a pass is heavy: on battery it waits for the charger (A18);
    // the foreground command (--force) runs anyway.
    if (!force && require('./lib/power.js').deferOnBattery(cfg, power ? { onBattery: power } : {})) return { status: 'skipped', reason: 'on battery' };
    return null;
  }
  if (graphSpendToday(now) >= dayCap(sem.perDayUsd, 1)) return { status: 'skipped', reason: 'graph budget reached' };
  if (!r) return { status: 'disabled', reason: 'no claude or codex CLI' };
  return null;
}

/**
 * graphify's argv and environment for the local engine (A14): the `ollama` backend at Ollama's OpenAI-compatible /v1
 * (or `openai` at an OpenAI-compatible server's url), the pulled model by env, a placeholder key (both backends refuse
 * to start without one; the server ignores it), one chunk at a time, and the workhorse's residency on Macs under 24 GB.
 */
function localExtract(target, sem, vault, base) {
  const budget = Math.min(Number(sem.tokenBudget) || 20000, LOCAL_TOKEN_BUDGET);
  const env = target.engine === 'openai'
    ? { ...base, OPENAI_BASE_URL: target.base, OPENAI_MODEL: target.model, OPENAI_API_KEY: 'local' }
    : { ...base, OLLAMA_BASE_URL: target.base, OLLAMA_MODEL: target.model, OLLAMA_API_KEY: 'local',
      ...(typeof target.keepAlive === 'string' ? { GRAPHIFY_OLLAMA_KEEP_ALIVE: target.keepAlive } : {}) };
  const args = ['extract', vault, '--backend', target.engine === 'openai' ? 'openai' : 'ollama', '--token-budget', String(budget), '--allow-partial', '--max-concurrency', '1'];
  return { args, env };
}

function semantic({ report, cfg, g, vault, out, timeoutMs, runner, spawn, now, target, recordLocal }) {
  const sem = g.semantic || {};
  fs.mkdirSync(out, { recursive: true });
  const graphFile = path.join(out, 'graph.json');
  if (fs.existsSync(graphFile)) fs.copyFileSync(graphFile, graphFile + '.prev');
  const startedAt = now().toISOString();
  // Stamped before the run: a crash or a kill still waits everyHours instead of retrying at every scan.
  G.writeMarker(out, { ...(G.readMarker(out) || {}), lastSemanticRun: startedAt });
  const local = runner.host === 'local';
  let args;
  let env;
  if (local) ({ args, env } = localExtract(target, sem, vault, childEnv(process.env, out)));
  else {
    try { fs.chmodSync(path.join(SHIM_DIR, 'claude'), 0o755); } catch { /* read-only install: the mode it shipped with */ }
    const model = (cfg.claude && cfg.claude.model) || 'haiku';
    env = {
      ...childEnv(process.env, out),
      PATH: `${SHIM_DIR}${path.delimiter}${process.env.PATH || ''}`,
      GRAPHIFY_CLAUDE_CLI_MODEL: model,            // graphify's own default is Opus; the shim forces this model anyway
      GRAPHIFY_MAX_RETRY_DEPTH: '0',               // one call per chunk: calls ≤ chunks
      // The shim answers through the runner's CLI (graph-claude.js): the real `claude`, or `codex exec` behind the same envelope.
      AOS_GRAPH_RUNNER: runner.host,
      ...(runner.host === 'codex' ? { AOS_GRAPH_CODEX_BIN: runner.bin } : { AOS_GRAPH_CLAUDE_BIN: runner.bin }),
      AOS_NODE: process.execPath,
      AOS_VAULT: vault,
      ...(process.env.ANTHROPIC_API_KEY ? { AOS_GRAPH_ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
    };
    args = ['extract', vault, '--backend', 'claude-cli', '--token-budget', String(Number(sem.tokenBudget) || 20000), '--allow-partial'];
  }
  const before = graphSpendToday();
  const t0 = Date.now();
  const r = spawn(g.bin, args, {
    cwd: vault, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // A local pass spends nothing; it counts as one local call (local-usage.json, A18), whatever graphify asked.
  if (local) { try { (recordLocal || require('./sdk/lib/local-usage.js').recordLocalCall)({ feature: 'graph:semantic', ms: Date.now() - t0 }); } catch { /* a counter */ } }
  const usd = local ? 0 : Math.round((graphSpendToday() - before) * 1e6) / 1e6;
  const fail = (msg) => {
    G.writeMarker(out, { ...(G.readMarker(out) || {}), lastSemanticRun: startedAt, lastSemanticError: msg });
    throw new Error(msg);
  };
  if ((r.error && r.error.code === 'ETIMEDOUT') || r.signal) fail(`graphify extract timed out after ${timeoutMs / 1000}s`);
  if (r.error) fail(`graphify could not start: ${r.error.message}`);
  if (r.status !== 0) fail(`graphify extract exited ${r.status}: ${lastLine(r.stderr) || lastLine(r.stdout) || 'no output'}`);
  const graph = G.loadGraph(graphFile);
  if (!graph) fail(`graphify extract left no readable ${graphFile}`);
  const o = G.overview(graph, { hubs: 0, communities: 0 });
  const concepts = graph.nodes.filter((n) => n.file_type === 'concept').length;
  const inferred = graph.links.filter((l) => l.confidence === 'INFERRED').length;
  const incomplete = /incomplete/i.test(r.stderr || '');
  // Why a run was partial, in graphify's words (the last warning or error line it printed): doctor and status show it.
  const partialWhy = incomplete ? (String(r.stderr || '').split('\n').map((l) => l.trim()).filter((l) => /incomplete|fail|error|budget|refus/i.test(l)).pop() || null) : null;
  const at = now().toISOString();
  const marker = {
    ...(G.readMarker(out) || {}), mode: 'semantic', builtAt: at, lastSemantic: at, lastSemanticRun: startedAt, lastSemanticError: null,
    semanticIncomplete: incomplete, semanticPartialWhy: partialWhy, semanticUsd: usd, nodes: o.nodes, edges: o.edges, communities: o.communities, concepts, inferred,
    // Who read the notes: doctor and `aos graph status` name it (local-first A14).
    semanticEngine: local ? 'local' : runner.host, semanticModel: local ? target.model : null,
    ms: Date.now() - t0,
  };
  G.writeMarker(out, marker);
  report.provider = local ? 'ollama' : runner.host;
  Object.assign(report.counts, { nodes: o.nodes, edges: o.edges, concepts, inferred, usd, incomplete: incomplete ? 1 : 0 });
  report.wrote.push(path.relative(vault, graphFile));
  return { status: 'ok', out, ...marker };
}

/** The `graph-semantic` report body: fn(report) for withReport. */
async function buildSemantic({ report, cfg = loadConfig(), vault = PATHS.VAULT, force = false, spawn = spawnSync, now = () => new Date(), runner, power, deps = {} } = {}) {
  const r0 = runner === undefined ? semanticRunner(cfg) : runner;
  const sk = semanticSkip(cfg, { vault, now: now(), force, runner: r0, power });
  if (sk) { if (sk.status === 'disabled') report.disable(sk.reason); else report.skip(sk.reason); return sk; }
  // The local engine down or its model not pulled: nothing is stamped, so the next scan asks again (A3).
  let target = null;
  if (r0.host === 'local') {
    target = await localTarget(cfg, deps);
    if (!target.ok) { report.skip(target.reason); return { status: 'skipped', reason: target.reason }; }
  }
  const g = cfg.graph;
  const out = G.outDir(vault, g);
  const timeoutMs = Math.max(1, Number((g.semantic || {}).timeoutSec) || 1800) * 1000;
  const r = await withGraphLock('semantic', timeoutMs, () => semantic({ report, cfg, g, vault, out, timeoutMs, runner: r0, spawn, now, target, recordLocal: deps.recordLocalCall }));
  if (r.busy) { const why = busyReason(r.busy); report.skip(why); return { status: 'skipped', reason: why }; }
  return r.value;
}

/** scan-vault's kick: the pass in a detached process, which records its own `graph-semantic` report. */
function spawnSemantic({ spawnFn = require('child_process').spawn } = {}) {
  if (process.env.AOS_NO_SPAWN === '1') return false;
  const child = spawnFn(process.execPath, [__filename, '--semantic', '--quiet'], { detached: true, stdio: 'ignore', env: { ...process.env, AOS_DETACHED: '1' } });
  child.unref();
  return true;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const semanticRun = args.includes('--semantic');
  const run = semanticRun
    ? withReport('graph-semantic', (report) => buildSemantic({ report, force: args.includes('--force') }))
    : withReport('graph-build', (report) => buildStructural({ report }));
  run
    .then((r) => {
      if (quiet) return;
      if (r.status !== 'ok') console.log(`graph: ${semanticRun ? 'semantic pass ' : ''}${r.status} (${r.reason})`);
      else if (semanticRun) console.log(`graph: semantic pass ${r.semanticIncomplete ? 'incomplete (the rest follows on the next runs)' : 'done'} · ${r.nodes} nodes · ${r.concepts} concepts · ${r.inferred} inferred edges · ${r.semanticEngine === 'local' ? `local ${r.semanticModel}, no spend` : `$${r.semanticUsd.toFixed(4)}`} in ${Math.round(r.ms / 1000)} s`);
      else console.log(`graph: ${r.nodes} nodes · ${r.edges} edges · ${r.communities} communities in ${r.ms} ms → ${path.relative(PATHS.VAULT, r.out)}`);
    })
    .catch((e) => { console.error('[graph-build]', e.message); process.exit(1); });
}

module.exports = { buildStructural, buildSemantic, semanticSkip, semanticState, semanticRunner, spawnSemantic, skipReason, childEnv, withGraphLock, lockOwner, busyReason, localTarget, localExtract, LOCK, SHIM_DIR, LOCAL_TOKEN_BUDGET };
