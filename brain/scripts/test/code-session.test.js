'use strict';
// code-session.js: the Codex SessionStart hook that names a Code terminal's session (spec 2026-11-10-codex-session-claim D1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'code-session.js');
const TERM = '3b1f6a52-8c4d-4e7a-9b20-5d6e7f8a9b0c';
const ID = 'aaaaaaaa-1111-4222-8333-444444444444';

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-code-session-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  return v;
}

const reportFile = (v) => path.join(v, 'brain', '_index', 'code', `${TERM}.session.json`);

function run(v, { payload = { session_id: ID, hook_event_name: 'SessionStart', source: 'startup', transcript_path: null }, env = {} } = {}) {
  const base = { ...process.env };
  delete base.AOS_TERMINAL;
  // The runner's NODE_OPTIONS preload (test/setup.js) would reach this child and delete AOS_HEADLESS: run the hook as Codex does.
  base.NODE_OPTIONS = '';
  return spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...base, AOS_VAULT: v, AOS_CONFIG: path.join(v, 'none.json'), AOS_HOST: 'codex', ...env },
  });
}

test('in a Code terminal it writes the session the agent started, and prints nothing', () => {
  const v = vault();
  const r = run(v, { env: { AOS_TERMINAL: TERM } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'a Codex SessionStart hook\'s stdout would become model context');
  const rep = JSON.parse(fs.readFileSync(reportFile(v), 'utf8'));
  assert.equal(rep.host, 'codex');
  assert.equal(rep.session_id, ID);
  assert.equal(rep.source, 'startup');
  assert.ok(!Number.isNaN(Date.parse(rep.at)));
  assert.deepEqual(Object.keys(rep).sort(), ['at', 'host', 'session_id', 'source'], 'no transcript_path is kept (D5)');
});

test('a later SessionStart (a /new, a resume) replaces the report', () => {
  const v = vault();
  run(v, { env: { AOS_TERMINAL: TERM } });
  const other = 'bbbbbbbb-1111-4222-8333-444444444444';
  run(v, { env: { AOS_TERMINAL: TERM }, payload: { session_id: other, hook_event_name: 'SessionStart', source: 'clear', transcript_path: '/x/rollout.jsonl' } });
  const rep = JSON.parse(fs.readFileSync(reportFile(v), 'utf8'));
  assert.equal(rep.session_id, other);
  assert.equal(rep.source, 'clear');
});

test('outside a Code terminal, or with a bad key, id or payload, it writes nothing and exits 0', () => {
  for (const c of [
    { env: {} },
    { env: { AOS_TERMINAL: 'not-a-uuid' } },
    { env: { AOS_TERMINAL: TERM }, payload: { session_id: '../escape', hook_event_name: 'SessionStart' } },
    { env: { AOS_TERMINAL: TERM }, payload: { hook_event_name: 'SessionStart' } },
    { env: { AOS_TERMINAL: TERM }, payload: 'not json' },
  ]) {
    const v = vault();
    const r = run(v, c);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(reportFile(v)), false, JSON.stringify(c));
  }
});

test('inside a headless AgenticOS worker it does nothing', () => {
  const v = vault();
  const r = run(v, { env: { AOS_TERMINAL: TERM, AOS_HEADLESS: '1' } });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(reportFile(v)), false);
});
