'use strict';
// The suite's own environment even when a check runs this file on its own (parity-check: `node --test <file>`), so
// lib/test-guard.js lets it resolve what it needs: a no-op under `npm test`, which preloads it already.
require('../tools/test-env.js');
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CH = require('./codex-host.js');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugin');
const LAUNCHER = '/vaults/demo/brain/scripts/bin/aos';
const CONFIG = '/cfg/agenticos.json';
const CTX = { launcher: LAUNCHER, config: CONFIG };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const err = (stderr, status = 1) => ({ status, stdout: '', stderr });
const PLUGIN_SERVER = { name: 'agenticos', transport: { type: 'stdio', command: 'sh', args: ['./bin/aos', 'mcp-server'], env: { AOS_HOST: 'codex' }, cwd: '/cache/agenticos/1.0.0/.' } };

/**
 * A fake `run`: records calls. `mcp get` answers from `state.registered`, `mcp add` sets it, `mcp remove` clears it.
 * The `plugin` verbs answer the way Codex 0.155.1 did in the design spike: a marketplace added again from the same
 * source reports alreadyAdded, from another source is refused; `marketplace upgrade` refuses a local source;
 * `state.noPlugins` makes the CLI predate plugins. `mcp list` shows the plugin's server and a direct registration.
 */
function fakeRun(state = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args.slice(0, 2).join(' ');
    if (key === 'login status') return state.loggedOut ? { status: 1, stdout: 'Not logged in\n', stderr: '' } : { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' };
    if (key === 'mcp get') return state.registered ? { status: 0, stdout: JSON.stringify({ name: 'agenticos', transport: { type: 'stdio', command: 'sh', args: [state.registered, 'mcp-server'], env: state.hostEnv ? { AOS_CONFIG: CONFIG, AOS_HOST: 'codex' } : { AOS_CONFIG: CONFIG } } }), stderr: '' } : { status: 1, stdout: '', stderr: 'no such server' };
    if (key === 'mcp add') { if (state.failAdd) return { status: 1, stdout: '', stderr: 'boom' }; state.registered = args[args.indexOf('--') + 2]; state.hostEnv = args.includes('AOS_HOST=codex'); return { status: 0, stdout: '', stderr: '' }; }
    if (key === 'mcp remove') {
      const had = !!state.registered;
      state.registered = null; state.hostEnv = false;
      return ok(had ? "Removed global MCP server 'agenticos'.\n" : "No MCP server named 'agenticos' found.\n");
    }
    if (key === 'mcp list') {
      const arr = [];
      if (state.installed) arr.push(PLUGIN_SERVER);
      if (state.registered) arr.push({ name: 'agenticos', transport: { type: 'stdio', command: 'sh', args: [state.registered, 'mcp-server'], env: { AOS_CONFIG: CONFIG, AOS_HOST: 'codex' } } });
      return ok(JSON.stringify(arr));
    }
    if (args[0] === 'plugin' && state.noPlugins) return err("error: unrecognized subcommand 'plugin'", 2);
    if (key === 'plugin list') return ok(JSON.stringify({ installed: state.installed ? [{ pluginId: 'agenticos@agenticos-workbench', version: '1.0.0', installed: true, enabled: true }] : [], available: [] }));
    if (key === 'plugin marketplace') {
      const [, , verb, arg] = args;
      if (verb === 'add') {
        if (state.failMarketplace) return err('Error: could not clone');
        if (!state.mkt) { state.mkt = arg; return ok(JSON.stringify({ marketplaceName: 'agenticos-workbench', alreadyAdded: false })); }
        if (state.mkt === arg) return ok(JSON.stringify({ marketplaceName: 'agenticos-workbench', alreadyAdded: true }));
        return err("Error: marketplace 'agenticos-workbench' is already added from a different source; remove it before adding this source");
      }
      if (verb === 'upgrade') return state.mkt && !state.mkt.startsWith('/') ? ok('') : err('Error: marketplace `agenticos-workbench` is not configured as a Git marketplace');
      if (verb === 'remove') { if (!state.mkt) return err('Error: marketplace `agenticos-workbench` is not configured or installed'); state.mkt = null; return ok(''); }
      if (verb === 'list') {
        if (!state.mkt) return ok(JSON.stringify({ marketplaces: [] }));
        const git = !state.mkt.startsWith('/');
        const root = git ? '/codex-home/.tmp/marketplaces/agenticos-workbench' : state.mkt;
        return ok(JSON.stringify({ marketplaces: [{ name: 'openai-bundled', root: '/bundled' }, { name: 'agenticos-workbench', root, marketplaceSource: { sourceType: git ? 'git' : 'local', source: state.mkt } }] }));
      }
    }
    if (key === 'plugin add') {
      if (!state.mkt || state.failPluginAdd) return err('Error: plugin not found');
      state.installed = true;
      return ok(JSON.stringify({ pluginId: 'agenticos@agenticos-workbench', name: 'agenticos', version: '1.0.0', installedPath: '/cache/agenticos/1.0.0' }));
    }
    if (key === 'plugin remove') { state.installed = false; return ok('Removed plugin `agenticos`.'); }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls, state };
}
const argvOf = (calls) => calls.map((c) => c.slice(1).join(' '));

