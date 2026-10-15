'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../lib/headless.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-headless-'));
const exe = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p; };
const CLAUDE = exe('claude');
const CODEX = exe('codex');
const none = () => null;
const both = { hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true, bin: CODEX } }, codex: { model: 'gpt-5-mini' } };
const ENV = { PATH: '/usr/bin:/bin' };

test('resolveRunner: auto prefers claude, falls back to codex, and honours the enabled flags and the recorded binaries', () => {
  assert.deepEqual(H.resolveRunner({ cfg: both, kind: 'routines', env: ENV, lookup: none, candidates: false }), { host: 'claude', bin: CLAUDE, model: null, home: null, reason: 'auto' });
  const codexOnly = { ...both, hosts: { claude: { enabled: false, bin: CLAUDE }, codex: { enabled: true, bin: CODEX } } };
  assert.deepEqual(H.resolveRunner({ cfg: codexOnly, kind: 'persona', env: ENV, lookup: none, candidates: false }), { host: 'codex', bin: CODEX, model: 'gpt-5-mini', home: null, reason: 'auto' });
  const claudeGone = { ...both, hosts: { claude: { enabled: true, bin: '/nowhere/claude' }, codex: { enabled: true, bin: CODEX } } };
  assert.equal(H.resolveRunner({ cfg: claudeGone, env: ENV, lookup: none, candidates: false }).host, 'codex');
  const legacy = { claude: { bin: CLAUDE } };
  assert.equal(H.resolveRunner({ cfg: legacy, env: ENV, lookup: none, candidates: false }).host, 'claude', 'a pre-0.5.0 config (no hosts) is claude only');
  const legacyGone = { claude: { bin: '/nowhere/claude' }, codex: { bin: CODEX } };
  const r = H.resolveRunner({ cfg: legacyGone, env: ENV, lookup: none, candidates: false });
  assert.equal(r.host, null);
  assert.match(r.reason, /claude CLI not found; codex host disabled/);
  assert.equal(H.resolveRunner({ cfg: {}, env: ENV, lookup: (n) => (n === 'claude' ? CLAUDE : null), candidates: false }).bin, CLAUDE, 'PATH lookup');
  assert.equal(H.resolveRunner({ cfg: null, env: ENV, lookup: none, candidates: false }).host, null);
});

test('resolveRunner: <kind>.runner and AOS_RUNNER pin a host; AOS_NO_*, AOS_CODEX_BIN and PERSONA_CLAUDE_BIN steer the binaries', () => {
  const pinned = { ...both, routines: { runner: 'codex' }, persona: { runner: 'claude' } };
  assert.deepEqual(H.resolveRunner({ cfg: pinned, kind: 'routines', env: ENV, lookup: none, candidates: false }), { host: 'codex', bin: CODEX, model: 'gpt-5-mini', home: null, reason: 'routines.runner=codex' });
  assert.equal(H.resolveRunner({ cfg: pinned, kind: 'persona', env: ENV, lookup: none, candidates: false }).host, 'claude');
  const disabledButPinned = { ...pinned, hosts: { claude: { enabled: false, bin: CLAUDE }, codex: { enabled: false, bin: CODEX } } };
  assert.equal(H.resolveRunner({ cfg: disabledButPinned, kind: 'routines', env: ENV, lookup: none, candidates: false }).host, 'codex', 'an explicit runner ignores the enabled flag');
  assert.equal(H.resolveRunner({ cfg: both, env: { ...ENV, AOS_RUNNER: 'codex' }, lookup: none, candidates: false }).host, 'codex');
  assert.equal(H.resolveRunner({ cfg: both, env: { ...ENV, AOS_NO_CLAUDE: '1' }, lookup: none, candidates: false }).host, 'codex');
  assert.equal(H.resolveRunner({ cfg: both, env: { ...ENV, AOS_NO_CLAUDE: '1', AOS_NO_CODEX: '1' }, lookup: none, candidates: false }).host, null);
  const other = exe('codex2');
  assert.equal(H.resolveRunner({ cfg: { ...both, hosts: { claude: { enabled: false }, codex: { enabled: true } } }, env: { ...ENV, AOS_CODEX_BIN: other }, lookup: none, candidates: false }).bin, other);
  assert.equal(H.resolveRunner({ cfg: both, kind: 'persona', env: { ...ENV, PERSONA_CLAUDE_BIN: '/nowhere/claude' }, lookup: none, candidates: false }).host, 'codex', 'a set but missing PERSONA_CLAUDE_BIN never falls through to another claude');
  assert.equal(H.resolveRunner({ cfg: both, kind: 'routines', env: { ...ENV, PERSONA_CLAUDE_BIN: '/nowhere/claude' }, lookup: none, candidates: false }).host, 'claude', 'PERSONA_CLAUDE_BIN is a persona knob only');
});

