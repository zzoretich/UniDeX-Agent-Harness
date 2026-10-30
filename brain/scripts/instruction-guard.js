#!/usr/bin/env node
'use strict';
/**
 * PreToolUse guard for instruction paths. It denies explicit headless writes and asks Claude's native permission flow
 * about interactive instruction edits. Codex does not support a hook-requested ask: its normal permission flow applies
 * in an interactive session. The duty snapshot is the backstop for dynamic commands and host hook gaps.
 */
const fs = require('fs');
const path = require('path');
const { instructionKind, fold } = require('./lib/write-areas.js');
const { hostInstructionRoots } = require('./persona/duty-guard.js');

const PATH_KEYS = new Set(['file_path', 'filepath', 'path', 'target', 'destination', 'dest', 'filename']);
const MUTATING = /(?:^|[^a-z])(?:write|edit|patch|delete|remove|create|update|move|rename|replace|apply)(?:[^a-z]|$)/i;
const SHELL_MUTATING = /(?:^|[\s;&|])(?:rm|mv|cp|install|mkdir|touch|tee|sed|perl|python\d*|node|ruby|printf|echo|git\s+(?:checkout|restore|apply|add|rm|mv))\b|(?:>>?|\bapply_patch\b)/i;

function parsedInput(input) {
  if (typeof input !== 'string') return input && typeof input === 'object' ? input : {};
  try { const value = JSON.parse(input); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function isInside(file, root) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function abs(file, cwd) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  const expanded = file.startsWith('~/') ? path.join(process.env.HOME || require('os').homedir(), file.slice(2)) : file;
  return path.resolve(cwd, expanded);
}
function protectedKind(file, { vault, hostRoots = [], cwd }) {
  const target = abs(file, cwd);
  if (!target) return null;
  const vaultDir = path.resolve(vault);
  for (const root of [vaultDir, (() => { try { return fs.realpathSync(vaultDir); } catch { return vaultDir; } })()]) {
    if (!isInside(target, root)) continue;
    const rel = path.relative(root, target).split(path.sep).join('/');
    const kind = instructionKind(rel);
    if (kind) return kind;
  }
  for (const spec of hostRoots) {
    const aliases = [path.resolve(spec.dir)];
    try { aliases.push(fs.realpathSync(spec.dir)); } catch { /* root can be new */ }
    for (const root of aliases) {
      if (!isInside(target, root)) continue;
      const rel = path.relative(root, target).split(path.sep).join('/');
      if (spec.kind === 'skills' && fold(path.basename(rel)) === 'skill.md' && !rel.split('/').some((p) => p.startsWith('.'))) return 'skill';
      if (spec.kind === 'agents' && !rel.includes('/') && /\.(md|toml)$/i.test(rel)) return 'agent';
    }
  }
  return null;
}
function stringPaths(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const child of value) stringPaths(child, out); return out; }
  for (const [key, child] of Object.entries(value)) {
    if (PATH_KEYS.has(key.toLowerCase()) && typeof child === 'string') out.push(child);
    else if (child && typeof child === 'object') stringPaths(child, out);
  }
  return out;
}
function patchPaths(command) {
  return [...String(command || '').matchAll(/^\*\*\* (?:Add|Update|Delete|Move to) File: (.+)$/gm)].map((m) => m[1].trim());
}
function shellPaths(command) {
  const text = String(command || '');
  const out = [];
  // Common explicit paths only. Dynamic paths are caught by the duty's post-run snapshot.
  for (const m of text.matchAll(/(?:^|[\s'"=>(])((?:~\/|\/|\.\.?\/|persona\/|brain\/)[^\s'";|<>)]{2,})/g)) out.push(m[1].replace(/[,.:]+$/, ''));
  return out;
}
function touchedInstructions(payload, options) {
  const name = String(payload.tool_name || '');
  const input = parsedInput(payload.tool_input);
  const cwd = options.cwd || payload.cwd || options.vault;
  const ctx = { ...options, cwd };
  let candidates = [];
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) candidates = stringPaths(input);
  else if (name === 'apply_patch') candidates = [...patchPaths(input.command || input.patch), ...stringPaths(input)];
  else if (name === 'Bash' || name === 'exec_command') {
    const command = String(input.command || input.cmd || '');
    if (!SHELL_MUTATING.test(command)) return [];
    candidates = shellPaths(command);
  } else if (name.startsWith('mcp__') && MUTATING.test(name)) candidates = stringPaths(input);
  else return [];
  return [...new Set(candidates.map((file) => protectedKind(file, ctx)).filter(Boolean))];
}
function decision(payload, options) {
  if (!payload || payload.hook_event_name !== 'PreToolUse') return null;
  const kinds = touchedInstructions(payload, options);
  if (!kinds.length) return null;
  if (options.env.AOS_HEADLESS === '1') return 'deny';
  if (options.host === 'claude') return 'ask';
  return null; // Codex cannot request an ask from a PreToolUse hook; use its native permission flow.
}
function output(choice) {
  if (!choice) return '';
  return JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: choice,
    permissionDecisionReason: 'Instruction changes need your approval. Review the exact change before continuing.',
  } }) + '\n';
}
async function main(env = process.env) {
  let payload;
  try { payload = JSON.parse(await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; if (data.length > 1024 * 1024) process.stdin.destroy(); });
    process.stdin.on('end', () => resolve(data));
  })); } catch { return; }
  const vault = env.AOS_VAULT;
  if (!vault) return;
  const host = env.AOS_HOST === 'codex' ? 'codex' : 'claude';
  const hostRoots = hostInstructionRoots(vault, env);
  const result = decision(payload, { vault, hostRoots, host, env });
  const text = output(result);
  if (text) process.stdout.write(text);
}
if (require.main === module) main().catch(() => {});
module.exports = { parsedInput, protectedKind, patchPaths, shellPaths, touchedInstructions, decision, output, main };
