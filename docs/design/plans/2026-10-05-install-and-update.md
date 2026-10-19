# Phase 5: install and update — plan

Design: `docs/design/specs/2026-10-05-workbench-app-design.md` (D8, D9, D12). Parent plan:
`docs/design/plans/2026-10-05-workbench-app.md` (phase 5). Verified against `f3c939d`.

## Where it starts

The app attaches to the vault `agenticos.json` names, once, when main loads; with no install the page says "No AgenticOS
vault found" and stops. Installing is the terminal path (`git clone`, `npm ci`, `npm run setup`), which runs
`npm install --omit=dev` in the vendored runtime. `electron-builder.yml` has `publish: null` and a DMG only, so there is
no update feed. Nothing in the bundle carries the runtime. `aos init` already finds its sources from its own location
(`repoRoot()`: `.claude-plugin/marketplace.json`, `brain/scripts/package.json`, `vault-template/`), and the runtime's two
dependencies (`@modelcontextprotocol/sdk`, `zod`) are plain JavaScript, so a copy built on one Mac runs on any Node ≥ 20.

## Decisions (under D8, D9, D12)

| # | Decision | Rejected |
|---|---|---|
| I1 | **The payload is a release tree**, built from this checkout by `app/scripts/make-payload.mjs` into `app/payload/` (gitignored) and shipped as `Contents/Resources/payload` (`extraResources`). It holds what `aos init` and `aos upgrade` read and nothing else: `package.json` (name, version), `LICENSE`, the two marketplace manifests, `brain/scripts` without tests and with its production `node_modules`, `cli/` without tests, fixtures or the rehearsal, `plugin/`, `codex-plugin/`, `vault-template/`, `extras/{schedule,cost}` without the python tests, and `payload.json` (schema, version, commit, `runtimeDeps`) | A tarball unpacked at first run: one more step to fail, and the files would sit outside the app's signature |
| I2 | **The CLI installs a release tree's dependencies by copy.** When the source has `payload.json` with `runtimeDeps: true` and `brain/scripts/node_modules`, `vendorRuntime` copies them beside the vault's and swaps them in with two renames instead of running `npm install`. The same CLI works from the terminal: `node "<app>/Contents/Resources/payload/cli/aos.js" upgrade` | `AOS_SKIP_NPM=1` from the app: a test seam that leaves the vault without dependencies. `npm install` from the wizard: network and npm failures in a GUI |
| I3 | **The app runs the payload's CLI with the user's own Node** (D12) on a login-shell PATH: main asks `$SHELL -lic` once, adds Homebrew's and `~/.local/bin`, finds `node` ≥ 20 there and runs `node <payload>/cli/aos.js init\|upgrade` directly, never through a shell. The plugins install from GitHub, as the terminal install's do (no `--from-local`) | Electron's Node: needs the `runAsNode` fuse (D12). A marketplace pointing into the app bundle: breaks when the app is moved, translocated or deleted |
| I4 | **The wizard.** (1) Preflight: Homebrew, Node ≥ 20, the claude and codex CLIs and their logins (at least one host), Ollama, python3 ≥ 3.9, uv. A missing one offers a fix-it from a fixed table in main (`brew install node\|python\|uv\|ollama`, the Homebrew installer, `npm install -g` for each CLI, `claude auth login`, `codex login`); it runs in a terminal inside the wizard (main's node-pty, the login shell with `-l -c <the fixed command>`), because Homebrew asks for a password and logins open a browser; preflight re-runs when it exits. (2) Hosts (what is ready) and the vault folder (`~/AgenticOS`, or a folder picker). (3) The persona form (`persona/interview.js`'s questions, checked in main, handed over with `--persona-json`). (4) `aos init --yes --host … --vault … --persona-json …` with its output live. (5) Claude Code: the `CLAUDE.md` line as a diff, appended only on "Add the line". (6) Done: Codex's `/hooks` trust step, which only the user can take, then the Workbench | Opening Terminal.app for fix-its: the exit criterion is no terminal. The page naming a command or a path: it names a fix by id, and main computes the `CLAUDE.md` path and line itself |
| I5 | **Attach mode.** `agenticos.json` naming an existing vault opens the Workbench, no wizard; a configured vault that is gone opens the wizard with its path filled in. Main attaches a vault at run time (also when the wizard finishes), so setup ends in the Workbench without a relaunch. Once per vault the app shows a "What changed" note (recorded in its data folder). When the vault's runtime (`agenticos.json` `version`) is older than the payload, a banner offers **Update the runtime**: `aos upgrade` from the payload, its output live | Upgrading on its own at launch: upgrade re-renders the schedules and refreshes both plugins, and could land in a routine's run. Relaunching after setup: a flash, and it breaks the e2e driver |
| I6 | **Updates: electron-updater** (bundled into main by esbuild) against this repo's GitHub Releases (`latest-mac.yml` and a zip beside the DMG). On only in a packaged release build (never a dev run or the smoke build), and off when `updates.check` is false (the runtime's own switch) or `AOS_APP_NO_UPDATES=1`. It checks 30 s after launch and every `updates.intervalHours`, downloads in the background, installs on quit, or at once from **Restart to Update** (status bar and app menu; the menu also has **Check for Updates…**). After an update the payload is newer than the runtime, and I5's banner follows. The runtime's update notice names the app when the app is the part behind | Sparkle: a second toolchain. Upgrading the runtime silently after an app update: see I5 |
| I7 | **`npm run release:app`** (local, D9). Refuses unless `HEAD` carries the tag `v<version>`, the tree is clean, `APPLE_KEYCHAIN_PROFILE` is set, `gh` is logged in and the tag's GitHub release exists (release.yml makes it from the tag). Then: payload, app (DMG and zip, the app notarized), `dist:verify --notarize-dmg` (notarizes, staples and verifies), the DMG's size and sha512 rewritten in `latest-mac.yml` after stapling, and `gh release upload --clobber` of the DMG, the zip, its blockmap and `latest-mac.yml`. `--dry-run` prints the plan | electron-builder's own publishing: wants a token in the environment and races release.yml for the release |
| I8 | Electron 44.5.1 (a handoff follow-up) | — |

