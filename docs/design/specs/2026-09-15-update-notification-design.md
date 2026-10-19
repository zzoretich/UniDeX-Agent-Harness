# Update notification — design

**Date:** 2026-09-15
**Status:** approved design, ready for an implementation plan
**Scope:** tell a user who has AgenticOS Workbench installed that a newer version exists, in their Claude Code status line and at session start.

---

## 1. Problem

`aos upgrade` already does the right thing: it updates the marketplace and plugin, re-vendors
`brain/scripts`, migrates `agenticos.json`, merges new config defaults, rebuilds the Obsidian bundle
and refreshes the indexes. What is missing is not the action but the **awareness** — nothing tells a
user that running it would get them anything.

This design adds that signal. It does not change what an upgrade does.

## 2. Decisions

Four decisions were settled before design, and the rest of this document follows from them.

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | **AgenticOS never takes the status line slot.** It publishes a pre-rendered fragment that a user composes into their own status line, and always prints the notice at session start through a channel the plugin owns outright. | `aos init` rewriting `settings.json` to wrap the user's existing status line command. |
| D2 | **The repository goes public and the check is unauthenticated** against GitHub Releases. | Staying private and shelling out to `gh` / storing a PAT; or publishing the version to a separate public channel. |
| D3 | **A `SessionStart` hook owns the poll**, reading a cache and spawning a detached check when it is older than the configured interval. | Folding the check into the scheduled duties (which users may decline); or checking synchronously on the session-start critical path. |
| D4 | **The notice persists until the user upgrades**, with one snooze escape hatch and a global off switch. No severity tiers. | Semver-driven severity tiers; or announcing each version exactly once. |

**Consequence of D3, stated plainly:** a release published five minutes ago is announced at the user's
*next* session, not the current one. This is the accepted cost of keeping session start off the network.

## 3. What already exists

Verified against the repository at `92b170b`. Three of these were initially assumed missing and are not.

- **`aos upgrade`** — `cli/aos.js`. Complete.
- **The installed version is already on disk.** `buildUserConfig()` writes `version` into
  `~/.claude/agenticos.json` on both `init` and `upgrade`.
- **Version fan-out is solved.** `tools/bump-version.js` keeps six surfaces in lockstep from the root
  `package.json`, and has a `--check` mode.
- **The release pipeline is complete.** `.github/workflows/release.yml` fires on `v*` tags and already
  enforces `bump-version.js --check` against the tag, runs `npm run gate`, tests and builds the
  Obsidian workspace, and publishes a Release with `main.js`, `manifest.json` and `styles.css`
  attached. **It has never run, because no tag has ever been pushed.**
- **`cli/*.js` is already vendored** into `<vault>/brain/scripts/cli/` by `vendorRuntime()`, minus
  tests, fixtures and the rehearsal. A new module in `cli/` reaches every vault with no installer change.
- **`plugin/bin/aos` is both surfaces at once** — the hook shim *and* the user-facing launcher
  (`~/.local/bin/aos` → `<vault>/brain/scripts/bin/aos`, a copy of it). One `case` arm serves both.
- **A `SessionStart` hook already exists** (`telemetry-hook`), so the notice is one array entry.
- **The graceful-degradation contract is already written down**, in both `plugin/bin/aos` and
  `hooks.json`: exit 0 when the workbench is not initialized, so *a hook never fails a session*.

Two things genuinely do not exist: **no git tags and no GitHub Releases** (so
`releases/latest` 404s, and `aos init`'s Obsidian bundle download at
`releases/download/v<version>/…` can only ever have failed), and **the repository is private**.

## 4. Architecture

One rule: **exactly one component touches the network or the clock. Every other component performs a
pure read of small files.**

