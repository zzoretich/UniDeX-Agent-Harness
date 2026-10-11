'use strict';
// The usage log (brain-hub D8, D9): rows by path only, per host, off with telemetry; the injection hook and the MCP
// server write them; the scan folds old rows into a rollup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const usage = require('../lib/memory-usage.js');

function vault(prefix) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  return v;
}
const put = (v, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), text);
};
const memory = (type, h1) => `---\ntype: memory\ntags: [memory/${type}, status/active]\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n\n# ${h1}\n\nThe graph answers structure questions in one call.\n`;
const rows = (v) => usage.readLog(v);

test('logUsage writes one row per memory or pattern path, each once, with the host it was given', () => {
  const v = vault('mu-log-');
  const n = usage.logUsage({
    vault: v, how: 'recalled', host: 'codex', cfg: {},
    paths: ['brain/memory/feedback/a.md', 'brain/memory/feedback/a.md', 'brain/patterns/p.md', '2026/2026-10-October/2026-10-01.md',
      'brain/memory/feedback/_drafts/d.md', 'brain/memory/../../etc/x.md', './brain/memory/reference/r.md'],
  });
  assert.equal(n, 3);
  assert.deepEqual(rows(v).map((r) => [r.how, r.host, r.path]), [
    ['recalled', 'codex', 'brain/memory/feedback/a.md'],
    ['recalled', 'codex', 'brain/patterns/p.md'],
    ['recalled', 'codex', 'brain/memory/reference/r.md'],
  ]);
  assert.deepEqual(Object.keys(rows(v)[0]).sort(), ['host', 'how', 'path', 'ts'], 'paths and counts only: no query, no snippet');
});

test('telemetry off, an unknown kind or no vault writes nothing, and nothing throws', () => {
  const v = vault('mu-off-');
  assert.equal(usage.logUsage({ vault: v, how: 'read', paths: ['brain/memory/user/profile.md'], host: 'claude', cfg: { telemetry: { enabled: false } } }), 0);
  assert.equal(usage.logUsage({ vault: v, how: 'searched', paths: ['brain/memory/user/profile.md'], host: 'claude', cfg: {} }), 0);
  assert.equal(usage.logUsage({ how: 'read', paths: ['brain/memory/user/profile.md'] }), 0);
  assert.equal(fs.existsSync(usage.logFile(v)), false);
});

test('summarize counts per path and host, the 7- and 30-day windows, and when collecting started', () => {
  const v = vault('mu-sum-');
  const now = Date.parse('2026-10-11T12:00:00Z');
  const at = (days) => new Date(now - days * 864e5);
  usage.logUsage({ vault: v, how: 'injected', paths: ['brain/memory/feedback/a.md'], host: 'claude', cfg: {}, now: at(40) });
  usage.logUsage({ vault: v, how: 'recalled', paths: ['brain/memory/feedback/a.md'], host: 'codex', cfg: {}, now: at(10) });
  usage.logUsage({ vault: v, how: 'read', paths: ['brain/memory/feedback/a.md'], host: 'claude', cfg: {}, now: at(1) });
  const s = usage.summarize(v, { now });
  const a = s.paths['brain/memory/feedback/a.md'];
  assert.deepEqual({ ...a }, { injected: 1, recalled: 1, read: 1, claude: 2, codex: 1, last: at(1).toISOString(), d7: 1, d30: 2 });
  assert.equal(s.since, at(40).toISOString());
});

test('foldUsage moves rows older than usageDays into the rollup; summarize still counts them', () => {
  const v = vault('mu-fold-');
  const now = Date.parse('2026-10-11T12:00:00Z');
  usage.logUsage({ vault: v, how: 'injected', paths: ['brain/memory/feedback/a.md'], host: 'claude', cfg: {}, now: new Date(now - 100 * 864e5) });
  usage.logUsage({ vault: v, how: 'read', paths: ['brain/memory/feedback/a.md'], host: 'codex', cfg: {}, now: new Date(now - 2 * 864e5) });
  assert.deepEqual(usage.foldUsage(v, { days: 90, now }), { folded: 1, kept: 1 });
  assert.equal(rows(v).length, 1);
  const roll = JSON.parse(fs.readFileSync(usage.rollupFile(v), 'utf8'));
  assert.equal(roll.schema, 1);
  assert.equal(roll.paths['brain/memory/feedback/a.md'].injected, 1);
  const a = usage.summarize(v, { now }).paths['brain/memory/feedback/a.md'];
  assert.equal(a.injected, 1);
  assert.equal(a.read, 1);
  assert.equal(a.d30, 1, 'the folded row is outside the windows');
  assert.deepEqual(usage.foldUsage(v, { days: 90, now }), { folded: 0, kept: 1 }, 'nothing left to fold');
});

// ── the injection hook ──

const INJECT = path.join(__dirname, '..', 'inject-context.js');
const { markerPath } = require('../lib/markers.js');

