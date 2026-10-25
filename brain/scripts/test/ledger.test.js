'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../persona/ledger.js');

const DAY = 86400e3;
const NOW = new Date('2026-09-22T12:00:00Z');
function tmpFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  return { root, file: path.join(root, 'persona', 'ledger.jsonl') };
}
const daysAgo = (n) => new Date(NOW - n * DAY);

test('append writes one JSON line with schema 1 and defaults; read returns it', () => {
  const { file } = tmpFile();
  const r = L.append({ event: 'filed', slug: 'trim-state', by: 'reflect', target: 'STATE.md' }, { file, now: NOW });
  assert.equal(r.schema, 1);
  assert.equal(r.kind, 'self');
  assert.equal(r.ts, NOW.toISOString());
  assert.equal(r.recheck, undefined, 'empty optional fields are omitted');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(L.read({ file }), [r]);
});

test('append validates event, slug, kind and string fields', () => {
  const { file } = tmpFile();
  assert.throws(() => L.append({ event: 'shipped', slug: 'x-y' }, { file }), /event must be one of/);
  assert.throws(() => L.append({ event: 'filed', slug: 'Bad Slug' }, { file }), /slug must be kebab-case/);
  assert.throws(() => L.append({ event: 'filed', slug: 'ok-slug', kind: 'meta' }, { file }), /kind must be one of/);
  assert.throws(() => L.append({ event: 'filed', slug: 'ok-slug', note: 42 }, { file }), /note must be a string/);
  assert.ok(!fs.existsSync(file), 'nothing written on a validation error');
});

test('read skips corrupt lines and a missing file reads as empty', () => {
  const { file } = tmpFile();
  assert.deepEqual(L.read({ file }), []);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"event":"filed","slug":"a-b","ts":"2026-09-01T00:00:00Z"}\nnot json\n{"nope":1}\n\n{"event":"approved","slug":"a-b","ts":"2026-09-02T00:00:00Z"}\n');
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(m);
  try { assert.equal(L.read({ file }).length, 2); } finally { console.error = orig; }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /skipped 2 unreadable line/);
});

test('verify: regressed at once, verified after settling, settling and out-of-window approvals untouched', () => {
  const { root, file } = tmpFile();
  const put = (slug, event, at, extra = {}) => L.append({ event, slug, ...extra }, { file, now: at });
  put('old-clean', 'approved', daysAgo(8), { recheck: 'exit 1' });      // clean for 8d → verified
  put('young-clean', 'approved', daysAgo(3), { recheck: 'exit 1' });    // clean but settling → nothing
  put('young-bad', 'approved', daysAgo(3), { recheck: 'exit 0' });      // present again → regressed
  put('too-young', 'approved', daysAgo(0.5), { recheck: 'exit 0' });    // under minDays → skipped
  put('too-old', 'approved', daysAgo(20), { recheck: 'exit 0' });       // beyond maxDays → skipped
  put('no-recipe', 'approved', daysAgo(8));                             // nothing to run
  put('done', 'approved', daysAgo(9), { recheck: 'exit 0' });
  put('done', 'verified', daysAgo(1));                                  // already judged → not rechecked
  put('broken', 'approved', daysAgo(8), { recheck: 'exit 127' });       // recipe error → skipped, never judged
  const ran = [];
  const run = (cmd, cwd) => { ran.push([cmd, cwd]); return cmd === 'exit 0' ? 'present' : cmd === 'exit 1' ? 'gone' : 'error'; };
  const out = L.verify({ file, root, now: NOW, run });
  assert.deepEqual(out, { checked: 4, verified: ['old-clean'], regressed: ['young-bad'], skipped: 1 });
  assert.deepEqual(ran.map(([, cwd]) => cwd), [root, root, root, root]);
  const events = L.read({ file }).filter(r => r.event === 'verified' || r.event === 'regressed').map(r => `${r.slug}:${r.event}:${r.by}`);
  assert.deepEqual(events.sort(), ['done:verified:null', 'old-clean:verified:watchdog', 'young-bad:regressed:watchdog']);
  // A second pass judges nothing new: the settling approval and the broken recipe are rechecked, the judged ones are not.
  assert.deepEqual(L.verify({ file, root, now: NOW, run }), { checked: 2, verified: [], regressed: [], skipped: 1 });
});

