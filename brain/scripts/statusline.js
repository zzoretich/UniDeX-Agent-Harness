#!/usr/bin/env node
'use strict';
/**
 * statusline.js — `aos statusline`: the opt-in AgenticOS status line (spec 2026-09-28-statusline-design).
 *
 *   aos statusline install [--host claude|codex] [--force] [--chain-output]   every enabled host by default
 *   aos statusline uninstall [--host claude|codex]                            puts back what was there
 *   aos statusline status [--json]                                            per host: installed, holds the slot, chains
 *   aos statusline render            Claude Code's statusLine command: payload on stdin, up to three lines out
 *   aos statusline subagents         Claude Code's subagentStatusLine command: tasks on stdin, JSON rows out
 *   aos statusline refresh [--json]  rebuild brain/_index/statusline.json
 *   aos statusline preview [--width N]  render against a sample payload
 *
 * render and subagents run on every refresh of the host's UI, so they never fail it: any error prints nothing and
 * exits 0. They read the model file and spawn a detached refresh when it is stale (D3), and fire the chained previous
 * status line with the same stdin (D2). install/uninstall exit 1 on a refusal, 2 on a usage error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const USAGE = `usage: aos statusline install [--host claude|codex] [--force] [--chain-output]
       aos statusline uninstall [--host claude|codex]
       aos statusline status [--json] · refresh [--json] · preview [--width N]
       aos statusline render · subagents        (the commands Claude Code runs)
`;
const VERBS = ['install', 'uninstall', 'status', 'render', 'subagents', 'refresh', 'preview', 'git'];
/** SL-R05: the flags each verb takes, and how many arguments after it (`git <dir>` is the render path's own refresher). */
const TAKES = {
  install: ['host', 'force', 'chain-output'], uninstall: ['host'], status: ['json'], refresh: ['json'], preview: ['width'],
  render: [], subagents: [], git: [],
};
const ARGS = { git: 1 };
const BOOL = new Set(['force', 'chain-output', 'json']);
const VALUE = new Set(['host', 'width']);
const GIT_TTL_MS = 5000;

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) { flags[k] = true; continue; }
    if (!VALUE.has(k)) throw new UsageError(`unknown flag --${k}`);
    const v = argv[i + 1];
    if (v === undefined) throw new UsageError(`--${k} needs a value`);
    flags[k] = v;
    i++;
  }
  return { flags, positional };
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/** stdin as text; '' on a TTY, and whatever arrived after 3 s if the pipe never closes. One settle path detaches the
 *  listeners and destroys the stream, so an open pipe can never keep the process alive (SL-06). */
function readStdin(timeoutMs = 3000, stream = process.stdin) {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const onData = (c) => { data += c; };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', settle);
      stream.removeListener('error', settle);
      try { stream.destroy(); } catch { /* already closed */ }
      resolve(data);
    };
    const timer = setTimeout(settle, timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.once('end', settle);
    stream.once('error', settle);
  });
}

/** A GSD project's position from .planning/STATE.md frontmatter: "Phase 02 actions-and-release · executing · 9/10". */
function gsdPhase(text) {
  const fm = text && /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return '';
  const get = (k) => { const m = new RegExp(`^${k}:[ \\t]*"?([^"\\n]*?)"?[ \\t]*$`, 'm').exec(fm[1]); return m ? m[1].trim() : ''; };
  const phase = get('current_phase');
  if (!phase) return '';
  const name = get('current_phase_name');
  const done = get('[ \\t]+completed_plans');
  const total = get('[ \\t]+total_plans');
  return [`Phase ${phase}${name ? ` ${name}` : ''}`, get('status'), total ? `${done || 0}/${total}` : ''].filter(Boolean).join(' · ');
}

