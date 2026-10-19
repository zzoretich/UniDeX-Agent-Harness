# Model Stack Refresh — implementation plan

Spec: `docs/design/specs/2026-09-21-model-stack-refresh-design.md` · Branch: `feat/model-stack-refresh`

## Global constraints

- Node ≥ 20, CommonJS, zero new runtime dependencies, `node:test` + `node:assert/strict`.
- No network in tests. Every provider and `claude -p` seam is injected, as today.
- No `qwen3.5:4b` or `gpt-oss:20b` string survives anywhere in the tree when done
  (`git grep -nE 'qwen3\.5:4b|gpt-oss'` must print nothing).
- `npm run gate` clean; commits per task; no session trailers.

## File structure

| File | Change |
|---|---|
| `brain/scripts/sdk/lib/models.js` *(modify)* | New defaults (D1, D2); reasoner tag resolves env → `cfg.reasoner.model` → default; drop `BRAIN_REASONER_EFFORT` and the Stack C note; `providerFor` now load-bearing. |
| `brain/scripts/sdk/lib/provider.js` *(modify)* | `makeClaude(reason, { model, perCallUsd, perDayUsd, spendFilter }, deps)`; `getProviderForRole(role, feature)`; `reasonSpendToday`; hook exclusion `/^duty:|^reason:/`. |
| `brain/scripts/sdk/lib/spend-ledger.js` *(modify)* | Default `exclude` widened; `reasonSpendToday()` export. |
| `brain/scripts/sdk/lib/claude-cli.js` *(modify)* | `buildArgs` / `claudeCall` accept `effort`. |
| `brain/scripts/sdk/lib/qwen.js` *(modify)* | `reason()` default `chatFn` from the reasoner provider; fallback only when the global provider is Ollama; comment at line 52 loses the `4b` name. |
| `brain/scripts/sdk/lib/interactive.js` *(modify)* | `localProvider(feature, { role })`. |
| `brain/scripts/sdk/lib/ollama.js` *(modify)* | Header comment (default model) and the effort comment at line 49. |
| `brain/scripts/sdk/ask.js`, `sdk/reflect-week.js`, `sdk/consolidate-memory.js` *(modify)* | Resolve the reasoner provider; drop `noFallback` guard; ledger feature `reason:<name>`. |
| `brain/scripts/config.default.json` *(modify)* | `reasoner` block. |
| `brain/scripts/auto-wrap.js` *(modify)* | Comment at line 40 (`4b` → "the workhorse"). |
| `brain/scripts/test/live/test-models.js` *(modify)* | New defaults and `providerFor`. |
| `brain/scripts/test/live/test-reason.js`, `test-ollama-body.js`, `live/README.md` *(modify)* | Drop the gpt-oss legs; `test-reason.js` becomes a fallback-path check against the workhorse. |
| `brain/scripts/test/provider.test.js`, `claude-cli.test.js`, `spend-ledger.test.js`, `qwen.test.js` *(modify)* | Cases listed in spec §5. |
| `brain/scripts/test/workspaceInsights.test.js`, `wrap-queue.test.js`, `json-extract.test.js` *(modify)* | Fixture strings and one comment. |
| `cli/aos.js` *(modify)* | `status`: one `reasoner` line. |
| `cli/aos.test.js` or the status test that exists *(modify)* | Assert the line. |
| `hud/src/data/aosConfig.ts` *(modify)* | `reasoner` block in the config type and defaults. |
| `hud/src/views/ChatTab.ts` *(modify)* | Spawner choice by Claude-binary availability; header text; pass reasoner model/cap. |
| `hud/src/data/claudeAsk.ts` + `.test.ts` *(modify)* | `feature` parameter for the ledger row (`reason:chat`). |
| `extras/ollama/reason.js`, `local-code.js`, `delegate.sh`, `Oss.md` *(delete)* | D8. |
| `extras/ollama/model-pull.sh`, `extras/ollama/README.md` *(modify)* | Two tags; rows for the deleted files removed; `BRAIN_REASONER` no longer listed as an Ollama override. |
| `README.md` *(modify)* | Line 260 provider sentence gains the reasoner rule; badge/line 33 wording still true. |
| `docs/install.md` *(modify)* | Providers section: reasoner paragraph and the `reasoner` config block. |
| `docs/acceptance.md` *(modify)* | Line 33 pull command (two tags); line 68 header text. |
| `docs/plugin-smoke.md` *(modify)* | Chat item names the new header. |

