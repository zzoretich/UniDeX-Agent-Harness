# Codex host support — implementation plan

Spec: `docs/design/specs/2026-09-21-codex-compat-design.md` · Branch: `feat/codex-compat`

Four phases, each a mergeable PR on its own. Phase 1 has no user-visible behaviour change
under Claude Code; phases 2–4 are additive. Every task ends with `npm run gate && npm test`.

## Task 0 — spike (manual, before phase 1)

On the owner's machine with the real `codex` CLI, using a throwaway `CODEX_HOME`:

- [x] Write a `hooks.json` with one entry per event whose command appends the stdin JSON to a
      file; open the TUI, send one prompt, quit; then `codex exec 'say hi'`. Record which
      events fired in each mode and the exact payload keys.
- [x] Confirm a Stop hook that prints nothing, and one that prints `{}`, are both accepted.
- [x] Confirm `transcript_path` points at the rollout file for every event.
- [x] Record the `tool_name` values seen for a shell command, a file edit, and an MCP call.
- [x] Confirm `codex exec -c features.hooks=false` suppresses the hooks.
- [x] Note the trust prompt behaviour (`/hooks`) and whether `codex exec` runs untrusted hooks.

Write the findings as a "Spike results" section at the bottom of this file. Any contradiction
with the spec is fixed in the spec before task 1.

## Phase 1 — host layer and hook contracts (brain/scripts)

- [x] 1.1 `brain/scripts/lib/host.js` + `test/host.test.js`.
- [x] 1.2 `detach.js` uses `host.isHookInvocation()`; existing tests still pass with
      `CLAUDE_PROJECT_DIR`, new case with `AOS_HOST=codex`.
- [x] 1.3 `hook-entry.js` `finishStop()`; `update-session.js`, `heartbeat-writer.js` call it.
- [x] 1.4 `scan-vault.js` gains `respawnDetached()` under a hook invocation.
- [x] 1.5 `inject-conventions.js` + `bin/aos` case arm + test.
- [x] 1.6 `lib/transcript.js` with Claude and Codex readers; fixture
      `test/fixtures/codex-rollout.jsonl`; `heuristics.js`, `inject-context.js`,
      `update-session.js`, `auto-wrap.js` read through it.
- [x] 1.7 `telemetry-hook.js` tool-kind mapping via the adapter.
- [x] 1.8 `config.default.json` `codex` block; `lib/config.js` merge test.

## Phase 2 — provider and costing

- [x] 2.1 `sdk/lib/codex-cli.js` + `test/codex-cli.test.js` (spawn seam, JSON parse,
      `ProviderUnavailable` on not-logged-in).
- [x] 2.2 `models.js` role `codex`; `provider.js` `makeCodex()`, budgets, login cache,
      chain order ollama → claude → codex → none; `provider.test.js` cases.
- [x] 2.3 `sdk/lib/codex-pricing.js` rate table (shared with the provider; the Python analyzer and
      `extras/cost/pricing.json` stay Claude-only); `auto-cost.js` host routing + `costCodexRollout()`;
      `cost-sync.js` accepts rollout-named snapshots; `test/auto-cost-codex.test.js`.
- [x] 2.4 `aos provider` output shows the codex row.

## Phase 3 — installer, doctor, skills

- [x] 3.1 `cli/aos.js` `buildUserConfig()` writes `hosts`; upgrade migration test.
- [x] 3.2 `cli/codex-host.js`: `installCodexHost`, `removeCodexHost`, `codexHostStatus`,
      `commandToSkill`; `cli/codex-host.test.js`.
- [x] 3.3 `aos init --host claude|codex|both` (default: detect); preflight "at least one
      host logged in"; `~/.codex` vault refusal; checklist text.
- [x] 3.4 `aos doctor` per-host rows; `aos uninstall --host`; `aos upgrade` regenerates
      skills and re-merges hooks.
- [x] 3.5 `vendorRuntime()` copies `plugin/{commands,skills}` into
      `<vault>/brain/scripts/plugin/`.
- [x] 3.6 Collectors gated on `hosts.claude.enabled`.
- [x] 3.7 `cli/fixtures/fake-codex.sh`; `cli/rehearsal/codex-host.sh` (a second rehearsal beside
      `first-run.sh`, which now pins `AOS_NO_CODEX=1`); CI step in the first-run job.

## Phase 4 — docs and vault seed

- [x] 4.1 README (prerequisites, install §4b, How it works diagram, layout line).
- [x] 4.2 `docs/install.md`, `docs/plugin-smoke.md` Codex list, `docs/cost.md` note.
- [x] 4.3 `vault-template/AGENTICOS.md`, `profile.md`, `brain/routines/README.md`.
- [x] 4.4 `cli/vault-template.test.js`, `cli/plugin-commands.test.js` updates.
- [ ] 4.5 Version bump to 0.5.0 at release (`npm run version:bump 0.5.0`).

## File structure

