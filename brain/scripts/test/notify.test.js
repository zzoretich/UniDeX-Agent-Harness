'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require('../lib/notifications.js');
const { main } = require('../notify.js');

// The shared on-disk contract (spec D7): hud/src/data/notifications.test.ts parses the same files.
const FIXTURES = path.join(__dirname, '..', '..', '..', 'hud', 'src', 'data', 'fixtures', 'notifications-vault');
const NOW = new Date('2026-09-24T11:00:00Z');
const MIN = 60e3;

function tmpVault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  return v;
}
function fixtureCopy() {
  const v = tmpVault();
  fs.cpSync(path.join(FIXTURES, 'brain'), path.join(v, 'brain'), { recursive: true });
  return v;
}
function run(argv, opts = {}) {
  const out = [];
  const err = [];
  const code = main(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), now: NOW, cfg: {}, notify: () => true, ...opts });
  return { code, out: out.join(''), err: err.join('') };
}
const ok = { from: 'news-anchor', level: 'edition', title: 'The Morning Edition' };

test('post writes one immutable item with JSON-valued frontmatter that parse() reads back', () => {
  const vault = tmpVault();
  const r = N.post({ ...ok, tags: ['news'], body: '## AI and Tech\n\nA story.\n', actions: [{ kind: 'ask', label: 'Deep dive', skill: 'deep-dive', arg: 'x' }] }, { vault, now: NOW });
  assert.equal(r.id, N.idFor(NOW, 'news-anchor', 'The Morning Edition'));
  assert.match(r.id, /-news-anchor-the-morning-edition$/);
  assert.equal(path.relative(vault, r.file).split(path.sep).join('/'), `brain/notifications/${NOW.getFullYear()}/${r.id}.md`);
  const text = fs.readFileSync(r.file, 'utf8');
  assert.match(text, /^---\nschema: 1\nid: "/);
  assert.match(text, /\ntitle: "The Morning Edition"\n/);
  const it = N.parse(text);
  assert.equal(it.meta.level, 'edition');
  assert.deepEqual(it.meta.tags, ['news']);
  assert.deepEqual(it.meta.actions, [{ kind: 'ask', label: 'Deep dive', skill: 'deep-dive', arg: 'x' }]);
  assert.equal(it.meta.created, N.localIso(NOW));
  assert.equal(Date.parse(it.meta.created), NOW.getTime(), 'created carries its offset');
  assert.equal(it.body, '## AI and Tech\n\nA story.\n');
  assert.deepEqual(fs.readdirSync(path.dirname(r.file)), [`${r.id}.md`], 'no tmp file left behind');
});

test('a colliding id gets -2, -3 instead of overwriting', () => {
  const vault = tmpVault();
  const a = N.post(ok, { vault, now: NOW });
  const b = N.post(ok, { vault, now: NOW });
  const c = N.post(ok, { vault, now: NOW });
  assert.deepEqual([b.id, c.id], [`${a.id}-2`, `${a.id}-3`]);
});

test('validation refuses bad senders, levels, titles, and anything but allow-listed actions', () => {
  const vault = tmpVault();
  const bad = (p, re) => assert.throws(() => N.post({ ...ok, ...p }, { vault, now: NOW }), re);
  bad({ from: 'Bad Sender' }, /from must be/);
  bad({ level: 'urgent' }, /level must be one of/);
  bad({ title: '' }, /title must be/);
  bad({ title: 'two\nlines' }, /title must be/);
  bad({ actions: [{ kind: 'run', label: 'x', command: 'rm -rf ~' }] }, /kind must be ask or react/);
  bad({ actions: [{ kind: 'ask', label: 'x', skill: 'deep-dive', command: 'echo hi' }] }, /unknown key "command"/);
  bad({ actions: [{ kind: 'ask', label: 'x', skill: 'deep dive; rm' }] }, /skill must match/);
  bad({ actions: [{ kind: 'ask', label: 'x', skill: 'ok', arg: 'a\nb' }] }, /arg must be one line/);
  bad({ actions: [{ kind: 'react', label: 'x', value: 2, ref: 'r' }] }, /value must be 1 or -1/);
  bad({ actions: { kind: 'ask' } }, /actions must be a JSON array/);
  assert.ok(!fs.existsSync(N.dirOf(vault)), 'nothing written on a validation error');
});

test('only breaking and alert raise the OS notifier, and only while osAlert is on', () => {
  const vault = tmpVault();
  const calls = [];
  const notify = (t, m) => { calls.push([t, m]); return true; };
  let t = NOW.getTime();
  const at = () => new Date((t += MIN));
  N.post({ ...ok, level: 'edition' }, { vault, now: at(), notify });
  N.post({ ...ok, level: 'info' }, { vault, now: at(), notify });
  const b = N.post({ ...ok, level: 'breaking', title: 'Markets drop', body: '## Lede\n\nThe index fell 4%.' }, { vault, now: at(), notify });
  N.post({ ...ok, level: 'alert', title: 'Heads up' }, { vault, now: at(), notify });
  const off = N.post({ ...ok, level: 'breaking', title: 'Muted' }, { vault, now: at(), notify, cfg: { notifications: { osAlert: false } } });
  assert.deepEqual(calls, [['BREAKING · Markets drop', 'Lede'], ['Heads up', 'news-anchor']]);
  assert.equal(b.alerted, true);
  assert.equal(off.alerted, false);
});

test('over maxPerSenderPerHour a post is written as info, keeps its requested level, and raises no alert', () => {
  const vault = tmpVault();
  const calls = [];
  const cfg = { notifications: { maxPerSenderPerHour: 2 } };
  let t = NOW.getTime();
  const at = () => new Date((t += MIN));
  N.post({ ...ok, level: 'breaking', title: 'one' }, { vault, now: at(), cfg, notify: () => calls.push(1) });
  N.post({ ...ok, level: 'breaking', title: 'two' }, { vault, now: at(), cfg, notify: () => calls.push(1) });
  const third = N.post({ ...ok, level: 'breaking', title: 'three' }, { vault, now: at(), cfg, notify: () => calls.push(1) });
  assert.equal(third.downgraded, true);
  assert.equal(third.level, 'info');
  assert.equal(N.parse(fs.readFileSync(third.file, 'utf8')).meta.requestedLevel, 'breaking');
  assert.equal(calls.length, 2);
  const other = N.post({ ...ok, from: 'monitor', level: 'alert', title: 'other sender' }, { vault, now: at(), cfg, notify: () => calls.push(1) });
  assert.equal(other.downgraded, false, 'the limit is per sender');
  const later = N.post({ ...ok, level: 'breaking', title: 'next hour' }, { vault, now: new Date(t + 61 * MIN), cfg, notify: () => true });
  assert.equal(later.downgraded, false, 'the window is one hour');
});

test('list reads the shared fixtures: newest first, state merged, archived hidden, malformed counted', () => {
  const { items, unreadable } = N.list(FIXTURES);
  assert.deepEqual(items.map((i) => i.id), ['2026-09-24T0930-news-anchor-breaking-markets-drop-4', '2026-09-24T0700-news-anchor-the-morning-edition']);
  assert.equal(unreadable, 1);
  assert.deepEqual(items.map((i) => [i.level, i.read]), [['breaking', false], ['edition', true]]);
  assert.equal(items[1].path, 'brain/notifications/2026/2026-09-24T0700-news-anchor-the-morning-edition.md');
  assert.deepEqual(N.list(FIXTURES, { unread: true }).items.map((i) => i.level), ['breaking']);
  assert.deepEqual(N.list(FIXTURES, { archived: 'only' }).items.map((i) => i.from), ['monitor']);
  assert.equal(N.list(FIXTURES, { archived: true }).items.length, 3);
  assert.deepEqual(N.list(FIXTURES, { level: 'edition' }).items.length, 1);
  assert.deepEqual(N.list(FIXTURES, { from: 'monitor', archived: true }).items.map((i) => i.title), ['Weekly health']);
});

test('same-minute posts list by created time, not by title slug', () => {
  const vault = tmpVault();
  N.post({ ...ok, title: 'Zebra edition' }, { vault, now: new Date(NOW.getTime() + 1000) });
  N.post({ ...ok, level: 'breaking', title: 'Alpha bulletin' }, { vault, now: new Date(NOW.getTime() + 20000) });
  assert.deepEqual(N.list(vault).items.map((i) => i.title), ['Alpha bulletin', 'Zebra edition']);
});

test('mark sets and clears read/archived in state.json only; the item files never change', () => {
  const vault = fixtureCopy();
  const breaking = '2026-09-24T0930-news-anchor-breaking-markets-drop-4';
  const file = path.join(N.dirOf(vault), '2026', `${breaking}.md`);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(N.mark(vault, { ids: [breaking] }), 1);
  assert.equal(N.mark(vault, { ids: [breaking] }), 0, 'idempotent');
  assert.equal(N.list(vault, { unread: true }).items.length, 0);
  assert.equal(N.mark(vault, { ids: [breaking], key: 'read', value: false }), 1);
  assert.equal(N.mark(vault, { ids: [breaking], key: 'archived', value: true }), 1);
  assert.equal(N.list(vault).items.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => N.mark(vault, { ids: ['2026-01-01T0000-nope-x'] }), /no such notification/);
  assert.equal(N.mark(vault, { all: true }), 1, 'all = every readable item: only the breaking one was unread; the malformed file is skipped');
  assert.equal(N.readState(vault).schema, 1);
});

test('prune archives old items without deleting and drops state for vanished ids', () => {
  const vault = fixtureCopy();
  const st = N.readState(vault);
  st.items['2025-01-01T0000-gone-x'] = { read: true };
  fs.writeFileSync(N.statePath(vault), JSON.stringify(st));
  const r = N.prune(vault, { days: 2, now: new Date('2026-09-24T12:00:00-04:00') });
  assert.deepEqual(r, { archived: 0, dropped: 1 }, 'the weekly-health item is already archived');
  const r2 = N.prune(vault, { days: 0.1, now: new Date('2026-09-24T12:00:00-04:00') });
  assert.equal(r2.archived, 2);
  assert.equal(N.itemFiles(vault).length, 4, 'nothing deleted');
});

test('CLI post: flags, stdin body, actions file, dry-run and JSON output', () => {
  const vault = tmpVault();
  const actions = path.join(vault, 'actions.json');
  fs.writeFileSync(actions, JSON.stringify([{ kind: 'react', label: 'More like this', value: 1, ref: 's1' }]));
  const dry = run(['post', '--from', 'news-anchor', '--level', 'edition', '--title', 'Dry', '--dry-run', '--root', vault]);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /^---\nschema: 1\n/);
  assert.ok(!fs.existsSync(N.dirOf(vault)), 'dry-run writes nothing');
  const r = run(['post', '--from', 'news-anchor', '--level', 'edition', '--title', 'Real', '--tag', 'news', '--tag', 'ai', '--body-file', '-', '--actions-json', actions, '--json', '--root', vault],
    { readStdin: () => 'From stdin.\n' });
  assert.equal(r.code, 0, r.err);
  const res = JSON.parse(r.out);
  assert.equal(res.level, 'edition');
  const it = N.parse(fs.readFileSync(path.join(N.dirOf(vault), String(NOW.getFullYear()), `${res.id}.md`), 'utf8'));
  assert.deepEqual(it.meta.tags, ['news', 'ai']);
  assert.equal(it.meta.actions[0].ref, 's1');
  assert.equal(it.body, 'From stdin.\n');
});

