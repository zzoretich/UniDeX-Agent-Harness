# Chief of Staff layer

Installed by default whenever the install has a host (Claude Code, Codex or both; an install with `--host none` gets
it when you add the first one with `aos hosts add`, with the default answers off a terminal, which `aos persona` changes). Your vault gets a named agent — an identity that is injected into every
session on either host, a small state file that bridges sessions, a playbook of your own commands,
skills and agents, five scheduled duties (monitor, reflect, reflect-daily, sitrep, tick) watched by
a heartbeat, and a proposals protocol for changes that need your
sign-off. The machinery ships; the content is generated for you and never leaves your machine.

## The interview

The `aos init` Chief of Staff interview (the **Chief of Staff interview** step in `docs/install.md`), and `aos persona` at any time, ask in order:

1. Agent name (required; the prompt shows "Proton" as an example — pick your own).
2. How the agent addresses you (a name or a title).
3. Voice in one line.
4. What it should watch most (comma-separated → `## Priorities` in STATE.md).
5. Where Claude Code is a host: the Claude Code model for duties (default `claude-opus-5-5`, the Chief of Staff's model; on a 2.0 install the answer becomes `persona.model` unless you set that yourself).
6. On a Codex host only (`hosts.codex.enabled`): the Codex model for duties (default `gpt-6-sol`; stored as `persona.codexModel` in `<vault>/brain/config.json`). With both hosts it is the other host's model, which a duty moves to when Claude Code cannot start it; on a Codex-only machine it is the duties' model and question 5 is not asked.
7. Effort for background duties (`low|medium|high`, default `medium`).
8. Schedule daily duties? (default yes → launchd on macOS, crontab on Linux).

Duties run on that hosted model; the hourly check runs on this Mac's local model and wakes it only when something
changed (see the tick, below). The setup wizard asks the same questions in a form, with each chosen host's model
preselected (Claude Code · `claude-opus-5-5`, Codex · `gpt-6-sol`).

Non-interactive: `aos init --persona-json answers.json` or `aos persona --yes` (reuses the last
answers). The answers file shape is
`{ "name", "addressAs", "voice", "priorities", "dutyModel", "dutyCodexModel", "dutyEffort", "schedule" }`
(`dutyCodexModel` is used only on a Codex host).
Re-running the interview regenerates `IDENTITY.md` and `duties/*.md`; it keeps `STATE.md`,
`PLAYBOOK.md`, `proposals/README.md` and `autoapply.json`.

## Layout: `<vault>/persona/`

| File | Written by | Purpose |
|---|---|---|
| `IDENTITY.md` | interview | persona + directives; guarded |
| `STATE.md` | duties, you | `## Sitrep`, `## Flags` (`- [ ]` items), `## Priorities`, `## Pending Proposals`, `## Last Duty Runs` |
| `PLAYBOOK.md` | `build-playbook.js` once | intent → route table over your `<configDir>/{skills,agents,commands}` |
| `duties/{monitor,reflect,reflect-daily,sitrep,tick}.md` | interview | duty prompts (guarded) |
| `proposals/` | agent | guarded changes awaiting approval (see its README) |
| `queue.jsonl` | `tick.js` (tracked) | signals the tick queued for the nightly reflect, one JSON line each; drained by `reflect.js` after the daily reflect runs |
| `backlog.md` | `backlog.js` (tracked) | accepted `workflow` and `product` proposals, one section each with the What and Why; a product entry names its surface |
| `journal/` | duties | one file per day; `journal/logs/` holds duty logs |
| `answers.json` | interview | the interview answers (for prefilled re-runs and rename) |
| `autoapply.json` | interview, then approved `autoapply-<class>` proposals | `{ "classes": [] }` at install — the auto-apply whitelist; only your approval adds a class |
| `flag-closer/confirmations.json` | `recheck.js record` (the tick, once a day) | per pending proposal, how many consecutive days its recipe still found the finding — the auto-apply gate's second condition |
| `repos.json` | you (optional) | `{ "stall_threshold_days": 4, "repos": [{ "name", "path" }] }` for the sitrep |
| `ledger.jsonl` | `ledger.js` (tracked) | append-only proposal outcomes: `filed`, `approved`, `rejected`, `stale-dropped`, `accepted`, `dismissed`, `auto-applied`, `verified`, `regressed`, each with the proposal's `class` when it has one |
| `DISABLED` | `aos persona off` | kill switch: no injection, no duties |

## Every session

The `UserPromptSubmit` hook injects `<persona>IDENTITY.md --- STATE.md</persona>` before the brain
context, unless the merged `persona.enabled` is `false` or `persona/DISABLED` exists. The config
merge reads `brain/config.json` first and `agenticos.json` last, and `aos init` pins
`"persona": { "enabled": true }` into `agenticos.json` — so on an installed vault the switch lives
there, not in `brain/config.json`. To turn the agent off without editing config, use
`aos persona off`: it only writes `persona/DISABLED` and leaves `persona.enabled` alone. A fresh
`brain/_index/sitrep.md` (under 18 hours old) is injected too.

## Duties

| Duty | When | Does |
|---|---|---|
| monitor | daily 13:00 | duty health, vault drift, unfinished work, pending review counts; prepares one safe fix |
| reflect | Sunday 18:00 | curates the playbook from `scan-arsenal.js`, promotes repeated corrections to feedback memories, files proposals, writes a weekly reflection |
| reflect-daily | daily 22:00 (or early, started by the tick) | the short nightly pass (0.50 USD cap): reads `reflect.js inputs` — the queue, the ledger summary, duty health, spend, this week's feedback and sessions — files at most two proposals, and the runner drains `persona/queue.jsonl`; skipped when the queue is empty and today already drained |
| sitrep | weekdays 07:45 | `sitrep-state.js diff` → one page with ONE recommended action → `brain/_index/sitrep.md` + daily note |
| tick | hourly | local triage first (`tick.js --triage`, no hosted call): an unchanged signature stops there, a real change asks the local model whether it merits a run; the woken duty (0.50 USD cap, read-only) runs `tick.js signals` → queues new corrections, duty failures, stalled repos, regressions and aged flags into `persona/queue.jsonl` for reflect |

Runner: `sh <vault>/brain/scripts/persona/run-duty.sh <duty> [--dry-run]`. It asks
`persona/chief.js` (`lib/headless.js` `resolveChief`) where the duty runs — the host, that host's Chief of Staff model
and the effort; see **Host, model and failover** below — then runs
`claude -p` with the duty prompt (or `codex exec`), appends `IDENTITY.md` + `STATE.md` as system prompt,
`AOS_HEADLESS=1` (your hooks do not fire), a scoped tool allowlist, `--max-budget-usd`
(`PERSONA_MAX_USD`, else `persona.perDutyUsd` from config, default 2.0), and
`--output-format json`. The cost of every run is appended to `brain/_index/provider-spend.jsonl`
as `feature: "duty:<name>"`. A duty is skipped for the rest of the day — journal entry
`- status: SKIPPED daily-cap`, exit 0 — once today's `duty:*` rows add up to `persona.perDayUsd` (default 6.0). It is
one cap over both hosts: every duty row counts whichever host ran it, and a capped day is never moved to the other. Both caps live in `<vault>/brain/config.json` (the `enabled` switch
does not — `agenticos.json` is merged last and `aos init` writes it there; see above):

```json
{ "persona": { "perDutyUsd": 2.0, "perDayUsd": 6.0 } }
```

Raise `perDayUsd` if you schedule more duties or a bigger `perDutyUsd`; with the defaults three
$2 runs fit in one day. The other daily caps are separate and never block a duty: `claude.perDayUsd` (0.5) for the
background hook calls when a host answers them (session summary, wrap), `reasoner.perDayUsd` for Vault chat and the
reasoner commands, `routines.perDayUsd` for prompt routines. Under provider `local` most of that work runs on this
Mac's model and spends nothing ([cost.md](cost.md#what-background-work-spends)). A duty must append a `## HH:MM — duty: <name>` entry to the journal; otherwise the
runner records FAILED and adds a flag to `STATE.md`. A duty that runs past `PERSONA_TIMEOUT`
(default 1800 s) is killed and journaled FAILED too; `claude -p` prints its cost only at the end,
so such a run ledgers $0 and only `--max-budget-usd` (`persona.perDutyUsd`) bounds what it
spent. A duty never runs `git commit`: `STATE.md`
and `journal/` are ignored by the vault's `.gitignore`, and anything else it edits (inside its write
scope, below) stays in the working tree for you to review. Env: `PERSONA_MODEL`, `PERSONA_EFFORT`, `PERSONA_LOG_DIR`,
`PERSONA_TOOLS`, `PERSONA_WRITES`, `PERSONA_MAX_USD`, `PERSONA_TIMEOUT`, `PERSONA_CLAUDE_BIN`, `AOS_NODE`.
`PERSONA_NAME` is set by the schedules (plists and cron lines) so that `aos persona rename` has
something to re-render; the runner takes the name from `IDENTITY.md` and never reads it.

