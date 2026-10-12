'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'sdk', 'recall-cli.js');

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-cli-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(v, 'brain', 'memory', 'reference'), { recursive: true });
  // Plan 2 rule: every test forces provider `none`. Under `auto`, getProvider() would ping Ollama and then run a
  // real `claude -p` login probe; with `none` recall stays BM25 and the test never resolves a provider.
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  fs.writeFileSync(path.join(v, 'brain', 'memory', 'reference', 'zebra-deploy.md'),
    '---\ntype: memory\nupdated: 2026-09-01\n---\n\n# Zebra deploy\n\nThe zebra service deploys from the release branch every Tuesday.\n');
  fs.writeFileSync(path.join(v, 'brain', '_index', 'SESSION.md'), '# Current Session Working Memory\n\n## Active Task\nzebra deploy\n');
  return v;
}
function run(v, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AOS_VAULT: v, AOS_CONFIG: path.join(os.tmpdir(), 'no-such-agenticos.json') },
  });
}

test('--warm builds recall-index.json and the wake file', () => {
  const v = vault();
  const r = run(v, ['--warm']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recall: indexed 1 docs/);
  const idx = JSON.parse(fs.readFileSync(path.join(v, 'brain', '_index', 'recall-index.json'), 'utf8'));
  assert.equal(idx.docCount, 1);
  assert.ok(fs.existsSync(path.join(v, 'brain', '_index', 'recall-wake.md')));
});

test('a query prints ranked hits, building the index when it is missing', () => {
  const v = vault();
  const r = run(v, ['zebra', 'release', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const hits = JSON.parse(r.stdout);
  assert.equal(hits[0].path, 'brain/memory/reference/zebra-deploy.md');
  assert.ok(fs.existsSync(path.join(v, 'brain', '_index', 'recall-index.json')));
  const text = run(v, ['zebra']);
  assert.match(text.stdout, /brain\/memory\/reference\/zebra-deploy\.md \(/);
});

test('no query and no --warm is a usage error', () => {
  const r = run(vault(), []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test('daily notes are indexed strictly under the configured dailyNote.layout', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'none', dailyNote: { layout: '{yyyy}/{yyyy}-{MM}-{dd}.md' } }));
  fs.mkdirSync(path.join(v, '2026'), { recursive: true });
  fs.writeFileSync(path.join(v, '2026', '2026-09-14.md'), '# 2026-09-14\n\nShipped the quokka migration today.\n');
  // A note left over from the default layout: under the configured flat layout it is not a daily note any more (spec §5.3).
  fs.mkdirSync(path.join(v, '2026', '2026-09-September'), { recursive: true });
  fs.writeFileSync(path.join(v, '2026', '2026-09-September', '2026-09-04.md'), '# 2026-09-04\n\nAn older quokka note under the previous layout.\n');
  const warm = run(v, ['--warm']);
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /recall: indexed 2 docs/);
  const hits = JSON.parse(run(v, ['quokka', 'migration', '--json']).stdout);
  assert.equal(hits[0].path, '2026/2026-09-14.md');
});

test('a null recallRoots in brain/config.json is treated as an empty list', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'none', recallRoots: null }));
  const r = run(v, ['--warm']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recall: indexed 0 docs/);
});

// The Brain tab's recall preview (brain-hub D18) runs exactly brainModel recallArgs' argv: one query argument, then
// --limit N --json. It logs no usage row (D9: only an agent's MCP recall and memory_read count as use) and, on a vault
// without an index, writes the two files --warm writes and nothing else (SECURITY.md's row for the preview).
const PREVIEW = ['zebra release branch', '--limit', '3', '--json'];
const vaultFiles = (v) => fs.readdirSync(v, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => fs.statSync(path.join(v, f)).isFile()).sort();