test('runnerArgs: the claude recipe is unchanged; codex takes the prompt on stdin with the sandbox and hooks off', () => {
  const spec = { prompt: 'do it', system: 'SYS', model: 'haiku', effort: 'high', tools: 'Read,Glob', budget: 1.5, outFile: '/tmp/x.txt' };
  const c = H.runnerArgs('claude', spec);
  assert.deepEqual(c.argv, ['-p', 'do it', '--model', 'haiku', '--effort', 'high', '--allowedTools', 'Read,Glob', '--max-budget-usd', '1.5', '--output-format', 'json', '--strict-mcp-config', '--no-session-persistence', '--append-system-prompt', 'SYS']);
  assert.equal(c.stdin, null);
  assert.equal(H.runnerArgs('claude', { prompt: 'p', effort: 'xhigh' }).argv[5], 'medium', 'an unknown claude effort falls back');
  const x = H.runnerArgs('codex', { ...spec, model: 'gpt-5-mini' });
  assert.deepEqual(x.argv, ['exec', '-', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-c', 'features.hooks=false', '--json', '-o', '/tmp/x.txt', '-m', 'gpt-5-mini', '-c', 'model_reasoning_effort="high"']);
  assert.equal(x.stdin, 'SYS\n\n---\n\ndo it');
  const bare = H.runnerArgs('codex', { prompt: 'p', model: null, effort: 'nope' });
  assert.ok(!bare.argv.includes('-m') && !bare.argv.some((a) => a.startsWith('model_reasoning_effort')));
  assert.equal(bare.stdin, 'p');
  assert.equal(H.headlessEnv({ CLAUDECODE: '1', X: 'y' }).CLAUDECODE, undefined);
  assert.equal(H.headlessEnv({}).AOS_HEADLESS, '1');
  // A recorded Codex home travels to the child unless the environment already names one.
  assert.equal(H.headlessEnv({}, { codexHome: '/c/home' }).CODEX_HOME, '/c/home');
  assert.equal(H.headlessEnv({ CODEX_HOME: '/mine' }, { codexHome: '/c/home' }).CODEX_HOME, '/mine');
  assert.equal(H.headlessEnv({}).CODEX_HOME, undefined);
});

test('--resolve prints host, bin, model and the recorded codex home (tab-separated) or exits 3 with the reason', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hl-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none', codex: { model: 'gpt-5-mini' } }));
  const cfg = path.join(vault, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ vault, hosts: { claude: { enabled: false }, codex: { enabled: true, bin: CODEX, home: '/c/home' } } }));
  const env = { ...process.env, AOS_VAULT: vault, AOS_CONFIG: cfg, PATH: '/usr/bin:/bin' };
  const ok = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js'), '--resolve', '--kind', 'persona'], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `codex\t${CODEX}\tgpt-6-sol\t/c/home\n`, 'persona.codexModel: the Chief of Staff default (local-first A4) from config.default.json');
  const routines = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js'), '--resolve', '--kind', 'routines'], { encoding: 'utf8', env });
  assert.equal(routines.stdout, `codex\t${CODEX}\tgpt-5-mini\t/c/home\n`, 'routines.codexModel null → codex.model');
  const no = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js'), '--resolve'], { encoding: 'utf8', env: { ...env, AOS_NO_CODEX: '1' } });
  assert.equal(no.status, 3);
  assert.match(no.stderr, /no runner for routines/);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js')], { encoding: 'utf8', env }).status, 2);
});

