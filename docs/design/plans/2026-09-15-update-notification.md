# Update Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a user who has AgenticOS Workbench installed that a newer version exists — in their Claude Code status line and at session start — without ever claiming their status line slot or failing a session.

**Architecture:** A producer/consumer split. One detached command (`aos update-check`) owns the network and the clock; it writes two small files into `<vault>/brain/_index/`. Every other surface — the user's status line, the plugin's `SessionStart` notice, `aos update-status`, the Obsidian HUD — performs a pure read. The status line is never taken over: AgenticOS publishes a pre-rendered one-line fragment that the user composes into their own script.

**Tech Stack:** Node.js ≥ 20, CommonJS, zero runtime dependencies, `node:test` + `node:assert/strict`, POSIX `sh` for the launcher shim, GitHub Releases API (unauthenticated), TypeScript for the Obsidian HUD type only.

**Spec:** `docs/design/specs/2026-09-15-update-notification-design.md`

## Global Constraints

- **Node ≥ 20.** CI runs 20 and 22 on `ubuntu-latest` and `macos-latest`.
- **Zero new runtime dependencies.** The root `package.json` declares none; `cmpSemver` is implemented in-repo rather than adding `semver`.
- **Every failure path exits 0 with empty stdout.** The contract in `plugin/bin/aos` and `plugin/hooks/hooks.json`: *a hook never fails a session.* `AOS_DEBUG=1` may explain on stderr. The single exception is `aos update-status --snooze` with a bad argument, which is a user-invoked usage error (exit 2).
- **The release body is never rendered.** Only the parsed, validated semver. `release.yml` sets `generate_release_notes: true`, so bodies are unbounded changelogs.
- **Links are constructed, never echoed.** `url` is built from `REPO_SLUG` plus the validated tag.
- **No credentials anywhere.** The check is unauthenticated by construction.
- **`installed = min(pluginVersion, vaultVersion)`.** A user is only as upgraded as their least-upgraded part.
- **`schema: 1`** on the store, matching the `lib/pipeline-report.js` ledger convention.
- **Store schema mismatch is treated as "no state"**, never migrated in place.
- **No network in the test suite.** All HTTP is injected via a `getFn` seam, matching `download()` in `cli/aos.js:504`.
- **macOS and Linux only.** Windows is unsupported repository-wide in v1.
- **Tests live beside their source** as `cli/<name>.test.js` and must `delete process.env.AOS_CONFIG / AOS_VAULT / AOS_REPO_HINT` at the top of the file, per the precedent in `cli/cost-cmd.test.js:10-13`.

## File Structure

| File | Responsibility |
|---|---|
| `cli/update-check.js` *(new)* | The whole feature's logic: semver comparison, store I/O, renderers, the HTTP fetch, `runCheck`, snooze, and the three command entry points. Zero deps, every side-effecting seam injected. Lives in `cli/` because `vendorRuntime()` copies that directory wholesale into `<vault>/brain/scripts/cli/`. |
| `cli/update-check.test.js` *(new)* | Unit tests for all of the above. No network. |
| `cli/aos.js` *(modify)* | Flag registration, `USAGE`, three dispatch cases, one `doctor()` row, a re-check at the end of `upgrade()`. |
| `plugin/bin/aos` *(modify)* | One `case` arm adding the three names to the group routed to `cli/aos.js`. |
| `plugin/hooks/hooks.json` *(modify)* | One entry appended to the existing `SessionStart` array. |
| `cli/plugin-manifests.test.js` *(modify)* | Assert the new hook entry and shim dispatch. |
| `brain/scripts/config.default.json` *(modify)* | The `updates` defaults block. |
| `brain/scripts/collectors/config.js` *(modify)* | Surface the cached flag into `snapshot.json` for the HUD. |
| `brain/scripts/test/collectors-config-updates.test.js` *(new)* | Collector tests. Lives in the `brain/scripts` workspace because `collectors/config.js` resolves a vault eagerly at import; that workspace preloads `test/setup.js`. |
| `hud/src/data/snapshot.ts` *(modify)* | Widen the snapshot type. |
| `README.md`, `docs/install.md` *(modify)* | The status line opt-in and the `updates` config block. |
| `cli/rehearsal/first-run.sh` *(modify)* | An `update-notice` leg driven by a fake fetcher. |

**Deliberate deviation from the spec.** The spec (§5) specifies `timeout: 5` for the new hook. `cli/plugin-manifests.test.js:44` asserts that *every* `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop` hook has `timeout: 10`. The plan uses **10**, matching the enforced repository convention rather than introducing a special case.

---

### Task 1: Semver comparison and tag validation

Pure functions, no I/O. Everything downstream depends on ordering being correct, so it is proved first.

**Files:**
- Create: `cli/update-check.js`
- Test: `cli/update-check.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `cmpSemver(a, b) -> -1 | 0 | 1 | null`; `parseTag(tag) -> string | null`; `lowerVersion(a, b) -> string | null`; constants `REPO_SLUG`, `LATEST_URL`, `STORE_REL`, `LINE_REL`, `SCHEMA`, `DEFAULT_INTERVAL_HOURS`, `MAX_BACKOFF_DOUBLINGS`, `MAX_BODY_BYTES`, `TAG_RE`. `parseSemver` and `cmpPre` stay module-internal and are deliberately not exported.

- [ ] **Step 1: Write the failing test**

Create `cli/update-check.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('./update-check.js');

// update-check.js resolves the vault and config from the environment, so a developer's exported
// AOS_CONFIG/AOS_VAULT would redirect this file's writes at their real vault
// (same class as cli/cost-cmd.test.js:10-13).
delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;

