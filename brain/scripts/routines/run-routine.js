#!/usr/bin/env node
'use strict';
/**
 * run-routine.js — the single entrypoint every scheduled routine runs through (spec D5).
 *
 *   node brain/scripts/routines/run-routine.js <slug> [--manual|--early] [--dry-run]
 *
 * Loads <vault>/brain/routines/<slug>.md, then by kind:
 *   duty     sh <vault>/brain/scripts/persona/run-duty.sh <slug>   (its own kill switch, caps, journal, contract);
 *            `budgetUsd` and `tools` in the routine file become PERSONA_MAX_USD and PERSONA_TOOLS for that run, and
 *            `model` and `effort` become PERSONA_MODEL and PERSONA_EFFORT
 *   prompt   the headless runner (lib/headless.js, codex-parity D4): `claude -p <body> --model … --effort … --allowedTools
 *            <routines.tools> --max-budget-usd …`, or `codex exec -` with the body on stdin when routines.runner says so
 *            or no claude is installed (spend then estimated from the usage block); gated by routines.perDayUsd over
 *            today's routine:* ledger rows; the run is ledgered as routine:<slug>. That is a routine with no `engine`, and
 *            it stays exactly so. A routine that names its engine (local-first A6) runs there:
 *              engine: claude | codex  that host's CLI, the same recipe, `model` a model of that host; a host that is not
 *                                      enabled, or whose CLI is missing, is a failed run with the reason — never the
 *                                      other host
 *              engine: local           the built-in local agent (lib/local-agent.js, A7) on the local engine, in this
 *                                      process: no cap (it spends nothing), one ledger row per run (provider ollama,
 *                                      usd 0; local-first §4) and one local-usage count per model turn (A18). The engine
 *                                      down or the model not pulled is a skip with reason `local-down` (nothing spent;
 *                                      the next fire retries). The tool calls and the final message go to the log.
 *   command  argv[0] argv.slice(1) — spawned directly (no shell), cwd = vault; `{{NODE}}` in an argv entry expands to
 *            this process.execPath and `{{VAULT}}` to the vault, so a template routine needs no per-machine rendering
 * Always: one entry in brain/_index/routines.json (lastRunAt, lastExit, lastCostUsd, lastDurationMs, failStreak,
 * lastTrigger, lastError), one pipelines.json row named routine:<slug>, and stdout/stderr appended to
 * <log dir>/routine-<slug>.log. The exit code mirrors the child's. A disabled routine (or routines.enabled=false)
 * exits 0 without running and records a skip. This is not a hook: it runs under launchd/cron, so no hook-entry
 * prologue — but the prompt child gets AOS_HEADLESS=1 exactly like every other `claude -p` the brain spawns.
 * Every external call is injectable for tests (deps).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// `early`: started by the tick's helper (persona/tick.js beat) when the queue crosses persona.tick.earlyReflect.
const TRIGGERS = ['scheduled', 'manual', 'early'];
const DEFAULT_TIMEOUT_SEC = 1800;
const TAIL_CHARS = 400;

function tail(text, n = TAIL_CHARS) { const s = String(text || '').trim(); return s.length > n ? s.slice(-n) : s; }
function n(v, d) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d; }

function defaultDeps() {
  const { PATHS } = require('../lib/paths.js');
  const store = require('../lib/routines-store.js');
  const { loadConfig } = require('../lib/config.js');
  const { withReport } = require('../lib/pipeline-report.js');
  const ledger = require('../sdk/lib/spend-ledger.js');
  const { resolveRunner } = require('../lib/headless.js');
  const { parseClaudeJson, rowFrom, rowFromCodex, parseCodexEvents } = require('../persona/record-spend.js');
  return {
    vault: PATHS.VAULT,
    store,
    config: loadConfig,
    withReport,
    spawn: (cmd, args, opts) => spawnSync(cmd, args, opts),
    recordSpend: ledger.recordSpend,
    routineSpendToday: ledger.routineSpendToday,
    runner: (cfg, host) => resolveRunner({ cfg, kind: 'routines', host }),
    resolveLocal: (cfg, model) => require('../lib/local-agent.js').resolveLocal({ cfg, model }),
    localAgent: (opts) => require('../lib/local-agent.js').runLocalAgent(opts),
    parseClaudeJson, rowFrom, rowFromCodex, parseCodexEvents,
    now: () => new Date(),
    env: process.env,
    logDir: process.env.AOS_ROUTINE_LOG_DIR || process.env.PERSONA_LOG_DIR || path.join(PATHS.VAULT, 'persona', 'journal', 'logs'),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
}

const { headlessEnv, runnerArgs } = require('../lib/headless.js');

/** What a prompt routine asks of its runner: { prompt, model, effort, tools, budget }. */
function promptSpec(routine, cfg) {
  const rc = cfg.routines || {};
  return {
    prompt: routine.body,
    model: routine.model || (cfg.claude && cfg.claude.model) || 'haiku',
    effort: routine.effort || 'medium',
    tools: typeof rc.tools === 'string' ? rc.tools : 'Read,Glob,Grep',
    budget: routine.budgetUsd !== undefined ? routine.budgetUsd : n(rc.perRunUsd, 2),
  };
}

