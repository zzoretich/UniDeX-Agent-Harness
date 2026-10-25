'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../persona/reflect.js');

// Mid-day UTC: "drained today" is the LOCAL day (the runner names the journal that way), so NOW ± 2 h must stay on one
// local day in every timezone CI or a developer runs in (an evening fixture crossed midnight on the UTC runners).
const NOW = new Date('2026-09-22T12:00:00.000Z');
const at = (ms) => new Date(NOW.getTime() + ms);
const HOUR = 3600e3, DAY = 86400e3;
const line = (type, source, ts = '2026-09-22T10:00:00.000Z', note = null) => ({ schema: 1, ts, type, source, note, by: 'tick' });

/** A vault with a queue and every reflect input present. */
function vault({ queue = [] } = {}) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-vault-'));
  const put = (rel, text = '') => { const f = path.join(v, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  put('persona/queue.jsonl', queue.map(q => (typeof q === 'string' ? q : JSON.stringify(q))).join('\n') + (queue.length ? '\n' : ''));
  put('brain/memory/feedback/always-gate.md', '# Always run the gate\n');
  put('brain/memory/feedback/old-rule.md', '# Old rule\n');
  put('brain/memory/feedback/_drafts/draft-one.md', '# Prefer the namespaced command\n');
  for (const d of ['monitor', 'reflect', 'reflect-daily', 'sitrep', 'tick']) put(`persona/duties/${d}.md`, `# Duty: ${d}\n`);
  put('brain/_index/routines.json', JSON.stringify({ schema: 1, routines: {
    monitor: { lastRunAt: '2026-09-22T17:00:05.000Z', lastExit: 0, failStreak: 0, lastTrigger: 'scheduled', lastError: null },
    reflect: { lastRunAt: '2026-09-22T05:01:29.000Z', lastExit: 1, failStreak: 2, lastTrigger: 'manual', lastError: 'exit 1' },
    heartbeat: { lastRunAt: '2026-09-22T21:00:05.000Z', lastExit: 0, failStreak: 0 },
  } }));
  put('brain/_index/provider-spend.jsonl', [
    JSON.stringify({ ts: at(-HOUR).toISOString(), feature: 'duty:tick', usd: 0.05 }),
    JSON.stringify({ ts: at(-2 * HOUR).toISOString(), feature: 'duty:tick', usd: 0.07 }),
    JSON.stringify({ ts: at(-5 * HOUR).toISOString(), feature: 'duty:monitor', usd: 0.15 }),
    JSON.stringify({ ts: at(-10 * DAY).toISOString(), feature: 'duty:monitor', usd: 9 }),      // outside the 7-day window
    JSON.stringify({ ts: at(-HOUR).toISOString(), feature: 'session-summary', usd: 50 }),       // hook spend: ignored
    'not json',
    '',
  ].join('\n'));
  put('persona/ledger.jsonl', JSON.stringify({ schema: 1, ts: at(-DAY).toISOString(), event: 'filed', slug: 'trim-state', kind: 'self' }) + '\n');
  put('brain/_index/agent-runs/2026-09-22/sess-a.json', JSON.stringify({ id: 'a', summary: { status: 'ok', cost_usd: 0.2 }, events: [] }));
  put('brain/_index/agent-runs/2026-09-22/sess-b.json', JSON.stringify({ id: 'b', summary: { status: 'error', end_reason: 'abandoned', cost_usd: null }, events: [] }));
  put('brain/_index/agent-runs/2026-09-21/sess-c.json', JSON.stringify({ id: 'c', script: 'session', status: 'ok', cost_usd: 0.1 }));   // flat shape
  put('brain/_index/agent-runs/2026-09-01/sess-d.json', JSON.stringify({ id: 'd', summary: { status: 'ok' } }));                        // outside the window
  put('brain/_index/agent-runs/runs.jsonl', '{}\n');
  const old = at(-3 * HOUR);
  const stamp = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) stamp(f); fs.utimesSync(f, old, old); } fs.utimesSync(dir, old, old); };
  stamp(v);
  fs.utimesSync(path.join(v, 'brain', 'memory', 'feedback', 'old-rule.md'), at(-20 * DAY), at(-20 * DAY));
  return v;
}
function deps(v) { return { vault: v, now: () => NOW }; }
const state = (v) => JSON.parse(fs.readFileSync(path.join(v, 'brain', '_index', 'persona-reflect.json'), 'utf8'));
const queue = (v) => { try { return fs.readFileSync(path.join(v, 'persona', 'queue.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

test('precheck: runs on a queued signal, runs on an empty queue with no drain today, skips after a same-day drain', () => {
  const v = vault({ queue: [line('correction', 'brain/memory/feedback/always-gate.md')] });
  const d = deps(v);
  const p1 = R.precheck({ deps: d });
  assert.equal(p1.run, true);
  assert.equal(p1.pending, 1);
  assert.match(p1.reason, /1 signal\(s\) queued/);
  assert.equal(state(v).pending.count, 1);
  R.beat({ deps: d, now: at(60e3) });
  const p2 = R.precheck({ deps: d, now: at(2 * HOUR) });
  assert.equal(p2.run, false);
  assert.equal(p2.reason, 'queue empty and already drained today');
  assert.equal(state(v).skipped, 1);
  assert.equal(state(v).pending, null);
  // The CLI path builds its own deps, so it reads the real clock — asserting its skip exit against the
  // fixture's drain would only hold on the fixture's calendar day. Drain a second vault at the real now.
  const live = vault({ queue: [line('correction', 'brain/memory/feedback/always-gate.md')] });
  const liveDeps = { vault: live, now: () => new Date() };
  R.precheck({ deps: liveDeps });
  R.beat({ deps: liveDeps });
  assert.equal(R.main(['precheck', '--root', live]), R.EXIT_SKIP, 'the CLI exit the runner keys on');
  // a new day with nothing queued still runs (the nightly pass reviews health and spend too)
  const p3 = R.precheck({ deps: d, now: at(DAY + 2 * HOUR) });
  assert.equal(p3.run, true);
  assert.equal(p3.reason, 'nothing drained today');
  // fresh vault, empty queue, never drained → runs
  assert.equal(R.precheck({ deps: deps(vault()) }).run, true);
});

test('beat: drains exactly the snapshot, keeps what arrived during the run, drops unreadable lines, records the drain', () => {
  const a = line('correction', 'brain/memory/feedback/always-gate.md');
  const b = line('duty-failure', 'brain/_index/persona-heartbeat.json#reflect', '2026-09-22T11:00:00.000Z');
  const v = vault({ queue: [a, b, '{ not json', '{"type":"missing-source"}'] });
  const d = deps(v);
  R.precheck({ deps: d });
  // during the model run the tick queues one more, and re-queues a (same type+source, new ts) — both must survive
  const late = line('repo-stall', 'app:.planning/STATE.md', at(60e3).toISOString());
  const again = line('correction', 'brain/memory/feedback/always-gate.md', at(90e3).toISOString());
  fs.appendFileSync(path.join(v, 'persona', 'queue.jsonl'), JSON.stringify(late) + '\n' + JSON.stringify(again) + '\n');
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(String(m));
  let r;
  try { r = R.beat({ deps: d, now: at(2 * 60e3) }); } finally { console.error = orig; }
  assert.deepEqual(r, { drained: 2, kept: 2, byType: { correction: 1, 'duty-failure': 1 }, lastDrainAt: at(2 * 60e3).toISOString() });
  assert.deepEqual(queue(v), [late, again]);
  assert.ok(errs.some(m => /dropped 2 unreadable line/.test(m)));
  const s = state(v);
  assert.equal(s.drains, 1);
  assert.equal(s.pending, null);
  assert.deepEqual(s.lastDrain, { count: 2, byType: { correction: 1, 'duty-failure': 1 } });
  // a beat without a snapshot (state reset) drains everything queued now and leaves an empty file behind
  fs.unlinkSync(path.join(v, 'brain', '_index', 'persona-reflect.json'));
  assert.deepEqual(R.beat({ deps: d, now: at(HOUR) }).byType, { 'repo-stall': 1, correction: 1 });
  assert.equal(fs.readFileSync(path.join(v, 'persona', 'queue.jsonl'), 'utf8'), '');
  assert.deepEqual(queue(v), []);
});

test('inputs: one pack — queue by type with titles, ledger summary, duty health, spend per duty, feedback in window, agent-runs per day', () => {
  const v = vault({ queue: [
    line('correction', 'brain/memory/feedback/always-gate.md', '2026-09-22T10:00:00.000Z', 'third time'),
    line('correction', 'brain/memory/feedback/_drafts/draft-one.md'),
    line('duty-failure', 'brain/_index/persona-heartbeat.json#reflect'),
    line('repo-stall', 'app:.planning/STATE.md'),
  ] });
  const p = R.inputs({ deps: deps(v), days: 7 });
  assert.equal(p.schema, 1);
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(p.today, `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`, 'today is the LOCAL day the runner journals under');
  assert.deepEqual(Object.keys(p).slice(0, 2), ['schema', 'today'], 'today leads the pack, ahead of the UTC stamps');
  assert.equal(p.days, 7);
  assert.equal(p.since, at(-7 * DAY).toISOString());
  assert.equal(p.lastDrainAt, null);
  assert.equal(p.queue.count, 4);
  assert.deepEqual(Object.keys(p.queue.byType).sort(), ['correction', 'duty-failure', 'repo-stall']);
  assert.deepEqual(p.queue.byType.correction.map(c => [c.title, c.note]), [['Always run the gate', 'third time'], ['Prefer the namespaced command', null]]);
  assert.equal(p.queue.byType['duty-failure'][0].title, null, 'a JSON pointer has no note title');
  assert.equal(p.queue.byType['repo-stall'][0].title, null, 'a repo pointer is not a vault note');
  assert.equal(p.ledger.days, 7);
  assert.deepEqual(p.ledger.open, ['trim-state']);
  assert.deepEqual(p.duties.map(x => x.slug), ['monitor', 'reflect', 'reflect-daily', 'sitrep', 'tick'], 'every duty prompt, not the heartbeat command');
  assert.deepEqual(p.duties[1], { slug: 'reflect', lastRunAt: '2026-09-22T05:01:29.000Z', lastExit: 1, failStreak: 2, lastTrigger: 'manual', lastError: 'exit 1' });
  assert.deepEqual(p.duties[2], { slug: 'reflect-daily', lastRunAt: null, lastExit: null, failStreak: 0, lastTrigger: null, lastError: null });
  assert.deepEqual(p.spend.perDuty.tick, { runs: 2, usd: 0.12, mean: 0.06, max: 0.07, lastAt: at(-HOUR).toISOString() });
  assert.deepEqual(p.spend.perDuty.monitor, { runs: 1, usd: 0.15, mean: 0.15, max: 0.15, lastAt: at(-5 * HOUR).toISOString() }, 'the 10-day-old row is outside the window');
  assert.equal(p.spend.perDuty['session-summary'], undefined, 'hook spend is not duty spend');
  assert.deepEqual(p.feedback.memories.map(m => m.title), ['Always run the gate'], 'the 20-day-old rule is outside the window');
  assert.deepEqual(p.feedback.drafts.map(m => m.file), ['brain/memory/feedback/_drafts/draft-one.md']);
  assert.deepEqual(p.agentRuns, [{ day: '2026-09-21', sessions: 1, notOk: 0, usd: 0.1 }, { day: '2026-09-22', sessions: 2, notOk: 1, usd: 0.2 }]);
  // 28 days widens the windows
  const m = R.inputs({ deps: deps(v), days: 28 });
  assert.equal(m.spend.perDuty.monitor.runs, 2);
  assert.equal(m.feedback.memories.length, 2);
  assert.equal(m.agentRuns.length, 3);
});

test('inputs tolerates every source missing; the CLI prints it as JSON', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-empty-'));
  const p = R.inputs({ deps: deps(v) });
  assert.deepEqual(p.queue, { count: 0, byType: {} });
  assert.equal(p.ledger.total, 0);
  assert.deepEqual(p.duties, []);
  assert.deepEqual(p.spend, { window: 'no ledger', perDuty: {} });
  assert.deepEqual(p.feedback, { memories: [], drafts: [] });
  assert.deepEqual(p.agentRuns, []);
  assert.equal(R.main(['inputs', '--days', '3', '--root', v]), 0);
  assert.equal(R.main(['status', '--root', v]), 0);
  assert.equal(R.main(['--root', v]), 2);
  assert.equal(R.main(['dance', '--root', v]), 2);
  assert.deepEqual(R.positionals(['--root', v, 'inputs', '--days', '3']), ['inputs']);
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(v, 'brain', '_index', 'persona-reflect.json'), '{ nope');
  assert.equal(R.readState(deps(v)).drains, 0, 'a corrupt state reads as fresh');
  assert.equal(R.main(['precheck', '--root', v]), 0, 'and a fresh state runs the duty');
  assert.equal(state(v).schema, 1);
});

test('localDay and identity', () => {
  assert.equal(R.localDay(new Date(2026, 8, 22, 23, 30)), '2026-09-22');
  assert.equal(R.identity(line('correction', 'x', 't')), 't\u0000correction\u0000x');
});

// Spec 2026-10-24-persona-learning-loop-design D1: the pack no longer carries the auto-apply ladder — no whitelist, no bar,
// no candidates, however many approvals of one class held.
test('inputs carries no autoapply section, even with verified approvals of one class and a whitelist file', () => {
  const v = vault();
  const L = require('../persona/ledger.js');
  const file = path.join(v, 'persona', 'ledger.jsonl');
  for (const slug of ['t-one', 't-two', 't-three']) {
    L.append({ event: 'approved', slug, class: 'doc-typo', recheck: 'exit 1' }, { file, now: at(-20 * DAY) });
    L.append({ event: 'verified', slug, class: 'doc-typo' }, { file, now: at(-10 * DAY) });
  }
  fs.writeFileSync(path.join(v, 'persona', 'autoapply.json'), JSON.stringify({ classes: ['doc-typo'] }));
  const pack = R.inputs({ deps: { vault: v, config: () => ({ persona: { autoapply: { minVerified: 2 } } }), now: () => NOW } });
  assert.equal('autoapply' in pack, false);
  assert.ok(pack.ledger, 'the ledger summary is still there');
});