test('cmpSemver orders releases and refuses what it cannot order', () => {
  assert.equal(U.cmpSemver('0.1.0', '0.1.0'), 0);
  assert.equal(U.cmpSemver('0.1.0', '0.1.1'), -1);
  assert.equal(U.cmpSemver('0.1.0', '0.2.0'), -1);
  assert.equal(U.cmpSemver('0.9.9', '1.0.0'), -1);
  assert.equal(U.cmpSemver('1.0.0', '0.9.9'), 1);
  assert.equal(U.cmpSemver('v1.2.3', '1.2.3'), 0, 'a leading v is accepted on either side');
  assert.equal(U.cmpSemver('1.0.0-rc.1', '1.0.0'), -1, 'a prerelease precedes its release');
  assert.equal(U.cmpSemver('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(U.cmpSemver('1.0.0-alpha-1', '1.0.0'), -1, 'a hyphen inside the prerelease is not a separator');
  // Semver §11 prerelease precedence. A plain string compare gets every one of these wrong.
  assert.equal(U.cmpSemver('1.0.0-rc.9', '1.0.0-rc.10'), -1, 'numeric identifiers compare numerically, not as text');
  assert.equal(U.cmpSemver('1.0.0-rc.10', '1.0.0-rc.9'), 1);
  assert.equal(U.cmpSemver('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(U.cmpSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1, 'fewer identifiers rank lower');
  assert.equal(U.cmpSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1, 'numeric ranks below alphanumeric');
  assert.equal(U.cmpSemver('1.0.0-alpha.beta', '1.0.0-beta'), -1);
  assert.equal(U.cmpSemver('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  assert.equal(U.cmpSemver('nightly', '1.0.0'), null);
  assert.equal(U.cmpSemver('1.0', '1.0.0'), null, 'two-part versions are not orderable');
  assert.equal(U.cmpSemver(null, '1.0.0'), null);
});

test('parseTag normalises a release tag or refuses it', () => {
  assert.equal(U.parseTag('v0.2.0'), '0.2.0');
  assert.equal(U.parseTag('0.2.0'), '0.2.0');
  assert.equal(U.parseTag('v1.0.0-rc.1'), '1.0.0-rc.1');
  assert.equal(U.parseTag('nightly'), null);
  assert.equal(U.parseTag('v2-beta'), null);
  assert.equal(U.parseTag(''), null);
  assert.equal(U.parseTag(undefined), null);
});

test('lowerVersion implements the skew rule from design section 8', () => {
  assert.equal(U.lowerVersion('0.2.0', '0.1.0'), '0.1.0');
  assert.equal(U.lowerVersion('0.1.0', '0.2.0'), '0.1.0');
  assert.equal(U.lowerVersion('0.1.0', '0.1.0'), '0.1.0');
  assert.equal(U.lowerVersion(null, '0.1.0'), '0.1.0', 'an unobserved plugin version falls back to the vault');
  assert.equal(U.lowerVersion('0.1.0', null), '0.1.0');
  assert.equal(U.lowerVersion(null, null), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test cli/update-check.test.js`
Expected: FAIL — `Cannot find module './update-check.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `cli/update-check.js`:

```js
'use strict';
/**
 * update-check.js — `aos update-check` / `aos update-status` / `aos update-notice`.
 *
 * One producer owns the network and the clock (`update-check`, run detached); every other surface is a
 * pure read of two files in <vault>/brain/_index/:
 *   update-check.json   state (schema 1)
 *   update-line.txt     pre-rendered status line fragment: zero bytes, or one line plus "\n"
 *
 * Design: docs/design/specs/2026-09-15-update-notification-design.md
 * Contract: every path exits 0 with empty stdout — a hook must never fail a Claude Code session.
 * Zero dependencies; the HTTP getter and the clock are injectable (the `getFn` seam mirrors
 * cli/aos.js download()).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const REPO_SLUG = 'zzoretich/AgenticOS-Workbench';
const LATEST_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
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

module.exports = {
  REPO_SLUG, LATEST_URL, STORE_REL, LINE_REL, SCHEMA,
  DEFAULT_INTERVAL_HOURS, MAX_BACKOFF_DOUBLINGS, MAX_BODY_BYTES, TAG_RE,
  parseTag, cmpSemver, lowerVersion,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test cli/update-check.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/update-check.js cli/update-check.test.js
git commit -m "feat: semver comparison and release-tag validation for update checks"
```

---

### Task 2: Store I/O, snooze predicate, and the renderers

Atomic writes and the two rendered surfaces. Still no network.

**Files:**
- Modify: `cli/update-check.js`
- Test: `cli/update-check.test.js`

**Interfaces:**
- Consumes: `cmpSemver`, `lowerVersion`, `SCHEMA`, `STORE_REL`, `LINE_REL` from Task 1.
- Produces: `storePath(vault)`, `linePath(vault)`, `readState(vault) -> object|null`, `writeState(vault, state)`, `writeAtomic(file, text)`, `isBehind(state) -> boolean`, `isSnoozed(state, now) -> boolean`, `isStale(state, {intervalHours, now}) -> boolean`, `renderStatusline(state, now) -> string`, `renderNotice(state, now) -> string`, `writeFragment(vault, state, now) -> string`.

- [ ] **Step 1: Write the failing test**

Append to `cli/update-check.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * A temp vault with brain/_index/, an EMPTY temp config dir, and helpers to read what the module
 * wrote.
 *
 * The config dir is not a convenience. Every entry point defaults `configDir` to
 * `CLAUDE_CONFIG_DIR || ~/.claude`, so any call that omits it reads the developer's REAL
 * `agenticos.json` — and on a machine that has actually run `aos init` (the product's own install
 * path), an `updates.check: false` there would fail these tests for reasons unrelated to the code
 * under test. Deleting env vars at the top of this file does NOT fix that: the final fallback is the
 * real home directory. Only an explicit `configDir` isolates, which is why `cli/cost-cmd.test.js`'s
 * `world()` injects one into every call rather than relying on the env deletions alone.
 */
function vaultWorld() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-upd-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-upd-cfg-'));
  return {
    vault,
    configDir,
    line: () => fs.readFileSync(path.join(vault, 'brain', '_index', 'update-line.txt'), 'utf8'),
    store: () => JSON.parse(fs.readFileSync(path.join(vault, 'brain', '_index', 'update-check.json'), 'utf8')),
  };
}

const behindState = (over = {}) => ({
  schema: 1, checkedAt: '2026-09-15T00:00:00.000Z', installed: '0.1.0',
  vaultVersion: '0.1.0', pluginVersion: '0.1.0', latest: '0.2.0', behind: true,
  url: 'https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.2.0',
  snooze: null, lastError: null, consecutiveFailures: 0, ...over,
});

test('readState refuses a foreign schema and an unparseable store', () => {
  const w = vaultWorld();
  assert.equal(U.readState(w.vault), null, 'missing is not an error');
  U.writeState(w.vault, behindState());
  assert.equal(U.readState(w.vault).latest, '0.2.0');
  fs.writeFileSync(path.join(w.vault, 'brain', '_index', 'update-check.json'), '{ not json');
  assert.equal(U.readState(w.vault), null);
  U.writeState(w.vault, behindState({ schema: 99 }));
  assert.equal(U.readState(w.vault), null, 'a future schema is treated as no state, never migrated');
});

test('writeAtomic leaves no .tmp file behind', () => {
  const w = vaultWorld();
  U.writeState(w.vault, behindState());
  const entries = fs.readdirSync(path.join(w.vault, 'brain', '_index'));
  assert.deepEqual(entries.filter((f) => f.endsWith('.tmp')), []);
});

test('isBehind requires an orderable pair', () => {
  assert.equal(U.isBehind(behindState()), true);
  assert.equal(U.isBehind(behindState({ latest: '0.1.0' })), false);
  assert.equal(U.isBehind(behindState({ latest: null })), false, 'no release yet is not behind');
  assert.equal(U.isBehind(behindState({ installed: '0.3.0' })), false, 'never advise upgrading backwards');
  assert.equal(U.isBehind(behindState({ latest: 'nightly' })), false);
  assert.equal(U.isBehind(null), false);
});

test('isSnoozed covers only the snoozed version, and expires', () => {
  const now = new Date('2026-09-16T00:00:00.000Z');
  const snoozed = behindState({ snooze: { version: '0.2.0', until: '2026-09-22T00:00:00.000Z' } });
  assert.equal(U.isSnoozed(snoozed, now), true);
  assert.equal(U.isSnoozed(behindState({
    snooze: { version: '0.2.0', until: '2026-09-15T00:00:00.000Z' },
  }), now), false, 'an expired snooze re-notifies');
  assert.equal(U.isSnoozed({ ...snoozed, latest: '0.3.0' }, now), false, 'a newer release breaks the snooze');
  assert.equal(U.isSnoozed(behindState(), now), false);
});

test('isStale honours the interval, failure backoff and clock skew', () => {
  const now = new Date('2026-09-16T00:00:00.000Z');
  const at = (iso, over = {}) => behindState({ checkedAt: iso, ...over });
  assert.equal(U.isStale(null, { now }), true, 'no state is stale');
  assert.equal(U.isStale(at('2026-09-15T23:00:00.000Z'), { now }), false, 'one hour old, 24h interval');
  assert.equal(U.isStale(at('2026-09-14T23:00:00.000Z'), { now }), true, '25h old, 24h interval');
  assert.equal(U.isStale(at('2026-09-15T12:00:00.000Z', { consecutiveFailures: 0 }), { now, intervalHours: 6 }), true,
    '12h old against a 6h interval');
  assert.equal(U.isStale(at('2026-09-15T13:00:00.000Z', { consecutiveFailures: 1 }), { now, intervalHours: 6 }), false,
    'one failure doubles 6h to 12h, so an 11h-old check is not yet due');
  assert.equal(U.isStale(at('2026-09-15T12:00:00.000Z', { consecutiveFailures: 1 }), { now, intervalHours: 6 }), true,
    'exactly one interval elapsed counts as due');
  // These two together pin the cap at FOUR doublings (16x24h = 16 days). A three-doubling cap
  // (8 days) would make the 10-day case stale and silently pass the 46-day case too.
  assert.equal(U.isStale(at('2026-08-01T00:00:00.000Z', { consecutiveFailures: 99 }), { now }), true,
    '46 days old is past even the capped 16-day backoff');
  assert.equal(U.isStale(at('2026-09-06T00:00:00.000Z', { consecutiveFailures: 99 }), { now }), false,
    '10 days old is still inside the capped 16-day backoff');
  assert.equal(U.isStale(at('2026-09-15T23:00:00.000Z', { consecutiveFailures: -5 }), { now }), false,
    'a negative failure count must not shrink the interval');
  assert.equal(U.isStale(at('2026-09-17T00:00:00.000Z'), { now }), true, 'a future checkedAt is clock skew');
  assert.equal(U.isStale(at('not a date'), { now }), true);
});

test('renderStatusline is the fragment or nothing', () => {
  const now = new Date('2026-09-16T00:00:00.000Z');
  assert.equal(U.renderStatusline(behindState(), now), '⬆ AgenticOS 0.2.0');
  assert.equal(U.renderStatusline(behindState({ latest: '0.1.0' }), now), '');
  assert.equal(U.renderStatusline(null, now), '');
  assert.equal(U.renderStatusline(behindState({
    snooze: { version: '0.2.0', until: '2026-09-22T00:00:00.000Z' },
  }), now), '');
});

test('renderNotice names the skew when the plugin and vault disagree', () => {
  const now = new Date('2026-09-16T00:00:00.000Z');
  assert.equal(
    U.renderNotice(behindState(), now),
    'AgenticOS Workbench 0.2.0 available (you have 0.1.0) — run `aos upgrade`');
  assert.equal(
    U.renderNotice(behindState({ pluginVersion: '0.2.0', vaultVersion: '0.1.0', installed: '0.1.0' }), now),
    'AgenticOS Workbench 0.2.0 available (plugin 0.2.0, vault 0.1.0) — run `aos upgrade`');
  assert.equal(U.renderNotice(behindState({ latest: '0.1.0' }), now), '');
  assert.equal(U.renderNotice(null, now), '');
});

test('writeFragment writes zero bytes when there is nothing to say', () => {
  const w = vaultWorld();
  const now = new Date('2026-09-16T00:00:00.000Z');
  U.writeFragment(w.vault, behindState(), now);
  assert.equal(w.line(), '⬆ AgenticOS 0.2.0\n');
  U.writeFragment(w.vault, behindState({ latest: '0.1.0' }), now);
  assert.equal(w.line(), '', 'exactly zero bytes, so a cat contributes nothing');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test cli/update-check.test.js`
Expected: FAIL — `U.readState is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Insert into `cli/update-check.js` above `module.exports`:

```js
function storePath(vault) { return path.join(vault, STORE_REL); }
function linePath(vault) { return path.join(vault, LINE_REL); }

/** tmp + rename: a reader always sees the whole old file or the whole new one, never a partial write. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
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
  // MAX_BACKOFF_DOUBLINGS counts DOUBLINGS, so 4 means at most 16x the base interval (16 days at
  // the 24h default). Math.max floors the count at 0: a negative would make 2^n < 1 and SHRINK the
  // interval, turning the backoff into a hammer. Due when at least the interval has elapsed.
  const doublings = Math.min(Math.max(state.consecutiveFailures || 0, 0), MAX_BACKOFF_DOUBLINGS);
  return now.getTime() - t >= intervalHours * 3600e3 * Math.pow(2, doublings);
}

function renderStatusline(state, now = new Date()) {
  if (!isBehind(state) || isSnoozed(state, now)) return '';
  return `⬆ AgenticOS ${state.latest}`;
}

function renderNotice(state, now = new Date()) {
  if (!isBehind(state) || isSnoozed(state, now)) return '';
  const { latest, pluginVersion, vaultVersion, installed } = state;
  const skew = pluginVersion && vaultVersion && cmpSemver(pluginVersion, vaultVersion) !== 0;
  const have = skew ? `plugin ${pluginVersion}, vault ${vaultVersion}` : `you have ${installed}`;
  return `AgenticOS Workbench ${latest} available (${have}) — run \`aos upgrade\``;
}

/** Re-rendered by the producer on every check AND by update-notice at every session start, so
 *  snooze expiry is never more than one session stale. */
function writeFragment(vault, state, now = new Date()) {
  const line = renderStatusline(state, now);
  writeAtomic(linePath(vault), line ? `${line}\n` : '');
  return line;
}
```

Extend the exports:

```js
module.exports = {
  REPO_SLUG, LATEST_URL, STORE_REL, LINE_REL, SCHEMA,
  DEFAULT_INTERVAL_HOURS, MAX_BACKOFF_DOUBLINGS, MAX_BODY_BYTES, TAG_RE,
  parseTag, cmpSemver, lowerVersion,
  storePath, linePath, writeAtomic, readState, writeState,
  isBehind, isSnoozed, isStale, renderStatusline, renderNotice, writeFragment,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test cli/update-check.test.js`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/update-check.js cli/update-check.test.js
git commit -m "feat: atomic update-check store, snooze rules and rendered surfaces"
```

---

### Task 3: The HTTP fetch, `runCheck`, and the `updates` config block

The only component that touches the network. The 404 branch is what lets this ship before the first release exists.

**Files:**
- Modify: `cli/update-check.js`
- Modify: `brain/scripts/config.default.json`
- Test: `cli/update-check.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: `httpGetJson(url, {getFn, timeoutMs}) -> Promise<object>` (rejects with an `Error` carrying `.statusCode` on a non-200); `updatesConfig({configDir, vault}) -> {check: boolean, intervalHours: number}`; `runCheck({vault, vaultVersion, pluginVersion, get, now, configDir}) -> Promise<state>`.

- [ ] **Step 1: Write the failing test**

Append to `cli/update-check.test.js`:

```js
const { EventEmitter } = require('events');

/** A fake https.get: replays one scripted response (or an error) with no network. */
function fakeGet({ status = 200, body = '{}', err = null, chunks = null } = {}) {
  return (_url, _opts, cb) => {
    const req = new EventEmitter();
    req.destroy = (e) => { if (e) req.emit('error', e); };
    req.setTimeout = () => {};
    process.nextTick(() => {
      if (err) return req.emit('error', err);
      const res = new EventEmitter();
      res.statusCode = status;
      res.setEncoding = () => {};
      res.resume = () => {};
      cb(res);
      for (const c of (chunks || [body])) res.emit('data', c);
      res.emit('end');
    });
    return req;
  };
}

const release = (tag) => JSON.stringify({ tag_name: tag, body: 'CHANGELOG\nwith\nmany\nlines' });
const NOW3 = () => new Date('2026-09-16T00:00:00.000Z');

/**
 * `runCheck` bound to one world's ISOLATED config dir and a fixed clock. Tests call this, never
 * `U.runCheck` directly — `configDir` defaults to `CLAUDE_CONFIG_DIR || ~/.claude`, so a call that
 * omits it reads the developer's real `agenticos.json`. Binding it here makes that mistake
 * impossible instead of relying on every future call site to remember.
 */
const check = (w, opts = {}) => U.runCheck({ vault: w.vault, configDir: w.configDir, now: NOW3, ...opts });

test('httpGetJson surfaces the status code on a non-200', async () => {
  await assert.rejects(
    () => U.httpGetJson('https://example.invalid/x', { getFn: fakeGet({ status: 404 }) }),
    (e) => e.statusCode === 404);
  await assert.rejects(
    () => U.httpGetJson('https://example.invalid/x', { getFn: fakeGet({ status: 403 }) }),
    (e) => e.statusCode === 403);
  await assert.rejects(
    () => U.httpGetJson('https://example.invalid/x', { getFn: fakeGet({ body: 'not json' }) }),
    /bad JSON/);
  await assert.rejects(
    () => U.httpGetJson('https://example.invalid/x', { getFn: fakeGet({ err: new Error('ENOTFOUND') }) }),
    /ENOTFOUND/);
});

test('runCheck records a newer release and never renders the release body', async () => {
  const w = vaultWorld();
  const s = await check(w, { vaultVersion: '0.1.0', pluginVersion: '0.1.0', get: fakeGet({ body: release('v0.2.0') }) });
  assert.equal(s.latest, '0.2.0');
  assert.equal(s.behind, true);
  assert.equal(s.installed, '0.1.0');
  assert.equal(s.url, 'https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.2.0');
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.lastError, null);
  assert.equal(w.line(), '⬆ AgenticOS 0.2.0\n');
  assert.ok(!JSON.stringify(s).includes('CHANGELOG'), 'the release body never enters the store');
});

test('runCheck treats 404 as "no release yet" and stays silent', async () => {
  const w = vaultWorld();
  const s = await check(w, { vaultVersion: '0.1.0', get: fakeGet({ status: 404 }) });
  assert.equal(s.latest, null);
  assert.equal(s.behind, false);
  assert.equal(w.line(), '', 'a private repo or an untagged repo says nothing at all');
});

test('runCheck keeps the last known-good latest when the transport fails', async () => {
  const w = vaultWorld();
  await check(w, { vaultVersion: '0.1.0', get: fakeGet({ body: release('v0.2.0') }) });
  for (const bad of [{ err: new Error('ENOTFOUND') }, { status: 403 }, { body: 'not json' }]) {
    const s = await check(w, { vaultVersion: '0.1.0', get: fakeGet(bad) });
    assert.equal(s.latest, '0.2.0', 'the notice must not flicker on a flaky network');
    assert.equal(s.behind, true);
    assert.ok(s.lastError);
  }
  assert.equal(U.readState(w.vault).consecutiveFailures, 3);
  const ok = await check(w, { vaultVersion: '0.1.0', get: fakeGet({ body: release('v0.2.0') }) });
  assert.equal(ok.consecutiveFailures, 0, 'a success resets the backoff');
});

test('runCheck carries pluginVersion forward when it cannot observe it', async () => {
  const w = vaultWorld();
  await check(w, { vaultVersion: '0.1.0', pluginVersion: '0.2.0', get: fakeGet({ body: release('v0.2.0') }) });
  // The detached producer has no CLAUDE_PLUGIN_ROOT, so it passes no pluginVersion at all.
  const s = await check(w, { vaultVersion: '0.1.0', get: fakeGet({ body: release('v0.2.0') }) });
  assert.equal(s.pluginVersion, '0.2.0', 'the skew signal survives a daily check');
  assert.equal(s.installed, '0.1.0');
});

test('runCheck ignores a tag it cannot order', async () => {
  const w = vaultWorld();
  const s = await check(w, { vaultVersion: '0.1.0', get: fakeGet({ body: release('nightly') }) });
  assert.equal(s.latest, null);
  assert.equal(w.line(), '');
});

test('updatesConfig merges brain/config.json under agenticos.json', () => {
  const w = vaultWorld();
  const configDir = w.configDir;
  assert.deepEqual(U.updatesConfig({ configDir, vault: w.vault }), { check: true, intervalHours: 24 });
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'),
    JSON.stringify({ updates: { check: true, intervalHours: 6 } }));
  assert.equal(U.updatesConfig({ configDir, vault: w.vault }).intervalHours, 6);
  fs.writeFileSync(path.join(configDir, 'agenticos.json'),
    JSON.stringify({ vault: w.vault, updates: { check: false } }));
  assert.deepEqual(U.updatesConfig({ configDir, vault: w.vault }), { check: false, intervalHours: 6 },
    'agenticos.json wins key by key');
});

test('runCheck does nothing when the check is disabled', async () => {
  const w = vaultWorld();
  fs.writeFileSync(path.join(w.configDir, 'agenticos.json'),
    JSON.stringify({ vault: w.vault, updates: { check: false } }));
  const s = await check(w, {
    vaultVersion: '0.1.0',
    get: () => { throw new Error('the network must not be touched'); },
  });
  assert.equal(s, null);
  assert.equal(fs.existsSync(path.join(w.vault, 'brain', '_index', 'update-check.json')), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test cli/update-check.test.js`
Expected: FAIL — `U.httpGetJson is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Insert into `cli/update-check.js` above `module.exports`:

```js
function claudeConfigDir() { return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')); }
function agenticosPath(configDir) { return process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json'); }
function readJsonOrNull(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** brain/config.json then agenticos.json, the latter winning key by key (the established precedence). */
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

/** GET + JSON parse. Rejects with an Error carrying .statusCode on a non-200 so callers can single out 404. */
function httpGetJson(url, { getFn = (u, o, cb) => https.get(u, o, cb), timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const req = getFn(url, {
      headers: { 'user-agent': 'agenticos-update-check', accept: 'application/vnd.github+json' },
    }, (res) => {
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
    snooze: prev.snooze || null,
    lastError: null,
    consecutiveFailures: 0,
  };
  base.installed = lowerVersion(base.pluginVersion, base.vaultVersion);

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
  writeState(vault, next);
  writeFragment(vault, next, at);
  return next;
}
```

Extend the exports with `claudeConfigDir, agenticosPath, updatesConfig, httpGetJson, runCheck`.

- [ ] **Step 4: Add the config defaults**

In `brain/scripts/config.default.json`, add the block after `"telemetry"` (existing installs receive it through the `deepMerge(defaults, user)` already in `upgrade()`, user values winning — no migration code):

```json
  "updates": { "check": true, "intervalHours": 24 },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test cli/update-check.test.js`
Expected: PASS — 19 tests.

- [ ] **Step 6: Commit**

```bash
git add cli/update-check.js cli/update-check.test.js brain/scripts/config.default.json
git commit -m "feat: GitHub release check with failure-preserving state and updates config"
```

---

### Task 4: The three command entry points

Thin wrappers that resolve the environment and call Task 1–3 logic. `io` is injected so the tests never write to a real terminal.

**Files:**
- Modify: `cli/update-check.js`
- Test: `cli/update-check.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `parseSnooze(spec) -> number|null` (milliseconds); `applySnooze({vault, spec, now}) -> state|null` (no `configDir` — a snooze touches only vault-scoped store state); `setOff({configDir}) -> string` (the path written); `cmdUpdateStatus({vault, configDir, flags, io, now}) -> Promise<number>`; `cmdUpdateCheck({vault, configDir, flags, io, now, get}) -> Promise<number>`; `cmdUpdateNotice({vault, configDir, io, now, spawnFn}) -> Promise<number>`. All three resolve to an exit code and never throw except `--snooze` usage.

- [ ] **Step 1: Write the failing test**

Append to `cli/update-check.test.js`:

```js
/**
 * A vault plus an agenticos.json pointing at it, and a captured io. Reuses the isolated `configDir`
 * `vaultWorld()` already owns — never the developer's real `~/.claude`.
 */
function cmdWorld(extra = {}) {
  const w = vaultWorld();
  fs.writeFileSync(path.join(w.configDir, 'agenticos.json'),
    JSON.stringify({ version: '0.1.0', vault: w.vault, node: process.execPath, ...extra }, null, 2));
  const outs = [];
  return { ...w, outs, io: { log: (m) => outs.push(String(m)), error: (m) => outs.push(`ERR ${m}`) } };
}

const NOW = () => new Date('2026-09-16T00:00:00.000Z');

test('parseSnooze accepts whole days and hours only', () => {
  assert.equal(U.parseSnooze('7d'), 7 * 86400e3);
  assert.equal(U.parseSnooze('12h'), 12 * 3600e3);
  assert.equal(U.parseSnooze('1d'), 86400e3);
  assert.equal(U.parseSnooze('0d'), null);
  assert.equal(U.parseSnooze('7'), null);
  assert.equal(U.parseSnooze('7w'), null);
  assert.equal(U.parseSnooze('1.5d'), null);
  assert.equal(U.parseSnooze(''), null);
});

test('update-status --statusline prints the fragment and nothing else', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState());
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: { statusline: true }, io: w.io, now: NOW }), 0);
  assert.deepEqual(w.outs, ['⬆ AgenticOS 0.2.0']);
});

test('update-status --statusline prints nothing when current, and still exits 0', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState({ latest: '0.1.0' }));
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: { statusline: true }, io: w.io, now: NOW }), 0);
  assert.deepEqual(w.outs, []);
});

test('update-status with no state explains itself to a human', async () => {
  const w = cmdWorld();
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: {}, io: w.io, now: NOW }), 0);
  assert.match(w.outs.join('\n'), /never checked|no update information/i);
});