/** The `claude -p` argv for a prompt routine (the claude runner; codex builds its own through runnerArgs). */
function promptArgs(routine, cfg) {
  return runnerArgs('claude', promptSpec(routine, cfg)).argv;
}

/** Older injected deps name a claudeBin; the runner seam (codex-parity D4) supersedes it. `host` pins the routine's engine. */
function runnerOf(deps, cfg, host = null) {
  if (typeof deps.runner === 'function') return deps.runner(cfg, host);
  const bin = host !== 'codex' && typeof deps.claudeBin === 'function' ? deps.claudeBin() : null;
  return bin ? { host: 'claude', bin, model: null, reason: 'claudeBin' } : { host: null, bin: null, model: null, reason: `${host || 'claude'} CLI not found` };
}

const HOST_NAMES = { claude: 'Claude Code', codex: 'Codex' };

/** `{{NODE}}` → the running node, `{{VAULT}}` → the vault. Only these two; anything else is literal. */
function expandArgv(a, deps) {
  return String(a).split('{{NODE}}').join(deps.node || process.execPath).split('{{VAULT}}').join(deps.vault);
}

/** Plan the child process for a routine: { cmd, args, env, feature } — or { skip: reason }. */
function plan(routine, cfg, deps) {
  const rc = cfg.routines || {};
  if (rc.enabled === false) return { skip: 'routines disabled in config' };
  if (!routine.enabled) return { skip: 'routine disabled' };
  if (routine.kind === 'duty') {
    // A duty's own budget and allowlist (reflect-daily.md: 0.50 USD, read-only tools) reach run-duty.sh as the env overrides it
    // already honours; `{{NODE}}`/`{{VAULT}}` in tools expand like argv so the template file works on every machine.
    const env = { ...deps.env };
    if (routine.budgetUsd !== undefined) env.PERSONA_MAX_USD = String(routine.budgetUsd);
    if (typeof routine.tools === 'string' && routine.tools.trim()) env.PERSONA_TOOLS = expandArgv(routine.tools, deps);
    // Extra write scope on top of the default one (spec 2026-09-23-duty-write-scope-design D5); duty-guard.js checks it.
    if (Array.isArray(routine.writes) && routine.writes.length) env.PERSONA_WRITES = routine.writes.join(',');
    // A duty's own model and effort win over the schedule's (spec 2026-09-24-duty-model-settings-design D1). The model is
    // a Claude model by contract, as for prompt routines: run-duty.sh (persona/chief.js) gives the Codex runner
    // persona.codexModel (D4). tick.js --triage builds the woken tick duty through this same plan (local-first A5).
    if (routine.model) env.PERSONA_MODEL = routine.model;
    if (routine.effort) env.PERSONA_EFFORT = routine.effort;
    return { cmd: 'sh', args: [path.join(deps.vault, 'brain', 'scripts', 'persona', 'run-duty.sh'), routine.slug], env, feature: `duty:${routine.slug}` };
  }
  if (routine.kind === 'prompt') {
    const feature = `routine:${routine.slug}`;
    // local-first A6/A7: the local agent, in this process; it spends nothing, so no daily cap.
    if (routine.engine === 'local') return { local: true, feature, runner: 'ollama' };
    const perDay = n(rc.perDayUsd, 6);
    const spent = deps.routineSpendToday();
    if (spent >= perDay) return { skip: `daily cap reached (${spent.toFixed(2)} of ${perDay} USD)` };
    const pinned = routine.engine === 'claude' || routine.engine === 'codex' ? routine.engine : null;
    const r = runnerOf(deps, cfg, pinned);
    if (!r.host && pinned) {
      const fix = /enabled/.test(r.reason) ? `add it (aos hosts add ${pinned}) or pick another engine` : `install ${HOST_NAMES[pinned]} or pick another engine`;
      return { fail: `engine ${pinned}: ${r.reason} — ${fix}`, feature, runner: pinned };
    }
    if (!r.host) return { error: `no runner for prompt routines (${r.reason}) — install claude or codex, or set routines.runner` };
    const spec = promptSpec(routine, cfg);
    // A routine's `model` is a Claude alias by contract; the codex runner takes codex.model (null = the Codex default).
    // A routine that names engine codex names a Codex model (local-first A6).
    const model = r.host === 'codex' ? (pinned === 'codex' && routine.model ? routine.model : r.model) : spec.model;
    const outFile = r.host === 'codex' ? path.join(require('os').tmpdir(), `aos-routine-${routine.slug}-${process.pid}.txt`) : null;
    const { argv, stdin } = runnerArgs(r.host, { ...spec, model, outFile });
    return { cmd: r.bin, args: argv, stdin, env: headlessEnv(deps.env, { codexHome: r.home }), feature, runner: r.host, model, outFile };
  }
  const argv = routine.argv.map(a => expandArgv(a, deps));
  return { cmd: argv[0], args: argv.slice(1), env: { ...deps.env }, feature: null };
}

