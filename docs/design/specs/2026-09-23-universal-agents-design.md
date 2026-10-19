# Universal agents — design

Date: 2026-09-23 · Branch: `feat/universal-agents` · Verified against `b6c3fa8` (v0.14.0), Claude Code 2.1.281, codex-cli 0.156.1

## 1. Problem

Both hosts run custom subagents, in different formats and folders. Claude Code reads
`<claude config dir>/agents/<name>.md`: YAML frontmatter (`name`, `description`, optional `tools`, `model`, `color`, …),
and the body is the system prompt. It spawns them through its Agent tool, a `@agent-<name>` mention, or runs a whole
session as one with `claude --agent <name>`. Codex (`features.multi_agent`, stable and on) reads
`<codex home>/agents/<name>.toml`: a TOML table with required `name`, `description` and `developer_instructions`, plus
optional config keys (`model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `nickname_candidates`). A custom
role whose name matches a built-in (`default`, `worker`, `explorer`) replaces it. Codex spawns a role when the prompt
names it; it has no `--agent` flag. (Verified in both binaries: `agent-roles/src/loader.rs` and its "must define
`developer_instructions`" errors; `--agent` and `@agent-` in Claude Code.)

On the owner's machine that is 33 agents on the Claude side and none on the Codex side. No agent is shared, and no
screen lists them. The owner wants an Agents tab, and every agent usable in both Claude Code and Codex, the way skills
are since #38.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **Translated mirror, one file, marker inside.** A user agent native to one host gets a generated file in the other host's user folder (`.md` ↔ `.toml`). Ownership travels *inside* that file as a comment line `# aos-mirror: {schema, id, from, source, sourceHash, writtenHash}` (YAML comment in the frontmatter, TOML comment at the top). `writtenHash` is the hash of the file without that line. | A `.aos-mirror.json` sidecar per agent; one manifest per folder; symlinks. | An agent is one file, so there is no folder to hold a sidecar, and 33 dotfiles beside the agents would be clutter. A manifest per folder is written by two hosts' SessionEnd hooks at once. A symlink cannot turn Markdown into TOML. Both hosts accept the comment (the GSD agents already carry YAML comments). |
| D2 | **Scope: each host's user agents** (`<claude config dir>/agents/*.md`, `<codex home>/agents/*.toml`, top level). Claude Code plugin agents and Codex roles declared in `config.toml` `[agents.<name>]` are **listed**, never mirrored. | Mirror plugin and `config.toml` roles too. | A plugin agent leans on its plugin (MCP server, hooks, `${CLAUDE_PLUGIN_ROOT}`). A `config.toml` role keeps its description in `config.toml` and its instructions in a separate `config_file`; the user can move it to `agents/<name>.toml` to share it (the note says so). Listing them keeps us out of Codex's "duplicate agent role name" error. |
| D3 | **Statuses as for skills:** `universal` · `differs` · `edited` (the file no longer hashes to `writtenHash`; kept until `aos agents reset`) · `excluded` · `invalid` · `listed` · `pending` · `error`. **A file without our marker is never written or removed.** A **reserved name** is `invalid`: a Claude agent named `default`/`worker`/`explorer` would replace a Codex built-in, and a Codex agent named `general-purpose`/`explore`/`plan`/`statusline-setup`/`claude-code-guide` would shadow a Claude Code one. | Last writer wins; mirror reserved names anyway. | The owner edits agents by hand in both folders. Silently replacing a host's built-in agent changes how that host delegates everything. |
| D4 | **One translator, `lib/agent-translate.js`**, plus a zero-dependency TOML subset (read: top-level strings of all four kinds, arrays of strings, booleans, numbers, and skipped tables; write: basic and multi-line basic strings). **Claude → Codex:** `name`, `description` (clipped to 1024), `developer_instructions` = a host note + the body through the skills wording transforms (`AskUserQuestion`, "with the Read tool", "this Claude Code session"). A `tools` list with no writing tool (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`) → `sandbox_mode = "read-only"`. **Codex → Claude:** `name` (`_` → `-`), `description`, the body from `developer_instructions`; `sandbox_mode = "read-only"` → `tools: Read, Grep, Glob, WebFetch, WebSearch`. **Not carried either way:** `model`, effort, `color`, MCP servers, hooks, `nickname_candidates`. A comment in the mirror names what was left out, and the host note maps the source host's tool names to the target's. | Carry `model`; rewrite every tool mention. | Host-parity rule: a Claude alias never goes to Codex, and an OpenAI model id means nothing to Claude Code, so the mirror inherits the host's default. Tool names run through prompts in too many shapes to rewrite safely; one mapping line is honest and cheap. |
| D5 | **When it runs: the existing `skills-sync` hook** runs the agent sync right after the skill sync (same detached child, each guarded on its own), and so do `aos upgrade`'s sharing step and the tab (on open when the cache is older than 10 min, and its **sync now** button). | A new `agents-sync` SessionEnd hook. | No `hooks.json` change means Codex users have nothing new to trust under `/hooks`, and there is still one detached process per session end. |
| D6 | **Config:** `agents: { sync: true, exclude: [] }` in `config.default.json`. Mirroring needs both hosts enabled. `aos agents exclude\|include <name>` edits `agents.exclude` in `<vault>/brain/config.json`. | Opt-in. | Same reasoning as skills D6. `exclude` is the escape hatch for Codex's context: every role's description goes into the `spawn_agent` tool on every Codex turn. |
| D7 | **Cache `brain/_index/agents.json`**, the same shape as `skills.json` with `agents: [row]`. A row adds `readOnly`, and `on.<host>` is `{ path, via, invoke, run }`. `invoke`: `@agent-<name>` in Claude Code (`@agent-<plugin>:<name>` for a plugin agent), the bare role name in Codex. `run`: `claude --agent <name>`, or `codex '<starter prompt>'` that asks for the task and then spawns the role. The HUD reads only this file. | The HUD scans the folders. | Skills D7 and host-routines D4: one parser in the runtime, one loader in the HUD. |
| D8 | **The persona arsenal lists each agent once, under its own host.** `scan-arsenal.js` skips mirror files in the Claude folder and adds Codex user agents (`host: 'codex'`) when Codex is enabled. The Pulse agent count (`collectors/capabilities.js`) keeps counting what Claude Code has, unchanged. | Leave the arsenal alone. | Without the change a Codex agent shows up in the playbook as a Claude one, and a Claude agent's Codex copy never shows. |
| D9 | **In-session command `agents`.** It is `/agenticos:agents` in Claude Code, because `/agents` is Claude Code's own agent manager and wins the bare name; `$agenticos:agents` in Codex; `$agents` with direct wiring. | Another name (`/agent-sync`). | The CLI verb, the tab and the Codex skill all say `agents`; the docs show the namespaced Claude form. |

## 3. What already exists (at `b6c3fa8`)

- `brain/scripts/lib/skills.js` — the pattern to follow: `skillsConfig` `:44`, `hostsOf` `:54`, `roots` `:60`,
  `claudePlugins` `:95`, `plan` `:200`, `writeAtomic` `:356`, `sync` `:468`, `reset` `:493`. `lib/skill-translate.js`:
  `parse` `:35`, `clip`, `yamlScalar`, `codexName`, `claudeWording` `:93`, `codexWording` `:98` (the last two exported for reuse).
- `brain/scripts/skills-sync.js` — the SessionEnd entry (`respawnDetached`, exit 0). Hooks: `HOOKS` in
  `cli/codex-host.js:36` already carries `skills-sync`; `plugin/bin/aos:94`.
- `cli/skills.js` — verbs, `summary`, `doctorRow`; `cli/aos.js` dispatch `:1391`, `skills()` `:1115`, doctor `:423`,
  upgrade's sharing step `:1211`, `USAGE` `:54`.
- `brain/scripts/persona/scan-arsenal.js:121` reads `agents/*.md`; `heartbeat-writer.js:80` seeds a roster heartbeat per
  Claude agent (a Codex-origin mirror is a real Claude Code agent, so it gets one too, correctly).
- HUD: `WorkbenchView.ts` `RAIL` `:21`; `SkillsTab.ts` and `data/skills.ts` (the loader, chips, `shq`, `runCommand`).

## 4. Design

**Runtime.** `lib/agent-translate.js` (D4) and `lib/agents.js`: `roots`, `discover` (user agents on both sides, our
mirrors by marker, enabled Claude plugins' `agents/*.md`, `config.toml` `[agents.<name>]` roles), `plan` (D3), `apply`
(per-pid temp + rename; every write and removal re-checks the marker and hash), `sync`, `reset`, `readCache`/`writeCache`,
`isMirrorFile`. Every root is injectable. `skills-sync.js` calls `agents.sync` after `skills.sync`, and a throw in one
never skips the other.

**CLI.** `cli/agents.js`: `aos agents [list [--all] [--json] | sync [--dry-run] [--json] | exclude <name> | include <name> | reset <name>]`.
It reuses the table and ago helpers exported from `cli/skills.js`. `aos doctor` gains an `agents` row (warn level only for
`edited`/`error`). `aos upgrade`'s step reads "share user skills and agents between the hosts".

**In-session.** `plugin/commands/agents.md` passes its argument to `aos agents` and explains the statuses and how each
host uses an agent (D9).

**HUD.** A new rail tab `agents` (♟ Agents) after Skills. `src/data/agents.ts` parses the cache (never throws);
`src/views/AgentsTab.ts` renders the head (counts, *as of*, **sync now**), a filter, *Your agents* and *Plugins &
config.toml* sections. A row shows name, description, a cyan `claude` and an amber `codex` pill, the source, a
`read-only` pill when set, and the status chip. Actions: `❯_ claude` → `runInTerm('claude --agent <name>')`,
`❯_ codex` → `runInTerm("codex '<starter prompt>'")`, `⧉` copies the invocation, `open` opens the file, and
`share`/`unshare`.

## 5. Host parity

1. **Entry:** the tab; `aos agents` (host-neutral); `/agenticos:agents` · `$agenticos:agents` · `$agents`.
2. **Hooks:** none added or changed (D5). Nothing to re-trust.
3. **Model calls:** none.
4. **Session data:** none; folders resolve through `host.js` (`claudeConfigDir`, `codexHome`).
5. **MCP:** none.
6. **Degradation:** one host → list-only with "sharing needs both hosts"; Codex with `features.multi_agent = false` or
   `agents.enabled = false` → the head says Codex subagents are off; no node-pty → the Term hint, and `⧉` still copies.
7. **Docs:** README commands + counts, `docs/install.md` Hosts, `docs/plugin-smoke.md` per host, `AGENTICOS.md` line.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Agents tab · `aos agents` · `/agenticos:agents`; use an agent: ask for it, `@agent-<name>`, `claude --agent <name>` | discovery + cache; no mirrors | "sharing needs both hosts"; Claude agents listed, `❯_ claude` only |
| Codex only (plugin · direct) | Agents tab · `aos agents` · `$agenticos:agents` · `$agents`; use an agent: name it in the prompt | discovery + cache; no mirrors | same, `❯_ codex` only |
| Both | all of the above | discovery, mirrors both ways (session end, tab, upgrade), cache | `differs` / `edited` / `invalid` chips with the reason on hover |

The one real difference, recorded as D7: `❯_ claude` starts a session *as* the agent; Codex has no such flag, so
`❯_ codex` starts a session whose first prompt asks for the task and hands it to the role.

## 6. Testing

- `test/agent-translate.test.js`: the TOML subset (every string form, escapes including `"""`, backslashes and control
  characters, arrays, tables skipped, malformed → error) and a write → read round trip; each D4 mapping in both
  directions; the marker's hash excludes the marker line.
- `test/agents.test.js` (tmp roots): discovery incl. plugin and `config.toml` roles; each D3 status incl. reserved names;
  apply is idempotent; an unmarked file is never written; an edited mirror is kept; orphan removal; exclude; one host → no writes.
- `test/skills-sync.test.js`: the agents sync runs, and runs even when the skills sync throws.
- `cli/agents.test.js`; scan-arsenal test (a mirror skipped, a Codex agent listed); `hud` `agents.test.ts`.
- Counts: 19 commands, 26 Codex skills. Rehearsals `first-run.sh` and `codex-host.sh`; manual: the tab here, a
  mirrored agent spawned in a Codex session.

## 7. Out of scope

- Project-scope agents (`<repo>/.claude/agents` ↔ `<repo>/.codex/agents`), subfolders of `agents/`, Codex plugin agents.
- Listing host built-ins (not on disk, version-dependent); creating or editing agents from the tab.
- "Last used" per agent: telemetry records Claude Code's Agent/Task spawns only, not Codex `spawn_agent`, so it would be
  one-host data. A follow-up can teach telemetry `spawn_agent` first.
- Mapping models across hosts (a per-host `agents.codexModel` could come later); a version bump and release.
