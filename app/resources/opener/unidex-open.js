#!/usr/bin/env node
'use strict';
// The command every UniDeX session's BROWSER points at (session-browser S23). A program in a session (a dev server, `gh`,
// `open`-style helpers that honour $BROWSER) runs it with a web address; it asks the app's door to open that address in
// the session's in-app browser. Anything it cannot hand to the door goes where it would have gone without UniDeX: the
// BROWSER that was set before, or the system's opener. It prints nothing, and never the address or the id: an address
// can carry a secret in its query.

const net = require('node:net');
const { spawn } = require('node:child_process');

const ID = /^[0-9a-f]{32}$/;
const CONNECT_MS = 3000;
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

function runAndExit(file, args) {
  const child = spawn(file, args, { stdio: 'inherit' });
  child.on('error', () => process.exit(127));
  child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 128 : 1) : code));
}

/** What a route that is not the door does: runs the previous BROWSER (through sh, so a command with arguments works) or the system's opener. */
function fallback(r) {
  if (r.to === 'prev') return runAndExit('/bin/sh', ['-c', r.cmd + ' "$1"', 'sh', r.url]);
  return runAndExit('/usr/bin/open', [r.url]);
}

function toDoor(r, env) {
  const prev = readSession(env).prev;
  const back = () => fallback(prev ? { to: 'prev', cmd: prev, url: r.url } : { to: 'system', url: r.url });
  let connected = false;
  let settled = false;
  const sock = net.createConnection(r.door);
  const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); fn(); };
  // Connected, the line is written and then only read: an answer, a close or silence all end it with 0.
  const timer = setTimeout(() => finish(() => (connected ? process.exit(0) : back())), CONNECT_MS);
  sock.on('connect', () => { connected = true; sock.write(JSON.stringify({ id: r.id, url: r.url }) + '\n'); });
  sock.on('data', () => {});
  sock.on('end', () => finish(() => process.exit(0)));
  sock.on('close', () => finish(() => (connected ? process.exit(0) : back())));
  sock.on('error', (err) => {
    if (connected) return finish(() => process.exit(0));
    finish(() => {
      // A host's command sandbox refuses the connection itself: say so once, so the agent can use computer_open.
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) process.stderr.write(SANDBOXED);
      back();
    });
  });
}

if (require.main === module) {
  const r = route(process.argv.slice(2), process.env);
  if (!r.url) process.exit(2);
  if (r.to === 'door') toDoor(r, process.env);
  else fallback(r);
}

module.exports = { route };