### Host, model and failover

The Chief of Staff runs on a hosted model per host (local-first A4; `sdk/lib/models.js` `CHIEF` is the one place to
bump them): **Claude Code · `claude-opus-5-5`** (`persona.model`) or **Codex · `gpt-6-sol`** (`persona.codexModel`),
at `persona.effort` (`medium` unless set). Before a duty starts, `persona/chief.js` checks today's duty spend on both
hosts together against `persona.perDayUsd` (a capped day is skipped on both — the cap is never a reason to move), then
which host can start it: the CLI is found, and `claude auth status` / `codex login status` say signed in (both free).
`persona.runner` picks the host: `auto` (default) takes the first enabled host that can start it, Claude Code first, so
with both hosts a duty goes to Codex by itself while Claude Code's CLI is missing or signed out; `claude` or `codex`
pins one (`AOS_RUNNER` overrides it for one run). With a pinned host, both hosts enabled and `persona.failover` on (the
default), a duty whose host cannot start it runs on the other host's model instead, and the duty log says why
(`(failover: claude signed out)`); with `persona.failover: false` it waits for its own host. When no
host can start it, the duty is **skipped, not failed**: one journal entry `- status: SKIPPED waiting-for-host` naming
each host and why, one flag a day under `## Flags`, exit 0. `aos doctor`'s `persona runner` row names the host, its
model and effort, and the failover host:

