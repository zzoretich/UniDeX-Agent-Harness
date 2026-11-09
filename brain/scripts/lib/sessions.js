'use strict';
/**
 * sessions.js — the runtime side of the app's agent sessions (spec 2026-10-07-unidex-sessions S2, S6, S7). The app's
 * main process runs it as a command, so every host flag, cap and event format stays in the runtime and the app never
 * names one:
 *
 *   node lib/sessions.js args '<json>'
 *     in:  { host, prompt, sessionId?, resume?, model?, effort?, access?, allowCommands? }  (access: read | edit | run)
 *     out: { ok: true, host, bin, argv, env: { set, unset }, perTurnUsd }  or  { ok: false, reason }  (exit 0 / 3)
 *     Refuses a host that is off or has no binary, and a day whose session spend reached sessions.perDayUsd (0 turns
 *     sessions off). Claude gets sessions.perTurnUsd as its budget flag; a Codex turn is estimated after it ends.
 *   node lib/sessions.js events --host claude|codex [--model <m>]
 *     stdin: the turn's raw stdout; stdout: one session-events.js event per line, as they arrive.
 *   node lib/sessions.js catalog [--refresh] [--host claude|codex]
 *     stdout: the host catalog (host-catalog.js), one JSON line. Served from brain/_index/host-catalog.json while it is
 *     fresh (a day, every host answered or off); --refresh asks the hosts again, --host only that one (merged into the
 *     cache, which keeps its older date). Never calls a model (spec 2026-10-07-sessions-ux U3).
 *   node lib/sessions.js mirror --host claude|codex (--id <id> | --cwd <abs> --since <ms>) [--terminal <uuid>] (--once|--follow)
 *     Copies a host transcript into brain/_index/code as session events (code-mirror.js; spec 2026-11-09-code-chat).
 *     --once writes <host>-<id>.jsonl whole and prints { ok, cache } (exit 0 / 3); --follow keeps <terminal>.jsonl (or
 *     <host>-<id>.jsonl without --terminal) current until SIGTERM. Bad arguments exit 2.
 *   node lib/sessions.js bin claude|codex
 *     out: { ok: true, bin }  or  { ok: false, reason }  (exit 0 / 3). The binary a Code launch runs: the app's main
 *     process spawns it as the terminal's own process (agent-computer D18), resolved as `args` resolves a turn's.
 *   node lib/sessions.js record '<json>'
 *     { host, model?, usd, inputTokens?, outputTokens?, ms?, startedAt?, status?, prompt?, reply?, toolCount?, error?,
 *       workspace?, thread? } → the turn's ledger row (feature session:<host>, when it cost anything) and its row in
 *     agent-runs/runs.jsonl (script session:<host>), so the Runs tab lists it (S8).
 *
 *   plan({ cfg, req, env, spentToday, ... }) is `args` as a function, with the config and today's spend passed in.
 */
const path = require('path');
const H = require('./headless.js');
const { dayCap } = require('./settings-schema.js');
const { createParser } = require('./session-events.js');

const PER_TURN_DEFAULT = 1;
const PER_DAY_DEFAULT = 10;

/** The two caps of S6 from a merged config. A turn cap that is not a positive number falls back to the default. */
function caps(cfg) {
  const s = (cfg && cfg.sessions) || {};
  const turn = dayCap(s.perTurnUsd, PER_TURN_DEFAULT);
  return { perTurnUsd: turn > 0 ? turn : PER_TURN_DEFAULT, perDayUsd: dayCap(s.perDayUsd, PER_DAY_DEFAULT) };
}

/** One turn's command, or why it may not start (module comment). `lookup`/`candidates` reach resolveBin (tests). */
function plan({ cfg, req, env = process.env, spentToday = 0, lookup, candidates }) {
  const r = req && typeof req === 'object' ? req : {};
  const host = r.host;
  if (!H.HOSTS.includes(host)) return { ok: false, reason: `no such host: ${host}` };
  if (!H.hostEnabled(cfg, host)) return { ok: false, reason: `${host === 'codex' ? 'Codex' : 'Claude Code'} is off on this machine` };
  const bin = H.resolveBin(host, { cfg, env, lookup, candidates });
  if (!bin) return { ok: false, reason: `no ${host} binary found` };
  const { perTurnUsd, perDayUsd } = caps(cfg);
  if (perDayUsd === 0) return { ok: false, reason: 'sessions.perDayUsd is 0, which turns sessions off' };
  if (spentToday >= perDayUsd) return { ok: false, reason: `today's session spend, $${spentToday.toFixed(2)}, reached the $${perDayUsd} daily cap (sessions.perDayUsd)` };
  let args;
  try {
    args = H.sessionArgs(host, {
      prompt: r.prompt, sessionId: r.sessionId, resume: r.resume, model: r.model, effort: r.effort, access: r.access,
      allowCommands: r.allowCommands === true, budget: host === 'claude' ? perTurnUsd : undefined,
    });
  } catch (e) {
    return { ok: false, reason: String(e.message || e).replace(/^sessionArgs: /, '') };
  }
  const set = { AOS_HEADLESS: '1' };
  const home = host === 'codex' ? H.codexHomeOf(cfg) : null;
  if (home && !env.CODEX_HOME) set.CODEX_HOME = home;
  return { ok: true, host, bin, argv: args.argv, env: { set, unset: [...H.HEADLESS_UNSET] }, perTurnUsd };
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
  });
}

const flag = (argv, name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };

