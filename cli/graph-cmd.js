'use strict';
/**
 * graph-cmd.js — `aos graph` and the graphify install step (spec 2026-09-23-graphify D1–D3, D8).
 *   (none) | status   the pinned and installed graphify, the last build, the semantic pass, counts, hubs, communities
 *   build             a structural rebuild now (<vault>/brain/scripts/graph-build.js, inline)
 *   build --semantic  the model pass now (D5/D6): says what it costs today, asks y/N (--yes skips), refuses when an
 *                     explicit `ollama`/`none` provider opts out and `graph.semantic.enabled` is still "auto"
 *   on | off          graph.enabled in agenticos.json (off stops the scan-vault stage; the binary stays)
 *   semantic on|off|auto  graph.semantic.enabled: the daily background model pass (D11)
 * install() is `aos init` step 5c and an `aos upgrade` step: `uv tool install graphifyy==<PIN>` into a tool dir
 * AgenticOS owns (never the user's own uv tools or PATH), then graph.bin in agenticos.json, the vault's
 * .graphifyignore when absent, and a one-time move of a graphify-out/ that no aos build wrote (it came from another
 * root, and graphify would keep its stale nodes). doctorRows() gives `aos doctor` its graphify rows.
 * The pin is a constant, not a config key: `aos upgrade` copies every default into brain/config.json, where a user
 * value wins, so a pin kept in config would freeze at the first upgrade.
 * Test seams (env): AOS_UV_BIN ('' → uv absent), XDG_DATA_HOME (where the tool dir lives).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PIN = '0.9.66';
const PACKAGE = 'graphifyy';
const PYTHON = '>=3.10';
const MARKER = '.aos-graph.json';
const USAGE = 'usage: aos graph [status | build [--semantic [--yes]] | on | off | semantic on|off|auto]';

function claudeConfigDir() { return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')); }
function agenticosPath(configDir) { return process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json'); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, obj) {
  // tmp + rename (spec 2026-09-24-aos-config D5): a reader never sees a half-written file.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
function isExecutable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }
function lastLine(s) { return String(s || '').trim().split('\n').filter(Boolean).pop() || ''; }
function which(name) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return r.status === 0 && p ? p : null;
}
function ago(ms) {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** uv (spec D1, same seam shape as the other prerequisites): AOS_UV_BIN ('' → absent; a path → it, when it exists)
 *  → `uv` on PATH → ~/.local/bin/uv (the uv installer's default) → ~/.cargo/bin/uv (older installers) → null. */
function uvBin() {
  const v = process.env.AOS_UV_BIN;
  if (v !== undefined) return v && fs.existsSync(v) ? v : null;
  const c = [which('uv'), path.join(os.homedir(), '.local', 'bin', 'uv'), path.join(os.homedir(), '.cargo', 'bin', 'uv')];
  return c.find((p) => p && fs.existsSync(p)) || null;
}

/** ${XDG_DATA_HOME:-~/.local/share}/agenticos/graphify — ours alone; uninstall removes it. */
function toolHome() { return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'agenticos', 'graphify'); }
function toolDirs(home = toolHome()) { return { home, tools: path.join(home, 'tools'), bin: path.join(home, 'bin'), graphify: path.join(home, 'bin', 'graphify') }; }

