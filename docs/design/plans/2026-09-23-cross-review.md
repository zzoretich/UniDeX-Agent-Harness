# cross-review and handoff (claudex-loop, integrated) — plan

Date: 2026-09-23 · Spec: `docs/design/specs/2026-09-23-cross-review-design.md` · Upstream pin: `8cf5e2c`

## Goal

A user on Claude Code, Codex or both can say "cross-review this plan". The host plans, the other provider reviews the
plan against the repository, the host arbitrates, a builder implements it, and the provider that did not build
inspects the diff. "Who should handle this?" gets a routing brief and, on request, one handoff. Every call is
ledgered on its own budget, ephemeral, and kept out of the brain's session collectors.

## Review decisions (2026-09-23)

| Topic | Decision |
|---|---|
| Design | Approved, with a rename. |
| Names | `cross-review` (the loop) and `handoff` (route); runner `aos cross-review`; config `crossReview`; spend `cross-review:*` (spec D2). |
| Review rounds | A fresh, unsaved session per round, carrying prior findings and dispositions (spec D3). |
| Single-CLI users | A labelled same-provider review; a build refuses it without `--accept-same-provider` (spec D6). |
| Route | Ported now as `handoff`, its model table kept close to upstream's and dated; execution goes through the runner (spec D12, D13). |

## File structure

| Path | New/Changed | Slice | What |
|---|---|---|---|
| `brain/scripts/cross-review/runner.js` | new | 1 | Port of `runner.py`: roles, preflight, review, build, inspect, check, handoff; snapshot, validation, approval, prior, cap gate, artifacts, `runs.jsonl` |
| `brain/scripts/lib/headless.js` | changed | 1 | `crossArgs(host, { mode: review\|consult\|build, schemaFile, outFile, model, effort, budget })` (D4) |
| `brain/scripts/sdk/lib/spend-ledger.js` | changed | 1 | `cross-review` in `HOOK_EXCLUDE`; `crossReviewSpendToday()`; `CROSS_REVIEW_ROWS` |
| `brain/scripts/config.default.json` | changed | 1 | `crossReview` block (D8) |
| `brain/scripts/test/cross-review-runner.test.js` | new | 1 | Port of upstream `tests/test_runner.py` onto fake CLIs, plus handoff cases |
| `brain/scripts/test/headless.test.js`, `test/spend-ledger.test.js` | changed | 1 | `crossArgs` per host and mode; the `cross-review:` family |
| (in the test) one fake CLI for both providers | new | 1 | Upstream's pattern: `exec` in argv means codex; `FAKE_CASE` picks the case. The shared `cli/fixtures` fakes stay untouched |
| `plugin/bin/aos` | changed | 2 | `cross-review) SCRIPT=cross-review/runner.js ;;` |
| `plugin/skills/cross-review/SKILL.md` | new | 2 | Host-neutral phases 0–3, roles table, runner commands with `--host claude`, D6 and D10 |
| `plugin/skills/cross-review/references/build.md`, `CONTEXT-FORMAT.md`, `ADR-FORMAT.md` | new | 2 | Adapted from upstream; host-neutral (copied to Codex verbatim) |
| `plugin/skills/handoff/SKILL.md` | new | 2 | Port of `claudex-route`; dated candidate table; executes via `aos cross-review handoff` |
| `plugin/skills/{cross-review,handoff}/THIRD-PARTY-NOTICES.md` | new | 2 | MIT notices, pin, what changed (D11) |
| `cli/codex-host.js`, `tools/build-codex-plugin.test.js` | changed | 2 | `rewriteBody`: `--host claude` → `--host codex`; the idiom regex |
| `codex-plugin/**` | generated | 2 | `npm run build:codex-plugin`, committed with its source |
| `cli/plugin-commands.test.js`, `cli/plugin-manifests.test.js`, `cli/codex-host.test.js`, `tools/build-codex-plugin.js` | changed | 2 | Counts 7 → 9 skills, 22 → 24 Codex skills; the new launcher arm |
| `cli/aos.js` | changed | 3 | One host-neutral doctor row; `status` spend line for `cross-review:`; the "22 skills" comment → 24 |
| `cli/aos.test.js` | changed | 3 | Doctor row: both CLIs present, one missing, logged out |
| `vault-template/AGENTICOS.md` | changed | 3 | Vocabulary line `/cross-review` · `/handoff` with their `$agenticos:` forms |
| `README.md`, `docs/install.md`, `docs/plugin-smoke.md` | changed | 3 | Everyday commands per host, counts, Hosts, smoke items per host per skill, credits |

## Tasks

### Slice 1: runtime (no user-visible surface yet)

- [x] `spend-ledger.js`: the `cross-review:` family plus tests.
- [x] `config.default.json`: the `crossReview` block; check that the config collector merges it on upgrade.
- [x] `headless.js` `crossArgs()`, with tests pinning each isolation flag per host and mode.
- [x] Fake CLI (test-local, both providers): structured replies, `-o` file and event stream, and the failure,
      timeout, mutate, commit and blank cases.
- [x] `runner.js`: port function by function, test first (upstream test names kept as comments for traceability).
- [x] `handoff` verb: consult vs `--write`, the same-provider label, an empty reply failing.
- [x] Cap gate: refuse when `crossReviewSpendToday() >= crossReview.perDayUsd`, naming the key.
- [x] Artifacts under `brain/_index/cross-review/runs/<id>/`, the tmp fallback, and a `runs.jsonl` row with `schema: 1`.

### Slice 2: plugin surfaces

- [x] `plugin/bin/aos` arm; `plugin-manifests.test.js`.
- [x] `cross-review` and `handoff` skills, host-neutral; their references and notices.
- [x] `rewriteBody` idiom and test regex; `npm run build:codex-plugin`; commit `codex-plugin/` with its source.
- [x] Count updates everywhere `parity-check.js` looks.

### Slice 3: doctor, docs, verification

- [x] Doctor row plus tests; `aos status` spend line.
- [x] README, install, smoke, `AGENTICOS.md`.
- [ ] `npm run gate` · `npm test` · `parity-check.js --wip --rehearse` · `publish-check.js`.
- [ ] **Ask first (spends):** one live smoke per direction on a disposable repo (a review and a consult handoff).
      Record the outcome of the Codex reviewer MCP override in spec §6.

## Verification

- `npm test` green, including the ported runner suite.
- Both rehearsals green (`first-run.sh`, `codex-host.sh`). Both skills appear as `$agenticos:<name>` in plugin mode
  and `$<name>` in direct mode.
- After `aos upgrade --from-local`: `aos doctor` shows the cross-review row in both blocks, and `aos cross-review
  preflight --host claude` and `--host codex` each print the opposite reviewer.
- A live review from each host ends as `completed` with a `cross-review:review` ledger row. No new files appear in
  `~/.codex/sessions` or `<claude config>/projects` for the child.
