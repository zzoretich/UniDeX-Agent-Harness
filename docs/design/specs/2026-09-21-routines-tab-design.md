# Routines tab — design

Date: 2026-09-21 · Branch: `feat/routines-tab` · Verified against `28b5fca`

## 1. Problem

The Workbench already runs recurring work: three Chief of Staff duties, each a Markdown
prompt under `<vault>/persona/duties/`, fired by launchd (macOS) or cron (Linux) through
`persona/run-duty.sh`. But the *schedule* is code, not data:

- `cli/schedule.js:21` hard-codes `DUTIES = ['monitor','reflect','sitrep']`, and
  `:25` hard-codes the same three names into the crontab regex.
- Each duty has its own static plist template in `extras/schedule/launchd/`; cron lines
  live in one `cron.tmpl`. Adding a fourth recurring action means editing three files
  in the runtime and re-vendoring.
- Last-run state is scattered: a prose block in `persona/STATE.md`, log mtimes, and the
  `duty:*` rows of `brain/_index/provider-spend.jsonl`. Nothing computes "next run" or
  notices a missed run.
- The HUD has no surface for any of this. The user cannot see, create, edit, enable, or
  run a recurring action without a terminal and a code change.

The owner also has automation outside the runtime (a disabled cloud routine, the
Obsidian Git hourly backup) and wants one place to see and manage the recurring actions
that belong to the vault.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | A routine is a Markdown file `<vault>/brain/routines/<slug>.md`: YAML frontmatter (`schema: 1`, `name`, `kind`, `schedule`, `enabled`, …) plus a body. `brain/routines/` is a new vault folder beside `patterns/` and `reflections/`. | Store routines in `persona/duties/` or in `brain/config.json`. | `persona/` is guarded self-modification territory (`identity.template.md:24`); a JSON blob has no body for a prompt and is not Obsidian-editable. Files are git-tracked, diffable, and readable by the HUD with the same reader the Memory tab uses. |
| D2 | Three kinds. `duty`: delegates to `persona/run-duty.sh <slug>` unchanged (the persona contract, allow-list, journal and caps stay exactly as they are). `prompt`: the body is sent to headless `claude -p` with no persona system prompt. `command`: `argv` (an array) is spawned directly, cwd = vault, no shell. | One kind that always runs `claude -p`; or free-form shell strings. | The existing duties must keep their contract and budget, so they wrap rather than rewrite. Prompts without a persona are what a migrated cloud routine looks like. An argv array avoids shell injection from a file the HUD writes. |
| D3 | `schedule` is a five-field cron expression (minute hour day-of-month month weekday; `*`, lists, ranges, `*/n`). A new zero-dependency `brain/scripts/lib/cron.js` parses it, computes `next(after)`, and expands it to a launchd `StartCalendarInterval` array (capped at 64 entries; an expression that expands wider is rejected at validation). | A custom `{ days, at }` object; or `StartInterval` seconds. | Cron is what Linux already needs, is compact in frontmatter, and one expression serves both platforms. The cap keeps generated plists small. |
| D4 | `cli/schedule.js` becomes data-driven: it enumerates `brain/routines/*.md`, renders one plist per *enabled* routine from a single generic template (`extras/schedule/launchd/routine.plist.tmpl`), and generates cron lines. Labels stay `com.agenticos.<slug>`; the crontab regex becomes `# com.agenticos.<slug>` matched against the *known slug set*, so foreign lines and `com.agenticos.ollama` are still never touched. The three per-duty templates and `cron.tmpl` are deleted. | Keep the static templates and add a second scheduler for routines. | Two schedulers would drift. The generic template plus a generated calendar array is strictly more general and the launchd identity of the three duties is preserved. |
| D5 | One entrypoint for every scheduled run: `brain/scripts/routines/run-routine.js <slug> [--manual]`. It loads the routine, checks `enabled`, the `persona/DISABLED` kill switch (for `duty` only), and the `routines.perDayUsd` cap (for `prompt` only, ledger prefix `routine:*`), runs the kind, then writes the outcome to `brain/_index/routines.json` and ledgers through `withReport('routine:<slug>')`. | Let launchd call `run-duty.sh` directly as today and have a separate state writer. | A single wrapper is the only way every kind gets the same last-run, exit-code, cost and failure-streak record. Duties still execute through `run-duty.sh`; the wrapper only records. |
| D6 | State lives in `brain/_index/routines.json` (`schema: 1`, one entry per slug: `lastRunAt`, `lastExit`, `lastCostUsd`, `lastDurationMs`, `failStreak`, `lastTrigger`). "Next run" and "missed" are *computed* by the reader from the cron expression and the last run; they are never stored. | Store `nextRunAt`. | A stored next-run goes stale the moment a schedule is edited or a plist is not loaded. Computing it from the source of truth cannot drift. |
| D7 | The HUD gets a `routines` rail tab. Rows show name, kind, human cadence ("Weekdays at 07:45"), next run, a health chip (`ok` / `stale` / `failed` / `missed` / `off`), and last cost. A drawer form creates and edits routines (with a live cadence preview and the next three fire times). Buttons: enable/disable, run now, apply schedules. All logic in `src/data/routines.ts` (tested); `src/views/RoutinesTab.ts` stays thin. | A modal instead of the drawer; or a Dataview-style table in a note. | The drawer is the existing create/edit pattern (Spaces, Memory, Runs). Views have no unit tests, so logic must live in `data/`. |
| D8 | The HUD never installs a schedule itself. "Apply schedules" and "run now" spawn runtime scripts through the existing detached spawner (`main.ts:460` `runBrainScript`); the tab shows a "schedules out of date" banner when any enabled routine's fingerprint (slug + schedule + kind) differs from what the last `sync` recorded in `routines.json`. | Call `launchctl` from the plugin. | The plugin already only reads files and spawns scripts. Keeping installation in the runtime means the CLI and the HUD share one code path and one test suite. |
| D9 | Guarded routines. The three migrated duties carry `guarded: true`. For a guarded routine the drawer asks for confirmation ("this routine is covered by the persona contract") before a schedule or body change, then writes in place. Enable/disable and run-now never prompt. Unguarded routines edit without a prompt. | Write a proposal file under `persona/proposals/` instead; or make duties read-only in the tab. | The owner chose the confirmation. The persona contract is the owner's own rule, and a deliberate confirmed edit from the owner is an approval; the proposal queue stays for changes the persona itself wants to make. |
| D10 | Migration is automatic in `aos upgrade`: when `brain/routines/` has no `duty`-kind file for an installed duty, upgrade writes `brain/routines/{monitor,reflect,sitrep}.md` (`kind: duty`, `guarded: true`, schedule from today's cadences, body = one line pointing at the duty prompt), removes the three old plists, and reinstalls through the generic path. `aos init` seeds the same three files from `vault-template/brain/routines/`. | A separate `aos routines migrate` step. | Upgrade already vendors the scheduler; leaving the old plists behind would fire duties twice. |
| D11 | Three surfaces beside the tab. `aos routines` CLI verb: `list`, `sync`, `run <slug>`, `enable <slug>`, `disable <slug>`, `next [<slug>]`. A read-only MCP tool `routine_list`. A `/routines <verb> [args]` plugin command that passes the verb straight through to the CLI (no args = `list`). The command count becomes 15. | No slash command (keep the 14-command lock); or a list-only command. | The owner wants run and sync reachable from a Claude Code session without leaving it. A 1:1 passthrough means one verb table to document and test. |
| D12 | New config block `routines: { enabled: true, perRunUsd: 2.0, perDayUsd: 6.0 }` gating the `prompt` kind. `duty` keeps using `persona.*`. The hook cap exclusion in `provider.js` widens to `/^duty:|^reason:|^routine:/`. | Reuse `persona.perDayUsd` for everything. | A prompt routine is not the persona and should not eat its budget. The separate-cap pattern is already proven twice. |
| D13 | External schedules appear as read-only rows under a separate "Outside the runtime" heading: the Obsidian Git backup timer (detected from `.obsidian/plugins/obsidian-git/data.json`) and any launchd label the owner lists in `routines.externalLabels` (parsed from `~/Library/LaunchAgents/<label>.plist`, macOS only). They show name, cadence and source, with no actions. The disabled cloud routine is server-side and is deleted by hand (§4.9). | Hide everything the runtime cannot act on; or a hand-written `external` kind. | The owner wants one place to *see* every recurring action, not only the ones the runtime owns. An allowlist keeps vendor updater agents out of the tab. |

## 3. What already exists (at `28b5fca`)

- `cli/schedule.js` (179 lines): `renderTemplate`/`xmlEscape` (`:32-37`), `scheduleVars`
  (`:39-50`), `installSchedules`/`removeSchedules`/`isInstalled` (`:86-177`) with every
  external call injectable. Only `DUTIES`, `CRON_LINE_RE` and the per-duty template
  lookup (`:52-58`) are duty-specific. Tests in `cli/schedule.test.js`.
- `extras/schedule/launchd/com.agenticos.<duty>.plist.tmpl` ×3 and `cron.tmpl`: the
  environment block (`AOS_CONFIG`, `AOS_VAULT`, `AOS_NODE`, `PERSONA_*`, `HOME`, `PATH`)
  is identical across the three; only `Label`, the duty argument and the calendar array differ.
- `brain/scripts/persona/run-duty.sh`: kill switch (`:72`), daily cap via `record-spend.js
  --check` (`:109-128`), the `claude -p` spawn (`:134-137`), watchdog (`:146`), duty
  contract check (`:157-177`). Untouched by this design.
- `brain/scripts/persona/record-spend.js`: `check({spendToday, perDayUsd})` and the
  `duty:*` ledger prefix, the pattern `run-routine.js` reuses for `routine:*`.
- `brain/scripts/lib/pipeline-report.js` `withReport(name, fn)` writes
  `brain/_index/pipelines.json`; `hud/src/data/pipelines.ts:51-72` classifies
  entries as `ok|stale|failed|died|neutral`. The routine health chip reuses the enum.
- `brain/scripts/lib/paths.js:52-69` `PATHS` is the single vault resolver; `ROUTINES`
  and `ROUTINES_STATE` are added there.
- `hud/src/views/WorkbenchView.ts`: `RAIL` (`:14-21`), the tab contract
  (`:29`), `openDrawer` (`:42`), `makeTab` (`:98-106`). `main.ts:88-91` registers one
  `open-workbench-<tab>` command per tab; `main.ts:460-473` `runBrainScript`.
- `hud/src/data/memoryWriter.ts` writes vault files from a drawer form; the
  routine writer follows it. Frontmatter parsing precedent: `src/data/snapshot.ts`.
- `cli/persona-cmd.js:77-85,95-98` installs and re-renders schedules; `cli/aos.js:258,489`
  vendors `cli/schedule.js` + `extras/schedule/`; `:821-842` uninstall path.
- `brain/scripts/sdk/mcp-server.js:41-214`: `registerTool` pattern; `wrap_session` is the
  only write tool. `routine_list` is read-only so needs no headless guard.
- Locked lists that must be updated: `cli/vault-template.test.js:80` (AGENTICOS.md H2s),
  `cli/plugin-commands.test.js:7-13` (the 14 command names), `cli/plugin-manifests.test.js:62-71`
  (bin/aos ↔ cli/aos.js), `README.md:44,276` ("14 commands" → 15).

## 4. Design

### 4.1 Routine file (`brain/routines/<slug>.md`)

```yaml
---
schema: 1
name: Morning sitrep
kind: duty            # duty | prompt | command
schedule: "45 7 * * 1-5"
enabled: true
guarded: true         # duty files only; optional elsewhere
model: haiku          # prompt only (default routines.model → claude.model)
effort: medium        # prompt only
budgetUsd: 2.0        # prompt only (default routines.perRunUsd)
timeoutSec: 1800
argv: ["node", "brain/scripts/scan-vault.js", "--quiet"]   # command only
tags: [persona]
---
Body: the prompt (prompt kind) or a note (duty / command kind).
```

Slug = filename, `^[a-z0-9][a-z0-9-]{1,40}$`. `brain/scripts/lib/routines-store.js`
owns `list()`, `read(slug)`, `write(slug, routine)`, `validate(routine)` (kind-specific
required fields, cron parse, expansion cap, argv is an array of strings) and the
frontmatter parser/serializer (a small hand-written YAML subset: scalars, quoted strings,
flow arrays). The TS mirror `src/data/routines.ts` implements the same parser and
validation so the drawer can validate before it writes; both have fixture-driven tests
sharing the same sample files under `brain/scripts/test/fixtures/routines/`.

### 4.2 Cron (`brain/scripts/lib/cron.js`)

`parse(expr) → { minute:Set, hour:Set, dom:Set, month:Set, dow:Set, raw }`;
`next(expr, after: Date, count = 1) → Date[]` (local time, minute resolution, bounded
search of 366 days); `describe(expr)` for the common shapes ("Every day at 13:00",
"Weekdays at 07:45", "Sundays at 18:00", "Every 15 minutes", else the raw expression);
`toLaunchd(expr) → Array<{Minute, Hour, Day?, Month?, Weekday?}>` as the cross product,
throwing when the product exceeds 64. Mirrored in `src/data/cron.ts` for the preview.

### 4.3 Scheduler (`cli/schedule.js`)

`DUTIES` and `CRON_LINE_RE` go. `listRoutines({ vault })` reads the store;
`renderLaunchd(routine, vars)` fills `routine.plist.tmpl` (`{{LABEL}}`, `{{SLUG}}`,
`{{CALENDAR}}` from `toLaunchd`, the shared environment block); `renderCron(routines,
vars)` emits one line per enabled routine ending in `# com.agenticos.<slug>`.
`stripAgenticosCron(text, slugs)` removes only lines whose tag is in `slugs` (the current
store plus the slugs recorded in `routines.json` from the previous sync, so a deleted
routine's line is still cleaned). `installSchedules` also unloads and deletes plists for
routines that are now disabled or gone, then records `{ synced: { slug: fingerprint } }`
into `routines.json`. `ProgramArguments` becomes
`<node> <vault>/brain/scripts/routines/run-routine.js <slug>`.

### 4.4 Runner (`brain/scripts/routines/run-routine.js`)

```
load routine → disabled? exit 0 (record skipped)
kind duty    → spawn sh persona/run-duty.sh <slug>   (its own caps, journal, contract)
kind prompt  → routines cap check (routine:* rows) → claude -p body --model --effort
               --max-budget-usd --output-format json --no-session-persistence
               --strict-mcp-config --allowedTools <routines.tools>  → record-spend
kind command → spawn argv[0] argv.slice(1), cwd vault, env from the plist
always       → routines.json entry (exit, duration, cost, failStreak, trigger)
               withReport('routine:<slug>') · stdout/stderr → persona/journal/logs/routine-<slug>.log
```

Exit code mirrors the child's. The plist keeps `RunAtLoad false`. `--manual` sets
`lastTrigger: "manual"` so a HUD run is distinguishable from a scheduled one.

### 4.5 CLI (`cli/routines.js`, dispatched from `cli/aos.js`)

`aos routines list` (table: slug, kind, cadence, enabled, next, last, health) ·
`sync` (= `installSchedules`) · `run <slug>` · `enable|disable <slug>` (rewrites
frontmatter, then `sync`) · `next [<slug>]` (next three fire times). `cli/routines.js`
is vendored beside `cli/schedule.js`, so `plugin/bin/aos` gains a `routines` arm
(`cli/routines.js`) and a `run-routine` arm (`routines/run-routine.js`); the HUD spawns
the same two scripts by path. `plugin/commands/routines.md` is the `/routines` command:
it runs `sh ${CLAUDE_PLUGIN_ROOT}/bin/aos routines $ARGUMENTS` and shows the output,
defaulting to `list`. `aos doctor` gains one row: routines with a fingerprint mismatch
or a `failStreak ≥ 1`.

### 4.6 HUD (`hud/src`)

`RAIL` gains `{ id: "routines", icon: "⟳", label: "Routines" }` after `runs`; `main.ts`
registers `open-workbench-routines`. `RoutinesTab` reads the store and `routines.json`,
renders rows and chips, and opens the drawer with the form. Health: `off` when disabled;
`failed` when `lastExit ≠ 0`; `missed` when the previous computed fire time is more than
15 minutes in the past and no run is recorded after it; `stale` when the plist fingerprint
mismatches; else `ok`. Writes go through `src/data/routineWriter.ts` (`vault.create` /
`modify`); for a `guarded: true` file the drawer's save button first opens a confirm
modal naming the persona contract, and the writer refuses to write unless the caller
passes `confirmed: true`. Below the routine rows, an "Outside the runtime" section lists
read-only rows from `src/data/externalSchedules.ts`: the Obsidian Git timer (reads
`autoSaveInterval` / `autoPushInterval` / `autoBackupAfterFileChange` from the plugin's
`data.json`) and each label in `routines.externalLabels`, parsed from its plist
(`StartCalendarInterval` → cron-style description through `cron.ts`; `StartInterval` →
"every N min"; missing or unparsable → "not loaded"). Styles use existing tokens; any new
colour goes in `styles.css`.

### 4.7 MCP (`brain/scripts/sdk/mcp-server.js`)

`routine_list` → `jsonResult({ routines: [{ slug, name, kind, schedule, enabled, next,
last, health }] })`. Listed in the header comment and in `vault-template/AGENTICOS.md`.

### 4.8 Config and vault seed

`config.default.json` gains `routines: { enabled: true, perRunUsd: 2.0, perDayUsd: 6.0,
tools: "Read,Glob,Grep", externalLabels: [] }`. `vault-template/brain/routines/README.md` and the three duty
routine files are seeded; `_gitignore` already covers `brain/_index/`. `AGENTICOS.md`
gains a short `## Routines` section (vocabulary: what a routine file is, `aos routines`).

### 4.9 Machine side (not in the repo)

```sh
aos upgrade --from-local ~/AgenticOS-Workbench && aos doctor
aos routines list                       # three duty rows, next run populated
launchctl list | grep com.agenticos     # still exactly three labels
```
Then delete the disabled cloud routine by hand at claude.ai/code/routines, and reconcile
the stale reference memory about the Obsidian Git backup interval (it documents a
30-minute idle timer; the vault runs a 60-minute wall-clock timer today).

## 5. Testing

- `brain/scripts/test/cron.test.js`: parse (all field forms, invalid inputs), `next`
  around month and year boundaries and DST, `describe` shapes, `toLaunchd` product and cap.
- `brain/scripts/test/routines-store.test.js`: round-trip every fixture, validation
  errors per kind, slug rules, guarded flag survives edits.
- `brain/scripts/test/run-routine.test.js`: each kind with an injected spawn; cap trip on
  `routine:*` rows only; `routines.json` entry shape; failStreak increments and resets;
  disabled → exit 0.
- `cli/schedule.test.js`: rewritten for the data-driven path (generic template, cron
  lines per enabled routine, deleted/disabled routines unloaded, foreign and `ollama`
  lines untouched, fingerprint recorded).
- `cli/routines.test.js`, `cli/aos-dispatch.test.js`, `cli/plugin-manifests.test.js`,
  `cli/plugin-commands.test.js` (`routines` added, count 15), `cli/vault-template.test.js`
  (new H2, seeded routine files), upgrade migration test in `cli/aos.test.js`.
- `hud`: `routines.test.ts`, `cron.test.ts`, `routineWriter.test.ts` (guarded
  write refused without `confirmed`), `externalSchedules.test.ts` (Obsidian Git config
  shapes, plist calendar and interval forms, missing file).
- Manual: new `## Routines` section in `docs/plugin-smoke.md`; `sh cli/rehearsal/first-run.sh`.

## 6. Out of scope

- Migrating the Obsidian Git backup timer or any Obsidian plugin's own scheduling (D13).
- A `hook` kind (event-triggered routines); hooks stay in `plugin/hooks/hooks.json`.
- Cloud routines (`/schedule`) as a kind; the orphan is deleted by hand.
- Acting on external rows (loading, unloading or editing a foreign plist); Linux crontab
  rows under "Outside the runtime".
- Having the `monitor` duty read `routines.json` (a natural follow-up).
- Windows, systemd timers, or per-routine environment overrides.
- A version bump and release; the owner decides after merge.
