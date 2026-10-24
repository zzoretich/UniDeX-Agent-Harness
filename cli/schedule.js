'use strict';
/**
 * schedule.js — renders and installs one OS schedule per enabled routine (<vault>/brain/routines/<slug>.md).
 *   macOS: ~/Library/LaunchAgents/com.agenticos.<slug>.plist, loaded with launchctl
 *   Linux: crontab lines ending in "# com.agenticos.<slug>" (merged; never touches other lines).
 * Every schedule runs `run-routine.js <slug>` (brain/scripts/routines/), which delegates duties to
 * persona/run-duty.sh, so the three Chief of Staff duties keep their labels and their contract.
 *
 * What counts as "ours": the slugs of the current routine files, the slugs recorded by the previous
 * sync in brain/_index/routines.json, and the three legacy duty labels from before routines existed —
 * so a deleted routine's plist or cron line is still cleaned up, and `aos uninstall` still removes the
 * pre-migration plists. Anything else in LaunchAgents or the crontab — the optional com.agenticos.ollama
 * supervisor from extras/ollama included — is never matched.
 *
 * Template: extras/schedule/launchd/routine.plist.tmpl — resolved relative to this file, so the checkout
 * (cli/../extras/schedule) and the vendored copy (<vault>/brain/scripts/cli/../extras/schedule) both work;
 * the routine store resolves the same way. Zero dependencies. Every external call is injectable for tests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CRON_TAG = '# com.agenticos.';
const TEMPLATES_DIR = path.join(__dirname, '..', 'extras', 'schedule');
/** Duty labels installed before routines existed (static per-duty plists): still removed by uninstall. */
const LEGACY_DUTIES = ['monitor', 'reflect', 'sitrep'];
const RUNNER_REL = 'brain/scripts/routines/run-routine.js';

function loadStore() {
  for (const p of [path.join(__dirname, '..', 'lib', 'routines-store.js'), path.join(__dirname, '..', 'brain', 'scripts', 'lib', 'routines-store.js')]) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('routines-store.js not found beside cli/schedule.js');
}
/** sdk/lib/models.js beside this file (vendored) or in the checkout: the Chief of Staff's models (local-first A4). */
function chiefModels() {
  for (const p of [path.join(__dirname, '..', 'sdk', 'lib', 'models.js'), path.join(__dirname, '..', 'brain', 'scripts', 'sdk', 'lib', 'models.js')]) {
    if (fs.existsSync(p)) return require(p).CHIEF;
  }
  return { claude: 'claude-opus-5-5', codex: 'gpt-6-sol' };
}
function chiefDefault() { return chiefModels().claude; }
function loadCron() {
  for (const p of [path.join(__dirname, '..', 'lib', 'cron.js'), path.join(__dirname, '..', 'brain', 'scripts', 'lib', 'cron.js')]) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('cron.js not found beside cli/schedule.js');
}

/** lib/test-guard.js beside this file (vendored) or in the checkout; null when neither exists (the guard is inert). */
let testGuard;
function loadTestGuard() {
  if (testGuard !== undefined) return testGuard;
  testGuard = null;
  for (const p of [path.join(__dirname, '..', 'lib', 'test-guard.js'), path.join(__dirname, '..', 'brain', 'scripts', 'lib', 'test-guard.js')]) {
    if (fs.existsSync(p)) { testGuard = require(p); break; }
  }
  return testGuard;
}

/** Default exec: execFileSync, with AOS_LAUNCHCTL_BIN / AOS_CRONTAB_BIN as test seams that replace the binary
 *  (the CLI test sandbox points them at logging fakes so no test ever loads a plist into the real launchd or
 *  rewrites a real crontab). Unset in normal use; under the test runner the real binary is refused (test-guard.js). */
function defaultExec(cmd, args, opts) {
  const bin = cmd === 'launchctl' ? process.env.AOS_LAUNCHCTL_BIN : cmd === 'crontab' ? process.env.AOS_CRONTAB_BIN : null;
  if (!bin && (cmd === 'launchctl' || cmd === 'crontab') && loadTestGuard()) loadTestGuard().guardRealScheduler(`the real ${cmd}`);
  return execFileSync(bin || cmd, args, opts);
}

