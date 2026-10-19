# Codex parity — implementation plan

Spec: `docs/design/specs/2026-09-22-codex-parity-design.md` · Branch `feat/codex-parity` · Base `7b6b429`

Each task lands as one commit with its tests. Tests: `npm test` (root) — `node --test cli/*.test.js`,
`npm test -w brain/scripts`. Rehearsal: `sh cli/rehearsal/codex-host.sh`.

## Phase 1 — host detection and registration (D1, D2, D7)

- [x] 1.1 `brain/scripts/lib/host.js`: `resolveHost({ env, payload, userConfig })` → `{ host, via }`;
      `currentHost(env, payload)` delegates. `test/host.test.js` chain matrix.
- [x] 1.2 (revised) callers pass the payload they parsed: `finishStop(input)`, `currentHost(env, input)`; the prologue never consumes stdin. Hooks that
      already parse stdin keep doing so (no behaviour change), `currentHost()` reads the stored payload.
- [x] 1.3 MCP server: `sdk/mcp-server.js` `wrap_session.sessionId` description → "session id of either
      host"; `auto-wrap.js` line 579 uses `host.currentHost(process.env, input)`.
- [x] 1.4 `cli/codex-host.js`: `--env AOS_HOST=codex` in the add command; `codexHostStatus().mcp`
      gains `stale`; `cli/aos.js` upgrade re-registers on `stale`; doctor row text.
      `cli/codex-host.test.js`, `cli/aos.test.js`.
- [x] 1.5 `heartbeat-writer.js`: gate `AGENTS_MD_DIR` listing on `hosts.claude.enabled !== false`.

## Phase 2 — reconcile stale sessions (D3, D6)

- [x] 2.1 `lib/transcript.js` `sessionModel(file, host)`; `test/transcript.test.js`.
- [x] 2.2 `sdk/lib/telemetry.js` `endRun` model backfill (transcript path from payload or `findTranscript`).
- [x] 2.3 `brain/scripts/reconcile-sessions.js` + `test/reconcile-sessions.test.js`
      (fixture live dir, stamp throttle, late SessionEnd no-op). `config.default.json`
      `telemetry.staleAfterMinutes`.
- [x] 2.4 Wire: `plugin/hooks/hooks.json` (SessionStart, Stop), `cli/codex-host.js` `HOOKS`,
      `plugin/bin/aos` case arm, `cli/plugin-manifests.test.js`.

## Phase 3 — headless runner (D4, D5)

- [x] 3.1 `brain/scripts/lib/headless.js`: `resolveRunner`, `runnerArgs`, `--resolve` CLI mode;
      `test/headless.test.js`. Config `routines.runner`, `persona.runner`.
- [x] 3.2 `routines/run-routine.js`: `deps.runner`, per-runner argv, codex stdin prompt, `report.provider`;
      `test/run-routine.test.js` codex leg.
- [x] 3.3 `persona/record-spend.js`: `--file` accepts the codex `--json` stream; `test/record-spend.test.js`.
- [x] 3.4 `persona/run-duty.sh`: resolve the runner, branch the exec line, `--dry-run` shows it.
- [x] 3.5 `cli/aos.js` doctor: `persona runner` / `routines runner` rows (host + bin, or why none).
- [x] 3.6 `cli/rehearsal/codex-host.sh`: runner row + one fake prompt routine under codex;
      `cli/fixtures/fake-codex.sh` answers `exec --json`.

## Phase 4 — docs

- [x] 4.1 README "Hosts": the three modes and what auto-detects what; runner note.
- [x] 4.2 `docs/install.md` Codex-only walkthrough; `docs/plugin-smoke.md` reconcile + runner items;
      `vault-template/AGENTICOS.md` `runner` line; `vault-template/brain/routines/README.md`.
- [x] 4.3 Manual verification on the owner's machine (2026-09-22, codex-cli 0.155.1): `aos upgrade --from-local` re-registered the MCP
      server with `AOS_HOST=codex` (doctor had shown it stale); three `codex exec` sessions with hooks on each ended with a
      `host: "codex"` row in `runs.jsonl` with `cost_usd` and the model — 0.155 fires SessionEnd on exec exit, unlike the
      0.144 spike; `reconcile-sessions --force` closed a dead Claude Code run (a killed session), costed and wrapped it.

## File structure

| Path | Change |
|---|---|
| `brain/scripts/lib/host.js` | `resolveHost`, detection chain |
| `brain/scripts/lib/hook-entry.js` | stored stdin payload |
| `brain/scripts/lib/headless.js` | new: runner resolution + argv |
| `brain/scripts/lib/transcript.js` | `sessionModel` |
| `brain/scripts/reconcile-sessions.js` | new hook script |
| `brain/scripts/heartbeat-writer.js` | Claude-dir gate |
| `brain/scripts/sdk/lib/telemetry.js` | model backfill |
| `brain/scripts/sdk/mcp-server.js`, `auto-wrap.js` | payload-aware host |
| `brain/scripts/routines/run-routine.js` | runner-aware prompt kind |
| `brain/scripts/persona/run-duty.sh`, `persona/record-spend.js` | runner-aware duty |
| `brain/scripts/config.default.json` | `telemetry.staleAfterMinutes`, `routines.runner`, `persona.runner` |
| `cli/codex-host.js`, `cli/aos.js` | MCP env, `stale` status, doctor rows |
| `plugin/hooks/hooks.json`, `plugin/bin/aos` | `reconcile-sessions` |
| `cli/rehearsal/codex-host.sh`, `cli/fixtures/fake-codex.sh` | runner leg |
| `README.md`, `docs/install.md`, `docs/plugin-smoke.md`, `vault-template/…` | docs |
