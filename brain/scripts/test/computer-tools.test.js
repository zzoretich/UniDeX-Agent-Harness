'use strict';
// agent-computer D19/D21: the thirteen computer_* tools against a fake bridge speaking the app's socket protocol.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { COMPUTER_TOOLS, COMPUTER_LOOK } = require('../sdk/computer-tools.js');
const { BROWSER_INSTRUCTIONS } = require('../sdk/lib/browser-instructions.js');
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
function fakeBridge({ refuse, onCall, admitDelayMs = 0, tools }) {
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
          if (refuse) { conn.end(JSON.stringify({ admitted: false, reason: refuse }) + '\n'); } else setTimeout(() => conn.write(JSON.stringify({ admitted: true, session: 's', ...(tools ? { tools } : {}) }) + '\n'), admitDelayMs);
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

test('the server lists the thirteen computer tools with look tools read-only and acting tools destructive', async () => {
  assert.equal(COMPUTER_TOOLS.length, 13);
  assert.equal(COMPUTER_LOOK.length, 5);
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

async function toolDefs() {
  return withClient(makeVault(), async (client) => new Map((await client.listTools()).tools.filter((t) => t.name.startsWith('computer_')).map((t) => [t.name, t])));
}

test('every tool names the UniDeX browser', async () => {
  const defs = await toolDefs();
  assert.equal(defs.size, 13);
  for (const [name, def] of defs) {
    assert.match(def.title, /UniDeX browser/, name);
    assert.match(def.description, /^In the UniDeX browser \(the browser inside the UniDeX app, which the user watches beside this session\), /, name);
    assert.doesNotMatch(def.title + def.description, /Computer pane/, name);
  }
});

const isObjectOrArray = (schema) => schema.type === 'object' || schema.type === 'array';

test('thirteen tools, five that only look, flat arguments', async () => {
  const defs = await toolDefs();
  assert.equal(COMPUTER_TOOLS.length, 13);
  assert.equal(COMPUTER_LOOK.length, 5);
  assert.deepEqual([...COMPUTER_LOOK].sort(), ['computer_console', 'computer_screenshot', 'computer_snapshot', 'computer_status', 'computer_wait']);
  for (const [name, def] of defs) {
    for (const [arg, schema] of Object.entries(def.inputSchema.properties || {})) assert.ok(!isObjectOrArray(schema), `${name}.${arg}`);
  }
});

test('the four new tools and double are registered with their arguments', async () => {
  const defs = await toolDefs();
  const titles = {
    computer_tab: 'Switch or close a tab in the UniDeX browser',
    computer_nav: 'Go back, forward or reload in the UniDeX browser',
    computer_hover: 'Hover in the UniDeX browser',
    computer_console: "Read the UniDeX browser's console",
  };
  for (const [name, title] of Object.entries(titles)) assert.equal(defs.get(name).title, title, name);
  const props = (n) => defs.get(n).inputSchema.properties;
  assert.deepEqual(Object.keys(props('computer_tab')).sort(), ['close', 'index']);
  assert.equal(props('computer_tab').index.type, 'integer');
  assert.equal(props('computer_tab').index.minimum, 0);
  assert.equal(props('computer_tab').index.maximum, 1000);
  assert.equal(props('computer_tab').close.type, 'boolean');
  assert.deepEqual(defs.get('computer_tab').inputSchema.required, ['index']);
  assert.deepEqual(Object.keys(props('computer_nav')), ['go']);
  assert.deepEqual(props('computer_nav').go.enum, ['back', 'forward', 'reload']);
  assert.deepEqual(Object.keys(props('computer_hover')).sort(), ['ref', 'x', 'y']);
  assert.deepEqual(Object.keys(props('computer_console')), ['tab']);
  assert.equal(props('computer_click').double.type, 'boolean');
  assert.ok(!(defs.get('computer_click').inputSchema.required || []).includes('double'));
  assert.match(defs.get('computer_console').description, /errors, warnings, uncaught exceptions and failed requests since the page loaded/);
  assert.match(defs.get('computer_console').description, /page text/);
  assert.equal(defs.get('computer_console').annotations.readOnlyHint, true);
  assert.equal(defs.get('computer_hover').annotations.destructiveHint, true);
});

test('every acting tool says its reply carries the page', async () => {
  const defs = await toolDefs();
  const sentence = 'The reply ends with the page as it is now, with refs you can use in your next call.';
  for (const [name, def] of defs) {
    if (COMPUTER_LOOK.includes(name)) assert.ok(!def.description.includes(sentence), name);
    else assert.ok(def.description.includes(sentence), name);
  }
});

test("the descriptions say what only the skill said: a snapshot is for a page not just acted on, a ref comes from the newest outline, what asks on nav (S16d)", async () => {
  const defs = await toolDefs();
  const props = (n) => defs.get(n).inputSchema.properties;
  assert.ok(defs.get('computer_snapshot').description.includes("An action's reply already ends with the page, so use this for a page you have not just acted on, or for the rest of a long one."), defs.get('computer_snapshot').description);
  for (const [name, arg] of [['computer_click', 'ref'], ['computer_type', 'ref'], ['computer_scroll', 'ref'], ['computer_hover', 'ref']]) {
    assert.ok(props(name)[arg].description.includes("from the newest outline this session was given (a computer_snapshot or an action's reply)"), `${name}.${arg}: ${props(name)[arg].description}`);
  }
  assert.ok(defs.get('computer_nav').description.includes('when the page was loaded by a form or how it was loaded is not known'), defs.get('computer_nav').description);
  assert.ok(defs.get('computer_console').description.includes('Entries from frames of another site are left out, and it holds the newest 200.'), defs.get('computer_console').description);
  assert.ok(props('computer_click').double.description.includes('when the first click changes the page the second is not sent, and the reply says so'), props('computer_click').double.description);
  // a tab index has the same bounds wherever it is asked for
  for (const name of ['computer_snapshot', 'computer_screenshot', 'computer_console']) {
    assert.equal(props(name).tab.type, 'integer', name);
    assert.equal(props(name).tab.minimum, 0, name);
    assert.equal(props(name).tab.maximum, props('computer_tab').index.maximum, name);
  }
});

test('a new tool reaches an app that lists it, with its arguments', async () => {
  const b = await fakeBridge({ tools: COMPUTER_TOOLS, onCall: (req, reply) => reply({ text: 'ok' }) });
  try {
    await withClient(makeVault(b.sock), async (client) => {
      assert.equal(text(await client.callTool({ name: 'computer_tab', arguments: { index: 1, close: true } })), 'ok');
      assert.equal(text(await client.callTool({ name: 'computer_click', arguments: { ref: 'e1', double: true } })), 'ok');
    });
    assert.deepEqual(b.seen.calls.map((c) => [c.tool, c.args]), [['computer_tab', { index: 1, close: true }], ['computer_click', { ref: 'e1', double: true }]]);
  } finally { b.close(); }
});

test('status says what to do outside the app, open says what the browser is for', async () => {
  const defs = await toolDefs();
  assert.match(defs.get('computer_status').description, /Call this first/);
  assert.match(defs.get('computer_status').description, /another browser tool/);
  assert.match(defs.get('computer_status').description, /is turned off in Settings/);
  assert.match(defs.get('computer_status').description, /"\(off: computer_open asks the user to turn it on\)" is not that: call computer_open/);
  assert.match(defs.get('computer_status').description, /could not start/);
  assert.match(defs.get('computer_status').description, /who is driving/);
  for (const word of ['web page', 'localhost', 'preview']) assert.ok(defs.get('computer_open').description.includes(word), word);
});

test('each client refusal is one sentence with a next step', () => {
  for (const s of [NO_APP, OFF, FAILED, CLOSED, TIMEOUT]) {
    assert.equal((s.match(/[.!?](\s|$)/g) || []).length, 1, s);
    assert.ok(!s.includes(';') && !s.includes('e.g.'), s);
    assert.match(s, /: (use|ask|quit|call) /, s);
  }
});

test("computer_open's description says how to search the web: DuckDuckGo's ?q=, how to open a result, and what asks", async () => {
  await withClient(makeVault(), async (client) => {
    const open = (await client.listTools()).tools.find((t) => t.name === 'computer_open');
    assert.ok(open.description.includes('To search the web, open https://duckduckgo.com/?q=<the words, URL-encoded>'), open.description);
    // A snapshot carries a link's name, not its URL (the accessibility tree has no href), so the description says what
    // the agent can see: the address DuckDuckGo prints with each result.
    assert.ok(open.description.includes("A snapshot shows each result's title and its address (site and path), not the link's URL: open a result with this tool at that address, or click it."), open.description);
    // session-browser S3: the browser starts off, so only the first open asks (to turn it on); after that opening never asks.
    assert.ok(open.description.includes('The browser starts off: the first open asks the user to turn it on.'), open.description);
    assert.ok(open.description.includes('Once the browser is on, opening a page never asks the user; clicking or typing on a site the user has not marked does.'), open.description);
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

test('with no marker the server sends no instructions (session-browser S15)', async () => {
  await withClient(makeVault(), async (client) => {
    assert.equal(client.getInstructions(), undefined);
  });
});

test('a live marker with a bridge socket makes the server send the browser paragraph (session-browser S15)', async () => {
  const b = await fakeBridge({});
  try {
    await withClient(markedVault({ pid: process.pid }, b.sock), async (client) => {
      assert.equal(client.getInstructions(), BROWSER_INSTRUCTIONS);
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