```
        ┌─ PRODUCER — network + clock, detached, never inside a session ─┐
        │  aos update-check                                              │
        │    GET https://api.github.com/repos/<slug>/releases/latest     │
        │    5s timeout · no auth · User-Agent set                       │
        └───────────────────────────┬────────────────────────────────────┘
                                    │ atomic write (tmp + rename), two files
              ┌─────────────────────▼─────────────────────┐
              │  THE STORE                                │
              │  <vault>/brain/_index/update-check.json   │  state
              │  <vault>/brain/_index/update-line.txt     │  pre-rendered fragment
              └─────────────────────┬─────────────────────┘
          ┌───────────────┬─────────┴────────┬──────────────────┐
          │ read          │ read             │ read             │ read
 ┌────────▼───────┐ ┌─────▼──────────┐ ┌─────▼─────────┐ ┌──────▼────────┐
 │ user's status  │ │ aos            │ │ aos           │ │ scan-vault.js │
 │ line:          │ │ update-notice  │ │ update-status │ │ -> snapshot   │
 │ cat update-    │ │ (SessionStart) │ │ (humans,      │ │ .json (data   │
 │ line.txt       │ │                │ │  scripting)   │ │  only — no    │
 │                │ │                │ │               │ │  HUD render)  │
 └────────────────┘ └────────────────┘ └───────────────┘ └───────────────┘
```

The fourth path is data-only in this branch: `snapshot.json` carries the `updates` flag, but nothing in
`hud/src/views/` renders it yet. A HUD indicator for it is a follow-up, not part of this
branch.

**Why the split.** The status line is re-run on every session event, debounced at 300ms, and the
in-flight script is **cancelled** when another trigger lands. Anything slower than reading a small
file there is a latency bug, and a network call would routinely be killed before returning. Inverting
the responsibility — the producer owns time and the network, consumers only render — is what makes a
low-millisecond status line segment possible at all.

**Why a pre-rendered fragment and not just the JSON.** The cheapest possible opt-in for a user who
already has a status line is a `cat` of a file that is either empty or exactly the line to show — no
Node process, no JSON parse, no branching in their script. `aos update-status` still exists for
humans and for scripting, but it is not on the hot path.

**Freshness of the fragment.** `update-line.txt` is re-rendered by the producer on every check *and*
by `update-notice` at every session start. Both the "behind" comparison and snooze expiry are
therefore re-evaluated at least once per session, which bounds fragment staleness to one session
rather than one check interval.

## 5. Components

| Component | File | Change | Responsibility |
|---|---|---|---|
| Producer + renderers | `cli/update-check.js` | **new** | `cmpSemver`, `fetchLatest`, `runCheck`, `readState`, `renderStatusline`, `renderNotice`, `writeFragment`, `snooze`. `fetcher` and `now` are injected. |
| CLI surface | `cli/aos.js` | touched | Three dispatch cases (`update-check`, `update-status`, `update-notice`); `USAGE` lines; a `doctor()` row; a re-check at the end of `upgrade()`. |
| Launcher + hook shim | `plugin/bin/aos` | touched | Add the three names to the existing `doctor\|status\|upgrade\|…` arm that routes to `cli/aos.js`. |
| Hook wiring | `plugin/hooks/hooks.json` | touched | One entry appended to the existing `SessionStart` array, `timeout: 5`. |
| Config defaults | `brain/scripts/config.default.json` | touched | `"updates": { "check": true, "intervalHours": 24 }`. |
| HUD | `brain/scripts/scan-vault.js`, `hud/src/data/snapshot.ts` | touched | Copy the cached flag into `snapshot.json`; widen the type. |
| Unit tests | `cli/update-check.test.js` | **new** | See §10. |
| Manifest tests | `cli/plugin-manifests.test.js` | touched | Assert the hook entry and the shim dispatch exist. |
| Rehearsal | `cli/rehearsal/first-run.sh` | touched | An `update-notice` leg driven by a fake fetcher, no network. |
| Docs | `README.md`, `docs/install.md` | touched | The status line opt-in and the `updates` config block. |

**No new dependencies.** The root `package.json` declares no runtime dependencies, so `cmpSemver` is
implemented in-repo (roughly fifteen lines) rather than adding `semver`.

**Placement rationale.** The module lives in `cli/` next to `cli/aos.js` because that directory is
vendored wholesale into `<vault>/brain/scripts/cli/`. A consumer placed in `brain/scripts/` would
need `require('./cli/update-check.js')`, which resolves in the vendored layout but not in the
repository layout. Routing all three subcommands through `cli/aos.js` avoids that asymmetry entirely.

## 6. Data contracts

### 6.1 `<vault>/brain/_index/update-check.json`

