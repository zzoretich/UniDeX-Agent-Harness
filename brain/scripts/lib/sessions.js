'use strict';
/**
 * sessions.js — what the app's main process asks the runtime about the host CLIs, as a command, so every host flag and
 * event format stays in the runtime and the app never names one (the Sessions tab's turns went with it, remove-sessions
 * D11):
 *
 *   node lib/sessions.js catalog [--refresh] [--host claude|codex]
 *     stdout: the host catalog (host-catalog.js), one JSON line. Served from brain/_index/host-catalog.json while it is
 *     fresh (a day, every host answered or off); --refresh asks the hosts again, --host only that one (merged into the
 *     cache, which keeps its older date). Never calls a model (spec 2026-10-07-sessions-ux U3).
 *   node lib/sessions.js mirror --host claude|codex (--id <id> [--cwd <abs> --since <ms>] | --cwd <abs> --since <ms>)
 *                               [--terminal <uuid>] (--once|--follow)
 *     Copies a host transcript into brain/_index/code as session events (code-mirror.js; spec 2026-11-09-code-chat).
 *     --once writes <host>-<id>.jsonl whole and prints { ok, cache } (exit 0 / 3); --follow keeps <terminal>.jsonl (or
 *     <host>-<id>.jsonl without --terminal) current until SIGTERM. --id with --cwd and --since is Codex's --follow with
 *     --terminal only: that rollout first, then the terminal's folder (R18). Bad arguments exit 2.
 *   node lib/sessions.js bin claude|codex
 *     out: { ok: true, bin }  or  { ok: false, reason }  (exit 0 / 3). The binary a Code launch runs: the app's main
 *     process spawns it as the terminal's own process (agent-computer D18): the host's recorded binary, else the one its
 *     PATH finds (headless.js resolveBin).
 */
const path = require('path');
const H = require('./headless.js');

const flag = (argv, name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };

async function main(argv) {
  const [verb, arg] = argv;
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
    if (id === undefined && cwd === undefined) return bad('takes --id, or --cwd with --since');
    if (id !== undefined && !M.validId(id)) return bad('--id is not a session id');
    if (terminal !== undefined && !M.UUID_RE.test(terminal)) return bad('--terminal is not a terminal id');
    const since = Number(sinceArg);
    if (cwd !== undefined && (!path.isAbsolute(cwd) || sinceArg === undefined || !Number.isFinite(since))) return bad('--cwd takes an absolute folder and --since milliseconds');
    if (once && (id === undefined || cwd !== undefined)) return bad('--once takes --id alone');
    if (!once && cwd !== undefined && !terminal) return bad('--cwd takes --terminal');
    if (id !== undefined && cwd !== undefined && host !== 'codex') return bad('--id with --cwd is codex\'s folder mode');
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
    try { await M.follow({ host, terminal, id, cwd, since: cwd !== undefined ? since : 0, vault: VAULT, signal: ac.signal }); } catch (e) { return bad(e.message); }
    return 0;
  }
  if (verb === 'bin') {
    if (!H.HOSTS.includes(arg)) { process.stderr.write('sessions: bin takes claude or codex\n'); return 2; }
    const { loadConfig } = require('./config.js');
    const bin = H.resolveBin(arg, { cfg: loadConfig() });
    process.stdout.write(`${JSON.stringify(bin ? { ok: true, bin } : { ok: false, reason: `no ${arg} binary found` })}\n`);
    return bin ? 0 : 3;
  }
  process.stderr.write('usage: sessions.js catalog [--refresh] [--host h] | mirror --host h (--id i [--cwd d --since ms] | --cwd d --since ms) [--terminal t] (--once|--follow) | bin claude|codex\n');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { main };
