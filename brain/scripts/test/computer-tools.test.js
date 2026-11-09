'use strict';
// agent-computer D19/D21: the nine computer_* tools against a fake bridge speaking the app's socket protocol.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { COMPUTER_TOOLS, COMPUTER_LOOK } = require('../sdk/computer-tools.js');
const { NO_APP, OFF, FAILED, CLOSED, TIMEOUT } = require('../sdk/lib/computer-client.js');
const { spawnSync } = require('child_process');

const SERVER = path.join(__dirname, '..', 'sdk', 'mcp-server.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-'));
const PNG = Buffer.from('png-bytes').toString('base64');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
function makeVault(socket) {
  const vault = path.join(ROOT, `v${++seq}`);
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  if (socket !== undefined) {
    const marker = { schema: 1, host: 'app', name: 'UniDeX', version: '1.0.0', at: '2026-11-07T00:00:00.000Z' };
    if (socket) marker.computerSocket = socket;
    fs.writeFileSync(path.join(vault, 'brain', '_index', 'hud-host.json'), JSON.stringify(marker));
  }
  return vault;
}

// A fake bridge: admits (or refuses) the first hello, then hands each request line to `onCall(req, reply, conn)`.
function fakeBridge({ refuse, onCall, admitDelayMs = 0 }) {
  const sock = path.join(ROOT, `b${++seq}.sock`);
  const seen = { hello: 0, calls: [], conns: [] };
  const server = net.createServer((conn) => {
    conn.setEncoding('utf8');
    seen.conns.push(conn);
    let buf = '';
    conn.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.hello) {
          seen.hello++;
          if (refuse) { conn.end(JSON.stringify({ admitted: false, reason: refuse }) + '\n'); } else setTimeout(() => conn.write(JSON.stringify({ admitted: true, session: 's' }) + '\n'), admitDelayMs);
        } else {
          seen.calls.push(msg);
          onCall && onCall(msg, (r) => conn.write(JSON.stringify({ id: msg.id, ...r }) + '\n'), conn);
        }
      }
    });
    conn.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(sock, () => resolve({ sock, seen, close: () => { for (const c of seen.conns) c.destroy(); server.close(); } })));
}

async function withClient(vault, fn, env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, AOS_VAULT: vault, AOS_CONFIG: path.join(ROOT, 'none.json'), ...env } });
  const client = new Client({ name: 'computer-test', version: '0.0.0' });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}
const text = (r) => r.content[0].text;

test('the server lists the nine computer tools with look tools read-only and acting tools destructive', async () => {
  assert.equal(COMPUTER_TOOLS.length, 9);
  await withClient(makeVault(), async (client) => {
    const tools = (await client.listTools()).tools.filter((t) => t.name.startsWith('computer_'));
    assert.deepEqual(tools.map((t) => t.name).sort(), [...COMPUTER_TOOLS].sort());
    for (const t of tools) {
      if (COMPUTER_LOOK.includes(t.name)) assert.equal(t.annotations.readOnlyHint, true, t.name);
      else assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, t.name);
      assert.match(t.description, /untrusted/);
      assert.match(t.description, /irreversible/);
    }
  });
});

test("computer_open's description says how to search the web: DuckDuckGo's ?q=, a result opened by its link's URL, and what asks", async () => {
  await withClient(makeVault(), async (client) => {
    const open = (await client.listTools()).tools.find((t) => t.name === 'computer_open');
    assert.ok(open.description.includes('To search the web, open https://duckduckgo.com/?q=<the words, URL-encoded>'), open.description);
    assert.ok(open.description.includes("then open a result by its link's URL"), open.description);
    assert.ok(open.description.includes('Opening a page never asks the user; clicking or typing on a site the user has not marked does.'), open.description);
  });
});

test('computer_open forwards the tool and args and returns the bridge text', async () => {
  const b = await fakeBridge({ onCall: (req, reply) => reply({ text: `opened ${req.args.url} — é€😀` }) });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      const r = await client.callTool({ name: 'computer_open', arguments: { url: 'https://example.com', newTab: true } });
      assert.equal(text(r), 'opened https://example.com — é€😀');
      assert.ok(!r.isError);
    });
    assert.equal(b.seen.hello, 1);
    assert.equal(b.seen.calls.length, 1);
    assert.deepEqual({ tool: b.seen.calls[0].tool, args: b.seen.calls[0].args }, { tool: 'computer_open', args: { url: 'https://example.com', newTab: true } });
    assert.equal(typeof b.seen.calls[0].id, 'number');
  } finally { b.close(); }
});

