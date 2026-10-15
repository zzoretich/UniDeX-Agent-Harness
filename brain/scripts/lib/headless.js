'use strict';
/**
 * headless.js — which agent CLI runs a headless agent job (a prompt routine, a persona duty), and the
 * argv for it (codex-parity D4/D5). Not the provider (sdk/lib/provider.js answers one-shot questions
 * without tools) and not the host (lib/host.js says who fired a hook): a runner is an agent with tools
 * and a working directory, spawned by run-routine.js and persona/run-duty.sh.
 *
 *   resolveRunner({ cfg, kind })  →  { host: 'claude' | 'codex' | null, bin, model, reason }
 *     kind is 'routines' or 'persona'; cfg.<kind>.runner ∈ auto | claude | codex (default auto; the env
 *     AOS_RUNNER overrides it). auto prefers claude when hosts.claude is enabled and a binary resolves,
 *     else codex on the same test. A config without `hosts` (pre-0.5.0) means claude only.
 *     Binaries: PERSONA_CLAUDE_BIN (persona only) / AOS_CODEX_BIN → the recorded hosts.<h>.bin (or the
 *     legacy claude.bin) → `command -v` → the usual install locations; AOS_NO_CLAUDE / AOS_NO_CODEX hide one.
 *     model: the model to pass — routine/duty model for claude; for codex cfg.<kind>.codexModel, else cfg.codex.model
 *     (null = the user's Codex default), because a routine's `model` is a Claude alias by contract.
 *   runnerArgs(host, { prompt, system, model, effort, tools, budget, outFile })  →  { argv, stdin }
 *     claude: the `claude -p` recipe every duty and prompt routine used before (budget enforced by the CLI).
 *     codex:  `codex exec -` with the prompt (system text first) on stdin, workspace-write sandbox, our
 *             hooks off, JSON events on stdout, the final message in outFile. Codex has no budget flag:
 *             the daily cap still gates the start and the spend is estimated afterwards (record-spend.js);
 *             the tools allowlist has no Codex form, the sandbox is the guard.
 *   crossArgs(host, { mode, schema, schemaFile, outFile, model, effort, budget, mcpOff })  →  { argv }
 *     one cross-review / handoff child (spec 2026-09-23-cross-review D4); the prompt always goes on stdin and the
 *     child is always ephemeral (D3). No child in any mode gets an MCP server, a plugin or a connector: claude an
 *     empty strict MCP config; codex every plugin off (that takes their MCP servers and connectors with it), each
 *     server its config.toml declares switched off by name (`mcpOff`, from codexMcpServers()), web search off, and
 *     our hooks plus its app/browser/computer/image tools off — measured live on codex-cli 0.156.1, where
 *     `-c mcp_servers={}` merges instead of emptying. mode 'review' and 'consult' are read-only: claude runs in safe
 *     mode (no CLAUDE.md, skills, plugins or hooks) with only Read/Glob/Grep, codex in the read-only sandbox; 'review'
 *     adds the structured reply (claude --json-schema <schema JSON>, codex --output-schema <schemaFile>). mode 'build'
 *     writes: claude acceptEdits with the user's own permissions, codex workspace-write. An effort the host's CLI does
 *     not take is left off here; the runner refuses it before it gets this far.
 *   seatArgs(host, { agent, prompt, body, model, effort, budget, addDir, cwd, gitDir, outFile })  →  { argv, stdin }
 *     one agent-team seat in its own git worktree (spec 2026-09-28-agent-teams D5). claude: `-p --agent <agent>` in auto
 *     permission mode with no prompts (the classifier approves routine work and denies the rest, never bypassed), capped at
 *     the item's budget left, with the team folder added so the seat can post. codex: `exec -` in the workspace-write sandbox
 *     rooted at the worktree, the repository's git dir added so it can commit, network on for package installs, our hooks
 *     off, and the agent's instructions (`body`) inlined ahead of the prompt, since codex exec has no agent flag.
 *   sessionArgs(host, { prompt, sessionId, resume, model, effort, budget, access, allowCommands })  →  { argv, stdin: null }
 *     one turn of an app session (spec 2026-10-07-unidex-sessions S1, S5; 2026-10-07-sessions-ux U6, U7), run by the app
 *     with the workspace as cwd. The prompt is the last argument, after `--`, so nothing reads stdin. `access` is the
 *     turn's level, read | edit | run (default edit; the older `allowCommands: true` reads as run). claude: stream-json
 *     events with no one to answer a prompt (a tool not allowed is refused): read runs in plan mode, edit in
 *     acceptEdits, run adds Bash; the first turn runs under the app's own `sessionId`, later turns `--resume` it; capped
 *     at `budget`; the model `default` passes no --model (the user's own default). codex: `exec --json` (later
 *     `exec resume --json <resume>`), read in the read-only sandbox, edit and run in workspace-write (commands always
 *     run in the sandbox, without network: it cannot edit read-only with no one to approve), our hooks off, never
 *     asking for approval. Efforts: SESSION_EFFORTS per host; any other level is left off.
 *   codexMcpServers(home)  →  the names of the [mcp_servers.<name>] tables in <home>/config.toml ([] when unreadable).
 *   resolveChief(cfg, deps)  →  where the Chief of Staff's next duty runs (local-first A4), async:
 *     { host, bin, model, effort, home, reason, primary, failover: [{ host, bin, model, effort, home }], skipped: [{ host, why }] }
 *     First the day: persona.perDayUsd is one cap over both hosts (deps.spentToday(): every duty:* ledger row of today,
 *     whichever provider), and a capped day is `daily-cap` on every host — never a reason to move. Then the host: the primary
 *     is persona.runner (AOS_RUNNER overrides it): auto → Claude when it is an enabled host whose CLI resolves and is signed
 *     in, else Codex. A host starts when its CLI resolves and it is signed in (deps.loggedIn: `claude auth status`,
 *     `codex login status`, both free). With both hosts enabled and persona.failover (default true), a primary whose CLI is
 *     missing or signed out moves the duty to the other host's CoS model; `failover` lists that host while the primary
 *     runs. Models per host come from sdk/lib/models.js chiefModel (PERSONA_MODEL, a Claude model by contract, never
 *     reaches Codex); effort from PERSONA_EFFORT → persona.effort → medium. Nobody can start → host null with reason
 *     `waiting-for-host`; persona/chief.js turns either reason into a skipped duty.
 *   CLI: node lib/headless.js --resolve [--kind persona|routines]  prints `host<TAB>bin<TAB>model<TAB>codex home`,
 *        exit 3 (reason on stderr) when no runner resolves. Prompt routines and older run-duty.sh copies read it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOSTS = ['claude', 'codex'];
const CLAUDE_CANDIDATES = [path.join(os.homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
const CODEX_CANDIDATES = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local', 'bin', 'codex')];
const CLAUDE_EFFORTS = ['low', 'medium', 'high'];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
/** What `claude --effort` takes (Claude Code 2.1.281); runnerArgs keeps its narrower routine list. */
const CROSS_CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** What a session turn may pass as its effort, per host: the levels each CLI takes (claude 2.1.293, codex-cli 0.158.0). */
const SESSION_EFFORTS = { claude: CROSS_CLAUDE_EFFORTS, codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
/** A session turn's access levels (spec 2026-10-07-sessions-ux U7). */
const SESSION_ACCESS = ['read', 'edit', 'run'];
const CROSS_MODES = ['review', 'consult', 'build'];
/** The only tools a read-only claude child gets. */
const READ_TOOLS = 'Read,Glob,Grep';
/** Codex features no cross-review child gets: each is a way to act outside the shell sandbox (plugins carry the
 *  connectors and their MCP servers). */
const CODEX_OFF = ['hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'image_generation'];
const EMPTY_MCP = '{"mcpServers":{}}';

function isExecutableFile(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}
function defaultLookup(name) {
  try {
    const out = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}

function hostEnabled(cfg, h) {
  const hosts = cfg && cfg.hosts && typeof cfg.hosts === 'object' ? cfg.hosts : null;
  if (!hosts) return h === 'claude';
  return !!(hosts[h] && typeof hosts[h] === 'object' && hosts[h].enabled !== false);
}

/** The binary for a host, or null. lookup(name) is injectable. */
function resolveBin(h, { cfg, env = process.env, kind, lookup = defaultLookup, candidates } = {}) {
  const cands = (list) => (candidates === false ? [] : Array.isArray(candidates) ? candidates : list);
  if (h === 'claude') {
    if (env.AOS_NO_CLAUDE === '1') return null;
    if (kind === 'persona' && env.PERSONA_CLAUDE_BIN) return isExecutableFile(env.PERSONA_CLAUDE_BIN) ? env.PERSONA_CLAUDE_BIN : null;
    const recorded = (cfg && cfg.hosts && cfg.hosts.claude && cfg.hosts.claude.bin) || (cfg && cfg.claude && cfg.claude.bin);
    if (recorded && isExecutableFile(recorded)) return recorded;
    return lookup('claude') || cands(CLAUDE_CANDIDATES).find(isExecutableFile) || null;
  }
  if (env.AOS_NO_CODEX === '1') return null;
  if (env.AOS_CODEX_BIN) return isExecutableFile(env.AOS_CODEX_BIN) ? env.AOS_CODEX_BIN : null;
  const recorded = (cfg && cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.bin) || (cfg && cfg.codex && cfg.codex.bin);
  if (recorded && isExecutableFile(recorded)) return recorded;
  return lookup('codex') || cands(CODEX_CANDIDATES).find(isExecutableFile) || null;
}

function defaultConfig() {
  try { return require('./config.js').loadConfig(); } catch { return {}; }
}

/** The Codex home `aos init` recorded (hosts.codex.home), or null: a headless codex run must use the same one. */
function codexHomeOf(cfg) {
  const h = cfg && cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.home;
  return typeof h === 'string' && h ? h : null;
}

/** See the module comment. `cfg` undefined → loadConfig(). */
function resolveRunner({ cfg, kind = 'routines', env = process.env, lookup, candidates } = {}) {
  const c = cfg === undefined ? defaultConfig() : (cfg || {});
  const section = c[kind] && typeof c[kind] === 'object' ? c[kind] : {};
  const pref = HOSTS.includes(env.AOS_RUNNER) ? env.AOS_RUNNER : HOSTS.includes(section.runner) ? section.runner : 'auto';
  const order = pref === 'auto' ? HOSTS : [pref];
  const why = [];
  for (const h of order) {
    if (pref === 'auto' && !hostEnabled(c, h)) { why.push(`${h} host disabled`); continue; }
    const bin = resolveBin(h, { cfg: c, env, kind, lookup, candidates });
    if (!bin) { why.push(`${h} CLI not found`); continue; }
    // A kind's own Codex model (persona.codexModel, routines.codexModel), else codex.model, else the user's Codex default.
    const str = (v) => (typeof v === 'string' && v ? v : null);
    const model = h === 'codex' ? (str(section.codexModel) || str(c.codex && c.codex.model)) : null;
    const home = h === 'codex' ? codexHomeOf(c) : null;
    return { host: h, bin, model, home, reason: pref === 'auto' ? 'auto' : `${kind}.runner=${pref}` };
  }
  return { host: null, bin: null, model: null, home: null, reason: why.join('; ') || 'no host enabled' };
}

/** n(v, d): an explicit finite, non-negative number (0 included) is honoured, anything else is the default (record-spend.js). */
function money(v, d) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d; }
const DEFAULT_DUTY_DAY_USD = 6;

/** The CoS's effort on `host`: PERSONA_EFFORT → persona.effort → medium, each only when that host's CLI takes it. */
function chiefEffort(host, cfg, env = process.env) {
  const levels = host === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;
  const persona = (cfg && cfg.persona) || {};
  for (const v of [env.PERSONA_EFFORT, persona.effort]) if (levels.includes(v)) return v;
  return 'medium';
}

/** The default sign-in check: free on both CLIs (local-first A16), capped at 15 s so a hung CLI reads as signed out. */
async function chiefLoggedIn(host, bin) {
  try {
    const cli = require(host === 'codex' ? '../sdk/lib/codex-cli.js' : '../sdk/lib/claude-cli.js');
    return !!(await cli.loginProbe({ bin, timeoutMs: 15_000 }));
  } catch { return false; }
}
/** Today's duty spend over both hosts (record-spend.js); 0 when the ledger cannot be read. */
function chiefSpentToday() {
  try { return require('../persona/record-spend.js').dutySpendToday(); } catch { return 0; }
}
function readAnswers(vault) {
  if (!vault) return null;
  try { return JSON.parse(fs.readFileSync(path.join(vault, 'persona', 'answers.json'), 'utf8')); } catch { return null; }
}

/**
 * See the module comment. deps: { env, lookup, candidates, loggedIn(host, bin), spentToday(), answers, vault }. Every host
 * is checked at most once; the failover entry is resolved (its binary) but not probed; a capped day probes nothing.
 */
async function resolveChief(cfg, deps = {}) {
  const c = cfg === undefined ? defaultConfig() : (cfg || {});
  const env = deps.env || process.env;
  const persona = c.persona && typeof c.persona === 'object' ? c.persona : {};
  const { chiefModel } = require('../sdk/lib/models.js');
  const answers = deps.answers !== undefined ? deps.answers : readAnswers(deps.vault || env.AOS_VAULT || c.vault);
  const pref = HOSTS.includes(env.AOS_RUNNER) ? env.AOS_RUNNER : HOSTS.includes(persona.runner) ? persona.runner : 'auto';
  const failoverOn = persona.failover !== false;
  const both = HOSTS.every((h) => hostEnabled(c, h));
  const perDay = money(persona.perDayUsd, DEFAULT_DUTY_DAY_USD);
  const loggedIn = deps.loggedIn || chiefLoggedIn;
  const spentToday = deps.spentToday || chiefSpentToday;
  const binOf = (h) => resolveBin(h, { cfg: c, env, kind: 'persona', lookup: deps.lookup, candidates: deps.candidates });
  const entry = (h, bin) => ({ host: h, bin, model: chiefModel(h, c, { env, answers }).tag, effort: chiefEffort(h, c, env), home: h === 'codex' ? codexHomeOf(c) : null });

  const none = (reason, skipped, primary = null) => ({ host: null, bin: null, model: null, effort: null, home: null, reason, primary, failover: [], skipped });
  // One cap over both hosts (the owner's call on local-first A4): a capped day is skipped everywhere, never moved.
  const spent = Number(spentToday()) || 0;
  if (spent >= perDay) return none('daily-cap', [{ host: null, why: `today's duty spend ${spent.toFixed(2)} of ${perDay} USD (persona.perDayUsd)` }]);
  const seen = {};
  /** { bin, why }: why is null when `h` can start a duty now. */
  const check = async (h) => {
    if (seen[h]) return seen[h];
    const bin = binOf(h);
    let why = null;
    if (!bin) why = 'CLI not found';
    else if (!(await loggedIn(h, bin))) why = 'signed out';
    seen[h] = { bin, why };
    return seen[h];
  };

  const skipped = [];
  let primary = pref;
  if (pref === 'auto') {
    primary = null;
    for (const h of HOSTS) {
      if (!hostEnabled(c, h)) continue;
      const st = await check(h);
      // auto takes the first enabled host that is installed and signed in.
      if (!st.why) { primary = h; break; }
      skipped.push({ host: h, why: st.why });
    }
    if (!primary) return none('waiting-for-host', skipped.length ? skipped : [{ host: null, why: 'no host enabled' }]);
  }
  const other = HOSTS.find((h) => h !== primary);
  const canFail = failoverOn && both;
  const first = await check(primary);
  if (!first.why) {
    const fo = canFail && !skipped.some((x) => x.host === other) ? [entry(other, binOf(other))] : [];
    return { ...entry(primary, first.bin), reason: pref === 'auto' ? 'auto' : `persona.runner=${pref}`, primary, failover: fo, skipped };
  }
  skipped.push({ host: primary, why: first.why });
  if (canFail && !skipped.some((x) => x.host === other)) {
    const alt = await check(other);
    if (!alt.why) return { ...entry(other, alt.bin), reason: `failover: ${primary} ${first.why}`, primary, failover: [], skipped };
    skipped.push({ host: other, why: alt.why });
  }
  return none('waiting-for-host', skipped, primary);
}

/**
 * Who answers the vault graph's semantic pass (spec 2026-09-23-codex-parity-gaps D3; local-first A14).
 * graph.semantic.runner pins a host (claude | codex); otherwise provider local or ollama names the local engine,
 * → { host: 'local', engine, url, model }: graphify's own `ollama` backend (or `openai` for an OpenAI-compatible
 * server) at that address, on the workhorse, with no spend (graph-build.js checks the model is pulled before it runs);
 * otherwise an explicit provider claude or codex names it; otherwise Claude when it is an enabled host with a binary,
 * else Codex on the same test. → { host, bin } or null. `bins` replaces the lookups (tests).
 */
function graphRunner(cfg, { env = process.env, lookup, candidates, bins } = {}) {
  const c = cfg || {};
  const sem = (c.graph && c.graph.semantic) || {};
  if (!HOSTS.includes(sem.runner) && (c.provider === 'local' || c.provider === 'ollama')) {
    const lc = require('../sdk/lib/local-config.js').localCfg(c);
    return { host: 'local', engine: lc.engine, url: lc.url, model: lc.workhorse.tag };
  }
  const pinned = HOSTS.includes(sem.runner) ? sem.runner : HOSTS.includes(c.provider) ? c.provider : null;
  for (const h of pinned ? [pinned] : HOSTS) {
    if (!pinned && !hostEnabled(c, h)) continue;
    const bin = bins && Object.prototype.hasOwnProperty.call(bins, h) ? bins[h] : resolveBin(h, { cfg: c, env, lookup, candidates });
    if (bin) return { host: h, bin };
  }
  return null;
}

/** { argv, stdin } for one headless agent run on `host`. */
function runnerArgs(host, { prompt = '', system = '', model, effort = 'medium', tools = '', budget, outFile } = {}) {
  if (host === 'codex') {
    const argv = ['exec', '-', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-c', 'features.hooks=false', '--json'];
    if (outFile) argv.push('-o', String(outFile));
    if (model) argv.push('-m', String(model));
    if (CODEX_EFFORTS.includes(effort)) argv.push('-c', `model_reasoning_effort="${effort}"`);
    return { argv, stdin: system ? `${system}\n\n---\n\n${prompt}` : String(prompt) };
  }
  const argv = ['-p', String(prompt), '--model', String(model || 'haiku'), '--effort', CLAUDE_EFFORTS.includes(effort) ? effort : 'medium'];
  if (tools) argv.push('--allowedTools', String(tools));
  if (budget !== undefined && budget !== null && budget !== '') argv.push('--max-budget-usd', String(budget));
  argv.push('--output-format', 'json', '--strict-mcp-config', '--no-session-persistence');
  if (system) argv.push('--append-system-prompt', String(system));
  return { argv, stdin: null };
}

/** A config key segment for `-c`: bare when TOML allows it, quoted otherwise. */
function tomlKey(name) { return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name); }

/** The servers <home>/config.toml declares ([mcp_servers.<name>] tables, not their sub-tables such as .env). */
function codexMcpServers(home) {
  let text = '';
  try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return []; }
  const names = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\[\s*mcp_servers\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const name = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] !== undefined ? m[2] : m[3];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** { argv } for one cross-review child on `host` (module comment). Throws on an unknown mode. */
function crossArgs(host, { mode, schema, schemaFile, outFile, model, effort, budget, mcpOff = [] } = {}) {
  if (!CROSS_MODES.includes(mode)) throw new Error(`crossArgs: unknown mode ${mode}`);
  const readOnly = mode !== 'build';
  if (host === 'codex') {
    const argv = ['exec', '-', '--ephemeral', '--skip-git-repo-check', '-s', readOnly ? 'read-only' : 'workspace-write'];
    for (const f of CODEX_OFF) argv.push('-c', `features.${f}=false`);
    for (const name of mcpOff) argv.push('-c', `mcp_servers.${tomlKey(name)}.enabled=false`);
    argv.push('-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '--json');
    if (outFile) argv.push('-o', String(outFile));
    if (model) argv.push('-m', String(model));
    if (CODEX_EFFORTS.includes(effort)) argv.push('-c', `model_reasoning_effort="${effort}"`);
    if (mode === 'review' && schemaFile) argv.push('--output-schema', String(schemaFile));
    return { argv };
  }
  const argv = ['-p', '--output-format', 'json', '--no-session-persistence', '--permission-prompts', 'none',
    '--strict-mcp-config', '--mcp-config', EMPTY_MCP, '--no-chrome'];
  if (readOnly) {
    argv.push('--safe-mode', '--tools', READ_TOOLS, '--allowedTools', READ_TOOLS, '--permission-mode', 'dontAsk');
    if (mode === 'review' && schema) argv.push('--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema));
  } else {
    // The user's normal permissions: a denied proof command is a reported failure, never a reason to bypass them.
    argv.push('--permission-mode', 'acceptEdits');
  }
  if (model) argv.push('--model', String(model));
  if (CROSS_CLAUDE_EFFORTS.includes(effort)) argv.push('--effort', effort);
  if (budget !== undefined && budget !== null && budget !== '') argv.push('--max-budget-usd', String(budget));
  return { argv };
}

/** What a codex seat reads after its instructions: it cannot always post itself, so its last line is its post. */
const SEAT_CODEX_TAIL = [
  'You are running under Codex, in a workspace-write sandbox rooted at this worktree, with network access for installing packages.',
  'Your last message must be your one-line channel post, starting with its kind, for example',
  '`handoff: waves 1-2 done (a1b2c3d..e4f5a6b); wave 3 is next`. The dispatcher posts it when you cannot.',
].join('\n');

/** { argv, stdin } for one agent-team seat on `host` (module comment). */
function seatArgs(host, { agent, prompt = '', body = '', model, effort, budget, addDir, cwd, gitDir, outFile } = {}) {
  const set = (v) => v !== undefined && v !== null && v !== '' && v !== 'inherit';
  if (host === 'codex') {
    const argv = ['exec', '-', '--skip-git-repo-check', '-s', 'workspace-write'];
    if (cwd) argv.push('-C', String(cwd));
    if (gitDir) argv.push('--add-dir', String(gitDir));
    argv.push('-c', 'sandbox_workspace_write.network_access=true', '-c', 'features.hooks=false', '-c', 'approval_policy="never"', '--json');
    if (outFile) argv.push('-o', String(outFile));
    if (set(model)) argv.push('-m', String(model));
    if (CODEX_EFFORTS.includes(effort)) argv.push('-c', `model_reasoning_effort="${effort}"`);
    const parts = [body, SEAT_CODEX_TAIL, prompt].map((s) => String(s || '').trim()).filter(Boolean);
    return { argv, stdin: parts.join('\n\n---\n\n') };
  }
  if (!agent) throw new Error('seatArgs: a claude seat needs its agent');
  const argv = ['-p', String(prompt), '--agent', String(agent), '--output-format', 'json',
    '--permission-mode', 'auto', '--permission-prompts', 'none'];
  if (set(budget)) argv.push('--max-budget-usd', Number(budget).toFixed(2));
  if (addDir) argv.push('--add-dir', String(addDir));
  if (set(model)) argv.push('--model', String(model));
  if (CROSS_CLAUDE_EFFORTS.includes(effort)) argv.push('--effort', effort);
  return { argv, stdin: '' };
}

/** { argv, stdin: null } for one turn of an app session on `host` (module comment). */
function sessionArgs(host, { prompt = '', sessionId, resume, model, effort, budget, access, allowCommands = false } = {}) {
  const set = (v) => v !== undefined && v !== null && v !== '' && v !== 'inherit';
  if (!String(prompt).trim()) throw new Error('sessionArgs: a turn needs a prompt');
  if (set(access) && !SESSION_ACCESS.includes(access)) throw new Error(`sessionArgs: no such access level ${access}`);
  const level = set(access) ? access : allowCommands ? 'run' : 'edit';
  if (host === 'codex') {
    const argv = set(resume) ? ['exec', 'resume'] : ['exec'];
    const sandbox = level === 'read' ? 'read-only' : 'workspace-write';
    argv.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, '-c', 'features.hooks=false', '-c', 'approval_policy="never"');
    if (set(model)) argv.push('-m', String(model));
    if (SESSION_EFFORTS.codex.includes(effort)) argv.push('-c', `model_reasoning_effort="${effort}"`);
    if (set(resume)) argv.push(String(resume));
    argv.push('--', String(prompt));
    return { argv, stdin: null };
  }
  if (host !== 'claude') throw new Error(`sessionArgs: no such host ${host}`);
  if (!set(resume) && !set(sessionId)) throw new Error('sessionArgs: a first claude turn needs its sessionId');
  const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', level === 'read' ? 'plan' : 'acceptEdits', '--permission-prompts', 'none'];
  argv.push(...(set(resume) ? ['--resume', String(resume)] : ['--session-id', String(sessionId)]));
  if (level === 'run') argv.push('--allowedTools', 'Bash');
  if (set(budget)) argv.push('--max-budget-usd', Number(budget).toFixed(2));
  if (set(model) && model !== 'default') argv.push('--model', String(model));
  if (SESSION_EFFORTS.claude.includes(effort)) argv.push('--effort', effort);
  argv.push('--', String(prompt));
  return { argv, stdin: null };
}

/** What a headless child never inherits: CLAUDECODE would tell claude it runs inside another session. */
const HEADLESS_UNSET = ['CLAUDECODE'];

/** The child's env: headless, never HEADLESS_UNSET, and the recorded Codex home unless the environment names one already. */
function headlessEnv(base = process.env, { codexHome = null } = {}) {
  const env = { ...base, AOS_HEADLESS: '1' };
  for (const k of HEADLESS_UNSET) delete env[k];
  if (codexHome && !env.CODEX_HOME) env.CODEX_HOME = codexHome;
  return env;
}

function main(argv) {
  if (!argv.includes('--resolve')) { process.stderr.write('usage: headless.js --resolve [--kind persona|routines]\n'); return 2; }
  const i = argv.indexOf('--kind');
  const kind = i !== -1 && ['persona', 'routines'].includes(argv[i + 1]) ? argv[i + 1] : 'routines';
  const r = resolveRunner({ kind });
  if (!r.host) { process.stderr.write(`headless: no runner for ${kind} (${r.reason})\n`); return 3; }
  process.stdout.write(`${r.host}\t${r.bin}\t${r.model || ''}\t${r.home || ''}\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { resolveRunner, resolveChief, chiefEffort, graphRunner, resolveBin, runnerArgs, crossArgs, seatArgs, sessionArgs, codexMcpServers, headlessEnv, hostEnabled, codexHomeOf, HEADLESS_UNSET, HOSTS, CODEX_EFFORTS, CLAUDE_EFFORTS, CROSS_CLAUDE_EFFORTS, CROSS_MODES, CODEX_OFF, SEAT_CODEX_TAIL, SESSION_EFFORTS, SESSION_ACCESS };
