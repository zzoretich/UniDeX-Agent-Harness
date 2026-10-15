'use strict';
// `aos hosts add <host>` (install-import B2): one more host wired into an existing install, through init's own steps,
// with the other host left as it was, that host's fast import phases and the schedules re-rendered; refused, writing
// nothing, when there is no vault or the host's CLI is missing or signed out. Fake claude and codex CLIs only.
delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AOS = path.join(ROOT, 'cli', 'aos.js');
const F = (n) => path.join(ROOT, 'cli', 'fixtures', n);
const IMPORT_FIX = path.join(ROOT, 'brain', 'scripts', 'test', 'fixtures', 'import');

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hosts-')));
  const home = path.join(dir, 'home');
  const cfg = path.join(dir, 'cfg');
  const codexHome = path.join(dir, 'codex');
  for (const d of [home, cfg, codexHome]) fs.mkdirSync(d, { recursive: true });
  const env = {
    ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codexHome,
    AOS_CLAUDE_BIN: F('fake-claude.sh'), AOS_CODEX_BIN: F('fake-codex.sh'), AOS_NPM_BIN: F('fake-npm.sh'), AOS_OLLAMA_BIN: F('fake-ollama.sh'), AOS_UV_BIN: F('fake-uv.sh'),
    FAKE_UV_LOG: path.join(dir, 'uv.log'), FAKE_CLAUDE_LOG: path.join(dir, 'claude.log'), FAKE_CODEX_LOG: path.join(dir, 'codex.log'),
    FAKE_CODEX_STATE: path.join(dir, 'codex-mcp.state'), FAKE_NPM_LOG: path.join(dir, 'npm.log'), FAKE_NPM_NODE_MODULES: path.join(ROOT, 'node_modules'),
    OLLAMA_PORT: '1', AOS_SKIP_OLLAMA_PROBE: '1',
  };
  // The two OS schedulers are fakes (cli/schedule.js AOS_*_BIN seams): a Chief of Staff set up here schedules its duties,
  // and nothing may reach the real launchd or crontab. The crontab keeps what it was given in crontab.txt.
  const cron = path.join(dir, 'crontab.txt');
  env.AOS_LAUNCHCTL_BIN = path.join(dir, 'fake-launchctl');
  fs.writeFileSync(env.AOS_LAUNCHCTL_BIN, `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(dir, 'launchctl.log'))}\n`, { mode: 0o755 });
  env.AOS_CRONTAB_BIN = path.join(dir, 'fake-crontab');
  fs.writeFileSync(env.AOS_CRONTAB_BIN, `#!/bin/sh\nif [ "$1" = "-l" ]; then [ -f ${JSON.stringify(cron)} ] && exec cat ${JSON.stringify(cron)}; echo "no crontab for test" >&2; exit 1; fi\ncat > ${JSON.stringify(cron)}\n`, { mode: 0o755 });
  for (const k of ['AOS_VAULT', 'BRAIN_VAULT', 'AOS_CONFIG', 'CLAUDE_PROJECT_DIR', 'XDG_DATA_HOME', 'AOS_NO_CODEX', 'AOS_NO_CLAUDE']) delete env[k];
  const sb = { dir, home, cfg, codexHome, vault: path.join(dir, 'vault'), env, cfgFile: path.join(cfg, 'agenticos.json') };
  /** The routine slugs scheduled with the OS: launchd plists under the sandbox's HOME, or the fake crontab's tagged lines. */
  sb.scheduled = () => {
    if (process.platform === 'darwin') {
      let files = [];
      try { files = fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')); } catch { files = []; }
      return files.map((f) => /^com\.agenticos\.(.+)\.plist$/.exec(f)).filter(Boolean).map((m) => m[1]).sort();
    }
    let text = '';
    try { text = fs.readFileSync(cron, 'utf8'); } catch { text = ''; }
    return [...new Set([...text.matchAll(/# com\.agenticos\.([a-z0-9-]+)/g)].map((m) => m[1]))].sort();
  };
  sb.aos = (args, extra = {}) => spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', env: { ...env, ...extra }, cwd: ROOT });
  sb.log = (k) => { try { return fs.readFileSync(env[k], 'utf8'); } catch { return ''; } };
  return sb;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('a Claude Code install adds Codex: wired as a plugin, both hosts on, AGENTS.md and config.toml imported', () => {
  const sb = sandbox();
  const init = sb.aos(['init', '--host', 'claude', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  fs.copyFileSync(path.join(IMPORT_FIX, 'codex-home', 'AGENTS.md'), path.join(sb.codexHome, 'AGENTS.md'));
  fs.copyFileSync(path.join(IMPORT_FIX, 'codex-home', 'config.toml'), path.join(sb.codexHome, 'config.toml'));
  const before = readJson(sb.cfgFile);
  assert.deepEqual([before.hosts.claude.enabled, before.hosts.codex.enabled], [true, false]);
  const r = sb.aos(['hosts', 'add', 'codex']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const cfg = readJson(sb.cfgFile);
  assert.equal(cfg.vault, sb.vault, 'the recorded vault, never the default');
  assert.deepEqual([cfg.hosts.claude.enabled, cfg.hosts.codex.enabled, cfg.hosts.codex.install, cfg.hosts.codex.bin], [true, true, 'plugin', F('fake-codex.sh')]);
  assert.equal(cfg.hosts.claude.bin, before.hosts.claude.bin, 'the other host is untouched');
  assert.match(sb.log('FAKE_CODEX_LOG'), /^plugin add agenticos@agenticos-workbench --json$/m);
  assert.match(r.stdout, /^hosts add codex: .*fake-codex\.sh$/m);
  assert.match(r.stdout, /^- instructions \(Codex\): 1 written/m, 'whole file: no local model under provider none');
  assert.match(r.stdout, /^- mcp: 2 on Codex listed$/m);
  assert.match(r.stdout, /^- no schedules installed; nothing to re-render/m);
  assert.match(r.stdout, /run \/hooks, and trust the agenticos@agenticos-workbench entries once/);
  assert.match(r.stdout, /Bring in its session history: aos import --from codex$/m);
  assert.doesNotMatch(r.stdout, /sessions queued/, 'the digest is not queued by hosts add');
  // init had a host and skipped the interview (no terminal): a second host leaves that choice alone and says how.
  assert.ok(!fs.existsSync(path.join(sb.vault, 'persona', 'IDENTITY.md')), 'no Chief of Staff set up behind the owner');
  assert.match(r.stdout, /No Chief of Staff on this vault yet: run aos persona to set one up\.$/m);
  const ref = fs.readdirSync(path.join(sb.vault, 'brain', 'memory', 'reference')).find((f) => f.startsWith('codex-global-instructions'));
  assert.ok(ref, 'AGENTS.md became one reference memory');
  assert.match(fs.readFileSync(path.join(sb.vault, 'brain', 'memory', 'reference', ref), 'utf8'), /source: import:codex/);
  const servers = readJson(path.join(sb.vault, 'brain', '_index', 'mcp-servers.json')).servers;
  assert.deepEqual(servers.map((s) => s.name), ['issue-tracker', 'web fetch']);
  assert.ok(!fs.existsSync(path.join(sb.vault, 'brain', '_index', 'import-state.json')) || !readJson(path.join(sb.vault, 'brain', '_index', 'import-state.json')).digest);
});

test('a Codex install adds Claude Code: the plugin installed, both hosts on', () => {
  const sb = sandbox();
  const init = sb.aos(['init', '--host', 'codex', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  fs.writeFileSync(path.join(sb.cfg, 'CLAUDE.md'), '- Always run the tests before saying it is done.\n');
  const r = sb.aos(['hosts', 'add', 'claude', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin marketplace add .*$/m);
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin install agenticos@agenticos-workbench$/m);
  const cfg = readJson(sb.cfgFile);
  assert.deepEqual([cfg.hosts.claude.enabled, cfg.hosts.codex.enabled, cfg.hosts.claude.bin], [true, true, F('fake-claude.sh')]);
  assert.match(r.stdout, /^- instructions \(Claude Code\): 1 written/m);
  assert.match(r.stdout, /Add this line to your CLAUDE\.md .* if it is not there yet:\n\s+@.*AGENTICOS\.md/);
});

test('an install made with --host none adds Claude Code: the plugin installed, Claude on, Codex left off (the F7 guard never applies)', () => {
  const sb = sandbox();
  const init = sb.aos(['init', '--host', 'none', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  assert.match(init.stdout, /aos hosts add claude \(or aos hosts add codex\)/, 'the checklist names the command');
  const r = sb.aos(['hosts', 'add', 'claude', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(sb.log('FAKE_CLAUDE_LOG'), /^plugin install agenticos@agenticos-workbench$/m);
  const cfg = readJson(sb.cfgFile);
  assert.deepEqual([cfg.hosts.claude.enabled, cfg.hosts.codex.enabled], [true, false]);
  // Adding the second host keeps the first: hosts add never narrows, so init's drop guard has nothing to refuse.
  const both = sb.aos(['hosts', 'add', 'codex']);
  assert.equal(both.status, 0, both.stderr + both.stdout);
  assert.deepEqual([readJson(sb.cfgFile).hosts.claude.enabled, readJson(sb.cfgFile).hosts.codex.enabled], [true, true]);
});

/** The routines the OS scheduler should hold: every enabled, valid routine file in the vault (cli/schedule.js installable). */
const installable = (vault) => require(path.join(ROOT, 'brain', 'scripts', 'lib', 'routines-store.js'))
  .list({ dir: path.join(vault, 'brain', 'routines') }).filter((r) => r.enabled && !r.errors.length).map((r) => r.slug).sort();

// install-import B2: the first host is what init's step 8 waited for. `hosts add` sets the Chief of Staff up as init would
// have: the persona from the vault template, the chief role's model for that host, the duties scheduled. Off a terminal
// it takes the default answers and the next steps say how to change them.
for (const [host, model] of [['claude', 'claude-opus-5-5'], ['codex', 'gpt-6-sol']]) {
  test(`an install made with --host none adds ${host}: the Chief of Staff is set up with the default answers and its duties scheduled`, () => {
    const sb = sandbox();
    const init = sb.aos(['init', '--host', 'none', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    assert.ok(!fs.existsSync(path.join(sb.vault, 'persona', 'IDENTITY.md')), 'no Chief of Staff without a host');
    assert.deepEqual(sb.scheduled(), []);
    const r = sb.aos(['hosts', 'add', host, ...(host === 'claude' ? ['--from-local', ROOT] : [])]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(fs.readFileSync(path.join(sb.vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Atlas$/m);
    for (const f of ['STATE.md', 'PLAYBOOK.md', 'duties/tick.md', 'duties/sitrep.md', 'proposals/README.md']) assert.ok(fs.existsSync(path.join(sb.vault, 'persona', f)), f);
    for (const f of ['tick.md', 'heartbeat.md', 'reflect-daily.md']) assert.ok(fs.existsSync(path.join(sb.vault, 'brain', 'routines', f)), f);
    const answers = readJson(path.join(sb.vault, 'persona', 'answers.json'));
    assert.deepEqual([answers.name, answers.schedule, host === 'claude' ? answers.dutyModel : answers.dutyCodexModel], ['Atlas', true, model]);
    const persona = readJson(path.join(sb.vault, 'brain', 'config.json')).persona;
    assert.deepEqual([persona.model, persona.codexModel], ['claude-opus-5-5', 'gpt-6-sol'], 'the chief role\'s models, as shipped');
    // Every enabled routine scheduled, the persona's own (tick, heartbeat, reflect-daily) among them, as init schedules them.
    assert.deepEqual(sb.scheduled(), installable(sb.vault));
    assert.ok(sb.scheduled().includes('tick'));
    assert.doesNotMatch(r.stdout, /no schedules installed/);
    assert.match(r.stdout, new RegExp(`Your Chief of Staff is Atlas, set up with the default answers: its duties run on ${model}\\. Change them with aos persona \\(its name: aos persona rename <name>\\)\\.$`, 'm'));
    // Run again, nothing changes: the Chief of Staff is there now.
    const identity = fs.readFileSync(path.join(sb.vault, 'persona', 'IDENTITY.md'), 'utf8');
    const again = sb.aos(['hosts', 'add', host]);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.doesNotMatch(again.stdout, /Your Chief of Staff is Atlas/);
    assert.equal(fs.readFileSync(path.join(sb.vault, 'persona', 'IDENTITY.md'), 'utf8'), identity);
  });
}

test('the first host never overwrites a Chief of Staff or a model the owner chose, and persona off sets none up', () => {
  // A model the owner chose before any host: kept in brain/config.json, and the one the duties run on.
  const sb = sandbox();
  assert.equal(sb.aos(['init', '--host', 'none', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']).status, 0);
  const vcfg = path.join(sb.vault, 'brain', 'config.json');
  fs.writeFileSync(vcfg, JSON.stringify({ ...readJson(vcfg), persona: { ...readJson(vcfg).persona, codexModel: 'gpt-6-mini' } }, null, 2));
  const r = sb.aos(['hosts', 'add', 'codex']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readJson(vcfg).persona.codexModel, 'gpt-6-mini');
  assert.equal(readJson(path.join(sb.vault, 'persona', 'answers.json')).dutyCodexModel, 'gpt-6-mini');
  assert.match(r.stdout, /its duties run on gpt-6-mini\./);

  // A Chief of Staff already there (set up with `aos persona` before any host): left exactly as it was.
  const sb2 = sandbox();
  assert.equal(sb2.aos(['init', '--host', 'none', '--vault', sb2.vault, '--no-obsidian', '--provider', 'none', '--yes']).status, 0);
  const own = sb2.aos(['persona', '--persona-json', F('persona.json')]);
  assert.equal(own.status, 0, own.stderr + own.stdout);
  const files = ['IDENTITY.md', 'answers.json', 'STATE.md', 'duties/tick.md'].map((f) => [f, fs.readFileSync(path.join(sb2.vault, 'persona', f), 'utf8')]);
  const r2 = sb2.aos(['hosts', 'add', 'claude', '--from-local', ROOT]);
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  for (const [f, text] of files) assert.equal(fs.readFileSync(path.join(sb2.vault, 'persona', f), 'utf8'), text, f);
  assert.doesNotMatch(r2.stdout, /Chief of Staff/);
  assert.deepEqual(sb2.scheduled(), [], 'its answers said no schedule, and none was installed');

  // persona.enabled false in agenticos.json (init's own switch for the interview): none set up.
  const sb3 = sandbox();
  assert.equal(sb3.aos(['init', '--host', 'none', '--vault', sb3.vault, '--no-obsidian', '--provider', 'none', '--yes']).status, 0);
  fs.writeFileSync(sb3.cfgFile, JSON.stringify({ ...readJson(sb3.cfgFile), persona: { enabled: false } }, null, 2));
  const r3 = sb3.aos(['hosts', 'add', 'codex']);
  assert.equal(r3.status, 0, r3.stderr + r3.stdout);
  assert.ok(!fs.existsSync(path.join(sb3.vault, 'persona', 'IDENTITY.md')));
  assert.deepEqual(sb3.scheduled(), []);
});

test('refused, writing nothing: no vault, a missing CLI, a signed-out CLI, a bad verb', () => {
  const sb = sandbox();
  const none = sb.aos(['hosts', 'add', 'codex']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no vault in .*agenticos\.json — run `aos init` first/);
  const init = sb.aos(['init', '--host', 'claude', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const cfgBefore = fs.readFileSync(sb.cfgFile, 'utf8');
  const missing = sb.aos(['hosts', 'add', 'codex'], { AOS_NO_CODEX: '1' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /codex CLI not found — install Codex CLI, then run `aos hosts add codex`/);
  const out = sb.aos(['hosts', 'add', 'codex'], { FAKE_CODEX_LOGGED_OUT: '1' });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /codex is not signed in — run `codex login`/);
  const claudeOut = sb.aos(['hosts', 'add', 'claude'], { FAKE_CLAUDE_LOGGED_OUT: '1' });
  assert.equal(claudeOut.status, 1);
  assert.match(claudeOut.stderr, /claude is not signed in — run `claude auth login`/);
  const claudeMissing = sb.aos(['hosts', 'add', 'claude'], { AOS_NO_CLAUDE: '1' });
  assert.equal(claudeMissing.status, 1);
  assert.match(claudeMissing.stderr, /claude CLI not found/);
  assert.equal(fs.readFileSync(sb.cfgFile, 'utf8'), cfgBefore, 'agenticos.json untouched by every refusal');
  assert.doesNotMatch(sb.log('FAKE_CODEX_LOG'), /plugin add/);
  for (const args of [['hosts'], ['hosts', 'add'], ['hosts', 'add', 'cursor'], ['hosts', 'remove', 'codex'], ['hosts', 'add', 'codex', 'extra']]) {
    const r = sb.aos(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /aos hosts add <claude\|codex>/);
  }
});

test('status: each host as add would find it (on, CLI, signed in) and the next step; it writes nothing', () => {
  const sb = sandbox();
  const none = sb.aos(['hosts', 'status', '--json'], { AOS_NO_CODEX: '1' });
  assert.equal(none.status, 0, none.stderr);
  const n = JSON.parse(none.stdout);
  assert.deepEqual([n.config, n.vault], [null, null], 'no install yet');
  assert.deepEqual(n.hosts.claude, { enabled: false, installed: true, bin: F('fake-claude.sh'), signedIn: true });
  assert.deepEqual(n.hosts.codex, { enabled: false, installed: false, bin: null, signedIn: null });
  const init = sb.aos(['init', '--host', 'claude', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const cfgBefore = fs.readFileSync(sb.cfgFile, 'utf8');
  const codexLog = sb.log('FAKE_CODEX_LOG');
  const r = sb.aos(['hosts', 'status', '--json'], { FAKE_CODEX_LOGGED_OUT: '1' });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.schema, 1);
  assert.equal(s.vault, sb.vault);
  assert.equal(s.config, sb.cfgFile);
  assert.deepEqual(s.hosts.claude, { enabled: true, installed: true, bin: F('fake-claude.sh'), signedIn: true });
  assert.deepEqual(s.hosts.codex, { enabled: false, installed: true, bin: F('fake-codex.sh'), signedIn: false });
  const text = sb.aos(['hosts', 'status'], { FAKE_CLAUDE_LOGGED_OUT: '1' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Claude Code on · .*fake-claude\.sh · signed out {2}→ sign in \(claude auth login\)$/m);
  assert.match(text.stdout, /^Codex {7}off · .*fake-codex\.sh · signed in {2}→ aos hosts add codex$/m);
  const gone = sb.aos(['hosts', 'status'], { AOS_NO_CODEX: '1' });
  assert.match(gone.stdout, /^Codex {7}off · CLI not found {2}→ install it, then aos hosts add codex$/m);
  assert.equal(fs.readFileSync(sb.cfgFile, 'utf8'), cfgBefore, 'agenticos.json untouched');
  assert.doesNotMatch(sb.log('FAKE_CODEX_LOG').slice(codexLog.length), /plugin|mcp add/, 'nothing wired');
  for (const args of [['hosts', 'status', 'codex'], ['hosts', 'stat']]) {
    const bad = sb.aos(args);
    assert.equal(bad.status, 2, args.join(' '));
    assert.match(bad.stderr, /aos hosts status \[--json\]/);
  }
});

test('status: a sign-in check that hangs is stopped and reported as unknown, never left running', () => {
  const sb = sandbox();
  const hang = path.join(sb.dir, 'hang-claude.sh');
  // `claude auth status` that never answers (and ignores SIGTERM): the probe is killed after AOS_HOSTS_PROBE_MS.
  fs.writeFileSync(hang, '#!/bin/sh\ntrap "" TERM\nsleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  const r = sb.aos(['hosts', 'status', '--json'], { AOS_CLAUDE_BIN: hang, AOS_HOSTS_PROBE_MS: '300' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 10_000, 'it did not wait for the hung CLI');
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.hosts.claude, { enabled: false, installed: true, bin: hang, signedIn: null, probe: 'timed out' });
  assert.equal(s.hosts.codex.signedIn, true, 'the other host is checked as usual');
  const text = sb.aos(['hosts', 'status'], { AOS_CLAUDE_BIN: hang, AOS_HOSTS_PROBE_MS: '300' });
  assert.match(text.stdout, /^Claude Code off · .*hang-claude\.sh · sign-in unknown \(timed out\) {2}→ check again: aos hosts status$/m);
});
