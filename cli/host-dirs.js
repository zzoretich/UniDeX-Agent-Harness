'use strict';
/**
 * host-dirs.js — the CLI's way to the runtime's lib/host.js (the vendored copy beside this file, else the checkout's)
 * for the hosts' folders: Claude Code's config dir (agenticos.json's home) and Codex's home. One lookup for every CLI
 * file, and the one that refuses a test run without the test environment (lib/test-guard.js) before it falls back to the
 * real home directory.
 */
const fs = require('fs');
const path = require('path');

let host = null;
function lib() {
  if (host) return host;
  for (const p of [path.join(__dirname, '..', 'lib', 'host.js'), path.join(__dirname, '..', 'brain', 'scripts', 'lib', 'host.js')]) {
    if (fs.existsSync(p)) { host = require(p); return host; }
  }
  throw new Error('lib/host.js not found beside the CLI — run `aos upgrade`');
}

/** CLAUDE_CONFIG_DIR, else Claude Code's default config dir: where agenticos.json lives. */
function claudeConfigDir(env = process.env) { return lib().claudeConfigDir(env); }
/** hosts.codex.home in agenticos.json, else CODEX_HOME, else Codex's default home. */
function codexHome(cfg = null, env = process.env) { return lib().codexHome(env, cfg); }

module.exports = { claudeConfigDir, codexHome };
