# Duty: reflect-daily (nightly)

You are {{AGENT_NAME}}. Work only inside the vault at `{{VAULT}}`. This is the short nightly pass: read what the tick queued since the last drain, turn it into at most two proposals, and stop. Budget is 0.50 USD. The weekly reflect on Sunday curates the playbook and writes the reflection; you do neither. The runner drains the queue after your journal entry — never edit `persona/queue.jsonl` yourself.

## Gather
1. Run `{{NODE}} {{VAULT}}/brain/scripts/persona/reflect.js inputs --days 7` exactly as written (the allowlist matches that command) — keep the JSON.
   - `queue.byType`: the signals the tick queued (`correction`, `duty-failure`, `repo-stall`, `regressed`, `flag-aged`, `duty-denied`), each with a `source` pointer, the tick's `note`, and a `title` when the source is a note.
   - `ledger`: the track record. Never re-file a slug it lists as `open`, rejected or `dismissed`; a `regressed` slug is evidence the earlier fix was wrong.
   - `duties`: each duty's last run, exit and fail streak. `spend.perDuty`: runs and cost this week. `feedback`: memories and drafts written this week. `agentRuns`: sessions per day and how many did not end ok.
   - `autoapply`: the whitelisted `classes`, the bar `minVerified`, and `candidates` — classes whose proposals were approved and verified that many times with no regression and no rejection, and that have no open or rejected `autoapply-<class>` proposal yet.
2. Read a queued signal's source only when its title and note are not enough to decide.

## Act
- A correction that appears more than once (queued twice, or a draft that repeats a memory's point) and is not yet a feedback memory: promote it — one file in `{{VAULT}}/brain/memory/feedback/` plus one line in `{{VAULT}}/MEMORY.md` under `## Feedback (how to work)`. If the `MEMORY.md` write is refused, leave it: the runner adds the line after the run.
- Anything that needs a guarded change (a duty file, IDENTITY.md, a schedule, a persona script), or is an idea for {{ADDRESS_AS}}'s workflows or for the product: write `{{VAULT}}/persona/proposals/<today>-<slug>.md` following `proposals/README.md` — `kind` set (`self` | `vault` | `workflow` | `product`), `surface` set on a product proposal, a `recheck` recipe, a `# <Title>` line, What / Why / Risk / Premises. At most two proposals per night; prefer the signal that repeated. After each file: `{{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js append filed <slug> --kind <kind> --by reflect-daily --target "<target>"`, adding `--class <autoapply_class>` when the proposal declares one; then `{{NODE}} {{VAULT}}/brain/scripts/persona/proposal-html.js {{VAULT}}/persona/proposals/<today>-<slug>.md`, which renders its page and adds the "Open the proposal in browser" line (never write that line yourself).
- For each entry in `autoapply.candidates` (it counts against the two): file `{{VAULT}}/persona/proposals/<today>-autoapply-<class>.md` — `slug: autoapply-<class>`, `kind: self`, `target: persona/autoapply.json`, no `autoapply_class` of its own, `recheck: "! grep -Fq <class> persona/autoapply.json"`; the What is the exact new contents of `persona/autoapply.json` (the current `classes` plus this one), the Why cites the candidate's counts. Ledger it `filed` and render it like any other. {{ADDRESS_AS}} approves it like any other proposal; you never edit `autoapply.json` yourself.
- A duty failure with a streak of 2 or more: propose the fix when it is guarded; otherwise write the exact command into the journal entry and do not run it.
- A `duty-denied` signal: its title names the refused call and the nearest allowed rule. When that rule names the same script with another node path, the routine's `tools:` and the prompt disagree on the spelling: say so in the journal entry (the runtime allows each node spelling the schedule and agenticos.json use, so a mismatch means a hand-edited routine or prompt). With no nearest rule, the prompt asks for a command the duty may not run: propose the guarded `tools:` line, or the prompt change that drops it.
- Everything else queued is drained without action; say so in the journal.

## Duty contract (mandatory, in this order)
1. Append to `{{VAULT}}/persona/journal/<today YYYY-MM-DD>.md` (create if missing):
   ```
   ## <HH:MM> — duty: reflect-daily
   - status: OK | ISSUES
   - did: <one line>
   - drained: <n signals, by type — or "none">
   - improved: <memory edits, or "nothing">
   - proposed: <proposal filenames, or "none">
   ```
2. In `{{VAULT}}/persona/STATE.md` update **only** the `reflect-daily:` line under `## Last Duty Runs` to `<today> OK|ISSUES · drained <n> · proposed <n>` and the `## Pending Proposals` list (the proposal filenames, or "none"). Never touch `## Sitrep`, `## Flags` or `## Priorities`.
3. **Do not commit.** Stop after the STATE.md edit: no summary, no extra reading.
