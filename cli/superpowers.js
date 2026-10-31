'use strict';
/** Official Superpowers plugin status and bounded, idempotent installation for either interactive host. */
const { spawnSync } = require('node:child_process');

const SELECTORS = Object.freeze({ claude: 'superpowers@claude-plugins-official', codex: 'superpowers@openai-curated-remote' });
const COMMANDS = Object.freeze({ claude: `claude plugin install ${SELECTORS.claude}`, codex: `codex plugin add ${SELECTORS.codex}` });

function defaultRun(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  return { status: r.status === null ? 124 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}
function parse(s) { try { return JSON.parse(s); } catch { return null; } }
function diagnostic(r) { return String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 350); }

function status({ host, bin, mode = 'plugin', run = defaultRun }) {
  if (!SELECTORS[host]) throw new Error(`unknown host: ${host}`);
  const command = COMMANDS[host];
  if (!bin) return { host, state: 'missing-cli', command, detail: `${host} CLI is unavailable` };
  if (host === 'codex' && mode !== 'plugin') return { host, state: 'unsupported', command, detail: 'Superpowers needs Codex plugin support; upgrade Codex, then run aos superpowers install' };
  const r = run(bin, ['plugin', 'list', '--json'], { capture: true, allowFail: true, timeout: 15_000 });
  const list = r.status === 0 ? parse(r.stdout) : null;
  const entries = host === 'claude' ? list : list && list.installed;
  if (!Array.isArray(entries)) return { host, state: 'unknown', command, detail: `plugin list failed: ${diagnostic(r)}` };
  const item = entries.find(p => p && (host === 'claude' ? p.id : p.pluginId) === SELECTORS[host]);
  if (!item && host === 'codex' && /failed to list remote marketplace plugins/i.test(r.stderr)) return { host, state: 'unknown', command, detail: 'remote plugin catalog could not be checked' };
  if (!item || (host === 'codex' && item.installed === false)) return { host, state: 'missing', command };
  return { host, state: item.enabled === false ? 'disabled' : 'installed', command, version: item.version || null };
}

function ensure(ctx) {
  const before = status(ctx);
  if (before.state !== 'missing') return before;
  const args = ctx.host === 'claude'
    ? ['plugin', 'install', SELECTORS.claude, '--scope', 'user', '--json', '--yes']
    : ['plugin', 'add', SELECTORS.codex, '--json'];
  const r = (ctx.run || defaultRun)(ctx.bin, args, { capture: true, allowFail: true, timeout: 60_000 });
  if (r.status !== 0) return { ...before, state: 'failed', detail: diagnostic(r) };
  const after = status(ctx);
  return after.state === 'installed' || after.state === 'disabled' ? after
    : { ...before, state: 'failed', detail: `install returned success but plugin status is ${after.state}` };
}

function enabled(cfg) { return !!(cfg && cfg.integrations && cfg.integrations.superpowers && cfg.integrations.superpowers.enabled === true); }

module.exports = { SELECTORS, COMMANDS, status, ensure, enabled };