test('update-status --snooze records the version and rejects a bad argument', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState());
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: { snooze: '7d' }, io: w.io, now: NOW }), 0);
  const s = U.readState(w.vault);
  assert.equal(s.snooze.version, '0.2.0');
  assert.equal(s.snooze.until, '2026-09-23T00:00:00.000Z');
  assert.equal(w.line(), '', 'the fragment is re-rendered immediately');

  const bad = cmdWorld();
  U.writeState(bad.vault, behindState());
  assert.equal(await U.cmdUpdateStatus({ vault: bad.vault, configDir: bad.configDir, flags: { snooze: '7w' }, io: bad.io, now: NOW }), 2);
  assert.match(bad.outs.join('\n'), /ERR .*--snooze/);
});

test('update-status --off writes to agenticos.json and clears the fragment', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState());
  U.writeFragment(w.vault, behindState(), NOW());
  assert.equal(w.line(), '⬆ AgenticOS 0.2.0\n', 'precondition: a fragment exists');

  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: { off: true }, io: w.io, now: NOW }), 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(w.configDir, 'agenticos.json'), 'utf8'));
  assert.equal(cfg.updates.check, false);
  assert.equal(cfg.vault, w.vault, 'the rest of the config survives');
  assert.equal(fs.existsSync(path.join(w.vault, 'brain', 'config.json')), false,
    'the off switch must live where nothing can override it');
  assert.equal(w.line(), '', 'nothing will refresh the fragment again, so it must not outlive the switch');
});

