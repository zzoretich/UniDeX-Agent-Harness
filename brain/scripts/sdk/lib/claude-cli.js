'use strict';
/**
 * claude-cli.js — the ONLY place the brain spawns `claude -p`.
 *
 * Recipe (measured 2026-09-04): every flag below is load-bearing.
 *   --setting-sources ""   the user's settings/hooks/CLAUDE.md are NOT loaded (without it a
 *                          call pulled ~45k tokens of context and fired the user's own hooks)
 *   --strict-mcp-config    no MCP servers
 *   --tools ""             no tools
 *   --no-session-persistence
 *   --max-budget-usd       hard per-call cap
 *   --output-format json   one JSON object on stdout: result, structured_output, total_cost_usd, usage, duration_api_ms
 * The child always gets AOS_HEADLESS=1 (hook scripts exit at once — lib/hook-entry.js) and
 * never inherits CLAUDECODE. A call that passes no `effort` also gets MAX_THINKING_TOKENS=0 (spec
 * 2026-09-23-graphify D12): measured on a Haiku extraction, thinking was 82% of the output and the cost
 * ($0.069 → $0.008); a caller that dials an effort (the reasoner) keeps its thinking. `--bare` is deliberately absent: it skips OAuth and fails for
 * logged-in users.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { PATHS } = require('../../lib/paths.js');
const { loadConfig } = require('../../lib/config.js');
const { ProviderUnavailable, recordSpend } = require('./spend-ledger.js');

const NOT_LOGGED_IN = /not logged in/i;
const DEFAULT_CANDIDATES = [path.join(os.homedir(), '.local', 'bin', 'claude')];

function defaultLookup() {
  try {
    const out = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}

function isExecutableFile(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** agenticos.json `claude.bin` (contract §2), read through loadConfig() where that file merges last; null when unset. */
function recordedBin() {
  let cfg = null;
  try { cfg = loadConfig(); } catch { return null; }
  const b = cfg && cfg.claude && cfg.claude.bin;
  return typeof b === 'string' && b ? b : null;
}

/** The path `aos init` recorded (while it is still an executable file) → PATH (`command -v claude`) →
 *  ~/.local/bin/claude, else null. opts.recorded overrides the config read (null = "no recorded path");
 *  opts.lookup / opts.candidates override the probes (tests). */
function resolveClaudeBin(opts = {}) {
  const recorded = opts.recorded === undefined ? recordedBin() : opts.recorded;
  if (recorded && isExecutableFile(recorded)) return recorded;
  const found = (opts.lookup || defaultLookup)();
  if (found) return found;
  for (const c of opts.candidates || DEFAULT_CANDIDATES) {
    if (isExecutableFile(c)) return c;
  }
  return null;
}

const EFFORTS = ['low', 'medium', 'high'];
/** No tools, none of the user's settings/hooks/CLAUDE.md, no MCP servers — shared with the graph shim (graph-claude.js). */
const ISOLATION_FLAGS = ['--tools', '', '--setting-sources', '', '--strict-mcp-config'];

/** `effort` (low|medium|high) becomes `--effort`; anything else is left off so the CLI default applies. */
function buildArgs({ prompt, model, system, schema, maxBudgetUsd, effort }) {
  const args = ['-p', String(prompt ?? ''), '--model', String(model)];
  if (EFFORTS.includes(effort)) args.push('--effort', effort);
  args.push(...ISOLATION_FLAGS, '--no-session-persistence', '--system-prompt', String(system ?? ''));
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  args.push('--max-budget-usd', String(maxBudgetUsd), '--output-format', 'json');
  return args;
}

/** The child env of every headless call; `thinking: false` adds MAX_THINKING_TOKENS=0 (D12). */
function headlessEnv(base = process.env, { thinking = true } = {}) {
  const env = { ...base, AOS_HEADLESS: '1' };
  delete env.CLAUDECODE;
  if (!thinking) env.MAX_THINKING_TOKENS = '0';
  return env;
}

