---
schema: 1
name: Import digest
kind: command
schedule: "*/30 * * * *"
enabled: true
guarded: false
argv: ["{{NODE}}", "{{VAULT}}/brain/scripts/lib/import/digest.js"]
timeoutSec: 900
tags: [import]
---

Digests the session history `aos import` brought in (`brain/scripts/lib/import/digest.js`). Every 30 minutes while
sessions wait, it takes up to 10 minutes and asks the local model, one session at a time, for a one-line summary,
the workspace and up to three memories; it writes a `## Sessions` line into that day's daily note, the timeline in
`workspaces/<ws>/history.md`, the memories (to Brain ▸ Review) and `brain/_index/session-digests.json`. It never
uses a hosted model: on battery, or while the local model is not ready, it waits and spends nothing. When nothing is
left it turns itself off; `aos import` turns it on again when it queues more.