## The IPC contract (additions to `app/src/shared/ipc.ts`)

| Area | Calls (S = sync, A = async, send) | Events |
|---|---|---|
| `setup` | `preflight` A · `fix(id)` S · `fixInput` `fixResize` `cancel` (send) · `chooseVault` A · `install(req)` S · `claudeMd` S · `applyClaudeMd` S · `finish` S · `upgrade` S · `noted` (send) | `setup:event` {job, data · exit} |
| `update` | `state` S · `check` `install` (send) | `update:state` |

`BootInfo` gains `setup` (the payload and its version, the configured vault, the default vault, why the wizard shows)
and `attach` (first time, the runtime's version, whether it is behind) and `updates` (on or off). One job runs at a time
(a fix, an install or an upgrade). `install` is refused while a vault is attached; `upgrade` unless one is and the payload
is newer; `applyClaudeMd` unless the Claude host is on and the line is missing. Each new channel is in `sandbox.spec.ts`.

## Host parity

The wizard detects both CLIs and passes `--host`; nothing in a hook, skill, MCP tool or model call changes.

| Mode | How the user gets it | What runs | If it can't |
|---|---|---|---|
| Claude Code only | the wizard with claude ready runs `aos init --host claude`, then offers the `CLAUDE.md` line | app + runtime + Claude Code plugin (GitHub) | the claude rows show **Install** / **Log in** fix-its |
| Codex only (plugin · direct) | `--host codex`; Done shows the `/hooks` trust step | app + runtime + the Codex plugin or direct wiring, as `aos init` picks | the codex rows show their fix-its |
| Both | `--host both`; both steps | both | per row |

## Files

| Path | What |
|---|---|
| `app/scripts/make-payload.mjs` | builds `app/payload/` (cached runtime deps, as the fixture builder caches them) |
| `app/src/main/setup/{env,preflight,fixes,jobs,claude-md,attach,payload}.ts` | login PATH, the checks, the fix-it table, the job runner, the `CLAUDE.md` diff, attach state, the payload |
| `app/src/main/ipc/setup.ts`, `app/src/main/updater.ts` | the handlers; the updater and its state |
| `app/src/main/index.ts` | attaching a vault at run time; the setup and update wiring |
| `app/src/renderer/setup/{wizard,attach,update}.ts` | the wizard, the attach note and runtime banner, the update item |
| `app/scripts/release-app.mjs`, `app/electron-builder.yml` | the release script; zip target, GitHub publish config, `extraResources` |
| `app/scripts/{verify-dist,smoke-packaged}.mjs` | check the payload in the bundle |
| `cli/aos.js`, `cli/update-check.js` | I2, I6's notice |
| `app/tests/unit/*.test.ts`, `app/tests/e2e/{setup,attach}.spec.ts`, `cli/aos.test.js`, `cli/update-check.test.js` | tests |

## Tests

- Unit: login PATH parsing, each preflight check on fake probes, host choice, the fix table, the persona schema and the
  init arguments, the `CLAUDE.md` diff and append (temp home), attach state, the updater's on/off rule, the release
  script's `latest-mac.yml` rewrite and asset list, the payload's contents (`--skip-deps`).
- CLI: `aos init` and `aos upgrade` from a release tree with prebuilt dependencies never call npm; the swap prunes.
- e2e: with no install, the wizard runs end to end on stub CLIs (a fix-it that installs a missing `uv` through a stub
  `brew` in the wizard's terminal, the persona form, a stub `aos init`, the `CLAUDE.md` diff), then the Workbench draws;
  the attach note shows once; the runtime banner runs a stub upgrade; `sandbox.spec.ts` covers every new channel.
- Packaged: `dist:test` + `smoke:packaged` (the payload in Resources, its version, its CLI runs); `dist:verify --app-only`.

## Exit

The packaged smoke build opens the wizard on its bundled runtime with no install, and attaches to an existing one with
the one-time note; the e2e suite runs the wizard end to end on stand-ins; `aos init` and `aos upgrade` run from a real
payload without npm; a signed release-config build loads the updater and handles a release without a feed;
`release:app --dry-run` prints its checks and plan (a real run needs a tagged, clean `HEAD`). The fresh-account
download → wizard → Workbench run, and an update from one signed release to the next, are phase 6's acceptance run.
