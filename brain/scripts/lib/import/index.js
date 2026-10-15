'use strict';
/**
 * import/index.js — the importer behind `aos import` (install-import B2–B10, B15): a user's Claude Code and Codex history
 * into the vault, read only through lib/host.js (hostDirs) and lib/transcript.js, whether or not the host is enabled
 * (a host's files on disk are imported even when its CLI is gone).
 *
 *   phases, in order   scan → instructions → memories → projects → mcp, then sessions (the digest queue)
 *     scan             writes nothing: per host and kind what a run would bring (rules, memory files, sessions in the
 *                      window, MCP servers), the proposed workspaces and whether the local model is ready. It is what
 *                      `--dry-run` prints (a provider check that records nothing; session-index.json read, never written).
 *     instructions     global CLAUDE.md / AGENTS.md → memories (instructions.js)
 *     memories         Claude Code's auto-memory → memories (memories.js)
 *     projects         proposals (projects.js); created or linked only for `accept`, else listed and left
 *     mcp              both hosts' servers → brain/_index/mcp-servers.json (mcp.js; never a host config write)
 *     sessions         the window's sessions queued for the import-digest routine, which is turned on (digest.js)
 *   Each phase records { phase, host, done, cursor, counts } in import-state.json and skips what it already wrote
 *   (content hashes), so a second run writes nothing twice. `only` limits the kinds; `from` the hosts.
 *
 * Model calls (B15): only the local engine (provider.js resolving `ollama`, Ollama or an OpenAI-compatible server)
 * classifies rules; a hosted provider is never asked, and with no local engine the fast phases run without a model.
 */
const fs = require('fs');
const os = require('os');
const C = require('./common.js');
const instructions = require('./instructions.js');
const memories = require('./memories.js');
const projects = require('./projects.js');
const mcp = require('./mcp.js');
const digest = require('./digest.js');

const KINDS = ['instructions', 'memories', 'projects', 'mcp', 'sessions'];
const FAST = ['instructions', 'memories', 'projects', 'mcp'];

