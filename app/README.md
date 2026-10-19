# UniDeX — the app

The Workbench as a macOS app. The HUD in `../hud` runs in its own Electron window, compiled unchanged
against an Obsidian compatibility package (`obsidian-compat/`), so the same source is the Workbench everywhere. The runtime,
the Claude Code and Codex plugins, the routines and the vault format are the ones in this repo.

Design and roadmap: `docs/design/specs/2026-10-05-workbench-app-design.md` and
`docs/design/plans/2026-10-05-workbench-app.md`. macOS only, built for Apple silicon.

To use it, download `AgenticOS-Workbench-<version>-arm64.dmg` from the
[latest release](https://github.com/zzoretich/UniDeX-Agent-Harness/releases/latest). This file is for running, testing
and building it from a checkout.

## Install and update (phase 5)

A packaged app carries the runtime in `Contents/Resources/payload`: a release tree (`scripts/make-payload.mjs`) with the
runtime's dependencies, from which the app runs `aos init` and `aos upgrade` with a Node 20 or newer (yours, or the one
the wizard installs). With no install it opens a setup wizard: it checks what `aos init` needs and installs what is
missing itself, with no Homebrew and no terminal (`src/main/setup/toolchain.ts`, install-import B1): Node, uv, the
Ollama app and the models for this Mac's memory, Claude Code and Codex, each downloaded from a pin in
`src/main/setup/toolchain-manifest.json`, checked against its SHA-256 and its maker's signature, then put where its own
installer puts it; the two logins run in a terminal inside the wizard. It asks for the hosts (or none yet: B2), the
vault folder and the Chief of Staff (an earlier install's host that the choice would drop is kept, or unwired first with
`aos uninstall --host`), runs `aos init`, brings in the history Claude Code and Codex left on the Mac (`aos import`,
B13), then lists what is left step by step (the `CLAUDE.md` line as a diff, Codex's `/hooks`, the history's digest, a
host to add later, the line that puts `aos` on the PATH) and opens the Workbench, where the welcome tour starts. With an
install it opens the Workbench (attach mode) and hands over to the HUD's launch sequence (tour C11): `aos upgrade`
offered when it carries a newer runtime than the vault has, then the Go-local card and What's new, one at a time, each
once. Plans: `docs/design/plans/2026-10-05-install-and-update.md`,
`docs/design/specs/2026-10-14-install-and-import-design.md`.

The pins are refreshed by hand before a release: each tool's `from` says where its version and SHA-256 come from (the
maker's checksum file), and `teamId` is what `codesign -dv` reports on the download. `tests/unit/toolchain.test.ts`
checks the shape.

The app updates itself from this repo's GitHub Releases (electron-updater; a packaged release build only, and off when
`updates.check` is false or `AOS_APP_NO_UPDATES=1`). `npm run release:app` puts a release's app there.

## Run it from a checkout

Requires Node 22.12+. With an install (`aos init`) the app reads the vault from `agenticos.json` (or `$AOS_APP_VAULT`);
without one it shows the setup wizard, which installs only when the run has a payload: `npm run payload`, then start it
with `AOS_APP_PAYLOAD=$PWD/payload`.

```sh
cd app
npm ci
node node_modules/electron/install.js   # Electron 44 fetches its binary on first use
npm start
```

Every Workbench surface writes to the vault, as the HUD always has; writes outside the surfaces in
`src/shared/surfaces.ts` are refused and logged. `AOS_APP_WRITE` narrows a run: `""` is read-only, `todo,chat` turns
on only those. The Code tab is a real shell: what you run there, or what a ❯_ button types for you, runs for real. Its New button,
⌘T and ⌥⌘1–3 start Claude Code, Codex or a shell by typing the command into a fresh shell, in the vault, a workspace
(or its linked code folder) or Scratch (`data/terminalLaunch.ts`); terminals start with the login shell's `PATH`.

The page runs sandboxed, with context isolation and no Node. Every file it reads or writes, every process and terminal
it starts and everything it hands to the OS is a call over the preload's bridge (`window.aos`), which main checks
against the read scope, the write surfaces and the program rules (`src/main/policy/`). `../SECURITY.md` has the review.

A dev run keeps its data in `~/Library/Application Support/AgenticOS Workbench (dev)`, apart from an installed app's.
Run a second instance with `AOS_APP_USER_DATA=<another folder>`.

