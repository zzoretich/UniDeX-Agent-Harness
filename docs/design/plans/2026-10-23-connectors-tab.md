# Connectors tab: build plan

Spec: `docs/design/specs/2026-10-23-connectors-tab-design.md` (D1–D23, A1–A3), built on `feat/connectors-data` in the
worktree `connectors-data`. Three PRs, each shippable alone (D6): the data layer, the read-only tab, the actions.

## File structure

| File | PR | New / changed | What |
|---|---|---|---|
| `brain/scripts/lib/connectors/discover.js` | 1 | new | D7 sources per host → rows (§4.1); reuses `lib/import/mcp.js` readers and secret cleaning, `lib/skills.js` plugin enumeration |
| `brain/scripts/lib/connectors/plugins.js` | 1 | new | each enabled plugin's `.mcp.json` (flat or `{mcpServers}`) and Codex `.app.json`; `codexPluginRoot` variant that does not need `skills/` |
| `brain/scripts/lib/connectors/check.js` | 1 | new | D10/D11: `claude mcp list` parser, `codex mcp list --json`, SDK `Client` handshakes (stdio, streamable HTTP, SSE), concurrency and timeouts, single-flight lock |
| `brain/scripts/lib/connectors/usage.js` | 1 | new | D13: incremental tail read per transcript (offset cursor), server-key mapping, 30-day roll |
| `brain/scripts/lib/connectors/cache.js` | 1 | new | the three caches (§4.2), atomic writes, `mcp-servers.json` schema-1 rows (D14) |
| `brain/scripts/lib/import/mcp.js` | 1 | changed | export what discovery reuses; `writeServers` callers go through `cache.js` |
| `brain/scripts/scan-vault.js` | 1 | changed | discovery + usage on every scan (D8); no spawns |
| `brain/scripts/config.default.json`, `lib/settings-schema.js` | 1 | changed | `connectors.*` (D22) |
| `brain/scripts/test/connectors-*.test.js` | 1 | new | per host: discovery fixtures (every source, both `.mcp.json` shapes, trusted/untrusted Codex project, pending approval), parser fixtures for every `claude mcp list` label, handshakes against a fixture stdio server, usage mapping and cursors |
| `cli/mcp.js` | 1, 3 | changed | `list`, `check` (PR 1); `park`, `unpark`, `add`, `remove`, `login`, copy `--url` to Codex (PR 3) |
| `cli/mcp.test.js`, `cli/fixtures/fake-codex.sh`, a fake `claude mcp list` | 1, 3 | changed | each verb per host; the fakes learn `mcp list [--json]`, `mcp remove`, `mcp login`, `plugin disable` |
| `app/src/shared/surfaces.ts` | 1, 3 | changed | `BACKGROUND`: `mcp (list\|check) --json` (PR 1); the `mcp` surface's new argv rules, `verified: false` (PR 3) |
| `hud/src/data/aosConfig.ts` | 1 | changed | `VAULT_CONFIG_DEFAULTS.connectors` |
| `hud/src/data/connectorsModel.ts` (+ test) | 2 | new | parse the three caches, merge by name (D9), tiles, attention list, sparkline data, sheet model |
| `hud/src/views/ConnectorsTab.ts`, `hud/src/views/connectors/*.ts` | 2 | new | board, cards, sheet, states, the tab-scoped check timer |
| `hud/src/views/WorkbenchView.ts`, `hud/main.ts`, `hud/src/views/badges.ts` | 2 | changed | rail entry after Skills, `makeTab`, palette id, the badge (D5) |
| `hud/src/views/SkillsTab.ts`, `hud/src/data/mcpServers.ts` | 2 | changed | the MCP section becomes a link; copy offers move to the sheet |
| `hud/styles.css` | 2 | changed | `.aos-con-*` (D23) |
| `hud/src/tour/steps.json`, `steps.ts` `TOUR_TABS`, `whatsnew.json` | 2 | changed | `connectors` chapter (`since` = next minor), `skills.mcp` retargeted, a What's new card |
| `app/tests/e2e/connectors.spec.ts`, `harness.ts`, `variants.spec.ts`, `sandbox.spec.ts` | 2, 3 | new / changed | board, sheet, badge, Codex-only and Claude-only variants, check timer only while active |
| `app/scripts/make-fixture-vault.mjs` | 2 | changed | fixture caches for both hosts, a failing server, a connector per host, a built-in |
| `docs/app-smoke.md`, `app/tests/e2e/COVERAGE.md` | 2, 3 | changed | items per host; SK10–SK12 move to the tab |
| `SECURITY.md`, `README.md`, `CHANGELOG.md` | 1–3 | changed | new rules; "Everyday commands" `aos mcp`; `[Unreleased]` with tour markers |