/** "graphify 0.9.66" → "0.9.66"; null when the binary is absent or does not answer. */
function installedVersion(bin, exec = spawnSync) {
  if (!bin || !isExecutable(bin)) return null;
  const r = exec(bin, ['--version'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const m = /graphify\s+v?(\d+\.\d+\.\d+\S*)/.exec(`${r.stdout || ''}${r.stderr || ''}`);
  return r.error || !m ? null : m[1];
}

/** The graph config by loadConfig() precedence: the shipped defaults ← <vault>/brain/config.json ← agenticos.json. */
function graphConfig({ vault, userCfg } = {}) {
  const defaults = readJson(path.join(__dirname, '..', 'config.default.json')) || readJson(path.join(__dirname, '..', 'brain', 'scripts', 'config.default.json')) || {};
  const vaultCfg = (vault && readJson(path.join(vault, 'brain', 'config.json'))) || {};
  const layers = [defaults.graph, vaultCfg.graph, userCfg && userCfg.graph].map((x) => x || {});
  const g = Object.assign({ enabled: true, out: 'brain/graphify-out', staleDays: 7 }, ...layers);
  g.semantic = Object.assign({ enabled: 'auto', everyHours: 24, perDayUsd: 1 }, ...layers.map((x) => x.semantic || {}));
  g.provider = (userCfg && userCfg.provider) || vaultCfg.provider || defaults.provider || 'auto';
  return g;
}
/** D11, the same rule as graph-build.js semanticState: "auto" is off under an explicit ollama or none provider. */
function semanticState(g) {
  const v = g.semantic.enabled;
  if (v === true) return { on: true, why: null, auto: false };
  if (v === false) return { on: false, why: 'off (aos graph semantic on)', auto: false };
  if (g.provider === 'none' || g.provider === 'ollama' || g.provider === 'local') return { on: false, why: `off under provider ${g.provider} (aos graph semantic on overrides)`, auto: true };
  return { on: true, why: null, auto: true };
}
/** The semantic pass holding the graph lock right now ({ startedAt, … }), or null — the same rule as graph-build.js
 *  lockOwner: a live pid inside its own deadline. */
function semanticRunning(vault, now = Date.now()) {
  let o;
  try { o = JSON.parse(fs.readFileSync(path.join(vault, 'brain', '_index', '.graph.lock.json'), 'utf8')); } catch { return null; }
  if (!o || o.mode !== 'semantic' || !(now < Date.parse(o.until))) return null;
  try { process.kill(o.pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
  return o;
}
function hhmm(iso) { return new Date(Date.parse(iso)).toTimeString().slice(0, 5); }

/** Today's graph:* spend from <vault>/brain/_index/provider-spend.jsonl (local calendar day). */
function graphSpendToday(vault, now = new Date()) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(vault, 'brain', '_index', 'provider-spend.jsonl'), 'utf8'); } catch { return 0; }
  const day = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  let sum = 0;
  for (const line of raw.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r && /^graph:/.test(String(r.feature || '')) && day(new Date(r.ts)) === day(now)) sum += Number(r.usd) || 0;
  }
  return Math.round(sum * 1e6) / 1e6;
}
function outDir(vault, g) { return path.resolve(vault, g.out || 'brain/graphify-out'); }

/** Copy the seed .graphifyignore into a vault that has none; returns true when it wrote one. */
function seedIgnore(vault, template) {
  const dest = path.join(vault, '.graphifyignore');
  if (fs.existsSync(dest) || !template || !fs.existsSync(template)) return false;
  fs.copyFileSync(template, dest);
  return true;
}

/** Vaults seeded before the graph existed have no git rule for it (upgrade never re-seeds .gitignore): append the
 *  missing ones for this out dir and its moved-aside twin. Never rewrites the file, never creates one. */
