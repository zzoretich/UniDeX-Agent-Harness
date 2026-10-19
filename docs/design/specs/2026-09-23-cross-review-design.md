# cross-review and handoff (claudex-loop, integrated) — design

Date: 2026-09-23 · Branch: `feat/cross-review` · Verified against `b65346b` (v0.12.0) · Upstream:
`chaseai-yt/claudex-loop` at `8cf5e2c` (v2.1.0, MIT) · Decisions approved by the owner 2026-09-23 (D2 names, D3, D6,
D12 chosen in review)

## 1. Problem

A plan written in one host is reviewed, at best, by the same model that wrote it. claudex-loop fixes that for a user
with both CLIs: the host plans, the *other* provider reviews the plan with evidence, the host arbitrates, a builder
implements, and the provider that did not build inspects the final diff in a fresh session. An approval is bound to the
plan's SHA256 and an inspection to a fingerprint of the change, so an edit after either invalidates it. Its companion
`claudex-route` recommends who should handle a task and can run one scoped handoff.

Upstream ships this as four skills plus a 420-line Python runner (`skills/claudex-loop/scripts/runner.py`). Installed
beside AgenticOS as-is, it would work against the product rather than with it:

- **Our hooks fire inside its reviewer.** It runs `codex exec` without `-c features.hooks=false`, so the AgenticOS Codex
  plugin's SessionStart/Stop hooks run in every review and write the reviewer's turns into `BRAIN.md ## Last Session`.
- **Its sessions pollute the brain.** Review rounds resume a persisted session. Those rollouts and transcripts land in
  `~/.codex/sessions` and `<claude config>/projects`, where `collectors/hostSessions.js`, `reconcile-sessions.js`,
  `auto-cost.js`, `collectors/history.js` and `persona/reflect.js` read them as the user's own. Reflect would mine the
  host's rejected findings as corrections. No collector filters headless children today.
- **Nothing is ledgered or capped**, and there is no doctor row. It needs Python 3.10+ and finds binaries with
  `shutil.which`, ignoring the recorded `hosts.<h>.bin` and Codex home. Route has the model type the CLI command
  itself, which gives no isolation, timeout or ledger.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **Port, don't vendor.** Rewrite the runner in Node as `brain/scripts/cross-review/runner.js` on the existing seams. Rewrite the skills host-neutrally. Keep upstream's contracts: roles, the review schema and its validation, plan-hash approval, change fingerprint, clean-checkout build gate, no-commit builder, bounded rounds, no silent fallback. | Vendor `runner.py` and the skills; tell users to install the upstream plugin next to ours. | The seams already provide bin resolution, `strictSchema()`, event parsing, `headlessEnv()` and the spend ledger. Vendoring adds a Python requirement and keeps every problem in §1. |
