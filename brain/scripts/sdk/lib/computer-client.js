'use strict';
/**
 * computer-client.js — the agenticos MCP server's side of the UniDeX app's computer bridge (agent-computer D19, D21).
 *
 * One Unix-socket connection per MCP server process, opened by start() before the MCP transport connects and never
 * awaited. The app publishes the socket path in the vault marker (hud-host.json `computerSocket`), `computer: "off"`
 * when it runs with the Computer surface off, or `computer: "failed"` when its bridge did not start, so a call says which
 * rather than that the app is missing; a marker whose app process is gone (a crash, `pid`) counts as no app.
 * Protocol, one JSON object per "\n"-terminated UTF-8 line:
 *   client → {"hello":1}                                   server → {"admitted":true,"session":"…"} | {"admitted":false,"reason":"…"}
 *   client → {"id":n,"tool":"computer_open","args":{…}}    server → {"id":n,"text":"…","image"?:{data,mimeType},"isError"?:true}
 * The bridge admits the first connection per CLI and closes on any protocol breach, so a closed socket is final: this
 * client never reconnects (D21). call() never rejects; every failure is a result with isError.
 */

const NO_APP = 'The Computer pane needs the UniDeX app running, with this session started from it (the Code page\'s New menu or a Chat thread).';
// The app's marker says it runs with the Computer surface off (agent-computer D26): a run whose write surfaces leave it
// out, so no bridge listens, by design. (The person's own switch, computer.enabled, answers from the bridge itself.)
const OFF = 'The Computer pane is turned off in this UniDeX run, so this session cannot use the computer tools.';
// The marker says the surface is on but the bridge did not start (no peer addon, no socket path, a failed listen).
const FAILED = 'The Computer pane couldn\'t start in UniDeX. Quit and reopen the app; the app\'s log has the reason.';
const CLOSED = 'The UniDeX app closed: the computer is unavailable for the rest of this session.';
const TIMEOUT = 'The UniDeX app didn\'t answer in time.';

function failure(text) { return { text, isError: true }; }

const hudHost = require('../../lib/hud-host.js');

function createComputerClient({ vault, net = require('net'), readMarker = hudHost.readMarker, alive = hudHost.alive, timeoutMs = 50000 }) {
  // 'idle' → 'connecting' → 'ready' | 'failed' (terminal; `failure` holds the result every call then gets).
  let state = 'idle';
  let failed = null;
  let sock = null;
  let nextId = 1;
  const pending = new Map(); // id → resolve
  const waiting = new Set(); // calls waiting for the hello answer: resolve(state) once settled
  let buf = '';

  function settle(next, result) {
    if (state === 'failed') return;
    state = next;
    if (next === 'failed') failed = result;
    for (const w of waiting) w();
    waiting.clear();
    if (next === 'failed') {
      for (const resolve of pending.values()) resolve(result);
      pending.clear();
    }
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (state === 'connecting') {
      if (msg.admitted === true) settle('ready');
      else if (msg.admitted === false) settle('failed', failure(typeof msg.reason === 'string' && msg.reason ? msg.reason : NO_APP));
      return;
    }
    if (typeof msg.id !== 'number') return;
    const resolve = pending.get(msg.id);
    if (!resolve) return; // unknown or already timed out: ignored
    pending.delete(msg.id);
    const out = { text: typeof msg.text === 'string' ? msg.text : '' };
    if (msg.image && typeof msg.image.data === 'string') out.image = { data: msg.image.data, mimeType: 'image/png' };
    if (msg.isError === true) out.isError = true;
    resolve(out);
  }

  function start() {
    if (state !== 'idle') return;
    let marker = null;
    try { marker = readMarker(vault); } catch { /* no marker */ }
    try { if (marker && !alive(marker)) marker = null; } catch { /* keep it */ }
    if (!marker || !marker.computerSocket) {
      settle('failed', failure(marker && marker.computer === 'off' ? OFF : marker && marker.computer === 'failed' ? FAILED : NO_APP));
      return;
    }
    state = 'connecting';
    try {
      sock = net.createConnection(marker.computerSocket);
    } catch { settle('failed', failure(NO_APP)); return; }
    sock.unref(); // an open bridge socket must not keep the MCP server alive after its host is gone
    sock.setEncoding('utf8'); // multibyte characters split across reads survive
    sock.on('connect', () => { try { sock.write('{"hello":1}\n'); } catch { /* close follows */ } });
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    });
    // Before admission an unreachable socket means no app; after it, any end is the app going away.
    const gone = () => settle('failed', failure(state === 'connecting' ? NO_APP : CLOSED));
    sock.on('error', gone);
    sock.on('close', gone);
  }

  function call(tool, args) {
    start();
    return new Promise((resolve) => {
      let timer = null;
      let id = null;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiting.delete(go);
        if (id !== null) pending.delete(id);
        resolve(result);
      };
      timer = setTimeout(() => finish(failure(TIMEOUT)), timeoutMs);
      function go() {
        if (done) return;
        if (state === 'failed') return finish(failed);
        if (state !== 'ready') { waiting.add(go); return; }
        id = nextId++;
        pending.set(id, finish);
        try { sock.write(JSON.stringify({ id, tool, args: args || {} }) + '\n'); } catch { finish(failure(CLOSED)); }
      }
      go();
    });
  }

  function stop() { if (sock) sock.destroy(); }

  return { start, call, stop };
}

module.exports = { createComputerClient, NO_APP, OFF, FAILED, CLOSED, TIMEOUT };
