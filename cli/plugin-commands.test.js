'use strict';
// The suite's own environment even when a check runs this file on its own (parity-check: `node --test <file>`), so
// lib/test-guard.js lets it resolve what it needs: a no-op under `npm test`, which preloads it already.
require('../tools/test-env.js');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', 'plugin', 'commands');
const EXPECTED = ['remember', 'feedback', 'pattern', 'project', 'wrap', 'brain', 'scan', 'ask-brain', 'reflect-week',
  'consolidate-memory', 'compress', 'standup', 'cost', 'aos', 'routines', 'todo', 'propose', 'skills', 'agents', 'notifications', 'team'];

test('exactly the 19 contract commands exist', () => {
  assert.deepEqual(fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort(), [...EXPECTED].sort());
});

test('every command has frontmatter with description and allowed-tools, and no absolute or owner paths', () => {
  for (const name of EXPECTED) {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, `${name}: frontmatter`);
    assert.match(fm[1], /^description: .{10,}$/m, `${name}: description`);
    assert.match(fm[1], /^allowed-tools: /m, `${name}: allowed-tools`);
    assert.ok(!/\/home\/|~\/\.claude\/brain|\/usr\/local\/bin/.test(text), `${name}: hardcoded path`);
    assert.ok(!/qwen|ollama run|token-goblin/i.test(text), `${name}: model or owner tooling name`);
  }
});

test('/todo creates a missing TODO.md with exactly the vault seed', () => {
  const text = fs.readFileSync(path.join(DIR, 'todo.md'), 'utf8');
  const block = /```markdown\n([\s\S]*?)```/.exec(text);
  assert.ok(block, 'todo.md embeds the seed in a markdown fence');
  assert.equal(block[1], fs.readFileSync(path.resolve(__dirname, '..', 'vault-template', 'TODO.md'), 'utf8'));
});

test('script-driven commands name the launcher and its fallback', () => {
  for (const name of ['wrap', 'scan', 'ask-brain', 'reflect-week', 'consolidate-memory', 'compress', 'standup', 'cost', 'aos', 'project', 'routines']) {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    assert.match(text, /`aos [a-z-]+/, `${name}: aos call`);
    assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/aos/, `${name}: fallback`);
  }
  // The context-assembly commands pass $ARGUMENTS unquoted: Plan 2's parseMode matches `--local` only as a
  // whole argv token, so a quoted "$ARGUMENTS" would bury it inside the question.
  for (const name of ['ask-brain', 'reflect-week', 'consolidate-memory', 'compress', 'standup']) {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    assert.ok(!/"\$ARGUMENTS"/.test(text), `${name}: $ARGUMENTS must not be quoted`);
  }
});

test('/todo, /propose and /project link what they write to the workspace `aos workspace which --json` names (spaces-redesign D27)', () => {
  const link = { todo: /#ws\/<slug>/, propose: /^workspace: <name/m, project: /^workspace: <name>$/m };
  for (const [name, re] of Object.entries(link)) {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.match(fm[1], /^allowed-tools: .*\bBash\b/m, `${name}: runs the launcher`);
    // /todo needs one command: its Bash is scoped to it, so text in the arguments or a folder name never runs a shell
    // command unprompted (the launcher fallback asks first).
    if (name === 'todo') assert.match(fm[1], /^allowed-tools: Read, Edit, Write, Bash\(aos workspace which:\*\)$/m, 'todo: Bash scoped to the which call');
    assert.match(text, /`aos workspace which --json`/, `${name}: which call`);
    assert.match(text, /`sh "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/aos" workspace which --json`/, `${name}: fallback`);
    assert.match(text, /Only when `name` is set/, `${name}: links only when a workspace is named`);
    assert.match(text, /`\{"name": null\}`/, `${name}: the no-workspace answer`);
    assert.match(text, re, `${name}: the link it writes`);
    // Host-neutral: the same answer on both hosts, from the session's folder (no host variable, no host config path).
    assert.ok(!/CLAUDE_PROJECT_DIR|CLAUDE_CODE|~\/\.claude\//.test(text), `${name}: host-specific workspace lookup`);
  }
});

test('MCP tools use the plugin-prefixed names Claude Code exposes for a plugin-declared server', () => {
  // mcp__plugin_<plugin>_<server>__<tool> (contract §0); the bare mcp__agenticos__ form never matches allowed-tools.
  for (const name of ['wrap', 'ask-brain']) {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.match(fm[1], /^allowed-tools: .*mcp__plugin_agenticos_agenticos__/m, `${name}: prefixed MCP tool in allowed-tools`);
  }
  for (const name of EXPECTED) {
    assert.ok(!/mcp__agenticos__/.test(fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8')), `${name}: unprefixed MCP name`);
  }
});

test('the nine plugin skills exist with frontmatter and are free of owner paths', () => {   // execution amendment 2026-09-15 (A32)
  const SK = path.resolve(__dirname, '..', 'plugin', 'skills');
  // final review Minor 18 (tests-12): iterating the names never catches an extra skill directory shipping
  // by accident — pin the directory listing itself.
  assert.deepEqual(
    fs.readdirSync(SK, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(),
    ['cost', 'cross-review', 'feedback-review', 'graph', 'handoff', 'persona-flag-closer', 'persona-sitrep', 'recall', 'wrap'],
    'exactly nine plugin skills ship');
  for (const name of ['recall', 'wrap', 'feedback-review', 'cost', 'persona-flag-closer', 'persona-sitrep', 'graph', 'cross-review', 'handoff']) {
    const text = fs.readFileSync(path.join(SK, name, 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, `${name}: frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${name}$`, 'm'));
    assert.match(fm[1], /^description: .{40,}/m);
    assert.ok(!/\/opt\/|\/home\/|\/usr\/local\/bin|~\/\.claude\/brain/.test(text), `${name}: hardcoded path`);
    assert.ok(!/qwen|token-goblin/i.test(text), `${name}: model or owner tooling name`);
  }
  assert.match(fs.readFileSync(path.join(SK, 'wrap', 'SKILL.md'), 'utf8'), /wrap_session/);
  assert.match(fs.readFileSync(path.join(SK, 'feedback-review', 'SKILL.md'), 'utf8'), /feedback_rules/);
  assert.match(fs.readFileSync(path.join(SK, 'cost', 'SKILL.md'), 'utf8'), /cost\.enabled/);
  for (const tool of ['graph_overview', 'graph_query', 'graph_neighbors', 'graph_path']) {
    assert.match(fs.readFileSync(path.join(SK, 'graph', 'SKILL.md'), 'utf8'), new RegExp(`mcp__plugin_agenticos_agenticos__${tool}`));
  }
  // MCP tools are named as Claude Code exposes them for a plugin-declared server (contract §0).
  for (const name of ['recall', 'wrap', 'feedback-review']) {
    const text = fs.readFileSync(path.join(SK, name, 'SKILL.md'), 'utf8');
    assert.match(text, /mcp__plugin_agenticos_agenticos__/, `${name}: prefixed MCP tool name`);
    assert.ok(!/mcp__agenticos__/.test(text), `${name}: unprefixed MCP name`);
  }
});