test('computer_screenshot returns an image block', async () => {
  const b = await fakeBridge({ onCall: (req, reply) => reply({ text: 'shot', image: { data: PNG, mimeType: 'image/png' } }) });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      const r = await client.callTool({ name: 'computer_screenshot', arguments: {} });
      const img = r.content.find((c) => c.type === 'image');
      assert.deepEqual({ data: img.data, mimeType: img.mimeType }, { data: PNG, mimeType: 'image/png' });
    });
  } finally { b.close(); }
});

test("the bridge's isError passes through", async () => {
  const b = await fakeBridge({ onCall: (req, reply) => reply({ text: 'no such ref', isError: true }) });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      const r = await client.callTool({ name: 'computer_click', arguments: { ref: 'e9' } });
      assert.equal(r.isError, true);
      assert.equal(text(r), 'no such ref');
    });
  } finally { b.close(); }
});

test('with no marker a call gets the no-app text as an error', async () => {
  await withClient(makeVault(), async (client) => {
    const r = await client.callTool({ name: 'computer_status', arguments: {} });
    assert.equal(r.isError, true);
    assert.equal(text(r), NO_APP);
  });
});

test('a marker without computerSocket, or a dead socket, is also the no-app text', async () => {
  await withClient(makeVault(''), async (client) => {
    assert.equal(text(await client.callTool({ name: 'computer_status', arguments: {} })), NO_APP);
  });
  await withClient(makeVault(path.join(ROOT, 'missing.sock')), async (client) => {
    const r = await client.callTool({ name: 'computer_status', arguments: {} });
    assert.equal(r.isError, true);
    assert.equal(text(r), NO_APP);
  });
});

test('a marker that says the app runs with the Computer surface off gives the off text, not the no-app one (agent-computer D26)', async () => {
  const vault = makeVault('');
  const file = path.join(vault, 'brain', '_index', 'hud-host.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), computer: 'off' }));
  await withClient(vault, async (client) => {
    for (const name of ['computer_status', 'computer_open']) {
      const r = await client.callTool({ name, arguments: name === 'computer_open' ? { url: 'https://example.com' } : {} });
      assert.equal(r.isError, true);
      assert.equal(text(r), OFF);
    }
  });
  assert.notEqual(OFF, NO_APP);
});

/** A vault whose marker carries `extra` over the plain one (and a socket when given). */
function markedVault(extra, socket = '') {
  const vault = makeVault(socket);
  const file = path.join(vault, 'brain', '_index', 'hud-host.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra }));
  return vault;
}
const status = async (client) => client.callTool({ name: 'computer_status', arguments: {} });

test('a marker that says the bridge did not start gives the failed text (agent-computer D26)', async () => {
  await withClient(markedVault({ computer: 'failed', pid: process.pid }), async (client) => {
    const r = await status(client);
    assert.equal(r.isError, true);
    assert.equal(text(r), FAILED);
  });
  assert.ok(![NO_APP, OFF].includes(FAILED));
});

test('a marker whose app process is gone counts as no app, whatever it says; a live one is believed', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  for (const extra of [{ computer: 'off' }, { computer: 'failed' }]) {
    await withClient(markedVault({ ...extra, pid: dead }), async (client) => { assert.equal(text(await status(client)), NO_APP, extra.computer); });
  }
  const b = await fakeBridge({ onCall: (msg, reply) => reply({ text: 'should not be asked' }) });
  try {
    await withClient(markedVault({ pid: dead }, b.sock), async (client) => { assert.equal(text(await status(client)), NO_APP); });
    assert.equal(b.seen.hello, 0, "a dead app's socket is not even tried");
  } finally { b.close(); }
  await withClient(markedVault({ computer: 'off', pid: process.pid }), async (client) => { assert.equal(text(await status(client)), OFF); });
});

test("a refused hello surfaces the bridge's reason, and the client does not reconnect", async () => {
  const b = await fakeBridge({ refuse: 'Another session already holds the computer.' });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      for (let i = 0; i < 2; i++) {
        const r = await client.callTool({ name: 'computer_status', arguments: {} });
        assert.equal(r.isError, true);
        assert.equal(text(r), 'Another session already holds the computer.');
      }
    });
    assert.equal(b.seen.conns.length, 1);
    assert.equal(b.seen.calls.length, 0);
  } finally { b.close(); }
});

