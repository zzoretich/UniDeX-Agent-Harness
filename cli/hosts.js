'use strict';
/**
 * hosts.js — `aos hosts add <claude|codex> [--from-local <repo-dir>]`: wire one more session host into an existing
 * install (install-import B2; the app's Settings ▸ Hosts runs it after installing and signing in that CLI).
 * `aos hosts status [--json]`: each host as `add` would find it — on in agenticos.json, its CLI (the same lookup chain),
 * signed in (`claude auth status`, `codex login status`: free, no model call) — which Settings ▸ Hosts shows. Read-only.
 *
 *   1. agenticos.json must name a vault (`cfg.vault`, never the default path); the host's CLI must resolve (the same
 *      chain `aos init` uses: claude through cli/aos.js claudeBin, codex through cli/codex-host.js codexBin) and be
 *      signed in (`claude auth status`, `codex login status`). Otherwise it refuses and writes nothing.
 *   2. agenticos.json: that host enabled and its CLI recorded, the other host left as it was (buildUserConfig).
 *   3. the wiring `aos init` does for that host: the Claude Code plugin (installPlugin), or the Codex plugin, else the
 *      direct wiring for an older Codex CLI (wireCodex, which records hosts.codex.install).
 *   4. that host's fast import phases (`aos import --from <host> --only instructions,memories,projects,mcp`): its
 *      instructions and memories into Review, its MCP servers listed, its project folders proposed (none created).
 *      Its session history is left for `aos import --from <host>`, which queues the digest.
 *   5. the installed schedules re-rendered (the Chief of Staff's duties pick the new host up); none installed, none made.
 * Every step is an existing function of cli/aos.js, cli/codex-host.js or cli/import.js; nothing here is host-specific
 * beyond picking which.
 */
const fs = require('fs');
const path = require('path');

const HOSTS = ['claude', 'codex'];
/** How long a sign-in check may take (sdk/lib/provider.js's login probe cap); AOS_HOSTS_PROBE_MS for the tests. */
function probeMs(env = process.env) { const n = Number(env.AOS_HOSTS_PROBE_MS); return Number.isFinite(n) && n > 0 ? n : 10_000; }
const USAGE = 'aos hosts add <claude|codex> [--from-local <repo-dir>] · aos hosts status [--json]';
const FAST = ['instructions', 'memories', 'projects', 'mcp'];

class UsageError extends Error {}
class Refused extends Error {}

/** Re-render the installed schedules from the routine files; a line saying what happened. */
function rerenderSchedules(A, vault, opts = {}) {
  const S = opts.schedule || require('./schedule.js');
  const platform = opts.platform || process.platform;
  if (!(opts.isInstalled || S.isInstalled)({ platform, vault })) return 'no schedules installed; nothing to re-render (aos routines sync installs them)';
  const { scheduleVarsFor } = require('./routines.js');
  const cfg = A.readJson(A.configPath()) || {};
  const { stableNode } = require('./node-path.js');
  const vars = scheduleVarsFor({ vault, configDir: A.configDir(), node: stableNode(cfg.node || process.execPath), cfg });
  const r = (opts.installSchedules || S.installSchedules)({ vars, platform, warn: (m) => A.out.warn(m) });
  return r.unsupported ? `scheduling is not supported on ${r.platform}` : `schedules re-rendered: ${r.labels.join(', ') || 'none'}`;
}

async function add(host, flags = {}, opts = {}) {
  const A = opts.aos || require('./aos.js');
  const CH = require('./codex-host.js');
  const io = opts.io || console;
  if (!HOSTS.includes(host)) throw new UsageError(USAGE);
  const cfg = A.readJson(A.configPath());
  if (!cfg || typeof cfg.vault !== 'string' || !cfg.vault) throw new Refused(`no vault in ${A.configPath()} — run \`aos init\` first`);
  const vault = cfg.vault;
  if (!fs.existsSync(path.join(vault, 'brain', '_index'))) throw new Refused(`${vault} is not a vault (no brain/_index) — run \`aos init\``);

  // 1. the CLI, installed and signed in
  let bin;
  if (host === 'claude') {
    bin = A.claudeBin(cfg);
    if (!bin) throw new Refused('claude CLI not found — install Claude Code, then run `aos hosts add claude`');
    if (!A.claudeLoggedIn(bin)) throw new Refused('claude is not signed in — run `claude auth login`, then `aos hosts add claude`');
  } else {
    bin = A.codexBin(cfg);
    if (!bin) throw new Refused('codex CLI not found — install Codex CLI, then run `aos hosts add codex`');
    if (!CH.codexLoggedIn(bin, A.run)) throw new Refused('codex is not signed in — run `codex login`, then `aos hosts add codex`');
  }
  const before = A.hostsOf(cfg);
  io.log(`hosts add ${host}: ${bin}${before[host] ? ' (already enabled: wiring it again)' : ''}`);

  // 2. agenticos.json: this host on, the other as it was
  const next = A.buildUserConfig(cfg, {
    vault, version: cfg.version, hosts: { ...before, [host]: true },
    bin: host === 'claude' ? bin : undefined,
    codexBin: host === 'codex' ? bin : undefined,
    codexHome: host === 'codex' ? CH.codexHome(cfg) : undefined,
  });
  A.writeJson(A.configPath(), next);
  io.log(`- ${A.configPath()}: hosts now ${[next.hosts.claude.enabled && 'claude', next.hosts.codex.enabled && 'codex'].filter(Boolean).join(', ')}`);

  // 3. the wiring init does
  let repo = null;
  try { repo = A.repoRoot({ fromLocal: flags.fromLocal }); } catch { repo = null; }
  const ctx = { flags: { fromLocal: flags.fromLocal }, repo, vault, written: [] };
  let codexMode = null;
  if (host === 'claude') {
    io.log(`- install ${A.PLUGIN_ID} from the ${A.MARKETPLACE} marketplace`);
    A.installPlugin(ctx, bin);
  } else {
    const mode = CH.codexInstallMode(bin, A.run);
    io.log(mode === 'plugin'
      ? `- install the Codex plugin ${CH.PLUGIN_ID} from the ${A.MARKETPLACE} marketplace and remove any direct wiring`
      : '- wire the Codex host: hooks.json, the agenticos MCP server, and the skills under ~/.agents/skills');
    codexMode = A.wireCodex(ctx, { bin, mode });
  }

  // 4. that host's fast import phases
  io.log(`- import from ${host === 'claude' ? 'Claude Code' : 'Codex'}: instructions, memories, projects (proposed only), MCP servers`);
  const I = require('./import.js');
  const { report } = await I.runWith({ from: [host], since: '90d', only: FAST, accept: null, dryRun: false, json: false }, { ...opts, io });

  // 5. schedules
  io.log(`- ${rerenderSchedules(A, vault, opts)}`);

  io.log('');
  io.log('Next steps:');
  const steps = [];
  if (host === 'claude') steps.push(`Add this line to your CLAUDE.md (${path.join(A.configDir(), 'CLAUDE.md')}) if it is not there yet:\n       @${path.join(vault, 'AGENTICOS.md')}`);
  else steps.push(codexMode === 'plugin'
    ? `Open \`codex\`, run /hooks, and trust the ${CH.PLUGIN_ID} entries once.`
    : `Open \`codex\`, run /hooks, and trust the AgenticOS entries once (${CH.hooksFile(A.readJson(A.configPath()))}).`);
  steps.push(`Bring in its session history: aos import --from ${host}${report.hosts[host] && report.hosts[host].present ? '' : ' (nothing on disk yet)'}`);
  steps.forEach((s, i) => io.log(`  ${i + 1}. ${s}`));
  return 0;
}