| D2 | **Names (owner's choice):** `cross-review` (the loop) and `handoff` (route). Claude Code `/agenticos:cross-review` · `/agenticos:handoff`; Codex `$agenticos:…`; direct wiring `$cross-review` · `$handoff`. Runner `aos cross-review roles\|preflight\|review\|build\|inspect\|check\|handoff`. Config `crossReview`, spend family `cross-review:*`. The descriptions say "adapted from claudex-loop". Upstream's `codex-review` / `codex-build` aliases are dropped. | `claudex`, `claudex-loop` + `claudex-route`, `crosscheck`, `second-opinion`. | These names describe what the skills do, avoid the built-in `/review` and `/loop`, and don't collide with an upstream install in `~/.agents/skills/claudex-*`. `mode=review` and `builder=codex` already express the aliases. |
| D3 | **Stateless rounds (owner's choice).** Every review round is a fresh ephemeral session (`codex exec --ephemeral`, `claude -p --no-session-persistence`) carrying the plan, the prior round's findings and the host's dispositions. `--prior <result.json>` replaces `--resume`. The runner still refuses a prior from another provider, model, effort or plan path. | Upstream's persisted, resumed session, plus teaching five collectors to skip child sessions. | See §1. Every other AOS headless call is already ephemeral. The cost is that the reviewer re-reads files each round; Codex's ~20k-token overhead is mostly cached. |
| D4 | **argv lives in the seam.** `lib/headless.js` gains `crossArgs(host, { mode, schemaFile, outFile, model, effort, budget })`, where mode is `review`, `consult` or `build`. **Read-only modes (`review`, `consult`)**, Claude: upstream's live-tested isolation (`--safe-mode`, `--strict-mcp-config` with an empty config, `--tools`/`--allowedTools Read,Glob,Grep`, `--permission-mode dontAsk`, `--no-chrome`), plus `--json-schema` for `review` only, `--no-session-persistence` and `--max-budget-usd`. **Read-only modes**, Codex: `exec - --ephemeral --skip-git-repo-check -s read-only -c approval_policy="never"`, and `--output-schema` through `strictSchema()` for `review`. **Every Codex child, in every mode:** `features.plugins=false` (plugins carry the connectors and their MCP servers), each server `config.toml` declares off by name (`mcp_servers.<name>.enabled=false`, found by `codexMcpServers()`), `web_search="disabled"`, and the features `hooks`, `apps`, `browser_use`, `computer_use` and `image_generation` off. **Every Claude child:** an empty strict MCP config and `--no-chrome`. **`build`**: Claude `--permission-mode acceptEdits` with the user's own permissions; Codex `-s workspace-write`. Every child gets `headlessEnv()`. | The runner, or a skill, builds its own argv. | host-parity: never a hand-built argv. `AOS_HEADLESS=1` makes our hooks exit at once under both hosts, so even a builder with plugins loaded stays out of the brain. |
| D5 | **Host is explicit and generator-translated.** The source says `--host claude`; `rewriteBody` learns one idiom, `--host claude` → `--host codex`. The runner refuses when a strong `resolveHost()` signal (`AOS_HOST`, `CLAUDECODE`) disagrees. | Let the runner infer the host; have the model name it (upstream). | In a Codex shell nothing sets `AOS_HOST`, and a both-hosts config resolves to claude, so the "other" provider would be the host itself. |
| D6 | **Single-CLI users get a labelled same-provider review (owner's choice).** When the other CLI is missing or logged out, `preflight` says so and the skill offers `--same-provider`: a fresh, isolated session of the host's own CLI. Results carry `independence: "same-provider"` and the log says so. `check` rejects that approval for a build unless `--accept-same-provider` is passed. | Refuse outright; fall back silently. | Refusing leaves a Claude-only or Codex-only user with nothing. Falling back silently would claim independence that isn't there. |
| D7 | **Own spend family.** Ledger rows use feature `cross-review:<mode>`; `HOOK_EXCLUDE` gains `cross-review`; new `crossReviewSpendToday()`; the start is gated by `crossReview.perDayUsd`. Claude calls also get `--max-budget-usd crossReview.perCallUsd`; Codex spend is estimated afterwards through `codex-pricing.js`. `aos status` shows the family. | The hook cap; no cap. | One review would exhaust the $0.50 hook cap. The precedent is `graph:` (graphify D10). |
| D8 | **Config `crossReview`**: `enabled: true`, `claudeModel: null`, `codexModel: null`, `effort: null`, `perCallUsd: 3`, `perDayUsd: 10`, `timeoutSec: 600`, `rounds: 5`. `null` means the CLI's own default. Explicit skill arguments (`reviewer_model=…`, a handoff's chosen model) win. The global `provider` does not gate it: the user invokes it and names the CLIs. | Reuse `reasoner.*`; honour `provider: none`. | Keeps a model name per host (conventions). `provider` governs background calls, and `aos routines run` sets the same precedent. |
| D9 | **Artifacts in the vault, plans in the repo.** Each call writes `<vault>/brain/_index/cross-review/runs/<id>/` (prompt, argv, stdout, stderr, result.json), which the vault already ignores with `brain/_index/*`. It falls back to `os.tmpdir()` when that path would be inside the target repo. One `schema: 1` row per call goes to `brain/_index/cross-review/runs.jsonl`. `PLAN.md` / `PLAN-REVIEW-LOG.md` stay in the target repo (upstream default, overridable); the workspace hub already treats `PLAN.md` as a project marker. | tmp only; plans in the vault. | Runs outlive a reboot and give a later HUD view something to read. A project's plan belongs beside its code. |
| D10 | **The brain feeds the loop.** Recon calls `recall` and `feedback_rules` when the agenticos tools are available and adds hits, with their paths, to the assumptions ledger. The close suggests `/remember <decision> #promote`. Reviewers and delegates never get the agenticos MCP. | Auto-write memories from the log. | `/wrap` already extracts from the host session, so auto-writing would capture twice. Keeping MCP out of children is the isolation D4 relies on. |
| D11 | **Attribution.** `THIRD-PARTY-NOTICES.md` in each ported skill carries upstream's MIT notice, the notice for the adapted `CONTEXT-FORMAT.md` / `ADR-FORMAT.md` (cross-review only), the pinned commit `8cf5e2c`, and a list of what changed. The README credits upstream. Later upstream releases are ported by hand against the pin. | Track upstream as a submodule. | Zero dependencies; the port diverges on purpose (D3–D7, D13). |
| D12 | **`handoff` ships in v1 (owner's choice).** It ports `claudex-route`: role before model, the routing brief (under 200 words), and at most one handoff. Its candidate table stays close to upstream's (GPT-5.6 Luna and Terra, GPT-6 Astra, Claude Fable 5.1, Sonnet/Opus) under an "as of September 2026" line, and tells the model to check what the user's CLIs list before recommending. Not ported: the legacy grill skills, Windows paths. | Leave route for a later `/handoff`; derive the table from `models.js`. | The owner wants it now. A hand-kept table is the honest v1, and its date says when to refresh it. |
| D13 | **A handoff runs through the runner.** `aos cross-review handoff --host <h> --provider claude\|codex [--model m] [--effort e] --brief <file> [--write]`. It is read-only by default (`consult`: free-text reply, which must be non-empty). `--write` uses `build` permissions, the clean-checkout gate and the HEAD-unchanged check, and reports the changed files from a snapshot. The same provider as the host is allowed (delegating to a smaller model) and recorded as `independence: "same-provider"`. There is no plan approval and no retries; ledgered as `cross-review:handoff`. | Upstream: the model types the CLI command itself. | That gives no isolation, timeout, ledger or artifacts, and `parity-check.js` fails a literal `claude -p` in a Codex skill. |

## 3. What already exists (at `b65346b`)

- `lib/headless.js`: `resolveBin()` (recorded bin → PATH → install locations, `AOS_NO_*`), `runnerArgs()`,
  `headlessEnv()` (`AOS_HEADLESS=1`, drops `CLAUDECODE`, recorded `CODEX_HOME`), `codexHomeOf()`.
- `sdk/lib/codex-cli.js`: `strictSchema()` / `dropNulls()` (strict `--output-schema`), `parseEvents()`, `NOT_LOGGED_IN`.
  `sdk/lib/claude-cli.js`: `resolveClaudeBin()`, the result-envelope parse.
- `sdk/lib/spend-ledger.js:58` `HOOK_EXCLUDE = /^(duty|reason|routine|graph):/`, `recordSpend()`; `codex-pricing.js`.
- `lib/host.js` `resolveHost()` chain. `cli/aos.js:325,361`: doctor's free login rows (`claude auth status --json`,
  `codex login status`).
- `cli/codex-host.js:218` `rewriteBody()`; `:298` copies a skill's other files to Codex verbatim, so `references/*.md`
  must be host-neutral by hand.
- `plugin/bin/aos` runtime case arms; `cli/fixtures/fake-claude.sh`, `fake-codex.sh`; `vault-template/_gitignore:2`.
- Installed CLIs have every flag used: Claude Code 2.1.281 (`--safe-mode`, `--json-schema`, `--tools`,
  `--permission-prompts`, `--no-chrome`); codex-cli 0.156.1 (`--output-schema`, `--ephemeral`, `-s`, and the
  `hooks`/`apps`/`browser_use`/`computer_use`/`image_generation` features).

## 4. Design

- **`brain/scripts/cross-review/runner.js`** is a port of `runner.py`. `resolveRoles`, `snapshot` (tracked, staged,
  deleted and untracked changes against a base, symlinks, a refusal for submodules), `validateReview` (the exact
  schema: verdict consistent with severities, unique ids, coverage required unless BLOCKED), `checkApproval`,
  `checkPrior`, and `execute`, which spawns detached and kills with `process.kill(-pid)` on timeout or SIGINT.
  `parseResult` reuses `parseEvents` and the Claude envelope parse. It also re-checks after the run: plan hash
  unchanged, snapshot unchanged during inspection, HEAD unchanged after build or a write handoff. `preflight` prints
  the resolved roles, each CLI's bin, version and login (no model call), the spend left today, and `independence`.
  Exit codes: 0 = a completed turn (not approval), 1 = failed, 2 = usage.
- **Prompts.** Upstream's reviewer and builder instructions come across verbatim. A `--prior` round appends
  "PRIOR FINDINGS" (the previous response) and "HOST DISPOSITIONS" (`--feedback`). An inspection appends the change
  manifest and the tracked diff. A handoff sends the host-written brief, framed as upstream's route asks (goal,
  files, constraints, expected output, verification), plus the permitted actions.
- **Skill `plugin/skills/cross-review/`.** `SKILL.md` covers phases 0–3 from upstream, the roles table naming both
  hosts, every runner command with `--host claude` and the `${CLAUDE_PLUGIN_ROOT}/bin/aos` launcher, and the D6 and
  D10 steps. `references/build.md`, `CONTEXT-FORMAT.md` and `ADR-FORMAT.md` are host-neutral; `THIRD-PARTY-NOTICES.md`.
  Long calls: "when your shell tool can run a command in the background, do so and report progress".
- **Skill `plugin/skills/handoff/`.** `SKILL.md` is route's text, adapted. It points to `/cross-review` where route
  pointed to Claude Code's loop, and executes via `aos cross-review handoff` (D13); `THIRD-PARTY-NOTICES.md`.
- **Doctor.** One host-neutral row beside the runner rows, never a fail: `ok cross-review cross-provider (claude and
  codex review each other)`, or `warn cross-review same-provider only: codex CLI not found` (or `not logged in`), or
  `info … off` when `crossReview.enabled` is false. It counts a CLI whether or not it is a wired host, and uses the
  free login probes (`claude auth status --json`, `codex login status`).

## 5. Host parity

1. **Entry.** Claude Code: `/agenticos:cross-review` · `/agenticos:handoff`, or their trigger phrases ("cross-review
   this plan", "who should handle this"). Codex: `$agenticos:cross-review` · `$agenticos:handoff`; direct wiring:
   `$cross-review` · `$handoff`. Terminal, either host: `aos cross-review preflight --host <h>`.
2. **Hooks.** None added or changed, so Codex users re-trust nothing.
3. **Model calls.** Agent jobs through `headless.js` (`resolveBin`, `crossArgs`, `headlessEnv`), ledgered as
   `cross-review:*`. Only claude or only codex available: D6 (the loop) and a same-provider delegate (handoff).
   `provider: none` does not gate it (D8).
4. **Session data.** None read. Children are ephemeral (D3), so no transcript or rollout is written.
5. **MCP.** No new tool. The skills name `recall` / `feedback_rules` by their Claude names and the generator
   rewrites them.
6. **Degradation.** The other CLI missing or logged out: a preflight line, a doctor row and the labelled
   same-provider offer; handoff recommends only runnable candidates. Over the daily cap: the runner refuses to start
   and names `crossReview.perDayUsd`.
7. **Docs.** README "Everyday commands" gets two rows per host. `docs/install.md` Hosts, `docs/plugin-smoke.md` (one
   item per host per skill) and the `vault-template/AGENTICOS.md` vocabulary line (`/cross-review` · `/handoff`,
   each with its `$agenticos:` form).

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | `/agenticos:cross-review` · `/agenticos:handoff` | Claude plans or routes. The Codex reviewer, inspector or delegate runs `codex exec`, ephemeral, read-only unless it is a build or `--write`. Claude builds by default. | Codex CLI missing or logged out: preflight and doctor say so, a labelled same-provider review (fresh Claude) is offered, and handoff delegates to a Claude model. |
| Codex only (plugin · direct) | `$agenticos:cross-review` · `$agenticos:handoff` · `$cross-review` · `$handoff` | Codex plans or routes. The Claude reviewer, inspector or delegate runs `claude -p` with safe mode and read-only tools. Codex builds by default. | Claude CLI missing or logged out: the mirror of the row above, with a fresh Codex session. |
| Both | Either of the above | The full loop from either host; the planner is whichever host the user started in. | — |

The first two rows differ only in the mirrored fallback, which is D6.

## 6. Testing

- `test/cross-review-runner.test.js` ports upstream's `tests/test_runner.py` onto the fake CLIs. It covers roles;
  both result formats; malformed, empty and failed turns; a turn with no completion event; a timeout killing the
  process group; approval invalidated by a plan edit; a snapshot covering staged, untracked and deleted files; a
  build that requires a clean checkout and an unchanged HEAD; a prior-round mismatch; same-provider labelling; a cap
  refusal; handoff consult vs `--write` (gate, changed-file report, an empty reply failing); one ledger row and one
  `runs.jsonl` row per call.
- `test/headless.test.js`: `crossArgs` per host and mode (the isolation flags are pinned). `test/spend-ledger.test.js`:
  the `cross-review:` family. `cli/codex-host.test.js` and `tools/build-codex-plugin.test.js`: the `--host` idiom.
- The fixtures gain `--json-schema` → `structured_output` (fake claude) and `--output-schema` → a reply file
  (fake codex).
- One live smoke per direction, on a disposable repo and **only with the user's go-ahead** (it spends). It
  confirms that Claude safe mode keeps the OAuth login, that the strict review schema passes on Codex, and which
  override (if any) empties the Codex reviewer's MCP servers under 0.156.1.
- **Outcome (2026-09-23, codex-cli 0.156.1, Claude Code 2.1.281).** Both directions completed with REVISE and caught
  the planted defect as `high`, at about $0.06 each. There were no new transcripts or rollouts. The Claude reviewer
  reported only Read/Glob/Grep. The first Codex reviewer reported `web` search and a `unified-computer-use` connector
  (`mcp__cua_repl`) despite `features.computer_use=false`, because the user's plugins carry connectors and
  `-c mcp_servers={}` merges instead of emptying. `codex mcp list` (no model call) showed that `features.plugins=false`
  plus each declared server off by name leaves none enabled. `web_search="disabled"` is a validated value. D4 now
  applies both to every Codex child. In the re-run, the Codex reviewer reported "no MCP servers or connectors"; only
  its shell and `apply_patch` remained, inside the read-only sandbox. It still found the planted defect (REVISE, $0.04).
  The smoke also caught a preflight bug: `claude auth status --json` is pretty-printed, and a one-line parse read it
  as logged out.

## 7. Out of scope

A HUD view of `runs.jsonl`; persona duties that call cross-review; deriving handoff's table from `models.js`; a
third-provider or quota fallback (upstream #9); persisted, resumed reviewer sessions (D3); a builder that commits;
the legacy grill skills; Windows.