```
ok    persona runner   claude · claude-opus-5-5 (medium) (~/.local/bin/claude); failover: codex · gpt-6-sol
```

An install from before 2.0 keeps `persona.model` / `persona.codexModel` at `null`, which keeps the chain it ran on —
the interview's answer, then `claude.model`; `codex.model`, then your Codex default — until you set them (or accept
the 2.0 update's offer to move the Chief of Staff).

### Model and effort

Every duty schedule carries one model and one effort (`PERSONA_MODEL`, `PERSONA_EFFORT`), resolved when the schedules
are rendered: `persona.model` → the interview's `dutyModel` → `claude.model` → `claude-opus-5-5`, and `persona.effort` →
`dutyEffort` → `medium`. `PERSONA_MODEL` is a Claude model: a duty that runs on Codex takes `persona.codexModel`
whatever the schedule carries. Change them without re-running the interview:

```sh
aos config set persona.model sonnet
aos config set persona.effort high
aos routines sync            # re-renders the schedules with the new values
```

One duty can differ from the rest: `model:` and `effort:` in its routine file (`brain/routines/<duty>.md`) win for
that duty's runs, with no sync needed — for example a smaller model for the woken tick while the weekly reflect runs
on the Chief of Staff's. `model` is a Claude model: under the Codex runner a duty runs on `persona.codexModel` (else
`codex.model`, else your Codex default) and `persona.model` has no effect; `effort` applies on both. A bigger model
costs more per run, so raise that duty's `budgetUsd` with it: a run that reaches its cap stops mid-duty and is
journaled FAILED.