/** `90d`, `30d`, `all` → days (Infinity for all); null when it does not parse. */
function windowDays(since) {
  if (since === 'all') return Infinity;
  const m = /^(\d{1,5})d$/.exec(String(since || ''));
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

/** The local engine, or { ready: false, reason }: a hosted provider counts as none here (B15). */
async function resolveEngine(providerFn) {
  let p = null;
  try { p = await providerFn(); } catch (e) { return { ready: false, provider: 'none', reason: e && e.message ? e.message : 'provider failed', p: null }; }
  if (p && p.name === 'ollama') return { ready: true, provider: p.engine || 'ollama', model: p.model || null, reason: p.reason || 'local-ready', p };
  const reason = !p ? 'no-provider' : p.name === 'none' ? p.reason || 'none' : `${p.name}-not-used`;
  return { ready: false, provider: p ? p.name : 'none', reason, p: null };
}

function hostInfo(host, opts) {
  const { hostDirs } = require('../host.js');
  const dirs = hostDirs(host, { env: opts.env, userConfig: opts.userConfig });
  let present = false;
  try { present = fs.statSync(dirs.configDir).isDirectory(); } catch { present = false; }
  return { dirs, present };
}

/**
 * Run the importer. opts: { vault, cfg (merged config), userConfig (agenticos.json, for hostDirs), env, home, now,
 * from: ['claude', 'codex'], only: [kinds], since ('90d' | 'all'), dryRun, accept (array or null), workspace
 * (cli/workspace.js) and wsOpts (its options), provider (async () → provider), tmpDirs, gitCeiling, log (line → void) }.
 * → the report `aos import --json` prints.
 */
async function runImport(opts) {
  const vault = opts.vault;
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const from = (opts.from && opts.from.length ? opts.from : C.HOSTS).filter((h) => C.HOSTS.includes(h));
  const only = (opts.only && opts.only.length ? opts.only : KINDS).filter((k) => KINDS.includes(k));
  const since = opts.since || '90d';
  const days = windowDays(since);
  if (days === null) throw new Error(`--since takes <n>d or all, not ${JSON.stringify(since)}`);
  const dryRun = !!opts.dryRun;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const userConfig = opts.userConfig || opts.cfg || {};
  const providerFn = opts.provider || (() => require('../../sdk/lib/provider.js').resolveProvider({ feature: 'import', deps: dryRun ? { unbilled: true } : {} }));
  const engine = await resolveEngine(providerFn);
  const want = (k) => only.includes(k);
  const report = {
    schema: C.SCHEMA, dryRun, since, windowDays: Number.isFinite(days) ? days : null, from, only,
    engine: { ready: engine.ready, provider: engine.provider, model: engine.model || null, reason: engine.reason },
    hosts: {}, projects: null, mcp: null, sessions: null, written: 0,
  };
  const hosts = {};
  for (const h of from) {
    hosts[h] = hostInfo(h, { env, userConfig });
    report.hosts[h] = { present: hosts[h].present, configDir: C.tilde(hosts[h].dirs.configDir, home) };
  }
  const needCollect = want('projects') || want('sessions');
  let collected = needCollect ? projects.collect({ vault, cfg: opts.cfg || {}, userConfig, env, home, now, windowDays: days, tmpDirs: opts.tmpDirs, gitCeiling: opts.gitCeiling, dryRun }) : null;

  // ── scan (also the dry run's whole answer) ──
  const state = C.readState(vault);
  for (const h of from) {
    const r = report.hosts[h];
    if (want('instructions')) r.instructions = instructions.scanInstructions({ host: h, dirs: hosts[h].dirs, vault, state });
    if (want('memories')) r.memories = memories.scanMemories({ host: h, dirs: hosts[h].dirs, vault, state });
    if (want('mcp')) r.mcp = { servers: mcp.listServers(h, { env, userConfig, dirs: hosts[h].dirs, home }).servers.length };
  }
  if (want('sessions') && collected) {
    const n = digest.countSessions(collected, { vault, hosts: from, windowDays: days, now, home });
    for (const h of from) report.hosts[h].sessions = n[h] || 0;
  }
  let proposals = [];
  if (want('projects') && collected) proposals = projects.propose({ outside: collected.outside, workspaces: collected.workspaces, vault, home, now });
  if (dryRun) {
    report.projects = { proposals, created: [], linked: [], failed: [], unknown: [] };
    if (want('mcp')) report.mcp = { servers: from.flatMap((h) => mcp.listServers(h, { env, userConfig, dirs: hosts[h].dirs, home }).servers) };
    return report;
  }

  const at = new Date(now).toISOString();
  const chat = engine.ready ? (o) => engine.p.chat({ ...o, feature: 'import' }) : null;
  const embed = engine.ready && engine.p.capabilities && engine.p.capabilities.embed ? (t) => engine.p.embed(t) : null;
  const dedup = (want('instructions') || want('memories')) ? new C.Deduper(vault, { embed }) : null;
  const merge = (work, phase, host, counts) => C.updateState(vault, (s) => {
    Object.assign(s.hashes, work.hashes);
    Object.assign(s.files, work.files);
    C.recordPhase(s, phase, host, { done: true, cursor: null, counts, at });
  });
  const strip = (c) => { const { paths, ...rest } = c; return rest; }; // eslint-disable-line no-unused-vars

  // ── instructions, memories ──
  for (const phase of ['instructions', 'memories']) {
    if (!want(phase)) continue;
    for (const h of from) {
      const work = C.readState(vault);
      const counts = phase === 'instructions'
        ? await instructions.importInstructions({ host: h, dirs: hosts[h].dirs, vault, state: work, chat, dedup, home })
        : await memories.importMemories({ host: h, dirs: hosts[h].dirs, vault, state: work, dedup, home });
      merge(work, phase, h, strip(counts));
      report.hosts[h][phase] = { ...report.hosts[h][phase], ...counts };
      report.written += counts.written;
      if (phase === 'memories' && h === 'codex') log('memories (Codex): none to read (Codex\'s built-in memories stay Codex\'s)');
      else log(`${phase} (${C.HOST_LABEL[h]}): ${counts.written} written, ${counts.duplicates} already in the vault${phase === 'instructions' && counts.mode ? ` (${counts.mode === 'rules' ? 'by rule, typed by the local model' : 'whole file: no local model'})` : ''}`);
    }
  }

  // ── projects ──
  if (want('projects')) {
    const acc = Array.isArray(opts.accept) ? opts.accept : null;
    const res = acc && acc.length && opts.workspace
      ? await projects.apply(proposals, { accept: acc, workspace: opts.workspace, wsOpts: opts.wsOpts || {} })
      : { created: [], linked: [], failed: [], unknown: [] };
    report.projects = { proposals, ...res, note: acc ? null : proposals.length ? 'none created: pass --accept with the ids to create them' : null };
    C.updateState(vault, (s) => C.recordPhase(s, 'projects', from.length === 2 ? 'all' : from[0], {
      done: true, cursor: null, at,
      counts: { proposed: proposals.length, created: res.created.length, linked: res.linked.length, failed: res.failed.length },
    }));
    log(`projects: ${proposals.length} proposed${acc ? `, ${res.created.length} created, ${res.linked.length} linked${res.failed.length ? `, ${res.failed.length} failed` : ''}` : ' (none created without --accept)'}`);
    // A workspace just made claims its sessions: credit them before the digest queue is built.
    if ((res.created.length || res.linked.length) && want('sessions')) {
      collected = projects.collect({ vault, cfg: opts.cfg || {}, userConfig, env, home, now, windowDays: days, tmpDirs: opts.tmpDirs, gitCeiling: opts.gitCeiling });
    }
  }

  // ── mcp ──
  if (want('mcp')) {
    const byHost = {};
    for (const h of from) byHost[h] = mcp.listServers(h, { env, userConfig, dirs: hosts[h].dirs, home }).servers;
    const w = mcp.writeServers(vault, from, byHost, { now: new Date(now) });
    report.mcp = { servers: w.servers, file: 'brain/_index/mcp-servers.json' };
    C.updateState(vault, (s) => { for (const h of from) C.recordPhase(s, 'mcp', h, { done: true, cursor: null, at, counts: { servers: byHost[h].length } }); });
    log(`mcp: ${from.map((h) => `${byHost[h].length} on ${C.HOST_LABEL[h]}`).join(', ')} listed`);
  }

  // ── sessions: the digest queue ──
  if (want('sessions') && collected) {
    const q = C.updateState(vault, (s) => {
      const r = digest.queueSessions(s, { vault, collected, hosts: from, since, windowDays: days, now, home });
      C.recordPhase(s, 'sessions', from.length === 2 ? 'all' : from[0], { done: true, cursor: null, at, counts: { added: r.added, queued: r.queued } });
      return r;
    });
    const routine = q.queued ? digest.setRoutine(vault, true) : { created: false, changed: false };
    report.sessions = { added: q.added, queued: q.queued, total: q.total, routine: q.queued ? 'on' : 'unchanged', routineChanged: routine.changed, engineReady: engine.ready || null };
    log(`sessions: ${q.added} queued for the digest (${q.queued} waiting in all)${q.queued ? '; the import-digest routine digests them on the local model' : ''}`);
  }

  if (report.written) C.rebuildHub(vault);
  C.updateState(vault, (s) => { s.runs = [...s.runs, { at, from, only, since, written: report.written }].slice(-20); });
  return report;
}

module.exports = { runImport, windowDays, resolveEngine, KINDS, FAST };
