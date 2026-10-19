#!/usr/bin/env node
'use strict';
/**
 * test-one.js — `npm run test:one -- <file>…`: run test files the way their suite does, never against the real vault.
 * brain/scripts tests get test/setup.js in every process (a temp vault, config dir and Codex home; it loads
 * tools/test-env.js), HUD tests tools/test-env.js and tsx, and the rest (cli/, tools/) tools/test-env.js, as `npm test`
 * runs them. A plain `node --test <file>` runs none of that, and lib/test-guard.js refuses it.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const files = process.argv.slice(2).map((f) => path.resolve(f));
if (!files.length) {
  process.stderr.write('usage: npm run test:one -- <test file>… (brain/scripts/test, hud, cli or tools)\n');
  process.exit(2);
}
const under = (dir) => (f) => f.startsWith(path.join(ROOT, dir) + path.sep);
const suites = [
  { match: under('brain/scripts'), cwd: path.join(ROOT, 'brain', 'scripts'), args: [], env: { NODE_OPTIONS: `--require=${path.join(ROOT, 'brain', 'scripts', 'test', 'setup.js')}` } },
  { match: under('hud'), cwd: path.join(ROOT, 'hud'), args: ['--require', path.join(ROOT, 'tools', 'test-env.js'), '--import', 'tsx'], env: {} },
  { match: () => true, cwd: ROOT, args: ['--require', path.join(ROOT, 'tools', 'test-env.js')], env: {} },
];
let status = 0;
for (const s of suites) {
  const mine = files.filter((f) => s.match(f) && !suites.slice(0, suites.indexOf(s)).some((x) => x.match(f)));
  if (!mine.length) continue;
  const r = spawnSync(process.execPath, [...s.args, '--test', ...mine], { cwd: s.cwd, env: { ...process.env, ...s.env }, stdio: 'inherit' });
  if (r.status !== 0) status = r.status || 1;
}
process.exit(status);