```json
{
  "schema": 1,
  "checkedAt": "2026-09-15T23:40:12Z",
  "installed": "0.1.0",
  "vaultVersion": "0.1.0",
  "pluginVersion": "0.1.0",
  "latest": "0.2.0",
  "behind": true,
  "url": "https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.2.0",
  "snooze": { "version": "0.2.0", "until": "2026-09-22T00:00:00Z" },
  "lastError": null,
  "consecutiveFailures": 0
}
```

`schema: 1` follows the existing ledger convention in `lib/pipeline-report.js`. `latest` is `null`
before the first successful check and whenever the upstream tag is not orderable semver. `snooze` is
`null` when unset. `url` is constructed from `REPO_SLUG` and the validated tag, never copied from the
response body.

**Who writes `pluginVersion`.** `update-notice` is the *usual* writer of the plugin's version, because
`CLAUDE_PLUGIN_ROOT` makes it the one consumer that can read it for free on every session start. It is
not, however, the *only* component that can observe it — `aos upgrade` resolves the plugin directly
(`installedPlugin(bin).installPath`, the same lookup `doctor()` already makes) and passes it into the
same `runCheck` the detached producer uses, because `upgrade()` is the one caller that knows for
certain all three surfaces just moved. The detached producer itself runs without `CLAUDE_PLUGIN_ROOT`
and, absent a caller-supplied version, must **carry the existing `pluginVersion` forward unchanged**
rather than clearing it — otherwise every daily check would erase the skew signal that §8 depends on.
When the field has never been written (a check that precedes the first session start or an upgrade),
`installed` falls back to `vaultVersion` alone.

### 6.2 `<vault>/brain/_index/update-line.txt`

Exactly one of two states:

- **Zero bytes** when there is nothing to say.
- **One line terminated by a single `\n`** otherwise:

```
⬆ AgenticOS 0.2.0
```

A consumer that `cat`s the file therefore contributes either nothing or one line, with no quoting,
trimming or conditional logic on the consumer's side.

### 6.3 Config

In `brain/scripts/config.default.json`, following the existing per-feature block convention used by
`telemetry`, `cost` and `persona`:

```json
"updates": { "check": true, "intervalHours": 24 }
```

Existing installs receive it through the `deepMerge(defaults, user)` step already present in
`upgrade()`, with user values winning. No migration code. Per the established precedence,
`agenticos.json` outranks `brain/config.json`, so `"updates": { "check": false }` in `agenticos.json`
is the global off switch.

### 6.4 User-facing surfaces

Status line opt-in, documented in the README — one line, no Node process:

```sh
cat "$HOME/AgenticOS/brain/_index/update-line.txt" 2>/dev/null
```

Session-start notice, printed by the plugin's `SessionStart` hook:

```
AgenticOS Workbench 0.2.0 available (you have 0.1.0) — run `aos upgrade`
```

Commands:

```
aos update-status                 human-readable state, exit 0
aos update-status --statusline    print the fragment, exit 0
aos update-status --snooze 7d     silence this version for 7 days
aos update-status --off           disable the check permanently
aos update-check                  force a check now (network)
aos update-check --quiet          as above, no stdout (how the detached spawn runs)
```

**`--snooze` argument format:** `<N>d` or `<N>h` (whole numbers only). Anything else is a usage error
with a non-zero exit — this is a deliberate user-invoked command, not a hook, so it may fail loudly.
The snooze is recorded against the specific `latest` version in the store, which is what makes a
newer release break it.

**Where `--off` writes:** `agenticos.json`, not `brain/config.json`. Since `agenticos.json` holds the
higher precedence, writing the off switch to the lower-precedence file would let a later
`brain/config.json` edit silently re-enable the check. `--off` is a user saying *never again*, so it
is written where nothing else can override it.

## 7. Data flow

### Path A — session start (always on)

1. `SessionStart` → `sh "$CLAUDE_PLUGIN_ROOT/bin/aos" update-notice`.
2. Resolve the vault via the shim's existing precedence (`AOS_CONFIG`/`CLAUDE_CONFIG_DIR` →
   `agenticos.json` → `vault`). Not initialized, no vault, or no Node → **exit 0, print nothing.**