test('runRecipe maps exit codes like the flag-closer', () => {
  assert.equal(L.runRecipe('exit 0', os.tmpdir()), 'present');
  assert.equal(L.runRecipe('exit 3', os.tmpdir()), 'gone');
  assert.equal(L.runRecipe('exit 127', os.tmpdir()), 'error');
});

test('summary counts the window, rates approvals, and lists open and unverified slugs', () => {
  const { file } = tmpFile();
  const put = (slug, event, at, extra = {}) => L.append({ event, slug, ...extra }, { file, now: at });
  put('a-one', 'filed', daysAgo(10), { kind: 'self' });
  put('a-one', 'approved', daysAgo(9), { kind: 'self', recheck: 'exit 1' });
  put('b-two', 'filed', daysAgo(5), { kind: 'product' });
  put('b-two', 'rejected', daysAgo(4), { kind: 'product' });
  put('c-three', 'filed', daysAgo(2), { kind: 'vault' });
  put('d-four', 'filed', daysAgo(40));                                   // outside the window, still open
  put('e-five', 'approved', daysAgo(3), { recheck: 'exit 1' });
  put('e-five', 'regressed', daysAgo(1));
  const s = L.summary({ file, days: 28, now: NOW });
  assert.equal(s.total, 7);
  assert.equal(s.counts.filed, 3);
  assert.equal(s.counts.approved, 2);
  assert.equal(s.counts.rejected, 1);
  assert.equal(s.approvalRate, 0.67);
  assert.deepEqual(s.byKind.product, { filed: 1, approved: 0, rejected: 1, accepted: 0, dismissed: 0 });
  assert.equal(s.acceptRate, null, 'no idea was accepted or dismissed yet');
  assert.deepEqual(s.dismissed, []);
  assert.deepEqual(s.regressed, ['e-five']);
  assert.deepEqual(s.open, ['c-three', 'd-four']);
  assert.deepEqual(s.unverified, ['a-one']);
  const text = L.formatSummary(s);
  assert.match(text, /approval rate 0\.67/);
  assert.match(text, /open: c-three, d-four/);
  assert.equal(L.summary({ file: path.join(os.tmpdir(), 'ledger-none.jsonl') }).approvalRate, null);
});

// Spec 2026-09-22-persona-reflect-daily-design D6: an idea (workflow or product) is accepted into the backlog or
// dismissed; both are terminal, counted per kind, and dismissed slugs are listed so the reflects do not re-file them.
test('accepted and dismissed: terminal idea verbs, counted per kind with an accept rate, dismissed slugs listed', () => {
  const { file } = tmpFile();
  const put = (slug, event, at, extra = {}) => L.append({ event, slug, ...extra }, { file, now: at });
  put('w-one', 'filed', daysAgo(6), { kind: 'workflow' });
  put('w-one', 'accepted', daysAgo(5), { kind: 'workflow', by: 'user' });
  put('p-two', 'filed', daysAgo(4), { kind: 'product', target: 'hud' });
  put('p-two', 'dismissed', daysAgo(3), { kind: 'product', by: 'user', note: 'not this quarter' });
  put('p-three', 'filed', daysAgo(2), { kind: 'product' });
  put('p-three', 'accepted', daysAgo(1), { kind: 'product' });
  put('s-four', 'filed', daysAgo(1), { kind: 'self' });
  assert.ok(L.EVENTS.includes('accepted') && L.EVENTS.includes('dismissed'));
  const s = L.summary({ file, days: 28, now: NOW });
  assert.equal(s.counts.accepted, 2);
  assert.equal(s.counts.dismissed, 1);
  assert.equal(s.acceptRate, 0.67);
  assert.equal(s.approvalRate, null, 'ideas never count toward the approval rate');
  assert.deepEqual(s.byKind.workflow, { filed: 1, approved: 0, rejected: 0, accepted: 1, dismissed: 0 });
  assert.deepEqual(s.byKind.product, { filed: 2, approved: 0, rejected: 0, accepted: 1, dismissed: 1 });
  assert.deepEqual(s.open, ['s-four'], 'accepted and dismissed proposals are no longer open');
  assert.deepEqual(s.dismissed, ['p-two']);
  const text = L.formatSummary(s);
  assert.match(text, /accepted 2 · dismissed 1 \(p-two\)/);
  assert.match(text, /accept rate 0\.67/);
  assert.match(text, /\(filed\/accepted\/dismissed\): workflow 1\/1\/0 · product 2\/1\/1/);
});