test('a kind\'s own Codex model wins over codex.model (persona.codexModel, routines.codexModel)', () => {
  const cfg = { hosts: { claude: { enabled: false }, codex: { enabled: true, bin: CODEX } }, codex: { model: 'gpt-5-mini' }, persona: { codexModel: 'gpt-5' } };
  assert.equal(H.resolveRunner({ cfg, kind: 'persona', env: ENV, lookup: none, candidates: false }).model, 'gpt-5');
  assert.equal(H.resolveRunner({ cfg, kind: 'routines', env: ENV, lookup: none, candidates: false }).model, 'gpt-5-mini');
  assert.equal(H.resolveRunner({ cfg: { ...cfg, codex: {} }, kind: 'routines', env: ENV, lookup: none, candidates: false }).model, null, 'the user\'s Codex default');
});

test('graphRunner: a pinned runner, else an explicit provider, else Claude when it is a host with a binary, else Codex', () => {
  const both = { hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  const bins = { claude: '/b/claude', codex: '/b/codex' };
  assert.deepEqual(H.graphRunner(both, { bins }), { host: 'claude', bin: '/b/claude' });
  assert.deepEqual(H.graphRunner(both, { bins: { claude: null, codex: '/b/codex' } }), { host: 'codex', bin: '/b/codex' });
  assert.deepEqual(H.graphRunner({ ...both, provider: 'codex' }, { bins }), { host: 'codex', bin: '/b/codex' }, 'provider codex names Codex');
  assert.deepEqual(H.graphRunner({ ...both, graph: { semantic: { runner: 'codex' } } }, { bins }), { host: 'codex', bin: '/b/codex' });
  assert.equal(H.graphRunner({ ...both, provider: 'claude' }, { bins: { claude: null, codex: '/b/codex' } }), null, 'an explicit provider claude never falls to Codex');
  assert.deepEqual(H.graphRunner({ hosts: { claude: { enabled: false }, codex: { enabled: true } } }, { bins }), { host: 'codex', bin: '/b/codex' });
  assert.deepEqual(H.graphRunner({}, { bins }), { host: 'claude', bin: '/b/claude' }, 'a config without hosts is Claude only');
  assert.equal(H.graphRunner({}, { bins: { claude: null, codex: '/b/codex' } }), null);
});

// Spec 2026-09-23-cross-review D4: every isolation flag is pinned, per host and mode. No child in any mode gets a plugin,
// a connector, an MCP server or web search (measured live on codex-cli 0.156.1: plugins carry the connectors, and
// `-c mcp_servers={}` merges instead of emptying, so each declared server is switched off by name).
const CODEX_ISOLATION = ['-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.browser_use=false',
  '-c', 'features.computer_use=false', '-c', 'features.image_generation=false'];
const NO_MCP = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome'];

test('crossArgs: codex review is read-only and ephemeral, every plugin, server, connector and web search off, strict schema last', () => {
  const r = H.crossArgs('codex', { mode: 'review', schemaFile: '/t/schema.json', outFile: '/t/reply.txt', model: 'gpt-6-astra', effort: 'high', mcpOff: ['node_repl', 'odd.name'] });
  assert.deepEqual(r.argv, ['exec', '-', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', ...CODEX_ISOLATION,
    '-c', 'mcp_servers.node_repl.enabled=false', '-c', 'mcp_servers."odd.name".enabled=false',
    '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '--json', '-o', '/t/reply.txt', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="high"', '--output-schema', '/t/schema.json']);
  const consult = H.crossArgs('codex', { mode: 'consult', schemaFile: '/t/schema.json', outFile: '/t/r' }).argv;
  assert.ok(consult.includes('read-only') && !consult.includes('--output-schema'), 'consult: read-only, free-text reply');
  assert.ok(!consult.includes('-m'), 'no model: the user\'s Codex default');
});

test('crossArgs: a codex build writes inside the workspace with the same isolation; an effort codex does not take is left off', () => {
  const b = H.crossArgs('codex', { mode: 'build', outFile: '/t/r', effort: 'max', mcpOff: ['node_repl'] }).argv;
  assert.deepEqual(b, ['exec', '-', '--ephemeral', '--skip-git-repo-check', '-s', 'workspace-write', ...CODEX_ISOLATION,
    '-c', 'mcp_servers.node_repl.enabled=false', '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '--json', '-o', '/t/r']);
});

test('crossArgs: claude review runs in safe mode with only Read/Glob/Grep, no MCP, no persistence, the schema inline', () => {
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
  const r = H.crossArgs('claude', { mode: 'review', schema, model: 'claude-fable-5-1', effort: 'max', budget: 3 }).argv;
  assert.deepEqual(r, ['-p', '--output-format', 'json', '--no-session-persistence', '--permission-prompts', 'none', ...NO_MCP,
    '--safe-mode', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk',
    '--json-schema', JSON.stringify(schema), '--model', 'claude-fable-5-1', '--effort', 'max', '--max-budget-usd', '3']);
  const consult = H.crossArgs('claude', { mode: 'consult', schema }).argv;
  assert.ok(consult.includes('--safe-mode') && !consult.includes('--json-schema'), 'consult: read-only, free-text reply');
  assert.ok(!consult.includes('--model') && !consult.includes('--max-budget-usd'), 'unset model and budget are left to the CLI');
});

test('crossArgs: claude build uses acceptEdits with the user\'s permissions and no MCP, never safe mode or a bypass', () => {
  const b = H.crossArgs('claude', { mode: 'build', effort: 'minimal', budget: 2.5 }).argv;
  assert.deepEqual(b, ['-p', '--output-format', 'json', '--no-session-persistence', '--permission-prompts', 'none', ...NO_MCP, '--permission-mode', 'acceptEdits', '--max-budget-usd', '2.5']);
  assert.ok(!b.includes('bypassPermissions') && !b.includes('--dangerously-skip-permissions'));
  assert.throws(() => H.crossArgs('claude', { mode: 'write' }), /unknown mode write/);
});

test('codexMcpServers: the [mcp_servers.<name>] tables of config.toml, quoted or bare, not their sub-tables', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cx-home-'));
  assert.deepEqual(H.codexMcpServers(home), [], 'no config.toml');
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model = "gpt-6-astra"', '[mcp_servers.node_repl]', 'command = "node"', '[mcp_servers.node_repl.env]', 'X = "1"',
    '  [ mcp_servers."odd.name" ]  # quoted', "[mcp_servers.'lit']", '[mcp_servers.computer-use]', '[profiles.fast.mcp_servers.skip]', '[mcp_servers.node_repl]',
  ].join('\n'));
  assert.deepEqual(H.codexMcpServers(home), ['node_repl', 'odd.name', 'lit', 'computer-use']);
});

