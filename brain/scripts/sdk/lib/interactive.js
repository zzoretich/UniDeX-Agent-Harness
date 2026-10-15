'use strict';
/**
 * interactive.js — the three-mode contract for the interactive scripts
 * (ask, standup, reflect-week, consolidate-memory, compress):
 *   --context (default)  print the assembled prompt for Claude-in-session; write nothing
 *   --write <file>       persist Claude's answer where the script would have written model output
 *   --local              run through the provider exactly as the old Ollama path did
 */
const fs = require('fs');

// The none reasons of provider local's engine (provider.js resolveLocal), and what to do about each.
const LOCAL_DOWN = new Set(['local-down', 'local-model-missing']);
const LOCAL_HINT = { 'local-down': 'start Ollama (or your local engine)', 'local-model-missing': 'pull the model with aos local pull' };

function parseMode(argv) {
  const rest = [];
  let mode = 'context';
  let writeFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') mode = 'local';
    else if (a === '--context') mode = 'context';
    else if (a === '--write') { mode = 'write'; writeFile = argv[++i] ?? null; }
    else if (a.startsWith('--write=')) { mode = 'write'; writeFile = a.slice('--write='.length); }
    else rest.push(a);
  }
  return { mode, writeFile, rest };
}

/**
 * `--host=claude|codex` among the arguments (reflect-week, consolidate-memory; ask.js has its own): with --local, that
 * host once, never another, whatever ai.<feature> says (local-first A3: "Run once on Claude/Codex"). → { host, rest }.
 * Any other value is a usage error.
 */
function hostFlag(argv) {
  let host = null;
  const rest = [];
  for (const a of argv) {
    const m = /^--host=(.*)$/.exec(a);
    if (!m) { rest.push(a); continue; }
    if (m[1] !== 'claude' && m[1] !== 'codex') throw new Error('--host takes claude or codex');
    host = m[1];
  }
  return { host, rest };
}

function renderContextBlock({ feature, system, context, format }) {
  return [
    `<<<AOS_CONTEXT feature=${feature}>>>`,
    '## System', String(system ?? ''), '',
    '## Context', String(context ?? ''), '',
    '## Output format', String(format ?? ''),
    '<<<END>>>',
  ].join('\n') + '\n';
}

function printContext(spec) { process.stdout.write(renderContextBlock(spec)); }

function readWriteFile(file) {
  if (!file) throw new Error('--write needs a file path (or - for stdin)');
  return fs.readFileSync(file === '-' ? 0 : file, 'utf8');
}

/**
 * The provider for --local; a `none` provider is an error the CLI reports on stderr (with `reason` set when it is the
 * local engine's: local-down, local-model-missing).
 * With `{ role: 'reasoner' }` the reasoner's provider (headless Claude) is returned; when that is
 * unavailable and the global provider is Ollama, the Ollama provider comes back instead with
 * `degraded` set to the reason, and reason() then sends it the workhorse request.
 */
async function localProvider(feature, { role, prefer, model, effort } = {}) {
  const prov = require('./provider.js');
  if (role && (prefer || model || effort)) {
    // A host, model or effort the user chose: resolved for this call only, and no other provider stands in for it.
    const p = await prov.resolveProviderForRole({ role, feature, prefer, model, effort });
    if (p.name !== 'none') return p;
    const e = new Error(`${prefer || 'the chosen host'} cannot answer (${p.reason})`);
    e.code = 'PROVIDER_NONE';
    throw e;
  }
  const p = role ? await prov.getProviderForRole(role, feature) : await prov.getProvider(feature);
  if (p.name !== 'none') return p;
  if (LOCAL_DOWN.has(p.reason)) {
    // local-first A2, A3: this feature runs on the local engine, which cannot answer now. No host stands in for it
    // unseen: the caller may ask one by name (ask.js --host=claude|codex) or run it in a session.
    const e = new Error(`the local model cannot answer (${p.reason}): ${LOCAL_HINT[p.reason]}; or run once on a host (--host=claude or --host=codex), or without --local for the in-session path`);
    e.code = 'PROVIDER_NONE';
    e.reason = p.reason;
    throw e;
  }
  if (role && require('./models.js').providerFor(role) === 'claude') {
    const g = await prov.getProvider(feature);
    if (g.name === 'ollama') return { ...g, degraded: p.reason };
    const e = new Error(`no model provider for the ${role} (${p.reason}) and none for the workhorse fallback (${g.reason}); run without --local for the in-session path`);
    e.code = 'PROVIDER_NONE';
    throw e;
  }
  const e = new Error(`no model provider (${p.reason}); run without --local for the in-session path`);
  e.code = 'PROVIDER_NONE';
  throw e;
}

module.exports = { parseMode, hostFlag, renderContextBlock, printContext, readWriteFile, localProvider, LOCAL_DOWN };