async function main(argv) {
  const [verb, arg] = argv;
  if (verb === 'args') {
    let req;
    try { req = JSON.parse(arg); } catch { process.stderr.write('sessions: args takes one JSON argument\n'); return 2; }
    const { loadConfig } = require('./config.js');
    const ledger = require('../sdk/lib/spend-ledger.js');
    const out = plan({ cfg: loadConfig(), req, spentToday: ledger.sessionSpendToday() });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return out.ok ? 0 : 3;
  }
  if (verb === 'events') {
    const host = flag(argv, '--host');
    let p;
    try { p = createParser(host, { model: flag(argv, '--model') || null }); } catch (e) { process.stderr.write(`sessions: ${e.message}\n`); return 2; }
    const write = (events) => { for (const e of events) process.stdout.write(`${JSON.stringify(e)}\n`); };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => write(p.push(chunk)));
    await new Promise((resolve) => process.stdin.on('end', resolve));
    write(p.end());
    return 0;
  }
  if (verb === 'catalog') {
    const C = require('./host-catalog.js');
    const { loadConfig } = require('./config.js');
    const { VAULT, PATHS } = require('./paths.js');
    const file = path.join(PATHS.INDEX, 'host-catalog.json');
    const only = flag(argv, '--host');
    if (only !== undefined && !H.HOSTS.includes(only)) { process.stderr.write('sessions: catalog --host takes claude or codex\n'); return 2; }
    const cached = C.loadCatalog(file);
    if (!argv.includes('--refresh') && C.isFresh(cached)) { process.stdout.write(`${JSON.stringify(cached)}\n`); return 0; }
    const fresh = await C.fetchCatalog({ cfg: loadConfig(), hosts: only ? [only] : H.HOSTS, cwd: VAULT });
    const cat = only && cached ? { ...cached, hosts: { ...cached.hosts, ...fresh.hosts } } : fresh;
    try { C.saveCatalog(file, cat); } catch (e) { process.stderr.write(`sessions: could not save the catalog: ${e.message}\n`); }
    process.stdout.write(`${JSON.stringify(cat)}\n`);
    return 0;
  }
  if (verb === 'mirror') {
    const M = require('./code-mirror.js');
    const host = flag(argv, '--host');
    const id = flag(argv, '--id');
    const cwd = flag(argv, '--cwd');
    const sinceArg = flag(argv, '--since');
    const terminal = flag(argv, '--terminal');
    const once = argv.includes('--once');
    const bad = (why) => { process.stderr.write(`sessions: mirror ${why}\n`); return 2; };
    if (!H.HOSTS.includes(host)) return bad('--host takes claude or codex');
    if (once === argv.includes('--follow')) return bad('takes exactly one of --once, --follow');
    if ((id !== undefined) === (cwd !== undefined)) return bad('takes --id, or --cwd with --since');
    if (id !== undefined && !M.validId(id)) return bad('--id is not a session id');
    if (terminal !== undefined && !M.UUID_RE.test(terminal)) return bad('--terminal is not a terminal id');
    const since = Number(sinceArg);
    if (cwd !== undefined && (!path.isAbsolute(cwd) || sinceArg === undefined || !Number.isFinite(since))) return bad('--cwd takes an absolute folder and --since milliseconds');
    if (once && id === undefined) return bad('--once takes --id');
    if (!once && id === undefined && !terminal) return bad('--cwd takes --terminal');
    const { VAULT } = require('./paths.js');
    if (once) {
      const r = M.mirrorOnce({ host, id, vault: VAULT });
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return r.ok ? 0 : 3;
    }
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try { await M.follow({ host, terminal, id, cwd, since, vault: VAULT, signal: ac.signal }); } catch (e) { return bad(e.message); }
    return 0;
  }
  if (verb === 'bin') {
    if (!H.HOSTS.includes(arg)) { process.stderr.write('sessions: bin takes claude or codex\n'); return 2; }
    const { loadConfig } = require('./config.js');
    const bin = H.resolveBin(arg, { cfg: loadConfig() });
    process.stdout.write(`${JSON.stringify(bin ? { ok: true, bin } : { ok: false, reason: `no ${arg} binary found` })}\n`);
    return bin ? 0 : 3;
  }
  if (verb === 'record') {
    let r;
    try { r = JSON.parse(arg || (await readStdin())); } catch { process.stderr.write('sessions: record takes one JSON argument\n'); return 2; }
    const usd = r && r.usd === null ? 0 : r && r.usd;
    if (!r || !H.HOSTS.includes(r.host) || typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
      process.stderr.write('sessions: record needs { host, usd }\n');
      return 2;
    }
    if (usd > 0) {
      const { recordSpend } = require('../sdk/lib/spend-ledger.js');
      recordSpend({ feature: `session:${r.host}`, provider: r.host, model: r.model || null, usd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ms: r.ms });
    }
    const { appendRunSummary } = require('../sdk/lib/telemetry.js');
    const ended = new Date();
    const started = r.startedAt && !Number.isNaN(Date.parse(r.startedAt)) ? new Date(r.startedAt) : new Date(ended.getTime() - (Number(r.ms) || 0));
    appendRunSummary({
      script: `session:${r.host}`, startedAt: started, endedAt: ended, costUsd: r.usd === null ? null : usd, turns: 1,
      status: ['ok', 'error', 'stopped'].includes(r.status) ? r.status : 'ok', prompt: r.prompt || null, reply: r.reply || null,
      toolCount: Number.isInteger(r.toolCount) ? r.toolCount : 0, error: r.error ? String(r.error) : null,
      extra: { host: r.host, model: r.model || null, workspace: r.workspace || null, thread: r.thread || null },
    });
    return 0;
  }
  process.stderr.write('usage: sessions.js args <json> | events --host claude|codex [--model m] | catalog [--refresh] [--host h] | mirror --host h (--id i | --cwd d --since ms) [--terminal t] (--once|--follow) | bin claude|codex | record <json>\n');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { plan, caps, PER_TURN_DEFAULT, PER_DAY_DEFAULT };
