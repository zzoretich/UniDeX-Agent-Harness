# UniDeX Sessions: host and model menus — plan

Spec: `docs/design/specs/2026-10-07-sessions-ux-design.md` (U1–U13).

## PR 3a — runtime and app (`feat/sessions-ux`)

Merged as PR #97.


- [x] A1 `lib/host-catalog.js`: Claude `initialize` (stream-json in and out, one control request, killed after the answer, 20 s), Codex `debug models` + config defaults + `debug prompt-input` skills; drop the account block; aliases as the fallback (U4, U5). Tests per host on recorded answers.
- [x] A2 `sessions.js catalog [--refresh] [--host h]` writes `brain/_index/host-catalog.json`, answers from it under 24 h.
- [x] A3 `headless.js` `sessionArgs`: `access` read/edit/run per host (U7), `allowCommands` → `run`; session effort lists per host (Codex adds `max`, `ultra`); refuse read + Bash. Tests per host and level.
- [x] A4 `sessions.js plan`: pass `access`; `args` refusals name the level.
- [x] A5 `session-events.js`: `plan` from Claude `TodoWrite` input and Codex `todo_list`; tests on both fixtures.
- [x] A6 `provider.js` `resolveProviderForRole({ prefer, model, effort })`; `ask.js --host --model --effort` (whole `--` flags only). Tests.
- [x] A7 App: `session:catalog` channel (ipc.ts, preload, trust, zod, policy), `start`/`send` gain `model`/`effort`/`access`, the prompt record carries them, a send without them reuses the thread's last. Unit tests with the fake CLIs.
- [x] A8 App: `git:status` per-file `added`/`removed` (`diff --numstat HEAD`, untracked line counts). Unit test on a temp repo.
- [x] A9 Surfaces: `sessions` runs `sessions.js catalog`; `chat` admits `ask.js --local --host … --model … --effort …` and Claude's five efforts. `write-policy.test.ts`, `sandbox.spec.ts` (+ `catalog`).
- [x] A10 `SECURITY.md` (read-only level, catalog channel), CHANGELOG `[Unreleased]`.

## PR 3b — the tab (`feat/sessions-ux-tab`, from 3a)

- [x] B1 `ui/HostModelMenu.ts` (Picker 2): host switch, search, models with older folded, efforts, custom id, source and ↻; thread mode with the host locked and **New session on <host>**.
- [x] B2 `ui/AccessMenu.ts` and `ui/SlashMenu.ts` (`/name` or `$name`, ↑↓↵, Esc).
- [x] B3 `SessionsTab.ts`: C's list (New session, Vault, folders → threads), B's reader (mono tool lines, Plan card, working line, model-change marker), Review changes drawer with counts, status line, Esc to stop.
- [x] B4 `ChatTab.ts`: the chip (any host per question), read-only chip, `runClaudeAsk` / `ask.js` with the choice.
- [x] B5 HUD settings: remember host, access, and per-host model and effort (U12).
- [x] B6 `styles.css` on the tokens (`check:hex`), `check:compat` for new icons and DOM helpers.
- [x] B7 e2e: picker, mid-thread change, access, slash per host, Vault per host, Codex-only vault; `docs/app-smoke.md` items per host + `COVERAGE.md`; README, `app/README.md`; screenshots (`npm run screens`).
- [ ] B8 Live check per host (spends; ask first), then release 1.3.0.

## File structure

| Path | Change | PR |
|---|---|---|
| `brain/scripts/lib/host-catalog.js`, `test/host-catalog.test.js`, `test/fixtures/catalog/*` | new: the host catalog | 3a |
| `brain/scripts/lib/sessions.js`, `test/sessions.test.js` | `catalog` verb, `access` | 3a |
| `brain/scripts/lib/headless.js`, `test/headless.test.js` | `sessionArgs` access levels, effort lists | 3a |
| `brain/scripts/lib/session-events.js`, `test/session-events.test.js` | `plan` events | 3a |
| `brain/scripts/sdk/lib/provider.js`, `sdk/ask.js`, their tests | `prefer`, model and effort for Vault | 3a |
| `app/src/shared/{ipc,surfaces}.ts`, `preload/index.ts`, `main/ipc/{schemas,trust}.ts`, `main/policy/*` | `session:catalog`, new fields, rules | 3a |
| `app/src/main/services/{sessions,git}.ts`, `app/tests/unit/*`, `app/tests/e2e/sandbox.spec.ts` | per-turn options, counts | 3a |
| `hud/src/host.ts`, `data/agentSessions.ts` (+ test) | catalog types, list grouping, tool lines | 3b |
| `hud/src/ui/{HostModelMenu,AccessMenu,SlashMenu}.ts` | new menus | 3b |
| `hud/src/views/{SessionsTab,ChatTab}.ts`, `styles.css`, `settings*.ts` | the tab, Vault, memory of choices | 3b |
| `app/tests/e2e/sessions*.spec.ts`, `variants.spec.ts`, `COVERAGE.md`, `docs/app-smoke.md` | e2e and smoke | 3b |
| `SECURITY.md`, `README.md`, `app/README.md`, `CHANGELOG.md` | docs | 3a, 3b |
