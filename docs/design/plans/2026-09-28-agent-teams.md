# Agent Teams: plan

Date: 2026-09-28 · Spec: `docs/design/specs/2026-09-28-agent-teams-design.md` · Base: `24073a1`

## Goal

A user on Claude Code, Codex or both can keep named agent teams in the vault: a lead agent moves work items across a
board through stages and gates, dispatches headless seats into git worktrees on the provider each seat names, and
reviewers run on the provider that did not build. `aos team` is the one reader and writer. PR 1 ships the store,
the CLI, the seams and the `/team` command on every host. PR 2 ships the Agent Teams tab.

## Review decisions (2026-09-28)

| Topic | Decision |
|---|---|
| Design | Approved as written (D1 to D14). |
| Split | Two PRs: the CLI and runtime first, then the tab (D14). |
| Builder | Built in-session and cross-reviewed by the other provider before each PR opens. |

## File structure

| Path | New/Changed | PR | What |
|---|---|---|---|
| `brain/scripts/lib/teams.js` | new | 1 | The store: `TEAM.md` subset parser and line-level rewrites, board (last row wins), channel, runs, markers, the killed-run sweep, `wait`, `put` with `--expect`, user decisions refused under `AOS_HEADLESS=1`, `init` from the template |
| `brain/scripts/lib/team-run.js` | new | 1 | Dispatch: preflight, provider resolution, worktrees, the async seat run with signal traps, spend, telemetry, merge back, posts, the run row; `--detach` via launchd, `systemd-run --user`, or a detached respawn |
| `brain/scripts/team.js` | new | 1 | `aos team`: parser, verbs, `--json`, exit codes 0/1/2/3 |
| `brain/scripts/lib/headless.js` | changed | 1 | `seatArgs(host, { agent, prompt, body, model, effort, budget, addDir, cwd, gitDir, outFile })` |
| `brain/scripts/sdk/lib/spend-ledger.js`, `cli/aos.js` | changed | 1 | The `team:` family: out of the hook cap, summed in `spendByFamily`, shown by `aos status` |
| `brain/scripts/heartbeat-writer.js` | changed | 1 | Every `TEAM.md` lead joins the orchestrator roster; config entries win |
| `vault-template/persona/teams/example/TEAM.md` | new | 1 | A neutral three-seat example team |
| `vault-template/_gitignore` | changed | 1 | `persona/teams/*/running/` |
| `plugin/bin/aos` | changed | 1 | `team) SCRIPT=team.js ;;` |
| `plugin/commands/team.md` | new | 1 | `/agenticos:team` · `$agenticos:team`: board, gates, step mode, quoting |
| `codex-plugin/**` | generated | 1 | `npm run build:codex-plugin` |
| `brain/scripts/test/teams.test.js`, `test/team-run.test.js` | new | 1 | Store, CLI, dispatch with fake `claude`, `codex` and `launchctl`, signals, sweep |
| `brain/scripts/test/headless.test.js`, spend and heartbeat tests | changed | 1 | `seatArgs` per host; the `team:` family; leads as orchestrators |
| count tests, `README.md`, `docs/install.md`, `docs/plugin-smoke.md`, `vault-template/AGENTICOS.md`, `CHANGELOG.md` | changed | 1 | 20 → 21 commands, 27 → 28 Codex skills, the `aos team` rows |
| `hud/src/views/AgentTeamsTab.ts`, `views/teams/*Pane.ts` | new | 2 | The tab and its four areas |
| `hud/src/data/teams.ts`, `data/teamWriter.ts` + tests and fixtures | new | 2 | Pure parser shared with `lib/teams.js` through fixtures; writes through `runAos` |
| `WorkbenchView.ts`, `badges.ts`, `main.ts`, `styles.css`, `ui/noTextBoxes.test.ts` | changed | 2 | Rail entry, badge, command, styles, the Manage pane under the scan |

## Tasks

PR 1:
- [ ] `lib/teams.js` + tests (port of the prototype's reader and writer, generic names, headless refusals)
- [ ] `seatArgs` in `lib/headless.js` + tests per host
- [ ] `lib/team-run.js` + tests (fake CLIs; SIGTERM; SIGKILL and the sweep; `--detach` against a fake `launchctl`)
- [ ] `team.js` CLI + tests
- [ ] Spend family, heartbeat roster, launcher arm, example team, `_gitignore`
- [ ] `plugin/commands/team.md`, rebuild `codex-plugin/`, move the counts
- [ ] Docs and `CHANGELOG`
- [ ] Verify: gate, build, `npm test`, lint, typecheck, parity `--wip --rehearse`
- [ ] Cross-review on the other provider, fix, publish-check, commit, PR, CI

PR 2:
- [ ] Shape the tab with impeccable; `data/teams.ts` + fixtures shared with `lib/teams.js`
- [ ] The tab, its panes, the badge, the command, styles, smoke checks
- [ ] Verify, cross-review, PR

After both merge: release, `aos upgrade --from-local`, and point the vault's own team at `aos team` (the vault's
prototype scripts retire).
