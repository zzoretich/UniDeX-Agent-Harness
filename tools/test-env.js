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
 */
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

scrub();

module.exports = { scrub, MARKER, PREFIXES };