test('sessionArgs: a claude turn streams JSON, edits without prompts, and runs under the session id the app picks, then resumes it', () => {
  const first = H.sessionArgs('claude', { prompt: 'fix the parser', sessionId: 'a1b2', model: 'sonnet', effort: 'high', budget: 1 });
  assert.equal(first.stdin, null, 'nothing on stdin: spawns from the app have none');
  assert.deepEqual(first.argv, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    '--session-id', 'a1b2', '--max-budget-usd', '1.00', '--model', 'sonnet', '--effort', 'high', '--', 'fix the parser']);
  const next = H.sessionArgs('claude', { prompt: '-v is a flag here', resume: 'a1b2', allowCommands: true });
  assert.deepEqual(next.argv.slice(8), ['--resume', 'a1b2', '--allowedTools', 'Bash', '--', '-v is a flag here'], 'a prompt that looks like a flag stays the prompt');
  assert.ok(!first.argv.includes('--allowedTools'), 'Bash only when commands are allowed');
  assert.throws(() => H.sessionArgs('claude', { prompt: 'x' }), /sessionId/);
  assert.throws(() => H.sessionArgs('claude', { prompt: '  ', sessionId: 'a' }), /prompt/);
});

test('sessionArgs: access levels per host, on every turn (sessions-ux U7)', () => {
  const claude = (o) => H.sessionArgs('claude', { prompt: 'p', resume: 'a1b2', ...o }).argv;
  const mode = (argv) => argv[argv.indexOf('--permission-mode') + 1];
  assert.equal(mode(claude({ access: 'read' })), 'plan');
  assert.ok(!claude({ access: 'read' }).includes('--allowedTools'));
  assert.equal(mode(claude({ access: 'edit' })), 'acceptEdits');
  assert.ok(!claude({ access: 'edit' }).includes('--allowedTools'));
  assert.deepEqual(claude({ access: 'run' }).slice(claude({ access: 'run' }).indexOf('--allowedTools'), claude({ access: 'run' }).indexOf('--allowedTools') + 2), ['--allowedTools', 'Bash']);
  assert.ok(claude({ allowCommands: true }).includes('Bash'), 'allowCommands still reads as run');
  assert.equal(mode(claude({ access: 'read', allowCommands: true })), 'plan', 'the level wins over the older flag');
  assert.ok(!claude({ access: 'read', allowCommands: true }).includes('Bash'));
  assert.equal(mode(claude({})), 'acceptEdits', 'edit is the default');
  const codex = (o) => H.sessionArgs('codex', { prompt: 'p', ...o }).argv;
  assert.ok(codex({ access: 'read' }).includes('sandbox_mode="read-only"'));
  assert.ok(codex({ access: 'edit' }).includes('sandbox_mode="workspace-write"'));
  assert.ok(codex({ access: 'run' }).includes('sandbox_mode="workspace-write"'));
  assert.throws(() => codex({ access: 'admin' }), /no such access level/);
});

