# Codex host support — design

Date: 2026-09-21 · Branch: `feat/codex-compat` · Verified against `92cbaad`

## 1. Problem

The Workbench is a second brain *for Claude Code*. Every session-facing surface assumes
that one host: the plugin manifest (`plugin/.claude-plugin/`, `plugin/hooks/hooks.json`,
`plugin/.mcp.json`) is installed through the Claude Code marketplace; the hook scripts are
reached through `${CLAUDE_PLUGIN_ROOT}/bin/aos`; seven readers parse Claude's transcript
JSONL under `<claude config dir>/projects/`; the expression `CLAUDE_CONFIG_DIR || ~/.claude`
is duplicated in 13 files; the `claude` provider spawns `claude -p`; and `aos init`
refuses to run unless the `claude` CLI is found *and* logged in (`cli/aos.js:662-670`).
There is no notion of "which agent CLI hosts the session" anywhere in the repo; the only
multi-backend layer is the model provider (`ollama | claude | none`), which is a
different axis.

The owner wants the same vault, memory pipeline, recall tools and vocabulary available
when the session runs under OpenAI Codex CLI, either instead of Claude Code (a machine
with only Codex) or beside it (both CLIs sharing one vault).

Codex (0.144+) makes this tractable. It ships a lifecycle hook system shaped like Claude
Code's (same event names, the same stdin fields `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `tool_name`; plain stdout or `hookSpecificOutput.additionalContext`
becomes developer context), MCP servers in `config.toml`, skills under
`~/.agents/skills/`, and `codex exec` for headless runs. The real gaps are: no `@file`
include in `AGENTS.md`; a different transcript format and location; a Stop hook that
rejects plain-text stdout; a SessionEnd hook capped at 3 s that fires late; hooks that
must be trusted once by content hash; and slash commands being deprecated in favour of
skills.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | Introduce a **host** concept, orthogonal to provider. `agenticos.json` gains `hosts: { claude: { enabled, configDir, bin }, codex: { enabled, home, bin } }`. Both may be enabled at once. The legacy `claudeConfigDir` and `claude.bin` keys stay and are mirrored into `hosts.claude` by `buildUserConfig()` on upgrade. | A single `host: "claude" \| "codex"` string. | "Alongside" is an explicit requirement: one vault, two CLIs, one memory pipeline. A set of enabled hosts is the only shape that expresses it, and it keeps every existing config file valid. |
| D2 | A hook learns its host from the environment, never by sniffing: the Codex hook entries are written as `env AOS_HOST=codex sh <vault>/brain/scripts/bin/aos <name>`, and the Claude plugin implies `claude`. New `brain/scripts/lib/host.js` exposes `currentHost()`, `hostDirs(host)` (config dir, sessions root), `isHookInvocation()` (replaces the `CLAUDE_PROJECT_DIR` test in `detach.js:19`), and `findTranscript(host, sessionId)`. | Detect the host from the `transcript_path` prefix or from `CODEX_*` env vars. | A path prefix breaks under `CODEX_HOME` / `CLAUDE_CONFIG_DIR` overrides and in tests; Codex's exported env vars are undocumented. One explicit variable, set by the file we write, is deterministic and testable. |
| D3 | Install Codex through its **user config, not a plugin bundle**: `aos init --host codex` (or `--host both`, default auto-detect) merges the five hook events into `~/.codex/hooks.json`, each command prefixed `env AOS_HOST=codex AOS_CONFIG=… sh <launcher>` which is also the ownership marker (foreign entries and unknown keys untouched), registers the MCP server with `codex mcp add agenticos -- sh <vault>/brain/scripts/bin/aos mcp-server`, and writes skills into `~/.agents/skills/<name>/`. `aos uninstall --host codex` reverses each step. The repo's `plugin/` directory is untouched. | Ship a `.codex-plugin/plugin.json` beside `.claude-plugin/` and install via a Codex marketplace. | Codex's plugin format is still moving (`plugins` is a feature flag), `${CLAUDE_PLUGIN_ROOT}` expansion inside a plugin's `.mcp.json` is unverified, and a plugin would need its own `skills/` tree since Codex has no `commands/`. The vault already has a vendored, symlinked launcher (`<vault>/brain/scripts/bin/aos`), so absolute-path hook commands are stable across upgrades, which is exactly what Codex's trust-by-hash wants. A plugin bundle can follow once the format settles (§6). |
| D4 | Slash commands become **generated skills**. `cli/codex-host.js` transforms each `plugin/commands/<name>.md` into `~/.agents/skills/<name>/SKILL.md` (drop `allowed-tools` and `argument-hint`; `$ARGUMENTS` → "the text after the skill name"; `${CLAUDE_PLUGIN_ROOT}/bin/aos` → the vendored launcher; `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json` → the real config path; `mcp__plugin_agenticos_agenticos__*` → `mcp__agenticos__*`) and copies the six `plugin/skills/*` with the same rewrites. `plugin/{commands,skills}` are vendored into `<vault>/brain/scripts/plugin/` so `aos upgrade` can regenerate without the marketplace clone. Names stay unprefixed (`$wrap`, `$remember`). | Write `~/.codex/prompts/*.md`; or prefix everything `aos-`. | Custom prompts are officially deprecated and home-only. Unprefixed names keep the AGENTICOS.md vocabulary true on both hosts and Codex's bundled skills live in a separate `.system` namespace, so nothing collides. |
| D5 | The conventions file is **injected by a SessionStart hook** on Codex: `aos inject-conventions` prints `<vault>/AGENTICOS.md` (about 1.4k tokens, under the 2,500-token default cap) as `additionalContext` for every `source` (`startup`, `resume`, `clear`, `compact`). The Claude path is unchanged (the user adds the `@` line to CLAUDE.md by hand). | Append AGENTICOS.md to `~/.codex/AGENTS.md` at init. | `AGENTS.md` has no include syntax, so an appended copy goes stale on every upgrade, and the installer's rule is that it never edits the user's instruction files. Re-injection after compaction is a bonus Claude Code does not offer. |
| D6 | Hook **output contracts** become host-aware in `hook-entry.js`: on Codex a Stop hook always ends with `{}` on stdout (plain text is rejected); UserPromptSubmit and SessionStart keep plain stdout (accepted by both hosts). Every SessionEnd handler must return within 3 s, so `scan-vault --quiet` gains the same `respawnDetached()` prologue the other four already use. | Wrap all output in `hookSpecificOutput` JSON on both hosts. | Minimal diff, and the existing Claude tests keep asserting the exact current stdout. |
| D7 | A **transcript adapter**, `brain/scripts/lib/transcript.js`, yields one normalised stream `{ role, text, toolUses: [{ name, kind, filePath }], usage }` from either format. Claude: the existing logic in `lib/heuristics.js:24-60`. Codex: `response_item` messages (`role` user/assistant, `content[].text`; `developer` skipped), tool kinds from the `event_msg` records `patch_apply_end` (edit, one per changed path), `exec_command_end` (bash) and `mcp_tool_call_end` (mcp), and `event_msg.token_count` for usage. Codex's code mode wraps tool calls in `custom_tool_call` scripts, so the call records themselves are not parsed. `heuristics.js`, `inject-context.js` (turn counting), `update-session.js` and `auto-wrap.js` read through the adapter; `collectors/projects.js`, `sweep-orphans.js` and the Pulse tab backfill stay Claude-scoped and are gated on `hosts.claude.enabled`. | Convert Codex rollouts to Claude's JSONL on disk. | A second copy of every session on disk doubles the orphan-sweep surface; a reader-side adapter is one function with fixture tests. |
| D8 | **Costing** for Codex sessions is computed in Node from `token_count` events and a rate table in `sdk/lib/codex-pricing.js` (shared with the provider; estimates, since Codex reports tokens, never dollars), written as a snapshot through the existing `cost-sync.js` patch path. `analyze_transcript.py` and `extras/cost/pricing.json` stay Claude-only; `auto-cost.js` routes by host. | Teach the Python analyser the rollout format. | The Python tool is a forensic per-skill analyser tied to Claude's `message.id` de-duplication quirks; Codex already gives per-turn totals, so a 40-line JS reducer is the honest size of the job. |
| D9 | A **`codex` provider** beside `claude`: `brain/scripts/sdk/lib/codex-cli.js` mirrors `claude-cli.js` and runs `codex exec --ephemeral --skip-git-repo-check -s read-only --json -c features.hooks=false -o <tmp> -` with the prompt on stdin, parses `turn.completed.usage`, and prices it from D8. Config `codex: { model: null, perCallUsd: 0.05, perDayUsd: 0.5, bin }` (`model: null` means "do not pass `-m`; use the user's Codex default"). The auto chain becomes ollama → claude → codex → none; login probe = `codex login status`. | Route Codex through the Codex MCP server tool. | The MCP route has no budget or usage reporting and cannot disable hooks. `-c features.hooks=false` is what stops our own SessionStart hook from re-entering the pipeline, alongside the existing `AOS_HEADLESS=1`. |
| D10 | `aos init` preflight requires **at least one** enabled host CLI to be installed and logged in; `aos doctor` grows per-host rows (`codex CLI`, `codex login`, `codex hooks registered`, `codex MCP declared`, `codex skills linked`) and refuses `~/.codex` as a vault like it refuses `~/.claude`. Collectors that describe the Claude config dir (`config.js`, `capabilities.js`, `runtime.js`, `folderAtlas.js`, `health.js`) skip instead of erroring when `hosts.claude.enabled` is false. | Keep Claude mandatory and treat Codex as an add-on. | "In place of" is half the requirement. A Codex-only machine must pass `aos init` and `aos doctor` clean. |
| D11 | Codex's built-in `memories` feature is **left alone** and surfaced as one `aos doctor` info row when enabled. | Disable it at init, or import its `MEMORY.md`. | Touching a user's model-memory setting is not the installer's call; importing is a separate feature. |
| D12 | Every MCP tool advertises **annotations**: `readOnlyHint: true` on the eleven read tools, `readOnlyHint: false, destructiveHint: false` on `wrap_session`. | Set `default_tools_approval_mode` on the server entry at install. | The spike showed Codex cancels un-annotated MCP calls inside any sandbox (`user cancelled MCP tool call`) and the approval-mode key does not change that; annotations do. Claude Code ignores them. |