/** The Code chat's copy of what render printed, per terminal: <vault>/brain/_index/statusline/<AOS_TERMINAL>.json. */
function teeStatus({ env, vault, payload, out, now }) {
  const terminal = env && env.AOS_TERMINAL;
  if (typeof terminal !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(terminal)) return;
  const p = payload || {};
  const sid = typeof p.session_id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(p.session_id) && !p.session_id.includes('..') ? p.session_id : null;
  const dir = path.join(vault, 'brain', '_index', 'statusline');
  fs.mkdirSync(dir, { recursive: true });
  require('./lib/fsx.js').writeAtomic(path.join(dir, `${terminal}.json`), JSON.stringify({
    at: now.toISOString(), session_id: sid, transcript_path: typeof p.transcript_path === 'string' ? p.transcript_path : null, ansi: out,
  }));
}

/** The work segment (D12): this session's in-progress task, else the project's GSD phase. */
function workOf(payload, claudeDir) {
  const p = payload || {};
  const sid = p.session_id;
  if (typeof sid === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(sid) && !sid.includes('..')) {
    const dir = path.join(claudeDir, 'tasks', sid);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)); } catch { /* no tasks */ }
    for (const n of names) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        if (t && t.status === 'in_progress' && (t.activeForm || t.subject)) return { kind: 'task', text: String(t.activeForm || t.subject) };
      } catch { /* mid-write */ }
    }
  }
  const ws = p.workspace || {};
  const root = ws.project_dir || ws.current_dir || p.cwd;
  const phase = root ? gsdPhase(readText(path.join(root, '.planning', 'STATE.md'))) : '';
  return phase ? { kind: 'phase', text: phase } : null;
}

function parseGitStatus(out) {
  let branch = null;
  let oid = null;
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  for (const l of String(out || '').split('\n')) {
    if (l.startsWith('# branch.head ')) branch = l.slice(14).trim();
    else if (l.startsWith('# branch.oid ')) oid = l.slice(13).trim();
    else if (l.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(l); if (m) { ahead = Number(m[1]); behind = Number(m[2]); } }
    else if (l && !l.startsWith('#')) dirty = true;
  }
  if (branch === '(detached)') branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : 'detached';
  return branch ? { branch, dirty, ahead, behind } : null;
}

const gitCacheFile = (dir, tmp) => path.join(tmp, `aos-sl-git-${crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16)}.json`);

/** The cached git facts for a directory: { git, fresh } (fresh within 5 s). Never runs git. */
function readGitCache(dir, { now = Date.now(), tmp = os.tmpdir() } = {}) {
  if (!dir) return { git: null, fresh: true };
  try {
    const c = JSON.parse(fs.readFileSync(gitCacheFile(dir, tmp), 'utf8'));
    if (c.dir === dir) return { git: c.git || null, fresh: now - c.at >= 0 && now - c.at < GIT_TTL_MS };
  } catch { /* cold */ }
  return { git: null, fresh: false };
}