function runClaude({ bin, args, cwd, timeoutMs, spawnFn, env = headlessEnv() }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawnFn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return reject(e); }
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const handleStreamError = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* already gone */ } reject(e); };
    child.stdout.on('error', handleStreamError);
    child.stderr.on('error', handleStreamError);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`claude -p timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

/**
 * One headless call. Resolves { text, structured, usd, usage, ms }; every successful call
 * AND every billed failure is appended to the spend ledger. "Not logged in" anywhere in the
 * output → ProviderUnavailable('PROVIDER_UNREACHABLE').
 */
async function claudeCall({
  system = '', prompt, schema, model = 'haiku', maxBudgetUsd = 0.05, timeoutMs = 120000,
  cwd = PATHS.VAULT, feature = 'unknown', bin, spawnFn, effort,
} = {}) {
  const exe = bin || resolveClaudeBin();
  if (!exe) throw new ProviderUnavailable('PROVIDER_UNREACHABLE', 'claude CLI not found on PATH or in ~/.local/bin', 'claude');
  const args = buildArgs({ prompt, model, system, schema, maxBudgetUsd, effort });
  const env = headlessEnv(process.env, { thinking: EFFORTS.includes(effort) });
  const { code, stdout, stderr, ms } = await runClaude({ bin: exe, args, cwd, timeoutMs, spawnFn: spawnFn || spawn, env });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  const obj = parsed && typeof parsed === 'object' ? parsed : null;
  const usage = obj && obj.usage && typeof obj.usage === 'object' ? obj.usage : {};
  const usd = obj ? Number(obj.total_cost_usd) || 0 : 0;
  const apiMs = obj && typeof obj.duration_api_ms === 'number' ? obj.duration_api_ms : ms;
  const ledger = () => recordSpend({ feature, provider: 'claude', model, usd,
    inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, ms: apiMs });
  // A BILLED result is ledgered before success/failure is decided: a failed result can still
  // carry cost (subtype error_max_budget does), and spendToday() must not under-count it.
  // A cost-free result is ledgered only on the success path, so the non-JSON, non-zero-exit
  // and "Not logged in" paths — nothing to record — stay out of the ledger.
  if (usd > 0) ledger();
  // "Not logged in" is only ever a diagnosis of a FAILED call. Matching it on a success would
  // misread a model reply that merely quotes the phrase as an unreachable provider (and, via
  // isRetryable, spool and retry a call that already succeeded).
  if ((code !== 0 || !obj || obj.is_error) && NOT_LOGGED_IN.test(stdout + '\n' + stderr)) {
    throw new ProviderUnavailable('PROVIDER_UNREACHABLE', 'claude CLI: Not logged in (run `claude login`)', 'claude');
  }
  if (code !== 0 || !obj) {
    throw new Error(`claude -p exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
  }
  if (obj.is_error) {
    throw new Error(`claude -p error (${obj.subtype || 'unknown'}): ${String(obj.result || '').slice(0, 300)}`);
  }
  if (usd === 0) ledger();
  return {
    text: typeof obj.result === 'string' ? obj.result : '',
    structured: obj.structured_output === undefined ? null : obj.structured_output,
    usd,
    usage,
    ms: apiMs,
  };
}

/**
 * Is the CLI signed in? `claude auth status --json` answers `{ loggedIn }` without a model call (local-first A16: the
 * check was a billed `claude -p` on haiku). Any failure (no binary, timeout, unparsable reply) → false.
 */
async function loginProbe(opts = {}) {
  const bin = opts.bin === undefined ? resolveClaudeBin(opts) : opts.bin;
  if (!bin) return false;
  try {
    const r = await runClaude({
      bin, args: ['auth', 'status', '--json'], timeoutMs: opts.timeoutMs || 60000,
      spawnFn: opts.spawnFn || spawn, env: headlessEnv(),
    });
    const obj = JSON.parse(r.stdout);
    return !!(obj && obj.loggedIn === true);
  } catch { return false; }
}

module.exports = { resolveClaudeBin, loginProbe, claudeCall, buildArgs, headlessEnv, NOT_LOGGED_IN, EFFORTS, ISOLATION_FLAGS };