test('mergeHooks writes the six events through the launcher with AOS_HOST=codex, SessionEnd under the 3 s cap, and is idempotent', () => {
  const doc = CH.mergeHooks(null, CTX);
  assert.deepEqual(Object.keys(doc.hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
  const names = (ev) => doc.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command.replace(/^env AOS_HOST=codex AOS_CONFIG='[^']*' sh '[^']*' /, '')));
  assert.deepEqual(names('SessionStart'), ['telemetry-hook', 'update-notice', 'persona-watchdog', 'reconcile-sessions', 'inject-conventions']);
  assert.deepEqual(names('UserPromptSubmit'), ['inject-context']);
  assert.deepEqual(names('PreToolUse'), ['instruction-guard']);
  assert.match(doc.hooks.PreToolUse[0].matcher, /apply_patch/);
  assert.deepEqual(names('PostToolUse'), ['telemetry-hook']);
  assert.deepEqual(names('Stop'), ['update-session', 'heartbeat-writer', 'reconcile-sessions']);
  assert.deepEqual(names('SessionEnd'), ['telemetry-hook', 'auto-cost', 'heartbeat-writer', 'auto-wrap', 'scan-vault --quiet', 'skills-sync']);
  for (const g of doc.hooks.SessionEnd) for (const h of g.hooks) assert.equal(h.timeout, 3);
  for (const g of doc.hooks.Stop) for (const h of g.hooks) { assert.equal(h.timeout, 10); assert.equal(h.type, 'command'); }
  assert.equal(doc.hooks.Stop[0].hooks[0].command, `env AOS_HOST=codex AOS_CONFIG='${CONFIG}' sh '${LAUNCHER}' update-session`);
  assert.ok(!('matcher' in doc.hooks.PostToolUse[0]), 'no matcher means every tool');
  assert.deepEqual(CH.mergeHooks(doc, CTX), doc, 'merging twice changes nothing');
  assert.deepEqual(CH.mergeHooks(CH.mergeHooks(doc, CTX), CTX).hooks.Stop.length, 1, 'never duplicated');
});

test('mergeHooks keeps foreign entries and unknown keys; a moved launcher replaces the old entry', () => {
  const foreign = { hooks: [{ type: 'command', command: 'echo theirs', timeout: 5 }] };
  const existing = { note: 'mine', hooks: { Stop: [foreign], PreToolUse: [foreign] } };
  const doc = CH.mergeHooks(existing, CTX);
  assert.equal(doc.note, 'mine');
  assert.deepEqual(doc.hooks.PreToolUse[0], foreign);
  assert.equal(doc.hooks.PreToolUse.length, 2);
  assert.equal(doc.hooks.Stop.length, 2);
  assert.deepEqual(doc.hooks.Stop[0], foreign);
  const moved = CH.mergeHooks(doc, { launcher: '/elsewhere/brain/scripts/bin/aos', config: CONFIG });
  assert.equal(moved.hooks.Stop.length, 2);
  assert.match(moved.hooks.Stop[1].hooks[0].command, /elsewhere/);
  assert.equal(CH.countOurEvents(moved), 6);
  assert.equal(CH.countOurEvents({ hooks: { Stop: [foreign] } }), 0);
});

