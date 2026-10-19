# Persona heartbeat and self-improvement loop — plan

Date: 2026-09-22 · Spec for slice 1: `docs/design/specs/2026-09-22-persona-heartbeat-design.md`

## Goal

Make the Chief of Staff agent observable (a heartbeat that notices when its own schedule breaks) and
give its self-improvement loop a memory (a ledger of what it proposed, what was approved, and whether
it helped), so that proposals get better over time instead of restarting from zero every Sunday.

## Interview decisions (2026-09-22)

| Topic | Decision |
|---|---|
| Heartbeat | Two layers: a model-free watchdog guarding the schedule, plus an hourly model-run tick. |
| Tick budget | Hourly, about 1 USD per day, hard cap 0.05 USD per tick, skips when nothing changed. (Raised to 0.10 after the first live runs on 2026-09-22 measured 0.055 per working run; skips keep the daily total near 1 USD.) |
| Tick job | Write the beat, triage new signals since the last beat into a queue for reflect, touch the sitrep line only if something moved. |
| Surfaces | `STATE.md` flag with session injection, OS notification, HUD pill. |
| Proposal scope | Own prompts and duties, vault and memory hygiene, the user's workflows and projects, the product itself. |
| Routing | One proposals folder, typed by `kind`. Self and vault kinds get approve or reject; workflow and product kinds get accept-to-backlog or dismiss. |
| Evidence | Outcome ledger, user corrections, duty run health, session telemetry. |
| Autonomy | None until earned: after a class is approved several times unchanged, the agent proposes adding it to the auto-apply list. |
| Success | Recheck stays clean, duty metrics move, corrections on that topic stop. The user is not asked to rate. |
| Reflect | A short daily reflect at night plus the weekly deep one on Sunday. |
| First slice | Watchdog plus outcome ledger. |

## Slices

### Slice 1 — watchdog + ledger (this branch)
- [ ] `cron.prev()` with tests
- [ ] `watchdog.js`: pure `check()`, `run()` writing `brain/_index/persona-heartbeat.json`
- [ ] flag reconcile in `STATE.md` (add on miss, remove on recovery, own lines only)
- [ ] OS notification, deduped, config `persona.watchdog.notify`
- [ ] `heartbeat` command routine in `vault-template` + interview render + `routines sync`
- [ ] `persona-watchdog` verb in `bin/aos`, `SessionStart` hook entry, 30 min throttle
- [ ] `ledger.js`: `append`, `verify`, `summary`; `<vault>/persona/ledger.jsonl`
- [ ] proposal `kind` in `collect.js`, digest column, `README.md` in the template
- [ ] flag-closer `SKILL.md` ledger calls; reflect template `filed` line
- [ ] config defaults, `docs/chief-of-staff.md` `## Heartbeat`, README command rows
- [ ] tests listed in the spec §5; `npm run gate`; `npm test`; first-run rehearsal

### Slice 2 — tick + HUD pill (spec: `docs/design/specs/2026-09-22-persona-tick-design.md`)
- [x] `tick` duty: hourly, `budgetUsd: 0.1` (0.05 in the interview; see the decisions table) and a read-only `tools:` allowlist in the routine file
      (passed to `run-duty.sh` as `PERSONA_MAX_USD` / `PERSONA_TOOLS`), skipped by the runner via
      `tick.js precheck` when the journal, feedback and drafts, STATE.md, proposals, ledger, tracked
      repos and the watchdog's beats are unchanged since the last beat
- [x] `<vault>/persona/queue.jsonl`: events the tick queues for reflect (`correction`, `duty-failure`,
      `repo-stall`, `regressed`, `flag-aged`) with a source pointer; `tick.js signals` finds them,
      `tick.js queue` appends and dedupes
- [x] HUD: `src/data/personaHeartbeat.ts` reading `brain/_index/persona-heartbeat.json`, a pill in
      `SidebarHUD.ts` next to the update pill (green last check under 1 h, amber under 3 h, red otherwise
      or any miss), tooltip listing per-duty status; `docs/plugin-smoke.md` item
