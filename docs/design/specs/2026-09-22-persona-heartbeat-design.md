# Persona heartbeat and proposal ledger — design

Date: 2026-09-22 · Branch: `feat/persona-heartbeat` · Verified against `9c2770c`

## 1. Problem

The Chief of Staff agent runs three scheduled duties (sitrep, monitor, reflect). The only liveness
check lives inside `run-duty.sh`: it counts journal entries before and after a run and records
FAILED when none appears. That check cannot fire when launchd or cron never starts the runner, so a
duty that silently stops firing produces no journal entry, no flag, and no FAILED record. Nothing
polls "did the schedule keep its promises", and nothing tells the user outside a session.

The self-improvement loop is half built. `reflect` can file proposals, and the `persona-flag-closer`
skill approves or rejects them, but a rejection is the only outcome that leaves a trace (a feedback
memory). An approval leaves a git commit and nothing else: no record of what was applied, whether the
recheck stayed clean, or whether the change helped. The agent cannot learn from its own track record
because there is no track record.

This spec is slice 1 of the plan in `docs/design/plans/2026-09-22-persona-heartbeat.md`: a
model-free watchdog and an append-only proposal ledger. The hourly model-run tick, the HUD pill, typed
proposal routing, and the daily reflect are later slices and are listed there.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | The watchdog is a plain Node script, `brain/scripts/persona/watchdog.js`, with no model call. | Fold the check into the hourly tick duty. | The thing being watched is the model-run schedule; the guard must not share its failure mode or its budget. |
| D2 | It runs two ways: as a `command` routine `heartbeat` every 30 min, and from the `SessionStart` hook throttled to once per 30 min via a state file. | Routine only. | If launchd itself is dead the routine dies with it. The hook is the independent path and costs one stat per session. |
| D3 | A miss is computed from data the store already keeps: `cron.next()` projected forward from the duty's last run (`routines.json` merged with the duty log) or, for a duty that never ran, from `syncedAt`. No backward cron function. | A new `prev(expr, before)` in `cron.js` (the first draft of this spec). | `routines-store.health()` already derives `missed` this way for the CLI and HUD; the watchdog needs the same answer with a longer grace and miss-over-failed precedence, not a second calendar. |
| D4 | A miss is `expectedLastFire + grace` in the past with no run started at or after `expectedLastFire`. Grace defaults to 45 min; `persona.watchdog.graceMinutes`. | Compare against the run's finish time. | `lastRunAt` is the run start and is the only timestamp the store records reliably; the duty-log mtime fallback already exists for it. |
| D5 | Surfaces in this slice: a `MISSED` flag line under `## Flags` in `STATE.md`, and a best-effort OS notification (`osascript` on macOS, `notify-send` on Linux). Both deduped per slug per expected fire. | Notify on every check. | A flag that re-fires every 30 min trains the user to ignore it. |
| D6 | The watchdog owns its own flag lines: it adds one on a miss and removes it once that slug runs OK again. It never touches other flags. | Leave removal to the flag-closer. | A stale MISSED flag after recovery is noise, and only the watchdog knows recovery happened. |
| D7 | The ledger is `<vault>/persona/ledger.jsonl`, append-only, one event per line, written only through `brain/scripts/persona/ledger.js`. | A section in `STATE.md` or a memory per outcome. | `STATE.md` has a 1,200-char cap and is rewritten wholesale by duties; a memory per event pollutes recall. JSONL survives concurrent appends and is trivially summarized. |
| D8 | An `approved` event stores the proposal's recheck recipe. `ledger.js verify` re-runs recipes for approvals aged 1 to 14 days and appends `verified` (still nonzero) or `regressed` (exit 0 again). The watchdog calls `verify` once a day. | Keep the proposal file after approval. | The README promises the file is deleted on approval; the recipe is the only thing worth keeping. |
| D9 | Proposals gain an optional frontmatter `kind: self \| vault \| workflow \| product`, defaulting to `self`. This slice parses and ledgers it; routing by kind is slice 3. | Separate folders per kind. | One inbox, one review flow was the routing decision; the field is cheap now and unblocks the ledger schema. |
| D10 | Duty prompts learn one line each: reflect appends `filed` events, monitor is unchanged. The flag-closer skill appends `approved`, `rejected`, and `stale-dropped`. | Have the ledger infer events from the filesystem. | Inference cannot tell a rejection from a stale drop. |

## 3. What already exists (at `9c2770c`)

- `brain/scripts/lib/routines-store.js`: `list()` (`:149`), `read(slug)` (`:160`), `patchState` (`:206`),
  and the duty-log mtime fallback for `lastRunAt` (`:236-273`). State file `brain/_index/routines.json`
  with `routines.<slug>.{lastRunAt,lastExit,failStreak,lastTrigger}`.
- `brain/scripts/lib/cron.js`: `parse`, `next(expr, after, count)` (`:105`), `describe`, `toLaunchd`.
  Forward only; no previous-fire computation. TS mirror `hud/src/data/cron.ts`.
- `brain/scripts/routines/run-routine.js`: `kind: command` runs `argv` locally with `feature: null`
  (`:92`), so a command routine costs nothing and is scheduled by `cli/schedule.js` like a duty.
- `brain/scripts/persona/run-duty.sh`: the awk that inserts a flag directly under `## Flags` (`:168-172`)
  and the FAILED journal entry (`:160-165`). The watchdog mirrors that flag format in JS.
- `plugin/hooks/hooks.json`: `SessionStart` runs `update-notice`, the precedent for a throttled
  staleness check that surfaces a badge; `updates.intervalHours` is the throttle pattern.
