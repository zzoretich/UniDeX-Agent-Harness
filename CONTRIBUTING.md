# Contributing

Issues and pull requests are welcome. UniDeX ships to two hosts, Claude Code and Codex, and to a macOS app, so a change is done when it works the same for someone on Claude Code only, Codex only, or both. Found a security problem? Follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Set up a checkout

```sh
git clone https://github.com/zzoretich/UniDeX-Agent-Harness.git
cd UniDeX-Agent-Harness
npm ci --ignore-scripts                    # enough for the installer and every test suite
npm run setup -- --from-local .            # optional: install from your clone instead of GitHub
```

The app has its own dependencies under `app/` (Node 22.12 or newer); [app/README.md](app/README.md) covers running, testing and building it.

## Run the checks

```sh
npm test                 # every suite: tools + cli, brain/scripts, obsidian-plugin
npm run test:one -- <file>…   # one or a few test files, each with its suite's setup (a temp vault, config and host homes)
npm run gate             # the privacy gate — fails on any forbidden term
npm run lint             # eslint over the JavaScript
npm run lint:sh          # shellcheck over every tracked shell script (brew/apt install shellcheck)
npm run typecheck        # tsc over the HUD's TypeScript
cd extras/cost && python3 -m unittest      # the cost analyzer's tests
sh cli/rehearsal/first-run.sh              # a complete install in a temp HOME with a fake claude (what CI runs)
sh cli/rehearsal/codex-host.sh             # a Codex-only machine: direct wiring, then the upgrade to the Codex plugin; hooks and MCP run for real
npm run build:codex-plugin                 # regenerate codex-plugin/ after changing plugin/ (the tests fail until you do)
(cd app && npm ci && npm run test:e2e)     # the app: see app/README.md (macOS)
(cd app && npm run screens)                # retake the README screenshots on a demo vault
node tools/brand-assets.js                 # regenerate the brand assets under docs/assets
```

The suites never see your shell's `AOS_*`, `BRAIN_*`, `CLAUDE*` or `CODEX_*` variables (`tools/test-env.js` clears them once per run), and CI runs them again in UTC+14 and UTC−11 with those variables exported, so a test that leans on your time zone or your setup fails there. Run a single file with `npm run test:one -- <file>`, never a bare `node --test <file>`: without that setup a test would resolve your own vault and config, so the vault, config and host-folder lookups refuse to run under the test runner without it (`brain/scripts/lib/test-guard.js`). `brain/scripts/test/live/` needs a running Ollama and is excluded from `npm test`. The app's manual checklist is [docs/app-smoke.md](docs/app-smoke.md); the per-release acceptance runbook is [docs/acceptance.md](docs/acceptance.md).

## Both hosts, one change

- `plugin/` is the Claude Code plugin and the source of the Codex plugin. `codex-plugin/` is generated: never edit it by hand. Change `plugin/`, run `npm run build:codex-plugin`, and commit the output with its source.
- Write commands and skills host-neutrally ("ask the user", "read the file"), so the generated Codex skill reads right too.
- Code that branches on the host goes through the existing seams (`brain/scripts/lib/host.js`, `brain/scripts/sdk/lib/provider.js`, `brain/scripts/lib/headless.js`) and gets a test per host. Never hard-code `claude`, `~/.claude` or `CLAUDE_*`.
- The runtime, `cli` and `tools` are Node 20+, CommonJS, `node:test`, with no new runtime dependencies and no network in tests. `app/` and the HUD (`obsidian-plugin/`, compiled into the app) are TypeScript with their own suites.

## Nothing personal in the repository

This repository ships machinery, not anyone's content. The privacy gate (`npm run gate`) runs in CI and fails on forbidden terms, and gitleaks checks every pushed commit. Keep absolute home paths, names and email addresses out of code, tests, docs and commit messages: use `os.homedir()`, `os.tmpdir()`, `~` or `<vault>`.

## Changelog and the guided tour

A user-visible change gets a line under `## [Unreleased]` in `CHANGELOG.md`, and each **Added** and **Changed** line ends with the guided-tour step that shows it, `<!-- tour: <chapter>[.<step>] -->` (ids from `obsidian-plugin/src/tour/steps.json`; several comma-separated), or says why none does, `<!-- no-tour: <reason> -->`. `node tools/changelog.js check current` (CI's lint job) fails a line with neither, an unknown id or an empty reason; GitHub hides the markers and the release notes drop them. A release also needs its What's new entry in `obsidian-plugin/src/tour/whatsnew.json` before `npm run version:bump`, or the bump refuses ([docs/app-smoke.md](docs/app-smoke.md), Release procedure).

## Pull requests

- One feature or fix per pull request, touching every place it reaches: the runtime, both plugins and, when it changes, the app.
- Title it with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`, `test:`) and say in the body what changed and why, and how it behaves on each host.
- CI must be green: the tests on Node 20 and 22 on macOS and Linux, the install rehearsals, the time-zone runs, lint and the changelog check, and the app's suite.

By contributing you agree your work is released under the project's [MIT License](LICENSE).