## Build a signed app

Needs a "Developer ID Application" identity in the login keychain, and a notarytool keychain profile.

```sh
APPLE_KEYCHAIN_PROFILE=<profile> npm run dist                            # package, sign, notarize the app, build the DMG
APPLE_KEYCHAIN_PROFILE=<profile> npm run dist:verify -- --notarize-dmg   # notarize and staple the DMG, verify both
npm run dist:test && npm run smoke:packaged                               # the smoke build, run on a synthetic install
```

## Layout

```
obsidian-compat/ the `obsidian` module as the app provides it (the HUD imports it by that name)
src/main/        Electron main: window, menubar item, app menu, agenticos:// links, app://hud, vault watcher
src/main/ipc/    the bridge's handlers: sender check, zod schemas, a Result for every call
src/main/policy/ what the page may read, write, run and open (read scope, write policy, programs, shell, debug switches, setup)
src/main/setup/  the wizard and attach mode: login PATH, preflight, the toolchain's pinned downloads, aos init/upgrade from the payload, CLAUDE.md, the PATH line
src/main/updater.ts the app's own updates (electron-updater)
src/main/services/ the page's files, processes and terminals (node-pty), as main runs them
src/preload/     window.aos: the contextBridge of named functions, the page's only way into main
src/renderer/    boot, the HUD's host over the bridge, the POSIX path shim, host chrome, the setup wizard (setup/)
src/shared/      the IPC contract (no imports) and the write surfaces
scripts/         build, payload, compat tripwire, fixture generator, icon, node-pty postinstall fix, unit-test runner, packaged checks and smoke, release
build/           the packaged app's entitlements and icon (electron-builder.yml is beside this file)
tests/           unit tests, and the end-to-end suite with its coverage map (tests/e2e/COVERAGE.md)
```

## Scripts

| Command | Does |
|---|---|
| `npm start` | build, then open the app |
| `npm run build` | bundle main, the preload and the page into `out/` (a Node import from the page fails the build) |
| `npm run typecheck` | strict `tsc` over the app and the compat package |
| `npm run test:unit` | unit tests (the policies and services behind the bridge, the path shim, links, tray, menu, paths) |
| `npm run check:compat` | fail if the HUD uses an Obsidian API, DOM helper or icon `obsidian-compat/` lacks |
| `npm run test:e2e` | build, generate the synthetic fixture vault, run the Playwright `_electron` suite |
| `npm run fixture` | generate the fixture vault alone (`tests/.fixture/`) |
| `npm run screens` | the README's screenshots: the app on a synthetic demo vault (the e2e fixture, its test-only error cases taken out), into `../docs/assets/screens/` |
| `npm run dist` | build, then package, sign and (with `APPLE_KEYCHAIN_PROFILE`) notarize the app and its DMG into `dist/` |
| `npm run dist:verify` | check the build's signature, entitlements, fuses, contents, notarization and DMG, and that it refuses a debugger |
| `npm run dist:test` | the smoke build in `dist-test/`: packaged like `dist`, ad-hoc signed, the one build that accepts the DevTools port |
| `npm run smoke:packaged` | run the smoke build on a fresh synthetic install from before 2.0 (its first attach meets the launch sequence: the runtime update from the bundle's payload, then Go local, Import and What's new, each dismissed), then once with no install (the wizard) (`-- --live`: on your vault, with the app's usual write surfaces; any launch dialog is closed untouched. It types nothing, but the app records itself in `brain/_index/hud-host.json`, and opening Skills or Agents with a stale cache runs `aos skills sync` / `aos agents sync`; `-- --app <path>`) |
| `npm run payload` | build the runtime the app carries into `payload/` (the dist scripts run it first) |
| `npm run release:app` | for a tagged release: build, sign, notarize, staple, verify, and upload the DMG, the zip and `latest-mac.yml` to the tag's GitHub release (`-- --dry-run` prints the checks and the plan) |

`app/` has its own lockfile and is not an npm workspace, so the runtime's installs and the repo's other CI jobs never
pull Electron or native modules. CI (`.github/workflows/ci.yml`, job `app`) runs `typecheck`, `test:unit`, `check:compat` and `test:e2e` on macOS; `screens`, `payload`, the `dist` scripts, `smoke:packaged` and `release:app` run by hand on a Mac.
