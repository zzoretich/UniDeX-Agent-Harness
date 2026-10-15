'use strict';
/**
 * team-run.js — `aos team dispatch`: one headless run of one seat on one board item, in its own git worktree
 * (spec 2026-09-28-agent-teams D5-D9, D11).
 *
 *   1. Refuses when the team is DISABLED, the seat is paused, the lead, or not the item's owner, the item waits on a
 *      gate or its stage's gate is not approved, or the phase budget is spent.
 *   2. Resolves the provider: the seat's own, or for `opposite` the one that did not build the item (`builders`), so a
 *      reviewer never runs on the provider that built what it reviews. The host must be enabled and have a binary.
 *   3. Forks team/<team>/<item>/<member> from the item's trunk team/<team>/<item>/trunk (cut from the project's HEAD on
 *      first use) at workspaces/_worktrees/<team>/<item>/<member> (vaults may still hold the older _worktrees/<item>/<member>),
 *      writes the run's marker, and runs lib/headless.js seatArgs under headlessEnv.
 *   4. Records spend (family team:<team>:<member>; Codex priced from tokens) and a telemetry run as the lead's, with the
 *      seat as its sub-agent, so the Runs tab rolls the seat up under the lead (D9).
 *   5. Merges the seat branch into the trunk (fast-forward, else a merge commit; a conflict is a blocker), adds an execute
 *      seat that committed to `builders`, posts the seat's final line when it did not post, and a blocker for a failure,
 *      a kill, uncommitted work or a conflict. Then the run's row lands in runs.jsonl and the marker goes. Its `session`
 *      is the host's own id for the run: Claude's session_id, Codex's thread id (thread.started), which Spaces uses to
 *      credit the run to the item's workspace (spaces-redesign D20, D34).
 *
 * SIGTERM, SIGHUP or SIGINT stops the seat (SIGKILL after GRACE_MS) and records the run as killed. A SIGKILL leaves the
 * marker for the next sweep (teams.js reapKilledRuns). --detach hands the same command to launchd (macOS), systemd-run
 * --user (Linux), or else a detached respawn, so a closing terminal cannot take the run with it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./teams.js');
const H = require('./headless.js');

const PROVIDERS = ['claude', 'codex'];
const SEAT_KINDS = ['note', 'handoff', 'done', 'blocker', 'question'];
const CAUGHT_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'];
const GRACE_MS = 10000; // a stopped seat gets this long to exit on SIGTERM before SIGKILL (launchd waits 20 s)
const { Refusal } = T;
const refuse = (msg) => { throw new Refusal(msg); };

// ── git ──

function gitTry(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function git(cwd, args) {
  const r = gitTry(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.err || r.out}`);
  return r.out;
}

// ── preflight: pure, so tests can call it ──

/** The provider a seat runs on for this item, or a Refusal. */
function resolveProvider(m, it, forced) {
  if (forced && !PROVIDERS.includes(forced)) refuse(`--provider must be claude or codex, not ${forced}`);
  if (m.provider === 'opposite') {
    const built = PROVIDERS.filter((p) => ((it.builders && it.builders[p]) || []).length);
    if (!built.length) refuse(`${it.id} has no builders yet, so ${m.id} has no opposite provider to run on`);
    if (built.length === 1) {
      const other = PROVIDERS.find((p) => p !== built[0]);
      if (forced && forced !== other) refuse(`${m.id} reviews work built on ${built[0]}, so it runs on ${other}, never on ${forced}`);
      return other;
    }
    if (!forced) refuse(`both providers built ${it.id}: run ${m.id} once with --provider claude and once with --provider codex, each --note scoped to the other provider's work`);
    return forced;
  }
  if (!PROVIDERS.includes(m.provider)) refuse(`${m.id} has an unknown provider "${m.provider}" in TEAM.md`);
  if (forced && forced !== m.provider) refuse(`${m.id} runs on ${m.provider} per TEAM.md; change TEAM.md rather than the dispatch`);
  return m.provider;
}

/** Whether the item's stage may run: a stage named after a gate needs that gate approved; any other stage after the
 *  first needs the first gate approved (a later gate on the item means it was, since an item keeps only its latest). */
function gateAllows(t, it) {
  if (!t.gates.length) return null;
  const g = it.gate || null;
  const i = t.stages.indexOf(it.stage);
  if (t.gates.includes(it.stage) && i > 0) {
    return g && g.name === it.stage && g.state === 'approved' ? null : `${it.id} is in ${it.stage}, but its ${it.stage} gate is not approved`;
  }
  if (i > 0 && !(g && (g.name !== t.gates[0] || g.state === 'approved'))) return `${it.id} is in ${it.stage}, but its ${t.gates[0]} gate is not approved`;
  return null;
}