## 3. What already exists (at `92cbaad`)

- `plugin/bin/aos` (91 lines): the single dispatcher for every hook and the MCP server;
  vendored to `<vault>/brain/scripts/bin/aos` and symlinked to `~/.local/bin/aos` by
  `cli/aos.js:483-497`. Reused verbatim as the Codex hook command target.
- `brain/scripts/lib/hook-entry.js`, `lib/detach.js`: the hook prologue and the detached
  respawn. Only the host test at `detach.js:19` changes.
- `brain/scripts/lib/paths.js:19-24,50-55`: `claudeConfigDir()`, `PATHS.PROJECTS`.
  `host.js` builds on these; the 13 duplicated `CLAUDE_CONFIG_DIR || ~/.claude`
  expressions are *not* refactored in this change (they remain the Claude host's rule).
- `brain/scripts/sdk/lib/claude-cli.js`, `provider.js:79-140`, `models.js:17-24`: the
  provider seam with budgets, login cache and role table. The `codex` provider is a
  fourth entry, not a new mechanism.
- `brain/scripts/auto-cost.js:46-55` `findTranscript()`, `cost-sync.js`: the costing
  seam that D8 extends.
- `cli/aos.js:446-481` `buildUserConfig()` / `noteClaudeBinChange()`: config migration
  on upgrade; D1 adds the `hosts` block here.
- `cli/fixtures/fake-claude.sh` and `cli/rehearsal/first-run.sh`: the pattern for a
  `fake-codex.sh` and a `--host codex` rehearsal leg.
- `cli/plugin-commands.test.js`: already parses every command's frontmatter; the skill
  generator reuses that parser.

## 4. Design

### 4.1 Config (`agenticos.json`, `config.default.json`)

`hosts.claude` defaults from today's keys; `hosts.codex.home` = `CODEX_HOME || ~/.codex`;
`hosts.codex.bin` resolved like `claude.bin`. `config.default.json` gains
`"codex": { "model": null, "perCallUsd": 0.05, "perDayUsd": 0.5 }`. `AOS_CODEX_MODEL`
mirrors `AOS_CLAUDE_MODEL`.

### 4.2 Host layer (`brain/scripts/lib/host.js`)

`currentHost()` = `AOS_HOST` env → `'claude'`. `hostDirs('codex')` = `{ configDir: home,
sessions: home/sessions, history: home/history.jsonl }`. `findTranscript('codex', id)`
walks `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` then `archived_sessions/`.
`isHookInvocation()` = `AOS_HOST` set or `CLAUDE_PROJECT_DIR` set.

### 4.3 Installer (`cli/codex-host.js`, dispatched from `cli/aos.js`)

Functions `installCodexHost(ctx)`, `removeCodexHost(ctx)`, `codexHostStatus(ctx)`, each
with injectable `run`/`fs` seams. Hook merge is idempotent and keyed by the
`env AOS_HOST=codex ` command prefix (no extra keys, so Codex's schema is untouched); the written
commands are exactly `env AOS_HOST=codex AOS_CONFIG='<config>' sh '<launcher>' <name>` so their hash
is stable across upgrades. The
init checklist tells the user to open `/hooks` once in Codex and trust the five entries.

### 4.4 Skills generator (`cli/codex-host.js` → `~/.agents/skills/`)

Pure function `commandToSkill(markdown, ctx)` with golden tests using `<vault>` placeholders.
Generated files carry a `generated-by: agenticos` frontmatter line so uninstall only
removes ours.

### 4.5 Hooks (`brain/scripts/*.js`)

`inject-conventions.js` (new, SessionStart, Codex only). `hook-entry.js` exports
`finishStop()` that prints `{}` when `currentHost() === 'codex'`. `telemetry-hook.js`
parses `tool_input` / `tool_response` when they arrive as JSON strings (Codex) and maps
`apply_patch` to the edit kind; `Bash` and `mcp__*` names already match. `scan-vault.js`
detaches under a hook. `sdk/mcp-server.js` carries the D12 annotations.

### 4.6 Transcript adapter and costing

`lib/transcript.js` with `readTurns(file, host)`; fixtures `test/fixtures/codex-rollout.jsonl`
(synthetic, no real content). `auto-cost.js` → `costCodexRollout(file, pricing)` →
`cost-sync.js`.

### 4.7 Provider

`codex-cli.js` + `models.js` role `codex` + `provider.js` `makeCodex()` and chain order.
`run-duty.sh`, `run-routine.js` and the HUD Chat tab keep calling `claude -p` (§6).

### 4.8 Docs and vault seed

README: prerequisites become "Claude Code and/or Codex CLI, logged in"; new
"Wire Codex to the vault" subsection; the mermaid diagram gains a second host node.
`vault-template/AGENTICOS.md` title and "How it runs" mention both hosts and the `$name`
skill form; `profile.md` drops "A Claude Code user". `docs/install.md` gets the Codex
tables; `docs/plugin-smoke.md` gets a Codex smoke list.

## 5. Testing

- `cli/codex-host.test.js`: hook merge (empty file, foreign entries, re-run idempotent,
  uninstall leaves foreign entries), MCP add/remove command lines, skill transform goldens.
- `brain/scripts/test/host.test.js`, `transcript.test.js`, `codex-cli.test.js`,
  `auto-cost-codex.test.js`; `telemetry-hook.test.js` gains a Codex `apply_patch` case;
  `inject-context.test.js` a Codex rollout turn-count case.
- `cli/aos.test.js`: init with only `fake-codex.sh` on PATH; doctor rows; upgrade migrates
  `hosts`.
- `cli/rehearsal/first-run.sh --host codex` added to the CI matrix.
- A manual spike (plan task 0) confirms on the real CLI: hooks fire in the TUI and under
  `codex exec`; empty/`{}` Stop stdout is accepted; `transcript_path` is populated;
  PostToolUse `tool_name` values. Findings are recorded in the plan before task 1 starts.

## 6. Out of scope

- A Codex plugin bundle / marketplace listing (follow-up once `plugins` leaves the flag).
- Persona duties (`run-duty.sh`), `prompt` routines and the HUD Chat tab under Codex:
  they keep requiring the `claude` CLI; a Codex-only machine sees them disabled in doctor.
- Importing Codex's built-in memories; the Codex desktop app's thread lifecycle; Windows.
- Refactoring the 13 `CLAUDE_CONFIG_DIR` expressions into `host.js`.
- Cost analysis of Codex sessions in the Python forensic tool.