function ensureGitignore(vault, g) {
  const p = path.join(vault, '.gitignore');
  let s;
  try { s = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const rel = path.relative(vault, outDir(vault, g)).split(path.sep).join('/');
  const have = new Set(s.split('\n').map((l) => l.trim()));
  const add = [`${rel}/`, `${rel}.pre-aos/`].filter((r) => !have.has(r));
  if (add.length) fs.appendFileSync(p, `${s === '' || s.endsWith('\n') ? '' : '\n'}# the vault knowledge graph (aos graph) is a derived cache, rebuilt from the notes\n${add.join('\n')}\n`);
  return add;
}

/** A graph.json under the out dir with no aos marker was built by hand, from some other root: rename the dir once. */
function moveAside(vault, g) {
  const dir = outDir(vault, g);
  if (!fs.existsSync(path.join(dir, 'graph.json')) || fs.existsSync(path.join(dir, MARKER))) return null;
  let target = `${dir}.pre-aos`;
  if (fs.existsSync(target)) target = `${target}-${Date.now()}`;
  fs.renameSync(dir, target);
  return target;
}

/**
 * Install graphify PIN (or re-install on a version drift), record graph.bin, seed .graphifyignore, move a hand-built
 * graphify-out/ aside. uv is needed only when an install has to run. Throws when it is missing then, or when the
 * install does not end at PIN; nothing is recorded in either case.
 */
function install({ vault, configDir = claudeConfigDir(), uv = uvBin(), template, io = console, exec = spawnSync, home = toolHome() } = {}) {
  const d = toolDirs(home);
  const before = installedVersion(d.graphify, exec);
  let action = `kept ${PIN}`;
  if (before !== PIN) {
    if (!uv) throw new Error(`uv not found — install it (docs.astral.sh/uv), then run aos upgrade (graphify ${before ? `${before} is not the pinned ${PIN}` : `${PIN} is not installed`})`);
    const args = ['tool', 'install', '--python', PYTHON, ...(fs.existsSync(d.tools) ? ['--reinstall'] : []), `${PACKAGE}==${PIN}`];
    const r = exec(uv, args, {
      encoding: 'utf8', timeout: 10 * 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, UV_TOOL_DIR: d.tools, UV_TOOL_BIN_DIR: d.bin },
    });
    if (r.error || r.status !== 0) throw new Error(`uv tool install ${PACKAGE}==${PIN} failed: ${lastLine(r.stderr) || (r.error && r.error.message) || `exit ${r.status}`}`);
    const after = installedVersion(d.graphify, exec);
    if (after !== PIN) throw new Error(`${d.graphify} reports ${after || 'no version'} after the install, expected ${PIN}`);
    action = before ? `updated ${before} → ${PIN}` : `installed ${PIN}`;
  }
  const file = agenticosPath(configDir);
  const cfg = readJson(file);
  if (cfg) { cfg.graph = { ...(cfg.graph || {}), bin: d.graphify }; writeJson(file, cfg); }
  const g = graphConfig({ vault, userCfg: cfg });
  const seeded = vault ? seedIgnore(vault, template) : false;
  const ignored = vault ? ensureGitignore(vault, g) : [];
  const moved = vault ? moveAside(vault, g) : null;
  io.log(`graph: graphify ${action} (${d.graphify})${seeded ? '; seeded .graphifyignore' : ''}${ignored.length ? `; .gitignore += ${ignored.join(' ')}` : ''}${moved ? `; moved a hand-built graph to ${path.relative(vault, moved)}` : ''}`);
  return { bin: d.graphify, version: PIN, action, seeded, ignored, moved };
}

/** uninstall: the tool dir is ours alone. Refuses any path that is not …/agenticos/graphify. */
function removeTools(home = toolHome()) {
  if (!home.endsWith(`${path.sep}agenticos${path.sep}graphify`) || !fs.existsSync(home)) return null;
  fs.rmSync(home, { recursive: true, force: true });
  return home;
}

/** The graph lib that matches the vault's runtime: the vendored copy, else this checkout's. */
/**
 * The CLI that answers the semantic pass — lib/headless.js graphRunner from the vault's copy when installed: a pinned
 * graph.semantic.runner, an explicit provider claude/codex, else Claude when it is a host, else Codex. null when
 * neither CLI resolves (spec 2026-09-23-codex-parity-gaps D3).
 */
