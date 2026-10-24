'use strict';
/**
 * test-guard.js — a test never touches the real vault, agenticos.json or a host's home. Every suite runs with
 * tools/test-env.js preloaded (`npm test`, `npm run test:one -- <file>`, CI), which scrubs the host variables, points the
 * vault and the hosts' folders at temp dirs (brain/scripts/test/setup.js) and marks the environment AOS_TEST_ENV_CLEAN=1.
 * A test file run by hand with plain `node --test <file>` (or `node <file>.test.js`) has none of that: the vault resolver
 * found the owner's own vault through ~/.claude/agenticos.json, and a test wrote into it. So under the Node test runner
 * without the marker, the resolvers that would fall back to the real locations (lib/paths.js, lib/host.js, cli/aos.js
 * and the CLI's other config-dir lookups) throw this before anything is read or written. Inert outside tests: nothing in
 * production runs under the test runner.
 */
const MARKER = 'AOS_TEST_ENV_CLEAN';

class UnsafeTestEnv extends Error {
  constructor(msg) { super(msg); this.name = 'UnsafeTestEnv'; this.code = 'UNSAFE_TEST_ENV'; }
}

/** This process runs tests: under `node --test` (its file processes carry NODE_TEST_CONTEXT, and so do their children),
 *  with a --test flag of its own, or as a test file run directly. */
function underTestRunner({ env = process.env, argv = process.argv, execArgv = process.execArgv } = {}) {
  return !!env.NODE_TEST_CONTEXT
    || execArgv.some((a) => a === '--test' || a.startsWith('--test-'))
    || /\.test\.[cm]?[jt]s$/.test(String(argv[1] || ''));
}

/** Throws UnsafeTestEnv when a test is about to resolve `what` (a real location) without the test environment. */
function guardTestEnv(what, opts = {}) {
  const env = opts.env || process.env;
  if (env[MARKER] === '1' || !underTestRunner({ env, argv: opts.argv, execArgv: opts.execArgv })) return;
  throw new UnsafeTestEnv(`refusing to resolve ${what}: this test runs without the test environment, so it would read and write the real vault and config. `
    + 'Run tests through `npm test`, or one file with `npm run test:one -- <file>` (node --require ./tools/test-env.js --test <file>).');
}

/**
 * Throws UnsafeTestEnv when a test is about to use the real OS scheduler: launchd's LaunchAgents folder in the real
 * home, or the real launchctl or crontab binary. Unlike guardTestEnv it holds with the test environment too:
 * tools/test-env.js scrubs variables but cannot move launchd, and a test that reached cli/schedule.js's defaults rewrote
 * the owner's tick plist and deleted the legacy duties' plists (spec 2026-10-24-persona-learning-loop-design D11). Every
 * test injects launchAgentsDir and exec, sets the AOS_LAUNCHCTL_BIN / AOS_CRONTAB_BIN seams, or runs its child under a
 * temp HOME.
 */
function guardRealScheduler(what, opts = {}) {
  const env = opts.env || process.env;
  if (!underTestRunner({ env, argv: opts.argv, execArgv: opts.execArgv })) return;
  throw new UnsafeTestEnv(`refusing to use ${what} under the test runner: a test never schedules, loads or deletes a real job. `
    + 'Inject launchAgentsDir and exec (or readCrontab/writeCrontab), or set AOS_LAUNCHCTL_BIN / AOS_CRONTAB_BIN.');
}

module.exports = { MARKER, UnsafeTestEnv, underTestRunner, guardTestEnv, guardRealScheduler };
