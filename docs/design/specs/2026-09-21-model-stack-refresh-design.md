# Model stack refresh — design

Date: 2026-09-21 · Branch: `feat/model-stack-refresh` · Verified against `ef48a73`

## 1. Problem

The brain runs a three-role model stack (`brain/scripts/sdk/lib/models.js`): a
*workhorse* for every background hook, a *reasoner* for the interactive deep-Q&A
commands, and an *embedder* for hybrid recall. Two of the three defaults are being
retired:

- **Workhorse `qwen3.5:4b`** has a record of drifting from JSON and paraphrasing
  around instructions (see the "live incident" comments in `auto-wrap.js` and
  `update-session.js`). The next size up, `qwen3.5:9b`, is the replacement.
- **Reasoner `gpt-oss:20b`** is being dropped entirely. The reasoner role moves to
  **Claude Opus 5** through the existing headless `claude -p` path. This is the first
  role that is *not* served by the global provider: the workhorse and embedder stay on
  Ollama while the reasoner is always Claude.

Both retired tags are removed from the machine (`ollama rm`) and from every file in the
repository.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | Workhorse default becomes `qwen3.5:9b` in `models.js`; every `4b` reference goes. `BRAIN_MODEL` env override stays. | A new `ollama.workhorse` config key with the 4b default kept. | The owner chose a straight replacement. The env override already covers per-machine deviation. |
| D2 | Reasoner default becomes the pinned id `claude-opus-5`, served by the `claude` provider regardless of `provider` mode. | The floating alias `opus`. | "Opus 5.0" was specified; a pinned id does not silently move when a newer Opus ships. |
| D3 | Per-role provider routing: `provider.js` gains `getProviderForRole(role, feature)`. Roles whose `providerFor()` is `claude` get a Claude provider instance built with the role's model and caps; everything else falls through to today's `getProvider()`. | Make the global `auto` chain prefer Claude. | Background hooks must stay local and free. Only the reasoner should pay. |
| D4 | New config block `reasoner: { model, perCallUsd, perDayUsd, effort }` with its own ledger prefix `reason:*`, excluded from the `claude.perDayUsd` hook cap the same way `duty:*` already is. | Reuse `claude.perCallUsd` (0.05). | An Opus answer over a 16K-token vault context exceeds five cents; the `--max-budget-usd` flag would kill every call. Duties already prove the separate-cap pattern. |
| D5 | `claude-cli.js` passes `--effort <low|medium|high>` when the caller supplies one; `reason()` supplies `thinkFor('reasoner', effort)`. | Drop the effort dial. | The CLI supports the flag (the duty runner already uses it) and the dial keeps its meaning for ask / reflect / consolidate. |
| D6 | Fallback: when the reasoner's Claude provider is unavailable (no binary, not logged in, daily cap) `reason()` falls back to the workhorse on Ollama, as it does today, unless `noFallback`. | Fail hard. | Interactive commands should degrade, not die, exactly as the current code comment promises. |
| D7 | HUD Chat tab always treats a question as a reasoner call: `runClaudeAsk` with the reasoner model and caps when a Claude binary resolves, else `runAsk` (which routes through the same fallback). The header names the actual model. | Keep choosing by the global provider name. | Under `auto` the global provider is `ollama` on any machine with Ollama, which would silently route chat to the 9b workhorse. |
| D8 | Delete the local-reasoner helpers in `extras/ollama/` (`reason.js`, `local-code.js`, `delegate.sh`, `Oss.md`) and their README rows. `model-pull.sh` pulls two tags. `wrap-headless.js` stays (workhorse only). | Repoint them at Claude. | They exist only to talk to a *local* reasoner directly; repointed, they would duplicate `ask.js --local` and belong nowhere under `extras/ollama`. |
| D9 | Remove the `BRAIN_REASONER_EFFORT` env and the "Stack C / gemma4" fallback note. `BRAIN_REASONER` survives as an env override of the Claude model id (e.g. `sonnet`). | Keep the effort kill-switch. | It existed only for local models without think-level support. |
| D10 | `aos status` prints a `reasoner` line (model, provider, today's `reason:*` spend against its cap) beside the existing hook and duty lines. | Leave status alone. | Three ledgered budgets with only two visible would hide the most expensive one. |

## 3. What already exists (at `ef48a73`)

- `models.js:18-25` — `DEFAULTS` with a `provider` field per role and an unused
  `providerFor()` export: the hook for D3 is already there.
- `provider.js:65-87` — `makeClaude()` builds a chat provider from `cfg.claude.model`
  and `cfg.claude.perCallUsd`, ignores `opts.model`, and checks `spendToday()` against
  `cfg.claude.perDayUsd`. It only needs to take those four values as parameters.
- `spend-ledger.js:62` — `spendToday(now, { exclude = /^duty:/ })`: the exclusion
  pattern is already a parameter.
- `claude-cli.js:61-67` — `buildArgs()` is the single place `claude -p` flags are
  assembled; `--effort` slots in beside `--model`.
- `qwen.js:149-172` — `reason()` already takes `chatFn` and `effort` and already falls
  back to the workhorse on error.
- Callers of `reason()`: `sdk/ask.js:126`, `sdk/reflect-week.js:112`,
  `sdk/consolidate-memory.js:83`, each via `localProvider()` in `sdk/lib/interactive.js:44`.
- `hud/src/views/ChatTab.ts:126,198,353-355` — provider-name branch and the
  hard-coded header text `headless claude (haiku, capped)`.
- `persona/run-duty.sh` — its own `claude -p` spawn with `--effort`; untouched here.
- Tags referenced today: `qwen3.5:4b` in 12 files, `gpt-oss:20b` in 10 (see the plan's
  File Structure table).

## 4. Design

### 4.1 Roles (`models.js`)

```js
workhorse: { tag: 'qwen3.5:9b',   env: 'BRAIN_MODEL',    provider: 'ollama', keepAlive: -1,   effort: false, numCtxCap: 32768 },
reasoner:  { tag: 'claude-opus-5', env: 'BRAIN_REASONER', provider: 'claude', keepAlive: null, effort: true,  numCtxCap: null },
embedder:  { tag: 'qwen3-embedding:0.6b', env: 'BRAIN_EMBEDDER', provider: 'ollama', keepAlive: -1, effort: false, numCtxCap: null },
claude:    { tag: 'haiku', env: 'AOS_CLAUDE_MODEL', provider: 'claude', ... }   // unchanged: the hook fallback
```

`role('reasoner').tag` resolves env → `cfg.reasoner.model` → default, mirroring how
`claude.model` overrides the `claude` role today. `thinkFor('reasoner', effort)` keeps
returning `'low' | 'medium' | 'high'` (default from `cfg.reasoner.effort`).

### 4.2 Provider routing (`provider.js`)

```
getProviderForRole(role, feature)
  providerFor(role) === 'claude'
    → resolve binary + login probe (same cached chain as auto, Ollama step skipped)
    → makeClaude(reason, { model: role tag, perCallUsd: cfg.reasoner.perCallUsd,
                           perDayUsd: cfg.reasoner.perDayUsd, ledger: /^reason:/ })
    → not resolvable or over cap → makeNone(reason)
  otherwise → getProvider(feature)
```

`makeClaude` gains a `{ model, perCallUsd, perDayUsd, spendFilter }` argument; the
hook-path call site passes the `claude.*` values and `/^duty:|^reason:/` as the exclusion
so the hook cap ignores both metered families. A `reasonSpendToday()` helper sums
`reason:*` rows for the status line.

### 4.3 `reason()` (`qwen.js`)

Unchanged signature. Default `chatFn` becomes the reasoner provider's `chat` (with
`feature: 'reason:<caller>'` and `effort`), replacing the bare Ollama `chat`. The
existing catch block falls back to the workhorse through the *global* provider only when
that provider is Ollama; otherwise it rethrows. Callers drop their
`noFallback: p.name !== 'ollama'` guard and call `localProvider(feature, { role: 'reasoner' })`.

