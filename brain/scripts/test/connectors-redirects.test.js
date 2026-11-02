'use strict';
// Real SDK transports, loopback only, dummy credentials; no host config or OAuth provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { sdkProbe } = require('../lib/connectors/check.js');

const HEADERS = { Authorization: 'Bearer DUMMY-AUTH', 'X-API-Key': 'DUMMY-KEY' };

async function listen(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    handler(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

function rpc(req, res, body) {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  const message = JSON.parse(body);
  if (message.id === undefined) { res.writeHead(202).end(); return; }
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'DUMMY', version: '0.0.0' } }
    : { tools: [{ name: 'dummy_read', description: 'Dummy read tool', inputSchema: { type: 'object' } }] };
  res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'DUMMY-SESSION' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}

test('HTTP probe follows same-origin redirects and returns real tool descriptions', { timeout: 5000 }, async (t) => {
  const source = await listen(t, (req, res, body) => {
    if (req.url === '/mcp') res.writeHead(307, { Location: '/same' }).end();
    else rpc(req, res, body);
  });
  const result = await probe(source.origin);
  assert.deepEqual(result, { ok: true, tools: [{ name: 'dummy_read', summary: 'Dummy read tool' }] });
  const initialized = source.requests.find((r) => r.url === '/same' && r.method === 'POST');
  assert.equal(initialized.headers['x-api-key'], 'DUMMY-KEY');
  assert.equal(initialized.headers.authorization, 'Bearer DUMMY-AUTH');
  assert.equal(JSON.parse(initialized.body).method, 'initialize');
});

const probe = (origin) => sdkProbe({ transport: 'http', url: `${origin}/mcp`, headers: HEADERS }, { timeoutMs: 1500 });

test('HTTP probe refuses a cross-origin 307 before any header or body reaches the other server', { timeout: 5000 }, async (t) => {
  const target = await listen(t, rpc);
  const source = await listen(t, (req, res) => res.writeHead(307, { Location: `${target.origin}/capture` }).end());
  const result = await probe(source.origin);
  assert.equal(target.requests.length, 0, 'no request of any kind may reach the other origin');
  assert.equal(result.ok, false);
  assert.equal(source.requests[0].headers['x-api-key'], 'DUMMY-KEY');
});

for (const status of [302, 303, 308]) {
  test(`HTTP probe refuses a cross-origin ${status} before contacting the other origin`, { timeout: 5000 }, async (t) => {
    const target = await listen(t, rpc);
    const source = await listen(t, (req, res) => res.writeHead(status, { Location: `${target.origin}/capture` }).end());
    const result = await probe(source.origin);
    assert.equal(target.requests.length, 0);
    assert.equal(result.ok, false);
    assert.equal(JSON.parse(source.requests[0].body).method, 'initialize');
  });
}

test('HTTP tools/list redirect does not forward an established session or JSON-RPC body', { timeout: 5000 }, async (t) => {
  const target = await listen(t, rpc);
  const source = await listen(t, (req, res, body) => {
    if (req.method === 'POST' && JSON.parse(body).method === 'tools/list') {
      res.writeHead(307, { Location: `${target.origin}/capture` }).end();
    } else rpc(req, res, body);
  });
  const result = await probe(source.origin);
  assert.equal(target.requests.length, 0);
  assert.equal(result.ok, false);
  const later = source.requests.find((r) => r.method === 'POST' && JSON.parse(r.body).method === 'tools/list');
  assert.equal(later.headers['mcp-session-id'], 'DUMMY-SESSION');
  assert.equal(later.headers['x-api-key'], 'DUMMY-KEY');
});

test('HTTP session GET refuses a cross-origin redirect while tools/list still works', { timeout: 5000 }, async (t) => {
  const target = await listen(t, rpc);
  let sawGet;
  const gotGet = new Promise((resolve) => { sawGet = resolve; });
  const source = await listen(t, (req, res, body) => {
    if (req.method === 'GET') {
      res.writeHead(307, { Location: `${target.origin}/capture` }).end();
      sawGet();
    } else rpc(req, res, body);
  });
  const result = await probe(source.origin);
  await Promise.race([gotGet, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('session GET was not exercised')), 500);
    timer.unref();
  })]);
  assert.equal(target.requests.length, 0);
  assert.equal(result.ok, true);
  const get = source.requests.find((r) => r.method === 'GET');
  assert.equal(get.headers['mcp-session-id'], 'DUMMY-SESSION');
  assert.equal(get.headers['x-api-key'], 'DUMMY-KEY');
  assert.equal(get.body, '');
});

