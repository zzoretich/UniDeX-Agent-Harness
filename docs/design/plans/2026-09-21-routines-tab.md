# Routines Tab — implementation plan

Spec: `docs/design/specs/2026-09-21-routines-tab-design.md` · Branch: `feat/routines-tab`

## Global constraints

- Node ≥ 20, CommonJS, zero new runtime dependencies, `node:test` + `node:assert/strict`.
- No network and no real `launchctl`/`crontab`/`claude` in tests; every spawn is injected.
- `persona/run-duty.sh` is not modified. The three duty labels `com.agenticos.<duty>`
  survive migration unchanged (`launchctl list | grep com.agenticos` prints the same three).
- `git grep -nE 'monitor|reflect|sitrep' cli/schedule.js` matches only the `LEGACY_DUTIES` constant (the
  pre-migration labels `aos uninstall` must still remove) when done.
- The plugin command count becomes 15 (`/routines`); `cli/plugin-commands.test.js` and the
  README layout line change together.
- No absolute home paths; `npm run gate` clean; one commit per task; no session trailers.

## File structure

| File | Change |
|---|---|
| `brain/scripts/lib/cron.js` *(new)* | `parse`, `next`, `describe`, `toLaunchd` (spec §4.2). |
| `brain/scripts/lib/routines-store.js` *(new)* | Frontmatter parse/serialize, `list/read/write/validate`, `readState/writeState` for `routines.json`, `fingerprint(routine)`. |
| `brain/scripts/lib/paths.js` *(modify)* | `ROUTINES`, `ROUTINES_STATE`. |
| `brain/scripts/routines/run-routine.js` *(new)* | The single scheduled entrypoint (spec §4.4). |
| `brain/scripts/test/cron.test.js`, `routines-store.test.js`, `run-routine.test.js` *(new)* | Spec §5. |
| `brain/scripts/test/fixtures/routines/*.md` *(new)* | One valid file per kind, one guarded, three invalid. |
| `brain/scripts/config.default.json` *(modify)* | `routines` block incl. `externalLabels`. |
| `hud/src/data/aosConfig.ts` *(modify)* | `routines` block in the config type and defaults. |
| `brain/scripts/sdk/lib/provider.js`, `spend-ledger.js` *(modify)* | Hook-cap exclusion widened to `routine:*`; `routineSpendToday()`. |
| `brain/scripts/sdk/mcp-server.js` *(modify)* | `routine_list` tool; header list. |
| `brain/scripts/test/routine-list-tool.test.js` *(new)* | Tool shape. |
| `extras/schedule/launchd/routine.plist.tmpl` *(new)* | Generic template with `{{LABEL}}`, `{{SLUG}}`, `{{CALENDAR}}`. |
| `extras/schedule/launchd/com.agenticos.{monitor,reflect,sitrep}.plist.tmpl`, `extras/schedule/cron.tmpl` *(delete)* | D4. |
| `cli/schedule.js` *(modify)* | Data-driven (spec §4.3); exports `listRoutines`, `renderLaunchd(routine, vars)`, `renderCron(routines, vars)`, `stripAgenticosCron(text, slugs)`. |
| `cli/schedule.test.js` *(modify)* | Rewritten for the data-driven path. |
| `cli/routines.js` + `cli/routines.test.js` *(new)* | `list/sync/run/enable/disable/next`. |
| `cli/aos.js` *(modify)* | `routines` dispatch + `USAGE` line; upgrade migration (D10); init seeding; `doctor` row; vendor `cli/routines.js`. |
| `cli/aos.test.js` (or the existing upgrade/init test) *(modify)* | Migration writes three files, removes three plists, reinstalls; idempotent on a second run. |
| `cli/aos-dispatch.test.js`, `cli/plugin-manifests.test.js`, `cli/plugin-commands.test.js` *(modify)* | New verb, the two new `bin/aos` arms, `routines` in the 15-name list. |
| `plugin/commands/routines.md` *(new)* | `/routines <verb>` passthrough to `bin/aos routines`; no args = `list`. |
| `cli/persona-cmd.js` *(modify)* | Install/rename paths call the data-driven scheduler. |
| `plugin/bin/aos` *(modify)* | `routines` (→ `cli/routines.js`) and `run-routine` (→ `routines/run-routine.js`) arms. |
| `vault-template/brain/routines/README.md`, `{monitor,reflect,sitrep}.md` *(new)* | Seed files (`kind: duty`, `guarded: true`). |
| `vault-template/AGENTICOS.md` *(modify)* | `## Routines` section; `routine_list` in the tool list. |
| `cli/vault-template.test.js` *(modify)* | New H2 in the deep-equal; seeded routine files parse and validate. |
| `hud/src/data/cron.ts` + `.test.ts` *(new)* | TS mirror of `cron.js` (parse, next, describe). |
| `hud/src/data/routines.ts` + `.test.ts` *(new)* | Reader, validator, health classifier, fingerprint. |
| `hud/src/data/routineWriter.ts` + `.test.ts` *(new)* | In-place write; guarded files require `confirmed: true` (D9). |
| `hud/src/data/externalSchedules.ts` + `.test.ts` *(new)* | Obsidian Git timer + allow-listed launchd plists as read-only rows (D13). |
| `hud/src/ui/ConfirmModal.ts` *(new)* | Small confirm dialog used by the guarded save (unless an equivalent already exists). |
| `hud/src/views/RoutinesTab.ts` *(new)* | Thin view: rows, chips, drawer form, three action buttons, "Outside the runtime" section. |
| `hud/src/views/WorkbenchView.ts`, `src/main.ts` *(modify)* | Rail entry, `makeTab`, `open-workbench-routines`. |
| `hud/styles.css` *(modify)* | `.aos-routines-*` rules; tokens regenerated if a colour is added. |
| `docs/plugin-smoke.md` *(modify)* | `## Routines` section. |
| `docs/chief-of-staff.md`, `docs/install.md`, `README.md` *(modify)* | Duty schedules are routine files; `aos routines`; the HUD feature line (`README.md:44`); layout line (`:275,:279`). |

