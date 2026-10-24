'use strict';
// A stdio MCP server for test/connectors-check.test.js (connectors-tab D10). Not a test file itself.
//   node mcp-fixture-server.js ok      → answers with two tools (and echoes FIXTURE_TOKEN's presence, never its value)
//   node mcp-fixture-server.js slow    → never answers
//   node mcp-fixture-server.js crash   → exits before answering
const mode = process.argv[2] || 'ok';
if (mode === 'crash') process.exit(3);
if (mode === 'slow') setInterval(() => {}, 60 * 1000);
else {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool('lookup', { description: `Look a thing up.\nSecond line is not kept.${process.env.FIXTURE_TOKEN ? ' (token set)' : ''}` }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.registerTool('fetch', { description: 'x'.repeat(500) }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.connect(new StdioServerTransport());
}
