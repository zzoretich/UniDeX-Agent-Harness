# Codex parity — one vault, either host, auto-detected — design

Date: 2026-09-22 · Branch: `feat/codex-parity` · Verified against `7b6b429`

## 1. Problem

Codex CLI became a session host in 0.5.0 (`docs/design/specs/2026-09-21-codex-compat-design.md`):
`aos init --host codex|both` wires hooks, the MCP server and generated skills; the runtime reads
either transcript format; telemetry stamps `host`. Six holes remain between that and the promise
"the whole system works the same whether you run Claude Code only, Codex only, or both":

1. **Host detection is env-only.** `host.currentHost()` returns `claude` unless `AOS_HOST=codex`,
   and only the hook commands set it. The Codex MCP registration passes `AOS_CONFIG` but not
   `AOS_HOST`, so `wrap_session` called from a Codex session resolves the *Claude* transcript
   directory. Any `aos` verb or generated skill run from inside a Codex session is misread the
   same way. On a Codex-only machine the config already says which host exists, but nothing reads it.
2. **Codex sessions are never finalized under `codex exec` or the desktop app.** The 0.144
   spike showed `SessionEnd` does not fire on exec exit (0.155 does, verified 2026-09-22) and fires late
   (thread close / 30 min idle) in the TUI. Everything that runs at SessionEnd — telemetry summary, auto-cost, auto-wrap memory
   extraction, `scan-vault` — silently never happens for those sessions; crashed runs are only
   *dropped* by the HUD orphan sweep, never wrapped.
3. **Prompt routines and persona duties require the `claude` CLI.** `routines/run-routine.js`
   (`prompt` kind) and `persona/run-duty.sh` spawn `claude -p` directly, bypassing the provider
   layer that already knows `codex exec`. A Codex-only machine has no Chief of Staff and every
   `prompt` routine records a failed run.
4. **Claude runs record `model: null`** because Claude Code's hook payload rarely carries a model;
   the transcript does. "Which LLM ran this session" is answerable today only for Codex.
5. **`heartbeat-writer.js` reads `<claude config dir>/agents`** unconditionally, a Claude-only
   directory, from a hook Codex also fires.
6. **Existing Codex installs keep the old MCP registration** after upgrade because the installer
   skips `codex mcp add` whenever a registration already names the launcher.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | `host.js` grows a **detection chain** behind the existing `currentHost()`: `AOS_HOST` (authoritative, unchanged) → `CLAUDE_PROJECT_DIR` / `CLAUDECODE` env → `claude` → the hook payload's `transcript_path` (basename `rollout-*.jsonl`, or inside `hostDirs('codex').sessions` / `archived`) → `codex` → `agenticos.json` `hosts` with exactly one enabled host → that host → `claude`. New `resolveHost({ env, payload, userConfig })` is pure; `currentHost(env, payload)` keeps its signature. Hooks, `auto-wrap`, `auto-cost` and the MCP server pass the payload they already hold. | Keep env-only detection (0.5.0 D2). | D2's reason was determinism, and it stays: `AOS_HOST` still wins and every fallback is an injected value with a golden test. The fallbacks only fire where nothing sets `AOS_HOST` today — the MCP server, interactive `aos` verbs, Codex-only machines — which is exactly the user-visible "auto-detect" gap. |