function sse(endpoint, redirectPost = null) {
  let stream;
  return (req, res, body) => {
    if (req.method === 'GET') {
      stream = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: endpoint\ndata: ${endpoint}\n\n`);
      return;
    }
    if (redirectPost) { res.writeHead(307, { Location: redirectPost }).end(); return; }
    const message = JSON.parse(body);
    res.writeHead(202).end();
    if (message.id === undefined) return;
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'DUMMY', version: '0.0.0' } }
      : { tools: [{ name: 'dummy_read', description: 'Dummy read tool', inputSchema: { type: 'object' } }] };
    stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
  };
}

const sseProbe = (origin) => sdkProbe({ transport: 'sse', url: `${origin}/mcp`, headers: HEADERS }, { timeoutMs: 1500 });

test('SSE follows a same-origin GET redirect and lists tools through the endpoint POST', { timeout: 5000 }, async (t) => {
  const handler = sse('/post');
  const source = await listen(t, (req, res, body) => {
    if (req.url === '/mcp') res.writeHead(307, { Location: '/events' }).end();
    else handler(req, res, body);
  });
  const result = await sseProbe(source.origin);
  assert.deepEqual(result, { ok: true, tools: [{ name: 'dummy_read', summary: 'Dummy read tool' }] });
  const post = source.requests.find((r) => r.method === 'POST' && JSON.parse(r.body).method === 'tools/list');
  assert.equal(post.url, '/post');
  assert.equal(post.headers['x-api-key'], 'DUMMY-KEY');
  const get = source.requests.find((r) => r.url === '/events');
  assert.equal(get.headers['x-api-key'], 'DUMMY-KEY');
});

test('SSE initial GET redirect never sends custom headers to another origin', { timeout: 5000 }, async (t) => {
  const target = await listen(t, (req, res) => res.writeHead(401).end());
  const source = await listen(t, (req, res) => res.writeHead(307, { Location: `${target.origin}/capture` }).end());
  const result = await sseProbe(source.origin);
  assert.equal(target.requests.length, 0);
  assert.equal(result.ok, false);
  assert.equal(source.requests[0].method, 'GET');
  assert.equal(source.requests[0].headers['x-api-key'], 'DUMMY-KEY');
});

test('SSE endpoint POST redirect never forwards custom headers or initialize body', { timeout: 5000 }, async (t) => {
  const target = await listen(t, (req, res) => res.writeHead(400).end());
  const source = await listen(t, sse('/post', `${target.origin}/capture`));
  const result = await sseProbe(source.origin);
  assert.equal(target.requests.length, 0);
  assert.equal(result.ok, false);
  const post = source.requests.find((r) => r.method === 'POST');
  assert.equal(post.headers['x-api-key'], 'DUMMY-KEY');
  assert.equal(JSON.parse(post.body).method, 'initialize');
});

test('SSE tools/list POST redirect never forwards an initialized conversation', { timeout: 5000 }, async (t) => {
  const target = await listen(t, (req, res) => res.writeHead(400).end());
  const handler = sse('/post');
  const source = await listen(t, (req, res, body) => {
    if (req.method === 'POST' && JSON.parse(body).method === 'tools/list') {
      res.writeHead(308, { Location: `${target.origin}/capture` }).end();
    } else handler(req, res, body);
  });
  const result = await sseProbe(source.origin);
  assert.equal(target.requests.length, 0);
  assert.equal(result.ok, false);
  const post = source.requests.find((r) => r.method === 'POST' && JSON.parse(r.body).method === 'tools/list');
  assert.equal(post.headers['x-api-key'], 'DUMMY-KEY');
});

test('SSE refuses a cross-origin endpoint event before posting initialize', { timeout: 5000 }, async (t) => {
  const target = await listen(t, (req, res) => res.writeHead(400).end());
  const source = await listen(t, sse(`${target.origin}/capture`));
  const result = await sseProbe(source.origin);
  assert.equal(target.requests.length, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /origin does not match/);
});