test('update-check --quiet writes state and prints nothing', async () => {
  const w = cmdWorld();
  assert.equal(await U.cmdUpdateCheck({
    vault: w.vault, configDir: w.configDir, flags: { quiet: true }, io: w.io, now: NOW,
    get: fakeGet({ body: release('v0.2.0') }),
  }), 0);
  assert.deepEqual(w.outs, []);
  assert.equal(U.readState(w.vault).latest, '0.2.0');
});

test('update-notice prints the notice and re-renders the fragment', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState({ checkedAt: NOW().toISOString() }));
  const spawned = [];
  assert.equal(await U.cmdUpdateNotice({
    vault: w.vault, configDir: w.configDir, io: w.io, now: NOW,
    spawnFn: (...a) => spawned.push(a),
  }), 0);
  assert.equal(w.outs.length, 1);
  assert.match(w.outs[0], /^AgenticOS Workbench 0\.2\.0 available/);
  assert.equal(w.line(), '⬆ AgenticOS 0.2.0\n');
  assert.deepEqual(spawned, [], 'a fresh check is not re-spawned');
});

test('update-notice spawns a detached check when the state is stale, without waiting', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState({ checkedAt: '2026-09-01T00:00:00.000Z' }));
  const spawned = [];
  assert.equal(await U.cmdUpdateNotice({
    vault: w.vault, configDir: w.configDir, io: w.io, now: NOW,
    spawnFn: (...a) => spawned.push(a),
  }), 0);
  assert.equal(spawned.length, 1, 'exactly one detached producer');
  assert.match(w.outs[0], /0\.2\.0 available/, 'the notice still comes from the cached state');
});