## PR 1: data layer (`feat: find every MCP server and connector on both hosts, check them, count their use`)

- [ ] Spec and plan committed first (this file and the spec).
- [ ] `plugins.js` + tests: both `.mcp.json` shapes, `.app.json`, a disabled plugin, a newest-version pick with no `skills/`.
- [ ] `discover.js` + tests per host: user, local, project (approved, pending), plugin, account (from the last check, then `claudeAiMcpEverConnected` as `unverified`); Codex every TOML form, trusted vs untrusted project, plugin servers, plugin apps; secrets never in a row.
- [ ] `usage.js` + tests: Claude and Codex fixtures, key mapping (`plugin_*`, `claude_ai_*`), cursor resume after an append, truncation (smaller file) resets, window roll.
- [ ] `check.js` + tests: the parser on every label (✔, `! Connected · tools fetch failed`, `! Needs authentication`, ✘ with reason, ⏸ pending, unknown); handshakes against a fixture stdio server (ok, slow → timeout, crash → failed); D11 refusals; lock busy; a host CLI missing.
- [ ] `cache.js`: the three caches, and `mcp-servers.json` byte-identical to today's for the same input.
- [ ] `scan-vault.js` runs discovery + usage; timing stays within the scan's budget on a large transcript set (measure: 946 files took 4 s cold; warm should be < 200 ms).
- [ ] `aos mcp list --json`, `aos mcp check --json`; `BACKGROUND` rules; `connectors.*` keys in all three places.
- [ ] Verify: gate, `npm test`, lint, typecheck, `changelog check`, parity `--wip --rehearse`, app checks (surfaces changed).
- [ ] Live, read-only: `aos mcp list --json` and `check --json` against this Mac's real hosts; the rows match `claude mcp list` and `codex mcp list --json`.

## PR 2: read-only tab (`feat: a Connectors tab: what works, what's broken, what's used`)

- [ ] `connectorsModel.ts` + unit tests (merge, tiles, attention, never checked, a host missing, Codex-only).
- [ ] Board, cards, sheet, folded rows, states; the check on mount and every `checkEveryMin` while `isTabActive("connectors")`; Check now.
- [ ] Rail entry, palette id, `TOUR_TABS`, `harness.ts` `RAIL_SECTIONS`, the badge.
- [ ] Skills' section → the link; `skills.mcp` retargeted; the `connectors` tour chapter; What's new entry.
- [ ] E2E: board, sheet, badge, timer gating, both variants; screenshots (`npm run screens`) if the README shows the tab.
- [ ] Smoke items per host; COVERAGE rows.

## PR 3: actions (`feat: park, add, remove and sign in to MCP servers from Connectors`)

- [x] A1–A3 answered and recorded in the spec (A2 checked: yes, Claude Code 2.1.310).
- [x] `aos mcp park|unpark|add|remove` with dry run → hash → `--expect`; stash and backups under `~/.local/share/unidex/` with `ownDir`; refusals (own server, plugin rows per D17, connectors, host off). No `login` verb (spec §8).
- [x] Copy: `--url` to Codex; moved into the sheet.
- [x] Surface rules (`verified: false`, on a new `mcp-manage` surface: spec §8), `sandbox.spec.ts` unchanged (no new channel), e2e for every confirm (`connectors-writes.spec.ts`), SECURITY.md rows.
- [ ] Live check per host before merge (ask first): park and turn back on a throwaway server on each host; add and remove one with a `$VAR` secret; `codex mcp login` on an OAuth test server if one is available.

## Release (when asked)
After PR 2 (the tab is user-visible) or after PR 3. The next minor; `whatsnew.json` entry; the §8 update proof.

## Risks
- **Spawning user servers.** The check starts every server the host would (user-approved, D10/D11). A server with side effects on start runs once per check; the 15-min cadence only while the tab is open bounds it.
- **`claude mcp list` text changes.** Labels are parsed by glyph with the raw text kept; an unknown label becomes `unknown`, never a failure; fixtures pin 2.1.310.
- **Version skew.** An older app reads `mcp-servers.json` (kept, D14); a newer app on an older runtime finds no `connectors*.json` and shows "Update the runtime" (the app's upgrade offer).
- **Secrets.** Discovery rows and check details pass the existing cleaners; the check holds full entries in memory only; tool summaries are capped and scrubbed.