test('sessionArgs: each host gets the efforts its CLI takes; claude `default` passes no model', () => {
  const effortOf = (host, effort) => {
    const argv = H.sessionArgs(host, { prompt: 'p', resume: 'r', effort }).argv;
    return host === 'claude' ? (argv.includes('--effort') ? argv[argv.indexOf('--effort') + 1] : null) : (argv.find((a) => a.startsWith('model_reasoning_effort=')) || null);
  };
  assert.equal(effortOf('claude', 'max'), 'max');
  assert.equal(effortOf('claude', 'ultra'), null, 'claude takes no ultra');
  assert.equal(effortOf('codex', 'max'), 'model_reasoning_effort="max"');
  assert.equal(effortOf('codex', 'ultra'), 'model_reasoning_effort="ultra"');
  assert.equal(effortOf('codex', 'turbo'), null);
  assert.ok(!H.sessionArgs('claude', { prompt: 'p', resume: 'r', model: 'default' }).argv.includes('--model'));
  const named = H.sessionArgs('claude', { prompt: 'p', resume: 'r', model: 'opus' }).argv;
  assert.equal(named[named.indexOf('--model') + 1], 'opus');
});

test('sessionArgs: a codex turn runs exec --json in the workspace-write sandbox whatever allowCommands says, then exec resume', () => {
  const first = H.sessionArgs('codex', { prompt: 'fix the parser', model: 'gpt-5-mini', effort: 'low', allowCommands: false });
  assert.equal(first.stdin, null);
  assert.deepEqual(first.argv, ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-c', 'features.hooks=false',
    '-c', 'approval_policy="never"', '-m', 'gpt-5-mini', '-c', 'model_reasoning_effort="low"', '--', 'fix the parser']);
  const next = H.sessionArgs('codex', { prompt: 'and the tests', resume: '0199-thread' });
  assert.deepEqual(next.argv.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(next.argv.slice(-3), ['0199-thread', '--', 'and the tests'], 'the thread id, then the prompt after --');
  assert.ok(!next.argv.includes('-s') && !next.argv.includes('-C'), 'exec resume takes neither -s nor -C');
  assert.throws(() => H.sessionArgs('nohost', { prompt: 'x' }), /no such host/);
});

// ── resolveChief (local-first A4): the Chief of Staff's host, model, effort and failover per host configuration ──
const CHIEF_CFG = (o = {}) => ({
  hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true, bin: CODEX, home: '/c/home' } },
  persona: { runner: 'auto', model: 'claude-opus-5-5', codexModel: 'gpt-6-sol', effort: null, failover: true, perDayUsd: 6 },
  ...o,
});
const claudeOnly = (o) => CHIEF_CFG({ hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: false } }, ...o });
const codexOnly = (o) => CHIEF_CFG({ hosts: { claude: { enabled: false }, codex: { enabled: true, bin: CODEX, home: '/c/home' } }, ...o });
/** deps: every binary from the config, sign-in per host, today's duty spend over both hosts, a record of the probes. */
function chiefDeps({ signedOut = [], spent = 0, env = ENV, answers = null } = {}) {
  const probed = [];
  return {
    probed,
    env, lookup: none, candidates: false, answers,
    loggedIn: async (h, bin) => { probed.push(`${h}:${bin}`); return !signedOut.includes(h); },
    spentToday: () => spent,
  };
}
const pick = (r) => ({ host: r.host, model: r.model, effort: r.effort, reason: r.reason, failover: r.failover.map((f) => `${f.host}·${f.model}`), skipped: r.skipped.map((s) => `${s.host}: ${s.why}`) });

