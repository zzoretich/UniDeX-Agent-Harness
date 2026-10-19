# Codex parity gaps — every Workbench feature under Codex — design

Date: 2026-09-23 · Branch: `feat/codex-parity-gaps` · Verified against `d463403` (0.11.3) and Codex CLI 0.156.1

## 1. Problem

Codex became a session host in 0.5.0 (codex-compat), reached runtime parity in 0.6.0 (codex-parity) and got its own
plugin in 0.10.0 (codex-plugin). The promise is that the Workbench behaves the same for a user on Claude Code only,
Codex only, or both. An audit of `brain/scripts`, `cli`, `hud/src` and `plugin/` against a Codex-only
machine (`hosts.claude.enabled: false`, no `claude` binary) found 19 features at parity and these that are not:

| # | Feature | What a Codex-only user gets today |
|---|---|---|
| 1 | Reasoner role: HUD Chat, `ask-brain --local`, `reflect-week`/`consolidate-memory --local` | `resolveProviderForRole` (`sdk/lib/provider.js:262`) is Claude-only; `localProvider` (`sdk/lib/interactive.js:53`) falls back to Ollama only → "no model provider" although Codex is logged in |
| 2 | Structured calls on the codex provider (auto-wrap, correction drafts, conflict check) | `codex-cli.js` passes loose schemas (`{type:'object'}`, no `additionalProperties:false`) to `--output-schema`. Live, 0.156.1: `400 invalid_json_schema` ("'additionalProperties' is required to be supplied and to be false"), so every such call fails; a strict-form schema is accepted. Hook calls also pass no effort, so they inherit the user's Codex default (here `xhigh`) |
| 3 | Vault graph semantic pass | `graph-build.js:183` → `disabled: no claude CLI`; `aos graph` still says the next scan starts it |
| 4 | `aos upgrade` | no `claude` → no marketplace dir → "cannot locate the checkout" unless `--from-local` (`cli/aos.js:535,1099`) |
| 5 | `aos status` | hook cap shows `claude.perDayUsd`; the codex provider enforces `codex.perDayUsd`; reasoner line says `provider=claude` |
| 6 | Proposals tab "Review in Claude" | types `claude "review persona flags"` into the terminal (`ProposalsTab.ts:12`) |
| 7 | Update notice | plugin version read from `.claude-plugin/plugin.json` only (`cli/update-check.js:325`) → never compares |
| 8 | Duty and routine models | every duty and prompt routine runs `codex.model`; the interview's model answer and the routine's `model` are ignored |
| 9 | Custom Codex home | `hosts.codex.home` is never exported as `CODEX_HOME` to headless or scheduled runs |
| 10 | File maps, workspace insights | model opt-in exists for Claude (`scan.*UnderClaude`), none for Codex |
| 11 | Cost backfill | `auto-cost.js` backfill looks up Claude transcripts only; Codex runs missed at SessionEnd are never costed |
| 12 | PLAYBOOK inventory, HUD capabilities | scan `~/.claude/{skills,agents,commands}` only → empty sections, zero counts |
| 13 | Codex skill text | `$agenticos:aos` doctor fix says `claude plugin install`; AskUserQuestion / "the Read tool" / `/agenticos:<name>` in three skills; the routines skill's cloud line is inverted by the blanket "Claude Code session" rewrite; cost skill points at Claude transcripts |
| 14 | Invocation names in runtime text | "run /wrap" (`auto-wrap.js:324`), "any Claude session", clipboard `/wrap`, `$wrap` under a plugin install, "decide it in a Claude session" |

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **Reasoner falls back to Codex.** `resolveProviderForRole('reasoner')`: Claude when `hosts.claude` is enabled (or absent) and logged in, else Codex when configured and logged in, with the reasoner's own caps (`reasoner.perCallUsd/perDayUsd`), model `reasoner.codexModel` (new, default null → `codex.model` → the user's Codex default) and effort `reasoner.effort`. `localProvider` accepts it. The HUD Chat needs no new spawn: `chatRoute` already sends every non-Claude state to `ask.js --local`. | Spawn `codex exec` from the HUD (a TS copy of the recipe). | One recipe (`codex-cli.js`) stays the only place that spawns Codex; the Chat fix falls out of the reasoner fix. |
| D2 | **Structured output that Codex accepts.** `codex-cli.js`: a free-form request (`format:'json'` → `{type:'object'}`) sends **no** `--output-schema`; the prompt ends "Reply with one JSON object only" and the reply is parsed leniently (fences stripped). A real schema is made strict-compatible by `strictSchema()` (every object gets `additionalProperties:false`, every property `required`, originally optional ones become nullable), and `null` fields are dropped from the parsed reply so callers see the shape they asked for. `auto-wrap` counts codex as structured. Calls that pass no effort use `codex.effort` (new, default `low`), the Codex twin of graphify D12's thinking-off rule. | Rewrite each caller's schema by hand. | One transform covers every caller, today's and future ones; Claude keeps receiving the schemas unchanged. Probed live (§6). |
| D3 | **Graph semantic pass under Codex, same shim.** graphify still runs `--backend claude-cli`; the `claude` shim (`graph-claude.js`) picks a runner: `graph.semantic.runner` (`auto`\|`claude`\|`codex`, new, default `auto`); `auto` follows an explicit `provider` of `claude`/`codex`, else `resolveRunner` (Claude first when its host is enabled and found, else Codex). The Codex leg runs `codex exec` through `codex-cli.js`'s recipe (read-only, ephemeral, hooks off, `--json`, `-o`) in an empty temp cwd, model `codex.model`, effort `low`, and prints a Claude-shaped result envelope (`result`, `usage` with cached tokens as `cache_read_input_tokens`, `modelUsage`, `stop_reason`, estimated `total_cost_usd`). `--help`/`--version` are answered by the shim, without `--json-schema`: the pinned graphify 0.9.66 probes `claude --help` for it and, not finding it, reads the plain `result` (its `structured_output` path stays unused). | graphify's `openai` backend. | It needs an `OPENAI_API_KEY` and the `openai` extra; Codex users sign in with ChatGPT, and it would bypass the ledger and caps. graphify 0.9.66 reads `structured_output` when present, else `result`, plus `usage`, `modelUsage`, `stop_reason` (`graphify/llm.py`); verified live end to end. |
| D4 | **Graph budget under Codex is estimated.** The daily `graph.semantic.perDayUsd` gate before each call is unchanged; `perCallUsd` cannot be enforced (no flag), so each call is priced after the fact through `codex-pricing.js` into one `graph:semantic` row with `provider: codex`. `semanticSkip` says `no claude or codex CLI` only when neither resolves; `aos graph` and the consent prompt name the runner. | Refuse the pass without a per-call cap. | Same guarantee as persona duties and routines under Codex (codex-parity D5). |
| D5 | **Per-kind Codex models.** `persona.codexModel`, `routines.codexModel`, `reasoner.codexModel` (all default null → `codex.model` → the user's default). `resolveRunner` returns the kind's model; `run-duty.sh` logs the model it actually passes. The interview asks for a Codex model on a Codex-enabled vault. | Map Claude aliases to OpenAI models. | Aliases do not translate; a null default keeps today's behaviour. |
| D6 | **Host-aware entry points.** `aos upgrade` adds the Codex marketplace `root` (`codex plugin marketplace list --json`) as a checkout candidate. `aos status` shows the hook cap of the resolved provider and the reasoner's resolved host. The Proposals button types `claude "review persona flags"` or `codex "$agenticos:persona-flag-closer"` by the enabled host (Claude first) and is labelled for it. The update notice reads `.codex-plugin/plugin.json` too. | Leave Codex users on `--from-local`. | Each is a place where the Codex path already exists one call away. |
| D7 | **`CODEX_HOME` travels.** `codex-cli.js` and `lib/headless.js` headless envs, `run-duty.sh` and the launchd/systemd templates export `CODEX_HOME` from `hosts.codex.home` when it is set. | Document it. | A custom home silently splits sessions from their config today. |
| D8 | **Codex opt-ins for file maps and insights**: `scan.fileMapBudgetUnderCodex` (0), `scan.insightsUnderCodex` (false), mirroring the Claude keys. | Reuse the Claude keys. | The keys say which provider is paid for; a user may opt in for one only. |
| D9 | **Cost and inventory by host.** Backfill routes each uncosted run by its recorded host (`costOne` → `costCodexRollout` for codex); the HUD Fix Queue counts both. `scan-arsenal`, `build-playbook`, `interview` and the capabilities collector also read `~/.agents/skills`, the installed Codex plugin's skills and Codex hooks. | Claude-only inventory. | The playbook drift check and the HUD should describe what the user actually has. |
| D10 | **Skill text translates.** `rewriteBody` learns `/agenticos:<name>` → `$agenticos:<name>` (`$<name>` direct), drops " with the Read tool", maps `AskUserQuestion` → "question to the user" with one host-note line on how to ask; the "Claude Code session" rewrite stops inverting host-specific lines (sources say "an interactive Claude Code session" where they mean Claude Code, tested). Plugin sources (`aos`, `cost`, `routines`) name both hosts where they differ; runtime and HUD strings name the invocation for the host (`/wrap` · `$agenticos:wrap`). `tools/build-codex-plugin.test.js`'s idiom regex grows to match. | Keep Claude idioms and rely on the model. | Codex hands skill bodies to the model verbatim; a wrong command is worse than none. |

## 3. What already exists (at `d463403`)

- `sdk/lib/provider.js` `makeCodex`, `resolveCodex`, `codexBudget` — D1 reuses them with reasoner caps.
- `sdk/lib/codex-cli.js` `buildArgs`, `runCodex`, `parseEvents`, `codexCall`, `defaultModelFromConfig`; `codex-pricing.js` `priceUsd` — D2/D3/D4.
- `lib/headless.js` `resolveRunner`, `resolveBin`, `runnerArgs`, `headlessEnv` — D3/D5/D7.
- `graph-claude.js` `main` (`:50`), `graph-build.js` `semanticState` (`:160`), `semanticSkip` (`:173`), `semantic` (`:188`) — D3/D4.
- `auto-cost.js` `costOne`, `costCodexRollout` (`:123`) — D9. `cli/codex-host.js` `rewriteBody` (`:202`), `hostNote` (`:221`) — D10.
- `cli/fixtures/fake-codex.sh` `exec -` branch — gains `FAKE_CODEX_REPLY` for the graph and structured tests.

## 4. Host parity

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | unchanged: `/ask-brain`, HUD Chat, `aos graph build --semantic`, `/aos` | unchanged: `claude -p` recipes | unchanged |
| Codex only (plugin · direct) | `$agenticos:ask-brain` · `$ask-brain`, HUD Chat, `aos graph build --semantic`, `$agenticos:aos` | `codex exec` through `codex-cli.js` for reasoner, structured hook calls and the graph pass; duties/routines on their kind's Codex model | not logged in → the same "no model provider" / `disabled` rows as Claude, naming `codex login` |
| Both | as today | Claude first wherever both qualify (reasoner, graph `auto`, Proposals button); an explicit `provider: codex` or `*.runner: codex` picks Codex | — |

The seven questions: entry points are unchanged (no new command); no hook command changes (no `/hooks` re-trust);
every model call goes through `provider.js`, `codex-cli.js` or `headless.js`; session data is read through `host.js`;
no new MCP tool; degradation is a named `disabled` reason on both hosts; docs: README "Hosts" and "Everyday commands",
`docs/install.md` (Codex-only walkthrough, the Chat line at :102), `docs/plugin-smoke.md` items per host, `AGENTICOS.md`.

## 5. Out of scope (host-native by design, documented)

`~/.claude/agents` for the heartbeat (Codex has none); Claude Code housekeeping collectors (`runtime`, `folderAtlas`,
`projects`, orphan sweep); the `settings.json`/`CLAUDE.md` health check and the GSD collector; Claude Code cloud
routines vs Codex Automations; per-run dollar caps and tool allowlists under Codex (sandbox only, codex-parity D5);
`agenticos.json` living in `~/.claude`; the daily-note heading "Claude Code Sessions". Windows.

## 6. Testing

- Unit, per host (inject `AOS_HOST`, config, `deps`): provider role resolution matrix (claude only / codex only / both /
  neither / caps); `strictSchema` goldens and null-dropping; graph shim codex leg (argv, envelope, ledger row, cap
  refusal) and `semanticSkip` runner matrix; `aos status` cap per provider; upgrade candidate from a fake
  `marketplace list --json`; `rewriteBody` goldens; build test idiom regex.
- Rehearsals: `first-run.sh` (Claude only) and `codex-host.sh` (Codex only, now also `aos status` and a fake
  `graph build --semantic` through the fake codex).
- **Live, on this machine, with the owner's OK (≤ 10 `codex exec` calls, cents).** Done: `{type:'object'}` →
  `400 invalid_json_schema`; `{additionalProperties:false, required:[…], note: ["string","null"]}` → accepted,
  `{"answer":"ok","note":null}`, 19.3k input tokens of Codex's own overhead per call. To do: one reasoner answer, one
  graph chunk end to end.
