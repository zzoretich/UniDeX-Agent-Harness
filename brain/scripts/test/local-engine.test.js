'use strict';
// The local engine's HTTP adapters (local-first A8, A13, A18) against a fake server on the loopback interface: Ollama's
// /api/tags and /api/pull, and an OpenAI-compatible /v1. Nothing here reaches a real Ollama or the network.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ollama = require('../sdk/lib/ollama.js');
const openai = require('../sdk/lib/openai-compat.js');
const { recordLocalCall, localUsageToday, KEEP_DAYS } = require('../sdk/lib/local-usage.js');

let server;
let port;
const seen = [];
let mode = 'ok';

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (mode === 'down') return json(503, { error: 'loading' });
      if (req.url === '/api/tags') return json(200, { models: [{ name: 'qwen3.5:9b', model: 'qwen3.5:9b' }, { model: 'qwen3-embedding:0.6b' }, {}] });
      if (req.url === '/api/pull') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write('{"status":"pulling manifest"}\n{"status":"downloading","completed":5,"total');
        res.write('":10}\n');
        if (mode === 'pull-error') res.write('{"error":"pull model manifest: file does not exist"}\n');
        else res.write('{"status":"success"}\n');
        return res.end();
      }
      if (req.url === '/v1/models') return json(200, { data: [{ id: 'qwen3.5-9b' }, { id: 'embed-small' }] });
      if (req.url === '/v1/chat/completions') return json(200, { choices: [{ message: { content: '<think>hm</think>{"ok":true}' } }] });
      if (req.url === '/v1/embeddings') {
        const n = body ? JSON.parse(body).input.length : 0;
        return json(200, { data: Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, embedding: [3, 4] })).reverse() });
      }
      json(404, { error: 'no route' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

test('ollama.tags lists pulled names (name, else model); null when the server fails or nothing listens', async () => {
  mode = 'ok';
  assert.deepEqual(await ollama.tags(2000, { host: '127.0.0.1', port }), ['qwen3.5:9b', 'qwen3-embedding:0.6b']);
  mode = 'down';
  assert.equal(await ollama.tags(2000, { host: '127.0.0.1', port }), null);
  mode = 'ok';
  assert.equal(await ollama.tags(500, { host: '127.0.0.1', port: 9 }), null, 'a closed port is "not answering", never a throw');
});

test('ollama.sameModel: a bare name means :latest; other tags compare as written', () => {
  assert.ok(ollama.sameModel('llama3.2', 'llama3.2:latest'));
  assert.ok(ollama.sameModel('qwen3.5:9b', 'qwen3.5:9b'));
  assert.ok(!ollama.sameModel('qwen3.5:9b', 'qwen3.5:4b'));
  assert.ok(!ollama.sameModel('qwen3.5', 'qwen3.5:9b'));
  assert.ok(!ollama.sameModel(null, 'x'));
});

test('ollama.pull streams progress lines (split across chunks) and resolves; an error line rejects', async () => {
  mode = 'ok';
  const lines = [];
  await ollama.pull('qwen3.5:4b', { host: '127.0.0.1', port, onProgress: (m) => lines.push(m) });
  assert.deepEqual(lines.map((l) => l.status), ['pulling manifest', 'downloading', 'success']);
  assert.deepEqual([lines[1].completed, lines[1].total], [5, 10]);
  assert.deepEqual(seen.at(-1).body, { model: 'qwen3.5:4b', stream: true });
  mode = 'pull-error';
  await assert.rejects(() => ollama.pull('nope:1b', { host: '127.0.0.1', port }), /file does not exist/);
  mode = 'ok';
});

test('openai-compat: models, chat (think stripped, json and schema formats) and normalized embeddings in input order', async () => {
  const url = `http://127.0.0.1:${port}/v1/`;
  assert.deepEqual(await openai.models(url), ['qwen3.5-9b', 'embed-small']);
  assert.equal(await openai.models(`http://127.0.0.1:9/v1`, 500), null);
  assert.equal(await openai.chat({ url, model: 'qwen3.5-9b', system: 's', prompt: 'p', format: 'json' }), '{"ok":true}');
  const body = seen.at(-1).body;
  assert.deepEqual(body.messages, [{ role: 'system', content: 's' }, { role: 'user', content: 'p' }]);
  assert.deepEqual([body.model, body.stream, body.temperature, body.response_format], ['qwen3.5-9b', false, 0, { type: 'json_object' }]);
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  assert.deepEqual(openai.buildChatBody({ model: 'm', prompt: 'p', format: schema }).response_format, { type: 'json_schema', json_schema: { name: 'reply', schema, strict: false } });
  const v = await openai.embed(['a', 'b'], { url, model: 'embed-small' });
  assert.deepEqual(v, [[0.6, 0.8], [0.6, 0.8]]);
  assert.deepEqual(seen.at(-1).body, { model: 'embed-small', input: ['a', 'b'] });
  assert.deepEqual(await openai.embed([], { url }), []);
});

test('local-usage: counts calls per day and feature, keeps the last KEEP_DAYS days, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusage-'));
  const file = path.join(dir, 'local-usage.json');
  const day = (d) => new Date(2026, 9, d, 12);
  recordLocalCall({ feature: 'file-map', ms: 400, now: day(14) }, file);
  recordLocalCall({ feature: 'file-map', ms: 100, now: day(14) }, file);
  recordLocalCall({ feature: 'session-summary', ms: -5, now: day(14) }, file);
  assert.deepEqual(localUsageToday(day(14), file), { calls: 3, ms: 500, byFeature: { 'file-map': 2, 'session-summary': 1 } });
  assert.deepEqual(localUsageToday(day(15), file), { calls: 0, ms: 0, byFeature: {} });
  for (let i = 1; i <= KEEP_DAYS + 5; i++) recordLocalCall({ feature: 'x', now: new Date(2026, 6, i, 12) }, file);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).days).length, KEEP_DAYS);
  fs.writeFileSync(file, 'not json');
  recordLocalCall({ feature: 'x', now: day(14) }, file);
  assert.equal(localUsageToday(day(14), file).calls, 1, 'a torn file starts over');
  assert.doesNotThrow(() => recordLocalCall({ feature: 'x' }, path.join(dir, 'missing-dir', 'sub', 'f.json')));
});
