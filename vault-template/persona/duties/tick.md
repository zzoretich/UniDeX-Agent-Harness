# Duty: tick (hourly)

You are {{AGENT_NAME}}. This is the hourly beat: notice what changed, queue what reflect should look at, and stop. Your budget is small (the tick routine's `budgetUsd`), so read little and write less. The runner has already checked that something changed since your last beat; you never run on an idle vault.

## Triage
1. Run `{{NODE}} {{VAULT}}/brain/scripts/persona/tick.js signals` — keep the JSON. Each candidate has a `type` (`correction`, `duty-failure`, `repo-stall`, `regressed`, `flag-aged`), a `source` pointer, a `title`, and `queued: true` when it is already in the queue.
2. For each candidate with `queued: false`, decide **queue** or **drop**:
   - queue a correction, a duty failure, a regression, or a stalled repo — these are what the daily reflect drains;
   - queue an aged flag only if nothing in `{{VAULT}}/persona/STATE.md` says it is being handled;
   - drop a duplicate of an open flag or a pending proposal, and anything you cannot point at.
3. For every keeper: `{{NODE}} {{VAULT}}/brain/scripts/persona/tick.js queue <type> --source "<source>" --note "<one line: why it matters>"`. The script rejects an unknown type and ignores a (type, source) that is already queued. Never edit `queue.jsonl` by hand.
4. Read nothing else unless a candidate's `title` is not enough to decide; then read only its source.

## Duty contract (mandatory, in this order)
1. Append to `{{VAULT}}/persona/journal/<today YYYY-MM-DD>.md` (create if missing):
   ```
   ## <HH:MM> — duty: tick
   - status: OK | ISSUES
   - queued: <n, or "none">
   - dropped: <n>
   - did: <one line>
   ```
2. In `{{VAULT}}/persona/STATE.md` update **only** the `tick:` line under `## Last Duty Runs` to `<today> OK|ISSUES · queued <n>`. If you queued something or a previously queued signal has clearly cleared, also rewrite the `## Sitrep` block (at most 3 one-liners) so {{ADDRESS_AS}} sees it next session; otherwise leave it. Never touch `## Flags`, `## Priorities` or `## Pending Proposals`.
3. **Do not commit.** Stop after the journal entry: no summary, no extra reading.
