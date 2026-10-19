# Host routines — design

Date: 2026-09-21 · Branch: `feat/host-routines` · Verified against `88420c6`

## 1. Problem

Two things make the Routines tab read as stale.

**The last-run column has one source and it is not the only writer.** `brain/_index/routines.json`
is written only by `run-routine.js` (spec D5). Before routines existed, `aos persona` installed one
static plist per duty that called `persona/run-duty.sh` directly, and those plists keep firing until
the next `aos upgrade` or `aos routines sync` replaces them. On the owner's machine the sitrep fired
at 07:45 and the monitor at 13:00 on 2026-09-21 through the legacy plists: both runs are in
`persona/journal/logs/duty-*.log` and in the persona journal, yet the tab and `aos routines list`
show sitrep as `never` and the monitor's last run as the 15:49 manual one. The sync tonight closed
the cause, but the reader still ignores a second source of truth it can see, and any direct
`run-duty.sh` invocation will reopen the gap.

**Two more schedulers the owner runs are invisible.** Claude Code cloud routines
(claude.ai/code/routines: two disabled one-shots today) and Codex app Automations
(`<codex home>/sqlite/codex-dev.db`, table `automations`, empty today). The "Outside the runtime"
rows (spec D13) know only the Obsidian Git timer and allow-listed launchd labels. The owner wants
one place to *see* every recurring action, including the ones each host owns.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | The reader gains a **duty-log fallback**. For a `duty` routine, `routines-store.overview()` (and its mirror `routines.ts`) reads `persona/journal/logs/duty-<slug>.log`: the file's mtime is the run end, the last line's `done (exit N)` is the exit. When that is newer than `lastRunAt`, it becomes `last` with `trigger: "duty-log"`; health is computed from the merged value. A last line that is a `start` line (a run in flight or a crash) is ignored. | Backfill `routines.json` at upgrade; or make `run-duty.sh` write the state file. | A one-time backfill misses the next direct invocation. The shell runner should not learn the JSON store; the wrapper owns writes (D5). Reading mtime is locale-proof where parsing the `[$(date)]` stamp is not. Zero writes, always honest. |
| D2 | **Codex Automations are read live from SQLite** through the `sqlite3` CLI (`-readonly -json`), never a Node binding. New `brain/scripts/lib/host-routines.js` runs one query over `automations` joined to the latest `automation_runs` row and describes the `rrule` (FREQ, INTERVAL, BYDAY, BYHOUR, BYMINUTE; anything else prints raw). A missing binary or database yields an empty section with one warning; nothing throws. | `node:sqlite` (Node ≥ 22.5, absent in Electron); a dependency; parsing the file by hand. | Node ≥ 20 and zero runtime dependencies are conventions. `sqlite3` ships with macOS and every mainstream Linux, and the read is one shell-free `execFileSync`. |
| D3 | **Claude Code cloud routines are a session-imported snapshot.** The runtime cannot list them: the only client is the in-process `RemoteTrigger` tool (OAuth added in-process), there is no CLI verb, and the endpoint is undocumented. New verb `aos routines import-cloud <file>` validates the `RemoteTrigger list` payload, normalizes it, and writes it with a `fetchedAt`. The `/routines cloud` command tells Claude to call `RemoteTrigger {action:"list"}`, write the JSON to a temp file, and run the verb. Under Codex the generated skill says the snapshot refreshes only from a Claude Code session. | Call `/v1/code/triggers` from the runtime with the keychain OAuth token; a `prompt` routine that refreshes it. | The token belongs to the Claude Code process, and a public runtime should not learn to read it. A Codex-only install has no token at all. A prompt routine's access to `RemoteTrigger` is unverified and costs money. A snapshot with a visible age is honest and cheap. |
| D4 | **One cache, one row shape.** `brain/_index/routines-hosts.json` = `{ schema: 1, hosts: { codex: { fetchedAt, ok, warning, routines }, claude: { fetchedAt, routines } } }`; a row is `{ id, name, cadence, schedule, enabled, next, last: { at, status } \| null, model, target, link }`. `aos routines hosts [--refresh] [--json]` prints it (`--refresh` re-reads Codex; Claude changes only through `import-cloud`); `aos routines list` appends a `HOSTS` table from the cache with the snapshot age. The HUD reads only the JSON (`hostRoutines.ts`), renders the rows under "Outside the runtime" with a `claude`/`codex` pill and "as of N ago", offers a `refresh` link that spawns `aos routines hosts --refresh`, and spawns it on mount when the Codex section is older than 10 minutes. | The HUD queries SQLite itself; or the runtime also takes over the launchd/Obsidian Git rows. | One parser in the runtime, one loader in the HUD, is the routines pattern. The existing D13 rows stay where they are; this feature adds two sources, it does not move two others. |
| D5 | MCP `routine_list` gains a `hosts` field (the cache as-is, `null` when absent). | A separate `host_routine_list` tool. | The persona's sitrep and monitor duties should see every schedule through the tool they already call. |
| D6 | **No new config key.** Codex rows appear when `hosts.codex.enabled` is not `false` and the database exists under `hosts.codex.home` (`host.js:codexHome`). The Claude section appears when a snapshot has been imported. | A `routines.hosts` allow-list. | Both hosts are already declared in `hosts.*`; a second switch would drift from the first. |