function launchdLabel(slug) { return `com.agenticos.${slug}`; }
function defaultLaunchAgentsDir() { return path.join(os.homedir(), 'Library', 'LaunchAgents'); }
/** The account's own LaunchAgents folder: os.userInfo() reads the user database, so a test's HOME does not move it. */
function realLaunchAgentsDir() {
  let home;
  try { home = os.userInfo().homedir; } catch { home = os.homedir(); }
  return path.join(home, 'Library', 'LaunchAgents');
}
/** Under the test runner the real LaunchAgents folder is never read, written or emptied (spec
 *  2026-10-24-persona-learning-loop-design D11): a test that reached the default rewrote and deleted real plists. */
function refuseRealLaunchAgents(dir, real = realLaunchAgentsDir()) {
  const g = loadTestGuard();
  if (g && path.resolve(dir) === path.resolve(real)) g.guardRealScheduler(dir);
}
function defaultWarn(message) { process.stderr.write(`schedule: ${message}\n`); }
function routinesDir(vault) { return path.join(vault, 'brain', 'routines'); }
function stateFileFor(vault) { return path.join(vault, 'brain', '_index', 'routines.json'); }

function renderTemplate(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}
/** plists are XML: the agent name and every path are free user text, so escape the three reserved characters
 *  (a vault under ~/R&D would otherwise produce a plist launchctl rejects). execution amendment 2026-09-15 (A30) */
function xmlEscape(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function scheduleVars({ vault, configDir, node, logDir, model, effort, agentName, home = os.homedir() }) {
  return {
    VAULT: vault,
    AOS_CONFIG: path.join(configDir, 'agenticos.json'),
    NODE: node || 'node',
    LOG_DIR: logDir || path.join(vault, 'persona', 'journal', 'logs'),
    MODEL: model || chiefDefault(),
    EFFORT: effort || 'medium',
    AGENT_NAME: agentName || 'persona',
    HOME: home,
  };
}

/** Every routine file in the vault (valid or not); `installable` is the subset the scheduler acts on. */
const DUTY_EFFORTS = ['low', 'medium', 'high'];
function nonEmpty(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

/** <vault>/brain/config.json, or {} when it is missing or does not parse (a schedule render never fails on it). */
function readVaultConfig(vault) {
  try { return JSON.parse(fs.readFileSync(path.join(vault, 'brain', 'config.json'), 'utf8')) || {}; } catch { return {}; }
}

/**
 * The model and effort every duty schedule carries (spec 2026-09-24-duty-model-settings-design D3), as PERSONA_MODEL and
 * PERSONA_EFFORT. Model (the Claude one; persona/chief.js gives Codex persona.codexModel at run time, and moves a duty to
 * the other host when this one cannot start): persona.model → the interview's dutyModel → claude.model → the Chief of
 * Staff's default, claude-opus-5-5 (sdk/lib/models.js chiefModel, local-first A4 — a 2.0 install carries it in
 * persona.model, a pre-2.0 one keeps its null and the chain it ran on). Effort: persona.effort → dutyEffort → medium.
 * userCfg is agenticos.json and wins over vaultCfg (<vault>/brain/config.json), as in lib/config.js loadConfig().
 * A duty routine's own model:/effort: still win for its runs (routines/run-routine.js plan()). `aos routines sync`
 * re-renders every schedule with these.
 */
function dutyRunDefaults({ userCfg = {}, vaultCfg = {}, answers = {} } = {}) {
  const files = [userCfg || {}, vaultCfg || {}];
  const first = (get, ok = () => true) => { for (const c of files) { const v = nonEmpty(get(c)); if (v && ok(v)) return v; } return null; };
  const a = answers || {};
  const effortOk = (v) => DUTY_EFFORTS.includes(v);
  return {
    model: first(c => c.persona && c.persona.model) || nonEmpty(a.dutyModel) || first(c => c.claude && c.claude.model) || chiefDefault(),
    effort: first(c => c.persona && c.persona.effort, effortOk) || (effortOk(nonEmpty(a.dutyEffort)) ? nonEmpty(a.dutyEffort) : null) || 'medium',
  };
}

function listRoutines({ vault, store = loadStore() }) {
  return store.list({ dir: routinesDir(vault) });
}
function installable(routines) { return routines.filter(r => r.enabled && (!r.errors || r.errors.length === 0)); }

/** The launchd calendar array for one routine, as plist XML lines (indented to sit inside the template's <array>). */
function calendarXml(routine, cron = loadCron()) {
  return cron.toLaunchd(routine.schedule).map((e) => {
    const keys = ['Month', 'Day', 'Weekday', 'Hour', 'Minute'].filter(k => e[k] !== undefined);
    return `    <dict>${keys.map(k => `<key>${k}</key><integer>${e[k]}</integer>`).join('')}</dict>`;
  }).join('\n');
}

function renderLaunchd(routine, vars, templatesDir = TEMPLATES_DIR) {
  const escaped = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, xmlEscape(v)]));   // execution amendment 2026-09-15 (A30)
  const tmpl = fs.readFileSync(path.join(templatesDir, 'launchd', 'routine.plist.tmpl'), 'utf8');
  return renderTemplate(tmpl, { ...escaped, LABEL: xmlEscape(launchdLabel(routine.slug)), SLUG: xmlEscape(routine.slug), CALENDAR: calendarXml(routine) });
}

