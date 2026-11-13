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

/** What codex-cli 0.167 does to config.toml, checked in a scratch CODEX_HOME: `mcp remove` drops every table of the
 *  server (its per-tool approvals too); `mcp add` writes the server's own tables in place of any it had. */
const SERVER_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*agenticos\s*[.\]]/;
function dropServer(text) {
  let skip = false;
  return text.split('\n').filter((l) => { if (/^\s*\[/.test(l)) skip = SERVER_TABLE.test(l); return !skip; }).join('\n');
}
function codexAdd(home, launcher, envs) {
  const file = path.join(home, 'config.toml');
  const before = fs.existsSync(file) ? dropServer(fs.readFileSync(file, 'utf8')) : '';
  const env = envs.map((e) => { const i = e.indexOf('='); return `${e.slice(0, i)} = ${JSON.stringify(e.slice(i + 1))}`; });
  fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}[mcp_servers.agenticos]\ncommand = "sh"\nargs = [${JSON.stringify(launcher)}, "mcp-server"]\n${env.length ? `\n[mcp_servers.agenticos.env]\n${env.join('\n')}\n` : ''}`);
}
function codexRemove(home) {
  const file = path.join(home, 'config.toml');
  if (fs.existsSync(file)) fs.writeFileSync(file, dropServer(fs.readFileSync(file, 'utf8')));
}

/**
 * A fake `run`: records calls. `mcp get` answers from `state.registered`, `mcp add` sets it, `mcp remove` clears it.
 * With `state.home` (a Codex home), `mcp add` and `mcp remove` also write its config.toml the way the real CLI does (in
 * the home the call's environment names, as the real CLI would, else `state.home`), and `state.rejectApprovals` makes
 * `mcp get` fail once config.toml holds an approval (a Codex that refuses the file). `homes` records each call's
 * CODEX_HOME.
 * The `plugin` verbs answer the way Codex 0.155.1 did in the design spike: a marketplace added again from the same
 * source reports alreadyAdded, from another source is refused; `marketplace upgrade` refuses a local source;
 * `state.noPlugins` makes the CLI predate plugins. `mcp list` shows the plugin's server and a direct registration.
 */
function fakeRun(state = {}) {
  const calls = [];
  const homes = [];
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    homes.push(opts.env ? opts.env.CODEX_HOME : undefined);
    const home = state.home ? (opts.env && opts.env.CODEX_HOME) || state.home : null;
    const key = args.slice(0, 2).join(' ');
    if (key === 'login status') return state.loggedOut ? { status: 1, stdout: 'Not logged in\n', stderr: '' } : { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' };
    const toml = home && fs.existsSync(path.join(home, 'config.toml')) ? fs.readFileSync(path.join(home, 'config.toml'), 'utf8') : '';
    if (key === 'mcp get' && state.rejectApprovals && /approval_mode/.test(toml)) return err('Error: failed to load configuration');
    if (key === 'mcp get') return state.registered ? { status: 0, stdout: JSON.stringify({ name: 'agenticos', transport: { type: 'stdio', command: 'sh', args: [state.registered, 'mcp-server'], env: state.hostEnv ? { AOS_CONFIG: CONFIG, AOS_HOST: 'codex' } : { AOS_CONFIG: CONFIG } } }), stderr: '' } : { status: 1, stdout: '', stderr: 'no such server' };
    if (key === 'mcp add') {
      if (state.failAdd) return { status: 1, stdout: '', stderr: 'boom' };
      state.registered = args[args.indexOf('--') + 2]; state.hostEnv = args.includes('AOS_HOST=codex');
      if (home) codexAdd(home, state.registered, args.slice(0, args.indexOf('--')).filter((a, i, all) => all[i - 1] === '--env'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (key === 'mcp remove') {
      if (home) codexRemove(home);
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
  return { run, calls, homes, state };
}
const argvOf = (calls) => calls.map((c) => c.slice(1).join(' '));

test('mergeHooks writes the six events through the launcher with AOS_HOST=codex, SessionEnd under the 3 s cap, and is idempotent', () => {
  const doc = CH.mergeHooks(null, CTX);
  assert.deepEqual(Object.keys(doc.hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
  const names = (ev) => doc.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command.replace(/^env AOS_HOST=codex AOS_CONFIG='[^']*' sh '[^']*' /, '')));
  assert.deepEqual(names('SessionStart'), ['telemetry-hook', 'update-notice', 'persona-watchdog', 'reconcile-sessions', 'inject-conventions', 'code-session']);
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
  assert.equal(r.written.length, 28, 'twenty-one commands and ten skills, two shared names (wrap, cost), one foreign (brain)');
  assert.equal(CH.countGenerated(dir), 28);
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
  const { run, calls, state } = fakeRun({ home });
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(r.hooksFile, path.join(home, 'hooks.json'));
  assert.equal(r.hooksChanged, true);
  assert.equal(r.mcp, 'added');
  assert.equal(state.registered, LAUNCHER);
  assert.ok(calls.some((c) => c.join(' ') === `/x/codex mcp add agenticos --env AOS_CONFIG=${CONFIG} --env AOS_HOST=codex -- sh ${LAUNCHER} mcp-server`));
  assert.equal(r.skills.written.length, 29);
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
  assert.equal(st.skills, 29);
  assert.equal(st.memories, false);
  const rm = CH.removeCodexHost({ cfg: {}, bin: '/x/codex', run, env, dir });
  assert.equal(rm.hooksFileState, 'deleted');
  assert.equal(rm.hooksRemoved, 6);
  assert.equal(rm.mcp, 'removed');
  assert.equal(state.registered, null);
  assert.equal(rm.skills.length, 29);
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
  const { run, calls, state } = fakeRun({ registered: LAUNCHER, hostEnv: false, home });
  const at = { bin: '/x/codex', run, launcher: LAUNCHER, cfg: {}, env };
  assert.equal(CH.mcpState(at), 'stale');
  assert.equal(CH.mcpRegistered(at), false);
  assert.equal(CH.codexHostStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir }).mcp, 'stale');
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(r.mcp, 'added');
  assert.equal(state.hostEnv, true);
  assert.ok(calls.some((c) => c[1] === 'mcp' && c[2] === 'remove'), 'the stale entry is removed before the add');
  assert.equal(CH.mcpState(at), 'ok');
  assert.equal(CH.mcpState({ ...at, bin: null }), 'no-binary');
  assert.equal(CH.mcpState({ ...at, launcher: '/elsewhere/aos' }), 'missing');
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
  assert.equal(CH.pluginHookCount(), 18);
});

// ── the computer tools' approvals (agent-computer D33) ───────────────────────
const ACTING = ['computer_open', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_tab', 'computer_nav', 'computer_hover'];
const block = (eol = '\n') => ACTING.map((t) => `${eol}[mcp_servers.agenticos.tools.${t}]${eol}approval_mode = "approve"${eol}`).join('');
const codexServer = `[mcp_servers.agenticos]\ncommand = "sh"\nargs = ["${LAUNCHER}", "mcp-server"]\n\n[mcp_servers.agenticos.env]\nAOS_CONFIG = "${CONFIG}"\nAOS_HOST = "codex"\n`;

test('the acting computer tools are the runtime\'s, and the plugin\'s server entry approves exactly those eight (agent-computer D33)', () => {
  const { COMPUTER_TOOLS, COMPUTER_LOOK } = require('../brain/scripts/sdk/computer-tools.js');
  assert.deepEqual(CH.approvedComputerTools(), COMPUTER_TOOLS.filter((t) => !COMPUTER_LOOK.includes(t)));
  assert.deepEqual(CH.approvedComputerTools(), ACTING);
  const server = CH.pluginMcpServers().mcpServers.agenticos;
  assert.deepEqual(server.tools, Object.fromEntries(ACTING.map((t) => [t, { approval_mode: 'approve' }])), 'the look tools need none: they are read-only');
  // What the plugin build commits (`npm run build:codex-plugin`): the same entry, so a plugin-mode session runs them.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'codex-plugin', '.mcp.json'), 'utf8')), CH.pluginMcpServers());
});

test('direct mode: after `codex mcp add` the eight approvals land in config.toml once, in its own mode, and nothing else changes (agent-computer D33)', () => {
  const home = tmp('aos-codex-approve-');
  const dir = tmp('aos-skills-approve-');
  const env = { CODEX_HOME: home };
  const file = path.join(home, 'config.toml');
  const mine = 'model = "gpt-6-astra"\n\n[projects."/srv/code"]\ntrust_level = "trusted"\n\n[mcp_servers.other]\ncommand = "echo"\nargs = ["[mcp_servers.agenticos.tools.computer_open]"]\n';
  fs.writeFileSync(file, mine, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const { run, calls } = fakeRun({ home });
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(r.mcp, 'added');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, `${mine}\n${codexServer}${block()}`, 'the approvals follow the server Codex wrote; every other line is as it was');
  assert.ok(!/computer_(status|snapshot|screenshot|wait)\]/.test(text), 'no table for a look tool');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the file keeps its mode');
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.includes('.tmp')), [], 'no temp file left');
  assert.equal(CH.mcpState({ bin: '/x/codex', run, launcher: LAUNCHER, cfg: {}, env }), 'ok');
  // A second run (aos upgrade): present, the file byte for byte, no table twice.
  const again = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(again.mcp, 'present');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(calls.filter((c) => c[1] === 'mcp' && c[2] === 'add').length, 1);
  assert.equal(CH.codexHostStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir }).mcp, 'ok');
});

test('direct mode: a registration without the approvals reads as unapproved, and aos upgrade writes them in place: no remove, no add (agent-computer D33)', () => {
  const home = tmp('aos-codex-unapproved-');
  const dir = tmp('aos-skills-unapproved-');
  const env = { CODEX_HOME: home };
  const file = path.join(home, 'config.toml');
  // What a release before this one left: Codex's own tables for the server, and no approvals.
  fs.writeFileSync(file, `model = "x"\n\n${codexServer}`);
  const { run, calls } = fakeRun({ home, registered: LAUNCHER, hostEnv: true });
  const at = { bin: '/x/codex', run, launcher: LAUNCHER, cfg: {}, env };
  assert.equal(CH.mcpState(at), 'unapproved');
  assert.equal(CH.mcpRegistered(at), false);
  assert.equal(CH.codexHostStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir }).mcp, 'unapproved');
  assert.equal(CH.codexPluginStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir }).direct.mcp, true, 'still a direct registration beside a plugin');
  const notes = [];
  const io = { warn: (m) => notes.push(`warn ${m}`), log: (m) => notes.push(`log ${m}`) };
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir, io });
  assert.equal(r.mcp, 'approved');
  assert.deepEqual(argvOf(calls).filter((c) => /^mcp (remove|add)/.test(c)), [], 'the registration is right: it stays as it is');
  assert.equal(fs.readFileSync(file, 'utf8'), `model = "x"\n\n${codexServer}${block()}`);
  assert.equal(CH.mcpState(at), 'ok');
  assert.deepEqual(notes, []);
  // A tool the user set to prompt: approved again in place, and the upgrade says so in one line naming it.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('[mcp_servers.agenticos.tools.computer_key]\napproval_mode = "approve"\n', '[mcp_servers.agenticos.tools.computer_key]\napproval_mode = "prompt"\n'));
  assert.equal(CH.mcpState(at), 'unapproved');
  assert.equal(CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir, io }).mcp, 'approved');
  assert.equal(CH.mcpState(at), 'ok');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^log computer_key: approval_mode was "prompt" in .*config\.toml; now "approve"/);
  assert.deepEqual(argvOf(calls).filter((c) => /^mcp (remove|add)/.test(c)), []);
});

test('direct mode: the in-place repair keeps every other setting of the agenticos server (agent-computer D33)', () => {
  const home = tmp('aos-codex-keep-');
  const dir = tmp('aos-skills-keep-');
  const env = { CODEX_HOME: home };
  const file = path.join(home, 'config.toml');
  const mine = codexServer.replace('command = "sh"', 'command = "sh"\nstartup_timeout_sec = 30\ndisabled_tools = ["x"]')
    + '\n[mcp_servers.agenticos.tools.wrap_session]\napproval_mode = "prompt"\n';
  fs.writeFileSync(file, mine);
  const { run, calls } = fakeRun({ home, registered: LAUNCHER, hostEnv: true });
  assert.equal(CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir }).mcp, 'approved');
  assert.equal(fs.readFileSync(file, 'utf8'), `${mine}${block()}`, 'the timeout, the disabled tools and another tool\'s own mode all stay');
  assert.ok(!calls.some((c) => c[1] === 'mcp' && ['remove', 'add'].includes(c[2])));
});

test('direct mode: registration, approvals and read-back use one Codex home: the one aos resolves (agent-computer D33)', () => {
  const recorded = tmp('aos-codex-recorded-');
  const other = tmp('aos-codex-other-');
  const dir = tmp('aos-skills-onehome-');
  const cfg = { hosts: { codex: { home: recorded } } };
  const env = { CODEX_HOME: other };
  const { run, calls, homes } = fakeRun({ home: other });
  assert.equal(CH.installCodexHost({ cfg, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir }).mcp, 'added');
  const mcpCalls = calls.map((c, i) => [c[1], c[2], homes[i]]).filter(([v]) => v === 'mcp');
  assert.deepEqual(mcpCalls.map(([, verb]) => verb), ['get', 'remove', 'add', 'get']);
  assert.ok(mcpCalls.every(([, , h]) => h === path.resolve(recorded)), JSON.stringify(mcpCalls));
  assert.equal(fs.readFileSync(path.join(recorded, 'config.toml'), 'utf8'), `${codexServer}${block()}`);
  assert.ok(!fs.existsSync(path.join(other, 'config.toml')), 'the other home is never written');
  assert.equal(CH.mcpState({ bin: '/x/codex', run, launcher: LAUNCHER, cfg, env }), 'ok');
  calls.length = 0; homes.length = 0;
  assert.equal(CH.removeCodexHost({ cfg, bin: '/x/codex', run, env, dir }).mcp, 'removed');
  assert.deepEqual(homes, [path.resolve(recorded)], 'the removal too');
  assert.ok(!/agenticos/.test(fs.readFileSync(path.join(recorded, 'config.toml'), 'utf8')));
});

test('mcpApprovalProblem says why config.toml does not approve the tools, and whether aos upgrade can fix it', () => {
  const home = tmp('aos-codex-why-');
  const env = { CODEX_HOME: home };
  const file = path.join(home, 'config.toml');
  assert.match(CH.mcpApprovalProblem({}, env).why, /there is no such file/);
  assert.equal(CH.mcpApprovalProblem({}, env).fix, 'by-hand');
  fs.writeFileSync(file, codexServer);
  assert.deepEqual(CH.mcpApprovalProblem({}, env), { file, why: 'the approvals are missing', fix: 'upgrade' });
  fs.writeFileSync(file, `${codexServer}oops = \n`);
  assert.deepEqual([CH.mcpApprovalProblem({}, env).fix, /does not parse/.test(CH.mcpApprovalProblem({}, env).why)], ['by-hand', true]);
  fs.writeFileSync(file, 'model = "x"\n');
  assert.match(CH.mcpApprovalProblem({}, env).why, /no \[mcp_servers\.agenticos\] table/);
  fs.writeFileSync(file, `${codexServer}${block()}`);
  assert.equal(CH.mcpApprovalProblem({}, env), null);
});

test('direct mode: approvals that cannot be written, or that the Codex CLI then refuses, leave config.toml as it was and say so', () => {
  const dir = tmp('aos-skills-refused-');
  // `codex mcp add` wrote somewhere else: no server table in this home, so no tool table for a server Codex would not know.
  const home = tmp('aos-codex-elsewhere-');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n');
  const warnings = [];
  const io = { warn: (m) => warnings.push(m) };
  const a = fakeRun();
  assert.equal(CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run: a.run, env: { CODEX_HOME: home }, dir, io }).mcp, 'unapproved');
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'model = "x"\n');
  assert.match(warnings.at(-1), /approvals were not written to .*config\.toml \(it has no \[mcp_servers\.agenticos\] table\)/);
  assert.match(warnings.at(-1), /computer_open, computer_click, computer_type, computer_key, computer_scroll, computer_tab, computer_nav, computer_hover/);
  // The Codex CLI refuses the file once the approvals are in: it is put back as `codex mcp add` left it.
  const home2 = tmp('aos-codex-rejects-');
  const b = fakeRun({ home: home2, rejectApprovals: true });
  assert.equal(CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run: b.run, env: { CODEX_HOME: home2 }, dir, io }).mcp, 'unapproved');
  assert.equal(fs.readFileSync(path.join(home2, 'config.toml'), 'utf8'), codexServer, 'put back');
  assert.match(warnings.at(-1), /refused config\.toml with them/);
});

test('withMcpApprovals edits only what it must: a wrong mode in place, a missing key under its header, CRLF kept; it refuses what it cannot edit safely', () => {
  const ok = (text) => CH.withMcpApprovals(text);
  // Idempotent on its own output.
  const once = ok(codexServer);
  assert.equal(once.changed, true);
  assert.deepEqual(ok(once.text), { text: once.text, changed: false, replaced: [] });
  assert.deepEqual(CH.mcpApprovalsIn(once.text), ACTING);
  assert.deepEqual(CH.mcpApprovalsIn(codexServer), []);
  // A table already there: its approval_mode is set in place, its other keys and comments stay; a table with no key gets
  // the key right under its header; the rest are added after the server's last table, before the next one.
  const partial = `${codexServer}\n[mcp_servers.agenticos.tools.computer_type]\napproval_mode = "prompt" # mine\nenabled = true\n\n[mcp_servers.agenticos.tools.computer_key]\n# a note\n\n[mcp_servers.zeta]\ncommand = "z"\n`;
  assert.equal(ok(partial).text, `${codexServer}\n[mcp_servers.agenticos.tools.computer_type]\napproval_mode = "approve"\nenabled = true\n\n[mcp_servers.agenticos.tools.computer_key]\napproval_mode = "approve"\n# a note\n`
    + '\n[mcp_servers.agenticos.tools.computer_open]\napproval_mode = "approve"\n\n[mcp_servers.agenticos.tools.computer_click]\napproval_mode = "approve"\n'
    + '\n[mcp_servers.agenticos.tools.computer_scroll]\napproval_mode = "approve"\n'
    + '\n[mcp_servers.agenticos.tools.computer_tab]\napproval_mode = "approve"\n\n[mcp_servers.agenticos.tools.computer_nav]\napproval_mode = "approve"\n'
    + '\n[mcp_servers.agenticos.tools.computer_hover]\napproval_mode = "approve"\n\n[mcp_servers.zeta]\ncommand = "z"\n');
  assert.deepEqual(CH.mcpApprovalsIn(ok(partial).text), ACTING);
  assert.deepEqual(ok(partial).replaced, [{ tool: 'computer_type', was: 'prompt' }], 'a mode the user set is reported');
  // Already approved in single quotes counts; a quoted header counts.
  const quoted = `${codexServer}${block().replace(/"approve"/g, "'approve'").replace(/tools\.computer_open\]/, 'tools."computer_open"]')}`;
  assert.deepEqual(ok(quoted), { text: quoted, changed: false, replaced: [] });
  // CRLF in, CRLF out; a file with no final newline gets one.
  const crlf = codexServer.replace(/\n/g, '\r\n');
  assert.equal(ok(crlf).text, `${crlf}${block('\r\n')}`);
  assert.equal(ok(codexServer.trimEnd()).text, `${codexServer}${block()}`);
  // A CRLF file with no final newline, ending in a tool's approval_mode line or in its header: no bare CR, no lone LF.
  const crlfEnd = (tail) => `${crlf}\r\n[mcp_servers.agenticos.tools.computer_open]${tail}`;
  const rest = ACTING.slice(1).map((t) => `\r\n[mcp_servers.agenticos.tools.${t}]\r\napproval_mode = "approve"\r\n`).join('');
  for (const tail of ['\r\napproval_mode = "prompt"', '']) {
    const out = ok(crlfEnd(tail)).text;
    assert.equal(out, `${crlfEnd('\r\napproval_mode = "approve"')}\r\n${rest}`, JSON.stringify(tail));
    assert.ok(!/[^\r]\n/.test(out) && !/\r(?!\n)/.test(out), 'every line ends in CRLF');
  }
  // A header-looking line inside a multi-line string is not a table.
  const multi = `notes = """\n[mcp_servers.agenticos.tools.computer_open]\napproval_mode = "approve"\n"""\n\n${codexServer}`;
  assert.equal(ok(multi).text, `${multi}${block()}`);
  // Refusals: no server table (a tool table alone would declare a server with no transport), a file that does not parse,
  // and tools set in a form this edit does not write (adding tables would declare them twice).
  assert.throws(() => ok('model = "x"\n'), /no \[mcp_servers\.agenticos\] table/);
  assert.throws(() => ok(`${codexServer}oops = \n`), /does not parse/);
  assert.throws(() => ok(codexServer.replace('command = "sh"', 'command = "sh"\ntools = { computer_open = { approval_mode = "approve" } }')), /tools set in a form/);
  assert.throws(() => ok(codexServer.replace('command = "sh"', 'command = "sh"\ntools.computer_open.approval_mode = "approve"')), /tools set in a form/);
  assert.throws(() => ok(`${codexServer}\n[mcp_servers.agenticos.tools]\ncomputer_click = { approval_mode = "approve" }\n`), /tools set in a form/);
  assert.throws(() => ok(`${codexServer}\n[[mcp_servers.agenticos.tools.computer_open]]\napproval_mode = "approve"\n`), /\[\[array\]\] table/);
});

