# AgenticOS — memory conventions for Claude Code and Codex CLI

> Under Claude Code this file is referenced from your CLAUDE.md as `@<vault>/AGENTICOS.md` (the installer prints the exact line); under Codex CLI a SessionStart hook injects it. This vault is plain Markdown: the agent's second brain, shown by the UniDeX app. Paths below are relative to the vault root; `aos <name>` is the launcher installed by `aos init` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" <name>` under Claude Code, `sh <vault>/brain/scripts/bin/aos <name>` anywhere).

## Memory System (3-file rule)

| File / path | Role | Shape |
|---|---|---|
| `MEMORY.md` (vault root) | **Index** — flat pointer list, one line per memory file | no frontmatter |
| `brain/memory/<type>/` | **Canonical content** — `user/`, `feedback/`, `projects/`, `reference/` | frontmatter + body |
| `brain/_index/BRAIN.md` | **Session bootstrap** — auto-injected on the first turn (≤850 tokens), compiled by `aos build-brain-md` | curated pointers |

Working memory: `brain/_index/SESSION.md` (≤400 tokens; reset by `/wrap`). Patterns: `brain/patterns/`. Reflections: `brain/reflections/`. Daily notes: `dailyNote.layout` in `brain/config.json` (default `<year>/<year>-<month>-<Month>/<date>.md`). Dashboard caches: `brain/_index/`.

