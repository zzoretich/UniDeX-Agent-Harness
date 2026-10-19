# UniDeX phase 2: agent sessions — plan

Spec: `docs/design/specs/2026-10-07-unidex-sessions-design.md` (approved 2026-10-07). There are three PRs, merged in order (S12), and release 1.2.0 comes after the last.

## PR 2a — runtime (`feat/unidex-sessions-runtime`)

- [x] **A1 `sessionArgs(host, opts)`** in `lib/headless.js`, beside `runnerArgs`, `crossArgs` and `seatArgs`.
  - Claude: `-p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits --permission-prompts none`. The first turn passes `--session-id <uuid>`, later turns `--resume <uuid>`. It adds `--allowedTools Bash` when commands are allowed, `--max-budget-usd <perTurn>`, and the model and effort.
  - Codex: `exec --json --skip-git-repo-check -c sandbox_mode="workspace-write" -c features.hooks=false -c approval_policy="never" [-m] [effort] -- <prompt>`. Later turns run `exec resume --json … <thread> -- <prompt>`.
  - Neither host reads stdin, and each has a test.
- [x] **A2 `lib/session-events.js`:** a streaming parser per host, turning raw JSONL into the spec §4.2 event, with the host session id, usage and cost. Claude cost comes from `result.total_cost_usd`; Codex cost is estimated from `turn.completed.usage` through `codex-pricing.js`. It has a test per host, on recorded-shape fixtures.
- [x] **A3 Caps (S6):** `sessions.perTurnUsd` (1.00) and `sessions.perDayUsd` (10.00). They go in `config.default.json`, `settings-schema.js` (with the picks and the `sessions` spend family) and `VAULT_CONFIG_DEFAULTS` in `aosConfig.ts`.
- [x] **A4 The `session:` ledger family:**
  - `spend-ledger.js`: `SESSION_ROWS` and `sessionSpendToday`, kept out of the hooks total.
  - `statusline-model.js` `FAMILY_OF` and the label in `statusline-render.js`.
  - `cli/aos.js`: `spendByFamily` and the cap that `aos status` shows.
- [x] **A5 `lib/sessions.js`,** the one entry point the app calls:
  - `args <json>` gates on the day cap and the host being ready, then prints `{ok, host, bin, argv, env, perTurnUsd}` or `{ok: false, reason}`.
  - `events --host <h>` is a stdin → stdout filter of normalised events.
  - `record <json>` appends `session:<host>` spend.
- [x] **A6:** amend the spec (§4.2 Codex events, S1 resume flags, S5, §5.5) and add the CHANGELOG line (the new caps show in Settings).

## PR 2b — app service (`feat/unidex-sessions-app`)

- [x] **B1 `app/src/main/services/sessions.ts`:**
  - Start, send, stop and list threads.
  - Each turn spawns `sessions.js args`, then the host's binary in `workspaces/<slug>`, then pipes its output through `sessions.js events`.
  - Events are written to `brain/_index/sessions/<slug>/<thread>.jsonl` and `agent-runs/live/<id>.ndjson`.
  - When a turn ends, it records spend and a `runs.jsonl` row.
  - Stop sends SIGTERM, then SIGKILL after 10 s.
- [x] **B2 Channels:** `session:start|send|stop|list` and the event `session:event` in `shared/ipc.ts`, the preload, zod schemas in `ipc/schemas.ts`, handlers through `ipc/trust.ts`, and the `sessions` surface in `shared/surfaces.ts` (`verified: false` until a live check).
- [x] **B3 Git** (`services/git.ts`): `git:status|diff|commit` for a workspace repo, with the refusals in §4.4.
- [x] **B4 Tests and docs:** unit tests on fake `claude`/`codex` scripts that replay fixtures, git on a temp repo, the `sandbox.spec.ts` lines for the new channels, and the `SECURITY.md` rows.

## PR 2c — UI (`feat/unidex-sessions-ui`)

- [x] **C1 `SessionsTab.ts`** replaces `ChatTab.ts`: threads per workspace (Vault first), the timeline, collapsed tool rows, the diff card with Review and Commit, the composer (host chip, model, workspace, **Allow commands**), Stop, and running dots. `ChatTab.ts` stays, as the Vault thread SessionsTab mounts in its reader; the rail tab keeps the id `chat`.
- [x] **C2 e2e:** a full turn per host on fakes, Stop, the diff card, Commit, the day cap, and a Codex-only vault. Also app-smoke items, `COVERAGE.md` rows and the README section.
- [x] **C3 Live check** (it spends; ask first): one turn per host on a real workspace, then set `verified: true` on the surface. Release 1.2.0 follows.

## File structure

| Path | Change | PR |
|---|---|---|
| `brain/scripts/lib/headless.js`, `test/headless.test.js` | `sessionArgs` | 2a |
| `brain/scripts/lib/session-events.js`, `test/session-events.test.js` | event normaliser | 2a |
| `brain/scripts/lib/sessions.js`, `test/sessions.test.js` | the app's entry point: args, events, record | 2a |
| `brain/scripts/lib/transcript.js` | export `kindOf` | 2a |
| `brain/scripts/sdk/lib/spend-ledger.js`, `lib/statusline-model.js`, `lib/statusline-render.js`, `cli/aos.js` | the `sessions` spend family | 2a |
| `brain/scripts/config.default.json`, `lib/settings-schema.js`, `hud/src/data/aosConfig.ts` | `sessions.*` caps | 2a |
| `app/src/main/services/{sessions,git}.ts`, `shared/{ipc,surfaces}.ts`, `preload/index.ts`, `main/ipc/*` | service and channels | 2b |
| `hud/src/views/SessionsTab.ts` (replaces `ChatTab.ts`), `styles.css` | the tab | 2c |
| `SECURITY.md`, `README.md`, `app/README.md`, `docs/app-smoke.md`, `app/tests/e2e/COVERAGE.md` | docs | 2b, 2c |