function inject(v, sid, host, extraEnv = {}) {
  try { fs.unlinkSync(markerPath(`.injected-${sid}`)); } catch {}
  return spawnSync(process.execPath, [INJECT], {
    input: JSON.stringify({ session_id: sid }), encoding: 'utf8',
    env: { ...process.env, AOS_VAULT: v, AOS_CONFIG: path.join(v, 'none.json'), ...(host ? { AOS_HOST: host } : {}), ...extraEnv },
  });
}
function injectVault(prefix) {
  const v = vault(prefix);
  put(v, 'brain/_index/BRAIN.md', '# BRAIN\nhello brain\n');
  put(v, 'brain/_index/SESSION.md', '# SESSION\n');
  put(v, 'brain/_index/brain-sources.json', JSON.stringify({ schema: 1, sections: {
    who: { paths: ['brain/memory/user/profile.md'] }, rules: { paths: ['brain/memory/feedback/graphify-first.md'] },
    active: { paths: ['brain/memory/projects/brain-hub.md'], omitted: ['brain/memory/projects/old.md'] },
  } }));
  put(v, 'brain/_index/recall-wake.md', '## Recall (auto)\n- `brain/memory/reference/ci.md` (2d) — gitleaks\n- `2026/2026-10-October/2026-10-10.md` (1d) — a day\n');
  return v;
}

test('the first prompt logs the memories BRAIN.md was built from and the recall-wake ones, as this host; stdout unchanged', () => {
  for (const host of ['claude', 'codex']) {
    const v = injectVault(`mu-inj-${host}-`);
    const r = inject(v, `mu-${host}-${process.pid}`, host);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /<brain-context>/);
    assert.doesNotMatch(r.stdout, /memory-usage|"how"/, 'nothing about the log reaches the session');
    assert.deepEqual(rows(v).map((x) => [x.how, x.host, x.path]), [
      ['injected', host, 'brain/memory/user/profile.md'],
      ['injected', host, 'brain/memory/feedback/graphify-first.md'],
      ['injected', host, 'brain/memory/projects/brain-hub.md'],
      ['injected', host, 'brain/memory/reference/ci.md'],
    ]);
    const again = spawnSync(process.execPath, [INJECT], {
      input: JSON.stringify({ session_id: `mu-${host}-${process.pid}` }), encoding: 'utf8',
      env: { ...process.env, AOS_VAULT: v, AOS_CONFIG: path.join(v, 'none.json'), AOS_HOST: host },
    });
    assert.equal(again.stdout, '');
    assert.equal(rows(v).length, 4, 'the second prompt logs nothing');
  }
});

test('with telemetry off the session still gets its context and no row is written', () => {
  const v = injectVault('mu-inj-off-');
  put(v, 'brain/config.json', JSON.stringify({ telemetry: { enabled: false } }));
  const r = inject(v, `mu-off-${process.pid}`, 'claude');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hello brain/);
  assert.equal(fs.existsSync(usage.logFile(v)), false);
});

test('a BRAIN.md built before brain-sources.json existed still logs the recall-wake paths', () => {
  const v = injectVault('mu-inj-nosrc-');
  fs.unlinkSync(path.join(v, 'brain/_index/brain-sources.json'));
  const r = inject(v, `mu-nosrc-${process.pid}`, 'claude');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows(v).map((x) => x.path), ['brain/memory/reference/ci.md']);
});

// ── the MCP server ──

const SERVER = path.join(__dirname, '..', 'sdk', 'mcp-server.js');
async function call(v, host, name, args) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER],
    env: { ...process.env, AOS_VAULT: v, AOS_CONFIG: path.join(v, 'none.json'), AOS_HOST: host },
  });
  const client = new Client({ name: 'memory-usage-test', version: '0.0.0' });
  await client.connect(transport);
  try { return (await client.callTool({ name, arguments: args })).content[0].text; } finally { await client.close(); }
}

test('recall logs its hits and memory_read the path it read, tagged with the server\'s host', async () => {
  for (const host of ['claude', 'codex']) {
    const v = vault(`mu-mcp-${host}-`);
    put(v, 'brain/config.json', JSON.stringify({ provider: 'none' }));
    put(v, 'brain/memory/feedback/graphify-first.md', memory('feedback', 'Graphify first'));
    put(v, 'brain/memory/reference/unrelated.md', memory('reference', 'Unrelated').replace('The graph answers structure questions in one call.', 'Tide tables and chart tiles.'));
    const hits = JSON.parse(await call(v, host, 'recall', { query: 'graph structure questions' })).hits;
    assert.ok(hits.some((h) => h.path === 'brain/memory/feedback/graphify-first.md'));
    const text = await call(v, host, 'memory_read', { path: 'brain/memory/feedback/graphify-first.md' });
    assert.match(text, /Graphify first/);
    await call(v, host, 'memory_read', { path: 'brain/memory/feedback/missing.md' });
    const got = rows(v);
    assert.ok(got.every((r) => r.host === host), JSON.stringify(got));
    assert.ok(got.some((r) => r.how === 'recalled' && r.path === 'brain/memory/feedback/graphify-first.md'));
    assert.deepEqual(got.filter((r) => r.how === 'read').map((r) => r.path), ['brain/memory/feedback/graphify-first.md'], 'a miss logs nothing');
  }
});
