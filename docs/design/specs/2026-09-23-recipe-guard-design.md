# Recipe guard — design

Date: 2026-09-23 · Branch: `feat/recipe-guard` · Verified against `da58be4` · The day-one part of the Workbench 1.0
proposal's Proposal 1 ("put the guardrails out of the agent's reach")

## 1. Problem

A proposal's `recheck` is free text that `ledger.runRecipe()` hands to `/bin/sh -c` (`persona/ledger.js:90`). Three
places run it, and two of them run with nobody watching:

- **The hourly tick** — `tick.js precheck` → `recheck.record()` (`persona/recheck.js`) runs the recipe of *every
  pending proposal* once a day. The nightly reflect writes those proposals after reading queued signals (commit
  messages, corrections, journal text). A crafted commit message in a tracked repo can therefore become a shell
  command on the owner's machine within a day, without any approval.
- **The watchdog** — the heartbeat routine and the `SessionStart` hook (`plugin/bin/aos:85` → `watchdog.js --hook`)
  run `ledger.verify()`, which re-runs the recipe of every approval in `persona/ledger.jsonl`. A duty may run
  `ledger.js append approved …` (its allowlist has `ledger.js:*`), so it can forge an approval carrying any recipe.
- **The review** — the flag-closer runs every pending recipe (step 2) and, on Approve, `sh -c '<recheck>'` itself.

Separately, `memory_read` accepts any path whose resolved form *starts with* the vault path (`sdk/lib/brain.js:91`),
so `~/AgenticOS-Workbench/…` counts as inside `~/AgenticOS`.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | Every recipe passes a read-only grammar before it runs, in the one choke point `ledger.runRecipe()`: simple commands from a fixed read-only set (`true false exit test [ grep egrep fgrep ls wc head tail cat cmp diff cut tr stat git`), `git` only with `-C <dir>` / `--no-pager` and a read-only subcommand (`log diff show status ls-files rev-parse rev-list cat-file merge-base describe`) and none of `-c`, `--output`, `--ext-diff`, `--textconv`, `--exec-path`, `--config-env`, `--upload-pack`, `--receive-pack`; joined only by `|`, `&&`, `\|\|` and a leading `!`; quotes and backslashes as sh reads them; `$HOME` / `${HOME}` the only expansion. No `;`, `&`, redirections, subshells, backticks, comments or newlines. A refused recipe never runs and reads as RECIPE-ERROR. | Only the proposal's stopgap (headless ledger refusal); replace recipes with a structured format now. | The tick path needs no approval at all, so a ledger rule cannot close it. A grammar at the choke point covers all three runners today and keeps every recipe in use valid; the structured format stays Proposal 1's full fix. |
| D2 | `ledger.append()` refuses `approved` and `auto-applied` when `AOS_HEADLESS=1`; the CLI exits 2. | Check the `--by` value; refuse in the CLI only. | `run-duty.sh` starts every duty with `AOS_HEADLESS=1`, so only an interactive session (the review) can record an approval. `--by` is whatever the caller types. |
| D3 | The `SessionStart` hook no longer runs recipes: `watchdog.run({ hook: true })` skips `verify`; the heartbeat routine still verifies once a day. | Keep verifying from the hook. | Opening a session should not execute anything a duty wrote. |
| D4 | `readMemory()` checks containment with `path.relative()` on real paths: a path outside the vault, a sibling that shares its name prefix, or a symlink leading out returns null. | Append a separator to the prefix. | `path.relative` also catches `..` and absolute input, and `realpath` catches a symlink out of the vault. |
| D5 | The flag-closer runs recipes only through the gate: `node "$LEDGER" run-recipe '<recheck>'` prints `present`, `gone`, `error` or `refused: <reason>` (Approve and auto-apply lanes, replacing `sh -c`). `recheck()` items carry `refused` so the digest and the question can say why. The proposals README and `/propose` document the grammar. | A new RECIPE-REFUSED verdict. | Reusing RECIPE-ERROR keeps the HUD, digest and verbs unchanged; the reason travels beside it. |

## 3. What already exists (at `da58be4`)

- `brain/scripts/persona/ledger.js:79` `append()`, `:90` `runRecipe()`, `:114` `verify()`, `:214` `main()`.
- `brain/scripts/persona/recheck.js:43` `runRecipe()` wraps `ledger.runRecipe`; `record()` and `recheck()` use it.
- `brain/scripts/persona/watchdog.js:151` `run({ hook })`; `:167-175` the once-a-day verify.
- `brain/scripts/persona/run-duty.sh:208,212` start the duty child with `AOS_HEADLESS=1`.
- `brain/scripts/sdk/lib/brain.js:89` `readMemory()`.
- Recipes in use: `true`, `false`, `exit N`, `grep -q …`, `test -f …`, `! grep -Fq <class> persona/autoapply.json`,
  `grep -Eq '…' "$HOME/…"`, `git -C "$HOME/…" log … | grep -qvx …` — all inside the grammar.

## 4. Design

- `brain/scripts/persona/recipe.js` (pure): `checkRecipe(cmd)` → `{ ok: true }` or `{ ok: false, reason }`. A small
  lexer (single quotes, double quotes with `\"` `\\` `\$` escapes, backslash, `$HOME`) yields words and the operators
  `|`, `||`, `&&`; anything else unquoted in `;&<>()` or a backtick, `$`, `#` at a word start, or a newline is refused
  with its name. Pipelines split on `&&` / `||`, commands on `|`; `!` only first in a pipeline.
- `ledger.runRecipe(cmd, cwd)`: `checkRecipe` first; refused → `'error'`, nothing spawned. `ledger.js run-recipe
  <cmd> [--root]` prints the verdict (`refused: <reason>` when refused) and exits 0.
- `ledger.append()`: throws `approved/auto-applied need an interactive session (AOS_HEADLESS=1)`.
- `recheck.recheck()`: each item gets `refused: <reason>` when the grammar refuses its recipe.
- `watchdog.run()`: `if (!hook && due)` around the verify block; state keeps the last result.
- `brain.readMemory()`: `realpath` of vault and target (target may not exist → resolve), `path.relative` test.

## 5. Testing

- `test/recipe.test.js`: every recipe in use passes; each refusal names its reason (`;`, `&`, `>`, `<`, `$(…)`,
  backtick, `$USER`, newline, `#`, `rm`, `sh -c`, `A=b grep`, `git -c`, `git push`, `git diff --output=x`,
  `git grep -O`, a `!` mid-pipeline, an empty command, an unclosed quote); quoted metacharacters are fine.
- `test/ledger.test.js`: `runRecipe` never spawns a refused recipe (a marker file stays absent); headless append of
  `approved` / `auto-applied` throws and the CLI exits 2, `filed` still works; `run-recipe` prints each verdict.
- `test/recheck.test.js`: a refused recipe is RECIPE-ERROR with `refused`, and `record()` does not run it.
- `test/watchdog.test.js`: the hook path never calls `verify`; the non-hook path still does once a day.
- `test/interactive.test.js` (or a new file): `readMemory` refuses a sibling-prefix path, `..`, and a symlink out.

## 6. Out of scope (the rest of Proposal 1)

- The structured check format replacing shell recipes; moving `autoapply.json`, the counters and recipe hashes out
  of the vault; moving the runtime out of the vault; narrowing duty writes to `persona/journal`, `persona/proposals`
  and `STATE.md` (a duty's Write tool can still reach files outside the vault); auto-extracted memories as drafts.