3. Read the store. Missing or unparseable is treated as "no state", not as an error.
4. If `checkedAt` is absent or older than `intervalHours`, **spawn `aos update-check --quiet`
   detached and do not wait for it.**
5. Re-render `update-line.txt` from current state and the current clock.
6. Print the notice if `behind` and not snoozed; otherwise print nothing.
7. Exit 0.

### Path B — status line (opt-in)

A `cat` of `update-line.txt`. No network, no writes, no subprocess beyond `cat`.

### Path C — producer (detached)

1. Exit 0 immediately if `updates.check` is false.
2. `GET https://api.github.com/repos/zzoretich/AgenticOS-Workbench/releases/latest`, 5s timeout, a
   `User-Agent` header, no credentials.
3. Validate `tag_name` against `/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/`; strip a leading `v`.
4. Compare against `installed` (§8), carrying the store's existing `pluginVersion` forward unchanged
   (§6.1), and write both files atomically (`tmp` + `rename`).
5. On any failure, apply §9 and exit 0 regardless.

## 8. The version-skew rule

Three versions live on a user's disk and drift independently: the plugin under
`~/.claude/plugins/cache/`, the vendored `brain/scripts`, and `agenticos.json.version`. `aos upgrade`
advances all three together — but `claude plugin update` can advance the **plugin alone**, so
"your current version" is genuinely ambiguous and a naive check can be wrong in both directions.

**Rule:** `installed = min(pluginVersion, vaultVersion)`. A user is only as upgraded as their
least-upgraded part.

`update-notice` runs inside the plugin, so it can read both `$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`
and `agenticos.json`, and it records **both** into the store. That is what lets the other consumers —
separate processes with no `CLAUDE_PLUGIN_ROOT` — report skew they could not otherwise observe.

When the two disagree, the notice says so outright rather than hiding it:

```
AgenticOS 0.2.0 available (plugin 0.2.0, vault 0.1.0) — run `aos upgrade`
```

## 9. Error handling

The governing rule is the contract already stated in `hooks.json`: *a hook never fails a session.*
Every row below ends in **exit 0 with empty stdout**. The notice is a convenience; it never degrades
a session and never explains itself inside one. `AOS_DEBUG=1` reveals the reason on stderr, matching
the shim's existing behaviour.

| Failure | Behaviour |
|---|---|
| Not initialized (no `agenticos.json`, no vault, no Node) | Silent. Existing shim contract, unchanged. |
| `updates.check = false` | Producer exits at once; consumers render nothing. |
| Offline, DNS failure, captive portal | Set `lastError`, increment `consecutiveFailures`, **keep the previous known-good `latest`**. Consumers keep rendering the stale-but-true answer. |
| GitHub 403 (unauthenticated rate limit, 60/hr/IP) | As offline, plus backoff. One call per user per day makes this unlikely; a shared NAT could still pool. |
| **404 — repository private, or no releases yet** | `latest: null`, `behind: false`, every consumer silent. **This is the state today**, and it is why the feature can ship before the first tag without emitting a single misleading message. |
| Malformed JSON from GitHub | Treated as a failed check; previous state preserved. |
| Corrupt or hand-edited store | Consumers treat unparseable as "no state"; the producer overwrites it. |
| Two sessions start at once | Two detached producers; `tmp`+`rename` means a reader always sees either the whole old file or the whole new one. Should the two disagree (one succeeded, one failed), the loser still wrote a complete and self-consistent file, and the next check reconciles. No lock. |
| `tag_name` not orderable semver (`nightly`, `v2-beta`) | `cmpSemver` → `null` → `behind: false`. **Never announce a version that cannot be ordered.** |
| Installed newer than latest (working from a fresh clone) | `behind: false`, silent. Never advise upgrading backwards. |
| Read-only vault, permission denied | Producer gives up silently; consumers render nothing. |
| `checkedAt` in the future (clock skew) | Treated as stale; re-check. |

**Backoff.** The effective interval doubles per consecutive failure, capped at four doublings, and
resets on the first success — so a permanently offline machine stops re-resolving DNS daily.

## 10. Security and hardening

Going public means the producer parses a document fetched over the network and the consumers render
it into a terminal. Two rules follow, and `release.yml`'s `generate_release_notes: true` makes the
first one concrete: release bodies are auto-generated changelogs, i.e. unbounded multi-line text.

