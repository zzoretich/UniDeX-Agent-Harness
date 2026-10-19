---
slug: trim-playbook
filed: 2026-09-18
target: persona/PLAYBOOK.md
recheck: "grep -q \"old heading\" persona/PLAYBOOK.md"
autoapply_class: playbook-trim
---
## What
Remove the `## Old heading` section from `persona/PLAYBOOK.md`.

## Why
The section names a skill that no longer exists (journal 2026-09-17).

## Risk
None beyond losing a stale line.

## Premises
| Premise | Status | Evidence |
|---|---|---|
| the section exists | VERIFIED | grep, 2026-09-18 |
| nothing links to it | ASSUMED | no wiki-links found by search |