How it runs (automatic, via the `agenticos` plugin on both hosts, or the same pieces written into an older Codex CLI's config):
- **First prompt** — the `UserPromptSubmit` hook injects `BRAIN.md` + `SESSION.md` as `<brain-context>` (plus a `<persona>` block when `persona/IDENTITY.md` exists and `persona/DISABLED` does not). The `agenticos` MCP server exposes `recall`, `memory_search`, `memory_read`, `memory_list`, `pattern_list`, `session_list`, `session_recall`, `feedback_rules`, `snapshot_read`, `brief_read`, `routine_list`, the graph tools `graph_overview`, `graph_query`, `graph_neighbors`, `graph_path` (structure; `recall` is for content), and the one write tool `wrap_session`.
- **During** — a `Stop` hook writes the last-active marker and, every ~5 turns, a working-memory summary into `BRAIN.md` `## Last Session` (model-written when a provider is available, heuristic otherwise).
- **Session end** — telemetry finalizes under `brain/_index/agent-runs/`; `auto-wrap` extracts memories when a provider is available (queued while the local model is down; with no provider `SESSION.md` shows "not wrapped — run /wrap"); `scan-vault` refreshes the dashboard caches and the recall index.

## Capture vocabulary

Under Codex CLI every `/name` below is the plugin skill `$agenticos:name` (`$name` with the direct wiring) and the MCP tools are `mcp__agenticos__<tool>`.

- `/remember <text>` — add to `SESSION.md`; tag `#promote` to make it permanent at wrap
- `/todo <text>` — add a todo to `TODO.md` (Tasks syntax: `📅` due, `⏫ 🔼 🔽` priority, `#tags`), shown in the To-Do tab
- `/propose <idea>` — file a proposal in `persona/proposals/` in the standard format, with an HTML page and an "Open the proposal in browser" link; the Proposals tab lists it, the `persona-flag-closer` review decides it
- `/feedback` · `/pattern` · `/project` — write a memory of that type
- `/wrap` — promote `#promote` items, extract this session's memories in-session (`wrap_session`), summarize into today's daily note, reset `SESSION.md`
- `/brain` — show current state · `/scan` — refresh the dashboard
- `/notifications [list|read <id>|archive <id>]` — the Workbench Notifications tab; agents post with `aos notify post`
- `/team` — your agent teams (`aos team`), boards and pending gates first; a lead dispatches seats with `aos team dispatch … --detach` and returns with the `wait` line it prints, and only you decide a gate
- `/ask-brain <q>` · `/standup` · `/reflect-week` · `/consolidate-memory` · `/compress <file>` — a script assembles the context, you answer or write it in-session (pass `--local` to let the local provider do it)
- `/cost` — session costing (only after `aos cost enable`)
- `/aos doctor|status|provider|persona|config` — maintenance; `aos config` lists every setting and changes one (`set <key> <value>`, `unset <key>`)
- `/routines [list|sync|run <slug>|enable <slug>|disable <slug>|next]` — the recurring actions (see Routines)
- `/skills [list|sync|exclude <name>|include <name>|reset <name>]` — every skill of both hosts; with both enabled, each host's skills are copied, translated, into the other at session end
- `/agenticos:agents [list|sync|exclude <name>|include <name>|reset <name>]` — the same for agents; use one by asking for it by name (Claude Code also takes `@agent-<name>`)
- `/cross-review` — the other CLI (Claude Code ⇄ Codex) reviews a plan before you build, and inspects what was built · `/handoff` — recommend who should handle a task and run one scoped handoff; both go through `aos cross-review` on the `crossReview.perDayUsd` budget

## Conventions

- New memory → file in `brain/memory/<type>/` → one line in `MEMORY.md` → (only if session-relevant) a pointer in `BRAIN.md`. **Never duplicate** across the three.
- Projects live in `workspaces/<slug>/` (kebab-case), each with a `CLAUDE.md` and an identical `AGENTS.md` (one per host); never create project directories elsewhere. `aos workspace` does what the Spaces tab does: `list` (sessions per host), `new <name>`, `adopt <path> --into <ws>` (an alias; nothing moves), `archive`, `restore`, `rename`, `set` (pin, status); ask the user before a move. `aos workspace which` names the workspace you are in; `/todo`, `/propose`, `/project` link what they write to it.
- `MEMORY.md` bullets are `- [Title](brain/memory/<type>/<slug>.md) — description` under the H2 for that type; the H2 names are fixed.
- `[[wiki-links]]` in notes (daily notes, memory, MOCs); markdown `[text](path)` in agent-facing files (this file, `MEMORY.md`, skills).
- A proposal you write for the user to decide on — a change or an idea, asked for or offered — goes through `/propose`, never into a loose file elsewhere, so every proposal lives in the Proposals tab in one format with its HTML page. A plan for work you are already doing (plan mode, a workspace `PLAN.md`) is not a proposal.
- `brain/_index/` is written only by scripts. In `BRAIN.md` the `## Last Session` block is the one hand-editable part; everything else is compiled from memory frontmatter (`pin: true`, `status/active`). `aos memory` keeps, pins, archives or supersedes a memory; `status/archived` and `status/superseded` leave recall.
- After any correction from the user: capture it with `/feedback` (include **Why** and **How to apply**). Rules surface through the `feedback_rules` tool; auto-drafted rules wait in `brain/memory/feedback/_drafts/` for the `feedback-review` skill.

## Providers

`provider` in `agenticos.json` (`aos provider <mode>`): `local` (a new install's default) runs background work on this Mac's model (Ollama or an OpenAI-compatible server; `aos local` shows and pulls it), never spending unless `local.hostedFallback` is on; while it can't answer, work waits or goes heuristic. Under `local`, `ai.chat|ask|reflectWeek|consolidate` (`local` or `host`) say where Vault chat and those commands run. `auto` picks Ollama when it answers, else `claude` if a host (headless `claude -p`, capped per call and per day, ledgered in `brain/_index/provider-spend.jsonl`), else `codex` when wired (spend estimated from tokens). Under `none`, summaries are heuristic and `/wrap` extracts in-session. `aos status` shows the provider, today's spend and local calls.

## Routines

A recurring action is a file: `brain/routines/<slug>.md` — frontmatter (`schedule:` five-field cron, `kind: duty | prompt | command`, `enabled:`, caps) plus a body (the prompt for `prompt`, a note otherwise). The five Chief of Staff duties (monitor, reflect, reflect-daily, sitrep, tick) are `guarded: true` routines (the persona contract covers them: confirm before changing their schedule or prompt); the hourly tick is a local check that runs its duty only on a real change. `aos routines list|sync|run|enable|disable|next` (also `/routines <verb>`, and the Routines tab, which edits the same files). `sync` renders one launchd plist (macOS) or crontab line (Linux) per enabled routine; run history lives in `brain/_index/routines.json`. A prompt routine's `engine:` picks where it runs: `local` (this Mac's model, free; it writes only its `writes:`), `claude` or `codex`. Without one, and for duties, `claude -p` when Claude Code is wired, else `codex exec` (spend estimated; `persona.runner` / `routines.runner` pin one). Hosted prompt routines are capped by `routines.perRunUsd` and `routines.perDayUsd` (ledgered as `routine:<slug>`); duties keep the persona caps. A duty run that bypassed the runtime is still read from `persona/journal/logs/duty-<slug>.log`. `aos routines hosts [--refresh]` (and the same tab) lists, read-only, the routines each host owns: the Codex app's Automations and the Claude Code cloud routines (imported by `/routines cloud`).
