'use strict';
/**
 * update-check.js — `aos update-check` / `aos update-status` / `aos update-notice`.
 *
 * One producer owns the network and the clock (`update-check`, run detached); every other surface is a
 * pure read of two files in <vault>/brain/_index/:
 *   update-check.json   state (schema 1)
 *   update-line.txt     pre-rendered status line fragment: zero bytes, or one line plus "\n"
 *
 * Design: docs/superpowers/specs/2026-09-15-update-notification-design.md
 * Contract: every path exits 0 with empty stdout — a hook must never fail a Claude Code session.
 * Zero dependencies; the HTTP getter and the clock are injectable (the `getFn` seam).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// What a release is called where people read it (UniDeX spec D1; app/src/shared/brand.ts).
const PRODUCT = 'UniDeX';
const REPO_SLUG = 'zzoretich/UniDeX-Agent-Harness';
const LATEST_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
// GitHub answers a renamed repository's old API path with a 301 (and any later move the same way).
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const STORE_REL = path.join('brain', '_index', 'update-check.json');
const LINE_REL = path.join('brain', '_index', 'update-line.txt');
const SCHEMA = 1;
const DEFAULT_INTERVAL_HOURS = 24;
const MAX_BACKOFF_DOUBLINGS = 4;
const MAX_BODY_BYTES = 1e6;

// A release tag this CLI is willing to order. Anything else is ignored rather than announced.
const TAG_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** The normalised version inside a tag ("v0.2.0" -> "0.2.0"), or null when it is not orderable semver. */
function parseTag(tag) {
  const m = TAG_RE.exec(String(tag == null ? '' : tag).trim());
  return m ? m[1] : null;
}

function parseSemver(v) {
  const core = parseTag(v);
  if (!core) return null;
  // indexOf, not split('-'): a prerelease may itself contain hyphens ("1.0.0-alpha-1").
  const i = core.indexOf('-');
  return {
    nums: (i === -1 ? core : core.slice(0, i)).split('.').map(Number),
    pre: i === -1 ? '' : core.slice(i + 1),
  };
}

/**
 * Semver §11 prerelease precedence, over the dot-separated identifiers: numeric identifiers
 * compare numerically, a numeric identifier ranks below an alphanumeric one, and a shorter set of
 * identifiers ranks below a longer one when every shared identifier is equal. An absent prerelease
 * (a real release) outranks any prerelease.
 * A plain `a < b` string compare is wrong here: it puts "rc.9" above "rc.10".
 */
function cmpPre(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const ai = a.split('.');
  const bi = b.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (ai[i] === undefined) return -1;
    if (bi[i] === undefined) return 1;
    if (ai[i] === bi[i]) continue;
    const an = /^\d+$/.test(ai[i]);
    const bn = /^\d+$/.test(bi[i]);
    if (an && bn) return Number(ai[i]) < Number(bi[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return ai[i] < bi[i] ? -1 : 1;
  }
  return 0;
}

/** -1 | 0 | 1, or null when either side is not orderable. A prerelease precedes its release. */
function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  return cmpPre(pa.pre, pb.pre);
}

/** The skew rule (design §8): a user is only as upgraded as their least-upgraded part. */
function lowerVersion(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const c = cmpSemver(a, b);
  if (c === null) return a;
  return c <= 0 ? a : b;
}

/** The lowest of the versions given (nulls skipped): what "installed" is when the parts of an install disagree. */
function lowestVersion(...vs) { return vs.reduce((a, b) => lowerVersion(a, b), null); }

/** lib/hud-host.js: the vendored copy beside this file (<vault>/brain/scripts/cli/..), else the checkout's. */
function hudHost() {
  for (const p of [path.join(__dirname, '..', 'lib', 'hud-host.js'), path.join(__dirname, '..', 'brain', 'scripts', 'lib', 'hud-host.js')]) {
    if (fs.existsSync(p)) return require(p);
  }
  return null;
}