/**
 * Each host's state, as `add` would check it, with nothing written. → { schema, config, vault, hosts: { <host>: { enabled,
 * installed, bin, signedIn (null when the CLI is not found or its check timed out), probe? ('timed out'), install? (Codex:
 * plugin | direct, when on) } } }
 */
function readStatus(opts = {}) {
  const A = opts.aos || require('./aos.js');
  const cfg = A.readJson(A.configPath());
  const on = cfg ? A.hostsOf(cfg) : { claude: false, codex: false };
  const out = { schema: 1, config: cfg ? A.configPath() : null, vault: cfg && typeof cfg.vault === 'string' && cfg.vault ? cfg.vault : null, hosts: {} };
  for (const h of HOSTS) {
    const bin = (h === 'claude' ? A.claudeBin(cfg) : A.codexBin(cfg)) || null;
    // The same checks `add` makes (claudeLoggedIn, codexLoggedIn), each stopped after probeMs: one that hangs is reported
    // as not known, never left running behind Settings ▸ Hosts.
    let signedIn = null;
    let timedOut = false;
    if (bin) {
      const r = A.run(bin, h === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], { capture: true, allowFail: true, timeout: probeMs() });
      if (r.timedOut) timedOut = true;
      else if (h === 'claude') { let j = null; try { j = JSON.parse(r.stdout); } catch { j = null; } signedIn = !!(j && j.loggedIn); }
      else { const out = `${r.stdout}\n${r.stderr}`; signedIn = r.status === 0 && /logged in/i.test(out) && !/not logged in/i.test(out); }
    }
    const row = { enabled: !!on[h], installed: !!bin, bin, signedIn };
    if (timedOut) row.probe = 'timed out';
    if (h === 'codex' && on.codex) row.install = (cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.install) || 'direct';
    out.hosts[h] = row;
  }
  return out;
}

/** `aos hosts status [--json]`. → exit code */
function status(flags = {}, opts = {}) {
  const io = opts.io || console;
  const s = readStatus(opts);
  if (flags.json) { io.log(JSON.stringify(s, null, 2)); return 0; }
  const name = { claude: 'Claude Code', codex: 'Codex' };
  for (const h of HOSTS) {
    const x = s.hosts[h];
    const login = x.probe ? `sign-in unknown (${x.probe})` : x.signedIn ? 'signed in' : 'signed out';
    const parts = [x.enabled ? 'on' : 'off', x.installed ? x.bin : 'CLI not found', x.installed ? login : null].filter(Boolean);
    const next = !x.installed ? `install it, then aos hosts add ${h}` : x.probe ? `check again: aos hosts status` : !x.signedIn ? `sign in (${h === 'claude' ? 'claude auth login' : 'codex login'})${x.enabled ? '' : `, then aos hosts add ${h}`}` : x.enabled ? null : `aos hosts add ${h}`;
    io.log(`${name[h].padEnd(11)} ${parts.join(' · ')}${next ? `  → ${next}` : ''}`);
  }
  return 0;
}

/** `argv` = the words after `aos hosts`. → exit code */
async function main(argv, flags = {}, opts = {}) {
  const [verb, host, ...rest] = argv;
  if (verb === 'status' && !host) return status(flags, opts);
  if (verb !== 'add' || !host || rest.length) throw new UsageError(USAGE);
  return add(host, flags, opts);
}

module.exports = { main, add, status, readStatus, rerenderSchedules, UsageError, Refused, USAGE, FAST };
