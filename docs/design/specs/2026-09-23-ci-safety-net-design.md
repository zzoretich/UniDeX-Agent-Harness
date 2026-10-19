# CI safety net — design

Date: 2026-09-23 · Branch: `feat/ci-safety-net` · Verified against `24ac997` (v0.15.0 + #40) · Proposal 7 of the
Workbench 1.0 proposal ("Catch the next bug in CI")

## 1. Problem

CI is green while real bugs are present, and releases do not say what changed. Measured at `24ac997`:

- **Types.** `tsc --noEmit -p hud` fails with 3 errors (a test fixture missing `telemetry.staleAfterMinutes`);
  nothing type-checks in CI.
- **JavaScript lint.** No linter. `eslint:recommended` over the 257 JS files reports 150 findings in 53 files (79
  `no-unused-vars`, 52 `no-empty`, 19 regex nits); `no-undef` reports none.
- **Shell.** 14 shell scripts, never linted. `shellcheck` finds nothing at `warning` or above (13 `note`s).
- **Time zones.** CI runs in UTC and the development machine in UTC−4. Eleven tests in four files fail in another zone:
  under UTC+14 two CLI tests (`routines hosts`, `import-cloud`) and eight runtime tests (`collectHostSessions`, four
  persona `recheck`, three `tick`); under UTC−11 five runtime tests (`collectHostSessions`, four `tick`).
- **Environment.** The suites inherit the developer's shell: with `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `AOS_HOST` and
  friends exported, 2 CLI tests fail and dozens of runtime tests do.
- **Versions.** `tools/bump-version.js` skips `brain/scripts/package.json`, so the MCP server (`sdk/mcp-server.js:36`)
  reports 0.1.0.
- **Releases.** No CHANGELOG; `release.yml` uses GitHub's generated notes (PR titles, no upgrade steps), and runs the
  gate, tests, build and publish in one job holding `contents: write`. Every action is pinned to a moving tag.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **tsc in CI.** `npm run typecheck -w hud` (`tsc --noEmit -p .`); fix the fixture. | Type-check `brain/scripts` with `checkJs`. | The HUD is the TypeScript; `checkJs` over 250 CommonJS files is a separate project. |
| D2 | **eslint, JavaScript only, tuned.** Root dev dependencies `eslint@9`, `@eslint/js@9`, `globals`; flat `eslint.config.js`; `eslint:recommended` with `no-empty: {allowEmptyCatch}` and `no-unused-vars: {caughtErrors: none, args: none, ignore ^_}`; fix the rest. `npm run lint`. | typescript-eslint over the HUD; no eslint. | The user chose JS only. The repo's `catch {}` is deliberate (hooks never fail), so those rules would only add noise; what remains is dead code or a real slip. Dev-only: the vendored runtime installs with `--omit=dev` from its own `package.json`. |
| D3 | **shellcheck at `warning`.** `tools/lint-shell.js` lists the tracked shell scripts (`*.sh` plus files with an `sh`/`bash` shebang, skipping the generated `codex-plugin/`), runs `shellcheck -S warning`, and fails when `shellcheck` is missing only under `CI`. `npm run lint:sh`. | `-S style`. A hand-kept file list. | Warning and above is clean today, so the job guards without churn; a shebang scan picks up new scripts by itself. |
| D4 | **A clean test environment, once.** `tools/test-env.js`, preloaded by all three suites, deletes every `AOS_*` (except `AOS_PRIVACY_TERMS`), `BRAIN_*`, `CLAUDE*`, `CODEX_*` and `AUTO_WRAP_*` variable, then sets `AOS_TEST_ENV_CLEAN=1`; a process that already has the marker changes nothing. | Scrub in every process. Fix tests one by one. | Tests set these variables on purpose for the children they spawn, and `NODE_OPTIONS` preloads run in every child, so a scrub must run only in the top-level runner; per-file processes inherit the clean env. |
| D5 | **A time-zone and dirty-environment job.** `ci.yml` job `tz-env` (ubuntu, Node 22, a matrix of `TZ=Pacific/Kiritimati` (UTC+14) and `TZ=Pacific/Pago_Pago` (UTC−11)) runs the full suite with host variables exported. Each failure is fixed at its cause: every one was a test clock that did not match its assertion (a UTC instant checked against a local-day rule, or the reverse); no runtime code was wrong. | A TZ axis on the whole matrix. | The two extremes cover every date-boundary off-by-one; one Linux job keeps CI time flat. |
| D6 | **`brain/scripts/package.json` is a version surface.** Added to `bump-version.js` (and `--check`); set to the repo version now. | Read the version from the root `package.json` at run time. | The vendored runtime has no root `package.json`. |
| D7 | **CHANGELOG.md, backfilled to v0.1.0**, Keep-a-Changelog sections with an **Upgrading** subsection whenever a user must act. `tools/changelog.js notes <v>` prints that version's section, `check <v|current>` fails when it is missing or empty, and `roll <v>` turns `[Unreleased]` into `## [v] — <date>`; `bump-version` calls `roll` and fails on an empty `[Unreleased]`. | Start at the next release. Hand-edit the headings at release time. | The user chose the full backfill; releases so far carried no upgrade steps, and one command keeps the notes and the version in step. |
| D8 | **Release: build, then publish.** `release.yml` job `build` (`contents: read`): version `--check`, `changelog --check`, gate, HUD tests, typecheck, build, upload the bundle as an artifact. Job `publish` (`contents: write`, needs `build`): download it and `gh release create` (or, on a re-run, `edit` + `upload --clobber`) with the CHANGELOG section as notes. | Keep one job; keep `softprops/action-gh-release`. | Only the job that publishes holds the write token, and it checks out nothing: the notes are built in `build`; `gh` is on the runner, so the one third-party action goes away. |
| D9 | **Actions pinned to full commit SHAs** with a `# vX.Y.Z` comment; `.github/dependabot.yml` keeps them current weekly. | Moving major tags. | A moved tag runs new code with the workflow's token; Dependabot turns every upgrade into a reviewed PR. |

## 3. What already exists (at `24ac997`)

- `.github/workflows/ci.yml` (test matrix ubuntu/macOS × Node 20/22; rehearsals), `privacy.yml` (gate + gitleaks,
  pinned by SHA256), `release.yml` (one job, `softprops/action-gh-release@v2`, `generate_release_notes`).
- `tools/bump-version.js` (six surfaces + `--check`), `tools/bump-version.test.js`.
- `brain/scripts/test/setup.js` (preloaded; seeds a temp vault; deletes `AOS_HEADLESS`); `cli/*.test.js` delete
  `AOS_CONFIG`/`AOS_VAULT`/`AOS_REPO_HINT` at the top.
- The hostile-recipe test the proposal asks for after Proposal 1 exists: `brain/scripts/test/recipe.test.js`
  (recipe guard, #22).

## 4. Design

- `tools/test-env.js` (+ test); root `test` script and ci.yml: `node --require ./tools/test-env.js --test …`;
  `brain/scripts/test/setup.js` requires it first; `hud` test script adds `--require ../tools/test-env.js`.
- `eslint.config.js`, root `devDependencies`, scripts `lint`, `lint:sh`, `typecheck` (delegates to the workspace).
- `tools/lint-shell.js` (+ test), `tools/changelog.js` (+ test), `CHANGELOG.md`.
- ci.yml: job `lint` (ubuntu, Node 22: eslint, shellcheck, typecheck, `changelog check current`); job `tz-env` (D5); SHA pins. privacy.yml,
  release.yml: SHA pins; release.yml split (D8). `.github/dependabot.yml`.
- Docs: `docs/plugin-smoke.md` release procedure (CHANGELOG first, the two release jobs), `docs/acceptance.md`, README
  "Staying up to date" (points at the CHANGELOG's Upgrading notes) and "Development" (the new commands).

## 5. Host parity

CI and tooling, plus what eslint found in the runtime: dead code removed, and `persona/backlog.js` now applies the
heading demotion its header promised. No hook, skill, MCP tool or model call changes, so both hosts behave as before.
The env scrub clears both hosts' variables (`CLAUDE*` and `CODEX_*`), and the `tz-env` job exports both, so a test
that leaks either host's setting fails in CI.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | nothing new | unchanged | — |
| Codex only (plugin · direct) | nothing new | unchanged | — |
| Both | nothing new | unchanged; release notes now carry Upgrading steps for either host (e.g. `/hooks` re-trust) | — |

## 6. Out of scope

- Type-checking the CommonJS runtime (`checkJs`), and typescript-eslint over the HUD.
- `shellcheck` at `style` severity.
