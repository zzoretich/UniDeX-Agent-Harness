# Duty model and effort as settings — design

Date: 2026-09-24 · Branch: `feat/duty-model-settings` · Verified against `2e97306` (v0.19.0), Claude Code 2.1.281, codex-cli 0.156.1

## 1. Problem

The Claude model and effort a Chief of Staff duty runs on have no setting and no per-duty override:

- **Only the interview sets them.** `persona/answers.json` `dutyModel` / `dutyEffort` (`persona/interview.js:54-57`) are
  baked into every schedule as `PERSONA_MODEL` / `PERSONA_EFFORT` (`cli/routines.js:46-52`, `cli/persona-cmd.js:91,109`,
  `cli/schedule.js:100`). Changing them means editing `answers.json` by hand, then `aos routines sync`.
  `aos config` has `persona.codexModel` (`lib/settings-schema.js:122`) but no Claude-side key and no effort key.
- **One model for every duty.** A routine's `model:` / `effort:` are validated for `kind: prompt` only
  (`lib/routines-store.js:124-129`, mirrored in `hud/src/data/routines.ts:151-152`) and `plan()` never passes
  them to a duty (`routines/run-routine.js:98-107`). The hourly tick cannot stay cheap while the weekly reflect runs on a
  stronger model.
- **Per-run budgets break silently on a model change.** Moving duties from `haiku` to a Sonnet model made the first
  tick stop at its `budgetUsd: 0.1` after one turn (`error_max_budget_usd`, contract unmet). A per-duty model lets a user
  move the expensive duties without touching the cheap one's budget.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **`model` and `effort` are valid on `kind: duty`** in a routine file, with the prompt rules (non-empty string; `low\|medium\|high`). `plan()` passes them as `PERSONA_MODEL` / `PERSONA_EFFORT` for that run, over the schedule's env. The HUD validator mirrors it. | Per-duty keys in config (`persona.duties.<slug>.model`). | The routine file is already the per-duty home for `budgetUsd`, `tools` and `writes`; a second place would drift. |
| D2 | **Two settings: `persona.model` (Claude, nullable) and `persona.effort` (`low\|medium\|high`, nullable)**, both `null` by default, `applies: next-duty`, follow-up `aos routines sync`. | Reuse `claude.model`. | `claude.model` also drives hook summaries, extraction and the graph shim under a $0.05 per-call cap; a duty model change must not move those. |
| D3 | **One resolver, `dutyRunDefaults({ userCfg, vaultCfg, answers })` in `cli/schedule.js`**, used by `routines sync`, `persona` (install) and `persona rename`. Model: `persona.model` → `answers.dutyModel` → `claude.model` → `haiku`. Effort: `persona.effort` → `answers.dutyEffort` → `medium`. `agenticos.json` wins over `brain/config.json`, as in `loadConfig()`. | Resolve at run time in `run-duty.sh` via `headless.js --resolve`. | Every installed schedule already carries `PERSONA_MODEL`, which wins in `run-duty.sh:73`; moving resolution to run time changes the plist contract for every install. `claude.model` already uses the sync follow-up. |
| D4 | **A routine's `model` is a Claude model by contract, on duties too.** Under the Codex runner it is ignored and the duty runs on `persona.codexModel` → `codex.model` → the Codex default, as prompt routines do (`run-routine.js:115-116`). `effort` applies on both runners (`model_reasoning_effort`). | A `codexModel:` routine key. | Keeps one rule for all routines; a Codex per-duty model is a separate change for both kinds. |
| D5 | **The interview is unchanged**: it still writes `answers.json`, now the fallback under `persona.model` / `persona.effort`. | Have the interview write the config keys. | No migration for existing vaults; `aos persona` re-runs keep working. |

## 3. What already exists (`2e97306`)

- `run-duty.sh:73-74` — `MODEL=${PERSONA_MODEL:-claude.model}`, `EFFORT=${PERSONA_EFFORT:-medium}`; claude gets
  `--model/--effort`, codex gets `CODEX_MODEL` and `model_reasoning_effort` (`:184,263`).
- `run-routine.js plan()` — a duty's `budgetUsd`, `tools`, `writes` → `PERSONA_MAX_USD`, `PERSONA_TOOLS`, `PERSONA_WRITES`.
- `routineWriter.ts:40` — `model`/`effort` already count as guarded fields in the HUD's change detection.
- `lib/settings-schema.js:45` — `ROUTINES_SYNC` follow-up; `config-write.js resolve()` — machine-over-vault precedence.

## 4. Design

1. `lib/routines-store.js validate()` and `routines.ts` accept `model` / `effort` on duties. Header comment updated.
2. `run-routine.js plan()`, duty branch: `if (routine.model) env.PERSONA_MODEL = routine.model;
   if (routine.effort) env.PERSONA_EFFORT = routine.effort;` with a comment on D4.
3. `config.default.json` `persona`: `"model": null, "effort": null`. `settings-schema.js`: two entries in the persona
   section (`type: 'model', host: 'claude', nullable` and `type: 'enum', values: REASONER_EFFORTS, nullable`), both
   `followUp: ROUTINES_SYNC`. The drift test covers them.
4. `cli/schedule.js dutyRunDefaults()`; `cli/routines.js scheduleVarsFor` and `cli/persona-cmd.js` (install, rename)
   read `<vault>/brain/config.json` beside `agenticos.json` and call it.
5. Docs: `vault-template/brain/routines/README.md` (`model`/`effort` no longer "prompt only"), `docs/chief-of-staff.md`
   (how to change the duty model after install), `docs/install.md` Headless jobs paragraph, `CHANGELOG.md` Unreleased.

Tests: store (duty with model/effort valid, bad effort rejected), `routines.ts` parity (same cases), `plan()` (env set
only when the routine has the key), `dutyRunDefaults` precedence (each tier, machine over vault), routines sync and
persona install passing the resolved values into `scheduleVars`, schema drift.

## 5. Host parity

1. **Entry point.** `aos config set persona.model <m>` / `persona.effort <e>` then `aos routines sync` (host-neutral
   CLI; `/aos config` in Claude Code, `$agenticos:aos` on Codex), or `model:` / `effort:` in `brain/routines/<duty>.md`.
2. **Hooks.** None added or changed; no `/hooks` re-trust.
3. **Model calls.** The duty runner is unchanged (`run-duty.sh` via `headless.js --resolve --kind persona`); only the
   values reaching `--model` / `--effort` change. Provider `none` does not affect duties.
4. **Session data.** None read.
5. **MCP.** No new tool.
6. **Degradation.** On a Codex-only machine `persona.model` and a routine's `model:` have no effect (D4); `aos config`
   labels the key "Duty model on Claude" beside "Duty model on Codex"; `effort` works.
7. **Docs.** `docs/install.md` Headless jobs, `docs/chief-of-staff.md`, the routines README. No new command, so the README
   command counts do not change.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | `aos config set persona.model …` + `aos routines sync`, or `model:` in a duty routine | `claude -p --model <resolved> --effort <resolved>` | — |
| Codex only (plugin · direct) | same verbs; `persona.codexModel` for the model | `codex exec` on `persona.codexModel`, `model_reasoning_effort=<resolved>` | `persona.model` / routine `model:` ignored, labelled Claude-only in `aos config` |
| Both | same as Claude Code (auto runner prefers claude) | as Claude Code | — |

## 6. Out of scope

- A per-duty Codex model (`codexModel:` in a routine) — for prompt routines and duties together.
- Rewriting `IDENTITY.md`'s Model Policy line when the setting changes (it is rendered once by the interview).
- Auto-scaling a duty's `budgetUsd` with its model.
