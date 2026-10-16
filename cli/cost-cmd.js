'use strict';
/**
 * cost-cmd.js — `aos cost [enable | disable]` (spec §11).
 *   (no subcommand)                  print "cost enabled" / "cost disabled"
 *   enable [--budget <usd>] [--yes]  python3 ≥3.9 check → copy extras/cost/* into <vault>/brain/scripts/cost/
 *                                    → cost.enabled=true in agenticos.json → cost.monthlyBudget in brain/config.json
 *   disable                          cost.enabled=false (files stay; auto-cost reports "disabled")
 * Runs from the checkout (node cli/aos.js) and from the vendored <vault>/brain/scripts/cli/ (the aos
 * launcher): the analyzer sources are looked up in that order — $AOS_REPO_HINT/extras/cost, ../extras/cost
 * next to this file, then the marketplace clone under <configDir>/plugins/marketplaces/.
 * Zero dependencies; python probe and the budget prompt are injectable.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const EXTRAS = path.join(__dirname, '..', 'extras', 'cost');
const MARKETPLACE = 'agenticos-workbench';
const FILES = ['analyze_transcript.py', 'pricing.json', 'report-template.html'];
const MIN_PY = [3, 9];

function claudeConfigDir() { return require('./host-dirs.js').claudeConfigDir(); }
function agenticosPath(configDir) { return process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json'); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, obj) {
  // tmp + rename (spec 2026-09-24-aos-config D5): a reader never sees a half-written file.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Where extras/cost lives for this process: hint (AOS_REPO_HINT or --from-local) → checkout/vendored → marketplace clone. */
function extrasDirFor(configDir, hint = process.env.AOS_REPO_HINT, { checkout = EXTRAS } = {}) {
  const candidates = [hint ? path.join(path.resolve(hint), 'extras', 'cost') : null, checkout,
    path.join(configDir, 'plugins', 'marketplaces', MARKETPLACE, 'extras', 'cost')].filter(Boolean);
  return candidates.find(d => fs.existsSync(path.join(d, 'analyze_transcript.py'))) || candidates[candidates.length - 1];
}

/** Same seam as cli/aos.js pythonBin() (mandatory-prereqs D7): AOS_PYTHON_BIN when defined ('' → absent), else python3. */
function pythonVersion(exec = spawnSync) {
  const bin = process.env.AOS_PYTHON_BIN === undefined ? 'python3' : process.env.AOS_PYTHON_BIN;
  const r = bin ? exec(bin, ['--version'], { encoding: 'utf8' }) || {} : { error: new Error('AOS_PYTHON_BIN is empty') };
  const m = `${r.stdout || ''}${r.stderr || ''}`.match(/Python (\d+)\.(\d+)(?:\.(\d+))?/);
  if (r.error || !m) return { ok: false, version: null, reason: 'python3 not found on PATH' };
  const version = m[0].slice('Python '.length);
  const ok = Number(m[1]) > MIN_PY[0] || (Number(m[1]) === MIN_PY[0] && Number(m[2]) >= MIN_PY[1]);
  return { ok, version, reason: ok ? null : `python3 ${version} is older than ${MIN_PY.join('.')}` };
}

function parseBudget(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

function askBudget(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, (a) => { rl.close(); res(a); }));
}

function loadAgenticos(configDir) {
  const file = agenticosPath(configDir);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // Split by cause (final review F7/safety-6): a corrupt file is not "missing" — readJson used to
    // conflate ENOENT and SyntaxError, so a parse error was misreported as "run `aos init` first".
    if (e.code === 'ENOENT') throw new Error(`no agenticos.json at ${file} (run \`aos init\` first)`);
    throw new Error(`agenticos.json at ${file} does not parse: ${e.message}`);
  }
  return { file, cfg };
}