### What a duty may write

A duty is steered by text it did not write (commit subjects, correction quotes, journal lines), so the runner limits
what it can write, on both hosts (`docs/superpowers/specs/2026-09-23-duty-write-scope-design.md`):

- **The write scope**: `persona/journal/`, `persona/STATE.md`, `persona/proposals/`, `persona/PLAYBOOK.md`,
  `brain/reflections/`, `brain/_index/sitrep.md` and today's daily-note folder; for `reflect` and `reflect-daily` also
  `brain/memory/feedback/` and `MEMORY.md`, so they can promote a repeated correction
  (`docs/superpowers/specs/2026-09-28-reflect-memory-writes-design.md`); plus the routine's `writes:` entries.
  An entry that is the vault, sits in or holds a guarded or executable area (`persona/IDENTITY.md`, `duties/`,
  `routines/`, `autoapply.json`, `flag-closer/`, `repos.json`, `ledger.jsonl`, `brain/scripts/`, `brain/routines/`,
  `workspaces/`) or has a dot-segment is refused and logged.
- **Claude Code**: `--permission-mode dontAsk`, so your settings' `defaultMode` never widens a duty; the routine's
  `tools` without write tools, `git log`/`diff`/`show` or unrestricted `Bash`; one absolute `Edit(//…)` rule per
  scope entry; deny rules for the guarded and executable areas and for `git … --output`.
- **Codex**: the duty's workspace is `persona/` (`-C`) with one `--add-dir` per other scope folder, so the sandbox
  refuses `brain/scripts/`, `workspaces/`, `.obsidian/` and the vault's `.git`. A file entry grants its folder
  (Codex roots are folders); a file at the vault root cannot be granted, so after a clean run of a reflect duty the
  guard writes the `MEMORY.md` line of each feedback memory the run added and did not index (on both hosts).
- **Both**: the persona scripts a duty may call refuse a `--root`, `--file` or file argument outside the vault under
  `AOS_HEADLESS=1`. Before the run, `persona/duty-guard.js` copies the persona's trust files (`IDENTITY.md`,
  `duties/`, `autoapply.json`, `flag-closer/`, `repos.json`) to `agenticos-duty-guard/` next to `agenticos.json`;
  after it, any of them the duty added, changed or removed is restored, the duty's version kept in
  `persona/journal/logs/guard-<duty>-<time>/`, `ledger.jsonl` keeps only appended `filed` events, `STATE.md` gets a
  flag and the run ends FAILED. Under Codex those files sit in the duty's workspace, so they are writable during the
  run and restored after it; under Claude Code they are never writable.
