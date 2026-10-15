'use strict';
// `aos local` (spec 2026-10-14-local-first A8, A12, A13, A18) against a temp vault: the engine is faked at its seams
// (deps.localModels, deps.pull) and AOS_SKIP_OLLAMA_PROBE, so nothing reaches an Ollama on this machine.
// provider.js, config.js and models.js fix the vault when first required (lib/paths.js), so this file keeps one vault.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-local-cli-')));
const HOME = path.join(TMP, 'home');
const VAULT = path.join(HOME, 'Vault');
const CFG_DIR = path.join(HOME, '.claude');
const USER_CFG = path.join(CFG_DIR, 'agenticos.json');
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
fs.mkdirSync(CFG_DIR, { recursive: true });
process.env.AOS_VAULT = VAULT;
process.env.AOS_CONFIG = USER_CFG;
process.env.CLAUDE_CONFIG_DIR = CFG_DIR;
process.env.CODEX_HOME = path.join(HOME, '.codex');

const L = require('./local.js');
const { recordLocalCall } = require('../brain/scripts/sdk/lib/local-usage.js');

const VAULT_CFG = path.join(VAULT, 'brain', 'config.json');
function setConfig(vaultCfg = {}) {
  fs.writeFileSync(VAULT_CFG, JSON.stringify({ provider: 'local', ...vaultCfg }));
  fs.writeFileSync(USER_CFG, JSON.stringify({ vault: VAULT, provider: 'local' }));
}
function io() {
  const lines = [];
  return { lines, log: (l) => lines.push(String(l)), error: (l) => lines.push(`ERR ${l}`) };
}
const engine = (...models) => ({ localModels: async () => models });

beforeEach(() => {
  setConfig();
  try { fs.unlinkSync(path.join(VAULT, 'brain', '_index', 'local-usage.json')); } catch { /* none yet */ }
  delete process.env.AOS_SKIP_OLLAMA_PROBE;
});

test('status --json: engine, tier (the suite\'s 32 GB Mac), the model that runs, the embedder, today\'s calls', async () => {
  recordLocalCall({ feature: 'file-map', ms: 1200 });
  const out = io();
  assert.equal(await L.main(['status', '--json'], { io: out, deps: engine('qwen3.5:9b', 'qwen3-embedding:0.6b') }), 0);
  const r = JSON.parse(out.lines.join('\n'));
  assert.deepEqual([r.provider, r.engine, r.url, r.reachable, r.memoryGb, r.tier], ['local', 'ollama', 'http://127.0.0.1:11434', true, 32, 'qwen3.5:9b']);
  assert.deepEqual(r.workhorse, { tag: 'qwen3.5:9b', source: 'tier', pulled: true, running: 'qwen3.5:9b', keepAlive: -1 });
  assert.deepEqual(r.embedder, { tag: 'qwen3-embedding:0.6b', pulled: true });
  assert.equal(r.why, null);
  assert.deepEqual([r.today.calls, r.today.byFeature], [1, { 'file-map': 1 }]);
});

test('status: nothing answering, a model not pulled, and no probe each say why in a line', async () => {
  let out = io();
  await L.main([], { io: out, deps: { localModels: async () => null } });
  assert.match(out.lines.join('\n'), /engine {5}ollama at http:\/\/127\.0\.0\.1:11434 · not answering/);
  assert.match(out.lines.join('\n'), /running on nothing: nothing answers at/);
  out = io();
  await L.main(['status'], { io: out, deps: engine('llama3.2:latest') });
  assert.match(out.lines.join('\n'), /running on nothing: qwen3\.5:9b is not pulled — aos local pull/);
  assert.match(out.lines.join('\n'), /embedder {3}qwen3-embedding:0\.6b · pulled no \(recall uses keyword search\)/);
  assert.match(out.lines.join('\n'), /pulled {5}llama3\.2:latest/);
  process.env.AOS_SKIP_OLLAMA_PROBE = '1';
  out = io();
  await L.main(['status', '--json'], { io: out, deps: { localModels: async () => { throw new Error('must not probe'); } } });
  const r = JSON.parse(out.lines.join('\n'));
  assert.deepEqual([r.probed, r.reachable, r.why], [false, false, 'not probed (AOS_SKIP_OLLAMA_PROBE=1)']);
});

test('status under auto says background work is local only with provider local', async () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({ vault: VAULT, provider: 'auto' }));
  const out = io();
  await L.main(['status'], { io: out, deps: engine('qwen3.5:9b') });
  assert.match(out.lines[0], /^provider {3}auto — background work is local only with provider local \(aos provider local\)$/);
});

test('pull: this Mac\'s workhorse and embedder by default, a line per status and per 10%; named models as given', async () => {
  const pulled = [];
  const pull = async (model, o) => {
    pulled.push([model, o.port]);
    o.onProgress({ status: 'pulling manifest' });
    o.onProgress({ status: 'downloading', completed: 0, total: 4e9 });
    o.onProgress({ status: 'downloading', completed: 1e9, total: 4e9 });
    o.onProgress({ status: 'downloading', completed: 1.1e9, total: 4e9 });
    o.onProgress({ status: 'success' });
  };
  let out = io();
  assert.equal(await L.main(['pull'], { io: out, deps: { pull } }), 0);
  assert.deepEqual(pulled, [['qwen3.5:9b', 11434], ['qwen3-embedding:0.6b', 11434]]);
  assert.deepEqual(out.lines.slice(0, 5), ['pulling qwen3.5:9b…', '  pulling manifest', '  0% of 4.0 GB', '  20% of 4.0 GB', '  success']);
  assert.equal(out.lines.at(-1), 'done: qwen3.5:9b, qwen3-embedding:0.6b');
  out = io();
  await L.main(['pull', 'qwen3.5:27b'], { io: out, deps: { pull } });
  assert.deepEqual(pulled.at(-1), ['qwen3.5:27b', 11434]);
});

test('pull refuses on an OpenAI-compatible engine: its own app downloads models', async () => {
  setConfig({ local: { engine: 'openai' } });
  await assert.rejects(() => L.main(['pull'], { io: io(), deps: { pull: async () => { throw new Error('no'); } } }), /local engine is openai at http:\/\/127\.0\.0\.1:1234\/v1/);
});

test('use <model> sets local.model through aos config, and says when it is not pulled', async () => {
  const out = io();
  assert.equal(await L.main(['use', 'qwen3.5:27b'], { io: out, deps: engine('qwen3.5:9b') }), 0);
  const written = { ...JSON.parse(fs.readFileSync(VAULT_CFG, 'utf8')), ...JSON.parse(fs.readFileSync(USER_CFG, 'utf8')) };
  assert.equal(written.local.model, 'qwen3.5:27b');
  assert.match(out.lines.at(-1), /^note: qwen3\.5:27b is not pulled yet — aos local pull qwen3\.5:27b$/);
});

test('usage: an unknown verb, extra words, and use without a model', async () => {
  await assert.rejects(() => L.main(['nope'], { io: io() }), L.UsageError);
  await assert.rejects(() => L.main(['status', 'x'], { io: io() }), L.UsageError);
  await assert.rejects(() => L.main(['use'], { io: io() }), L.UsageError);
});