test('the recall preview logs no memory-usage row, with telemetry on, on either host', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'none', telemetry: { enabled: true } }));
  assert.equal(run(v, ['--warm']).status, 0);
  for (const host of ['claude', 'codex']) {
    const r = spawnSync(process.execPath, [CLI, ...PREVIEW], {
      encoding: 'utf8',
      env: { ...process.env, AOS_VAULT: v, AOS_HOST: host, AOS_CONFIG: path.join(os.tmpdir(), 'no-such-agenticos.json') },
    });
    assert.equal(r.status, 0, r.stderr);
    const hits = JSON.parse(r.stdout);
    assert.equal(hits[0].path, 'brain/memory/reference/zebra-deploy.md', 'a memory hit: the row would have qualified');
    assert.ok(hits.length <= 3);
  }
  assert.ok(!fs.existsSync(path.join(v, 'brain', '_index', 'memory-usage.jsonl')));
});

test('the recall preview on a vault without an index builds recall-index.json and recall-wake.md, and writes nothing else', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'none', telemetry: { enabled: true } }));
  const before = vaultFiles(v);
  assert.ok(!before.includes('brain/_index/recall-index.json'));
  const r = run(v, PREVIEW);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].path, 'brain/memory/reference/zebra-deploy.md');
  assert.deepEqual(vaultFiles(v), [...before, 'brain/_index/recall-index.json', 'brain/_index/recall-wake.md'].sort());
  assert.equal(JSON.parse(fs.readFileSync(path.join(v, 'brain', '_index', 'recall-index.json'), 'utf8')).docCount, 1);
  // A second preview reads that index and writes nothing at all.
  const mtime = fs.statSync(path.join(v, 'brain', '_index', 'recall-index.json')).mtimeMs;
  assert.equal(run(v, PREVIEW).status, 0);
  assert.deepEqual(vaultFiles(v), [...before, 'brain/_index/recall-index.json', 'brain/_index/recall-wake.md'].sort());
  assert.equal(fs.statSync(path.join(v, 'brain', '_index', 'recall-index.json')).mtimeMs, mtime);
});

// With an embed index the preview embeds the query, and only through the local Ollama (ollamaEmbedder): it never resolves
// the provider, so it writes no provider-state.json and never runs a headless login probe (no provider-spend.jsonl), and
// when Ollama does not answer the hits are BM25's (SECURITY.md's row for the preview).
test('the recall preview with an embed index and Ollama down writes nothing and probes no provider', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'auto', ollama: { host: '127.0.0.1', port: 1 } }));
  assert.equal(run(v, ['--warm']).status, 0);
  fs.writeFileSync(path.join(v, 'brain', '_index', 'embed-index.json'),
    JSON.stringify({ dims: 2, chunks: [{ path: 'brain/memory/reference/zebra-deploy.md', vec: [1, 0] }] }));
  const before = vaultFiles(v);
  // No claude or codex binary reachable either way: a regression would fail on the state file, never spend.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-cli-home-'));
  const r = spawnSync(process.execPath, [CLI, ...PREVIEW], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: path.dirname(process.execPath), AOS_VAULT: v, AOS_CONFIG: path.join(os.tmpdir(), 'no-such-agenticos.json') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].path, 'brain/memory/reference/zebra-deploy.md', 'BM25 hits');
  assert.deepEqual(vaultFiles(v), before, 'no provider-state.json, no provider-spend.jsonl, nothing else');
});

test('ollamaEmbedder: Ollama\'s /api/embed only under auto or ollama; every other provider mode refuses (BM25)', async () => {
  const http = require('http');
  const { ollamaEmbedder } = require('../sdk/recall-cli.js');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { seen.push([req.url, JSON.parse(body).input]); res.end(JSON.stringify({ embeddings: [[3, 4]] })); });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  try {
    for (const provider of ['auto', 'ollama', undefined]) {
      const vec = await ollamaEmbedder({ provider, ollama: { host: '127.0.0.1', port } })(['zebra'], { timeoutMs: 2000 });
      assert.deepEqual(vec, [[0.6, 0.8]], String(provider));
    }
    assert.deepEqual(seen, [['/api/embed', ['zebra']], ['/api/embed', ['zebra']], ['/api/embed', ['zebra']]]);
    for (const provider of ['claude', 'codex', 'none']) {
      await assert.rejects(ollamaEmbedder({ provider, ollama: { host: '127.0.0.1', port } })(['zebra']), /has no embeddings/, provider);
    }
    assert.equal(seen.length, 3, 'a refused mode never calls Ollama');
  } finally {
    server.close();
  }
});