- **Routine files** (`brain/routines/`, schedules, `tools:`, a command routine's `argv`) are outside every duty's
  reach on both hosts: denied under Claude Code, outside every Codex root.

Each duty is a routine file, `brain/routines/<duty>.md` (`kind: duty`, `guarded: true`, a five-field
cron `schedule:`). Its schedule is rendered from that file through `extras/schedule/launchd/routine.plist.tmpl`
into `~/Library/LaunchAgents/com.agenticos.<duty>.plist` (macOS) or a crontab line ending in
`# com.agenticos.<duty>` (Linux); every schedule runs `brain/scripts/routines/run-routine.js`, which
hands a duty to `run-duty.sh` unchanged. Change a cadence by editing the file — the HUD's Routines
tab asks for confirmation on a guarded duty — and running `aos routines sync`; `aos routines list`
shows the next fire time and the last result. `aos uninstall` removes every routine schedule (the
pre-routines `com.agenticos.monitor|reflect|sitrep` plists included); the optional
`com.agenticos.ollama` supervisor from `extras/ollama` is left alone. A failed `launchctl load` is reported as a warning and never aborts `aos init` or
`aos persona`. Limits: the plist renderer XML-escapes the values it substitutes, but cron lines
carry them unquoted — on Linux the vault path and the agent name may contain no spaces and no
shell-special characters (`& ; $ ' " %` — `%` is cron's command terminator); launchd escapes them, cron does not. On both platforms
`PERSONA_TOOLS` interpolates the vault path into permission rules, so a vault path with spaces
cannot be used by duties at all. Windows: not supported; run duties by hand.

## Heartbeat

Duties are only as reliable as the scheduler that starts them, and `run-duty.sh` can only record a
FAILED run it was started for. The watchdog, `brain/scripts/persona/watchdog.js`, closes that gap from
outside and never calls a model. It runs two ways: as the `heartbeat` routine
(`brain/routines/heartbeat.md`, `kind: command`, every 30 minutes; `aos persona` seeds the file when it
is missing, and `{{NODE}}` / `{{VAULT}}` in its `argv` are expanded by the routine runner, so the file
is the same on every machine) and from the `SessionStart` hook (`aos persona-watchdog`, throttled to
once per 30 minutes, silent), so a dead launchd still gets noticed the next time you open a session.

Each check takes every enabled duty's last run from `brain/_index/routines.json` (merged with the duty
log, as `aos routines list` does) and projects its schedule forward: a fire time more than
`persona.watchdog.graceMinutes` (default 45, longer than `PERSONA_TIMEOUT`, so a duty still running is
never a miss) in the past with no run since is a MISSED duty; a duty that never ran counts from the
moment `aos routines sync` installed its schedule. On a miss the watchdog writes one
`- [ ] <date> duty '<slug>' MISSED — … (watchdog)` line directly under `## Flags` in `STATE.md` (the
next session sees it in the `<persona>` block), sends one OS notification (`osascript` on macOS,
`notify-send` on Linux; `persona.watchdog.notify: false` turns that off), and records every beat in
`brain/_index/persona-heartbeat.json` (`schema: 1`; per routine `status`:
`ok | missed | failed | never | disabled | unwatched | invalid | stale`, `lastRunAt`, `due`, `next`).
It removes its own MISSED line once the duty runs again and never touches any other flag; a line you
close by hand stays closed until a new miss. Once a day it also runs `ledger.js verify` (see
Proposals). `aos routines run heartbeat` checks now; `aos routines disable heartbeat` turns the schedule
off without deleting the file.

The second layer is the **tick**, `brain/routines/tick.md` (hourly, seeded by `aos persona` next to the heartbeat;
`aos persona --yes` adds it to an existing vault). Since 2.0 it is a `kind: command` routine that runs
`brain/scripts/persona/tick.js --triage` on this Mac (local-first A5), and the Chief of Staff's hosted model runs only
when the triage wakes it:

1. **Rules.** `tick.js` builds a signature of what can make a run worth paying for, never a clock: each routine's
   status (`ok`, `failed`, `missed`, `off`, `invalid` — a failure or a miss is a change, a run time never is, so the
   heartbeat, the briefing and the tick's own runs are not news), each repo in `persona/repos.json` by its HEAD
   (branch and commit, read from the files, no git process) — except the vault's own repo, whose commits are the
   backups: it counts by its memory files instead — the feedback memories and drafts, `persona/proposals/`, the open
   `- [ ]` flags under `## Flags`, and unread inbox alerts (notifications at `breaking` or `alert`). Unchanged since
   the last triage, or back to what the Chief of Staff last saw: the hour ends there, with no model call of any kind
   and no journal line.
2. **Local model.** A real change goes to the local model through `provider.js` — only when the background provider
   is the local engine — as a small JSON decision `{ "wake": true|false, "reason": "…" }`, with the changes and the
   candidates `tick.js signals` would list. When the local model is down (or the background provider is hosted, or
   it answers nonsense), any real change wakes the Chief of Staff. Either way one line goes into today's journal:
   `## 14:00 — tick triage: woke the Chief of Staff — the briefing started failing (local model qwen3.5:9b; changed:
   routine briefing: ok → failed)`.
3. **The duty.** Waking runs `persona/duties/tick.md` through `run-duty.sh` exactly like a scheduled duty, on the
   Chief of Staff's model with its failover, with the routine file's `budgetUsd` (0.50, enforced on Claude Code; Codex
   has no per-run budget flag, so there only `persona.perDayUsd` bounds it — a working run costs about 0.06 USD on Haiku
   and Opus 5.5 bills about four times that) and `tools` (Read, Glob, Grep, `date`, `tick.js` and
   `ledger.js summary` — no git) as `PERSONA_MAX_USD` and `PERSONA_TOOLS`. The duty runs `tick.js signals`, which
   lists the candidates since the last beat with a source pointer each — `correction` (a feedback file or draft),
   `duty-failure` (a failed or missed beat), `repo-stall` (`.planning/STATE.md` idle past `stall_threshold_days`),
   `regressed` (a ledger event) and `flag-aged` (a `- [ ] <date>` flag older than `persona.tick.flagAgeDays`,
   default 7) — and queues the ones worth reflect's time with `tick.js queue <type> --source <pointer> --note <why>`,
   which validates the type and never queues the same (type, source) twice. The queue is `persona/queue.jsonl`, one
   JSON line per signal, drained by the nightly reflect (see Self-improvement). `tick.js beat` records the beat after
   the contract check passes. `--triage` refuses to run inside a duty (`AOS_HEADLESS=1`), so a duty never starts
   another.

The tick touches `STATE.md` in two places only: its `tick:` line under `## Last Duty Runs`, and the `## Sitrep` block
when it queued something — neither is in the signature, so a run never wakes the next one. `tick.js status` prints
its state (`brain/_index/persona-tick.json`: last beat, skips, the last triage and its decision, triages, wakes, local
calls). A vault whose `tick.md` is still the pre-2.0 `kind: duty` file runs the duty every hour as before, and
`run-duty.sh` still skips it through `tick.js precheck` when the same signature is unchanged; the 2.0 update offers
to move it.

In the Workbench the sidebar shows a heartbeat pill next to the update pill, read from
`persona-heartbeat.json`: green while the last check is under an hour old and no duty is missed or
failed, amber under three hours (or while a duty has never run, is stale or invalid), rose otherwise or on
any miss; the tooltip lists each duty with its status, last run and next fire.

## Commands and skills

- `aos persona` — re-run the interview (prefilled). `aos persona rename <name>` re-renders
  IDENTITY.md and the five duty prompts (`duties/*.md`) from the templates with the new name, rewrites the PLAYBOOK's
  H1 and the name on STATE.md's non-heading lines, and re-renders installed schedules; the
  playbook's body is yours, so hand-written annotations that mention the old name survive a rename.
  `aos persona off` / `on` create / remove `persona/DISABLED` — the kill switch only; neither
  touches `persona.enabled`.
- "sitrep" (skill `persona-sitrep`, also reachable as `/agenticos:persona-sitrep`) — present the
  fresh sitrep or rebuild it interactively.
- "review persona flags" (skill `persona-flag-closer`) — batch-review proposals, flags and new
  duty failures with deterministic recheck recipes, one decision pass, one commit per decision.

## Proposals

Guarded files (IDENTITY.md, duties and their routine files — `guarded: true`, which the Routines tab confirms before changing — persona scripts, schedules, anything outside `persona/`)
change only through `persona/proposals/YYYY-MM-DD-<slug>.md` with a `recheck` recipe and a
premise table; approval applies the change exactly as written and re-runs the recipe expecting
the finding to be gone. See `persona/proposals/README.md` in your vault. The Workbench's Proposals tab
shows the pending files, the backlog and the ledger history read-only; its **Review in Claude** button starts
this review in the Code tab (on a Codex-only setup, where Claude Code is not enabled, it reads **Review in Codex** and runs `codex '$agenticos:persona-flag-closer'`).

Every proposal shares one format — frontmatter, a `# ` title, the link line
`**[Open the proposal in browser](file:///…)**`, then What / Why / Risk / Premises — and exists as an HTML page.
`brain/scripts/persona/proposal-html.js` renders each file to `brain/_index/proposals/<date>-<slug>.html`
(gitignored, kept after the decision) and owns the link line. The reflect duties and `/propose` run it right after
filing, every vault scan renders anything missed, and the review renders before it decides. The Proposals tab opens
a pending proposal's page, and a backlog or history entry's page, in the default browser. Proposals you or Claude
write in a session go through `/propose`, so they land in the same tab and the same review.

**Recipes are read-only by grammar.** A duty writes proposals after reading text it did not write, and the tick, the
watchdog and the review run their recipes, so every recipe passes `brain/scripts/persona/recipe.js` before a shell
sees it: read-only programs (`grep`, `test`, `ls`, `wc`, `head`, `tail`, `cat`, `diff`, read-only `git`, …) joined
by `|`, `&&`, `||`, with `$HOME` the only expansion. Anything else is never run and reviews as RECIPE-ERROR with the
reason; `node brain/scripts/persona/ledger.js run-recipe '<recipe>'` checks one. Two more guards: `ledger.js`
refuses `approved` and `auto-applied` under `AOS_HEADLESS=1`, so a duty cannot record an approval, and the
`SessionStart` hook no longer re-runs approved recipes (the heartbeat still verifies once a day).

Every outcome lands in `persona/ledger.jsonl` (tracked, unlike `STATE.md`) through
`brain/scripts/persona/ledger.js`: `filed` by a reflect, `approved` / `rejected` / `stale-dropped` by the
review (an approval keeps the proposal's `recheck` recipe), and `verified` or `regressed` by the
watchdog, which re-runs each approval's recipe daily from day 1 to day 14: exit 0 again means the
finding is back (`regressed`, plus a `STATE.md` flag and a notification); a clean week means
`verified`. A proposal carries an optional `kind: self | vault | workflow | product` (default `self`).
The last two are ideas for you rather than changes the agent applies, so the review offers different
verbs for them: **Accept** appends the proposal's What and Why to `persona/backlog.md` through
`brain/scripts/persona/backlog.js` and ledgers `accepted`; **Dismiss** ledgers `dismissed` with a reason and
deletes the file. A product proposal names its `surface` (`cli | plugin | brain | hud | vault-template |
docs`), so a backlog entry says where a feature run would start. `ledger.js summary [--days N]` prints
counts per event and kind, the approval and accept rates, open proposals, dismissed slugs, unverified
approvals and, over the whole file, the counts per `autoapply_class` (approved, verified, regressed,
rejected); both reflects read it before proposing, so a rejected or dismissed idea is not filed twice and
a regression counts as evidence against the earlier fix. An `auto-applied` change (below) keeps its recipe
like an approval and is verified the same way. Under the hood a duty may run `ledger.js` (it is
on the runner's tool allowlist), and the runner's system prompt opens with today's date and the journal
path, so a duty that runs just after midnight no longer journals into yesterday's file.

## Self-improvement

The pieces above form one loop, and each step is deterministic except the two model runs that judge:

1. **Notice.** Every hour the tick (a local triage, then — only on a change worth it — `tick.js signals` and a hosted run) queues what changed
   into `persona/queue.jsonl`: a correction you made (a feedback memory or draft), a duty that failed or
   was missed, a repo whose planning idled, an approved fix that regressed, a flag left open for a week.
   The same `(type, source)` is never queued twice while it is pending.
2. **Reflect.** At 22:00 `reflect-daily` runs (`brain/routines/reflect-daily.md`, seeded by `aos persona`
   next to the tick). Its helper `brain/scripts/persona/reflect.js` snapshots the queue (`precheck`), the
   duty reads one evidence pack — `reflect.js inputs --days 7`: the queue grouped by type with each source's
   title, `ledger.js summary`, each duty's last run and fail streak from `routines.json`, spend per duty,
   the week's feedback memories and drafts, sessions per day from the agent-runs telemetry — and files at
   most two proposals, promoting a correction that repeated to a feedback memory on the way. After the
   journal entry passes the runner's contract check, `reflect.js beat` removes exactly the snapshotted
   lines, so a signal queued during the run waits for the next drain. When the queue is empty and today
   already drained, `precheck` skips the run (exit 3, one log line, no journal entry). The Sunday reflect
   reads the same pack over 28 days (`reflect.js inputs --days 28`) and keeps the long form: playbook
   curation and the written reflection. Both prompts read `open`, rejected and `dismissed` from the summary
   and never re-file them.
3. **Early reflect.** The tick can bring step 2 forward. After its beat, `tick.js` weighs the queue: at
   least `persona.tick.earlyReflect.corrections` (3) corrections, or duty failures weighing
   `persona.tick.earlyReflect.dutyFailures` (2) — a queued failure of a duty counts as that duty's
   `failStreak`, so one duty failing twice in a row and two duties failing once both qualify — and starts
   `run-routine.js reflect-daily --early` detached, at most once per local day and only while the routine
   file exists and is enabled. `aos routines list` shows the trigger as `early`; the 22:00 run then finds
   an empty queue and skips unless something new arrived. The tick's own model never decides this: it runs
   under a read-only allowlist, and the trigger belongs to the runner.
4. **Review.** "review persona flags" (`persona-flag-closer`) re-runs each recipe and asks once per item.
   A `self` or `vault` proposal is approved (applied exactly as written, recipe re-run expecting the finding
   gone, one commit) or rejected (feedback memory). A `workflow` or `product` proposal is accepted into
   `persona/backlog.md` or dismissed. Every decision is a ledger line.
5. **Verify.** The watchdog re-runs each approval's recipe daily for two weeks and writes `verified` or
   `regressed`; a regression is a flag, a notification, and the next tick's `regressed` signal, so step 2
   sees it. Nothing asks you to rate anything: the evidence is whether the recheck stays clean, whether the
   duty metrics move, and whether the corrections on that topic stop.

6. **Earn.** Autonomy is granted per class of change, and only by you. A proposal may declare an
   `autoapply_class` (say `doc-typo`); every ledger line for it carries that class, so the summary knows,
   per class, how many approvals held (`verified`), how many regressed and how many you rejected. Once a
   class has `persona.autoapply.minVerified` (3) verified approvals and neither a regression nor a
   rejection, `reflect.js inputs` lists it under `autoapply.candidates` and the next reflect files
   `autoapply-<class>`: a `self` proposal whose What is the exact new `persona/autoapply.json`. You approve
   it like any other proposal (the file is gitignored, so that approval commits only the ledger). From then
   on a proposal of that class is applied during the review without a question — but only after the tick
   has confirmed it two days running: every hour `tick.js precheck` runs `recheck.js record`, which re-runs
   each pending proposal's recipe once per local day and keeps the streak in
   `persona/flag-closer/confirmations.json` (a STALE verdict resets it; an interactive review never counts).
   The applied change is ledgered `auto-applied` with its recipe and class, committed on its own, and the
   watchdog verifies it exactly like an approval, so a regression feeds step 5 and the class's record.
   While the ledger is thin the ladder is inert: no class has three verified approvals, `candidates` is
   empty, the whitelist stays `[]`, and the review's auto-apply lane finds nothing eligible.

## Privacy

The product ships templates and scripts only. Your identity, state, playbook, journal and
proposals are generated in your vault; `agenticos.json` records no agent name.