/** Everything that must hold before a run. → { m, provider, left, warnings } or a Refusal. */
function preflight(t, memberId, it, { provider: forced } = {}) {
  if (t.disabled) refuse(`the ${t.id} team is DISABLED`);
  const m = T.member(t, memberId);
  if (!m) refuse(`${memberId} is not on the ${t.id} team`);
  if (memberId === t.lead) refuse(`${memberId} is the lead and runs interactively, not through dispatch`);
  if (m.paused) refuse(`${memberId} is paused in TEAM.md`);
  if (!it) refuse('no such board item');
  const own = T.owners(it);
  if (!own.includes(memberId)) refuse(`${memberId} is not the owner of ${it.id} (owner: ${own.join(', ') || 'nobody'})`);
  if (it.status === 'done' || it.status === 'paused') refuse(`${it.id} is ${it.status}`);
  const g = it.gate || null;
  if (it.status === 'gate' || (g && g.state === 'pending')) refuse(`${it.id} waits on the user at the ${(g && g.name) || '?'} gate`);
  const blocked = gateAllows(t, it);
  if (blocked) refuse(blocked);
  const usd = Number((it.budget && it.budget.usd) || 0);
  const spent = Number((it.budget && it.budget.spentUsd) || 0);
  const left = Math.round((usd - spent) * 100) / 100;
  if (!(left > 0)) refuse(`${it.id}'s phase budget is spent ($${spent} of $${usd}); only the user raises it`);
  const warnings = [];
  const stages = [].concat(m.stage || []);
  if (!stages.includes(it.stage) && !stages.includes('all')) warnings.push(`${memberId}'s stage in TEAM.md is ${stages.join(',') || '(none)'}, and ${it.id} is in ${it.stage}`);
  return { m, provider: resolveProvider(m, it, forced), left, warnings };
}

// ── the project repo and the item's branches ──

function projectRepo(vault, it) {
  if (!it.path) refuse(`${it.id} has no "path" on the board`);
  const workspaces = path.join(vault, 'workspaces');
  const repo = path.resolve(vault, it.path);
  const under = (root, p) => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep)[0].startsWith('_'); };
  if (!under(workspaces, repo)) refuse(`${it.id}'s path ${it.path} is not a project under workspaces/`);
  if (!fs.existsSync(repo)) refuse(`${it.path} does not exist`);
  // Real paths too, so a symlink under workspaces/ cannot point a seat at a repository elsewhere (AT-R2).
  const realVault = fs.realpathSync(vault);
  const realWs = fs.realpathSync(workspaces);
  if (realWs !== path.join(realVault, 'workspaces')) refuse('workspaces/ resolves outside the vault'); // AT-REV-05
  if (!under(realWs, fs.realpathSync(repo))) refuse(`${it.id}'s path ${it.path} leads outside workspaces/`);
  const top = gitTry(repo, ['rev-parse', '--show-toplevel']);
  if (!top.ok || fs.realpathSync(top.out) !== fs.realpathSync(repo)) refuse(`${it.path} is not its own git repository (the lead runs git init there first)`);
  return repo;
}