test('the approvals are written through a symlinked config.toml to its target, which keeps its mode', () => {
  const home = tmp('aos-codex-link-');
  const dots = tmp('aos-dotfiles-');
  const real = path.join(dots, 'codex.toml');
  fs.writeFileSync(real, codexServer, { mode: 0o640 });
  fs.chmodSync(real, 0o640);
  fs.symlinkSync(real, path.join(home, 'config.toml'));
  const { run } = fakeRun({ registered: LAUNCHER, hostEnv: true });
  assert.equal(CH.registerMcp({ bin: '/x/codex', run, launcher: LAUNCHER, config: CONFIG, cfg: {}, env: { CODEX_HOME: home } }), 'approved');
  assert.ok(fs.lstatSync(path.join(home, 'config.toml')).isSymbolicLink(), 'still a link');
  assert.equal(fs.readFileSync(real, 'utf8'), `${codexServer}${block()}`);
  assert.equal(fs.statSync(real).mode & 0o777, 0o640);
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
  const { run, state } = fakeRun({ home });
  CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run });
  assert.deepEqual(CH.removeDirectWiring({ cfg: {}, bin: '/x/codex', run, env, dir }), { hooks: 6, mcp: true, skills: 29 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8')), { hooks: { Stop: [foreign] } });
  assert.equal(state.registered, null);
  assert.ok(!/agenticos/.test(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')), 'the registration goes with its approvals');
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
  const { run } = fakeRun({ home });
  const before = CH.codexPluginStatus({ cfg: {}, launcher: LAUNCHER, run, env, dir });
  assert.equal(before.installed, false);
  assert.equal(before.mcp, 'missing');
  assert.equal(before.hooksTotal, 18);
  CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  CH.installCodexPlugin({ bin: '/x/codex', source: 'owner/repo', run });
  const both = CH.codexPluginStatus({ cfg: {}, launcher: LAUNCHER, run, env, dir });
  assert.equal(both.installed, true);
  assert.equal(both.version, '1.0.0');
  assert.equal(both.mcp, 'ok');
  assert.deepEqual(both.direct, { hookEvents: 6, mcp: true, skills: 29 });
  CH.removeDirectWiring({ cfg: {}, bin: '/x/codex', run, env, dir });
  assert.deepEqual(CH.codexPluginStatus({ cfg: {}, launcher: LAUNCHER, run, env, dir }).direct, { hookEvents: 0, mcp: false, skills: 0 });
});
