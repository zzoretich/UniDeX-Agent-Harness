'use strict';
/**
 * computer-client.js — the agenticos MCP server's side of the UniDeX app's computer bridge (agent-computer D19, D21).
 *
 * One Unix-socket connection per MCP server process, opened by start() before the MCP transport connects and never
 * awaited. The app publishes the socket path in the vault marker (hud-host.json `computerSocket`), `computer: "off"`
 * when it runs with the Computer surface off, or `computer: "failed"` when its bridge did not start, so a call says which
 * rather than that the app is missing; a marker whose app process is gone (a crash, `pid`) counts as no app.
 * Protocol, one JSON object per "\n"-terminated UTF-8 line:
 *   client → {"hello":1}                                   server → {"admitted":true,"session":"…","tools"?:[…]} | {"admitted":false,"reason":"…"}
 *   client → {"id":n,"tool":"computer_open","args":{…}}    server → {"id":n,"text":"…","image"?:{data,mimeType},"isError"?:true}
 * The bridge admits the first connection per CLI and closes on any protocol breach, so a closed socket is final: this
 * client never reconnects (D21). call() never rejects; every failure is a result with isError.
 * session-browser R1: an app that does not know a tool's name ends the connection, and the runtime and the app update
 * separately, so a tool goes out only if the admission answer's `tools` list names it; with no list the app takes the
 * nine tools it had before the list existed, and a double click needs a list (an older app would click once).
 */

const NO_APP = 'The UniDeX browser is not reachable because this session was not started from the UniDeX app: use another browser tool, or ask the user to start the session from UniDeX\'s Code page or a Chat thread.';
// The app's marker says the UniDeX browser is turned off for this run of the app (agent-computer D26): a run whose write
// surfaces leave it out, so no bridge listens, by design. (The person's own switch, computer.enabled, answers from the bridge itself.)
const OFF = 'The UniDeX browser is turned off in Settings for this run of the app: use another browser tool, or ask the user to turn the Computer pane on and restart UniDeX.';
// The marker says the surface is on but the bridge did not start (no peer addon, no socket path, a failed listen).
const FAILED = 'The UniDeX browser could not start in this run of the app: ask the user to quit and reopen UniDeX, whose log has the reason.';
const CLOSED = 'The UniDeX app closed, so its browser is gone for the rest of this session: use another browser tool.';
const TIMEOUT = 'The UniDeX app did not answer in time: call computer_status to see whether the browser is still there.';

// The nine tools an app that sends no `tools` list takes (every app before session-browser).
const NINE_OLD = ['computer_open', 'computer_snapshot', 'computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_wait', 'computer_status'];
const olderThan = (what, then) => `This UniDeX app is older than ${what}: ask the user to update UniDeX, and ${then} meanwhile.`;

function failure(text) { return { text, isError: true }; }

const hudHost = require('../../lib/hud-host.js');

function createComputerClient({ vault, net = require('net'), readMarker = hudHost.readMarker, alive = hudHost.alive, timeoutMs = 50000 }) {
  // 'idle' → 'connecting' → 'ready' | 'failed' (terminal; `failure` holds the result every call then gets).
  let state = 'idle';
  let failed = null;
  let sock = null;
  let taken = NINE_OLD; // the tool names the app takes; the admission answer's list replaces it
  let listed = false;
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
      if (msg.admitted === true) {
        if (Array.isArray(msg.tools) && msg.tools.every((t) => typeof t === 'string')) { taken = msg.tools; listed = true; }
        settle('ready');
      }
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
        // Never write what the app would end the connection over (session-browser R1).
        if (!taken.includes(tool)) return finish(failure(olderThan(tool, 'use the other computer_* tools')));
        if (tool === 'computer_click' && args && args.double === true && !listed) return finish(failure(olderThan('double clicks', 'click once')));
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
