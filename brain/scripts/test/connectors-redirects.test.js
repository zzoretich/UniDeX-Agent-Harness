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
  assert.equal(JSON.parse(source.requests[0].body).method, 'initialize');
});
