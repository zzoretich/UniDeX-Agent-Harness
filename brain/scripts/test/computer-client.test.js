'use strict';
// session-browser R1: the client sends a tool only to an app that listed it. An app that does not know a tool's name
// ends the bridge connection for good, so an older app must never be sent one. A fake socket stands in for the bridge.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createComputerClient } = require('../sdk/lib/computer-client.js');
const { COMPUTER_TOOLS } = require('../sdk/computer-tools.js');

const OLD_NINE = ['computer_open', 'computer_snapshot', 'computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_wait', 'computer_status'];

// A socket that records writes; `admit(answer)` plays the app's admission answer, `reply(id, r)` a reply.
function fakeNet() {
  const sock = new EventEmitter();
  sock.writes = [];
  sock.unref = () => {};
  sock.setEncoding = () => {};
  sock.write = (line) => { sock.writes.push(JSON.parse(line)); };
  sock.destroy = () => {};
  sock.admit = (answer) => sock.emit('data', JSON.stringify(answer) + '\n');
  sock.reply = (id, r) => sock.emit('data', JSON.stringify({ id, ...r }) + '\n');
  return { net: { createConnection: () => { setImmediate(() => sock.emit('connect')); return sock; } }, sock };
}
const tick = () => new Promise((r) => setImmediate(r));

function make() {
  const f = fakeNet();
  const client = createComputerClient({ vault: 'v', net: f.net, readMarker: () => ({ computerSocket: 'x' }), alive: () => true, timeoutMs: 2000 });
  return { client, sock: f.sock };
}
const calls = (sock) => sock.writes.filter((w) => w.tool);

test('a tool the app did not list is answered without a write', async () => {
  const { client, sock } = make();
  const p = client.call('computer_tab', { index: 1 });
  await tick(); sock.admit({ admitted: true, session: 's', tools: ['computer_open', 'computer_status'] });
  const r = await p;
  assert.equal(r.isError, true);
  assert.equal(r.text, 'This UniDeX app is older than computer_tab: ask the user to update UniDeX, and use the other computer_* tools meanwhile.');
  assert.equal(calls(sock).length, 0);
  // a tool it did list still goes out
  const q = client.call('computer_status', {});
  await tick(); assert.equal(calls(sock).length, 1);
  sock.reply(calls(sock)[0].id, { text: 'fine' });
  assert.equal((await q).text, 'fine');
  client.stop();
});

test('with no list only the nine old tools are sent', async () => {
  for (const noList of [{}, { tools: 'computer_open' }, { tools: null }]) {
    const { client, sock } = make();
    const fresh = COMPUTER_TOOLS.filter((t) => !OLD_NINE.includes(t));
    assert.equal(fresh.length, 4);
    const pending = [...OLD_NINE.map((t) => client.call(t, {})), ...fresh.map((t) => client.call(t, {}))];
    await tick(); sock.admit({ admitted: true, session: 's', ...noList });
    await tick();
    assert.deepEqual(calls(sock).map((c) => c.tool), OLD_NINE, JSON.stringify(noList));
    for (const c of calls(sock)) sock.reply(c.id, { text: 'ok' });
    const results = await Promise.all(pending);
    for (const r of results.slice(0, 9)) assert.equal(r.text, 'ok');
    for (const [i, r] of results.slice(9).entries()) {
      assert.equal(r.isError, true);
      assert.equal(r.text, `This UniDeX app is older than ${fresh[i]}: ask the user to update UniDeX, and use the other computer_* tools meanwhile.`);
    }
    client.stop();
  }
});

test('a double click on an app with no list is refused without a write', async () => {
  const { client, sock } = make();
  const p = client.call('computer_click', { ref: 'e1', double: true });
  await tick(); sock.admit({ admitted: true, session: 's' });
  const r = await p;
  assert.equal(r.isError, true);
  assert.equal(r.text, 'This UniDeX app is older than double clicks: ask the user to update UniDeX, and click once meanwhile.');
  assert.equal(calls(sock).length, 0);
  // a plain click, and a click with double:false, still go out
  const a = client.call('computer_click', { ref: 'e1' });
  const b = client.call('computer_click', { ref: 'e1', double: false });
  await tick(); assert.equal(calls(sock).length, 2);
  for (const c of calls(sock)) sock.reply(c.id, { text: 'ok' });
  assert.equal((await a).text, 'ok'); assert.equal((await b).text, 'ok');
  client.stop();
});

test('an app that lists thirteen gets all thirteen', async () => {
  const { client, sock } = make();
  const pending = COMPUTER_TOOLS.map((t) => client.call(t, t === 'computer_click' ? { ref: 'e1', double: true } : {}));
  await tick(); sock.admit({ admitted: true, session: 's', tools: [...COMPUTER_TOOLS] });
  await tick();
  assert.deepEqual(calls(sock).map((c) => c.tool), [...COMPUTER_TOOLS]);
  assert.deepEqual(calls(sock).find((c) => c.tool === 'computer_click').args, { ref: 'e1', double: true });
  for (const c of calls(sock)) sock.reply(c.id, { text: 'ok' });
  for (const r of await Promise.all(pending)) assert.equal(r.text, 'ok');
  client.stop();
});