1. **The release body is never rendered.** Only the parsed, validated semver is displayed. Unbounded
   remote text in a status line would break the render even with a perfectly well-behaved upstream;
   refusing to render it removes the question.
2. **Links are constructed, never echoed.** `url` is built from `REPO_SLUG` and the validated tag, so
   no URL from the response is ever printed or followed.

No credentials are introduced anywhere: the check is unauthenticated by construction (D2), so there
is no token to store, rotate or leak.

## 11. Testing

Matching the repository's existing style: `node --test`, `*.test.js` beside the source, injected
fakes in the manner of `fake-claude.sh` / `fake-npm.sh`. **The suite makes no network calls** — CI
runs on Node 20 and 22 across Ubuntu and macOS.

New `cli/update-check.test.js`:

- **`cmpSemver` table** — equality, patch/minor/major ordering, `v` prefix, prerelease ordering,
  non-semver → `null`.
- **`runCheck` with an injected fetcher** — success writes the expected store and fragment; 404 →
  `latest: null` and silence; 500 and malformed JSON → previous `latest` preserved and
  `consecutiveFailures` incremented; timeout → same.
- **Backoff** — grows, caps at four doublings, resets on success.
- **`renderStatusline`** — behind → fragment; current → empty; snoozed → empty; corrupt store → empty.
- **`renderNotice`** — skew prints both versions; no skew prints one; downgrade prints nothing.
- **Snooze semantics** — `--snooze 7d` sets `until`; a newer `latest` breaks the snooze; an expired
  snooze re-notifies.
- **The skew rule** — `installed` is the lower of plugin and vault versions.
- **Atomicity** — no `.tmp` file survives `runCheck`.
- **The never-fails contract** — `update-notice` against an uninitialized vault, and against a
  `chmod 000` store: exit 0, empty stdout. This is the test that protects every user's session.

Extended rather than new: `cli/plugin-manifests.test.js` gains assertions that `SessionStart`
contains the `update-notice` entry and that `plugin/bin/aos` dispatches the three new names;
`cli/rehearsal/first-run.sh` gains an `update-notice` leg driven by a fake fetcher.

## 12. Prerequisites and the go-public order

The notification is inert until a release exists. The pipeline is already built (§3), so what remains
is sequencing — and this order is load-bearing.

1. **Scan the git history for private data.** `tools/privacy-gate.js` scans
   `git ls-files --cached --others --exclude-standard` — the working tree, **not history**. Flipping
   visibility publishes every past commit, so the terms in `tools/privacy-terms.json` get a one-time
   pass over history (for example over `git log -p`) before anything is published.
2. **Resolve whatever that finds, before flipping.** Public history cannot be recalled.
3. **Flip the repository to public.**
4. **Tag and push `v0.1.0`** — the version already installed. This makes `releases/latest` resolve,
   establishes the baseline so nobody is told they are behind on day one, and makes `aos init`'s
   Obsidian bundle download work for the first time.
5. **Then** the notification mechanism has something to observe.

An optional convenience, not required by anything above: a `npm run release` wrapper that bumps,
commits, tags and pushes. `release.yml` deliberately *enforces* version agreement rather than
performing the bump, and that division stays as it is.

## 13. Out of scope

Deliberately excluded to keep the first version honest:

- **Severity tiers** (patch whispers, major shouts). No release has ever shipped; tiering now would
  be guessing at a problem that does not exist yet.
- **Self-upgrading.** The notice never runs `aos upgrade` for the user. Upgrades re-vendor scripts and
  rebuild indexes; that stays an explicit act.
- **A release-notes viewer.** The notice carries a version and a command, not a changelog.
- **Pre-release and nightly channels.** `releases/latest` excludes pre-releases, and non-semver tags
  are ignored by design (§9).
- **Windows.** Unsupported in v1 repository-wide; the shim is POSIX `sh`.
- **A raw.githubusercontent.com fallback.** A static `latest.json` on the CDN has no rate limit and
  would sidestep the 403 row in §9, but it adds a second thing to keep in sync. Noted as the known
  remedy should rate limiting ever actually bite.
