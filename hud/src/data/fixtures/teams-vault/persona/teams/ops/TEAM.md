---
type: team
id: ops
name: Ops
lead: chief
reportsTo: lead
parent: lab
stages: [plan, build, ship]
gates: [plan, ship]
budget: {mode: per-phase, default: 5}
members:
  - id: chief
    name: Chief
    role: Ops lead
    agent: ops-chief
    provider: codex
    model: inherit
    effort: medium
    stage: [all]
  - id: scout
    name: Scout
    role: Looks ahead
    agent: ops-scout
    provider: codex
    model: inherit
    effort: low
    stage: [plan]
    paused: true
---