test('AOS_NO_SPAWN=1 suppresses the detached producer but not the notice', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState({ checkedAt: '2026-09-01T00:00:00.000Z' }));
  const spawned = [];
  process.env.AOS_NO_SPAWN = '1';
  try {
    assert.equal(await U.cmdUpdateNotice({
      vault: w.vault, configDir: w.configDir, io: w.io, now: NOW,
      spawnFn: (...a) => spawned.push(a),
    }), 0);
  } finally { delete process.env.AOS_NO_SPAWN; }
  assert.deepEqual(spawned, [], 'the CI rehearsal must never reach the network');
  assert.match(w.outs[0], /0\.2\.0 available/);
});

test('update-notice is silent and exits 0 with no vault, no state, or an unreadable store', async () => {
  const none = cmdWorld();
  assert.equal(await U.cmdUpdateNotice({ vault: null, configDir: none.configDir, io: none.io, now: NOW, spawnFn: () => {} }), 0);
  assert.deepEqual(none.outs, []);

  const empty = cmdWorld();
  assert.equal(await U.cmdUpdateNotice({ vault: empty.vault, configDir: empty.configDir, io: empty.io, now: NOW, spawnFn: () => {} }), 0);
  assert.deepEqual(empty.outs, [], 'nothing to say before the first check');

  const broken = cmdWorld();
  fs.writeFileSync(path.join(broken.vault, 'brain', '_index', 'update-check.json'), '{ not json');
  assert.equal(await U.cmdUpdateNotice({ vault: broken.vault, configDir: broken.configDir, io: broken.io, now: NOW, spawnFn: () => {} }), 0);
  assert.deepEqual(broken.outs, []);
});

