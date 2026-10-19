# Persona tick and HUD heartbeat pill — design

Date: 2026-09-22 · Branch: `feat/persona-tick` · Verified against `b683a54` · Slice 2 of
`docs/design/plans/2026-09-22-persona-heartbeat.md`

## 1. Problem

Slice 1 gave the Chief of Staff agent a model-free watchdog: `brain/_index/persona-heartbeat.json`
now says whether every duty fired on schedule. Nothing yet reads that file in the HUD, and nothing
runs between the daily duties. A correction captured at 09:00, a duty that failed at 13:00, a repo
whose planning phase went idle, a proposal that regressed: each waits for Sunday's reflect, or for the
user to notice. The interview asked for an hourly, cheap, mostly silent tick that notices these
signals as they happen and queues them for reflect, and for a pill in the sidebar that shows the
agent is alive without opening a session.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | The tick is a `kind: duty` routine, `tick`, `0 * * * *`, seeded by `writePersona()` from `vault-template/persona/routines/tick.md` exactly like `heartbeat.md`; its prompt is `vault-template/persona/duties/tick.md`, rendered through the `DUTIES` list. | A `command` routine that wraps `run-duty.sh`. | Only duties are watched by the watchdog, ledgered as `duty:<slug>`, capped by `persona.perDayUsd`, and merged from the duty log. |
| D2 | A duty routine's frontmatter may carry `budgetUsd` and `tools`; `run-routine.js` passes them to `run-duty.sh` as `PERSONA_MAX_USD` and `PERSONA_TOOLS` (with `{{NODE}}` and `{{VAULT}}` expanded in `tools`). `tick.md` sets `budgetUsd: 0.1` and a read-only allowlist. | Hardcode the tick's budget and tools in `run-duty.sh`. | The routine file is the user's knob and the HUD's Routines tab already edits it. |
| D3 | The skip is the runner's. `run-duty.sh` gains one seam: a duty helper (`tick.js` for `tick`, named in an explicit case arm) whose `precheck` verb exits 3 when nothing changed, and whose `beat` verb runs after the duty met its contract. A skip appends one duty-log line and no journal entry. | Put the precheck in `run-routine.js`. | A skip there records no `lastRunAt`, so the watchdog would count the idle hours as a miss; and the daily-cap skip precedent lives in `run-duty.sh`. |
| D4 | "Nothing changed" is a signature of newest mtimes: `persona/journal/`, `brain/memory/feedback/` and its `_drafts/`, `persona/STATE.md`, `persona/proposals/`, `persona/ledger.jsonl`, and per tracked repo (`persona/repos.json`) `.git/HEAD`, `.git/index`, `.git/logs/HEAD`, `.planning/STATE.md`; plus the watchdog's beats by `(slug, status, lastRunAt)`, not the file's mtime. The beat recomputes the signature after the run, so the tick's own journal and STATE writes never wake the next tick. | Hash file contents. | Mtimes cost a few stats; the watchdog file is the one input rewritten every 30 minutes without news, so it is compared by content. |
| D5 | `tick.js signals` computes the candidates since the last beat deterministically, each with a source pointer: `correction` (feedback files and drafts), `duty-failure` (beats `failed` or `missed`), `repo-stall` (the sitrep's stall rule: `.planning/STATE.md` idle past `stall_threshold_days`, inlined so the helper does not load `sitrep-state.js` and its vault resolution), `regressed` (ledger events), `flag-aged` (`- [ ] <date>` lines under `## Flags` older than `persona.tick.flagAgeDays`, default 7). The model triages and appends through `tick.js queue`, which validates the type and dedupes on `(type, source)`. | The runner queues every candidate itself. | The model call exists for judgement: drop noise, merge duplicates, write the one-line why. Letting it write JSONL by hand would produce malformed lines. |
| D6 | `<vault>/persona/queue.jsonl` is append-only: `{ schema: 1, ts, type, source, note, by: "tick" }`. Draining belongs to slice 3's daily reflect. | A section in `STATE.md`. | Same reasons as the ledger (D7 in slice 1): the 1,200-character cap and wholesale rewrites by duties. |
| D7 | The tick touches `STATE.md` in two places only: the `tick:` line under `## Last Duty Runs` on every run, and the `## Sitrep` block (at most 3 lines) only when it queued something or a queued signal cleared. Flags, priorities and pending proposals are never edited by the tick. | Rewrite STATE.md wholesale like monitor. | Hourly rewrites by a 0.05 USD model call would erode the flags the watchdog and the user own. |
| D8 | HUD: `hud/src/data/personaHeartbeat.ts` reads `brain/_index/persona-heartbeat.json`; a pure `heartbeatPill(state, nowMs, formatAge)` returns `{ label, tone, title }` or null. Tone: `bad` (rose) on any `missed` or `failed` duty or when the last check is 3 h old or more; `warn` (amber) when the check is 1 h old or more, or a duty is `never`, `stale` or `invalid` (it cannot fire as scheduled yet, but nothing has been missed); `ok` (green) otherwise. The label is `♥ <age>` plus `· N missed` when nonzero; the tooltip lists every watched duty with status, last run and next fire. | Derive freshness from the routine store. | The watchdog already decided who missed; the pill renders its verdict, as the update pill trusts the scanner. |
| D9 | No `cron.prev` mirror. The beat already carries `next` (from `routines-store.overview()`) and `due`, so the tooltip needs no calendar code. | The plan's "TS mirror of `cron.prev`". | Slice 1 dropped `prev` from the runtime (its D3); mirroring a function that does not exist would be the drift the spec warned against. |
| D10 | `heartbeat-writer.js` fills `next_fire` from the routine schedule for an agent whose name matches a routine slug, through a pure `nextFireFor(name, rows)` helper. | Leave it `null`. | Cheap, testable, and closes the plan item. |
| D11 | One config key, `persona.tick.flagAgeDays: 7`, mirrored into `aosConfig.ts`. Budget, cadence and tools live in `tick.md`. | Also `persona.tick.enabled`. | `aos routines disable tick` already exists. |

## 3. What already exists (at `b683a54`)

- `brain/scripts/persona/watchdog.js`: `check()` statuses `ok | missed | failed | never | disabled |
  unwatched | invalid | stale`; each beat has `lastRunAt`, `lastExit`, `due`, `next`; `misses[]`.
- `brain/scripts/persona/run-duty.sh`: the daily-cap skip (`:110-123`) is the precedent for a
  runner-side skip; `PERSONA_MAX_USD` and `PERSONA_TOOLS` are env overrides (`:71-77`); the contract
  check (`:172-193`) is where a post-run hook belongs.
- `brain/scripts/routines/run-routine.js` `plan()` (`:76`): the duty arm passes `deps.env` untouched;
  `expandArgv` (`:70`) expands the two placeholders.
- `brain/scripts/lib/routines-store.js` `validate()` (`:118`): `budgetUsd` is prompt-only today;
  unknown keys survive `serializeFrontmatter`.
- `brain/scripts/persona/interview.js`: `DUTIES` (`:26`), `renderRegenerated`, the `heartbeat.md`
  seed block in `writePersona` (`:158-165`).
- `brain/scripts/persona/sitrep-state.js` exports `detectPlanning`, `collectRepos`, `parseFlags`.
- `brain/scripts/persona/ledger.js` `read()` and the line-per-event JSONL shape to copy.
- `hud/src/data/updateBadge.ts` + `views/SidebarHUD.ts` (`:110-114`): the pill to sit next
  to; `ui/tokens.ts` has `green`; `styles.css` has `aos-pill-{cyan,amber,rose,dim}`.
- `vault-template/persona/STATE.template.md` `## Last Duty Runs` lists the three duties.

## 4. Design

### 4.1 `brain/scripts/persona/tick.js`
CLI and module; state in `brain/_index/persona-tick.json` (`schema: 1`, `lastBeatAt`, `lastSignature`,
`lastPrecheckAt`, `skipped` count, `pending`). Verbs: `precheck` (prints `{ changed, changes[] }`, stores
`pending`, exit 3 when unchanged), `signals` (prints `{ since, candidates[] }`), `queue <type> --source
<ptr> [--note <text>]` (prints the record or `{ duplicate: true }`), `beat` (promotes `pending`,
recomputes the signature, sets `lastBeatAt`), `status`. Every path is injectable; `--root <vault>`.
Exit 0 on every path except `precheck`'s 3 and a usage error's 2; a corrupt state file reads as empty
with one stderr line (the `loadRepos()` pattern).

### 4.2 Runner and routine
`run-duty.sh`: after the cap check, `case "$DUTY" in tick) HELPER="$SCRIPT_DIR/tick.js";; esac`; when
set, `"$NODE" "$HELPER" precheck` exit 3 → log `skipped: unchanged`, exit 0 (no journal entry, no
FAILED); after the contract check passes, `"$NODE" "$HELPER" beat`. `run-routine.js` duty arm: env
gains `PERSONA_MAX_USD` when `budgetUsd` is set and `PERSONA_TOOLS` when `tools` is set.
`routines-store.validate` accepts `budgetUsd` (money) and `tools` (string) on a duty. `tick.md`:
`schedule: "0 * * * *"`, `guarded: true`, `budgetUsd: 0.1` (the interview said 0.05; the first live runs measured about 0.055 for a working haiku run, most of it the cached system prompt across tool turns, so 0.05 cut every run off before its journal entry), `timeoutSec: 600`, `tools:
"Read,Glob,Grep,Write,Edit,Bash(date:*),Bash({{NODE}} {{VAULT}}/brain/scripts/persona/tick.js:*),
Bash({{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js summary:*)"`. Write and Edit are needed for
the journal entry and the two STATE lines; Bash is limited to the two scripts and `date`.

### 4.3 The duty prompt
`duties/tick.md`: run `tick.js signals`; for each candidate decide queue or drop (a duplicate of an
open flag or proposal is a drop); `tick.js queue` for the keepers with a one-line note; read
`queue.jsonl` tail to see what is already queued; update the `tick:` line; rewrite `## Sitrep` only
if something was queued or cleared; append the journal entry (`status`, `did`, `queued: <n or none>`,
`dropped: <n>`); never commit. Hard budget: stop after the journal entry.

### 4.4 HUD
`personaHeartbeat.ts`: `loadPersonaHeartbeat(app)` (adapter read, null on absence or a parse error,
`schema !== 1` treated as absent) and the pure `heartbeatPill`. `SidebarHUD.ts` renders it after the
update pill with `aos-pill-green | aos-pill-amber | aos-pill-rose`, refreshes on `modify` of
`PERSONA_HEARTBEAT_PATH`. `styles.css` gains `.aos-pill-green`. `docs/plugin-smoke.md` gains a Pulse
item: the pill appears after `aos routines run heartbeat`, turns amber after 1 h without a check,
and rose with a `MISSED` flag.

### 4.5 Config, templates, docs
`config.default.json` and `aosConfig.ts`: `persona.tick: { flagAgeDays: 7 }`. `STATE.template.md`:
`- tick: never`. `docs/chief-of-staff.md`: a `tick` row under `## Duties`, a paragraph under
`## Heartbeat` (the tick, the skip, `queue.jsonl`, the HUD pill). `brain/routines/README.md`:
`budgetUsd` and `tools` apply to duties too. README: the vault-template layout line names the tick
routine. Plan file: slice 2 boxes ticked, D9 noted.

## 5. Testing

- `tick.test.js` (temp vault): signature stable across an untouched vault and across the tick's own
  journal write after `beat`; changed on a new draft, a repo `.git/HEAD` touch, a new miss;
  `signals` yields one candidate per type with the expected source, nothing before `lastBeatAt`;
  `queue` validates type, dedupes, appends the line shape; `precheck` exit codes; corrupt state.
- `run-duty.test.js`: a fake `tick.js` exiting 3 → exit 0, log line, no journal, no FAILED flag;
  exiting 0 → duty runs and `beat` is called once; a failing contract does not call `beat`.
- `run-routine.test.js`: duty `budgetUsd`/`tools` reach the env, `{{NODE}}` expanded in tools.
- `routines-store.test.js`: `tools` and `budgetUsd` valid on a duty, `tools` rejected when not a string.
- `persona-interview.test.js`: `duties/tick.md` and `../brain/routines/tick.md` written, kept on re-run.
- `heartbeat-roster.test.js`: `nextFireFor` matches a slug, null otherwise.
- `personaHeartbeat.test.ts`: tones at 59 min, 61 min, 181 min; a miss forces `bad`; label and
  tooltip text; null on absent or wrong schema. `aosConfig.test.ts` mirror stays green.
- `cli/vault-template.test.js`: the tick routine in `persona/routines/` is valid and guarded.

## 6. Out of scope

The daily reflect that drains the queue, backlog routing of workflow and product proposals, the
event-driven early reflect (slice 3). Earned autonomy and `recheck.js --record` from the tick
(slice 4). Draining or expiring `queue.jsonl`. Windows.
