#!/usr/bin/env node
'use strict';
/**
 * build-playbook.js — generates <vault>/persona/PLAYBOOK.md from the arsenal scan.
 * One-time use (or --force): after bootstrap the playbook is the persona's to curate;
 * regenerating would destroy annotations. Called by persona/interview.js on first run.
 *
 *   node persona/build-playbook.js [--root <configDir>] [--vault <dir>] [--name <agent>] [--force]
 */
const fs = require('fs');
const path = require('path');
const { scanArsenal } = require('./scan-arsenal.js');

function header(name, now) {
  return `---
type: persona-playbook
updated: ${now.toISOString().slice(0, 10)}
---

# ${name} PLAYBOOK — the front door

> Route by intent, not by name. After using a route, annotate it: append
> \`✓ <date> note\` or \`✗ <date> note\` to its Notes cell. Curate ruthlessly —
> a stale playbook is worse than none. Core Routes are hand-curated; the
> generated sections below them are the raw inventory.

## Core Routes

| Intent | Route | Notes |
|---|---|---|
| Interactive software development | If installed in this host, use Superpowers skills for discovery, design, planning, TDD, debugging, review, and finish; follow user instructions and host permissions. | |
| _curated after the first reflect duty_ | | |
`;
}

function table(entries) {
  const rows = entries.map(e => `| ${e.name}${e.host === 'codex' ? ' (Codex)' : ''} | ${e.description.replace(/\|/g, '\\|')} | |`);
  return ['| Name | Description | Notes |', '|---|---|---|', ...rows].join('\n');
}

/** @returns {string} the markdown written to <vault>/persona/PLAYBOOK.md */
function buildPlaybook({ configDir, vault, name = 'PERSONA', force = false, now = new Date() }) {
  if (!configDir || !vault) throw new Error('buildPlaybook({ configDir, vault }) needs both roots');
  const target = path.join(vault, 'persona', 'PLAYBOOK.md');
  if (fs.existsSync(target) && !force) {
    throw new Error(`${target} exists — pass --force to overwrite (destroys annotations)`);
  }
  const all = scanArsenal(configDir);
  const section = t => all.filter(e => e.type === t);
  const md = [
    header(name, now),
    '\n## Skills (generated)\n', table(section('skill')),
    '\n\n## Agents (generated)\n', table(section('agent')),
    '\n\n## Commands (generated)\n', table(section('command')),
    '\n',
  ].join('');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, md);
  return md;
}

if (require.main === module) {
  const arg = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
  const { PATHS } = require('../lib/paths.js');
  const configDir = arg('--root') || PATHS.CLAUDE_CONFIG_DIR;
  const vault = arg('--vault') || PATHS.VAULT;
  buildPlaybook({ configDir, vault, name: arg('--name') || 'PERSONA', force: process.argv.includes('--force') });
  console.log(`wrote ${path.join(vault, 'persona', 'PLAYBOOK.md')}`);
}

module.exports = { buildPlaybook };