/** One crontab line per routine, each ending in "# com.agenticos.<slug>". The sh -c wrapper lets AOS_NODE be a bare
 *  `node` (resolved through the PATH set on the line) or an absolute path recorded by `aos init`. */
function cronLine(routine, vars) {
  const env = `AOS_CONFIG=${vars.AOS_CONFIG} AOS_VAULT=${vars.VAULT} AOS_NODE=${vars.NODE} PERSONA_NAME=${vars.AGENT_NAME} PERSONA_MODEL=${vars.MODEL} PERSONA_EFFORT=${vars.EFFORT} PERSONA_LOG_DIR=${vars.LOG_DIR} PATH=${vars.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const cmd = `/bin/sh -c 'exec "$AOS_NODE" "$0" "$@"' ${vars.VAULT}/${RUNNER_REL} ${routine.slug}`;
  return `${String(routine.schedule).trim().replace(/\s+/g, ' ')} ${env} ${cmd} >> ${vars.LOG_DIR}/cron-${routine.slug}.log 2>&1 ${CRON_TAG}${routine.slug}`;
}
function renderCron(routines, vars) {
  const lines = installable(routines).map(r => cronLine(r, vars));
  return lines.length ? lines.join('\n') + '\n' : '';
}

function tagRe(slugs) {
  const alt = [...new Set(slugs)].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return alt ? new RegExp(`# com\\.agenticos\\.(${alt})(\\s|$)`) : /$^/;
}
/** Drops only the lines tagged with one of `slugs`; every other line (foreign, com.agenticos.ollama) is kept. */
function stripAgenticosCron(text, slugs) {
  const re = tagRe(slugs);
  return String(text || '').split('\n').filter(l => !re.test(l)).join('\n').replace(/\n+$/, '');
}