- `plugin/skills/persona-flag-closer/scripts/collect.js` `collectProposals` (`:48`) parses `slug`,
  `filed`, `target`, `recheck`, `autoapply_class`; `recheck.js --record` (`:63`) writes
  `persona/flag-closer/confirmations.json` and nothing calls it. `render-digest.js` has no kind column.
- `brain/scripts/lib/config.js`: precedence `config.default.json` < `<vault>/brain/config.json` <
  `agenticos.json`; `persona: { enabled, perDutyUsd, perDayUsd }` (`config.default.json:19`).
- `brain/scripts/heartbeat-writer.js` writes per-agent `brain/agents/<name>/heartbeat.json` for the HUD
  staff strip; unrelated to duties, and its `next_fire` is always `null`.
- `docs/chief-of-staff.md` `## Proposals` (`:115`) documents the approve and reject flow.

## 4. Design

### 4.1 No cron change
`check()` takes `routines-store.overview()` rows plus `readState().syncedAt`; for each enabled duty
`from = last.at || syncedAt`, `due = cron.next(schedule, from)[0]`, and `now - due > grace` is a miss.
A miss outranks a non-zero last exit (a duty that failed and then stopped firing is missed).

### 4.2 `brain/scripts/persona/watchdog.js`
`check({ now, store, config, vault })` is pure and returns
`{ checkedAt, beats: { <slug>: { schedule, expectedLastFire, lastRunAt, status, lateMs } }, state: { updated, ageHours }, misses: [...] }`
with `status` one of `ok | missed | never | disabled | unscheduled`. `never` is a duty with an
expected fire in the past and no run ever; it is reported as a miss after one full cadence. Disabled
routines and `kind: command` routines are listed but never flagged. `run()` writes
`brain/_index/persona-heartbeat.json`, reconciles flag lines in `STATE.md` (D6), sends notifications
(D5) deduped through `notified` in the same JSON, and calls `ledger.verify()` when the last verify
is older than 24 h. Exit 0 always; stdout is empty under `AOS_HEADLESS=1` or when nothing changed.
Notifications are skipped when `persona.watchdog.notify` is `false` or the binary is missing.

### 4.3 Scheduling and the hook
`vault-template/persona/routines/heartbeat.md` (vendored with the persona templates): `kind: command`,
`schedule: */30 * * * *`, `argv: ["{{NODE}}", "{{VAULT}}/brain/scripts/persona/watchdog.js"]`.
`run-routine.js` expands exactly those two placeholders at plan time, so the file is byte-identical on
every machine and survives a node upgrade (the duty prompts, which bake the interpreter path in, do
not). `writePersona()` seeds `<vault>/brain/routines/heartbeat.md` when it is missing and keeps it
otherwise; `aos routines sync` installs the schedule. `bin/aos` gains a `persona-watchdog` verb wired
into `SessionStart` after `update-notice` (Claude Code and Codex hook tables), exiting 0 with empty
stdout when the persona is off, the vault is uninitialized, or the last check is under 30 min old.

### 4.4 `brain/scripts/persona/ledger.js`
CLI and module. Events: `filed | approved | rejected | stale-dropped | verified | regressed`.
Line shape: `{ ts, event, slug, kind, target, by, recheck?, commit?, note? }` where `by` is
`reflect | user | watchdog | flag-closer`. Verbs: `append <event> <slug> [--kind] [--target] [--by]
[--recheck] [--commit] [--note]`, `verify` (D8), `summary [--days N]` printing counts per event and
per kind, the approval rate, and any `regressed` in the window. Corrupt lines are skipped with one
stderr warning, matching `loadRepos()` in `sitrep-state.js`.

### 4.5 Flag-closer and duty prompt changes
`collect.js` parses `kind` (default `self`) and lints an unknown value. `render-digest.js` shows it
as a column. `SKILL.md` gains one ledger call after each approve, reject, and stale drop, passing the
recipe on approve. The reflect duty template in `interview.js` gains a line after filing: run
`ledger.js append filed <slug> --kind <kind> --by reflect`. Existing vaults pick this up by regenerating
duties through the interview or by an ordinary proposal; the spec does not edit a live vault.

### 4.6 Config and docs
`config.default.json` `persona` gains `"watchdog": { "graceMinutes": 45, "notify": true }`.
`docs/chief-of-staff.md` gains `## Heartbeat` and a ledger paragraph under `## Proposals`;
`proposals/README.md` in `vault-template` documents `kind`. README "Everyday commands" lists
`aos routines run heartbeat` and `ledger.js summary`.

## 5. Testing

- `run-routine.test.js`: `{{NODE}}` / `{{VAULT}}` expansion in a command routine's argv, other text literal.
- `run-duty.test.js`: the system prompt opens with the date line; `ledger.js` is on the tool allowlist.
- `watchdog.test.js` (temp vault built inline before requires, per `sitrep-state.test.js`): ok, missed,
  never, disabled, command kind, grace boundary, flag added on miss and removed on recovery, other flags
  untouched, dedupe of notifications, no-op under a fresh check, exit 0 on a corrupt state file.
- `ledger.test.js`: append and read, corrupt line skipped, `verify` marks verified and regressed with a
  fake recipe runner, `summary` counts.
- `flag-closer.test.js`: `kind` parsed with default and lint, digest column present.
- `persona-interview.test.js`: the heartbeat routine is seeded verbatim and kept on a re-run.
- `cli/plugin-manifests.test.js` and `cli/vault-template.test.js`: new verb and routine file.

## 6. Out of scope

The hourly model-run tick and its signal queue (slice 2). The HUD heartbeat pill and the TS mirror of
`prev` (slice 2). Routing workflow and product proposals to a backlog, the daily short reflect, and
correction and telemetry signals feeding reflect (slice 3). Earned auto-apply and the confirmations
producer (slice 4). Windows.