test('CLI: append and summary through main(); usage errors exit 2', () => {
  const { root, file } = tmpFile();
  let out = '', err = '';
  const io = { stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, now: NOW };
  assert.equal(L.main(['append', 'filed', 'cli-slug', '--kind', 'workflow', '--by', 'reflect', '--target', 'daily note', '--root', root], io), 0);
  assert.equal(JSON.parse(out).kind, 'workflow');
  assert.equal(L.read({ file })[0].target, 'daily note');
  out = '';
  assert.equal(L.main(['summary', '--json', '--file', file], io), 0);
  assert.equal(JSON.parse(out).counts.filed, 1);
  out = '';
  assert.equal(L.main(['verify', '--root', root], io), 0);
  assert.deepEqual(JSON.parse(out), { checked: 0, verified: [], regressed: [], skipped: 0 });
  assert.equal(L.main(['append', 'filed', '--root', root], io), 2);
  assert.match(err, /usage: ledger.js append/);
  assert.equal(L.main(['append', 'bogus', 'cli-slug', '--root', root], io), 2);
  assert.equal(L.main(['dance', '--root', root], io), 2);
});

// Spec 2026-09-22-persona-earned-autonomy-design D3/D7, kept for old ledgers after the ladder was retired (spec
// 2026-10-24-persona-learning-loop-design D1): an event may still carry a class, verify copies it onto the verdict, and an
// old auto-applied change is verified exactly like an approval.
test('class: validated and written when given, omitted otherwise, copied by verify onto the verdict; auto-applied is verified like an approval', () => {
  const { root, file } = tmpFile();
  assert.throws(() => L.append({ event: 'filed', slug: 'a-b', class: 'Doc Typo' }, { file }), /class must be kebab-case/);
  const r = L.append({ event: 'filed', slug: 'a-b', class: 'doc-typo' }, { file, now: NOW });
  assert.equal(r.class, 'doc-typo');
  assert.equal(L.append({ event: 'filed', slug: 'c-d' }, { file, now: NOW }).class, undefined);
  L.append({ event: 'approved', slug: 'a-b', class: 'doc-typo', recheck: 'exit 1' }, { file, now: daysAgo(8) });
  L.append({ event: 'auto-applied', slug: 'e-f', class: 'doc-typo', recheck: 'exit 0', by: 'flag-closer' }, { file, now: daysAgo(3) });
  const run = (cmd) => (cmd === 'exit 0' ? 'present' : 'gone');
  const out = L.verify({ file, root, now: NOW, run });
  assert.deepEqual(out, { checked: 2, verified: ['a-b'], regressed: ['e-f'], skipped: 0 });
  const verdicts = L.read({ file }).filter(x => x.event === 'verified' || x.event === 'regressed');
  assert.deepEqual(verdicts.map(x => [x.slug, x.event, x.class]), [['a-b', 'verified', 'doc-typo'], ['e-f', 'regressed', 'doc-typo']]);
  const io = { stdout: () => {}, stderr: () => {} };
  assert.equal(L.main(['append', 'approved', 'g-h', '--class', 'doc-typo', '--file', file], io), 0);
  assert.equal(L.read({ file }).pop().class, 'doc-typo');
});

