#!/usr/bin/env node
'use strict';
/**
 * SessionStart hook (Codex host) — names the conversation a Code terminal's agent just started
 * (spec 2026-11-10-codex-session-claim D1).
 *
 * Codex can't be started with a session id, so Code's chat follower guesses a terminal's rollout from its folder and
 * start time, and two terminals started together can't be told apart (code-chat R75). Each Code terminal carries its key
 * in AOS_TERMINAL; this hook writes <vault>/brain/_index/code/<terminal>.session.json with the payload's session_id on
 * every SessionStart source (startup, resume, clear, compact, fork), and the follower acts on it (lib/code-mirror.js).
 * Claude Code needs no such hook: it is started with --session-id and its status-line tee names each change (D2).
 *
 * Outside a Code terminal (no AOS_TERMINAL) it does nothing. It prints nothing (a Codex SessionStart hook's stdout
 * becomes model context) and exits 0 on every path.
 */
const { PATHS } = require('./lib/hook-entry.js').hookEntry();

function report({ env = process.env, payload, vault = PATHS.VAULT, now = new Date() } = {}) {
  const terminal = env.AOS_TERMINAL;
  if (!terminal || !payload || typeof payload !== 'object') return null;
  const host = require('./lib/host.js').currentHost(env, payload);
  return require('./lib/code-mirror.js').writeSessionReport(vault, {
    terminal, host, sessionId: payload.session_id || payload.sessionId, source: payload.source, now,
  });
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try { report({ payload: JSON.parse(raw || '{}') }); } catch (_) { /* never block the session */ }
    process.exit(0);
  });
}

module.exports = { report };