test('stripHooks removes only ours and reports an empty document as null', () => {
  const foreign = { hooks: [{ type: 'command', command: 'echo theirs' }] };
  const doc = CH.mergeHooks({ hooks: { Stop: [foreign] } }, CTX);
  const { doc: left, removed } = CH.stripHooks(doc);
  assert.equal(removed, 6);
  assert.deepEqual(left, { hooks: { Stop: [foreign] } });
  assert.deepEqual(CH.stripHooks(CH.mergeHooks(null, CTX)), { doc: null, removed: 6 });
  assert.deepEqual(CH.stripHooks(null), { doc: null, removed: 0 });
  assert.deepEqual(CH.stripHooks({ other: 1 }), { doc: { other: 1 }, removed: 0 });
});

test('hook commands shell-quote the paths', () => {
  const c = CH.hookCommand({ launcher: "/v/it's here/bin/aos", config: '/c/a b.json' }, 'inject-context');
  assert.equal(c, `env AOS_HOST=codex AOS_CONFIG='/c/a b.json' sh '/v/it'\\''s here/bin/aos' inject-context`);
  assert.ok(CH.isOurs(c));
  assert.ok(!CH.isOurs('sh something inject-context'));
});

test('commandToSkill rewrites every Claude Code idiom and carries the marker', () => {
  const src = [
    '---', 'description: Append a note; tag #promote to make it permanent at /wrap', 'allowed-tools: Read, Edit', 'argument-hint: <text>', '---', '',
    'Remember: **$ARGUMENTS**. Vault: `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.',
    'Bash: `aos wrap-session` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" wrap-session`); call `mcp__plugin_agenticos_agenticos__wrap_session` once.',
    'Then run /wrap, not brain/_index/wrap or /wrap-session. Also ${CLAUDE_PLUGIN_ROOT}/bin/aos alone. A Claude Code session ends.',
  ].join('\n');
  const out = CH.commandToSkill('remember', src, { ...CTX, skillsDir: '/home/demo/.agents/skills', names: ['remember', 'wrap'] });
  assert.match(out, /^---\nname: remember\ndescription: Append a note; tag #promote to make it permanent at \$wrap\n---\n/, 'descriptions are rewritten too');
  assert.ok(out.split('\n')[4] === CH.GENERATED_MARKER, 'marker right under the frontmatter');
  assert.ok(!/allowed-tools|argument-hint/.test(out));
  assert.match(out, /Remember: \*\*the text the user wrote after `\$remember`\*\*/);
  assert.match(out, /Vault: `\/cfg\/agenticos\.json`/);
  assert.match(out, /sh "\/vaults\/demo\/brain\/scripts\/bin\/aos" wrap-session/);
  assert.match(out, /mcp__agenticos__wrap_session/);
  assert.ok(!/mcp__plugin_agenticos|CLAUDE_PLUGIN_ROOT|CLAUDE_CONFIG_DIR|\$ARGUMENTS/.test(out));
  assert.match(out, /Then run \$wrap, not brain\/_index\/wrap or \/wrap-session\./);
  assert.match(out, /Also \/vaults\/demo\/brain\/scripts\/bin\/aos alone\. A Codex session ends\./);
  assert.match(out, /> Host: Codex CLI\. Invoke as `\$remember`/);
  assert.ok(!/question to the user is one message/.test(out), 'the question note only when the source asks');
});

test('Claude Code tools and host wording: file tools, AskUserQuestion, /agenticos:<name>, the current session only', () => {
  const src = [
    '---', 'name: review', 'description: Batch review. Use when the user says "review drafts" or "/agenticos:review".', '---', '',
    '1. Read every draft with the Read tool at `<vault>/x.md`.',
    '2. Ask ONE AskUserQuestion (multiSelect: true); group items 4 per AskUserQuestion call; then a follow-up AskUserQuestion.',
    '3. Then /agenticos:wrap (or (/wrap)). At the end of a Claude Code session, run it.',
    '4. The snapshot only refreshes from an interactive Claude Code session.',
  ].join('\n');
  const direct = CH.skillToCodex('review', src, { ...CTX, skillsDir: '/s', names: ['review', 'wrap'] });
  assert.match(direct, /description: Batch review\. Use when the user says "review drafts" or "\$review"\./);
  assert.match(direct, /1\. Read every draft at `<vault>\/x\.md`\./);
  assert.match(direct, /2\. Ask ONE question \(multiSelect: true\); group items 4 per question; then a follow-up question\./);
  assert.match(direct, /3\. Then \$wrap \(or \(\$wrap\)\)\. At the end of a Codex session, run it\./);
  assert.match(direct, /4\. The snapshot only refreshes from an interactive Claude Code session\./, 'a qualified host phrase is kept');
  assert.match(direct, /question to the user is one message with its options numbered/);
  const plugin = CH.skillToCodex('review', src, { skillsDir: '/s', names: ['review', 'wrap'], target: 'plugin' });
  assert.match(plugin, /"\$agenticos:review"/);
  assert.match(plugin, /3\. Then \$agenticos:wrap \(or \(\$agenticos:wrap\)\)\./);
  assert.ok(!/AskUserQuestion|Read tool|\/agenticos:/.test(plugin));
});

test('generateSkills turns the real plugin into 29 marked skills, copies skill scripts, and never overwrites a foreign skill', () => {
  const dir = tmp('aos-skills-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'brain', 'SKILL.md'), '---\nname: brain\ndescription: the user\'s own brain skill\n---\nmine\n');
  const warnings = [];
  const r = CH.generateSkills({ pluginDir: PLUGIN, dir, launcher: LAUNCHER, config: CONFIG, io: { warn: (m) => warnings.push(m) } });
  assert.deepEqual(r.skipped, ['brain']);
  assert.equal(warnings.length, 1);
  assert.equal(r.written.length, 27, 'twenty-one commands and nine skills, two shared names (wrap, cost), one foreign (brain)');
  assert.equal(CH.countGenerated(dir), 27);
  assert.equal(fs.readFileSync(path.join(dir, 'brain', 'SKILL.md'), 'utf8').trim().endsWith('mine'), true);
  for (const name of r.written) {
    const text = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`), `${name}: name`);
    assert.ok(text.includes(CH.GENERATED_MARKER), `${name}: marker`);
    assert.ok(!/CLAUDE_PLUGIN_ROOT|CLAUDE_CONFIG_DIR|mcp__plugin_agenticos|\$ARGUMENTS/.test(text), `${name}: leftover Claude idiom`);
  }
  const wrap = fs.readFileSync(path.join(dir, 'wrap', 'SKILL.md'), 'utf8');
  assert.match(wrap, /mcp__agenticos__wrap_session/);
  assert.match(wrap, /## The `\$wrap` procedure/, 'the command steps are appended to the skill of the same name');
  assert.ok(fs.existsSync(path.join(dir, 'persona-flag-closer', 'scripts', 'collect.js')), 'skill scripts travel with the skill');
  assert.match(fs.readFileSync(path.join(dir, 'persona-flag-closer', 'SKILL.md'), 'utf8'), new RegExp(`SKILL_DIR = ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/persona-flag-closer`));
  // re-run: same set, nothing duplicated, foreign still skipped
  const again = CH.generateSkills({ pluginDir: PLUGIN, dir, launcher: LAUNCHER, config: CONFIG });
  assert.deepEqual(again.written.sort(), r.written.sort());
  assert.deepEqual(CH.removeSkills({ dir }).sort(), r.written.sort());
  assert.ok(fs.existsSync(path.join(dir, 'brain', 'SKILL.md')), 'the foreign skill survives removal');
  assert.equal(CH.countGenerated(dir), 0);
});

test('installCodexHost writes hooks.json, registers the MCP server once, generates skills; removeCodexHost reverses it', () => {
  const home = tmp('aos-codex-home-');
  const dir = tmp('aos-skills2-');
  const env = { CODEX_HOME: home };
  const { run, calls, state } = fakeRun();
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(r.hooksFile, path.join(home, 'hooks.json'));
  assert.equal(r.hooksChanged, true);
  assert.equal(r.mcp, 'added');
  assert.equal(state.registered, LAUNCHER);
  assert.ok(calls.some((c) => c.join(' ') === `/x/codex mcp add agenticos --env AOS_CONFIG=${CONFIG} --env AOS_HOST=codex -- sh ${LAUNCHER} mcp-server`));
  assert.equal(r.skills.written.length, 28);
  const doc = JSON.parse(fs.readFileSync(r.hooksFile, 'utf8'));
  assert.equal(CH.countOurEvents(doc), 6);
  // second run: present, unchanged
  const again = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(again.hooksChanged, false);
  assert.equal(again.mcp, 'present');
  assert.equal(calls.filter((c) => c[1] === 'mcp' && c[2] === 'add').length, 1);
  const st = CH.codexHostStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir });
  assert.equal(st.loggedIn, true);
  assert.equal(st.hookEvents, 6);
  assert.equal(st.mcp, 'ok');
  assert.equal(st.skills, 28);
  assert.equal(st.memories, false);
  const rm = CH.removeCodexHost({ cfg: {}, bin: '/x/codex', run, env, dir });
  assert.equal(rm.hooksFileState, 'deleted');
  assert.equal(rm.hooksRemoved, 6);
  assert.equal(rm.mcp, 'removed');
  assert.equal(state.registered, null);
  assert.equal(rm.skills.length, 28);
  assert.ok(!fs.existsSync(r.hooksFile));
  assert.equal(CH.codexHostStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir }).hookEvents, 0);
});

test('a user hooks.json with its own entries is merged into and left standing after removal; mcp add failure is a warning', () => {
  const home = tmp('aos-codex-home2-');
  const dir = tmp('aos-skills3-');
  const env = { CODEX_HOME: home };
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  const { run, state } = fakeRun({ failAdd: true });
  const warnings = [];
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir, io: { warn: (m) => warnings.push(m) } });
  assert.equal(r.mcp, 'failed');
  assert.match(warnings[0], /codex mcp add failed/);
  assert.equal(state.registered, null);
  const doc = JSON.parse(fs.readFileSync(r.hooksFile, 'utf8'));
  assert.equal(doc.hooks.Stop.length, 2);
  assert.equal(doc.hooks.Stop[0].hooks[0].command, 'say done');
  const rm = CH.removeCodexHost({ cfg: {}, bin: null, run, env, dir });
  assert.equal(rm.hooksFileState, 'kept-foreign');
  assert.equal(rm.mcp, 'no-binary');
  assert.deepEqual(JSON.parse(fs.readFileSync(r.hooksFile, 'utf8')), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
});

test('codexBin: AOS_NO_CODEX hides it, AOS_CODEX_BIN wins, then the recorded path, then PATH', () => {
  const exe = path.join(tmp('aos-cx-'), 'codex');
  fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(CH.codexBin({}, { env: { AOS_NO_CODEX: '1', AOS_CODEX_BIN: '/x' } }), null);
  assert.equal(CH.codexBin({}, { env: { AOS_CODEX_BIN: '/x' } }), '/x');
  assert.equal(CH.codexBin({ hosts: { codex: { bin: exe } } }, { env: {}, which: () => '/from/path' }), exe);
  assert.equal(CH.codexBin({ hosts: { codex: { bin: '/gone' } } }, { env: {}, which: () => '/from/path' }), '/from/path');
  assert.equal(CH.codexLoggedIn('/x', () => ({ status: 0, stdout: 'Logged in using ChatGPT', stderr: '' })), true);
  assert.equal(CH.codexLoggedIn('/x', () => ({ status: 0, stdout: 'Not logged in', stderr: '' })), false);
  assert.equal(CH.codexLoggedIn(null), false);
});

test('codexHome and memoriesEnabled read the config the way Codex does', () => {
  const home = tmp('aos-cx-home-');
  assert.equal(CH.codexHome({}, { CODEX_HOME: home }), home);
  assert.equal(CH.codexHome({ hosts: { codex: { home: '/cfg-home' } } }, { CODEX_HOME: home }), path.resolve('/cfg-home'));
  assert.equal(CH.memoriesEnabled({}, { CODEX_HOME: home }), false);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n[features]\nhooks = true\nmemories = true\n[projects."/p"]\ntrust_level = "trusted"\n');
  assert.equal(CH.memoriesEnabled({}, { CODEX_HOME: home }), true);
  fs.writeFileSync(path.join(home, 'config.toml'), '[memories]\ngenerate_memories = true\n');
  assert.equal(CH.memoriesEnabled({}, { CODEX_HOME: home }), true);
  fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nhooks = true\n[other]\nmemories = true\n');
  assert.equal(CH.memoriesEnabled({}, { CODEX_HOME: home }), false);
});

test('a 0.5.0 MCP registration (launcher right, no AOS_HOST env) reads as stale and is re-added with the env (codex-parity D2)', () => {
  const home = tmp('aos-codex-home3-');
  const dir = tmp('aos-skills4-');
  const env = { CODEX_HOME: home };
  const { run, calls, state } = fakeRun({ registered: LAUNCHER, hostEnv: false });
  assert.equal(CH.mcpState({ bin: '/x/codex', run, launcher: LAUNCHER }), 'stale');
  assert.equal(CH.mcpRegistered({ bin: '/x/codex', run, launcher: LAUNCHER }), false);
  assert.equal(CH.codexHostStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir }).mcp, 'stale');
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(r.mcp, 'added');
  assert.equal(state.hostEnv, true);
  assert.ok(calls.some((c) => c[1] === 'mcp' && c[2] === 'remove'), 'the stale entry is removed before the add');
  assert.equal(CH.mcpState({ bin: '/x/codex', run, launcher: LAUNCHER }), 'ok');
  assert.equal(CH.mcpState({ bin: null, run, launcher: LAUNCHER }), 'no-binary');
  assert.equal(CH.mcpState({ bin: '/x/codex', run, launcher: '/elsewhere/aos' }), 'missing');
  assert.deepEqual(CH.mcpAddArgs({ config: CONFIG, launcher: LAUNCHER }).slice(0, 7), ['mcp', 'add', 'agenticos', '--env', `AOS_CONFIG=${CONFIG}`, '--env', 'AOS_HOST=codex']);
});

// ── the Codex plugin (design 2026-09-23-codex-plugin D4–D6) ──────────────────
test('codexInstallMode: plugin when `codex plugin list --json` answers with a list, otherwise direct', () => {
  assert.equal(CH.codexInstallMode('/x/codex', fakeRun().run), 'plugin');
  assert.equal(CH.codexInstallMode('/x/codex', fakeRun({ noPlugins: true }).run), 'direct');
  assert.equal(CH.codexInstallMode('/x/codex', () => ok('')), 'direct', 'a CLI that exits 0 without a list is not trusted to have plugins');
  assert.equal(CH.codexInstallMode(null, fakeRun().run), 'direct');
});

test('the plugin wiring names nothing on this machine: ${PLUGIN_ROOT} in hooks, a relative launcher for MCP', () => {
  assert.equal(CH.pluginHookCommand('inject-context'), 'env AOS_HOST=codex sh "${PLUGIN_ROOT}/bin/aos" inject-context');
  assert.ok(CH.isOurs(CH.pluginHookCommand('x')), 'the same AOS_HOST prefix as direct entries');
  assert.deepEqual(CH.pluginMcpServers().mcpServers.agenticos.args, ['./bin/aos', 'mcp-server']);
  assert.equal(CH.pluginMcpServers().mcpServers.agenticos.cwd, '.');
  assert.equal(CH.pluginHookCount(), 17);
});

test('installCodexPlugin: a fresh install adds the marketplace and the plugin; a re-run refreshes a git marketplace first', () => {
  const { run, calls, state } = fakeRun();
  const r = CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run });
  assert.deepEqual(r, { state: 'installed', version: '1.0.0', installedPath: '/cache/agenticos/1.0.0', source: 'owner/repo' });
  assert.deepEqual(argvOf(calls), ['plugin marketplace add owner/repo --json', 'plugin add agenticos@agenticos-workbench --json']);
  assert.equal(state.installed, true);
  calls.length = 0;
  CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run });
  assert.deepEqual(argvOf(calls), ['plugin marketplace add owner/repo --json', 'plugin marketplace upgrade agenticos-workbench', 'plugin add agenticos@agenticos-workbench --json']);
});

test('codexMarketplaceRoot: the checkout of a local marketplace, the refreshed snapshot of a git one, else null', () => {
  const local = fakeRun({ mkt: '/checkout' });
  assert.equal(CH.codexMarketplaceRoot({ bin: '/x/codex', run: local.run, refresh: true }), '/checkout');
  assert.deepEqual(argvOf(local.calls), ['plugin marketplace list --json'], 'a local marketplace is read in place, never upgraded');
  const git = fakeRun({ mkt: 'owner/repo' });
  assert.equal(CH.codexMarketplaceRoot({ bin: '/x/codex', run: git.run, refresh: true }), '/codex-home/.tmp/marketplaces/agenticos-workbench');
  assert.deepEqual(argvOf(git.calls), ['plugin marketplace list --json', 'plugin marketplace upgrade agenticos-workbench', 'plugin marketplace list --json']);
  assert.equal(CH.codexMarketplaceRoot({ bin: '/x/codex', run: fakeRun().run }), null, 'no agenticos-workbench marketplace');
  assert.equal(CH.codexMarketplaceRoot({ bin: null }), null);
});

test('installCodexPlugin keeps a marketplace from another source unless switchSource (an explicit --from-local)', () => {
  const { run, calls, state } = fakeRun({ mkt: '/checkout' });
  const kept = CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run });
  assert.equal(kept.state, 'installed');
  assert.equal(state.mkt, '/checkout', 'upgrade without --from-local keeps the source the user chose');
  assert.ok(argvOf(calls).includes('plugin marketplace upgrade agenticos-workbench'));
  calls.length = 0;
  const switched = CH.installCodexPlugin({ bin: '/x/codex', source: '/other-checkout', switchSource: true, run });
  assert.equal(switched.state, 'installed');
  assert.equal(state.mkt, '/other-checkout');
  assert.deepEqual(argvOf(calls), [
    'plugin marketplace add /other-checkout --json', 'plugin marketplace remove agenticos-workbench',
    'plugin marketplace add /other-checkout --json', 'plugin add agenticos@agenticos-workbench --json',
  ]);
});

test('installCodexPlugin reports failure with the command to run, and installs nothing half-way', () => {
  const warnings = [];
  const io = { warn: (m) => warnings.push(m) };
  const a = fakeRun({ failMarketplace: true });
  assert.deepEqual(CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run: a.run, io }), { state: 'failed', source: 'owner/repo' });
  assert.match(warnings[0], /marketplace add failed .* run: codex plugin marketplace add owner\/repo/);
  assert.ok(!argvOf(a.calls).some((c) => c.startsWith('plugin add')));
  const b = fakeRun({ failPluginAdd: true });
  assert.equal(CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run: b.run, io }).state, 'failed');
  assert.match(warnings[1], /codex plugin add failed .* run: codex plugin add agenticos@agenticos-workbench/);
});

test('removeCodexPlugin uninstalls and drops the marketplace; a second run is still clean', () => {
  const { run, state } = fakeRun();
  CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run });
  assert.deepEqual(CH.removeCodexPlugin({ bin: '/x/codex', run }), { plugin: 'removed', marketplace: 'removed' });
  assert.equal(state.installed, false);
  assert.equal(state.mkt, null);
  assert.deepEqual(CH.removeCodexPlugin({ bin: '/x/codex', run }), { plugin: 'removed', marketplace: 'removed' });
  assert.deepEqual(CH.removeCodexPlugin({ bin: null, run }), { plugin: 'no-binary', marketplace: 'no-binary' });
});

test('removeDirectWiring takes out what a direct install wrote (hooks, MCP registration, skills) and nothing else (D5)', () => {
  const home = tmp('aos-codex-home5-');
  const dir = tmp('aos-skills5-');
  const env = { CODEX_HOME: home };
  const foreign = { hooks: [{ type: 'command', command: 'say done' }] };
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [foreign] } }));
  const { run, state } = fakeRun();
  CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run });
  assert.deepEqual(CH.removeDirectWiring({ cfg: {}, bin: '/x/codex', run, env, dir }), { hooks: 6, mcp: true, skills: 28 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8')), { hooks: { Stop: [foreign] } });
  assert.equal(state.registered, null);
  assert.equal(state.installed, true, 'the plugin stays');
  assert.deepEqual(CH.removeDirectWiring({ cfg: {}, bin: '/x/codex', run, env, dir }), { hooks: 0, mcp: false, skills: 0 });
  // a hooks.json that held only our entries is deleted
  const home2 = tmp('aos-codex-home6-');
  CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: null, run, env: { CODEX_HOME: home2 }, dir });
  assert.equal(CH.removeDirectWiring({ cfg: {}, bin: null, run, env: { CODEX_HOME: home2 }, dir }).hooks, 6);
  assert.ok(!fs.existsSync(path.join(home2, 'hooks.json')));
});

test('trustedPluginHooks counts our [hooks.state] tables that carry a trusted_hash, and nothing else', () => {
  const home = tmp('aos-codex-trust-');
  const env = { CODEX_HOME: home };
  assert.equal(CH.trustedPluginHooks({}, env), 0, 'no config.toml');
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model = "x"',
    '[hooks.state]',
    '[hooks.state."agenticos@agenticos-workbench:hooks/hooks.json:session_start:0:0"]',
    'trusted_hash = "sha256:aa11"',
    '[hooks.state."agenticos@agenticos-workbench:hooks/hooks.json:stop:0:1"]',
    'trusted_hash = "sha256:bb22"',
    '[hooks.state."agenticos@agenticos-workbench:hooks/hooks.json:stop:0:2"]',
    'enabled = false',
    '[hooks.state."/codex-home/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:cc33"',
    '[hooks.state."other@market:hooks/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:dd44"',
    '[plugins."agenticos@agenticos-workbench"]',
    'enabled = true',
  ].join('\n'));
  assert.equal(CH.trustedPluginHooks({}, env), 2);
});

test('codexPluginStatus reports the plugin, its MCP server and any direct wiring left behind', () => {
  const home = tmp('aos-codex-home7-');
  const dir = tmp('aos-skills7-');
  const env = { CODEX_HOME: home, AOS_CODEX_BIN: '/x/codex' };
  const { run } = fakeRun();
  const before = CH.codexPluginStatus({ cfg: {}, launcher: LAUNCHER, run, env, dir });
  assert.equal(before.installed, false);
  assert.equal(before.mcp, 'missing');
  assert.equal(before.hooksTotal, 17);
  CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run });
  const both = CH.codexPluginStatus({ cfg: {}, launcher: LAUNCHER, run, env, dir });
  assert.equal(both.installed, true);
  assert.equal(both.version, '1.0.0');
  assert.equal(both.mcp, 'ok');
  assert.deepEqual(both.direct, { hookEvents: 6, mcp: true, skills: 28 });
  CH.removeDirectWiring({ cfg: {}, bin: '/x/codex', run, env, dir });
  assert.deepEqual(CH.codexPluginStatus({ cfg: {}, launcher: LAUNCHER, run, env, dir }).direct, { hookEvents: 0, mcp: false, skills: 0 });
});