function semanticRunner(vault, cfg, g) {
  const vendored = path.join(vault, 'brain', 'scripts', 'lib', 'headless.js');
  const H = require(fs.existsSync(vendored) ? vendored : path.join(__dirname, '..', 'brain', 'scripts', 'lib', 'headless.js'));
  return H.graphRunner({ ...(cfg || {}), provider: g.provider, graph: { ...((cfg && cfg.graph) || {}), semantic: g.semantic } });
}
/** "Claude (haiku, on your login)" / "Codex (gpt-5-mini, on your login)": who reads the notes. */
function runnerLabel(runner, cfg) {
  if (runner && runner.host === 'codex') return `Codex (${(cfg.codex && cfg.codex.model) || 'your Codex default model'}, on your login)`;
  return `Claude (${(cfg.claude && cfg.claude.model) || 'haiku'}, on your login)`;
}

function graphLib(vault) {
  const vendored = path.join(vault, 'brain', 'scripts', 'sdk', 'lib', 'graph.js');
  return require(fs.existsSync(vendored) ? vendored : path.join(__dirname, '..', 'brain', 'scripts', 'sdk', 'lib', 'graph.js'));
}

/** `aos doctor` rows (name, ok, detail, level): the pinned binary, and whether the graph is fresh. */
function doctorRows({ cfg, vault, exec = spawnSync, now = Date.now(), runner } = {}) {
  const rows = [];
  const bin = cfg && cfg.graph && cfg.graph.bin;
  const v = installedVersion(bin, exec);
  if (!v) rows.push({ name: `graphify ${PIN}`, ok: false, detail: bin ? `${bin} does not answer --version — run aos upgrade` : 'not installed — run aos upgrade', level: 'fail' });
  else rows.push({ name: `graphify ${PIN}`, ok: v === PIN, detail: v === PIN ? bin : `installed ${v}, pinned ${PIN} — run aos upgrade`, level: 'warn' });
  if (!vault) return rows;
  const g = graphConfig({ vault, userCfg: cfg });
  if (g.enabled === false) { rows.push({ name: 'graph fresh', ok: false, detail: 'graph off (aos graph on)', level: 'info' }); return rows; }
  const m = readJson(path.join(outDir(vault, g), MARKER));
  const at = m && Date.parse(m.lastStructural || m.builtAt);
  if (!at) { rows.push({ name: 'graph fresh', ok: false, detail: 'no graph yet — run aos graph build', level: 'warn' }); return rows; }
  const age = now - at;
  const fresh = age <= (Number(g.staleDays) || 7) * 86_400_000;
  rows.push({ name: 'graph fresh', ok: fresh, detail: `built ${ago(age)} ago · ${m.nodes} nodes · ${m.edges} edges${fresh ? '' : ` — older than ${g.staleDays} days, run aos graph build`}`, level: 'warn' });
  rows.push(semanticRow({ g, m, vault, now, runner: runner === undefined ? semanticRunner(vault, cfg, g) : runner }));
  return rows;
}

/** The `graph semantic` row: info while off or not yet run, warn on a failed last run, else ok with today's spend. */
function semanticRow({ g, m, vault, now, runner }) {
  const st = semanticState(g);
  const spend = `today $${graphSpendToday(vault, new Date(now)).toFixed(2)} of $${g.semantic.perDayUsd}${runner && runner.host === 'codex' ? ' · via codex' : ''}`;
  if (!st.on) return { name: 'graph semantic', ok: false, detail: st.why, level: 'info' };
  // A pass holding the lock is running whatever this process can resolve; only then does a missing CLI matter.
  const running = semanticRunning(vault, now);
  if (running) return { name: 'graph semantic', ok: true, detail: `running since ${hhmm(running.startedAt)} · ${spend}`, level: 'warn' };
  if (!runner) return { name: 'graph semantic', ok: false, detail: 'needs the claude or codex CLI (the model pass runs through one of them)', level: 'info' };
  if (!m || !m.lastSemanticRun) return { name: 'graph semantic', ok: false, detail: `not run yet — the next scan starts it (every ${g.semantic.everyHours} h, ${spend})`, level: 'info' };
  if (m.lastSemanticError) return { name: 'graph semantic', ok: false, detail: `last run failed: ${m.lastSemanticError} — aos graph build --semantic`, level: 'warn' };
  const last = Date.parse(m.lastSemantic || m.lastSemanticRun);
  const partial = m.semanticIncomplete ? ` (partial${m.semanticPartialWhy ? `: ${m.semanticPartialWhy.slice(0, 120)}` : ''}; the rest follows on the next runs)` : '';
  return { name: 'graph semantic', ok: true, detail: `last run ${ago(now - last)} ago${partial} · ${m.concepts ?? 0} concepts · ${spend}`, level: 'warn' };
}