### 4.4 Headless CLI (`claude-cli.js`)

`buildArgs` appends `'--effort', effort` when `effort` is one of the three levels.
`claudeCall` accepts `effort` and forwards it. The login probe is unchanged.

### 4.5 Config (`config.default.json`)

```json
"reasoner": { "model": "claude-opus-5", "perCallUsd": 0.5, "perDayUsd": 5.0, "effort": "medium" }
```

The two caps are a judgement call and are surfaced in the decisions table for review.

### 4.6 HUD (`hud/src`)

`ChatTab` reads `cfg.reasoner` (type widened in `readVaultConfig`). If
`this.plugin.claudeBin()` resolves it calls `runClaudeAsk` with the reasoner model and
per-call cap and ledgers `feature: "reason:chat"`; else `runAsk`. Header text becomes
`· claude (<model>, capped)` or `· local ask.js`.

### 4.7 Removals

Every `qwen3.5:4b` and `gpt-oss:20b` string in the repo, the four local-reasoner extras,
the `BRAIN_REASONER_EFFORT` handling, the Stack C comment. `model-pull.sh` and
`extras/ollama/README.md` describe a two-model Ollama stack.

### 4.8 Machine side (not in the repo)

```sh
ollama rm qwen3.5:4b gpt-oss:20b && ollama pull qwen3.5:9b
aos upgrade --from-local ~/AgenticOS-Workbench && aos doctor
```
Plus: delete `<claude config dir>/agents/Oss.md` if it was copied there, and unset any
`BRAIN_MODEL` / `BRAIN_REASONER*` exports in the shell rc files.

## 5. Testing

- `test/live/test-models.js`: new defaults, `providerFor('reasoner') === 'claude'`, env
  precedence, `thinkFor` unchanged.
- `test/provider.test.js`: `getProviderForRole` under each mode; reasoner cap trips on
  `reason:*` rows only; hook cap ignores `reason:*` and `duty:*`.
- `test/claude-cli.test.js`: `--effort` present only when supplied.
- `test/spend-ledger.test.js`: new exclusion pattern and `reasonSpendToday`.
- `test/qwen.test.js`: reasoner failure falls back to the workhorse only under Ollama.
- Fixture strings in `workspaceInsights.test.js`, `wrap-queue.test.js` move to `9b`.
- `hud`: `ChatTab` spawner choice and header; `claudeAsk` feature row.
- Manual: `docs/plugin-smoke.md` Chat item and `docs/acceptance.md` lines 33 and 68.

## 6. Out of scope

- Routing persona duties through `provider.js` (they keep their own spawn).
- A config key for the workhorse tag (D1).
- Changing the embedder, recall ranking, or the `claude` hook-fallback role.
- A version bump and release; the owner decides after merge.