test('a bridge closed mid-session gives the closed text for the pending and every later call, without reconnecting', async () => {
  const b = await fakeBridge({ onCall: (req, reply, conn) => { if (req.tool === 'computer_key') conn.destroy(); else reply({ text: 'ok' }); } });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      assert.equal(text(await client.callTool({ name: 'computer_status', arguments: {} })), 'ok');
      const pending = await client.callTool({ name: 'computer_key', arguments: { key: 'Enter' } });
      assert.equal(pending.isError, true);
      assert.equal(text(pending), CLOSED);
      const later = await client.callTool({ name: 'computer_status', arguments: {} });
      assert.equal(later.isError, true);
      assert.equal(text(later), CLOSED);
    });
    assert.equal(b.seen.conns.length, 1);
  } finally { b.close(); }
});

test('silence past the timeout gives the timeout text, and a late reply is ignored', async () => {
  const held = [];
  const b = await fakeBridge({ onCall: (req, reply) => { if (req.tool === 'computer_wait') held.push(reply); else reply({ text: `answer ${req.tool}` }); } });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      const r = await client.callTool({ name: 'computer_wait', arguments: { timeoutSec: 1 } });
      assert.equal(r.isError, true);
      assert.equal(text(r), TIMEOUT);
      held[0]({ text: 'too late' }); // the forgotten id: nothing happens
      assert.equal(text(await client.callTool({ name: 'computer_status', arguments: {} })), 'answer computer_status');
    }, { AOS_COMPUTER_TIMEOUT_MS: '200' });
  } finally { b.close(); }
});

test('a reply for an unknown id is ignored', async () => {
  const b = await fakeBridge({ onCall: (req, reply, conn) => { conn.write(JSON.stringify({ id: 99999, text: 'stray' }) + '\n'); reply({ text: 'real' }); } });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      assert.equal(text(await client.callTool({ name: 'computer_status', arguments: {} })), 'real');
    });
  } finally { b.close(); }
});

test('overlapping calls resolve to their own replies', async () => {
  const held = [];
  const b = await fakeBridge({ onCall: (req, reply) => { held.push({ req, reply }); if (held.length === 2) { held[1].reply({ text: `r:${held[1].req.tool}` }); held[0].reply({ text: `r:${held[0].req.tool}` }); } } });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      const [a, c] = await Promise.all([
        client.callTool({ name: 'computer_status', arguments: {} }),
        client.callTool({ name: 'computer_snapshot', arguments: {} }),
      ]);
      assert.equal(text(a), 'r:computer_status');
      assert.equal(text(c), 'r:computer_snapshot');
    });
    assert.equal(new Set(b.seen.calls.map((c) => c.id)).size, 2);
  } finally { b.close(); }
});

test('a call made before the hello answer waits for it and then succeeds', async () => {
  const b = await fakeBridge({ admitDelayMs: 300, onCall: (req, reply) => reply({ text: 'late but fine' }) });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      const r = await client.callTool({ name: 'computer_status', arguments: {} });
      assert.ok(!r.isError);
      assert.equal(text(r), 'late but fine');
    });
  } finally { b.close(); }
});

test('the timeout elapsing while waiting for the hello answer gives the timeout text', async () => {
  const b = await fakeBridge({ admitDelayMs: 1500, onCall: (req, reply) => reply({ text: 'never asked' }) });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      const r = await client.callTool({ name: 'computer_status', arguments: {} });
      assert.equal(r.isError, true);
      assert.equal(text(r), TIMEOUT);
    }, { AOS_COMPUTER_TIMEOUT_MS: '200' });
    assert.equal(b.seen.calls.length, 0);
  } finally { b.close(); }
});

test('the server exits on its own when its host closes stdin, with the bridge still connected', async () => {
  const b = await fakeBridge({ onCall: (req, reply) => reply({ text: 'ok' }) });
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, AOS_VAULT: makeVault(b.sock), AOS_CONFIG: path.join(ROOT, 'none.json') } });
    const client = new Client({ name: 'computer-test', version: '0.0.0' });
    await client.connect(transport);
    assert.equal(text(await client.callTool({ name: 'computer_status', arguments: {} })), 'ok');
    const pid = transport.pid;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // Close stdin only (what a host going away does); the transport's own close would signal the child after 2 s.
    transport._process.stdin.end();
    const t0 = Date.now();
    while (alive() && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 25));
    const exited = !alive();
    await client.close();
    assert.ok(exited, 'the server process exited without a signal');
  } finally { b.close(); }
});