| D2 | The Codex **MCP registration carries `AOS_HOST=codex`** (`codex mcp add agenticos --env AOS_CONFIG=… --env AOS_HOST=codex -- …`). `codexHostStatus()` parses `codex mcp get agenticos --json` and reports `mcp: 'stale'` when the env lacks it; `aos upgrade` re-registers (remove + add) on `stale`; `aos doctor` shows a warn row with the fix command. | Rely on D1's config fallback alone. | On a *both* machine the config names two hosts, so only the registration can say which one spawned the server. |
| D3 | A new hook script **`reconcile-sessions`** (SessionStart and Stop on both hosts, detached, ≤1 run per 5 min via a mtime stamp in `brain/_index/agent-runs/.reconcile`) finalizes **stale live runs**: every `live/<id>.ndjson` whose header and transcript are both older than `telemetry.staleAfterMinutes` (default 30, Codex's own idle window) gets the SessionEnd pipeline for its recorded host — `endRun(id, 'reconciled')`, then `auto-cost` and `auto-wrap` for that session id with `AOS_HOST` set from the header. `endRun` already returns when the live file is gone, so a late real `SessionEnd` is a no-op; auto-cost's numeric-cost check and auto-wrap's ledger keep both idempotent. | A per-Stop detached debounce timer; or Codex's `notify` hook. | A sleeping process per session dies with the machine and multiplies under the desktop app; `notify` fires on turn end only, the same signal as Stop. A sweep keyed on what is already on disk needs no new state and also heals Claude sessions whose terminal was killed. |
| D4 | A **host-neutral headless runner**, `brain/scripts/lib/headless.js`: `resolveRunner(cfg, { env, lookup })` → `{ host, bin, reason }`, preferring `claude` when `hosts.claude.enabled` and a binary resolves, else `codex` on the same test, overridable by the new config keys `routines.runner` and `persona.runner` (`auto` \| `claude` \| `codex`). `run-routine.js` builds the argv per runner (`codex exec - --json -o <out> -m <model> -s workspace-write -C <vault> --skip-git-repo-check --ephemeral -c features.hooks=false`, prompt on stdin, `AOS_HEADLESS=1`); `run-duty.sh` asks `node lib/headless.js --resolve` for `host<TAB>bin` and branches the one `exec` line; `record-spend.js --file` detects the codex `--json` stream and prices it through `codex-pricing.js`. `--dry-run` prints the resolved command for either runner. | Port `run-duty.sh` to Node; or route duties through `provider.js`. | The shell script carries the audited kill switch, caps and journal contract (amendments A24, A25, A50); replacing one spawn line keeps that intact. `provider.js` is a one-shot Q&A seam without tools, cwd or a budget flag, not an agent runner. |
| D5 | Budget semantics under the codex runner are **estimated, post-hoc**: Codex has no `--max-budget-usd`; the daily caps (`routines.perDayUsd`, `persona.perDayUsd`) still gate *starting* a run, and each run's estimated cost is ledgered from `turn.completed.usage`. The tools allowlist becomes the sandbox mode only (`workspace-write`, never `danger-full-access`). The doctor row and the routine file's README say so. | Refuse to run duties on Codex. | "Codex only" means the Chief of Staff exists there. Estimated spend with a hard daily gate is the same guarantee `auto-cost` already gives Codex sessions (0.5.0 D8). |
| D6 | **Model backfill**: `lib/transcript.js` exposes `sessionModel(file, host)` (first assistant `message.model` for Claude, `turn_context` / `session_meta` for Codex); `telemetry.endRun()` fills a null header model from it, and `runs.jsonl` / the day summary carry it. | Add a Claude PreToolUse model sniff. | The transcript is authoritative and already open at SessionEnd. |
| D7 | `heartbeat-writer.js` **gates the Claude agents directory** on `hosts.claude.enabled` (default true when the key is absent, so old configs are unchanged). | Read both hosts' agent dirs. | Codex has no equivalent directory. |
| D8 | Docs state the **three modes** explicitly: README "Hosts" (Claude only / Codex only / both, what auto-detects what), `docs/install.md` Codex-only walkthrough including the runner rows, `docs/plugin-smoke.md` items for reconcile and the runner, `vault-template/AGENTICOS.md` one line on `runner`. | Leave the 0.5.0 wording. | The user-facing promise is the feature. |

## 3. What already exists (at `7b6b429`)

- `brain/scripts/lib/host.js` (`currentHost`, `hostDirs`, `findTranscript`, `codexHome`) — D1 extends it in place.
- `cli/codex-host.js` (`installCodexHost` / `removeCodexHost` / `codexHostStatus`, `run` seam, `codex mcp get --json` parsing) — D2 touches the MCP step only.
- `brain/scripts/telemetry-hook.js` `ensureHeader` / `endRun`, `sdk/lib/telemetry.js` `LIVE_DIR` — D3's inputs; `lib/detach.js` `respawnDetached()` is the detach prologue every hook uses.
- `brain/scripts/auto-wrap.js` (`findTranscript` fallback, ledger), `auto-cost.js` (`costOne(sessionId, transcript, host)`, "numeric cost = already costed") — D3 calls them per session.
- `brain/scripts/sdk/lib/codex-cli.js` (`resolveCodexBin`, `buildArgs`, `headlessEnv`, `parseEvents`), `codex-pricing.js`, `claude-cli.js` `resolveClaudeBin` — D4/D5 compose these.
- `brain/scripts/routines/run-routine.js` (`deps` seam, `promptArgs()`, `rowFrom`), `persona/run-duty.sh`, `persona/record-spend.js` — D4's call sites.
- `brain/scripts/lib/transcript.js` `detectFormat` / `parseClaude` / `parseCodex` — D6 adds one reader.
- `cli/aos.js` `doctor()` host rows, `upgrade()` Codex re-wire at `cli/aos.js:963`; `cli/fixtures/fake-codex.sh`; `cli/rehearsal/codex-host.sh`.

## 4. Design

### 4.1 Host detection (`lib/host.js`)
`resolveHost({ env, payload, userConfig })` returns `{ host, via }` with `via` ∈ `aos-host | claude-env | transcript | config | default`. `currentHost(env, payload)` returns `.host`. Every caller passes the payload it already parsed (`telemetry-hook`, `auto-wrap`, `auto-cost`, `finishStop(input)`); the MCP server passes nothing and relies on its registration env; `AOS_DEBUG=1` prints `via` on stderr. (Implementation note: storing the payload in `hook-entry.js` was dropped because the prologue must not consume stdin before the hook script reads it.)

### 4.2 Installer (`cli/codex-host.js`, `cli/aos.js`)
`mcpAddArgs()` gains `--env AOS_HOST=codex`. `codexHostStatus().mcp` ∈ `ok | missing | stale | foreign`. `upgrade()` treats `stale` like `missing` (remove, add). Doctor row text: `codex MCP declared … (env lacks AOS_HOST — run: aos upgrade)`.

### 4.3 Reconcile (`brain/scripts/reconcile-sessions.js`)
Hook prologue → `respawnDetached()` → stamp check → for each stale live header: `endRun`, then `require('./auto-cost.js').costOne(id, transcript, host)` and `require('./auto-wrap.js')`'s per-session entry with `process.env.AOS_HOST = header.host`. Config `telemetry.staleAfterMinutes` (default 30). Both `plugin/hooks/hooks.json` and the Codex `HOOKS` table add it to SessionStart and Stop; `plugin/bin/aos` and `cli/plugin-manifests.test.js` follow.

### 4.4 Headless runner (`lib/headless.js`, `routines/run-routine.js`, `persona/run-duty.sh`, `persona/record-spend.js`)
`resolveRunner` as in D4; `runnerArgs(runner, { prompt, model, effort, tools, budget, outFile, cwd })` returns `{ argv, stdin }`. `run-routine.js` `deps.runner` replaces `deps.claudeBin`; `report.provider` becomes the runner host. `run-duty.sh`: `RUNNER="$($NODE $VAULT/brain/scripts/lib/headless.js --resolve)"`, then one `case` around the existing `exec`. `record-spend.js`: `--file` sniffs `{"type":"turn.completed"` and prices with `codex-pricing.js`.

### 4.5 Model backfill (`lib/transcript.js`, `sdk/lib/telemetry.js`)
`sessionModel(file, host)`; `endRun` calls it when `header.model` is null and a transcript path is known (from the SessionEnd payload or `findTranscript`).

### 4.6 Config defaults (`config.default.json`)
`telemetry.staleAfterMinutes: 30`, `routines.runner: "auto"`, `persona.runner: "auto"`.

## 5. Testing

- `test/host.test.js`: the full chain with injected env/payload/config; `AOS_HOST` beats a Codex transcript path; both-hosts config without hints → `claude`.
- `cli/codex-host.test.js`: `mcpAddArgs` includes `AOS_HOST`; status `stale` from a fake `mcp get --json` lacking it; upgrade re-adds.
- `test/reconcile-sessions.test.js`: fixture live dir with fresh and stale headers; only stale ones end; a late `SessionEnd` is a no-op; stamp throttles a second run.
- `test/headless.test.js`: runner resolution matrix (claude only, codex only, both, override, neither → error), argv goldens for both runners; `run-routine.test.js` prompt kind under codex (fake spawn); `record-spend` codex stream pricing.
- `test/transcript.test.js`: `sessionModel` on both fixtures; `telemetry` backfill.
- `cli/rehearsal/codex-host.sh`: doctor shows the runner row and the MCP env; a fake `codex exec --json` prompt routine runs.
- Manual on this machine: one real `codex exec` session, then `reconcile-sessions` → a `host: codex` row in `runs.jsonl` and a wrapped session.

## 6. Out of scope

- The HUD Chat tab still spawns `claude -p` (Codex-only shows it disabled, as today).
- A Codex plugin bundle; importing Codex's built-in memories; Windows.
- A Claude-side `inject-conventions` hook (the `@` line in CLAUDE.md stays the Claude rule).
- Enforcing a per-run dollar cap inside Codex (not offered by `codex exec`).