function loadAgenticos(configDir) {
  const file = agenticosPath(configDir);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no agenticos.json at ${file} (run \`aos init\` first)`);
    throw new Error(`agenticos.json at ${file} does not parse: ${e.message}`);
  }
  if (!cfg || typeof cfg.vault !== 'string') throw new Error(`agenticos.json at ${file} has no vault (run \`aos init\` first)`);
  return { file, cfg };
}

function status({ cfg, io, exec = spawnSync, now = Date.now() }) {
  const vault = cfg.vault;
  const g = graphConfig({ vault, userCfg: cfg });
  const bin = cfg.graph && cfg.graph.bin;
  const v = installedVersion(bin, exec);
  io.log(`graphify   ${v ? `${v}${v === PIN ? '' : ` (pinned ${PIN} — run aos upgrade)`}` : `not installed (pinned ${PIN} — run aos upgrade)`}${bin ? ` · ${bin}` : ''}`);
  const dir = outDir(vault, g);
  const m = readJson(path.join(dir, MARKER));
  const built = m && Date.parse(m.lastStructural || m.builtAt);
  io.log(`graph      ${g.enabled === false ? 'off' : 'on'} · ${built ? `${m.mode || 'structural'} · built ${ago(now - built)} ago` : 'not built yet'} · ${path.relative(vault, dir)}`);
  const st = semanticState(g);
  const semLast = m && Date.parse(m.lastSemantic || '');
  const running = semanticRunning(vault, now);
  io.log(`semantic   ${st.on ? `on (every ${g.semantic.everyHours} h${st.auto ? ', auto' : ''})` : st.why} · ${running ? `running since ${hhmm(running.startedAt)} · ` : ''}${semLast ? `last run ${ago(now - semLast)} ago${m.semanticIncomplete ? ' (partial)' : ''} · ${m.concepts ?? 0} concepts` : 'never run'}${m && m.lastSemanticError ? ` · last error: ${m.lastSemanticError}` : ''} · today $${graphSpendToday(vault, new Date(now)).toFixed(4)} of $${g.semantic.perDayUsd}`);
  const G = graphLib(vault);
  const block = G.pulse(G.loadGraph(path.join(dir, 'graph.json')));
  if (block) io.log(`\n${block}`);
  return 0;
}

function askYesNo(question) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); }));
}

/** The foreground model pass: policy (D11), what it costs, y/N, then graph-build.js --semantic --force inline. */
async function buildSemantic({ cfg, configDir, io, yes, ask = askYesNo, isTTY = !!process.stdin.isTTY, runner }) {
  const g = graphConfig({ vault: cfg.vault, userCfg: cfg });
  const st = semanticState(g);
  if (!st.on && st.auto) {
    io.error(`graph: the semantic pass sends note text to a hosted model (Claude or Codex) on your login, and provider is ${g.provider} — \`aos graph semantic on\` allows it anyway`);
    return 1;
  }
  const r = runner === undefined ? semanticRunner(cfg.vault, cfg, g) : runner;
  if (!r) { io.error('graph: the semantic pass needs the claude or codex CLI (neither was found)'); return 1; }
  const G = graphLib(cfg.vault);
  const graph = G.loadGraph(path.join(outDir(cfg.vault, g), 'graph.json'));
  const notes = graph ? new Set(graph.nodes.filter((n) => n.file_type === 'document' && n.source_file).map((n) => n.source_file)).size : null;
  io.log(`graph: the semantic pass sends ${notes == null ? 'the vault\'s' : notes} notes' text to ${runnerLabel(r, cfg)}; only new or changed notes reach the model.`);
  io.log(`graph: today $${graphSpendToday(cfg.vault).toFixed(4)} of the $${g.semantic.perDayUsd} graph budget; calls stop at the cap and the rest follows on later runs.`);
  if (!yes) {
    if (!isTTY) { io.error('graph: not a terminal — pass --yes to run the semantic pass without the prompt'); return 1; }
    if (!(await ask('Run it now? [y/N] '))) { io.log('graph: not run'); return 0; }
  }
  return build({ cfg, configDir, io, args: ['--semantic', '--force'] });
}

