'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanArsenal } = require('../persona/scan-arsenal.js');
const { buildPlaybook } = require('../persona/build-playbook.js');

function fixtureConfigDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  w('skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: Does demo things\n---\n# Demo\n');
  w('skills/bare-skill/SKILL.md', '# Bare Skill Title\nbody\n');
  w('agents/demo-agent.md', '---\nname: demo-agent\ndescription: Reviews demo output\n---\nbody\n');
  w('agents/INDEX.md', '# not an agent\n');
  w('commands/ship.md', '---\ndescription: Pre-commit checks\n---\nbody\n');
  return root;
}

test('scanArsenal inventories skills, agents and commands with frontmatter fallbacks', () => {
  const out = scanArsenal(fixtureConfigDir());
  const byName = Object.fromEntries(out.map(e => [e.name, e]));
  assert.equal(byName['demo-skill'].type, 'skill');
  assert.equal(byName['demo-skill'].description, 'Does demo things');
  assert.equal(byName['bare-skill'].description, 'Bare Skill Title');
  assert.equal(byName['demo-agent'].type, 'agent');
  assert.equal(byName['ship'].type, 'command');
  assert.ok(!byName['INDEX'], 'INDEX.md is not an agent');
  assert.deepEqual(out.map(e => e.type), ['agent', 'command', 'skill', 'skill'], 'sorted by type then name');
});

test('scanArsenal returns [] for a config dir with none of the three folders', () => {
  assert.deepEqual(scanArsenal(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-empty-'))), []);
});

test('scanArsenal lists each skill once: the mirrors of the other host\'s skills are skipped on both sides', () => {
  const root = fixtureConfigDir();
  const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-agents-'));
  const w = (dir, rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
  w(root, 'skills/from-codex/SKILL.md', '---\nname: from-codex\ndescription: mirror\n---\n');
  w(root, 'skills/from-codex/.aos-mirror.json', '{"schema":1}');
  w(agents, 'triage/SKILL.md', '---\nname: triage\ndescription: Codex own\n---\n');
  w(agents, 'demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: mirror\n---\n');
  w(agents, 'demo-skill/.aos-mirror.json', '{"schema":1}');
  const out = scanArsenal(root, { codex: { skillsDir: agents, promptsDir: null } });
  const skills = out.filter((e) => e.type === 'skill').map((e) => `${e.name}${e.host ? `@${e.host}` : ''}`).sort();
  assert.deepEqual(skills, ['bare-skill', 'demo-skill', 'triage@codex']);
});

test('scanArsenal lists each agent once: mirrors skipped on both sides, Codex user agents listed under codex', () => {
  const root = fixtureConfigDir();
  const codexAgents = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-codex-agents-'));
  const w = (dir, rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
  w(root, 'agents/pr-explorer.md', '---\nname: pr-explorer\ndescription: mirror\n# aos-mirror: {"schema":1,"id":"pr-explorer"}\n---\nbody\n');
  w(codexAgents, 'pr_explorer.toml', 'name = "pr_explorer"\ndescription = "Maps code paths"\ndeveloper_instructions = "Explore."\n');
  w(codexAgents, 'demo-agent.toml', '# aos-mirror: {"schema":1,"id":"demo-agent"}\nname = "demo-agent"\ndescription = "mirror"\ndeveloper_instructions = "x"\n');
  w(codexAgents, 'broken.toml', 'name = "broken\n');
  w(codexAgents, 'notes.md', 'not an agent');
  const out = scanArsenal(root, { codex: { skillsDir: null, promptsDir: null, agentsDir: codexAgents } });
  const agents = out.filter((e) => e.type === 'agent').map((e) => `${e.name}${e.host ? `@${e.host}` : ''}`).sort();
  assert.deepEqual(agents, ['demo-agent', 'pr_explorer@codex']);
  assert.equal(out.find((e) => e.name === 'pr_explorer').description, 'Maps code paths');
});

test('buildPlaybook writes <vault>/persona/PLAYBOOK.md with the agent name and generated sections', () => {
  const configDir = fixtureConfigDir();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vault-'));
  const md = buildPlaybook({ configDir, vault, name: 'Atlas', now: new Date('2026-09-04T00:00:00Z') });
  const file = path.join(vault, 'persona', 'PLAYBOOK.md');
  assert.equal(fs.readFileSync(file, 'utf8'), md);
  assert.match(md, /^type: persona-playbook$/m);
  assert.match(md, /^updated: 2026-09-04$/m);
  assert.match(md, /^# Atlas PLAYBOOK — the front door$/m);
  assert.match(md, /\| Interactive software development \| If installed in this host, use Superpowers skills/);
  for (const h of ['## Core Routes', '## Skills (generated)', '## Agents (generated)', '## Commands (generated)']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('| demo-skill | Does demo things | |'));
  assert.ok(!md.includes('{{'), 'no unrendered placeholder');
});

test('buildPlaybook refuses to overwrite without force', () => {
  const configDir = fixtureConfigDir();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vault-'));
  buildPlaybook({ configDir, vault, name: 'Atlas' });
  assert.throws(() => buildPlaybook({ configDir, vault, name: 'Atlas' }), /--force/);
  assert.doesNotThrow(() => buildPlaybook({ configDir, vault, name: 'Atlas', force: true }));
});

test('scanArsenal lists Codex skills and prompts (host codex) and leaves out skills aos generated for Codex', () => {
  const { scanArsenal } = require('../persona/scan-arsenal.js');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arsenal-claude-'));
  const cx = fs.mkdtempSync(path.join(os.tmpdir(), 'arsenal-codex-'));
  const skillsDir = path.join(cx, 'skills'); const promptsDir = path.join(cx, 'prompts');
  fs.mkdirSync(path.join(skillsDir, 'mine'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'mine', 'SKILL.md'), '---\nname: mine\ndescription: a Codex skill I wrote\n---\n');
  fs.mkdirSync(path.join(skillsDir, 'wrap'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'wrap', 'SKILL.md'), '---\nname: wrap\ndescription: d\n---\n<!-- generated by `aos init --host codex` from the AgenticOS Workbench plugin; edits are lost on `aos upgrade` -->\n');
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(path.join(promptsDir, 'review.md'), '# Review the diff\n');
  const all = scanArsenal(root, { codex: { skillsDir, promptsDir } });
  assert.deepEqual(all.map((e) => [e.type, e.name, e.host]), [['command', 'review', 'codex'], ['skill', 'mine', 'codex']]);
  assert.deepEqual(scanArsenal(root, { codex: null }), [], 'no Codex host: the Claude config dir only');
});
