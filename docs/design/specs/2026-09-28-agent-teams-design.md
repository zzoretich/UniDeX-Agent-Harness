# Agent Teams: design

**Date:** 2026-09-28
**Status:** approved design (2026-09-28); PR 1 merged (#59); PR 2, the tab, on `feat/agent-teams-tab` (§4.5)
**Scope:** named agent teams in the vault. A lead agent runs a board of work items through stages and gates, with
headless seats on Claude Code or Codex, each in its own git worktree. `aos team` is the one reader and writer; a new
**Agent Teams** tab shows every team and lets the user manage it, talk to it and decide its gates.

---

## 1. Problem

A user can define agents on both hosts and run routines and duties, but agents cannot work *together*: nothing
holds a shared work board, a team thread, per-item budgets, or the rule that a reviewer never runs on the provider
that built the work. A private prototype (a board, a channel and a dispatcher, piloted end to end on a small Electron
app with nine seats on both providers) proved the shape. It also found what breaks: runs killed with their host
terminal leave no trace, dollar signs vanish from posts through shell quoting, and a lead run as a sub-agent cannot
wait for an hour-long seat. This spec makes the prototype a product feature, generic and host-neutral.

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | **Store:** `persona/teams/<team>/`: `TEAM.md` (frontmatter roster, a strict YAML subset: `key: value`, inline `[a, b]` and `{a: 1}`, one `members:` list of flat maps), `board.jsonl` (append-only snapshots, last row per id wins), `channel.jsonl`, `runs.jsonl` (one row per finished run), `running/<run>.json` (a live run's marker), `STATE.md` (the lead's three lines), `DISABLED` (kill switch). All rows `schema: 1`. | One JSON registry: not hand-editable, and prototype teams would need converting. |
| D2 | **`aos team` is a runtime script** (`brain/scripts/team.js`, `lib/teams.js`, `lib/team-run.js`) with its own parser behind a launcher arm, as `aos notify` is. The HUD calls it through `runAos` with its `cli` override. | `cli/team.js` behind `cli/aos.js`: its strict global parser would need a dozen new flags. |
| D3 | **Every board write goes through the CLI** under the board's `fsx` lock. The lead writes with `put --from <lead>`, and user decisions have their own verbs. Any write can carry `--expect '<json>'`, a compare-and-set against the item's snapshot, and the HUD always sends the `ts` of the row it rendered. | The HUD writing files itself: a stale card could overwrite a newer decision. |
| D4 | **User decisions** (`gate approve|redirect`, `budget`, `pause|resume`, `set`, `member add|remove`) are refused under `AOS_HEADLESS=1`, so no dispatched seat or duty can record one (precedent: `persona/ledger.js` refuses `approved`). A gate records `"by": "user"`. A seat runs as the user's own account, so the variable is a guard, not a wall: a Codex seat's sandbox cannot reach the board, and a decision recorded on an item while its seat runs marks the run `blocked` and asks the user to confirm it. | Trusting the caller: the prototype relied on a session's permission classifier. |
| D5 | **Seats run through the headless seam.** A new `seatArgs(host, …)` in `lib/headless.js` builds the command: Claude `-p --agent <agent> --permission-mode auto --max-budget-usd <left> --add-dir <team dir>`; Codex `exec` in a `workspace-write` sandbox on the worktree, with the git dir added, network on, hooks off, and the agent's instructions inlined from its definition. | Building the command in the team runner: it bypasses the seam `parity-check` guards. |
| D6 | **One worktree per run** on `team/<item>/<member>`, forked from `team/<item>/trunk`, under `workspaces/_worktrees/`, and merged back with `git merge-tree` plus a ref compare-and-swap, so the trunk is never checked out. Projects live under `workspaces/`. The project's `main` changes only through a ship seat. | Seats sharing one checkout: parallel verify seats collide. |
| D7 | **A killed run leaves a trace.** The marker holds the dispatcher's pid and host. SIGTERM, SIGHUP and SIGINT stop the seat and record `killed`. Every team command sweeps markers whose pid is gone or reused into one `killed` row and a `blocker`, exactly once. `dispatch --detach` hands the run to launchd (macOS) or `systemd-run --user` (Linux; otherwise a detached respawn plus a warning). `aos team wait` blocks until a run's row lands. | A `running` row in `runs.jsonl`: every reader would have to fold two rows per run. |
| D8 | **Spend** is recorded as family `team:<team>:<member>`, excluded from the hook cap and shown in `aos status`. Claude cost comes from the result; Codex cost is priced from tokens. An item's phase budget caps Claude dollars (`--max-budget-usd`); Codex runs count as `codexRuns`. There is no daily cap by default. | Charging Codex estimates to phase budgets: an estimate is not a bill. |
| D9 | **Runs tab roll-up.** Each seat run appends a telemetry row as the lead's run, with the seat in `subagents`. `heartbeat-writer` treats every `TEAM.md` lead as an orchestrator, so the lead's card rolls up its seats. An explicit `roster.orchestrators` entry still wins. | Making users edit `roster.orchestrators` by hand. |
| D10 | **Gates.** `gate approve` records the decision and moves the item to the next stage, with the lead as owner. The lead's next step picks the seat. The Discuss gate takes `--usd`. A redirect carries the user's note, so the tab opens the lead in the terminal to take it. | The tab dispatching seats: choosing a seat is the lead's judgement. |
| D11 | **Step mode.** A lead never waits for a seat. `dispatch --detach` prints a `wait` line and the lead returns. Whoever called the lead runs that line in the background and calls the lead again when it exits. | An autonomous loop driving the lead: out of scope (section 7). |
| D12 | **The tab** has four areas: Roster, Manage, Interact and Work board. Manage is its own file under the no-text-boxes test. Interact's message box (data entry, which the settings rule allows) posts to the channel as `user` with an `@<lead>` mention. The badge counts pending gates. | One view file: the message box would fail the scan or need an exemption. |
| D13 | **The example team** (`vault-template/persona/teams/example/`, neutral names) is seeded only by `aos team init` or the tab's empty-state button, never by `init` or `upgrade`. | Seeding on upgrade: it would write into users' `persona/`. |
| D14 | **Two PRs.** PR 1: the store, `aos team`, the seams, the `/team` command and the example team, on all hosts. PR 2: the tab. | One PR: too large to review, and the CLI is useful before the tab. |

## 3. What already exists (verified at `24073a1`)

- `lib/headless.js`: `resolveBin`, `headlessEnv`, `codexHomeOf`, `hostEnabled`, `runnerArgs`, `crossArgs`. It has no
  `--agent`, working-directory or permission-mode support.
- `lib/agent-translate.js`: `readClaude(text).body`, `readCodex(text).instructions`. `lib/fsx.js`: `withLockSync`,
  `writeAtomic`, `appendLineSync`. `lib/detach.js`: `respawnDetached`. `cli/schedule.js`: launchd with an
  `AOS_LAUNCHCTL_BIN` seam.
- `persona/record-spend.js`: `rowFrom`, `rowFromCodex`; `sdk/lib/codex-pricing.js`: `priceUsd`;
  `sdk/lib/spend-ledger.js`: `HOOK_EXCLUDE`; `cli/aos.js`: `spendByFamily`, `status()`.
- `sdk/lib/telemetry.js`: `startRun`, `endRun`. `heartbeat-writer.js`: `buildRoster`, `orchestratorFor`.
- HUD: `WorkbenchView` `RAIL`, `makeTab`, `setBadge`, `touchesBadges` and `runInTerm`. `data/aosRun.ts`: `runAos` and
  `failureText`. `data/aosConfig.ts`: `sessionHosts`. `data/agents.ts`: per-host run commands. `ui/noTextBoxes.test.ts`.

## 4. Design

### 4.1 `aos team`

```
aos team list | status <team> | roster <team> | board <team> | item <team> <id> | tail <team> [--item id] [-n N]
aos team post <team> --from <id> [--item id] [--kind note|assign|handoff|done|blocker|gate|question] <text>
aos team put <team> --from <lead> [--expect <json>] <patch json>                         # the lead's board write
aos team dispatch <team> <member> <item> [--wave N] [--note text] [--provider p] [--dry-run | --detach]
aos team wait <team> <item> <member> [--since iso] [--timeout-min N]
aos team gate approve|redirect <team> <item> [--usd N] [--note text] --expect <json>     # user decisions (D4)
aos team budget <team> <item> <usd> --expect <json> · pause|resume <team> [member]
aos team set <team> <member> provider|model|effort <preset> · member add|remove <team> <agent>
aos team init [--example]
```

`--json` on every read. Usage errors exit 2 and refusals exit 1. `dispatch` exits 3 when a run fails, is killed or
does not merge. Every verb sweeps killed runs first (D7).

### 4.2 Dispatch

This is the prototype's procedure, verified in the pilot:
1. Refuse on `DISABLED`, a paused seat, the lead, a non-owner, a pending or unapproved gate, a spent budget, or
   `opposite` with no builders.
2. Resolve the provider: `opposite` means the one missing from the item's `builders`. When both built, `--provider`
   is required, one round per provider.
3. Cut the worktree, write the marker, and run `seatArgs` under `headlessEnv`.
4. Record spend and telemetry.
5. Merge back. A seat that committed in execute becomes a builder.
6. Post the seat's final line when the seat did not post, plus a `blocker` for a failure, a kill, uncommitted work or
   a conflict.
7. Append the run row and remove the marker.

`set` accepts only presets: provider `claude|codex|opposite`, the model presets from `settings-schema`, and effort
`low|medium|high`.

### 4.3 In-session surface

`plugin/commands/team.md` → `/agenticos:team` · `$agenticos:team` (direct wiring: `$team`). It shows the board and
pending gates, records a gate the user decides in the session, and documents step mode (D11) and quoting (text with a
`$` goes in single quotes) for any lead or seat.

### 4.4 The Agent Teams tab (PR 2)

Files: `views/AgentTeamsTab.ts`, `views/teams/{Roster,Manage,Interact,Board}Pane.ts`, `data/teams.ts` (pure parser; it
skips a bad complete line and retries a torn tail), `data/teamWriter.ts` (`runAos` only). The rail entry sits after
Agents. The badge counts gates pending across teams, and `touchesBadges` covers `persona/teams/`.
- **Roster:** team cards, nested by `parent`. A member row shows name, role, a provider chip, model, status (idle,
  working from its marker, blocked from the board, or paused), the current item, and the last run with its cost.
- **Manage:** provider, model and effort pickers; a pause toggle; add a member by picking from `agents.json`; remove
  with a confirm dialog. No text boxes.
- **Interact:** the channel with `@mentions`, a message box to the lead, and "Talk to <name>" per enabled host (the
  agent's run command from `agents.json`).
- **Work board:** one column per stage. A gate card has Approve (the Discuss gate adds budget presets and − / +
  steppers) and Redirect, which opens the lead in the terminal.

### 4.5 PR 2: how the tab came out (2026-09-28)

- **Layout (the user's pick):** "Needs you" first, the pending gate cards of every team; then team chips in tree order
  (a child indented under its `parent`); then Board · Roster · Interact · Manage for the chosen team, Board by default.
- **Reads:** `data/teams.ts` parses the files by `lib/teams.js`'s rules, which the shared fixture vault proves, from disk
  at the plugin's vault root: the folder `aos team` writes, which can differ from the open Obsidian vault. The badge
  reads boards only, on vault events and once a minute (a vault outside Obsidian sends no events). **Writes:** only `aos team` through `runAos`'s `cli` override, each board write with the
  whole rendered snapshot as `--expect` (a timestamp alone can repeat within a millisecond); reads that overlap apply
  only the newest. While the tab is showing it re-reads every 30 s and runs `aos team list --json`
  about once a minute, which records any killed run (so a stale marker never shows a member working for good) and names
  the presets `set` takes. Unsent messages are kept per team.
- **Gates:** the gate on a team's first stage funds the work: presets are half, the proposal (`budget.usd`) and double,
  − / + walk a fixed ladder, and nothing goes below spend plus what live Claude runs hold. Approve asks first. Redirect
  opens the lead's agent with a prompt naming the gate and the exact line that records it: this vault's own
  `team.js` with `AOS_VAULT` set (never the terminal's `aos` config), every value shell-quoted, the whole snapshot as
  `--expect`; the host's folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) leads the command when a new terminal would use
  another. Where that host lacks the lead's agent, a plain session gets the same prompt.
- **The lead's next step (after 0.20.2):** a recorded Approve, and a recorded budget raise on a `paused` item, open the
  team's lead in the terminal with a prompt saying what the user decided, that it is already recorded, and this vault's
  `aos team` line. It opens the lead's agent on the lead's own `provider` when that host is enabled and has it, else on
  the first enabled host that has it, else a plain session told which lead to act as and to read its team's
  `TEAM.md`; the Approve dialog names that host first. A cancelled or refused write opens nothing, and when no terminal
  can start, the tab copies the command and shows it in a notice that stays until dismissed. The lead picks the seat and dispatches it: the tab still never
  dispatches (D10).
- **Runtime change:** `aos team list` lists a team whose `TEAM.md` does not parse as a row with its error, rather than
  failing, and its `--json` carries `presets`.

## 5. Host parity

1. **Entry point:** `aos team` is host-neutral. `/agenticos:team` · `$agenticos:team` · `$team`. The tab is the same
   on every host.
2. **Hooks:** no hook command is added or changed. `heartbeat-writer` reads `TEAM.md` inside an existing hook, so no
   re-trust is needed.
3. **Model calls:** seats go through `lib/headless.js` (D5) on the host their `TEAM.md` row names. `provider: none` is
   irrelevant, since seats are agent jobs.
4. **Session data:** none. Agent definitions are read from the Claude config dir or the Codex home.
5. **MCP:** no new tool.
6. **Degradation:** a seat whose host has no binary, and `opposite` with only one host, both refuse with a line naming
   the missing host. On a single-host vault the tab hides the other host's buttons. On a platform with no launchd or
   systemd, `--detach` warns and respawns detached.
7. **Docs:** the README commands table, `docs/install.md`, `AGENTICOS.md` (both forms), `docs/plugin-smoke.md` (a tab
   check, and an in-session check per host), and `CHANGELOG`.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | the tab · `/agenticos:team` · `aos team` | `team.js`; seats on `claude -p --agent` | a Codex seat or `opposite` refuses, naming the missing host |
| Codex only (plugin · direct) | the tab · `$agenticos:team` · `$team` · `aos team` | `team.js`; seats on `codex exec` with the agent inlined | a Claude seat or `opposite` refuses, naming the missing host |
| Both | all of the above | seats on the host each `TEAM.md` row names; reviewers on the other one | none |

The Claude-only and Codex-only cells differ only by symmetric refusals. A team whose seats all name available hosts
works everywhere, so there is no host gap to approve.

## 6. Testing

- `brain/scripts/test/teams.test.js`: `TEAM.md` parsing and `set` rewrites, torn lines, `--expect`, the headless
  refusals, gates, `wait`, and the sweep (a dead pid, a reused pid, another host, exactly once).
- `brain/scripts/test/team-run.test.js`: fake `claude` and `codex` binaries run the whole dispatch, including a SIGTERM,
  a SIGKILL plus sweep, `--detach` against a fake `launchctl`, spend rows and telemetry.
- `test/headless.test.js`: `seatArgs` per host.
- `hud/src/data/teams.test.ts`: shared fixtures read by both the TS parser and `lib/teams.js`, the badge,
  and member status.
- The count tests move with the new command. `npm run gate` stays clean.

## 7. Out of scope

An autonomous lead loop, cross-machine runs, Windows, shipping agent definitions (teams name the user's own agents),
and a daily team spend cap.