test('update-notice records the plugin version it can see', async () => {
  const w = cmdWorld();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-plug-'));
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agenticos', version: '0.2.0' }));
  U.writeState(w.vault, behindState({ checkedAt: NOW().toISOString(), latest: '0.3.0' }));
  await U.cmdUpdateNotice({ vault: w.vault, configDir: w.configDir, io: w.io, now: NOW, spawnFn: () => {}, pluginRoot: root });
  const s = U.readState(w.vault);
  assert.equal(s.pluginVersion, '0.2.0');
  assert.equal(s.installed, '0.1.0', 'min(plugin 0.2.0, vault 0.1.0)');
  assert.match(w.outs[0], /\(plugin 0\.2\.0, vault 0\.1\.0\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test cli/update-check.test.js`
Expected: FAIL — `U.parseSnooze is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Insert into `cli/update-check.js` above `module.exports`:

```js
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

/** The off switch goes in agenticos.json, the higher-precedence file, so nothing can re-enable it. */
function setOff({ configDir = claudeConfigDir() } = {}) {
  const file = agenticosPath(configDir);
  const cfg = readJsonOrNull(file) || {};
  cfg.updates = { ...(cfg.updates || {}), check: false };
  writeAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

function pluginVersionFrom(pluginRoot) {
  if (!pluginRoot) return null;
  const p = readJsonOrNull(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  return (p && parseTag(p.version)) || null;
}

async function cmdUpdateStatus({ vault, configDir = claudeConfigDir(), flags = {}, io = console, now = () => new Date() } = {}) {
  if (flags.off) {
    const file = setOff({ configDir });
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
  io.log(`checked ${state.checkedAt}${state.lastError ? ` · last error: ${state.lastError}` : ''}`);
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
 * The SessionStart consumer. Reads, optionally spawns a detached producer, re-renders the fragment
 * and prints at most one line. Every failure is silence.
 */
async function cmdUpdateNotice({
  vault, configDir = claudeConfigDir(), io = console, now = () => new Date(),
  pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || null, spawnFn = spawn,
} = {}) {
  try {
    if (!vault) return 0;
    const cfg = updatesConfig({ configDir, vault });
    if (!cfg.check) return 0;
    const at = now();
    let state = readState(vault);

    // Only this process can see the plugin's own version; persist it so the other consumers can too.
    const pv = pluginVersionFrom(pluginRoot);
    if (state && pv && pv !== state.pluginVersion) {
      state = { ...state, pluginVersion: pv };
      state.installed = lowerVersion(pv, state.vaultVersion);
      state.behind = isBehind(state);
      writeState(vault, state);
    }

    // AOS_NO_SPAWN=1 is a test seam (the shape of AOS_SKIP_NPM / AOS_SKIP_OLLAMA_PROBE /
    // AOS_NODE_CANDIDATES) so the CI rehearsal can exercise this path without touching the network.
    if (process.env.AOS_NO_SPAWN !== '1' && isStale(state, { intervalHours: cfg.intervalHours, now: at })) {
      const child = spawnFn(process.execPath, [path.join(__dirname, 'aos.js'), 'update-check', '--quiet'],
        { detached: true, stdio: 'ignore' });
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
```

Extend the exports with `parseSnooze, applySnooze, setOff, pluginVersionFrom, cmdUpdateStatus, cmdUpdateCheck, cmdUpdateNotice`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test cli/update-check.test.js`
Expected: PASS — 31 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/update-check.js cli/update-check.test.js
git commit -m "feat: update-status, update-check and update-notice command entry points"
```

---

### Task 5: Wire the commands into `cli/aos.js`

**Files:**
- Modify: `cli/aos.js` — `VALUE_FLAGS`/`BOOL_FLAGS`, `USAGE`, `main()` switch, `doctor()`, `upgrade()`
- Test: `cli/update-check.test.js` (a dispatch test using the real `aos.js`)

**Interfaces:**
- Consumes: `cmdUpdateStatus`, `cmdUpdateCheck`, `cmdUpdateNotice` from Task 4; `loadConfigOrThrow()`, `readJson()`, `configPath()`, `productVersion()` already in `aos.js`.
- Produces: `aos update-check`, `aos update-status`, `aos update-notice` as real CLI commands; a `doctor()` row named `update check`.

- [ ] **Step 1: Write the failing test**

Append to `cli/update-check.test.js`:

```js
const { spawnSync } = require('child_process');

test('aos.js dispatches the three update commands and rejects a bad flag', () => {
  const w = cmdWorld();
  // AOS_NO_SPAWN=1 is mandatory here: this runs a real subprocess against the real clock, so the
  // seeded checkedAt is stale and update-notice would otherwise spawn a live api.github.com request,
  // breaking the no-network constraint.
  const env = {
    ...process.env, AOS_CONFIG: path.join(w.configDir, 'agenticos.json'),
    HOME: w.configDir, AOS_NO_SPAWN: '1',
  };
  const aos = (args) => spawnSync(process.execPath, [path.join(__dirname, 'aos.js'), ...args], { encoding: 'utf8', env });

  U.writeState(w.vault, behindState());
  const line = aos(['update-status', '--statusline']);
  assert.equal(line.status, 0, line.stderr);
  assert.equal(line.stdout.trim(), '⬆ AgenticOS 0.2.0');

  const notice = aos(['update-notice']);
  assert.equal(notice.status, 0, notice.stderr);
  assert.match(notice.stdout, /0\.2\.0 available/);

  const bad = aos(['update-status', '--nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown flag --nope/);

  const help = aos(['help']);
  assert.match(help.stdout, /aos update-status/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test cli/update-check.test.js`
Expected: FAIL — exit 2 with `unknown command: update-status`.

- [ ] **Step 3: Write the minimal implementation**

In `cli/aos.js`:

```js
// 1. Flags (add to the existing sets):
const VALUE_FLAGS = new Set(['vault', 'provider', 'persona-json', 'from-local', 'budget', 'snooze']);
const BOOL_FLAGS = new Set(['dry-run', 'yes', 'terminal', 'cost', 'keep-vault', 'statusline', 'off', 'quiet']);
```

```js
// 2. USAGE — add these two lines after the `aos cost …` line:
  aos update-status [--statusline | --snooze <N>d|<N>h | --off]
  aos update-check [--quiet]
```

```js
// 3. main() — add before `case 'help':`. update-notice is intentionally absent from USAGE:
//    it is a hook entry point, not something a user types.
    case 'update-check': return updateCheck(flags);
    case 'update-status': return updateStatus(flags);
    case 'update-notice': return updateNotice();
```

```js
// 4. The three thin wrappers — place them next to cost()/provider(). A missing or unreadable
//    agenticos.json must not throw here: these run from hooks.
//    `io: console` matches how aos.js already calls cost-cmd.js and persona (4 existing call sites).
//    Do NOT pass the module-level `out`: it defines only log/warn, and these commands need error().
function updateVault() { const cfg = readJson(configPath()); return (cfg && cfg.vault) || null; }

function updateCheck(flags) {
  return require('./update-check.js').cmdUpdateCheck({ vault: updateVault(), configDir: configDir(), flags, io: console });
}
function updateStatus(flags) {
  return require('./update-check.js').cmdUpdateStatus({ vault: updateVault(), configDir: configDir(), flags, io: console });
}
function updateNotice() {
  return require('./update-check.js').cmdUpdateNotice({ vault: updateVault(), configDir: configDir(), io: console });
}
```

```js
// 5. doctor() — add after the `obsidian plugin` row:
  if (vault) {
    const u = require('./update-check.js');
    const st = u.readState(vault);
    const cfgU = u.updatesConfig({ configDir: configDir(), vault });
    if (!cfgU.check) add('update check', true, 'disabled (updates.check = false)', 'info');
    else if (!st) add('update check', true, 'never run — the next session start schedules one', 'info');
    else add('update check', !st.lastError,
      `checked ${st.checkedAt} · latest ${st.latest || '(none published)'}${st.lastError ? ` · ${st.lastError}` : ''}`,
      'warn');
  }
```

```js
// 6. upgrade() — add immediately before the final `out.log(\`upgraded to v${version}…\`)`.
//    An upgrade is already long and network-bound, so this runs inline: the notice must clear now,
//    not up to intervalHours later.
  await act('refresh the update check', async () => {
    await require('./update-check.js').runCheck({ vault, vaultVersion: version, configDir: configDir() });
  });
```

Add `updateCheck, updateStatus, updateNotice` to `module.exports`.

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `node --test cli/update-check.test.js cli/aos.test.js cli/aos-dispatch.test.js`
Expected: PASS — the new dispatch test plus no regressions.

- [ ] **Step 5: Commit**

```bash
git add cli/aos.js cli/update-check.test.js
git commit -m "feat: register update-check, update-status and update-notice in the aos CLI"
```

---

### Task 6: Wire the launcher shim and the SessionStart hook

**Files:**
- Modify: `plugin/bin/aos`
- Modify: `plugin/hooks/hooks.json`
- Test: `cli/plugin-manifests.test.js`
- Test: `cli/aos-wrapper.test.js:131` — **required, not optional.** That assertion hardcodes the shim's
  `SCRIPT=cli/aos.js` case arm as a literal string, so extending the arm below necessarily makes it
  stale. Updating the expected literal is part of this task, not scope creep.

**Interfaces:**
- Consumes: the three commands from Task 5.
- Produces: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" update-notice` as a working `SessionStart` hook, and `aos update-status` via `~/.local/bin/aos`.

- [ ] **Step 1: Write the failing test**

In `cli/plugin-manifests.test.js`, change the `SessionStart` assertion inside the *existing* `hooks.json wires exactly the contract events, in order, through bin/aos` test:

```js
  assert.deepEqual(names('SessionStart'), ['telemetry-hook', 'update-notice']);
```

and append a new test at the end of the file:

```js
test('bin/aos dispatches every hook and CLI name the manifests reference', () => {
  const shim = fs.readFileSync(path.join(ROOT, 'plugin', 'bin', 'aos'), 'utf8');
  const h = read('plugin/hooks/hooks.json').hooks;
  const referenced = new Set(Object.values(h).flatMap((groups) => groups.flatMap((g) => g.hooks.map((x) => HOOK_RE.exec(x.command)[1]))));
  for (const name of referenced) {
    assert.match(shim, new RegExp(`(^|[|(])\\s*${name}[)|]`, 'm'), `bin/aos does not dispatch ${name}`);
  }
  for (const name of ['update-check', 'update-status', 'update-notice']) {
    assert.match(shim, new RegExp(`[|(]${name}[|)]`), `bin/aos does not route ${name} to cli/aos.js`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test cli/plugin-manifests.test.js`
Expected: FAIL — `SessionStart` is `['telemetry-hook']`, and the shim does not mention `update-notice`.

- [ ] **Step 3: Write the minimal implementation**

In `plugin/hooks/hooks.json`, append to the existing `SessionStart` group's `hooks` array. `timeout: 10` matches every other non-`SessionEnd` hook and the assertion at `cli/plugin-manifests.test.js:44`:

```json
          { "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/bin/aos\" update-notice", "timeout": 10 }
```

In `plugin/bin/aos`, extend the arm that routes to `cli/aos.js`:

```sh
  doctor|status|upgrade|uninstall|persona|cost|terminal|provider|update-check|update-status|update-notice) SCRIPT=cli/aos.js; set -- "$NAME" "$@" ;;
```

- [ ] **Step 4: Update the stale literal assertion in `cli/aos-wrapper.test.js`**

Extending the case arm breaks an assertion that pinned its old text. Update the expected literal to
match — do not loosen the assertion, which would lose the coverage it provides:

```js
  assert.ok(src.includes('doctor|status|upgrade|uninstall|persona|cost|terminal|provider|update-check|update-status|update-notice) SCRIPT=cli/aos.js'), 'maintenance names reach cli/aos.js');
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test cli/plugin-manifests.test.js cli/aos-wrapper.test.js`
Expected: PASS — including `claude plugin validate` if the CLI is on PATH.

Then the full suite, because this task touches two shared test files:

Run: `node --test cli/*.test.js tools/*.test.js`
Expected: 126 passing, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add plugin/bin/aos plugin/hooks/hooks.json cli/plugin-manifests.test.js cli/aos-wrapper.test.js
git commit -m "feat: print the update notice from the SessionStart hook"
```

---

### Task 7: Surface the flag in the Obsidian HUD

**Files:**
- Modify: `brain/scripts/collectors/config.js`
- Modify: `hud/src/data/snapshot.ts`
- Test: `brain/scripts/test/collectors-config-updates.test.js` *(new)*

**Interfaces:**
- Consumes: the store written in Task 3.
- Produces: `snapshot.config.updates` of type `SnapshotUpdates | undefined`.

**Why the test lives here, not in `cli/update-check.test.js`.** `brain/scripts/collectors/config.js`
requires `../lib/paths.js`, which resolves `VAULT` **eagerly at import time** and throws
`no AgenticOS vault found` when none is resolvable — so a bare `require` from `cli/` fails before
`collectConfig` is ever called. Collector tests belong in the `brain/scripts` workspace, which
preloads `test/setup.js` via `NODE_OPTIONS` and runs under its own `npm test`. The file below follows
`brain/scripts/test/collectors-brain.test.js` exactly: a private vault, `process.env.AOS_VAULT` set
**before the first require**, then the collector.

- [ ] **Step 1: Write the failing test**

Create `brain/scripts/test/collectors-config-updates.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// A private vault, set before the first require: lib/paths.js resolves VAULT eagerly and AOS_VAULT
// outranks the shared BRAIN_VAULT that test/setup.js creates (the shape of collectors-brain.test.js).
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-config-updates-'));
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
process.env.AOS_VAULT = VAULT;
const { collectConfig } = require('../collectors/config.js');

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-config-updates-cfg-'));
const storeFile = path.join(VAULT, 'brain', '_index', 'update-check.json');
const write = (o) => fs.writeFileSync(storeFile, `${JSON.stringify(o, null, 2)}\n`);
const store = (over = {}) => ({
  schema: 1, checkedAt: '2026-09-15T00:00:00.000Z', installed: '0.1.0', vaultVersion: '0.1.0',
  pluginVersion: '0.1.0', latest: '0.2.0', behind: true, url: null, snooze: null,
  lastError: null, consecutiveFailures: 0, ...over,
});

test('collectConfig omits updates before the first check', () => {
  fs.rmSync(storeFile, { force: true });
  assert.equal(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates, undefined);
});

test('collectConfig surfaces the update summary for the HUD', () => {
  write(store());
  assert.deepEqual(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates, {
    installed: '0.1.0', latest: '0.2.0', behind: true, checkedAt: '2026-09-15T00:00:00.000Z', snoozed: false,
  });
});

test('collectConfig reports an active snooze and ignores a foreign schema', () => {
  write(store({ snooze: { version: '0.2.0', until: '2099-01-01T00:00:00.000Z' } }));
  assert.equal(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates.snoozed, true);
  write(store({ snooze: { version: '0.1.5', until: '2099-01-01T00:00:00.000Z' } }));
  assert.equal(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates.snoozed, false,
    'a snooze for another version does not silence this one');
  write(store({ schema: 99 }));
  assert.equal(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates, undefined,
    'a foreign schema is ignored, never rendered');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w brain/scripts`
Expected: FAIL — the two `updates` assertions fail because `collectConfig` never sets the field.

- [ ] **Step 3: Write the minimal implementation**

In `brain/scripts/collectors/config.js`, add before `return out;`:

```js
  // The update check owns brain/_index/update-check.json; the HUD only ever reads the summary.
  const upd = readJson(path.join(vault, 'brain', '_index', 'update-check.json'));
  if (upd && upd.schema === 1) {
    const snoozed = !!(upd.snooze && upd.snooze.version === upd.latest
      && new Date(upd.snooze.until).getTime() > Date.now());
    out.updates = {
      installed: upd.installed || null,
      latest: upd.latest || null,
      behind: !!upd.behind,
      checkedAt: upd.checkedAt || null,
      snoozed,
    };
  }
```

In `hud/src/data/snapshot.ts`, add the interface next to `SnapshotSettings` and the field on `SnapshotConfig`:

```ts
export interface SnapshotUpdates {
  installed: string | null;
  latest: string | null;
  behind: boolean;
  checkedAt: string | null;
  snoozed: boolean;
}
```

```ts
export interface SnapshotConfig {
  settings: SnapshotSettings;
  updates?: SnapshotUpdates;
  // …existing fields unchanged
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w brain/scripts && npm run build -w hud`
Expected: PASS — 3 new tests green alongside the workspace's existing suite, and the TypeScript build succeeds.

- [ ] **Step 5: Commit**

```bash
git add brain/scripts/collectors/config.js brain/scripts/test/collectors-config-updates.test.js hud/src/data/snapshot.ts
git commit -m "feat: surface the update flag in the vault snapshot for the HUD"
```

---

### Task 8: Document the opt-in and add the rehearsal leg

**Files:**
- Modify: `README.md`
- Modify: `docs/install.md`
- Modify: `cli/rehearsal/first-run.sh`

**Interfaces:**
- Consumes: every command from Tasks 4–6.
- Produces: no code interface; the documented user-facing contract.

- [ ] **Step 1: Add the rehearsal leg**

In `cli/rehearsal/first-run.sh`, insert this block immediately **before** the `echo "== doctor"` line (currently line 51). It reuses the `AOS` variable already set at line 36 and follows the file's existing idiom: `set -eu`, `echo "== label"`, and inline `[ … ] || { echo …; exit 1; }`. `AOS_NO_SPAWN=1` keeps the leg off the network — the rehearsal must not depend on GitHub reachability or on the repository being public.

```sh
echo "== update notice degrades silently and renders a seeded update"
# Nothing has been checked yet: the notice must print nothing and still exit 0.
OUT=$(AOS_NO_SPAWN=1 sh "$AOS" update-notice 2>&1)
[ -z "$OUT" ] || { echo "update-notice printed before any check: $OUT"; exit 1; }

# A seeded store proves the render path without any network call.
# AOS_NO_SPAWN=1 — NOT the timestamp — is the only thing keeping this leg off the network.
# isStale() treats a FUTURE checkedAt as stale by design (clock skew: re-check rather than wait it
# out), so 2099 reads as "maximally fresh" and behaves as "recheck immediately". Dropping
# AOS_NO_SPAWN here would hand this CI gate a dependency on GitHub's uptime.
cat > "$VAULT/brain/_index/update-check.json" <<'JSON'
{ "schema": 1, "checkedAt": "2099-01-01T00:00:00.000Z", "installed": "0.1.0", "vaultVersion": "0.1.0",
  "pluginVersion": "0.1.0", "latest": "9.9.9", "behind": true, "url": null, "snooze": null,
  "lastError": null, "consecutiveFailures": 0 }
JSON
AOS_NO_SPAWN=1 sh "$AOS" update-status --statusline | grep -q '9.9.9' || { echo "no fragment for a seeded update"; exit 1; }
AOS_NO_SPAWN=1 sh "$AOS" update-notice | grep -q '9.9.9 available' || { echo "no session notice for a seeded update"; exit 1; }
grep -q '9.9.9' "$VAULT/brain/_index/update-line.txt" || { echo "update-notice did not re-render the fragment"; exit 1; }

# Leave the vault as the later legs expect: an unseeded store renders nothing.
rm -f "$VAULT/brain/_index/update-check.json" "$VAULT/brain/_index/update-line.txt"
```

- [ ] **Step 2: Run the rehearsal to verify it passes**

Run: `sh cli/rehearsal/first-run.sh`
Expected: `REHEARSAL-OK`, with the new `== update notice …` section passing. Note the final `BEFORE`/`AFTER` assertion at line 60 compares the *Claude config dir* listing, which this leg does not touch — the seeded files live in the vault and are removed before `uninstall --keep-vault` runs.

- [ ] **Step 3: Document the status line opt-in**

In `README.md`, add a subsection under `## Everyday commands`:

````markdown
### Staying up to date

`aos upgrade` pulls the newest version. To be told when there is one, AgenticOS writes a one-line
fragment that is either empty or the update notice:

```sh
cat "$HOME/AgenticOS/brain/_index/update-line.txt" 2>/dev/null
```

Add that line to your own status line script and it contributes nothing until an update exists. It
reads a file and never touches the network, so it costs nothing per render. AgenticOS never edits
your `settings.json` or claims the status line itself.

You are also told once at the start of every session. The check itself runs at most once a day, in a
detached process, so nothing ever waits on GitHub.

```sh
aos update-status                 # what is installed, what is available
aos update-status --snooze 7d     # silence this version for a week
aos update-status --off           # stop checking entirely
aos update-check                  # check right now
```
````

- [ ] **Step 4: Document the config block**

In `docs/install.md`, add to the configuration reference:

```markdown
### `updates`

| Key | Default | Meaning |
|---|---|---|
| `updates.check` | `true` | Whether to check GitHub Releases for a newer version. |
| `updates.intervalHours` | `24` | Minimum hours between checks. Doubles on consecutive failures, capped at four doublings. |

Set in `brain/config.json`, or in `~/.claude/agenticos.json` to override it (`agenticos.json` wins).
`aos update-status --off` writes `updates.check = false` to `agenticos.json`. The check is
unauthenticated and sends nothing but an HTTP GET to `api.github.com`.
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/install.md cli/rehearsal/first-run.sh
git commit -m "docs: document the update notice, its opt-in fragment and the updates config"
```

---

### Task 9: Publish the first release (operational — needs a human decision)

Until a release exists, everything above is correct and silent: `releases/latest` 404s, so `latest`
stays `null` and no surface renders. This task makes the feature live. **Step 3 is irreversible** —
public git history cannot be recalled — so it requires explicit human confirmation, not an agent's.

**Files:** none in this repository. This is a runbook.

- [ ] **Step 1: Run the privacy gate over the working tree**

```bash
npm run gate
```
Expected: exit 0. `release.yml` runs this too, so a failure here would fail the release anyway.

- [ ] **Step 2: Run the privacy terms over the git history**

`tools/privacy-gate.js` scans `git ls-files --cached --others --exclude-standard` — the working tree
only. Going public publishes every past commit, so the same terms need one pass over history:

```bash
node -e '
const fs=require("fs"),{execFileSync}=require("child_process");
const terms=JSON.parse(fs.readFileSync("tools/privacy-terms.json","utf8"));
const log=execFileSync("git",["log","-p","--no-color"],{maxBuffer:1<<30,encoding:"utf8"}).toLowerCase();
const hits=terms.filter(t=>log.includes(String(t).toLowerCase()));
console.log(hits.length?"HISTORY HITS: "+hits.join(", "):"history clean");
process.exit(hits.length?1:0);'
```
Expected: `history clean`. If it reports hits, **stop** — resolve them (scrub or squash the history)
before going any further. Note that `tools/privacy-exceptions.json` exemptions are path-scoped and do
not apply to this pass, so cross-check any hit against that file before treating it as real.

- [ ] **Step 3: Flip the repository to public (human confirmation required)**

```bash
gh repo edit zzoretich/AgenticOS-Workbench --visibility public --accept-visibility-change-consequences
```

- [ ] **Step 4: Tag the version already installed**

This establishes the baseline so no one is told they are behind on day one, and makes `aos init`'s
Obsidian bundle download work for the first time.

```bash
node tools/bump-version.js 0.1.0 --check   # every surface must already equal the tag
git tag -a v0.1.0 -m "AgenticOS Workbench 0.1.0"
git push origin v0.1.0
```

- [ ] **Step 5: Verify the release and the live check**

```bash
gh run watch                                   # release.yml must pass
gh release view v0.1.0                         # main.js, manifest.json, styles.css attached
curl -fsS https://api.github.com/repos/zzoretich/AgenticOS-Workbench/releases/latest | grep tag_name
aos update-check                               # expect: installed 0.1.0 · latest 0.1.0
aos update-status --statusline                 # expect: no output, because you are current
aos doctor                                     # expect: the `update check` row reports a recent check
```

---

## Self-Review

**1. Spec coverage.** Every section maps to a task: §4 architecture → Tasks 1–4; §5 components → the
File Structure table, all tasks; §6.1 store and the `pluginVersion` writer rule → Tasks 2–3 (test:
*carries pluginVersion forward*); §6.2 fragment byte states → Task 2 (test: *writes zero bytes*);
§6.3 config and precedence → Task 3 (test: *updatesConfig merges*); §6.4 surfaces and `--off`/
`--snooze` semantics → Task 4 + Task 8; §7 Path A → Task 4 (`cmdUpdateNotice`) + Task 6; Path B →
Task 4 + Task 8; Path C → Task 3; §8 skew rule → Task 1 (`lowerVersion`) + Task 4 (test: *records
the plugin version*); §9 all thirteen rows → Tasks 2–4, each with a named test; §10 hardening →
Task 3 (test: *never renders the release body*); §11 testing → the tests inside every task; §12
prerequisites → Task 9; §13 out of scope → nothing implemented.

**2. Placeholder scan.** No `TBD`, no "add error handling", no "similar to Task N". Every code step
carries the actual code; every test step carries the actual assertions.

**3. Type consistency.** Verified across tasks: `readState`/`writeState`/`writeAtomic`/`writeFragment`
/`isBehind`/`isSnoozed`/`isStale`/`renderStatusline`/`renderNotice`/`lowerVersion`/`parseTag`/
`cmpSemver`/`updatesConfig`/`httpGetJson`/`runCheck`/`parseSnooze`/`applySnooze`/`setOff`/
`pluginVersionFrom`/`cmdUpdateStatus`/`cmdUpdateCheck`/`cmdUpdateNotice` are each defined once and
referenced under the same name everywhere. The store's field names (`schema`, `checkedAt`,
`installed`, `vaultVersion`, `pluginVersion`, `latest`, `behind`, `url`, `snooze`, `lastError`,
`consecutiveFailures`) match the spec §6.1 shape exactly and are used consistently by the
`behindState()` fixture, `runCheck`, the renderers, the `doctor()` row and the HUD collector. The
HUD's `SnapshotUpdates` fields match what `collectConfig` writes.

**Gaps found and fixed inline while reviewing.** Two from the spec pass: the `doctor()` row (spec §4,
previously in no task) is now Task 5 Step 3 item 5; and `updates.intervalHours` was read but never
documented, now Task 8 Step 4.

Three more from verifying the plan's assumptions against the live repository — each would have been a
runtime failure during execution:

1. **`io: console`, not `io: out`.** `cli/aos.js:51` defines `out` with only `log` and `warn`, so
   `io.error()` in the `--snooze` usage path would have thrown `TypeError`. `io: console` is the
   convention already used at four existing call sites (`cli/aos.js:618, 719, 841, 846`).
2. **The rehearsal has no `note`/`fail` helpers.** `cli/rehearsal/first-run.sh` uses `set -eu`,
   `echo "== label"` and inline `[ … ] || { echo …; exit 1; }`. Task 8 Step 1 now matches that idiom
   and reuses the `AOS` variable from line 36.
3. **The rehearsal must not reach the network.** `cmdUpdateNotice` on a never-checked vault would
   have spawned a real `api.github.com` request in CI. A new `AOS_NO_SPAWN=1` seam — the shape of the
   existing `AOS_SKIP_NPM` / `AOS_SKIP_OLLAMA_PROBE` / `AOS_NODE_CANDIDATES` seams — suppresses it,
   with its own test in Task 4.

One behaviour gap surfaced while writing those: `--off` disables the producer, so nothing would ever
refresh `update-line.txt` again and a stale fragment would have outlived the switch meant to silence
it. `cmdUpdateStatus` now clears the fragment when `--off` is used, asserted in Task 4.

**Also confirmed by inspection rather than assumed:** `tools/privacy-terms.json` is a flat array (22
entries), so the history-scan one-liner in Task 9 Step 2 is correct as written.