## 3. What already exists (at `88420c6`)

- `brain/scripts/lib/routines-store.js`: `overview()` (`:232-247`) builds rows from files plus
  `routines.json`; `health()` (`:215-228`) computes `stale`/`failed`/`missed` from the entry.
  `hud/src/data/routines.ts` mirrors both (`buildRows` `:509`, `health` `:495`).
- `brain/scripts/persona/run-duty.sh` appends `[$(date)] duty=<slug> … start` (`:130`) and
  `[$(date)] duty=<slug> done (exit N)` (`:179`) to `$PERSONA_LOG_DIR/duty-<slug>.log`.
- `cli/schedule.js:27` keeps `LEGACY_DUTIES` so uninstall and sync remove the pre-routines plists;
  `cli/aos.js:880-894` re-renders the schedules at upgrade when any are installed.
- `cli/routines.js`: verbs `list|sync|run|enable|disable|next`, `table()`, `ago()`, `fmtLocal()`,
  injectable `io`/`now`; `plugin/commands/routines.md` passes the verb through and explains health.
- `hud/src/data/externalSchedules.ts` (`readExternalSchedules` `:627`) and
  `RoutinesTab.ts:116-126` render the read-only "Outside the runtime" rows; `refresh()` `:75`
  reloads on vault events for `brain/routines/` and `brain/_index/routines.json`.
