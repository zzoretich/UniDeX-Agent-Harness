# Codex parity gaps — plan

Spec: `docs/design/specs/2026-09-23-codex-parity-gaps-design.md`. Four slices, each its own PR off `main`, each
green on its own (`npm run gate`, `npm test`, both rehearsals). Order: A → B → C → D (B's `strictSchema` and C's shim
share `codex-cli.js`; C lands after B so it reuses the settled helpers).

## Slice A — text and routing (no model calls) · spec D6, D7, D10, finding 13–14

- [ ] `cli/codex-host.js` `rewriteBody`: `/agenticos:<name>`, " with the Read tool", `AskUserQuestion` + host-note line; tests
- [ ] `plugin/commands/aos.md`, `plugin/skills/cost/SKILL.md`, `plugin/commands/routines.md`: host-aware wording
- [ ] `plugin/skills/{feedback-review,persona-flag-closer,persona-sitrep}`: sources checked against the new rewrites
- [ ] `tools/build-codex-plugin.test.js`: idiom regex + routines cloud line stays Claude-specific; `npm run build:codex-plugin`
- [ ] `cli/aos.js` `status`: hook cap by resolved provider; `repoRoot` + Codex marketplace root; text at :955
- [ ] `cli/update-check.js`: `.codex-plugin/plugin.json`
- [ ] `CODEX_HOME` in `codex-cli.js`/`headless.js` `headlessEnv`, `run-duty.sh`, schedule templates
- [ ] runtime/HUD invocation strings: `auto-wrap.js:324`, `TodoTab.ts`, `commandRegistry.ts`, `cli/workspace.js:57`, `proposal-html.js:174`
- [ ] `ProposalsTab.ts` review button by host
- [ ] docs: README, `docs/install.md`, `docs/plugin-smoke.md`, `vault-template/AGENTICOS.md`

## Slice B — models under Codex · spec D1, D2, D5, D8

- [x] live probe (owner's OK): loose schema → 400 `invalid_json_schema`; strict-form schema accepted
- [ ] `codex-cli.js` `strictSchema()`, free-form JSON without a schema, null-dropping; `auto-wrap.js:472` structured for codex
- [ ] `codex.effort` (default `low`) for calls that pass no effort; `provider.js` `codexBudget`
- [ ] `provider.js` `resolveProviderForRole` codex leg with reasoner caps; `interactive.js` `localProvider`; `qwen.js` fallback
- [ ] `models.js` / `config.default.json`: `reasoner.codexModel`, `persona.codexModel`, `routines.codexModel`, `scan.*UnderCodex`
- [ ] `headless.js` `resolveRunner` kind model; `run-duty.sh` log line; `persona/interview.js` Codex model question
- [ ] `collectors/fileMap.js`, `collectors/workspaceInsights.js` codex opt-ins
- [ ] `cli/aos.js` status reasoner line; HUD Chat header label for codex; `docs/install.md:102`
- [ ] live: one reasoner answer through `ask.js --local` on a codex-only config

## Slice C — graph semantic pass under Codex · spec D3, D4

- [ ] `graph-claude.js` runner pick + codex leg (envelope, ledger, cap), `--help`/`--version` locally
- [ ] `graph-build.js` `semanticSkip`/`semantic`/`buildSemantic` runner-aware; `report.provider`
- [ ] `cli/graph-cmd.js` status text and consent prompt name the runner
- [ ] `config.default.json` `graph.semantic.runner`; `fake-codex.sh` `FAKE_CODEX_REPLY`
- [ ] tests: shim codex leg, gate matrix, end-to-end through fake graphify + fake codex; `codex-host.sh` leg
- [ ] live: one semantic chunk through the real Codex

## Slice D — cost and inventory by host · spec D9

- [ ] `auto-cost.js` backfill by run host; `PulseTab.ts` Fix Queue count
- [ ] `persona/scan-arsenal.js`, `build-playbook.js`, `interview.js`, `collectors/capabilities.js`: Codex skills and hooks
- [ ] HUD `SystemDrawer.ts` / `SidebarHUD.ts` counts include them

## File structure

| Path | Slice | Change |
|---|---|---|
| `cli/codex-host.js` | A | rewrite rules, host note |
| `plugin/commands/{aos,routines}.md`, `plugin/skills/{cost,feedback-review,persona-flag-closer,persona-sitrep}/SKILL.md` | A | wording |
| `codex-plugin/**` | A (B, C if sources change) | regenerated |
| `cli/aos.js`, `cli/update-check.js`, `cli/workspace.js` | A, B | status, upgrade, notice, text |
| `brain/scripts/sdk/lib/codex-cli.js` | A, B | `CODEX_HOME`, `strictSchema` |
| `brain/scripts/sdk/lib/provider.js`, `sdk/lib/interactive.js`, `sdk/lib/models.js` | B | reasoner codex leg |
| `brain/scripts/lib/headless.js`, `persona/run-duty.sh`, `persona/interview.js` | A, B | env, kind models |
| `brain/scripts/graph-claude.js`, `graph-build.js`, `cli/graph-cmd.js` | C | codex leg |
| `brain/scripts/auto-cost.js`, `auto-wrap.js`, `collectors/*`, `persona/{scan-arsenal,build-playbook}.js` | B, D | by host |
| `hud/src/views/{ProposalsTab,ChatTab,TodoTab,PulseTab,SystemDrawer,SidebarHUD}.ts`, `src/commandRegistry.ts` | A, B, D | host-aware |
| `brain/scripts/config.default.json` | B, C | new keys |
| `cli/fixtures/fake-codex.sh`, `cli/rehearsal/codex-host.sh` | B, C | reply knob, legs |