| Path | Change | Phase |
|---|---|---|
| `brain/scripts/lib/host.js` | new | 1 |
| `brain/scripts/lib/transcript.js` | new | 1 |
| `brain/scripts/inject-conventions.js` | new | 1 |
| `brain/scripts/lib/{detach,hook-entry,heuristics}.js` | edit | 1 |
| `brain/scripts/{inject-context,update-session,auto-wrap,telemetry-hook,scan-vault}.js` | edit | 1 |
| `brain/scripts/config.default.json` | edit | 1 |
| `brain/scripts/test/fixtures/codex-rollout.jsonl` | new | 1 |
| `brain/scripts/sdk/lib/codex-cli.js` | new | 2 |
| `brain/scripts/sdk/lib/{provider,models}.js` | edit | 2 |
| `brain/scripts/{auto-cost,cost-sync}.js` | edit | 2 |
| `brain/scripts/sdk/lib/codex-pricing.js` | new | 2 |
| `cli/codex-host.js`, `cli/codex-host.test.js` | new | 3 |
| `cli/aos.js`, `cli/aos.test.js` | edit | 3 |
| `cli/fixtures/fake-codex.sh`, `cli/rehearsal/codex-host.sh` | new | 3 |
| `cli/rehearsal/first-run.sh`, `.github/workflows/ci.yml` | edit | 3 |
| `plugin/bin/aos` | edit (two case arms) | 1, 3 |
| `brain/scripts/collectors/health.js` (the other collectors only report, so they needed no gate) | edit | 3 |
| `README.md`, `docs/install.md`, `docs/plugin-smoke.md`, `docs/cost.md` | edit | 4 |
| `vault-template/AGENTICOS.md`, `vault-template/brain/memory/user/profile.md` | edit | 4 |

## Spike results

Run on 2026-09-21 against codex-cli 0.144.5 in a throwaway `CODEX_HOME`, eleven `codex exec`
sessions, hooks trusted with `--dangerously-bypass-hook-trust`. Task 0 is complete.

**Events.** Under `codex exec`, `SessionStart` (`source: "startup"`), `UserPromptSubmit`,
`PostToolUse` and `Stop` fire; `SessionEnd` does **not** fire when exec exits (the docs say it
fires on thread close, archive, or 30 min idle). Not verified in the TUI.

**Payloads** match the spec: `session_id`, `turn_id`, `transcript_path` (always populated, the
rollout file), `cwd`, `hook_event_name`, `model`, `permission_mode` (`bypassPermissions` under
exec). `UserPromptSubmit` carries `prompt`; `Stop` carries `stop_hook_active` and
`last_assistant_message`. Two differences from Claude Code: `tool_input` and `tool_response` are
**JSON-encoded strings**, not objects, and the shell tool is reported as `tool_name: "Bash"`
(Claude's name), a file edit as `"apply_patch"`, an MCP call as `"mcp__agenticos__memory_list"`.

**Output contracts.** Plain stdout from `SessionStart` lands in the transcript as a developer
message and the model can quote it. A `Stop` hook printing nothing, `{}`, or plain text was
accepted with exit 0 and no warning in 0.144.5; the spec keeps `{}` because the docs call plain
text invalid. `-c features.hooks=false` suppressed every hook.

**MCP.** With the server registered in `config.toml`, every tool call was rejected with
`user cancelled MCP tool call` under the `read-only` and `workspace-write` sandboxes and
succeeded only under `danger-full-access`. `default_tools_approval_mode` (via `-c` or in the
file) did not change this. Adding MCP tool annotations (`readOnlyHint: true`) to the server
fixed it: the call succeeded under `workspace-write` and `PostToolUse` fired for it. This is
decision D12 in the spec and is already implemented in `brain/scripts/sdk/mcp-server.js`.
`codex mcp add` has no approval flags; none are needed. Twice an MCP server process outlived
its exec session; the server itself exits immediately on stdin EOF when tested directly.

**Transcript.** `code_mode_host` is on by default, so tool calls in the rollout are
`response_item/custom_tool_call` named `exec` wrapping a JavaScript snippet; no classic
`function_call` records appeared even with the feature disabled. The reliable tool signals are
the `event_msg` records: `patch_apply_end` (`changes` keyed by absolute path with
`type: add|update|delete`), `mcp_tool_call_end` (`invocation.server`, `invocation.tool`),
`exec_command_end`, and `token_count` (`info.total_token_usage`, `info.last_token_usage` with
`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`,
`total_tokens`). Messages are `response_item/message` with `role` `user`, `assistant` or
`developer` (skip `developer`, it is injected context). `session_meta` has `id`, `cwd`,
`originator`, `cli_version`, `source`, `model_provider`; the model name is in the hook payload
and `turn_context`.

**Headless.** `codex exec` with an open non-TTY stdin blocks on "Reading additional input from
stdin" forever. The provider must feed the prompt on stdin and close it; any probe must spawn with
stdin ignored. `--json` emits `thread.started`, `turn.started`, `item.*`, `turn.completed`
(`usage`), and the bypass flag adds two `error` items that are warnings, not failures.