test('resolveChief: Claude only — claude-opus-5-5 at medium, no failover; signed out or capped it waits', async () => {
  assert.deepEqual(pick(await H.resolveChief(claudeOnly(), chiefDeps())),
    { host: 'claude', model: 'claude-opus-5-5', effort: 'medium', reason: 'auto', failover: [], skipped: [] });
  const out = await H.resolveChief(claudeOnly(), chiefDeps({ signedOut: ['claude'] }));
  assert.deepEqual(pick(out), { host: null, model: null, effort: null, reason: 'waiting-for-host', failover: [], skipped: ['claude: signed out'] });
  assert.deepEqual(pick(await H.resolveChief(claudeOnly(), chiefDeps({ spent: 6 }))).reason, 'daily-cap');
  const gone = await H.resolveChief(claudeOnly({ hosts: { claude: { enabled: true, bin: '/nowhere/claude' }, codex: { enabled: false } } }), chiefDeps());
  assert.deepEqual(pick(gone).skipped, ['claude: CLI not found']);
  assert.equal(gone.reason, 'waiting-for-host');
});

test('resolveChief: Codex only — gpt-6-sol with the recorded Codex home; a Claude model never reaches it', async () => {
  const r = await H.resolveChief(codexOnly(), chiefDeps({ env: { ...ENV, PERSONA_MODEL: 'sonnet', PERSONA_EFFORT: 'high' } }));
  assert.deepEqual(pick(r), { host: 'codex', model: 'gpt-6-sol', effort: 'high', reason: 'auto', failover: [], skipped: [] });
  assert.equal(r.bin, CODEX);
  assert.equal(r.home, '/c/home');
  assert.deepEqual(pick(await H.resolveChief(codexOnly(), chiefDeps({ signedOut: ['codex'] }))).skipped, ['codex: signed out']);
  assert.equal((await H.resolveChief(codexOnly(), chiefDeps({ spent: 7 }))).reason, 'daily-cap');
  // A pre-2.0 vault: null persona.codexModel keeps codex.model, then the user's own Codex default (no -m).
  const legacy = codexOnly({ persona: { codexModel: null }, codex: { model: 'gpt-5-mini' } });
  assert.equal((await H.resolveChief(legacy, chiefDeps())).model, 'gpt-5-mini');
  assert.equal((await H.resolveChief(codexOnly({ persona: { codexModel: null } }), chiefDeps())).model, null);
});

