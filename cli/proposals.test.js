'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../brain/scripts/persona/proposal.js');

const CLI = path.join(__dirname, 'aos.js');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-proposals-cli-'));
  fs.mkdirSync(path.join(root, 'persona', 'proposals'), { recursive: true });
  const name = '2026-10-30-routing.md';
  fs.writeFileSync(path.join(root, 'persona', 'PLAYBOOK.md'), 'old\n');
  const change = { op: 'replace', path: 'persona/PLAYBOOK.md', base: P.hash(Buffer.from('old\n')), content: 'new\n' };
  fs.writeFileSync(path.join(root, 'persona', 'proposals', name), [
    '---', 'slug: routing', 'kind: self', 'recheck: "grep old persona/PLAYBOOK.md"', 'changes: |',
    ...JSON.stringify([change]).split('\n').map((line) => `  ${line}`), '---', '', '# Routing', '',
  ].join('\n'));
  const config = path.join(root, 'agenticos.json');
  fs.writeFileSync(config, JSON.stringify({ vault: root }));
  return { root, name, config };
}
function run(w, args) { return spawnSync(process.execPath, [CLI, 'proposals', ...args], { env: { ...process.env, AOS_CONFIG: w.config }, encoding: 'utf8' }); }

test('proposals CLI lists and previews exact changes but has no approval verb', () => {
  const w = fixture();
  const before = fs.readFileSync(path.join(w.root, 'persona', 'PLAYBOOK.md'), 'utf8');
  const listed = run(w, ['list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).map(({ name, exact }) => ({ name, exact })), [{ name: w.name, exact: true }]);
  const preview = run(w, ['preview', w.name, '--json']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).changes[0].content, 'new\n');
  const refused = run(w, ['approve', w.name]);
  assert.equal(refused.status, 2);
  assert.equal(fs.readFileSync(path.join(w.root, 'persona', 'PLAYBOOK.md'), 'utf8'), before);
});
