'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../instruction-guard.js');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-guard-'));
  const vault = path.join(home, 'vault');
  const skill = path.join(home, 'skills');
  fs.mkdirSync(vault);
  fs.mkdirSync(skill);
  return { vault, hostRoots: [{ id: 'codex-skills', dir: skill, kind: 'skills' }], skill, cwd: vault };
}
function payload(name, toolInput, cwd) { return { hook_event_name: 'PreToolUse', tool_name: name, tool_input: toolInput, cwd }; }

test('headless explicit instruction edits are denied; observations are not', () => {
  const opts = { ...setup(), host: 'codex', env: { AOS_HEADLESS: '1' } };
  const self = payload('Write', { file_path: 'persona/IDENTITY.md' }, opts.vault);
  assert.equal(G.decision(self, opts), 'deny');
  assert.equal(G.decision(payload('Write', { file_path: 'persona/STATE.md' }, opts.vault), opts), null);
  assert.equal(G.decision(payload('Write', { file_path: 'brain/memory/feedback/rule.md' }, opts.vault), opts), 'deny');
  assert.equal(G.decision(payload('Write', { file_path: 'brain/memory/feedback/_drafts/rule.md' }, opts.vault), opts), null);
  assert.equal(G.decision(payload('Write', { file_path: path.join(opts.skill, 'my-skill', 'SKILL.md') }, opts.vault), opts), 'deny');
});

test('interactive Claude asks through native permission flow; Codex leaves its normal flow in charge', () => {
  const opts = { ...setup(), host: 'claude', env: {} };
  const edit = payload('Edit', { file_path: 'persona/teams/dev/TEAM.md' }, opts.vault);
  assert.equal(G.decision(edit, opts), 'ask');
  assert.equal(G.decision(edit, { ...opts, host: 'codex' }), null);
});

test('patch and shell paths detect explicit writes, not reads', () => {
  const opts = { ...setup(), host: 'claude', env: { AOS_HEADLESS: '1' } };
  const patch = '*** Begin Patch\n*** Update File: persona/PLAYBOOK.md\n@@\n-old\n+new\n*** End Patch\n';
  assert.equal(G.decision(payload('apply_patch', { command: patch }, opts.vault), opts), 'deny');
  assert.equal(G.decision(payload('Bash', { command: 'echo new > persona/pepper/IDENTITY.md' }, opts.vault), opts), 'deny');
  assert.equal(G.decision(payload('Bash', { command: 'cat persona/pepper/IDENTITY.md' }, opts.vault), opts), null);
  assert.equal(G.decision(payload('Bash', { command: 'echo new > persona/pepper/STATE.md' }, opts.vault), opts), null);
});

test('MCP write path is checked; read tools stay silent', () => {
  const opts = { ...setup(), host: 'codex', env: { AOS_HEADLESS: '1' } };
  assert.equal(G.decision(payload('mcp__fs__write_file', { path: 'persona/pepper/skills/triage.md' }, opts.vault), opts), 'deny');
  assert.equal(G.decision(payload('mcp__fs__read_file', { path: 'persona/pepper/skills/triage.md' }, opts.vault), opts), null);
});