- [x] ~~TS mirror of `cron.prev`~~ — slice 1 dropped `prev` (its D3); the beat carries `next` and `due`,
      so the tooltip needs no calendar code (spec D9)
- [x] fill `next_fire` in `heartbeat-writer.js` from the routine schedule (`nextFireFor`)

### Slice 3 — proposal loop (spec: `docs/design/specs/2026-09-22-persona-reflect-daily-design.md`)
- [x] `reflect-daily` duty at 22:00: drains `queue.jsonl` (runner-side, `reflect.js precheck`/`beat` on
      the tick's helper seam — exact snapshot, atomic rewrite), files at most two proposals, writes no
      weekly reflection; Sunday `reflect` keeps the long form and reads `ledger.js summary --days 28`
- [x] reflect inputs: `reflect.js inputs --days N` — `ledger summary`, `routines.json` health,
      `provider-spend.jsonl` per duty, feedback memories and drafts, `agent-runs` per day, the queue
- [x] backlog routing: accepted `workflow` and `product` proposals append to
      `<vault>/persona/backlog.md` through `backlog.js` with the proposal's What and Why; product items
      name the `surface` so a later `/AgenticOS-New-Feature` run can start from them
- [x] flag-closer: verbs per kind (`verbsFor`), `accept` and `dismiss` lanes, ledger events `accepted`
      and `dismissed`
- [x] event-driven early reflect: `tick.js beat` starts `reflect-daily` early (trigger `early`) when the
      queue holds 3 corrections or duty failures weighing 2 (`persona.tick.earlyReflect`), once per day
- [x] `docs/chief-of-staff.md` `## Self-improvement` describing the loop end to end

### Slice 4 — earned autonomy (spec: `docs/design/specs/2026-09-22-persona-earned-autonomy-design.md`)
- [x] the tick calls `recheck.js record` (the runner moved into `brain/scripts/persona/recheck.js`) from its
      precheck, once per local day, so confirmations accrue between reviews
- [x] ledger-derived class stats: `class` on every event, `summary.byClass` over the whole file
      (filed, approved, rejected, auto-applied, verified, regressed, stale-dropped) and `autoapplyCandidates`
- [x] reflect proposes `autoapply-<class>` after `persona.autoapply.minVerified` (3) verified approvals with
      zero regressions and zero rejections (`reflect.js inputs` → `autoapply.candidates`); the user approves
      that proposal like any other
- [x] the flag-closer's auto-apply lane ledgers `auto-applied` with the recipe and class and removes the
      proposal; `ledger.verify` judges it like an approval (test pinned)

## Bootstrap in the vault (user-approved, done by hand, not by this branch)

1. `<vault>/persona/repos.json` naming the product checkout, the vault, and the two workspaces that
   are their own repositories, so the sitrep's repo lane comes alive.
2. One manual `aos routines run reflect` to exercise the proposal path before Sunday.

## File structure (slice 1)

| Path | Change |
|---|---|
| `brain/scripts/lib/cron.js` | add `prev` |
| `brain/scripts/persona/watchdog.js` | new |
| `brain/scripts/persona/ledger.js` | new |
| `brain/scripts/persona/interview.js` | render `heartbeat.md`; reflect template `filed` line |
| `brain/scripts/config.default.json` | `persona.watchdog` |
| `brain/scripts/test/{cron,watchdog,ledger,flag-closer,run-routine}.test.js` | tests |
| `vault-template/brain/routines/heartbeat.md` | new command routine |
| `vault-template/persona/proposals/README.md` | document `kind` (if the template carries it) |
| `plugin/bin/aos` | `persona-watchdog` verb |
| `plugin/hooks/hooks.json` | `SessionStart` entry |
| `plugin/skills/persona-flag-closer/{SKILL.md,scripts/collect.js,scripts/render-digest.js}` | `kind`, ledger calls |
| `docs/chief-of-staff.md`, `README.md` | docs |
| `cli/plugin-manifests.test.js`, `cli/vault-template.test.js` | manifests |