function branchExists(repo, name) { return gitTry(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok; }
function checkedOut(repo, name) {
  return gitTry(repo, ['worktree', 'list', '--porcelain']).out.split('\n').some((l) => l === `branch refs/heads/${name}`);
}

/** An item's branches and a seat's worktree, scoped by team so two teams on one project never share them (AT-04). */
function branchNames(teamId, itemId, memberId, worktrees) {
  return { trunk: `team/${teamId}/${itemId}/trunk`, seat: `team/${teamId}/${itemId}/${memberId}`, wt: path.join(worktrees, teamId, itemId, memberId) };
}

/** Cut the trunk and the seat branch and add the worktree. → { trunk, seat, wt, base } */
function prepareWorktree(repo, names, it, memberId) {
  const { trunk, seat, wt } = names;
  gitTry(repo, ['worktree', 'prune']);
  if (fs.existsSync(wt)) refuse(`a ${memberId} run on ${it.id} is still going, or left its worktree at ${wt}; once it is done: git -C ${repo} worktree remove ${wt}`);
  if (!gitTry(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) git(repo, ['commit', '--allow-empty', '-m', `chore: start ${path.basename(repo)}`]);
  if (!branchExists(repo, trunk)) git(repo, ['branch', trunk, 'HEAD']);
  if (branchExists(repo, seat)) {
    if (!gitTry(repo, ['merge-base', '--is-ancestor', seat, trunk]).ok) refuse(`${seat} has commits the trunk lacks (an earlier merge conflict?); resolve it before running ${memberId} again`);
    if (checkedOut(repo, seat)) refuse(`${seat} is checked out somewhere else`);
    git(repo, ['branch', '-f', seat, trunk]);
  } else {
    git(repo, ['branch', seat, trunk]);
  }
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, ['worktree', 'add', '--quiet', wt, seat]);
  return { trunk, seat, wt, base: git(repo, ['rev-parse', trunk]) };
}

/** Merge the seat branch into the trunk without checking the trunk out. → { commits, head } or { commits, conflict } */
function mergeBack(repo, trunk, seat) {
  const commits = Number(git(repo, ['rev-list', '--count', `${trunk}..${seat}`]));
  if (!commits) return { commits: 0, head: git(repo, ['rev-parse', trunk]) };
  if (checkedOut(repo, trunk)) return { commits, conflict: `${trunk} is checked out in a worktree, so it was left alone` };
  for (let i = 0; i < 5; i++) {
    const old = git(repo, ['rev-parse', trunk]);
    let next;
    if (gitTry(repo, ['merge-base', '--is-ancestor', old, seat]).ok) {
      next = git(repo, ['rev-parse', seat]);
    } else {
      const r = gitTry(repo, ['merge-tree', '--write-tree', '--name-only', old, seat]);
      if (!r.ok) return { commits, conflict: `merge conflict in ${r.out.split('\n').slice(1).filter(Boolean).slice(0, 5).join(', ') || 'unknown files'}` };
      next = git(repo, ['commit-tree', r.out.split('\n')[0], '-p', old, '-p', seat, '-m', `Merge ${seat} into ${trunk}`]);
    }
    // Compare-and-swap: a parallel seat that merged first makes this fail, and the loop merges on top of it.
    if (gitTry(repo, ['update-ref', `refs/heads/${trunk}`, next, old]).ok) return { commits, head: next };
  }
  return { commits, conflict: `${trunk} kept moving; the merge was retried 5 times` };
}

// ── the seat ──

/** The agent's instructions for the host that runs it (AT-06). A Claude seat needs its Claude Code definition (`--agent`
 *  loads it). A Codex seat uses its Codex definition, else the Claude one's body (the two are mirrors after `aos agents sync`). */
function agentBody(agent, { claudeDir, codexDir }, provider = 'claude') {
  const A = require('./agent-translate.js');
  const where = T.agentFiles(agent, { claudeDir, codexDir });
  const fromClaude = () => { if (!where.claude) return null; const r = A.readClaude(fs.readFileSync(where.claude, 'utf8')); return r.ok && r.body.trim() ? r.body.trim() : null; };
  const fromCodex = () => { if (!where.codex) return null; const r = A.readCodex(fs.readFileSync(where.codex, 'utf8')); return r.ok && r.instructions.trim() ? r.instructions.trim() : null; };
  if (provider === 'claude') return fromClaude() || refuse(`${agent} has no Claude Code agent file, which claude --agent needs (aos agents sync mirrors a Codex one)`);
  return fromCodex() || fromClaude() || refuse(`no agent named ${agent} in either host's agents folder`);
}

/** The model a seat runs on for `provider` (AT-05): the member's model when it names one of that provider's models, else the
 *  provider's default (codex: cfg.codex.model or the user's Codex default; claude: the CLI's default). */
function modelFor(provider, m, cfg) {
  const want = typeof m.model === 'string' && m.model && m.model !== 'inherit' ? m.model : null;
  const codexModels = require('./settings-schema.js').CODEX_MODELS;
  if (provider === 'codex') return want && codexModels.includes(want) ? want : (typeof (cfg.codex && cfg.codex.model) === 'string' && cfg.codex.model) || null;
  return want && !codexModels.includes(want) ? want : null;
}

function promptFor(it, { waves, note }) {
  const lines = [it.id];
  if (waves) lines.push('', `Waves: ${waves}`);
  if (note) lines.push('', `Note from the lead: ${note}`);
  return lines.join('\n');
}

/** The seat's last line as a channel post: `kind: text`, an echoed `aos team post` command, or a plain note. */
function parseFinal(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const line = (lines[lines.length - 1] || '').replace(/^`+|`+$/g, '');
  const cmd = /--kind\s+(\w+)\s+(["'])((?:(?!\2)[^\\]|\\.)*)\2\s*$/.exec(line);
  if (cmd && SEAT_KINDS.includes(cmd[1])) return { kind: cmd[1], text: cmd[3].replace(/\\(["'])/g, '$1') };
  const lead = /^(note|handoff|done|blocker|question)\s*[:-]\s*/i.exec(line);
  if (lead) return { kind: lead[1].toLowerCase(), text: line.slice(lead[0].length).trim() };
  return { kind: 'note', text: line };
}

/** The thread id a Codex seat's `exec --json` events start with (thread.started, read by session-events.js), or null. The
 *  ledger records it as the run's `session`, as it does Claude's session_id (spaces-redesign D34). */
function codexThreadId(events) {
  try {
    const p = require('./session-events.js').createParser('codex');
    p.push(String(events || ''));
    p.end();
    return p.state.hostSessionId || null;
  } catch { return null; }
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeMarker(file, obj) { require('./fsx.js').writeAtomic(file, JSON.stringify(obj, null, 2) + '\n'); }

/** Start the seat's CLI and resolve when it exits. A caught signal (`ctl.stop`) or the timeout sends it SIGTERM, then
 *  SIGKILL after GRACE_MS. → { status, signal, error, timedOut } */
function runSeat(bin, argv, { cwd, env, stdin, outFd, errFd, timeoutMs, ctl, graceMs = GRACE_MS }) {
  return new Promise((resolve) => {
    const res = { status: null, signal: null, error: null, timedOut: false };
    let child = null;
    let timer = null;
    let hard = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(hard); ctl.stop = null;
      resolve(res);
    };
    const stop = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (!hard) hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
    };
    if (ctl.caught) { finish(); return; } // signalled before the seat started: it never runs
    try { child = spawn(bin, argv, { cwd, env, stdio: ['pipe', outFd, errFd] }); } catch (e) { res.error = e; finish(); return; }
    ctl.stop = stop;
    if (ctl.onSpawn && child.pid) ctl.onSpawn(child.pid);
    timer = setTimeout(() => { res.timedOut = true; stop(); }, timeoutMs);
    child.on('error', (e) => { if (child.pid === undefined) { res.error = e; finish(); } });
    child.on('close', (code, signal) => { res.status = code; res.signal = signal; finish(); });
    child.stdin.on('error', () => { /* the seat exited before it read its stdin */ });
    child.stdin.end(stdin);
  });
}

function recordSpend(row) {
  try { return require('../sdk/lib/spend-ledger.js').recordSpend(row); } catch { return null; }
}

/** A telemetry run as the lead's, with the seat as its sub-agent (D9). Never fails the dispatch. */
function startTelemetry(leadAgent, seatAgent, prompt) {
  if (!leadAgent) return null;
  try {
    const tel = require('../sdk/lib/telemetry.js');
    const run = tel.startRun({ script: leadAgent, prompt });
    const evt = { type: 'tool_use_batch', tools: [{ name: 'Agent', subagent_type: seatAgent }], ts: Date.now() };
    run.events.push(evt);
    try { fs.appendFileSync(run.liveFile, JSON.stringify(evt) + '\n'); } catch { /* live file is best-effort */ }
    return { tel, run };
  } catch { return null; }
}
async function endTelemetry(t, opts) {
  if (!t) return;
  try { await t.tel.endRun(t.run, opts); } catch { /* telemetry never fails a run */ }
}

// ── the run ──

/**
 * ctx: { vault, cfg (loadConfig()), env, claudeDir, codexDir, stderr }. → { code, out }
 */
async function dispatch(opts, ctx) {
  const { vault, cfg = {}, env = process.env } = ctx;
  const stderr = ctx.stderr || ((s) => process.stderr.write(s));
  const root = T.teamsRoot(vault);
  const t = T.readTeam(root, opts.team);
  for (const k of T.reapKilledRuns(t)) stderr(`team: found a killed run: ${k.member} on ${k.item} (${k.run}); recorded it and posted a blocker\n`);
  const item = T.boardItems(t).get(opts.item);
  if (!item) refuse(`no board item ${opts.item} on ${t.id}`);
  const { m, provider, left, warnings } = preflight(t, opts.member, item, { provider: opts.provider });
  const repo = projectRepo(vault, item);
  if (!H.hostEnabled(cfg, provider)) refuse(`${m.id} runs on ${provider}, and the ${provider} host is off on this machine (aos hosts add ${provider} turns it on)`);
  const bin = H.resolveBin(provider, { cfg, env });
  if (!bin) refuse(`${m.id} runs on ${provider}, and no ${provider} CLI was found on this machine`);
  const agent = m.agent || `${t.id}-${m.id}`;
  const dirs = { claudeDir: ctx.claudeDir, codexDir: ctx.codexDir };
  const body = agentBody(agent, dirs, provider);
  const str = (v) => (typeof v === 'string' && v && v !== 'inherit' ? v : null);
  const model = modelFor(provider, m, cfg);
  const effort = str(m.effort);
  const maxUsd = opts.maxUsd === undefined || opts.maxUsd === null ? null : Number(opts.maxUsd);
  if (maxUsd !== null && !(Number.isFinite(maxUsd) && maxUsd >= 0.01 && Math.round(maxUsd * 100) === Math.round(maxUsd * 1e6) / 1e4)) refuse('--max-usd must be a dollar amount of at least 0.01, in cents'); // AT-R7
  const worktrees = path.join(vault, 'workspaces', '_worktrees');
  const names = branchNames(t.id, item.id, m.id, worktrees);
  const prompt = promptFor(item, opts);
  const plan = {
    team: t.id, member: m.id, item: item.id, provider, bin, agent, model: model || `${provider} default`, effort: effort || `${provider} default`,
    budgetLeftUsd: left, maxUsd, repo, trunk: names.trunk, branch: names.seat, worktree: names.wt, prompt, warnings,
  };
  if (opts.dryRun) return { code: 0, out: JSON.stringify(plan, null, 2), plan };
  for (const w of warnings) stderr(`team: warning: ${w}\n`);
  if (opts.detach) return detach(t, plan, opts.args || [], { ...ctx, worktrees });

  const logDir = path.join(worktrees, '.logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logBase = path.join(logDir, `${t.id}-${item.id}-${m.id}-${stamp()}`);
  const outFile = `${logBase}.final.txt`;
  const log = path.relative(vault, logBase);
  const runsFile = path.join(t.dir, 'runs.jsonl');
  const who = { team: t.id, member: m.id, item: item.id, stage: item.stage, provider, model, effort };
  const runId = path.basename(logBase);
  const startIso = new Date().toISOString();
  const marker = path.join(T.runningDir(t), `${runId}.json`);
  const markerBase = {
    schema: 1, run: runId, ...who, pid: process.pid, pidStart: T.processStart(process.pid), host: os.hostname(), startedAt: startIso, log,
    worktree: path.relative(vault, names.wt),
  };
  // The run's budget is reserved under the board lock together with its marker, so parallel Claude seats on one item can
  // never spend more than its budget between them (AT-02); --max-usd leaves the rest for a parallel seat.
  const reserved = T.withBoard(t, () => {
    const b = T.boardItems(t).get(item.id).budget || {};
    const held = T.liveMarkers(t).filter((x) => x.item === item.id && x.provider === 'claude').reduce((s, x) => s + (Number(x.reservedUsd) || 0), 0);
    const avail = Math.round(((Number(b.usd) || 0) - (Number(b.spentUsd) || 0) - held) * 100) / 100;
    if (provider === 'claude' && !(avail > 0)) refuse(`${item.id}'s phase budget is spent or held by live runs ($${held} held); only the user raises it`);
    const mine = provider === 'claude' ? Math.min(avail, maxUsd === null ? avail : maxUsd) : 0;
    writeMarker(marker, { ...markerBase, reservedUsd: mine });
    return mine;
  });
  let prepared;
  try { prepared = prepareWorktree(repo, names, item, m.id); } catch (e) { fs.rmSync(marker, { force: true }); throw e; }
  const { trunk, seat, wt, base } = prepared;
  const gitDir = path.resolve(wt, git(wt, ['rev-parse', '--git-common-dir']));
  const { argv, stdin } = H.seatArgs(provider, { agent, prompt, body, model, effort, budget: provider === 'claude' ? reserved : undefined, addDir: t.dir, cwd: wt, gitDir, outFile });

  // From here the run is live: its marker says so until its row is in runs.jsonl, and a catchable kill stops the seat.
  const ctl = { caught: null, stop: null };
  const onSignal = (sig) => { if (!ctl.caught) ctl.caught = sig; if (ctl.stop) ctl.stop(); };
  for (const s of CAUGHT_SIGNALS) process.on(s, onSignal);
  // The seat's own pid joins the marker, so a sweep after a SIGKILL can stop a seat that outlived its dispatcher (AT-08).
  ctl.onSpawn = (pid) => { try { writeMarker(marker, { ...markerBase, reservedUsd: reserved, seatPid: pid, seatStart: T.processStart(pid) }); } catch { /* best effort */ } };
  const lead = T.leadOf(t);
  const telemetry = startTelemetry(lead && lead.agent, agent, `team ${t.id}: ${m.id} on ${item.id}`);
  const t0 = Date.now();
  let closed = false;
  try {
    const outFd = fs.openSync(`${logBase}.out`, 'w');
    const errFd = fs.openSync(`${logBase}.err`, 'w');
    let r;
    try {
      r = await runSeat(bin, argv, {
        cwd: wt, env: H.headlessEnv(env, { codexHome: H.codexHomeOf(cfg) }), stdin, outFd, errFd,
        timeoutMs: (Number(opts.timeoutMin) || 120) * 60000, ctl,
      });
    } finally { fs.closeSync(outFd); fs.closeSync(errFd); }
    const ms = Date.now() - t0;

    // What the seat said and spent.
    const S = require('../persona/record-spend.js');
    const feature = `team:${t.id}:${m.id}`;
    let usd = 0;
    let final = '';
    let session = null;
    let failed = null;
    let spendRow;
    if (provider === 'claude') {
      const res = readJson(`${logBase}.out`);
      if (res) {
        final = res.result || '';
        session = res.session_id || null;
        if (res.is_error || (res.subtype && res.subtype !== 'success')) failed = res.subtype || 'error';
      } else failed = 'no result from claude';
      spendRow = S.rowFrom(res || {}, { feature, model: model || null });
    } else {
      try { final = fs.readFileSync(outFile, 'utf8'); } catch { /* no final message */ }
      let events = '';
      try { events = fs.readFileSync(`${logBase}.out`, 'utf8'); } catch { /* no events */ }
      spendRow = S.rowFromCodex(events, { feature, model: model || '', ms });
      session = codexThreadId(events);
    }
    usd = Number(spendRow.usd) || 0;
    const killed = ctl.caught;
    if (killed) failed = `the dispatcher got ${killed}`;
    else if (r.timedOut) failed = `timed out after ${opts.timeoutMin || 120} min`;
    else if (r.error) failed = r.error.message;
    else if (r.signal) failed = failed || `killed by ${r.signal}`;
    else if (r.status !== 0) failed = failed || `exit ${r.status}`;

    recordSpend({ ...spendRow, ms });
    // The worktree: keep it when the seat left uncommitted work, so nothing is lost.
    const dirty = gitTry(wt, ['status', '--porcelain']).out;
    if (!dirty) gitTry(repo, ['worktree', 'remove', wt]);
    // Only a clean, successful run merges. A failed, killed or dirty run's commits stay on its branch until the lead takes
    // them with `aos team merge` (AT-03), and it builds nothing.
    const merged = !failed && !dirty ? mergeBack(repo, trunk, seat)
      : { commits: Number(gitTry(repo, ['rev-list', '--count', `${trunk}..${seat}`]).out) || 0, held: true };
    const heldNote = merged.held && merged.commits ? `; its ${merged.commits} commit(s) stay on ${seat}, and aos team merge ${t.id} ${item.id} ${m.id} --from ${t.lead} takes them` : '';

    // The item's spend, under the board lock so parallel seats never lose an update. The phase budget caps Claude
    // dollars; a Codex run counts as a run (D8).
    T.withBoard(t, () => {
      const cur = T.boardItems(t).get(item.id);
      const b = cur.budget || {};
      const patch = { id: item.id, budget: provider === 'claude'
        ? { spentUsd: Math.round(((Number(b.spentUsd) || 0) + usd) * 10000) / 10000 }
        : { codexRuns: (Number(b.codexRuns) || 0) + 1 } };
      if (cur.stage === 'execute' && merged.commits > 0 && !merged.held && !merged.conflict) { // only merged work built anything
        const list = ((cur.builders && cur.builders[provider]) || []).slice();
        if (!list.includes(m.id)) { list.push(m.id); patch.builders = { [provider]: list }; }
      }
      T.writeItem(t, patch, { by: 'dispatch', existing: cur });
    });

    // The channel: the seat's own post, else its final line; then anything the lead must act on.
    const posted = T.readJsonl(path.join(t.dir, 'channel.jsonl')).filter((p) => p.from === m.id && p.item === item.id && p.ts >= startIso);
    let postedKind = posted.length ? posted[posted.length - 1].kind : null;
    if (!posted.length) {
      const f = parseFinal(final);
      if (f.text) { T.post(t, { from: m.id, item: item.id, kind: f.kind, text: f.text }); postedKind = f.kind; }
    }
    const mins = (ms / 60000).toFixed(1);
    const rel = (p) => path.relative(vault, p);
    if (killed) T.post(t, { from: 'dispatch', item: item.id, kind: 'blocker', text: `${m.id}'s run on ${item.id} was killed (the dispatcher got ${killed}) after ${mins} min, and the seat was stopped${heldNote}; log ${log}.*` });
    else if (failed) T.post(t, { from: 'dispatch', item: item.id, kind: 'blocker', text: `${m.id}'s run failed (${failed}) after ${mins} min${heldNote}; log ${log}.*` });
    if (dirty) T.post(t, { from: 'dispatch', item: item.id, kind: 'blocker', text: `${m.id} left uncommitted changes in ${rel(wt)}; the lead decides: commit, discard or re-run` });
    if (merged.conflict) T.post(t, { from: 'dispatch', item: item.id, kind: 'blocker', text: `${seat} was not merged into ${trunk}: ${merged.conflict}` });

    // A seat runs as the user's account and could strip AOS_HEADLESS; a decision recorded on its item while it ran is
    // flagged for the user to confirm (AT-REV-01).
    const decided = T.readJsonl(path.join(t.dir, 'board.jsonl')).filter((x) => x.id === item.id && x.by === 'user' && x.ts >= startIso);
    if (decided.length) T.post(t, { from: 'dispatch', item: item.id, kind: 'blocker', text: `a user decision on ${item.id} (${decided.map((x) => (x.gate && x.gate.state !== 'pending' ? `${x.gate.name} ${x.gate.state}` : `budget $${x.budget && x.budget.usd}`)).join(', ')}) was recorded while ${m.id}'s run was going; confirm you made it before anything moves` });
    // A run that finished but left uncommitted work or a conflict is `blocked`: its seat is done, the lead is not (AT-07).
    const status = killed ? 'killed' : failed ? 'failed' : dirty || merged.conflict || decided.length ? 'blocked' : 'ok';
    T.appendJsonl(runsFile, {
      schema: 1, ts: new Date().toISOString(), ...who, run: runId, startedAt: startIso, ms,
      usd: Math.round(usd * 1e6) / 1e6, status, error: failed, session, base, head: merged.head || null,
      commits: merged.commits, merged: !merged.conflict && !merged.held, posted: postedKind, log,
    });
    closed = true;
    await endTelemetry(telemetry, { costUsd: usd, status: status === 'ok' ? 'ok' : 'error', reply: parseFinal(final).text || null });
    const cost = provider === 'claude' ? `$${usd.toFixed(2)}` : `codex run (~$${usd.toFixed(2)})`;
    const summary = `team: ${m.id} on ${item.id} via ${provider}${model ? ` ${model}` : ''}${effort ? `/${effort}` : ''} · ${mins} min · ${cost}`
      + ` · ${merged.commits} commit(s)${merged.conflict ? ' NOT merged' : merged.held ? ` held on ${seat}` : ` merged into ${trunk}`}`
      + ` · ${postedKind ? `posted ${postedKind}` : 'no post'}${killed ? ` · KILLED: ${failed}` : failed ? ` · FAILED: ${failed}` : ''}`;
    return { code: failed || merged.conflict || dirty ? 3 : 0, out: summary };
  } catch (e) {
    // The dispatcher broke mid-run (git, the disk): still close the run, so it is not later mistaken for a killed one.
    if (!closed) {
      const ms = Date.now() - t0;
      try {
        T.appendJsonl(runsFile, { schema: 1, ts: new Date().toISOString(), ...who, run: runId, startedAt: startIso, ms, usd: null, status: 'failed', error: `dispatch error: ${e.message}`, log });
        closed = true;
      } catch { /* the marker stays, and the next sweep reports the run */ }
      try { T.post(t, { from: 'dispatch', item: item.id, kind: 'blocker', text: `${m.id}'s run on ${item.id} broke inside the dispatcher (${e.message}) after ${(ms / 60000).toFixed(1)} min; worktree ${path.relative(vault, wt)}; log ${log}.*` }); } catch { /* best effort */ }
      await endTelemetry(telemetry, { costUsd: null, status: 'error', error: e });
    }
    throw e;
  } finally {
    if (closed) { try { fs.unlinkSync(marker); } catch { /* already gone */ } }
    for (const s of CAUGHT_SIGNALS) process.removeListener(s, onSignal);
  }
}

/** `aos team merge`: the lead takes a seat branch that a failed, killed or dirty run left held into the trunk (AT-03). */
function mergeSeat(opts, { vault, env = process.env }) {
  const t = T.readTeam(T.teamsRoot(vault), opts.team);
  if (opts.from !== t.lead) refuse(`only the lead (${t.lead}) merges a held seat branch`);
  // The lead's own decision, never a seat's (AT-R4): a headless run is refused, and only a held run's branch merges.
  if (env.AOS_HEADLESS === '1') refuse('merging held work is the lead\'s decision, and a headless run cannot make it');
  const item = T.boardItems(t).get(opts.item);
  if (!item) refuse(`no board item ${opts.item} on ${t.id}`);
  if (item.status === 'done') refuse(`${item.id} is done`);
  const last = T.readJsonl(path.join(t.dir, 'runs.jsonl')).filter((r) => r.item === item.id && r.member === opts.member).pop();
  if (!last || last.merged !== false) refuse(`${opts.member}'s last run on ${item.id} holds no unmerged work`);
  const repo = projectRepo(vault, item);
  const names = branchNames(t.id, item.id, opts.member, path.join(vault, 'workspaces', '_worktrees'));
  if (!branchExists(repo, names.seat)) refuse(`there is no branch ${names.seat}`);
  if (fs.existsSync(names.wt)) refuse(`${names.seat} still has its worktree at ${path.relative(vault, names.wt)}: commit or discard what is there, then remove it`);
  if (!branchExists(repo, names.trunk)) git(repo, ['branch', names.trunk, 'HEAD']);
  if (!Number(git(repo, ['rev-list', '--count', `${names.trunk}..${names.seat}`]))) refuse(`${names.seat} holds nothing the trunk lacks`);
  const merged = mergeBack(repo, names.trunk, names.seat);
  if (merged.conflict) refuse(`${names.seat} was not merged: ${merged.conflict}`);
  // Merged execute work counts as built on the run's provider, so reviewers still land on the other one (AT-R3).
  T.withBoard(t, () => {
    const cur = T.boardItems(t).get(item.id);
    const p = last.provider;
    if ((last.stage || cur.stage) !== 'execute' || !merged.commits || !['claude', 'codex'].includes(p)) return; // the run's own stage (AT-REV-02)
    const list = ((cur.builders && cur.builders[p]) || []).slice();
    if (!list.includes(opts.member)) { list.push(opts.member); T.writeItem(t, { id: item.id, builders: { [p]: list } }, { by: 'dispatch', existing: cur }); }
  });
  const text = `merged ${merged.commits} held commit(s) from ${names.seat} into ${names.trunk}`;
  if (merged.commits) T.post(t, { from: t.lead, item: item.id, kind: 'note', text });
  return { code: 0, out: merged.commits ? text : `${names.seat} has nothing the trunk lacks` };
}

// ── --detach ──

/** The environment a detached dispatch keeps: HOME, a PATH that finds node, claude and codex, and the variables that
 *  pick the vault, the config and each host's folders. AOS_HEADLESS is never carried: the dispatcher sets it per seat. */
function detachedEnv(env = process.env) {
  const home = env.HOME || os.homedir();
  const dirs = [...String(env.PATH || '').split(':'), path.join(home, '.local', 'bin'), path.dirname(process.execPath),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const out = { PATH: [...new Set(dirs.filter(Boolean))].join(':'), HOME: home };
  for (const [k, v] of Object.entries(env)) {
    if (k === 'AOS_HEADLESS' || typeof v !== 'string') continue;
    if (/^AOS_/.test(k) || k === 'CLAUDE_CONFIG_DIR' || k === 'CODEX_HOME') out[k] = v;
  }
  return out;
}

/** A property list for strings, booleans, arrays and dicts: all a launchd job needs. */
function plistXml(obj) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const val = (v, pad) => {
    if (typeof v === 'boolean') return `${pad}<${v}/>`;
    if (Array.isArray(v)) return [`${pad}<array>`, ...v.map((x) => val(x, `${pad}\t`)), `${pad}</array>`].join('\n');
    if (v && typeof v === 'object') {
      const rows = Object.entries(v).flatMap(([k, x]) => [`${pad}\t<key>${esc(k)}</key>`, val(x, `${pad}\t`)]);
      return [`${pad}<dict>`, ...rows, `${pad}</dict>`].join('\n');
    }
    return `${pad}<string>${esc(v)}</string>`;
  };
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n${val(obj, '')}\n</plist>\n`;
}

/** The command a detached dispatch runs: this same dispatch without --detach. */
function detachedCommand(args) { return [process.execPath, path.join(__dirname, '..', 'team.js'), 'dispatch', ...args]; }

/** The one-shot LaunchAgent a detached dispatch becomes (macOS). */
function launchdJob({ label, args, log, vault, env }) {
  return {
    Label: label, ProgramArguments: detachedCommand(args), WorkingDirectory: vault, EnvironmentVariables: detachedEnv(env),
    StandardOutPath: log, StandardErrorPath: log, RunAtLoad: true, KeepAlive: false,
  };
}

function which(name, env) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', env });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Hand the checked run to launchd, systemd-run --user, or a detached respawn. Never `launchctl submit`: it keeps a
 *  job alive and reruns it. A finished one-shot stays loaded, so the next detach of that seat boots it out first. */
function detach(t, plan, args, ctx) {
  const { vault, env = process.env, worktrees } = ctx;
  if (fs.existsSync(plan.worktree)) refuse(`a ${plan.member} run on ${plan.item} is still going, or left its worktree at ${path.relative(vault, plan.worktree)}`);
  const logDir = path.join(worktrees, '.logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logBase = path.join(logDir, `dispatch-${plan.item}-${plan.member}-${stamp()}`);
  const log = `${logBase}.log`;
  const label = `com.agenticos.team.${t.id}.${plan.item}.${plan.member}`;
  const since = new Date().toISOString();
  const platform = ctx.platform || process.platform;
  let how;
  let stop;
  if (platform === 'darwin') {
    const lc = (a) => spawnSync(env.AOS_LAUNCHCTL_BIN || 'launchctl', a, { encoding: 'utf8', env });
    const domain = `gui/${process.getuid()}`;
    const seen = lc(['print', `${domain}/${label}`]);
    if (seen.error) refuse(`--detach needs launchctl: ${seen.error.message}`);
    if (seen.status === 0) {
      if (/^\s*state = running\s*$/m.test(seen.stdout)) refuse(`${label} is still running; let it finish, or stop it with launchctl bootout ${domain}/${label}`);
      lc(['bootout', `${domain}/${label}`]);
    }
    fs.writeFileSync(`${logBase}.plist`, plistXml(launchdJob({ label, args, log, vault, env })));
    const b = lc(['bootstrap', domain, `${logBase}.plist`]);
    if (b.status !== 0) throw new Error(`launchctl bootstrap failed: ${(b.stderr || b.stdout || '').trim()}`);
    how = `the launchd job ${label}`;
    stop = `launchctl bootout ${domain}/${label}`;
  } else {
    const sd = env.AOS_SYSTEMD_RUN_BIN || which('systemd-run', env);
    const unit = label.replace(/\./g, '-');
    const e = detachedEnv(env);
    const r = sd ? spawnSync(sd, ['--user', `--unit=${unit}`, '--collect', '--quiet', `--working-directory=${vault}`,
      `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`,
      ...Object.entries(e).map(([k, v]) => `--setenv=${k}=${v}`), '--', ...detachedCommand(args)], { encoding: 'utf8', env }) : null;
    if (r && r.status === 0) {
      how = `the systemd user unit ${unit}`;
      stop = `systemctl --user stop ${unit}`;
    } else {
      const fd = fs.openSync(log, 'a');
      const cmd = detachedCommand(args);
      const child = spawn(cmd[0], cmd.slice(1), { cwd: vault, env: e, detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
      fs.closeSync(fd);
      ctx.stderr && ctx.stderr(`team: warning: no launchd or systemd user session, so the run is only detached from this terminal (pid ${child.pid})\n`);
      how = `a detached process (pid ${child.pid})`;
      stop = `kill ${child.pid}`;
    }
  }
  return { code: 0, out: [
    `team: detached ${plan.member} on ${plan.item} as ${how}`,
    `  log:   ${path.relative(vault, log)}`,
    `  wait:  aos team wait ${t.id} ${plan.item} ${plan.member} --since ${since}`,
    '         (run it in the background: it exits when the run\'s row lands in runs.jsonl)',
    `  stop:  ${stop}`,
  ].join('\n') };
}

module.exports = { dispatch, mergeSeat, branchNames, modelFor, preflight, resolveProvider, gateAllows, projectRepo, prepareWorktree, mergeBack, agentBody, parseFinal, promptFor, codexThreadId, runSeat, detach, detachedEnv, launchdJob, plistXml, GRACE_MS };