// execution amendment 2026-09-15 (A56): a failed `crontab -l` is NOT the same as "no crontab" — only ENOENT
// (no crontab binary at all) or an explicit "no crontab for <user>" stderr means genuinely empty; any other
// failure (spool lock contention, a permission error) means the read is unreliable and the crontab must be
// left untouched rather than treated as empty and overwritten by the next `crontab -`.
function readCrontabResult(exec) {
  try {
    const text = exec('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '';
    return { text, unreadable: false };
  } catch (e) {
    const message = e && (e.stderr || e.message) ? String(e.stderr || e.message).trim() : String(e);
    if (e && e.code === 'ENOENT') return { text: '', unreadable: false };   // no cron here: nothing to merge, nothing to write
    if (/no crontab/i.test(message)) return { text: '', unreadable: false };   // genuinely empty crontab
    return { text: '', unreadable: true, message };
  }
}
function readCrontabWith(exec) {
  const r = readCrontabResult(exec);
  return r.unreadable ? null : r.text;   // null: "unreadable" — distinct from '' ("genuinely empty")
}
function writeCrontabWith(exec, text) {
  exec('crontab', ['-'], { input: text.endsWith('\n') ? text : `${text}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
}

/** The slug set this scheduler owns: current files ∪ last sync ∪ the legacy duties. */
function knownSlugs({ routines = [], state = null } = {}) {
  return [...new Set([...routines.map(r => r.slug), ...Object.keys((state && state.synced) || {}), ...LEGACY_DUTIES])];
}
function readStateSafe(store, file) { try { return store.readState({ file }); } catch { return { schema: 1, routines: {}, synced: {}, syncedAt: null }; } }

/** Whether launchd has this job loaded (`launchctl list <label>` exits 0 only then). */
function launchdLoaded(exec, label) {
  try { exec('launchctl', ['list', label], { stdio: 'ignore' }); return true; } catch { return false; }
}

/**
 * Renders and (re)loads one schedule per installable routine, removes the schedules of routines that are now
 * disabled, invalid or gone, and records { synced: { slug: fingerprint }, syncedAt } in routines.json.
 * `routines` may be injected (tests); by default they are read from vars.VAULT.
 * On macOS a routine whose plist is already byte for byte what it renders, and loaded, is left alone: unloading a job
 * stops it if it is running (launchd sends its process group SIGTERM), so a sync never cuts an unchanged routine short.
 */
function installSchedules({ platform = process.platform, vars, routines, store = loadStore(), templatesDir = TEMPLATES_DIR,
  launchAgentsDir = defaultLaunchAgentsDir(), stateFile, exec = defaultExec, readCrontab, writeCrontab, warn = defaultWarn, now = () => new Date() } = {}) {
  fs.mkdirSync(vars.LOG_DIR, { recursive: true });
  const all = routines || listRoutines({ vault: vars.VAULT, store });
  const active = installable(all);
  const file = stateFile || stateFileFor(vars.VAULT);
  const state = readStateSafe(store, file);
  const stale = knownSlugs({ routines: all, state }).filter(s => !active.some(r => r.slug === s));
  const record = () => {
    const synced = Object.fromEntries(active.map(r => [r.slug, store.fingerprint(r)]));
    const syncedAt = now().toISOString();
    state.synced = synced;
    state.syncedAt = syncedAt;
    // Merged into a fresh, locked read (spec 2026-09-24-locked-writers D2): `state` was read before the launchd/cron
    // work, and writing it back whole erased any run a routine recorded meanwhile.
    try {
      if (store.updateState) store.updateState((s) => { s.synced = synced; s.syncedAt = syncedAt; }, { file });
      else store.writeState(state, { file });
    } catch (e) { warn(`could not record the sync in ${file}: ${e.message}`); }
  };
  if (platform === 'darwin') {
    refuseRealLaunchAgents(launchAgentsDir);
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    const written = []; const removed = []; const warnings = [];
    const unchanged = [];
    for (const r of active) {
      const plist = path.join(launchAgentsDir, `${launchdLabel(r.slug)}.plist`);
      const text = renderLaunchd(r, vars, templatesDir);
      let before = null;
      try { before = fs.readFileSync(plist, 'utf8'); } catch { before = null; }
      if (before === text && launchdLoaded(exec, launchdLabel(r.slug))) { written.push(plist); unchanged.push(plist); continue; }
      fs.writeFileSync(plist, text);
      try { exec('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
      // execution amendment 2026-09-15 (A30): a failing load is reported, never thrown — it must not abort `aos init` step 8.
      try { exec('launchctl', ['load', plist], { stdio: 'ignore' }); }
      catch (e) { const m = `launchctl load ${plist}: ${e && e.message ? e.message : e}`; warnings.push(m); warn(m); }
      written.push(plist);
    }
    for (const s of stale) {
      const plist = path.join(launchAgentsDir, `${launchdLabel(s)}.plist`);
      if (!fs.existsSync(plist)) continue;
      try { exec('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch { /* already unloaded */ }
      fs.unlinkSync(plist);
      removed.push(plist);
    }
    record();
    return { platform, written, unchanged, removed, labels: active.map(r => launchdLabel(r.slug)), warnings };
  }
  if (platform === 'linux') {
    const warnings = [];
    let current;
    if (readCrontab) {
      current = readCrontab();
    } else {
      // execution amendment 2026-09-15 (A56): an injected readCrontab always returns a string (tests' fakes never
      // signal "unreadable"); only the default seam, going through the real crontab binary via exec, can be unreadable.
      const r = readCrontabResult(exec);
      if (r.unreadable) {
        const m = `crontab -l failed (${r.message}) — crontab left untouched; install the routine lines by hand`;
        warnings.push(m); warn(m);
        return { platform, written: [], removed: [], labels: [], warnings };
      }
      current = r.text;
    }
    const write = writeCrontab || ((t) => writeCrontabWith(exec, t));
    const kept = stripAgenticosCron(current, knownSlugs({ routines: all, state }));
    // execution amendment 2026-09-15 (A57): a failing `crontab -` is reported, never thrown — it must not abort
    // `aos init` step 8 (darwin's launchctl load failure is already handled the same way, above).
    try {
      const lines = renderCron(all, vars).trim();
      write(`${kept ? `${kept}\n` : ''}${lines ? `${lines}\n` : ''}`);
    } catch (e) {
      const m = `crontab - failed (${e && e.message ? e.message : e})`;
      warnings.push(m); warn(m);
      return { platform, written: [], removed: [], labels: [], warnings };
    }
    record();
    return { platform, written: ['crontab'], removed: stale.filter(s => tagRe([s]).test(current)).map(s => `${CRON_TAG}${s}`), labels: active.map(r => `${CRON_TAG}${r.slug}`), warnings };
  }
  return { platform, written: [], removed: [], labels: [], unsupported: true, warnings: [] };
}

/**
 * Takes ONE routine's schedule out and touches nothing else (install-import B10: a routine that turned itself off, the
 * import-digest routine once its queue is empty): its plist unloaded and deleted (macOS) or its crontab line dropped
 * (Linux), and its entry dropped from the sync record, so the Routines tab does not ask to apply schedules. Every other
 * job stays loaded: unloading one that is running would stop it. → { platform, removed, warnings }
 */
function removeSchedule({ slug, platform = process.platform, vault, store = null, launchAgentsDir = defaultLaunchAgentsDir(), stateFile,
  exec = defaultExec, readCrontab, writeCrontab, warn = defaultWarn } = {}) {
  const removed = []; const warnings = [];
  const plist = path.join(launchAgentsDir, `${launchdLabel(slug)}.plist`);
  if (platform === 'darwin') refuseRealLaunchAgents(launchAgentsDir);
  if (platform === 'darwin' && fs.existsSync(plist)) {
    try { exec('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch { /* not loaded */ }
    fs.unlinkSync(plist);
    removed.push(plist);
  }
  if (platform === 'linux') {
    let current = null;
    if (readCrontab) current = readCrontab();
    else {
      const r = readCrontabResult(exec);
      if (r.unreadable) {
        const m = `crontab -l failed (${r.message}) — crontab left untouched`;
        warnings.push(m); warn(m);
      } else current = r.text;
    }
    if (current !== null && tagRe([slug]).test(current)) {
      const kept = stripAgenticosCron(current, [slug]);
      try { (writeCrontab || ((t) => writeCrontabWith(exec, t)))(kept ? `${kept}\n` : ''); removed.push(`${CRON_TAG}${slug}`); }
      catch (e) { const m = `crontab - failed (${e && e.message ? e.message : e})`; warnings.push(m); warn(m); }
    }
  }
  if (vault) {
    try {
      const st = store || loadStore();
      const file = stateFile || stateFileFor(vault);
      st.updateState((s) => { if (s.synced && Object.prototype.hasOwnProperty.call(s.synced, slug)) delete s.synced[slug]; }, { file });
    } catch (e) { const m = `could not update the sync record: ${e.message}`; warnings.push(m); warn(m); }
  }
  return { platform, removed, warnings };
}

/** Removes every schedule this scheduler owns (files, last sync, legacy duties) and clears the sync record. */
function removeSchedules({ platform = process.platform, vault, store = null, launchAgentsDir = defaultLaunchAgentsDir(), stateFile,
  exec = defaultExec, readCrontab, writeCrontab, warn = defaultWarn } = {}) {
  const removed = []; const warnings = [];
  let st = null; let routines = [];
  const file = stateFile || (vault ? stateFileFor(vault) : null);
  if (vault) {
    try { store = store || loadStore(); routines = listRoutines({ vault, store }); st = readStateSafe(store, file); } catch { /* no store beside us: legacy labels only */ }
  }
  const slugs = knownSlugs({ routines, state: st });
  // Plists go on every platform (Plan 3's uninstall test seeds them under $HOME on ubuntu too; a stray plist on
  // Linux is harmless to delete). Only launchctl is darwin-specific. Anything else in launchAgentsDir — the
  // com.agenticos.ollama supervisor included — is never matched.
  refuseRealLaunchAgents(launchAgentsDir);
  for (const s of slugs) {
    const plist = path.join(launchAgentsDir, `${launchdLabel(s)}.plist`);
    if (!fs.existsSync(plist)) continue;
    if (platform === 'darwin') { try { exec('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch { /* already unloaded */ } }
    fs.unlinkSync(plist);
    removed.push(plist);
  }
  if (platform === 'linux') {
    let current;
    if (readCrontab) {
      current = readCrontab();
    } else {
      // execution amendment 2026-09-15 (A56): same unreadable-vs-empty distinction as installSchedules — a
      // teardown must finish, so an unreadable crontab is left alone rather than guessed at.
      const r = readCrontabResult(exec);
      if (r.unreadable) {
        const m = `crontab -l failed (${r.message}) — crontab left untouched`;
        warnings.push(m); warn(m);
        return { platform, removed, warnings };
      }
      current = r.text;
    }
    if (tagRe(slugs).test(current)) {
      const write = writeCrontab || ((t) => writeCrontabWith(exec, t));
      // execution amendment 2026-09-15 (A57): a failing `crontab -` is reported, never thrown — `aos uninstall`
      // must finish its teardown even when the crontab write fails.
      try { write(`${stripAgenticosCron(current, slugs)}\n`); removed.push('crontab'); }
      catch (e) { const m = `crontab - failed (${e && e.message ? e.message : e})`; warnings.push(m); warn(m); }
    }
  }
  if (st && store && file) {
    st.synced = {}; st.syncedAt = null;
    try {
      if (store.updateState) store.updateState((s) => { s.synced = {}; s.syncedAt = null; }, { file });
      else store.writeState(st, { file });
    } catch { /* best effort */ }
  }
  return { platform, removed, warnings };
}

function isInstalled({ platform = process.platform, vault, launchAgentsDir = defaultLaunchAgentsDir(), stateFile, exec = defaultExec, readCrontab } = {}) {
  let routines = []; let st = null;
  if (vault) { try { const store = loadStore(); routines = listRoutines({ vault, store }); st = readStateSafe(store, stateFile || stateFileFor(vault)); } catch { /* legacy only */ } }
  const slugs = knownSlugs({ routines, state: st });
  if (platform === 'darwin') {
    refuseRealLaunchAgents(launchAgentsDir);
    return slugs.some(s => fs.existsSync(path.join(launchAgentsDir, `${launchdLabel(s)}.plist`)));
  }
  if (platform === 'linux') return tagRe(slugs).test((readCrontab || (() => readCrontabWith(exec)))() || '');
  return false;
}

module.exports = {
  CRON_TAG, TEMPLATES_DIR, LEGACY_DUTIES, RUNNER_REL, launchdLabel, renderTemplate, xmlEscape, scheduleVars, dutyRunDefaults, readVaultConfig, chiefModels,
  listRoutines, installable, calendarXml, renderLaunchd, renderCron, cronLine, stripAgenticosCron, knownSlugs,
  installSchedules, removeSchedules, removeSchedule, isInstalled, defaultExec, realLaunchAgentsDir, refuseRealLaunchAgents,
};
