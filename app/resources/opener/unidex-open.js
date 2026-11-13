#!/usr/bin/env node
'use strict';
// The command every UniDeX session's BROWSER points at (session-browser S23). A program in a session (a dev server, `gh`,
// `open`-style helpers that honour $BROWSER) runs it with a web address; it asks the app's door to open that address in
// the session's in-app browser. Anything it cannot hand to the door goes where it would have gone without UniDeX: the
// BROWSER that was set before, or the system's opener. It prints only two fixed lines on standard error (the sandbox
// one and the no-answer one), and never the address or the id: an address can carry a secret in its query.

const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ID = /^[0-9a-f]{32}$/;
const CONNECT_MS = 3000;
const NO_ANSWER = 'unidex-open: the UniDeX browser did not answer. Use the computer_open tool to open the address.\n';
const SANDBOXED = "unidex-open: this session's sandbox blocks the UniDeX browser. Use the computer_open tool to open the address.\n";

/** What AOS_BROWSER_SESSION says ({id, door, prev}), or null when it is missing or not that. */
function readSession(env) {
  const raw = env.AOS_BROWSER_SESSION;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    if (typeof v.id !== 'string' || !ID.test(v.id)) return null;
    if (typeof v.door !== 'string' || !v.door) return null;
    if (v.prev !== null && v.prev !== undefined && typeof v.prev !== 'string') return null;
    return { id: v.id, door: v.door, prev: v.prev || null };
  } catch { return null; }
}

function isWeb(url) {
  try { const p = new URL(url).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

/**
 * Where an address goes. The last argument is the address. With a readable variable a web address goes to the door; any
 * other address goes to the BROWSER that was set before, or the system's opener when none was. Without a readable
 * variable the previous BROWSER is unknown (it travels only inside that variable): the system's opener.
 */
function route(argv, env) {
  const url = argv.length ? String(argv[argv.length - 1]) : '';
  const s = readSession(env);
  if (!s) return { to: 'system', url };
  if (isWeb(url)) return { to: 'door', door: s.door, id: s.id, url };
  return s.prev ? { to: 'prev', cmd: s.prev, url } : { to: 'system', url };
}

/** What every program the opener starts gets: the session variable stays behind, so an opener reached as the previous
 *  BROWSER (an app started inside another session) has none to read and goes to the system's opener: two deep at most. */
function childEnv(env) {
  const out = { ...env };
  delete out.AOS_BROWSER_SESSION;
  return out;
}

function runAndExit(file, args, env) {
  const child = spawn(file, args, { stdio: 'inherit', env: childEnv(env) });
  child.on('error', () => process.exit(127));
  // A program killed by a signal ends us as a shell reports it: 128 plus the signal's number.
  child.on('exit', (code, signal) => process.exit(code === null ? 128 + (os.constants.signals[signal] || 0) : code));
}

/** What a route that is not the door does: runs the previous BROWSER (through sh, so a command with arguments works) or
 *  the system's opener (`deps.open`, /usr/bin/open: replaceable only by an argument, so a test never opens a real browser). */
function fallback(r, env, deps) {
  if (r.to === 'prev') return runAndExit('/bin/sh', ['-c', r.cmd + ' "$1"', 'sh', r.url], env);
  return runAndExit((deps && deps.open) || '/usr/bin/open', [r.url], env);
}

/**
 * Sends the address to the door and reads its one answer line: {"ok":true} ends 0; {"ok":false} ends 0 with nothing
 * opened anywhere (the door refused: the limit, Read only, the quiet period); {"ok":false,"off":true} (the door is not
 * enabled) goes where a door that cannot be reached goes, silently. A connection that ends, errors or stays silent for
 * 3 s without a whole answer line ends 1 with NO_ANSWER and no fallback: the door may have taken the address, and a
 * fallback could open it twice. A connection that cannot be made is the unreachable-door fallback.
 */
function toDoor(r, env, deps) {
  const prev = readSession(env).prev;
  const back = () => fallback(prev ? { to: 'prev', cmd: prev, url: r.url } : { to: 'system', url: r.url }, env, deps);
  let connected = false;
  let settled = false;
  let buf = '';
  let timer = null;
  const sock = net.createConnection(r.door);
  const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); fn(); };
  const unanswered = () => finish(() => { process.stderr.write(NO_ANSWER); process.exit(1); });
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => (connected ? unanswered() : finish(back)), CONNECT_MS); };
  arm();
  sock.setEncoding('utf8');
  sock.on('connect', () => { connected = true; arm(); sock.write(JSON.stringify({ id: r.id, url: r.url }) + '\n'); });
  sock.on('data', (chunk) => {
    if (settled) return;
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    let answer = null;
    try { answer = JSON.parse(buf.slice(0, nl)); } catch { /* not an answer */ }
    if (answer === null || typeof answer !== 'object' || typeof answer.ok !== 'boolean') return unanswered();
    if (answer.ok === false && answer.off === true) return finish(back);
    finish(() => process.exit(0));
  });
  sock.on('end', () => (connected ? unanswered() : finish(back)));
  sock.on('close', () => (connected ? unanswered() : finish(back)));
  sock.on('error', (err) => {
    if (connected) return unanswered();
    finish(() => {
      // A host's command sandbox refuses the connection itself: say so once, so the agent can use computer_open.
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) process.stderr.write(SANDBOXED);
      back();
    });
  });
}

/** Does what `route` decided. */
function act(r, env, deps) {
  if (!r.url) process.exit(2);
  if (r.to === 'door') toDoor(r, env, deps);
  else fallback(r, env, deps);
}

if (require.main === module) act(route(process.argv.slice(2), process.env), process.env);

module.exports = { route, act };