## Tasks

### Task 1 — Role table and config
- [ ] `models.js`: new defaults, reasoner config lookup, remove effort kill-switch and Stack C note.
- [ ] `config.default.json`: `reasoner` block.
- [ ] `test/live/test-models.js` updated and passing (`node brain/scripts/test/live/test-models.js`).
- [ ] Commit: `feat(models): qwen3.5:9b workhorse, claude-opus-5 reasoner`.

### Task 2 — Spend ledger and provider routing
- [ ] `spend-ledger.js`: widen default exclusion; add `reasonSpendToday`.
- [ ] `provider.js`: parameterised `makeClaude`; `getProviderForRole`; export both helpers.
- [ ] `claude-cli.js`: `effort` flag.
- [ ] Tests: `provider.test.js`, `spend-ledger.test.js`, `claude-cli.test.js`.
- [ ] Commit: `feat(provider): per-role routing and a metered reasoner cap`.

### Task 3 — reason() and its callers
- [ ] `qwen.js`: reasoner provider as default `chatFn`; fallback rule; comment cleanup.
- [ ] `interactive.js`: `localProvider(feature, { role })`.
- [ ] `ask.js`, `reflect-week.js`, `consolidate-memory.js`: switch to the reasoner provider, feature names.
- [ ] `qwen.test.js` fallback case; `test-reason.js` reshaped.
- [ ] Commit: `feat(reason): route the reasoner role through Claude`.

### Task 4 — Purge the retired tags
- [ ] Delete the four extras; rewrite `model-pull.sh` and `extras/ollama/README.md`.
- [ ] Fixture and comment edits in `auto-wrap.js`, `ollama.js`, `qwen.js`, the three test files, `live/README.md`, `test-ollama-body.js`.
- [ ] `git grep -nE 'qwen3\.5:4b|gpt-oss|gemma4|BRAIN_REASONER_EFFORT'` prints nothing.
- [ ] Commit: `chore: drop qwen3.5:4b and gpt-oss:20b from the tree`.

### Task 5 — Status line
- [ ] `cli/aos.js` `status`: `reasoner  <model> (claude)  today $x / cap $y`.
- [ ] Test asserting the line with a seeded ledger.
- [ ] Commit: `feat(status): show the reasoner model and spend`.

### Task 6 — HUD
- [ ] `aosConfig.ts` type + defaults; `ChatTab.ts` spawner choice and header; `claudeAsk.ts` feature param.
- [ ] `npm test -w hud` and `npm run build -w hud` green.
- [ ] `docs/plugin-smoke.md` Chat item.
- [ ] Commit: `feat(hud): chat follows the reasoner role`.

### Task 7 — Docs
- [ ] `README.md`, `docs/install.md`, `docs/acceptance.md`.
- [ ] Commit: `docs: two-model Ollama stack and the Claude reasoner`.

### Task 8 — Verify and publish
- [ ] `npm run gate` · `npm test` · `npm run build -w hud` · `sh cli/rehearsal/first-run.sh`.
- [ ] `publish-check.js` clean; push; PR; CI green; **merge decision**.

### Task 9 — Bring it home (machine side, after merge)
- [ ] `ollama rm qwen3.5:4b gpt-oss:20b`
- [ ] `ollama pull qwen3.5:9b`
- [ ] `aos upgrade --from-local ~/AgenticOS-Workbench && aos doctor`
- [ ] Run one `/wrap` and one `/ask-brain --local` and confirm `aos status` shows the reasoner line and a `reason:ask` ledger row.
- [ ] `/remember model stack: qwen3.5:9b workhorse, claude-opus-5 reasoner, gpt-oss retired #promote`