/** Runs one routine end to end. Returns the exit code. */
async function runRoutine(slug, { trigger = 'scheduled', dryRun = false, deps = defaultDeps() } = {}) {
  if (!TRIGGERS.includes(trigger)) trigger = 'scheduled';
  const routine = deps.store.read(slug);
  if (!routine) { deps.stderr(`run-routine: no routine "${slug}" under brain/routines/\n`); return 2; }
  if (routine.errors.length) { deps.stderr(`run-routine: "${slug}" is invalid: ${routine.errors.join('; ')}\n`); return 2; }
  const cfg = deps.config();
  const p = plan(routine, cfg, deps);
  if (p.error) { deps.stderr(`run-routine: ${p.error}\n`); return 1; }
  if (dryRun && p.local) {
    const { localCfg } = require('../sdk/lib/local-config.js');
    const lc = localCfg(cfg);
    deps.stdout(['local-agent', `engine=${lc.engine}`, `url=${lc.url}`, `model=${routine.model || lc.workhorse.tag}`, `maxTurns=${routine.maxTurns || 24}`, `writes=${(routine.writes || []).join(',')}`, `<${slug} body>`].join('\n') + '\n');
    return 0;
  }
  if (dryRun && p.fail) { deps.stdout(`run-routine: ${slug} cannot run — ${p.fail}\n`); return 1; }
  let local = null;
  if (p.local) {
    // Is the local engine up with the model pulled? Down → a skip, nothing spent; the next fire retries (local-first A3).
    const r = await deps.resolveLocal(cfg, routine.model || null);
    if (r.ok) local = r;
    else p.skip = `${r.reason}: ${r.detail}`;
  }
  if (p.skip) {
    deps.stdout(`run-routine: ${slug} skipped — ${p.skip}\n`);
    deps.store.patchState(slug, (cur) => ({ ...cur, lastSkippedAt: deps.now().toISOString(), lastSkipReason: p.skip }));
    return 0;
  }
  if (dryRun) {
    const shown = [p.cmd, ...p.args.map(a => (a === routine.body && routine.kind === 'prompt' ? `<${slug} body>` : a))];
    if (p.stdin != null) shown.push(`<${slug} body on stdin>`);
    deps.stdout(shown.join('\n') + '\n');
    return 0;
  }

  const started = deps.now();
  const startedIso = started.toISOString();
  fs.mkdirSync(deps.logDir, { recursive: true });
  const logFile = path.join(deps.logDir, `routine-${slug}.log`);
  const timeoutMs = n(routine.timeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;

  let exit = 1, costUsd = null, lastError = null;
  const head = () => `[${startedIso}] routine=${slug} kind=${routine.kind}${routine.engine ? ` engine=${routine.engine}` : ''} trigger=${trigger} exit=${exit}${costUsd != null ? ` usd=${costUsd}` : ''}`;
  const run = async (report) => {
    report.provider = routine.kind === 'prompt' ? (p.runner || 'claude') : routine.kind === 'duty' ? 'persona' : 'local';
    if (p.fail) {
      // A routine whose engine cannot run here: a failed run with the reason, so the tab and the tick see it.
      exit = 1;
      lastError = p.fail;
      fs.appendFileSync(logFile, `${head()}\n${p.fail}\n`);
      report.counts.exit = exit;
      report.status = 'error'; report.reason = lastError;
      return;
    }
    if (p.local) {
      const res = await deps.localAgent({ routine, cfg, vault: deps.vault, lc: local.lc, model: local.model, timeoutMs });
      exit = res.status === 'ok' ? 0 : res.status === 'timeout' ? 124 : 1;
      if (exit !== 0) lastError = res.error;
      // One ledger row per run, never per call (local-first §4 with A18): provider ollama, nothing spent, the tokens.
      deps.recordSpend({ feature: p.feature, provider: 'ollama', model: res.model, usd: 0, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, ms: res.ms });
      costUsd = 0;
      const body = [`engine=${res.engine} model=${res.model} turns=${res.turns} tools=${res.toolCalls}${res.wrote.length ? ` wrote=${res.wrote.join(',')}` : ''}`, ...res.journal];
      if (res.final) body.push('--- final ---', res.final.replace(/\s+$/, ''));
      if (exit !== 0) body.push(`--- error ---`, String(lastError));
      fs.appendFileSync(logFile, `${head()}\n${body.join('\n')}\n`);
      Object.assign(report.counts, { exit, usd: 0, turns: res.turns, tools: res.toolCalls, refused: res.refused.length });
      if (exit !== 0) { report.status = 'error'; report.reason = lastError; }
      return;
    }
    let res;
    try {
      // The codex runner takes the prompt on stdin (then closed: an open non-TTY stdin blocks `codex exec`).
      const stdin = p.stdin != null ? { input: p.stdin } : {};
      res = deps.spawn(p.cmd, p.args, { cwd: deps.vault, env: p.env, encoding: 'utf8', timeout: timeoutMs, stdio: [p.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, ...stdin });
    } catch (e) { res = { status: 1, stdout: '', stderr: e.message, error: e }; }
    const stdout = String(res.stdout || ''), stderr = String(res.stderr || '');
    if (res.error && res.error.code === 'ENOENT') exit = 127;
    else if (res.signal) exit = 124;   // timeout (SIGTERM) or killed
    else exit = typeof res.status === 'number' ? res.status : 1;
    if (res.signal === 'SIGTERM' && timeoutMs) lastError = `timed out after ${routine.timeoutSec || DEFAULT_TIMEOUT_SEC}s`;
    else if (exit !== 0) lastError = tail(stderr) || (res.error && res.error.message) || `exit ${exit}`;

    if (routine.kind === 'prompt' && p.runner === 'codex') {
      const row = deps.rowFromCodex(stdout, { feature: p.feature, model: p.model, ms: Math.max(0, deps.now() - started) });
      deps.recordSpend(row);
      costUsd = row.usd;
      const errs = deps.parseCodexEvents(stdout).errors;
      if (errs.length && exit !== 0) lastError = tail(errs.join(' | '));
      if (p.outFile) { try { fs.unlinkSync(p.outFile); } catch { /* codex may not have written it */ } }
    } else if (routine.kind === 'prompt') {
      const json = deps.parseClaudeJson(stdout);
      const row = deps.rowFrom(json, { feature: p.feature, model: p.args[p.args.indexOf('--model') + 1] });
      deps.recordSpend(row);
      costUsd = row.usd;
      if (json && json.is_error) { exit = exit || 1; lastError = lastError || tail(json.result); }
    }
    fs.appendFileSync(logFile, `${head()}\n${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}${stderr ? `--- stderr ---\n${stderr}${stderr.endsWith('\n') ? '' : '\n'}` : ''}`);
    report.counts.exit = exit;
    if (costUsd != null) report.counts.usd = costUsd;
    if (exit !== 0) { report.status = 'error'; report.reason = lastError; }
  };
  try { await deps.withReport(`routine:${slug}`, run); } catch (e) { exit = exit || 1; lastError = lastError || e.message; }

  const ended = deps.now();
  deps.store.patchState(slug, (cur) => ({
    ...cur,
    lastRunAt: startedIso,
    lastExit: exit,
    lastCostUsd: costUsd,
    lastDurationMs: Math.max(0, ended - started),
    failStreak: exit === 0 ? 0 : (Number(cur.failStreak) || 0) + 1,
    lastTrigger: trigger,
    lastError: exit === 0 ? null : lastError,
  }));
  if (exit !== 0) deps.stderr(`run-routine: ${slug} failed (exit ${exit})${lastError ? `: ${lastError}` : ''}\n`);
  return exit;
}

function main(argv) {
  const slug = argv.find(a => !a.startsWith('--'));
  if (!slug) { process.stderr.write('usage: run-routine.js <slug> [--manual|--early] [--dry-run]\n'); return Promise.resolve(2); }
  const trigger = argv.includes('--early') ? 'early' : argv.includes('--manual') ? 'manual' : 'scheduled';
  return runRoutine(slug, { trigger, dryRun: argv.includes('--dry-run') });
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`run-routine: ${e.message}\n`); process.exit(1); });
module.exports = { runRoutine, plan, promptArgs, promptSpec, expandArgv, main, TRIGGERS };
