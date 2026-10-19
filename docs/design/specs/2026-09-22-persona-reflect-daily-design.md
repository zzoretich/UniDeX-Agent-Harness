# Persona daily reflect, backlog routing and early reflect — design

Date: 2026-09-22 · Branch: `feat/persona-reflect-daily` · Verified against `c848a85` · Slice 3 of
`docs/design/plans/2026-09-22-persona-heartbeat.md`

## 1. Problem

Slice 2 gave the agent an hourly tick that queues signals into `<vault>/persona/queue.jsonl` —
corrections, duty failures, stalled repos, regressions, aged flags — and nothing reads them. The queue
already holds four corrections and one duty failure and will keep growing until Sunday's reflect, which
does not know the queue exists. A `workflow` or `product` proposal, once approved, is deleted with no
trace beyond the ledger, so an idea the user wanted to keep has nowhere to live. And the hourly tick
cannot act on what it notices: three corrections in a morning wait until Sunday like everything else.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | `reflect-daily` is a `kind: duty` routine, `0 22 * * *`, seeded from `vault-template/persona/routines/reflect-daily.md` like `tick.md`; its prompt `duties/reflect-daily.md` is rendered through `DUTIES`. Guarded, `budgetUsd: 0.5`, `timeoutSec: 900`, `tools:` Read, Glob, Grep, Write, Edit, `date`, `ls`, `git status/log/diff`, `reflect.js`, `ledger.js`. | Reschedule the weekly reflect to daily. | The interview asked for a short nightly pass plus the Sunday deep one; the weekly keeps the playbook curation and the written reflection, the daily keeps only the queue and proposals. |
| D2 | The drain is the runner's, through a second helper, `brain/scripts/persona/reflect.js`, on the seam slice 2 built: `run-duty.sh` gets a `reflect-daily)` case arm. `precheck` snapshots the queue into `brain/_index/persona-reflect.json` (`pending`) and exits 3 only when the queue is empty **and** a daily reflect already drained today (an early run is that day's reflect). `beat` removes exactly the snapshotted entries (identity `ts`+`type`+`source`) by an atomic rewrite and records `lastDrain`; a signal queued during the model run survives. | The model truncates the file; or a `drained` marker line appended to the queue. | The tick's D5 reasoning: a model editing JSONL by hand produces malformed lines. A marker keeps the file append-only but makes every reader skip drained lines and the file grow forever; the queue's meaning stays "what reflect has not seen", so the runner removes what reflect saw, after the contract check, never before. |
| D3 | One deterministic input pack for both reflects: `reflect.js inputs [--days N]` prints JSON — the pending queue grouped by type with each source's title, `ledger.summary(days)`, duty health from `routines.json` (`lastRunAt`, `lastExit`, `failStreak`, `lastError` per duty), spend per duty over the window from `provider-spend.jsonl` (runs, total, mean, max), feedback memories and drafts modified in the window, and agent-runs per day (sessions, non-ok, cost). The daily prompt uses 7 days; the Sunday prompt gains one gather step, `reflect.js inputs --days 28`. | Keep the weekly prompt's prose instructions ("read the last 7 journals, list feedback files…"). | Discovery by a haiku model is where the budget goes; the pack costs a few reads and makes both reflects see the same evidence. |
| D4 | The daily reflect writes: at most two proposals (ledgered `filed` as the weekly does), the journal entry (`drained`, `proposed`, `improved`), and in `STATE.md` only its `reflect-daily:` line and `## Pending Proposals`. No weekly reflection file, no playbook edits, no wholesale `STATE.md` rewrite. | Same contract as the weekly reflect. | A nightly wholesale rewrite by a 0.50 USD run erodes the flags the watchdog and the user own (the tick's D7 reasoning). |
| D5 | Accepted `workflow` and `product` proposals go to `<vault>/persona/backlog.md` (tracked), appended only through `brain/scripts/persona/backlog.js append <proposal-file>`: a `## <filed> · <kind> · <slug>` section with `target`, `surface`, the proposal's What and Why verbatim, and the accept date. Product proposals carry `surface: cli \| plugin \| brain \| hud \| vault-template \| docs` (the surfaces `/AgenticOS-New-Feature` knows); `collect.js` parses it and lints a product proposal without one. | One file per backlog item; a `## Backlog` section in `STATE.md`. | A folder is a second inbox to review; `STATE.md` has the 1,200-char cap. One Markdown file reads in Obsidian and a feature run can start from a section. |
| D6 | `ledger.js` gains `accepted` and `dismissed` (both terminal); `summary` counts them per kind, adds `acceptRate` for the idea kinds and lists `dismissed` slugs in the window. The flag-closer offers verbs per kind through a pure `verbsFor(kind)` in `collect.js` — self and vault: Approve / Reject / Defer; workflow and product: Accept (to backlog) / Dismiss / Defer — and the digest shows them in a Decision column. Accept runs `backlog.js`, ledgers `accepted`, commits `backlog.md` and the ledger and removes the proposal; Dismiss ledgers `dismissed` with a note and removes the file, no feedback memory. | Reuse Approve / Reject for every kind (today's SKILL.md). | "Apply exactly as written" is meaningless for an idea; the review must say what the verb does. A dismissed idea is not a correction, so it earns a ledger line, not a memory; the reflect prompts read `dismissed` from the summary and do not re-file it. |
| D7 | The early reflect is triggered by `tick.js beat`, after the beat is recorded: the queue is read and `reflect-daily` is started when it holds at least `persona.tick.earlyReflect.corrections` (3) corrections, or duty failures weighing at least `persona.tick.earlyReflect.dutyFailures` (2), where a queued failure of duty `s` weighs `max(1, failStreak of s in routines.json)` — one duty failing twice in a row is a streak, and so are two duties failing once. Guards: at most one early run per local day (`lastEarlyReflectAt` in the tick state), `brain/routines/reflect-daily.md` present and enabled. The start is `node run-routine.js reflect-daily --early`, detached with stdio ignored, so the tick finishes on its own budget and clock; `run-routine.js` `TRIGGERS` gains `early`, so `aos routines list` shows it. | Let the tick's model decide; a wake file polled by the watchdog. | The tick runs under a read-only allowlist and a 0.10 USD cap; the watchdog is the model-free guard and lags 30 minutes. |
| D8 | Config: `persona.tick.earlyReflect: { corrections: 3, dutyFailures: 2 }`, mirrored into `aosConfig.ts`. Cadence, budget and tools live in the routine file. | A `persona.reflectDaily` block. | The thresholds are the tick's knobs; the tick is what reads them. |
| D9 | `run-duty.sh`'s default `PERSONA_TOOLS` gains `reflect.js` (both node spellings), so the Sunday reflect, whose routine file sets no `tools:`, can call `inputs`. | A `tools:` line in `brain/routines/reflect.md`. | That file is seeded once and kept; an upgraded vault would never get the new line. |

## 3. What already exists (at `c848a85`)

- `brain/scripts/persona/run-duty.sh`: the helper case arm (`:172-181`, `tick` only), `beat` after the
  contract check (`:201`), the default allowlist (`:69`).
- `brain/scripts/persona/tick.js`: `readJsonl` (`:82`), `writeAtomic` (`:94`), `beat` (`:169`) and
  `queue` (`:255`), whose dedupe reads the whole file — correct once the drain removes lines.
- `brain/scripts/routines/run-routine.js`: `TRIGGERS` (`:26`), trigger fallback (`:108`); `cli/routines.js`
  `run` (`:152`) passes `--manual`.
- `brain/scripts/persona/ledger.js`: `EVENTS` (`:26`), `TERMINAL` (`:28`), `summary` (`:127`),
  `formatSummary` (`:156`); `KINDS` already has `workflow` and `product`.
- `plugin/skills/persona-flag-closer/scripts/collect.js`: `KINDS` (`:20`), `collectProposals` (`:51`);
  `render-digest.js` Kind column (`:51`); SKILL.md step 5 notes "slice 3 routes it to a backlog".
- `brain/scripts/persona/interview.js`: `DUTIES` (`:26`), routine seeding (`:164`).
- `brain/scripts/sdk/lib/spend-ledger.js` rows `{ ts, feature: "duty:<slug>", usd }`;
  `brain/_index/agent-runs/<day>/sess-*.json` with `summary.{status,end_reason,cost_usd}`.
- `vault-template/persona/duties/reflect.md`: the weekly prompt (gather, improve, propose, contract).

## 4. Design

### 4.1 `brain/scripts/persona/reflect.js`
CLI and module, the tick's shape: `--root <vault>`, injectable deps, state `brain/_index/persona-reflect.json`
(`schema: 1`, `lastDrainAt`, `lastDrain: { count, byType }`, `drains`, `pending`). Verbs: `precheck` (exit 3
per D2, prints `{ run, reason, pending }`), `inputs [--days N]` (D3; `--json` only), `beat` (prints
`{ drained, kept }`), `status`. A corrupt state or queue line is skipped with one stderr line. Exit 0 on every
path except `precheck`'s 3 and a usage error's 2.

### 4.2 `brain/scripts/persona/backlog.js`
`append <proposal-file> [--by user] [--root <vault>]`: parses the frontmatter and the `## What` / `## Why`
sections (the collect.js parser, inlined — the script is vendored without the plugin), refuses a `kind` that
is not `workflow` or `product` (exit 2) and a duplicate slug already in `backlog.md`, appends the section,
prints `{ file, slug, kind, surface }`. Creates the file with a one-line header on first use.

### 4.3 Runner, tick, routine
`run-duty.sh`: `reflect-daily) HELPER="$SCRIPT_DIR/reflect.js" ;;` — nothing else changes, the seam is
generic. `tick.js beat`: after `writeState`, `earlyReflect()` (pure decision `shouldReflectEarly(entries,
routinesState, cfg)` plus the guards and the detached spawn, injectable as `deps.spawnReflect`); the
result is printed with the beat (`{ lastBeatAt, beats, earlyReflect: { started, reason } }`). Routine
file `reflect-daily.md`: `schedule: "0 22 * * *"`, `guarded: true`, `budgetUsd: 0.5`, `timeoutSec: 900`,
`tools:` per D1.

### 4.4 The duty prompts
`duties/reflect-daily.md`: run `reflect.js inputs --days 7`; for each queued signal read only its source
when the title is not enough; promote a repeated correction to a feedback memory if it is not one yet;
file at most two proposals (README shape, `kind`, `surface` for product), ledger each `filed`; journal
entry (`status`, `did`, `drained: <n>`, `improved`, `proposed`); `STATE.md` per D4; never commit, stop
after the journal entry. `duties/reflect.md`: gather step 5 `reflect.js inputs --days 28`; the propose
paragraph names `dismissed` next to rejected and open. `STATE.template.md`: `- reflect-daily: never`.

### 4.5 Flag-closer
`SKILL.md` step 5: the verb sets per kind (D6) with the Accept and Dismiss lanes in step 6; `LEDGER`
gains a sibling `BACKLOG = <vault>/brain/scripts/persona/backlog.js`. `collect.js`: `surface`, the
product lint, `verbsFor`. `render-digest.js`: a Decision column and the surface under the target.

### 4.6 Config, docs
`config.default.json` and `aosConfig.ts`: `persona.tick.earlyReflect`. `docs/chief-of-staff.md`: a
`reflect-daily` row under `## Duties`, `backlog.md` and `queue.jsonl` rows in the layout table, the two new
ledger events under `## Proposals`, and a new `## Self-improvement` section walking the loop: tick →
queue → daily reflect (and the early trigger) → proposals → review verbs per kind → ledger and backlog →
watchdog verify → what the next reflect reads. README: the layout line and the persona paragraph name the
daily reflect. `brain/routines/README.md`: `reflect-daily.md` uses `budgetUsd` and `tools` too. Plan
file: slice 3 boxes ticked.

## 5. Testing

- `reflect.test.js` (temp vault): `precheck` runs on a non-empty queue, on an empty queue with no drain
  today, skips after a same-day drain with an empty queue; `beat` removes only the snapshot, keeps a line
  queued during the run, records `lastDrain.byType`; `inputs` shapes every section from fixtures (spend per
  duty, agent-runs counts, feedback in window, routines health) and tolerates every source missing;
  corrupt queue line; CLI exit codes.
- `backlog.test.js`: appends a workflow and a product section, refuses `self`, refuses a duplicate slug,
  creates the file with the header, keeps the What verbatim.
- `tick.test.js`: `shouldReflectEarly` at 2 and 3 corrections, one duty with `failStreak` 2, two duties
  once each, nothing on a drained queue; `beat` spawns once per day and not when the routine is disabled
  or missing; the spawn argv.
- `run-duty.test.js`: the `reflect-daily` arm — skip on exit 3, `beat` after the contract.
- `run-routine.test.js`: `--early` is recorded as `lastTrigger: early`.
- `ledger.test.js`: `accepted` and `dismissed` validate, count per kind, `acceptRate`, `dismissed` list.
- `flag-closer.test.js`: `surface` parsed, the product lint, `verbsFor`, the Decision column.
- `persona-interview.test.js`, `cli/vault-template.test.js`: `duties/reflect-daily.md` and
  `routines/reflect-daily.md` written and kept; the routine valid, guarded, 0.5 USD, tools include
  `reflect.js` and no git write verbs. `aosConfig.test.ts` mirror stays green.

## 6. Out of scope

Earned autonomy and `recheck.js --record` from the tick (slice 4). Expiring or archiving `backlog.md`
entries. A HUD surface for the queue or the backlog. Windows.
