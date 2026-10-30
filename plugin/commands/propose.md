---
description: File a proposal in persona/proposals (the Workbench Proposals tab) in the standard format, with its HTML page and a link to it
allowed-tools: Bash, Read, Write
argument-hint: <what you propose, or "the plan above">
---

File this as a proposal: **$ARGUMENTS**

A proposal is something for the user to decide: a change to make, or an idea to keep. When the text points at a plan or write-up earlier in this conversation ("the plan above", "that proposal"), file that one and keep its substance.

Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json` (also visible in the injected `<brain-context>`). Proposals live in `<vault>/persona/proposals/`; its `README.md`, when present, is the format's reference. If `node` is not on PATH, use the `node` path recorded in `agenticos.json`.

1. **Classify.**
   - `kind`: `vault` for a change inside the vault that the review would apply; `self` for a change to the Chief of Staff's own files (IDENTITY.md, duties, persona scripts, schedules); `workflow` for an idea about how the user works, including a plan for another project; `product` for an idea for UniDeX itself.
   - `surface`, on a `product` proposal only: `cli` | `plugin` | `brain` | `hud` | `vault-template` | `docs`, where most of the change lands.
   - `slug`: kebab-case, `[a-z0-9-]`, 2–61 characters, not used by a file in `persona/proposals/` or a section of `persona/backlog.md`.
   - `workspace`: run `aos workspace which --json` in the shell from the folder this session runs in, without changing directory first (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" workspace which --json`). It prints `{"name": "<name>", "slug": "<slug>", "via": "<how it matched>"}` when the folder belongs to a workspace (the workspace itself, a worktree of it, or a code folder linked to it), or `{"name": null}` when it does not. Only when `name` is set, the proposal records it as `workspace: <name>`, which links it to that workspace in the Workbench Spaces tab. When `name` is null, or the command fails or prints anything else, the proposal has no `workspace:` line.
2. **Recheck.** One read-only `/bin/sh` command, under 15 seconds, no network, that exits 0 while the situation behind the proposal still holds and nonzero once it is resolved (a file still lacks a line, a version is still below a number). For an idea with nothing to check, use `true`. It must pass the read-only grammar in the proposals README — `grep`, `test`, `ls`, `wc`, `head`, `tail`, `cat`, `diff` and read-only `git` joined by `|`, `&&`, `||`, a leading `!`, `$HOME` the only expansion; no `;`, redirections or `$(…)` — or it never runs; check it with `node <vault>/brain/scripts/persona/ledger.js run-recipe '<recipe>'` (it prints `refused: <reason>` when it does not pass).
3. **Exact changes for instruction proposals.** If a `self` or `vault` proposal changes an agent instruction, active feedback rule, team `TEAM.md`, or user-owned skill, include a `changes: |` frontmatter field. Its value is a JSON array (1–20 entries), indented by two spaces. Each entry names a protected `path`: a vault-relative path, or `host/claude-skills/<skill>/SKILL.md`, `host/codex-skills/<skill>/SKILL.md`, `host/claude-agents/<name>.md`, or `host/codex-agents/<name>.toml` for user-owned host instructions and an `op`: `create` with `base: null` and `content`; `replace` or `delete` with the current file's `base` SHA-256 (`sha256:<64 hex>`), and `content` for replace; or `patch` with `base`, exact unique `old` text and exact `new` text. Read each current file and calculate its hash before filing. The Workbench shows the exact before and after text, refuses stale hashes, and requires the user's click to apply. If you cannot specify exact bytes, file the prose proposal but say it needs an exact diff before approval. Do not apply the change yourself.
4. **Write** `<vault>/persona/proposals/<today>-<slug>.md` (local date; create the folder when missing) in this shape:

```markdown
---
slug: <slug>
filed: <today>
kind: <kind>
surface: <surface — product proposals only; leave the line out otherwise>
workspace: <name — only when step 1's `which` printed one; leave the line out otherwise>
target: <one line — what the change touches, or what the idea is about>
recheck: "<the recipe, with any inner double quote written as \">"
changes: |
  <JSON array of exact operations for instruction proposals; omit for ideas>
---

# <Title — one line the user recognises>

## What
<the exact change (a diff or the full replacement text), or for an idea what would be built or done. Several items: a numbered list, each led by its priority (🔺 ⏫ 🔼 🔽) when they differ, with timing in brackets.>

## Why
<the evidence: what prompted it, with sources>

## Risk
<what could go wrong, and what undoing it costs>

## Premises
| Premise | Status | Evidence |
|---|---|---|
| <a claim the proposal depends on> | VERIFIED | <how you checked it in this session, with path and date> |
| <a claim taken on trust> | ASSUMED | <why it is believed> |
```

   Mark a premise VERIFIED only when you checked it in this session. Do not write the "Open the proposal in browser" line: the renderer owns it.
5. **Ledger and render**, in the vault:
   - `node <vault>/brain/scripts/persona/ledger.js append filed <slug> --kind <kind> --by user --target "<target>"`
   - `node <vault>/brain/scripts/persona/proposal-html.js <vault>/persona/proposals/<today>-<slug>.md` — writes the page to `<vault>/brain/_index/proposals/<today>-<slug>.html` and the link line under the title.
   If either script is missing (a vault not yet upgraded), say so and leave the file in place: the next `aos upgrade` and scan render it.
6. **Reply** in two lines: the title as the page link, copied from the file's `**[Open the proposal in browser](file://…)**` line, then "Decide instruction changes in the Workbench Proposals tab; use `review persona flags` for ideas and flags." Commit nothing — proposals stay uncommitted until the review decides them.
