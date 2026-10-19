# Append-only runs.jsonl and one file-write helper — design

Date: 2026-09-24 · Branch: `feat/append-only-runs` · Verified against `6f48062` (v0.19.2 + #53–#56), Claude Code 2.1.281, codex-cli 0.156.1

Review finding R2, the fourth P3 fix, first of two PRs: this one makes `runs.jsonl` append-only and adds the shared
helper; the second moves the other unlocked writers (routines.json, MEMORY.md, SESSION.md, BRAIN.md's Last Session,
the fixed-`.tmp` writers) onto it.

## 1. Problem

- `runs.jsonl` has four appenders (telemetry-hook `endRun`, headless runs, and until #56 the Workbench) and two
  processes that rewrite it whole: cost-sync (patch `cost_usd` into a session's rows) and retention (drop old rows).
  They run in the same SessionEnd, detached, so they overlap: a row appended between a rewriter's read and its rename
  is lost, and both rewriters used the temp name `runs.jsonl.tmp`, so one truncated the other's temp file.
- cost-sync patched the whole session's cost into every row of the session. On the owner's vault (148 rows) the raw
  sum was $770.01 against $556.56 counted once per session: $213.45 counted twice.
- 12 writers across the runtime use a fixed `<file>.tmp`; the only shared helper (`config-write.writeAtomic`) is JSON
  only and used by one command. The one owner-aware lock is graph-build's, private to it.
- Codex costs in-process and fast, so cost-sync could run before `endRun` appended the row: "0 runs needed
  patching", and the session stayed uncosted.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **`lib/fsx.js`**: `writeAtomic` (temp `<file>.<pid>.<random>.tmp`, opened `wx`, renamed), `withLockSync` (a `<file>.lock` with `{ pid, id, until }`, broken only when the pid is gone or `until` passed, released only by its id; `timeoutMs`, `onBusy: 'throw' \| 'run'`), `updateSync` (lock → read → change → write when changed), `appendLineSync` (optionally waiting on the lock). | Reuse `snapshotLock` (mkdir mutex). | It has no owner: a slow holder whose lock went stale deletes the next holder's lock on release. graph-build's owner-aware model already proved itself; the writers are synchronous, so the helper is too. |
| D2 | **Costs are records of their own**: cost-sync appends `{ schema: 1, session_id, cost_usd, cost_source, tokens, at }` to `brain/_index/agent-runs/costs.jsonl` (skipping a repeat of the newest), and never rewrites `runs.jsonl`. | Patch under a lock. | A lock would stop the lost rows but not the double count, and every SessionEnd would rewrite the whole log; a cost recorded before its row exists just waits for it. |
| D3 | **One merge rule, `applyCosts(runs, costs)`**, in `lib/runs-log.js` (`readRuns()`) and mirrored in the HUD's `runs.ts`: a session's newest cost goes on its latest session row (the one that ended last); its other session rows read `cost_usd: 0` with `cost_counted_on` naming that row; a session with no record keeps the highest `cost_usd` its rows carry, on the same one row; headless rows keep their own cost. Both implementations run the same fixture (`test/fixtures/apply-costs.json`). | Collapse a session's rows into one. | Rows stay what they are (closed runs, segments since #56); only the money is counted once. `0` with a pointer keeps "uncosted" checks (Fix Queue, backfill) honest. |
| D4 | **Retention is the one rewrite left**, of both logs, under each file's lock from read to rename; the appenders (`endRun`, headless runs, `appendCost`) wait on it up to a second, then append anyway rather than drop a row. | Monthly log files. | One rewrite a scan, milliseconds long; monthly files would change every reader. |
| D5 | **Readers move to the merged view**: auto-cost backfill, cost-budget, and the HUD's `loadRuns` / `loadRunsForMonth` (so the Runs tab, Cost panel, Fix Queue and status bar); the HUD refreshes on either log (`touchesRuns`). `runFieldFor` (model, host) and standup read fields costs never touch and stay as they are. | — | — |

## 3. What already exists (at `6f48062`)

- `cost-sync.js` `gatherReports` (newest report per session uuid) — kept; `lib/telemetry-retention.js`; the appends in
  `telemetry-hook.js` `endRun` and `sdk/lib/telemetry.js`.
- `graph-build.js` `withGraphLock` (the lock model), `lib/config-write.js` `writeAtomic` (JSON, pid temp).
- HUD: `src/data/runs.ts` (`loadRuns`, `loadRunsForMonth`), `cost.ts` `dedupeRuns` (still applied; the merged view
  gives it one costed row per session).

## 4. Host parity

1. **Entry point.** SessionEnd on both hosts (auto-cost → cost-sync; telemetry-hook), scans (retention), the HUD.
2. **Hooks.** Commands unchanged; Codex users re-trust nothing.
3. **Model calls.** None.
4. **Session data.** Keyed by session id from either host's transcript name (unchanged `uuidOf`).
5. **MCP.** None.
6. **Degradation.** A lock not taken in time: appenders append anyway, retention leaves the log to the next scan.
7. **Docs.** `docs/cost.md`, `docs/plugin-smoke.md`, CHANGELOG.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | SessionEnd · scans · the HUD | analyzer → cost-sync → costs.jsonl; readers merge | — |
| Codex only (plugin · direct) | the same | rollout pricing → cost-sync → costs.jsonl | — |
| Both | either | the same, per session | — |

## 5. Out of scope

The second R2 PR (the other writers onto `fsx`). `persona/reflect.js` sums `cost_usd` from the per-run timeline files,
which never received a cost; it should read `readRuns()` (a follow-up). Rows already in a vault are not rewritten:
the merge reads them as they are.
