---
type: team
id: example
name: Example
lead: lead
gates: [discuss, ship]
notify: [gate, blocker, budget, ship]
budget: {mode: per-phase, default: 10}
updated: 2026-09-28
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
    voice: "Plain and brief; says what moved and what is next."
    paused: false
  - id: builder
    name: Builder
    role: Builds the work
    agent: team-builder
    provider: claude
    model: inherit
    effort: high
    stage: [discuss, plan, execute]
    skills: []
    voice: "Practical; shows the commit range."
    paused: false
  - id: reviewer
    name: Reviewer
    role: Reviews the work on the other provider
    agent: team-reviewer
    provider: opposite
    model: inherit
    effort: high
    stage: [verify]
    skills: []
    voice: "Exacting; names each finding and who fixes it."
    paused: false
---

# Example team

A starting point for your own team. Rename it, or copy the folder to `persona/teams/<id>/` and set `id:` to match.

- **Members** point at your own agents by name (`agent:`): a Claude Code agent file or a Codex agent file. Create
  `team-lead`, `team-builder` and `team-reviewer`, or change the names to agents you already have.
- **The lead** runs in your session (or the Agent Workspace tab's terminal) and moves the board with `aos team put`. It
  dispatches the other seats with `aos team dispatch <team> <member> <item> --detach`, then returns; run the `wait`
  line it prints in the background and call the lead again when it exits.
- **`provider: opposite`** runs the reviewer on whichever provider did not build the item, so no model grades its own
  work. It needs both Claude Code and Codex.
- **Gates** (`discuss`, `ship`) are yours to decide: `aos team gate approve|redirect`, or the Approve and Redirect
  buttons in the Agent Workspace tab. A headless run can never record one.
- **Budgets** are per board item (`budget.default` is the allowance before the Discuss gate), capping Claude spend;
  Codex runs are counted as runs.

`board.jsonl`, `channel.jsonl` and `runs.jsonl` appear with the first item, post and run. `aos team --help` lists
every command.
