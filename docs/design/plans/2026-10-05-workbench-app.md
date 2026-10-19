# The Workbench is an app — plan

Design: `docs/design/specs/2026-10-05-workbench-app-design.md`. Six phases, one or more PRs each, merged to `main`
in order. Nothing is released until phase 6; `main` stays releasable as 0.x until then (the app is built and tested,
but the installer still uses Obsidian until phase 3 lands with phase 6's release).

## File structure

| Path | What | Phase |
|---|---|---|
| `app/package.json`, `app/package-lock.json` | the app package (its own lockfile, not a workspace): Electron, esbuild, electron-builder, CodeMirror, xterm, node-pty, Playwright | 1 |
| `app/obsidian-compat/` | the `obsidian` compatibility package the HUD is compiled against | 1 |
| `app/src/main/` | window, tray popover, menu, `agenticos://`, watcher, pty host, settings, updater (5), IPC handlers (4) | 1, 4, 5 |
| `app/src/preload/` | the contextBridge API, named functions only | 4 |
| `app/src/renderer/` | boot, the Files view, the setup wizard | 1, 2, 5 |
| `app/src/shared/` | the IPC contract (types + zod schemas), the allow-lists | 1, 4 |
| `app/scripts/` | build, fixture vault, compat check, dist, verify, smoke, release | 1, 5 |
| `app/tests/{unit,e2e}/` | unit tests and Playwright `_electron` specs | all |
| `hud/src/host.ts` | the `HudHost` seam: fs, spawn and pty adapters the HUD's I/O modules take | 4 |
| `cli/aos.js`, `cli/update-check.js`, `brain/scripts/lib/{hud-host,statusline-render}.js`, `persona/proposal-html.js` | Obsidian removed, `agenticos://`, the app's registration | 3 |
| `.github/workflows/ci.yml` | an `app` job on macOS: typecheck, unit, compat check, e2e | 1 |
| `README.md`, `docs/install.md`, `docs/plugin-smoke.md` → `docs/app-smoke.md`, `docs/acceptance.md`, `docs/migrating-to-1.0.md` | app-first, macOS only | 3, 6 |
| `SECURITY.md` | the hardening review | 4 |

## Phase 1 — Import the app (S–M)

- [ ] Fix the 3 privacy-term hits in the prototype; run this repo's gate over it before copying.
- [ ] Copy it in as `app/` (one commit, its own lockfile), point the build at `../hud`, drop the submodule.
- [ ] Rename to AgenticOS Workbench (product name, bundle id, menus); version follows the root `package.json`.
- [ ] Remove the Write Access menu and the read-only default (D6); keep the tables as data for phase 4.
- [ ] Add the `app` job to CI (macOS); keep `check:compat` as the tripwire for a HUD change that needs a new API.
- **Exit:** CI green including app e2e; the maintainer's Mac runs a local build against the live vault.

## Phase 2 — The Files view (M)

- [ ] A Files rail tab: vault tree (ignoring `.git`, `node_modules`, `graphify-out`), ⌘O quick open over every file,
  full-text search with results that open at the line, new note (folder picker), rename, move, delete (to Trash).
- [ ] The note pane: "Open in Obsidian" removed; Show in Finder kept.
- [ ] e2e per action on the fixture vault.
- **Exit:** everything a user did in Obsidian's file explorer, quick switcher and search works in the app.

## Phase 3 — The runtime without Obsidian (S–M)

- [ ] `aos init`: no Obsidian gate, no bundle, no `.obsidian/daily-notes.json`; `--no-obsidian` accepted as a no-op.
- [ ] `aos upgrade`: no bundle; prints once that the HUD is now the app, with the download link.
- [ ] Links: `agenticos://` in the status line and proposal pages, through one helper (`lib/hud-host.js`).
- [ ] The app writes `brain/_index/hud-host.json`; doctor's `workbench app` row and the update check read it.
- [ ] D12: stable Homebrew Node path in `agenticos.json` and schedules; doctor warns on a versioned Cellar path.
- [ ] README and `docs/install.md`: app first, macOS only, Obsidian gone.
- **Exit:** `first-run.sh` and `codex-host.sh` green with no Obsidian; doctor green with the app registered.

## Phase 4 — Sandbox the renderer (M–L)

- [ ] `hud/src/host.ts`: the ~17 I/O modules take injected adapters (many already do in tests).
- [ ] Typed IPC with zod validation and sender checks; preload exposes named functions only.
- [ ] Spawn allow-list (`aos`, named runtime scripts, `claude`/`codex` with fixed flags, pty shells); fs scoped to
  the vault, `~/.claude`, `~/.codex`, LaunchAgents (read-only).
- [ ] `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; packaged builds refuse remote debugging.
- [ ] Security review against the Electron checklist; `SECURITY.md` with no open high findings.
- **Exit:** e2e green sandboxed; the review signed off.

## Phase 5 — Install and update (M)

- [ ] Release tree in `Contents/Resources/payload`; `aos init`/`upgrade` run from it (`AOS_SKIP_NPM` + prebuilt deps).
- [ ] First-run wizard: preflight with fix-it actions (Homebrew, node, claude/codex CLI and login, Ollama, python3,
  uv), the persona form, `aos init --host …`, the `CLAUDE.md` line shown as a diff and added only on approval.
- [ ] Attach mode for existing installs (`agenticos.json` found): no wizard, a one-time "what changed" note.
- [ ] `electron-updater` against GitHub Releases; `release:app` script: build, sign, notarize, staple, upload.
- **Exit:** on a fresh macOS user account with no Obsidian: download → wizard → working Workbench, no terminal.

## Phase 6 — Ship 1.0.0

- [ ] `docs/migrating-to-1.0.md`; CHANGELOG `[1.0.0]` with **Upgrading**; `docs/acceptance.md` updated and run.
- [ ] Remove `hud`'s Obsidian packaging (manifest, versions, release asset); keep its source.
- [ ] Tag, release, verify the update feed from the previous build.
- **Exit:** a 1.0.0 release with the app attached; the maintainer's Mac on the released app with Obsidian deleted.
