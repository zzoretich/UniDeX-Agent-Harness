# Codex plugin — implementation plan

Spec: `docs/design/specs/2026-09-23-codex-plugin-design.md` · Branch `feat/codex-plugin` · Base `6b372c5`

Each task lands with its tests. Tests: `npm test` (root). Rehearsal: `sh cli/rehearsal/codex-host.sh`.

## File structure

| Path | Change |
|---|---|
| `cli/codex-host.js` | `rewriteBody` / `commandToSkill` / `skillToCodex` / `generateSkills` take a `target` (`direct` \| `plugin`); plugin install / remove / status; `removeDirectWiring` |
| `tools/build-codex-plugin.js` (+ test) | generates `codex-plugin/`; `--check` compares the committed tree with a fresh build |
| `codex-plugin/**` | generated output (manifest, hooks, MCP, launcher, 21 skills) |
| `.agents/plugins/marketplace.json` | the Codex marketplace entry → `./codex-plugin` |
| `cli/aos.js` | init / upgrade / uninstall / doctor / status / checklist pick the Codex mode (D4, D5, D6) |
| `cli/fixtures/fake-codex.sh` | `plugin list\|add\|remove`, `plugin marketplace add\|upgrade\|remove`, `mcp list`; `FAKE_CODEX_NO_PLUGINS=1` |
| `cli/plugin-manifests.test.js`, `cli/codex-host.test.js`, `cli/aos.test.js` | new assertions for both modes |
| `cli/rehearsal/codex-host.sh` | plugin-mode leg, direct-mode leg |
| `tools/bump-version.js` (+ test) | the Codex manifest is a version surface (D7) |
| `package.json` | `build:codex-plugin` script |
| `README.md`, `docs/install.md` | install and host text |

## Phase 1 — the plugin (D1, D2, D3, D7)

- [x] 1.1 `cli/codex-host.js`: `target: 'plugin'` rewrites (`<plugin root>`, `$agenticos:<name>`, plugin host note and marker);
      `direct` output byte-identical to today. Tests.
- [x] 1.2 `tools/build-codex-plugin.js`: manifest, hooks, MCP, launcher copy, skills; `--check`. Test: committed = fresh,
      no absolute paths, 21 skills, no `${CLAUDE_PLUGIN_ROOT}`.
- [x] 1.3 Generate `codex-plugin/`, add `.agents/plugins/marketplace.json`, `npm run build:codex-plugin`.
- [x] 1.4 `cli/plugin-manifests.test.js`: Codex marketplace shape, manifest version, hooks ↔ `HOOKS`, launcher identical.
- [x] 1.5 `tools/bump-version.js`: write and check the Codex manifest; test.

## Phase 2 — installer (D4, D5, D6)

- [x] 2.1 `cli/codex-host.js`: `codexInstallMode`, `codexPluginInstalled`, `installCodexPlugin` (install and upgrade alike:
      idempotent, refreshes a git marketplace, `switchSource` for --from-local), `removeCodexPlugin`, `removeDirectWiring`,
      `trustedPluginHooks`, `codexPluginStatus` (installed, trusted n/15, MCP, direct leftovers). Tests with `fakeRun`.
- [x] 2.2 `cli/fixtures/fake-codex.sh`: plugin verbs with state, `mcp list --json`, `FAKE_CODEX_NO_PLUGINS`.
- [x] 2.3 `cli/aos.js`: init step 6b and upgrade choose the mode, record `hosts.codex.install`, remove direct wiring
      in plugin mode; uninstall removes plugin + marketplace + leftovers; doctor rows; status; checklist text.
- [x] 2.4 `cli/aos.test.js`: `--host both` in plugin mode; direct mode under `FAKE_CODEX_NO_PLUGINS=1`; migration
      from direct to plugin on upgrade.
- [x] 2.5 `cli/rehearsal/codex-host.sh`: plugin leg (hooks from `codex-plugin/hooks/hooks.json` run for real) and
      direct leg.

## Phase 3 — docs and verification

- [x] 3.1 README (install, 4b, commands, hosts, layout), `docs/install.md`.
- [x] 3.2 Real Codex in a sandboxed `CODEX_HOME`: install from the checkout, `hooks/list`, `mcp list`, skills list.
- [x] 3.3 `npm run gate`, `npm test`, both rehearsals, publish check.
