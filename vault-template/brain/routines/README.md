# Routines

One file per recurring action. Frontmatter holds the schedule (five-field cron, local time), the kind, and whether it is enabled; the body is the prompt for a `prompt` routine and a note for the others.

```yaml
---
schema: 1
name: Morning brief
kind: prompt            # duty | prompt | command
schedule: "30 7 * * 1-5"
enabled: true
engine: claude          # prompt only; local | claude | codex (leave it out: routines.runner decides)
model: haiku            # prompt: a model of its engine (default claude.model) · duty: that duty's Claude model (default persona.model, see below)
effort: low             # prompt, duty; low | medium | high
budgetUsd: 0.5          # prompt: default routines.perRunUsd · duty: PERSONA_MAX_USD for that duty (default persona.perDutyUsd)
tools: "Read,Glob,Grep" # duty only; the PERSONA_TOOLS allowlist for that duty ({{NODE}} and {{VAULT}} expand; a {{NODE}} rule is allowed for each node spelling: the schedule's, agenticos.json's and the running one)
writes: [notes/inbox/]  # duty: vault-relative paths it may write on top of the default scope · prompt on engine local: all it may write
timeoutSec: 600
tags: [brief]
---
The prompt for a prompt routine goes here.
```

- `duty` runs `persona/duties/<slug>.md` through the persona runner (its caps, journal and contract apply); `budgetUsd` and `tools` in the file override the runner's defaults for that duty (the hourly `tick.md` and the nightly `reflect-daily.md` use both), and `model` and `effort` override the model and effort every duty's schedule carries (`persona.model` / `persona.effort`, then the interview's answers); `model` is a Claude model, so under the Codex runner the duty keeps `persona.codexModel`. A duty writes only inside its write scope — the journal, `STATE.md`, proposals, the playbook, reflections, the sitrep and today's daily note, and for the two reflect duties the feedback memories and `MEMORY.md` — plus its `writes:` entries; write tools in `tools` are ignored, this folder's routine files cannot be written at all, and a change to the persona's own files (`IDENTITY.md`, duties, `autoapply.json`) is undone after the run. The same limits hold under Claude Code and Codex (see `docs/chief-of-staff.md` in the AgenticOS repository).
- `prompt` sends the body to a headless agent, capped by `routines.perDayUsd`: `claude -p` with the tools in `routines.tools` when Claude Code is wired and installed, else `codex exec` in a workspace-write sandbox (no tools allowlist there; the spend is estimated from token counts). `routines.runner` in `brain/config.json` pins `claude` or `codex`. A routine with `engine: claude` or `engine: codex` runs on that host only (a host this machine lacks is a failed run, never the other host), with `model` a model of that host.
- `engine: local` runs a `prompt` routine on the model on this Mac, free, through the built-in local agent: it can read, list and search (plain text) the vault's files, write only where `writes:` says (folders ending in `/`, files, or globs such as `notes/**/*.md`; never `persona/`, `brain/memory/`, `brain/_index/`, `MEMORY.md`, `AGENTICOS.md`, a `CLAUDE.md` or `AGENTS.md`, `brain/scripts/`, this folder, `workspaces/` or a dot-folder), and post a notification. `maxTurns:` (default 24) and `timeoutSec` bound it; `output:` sends its final message to `notify` or appends it to a `.md` file (it always goes to the log). When the local model is down or not pulled the run is skipped (`local-down`) and the next fire tries again. Small local models can lose the thread on long, many-step routines: keep the steps few.
- `command` runs `argv: [program, arg, …]` directly (no shell) with the vault as the working directory. `{{NODE}}` in an entry expands to the node running the routine and `{{VAULT}}` to the vault path, so a file like `heartbeat.md` (the persona watchdog) works unchanged on every machine. `briefing.md` is one too: the Chief of Staff's Pulse paragraph, written only when the facts changed and paid from the daily duty cap.

Apply changes with `aos routines sync` (the HUD's Routines tab has an Apply button). `aos routines list` shows the next fire time and the last result; `brain/_index/routines.json` keeps the run state.
