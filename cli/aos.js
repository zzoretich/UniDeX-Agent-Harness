#!/usr/bin/env node
'use strict';
/**
 * aos.js — AgenticOS Workbench installer and maintenance CLI. Zero dependencies (node: builtins only).
 *
 *   aos init [--vault <dir>] [--host auto|claude|codex|both|none] [--provider local|auto|ollama|claude|codex|none]
 *            [--cost] [--budget <usd>] [--persona-json <file>] [--from-local <repo-dir>] [--dry-run] [--yes]
 *   (Node >= 20 and uv are hard prerequisites of init; Ollama is a warning, and python3 >= 3.9 is needed only with --cost
 *   (install-import B1). --host none installs with no host (B2). The Workbench is the AgenticOS Workbench app, which
 *   installs nothing into the vault, so Obsidian is no longer one: --no-obsidian, --terminal and `aos terminal install`
 *   are still accepted, and do nothing, so scripts written for an older release keep working.)
 *   aos doctor · aos status · aos provider [local|auto|ollama|claude|codex|none] · aos local [status | pull | use <model>] · aos graph [status | build [--semantic] | on | off | semantic on|off|auto]
 *   aos upgrade [--from-local <repo-dir>] · aos uninstall [--host claude|codex] [--keep-vault] [--yes]
 *   aos persona [rename <name> | on | off] [--persona-json <file>] [--yes] · aos cost [enable [--budget <usd>] [--yes] | disable]
 *   aos import [--from claude|codex|all] [--since 90d|all] [--only …] [--accept <json>] [--dry-run] [--json] · aos hosts add <claude|codex>
 *   aos migrate [local-first|import] [--status | --apply [--chief] | --decline | --undo] [--json]   (local-first A9, install-import B12)
 *
 * Exit codes: 0 ok · 1 a check failed · 2 usage.
 * Runs from the repo checkout (`node cli/aos.js …`, `npm run setup`), from a release tree (the AgenticOS Workbench app's
 * Contents/Resources/payload, whose payload.json says it carries the runtime's dependencies, so init and upgrade copy them
 * rather than run npm), and from its vendored copy at <vault>/brain/scripts/cli/aos.js, which the `aos` launcher reaches
 * for every subcommand except init.
 * Platforms: macOS and Linux. Windows is unsupported in v1.
 * Config file: $AOS_CONFIG when set (the launcher exports it), else <configDir>/agenticos.json — the same
 * rule as lib/paths.js configFile(), so every aos subcommand reads the file the hooks read.
 * Hosts (design D1): a session runs under Claude Code, Codex CLI, or both; agenticos.json `hosts` says which. Claude Code is
 * wired through its plugin (installPlugin), Codex through cli/codex-host.js (hooks.json, `codex mcp add`, generated skills).
 * Test seams (env): AOS_CONFIG, AOS_CLAUDE_BIN, AOS_NO_CLAUDE=1, AOS_CODEX_BIN, AOS_NO_CODEX=1, AOS_NPM_BIN, AOS_SKIP_NPM=1, AOS_CONFIRM_DELETE=<vault path>,
 * AOS_SKIP_OLLAMA_PROBE=1, AOS_REPO_HINT=<repo-dir> (where cost-cmd.js looks for extras/cost before the checkout and the marketplace clone),
 * AOS_UV_BIN (cli/graph-cmd.js uvBin; '' → uv absent).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const REPO_SLUG = 'zzoretich/UniDeX-Agent-Harness';
const MARKETPLACE = 'agenticos-workbench';
const PLUGIN_ID = `agenticos@${MARKETPLACE}`;
// The macOS app's name as people see it (UniDeX spec D1; app/src/shared/brand.ts) and where it is downloaded: the
// newest release carries its DMG (Apple silicon).
const APP_NAME = 'UniDeX';
const APP_DOWNLOAD = `https://github.com/${REPO_SLUG}/releases/latest`;
// The folder an Obsidian-era install put the HUD in (<vault>/.obsidian/plugins/agentic-os/): upgrade only looks for it.
const OBSIDIAN_PLUGIN_ID = 'agentic-os';
const DEFAULT_VAULT = path.join(os.homedir(), 'AgenticOS');
const PROVIDERS = ['local', 'auto', 'ollama', 'claude', 'codex', 'none'];
const RUNTIME_SCRIPTS = { 'scan-vault': 'scan-vault.js', 'build-brain-md': 'build-brain-md.js', recall: 'sdk/recall-cli.js', 'skills-sync': 'skills-sync.js' };
const HOST_CHOICES = ['auto', 'claude', 'codex', 'both', 'none'];
const CH = require('./codex-host.js');
const { stableNode, isCellarPath } = require('./node-path.js');

const USAGE = `usage:
  aos init [--vault <dir>] [--host auto|claude|codex|both|none] [--provider local|auto|ollama|claude|codex|none]
           [--cost] [--budget <usd>] [--persona-json <file>] [--from-local <repo-dir>] [--dry-run] [--yes]
  aos doctor | status | provider [local|auto|ollama|claude|codex|none]
  aos local [status [--json] | pull [model…] | use <model>]
  aos upgrade [--from-local <repo-dir>]
  aos uninstall [--host claude|codex] [--keep-vault] [--yes]
  aos persona [rename <name> | on | off] [--persona-json <file>] [--yes]
  aos cost [enable [--budget <usd>] [--yes] | disable]
  aos graph [status | build [--semantic [--yes]] | on | off | semantic on|off|auto]
  aos routines [list [--json] | sync | run <slug> [--dry-run] | enable <slug> | disable <slug> | next [<slug>] | hosts [--refresh] [--json] | import-cloud <file>]
  aos skills [list [--all] [--json] | sync [--dry-run] [--json] | exclude <name> | include <name> | reset <name>]
  aos agents [list [--all] [--json] | sync [--dry-run] [--json] | exclude <name> | include <name> | reset <name>]
  aos config [list [--json] | get <key> [--json] | set <key> <value> [--dry-run] [--json] | unset <key> [--dry-run]]
  aos workspace [list [--json] | which [--cwd <path>] [--json] | new <name> [--git] [--pin] [--empty] [--json] | stubs <name> [--pin]
                | adopt <path> --into <workspace> [--json] | adopt <path> [--name <slug>] | archive|restore <workspace> [--json]
                | rename <workspace> <new-name> [--json] | hide|unhide <path> [--json] | draft <workspace> [--json]
                | set <workspace> --set <json> [--expect <hash>] [--dry-run] [--json]]
  aos memory [list [--json] | keep <path>… [--json]
             | set <path> --set <json> [--expect <hash>] [--dry-run] [--skip-brain-md] [--json]
             | archive|restore <path>… [--json] | supersede <path> --by <path> [--json] | draft approve|reject <slug> [--json]
             | notdup <path> <path> [--json] | fix sources|types|descriptions|index|drafts [--dry-run] [--expect <hash>] [--json]
             | merge-draft <path> <path>… [--estimate] [--json] | merge <path> <path>… --into <json> --expect <hash>,… [--json]
             | unmerge <path> --expect <hash> [--json] | sweep [<path>…] [--estimate] [--json] | sweep dismiss <id> [--json]]
  aos import [--from claude|codex|all] [--since 90d|all] [--only instructions,memories,projects,mcp,sessions] [--accept <json list>] [--dry-run] [--json]
  aos hosts add <claude|codex> [--from-local <repo-dir>]
  aos migrate [local-first|import] [--status | --apply [--chief] | --decline | --undo] [--accept <json list>] [--json]
  aos statusline [install [--host claude|codex] [--force] [--chain-output] | uninstall [--host claude|codex] | status [--json] | preview [--width N] | refresh]
  aos update-status [--statusline | --snooze <N>d|<N>h | --off]
  aos update-check [--quiet]`;

class UsageError extends Error {}
class CheckFailed extends Error {}

const out = {
  log: (m) => process.stdout.write(m + '\n'),
  warn: (m) => process.stderr.write('warning: ' + m + '\n'),
};

// ── files and config ──────────────────────────────────────────────────────────
function configDir() { return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')); }
function configPath() { return path.resolve(process.env.AOS_CONFIG || path.join(configDir(), 'agenticos.json')); }
function readJson(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
/** tmp + rename (spec 2026-09-24-aos-config D5): a hook reading agenticos.json mid-write would otherwise get null, then
 *  the defaults and a Claude-only host. */
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
/** readJson's strict sibling for files the USER owns: a file that exists but does not parse is refused rather
 *  than replaced, because overwriting it discards their settings with no warning (final review F7 — the shape
 *  cli/cost-cmd.js:81-87 already uses for this same brain/config.json). Missing is fine → fallback. */