test('resolveChief: both hosts — Claude first with Codex as its failover; signed out or missing moves the duty, a cap never does', async () => {
  const deps = chiefDeps();
  const r = await H.resolveChief(CHIEF_CFG(), deps);
  assert.deepEqual(pick(r), { host: 'claude', model: 'claude-opus-5-5', effort: 'medium', reason: 'auto', failover: ['codex·gpt-6-sol'], skipped: [] });
  assert.deepEqual(deps.probed, [`claude:${CLAUDE}`], 'the failover host is named, not probed, while the primary runs');
  // auto: a signed-out Claude makes Codex the primary.
  const auto = await H.resolveChief(CHIEF_CFG(), chiefDeps({ signedOut: ['claude'] }));
  assert.deepEqual(pick(auto), { host: 'codex', model: 'gpt-6-sol', effort: 'medium', reason: 'auto', failover: [], skipped: ['claude: signed out'] });
  // One cap over both hosts (the owner's call): a capped day is skipped on every host, never moved — and probes nothing.
  const capDeps = chiefDeps({ spent: 6 });
  const capped = await H.resolveChief(CHIEF_CFG(), capDeps);
  assert.deepEqual(pick(capped), { host: null, model: null, effort: null, reason: 'daily-cap', failover: [], skipped: ['null: today\'s duty spend 6.00 of 6 USD (persona.perDayUsd)'] });
  assert.deepEqual(capDeps.probed, []);
  assert.equal((await H.resolveChief(CHIEF_CFG({ persona: { ...CHIEF_CFG().persona, perDayUsd: 0 } }), chiefDeps())).reason, 'daily-cap', 'a $0 day runs nothing');
  assert.equal((await H.resolveChief(CHIEF_CFG(), chiefDeps({ spent: 5.99 }))).host, 'claude');
  // persona.runner codex: Codex first, Claude its failover; Codex's CLI missing → Claude.
  const pinned = CHIEF_CFG({ persona: { ...CHIEF_CFG().persona, runner: 'codex' } });
  assert.deepEqual(pick(await H.resolveChief(pinned, chiefDeps())).failover, ['claude·claude-opus-5-5']);
  const noCodex = await H.resolveChief(pinned, chiefDeps({ env: { ...ENV, AOS_NO_CODEX: '1' } }));
  assert.deepEqual(pick(noCodex), { host: 'claude', model: 'claude-opus-5-5', effort: 'medium', reason: 'failover: codex CLI not found', failover: [], skipped: ['codex: CLI not found'] });
  // AOS_RUNNER beats persona.runner.
  assert.equal((await H.resolveChief(pinned, chiefDeps({ env: { ...ENV, AOS_RUNNER: 'claude' } }))).host, 'claude');
  // Both signed out → waiting-for-host; signed out and capped → daily-cap (the cap is the day's, whoever is signed in).
  const stuck = await H.resolveChief(CHIEF_CFG(), chiefDeps({ signedOut: ['claude', 'codex'] }));
  assert.deepEqual(pick(stuck), { host: null, model: null, effort: null, reason: 'waiting-for-host', failover: [], skipped: ['claude: signed out', 'codex: signed out'] });
  assert.equal((await H.resolveChief(CHIEF_CFG(), chiefDeps({ signedOut: ['claude'], spent: 9 }))).reason, 'daily-cap');
  // persona.failover false: no move, no failover named.
  const noFail = CHIEF_CFG({ persona: { ...CHIEF_CFG().persona, failover: false } });
  assert.deepEqual(pick(await H.resolveChief(noFail, chiefDeps())).failover, []);
  const pinnedOff = CHIEF_CFG({ persona: { ...CHIEF_CFG().persona, runner: 'claude', failover: false } });
  assert.deepEqual(pick(await H.resolveChief(pinnedOff, chiefDeps({ signedOut: ['claude'] }))).skipped, ['claude: signed out']);
});

test('resolveChief: no host — waiting-for-host, nothing probed', async () => {
  const deps = chiefDeps();
  const r = await H.resolveChief({ hosts: { claude: { enabled: false }, codex: { enabled: false } }, persona: {} }, deps);
  assert.deepEqual(pick(r), { host: null, model: null, effort: null, reason: 'waiting-for-host', failover: [], skipped: ['null: no host enabled'] });
  assert.deepEqual(deps.probed, []);
});

test('resolveChief: models — PERSONA_MODEL, persona.model, the interview answer, claude.model, then the chief default; effort per host', async () => {
  const m = async (cfg, o) => (await H.resolveChief(cfg, chiefDeps(o))).model;
  assert.equal(await m(claudeOnly({ persona: {} })), 'claude-opus-5-5', 'nothing set: models.js CHIEF');
  assert.equal(await m(claudeOnly({ persona: {}, claude: { model: 'haiku' } })), 'haiku', 'a pre-2.0 vault keeps claude.model');
  assert.equal(await m(claudeOnly({ persona: {}, claude: { model: 'haiku' } }), { answers: { dutyModel: 'sonnet' } }), 'sonnet');
  assert.equal(await m(claudeOnly({ persona: { model: 'opus' }, claude: { model: 'haiku' } }), { answers: { dutyModel: 'sonnet' } }), 'opus');
  assert.equal(await m(claudeOnly(), { env: { ...ENV, PERSONA_MODEL: 'claude-sonnet-5' } }), 'claude-sonnet-5', 'a duty routine\'s own model');
  const e = async (cfg, env) => (await H.resolveChief(cfg, chiefDeps({ env: { ...ENV, ...env } }))).effort;
  assert.equal(await e(claudeOnly({ persona: { effort: 'low' } })), 'low');
  assert.equal(await e(claudeOnly({ persona: { effort: 'low' } }), { PERSONA_EFFORT: 'high' }), 'high');
  assert.equal(await e(claudeOnly(), { PERSONA_EFFORT: 'xhigh' }), 'medium', 'claude -p takes low|medium|high here');
  assert.equal(await e(codexOnly(), { PERSONA_EFFORT: 'xhigh' }), 'xhigh');
});