- `brain/scripts/lib/host.js`: `codexHome(env, userConfig)` (`:32`), `hostDirs('codex')`.
- `brain/scripts/sdk/mcp-server.js:225-238`: `routine_list` returns `store.overview()`.
- Codex schema (verified on the owner's machine): `automations(id, name, prompt, status,
  next_run_at, last_run_at, cwds, rrule, model, reasoning_effort, kind, target_type, …)` and
  `automation_runs(thread_id, automation_id, status, created_at, …)`; epoch milliseconds.
- `RemoteTrigger list` payload (verified): `data[]` with `id`, `name`, `cron_expression`,
  `run_once_at`, `enabled`, `next_run_at`, `last_fired_at`, `ended_reason`, `derived_state.model`,
  `job_config.ccr.session_context.sources[].git_repository.url`.

## 4. Design

### 4.1 `brain/scripts/lib/host-routines.js` (new)

`describeRrule(rrule)` → `"Every day at 09:00"`, `"Mon, Wed at 18:30"`, `"Every 24 h at :00"`,
else the raw string. `readCodex({ home, sqlite3 = 'sqlite3', exec = execFileSync, now })` →
`{ fetchedAt, ok, warning, routines }`: `ok: false` with `warning` when the binary or DB is
absent or the query fails. `normalizeCloud(payload, now)` → `{ fetchedAt, routines }`; throws
`TypeError` on a payload without `data[]`. Cloud `cadence`: `cron.describe(cron_expression)`
with "(UTC)" appended, or `once at <local time>`; `enabled` false plus `ended_reason:
"run_once_fired"` → `last.status = "ran once"`. `readCache(file)` / `writeCache(file, patch)`
merge per host. `refresh({ vault, cfg, … })` re-reads Codex (when D6 allows) and writes the cache.

### 4.2 Duty-log fallback (`routines-store.js`, `routines.ts`)

`dutyLogLast(slug, { logDir })` → `{ at, exit } | null` (mtime + last-line regex, tail read of
4 KiB). `overview()` and `buildRows()` merge it when `at > lastRunAt`; `health()` receives the
merged entry. Log dir: `<vault>/persona/journal/logs`, overridable for tests.

### 4.3 CLI (`cli/routines.js`, `cli/aos.js` usage line, `plugin/bin/aos` untouched)

`hosts [--refresh] [--json]` and `import-cloud <file|->`. `list` prints the existing table, then a
blank line and `HOSTS` rows: `host  name  cadence  on  next  last  as-of`. Under `--json` the
list gains `hosts`. Exit codes: `import-cloud` 2 on an invalid payload.

### 4.4 Plugin command (`plugin/commands/routines.md`)

`cloud` verb: load `RemoteTrigger` with `ToolSearch select:RemoteTrigger`, call `list`, write
the JSON to a temp file, run `aos routines import-cloud <file>`, relay the `HOSTS` rows. When
`RemoteTrigger` is unavailable (Codex, or a headless run) say so and run `aos routines hosts`.
`hosts` passes through. `argument-hint` and the verb table are extended.

### 4.5 HUD (`hud/src/data/hostRoutines.ts`, `RoutinesTab.ts`, `styles.css`)

`readHostRoutines(vaultRoot)` parses the cache (never throws). `RoutinesTab.refresh()` loads it;
the vault watcher also matches `brain/_index/routines-hosts.json`. Rows render after the D13 rows
in the same table: name (tooltip: the prompt's first line for Codex, the repo for Claude), source
pill, cadence, next fire, `last` (`formatAgo` + status), a chip `ran once`/`paused`/`ok`/`unknown`.
A subhead trailer shows `codex as of 2m ago · claude as of 3h ago` and a `refresh` link.
`mount()` spawns `aos routines hosts --refresh` when the Codex `fetchedAt` is older than 10 min.

### 4.6 MCP and docs

`routine_list` adds `hosts`. README "Everyday commands" row and the in-session row grow the
two verbs; `docs/plugin-smoke.md` Routines section gains "host rows and the refresh link";
`vault-template/AGENTICOS.md` `## Routines` mentions `/routines cloud`.

## 5. Testing

- `brain/scripts/test/host-routines.test.js`: `describeRrule` forms; `readCodex` with an
  injected `exec` (rows, empty table, ENOENT binary, failing query); `normalizeCloud` on the
  verified payload shape (cron, once-fired, disabled, missing fields → `TypeError`);
  cache merge keeps the other host.
- `brain/scripts/test/routines-store.test.js`: duty-log fallback newer/older/absent/start-only.
- `cli/routines.test.js`: `hosts` table and `--json`, `import-cloud` from a file and from `-`,
  invalid payload exit 2, `list` shows `HOSTS` only when the cache exists.
- `cli/plugin-commands.test.js` / `cli/plugin-manifests.test.js`: the extended argument hint.
- `hud`: `hostRoutines.test.ts` (parse, absent, corrupt), `routines.test.ts`
  (fallback merge mirrors the runtime).
- Manual: `docs/plugin-smoke.md` items; `aos routines hosts --refresh` on the owner's machine.

## 6. Out of scope

- Acting on a host routine (run, pause, edit, delete): rows are read-only; deleting the two
  cloud orphans stays a hand step at claude.ai/code/routines.
- Refreshing the Claude snapshot without a session (no token handling in the runtime).
- Codex Cloud tasks, Codex `thread_goals`, Linux crontab rows, RRULE forms beyond D2.
- Having the sitrep or monitor duty act on `hosts` (they may read it via `routine_list`).
- A version bump and release; the owner decides after merge.