/** Branch, dirty, ahead/behind from one `git status`, written to the cache. */
function refreshGit(dir, { now = Date.now(), spawnSyncFn = spawnSync, tmp = os.tmpdir() } = {}) {
  const r = spawnSyncFn('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], { encoding: 'utf8', timeout: 2000 });
  const git = r && r.status === 0 ? parseGitStatus(r.stdout) : null;
  try { require('./lib/fsx.js').writeAtomic(gitCacheFile(dir, tmp), JSON.stringify({ dir, at: now, git })); } catch { /* best effort */ }
  return git;
}

/** preview and tests: the cache when fresh, else git now. render never calls this (SL-R09). */
function gitOf(dir, { now = Date.now(), spawnSyncFn = spawnSync, tmp = os.tmpdir() } = {}) {
  if (!dir) return null;
  const c = readGitCache(dir, { now, tmp });
  return c.fresh ? c.git : refreshGit(dir, { now, spawnSyncFn, tmp });
}

/** SL-R09: render shows the cached facts and leaves a stale cache to a detached `git <dir>` child, at most one per 5 s. */
function gitForRender(dir, { now = Date.now(), tmp = os.tmpdir(), spawnFn = spawn, env = process.env } = {}) {
  const c = readGitCache(dir, { now, tmp });
  if (c.fresh || !dir || env.AOS_NO_SPAWN === '1') return c.git;
  const pending = `${gitCacheFile(dir, tmp)}.pending`;
  try { if (now - fs.statSync(pending).mtimeMs < GIT_TTL_MS) return c.git; } catch { /* none running */ }
  try {
    fs.writeFileSync(pending, '');
    const child = spawnFn(process.execPath, [__filename, 'git', dir], { detached: true, stdio: 'ignore', env });
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
  } catch { /* the branch shows on a later refresh */ }
  return c.git;
}

/** D2: run the previous status line with the same stdin, detached, so its side effects (bridge files) keep working. */
function fireChain(command, raw, { spawnFn = spawn, env = process.env } = {}) {
  try {
    const child = spawnFn(command, { shell: true, detached: true, stdio: ['pipe', 'ignore', 'ignore'], env });
    if (!child) return;
    if (typeof child.on === 'function') child.on('error', () => {});
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(raw); }
    if (typeof child.unref === 'function') child.unref();
  } catch { /* the chain never breaks our line */ }
}
/** --chain-output: the previous line's first non-empty line, waited on for at most a second. */
function chainFirstLine(command, raw, { spawnSyncFn = spawnSync, env = process.env } = {}) {
  try {
    const r = spawnSyncFn(command, { shell: true, input: raw, encoding: 'utf8', timeout: 1000, env });
    return r && typeof r.stdout === 'string' ? (r.stdout.split('\n').find((l) => l.trim()) || '') : '';
  } catch { return ''; }
}

function samplePayload(now, cwd) {
  const s = Math.floor(now / 1000);
  return {
    session_id: 'preview',
    model: { display_name: 'Claude' },
    effort: { level: 'high' },
    workspace: { current_dir: cwd, project_dir: cwd },
    cost: { total_cost_usd: 1.23, total_lines_added: 42, total_lines_removed: 7 },
    context_window: { remaining_percentage: 62, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 24, resets_at: s + 7200 }, seven_day: { used_percentage: 41, resets_at: s + 300000 } },
    prompt_cache: { warm: true, hit_ratio: 0.91, expires_at: s + 42 * 60 },
  };
}

function hostLine(r) {
  const tag = r.host.padEnd(7);
  if (r.skipped) return `${tag} skipped: ${r.message}`;
  if (r.refused) return `${tag} refused: ${r.message}`;
  return `${tag} ${r.text}`;
}

