---
type: team
id: lab
name: Lab
lead: lead
gates: [discuss, ship]
notify: [gate, blocker]
budget: {mode: per-phase, default: 10}
updated: 2026-09-20
members:
  - id: lead
    name: Lead
    role: Team lead
    agent: team-lead
    provider: claude
    model: inherit
    effort: inherit
    stage: [all]
    skills: []
    voice: "Plain: says what moved and what is next."
    paused: false
  - id: builder
    name: Builder
    role: Builds the work
    agent: team-builder
    provider: claude
    model: claude-sonnet-5
    effort: high
    stage: [discuss, plan, execute]
    skills: [one skill, another]
    voice: 'Practical; shows the commit range, and it''s brief.'
    paused: false
  - id: reviewer
    name: Reviewer
    role: Reviews on the other provider
    agent: team-reviewer
    provider: opposite
    model: inherit
    effort: high
    stage: [verify]
    paused: false
---

# Lab team

The fixture team the HUD parser and lib/teams.js both read.
