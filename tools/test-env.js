'use strict';
/**
 * test-env.js — one clean environment for every test suite (spec 2026-09-23-ci-safety-net-design D4). Preloaded by
 * the root suite (`node --require ./tools/test-env.js --test …`), brain/scripts/test/setup.js and the HUD's test script.
 *
 * The suites used to inherit the developer's shell: an exported CODEX_HOME, CLAUDE_CONFIG_DIR, AOS_HOST or AOS_VAULT
 * pointed tests at real host folders or flipped scripts into hook mode. This deletes every host and runtime variable
 * (AOS_*, BRAIN_*, CLAUDE*, CODEX_*, AUTO_WRAP_*) except AOS_PRIVACY_TERMS (the private gate terms CI passes on
 * purpose), then marks the environment clean. Tests set these variables on purpose for the children they spawn, and a
 * NODE_OPTIONS preload runs in every child, so a process that already carries the marker changes nothing: the scrub
 * runs once, in the top-level runner, and every test-file process inherits its result.
 *
 * The temp root: suites make their fixtures with fs.mkdtempSync(path.join(os.tmpdir(), …)) and almost none removes them,
 * so the OS temp folder filled with hundreds of thousands of leftovers. The top-level runner therefore makes one folder
 * of its own, aos-testrun-<pid>-<six chars>, points TMPDIR at it (every child inherits it, so os.tmpdir() answers the
 * root everywhere) and removes it when it exits. The top-level runner owns the root: a child never makes or removes one.
 * At start it also removes the roots of runs that were killed (their pid is no longer running).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = 'AOS_TEST_ENV_CLEAN';
const KEEP = new Set(['AOS_PRIVACY_TERMS', MARKER]);
const PREFIXES = ['AOS_', 'BRAIN_', 'CLAUDE', 'CODEX_', 'AUTO_WRAP_'];

/** Delete the host variables from `env` unless it is already marked clean. Returns the names removed. */
function scrub(env = process.env) {
  if (env[MARKER] === '1') return [];
  const removed = [];
  for (const k of Object.keys(env)) {
    if (KEEP.has(k) || !PREFIXES.some((p) => k.startsWith(p))) continue;
    delete env[k];
    removed.push(k);
  }
  env[MARKER] = '1';
  // local-first A12 picks the local model by the Mac's memory: every suite sees a 32 GB Mac (the large tier, a resident
  // workhorse) whatever machine runs it — CI's macOS runners have 7 GB. A test of the tiers pins its own value.
  env.AOS_TOTALMEM = String(32 * 1024 ** 3);
  return removed;
}

const ROOT_NAME = /^aos-testrun-(\d+)-[A-Za-z0-9]{6}$/;

/** True when `pid` is a running process; EPERM means it exists but is not ours. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Remove the run roots in `tmp` whose pid is not running. Real directories only, never a symlink's target. Never throws. */
function sweepStale(tmp, alive = pidAlive) {
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return; }
  for (const name of names) {
    const m = ROOT_NAME.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    try {
      const p = path.join(tmp, name);
      if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* a leftover that cannot be removed stays */ }
  }
}

/** Make this run's root under `tmp`. */
function makeRunRoot(tmp, pid) {
  return fs.mkdtempSync(path.join(tmp, 'aos-testrun-' + pid + '-'));
}

// Only the process that finds the environment unmarked is the top-level runner; it owns the temp root.
const topLevel = process.env[MARKER] !== '1';
scrub();
if (topLevel) {
  const tmp = os.tmpdir();
  sweepStale(tmp);
  try {
    const root = makeRunRoot(tmp, process.pid);
    process.env.TMPDIR = root;
    // Only the top-level runner registers this: a child inherits the marker, so it never gets here and cannot remove the root.
    process.on('exit', () => {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    });
  } catch (e) {
    process.stderr.write('test-env: the temp root could not be made (' + e.message + '); using the temp folder as it is\n');
  }
}

module.exports = { scrub, MARKER, PREFIXES, sweepStale, makeRunRoot };
