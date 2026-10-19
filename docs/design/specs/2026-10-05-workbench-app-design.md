# The Workbench is an app — design

**Date:** 2026-10-05
**Status:** approved design (2026-10-05), implementing on `feat/workbench-app`
**Scope:** AgenticOS stops depending on Obsidian. The Workbench HUD ships as a signed macOS app, **AgenticOS
Workbench**, built in this repo from the same HUD source. It installs the runtime itself, updates itself, and has its
own note browser and editor. Obsidian is removed from the installer, the runtime and the docs. macOS only.
**Plan:** `docs/design/plans/2026-10-05-workbench-app.md`

---

## 1. Problem

Today a user needs Obsidian to use AgenticOS: `aos init` refuses to run without Obsidian.app, the HUD is an Obsidian
community plugin the user must enable, links open Obsidian, and notes are read and edited in Obsidian. The install is
six prerequisites and nine steps. The HUD itself does not need Obsidian: it is ~15.7k lines of TypeScript over a vault,
and it has been shown to run unchanged in an Electron app on a small compatibility layer (a private prototype: every
tab, every write path and a note editor, signed and notarized, 264 end-to-end tests, in daily use).

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | The app is the only HUD. Obsidian is removed from install, runtime and docs in the same release that ships the app. The vault stays plain Markdown, so a user may still open it in any editor, Obsidian included, unsupported | Keeping Obsidian as an option: two HUD hosts to test and document forever. Removing Obsidian before the app ships: every user would lose the HUD |
| D2 | **macOS only.** The README, installer and docs say so. The runtime's Linux code is not removed, but nothing is promised and the app has no Linux build | A Linux app build: a second packaging path nobody has asked for |
| D3 | The app lives here as `app/`, a package with its own lockfile (not an npm workspace, so runtime installs and the other CI jobs never pull Electron or native modules), and compiles `hud/` directly (no submodule, no pinned tag). One version, one CHANGELOG, one release: every release ships the runtime, both plugins and the app | A separate app repo: the HUD and the app would drift, and every HUD change would need a second release |
| D4 | The app is imported as one new commit. The prototype's history stays private (its authorship is not noreply-clean). Its 3 files with privacy-term hits are fixed before import | Importing history with `git subtree`: it would publish authorship this repo has never published |
| D5 | The HUD keeps importing `obsidian`, aliased at build time to the app's compatibility package (`app/obsidian-compat`). Renaming the HUD folder and moving it off Obsidian's API names is later, optional work | A React rewrite of 13 tabs: months of work for the same behaviour |
| D6 | The prototype's per-surface write switches (off by default, needed while two HUDs ran side by side) are removed from the UI: every surface writes. Their tables become the allow-lists of phase 4's sandbox | Shipping the switches: a new user would meet a read-only HUD |
| D7 | Security bar before the first public build (phase 4): renderer `sandbox: true`, `contextIsolation`, no Node; a `HudHost` seam in the HUD so every fs, spawn and pty call goes through typed, validated IPC; a spawn allow-list; fs scoped to the vault and the hosts' config dirs; packaged builds refuse `--remote-debugging-port`; a security review with no open high findings | Shipping with Obsidian's posture (Node in the renderer): acceptable for one owner, not for a download whose notifications carry web-derived text |
| D8 | The app carries the release tree (runtime, `cli/`, both plugins, `vault-template/`) in its Resources. A first-run wizard checks prerequisites with fix-it actions, asks the persona questions in a form, and runs `aos init` from Resources. Existing installs are found through `agenticos.json` and attached | Keeping the terminal install as the path for new users: the app exists to remove it |
| D9 | Updates: `electron-updater` from this repo's GitHub Releases, signed with the maintainer's individual Developer ID and notarized; the signing name is visible in the app's signature, accepted by the maintainer (2026-10-05). Releases are built and signed by a local release script on the maintainer's Mac; CI builds and tests unsigned | Signing in CI: the certificate would have to live in repository secrets. An organization account: weeks of enrollment for no user-visible gain. Unsigned builds: Gatekeeper blocks them and the updater refuses them |
| D10 | The app has its own **Files** view: a vault tree, quick open of any file (⌘O), full-text search, new note, rename, move and delete, and the existing Markdown editor. No link rewriting on rename in 1.0 | Relying on another editor: AgenticOS has to be complete without Obsidian |
| D11 | Links are `agenticos://workbench?tab=<rail id>` and `agenticos://note?file=<vault path>`. The app registers the scheme. The app records itself in `<vault>/brain/_index/hud-host.json` (name, version) so doctor and the update check can see it | Reading the app bundle from the runtime: ties the runtime to one install path |
| D12 | Node stays the user's own (Homebrew), but `agenticos.json` and the schedules record Homebrew's stable `opt/<formula>/bin/node`, which survives `brew upgrade` | Bundling Node: Electron's Node cannot be used without enabling the `runAsNode` fuse |
| D13 | The release that ships this is **1.0.0** (a breaking change to every install) | A minor version: users would not expect Obsidian to disappear in one |

## 3. What already exists (verified at `b56484b`, v0.21.0 + 1)

- `hud/` (the HUD) imports 17 symbols from `obsidian` plus its DOM helpers; `main.ts` registers the views.
- `cli/aos.js:239-247, 344, 443, 1056-1057, 1102, 1138, 1321`: the Obsidian gate, doctor rows, bundle and daily-notes
  writes. `lib/statusline-render.js:88-95` and `persona/proposal-html.js:171`: the `obsidian://` links.
  `cli/update-check.js:105`: the HUD version from `.obsidian/plugins/agentic-os/manifest.json`.
- The prototype (private, to be imported): Electron 44, esbuild, the compatibility package (17 files), a main process
  (window, tray popover, menu, `agenticos://` handler, FSEvents watcher, node-pty host, settings), a CodeMirror 6 note
  editor, electron-builder 26 with fuses, hardened runtime and notarization, `dist:verify` and `smoke:packaged`, 39 unit
  and 264 Playwright `_electron` tests over a synthetic fixture vault.

## 4. Host parity (Claude Code and Codex)

The app is host-neutral: it reads the vault and spawns the runtime, and its terminal starts `claude` or `codex` as
configured. No hook, skill, MCP tool or model call changes shape. The wizard detects both CLIs and passes
`--host claude|codex|both` to `aos init`, as the terminal install does.

| Mode | How the user gets it | What runs | If it can't |
|---|---|---|---|
| Claude Code only | install the app; the wizard runs `aos init --host claude` | app + runtime + Claude Code plugin | the wizard shows the missing CLI with a fix-it action |
| Codex only (plugin · direct) | the wizard runs `aos init --host codex` | app + runtime + Codex plugin or direct wiring | same |
| Both | `--host both` | both plugins | same |

## 5. Out of scope for 1.0

Linux and Windows builds; an App Store build; link rewriting on rename; moving the HUD off Obsidian's API names;
bundling Node; the 1.0 proposal's other items (guardrails, cost, CI, story), which stay separate work.
