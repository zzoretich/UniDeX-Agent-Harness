---
schema: 1
name: Tick
kind: command
schedule: "0 * * * *"
enabled: true
guarded: true
budgetUsd: 0.5
tools: "Read,Glob,Grep,Bash(date:*),Bash({{NODE}} {{VAULT}}/brain/scripts/persona/tick.js:*),Bash({{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js summary:*)"
argv: ["{{NODE}}", "{{VAULT}}/brain/scripts/persona/tick.js", "--triage", "--root", "{{VAULT}}"]
timeoutSec: 900
tags: [persona]
---
The hourly check, triaged on this Mac (`brain/scripts/persona/tick.js --triage`). It compares a signature of what can matter — routine failures and misses (never run times), new commits in tracked repos (the vault's own repo by its memory files, not its backup commits), corrections, proposals, open flags and inbox alerts — with the last one it looked at. Nothing changed: it stops there, with no model call at all. A real change goes to the local model, which decides whether it merits a Chief of Staff run and says why in one journal line; when the local model is not running, any real change wakes it. Waking runs `persona/duties/tick.md` on the Chief of Staff's hosted model through the persona runner (`run-duty.sh`), for at most `budgetUsd` (0.50 USD) with the allowlist in `tools` — no git, no shell beyond `tick.js` and `ledger.js summary`; the duty queues new signals into `persona/queue.jsonl` for reflect. Guarded by the persona contract — confirm before changing its schedule. `{{NODE}}` and `{{VAULT}}` are expanded by the routine runner.