function readJsonStrict(p, fallback = null) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`refusing to touch unreadable ${p}: ${e.message}`);
  }
  try { return JSON.parse(raw); } catch (e) {
    throw new Error(`refusing to touch unparseable ${p}: ${e.message}`);
  }
}
function exists(p) { return fs.existsSync(p); }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isExecutable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }
function insideDir(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, over) {
  const o = { ...base };
  for (const [k, v] of Object.entries(over || {})) o[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return o;
}
/** Doctor's persona runner row (local-first A4): `claude · claude-opus-5-5 (medium) (<bin>); failover: codex · gpt-6-sol`. */
function chiefRow(c, codexNote = () => '') {
  const name = (m) => m || 'your Codex default';
  const why = (c.skipped || []).map((s) => (s.host ? `${s.host}: ${s.why}` : s.why)).join('; ');
  if (!c.host && c.reason === 'daily-cap') return `none today (daily-cap: ${why}); duties are skipped on both hosts until tomorrow`;
  if (!c.host) return `none (${c.reason}${why ? `: ${why}` : ''}); duties are skipped until a host can start them — sign in to Claude Code or Codex, or set persona.runner`;
  const moved = String(c.reason || '').startsWith('failover') ? ` (${c.reason})` : '';
  const fo = (c.failover || []).map((f) => `${f.host} · ${name(f.model)}`).join(', ');
  return `${c.host} · ${name(c.model)} (${c.effort}) (${c.bin})${codexNote(c.host)}${moved}; failover: ${fo || 'none'}`;
}
function loadConfigOrThrow() {
  const c = readJson(configPath());
  if (!c || typeof c.vault !== 'string') throw new CheckFailed(`no ${configPath()} — run \`aos init\` (npm run setup) first`);
  return c;
}
function scriptPath(vault, rel) { return path.join(vault, 'brain', 'scripts', rel); }

// ── status line (spec 2026-09-28-statusline-design) ───────────────────────────
/** lib/hud-host.js: the vendored copy beside this file (<vault>/brain/scripts/cli/..), else the checkout's. */
function hudHost() {
  for (const p of [path.join(__dirname, '..', 'lib', 'hud-host.js'), path.join(__dirname, '..', 'brain', 'scripts', 'lib', 'hud-host.js')]) if (exists(p)) return require(p);
  return null;
}
/** The vault's vendored status line installer, or null for a runtime that predates it. */
function statuslineLib(vault) {
  const p = vault && scriptPath(vault, 'lib/statusline-install.js');
  return p && exists(p) ? require(p) : null;
}
/** Its context: statusline.* by config precedence (brain/config.json, then agenticos.json). */
function statuslineCtx(vault, cfg) {
  const vaultCfg = readJson(path.join(vault, 'brain', 'config.json'), {}) || {};
  return { vault, userConfigFile: configPath(), userCfg: cfg, cfg: { statusline: { ...(vaultCfg.statusline || {}), ...((cfg && cfg.statusline) || {}) } }, env: process.env };
}
/** Take an installed status line out of the host configs, before the vault that runs it is unwired or removed. */
function removeStatusline(vault, cfg, host = null) {
  const SLI = statuslineLib(vault);
  if (!SLI || !exists(SLI.statePath(configPath()))) return;
  try {
    for (const r of SLI.uninstall(statuslineCtx(vault, cfg), { host })) {
      if (!r.skipped) out.log(`status line (${r.host}): removed${r.restored ? `; restored ${r.restored}` : ''}${r.notes && r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
    }
  } catch (e) { out.warn(`status line: ${e.message}; run aos statusline uninstall yourself`); }
}

// ── processes ─────────────────────────────────────────────────────────────────
function run(cmd, args, { cwd, env, capture = false, allowFail = false, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : (input !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit'),
  });
  if (r.error) {
    if (allowFail) return { status: 127, stdout: '', stderr: String(r.error.message) };
    throw new CheckFailed(`${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) {
    throw new CheckFailed(`${cmd} ${args.join(' ')} exited ${r.status}${capture && r.stderr ? ': ' + r.stderr.trim() : ''}`);
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function which(name) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return r.status === 0 && p ? p : null;
}
/** `cfg.claude.bin` — the path `aos init` recorded (contract §2) — while it is still an executable file, else null. */
function recordedClaudeBin(cfg) {
  const b = cfg && cfg.claude && typeof cfg.claude.bin === 'string' ? cfg.claude.bin : null;
  return b && isExecutable(b) ? b : null;
}
/** The `claude` CLI: AOS_CLAUDE_BIN (test/CI knob) → the recorded path → PATH → ~/.local/bin/claude → null.
 *  Callers that hold agenticos.json pass it; a recorded path that is gone falls through (doctor warns) and
 *  `aos upgrade` re-records whatever the chain finds. */
function claudeBin(cfg) {
  if (process.env.AOS_NO_CLAUDE === '1') return null;
  if (process.env.AOS_CLAUDE_BIN) return process.env.AOS_CLAUDE_BIN;
  const recorded = recordedClaudeBin(cfg);
  if (recorded) return recorded;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return which('claude') || (exists(local) ? local : null);
}
function npmBin() { return process.env.AOS_NPM_BIN || 'npm'; }
function claudeLoggedIn(bin) {
  const j = safeParse(run(bin, ['auth', 'status', '--json'], { capture: true, allowFail: true }).stdout);
  return !!(j && j.loggedIn);
}
/** The `codex` CLI (cli/codex-host.js): AOS_CODEX_BIN → the recorded hosts.codex.bin → PATH → the usual locations → null. */
function codexBin(cfg) { return CH.codexBin(cfg); }
/** Which hosts an agenticos.json enables. A config written before hosts existed is a Claude-only install. */
function hostsOf(cfg) {
  const h = cfg && cfg.hosts;
  if (!h || typeof h !== 'object') return { claude: true, codex: false };
  return { claude: !!(h.claude && h.claude.enabled), codex: !!(h.codex && h.codex.enabled) };
}
/** --host claude|codex|both|none is explicit (none: no host yet, install-import B2); auto keeps an existing selection, else
 *  takes whatever CLI is installed and logged in (both when both are), else falls back to the Claude-only path so its own
 *  preflight message explains what is missing (and names --host none). */
function resolveHosts(flags, cfg, { claudeAvail, codexAvail }) {
  const want = flags.host || 'auto';
  if (!HOST_CHOICES.includes(want)) throw new UsageError(`--host must be one of ${HOST_CHOICES.join('|')}`);
  if (want === 'none') return { claude: false, codex: false };
  if (want === 'claude') return { claude: true, codex: false };
  if (want === 'codex') return { claude: false, codex: true };
  if (want === 'both') return { claude: true, codex: true };
  if (cfg && cfg.hosts && typeof cfg.hosts === 'object') return hostsOf(cfg);
  if (claudeAvail || codexAvail) return { claude: !!claudeAvail, codex: !!codexAvail };
  return { claude: true, codex: false };
}
/**
 * Inspection F7: an explicit --host names the whole set, and init only wires hosts, never unwires them. A set that drops
 * a host this install has on would leave its plugin, hooks and MCP server in place while agenticos.json says it is off,
 * so it is refused before anything is written, naming how to keep it and how to remove it properly.
 */
function assertKeepsHosts(flags, cfg, hosts) {
  if (!cfg || !flags.host || flags.host === 'auto') return;
  const was = hostsOf(cfg);
  const dropped = ['claude', 'codex'].filter((h) => was[h] && !hosts[h]);
  if (!dropped.length) return;
  const keep = { claude: hosts.claude || was.claude, codex: hosts.codex || was.codex };
  const keepFlag = keep.claude && keep.codex ? 'both' : keep.claude ? 'claude' : 'codex';
  throw new CheckFailed(`--host ${flags.host} would turn off ${dropped.join(' and ')}, which this install has wired, and init never unwires a host: `
    + `keep it with --host ${keepFlag}, or remove it first with ${dropped.map((h) => `aos uninstall --host ${h}`).join(' and ')}`);
}
/** The commands/ and skills/ the Codex skills are generated from: the vendored copy, else the checkout's plugin/. */
function pluginSourceDir(vault, repo) {
  const vendored = scriptPath(vault, 'plugin');
  if (isDir(path.join(vendored, 'commands'))) return vendored;
  return repo ? path.join(repo, 'plugin') : vendored;
}
function installedPlugin(bin) {
  const arr = safeParse(run(bin, ['plugin', 'list', '--json'], { capture: true, allowFail: true }).stdout);
  if (!Array.isArray(arr)) return null;
  return arr.find((p) => typeof p.id === 'string' && p.id.startsWith('agenticos@')) || null;
}
function nodeMajor() { return Number(process.versions.node.split('.')[0]); }
/** Env seam shared by the prerequisite probes (mandatory-prereqs D3): defined and empty → the tool is absent (null),
 *  defined and non-empty → that path when it exists (else null), undefined → run the real probe. */
function seam(envName, probe) {
  const v = process.env[envName];
  if (v === undefined) return probe();
  return v && exists(v) ? v : null;
}
/** The python3 to test: AOS_PYTHON_BIN when defined ('' → none), else `python3` on PATH. */
function pythonBin() {
  const v = process.env.AOS_PYTHON_BIN;
  if (v === undefined) return 'python3';
  return v || null;
}
function python3Version() {
  const bin = pythonBin();
  if (!bin) return null;
  const r = run(bin, ['--version'], { capture: true, allowFail: true });
  const m = /(\d+)\.(\d+)/.exec(r.stdout + r.stderr);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}
function python3Ok(v) { return !!v && (v.major > 3 || (v.major === 3 && v.minor >= 9)); }
/** The Ollama install (mandatory-prereqs D1): AOS_OLLAMA_BIN → `ollama` on PATH → the macOS app bundle → null.
 *  Presence, not liveness: whether it answers is the separate `ollama reachable` probe. */
function ollamaBin() {
  return seam('AOS_OLLAMA_BIN', () => {
    const c = [which('ollama')];
    if (process.platform === 'darwin') c.push('/Applications/Ollama.app', path.join(os.homedir(), 'Applications', 'Ollama.app'));
    return c.find((p) => p && exists(p)) || null;
  });
}
function httpProbe(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}
/** Ollama endpoint for informational probes: config.ollama > OLLAMA_HOST/OLLAMA_PORT > local default
 *  (the same precedence sdk/lib/ollama.js endpoint() gives provider-routed calls). */
function ollamaEndpoint(cfg) {
  const o = (cfg && cfg.ollama) || {};
  return { host: o.host || process.env.OLLAMA_HOST || '127.0.0.1', port: Number(o.port || process.env.OLLAMA_PORT || 11434) };
}
/** True when the informational Ollama probe must not run (tests and offline rehearsals set AOS_SKIP_OLLAMA_PROBE=1). */
function ollamaProbeSkipped() { return process.env.AOS_SKIP_OLLAMA_PROBE === '1'; }
function ask(question, def) {
  if (!process.stdin.isTTY) return Promise.resolve(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim() || def); }));
}
/** Runs a vendored runtime script inline (AOS_DETACHED=1 keeps hook scripts from forking). */
function runScript(vault, name, args = [], opts = {}) {
  if (!RUNTIME_SCRIPTS[name]) throw new UsageError(`unknown runtime script ${name}`);
  return run(process.execPath, [scriptPath(vault, RUNTIME_SCRIPTS[name]), ...args], {
    cwd: vault, ...opts,
    env: { AOS_VAULT: vault, AOS_CONFIG: configPath(), AOS_DETACHED: '1', ...(opts.env || {}) },
  });
}

// ── MCP probe: initialize (+ one tools/call) over stdio against the vault's server ──
function mcpProbe({ vault, tool = null, args = {}, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [scriptPath(vault, 'bin/aos'), 'mcp-server'], {
      env: { ...process.env, AOS_CONFIG: configPath(), CLAUDE_CONFIG_DIR: configDir() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    let serverName = null;
    let timer = null;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      if (err) reject(err); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(`MCP probe timed out after ${timeoutMs} ms${stderr ? ': ' + stderr.trim().slice(-300) : ''}`)), timeoutMs);
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    child.on('error', (e) => finish(e));
    // A server that answers `initialize` and exits immediately leaves stdin's pipe already broken by the
    // time notifications/initialized (or tools/call) is written; without this the EPIPE crashes the process.
    child.stdin.on('error', () => {});
    child.on('exit', (code) => { finish(new Error(`mcp-server exited ${code} before answering${stderr ? ': ' + stderr.trim().slice(-300) : ''}`)); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = safeParse(line);
        if (!msg) continue;
        if (msg.id === 1) {
          if (msg.error) return finish(new Error(`initialize: ${msg.error.message}`));
          if (!msg.result) continue;
          serverName = (msg.result.serverInfo && msg.result.serverInfo.name) || '';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          if (!tool) return finish(null, { serverName, result: null });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error(`tools/call ${tool}: ${msg.error.message}`));
          finish(null, { serverName, result: msg.result });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aos', version: '0' } } });
  });
}

// ── doctor ────────────────────────────────────────────────────────────────────
async function doctor() {
  const checks = [];
  const add = (name, ok, detail, level = 'fail') => checks.push({ name, ok, detail, level });
  add('node >= 20', nodeMajor() >= 20, `v${process.versions.node}`);
  // mandatory-prereqs D5, install-import B1: Node and uv (graphify's) are fail rows; Ollama is a warn, since background
  // work waits for it rather than failing, and the UniDeX app's wizard installs it.
  const ollBin = ollamaBin();
  add('ollama installed', !!ollBin, ollBin || `not found — background work waits for it; install Ollama from ollama.com (the ${APP_NAME} app's setup installs it)`, 'warn');
  const graphCmd = require('./graph-cmd.js');
  const uv = graphCmd.uvBin();
  add('uv installed', !!uv, uv || 'not found — install uv (docs.astral.sh/uv)');
  const cfg = readJson(configPath());
  // Only the opt-in cost module runs python3 (install-import B1): not asked otherwise, so a Mac without the Command Line
  // Tools never sees their install dialog from a check.
  if (cfg && cfg.cost && cfg.cost.enabled) {
    const py = python3Version();
    add('python3 >= 3.9', python3Ok(py), py ? `${py.major}.${py.minor} (the cost module)` : 'python3 not found on PATH — the cost module needs it (aos cost disable turns it off)');
  }
  const hosts = hostsOf(cfg);
  // install-import B2: an install with no host is complete; what needs one says so instead of failing.
  if (cfg && !hosts.claude && !hosts.codex) add('hosts', false, 'none yet — Sessions and the Chief of Staff wait for one: aos hosts add claude (or codex)', 'info');
  const bin = hosts.claude ? claudeBin(cfg) : null;
  if (hosts.claude) {
    add('claude CLI', !!bin, bin || 'not found on PATH or in ~/.local/bin');
    if (bin) add('claude login', claudeLoggedIn(bin), 'claude auth status --json');
    const recorded = cfg && cfg.claude && cfg.claude.bin;
    if (recorded && !isExecutable(recorded)) add('claude.bin', false, `${recorded} is not an executable file — run aos upgrade to re-resolve it`, 'warn');
  }
  add('agenticos.json', !!(cfg && cfg.vault && cfg.node), cfg ? configPath() : `${configPath()} missing — run aos init`);
  const vault = cfg && cfg.vault;
  // AOS_VAULT/BRAIN_VAULT outrank agenticos.json for every hook and the MCP server (brain/scripts/lib/paths.js), and
  // detectVault() silently falls through when the directory is missing — say so here rather than let hooks target
  // a different vault than the one the env var names.
  const vaultEnv = process.env.AOS_VAULT || process.env.BRAIN_VAULT;
  if (vaultEnv) add('AOS_VAULT env', isDir(vaultEnv), isDir(vaultEnv) ? vaultEnv : `${vaultEnv} does not exist — hooks fall through to agenticos.json / directory walk`, 'warn');
  if (vault) {
    const need = ['brain/_index', 'brain/memory', 'brain/scripts/package.json', 'brain/scripts/node_modules/@modelcontextprotocol/sdk',
      'brain/scripts/bin/aos', 'brain/scripts/cli/aos.js', 'brain/scripts/cli/persona-cmd.js', 'brain/scripts/cli/schedule.js',
      'brain/scripts/persona/interview.js', 'brain/scripts/persona/templates/identity.template.md', 'brain/scripts/extras/schedule/launchd/routine.plist.tmpl',
      'brain/scripts/routines/run-routine.js', 'brain/scripts/cli/routines.js', 'brain/routines', 'MEMORY.md', 'AGENTICOS.md'];
    const missing = need.filter((r) => !exists(path.join(vault, r)));
    add('vault layout', missing.length === 0, missing.length ? `${vault} missing: ${missing.join(', ')}` : vault);
    add('node in config', exists(cfg.node), cfg.node);
    // D12: a versioned Homebrew path disappears with the next `brew upgrade`, and every hook and schedule with it.
    if (isCellarPath(cfg.node)) add('node path', false, 'a versioned Homebrew Cellar path — re-run `aos upgrade` to record the stable link', 'warn');
  }
  if (hosts.claude) {
    const plugin = bin ? installedPlugin(bin) : null;
    add('plugin installed', !!plugin, plugin ? `${plugin.id} at ${plugin.installPath}` : `run: claude plugin install ${PLUGIN_ID}`);
    const mcpJson = plugin ? readJson(path.join(plugin.installPath, '.mcp.json')) : null;
    add('MCP declared', !!(mcpJson && mcpJson.agenticos), plugin ? path.join(plugin.installPath, '.mcp.json') : 'plugin not installed');
  }
  if (vault && exists(scriptPath(vault, 'bin/aos'))) {
    try {
      const r = await mcpProbe({ vault });
      add('MCP server answers', r.serverName === 'agenticos', `serverInfo.name=${r.serverName || '(none)'}`);
    } catch (e) { add('MCP server answers', false, e.message); }
  }
  if (hosts.codex && ((cfg.hosts || {}).codex || {}).install === 'plugin') {
    // codex-plugin D6: the plugin, whether Codex trusts its hooks yet, its MCP server, and any direct wiring left beside it.
    const cx = CH.codexPluginStatus({ cfg, launcher: vault ? scriptPath(vault, 'bin/aos') : null, run });
    add('codex CLI', !!cx.bin, cx.bin || 'not found on PATH or in the usual install locations');
    if (cx.bin) add('codex login', cx.loggedIn, 'codex login status');
    add('codex plugin', cx.installed, cx.installed ? `${CH.PLUGIN_ID}${cx.version ? ` ${cx.version}` : ''}` : 'not installed — run: aos upgrade');
    add('codex hooks trusted', cx.trusted >= cx.hooksTotal,
      `${cx.trusted} of ${cx.hooksTotal}${cx.trusted < cx.hooksTotal ? ' — open codex, run /hooks, and trust the agenticos plugin entries (until then they do not run)' : ''}`, 'warn');
    if (cx.bin) add('codex MCP declared', cx.mcp === 'ok', cx.mcp === 'ok' ? 'agenticos from the plugin (./bin/aos, AOS_HOST=codex)' : 'codex mcp list shows no agenticos server from the plugin — run: aos upgrade');
    const d = cx.direct;
    const left = [d.hookEvents && `${d.hookEvents} hook events in ${CH.hooksFile(cfg)}`, d.mcp && 'the MCP registration', d.skills && `${d.skills} skills under ${CH.skillsDir()}`].filter(Boolean);
    if (left.length) add('codex direct wiring', false, `still present beside the plugin: ${left.join(', ')} — run: aos upgrade`, 'warn');
    if (cx.memories) add('codex memories', true, 'Codex\'s built-in memories are on (separate from the vault; aos never touches them)', 'info');
  } else if (hosts.codex) {
    const cx = CH.codexHostStatus({ cfg, launcher: vault ? scriptPath(vault, 'bin/aos') : null, run });
    add('codex CLI', !!cx.bin, cx.bin || 'not found on PATH or in the usual install locations');
    if (cx.bin) add('codex login', cx.loggedIn, 'codex login status');
    add('codex hooks', cx.hookEvents === cx.hookEventsTotal,
      `${cx.hookEvents} of ${cx.hookEventsTotal} events in ${cx.hooksFile}${cx.hookEvents < cx.hookEventsTotal ? ' — run: aos init --host codex' : ' (trust them once under /hooks in codex)'}`);
    if (cx.bin) add('codex MCP declared', cx.mcp === 'ok', cx.mcp === 'ok' ? 'codex mcp get agenticos names the vault launcher with AOS_HOST=codex'
      : cx.mcp === 'stale' ? 'registered without AOS_HOST=codex (a 0.5.0 registration) — run: aos upgrade' : 'run: aos init --host codex');
    add('codex skills', cx.skills > 0, `${cx.skills} generated under ${cx.skillsDir}${cx.skills ? '' : ' — run: aos init --host codex'}`);
    if (cx.memories) add('codex memories', true, 'Codex\'s built-in memories are on (separate from the vault; aos never touches them)', 'info');
  }
  // Which CLI runs persona duties and prompt routines (codex-parity D4): claude when enabled and installed, else codex.
  // The persona row is the Chief of Staff's (local-first A4): its host, its model there, and the host a duty fails over to.
  if (vault && exists(scriptPath(vault, 'lib/headless.js'))) {
    try {
      const H = require(scriptPath(vault, 'lib/headless.js'));
      const vaultCfg = readJson(path.join(vault, 'brain', 'config.json'), {}) || {};
      const merged = { ...vaultCfg, ...(cfg || {}), persona: { ...(vaultCfg.persona || {}), ...((cfg && cfg.persona) || {}) }, routines: { ...(vaultCfg.routines || {}), ...((cfg && cfg.routines) || {}) } };
      const codexNote = (h) => (h === 'codex' ? ' (spend estimated from usage, no per-run cap)' : '');
      if (typeof H.resolveChief === 'function') {
        const c = await H.resolveChief(merged, { vault });
        add('persona runner', !!c.host, chiefRow(c, codexNote), 'warn');
      }
      for (const kind of typeof H.resolveChief === 'function' ? ['routines'] : ['persona', 'routines']) {
        const r = H.resolveRunner({ cfg: merged, kind });
        add(`${kind} runner`, !!r.host, r.host ? `${r.host} (${r.bin})${codexNote(r.host)}` : `none (${r.reason}); install claude or codex, or set ${kind}.runner`, 'warn');
      }
    } catch (e) { add('runner', false, e.message, 'warn'); }
  }
  // cross-review spec D6: whether the other provider can review. Both CLIs installed and logged in → cross-provider; one →
  // same-provider only (the skill offers a labelled same-provider review); none → nothing to run. Never a fail row: the
  // rest of AgenticOS works without it. The CLIs count whether or not they are enabled hosts; the login probes are free.
  if (vault) {
    const vaultCfg = readJson(path.join(vault, 'brain', 'config.json'), {}) || {};
    const xr = { ...(vaultCfg.crossReview || {}), ...((cfg && cfg.crossReview) || {}) };
    if (xr.enabled === false) add('cross-review', true, 'off (crossReview.enabled=false)', 'info');
    else {
      const cb = claudeBin(cfg);
      const xb = codexBin(cfg);
      const ready = { claude: !!cb && claudeLoggedIn(cb), codex: !!xb && CH.codexLoggedIn(xb, run) };
      const why = (h, b) => `${h} CLI ${b ? 'not logged in' : 'not found'}`;
      if (ready.claude && ready.codex) add('cross-review', true, 'cross-provider (claude and codex review each other)', 'warn');
      else if (ready.claude || ready.codex) add('cross-review', false, `same-provider only: ${ready.claude ? why('codex', xb) : why('claude', cb)} — the skill offers a labelled same-provider review`, 'warn');
      else add('cross-review', false, 'no CLI ready: claude and codex are both missing or logged out', 'warn');
    }
  }
  if (vault) {
    // D11: the app records itself in the vault each time it starts; a warn, since the runtime works without it.
    const H = hudHost();
    const m = H && H.readMarker(vault);
    add('workbench app', !!m, m ? `${m.name || APP_NAME} ${m.version}` : `not registered yet — open the ${APP_NAME} app once`, 'warn');
  }
  // graphify spec §4.6: the pinned binary (fail when missing, warn on drift) and the graph's age (warn).
  if (cfg && vault) for (const row of graphCmd.doctorRows({ cfg, vault })) add(row.name, row.ok, row.detail, row.level);
  if (vault && isDir(path.join(vault, 'brain', 'routines'))) {
    // One row for the routines: anything failed, missed, invalid or out of sync with the installed schedules is a warn.
    try {
      const rows = require('./routines.js').rows({ vault });
      const bad = rows.filter((r) => ['failed', 'missed', 'stale', 'invalid'].includes(r.health));
      add('routines', bad.length === 0, rows.length === 0 ? 'none defined' : bad.length ? bad.map((r) => `${r.slug} ${r.health}`).join(', ') + ' — run aos routines list' : `${rows.filter((r) => r.enabled).length} enabled of ${rows.length}`, 'warn');
    } catch (e) { add('routines', false, e.message, 'warn'); }
  }
  if (vault) {
    try { const row = require('./skills.js').doctorRow({ vault }); add(row.name, row.ok, row.detail, row.level); }
    catch (e) { add('skills', false, e.message, 'warn'); }
    try { const row = require('./agents.js').doctorRow({ vault }); add(row.name, row.ok, row.detail, row.level); }
    catch (e) { add('agents', false, e.message, 'warn'); }
    try { const row = require('./config-cmd.js').doctorRow({ configDir: configDir(), vault }); add(row.name, row.ok, row.detail, row.level); }
    catch (e) { add('config', false, e.message, 'warn'); }
  }
  if (vault) {
    const u = require('./update-check.js');
    const st = u.readState(vault);
    const cfgU = u.updatesConfig({ configDir: configDir(), vault });
    if (!cfgU.check) add('update check', true, 'disabled (updates.check = false)', 'info');
    else if (!st) add('update check', true, 'never run — the next session start schedules one', 'info');
    else add('update check', !st.lastError,
      `checked ${st.checkedAt} · latest ${st.latest || '(none published)'}${st.lastError ? ` · ${st.lastError}` : ''}`,
      'warn');
  }
  const SLI = statuslineLib(vault);
  if (SLI) {
    try {
      const st = SLI.status(statuslineCtx(vault, cfg));
      const c = st.claude;
      if (!c.installed && !st.codex.installed) add('status line', true, 'not installed (opt-in: aos statusline install)', 'info');
      if (c.installed) add('status line', c.ownsSlot, c.ownsSlot ? `installed${c.chained ? ` · chains ${c.chained}` : ''}` : `taken by ${c.current || 'nothing'} — aos statusline install takes it back and chains it`, 'warn');
      if (st.codex.installed) add('codex footer', st.codex.present, st.codex.present ? 'built-in items (Codex runs no status line command; what needs you arrives at session start)' : `the status_line in ${st.codex.file} changed since install`, 'warn');
    } catch (e) { add('status line', false, e.message, 'warn'); }
  }
  if (cfg && cfg.provider === 'local' && vault) {
    // local-first A13: under provider local, ready means the engine answers AND serves the model (cli/local.js).
    try {
      const r = await require('./local.js').report({ env: process.env });
      if (!r.probed) add('local engine', false, `${r.engine} at ${r.url} not probed (AOS_SKIP_OLLAMA_PROBE=1)`, 'info');
      else {
        add('local engine', r.reachable, r.reachable ? `${r.engine} at ${r.url}` : `${r.engine} at ${r.url} not answering — open Ollama (or run \`ollama serve\`); background work waits or uses heuristics meanwhile`, 'warn');
        if (r.reachable) {
          add('local model', !!r.workhorse.running, r.workhorse.running
            ? `${r.workhorse.running} (${r.workhorse.source === 'tier' ? `the ${r.memoryGb} GB tier` : r.workhorse.source})${r.embedder.pulled ? ` · embedder ${r.embedder.tag}` : ` · embedder ${r.embedder.tag} not pulled (recall uses keyword search)`}`
            : `${r.workhorse.tag} not pulled — aos local pull`, 'warn');
        }
        // local-first A3: the sessions that ended while the engine was down wait in auto-wrap's spool.
        const queued = wrapsQueued(vault);
        if (queued && (!r.reachable || !r.workhorse.running)) add('wraps queued', false, `local model ${r.reachable ? 'not downloaded' : 'down'}: ${queued} wrap${queued === 1 ? '' : 's'} queued — they run when the model is back`, 'warn');
        else if (queued) add('wraps queued', true, `${queued} wrap${queued === 1 ? '' : 's'} queued — the next session start or Workbench load runs them`, 'info');
      }
    } catch (e) { add('local engine', false, e.message, 'warn'); }
  } else {
    const { host, port } = ollamaEndpoint(cfg);
    if (ollamaProbeSkipped()) add('ollama reachable', false, `${host}:${port} not probed (AOS_SKIP_OLLAMA_PROBE=1)`, 'info');
    else {
      const up = await httpProbe(`http://${host}:${port}/api/tags`);
      add('ollama reachable', up, up ? `${host}:${port}` : `${host}:${port} not answering — run \`ollama serve\``, 'warn');
    }
  }
  if (cfg && cfg.cost && cfg.cost.enabled) {
    // execution amendment 2026-09-15 (A39): the opt-in analyzer is not in `need`; check it here, where cost is known to be on.
    const analyzer = vault ? scriptPath(vault, 'cost/analyze_transcript.py') : null;
    add('cost analyzer', !!analyzer && exists(analyzer), analyzer ? (exists(analyzer) ? analyzer : `${analyzer} missing — run aos cost enable`) : 'no vault');
  }
  for (const c of checks) {
    const tag = c.ok ? 'ok  ' : c.level === 'fail' ? 'FAIL' : c.level === 'warn' ? 'warn' : 'info';
    out.log(`${tag}  ${c.name.padEnd(20)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok && c.level === 'fail');
  out.log(failed.length ? `${failed.length} check(s) failed` : 'all checks passed');
  return failed.length ? 1 : 0;
}

// ── status ────────────────────────────────────────────────────────────────────
// Contract §3 spendToday semantics: ledger rows whose `feature` starts with `duty:` belong to the persona
// (Plan 5's record-spend.js; gated by persona.perDayUsd), rows starting with `reason:` belong to the
// reasoner role (gated by reasoner.perDayUsd), rows starting with `routine:` belong to prompt routines
// (gated by routines.perDayUsd), `graph:` to the vault graph's semantic pass (graph.semantic.perDayUsd) and
// `cross-review:` to cross-review and handoff calls (crossReview.perDayUsd), `team:` to agent-team seats (no daily cap:
// each board item's phase budget caps them, spec 2026-09-28-agent-teams D8); every other row is a background hook
// call (gated by claude.perDayUsd — spendToday in spend-ledger.js excludes the same families). One line per cap.
const DUTY_FEATURE = /^duty:/;
const REASON_FEATURE = /^reason:/;
const ROUTINE_FEATURE = /^routine:/;
const GRAPH_FEATURE = /^graph:/;
const CROSS_REVIEW_FEATURE = /^cross-review:/;
const TEAM_FEATURE = /^team:/;
const SESSION_FEATURE = /^session:/;
const isDutyFeature = (feature) => DUTY_FEATURE.test(feature);
const isReasonFeature = (feature) => REASON_FEATURE.test(feature);
const isRoutineFeature = (feature) => ROUTINE_FEATURE.test(feature);
const isGraphFeature = (feature) => GRAPH_FEATURE.test(feature);
const isCrossReviewFeature = (feature) => CROSS_REVIEW_FEATURE.test(feature);
const isTeamFeature = (feature) => TEAM_FEATURE.test(feature);
const isSessionFeature = (feature) => SESSION_FEATURE.test(feature);
const isHookFeature = (feature) => ![DUTY_FEATURE, REASON_FEATURE, ROUTINE_FEATURE, GRAPH_FEATURE, CROSS_REVIEW_FEATURE, TEAM_FEATURE, SESSION_FEATURE].some((re) => re.test(feature));
/** Today's provider-spend.jsonl rows (local calendar day) that carry a numeric usd; [] when the ledger is absent. */
function spendRowsToday(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const day = localDay();
  const rows = [];
  for (const line of raw.split('\n')) {
    const r = safeParse(line);
    if (r && typeof r.usd === 'number' && localDay(new Date(r.ts)) === day) rows.push(r);
  }
  return rows;
}
/** USD sum of `rows` whose feature string satisfies `filter`. */
function sumUsd(rows, filter) { return rows.filter((r) => filter(String(r.feature || ''))).reduce((s, r) => s + r.usd, 0); }
/** Today's spend in USD; `filter(feature)` picks the rows (default: every row). */
function spendToday(file, filter = () => true) { return sumUsd(spendRowsToday(file), filter); }
/** Today's USD per ledger family, keyed as settings-schema.js SPEND_FAMILIES (spec 2026-09-24-settings-tab D7), plus `teams`,
 *  which has no daily cap. Both hook caps (claude.perDayUsd, codex.perDayUsd) govern the same hook total. */
function spendByFamily(vault) {
  const rows = spendRowsToday(path.join(vault, 'brain', '_index', 'provider-spend.jsonl'));
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  return {
    hooks: r6(sumUsd(rows, isHookFeature)), duties: r6(sumUsd(rows, isDutyFeature)), reasoner: r6(sumUsd(rows, isReasonFeature)),
    routines: r6(sumUsd(rows, isRoutineFeature)), graph: r6(sumUsd(rows, isGraphFeature)), crossReview: r6(sumUsd(rows, isCrossReviewFeature)),
    sessions: r6(sumUsd(rows, isSessionFeature)), teams: r6(sumUsd(rows, isTeamFeature)),
  };
}
/** Sessions auto-wrap spooled for later (brain/_index/auto-wrap-pending.jsonl, one row each; local-first A3). */
function wrapsQueued(vault) {
  try { return fs.readFileSync(path.join(vault, 'brain', '_index', 'auto-wrap-pending.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length; } catch { return 0; }
}

function status() {
  const cfg = loadConfigOrThrow();
  const idx = path.join(cfg.vault, 'brain', '_index');
  const state = readJson(path.join(idx, 'provider-state.json'));
  // Caps follow loadConfig() precedence (contract §1): agenticos.json wins over brain/config.json, then the
  // config.default.json values (claude.perDayUsd 0.5, persona.perDayUsd 6.0).
  const vaultCfg = readJson(path.join(cfg.vault, 'brain', 'config.json'), {}) || {};
  const num = (obj, key) => (obj && typeof obj[key] === 'number' ? obj[key] : undefined);
  // Hook calls are capped by the provider that makes them (sdk/lib/provider.js hookBudget / codexBudget).
  const hookKey = state && state.name === 'codex' ? 'codex' : 'claude';
  const hookCap = num(cfg[hookKey], 'perDayUsd') ?? num(vaultCfg[hookKey], 'perDayUsd') ?? 0.5;
  const dutyCap = num(cfg.persona, 'perDayUsd') ?? num(vaultCfg.persona, 'perDayUsd') ?? 6;
  const reasonCap = num(cfg.reasoner, 'perDayUsd') ?? num(vaultCfg.reasoner, 'perDayUsd') ?? 5;
  const routineCap = num(cfg.routines, 'perDayUsd') ?? num(vaultCfg.routines, 'perDayUsd') ?? 6;
  const semOf = (c) => (c && c.graph && c.graph.semantic) || null;
  const graphCap = num(semOf(cfg), 'perDayUsd') ?? num(semOf(vaultCfg), 'perDayUsd') ?? 1;
  const crossReviewCap = num(cfg.crossReview, 'perDayUsd') ?? num(vaultCfg.crossReview, 'perDayUsd') ?? 10;
  const sessionCap = num(cfg.sessions, 'perDayUsd') ?? num(vaultCfg.sessions, 'perDayUsd') ?? 10;
  const str = (obj, key) => (obj && typeof obj[key] === 'string' && obj[key].trim() ? obj[key].trim() : undefined);
  // The reasoner role (sdk/lib/models.js): BRAIN_REASONER, then reasoner.model by config precedence, then the default.
  const reasonerModel = (process.env.BRAIN_REASONER || '').trim() || str(cfg.reasoner, 'model') || str(vaultCfg.reasoner, 'model') || 'claude-opus-5';
  const reasonerEffort = str(cfg.reasoner, 'effort') || str(vaultCfg.reasoner, 'effort') || 'medium';
  const spend = spendRowsToday(path.join(idx, 'provider-spend.jsonl')); // the ledger is read once, summed three times
  out.log(`vault      ${cfg.vault}`);
  out.log(`provider   mode=${cfg.provider || 'auto'} resolved=${state ? `${state.name} (${state.reason}, ${state.checkedAt})` : 'never resolved'}`);
  if (cfg.provider === 'local' || (state && state.engine)) {
    // local-first A18: what the local engine did today (brain/_index/local-usage.json; no probe here, `aos local` asks it).
    const today = ((readJson(path.join(idx, 'local-usage.json')) || {}).days || {})[localDay(new Date())] || { calls: 0 };
    const queued = wrapsQueued(cfg.vault);
    out.log(`local      model=${(state && state.model) || 'unresolved'} engine=${(state && state.engine) || 'ollama'} calls today=${today.calls}${state && state.localReason && state.localReason !== 'local-ready' ? ` (${state.localReason})` : ''}${queued ? ` · ${queued} wrap${queued === 1 ? '' : 's'} queued` : ''}`);
  }
  const claudeState = (state && state.claude) || {};
  const hosts = hostsOf(cfg);
  out.log(`hosts      ${[hosts.claude && 'claude', hosts.codex && 'codex'].filter(Boolean).join(', ') || 'none'}`);
  if (hosts.claude) out.log(`claude     bin=${claudeState.bin || claudeBin(cfg) || 'not found'} login=${typeof claudeState.loggedIn === 'boolean' ? claudeState.loggedIn : 'unprobed'}`);
  if (hosts.codex) {
    const codexState = (state && state.codex) || {};
    out.log(`codex      bin=${codexState.bin || codexBin(cfg) || 'not found'} login=${typeof codexState.loggedIn === 'boolean' ? codexState.loggedIn : 'unprobed'} home=${CH.codexHome(cfg)} install=${((cfg.hosts || {}).codex || {}).install || 'direct'}`);
  }
  // The host that answers the reasoner (sdk/lib/provider.js resolveProviderForRole): Claude when it is a host and not known
  // to be logged out, else Codex when it is a host; an explicit provider codex puts Codex first.
  const loggedOut = (h) => !!(state && state[h] && state[h].loggedIn === false);
  const reasonerHost = (cfg.provider === 'codex' ? ['codex', 'claude'] : ['claude', 'codex']).find((h) => hosts[h] && !loggedOut(h)) || 'none';
  const codexReasonerModel = str(cfg.reasoner, 'codexModel') || str(vaultCfg.reasoner, 'codexModel') || str(cfg.codex, 'model') || str(vaultCfg.codex, 'model') || 'codex-default';
  out.log(`reasoner   model=${reasonerHost === 'codex' ? codexReasonerModel : reasonerModel} provider=${reasonerHost} effort=${reasonerEffort}`);
  out.log(`spend      today (hooks) $${sumUsd(spend, isHookFeature).toFixed(4)} / cap $${hookCap} (${hookKey}.perDayUsd)`);
  out.log(`spend      today (duties) $${sumUsd(spend, isDutyFeature).toFixed(4)} / cap $${dutyCap}`);
  out.log(`spend      today (reasoner) $${sumUsd(spend, isReasonFeature).toFixed(4)} / cap $${reasonCap}`);
  out.log(`spend      today (routines) $${sumUsd(spend, isRoutineFeature).toFixed(4)} / cap $${routineCap}`);
  out.log(`spend      today (graph) $${sumUsd(spend, isGraphFeature).toFixed(4)} / cap $${graphCap}`);
  out.log(`spend      today (cross-review) $${sumUsd(spend, isCrossReviewFeature).toFixed(4)} / cap $${crossReviewCap}`);
  out.log(`spend      today (sessions) $${sumUsd(spend, isSessionFeature).toFixed(4)} / cap $${sessionCap}`);
  out.log(`spend      today (teams) $${sumUsd(spend, isTeamFeature).toFixed(4)} (no daily cap: each board item has a phase budget)`);
  // Ledger shape (lib/pipeline-report.js): { version: 1, pipelines: { <name>: { lastRun: {…} | null, history: [] } } }.
  const ledger = readJson(path.join(idx, 'pipelines.json'), {}) || {};
  const rows = Object.entries(ledger.pipelines || {}).map(([name, st]) => [name, (st && st.lastRun) || null]);
  out.log(rows.length ? 'pipelines' : 'pipelines  (none yet — run aos scan-vault)');
  for (const [name, e] of rows) {
    if (!e) { out.log(`  ${name.padEnd(20)} never`); continue; }
    out.log(`  ${name.padEnd(20)} ${String(e.status || '?').padEnd(9)} ${String(e.provider || '-').padEnd(7)} ${e.endedAt || e.startedAt || ''}${e.reason ? '  ' + e.reason : ''}${e.status === 'error' && e.error ? '  ' + e.error : ''}`);
  }
  return 0;
}

// ── provider ──────────────────────────────────────────────────────────────────
function provider(mode) {
  const cfg = loadConfigOrThrow();
  if (!mode) { out.log(cfg.provider || 'auto'); return 0; }
  if (!PROVIDERS.includes(mode)) throw new UsageError(`provider must be one of ${PROVIDERS.join('|')}`);
  cfg.provider = mode;
  writeJson(configPath(), cfg);
  try { fs.unlinkSync(path.join(cfg.vault, 'brain', '_index', 'provider-state.json')); } catch { /* no cache yet */ }
  out.log(`provider set to ${mode} (cached probe cleared; the next hook re-resolves)`);
  return 0;
}

// ── init ──────────────────────────────────────────────────────────────────────
// Never vendored: installed deps, the test suite, and any lockfile (contract §4.3: the vendored runtime is
// installed with a plain `npm install --omit=dev`; its two deps are pinned by `^` ranges in package.json). A release
// tree that carries them (the app's payload) has them copied instead: releaseTreeDeps / swapNodeModules.
const VENDOR_EXCLUDE = /(^|\/)(node_modules|test|package-lock\.json)(\/|$)/;

function isRepoRoot(d) {
  return !!d && exists(path.join(d, '.claude-plugin', 'marketplace.json')) &&
    exists(path.join(d, 'brain', 'scripts', 'package.json')) && isDir(path.join(d, 'vault-template'));
}
/** The checkout to vendor from: --from-local, this file's parent (repo run), the marketplace's own location (a local
 *  directory marketplace, or the GitHub clone), else the default clone path. */
function repoRoot(flags, marketplaceDir = null) {
  const candidates = [flags.fromLocal, path.resolve(__dirname, '..'), marketplaceDir, path.join(configDir(), 'plugins', 'marketplaces', MARKETPLACE)];
  for (const c of candidates) if (isRepoRoot(c)) return path.resolve(c);
  throw new UsageError('cannot locate the AgenticOS-Workbench checkout (needs .claude-plugin/marketplace.json, brain/scripts, vault-template) — pass --from-local <repo-dir>');
}
function productVersion(repo) { return (readJson(path.join(repo, 'package.json')) || {}).version || '0.0.0'; }

/** Recursive copy. Existing destination files are kept unless force. `rename` maps a source rel path to a dest rel path. */
function copyTree(srcRoot, destRoot, { exclude = null, force = false, rename = {}, written = [] } = {}) {
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(srcRoot, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (exclude && exclude.test(childRel)) continue;
      if (e.isDirectory()) { walk(childRel); continue; }
      if (!e.isFile()) continue;
      const destRel = rename[childRel] || childRel;
      const target = path.join(destRoot, destRel);
      if (exists(target) && !force) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(srcRoot, childRel), target);
      written.push(destRel);
    }
  };
  walk('');
  return written;
}

/** Structural guard shared by init and the uninstall delete: a vault is never a directory whose removal would take
 *  the machine, the home directory or the Claude config dir with it. `uninstall` adds the vault-marker check. */
function assertVaultOk(vault) {
  if (insideDir(vault, configDir())) throw new CheckFailed(`refusing ${vault}: it is inside the Claude config dir ${configDir()}`);
  if (exists(path.join(vault, 'settings.json'))) throw new CheckFailed(`refusing ${vault}: it contains settings.json (looks like a Claude config dir)`);
  if (path.resolve(vault) === path.resolve(os.homedir())) throw new CheckFailed('refusing the home directory as a vault; pick a subdirectory such as ~/AgenticOS');
  if (path.parse(path.resolve(vault)).root === path.resolve(vault)) throw new CheckFailed('refusing a filesystem root as a vault');
  if (insideDir(configDir(), vault)) throw new CheckFailed(`refusing ${vault}: it contains the Claude config dir ${configDir()}`);
  const cxHome = CH.codexHome(readJson(configPath()));
  if (insideDir(vault, cxHome)) throw new CheckFailed(`refusing ${vault}: it is inside the Codex home ${cxHome}`);
  if (insideDir(cxHome, vault)) throw new CheckFailed(`refusing ${vault}: it contains the Codex home ${cxHome}`);
}

function buildUserConfig(existing, { vault, provider, version, bin, hosts, codexBin: cxBin, codexHome: cxHome }) {
  const base = {
    // local-first A10: a new install runs background work on the local engine; a file written before 2.0 without the key
    // was on auto, and moves to local only when its owner says so (A9: aos migrate local-first).
    version, vault, node: stableNode(process.execPath), claudeConfigDir: configDir(), provider: existing ? 'auto' : 'local',
    claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 },
    ollama: { host: '127.0.0.1', port: 11434 },
    telemetry: { enabled: true, redact: true, retentionDays: 30 },
    cost: { enabled: false },
    persona: { enabled: true },
    graph: { enabled: true },
    // Design D1: the hosts a session may run under. A config written before this key existed is a Claude-only install.
    hosts: { claude: { enabled: true, configDir: configDir() }, codex: { enabled: false, home: CH.codexHome(existing) } },
  };
  const merged = deepMerge(base, existing || {});
  merged.version = version;
  merged.vault = vault;
  // D12: Homebrew's stable opt link rather than the versioned Cellar path `brew upgrade` deletes.
  merged.node = stableNode(process.execPath);
  merged.claudeConfigDir = configDir();
  if (provider) merged.provider = provider;
  // Contract §2: record the resolved `claude` CLI; absent when none was found, so every reader falls back to its probe.
  if (bin !== undefined) {
    const caps = { ...(merged.claude || {}) };
    delete caps.bin;
    merged.claude = bin ? { ...caps, bin } : caps;
  }
  if (hosts) {
    merged.hosts.claude.enabled = !!hosts.claude;
    merged.hosts.codex.enabled = !!hosts.codex;
  }
  merged.hosts.claude.configDir = configDir();
  if (bin !== undefined) { if (bin) merged.hosts.claude.bin = bin; else delete merged.hosts.claude.bin; }
  if (cxBin !== undefined) { if (cxBin) merged.hosts.codex.bin = cxBin; else delete merged.hosts.codex.bin; }
  if (cxHome) merged.hosts.codex.home = cxHome;
  const ordered = {};
  for (const k of Object.keys(base)) ordered[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in ordered)) ordered[k] = merged[k];
  return ordered;
}

/** After agenticos.json is (re)written: when claude.bin changed, drop the cached provider probe (the same cache
 *  `aos provider` clears) so hooks and the MCP server pick the new path up now, not after the 24 h TTL. */
function noteClaudeBinChange(vault, before, after) {
  if ((before || null) === (after || null)) return;
  let cleared = false;
  try { fs.unlinkSync(path.join(vault, 'brain', '_index', 'provider-state.json')); cleared = true; } catch { /* no cache yet */ }
  out.log(`claude.bin now ${after || 'unset'} (was ${before || 'unset'})${cleared ? '; cached provider probe cleared' : ''}`);
}

/** ~/.local/bin/aos → <vault>/brain/scripts/bin/aos, so `aos doctor` works from any shell. */
function linkLauncher(vault) {
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const link = path.join(binDir, 'aos');
  const target = scriptPath(vault, 'bin/aos');
  try {
    fs.mkdirSync(binDir, { recursive: true });
    let current = null;
    try { current = fs.readlinkSync(link); } catch { /* absent, or a regular file */ }
    if (current === target) return link;
    if (current && current.endsWith('/brain/scripts/bin/aos')) fs.unlinkSync(link);
    else if (exists(link)) { out.warn(`${link} exists and is not an AgenticOS launcher; leaving it alone`); return null; }
    fs.symlinkSync(target, link);
    return link;
  } catch (e) { out.warn(`could not link ${link}: ${e.message}`); return null; }
}

/** A release tree (the app's payload, install-and-update I1) that carries its runtime's dependencies: the path of its
 *  brain/scripts/node_modules when payload.json says so and the folder is there, else null (a checkout: npm installs). */
function releaseTreeDeps(repo) {
  const manifest = readJson(path.join(repo, 'payload.json'));
  const deps = path.join(repo, 'brain', 'scripts', 'node_modules');
  return manifest && manifest.schema === 1 && manifest.runtimeDeps === true && isDir(deps) ? deps : null;
}

/** <dest>/node_modules becomes a copy of `src`: staged under a name of this process's own, then renamed into place. */
function swapNodeModules(src, dest) {
  const live = path.join(dest, 'node_modules');
  const incoming = path.join(dest, `node_modules.incoming-${process.pid}`);
  const old = path.join(dest, `node_modules.old-${process.pid}`);
  fs.rmSync(incoming, { recursive: true, force: true });
  fs.cpSync(src, incoming, { recursive: true, verbatimSymlinks: true });
  // lstat, not exists: an install from a checkout may have left node_modules as a symlink (the CI rehearsal's fake npm).
  let had = false;
  try { fs.lstatSync(live); had = true; } catch { /* first install */ }
  if (had) fs.renameSync(live, old);
  fs.renameSync(incoming, live);
  if (had) fs.rmSync(old, { recursive: true, force: true });
}

function vendorRuntime(ctx, { force = true } = {}) {
  const { repo, vault, written } = ctx;
  const dest = scriptPath(vault, '');
  copyTree(path.join(repo, 'brain', 'scripts'), dest, { exclude: VENDOR_EXCLUDE, force, written: [] });
  // cli/*.js (persona-cmd, schedule, cost-cmd, …) minus tests, fixtures and the CI rehearsal;
  // the persona templates next to interview.js; the schedule and cost sources under extras/.
  copyTree(path.join(repo, 'cli'), path.join(dest, 'cli'), { exclude: /(^|\/)(fixtures|rehearsal)(\/|$)|\.test\.js$/, force, written: [] });
  copyTree(path.join(repo, 'vault-template', 'persona'), path.join(dest, 'persona', 'templates'), { force, written: [] });
  for (const x of ['schedule', 'cost']) {
    if (isDir(path.join(repo, 'extras', x))) copyTree(path.join(repo, 'extras', x), path.join(dest, 'extras', x), { exclude: /(^|\/)test_[^/]*\.py$/, force, written: [] });
  }
  fs.mkdirSync(path.join(dest, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'plugin', 'bin', 'aos'), path.join(dest, 'bin', 'aos'));
  fs.chmodSync(path.join(dest, 'bin', 'aos'), 0o755);
  // Design D4: the commands and skills the Codex host generates its skills from, so `aos upgrade` never needs the marketplace clone.
  for (const x of ['commands', 'skills']) copyTree(path.join(repo, 'plugin', x), path.join(dest, 'plugin', x), { force, written: [] });
  written.push('brain/scripts/ (runtime)', 'brain/scripts/cli/', 'brain/scripts/persona/templates/', 'brain/scripts/extras/', 'brain/scripts/bin/aos', 'brain/scripts/plugin/');
  const prebuilt = releaseTreeDeps(repo);
  if (process.env.AOS_SKIP_NPM === '1') { /* test seam: no dependencies at all */ }
  else if (prebuilt) {
    // install-and-update I2: the app's payload carries its runtime's dependencies (plain JavaScript, so a copy built on
    // one Mac runs on any Node >= 20), and an app-driven install has no npm to count on. Copied beside the old tree,
    // then swapped in with two renames, so a re-run prunes and a hook starting mid-upgrade never meets half a tree.
    swapNodeModules(prebuilt, dest);
  } else {
    // Spec §9.2 step 4 / contract §4.3: a plain `npm install --omit=dev` in the vendored dir. No lockfile is
    // vendored (VENDOR_EXCLUDE drops one even when the checkout has it; the root workspace lockfile describes
    // the workspaces, not this package alone), so `npm ci` is not an option here and is deliberately not used.
    // On a re-run (init again, upgrade) npm prunes and refreshes node_modules in place.
    run(npmBin(), ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dest });
  }
  const link = linkLauncher(vault);
  if (link) written.push(link);
}

function installPlugin(ctx, bin) {
  const source = ctx.flags.fromLocal ? path.resolve(ctx.flags.fromLocal) : REPO_SLUG;
  const already = installedPlugin(bin);
  if (already) { out.log(`   plugin already installed: ${already.id}`); return; }
  const add = run(bin, ['plugin', 'marketplace', 'add', source], { allowFail: true, capture: true });
  if (add.status !== 0 && !/already/i.test(add.stdout + add.stderr)) out.warn(`marketplace add: ${(add.stderr || add.stdout).trim()}`);
  const inst = run(bin, ['plugin', 'install', PLUGIN_ID], { allowFail: true, capture: true });
  if (inst.status !== 0) out.warn(`plugin install failed (${(inst.stderr || inst.stdout).trim() || 'exit ' + inst.status}); finish the rest of init, then run: claude plugin install ${PLUGIN_ID}`);
  else if (inst.stdout.trim()) out.log(inst.stdout.trim());
}

/** "5 hook entries, the MCP registration, 28 skills" — what removeDirectWiring took out, or '' when nothing. */
function directWiringSummary(d) {
  return [d.hooks && `${d.hooks} hook entries`, d.mcp && 'the MCP registration', d.skills && `${d.skills} skills`].filter(Boolean).join(', ');
}

/**
 * Wire the Codex host (init step 6b, upgrade) and record how in agenticos.json `hosts.codex.install`. Plugin mode
 * (codex-plugin D4/D5): add the marketplace — this checkout under --from-local, else GitHub — install or reinstall
 * agenticos@agenticos-workbench, and only then remove the direct wiring, so the two never run side by side. A plugin
 * install that fails falls back to the direct wiring, so the host is never left unwired. Returns the mode installed.
 */
function wireCodex(ctx, { bin, mode, upgrade = false }) {
  const { vault, repo, flags, written } = ctx;
  const cfg = readJson(configPath());
  const before = cfg && cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.install;
  let installed = mode;
  if (mode === 'plugin') {
    const source = flags.fromLocal ? path.resolve(flags.fromLocal) : REPO_SLUG;
    const r = CH.installCodexPlugin({ bin, source, switchSource: !!flags.fromLocal, run, io: out });
    if (r.state === 'installed') {
      const gone = directWiringSummary(CH.removeDirectWiring({ cfg, bin, run }));
      out.log(`   plugin ${CH.PLUGIN_ID}${r.version ? ` ${r.version}` : ''} installed from ${r.source}${gone ? ` · direct wiring removed (${gone})` : ''}`);
      if (upgrade && before !== 'plugin') out.log('   Codex asks once to trust the plugin\'s hooks: open codex, run /hooks, and trust the agenticos entries');
    } else {
      out.warn('the Codex plugin could not be installed; wiring Codex directly instead (aos upgrade tries the plugin again)');
      installed = 'direct';
    }
  }
  if (installed === 'direct') {
    const r = CH.installCodexHost({ cfg, launcher: scriptPath(vault, 'bin/aos'), config: configPath(), pluginDir: pluginSourceDir(vault, repo), bin, run, io: out });
    if (upgrade) out.log(`   hooks ${r.hooksChanged ? 'rewritten' : 'unchanged'} · MCP ${r.mcp} · skills ${r.skills.written.length} regenerated`);
    else {
      written.push(r.hooksFile, ...r.skills.written.map((n) => path.join(r.skillsDir, n, 'SKILL.md')));
      out.log(`   hooks ${r.hooksChanged ? 'written' : 'unchanged'} · MCP ${r.mcp} · skills ${r.skills.written.length} generated${r.skills.skipped.length ? `, ${r.skills.skipped.length} left alone (${r.skills.skipped.join(', ')})` : ''}`);
    }
  }
  const next = readJson(configPath());
  if (next && next.hosts && next.hosts.codex) { next.hosts.codex.install = installed; writeJson(configPath(), next); }
  return installed;
}

/** Take the Codex host down whichever way it was wired: the plugin and its marketplace plus any direct leftovers, or the direct wiring. */
function unwireCodex(cfg) {
  const bin = codexBin(cfg);
  if (bin && CH.codexPluginInstalled(bin, run)) {
    const p = CH.removeCodexPlugin({ bin, run, io: out });
    const gone = directWiringSummary(CH.removeDirectWiring({ cfg, bin, run }));
    out.log(`codex plugin removed: plugin ${p.plugin} · marketplace ${p.marketplace}${gone ? ` · direct wiring removed (${gone})` : ''}`);
    return;
  }
  const r = CH.removeCodexHost({ cfg, bin, run, io: out });
  out.log(`codex host removed: hooks ${r.hooksFileState} (${r.hooksRemoved} entries) · MCP ${r.mcp} · ${r.skills.length} skills deleted`);
}

/** Init step 8 (spec §10). Delegates to cli/persona-cmd.js; `act` already skipped us under --dry-run. */
function personaInterview(ctx) {
  const cfg = readJson(configPath()) || {};
  if (cfg.persona && cfg.persona.enabled === false) { out.log('   persona disabled in config; skipping the interview'); return; }
  return require('./persona-cmd.js').runInterview({
    configDir: configDir(), vault: ctx.vault, node: stableNode(process.execPath),
    answersFile: ctx.flags.personaJson ? path.resolve(ctx.flags.personaJson) : undefined,
    // dryRun is unreachable from init (act() skips this body under --dry-run — Open issue 6); kept so the function stays callable directly.
    yes: ctx.yes, dryRun: ctx.dry, exampleName: 'Proton', io: console,
  }).catch((e) => out.warn(`persona interview failed: ${e.message}; run \`aos persona\` later`));   // execution amendment 2026-09-15 (A11): Plan 3's allowFail — init stays exit 0
}

const TERMINAL_NOTE = `terminal: nothing to install — the ${APP_NAME} app brings its own terminal`;

function checklist(ctx) {
  const { vault, written, dry } = ctx;
  out.log('');
  if (dry) out.log('dry-run complete — nothing was written.');
  else {
    out.log('done. Files written:');
    for (const w of written) out.log(`  ${path.isAbsolute(w) ? w : path.join(vault, w)}`);
  }
  const hosts = ctx.hosts || { claude: true, codex: false };
  const steps = [];
  if (hosts.claude) {
    steps.push(`Add this line to your CLAUDE.md (${path.join(configDir(), 'CLAUDE.md')}); the installer never edits it:\n       @${path.join(vault, 'AGENTICOS.md')}`);
  }
  const codexPlugin = ctx.codexInstall === 'plugin';
  if (hosts.codex) {
    steps.push(codexPlugin
      ? `Open \`codex\`, run /hooks, and trust the ${CH.PLUGIN_ID} entries once; they stay trusted across aos upgrade.`
      : `Open \`codex\`, run /hooks, and trust the AgenticOS entries once (${CH.hooksFile(readJson(configPath()))}); they only need re-trusting if the vault moves.`);
  }
  // From the app's payload the app is already there (its wizard runs this); from a checkout it may not be.
  steps.push(ctx.repo && exists(path.join(ctx.repo, 'payload.json'))
    ? `Open the ${APP_NAME} app; it finds this vault through agenticos.json.`
    : `Open the ${APP_NAME} app (macOS, Apple silicon; download it from ${APP_DOWNLOAD}); it finds this vault through agenticos.json.`);
  steps.push(`Put ${path.join(os.homedir(), '.local', 'bin')} on your PATH, then run: aos doctor`);
  // install-import B2: no host yet. Re-running init with one adds it and keeps every file (`--host both` keeps both).
  if (!hosts.claude && !hosts.codex) steps.push('Add a host when you have one: install and log in to Claude Code or Codex, then run aos hosts add claude (or aos hosts add codex). It keeps every file. Sessions and the Chief of Staff wait until then.');
  if (hosts.claude) steps.push('Start a new `claude` session; the first prompt receives <brain-context>. Use /wrap at the end.');
  if (hosts.codex) steps.push(codexPlugin
    ? 'Start a new `codex` session; every SessionStart receives the conventions and the first prompt <brain-context>. The skills come with the agenticos plugin — use $agenticos:wrap at the end.'
    : `Start a new \`codex\` session; every SessionStart receives the conventions and the first prompt <brain-context>. Skills live under ${CH.skillsDir()} — use $wrap at the end.`);
  out.log('');
  out.log('Next steps:');
  steps.forEach((s, i) => out.log(`  ${i + 1}. ${s}`));
}

async function init(flags) {
  const dry = !!flags.dryRun;
  const yes = !!flags.yes;
  const repo = repoRoot(flags);
  const version = productVersion(repo);
  // An explicit --provider wins; otherwise a re-run keeps the mode already in agenticos.json (e.g. after `aos provider ollama`).
  const provider = flags.provider || ((readJson(configPath()) || {}).provider) || 'local';
  if (!PROVIDERS.includes(provider)) throw new UsageError(`--provider must be one of ${PROVIDERS.join('|')}`);
  const written = [];
  let n = 0;
  const act = async (what, fn) => { n += 1; out.log(`${dry ? '[dry-run] ' : ''}${n}. ${what}`); if (!dry) await fn(); };
  const ctx = { flags, repo, dry, yes, written, act, version };

  // 1. preflight
  if (nodeMajor() < 20) throw new CheckFailed(`Node 20 or newer is required (running v${process.versions.node})`);
  out.log(`preflight: node v${process.versions.node} · checkout ${repo} (v${version})`);
  const cfg0 = readJson(configPath());
  const bin = claudeBin(cfg0);
  const claudeOk = !!bin && claudeLoggedIn(bin);
  const cxBin = codexBin(cfg0);
  const codexOk = !!cxBin && CH.codexLoggedIn(cxBin, run);
  const hosts = resolveHosts(flags, cfg0, { claudeAvail: claudeOk, codexAvail: codexOk });
  assertKeepsHosts(flags, cfg0, hosts);
  ctx.hosts = hosts;
  if (hosts.claude) {
    if (!bin) {
      if (provider !== 'none') throw new CheckFailed('claude CLI not found — install Claude Code, pass --host codex, or pass --host none to install with no host yet');
      out.warn('claude CLI not found; the plugin will not be installed (re-run init after installing Claude Code)');
    } else if (!claudeOk) {
      if (provider !== 'none') throw new CheckFailed('claude is not logged in — run `claude auth login` first');
      out.warn('claude is not logged in; plugin install may fail');
    }
  }
  if (hosts.codex) {
    if (!cxBin) throw new CheckFailed('codex CLI not found — install Codex CLI, or drop --host codex');
    if (!codexOk) {
      if (provider !== 'none') throw new CheckFailed('codex is not logged in — run `codex login` first');
      out.warn('codex is not logged in; the MCP registration may fail');
    }
  }
  const hostLabel = [hosts.claude && 'claude', hosts.codex && 'codex'].filter(Boolean).join('+') || 'none (Sessions and the Chief of Staff wait for one)';
  // codex-plugin D4: the agenticos plugin where this Codex CLI installs plugins, else the direct wiring.
  const cxMode = hosts.codex ? CH.codexInstallMode(cxBin, run) : null;
  ctx.codexInstall = cxMode;
  out.log(`preflight: hosts ${hostLabel} · claude ${bin ? bin : 'absent'} · codex ${cxBin ? cxBin : 'absent'}${cxMode ? ` (${cxMode === 'plugin' ? 'plugin' : 'direct wiring'})` : ''}`);
  // install-import B1: Ollama is a warning, not a gate (background work waits for it; CLI users install it themselves, the
  // app's wizard installs it), and python3 is checked only with --cost, the one thing that runs it. graphify's Python
  // comes with uv. Obsidian is no prerequisite either: the Workbench is the AgenticOS Workbench app (workbench-app D1),
  // and --no-obsidian is accepted as a no-op so older scripts keep working.
  const ollBin = ollamaBin();
  if (!ollBin) out.warn(`ollama not found — background work waits for it; install it from ollama.com (the ${APP_NAME} app's setup installs it), then run aos doctor`);
  let py = null;
  if (flags.cost) {
    py = python3Version();
    if (!python3Ok(py)) throw new CheckFailed(`--cost: python3 >= 3.9 is required — ${py ? `found ${py.major}.${py.minor}` : 'python3 not found on PATH'}`);
  }
  // graphify spec D1: uv installs the pinned graphify (step 5c) with a Python of its own, so it is a hard gate.
  const uv = require('./graph-cmd.js').uvBin();
  if (!uv) throw new CheckFailed('uv not found — install it (docs.astral.sh/uv), then re-run aos init');
  out.log(`preflight: ollama ${ollBin || 'absent'}${py ? ` · python3 ${py.major}.${py.minor}` : ''} · uv ${uv}`);
  // execution amendment 2026-09-15 (A37): the analyzer ships from Plan 5 Task 1 on. --cost installs the module through
  // cost-cmd.js right after agenticos.json is written (step 5b); its python3 gate is now the unconditional one above (D7).
  if (flags.cost) {
    // execution amendment 2026-09-15 (A63): the sources check A37 dropped, restored here where nothing has been written yet — a
    // marketplace clone published without extras/ or a --from-local checkout that predates the analyzer fails in the preflight, not at step 5b.
    const costSrc = require('./cost-cmd.js').extrasDirFor(configDir(), flags.fromLocal || process.env.AOS_REPO_HINT);
    if (!exists(path.join(costSrc, 'analyze_transcript.py'))) throw new CheckFailed(`--cost: cost module sources not found at ${costSrc} (pass --from-local <repo-dir> carrying extras/cost, or run without --cost and \`aos cost enable\` later)`);
  }
  const oll = ollamaEndpoint(readJson(configPath()));
  if (ollBin) out.log(`preflight: ollama ${oll.host}:${oll.port} ${ollamaProbeSkipped() ? 'not probed (AOS_SKIP_OLLAMA_PROBE=1)' : (await httpProbe(`http://${oll.host}:${oll.port}/api/tags`)) ? 'reachable' : 'not reachable — run `ollama serve` (auto falls back to claude, then codex, then none until it answers)'}`);

  // 2. vault path
  let vault = flags.vault ? path.resolve(flags.vault) : DEFAULT_VAULT;
  if (!flags.vault && !yes && !dry) vault = path.resolve(await ask(`Vault directory [${DEFAULT_VAULT}]: `, DEFAULT_VAULT));
  assertVaultOk(vault);
  ctx.vault = vault;
  out.log(`vault: ${vault}`);

  // 3. seed
  await act(`copy the seed vault into ${vault} (existing files are kept)`, () => {
    const defaults = readJson(path.join(repo, 'brain', 'scripts', 'config.default.json'), {});
    const cfgJson = path.join(vault, 'brain', 'config.json');
    // final review F7: parse the user's brain/config.json BEFORE anything is written. readJson() conflated
    // ENOENT with a parse error, so a corrupt config took the "empty" branch and was replaced by the
    // defaults; refusing up front leaves the vault exactly as it was.
    const current = readJsonStrict(cfgJson);
    // execution amendment 2026-09-15 (A8): vault-template/persona/ holds the raw {{…}} templates (Task 5); the interview renders
    // them into <vault>/persona/ itself (step 8), so the seed copy must not land identity.template.md / STATE.template.md there.
    copyTree(path.join(repo, 'vault-template'), vault, { exclude: /(^|\/)persona(\/|$)/, rename: { _gitignore: '.gitignore' }, written });
    // Only the freshly seeded template gets today's date; a re-run must not touch live working memory.
    if (written.includes('brain/_index/SESSION.md')) {
      const session = path.join(vault, 'brain', '_index', 'SESSION.md');
      fs.writeFileSync(session, fs.readFileSync(session, 'utf8').replace(/^updated: .*$/m, `updated: ${localDay()}`));
    }
    if (!current || Object.keys(current).length === 0) { writeJson(cfgJson, defaults); written.push('brain/config.json'); }
  });

  // 4. vendor runtime
  await act(`vendor brain/scripts into ${scriptPath(vault, '')} and install its dependencies`, () => vendorRuntime(ctx));

  // 5. agenticos.json
  await act(`write ${configPath()}`, () => {
    const existing = readJson(configPath());
    const next = buildUserConfig(existing, { vault, provider, version, bin: hosts.claude ? bin : undefined, hosts, codexBin: hosts.codex ? cxBin : undefined, codexHome: hosts.codex ? CH.codexHome(existing) : undefined });   // execution amendment 2026-09-15 (A15): `cost:` dropped, `bin` stays
    writeJson(configPath(), next);
    written.push(configPath());
    noteClaudeBinChange(vault, existing && existing.claude && existing.claude.bin, next.claude.bin);
  });
  // 5b. cost module (only with --cost) — execution amendment 2026-09-15 (A39): the three installed files join the checklist
  if (flags.cost) await act('install the cost module (aos cost enable)', async () => {
    const cc = require('./cost-cmd.js');
    await cc.enable({ configDir: configDir(), vault, budget: flags.budget, yes, hint: flags.fromLocal || process.env.AOS_REPO_HINT, io: console });
    for (const f of cc.FILES) written.push(path.join('brain', 'scripts', 'cost', f));
  });
  // 5c. the vault knowledge graph (graphify spec D1/D2): the pinned graphify into a tool dir of our own; step 9's scan builds it
  await act('install graphify (pinned, through uv) for the vault knowledge graph', () => {
    const gc = require('./graph-cmd.js');
    const r = gc.install({ vault, configDir: configDir(), uv, template: path.join(repo, 'vault-template', '.graphifyignore'), io: out });
    written.push(r.bin);
  });

  // 6. plugin (Claude Code host)
  if (hosts.claude && bin) await act(`register the ${MARKETPLACE} marketplace and install ${PLUGIN_ID}`, () => installPlugin(ctx, bin));
  // 6b. Codex host: the agenticos plugin (codex-plugin D4/D5), else hooks.json, MCP registration, generated skills (design D3/D4)
  if (hosts.codex) await act(cxMode === 'plugin'
    ? `install the Codex plugin ${CH.PLUGIN_ID} from the ${MARKETPLACE} marketplace and remove any direct wiring`
    : 'wire the Codex host: hooks.json, the agenticos MCP server, and the skills under ~/.agents/skills', () => { ctx.codexInstall = wireCodex(ctx, { bin: cxBin, mode: cxMode }); });

  // 7. The Workbench is the app, which brings its own terminal: --terminal has nothing left to install.
  if (flags.terminal) out.log(TERMINAL_NOTE);

  // 8. persona — its duties need a host (install-import B2): with none, it waits, and `aos init --host <h>` asks it then.
  if (hosts.claude || hosts.codex) await act('run the Chief of Staff interview', () => personaInterview(ctx));
  else out.log('persona: no host yet, so no Chief of Staff; it is set up when you add Claude Code or Codex');

  // 9. first scan
  await act('first scan, compile BRAIN.md, warm the recall index', () => {
    runScript(vault, 'scan-vault', ['--quiet'], { allowFail: true });
    runScript(vault, 'build-brain-md', [], { allowFail: true });
    runScript(vault, 'recall', ['--warm'], { allowFail: true });
  });

  // 10. checklist
  checklist(ctx);
  return 0;
}

// ── upgrade / uninstall / terminal / persona / cost ───────────────────────────
/** Routines a release added to the vault template after brain/routines/ existed, with that release. */
// import-digest (install-import B10): on from the start, it turns itself off at its first run when no import queued
// anything, and `aos import` turns it on again; it never imports on its own (B12).
const NEW_ROUTINES = [{ slug: 'briefing', since: '1.5.0' }, { slug: 'import-digest', since: '2.0.0' }];

/** Upgrade: the three duties become routine files the first time brain/routines/ is absent (spec D10), and any
 *  installed schedule — legacy per-duty plists included — is re-rendered from the routine files so the old
 *  plists cannot fire a duty twice. A vault that already has brain/routines/ is the owner's; only the sync runs,
 *  except that an upgrade from before a NEW_ROUTINES release adds that routine when the vault lacks it (pulse-cockpit
 *  A5). Once the vault is on that release, a routine its owner deleted stays deleted. */
function migrateRoutines(ctx) {
  const { repo, vault } = ctx;
  const S = require('./schedule.js');
  const dir = path.join(vault, 'brain', 'routines');
  const seed = path.join(repo, 'vault-template', 'brain', 'routines');
  if (!isDir(dir) && isDir(seed)) {
    copyTree(seed, dir, { written: ctx.written });
    out.log(`   seeded brain/routines/ (${fs.readdirSync(seed).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.slice(0, -3)).join(', ')})`);
  }
  const { cmpSemver } = require('./update-check.js');
  for (const { slug, since } of NEW_ROUTINES) {
    const src = path.join(seed, `${slug}.md`);
    const dest = path.join(dir, `${slug}.md`);
    // An unreadable or missing recorded version counts as older.
    if (exists(dest) || !exists(src) || !isDir(dir) || (ctx.from && cmpSemver(ctx.from, since) !== null && cmpSemver(ctx.from, since) >= 0)) continue;
    fs.copyFileSync(src, dest);
    ctx.written.push(dest);
    out.log(`   added the ${slug} routine (new in ${since}): brain/routines/${slug}.md`);
  }
  const platform = process.platform;
  if (!S.isInstalled({ platform, vault })) { out.log('   no schedules installed; nothing to re-render (aos routines sync installs them)'); return; }
  const { scheduleVarsFor } = require('./routines.js');
  const cfg = readJson(configPath()) || {};
  const vars = scheduleVarsFor({ vault, configDir: configDir(), node: stableNode(cfg.node || process.execPath), cfg });
  const r = S.installSchedules({ vars, platform, warn: (m) => out.warn(m) });
  out.log(`   schedules re-rendered: ${r.labels.join(', ') || 'none'}${r.removed.length ? ` (removed ${r.removed.map((x) => path.basename(x)).join(', ')})` : ''}`);
}

/** `aos workspace <verb>` — cli/workspace.js (workspace hub D3; spaces-redesign D28: every flag its verbs take). */
async function workspace(sub, flags) {
  const W = require('./workspace.js');
  const value = (flag, v) => (v !== undefined ? [`--${flag}`, v] : []);
  const bool = (flag, v) => (v ? [`--${flag}`] : []);
  try {
    return await W.main([
      ...sub, ...value('name', flags.name), ...value('into', flags.into), ...value('cwd', flags.cwd), ...value('set', flags.set),
      ...value('expect', flags.expect), ...bool('git', flags.git), ...bool('pin', flags.pin), ...bool('empty', flags.empty),
      ...bool('dry-run', flags.dryRun), ...bool('skip-brain-md', flags.skipBrainMd), ...bool('json', flags.json),
    ], { io: console });
  } catch (e) {
    if (e instanceof W.UsageError) throw new UsageError(e.message);
    throw e;
  }
}

/** `aos routines <verb>` — cli/routines.js. */
async function routines(sub, flags) {
  const R = require('./routines.js');
  try {
    return await R.main([...sub, ...(flags.json ? ['--json'] : []), ...(flags.dryRun ? ['--dry-run'] : []), ...(flags.refresh ? ['--refresh'] : [])], { io: console });
  } catch (e) {
    if (e instanceof R.UsageError) throw new UsageError(e.message);
    throw e;
  }
}

/** `aos skills <verb>` — cli/skills.js (spec 2026-09-23-universal-skills). */
async function skills(sub, flags) {
  const K = require('./skills.js');
  try {
    return await K.main([...sub, ...(flags.json ? ['--json'] : []), ...(flags.dryRun ? ['--dry-run'] : []), ...(flags.all ? ['--all'] : [])], { io: console });
  } catch (e) {
    if (e instanceof K.UsageError) throw new UsageError(e.message);
    throw e;
  }
}

/** `aos agents <verb>` — cli/agents.js (spec 2026-09-23-universal-agents). */
async function agents(sub, flags) {
  const G = require('./agents.js');
  try {
    return await G.main([...sub, ...(flags.json ? ['--json'] : []), ...(flags.dryRun ? ['--dry-run'] : []), ...(flags.all ? ['--all'] : [])], { io: console });
  } catch (e) {
    if (e instanceof G.UsageError) throw new UsageError(e.message);
    throw e;
  }
}

/** `aos config <verb>` — cli/config-cmd.js (spec 2026-09-24-aos-config). */
async function config(sub, flags) {
  const C = require('./config-cmd.js');
  try {
    return await C.main([...sub, ...(flags.json ? ['--json'] : []), ...(flags.dryRun ? ['--dry-run'] : [])], { io: console, spend: spendByFamily });
  } catch (e) {
    if (e instanceof C.UsageError) throw new UsageError(e.message);
    throw e;
  }
}

/** The launcher execs <vault>/brain/scripts/cli/aos.js — the copy vendored by the PREVIOUS upgrade — so an upgrade
 *  step that is new in the release being installed would only run on the second `aos upgrade`. upgrade() therefore
 *  re-execs the CLI that ships with the source it re-vendors from: this returns that file when it is not the one
 *  running (null when it is, or when the source has no cli/aos.js — an unpacked bundle). */
function upgradeReexecTarget(repo, self = __filename) {
  const target = path.join(path.resolve(repo), 'cli', 'aos.js');
  if (!exists(target) || path.resolve(target) === path.resolve(self)) return null;
  return target;
}

/** Where the `claude` CLI keeps the agenticos-workbench marketplace: its `installLocation` — the GitHub clone, or for a
 *  marketplace added from a local directory (`aos init --from-local`) that checkout itself. null when unknown. */
function marketplaceDir(bin) {
  if (!bin) return null;
  const arr = safeParse(run(bin, ['plugin', 'marketplace', 'list', '--json'], { capture: true, allowFail: true }).stdout);
  const m = Array.isArray(arr) ? arr.find((x) => x && x.name === MARKETPLACE) : null;
  return m && typeof m.installLocation === 'string' && m.installLocation ? path.resolve(m.installLocation) : null;
}

async function upgrade(flags) {
  const cfg = loadConfigOrThrow();
  const vault = cfg.vault;
  const bin = claudeBin(cfg);
  const clone = path.join(configDir(), 'plugins', 'marketplaces', MARKETPLACE);
  const reexeced = process.env.AOS_UPGRADE_REEXEC === '1';
  // The plugin follows its marketplace, so refresh both whenever that marketplace is what this upgrade vendors from: a
  // plain upgrade (GitHub clone or local directory), or --from-local naming the directory the marketplace points at.
  // --from-local with any other checkout keeps the installed plugin (a dev checkout is not what Claude Code installs).
  const mktDir = reexeced ? null : (marketplaceDir(bin) || (isDir(clone) ? clone : null));
  const followsMarketplace = !flags.fromLocal || (mktDir && path.resolve(flags.fromLocal) === mktDir);
  if (bin && mktDir && !reexeced && followsMarketplace) {
    run(bin, ['plugin', 'marketplace', 'update', MARKETPLACE], { allowFail: true });
    run(bin, ['plugin', 'update', PLUGIN_ID], { allowFail: true });
  }
  // A Codex-only machine has no Claude Code marketplace: vendor from the Codex marketplace's folder instead, refreshed
  // first like the clone above (codex-parity-gaps D6). The Codex plugin itself is refreshed further down.
  const codexDir = !reexeced && !mktDir && !flags.fromLocal && hostsOf(cfg).codex
    ? CH.codexMarketplaceRoot({ bin: codexBin(cfg), run, refresh: true }) : null;
  const repo = repoRoot(flags, mktDir || codexDir);
  const target = reexeced ? null : upgradeReexecTarget(repo);
  if (target) {
    out.log(`upgrade: running the checkout's cli/aos.js (${target}) — the vendored copy is the one being replaced`);
    const r = run(process.execPath, [target, ...process.argv.slice(2)], { env: { AOS_UPGRADE_REEXEC: '1' }, allowFail: true });
    return typeof r.status === 'number' ? r.status : 1;
  }
  const version = productVersion(repo);
  const written = [];
  const act = async (what, fn) => { out.log(`- ${what}`); await fn(); };
  // `from`: the version this vault was last installed or upgraded at, before this upgrade records the new one.
  const ctx = { flags, repo, vault, written, act, dry: false, yes: true, version, from: cfg.version };
  out.log(`upgrading ${vault} from ${repo} (v${version})`);
  // local-first A9, install-import B12: what a release asks once (cli/migrations.js MIGRATIONS, gated on `from` like
  // NEW_ROUTINES), recorded pending first: before any step writes the new version, so an upgrade that stops part way
  // still asks at its re-run. Asked about at the end on a TTY; shown by the app's launch sequence.
  let migrationsAdded = [];
  await act('record what this release asks you once (aos migrate)', () => {
    migrationsAdded = require('./migrations.js').recordPending({ vault, from: ctx.from });
    out.log(`   ${migrationsAdded.length ? `pending: ${migrationsAdded.join(', ')}` : 'nothing new'}`);
  });
  await act('re-vendor brain/scripts (force) and reinstall its dependencies', () => vendorRuntime(ctx, { force: true }));
  await act('seed brain/routines/ and re-render the installed schedules', () => migrateRoutines(ctx));
  const hosts = hostsOf(cfg);
  await act(`migrate ${configPath()} keys (version → ${version})`, () => {
    const next = buildUserConfig(cfg, { vault, version, bin: hosts.claude ? bin : undefined, codexBin: hosts.codex ? codexBin(cfg) : undefined });
    writeJson(configPath(), next);
    noteClaudeBinChange(vault, cfg.claude && cfg.claude.bin, next.claude.bin);
  });
  if (hosts.codex) {
    // codex-plugin D4/D5: a direct install moves to the plugin as soon as this Codex CLI installs plugins.
    const cbin = codexBin(readJson(configPath()));
    const mode = CH.codexInstallMode(cbin, run);
    await act(mode === 'plugin'
      ? `install or refresh the Codex plugin ${CH.PLUGIN_ID}, then remove any direct wiring`
      : 're-wire the Codex host (hooks.json, MCP registration, regenerated skills)', () => wireCodex(ctx, { bin: cbin, mode, upgrade: true }));
  }
  await act('add any new default keys to brain/config.json (user values win)', () => {
    const defaults = readJson(path.join(repo, 'brain', 'scripts', 'config.default.json'), {});
    const p = path.join(vault, 'brain', 'config.json');
    // final review F7: missing is fine (fresh vault → {}), but merging the defaults over a file we could
    // not parse would drop every key the user has set. Refuse and stop the upgrade instead.
    writeJson(p, deepMerge(defaults, readJsonStrict(p, {}) || {}));
  });
  const SLI = statuslineLib(vault);
  if (SLI && exists(SLI.statePath(configPath()))) {
    // D9: our own entries follow this runtime; a slot someone else took is left to `aos statusline install`.
    await act('point the installed status line at this runtime', () => {
      const done = SLI.reapply(statuslineCtx(vault, cfg));
      if (done.length) out.log(`  updated: ${done.join(', ')}`);
    });
  }
  await act('install or refresh the pinned graphify and seed .graphifyignore', () => {
    // graphify spec D3: reinstall only when the installed version is not the pin. Upgrade is never gated (prereqs D9):
    // a machine without uv keeps upgrading, and doctor's `uv installed` row says what is missing.
    try {
      require('./graph-cmd.js').install({ vault, configDir: configDir(), template: path.join(repo, 'vault-template', '.graphifyignore'), io: out });
    } catch (e) { out.warn(`graph: ${e.message}`); }
  });
  await act('share user skills and agents between the hosts (skills-sync)', () => {
    runScript(vault, 'skills-sync', [], { allowFail: true });
  });
  await act('refresh the update check', async () => {
    const u = require('./update-check.js');
    // upgrade() is the one caller that knows all three surfaces just moved, and it can observe the
    // plugin's version directly (installedPlugin(bin).installPath, same as doctor()) — unlike the detached
    // producer, which has no CLAUDE_PLUGIN_ROOT and must carry the stored pluginVersion forward. Passing
    // `version` here instead would be wrong on --from-local, where `claude plugin update` is skipped and
    // the installed plugin genuinely stays behind.
    const plugin = bin ? installedPlugin(bin) : null;
    await u.runCheck({
      vault,
      vaultVersion: version,
      pluginVersion: plugin ? u.pluginVersionFrom(plugin.installPath) : null,
      configDir: configDir(),
    });
  });
  // After the update check: scan-vault copies its verdict into the snapshot the Workbench's update badge reads.
  await act('rebuild indexes (scan-vault, build-brain-md, recall --warm)', () => {
    runScript(vault, 'scan-vault', ['--quiet'], { allowFail: true });
    runScript(vault, 'build-brain-md', [], { allowFail: true });
    runScript(vault, 'recall', ['--warm'], { allowFail: true });
  });
  // An install from the Obsidian era still has the HUD in the vault: say once where the Workbench went, and leave the
  // folder alone (the user may still be running it until the app is installed).
  if (isDir(path.join(vault, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID))) {
    out.log(`The Workbench is now the ${APP_NAME} app for macOS (${APP_DOWNLOAD}); once you use the app, you can remove the old Obsidian plugin folder ${path.join(vault, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID)}.`);
  }
  out.log(`upgraded to v${version}. Memory, notes and persona were not touched.`);
  try {
    await require('./migrations.js').offer(migrationsAdded, { io: { log: out.log }, vault, configDir: configDir() });
  } catch (e) { out.warn(`aos migrate: ${e.message}`); }
  return 0;
}

/** Every routine schedule (com.agenticos.<slug> plists; crontab lines tagged "# com.agenticos.<slug>"), the three
 *  legacy duty labels included — one implementation, cli/schedule.js. com.agenticos.ollama (Plan 2, extras/ollama)
 *  is never matched there either. */
function removeSchedules() {
  const cfg = readJson(configPath());
  const { removed } = require('./schedule.js').removeSchedules({ vault: cfg && cfg.vault });
  for (const r of removed) out.log(`removed ${r}`);
  return removed;
}

async function uninstall(flags) {
  const cfg = readJson(configPath());
  const hosts = hostsOf(cfg);
  if (flags.host) {
    // Partial: unwire one host and keep everything else (vault, config, launcher, the other host).
    if (!['claude', 'codex'].includes(flags.host)) throw new UsageError('uninstall --host takes claude or codex');
    if (!cfg || !cfg.vault) throw new CheckFailed(`no ${configPath()} — nothing to unwire`);
    removeStatusline(cfg.vault, cfg, flags.host);
    if (flags.host === 'codex') {
      unwireCodex(cfg);
    } else {
      const cbin = claudeBin(cfg);
      if (cbin) for (const args of [['plugin', 'uninstall', PLUGIN_ID], ['plugin', 'marketplace', 'remove', MARKETPLACE]]) {
        const r = run(cbin, args, { allowFail: true, capture: true });
        if (r.status !== 0) out.warn(`claude ${args.join(' ')} failed (${(r.stderr || r.stdout).trim() || 'exit ' + r.status}); run it yourself`);
      } else out.warn(`claude CLI not found; skipped: claude plugin uninstall ${PLUGIN_ID}`);
    }
    const next = buildUserConfig(cfg, { vault: cfg.vault, version: cfg.version, hosts: { claude: hosts.claude && flags.host !== 'claude', codex: hosts.codex && flags.host !== 'codex' } });
    if (flags.host === 'codex') delete next.hosts.codex.install;
    writeJson(configPath(), next);
    out.log(`hosts now: ${[next.hosts.claude.enabled && 'claude', next.hosts.codex.enabled && 'codex'].filter(Boolean).join(', ') || 'none'}`);
    return 0;
  }
  if (cfg && cfg.vault) removeStatusline(cfg.vault, cfg);
  if (hosts.codex) unwireCodex(cfg);
  const bin = hosts.claude ? claudeBin(cfg) : null;
  if (bin) {
    // Warn and continue (a teardown must finish), but never report a removal that did not happen.
    for (const args of [['plugin', 'uninstall', PLUGIN_ID], ['plugin', 'marketplace', 'remove', MARKETPLACE]]) {
      const r = run(bin, args, { allowFail: true, capture: true });
      if (r.status !== 0) out.warn(`claude ${args.join(' ')} failed (${(r.stderr || r.stdout).trim() || 'exit ' + r.status}); run it yourself`);
      else if (r.stdout.trim()) out.log(r.stdout.trim());
    }
  } else if (hosts.claude) {
    out.warn(`claude CLI not found; skipped: claude plugin uninstall ${PLUGIN_ID} && claude plugin marketplace remove ${MARKETPLACE}`);
  }
  removeSchedules();
  const graphTools = require('./graph-cmd.js').removeTools();
  if (graphTools) out.log(`removed ${graphTools}`);
  const link = path.join(os.homedir(), '.local', 'bin', 'aos');
  try { if (fs.readlinkSync(link).endsWith('/brain/scripts/bin/aos')) { fs.unlinkSync(link); out.log(`removed ${link}`); } } catch { /* absent */ }
  try { fs.unlinkSync(configPath()); out.log(`removed ${configPath()}`); } catch { /* absent */ }
  if (!cfg || !cfg.vault) { out.log('no vault recorded; done'); return 0; }
  if (flags.keepVault) { out.log(`kept vault ${cfg.vault}`); return 0; }
  // --yes means "accept defaults, no prompts", and the default here is to keep the vault: it never prompts and it
  // never deletes. A scripted teardown that really wants the vault gone sets AOS_CONFIRM_DELETE=<vault>.
  const typed = process.env.AOS_CONFIRM_DELETE || (flags.yes ? '' : await ask(`Type the vault path to DELETE it, anything else keeps it (${cfg.vault}): `, ''));
  if (typed !== cfg.vault) {
    out.log(flags.yes
      ? `kept vault ${cfg.vault} (--yes never deletes; set AOS_CONFIRM_DELETE=<vault> or run without --yes and type the path)`
      : `kept vault ${cfg.vault} (delete it yourself if you want it gone)`);
    return 0;
  }
  assertVaultOk(cfg.vault); // structural guard (home dir, filesystem root, Claude config dir, settings.json) even under AOS_CONFIRM_DELETE
  // …and a confirmed path still has to look like a vault this installer built, so a hand-edited config cannot aim
  // the recursive remove at an unrelated directory.
  if (!exists(path.join(cfg.vault, 'AGENTICOS.md')) || !exists(scriptPath(cfg.vault, 'bin/aos'))) {
    throw new CheckFailed(`${cfg.vault} is not an AgenticOS vault (no AGENTICOS.md + brain/scripts/bin/aos); delete it yourself`);
  }
  fs.rmSync(cfg.vault, { recursive: true, force: true });
  out.log(`deleted ${cfg.vault}`);
  return 0;
}

/** Kept so a script written for an older release still runs: the app ships node-pty built for its own Electron. */
function terminal(sub) {
  if (sub[0] !== 'install') throw new UsageError('usage: aos terminal install');
  out.log(TERMINAL_NOTE);
  return 0;
}

function persona(sub, flags) {
  return require('./persona-cmd.js').run(sub, {
    yes: !!flags.yes,
    answersFile: flags.personaJson ? path.resolve(flags.personaJson) : undefined,
    exampleName: 'Proton', io: console,
  });
}

function cost(sub, flags) {
  return require('./cost-cmd.js').run(sub, { budget: flags.budget, yes: !!flags.yes, hint: flags.fromLocal || process.env.AOS_REPO_HINT, io: console });
}

function graph(sub, flags) {
  return require('./graph-cmd.js').run(sub, { configDir: configDir(), io: console, semantic: !!flags.semantic, yes: !!flags.yes });
}

// ── updates ───────────────────────────────────────────────────────────────────
function updateVault() { const cfg = readJson(configPath()); return (cfg && cfg.vault) || null; }

function updateCheck(flags) {
  return require('./update-check.js').cmdUpdateCheck({ vault: updateVault(), configDir: configDir(), flags, io: console });
}
function updateStatus(flags) {
  return require('./update-check.js').cmdUpdateStatus({ vault: updateVault(), configDir: configDir(), flags, io: console });
}
/** `aos memory <verb>` — cli/memory.js (spec 2026-10-11-brain-hub D13: every Brain hub action, for the page and sessions). */
async function memory(sub, flags) {
  const M = require('./memory.js');
  const value = (flag, v) => (v !== undefined ? [`--${flag}`, v] : []);
  const bool = (flag, v) => (v ? [`--${flag}`] : []);
  try {
    return await M.main([
      ...sub, ...value('set', flags.set), ...value('expect', flags.expect), ...value('by', flags.by), ...value('into', flags.into),
      ...bool('dry-run', flags.dryRun), ...bool('skip-brain-md', flags.skipBrainMd), ...bool('estimate', flags.estimate), ...bool('json', flags.json),
    ], { io: console });
  } catch (e) {
    if (e instanceof M.UsageError) throw new UsageError(e.message);
    throw e;
  }
}

/** `aos import` (install-import B7): cli/import.js, which runs the runtime's importer (brain/scripts/lib/import/). */
async function importCmd(sub, flags) {
  const I = require('./import.js');
  const value = (flag, v) => (v !== undefined ? [`--${flag}`, v] : []);
  try {
    return await I.main([
      ...sub, ...value('from', flags.from), ...value('since', flags.since), ...value('only', flags.only), ...value('accept', flags.accept),
      ...(flags.dryRun ? ['--dry-run'] : []), ...(flags.json ? ['--json'] : []),
    ], { io: console });
  } catch (e) {
    if (e instanceof I.UsageError) throw new UsageError(e.message);
    throw e;
  }
}

/** `aos hosts add <host>` (install-import B2): cli/hosts.js, wiring one more host into this install. */
async function hostsCmd(sub, flags) {
  const H = require('./hosts.js');
  try {
    // The steps init itself takes, handed over by name: this file's exports are not assigned yet while main() runs.
    const aos = {
      readJson, writeJson, configPath, configDir, claudeBin, claudeLoggedIn, codexBin, hostsOf, buildUserConfig, repoRoot,
      installPlugin, wireCodex, run, out, PLUGIN_ID, MARKETPLACE,
    };
    return await H.main(sub, { fromLocal: flags.fromLocal }, { io: console, aos });
  } catch (e) {
    if (e instanceof H.UsageError) throw new UsageError(e.message);
    if (e instanceof H.Refused) throw new CheckFailed(e.message);
    throw e;
  }
}

/** `aos migrate` (local-first A9, install-import B12): cli/migrations.js, the choices an upgrade asks once. */
async function migrateCmd(sub, flags) {
  const M = require('./migrations.js');
  const argv = [...sub, ...['status', 'apply', 'chief', 'decline', 'undo', 'json'].filter((f) => flags[f]).map((f) => `--${f}`)];
  if (flags.accept !== undefined) argv.push('--accept', flags.accept);
  try {
    return await M.main(argv, { io: console });
  } catch (e) {
    if (e instanceof M.UsageError) throw new UsageError(e.message);
    if (e instanceof M.Refused) throw new CheckFailed(e.message);
    throw e;
  }
}

/** `aos local` (local-first A8, A12, A13): cli/local.js, beside this file in the checkout and the vendored runtime. */
async function local(sub, flags) {
  const L = require('./local.js');
  try {
    return await L.main([...sub, ...(flags.json ? ['--json'] : [])], { io: console });
  } catch (e) {
    if (e instanceof L.UsageError) throw new UsageError(e.message);
    throw e;
  }
}

function updateNotice() {
  return require('./update-check.js').cmdUpdateNotice({ vault: updateVault(), configDir: configDir(), io: console });
}

// ── args and main ─────────────────────────────────────────────────────────────
// `aos workspace`'s own (spaces-redesign D28): --into, --cwd, --set, --expect take a value; --git, --pin, --empty do not.
// `aos memory`'s (brain-hub D13): --by takes a value (supersede's winner), --into merge's fields (brain-ai A9); set's
// --skip-brain-md and merge-draft's and sweep's --estimate (A5) do not.
// `aos import`'s (install-import B7): --from, --since, --only and --accept take a value.
const VALUE_FLAGS = new Set(['vault', 'provider', 'persona-json', 'from-local', 'budget', 'snooze', 'host', 'name', 'into', 'cwd', 'set', 'expect', 'by', 'from', 'since', 'only', 'accept']);
// `aos migrate`'s (local-first A9): --status, --apply, --chief, --decline and --undo take none, and main() refuses them on
// any other verb.
const MIGRATE_FLAGS = ['status', 'apply', 'chief', 'decline', 'undo'];
const BOOL_FLAGS = new Set(['dry-run', 'yes', 'terminal', 'cost', 'keep-vault', 'statusline', 'off', 'quiet', 'json', 'refresh', 'semantic', 'all', 'git', 'pin', 'empty', 'skip-brain-md', 'estimate',
  ...MIGRATE_FLAGS]);
// --no-obsidian is parsed and ignored: Obsidian is no longer installed, and a script written for an older release keeps working.
const NEGATABLE_FLAGS = new Set(['obsidian']);
function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
/** `--flag`, `--no-flag`, `--flag value`, `--flag=value`; unknown flags are a usage error (a typo must never start a real install). */
function parseArgs(argv) {
  const a = { cmd: argv[0] || '', sub: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    // A single-dash token is never a flag this CLI understands, and must not become a silent positional
    // (`aos init -y` would otherwise start an interactive install instead of accepting defaults).
    if (!t.startsWith('--')) {
      if (t.startsWith('-') && t !== '-') throw new UsageError(`unknown flag ${t}`);
      a.sub.push(t);
      continue;
    }
    const eq = t.indexOf('=');
    const name = eq === -1 ? t.slice(2) : t.slice(2, eq);
    const inline = eq === -1 ? undefined : t.slice(eq + 1);
    if (name.startsWith('no-')) {
      const base = name.slice(3);
      if (!NEGATABLE_FLAGS.has(base) || inline !== undefined) throw new UsageError(`unknown flag --${name}`);
      a.flags[camel(base)] = false;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v === '') throw new UsageError(`--${name} needs a value`);
      a.flags[camel(name)] = v;
      continue;
    }
    if (!BOOL_FLAGS.has(name) || inline !== undefined) throw new UsageError(`unknown flag --${name}`);
    a.flags[camel(name)] = true;
  }
  return a;
}

async function main(argv) {
  const { cmd, sub, flags } = parseArgs(argv);
  // --dry-run is an init-only preview (contract §4.3); on a mutating command it must be a loud error, never a silent no-op.
  const misplaced = cmd === 'migrate' ? undefined : MIGRATE_FLAGS.find((f) => flags[f] !== undefined);
  if (misplaced) throw new UsageError(`--${misplaced} is only for \`aos migrate\``);
  if (flags.dryRun && !['init', 'routines', 'skills', 'agents', 'config', 'workspace', 'memory', 'import'].includes(cmd)) throw new UsageError('--dry-run is only supported by `aos init`, `aos routines run`, `aos skills sync`, `aos agents sync`, `aos config set`, `aos config unset`, `aos workspace set`, `aos memory set`, `aos memory fix` and `aos import`');
  switch (cmd) {
    case 'init': return init(flags);
    case 'upgrade': return upgrade(flags);
    case 'uninstall': return uninstall(flags);
    case 'terminal': return terminal(sub);
    case 'persona': return persona(sub, flags);
    case 'cost': return cost(sub, flags);
    case 'graph': return graph(sub, flags);
    case 'routines': return routines(sub, flags);
    case 'skills': return skills(sub, flags);
    case 'agents': return agents(sub, flags);
    case 'config': return config(sub, flags);
    case 'workspace': return workspace(sub, flags);
    case 'memory': return memory(sub, flags);
    case 'doctor': return doctor();
    case 'status': return status();
    case 'provider': return provider(sub[0]);
    case 'local': return local(sub, flags);
    case 'import': return importCmd(sub, flags);
    case 'hosts': return hostsCmd(sub, flags);
    case 'migrate': return migrateCmd(sub, flags);
    case 'update-check': return updateCheck(flags);
    case 'update-status': return updateStatus(flags);
    case 'update-notice': return updateNotice();
    case 'help': case '--help': case '-h': out.log(USAGE); return 0;
    case '': out.log(USAGE); return 2;
    default: throw new UsageError(`unknown command: ${cmd}`);
  }
}

/** Exits once stdout and stderr have flushed. process.exit() drops whatever is still queued on a pipe, which cut
 *  `aos config list --json` off at 64 KB when the Workbench read it through one; a write callback runs after every
 *  earlier write on that stream has been handed to the OS. */
function exitFlushed(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => exitFlushed(code), (e) => {
    if (e instanceof UsageError) { process.stderr.write(`aos: ${e.message}\n${USAGE}\n`); exitFlushed(2); return; }
    // A non-Error rejection (a thrown string, a rejected promise with no reason) must still name itself.
    process.stderr.write(`aos: ${e && e.message ? e.message : String(e)}\n`);
    exitFlushed(1);
  });
}

module.exports = {
  parseArgs, deepMerge, configDir, configPath, readJson, readJsonStrict, writeJson, exists, isDir, insideDir, localDay,
  run, which, claudeBin, codexBin, hostsOf, resolveHosts, pluginSourceDir, npmBin, claudeLoggedIn, installedPlugin, python3Version, python3Ok, pythonBin, ollamaBin, httpProbe, ollamaEndpoint, ollamaProbeSkipped, ask,
  runScript, scriptPath, mcpProbe, spendRowsToday, spendToday, spendByFamily, isDutyFeature, isHookFeature, loadConfigOrThrow,
  doctor, chiefRow, status, provider, main,
  init, repoRoot, productVersion, upgradeReexecTarget, copyTree, assertVaultOk, buildUserConfig, linkLauncher, vendorRuntime, releaseTreeDeps, swapNodeModules,
  installPlugin, wireCodex, personaInterview, checklist, hudHost,
  upgrade, uninstall, removeSchedules, terminal, persona, cost, graph, routines, workspace, config, updateCheck, updateStatus, updateNotice,
  PROVIDERS, HOST_CHOICES, PLUGIN_ID, MARKETPLACE, REPO_SLUG, APP_DOWNLOAD, OBSIDIAN_PLUGIN_ID, DEFAULT_VAULT, RUNTIME_SCRIPTS, USAGE,
  VALUE_FLAGS, BOOL_FLAGS, NEGATABLE_FLAGS,
  UsageError, CheckFailed, out,
};