test('CLI errors exit 2 with a message; list, read, archive and prune round-trip', () => {
  const vault = fixtureCopy();
  assert.equal(run(['post', '--from', 'x', '--level', 'loud', '--title', 't', '--root', vault]).code, 2);
  assert.equal(run(['post', '--title', '--root', vault]).code, 2, 'a flag with no value');
  assert.equal(run(['bogus', '--root', vault]).code, 2);
  assert.equal(run(['read', '--root', vault]).code, 2, 'read needs ids or --all');
  assert.match(run(['read', '2026-01-01T0000-nope-x', '--root', vault]).err, /no such notification/);
  const listed = JSON.parse(run(['list', '--unread', '--json', '--root', vault]).out);
  assert.deepEqual(listed.items.map((i) => i.level), ['breaking']);
  assert.equal(listed.unreadable, 1);
  assert.match(run(['list', '--root', vault]).out, /● breaking/);
  assert.match(run(['read', '--all', '--root', vault]).out, /^1 notification\(s\) marked read/);
  assert.match(run(['list', '--unread', '--root', vault]).out, /No unread notifications/);
  assert.match(run(['archive', '2026-09-24T0700-news-anchor-the-morning-edition', '--root', vault]).out, /1 notification\(s\) archived/);
  assert.match(run(['unarchive', '2026-09-24T0700-news-anchor-the-morning-edition', '--root', vault]).out, /1 notification\(s\) unarchived/);
  assert.match(run(['list', '--archived', '--root', vault]).out, /Weekly health/);
  assert.match(run(['prune', '--days', '1', '--root', vault]).out, /^\d+ archived/);
  assert.equal(run(['prune', '--days', '-1', '--root', vault]).code, 2);
});

test('under AOS_HEADLESS=1 --root must be the vault', () => {
  const vault = tmpVault();
  const elsewhere = tmpVault();
  const prev = process.env.AOS_HEADLESS;
  process.env.AOS_HEADLESS = '1';
  try {
    const r = run(['list', '--root', elsewhere]);
    assert.equal(r.code, 2);
    assert.match(r.err, /is not the vault/);
  } finally {
    if (prev === undefined) delete process.env.AOS_HEADLESS; else process.env.AOS_HEADLESS = prev;
  }
  assert.ok(vault);
});

test('settings falls back to defaults for missing or bad values', () => {
  assert.deepEqual(N.settings({}), N.DEFAULTS);
  assert.deepEqual(N.settings({ notifications: { osAlert: 'yes', retentionDays: -1, maxPerSenderPerHour: 1.5 } }), N.DEFAULTS);
  assert.deepEqual(N.settings({ notifications: { osAlert: false, retentionDays: 7, maxPerSenderPerHour: 0 } }), { osAlert: false, retentionDays: 7, maxPerSenderPerHour: 0 });
});
