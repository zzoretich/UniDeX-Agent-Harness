'use strict';
// Native schema compatibility through the actual MCP stdio server, bounded fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function withClient(t, fn) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'zod-mcp-'));
  fs.mkdirSync(path.join(vault, 'brain/memory/user'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'brain/_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain/config.json'), JSON.stringify({ provider: 'none' }));
  fs.writeFileSync(path.join(vault, 'MEMORY.md'), '# Memory Index\n');
  const session = path.join(vault, 'brain/_index/SESSION.md');
  fs.writeFileSync(session, 'DUMMY unchanged session\n');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--max-old-space-size=128', path.join(__dirname, '../sdk/mcp-server.js')],
    env: { ...process.env, AOS_VAULT: vault, AOS_CONFIG: path.join(vault, 'absent.json') }, stderr: 'ignore' });
  const client = new Client({ name: 'zod-compat-test', version: '0.0.0' });
  t.after(async () => { await client.close(); fs.rmSync(vault, { recursive: true, force: true }); });
  await client.connect(transport);
  return fn(client, { vault, session });
}

test('native schemas retain required strings, bounded graph integers and write-tool arrays', { timeout: 10000 }, async (t) => {
  await withClient(t, async (client) => {
    const tools = (await client.listTools()).tools;
    const search = tools.find((tool) => tool.name === 'memory_search');
    assert.equal(search.inputSchema.type, 'object');
    assert.deepEqual(search.inputSchema.required, ['query']);
    assert.equal(search.inputSchema.properties.query.type, 'string');
    assert.equal(search.annotations.readOnlyHint, true);
    const graph = tools.find((tool) => tool.name === 'graph_query');
    assert.equal(graph.inputSchema.properties.depth.type, 'integer');
    assert.equal(graph.inputSchema.properties.depth.minimum, 0);
    assert.equal(graph.inputSchema.properties.depth.maximum, 3);
    assert.equal(graph.inputSchema.properties.budget.maximum, 200);
    const wrap = tools.find((tool) => tool.name === 'wrap_session');
    assert.equal(wrap.annotations.readOnlyHint, false);
    assert.equal(wrap.inputSchema.properties.facts.type, 'array');
    assert.equal(wrap.inputSchema.properties.facts.items.type, 'string');
    assert.deepEqual(wrap.inputSchema.properties.candidates.items.properties.type.enum, ['user', 'feedback', 'projects', 'reference']);
    const result = await client.callTool({ name: 'memory_search', arguments: { query: 'DUMMY-no-match' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 'No matches for "DUMMY-no-match".');
  });
});

test('bounded malformed tool collections return an error without writes and keep the same server usable', { timeout: 10000 }, async (t) => {
  await withClient(t, async (client, { vault, session }) => {
    const result = await client.callTool({ name: 'wrap_session', arguments: {
      facts: Array(64).fill(null), decisions: [], feedback: [], threads: [], candidates: [],
    } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /facts/);
    assert.ok(result.content[0].text.length < 128 * 1024, 'bounded error response');
    assert.equal(fs.readFileSync(session, 'utf8'), 'DUMMY unchanged session\n');
    assert.deepEqual(fs.readdirSync(path.join(vault, 'brain/memory/user')), []);
    const later = await client.callTool({ name: 'memory_list', arguments: {} });
    assert.equal(later.isError, undefined);
    assert.deepEqual(JSON.parse(later.content[0].text), { total: 0, shown: 0, byType: {} });
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'wrap_session'));
  });
});
