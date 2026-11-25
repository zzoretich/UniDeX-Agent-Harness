---
description: Every Claude Code and Codex agent in one list, and share each host's own agents with the other — list, sync now, stop or resume sharing one agent, reset an edited copy
allowed-tools: Bash, Read
argument-hint: [list [--all] | sync [--dry-run] | exclude <name> | include <name> | reset <name>]
---

Run `aos agents $ARGUMENTS` in the shell (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" agents $ARGUMENTS`); with no arguments run `aos agents list`. Relay the output; every verb is a passthrough.

How sharing works: each host keeps its own agents, in its own format. Claude Code reads `~/.claude/agents/<name>.md` (frontmatter, and the body is the prompt); Codex reads `~/.codex/agents/<name>.toml` (`name`, `description`, `developer_instructions`). With both hosts enabled, AgenticOS writes a translated copy of each one into the other host's folder at the end of every session, so an agent made in one host is in the other by its next session. The name, the description and the prompt carry over; an agent whose tools cannot write runs read-only on the other host; the model does not carry over (each host uses its own default). Plugin agents and roles declared in Codex's `config.toml` are listed but never copied.

- `list [--all]`: the first line is the summary; relay it, then the table. Columns: the agent (marked read-only when it is), how to reach it in Claude Code (`@agent-<name>`) and in Codex (its name), where it comes from, and its status. `--all` adds plugin agents and `config.toml` roles.
- `sync [--dry-run]`: share now instead of waiting for the session to end. `--dry-run` prints what it would write or remove and changes nothing.
- `exclude <name>` / `include <name>`: stop or resume sharing one agent (kept in `brain/config.json` under `agents.exclude`). Suggest it when Codex carries agents the user never uses there: every Codex agent's description is sent on every Codex turn.
- `reset <name>`: a copy that was edited by hand is never overwritten. This deletes that copy, and the edit with it, so the next sync writes it fresh. Say that plainly and ask before running it.

Statuses worth one line each: `universal` = on both hosts; `pending` = sharing is off or only one host is enabled (the summary says which); `differs` = a different agent of the same name exists on each host and both are left alone; `edited` = a copy was edited by hand (edit the source instead, or `reset`); `excluded` = not shared on purpose; `invalid` = cannot be shared as written (the reason follows the table: a missing name, description or prompt, or a name the other host already uses for a built-in agent such as `explorer` or `general-purpose`); `listed` = a plugin agent or a `config.toml` role.

Using an agent: in Claude Code, ask for it by name, mention `@agent-<name>`, or start a session as it with `claude --agent <name>`. In Codex, ask for it by name ("have reviewer check this diff") and Codex spawns it. The Workbench Agent Workspace tab shows the same list, with buttons that start a Claude Code or Codex session with the agent.