/**
 * The Workbench's own version: the UniDeX app's, from the marker it writes in the vault each time it starts
 * (<vault>/brain/_index/hud-host.json, spec 2026-10-05-workbench-app-design D11). An app left on an older release
 * keeps counting as behind until it is updated and opened. null when the app has not run against this vault, or the
 * marker carries no version the check can order: the install is then judged by the plugin and the vault alone.
 */
function hudVersionFrom(vault) {
  if (!vault) return null;
  const H = hudHost();
  const m = H ? H.readMarker(vault) : null;
  return m && parseSemver(m.version) ? m.version : null;
}

function storePath(vault) { return path.join(vault, STORE_REL); }
function linePath(vault) { return path.join(vault, LINE_REL); }

/** tmp + rename: a reader always sees the whole old file or the whole new one, never a partial write. The temp name
 *  is this process's own, so two writers never share one (brain/scripts/lib/fsx.js does the same for the runtime). */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${require('crypto').randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

/** Missing, unparseable, or a foreign schema all mean "no state" — never an error, never a migration. */
function readState(vault) {
  try {
    const s = JSON.parse(fs.readFileSync(storePath(vault), 'utf8'));
    return s && s.schema === SCHEMA ? s : null;
  } catch { return null; }
}

function writeState(vault, state) { writeAtomic(storePath(vault), `${JSON.stringify(state, null, 2)}\n`); }

function isBehind(state) {
  return !!(state && state.latest && state.installed && cmpSemver(state.installed, state.latest) === -1);
}

/** A snooze covers one specific version, so a newer release breaks it. */
function isSnoozed(state, now = new Date()) {
  const s = state && state.snooze;
  if (!s || !s.version || !s.until) return false;
  if (s.version !== state.latest) return false;
  const until = new Date(s.until).getTime();
  return Number.isFinite(until) && until > now.getTime();
}

function isStale(state, { intervalHours = DEFAULT_INTERVAL_HOURS, now = new Date() } = {}) {
  if (!state || !state.checkedAt) return true;
  const t = new Date(state.checkedAt).getTime();
  if (!Number.isFinite(t)) return true;
  if (t > now.getTime()) return true; // clock skew: re-check rather than wait it out
  // Math.max clamps negative failure counts to 0 so exponential backoff never shrinks the interval.
  const doublings = Math.min(Math.max(state.consecutiveFailures || 0, 0), MAX_BACKOFF_DOUBLINGS);
  return now.getTime() - t >= intervalHours * 3600e3 * Math.pow(2, doublings);
}

function renderStatusline(state, now = new Date()) {
  if (!isBehind(state) || isSnoozed(state, now)) return '';
  return `⬆ ${PRODUCT} ${state.latest}`;
}

function renderNotice(state, now = new Date()) {
  if (!isBehind(state) || isSnoozed(state, now)) return '';
  const { latest, pluginVersion, vaultVersion, hudVersion, installed } = state;
  const parts = [['plugin', pluginVersion], ['vault', vaultVersion], ['Workbench', hudVersion]].filter(([, v]) => v);
  const skew = new Set(parts.map(([, v]) => v)).size > 1;
  const have = skew ? parts.map(([k, v]) => `${k} ${v}`).join(', ') : `you have ${installed}`;
  // `aos upgrade` moves the plugin and the vault; the app updates itself (install-and-update I6). Name what is behind.
  const behind = (v) => !!v && cmpSemver(v, latest) === -1;
  const app = behind(hudVersion);
  const runtime = behind(pluginVersion) || behind(vaultVersion);
  const todo = app && !runtime ? `update the ${PRODUCT} app (Check for Updates… in its app menu)`
    : app ? 'run `aos upgrade` and update the app' : 'run `aos upgrade`';
  return `${PRODUCT} ${latest} available (${have}) — ${todo}`;
}

/** Re-rendered by the producer on every check AND by update-notice at every session start, so
 *  snooze expiry is never more than one session stale. */
function writeFragment(vault, state, now = new Date()) {
  const line = renderStatusline(state, now);
  writeAtomic(linePath(vault), line ? `${line}\n` : '');
  return line;
}

function claudeConfigDir() { return require('./host-dirs.js').claudeConfigDir(); }
function agenticosPath(configDir) { return process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json'); }
function readJsonOrNull(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** brain/config.json then agenticos.json, the latter winning key by key (the established precedence).
 *
 *  Three declarations of these defaults exist, all deliberate, and they go stale DIFFERENTLY:
 *   - brain/scripts/config.default.json — the declared default. `init` and `upgrade` merge it into
 *     <vault>/brain/config.json, so changing it reaches only vaults created or upgraded afterwards;
 *     an older vault keeps its own copy, which then OUTRANKS the new default, by design.
 *   - the fallback below — applies only when NEITHER file carries the key, so a stale value here
 *     would be supplied forever and silently.
 *   - brain/scripts/lib/config.js — the canonical precedence implementation this function mirrors.
 *     cli/ cannot require across the vendoring boundary (no path resolves in both the repository
 *     layout and the vendored layout), so the mirror is forced, not chosen.
 *
 *  lib/config.js merges DEEPLY; this merges key-by-key with type guards. Equivalent for a two-scalar
 *  block, and this one is the stricter of the two — a string "6" for intervalHours is rejected rather
 *  than accepted, and a non-boolean `check` is ignored rather than propagated. Revisit the mirror if
 *  the `updates` block ever gains a nested key.
 */
function updatesConfig({ configDir = claudeConfigDir(), vault } = {}) {
  const out = { check: true, intervalHours: DEFAULT_INTERVAL_HOURS };
  const apply = (u) => {
    if (!u || typeof u !== 'object') return;
    if (typeof u.check === 'boolean') out.check = u.check;
    if (Number.isFinite(u.intervalHours) && u.intervalHours > 0) out.intervalHours = u.intervalHours;
  };
  if (vault) apply((readJsonOrNull(path.join(vault, 'brain', 'config.json')) || {}).updates);
  apply((readJsonOrNull(agenticosPath(configDir)) || {}).updates);
  return out;
}

/**
 * GET + JSON parse, following up to MAX_REDIRECTS https redirects. Rejects with an Error carrying .statusCode on a
 * non-200 so callers can single out 404.
 */
function httpGetJson(url, { getFn = (u, o, cb) => https.get(u, o, cb), timeoutMs = 5000, redirects = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const req = getFn(url, {
      headers: { 'user-agent': 'agenticos-update-check', accept: 'application/vnd.github+json' },
    }, (res) => {
      const location = REDIRECTS.has(res.statusCode) && res.headers ? res.headers.location : null;
      if (location) {
        res.resume();
        let next;
        try { next = new URL(location, url); } catch { return fail(new Error(`bad redirect from ${url}`)); }
        if (next.protocol !== 'https:') return fail(new Error(`refusing a non-https redirect from ${url}`));
        if (redirects <= 0) return fail(new Error(`too many redirects from ${url}`));
        if (settled) return;
        settled = true;
        return httpGetJson(next.href, { getFn, timeoutMs, redirects: redirects - 1 }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error(`HTTP ${res.statusCode} for ${url}`);
        e.statusCode = res.statusCode;
        return fail(e);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_BODY_BYTES) { req.destroy(); fail(new Error('response too large')); }
      });
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        try { settled = true; resolve(JSON.parse(body)); } catch (e) { settled = true; reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
  });
}

/**
 * The producer. Writes both files atomically and resolves to the new state, or null when disabled.
 * Never throws: a transport failure preserves the previous known-good `latest`; a 404 is the
 * successful answer "there is no release", which is how this ships dark before the first tag.
 */
async function runCheck({
  vault, vaultVersion = null, pluginVersion = null, configDir = claudeConfigDir(),
  get, now = () => new Date(),
} = {}) {
  if (!vault) return null;
  const cfg = updatesConfig({ configDir, vault });
  if (!cfg.check) return null;

  const prev = readState(vault) || {};
  const at = now();
  const base = {
    schema: SCHEMA,
    checkedAt: at.toISOString(),
    vaultVersion: vaultVersion || prev.vaultVersion || null,
    // Only update-notice runs with CLAUDE_PLUGIN_ROOT set, so the producer must carry this forward
    // rather than clear it — otherwise every daily check would erase the skew signal (design §6.1).
    pluginVersion: pluginVersion || prev.pluginVersion || null,
    // Read fresh on every check: the file in the vault is the truth, not what an earlier check saw.
    hudVersion: hudVersionFrom(vault),
    snooze: prev.snooze || null,
    lastError: null,
    consecutiveFailures: 0,
  };
  base.installed = lowestVersion(base.pluginVersion, base.vaultVersion, base.hudVersion);

  let next;
  try {
    const rel = await httpGetJson(LATEST_URL, { getFn: get });
    const v = parseTag(rel && rel.tag_name);
    // Only the parsed version and a URL we construct ourselves. The release body is never stored.
    next = { ...base, latest: v, url: v ? `https://github.com/${REPO_SLUG}/releases/tag/v${v}` : null };
  } catch (e) {
    if (e.statusCode === 404) {
      next = { ...base, latest: null, url: null };
    } else {
      next = {
        ...base,
        latest: prev.latest || null,
        url: prev.url || null,
        lastError: e.message,
        consecutiveFailures: (prev.consecutiveFailures || 0) + 1,
      };
    }
  }
  next.behind = isBehind(next);
  // Spec §9: a read-only or full vault makes the producer give up silently. It must not turn a
  // completed `aos upgrade` into a failed one.
  try {
    writeState(vault, next);
    writeFragment(vault, next, at);
  } catch (e) {
    if (process.env.AOS_DEBUG === '1') process.stderr.write(`update-check: ${e.message}\n`);
  }
  return next;
}

const { spawn } = require('child_process');

/** "<N>d" or "<N>h", whole numbers only, in milliseconds. null means usage error. */
function parseSnooze(spec) {
  const m = /^(\d+)([dh])$/.exec(String(spec == null ? '' : spec).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!n) return null;
  return n * (m[2] === 'd' ? 86400e3 : 3600e3);
}

function applySnooze({ vault, spec, now = () => new Date() }) {
  const ms = parseSnooze(spec);
  if (ms === null) return null;
  const prev = readState(vault);
  if (!prev || !prev.latest) return prev;
  const at = now();
  const next = { ...prev, snooze: { version: prev.latest, until: new Date(at.getTime() + ms).toISOString() } };
  writeState(vault, next);
  writeFragment(vault, next, at);
  return next;
}

/** The off switch goes in agenticos.json, the higher-precedence file, so nothing can re-enable it. A
 *  file that exists but does not parse is REFUSED, never replaced: rewriting it would discard the
 *  user's vault/node/claude.bin with no warning and silently kill every hook (cli/aos.js:63-75
 *  added readJsonStrict for exactly this class). */
function setOff({ configDir = claudeConfigDir() } = {}) {
  const file = agenticosPath(configDir);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') cfg = {};
    else throw new Error(`refusing to rewrite unparseable ${file}: ${e.message}`);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`refusing to rewrite ${file}: not a JSON object`);
  cfg.updates = { ...(cfg.updates || {}), check: false };
  writeAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

/** The version in a plugin folder's manifest: the Claude Code plugin's `.claude-plugin/`, or the Codex plugin's `.codex-plugin/`. */
function pluginVersionFrom(pluginRoot) {
  if (!pluginRoot) return null;
  for (const dir of ['.claude-plugin', '.codex-plugin']) {
    const p = readJsonOrNull(path.join(pluginRoot, dir, 'plugin.json'));
    const v = p && parseTag(p.version);
    if (v) return v;
  }
  return null;
}

async function cmdUpdateStatus({ vault, configDir = claudeConfigDir(), flags = {}, io = console, now = () => new Date() } = {}) {
  if (flags.off) {
    let file;
    try { file = setOff({ configDir }); } catch (e) { io.error(e.message); return 1; }
    // Clear the fragment too: nothing will refresh it again, and a lingering line would outlive the
    // switch that was meant to silence it.
    if (vault) { try { writeAtomic(linePath(vault), ''); } catch { /* read-only vault: nothing to clear */ } }
    io.log(`update checks disabled in ${file}`);
    return 0;
  }
  if (flags.snooze !== undefined) {
    if (parseSnooze(flags.snooze) === null) { io.error('--snooze takes <N>d or <N>h, for example --snooze 7d'); return 2; }
    const s = vault ? applySnooze({ vault, spec: flags.snooze, now }) : null;
    io.log(s && s.snooze ? `snoozed ${s.snooze.version} until ${s.snooze.until}` : 'nothing to snooze');
    return 0;
  }
  const state = vault ? readState(vault) : null;
  if (flags.statusline) {
    const line = renderStatusline(state, now());
    if (line) io.log(line);
    return 0;
  }
  if (!state) { io.log('no update information yet — this vault has never checked'); return 0; }
  const cfg = updatesConfig({ configDir, vault });
  io.log(`installed ${state.installed || '(unknown)'} · latest ${state.latest || '(none published)'}`);
  // A store with no checkedAt (hand-written or from a future schema this build still accepts) used to
  // print "checked undefined" — fall back the same way `installed`/`latest` already do above.
  io.log(`checked ${state.checkedAt || '(unknown)'}${state.lastError ? ` · last error: ${state.lastError}` : ''}`);
  if (state.snooze) io.log(`snoozed ${state.snooze.version} until ${state.snooze.until}`);
  if (!cfg.check) io.log('update checks are disabled (updates.check = false)');
  const notice = renderNotice(state, now());
  if (notice) io.log(notice);
  return 0;
}

async function cmdUpdateCheck({ vault, configDir = claudeConfigDir(), flags = {}, io = console, now = () => new Date(), get } = {}) {
  const s = await runCheck({ vault, vaultVersion: (readJsonOrNull(agenticosPath(configDir)) || {}).version || null, configDir, get, now });
  if (!flags.quiet) {
    if (!s) io.log('update checks are disabled');
    else io.log(`installed ${s.installed || '(unknown)'} · latest ${s.latest || '(none published)'}${s.lastError ? ` · ${s.lastError}` : ''}`);
  }
  return 0;
}

/**
 * The SessionStart consumer: the update notice, then the status line's lines. Every failure is silence.
 */
async function cmdUpdateNotice(opts = {}) {
  const code = await updateNoticeOnly(opts);
  statuslineNotice(opts);
  return code;
}

function deepMerge(base, over) {
  const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = plain(v) && plain(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

/**
 * The status line at session start (spec 2026-09-28-statusline-design), through the vault's vendored runtime (cli/ may
 * require brain/scripts, never the reverse). Only after `aos statusline install`, and at most one line per host:
 *  - Codex (D7): what needs you, since its footer runs no command. The model is rebuilt here when stale, because a
 *    Codex-only user has no Claude Code render to refresh it.
 *  - Claude Code (D9): the status line someone else took since install, and how to take it back.
 */
function statuslineNotice({ vault, configDir = claudeConfigDir(), io = console, now = () => new Date(), env = process.env } = {}) {
  try {
    if (!vault) return;
    const lib = (rel) => { const p = path.join(vault, 'brain', 'scripts', rel); return fs.existsSync(p) ? require(p) : null; };
    const I = lib('lib/statusline-install.js');
    if (!I) return;
    const userConfigFile = agenticosPath(configDir);
    const state = I.readState(userConfigFile);
    const userCfg = readJsonOrNull(userConfigFile) || {};
    if (env.AOS_HOST === 'codex') {
      if (!state.codex) return;
      const M = lib('lib/statusline-model.js');
      const R = lib('lib/statusline-render.js');
      const defaults = readJsonOrNull(path.join(vault, 'brain', 'scripts', 'config.default.json')) || {};
      const cfg = deepMerge(deepMerge(defaults, readJsonOrNull(path.join(vault, 'brain', 'config.json')) || {}), userCfg);
      const at = now();
      let model = M.read(vault);
      if (M.isStale(model, at)) model = M.refresh(vault, { cfg, now: at }) || model;
      const line = R.summaryLine(model, cfg.statusline && cfg.statusline.segments);
      if (line) io.log(line);
      return;
    }
    if (!state.claude) return;
    const by = I.slotTakenBy({ vault, userConfigFile, userCfg, env });
    if (by) io.log(`AgenticOS status line: replaced by \`${by}\` — run \`aos statusline install\` to take it back (it chains that command).`);
  } catch (e) {
    if (env.AOS_DEBUG === '1') process.stderr.write(`update-notice statusline: ${e.message}\n`);
  }
}

/**
 * The update notice: reads, optionally spawns a detached producer, re-renders the fragment and prints at most one
 * line. Every failure is silence.
 */
async function updateNoticeOnly({
  vault, configDir = claudeConfigDir(), io = console, now = () => new Date(),
  pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.env.AOS_PLUGIN_ROOT || null, spawnFn = spawn,
} = {}) {
  try {
    if (!vault) return 0;
    const cfg = updatesConfig({ configDir, vault });
    if (!cfg.check) return 0;
    const at = now();
    let state = readState(vault);

    // Only this process can see the plugin's own version; persist it so the other consumers can too. The app's marker is
    // read again at every session start, so an app updated (or not) since the last check counts now.
    const pv = pluginVersionFrom(pluginRoot);
    const hv = hudVersionFrom(vault);
    if (state && ((pv && pv !== state.pluginVersion) || hv !== (state.hudVersion || null))) {
      state = { ...state, pluginVersion: pv || state.pluginVersion || null, hudVersion: hv };
      state.installed = lowestVersion(state.pluginVersion, state.vaultVersion, hv);
      state.behind = isBehind(state);
      writeState(vault, state);
    }

    // AOS_NO_SPAWN=1 is a test seam (the shape of AOS_SKIP_NPM / AOS_SKIP_OLLAMA_PROBE /
    // AOS_NODE_CANDIDATES) so the CI rehearsal can exercise this path without touching the network.
    if (process.env.AOS_NO_SPAWN !== '1' && isStale(state, { intervalHours: cfg.intervalHours, now: at })) {
      const child = spawnFn(process.execPath, [path.join(__dirname, 'aos.js'), 'update-check', '--quiet'],
        { detached: true, stdio: 'ignore' });
      if (child && typeof child.on === 'function') child.on('error', () => {}); // an unhandled 'error' would fail the session
      if (child && typeof child.unref === 'function') child.unref();
    }

    if (!state) return 0;
    writeFragment(vault, state, at);
    const notice = renderNotice(state, at);
    if (notice) io.log(notice);
    return 0;
  } catch (e) {
    if (process.env.AOS_DEBUG === '1') process.stderr.write(`update-notice: ${e.message}\n`);
    return 0;
  }
}

module.exports = {
  statuslineNotice,
  REPO_SLUG, LATEST_URL, STORE_REL, LINE_REL, SCHEMA,
  DEFAULT_INTERVAL_HOURS, MAX_BACKOFF_DOUBLINGS, MAX_BODY_BYTES, TAG_RE,
  parseTag, cmpSemver, lowerVersion, lowestVersion, hudVersionFrom,
  storePath, linePath, writeAtomic, readState, writeState,
  isBehind, isSnoozed, isStale, renderStatusline, renderNotice, writeFragment,
  claudeConfigDir, agenticosPath, updatesConfig, httpGetJson, runCheck,
  parseSnooze, applySnooze, setOff, pluginVersionFrom, cmdUpdateStatus, cmdUpdateCheck, cmdUpdateNotice,
};