async function enable({ configDir = claudeConfigDir(), vault, budget, yes, io = console, exec, extrasDir, hint, ask = askBudget } = {}) {
  const { file, cfg } = loadAgenticos(configDir);
  vault = vault || cfg.vault;
  if (!vault) throw new Error('agenticos.json has no vault (run `aos init` first)');
  // execution amendment 2026-09-15 (A39): a non-numeric or non-positive --budget is a usage mistake — fail before touching anything.
  let monthly = null;
  if (budget != null && budget !== '') {
    monthly = parseBudget(budget);
    if (monthly == null) throw new Error(`--budget must be a positive number of USD (got "${budget}")`);
  }
  // Read the vault config ONCE, up front, before any copy or write (final review F7/safety-6): the old
  // `readJson(vaultCfgFile) || {}` at write time silently replaced a corrupt brain/config.json with just
  // {"cost":{…}}, dropping the user's other keys with no warning. ENOENT → {} (no config yet, fine);
  // any other parse error refuses the whole enable, with nothing copied and nothing flipped.
  const vaultCfgFile = path.join(vault, 'brain', 'config.json');
  let vaultCfg = {};
  try {
    vaultCfg = JSON.parse(fs.readFileSync(vaultCfgFile, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`refusing to touch unparseable ${vaultCfgFile}: ${e.message}`);
  }
  const py = pythonVersion(exec);
  if (!py.ok) throw new Error(`${py.reason}; the cost module needs python3 ${MIN_PY.join('.')}+`);
  const src = extrasDir || extrasDirFor(configDir, hint);
  // execution amendment 2026-09-15 (A39): `aos upgrade` re-vendors brain/scripts/extras/cost but never reinstalls brain/scripts/cost — say what actually helps.
  if (!fs.existsSync(path.join(src, 'analyze_transcript.py'))) throw new Error(`cost module sources not found at ${src} (run \`aos cost enable --from-local <repo-dir>\` from a checkout, or \`aos upgrade\` and then \`aos cost enable\` again)`);
  const dest = path.join(vault, 'brain', 'scripts', 'cost');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  // cost.enabled lives in agenticos.json only: lib/config.js merges it last, so it wins over brain/config.json's default false (A38).
  cfg.cost = { ...(cfg.cost || {}), enabled: true };
  writeJson(file, cfg);
  if (monthly == null && budget == null && !yes) monthly = parseBudget(await ask('Monthly budget in USD (blank = none): '));
  // execution amendment 2026-09-15 (A38): write cost.monthlyBudget only when a budget was supplied or answered — a re-run
  // without one (--yes, non-TTY, `aos init --cost --yes`) keeps whatever the vault config already holds.
  if (monthly != null) {
    vaultCfg.cost = { ...(vaultCfg.cost || {}), monthlyBudget: monthly };
    writeJson(vaultCfgFile, vaultCfg);
  }
  const storedBudget = (((readJson(vaultCfgFile) || {}).cost || {}).monthlyBudget);
  const effective = monthly != null ? monthly : (typeof storedBudget === 'number' && storedBudget > 0 ? storedBudget : null);
  io.log(`cost: enabled (python3 ${py.version}); analyzer installed at ${dest}; monthly budget ${effective == null ? 'not set' : `$${effective}`}`);
  io.log('cost: sessions are costed at SessionEnd from now on; `node brain/scripts/auto-cost.js --backfill` costs past sessions');
  return { enabled: true, dest, python: py.version, monthlyBudget: effective };
}

function disable({ configDir = claudeConfigDir(), io = console } = {}) {
  const { file, cfg } = loadAgenticos(configDir);
  cfg.cost = { ...(cfg.cost || {}), enabled: false };
  writeJson(file, cfg);
  io.log('cost: disabled (analyzer files left in place; the auto-cost stage now reports "disabled")');
  return { enabled: false };
}

/** `aos cost …`. `args` is Plan 3's positional `sub` array; `opts.budget`/`opts.yes` carry Plan 3's parsed flags (a raw --budget/--yes in args is tolerated). */
async function run(args, opts = {}) {
  const io = opts.io || console;
  const sub = args.find(a => !a.startsWith('--'));
  const b = args.indexOf('--budget');
  try {
    if (!sub) {
      const { cfg } = loadAgenticos(opts.configDir || claudeConfigDir());
      io.log(`cost ${cfg.cost && cfg.cost.enabled ? 'enabled' : 'disabled'}`);
      return 0;
    }
    if (sub === 'enable') {
      await enable({ ...opts, budget: opts.budget !== undefined ? opts.budget : (b >= 0 ? args[b + 1] : undefined), yes: opts.yes || args.includes('--yes') });
      return 0;
    }
    if (sub === 'disable') { disable(opts); return 0; }
    io.error('usage: aos cost [enable [--budget <usd>] [--yes] | disable]');
    return 2;
  } catch (e) {
    io.error(`cost: ${e.message}`);
    return 1;
  }
}

module.exports = { EXTRAS, MARKETPLACE, FILES, MIN_PY, pythonVersion, parseBudget, extrasDirFor, enable, disable, run };