function build({ cfg, configDir, io, args = [] }) {
  const script = path.join(cfg.vault, 'brain', 'scripts', 'graph-build.js');
  if (!fs.existsSync(script)) throw new Error(`${script} missing — run aos upgrade`);
  const r = spawnSync(cfg.node || process.execPath, [script, ...args], {
    cwd: cfg.vault, stdio: 'inherit',
    env: { ...process.env, AOS_VAULT: cfg.vault, AOS_CONFIG: agenticosPath(configDir), AOS_DETACHED: '1' },
  });
  if (r.error) { io.error(`graph: ${r.error.message}`); return 1; }
  return typeof r.status === 'number' ? r.status : 1;
}

function setSemantic({ file, cfg, value, io }) {
  cfg.graph = { ...(cfg.graph || {}), semantic: { ...((cfg.graph || {}).semantic || {}), enabled: value } };
  writeJson(file, cfg);
  io.log(value === true ? 'graph: semantic pass on (daily, on its own graph budget)'
    : value === false ? 'graph: semantic pass off (the structural graph stays current)'
      : 'graph: semantic pass auto (on unless the provider is ollama or none)');
}

function setEnabled({ file, cfg, on, io }) {
  cfg.graph = { ...(cfg.graph || {}), enabled: on };
  writeJson(file, cfg);
  io.log(on ? 'graph: on (the next scan rebuilds it; aos graph build does it now)' : 'graph: off (scans stop rebuilding it; the graph and graphify stay)');
}

/** `aos graph …` — args is the positional `sub` array cli/aos.js parsed. */
async function run(args, opts = {}) {
  const io = opts.io || console;
  const sub = args[0] || 'status';
  try {
    const configDir = opts.configDir || claudeConfigDir();
    const semanticArg = sub === 'semantic' ? { on: true, off: false, auto: 'auto' }[args[1]] : undefined;
    const ok = (['status', 'build', 'on', 'off'].includes(sub) && args.length <= 1) || (sub === 'semantic' && semanticArg !== undefined && args.length === 2);
    if (!ok || (opts.semantic && sub !== 'build')) { io.error(USAGE); return 2; }
    const { file, cfg } = loadAgenticos(configDir);
    if (sub === 'status') return status({ cfg, io });
    if (sub === 'semantic') { setSemantic({ file, cfg, value: semanticArg, io }); return 0; }
    if (sub === 'build') return opts.semantic ? buildSemantic({ cfg, configDir, io, yes: !!opts.yes, ask: opts.ask, isTTY: opts.isTTY, runner: opts.runner }) : build({ cfg, configDir, io });
    setEnabled({ file, cfg, on: sub === 'on', io });
    return 0;
  } catch (e) {
    io.error(`graph: ${e.message}`);
    return 1;
  }
}

module.exports = {
  PIN, PACKAGE, PYTHON, MARKER, USAGE, uvBin, toolHome, toolDirs, installedVersion, graphConfig, outDir, seedIgnore, ensureGitignore, moveAside,
  install, removeTools, doctorRows, semanticState, semanticRunning, graphSpendToday, status, build, buildSemantic, setEnabled, setSemantic, run,
};