// Spec 2026-10-24-persona-learning-loop-design D1: no class earns anything, so the summary keeps no per-class tally and
// the text names auto-applied only when an old ledger holds one.
test('summary keeps no per-class tally; formatSummary names auto-applied only when the ledger has one', () => {
  const { file } = tmpFile();
  const put = (slug, event, at, extra = {}) => L.append({ event, slug, ...extra }, { file, now: at });
  for (const slug of ['t-one', 't-two', 't-three']) {
    put(slug, 'approved', daysAgo(10), { class: 'doc-typo', recheck: 'exit 1' });
    put(slug, 'verified', daysAgo(2), { class: 'doc-typo' });
  }
  let s = L.summary({ file, days: 28, now: NOW });
  assert.equal('byClass' in s, false);
  assert.equal(L.autoapplyCandidates, undefined);
  assert.equal(L.classStats, undefined);
  let text = L.formatSummary(s);
  assert.doesNotMatch(text, /by class/);
  assert.doesNotMatch(text, /auto-applied/);
  put('old-auto', 'auto-applied', daysAgo(5), { class: 'doc-typo', recheck: 'exit 1', by: 'flag-closer' });
  s = L.summary({ file, days: 28, now: NOW });
  text = L.formatSummary(s);
  assert.match(text, /auto-applied 1/);
});

test('runRecipe never spawns a recipe outside the read-only grammar; run-recipe prints the verdict or the refusal', () => {
  const { root } = tmpFile();
  const marker = path.join(root, 'ran');
  assert.equal(L.runRecipe(`test -d . ; mkdir ${marker}`, root), 'error');
  assert.equal(L.runRecipe(`mkdir ${marker}`, root), 'error');
  assert.equal(fs.existsSync(marker), false, 'a refused recipe never reaches the shell');
  assert.equal(L.runRecipe('test -d .', root), 'present');
  const lines = [];
  const io = { stdout: (s) => lines.push(s.trim()), stderr: (s) => lines.push(`ERR ${s.trim()}`), now: NOW };
  assert.equal(L.main(['run-recipe', 'test -d persona', '--root', root], io), 0);
  assert.equal(L.main(['run-recipe', 'false', '--root', root], io), 0);
  assert.equal(L.main(['run-recipe', 'grep -q x a; rm -rf ~', '--root', root], io), 0);
  assert.equal(L.main(['run-recipe', '--root', root], io), 2);
  assert.deepEqual(lines.slice(0, 3), ['gone', 'gone', 'refused: a ;']);
  fs.mkdirSync(path.join(root, 'persona'), { recursive: true });
  lines.length = 0;
  L.main(['run-recipe', 'test -d persona', '--root', root], io);
  assert.deepEqual(lines, ['present']);
});

test('approved and auto-applied need an interactive session: refused under AOS_HEADLESS=1, other events still append', () => {
  const { root, file } = tmpFile();
  const prev = process.env.AOS_HEADLESS;
  process.env.AOS_HEADLESS = '1';
  try {
    for (const event of ['approved', 'auto-applied']) {
      assert.throws(() => L.append({ event, slug: 'forged', recheck: 'true', class: 'doc-typo' }, { file, now: NOW }), /needs an interactive session/);
    }
    // The CLI goes through the vault itself: a headless --root anywhere else is refused first (lib/pin-root.js).
    const err = [];
    assert.equal(L.main(['append', 'approved', 'forged', '--recheck', 'true', '--root', require('../lib/paths.js').VAULT], { stdout: () => {}, stderr: (s) => err.push(s), now: NOW }), 2);
    assert.match(err.join(''), /needs an interactive session/);
    err.length = 0;
    assert.equal(L.main(['append', 'filed', 'forged', '--root', root], { stdout: () => {}, stderr: (s) => err.push(s), now: NOW }), 2);
    assert.match(err.join(''), /is not the vault/);
    L.append({ event: 'filed', slug: 'honest', by: 'reflect' }, { file, now: NOW });
    L.append({ event: 'verified', slug: 'honest', by: 'watchdog' }, { file, now: NOW });
  } finally {
    if (prev === undefined) delete process.env.AOS_HEADLESS; else process.env.AOS_HEADLESS = prev;
  }
  assert.deepEqual(L.read({ file }).map((r) => r.event), ['filed', 'verified']);
  L.append({ event: 'approved', slug: 'honest', by: 'user', recheck: 'true' }, { file, now: NOW });
  assert.equal(L.read({ file }).length, 3, 'an interactive session still records approvals');
});