async function main(argv, {
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
  env = process.env,
  now = () => new Date(),
  stdin = readStdin,
  vault = null,
  cfg = null,
  userConfigFile = null,
  userCfg,
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  cwd = process.cwd(),
} = {}) {
  let flags;
  let positional;
  try { ({ flags, positional } = parseArgs(argv)); } catch (e) { stderr(`${e.message}\n${USAGE}`); return 2; }
  const verb = positional[0];
  if (!VERBS.includes(verb)) { stderr(USAGE); return 2; }
  const extra = positional.slice(1);
  const wrongFlag = Object.keys(flags).find((k) => !TAKES[verb].includes(k));
  if (extra.length !== (ARGS[verb] || 0) || wrongFlag) {
    stderr(`${wrongFlag ? `--${wrongFlag} does not apply to ${verb}` : extra.length ? `unexpected argument "${extra[ARGS[verb] || 0] || extra[0]}"` : `${verb} needs a directory`}\n${USAGE}`);
    return 2;
  }

  // The hot path first: render and subagents load nothing they do not need and swallow every failure.
  const quiet = verb === 'render' || verb === 'subagents' || verb === 'git';
  if (verb === 'git') {
    try { refreshGit(path.resolve(positional[1]), { spawnSyncFn }); fs.rmSync(`${gitCacheFile(path.resolve(positional[1]), os.tmpdir())}.pending`, { force: true }); } catch { /* quiet */ }
    return 0;
  }
  try {
    const V = vault || env.AOS_VAULT || require('./lib/paths.js').VAULT;
    const UCF = userConfigFile || env.AOS_CONFIG || require('./lib/paths.js').configFile();
    const UC = userCfg !== undefined ? userCfg : (() => { try { return JSON.parse(fs.readFileSync(UCF, 'utf8')); } catch { return null; } })();
    const CFG = cfg || require('./lib/config.js').loadConfig();
    const sl = CFG.statusline || {};
    const H = require('./lib/host.js');
    const claudeDir = path.resolve((UC && UC.claudeConfigDir) || H.claudeConfigDir(env));
    const I = require('./lib/statusline-install.js');
    const M = require('./lib/statusline-model.js');
    const R = require('./lib/statusline-render.js');
    const at = now();

    if (verb === 'render') {
      const raw = await stdin();
      let payload = {};
      try { payload = JSON.parse(raw) || {}; } catch { /* keep the line with what we have */ }
      const claude = I.readState(UCF).claude || null;
      const prev = claude && claude.previous && typeof claude.previous.command === 'string' ? claude.previous.command : null;
      let chained = '';
      // SL-R02: skip only our own line (recorded or this vault's); another vault's status line is a real previous line.
      if (prev && prev !== claude.command && prev !== I.commandFor(V, 'render')) {
        if (claude.chainOutput) chained = chainFirstLine(prev, raw, { spawnSyncFn, env });
        else fireChain(prev, raw, { spawnFn, env });
      }
      const model = M.read(V);
      if (M.isStale(model, at) && env.AOS_NO_SPAWN !== '1') {
        const child = spawnFn(process.execPath, [__filename, 'refresh'], { detached: true, stdio: 'ignore', env: { ...env, AOS_VAULT: V } });
        if (child && typeof child.on === 'function') child.on('error', () => {});
        if (child && typeof child.unref === 'function') child.unref();
      }
      const ws = payload.workspace || {};
      const lines = R.render({
        payload, model, work: workOf(payload, claudeDir), git: gitForRender(ws.current_dir || ws.project_dir || payload.cwd, { now: at.getTime(), spawnFn, env }),
        columns: parseInt(env.COLUMNS || '0', 10) || 0, links: sl.links !== false, segments: sl.segments, env, now: at.getTime(),
      });
      const out = (sl.chainPosition === 'bottom' ? [...lines, chained] : [chained, ...lines]).filter(Boolean);
      const printed = out.length ? `${out.join('\n')}\n` : '';
      if (printed) stdout(printed);
      try { teeStatus({ env, vault: V, payload, out: printed, now: at }); } catch { /* the tee never changes render */ }
      return 0;
    }

    if (verb === 'subagents') {
      const claude = I.readState(UCF).claude;
      if (!claude || !claude.subagentCommand || sl.subagents === false) return 0;
      let input = {};
      try { input = JSON.parse(await stdin()) || {}; } catch { return 0; }
      const rows = R.subagentRows(input, { now: at.getTime(), columns: parseInt(env.COLUMNS || '0', 10) || 0 });
      if (rows.length) stdout(`${rows.join('\n')}\n`);
      return 0;
    }

    if (verb === 'refresh') {
      const m = M.refresh(V, { cfg: CFG, now: at });
      if (flags.json) stdout(`${JSON.stringify(m || M.read(V), null, 2)}\n`);
      return 0;
    }

    if (verb === 'preview') {
      const width = flags.width === undefined ? parseInt(env.COLUMNS || '0', 10) || 0 : parseInt(flags.width, 10);
      if (!Number.isInteger(width) || width < 0) throw new UsageError('--width takes a number of columns');
      const payload = samplePayload(at.getTime(), cwd);
      const model = M.read(V) || M.build(V, { cfg: CFG, now: at });
      const lines = R.render({ payload, model, work: workOf(payload, claudeDir), git: gitOf(cwd, { spawnSyncFn }), columns: width, links: false, segments: sl.segments, env, now: at.getTime() });
      stdout(`${lines.join('\n')}\n`);
      return 0;
    }

    const ctx = { vault: V, userConfigFile: UCF, userCfg: UC, cfg: CFG, env, now: at };

    if (verb === 'status') {
      const s = I.status(ctx);
      const m = M.read(V);
      if (flags.json) { stdout(`${JSON.stringify({ ...s, model: m ? { at: m.at, stale: M.isStale(m, at) } : null }, null, 2)}\n`); return 0; }
      const c = s.claude;
      stdout(`claude  ${!c.installed ? 'not installed (opt-in: aos statusline install)' : c.ownsSlot ? `installed in ${c.file}${c.chained ? ` · chains ${c.chained}` : ''}${c.subagents ? ' · subagent rows' : ''}` : `installed, but the slot now runs ${c.current || 'nothing'} — aos statusline install takes it back and chains it`}\n`);
      if (c.projectOverride) stdout(`        but ${c.projectOverride.file} overrides it in this project (runs ${c.projectOverride.command})\n`);
      const x = s.codex;
      stdout(`codex   ${!x.installed ? 'not installed' : x.present ? `footer preset in ${x.file} (built-in items only; what needs you arrives at session start)` : `installed, but the status_line in ${x.file} changed`}\n`);
      stdout(`model   ${m ? `${M.modelPath(V)} · ${Math.max(0, Math.round((at.getTime() - Date.parse(m.at)) / 1000))}s old` : 'not built yet (aos statusline refresh)'}\n`);
      return 0;
    }

    if (verb === 'install' || verb === 'uninstall') {
      const hosts = verb === 'install' || flags.host ? I.targetHosts(UC, flags.host || null) : ['claude', 'codex'];
      let refused = false;
      for (const h of hosts) {
        let r;
        try {
          r = verb === 'install'
            ? I.install(ctx, { host: h, force: !!flags.force, chainOutput: !!flags['chain-output'] })[0]
            : I.uninstall(ctx, { host: h })[0];
        } catch (e) {
          if (!(e instanceof I.Refusal)) throw e;
          refused = true;
          r = { host: h, refused: true, message: e.message };
        }
        if (!r.skipped && !r.refused) {
          if (verb === 'install' && h === 'claude') r.text = `status line installed in ${r.file}${r.retook ? ' (taken back)' : ''}${r.chained ? `; chains the previous line: ${r.chained}` : ''}`;
          else if (verb === 'install') r.text = `footer preset written to ${r.file}${r.replaced ? ' (replaced your status_line; uninstall puts it back)' : ''}. Codex shows built-in items only; what needs you arrives at session start`;
          else if (h === 'claude') r.text = `removed${r.restored ? `; restored ${r.restored}` : ''}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`;
          else r.text = `removed${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`;
        }
        stdout(`${hostLine(r)}\n`);
      }
      if (verb === 'install') { try { M.refresh(V, { cfg: CFG, now: at }); } catch { /* the first render builds it */ } }
      return refused ? 1 : 0;
    }
    return 2;
  } catch (e) {
    if (quiet) { if (env.AOS_DEBUG === '1') stderr(`statusline ${verb}: ${e.stack || e.message}\n`); return 0; }
    if (e instanceof UsageError) { stderr(`${e.message}\n${USAGE}`); return 2; }
    stderr(`aos statusline: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 0; });
}

module.exports = { main, teeStatus, parseArgs, readStdin, gsdPhase, workOf, parseGitStatus, gitOf, readGitCache, refreshGit, gitForRender, fireChain, chainFirstLine, samplePayload, USAGE };