## Tasks

### Task 1 — Cron and the routine store (runtime, no callers yet)
- [ ] `lib/cron.js` with tests: every field form, `next` across month/year/DST, `describe`, `toLaunchd` cap.
- [ ] `lib/routines-store.js` with fixtures and tests; `paths.js` entries.
- [ ] Commit: `feat(routines): cron parser and routine file store`.

### Task 2 — Runner and config
- [ ] `config.default.json` `routines` block; `provider.js`/`spend-ledger.js` exclusion + `routineSpendToday`.
- [ ] `routines/run-routine.js` with injected spawn; `routines.json` writer; `withReport`.
- [ ] Tests: each kind, cap trip, failStreak, disabled → exit 0, journal log path.
- [ ] Commit: `feat(routines): run-routine entrypoint with state and caps`.

### Task 3 — Data-driven scheduler
- [ ] `routine.plist.tmpl`; delete the four static templates.
- [ ] `cli/schedule.js` rewritten; `cli/schedule.test.js` rewritten (generic template, disabled/deleted cleanup, foreign + `ollama` lines untouched, fingerprint recorded).
- [ ] `cli/persona-cmd.js` call sites.
- [x] `git grep -nE 'monitor|reflect|sitrep' cli/schedule.js` matches only `LEGACY_DUTIES`.
- [ ] Commit: `feat(schedule): render one plist per routine file`.

### Task 4 — CLI verb, migration, seed
- [ ] `cli/routines.js` + tests; `cli/aos.js` dispatch, `USAGE`, `doctor` row, vendoring.
- [ ] `plugin/bin/aos` arms; `plugin/commands/routines.md`; `aos-dispatch`, `plugin-manifests`, `plugin-commands` tests.
- [ ] Upgrade migration (D10) + test (idempotent); init seeding from `vault-template/brain/routines/`.
- [ ] `vault-template` files; `AGENTICOS.md` section; `vault-template.test.js`.
- [ ] Commit: `feat(aos): routines verb, duty migration, vault seed`.

### Task 5 — MCP tool
- [ ] `routine_list` in `mcp-server.js`; header comment; `AGENTICOS.md` tool list; test.
- [ ] Commit: `feat(mcp): routine_list tool`.

### Task 6 — HUD data layer
- [ ] `src/data/cron.ts`, `routines.ts`, `routineWriter.ts`, `externalSchedules.ts` with tests (fixtures shared with the runtime); `aosConfig.ts` block.
- [ ] `npm test -w hud` green (including `check:hex`).
- [ ] Commit: `feat(hud): routines reader, validator and writer`.

### Task 7 — HUD tab
- [ ] `RoutinesTab.ts`; rail entry; `makeTab`; `open-workbench-routines`; styles.
- [ ] Drawer form with live cadence preview and next-three fire times; guarded → confirm modal, then write.
- [ ] "Outside the runtime" rows: Obsidian Git timer and `routines.externalLabels` plists.
- [ ] Run now / apply schedules via `runBrainScript`; "schedules out of date" banner.
- [ ] `npm run build -w hud` green; `docs/plugin-smoke.md` `## Routines` section.
- [ ] Commit: `feat(hud): routines tab`.

### Task 8 — Docs
- [ ] `README.md` (feature line, layout line "15 commands", "Everyday commands" rows for `aos routines` and `/routines`), `docs/install.md`, `docs/chief-of-staff.md`.
- [ ] Commit: `docs: routines tab and aos routines`.

### Task 9 — Verify and publish
- [ ] `npm run gate` · `npm test` · `npm run build -w hud` · `sh cli/rehearsal/first-run.sh`.
- [ ] `publish-check.js` clean; push; PR; CI green; **merge decision**.

### Task 10 — Bring it home (machine side, after merge)
- [ ] `aos upgrade --from-local ~/AgenticOS-Workbench && aos doctor` — migration writes the three routine files and reinstalls the plists.
- [ ] `aos routines list` shows three duty rows with next-run times; `launchctl list | grep com.agenticos` still prints exactly three labels.
- [ ] Open the HUD Routines tab; confirm chips; run `monitor` with "run now" and see a `manual` entry in `routines.json` and a journal line.
- [ ] Add the launchd labels worth watching to `routines.externalLabels` in `agenticos.json` and confirm they appear under "Outside the runtime" with the Obsidian Git row.
- [ ] Delete the disabled cloud routine by hand at claude.ai/code/routines.
- [ ] Reconcile the stale reference memory about the Obsidian Git backup interval (60-minute wall-clock today, memory says 30-minute idle).
- [ ] `/remember routines tab shipped: brain/routines/<slug>.md + aos routines #promote`
