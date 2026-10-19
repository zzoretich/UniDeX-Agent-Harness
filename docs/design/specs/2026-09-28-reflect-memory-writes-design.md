# Reflect duties may write feedback memories

## Problem

The two reflect duties promote a repeated correction into a feedback memory: `persona/duties/reflect-daily.md` and
`persona/duties/reflect.md` both say "one file in `brain/memory/feedback/` plus one line in `MEMORY.md` under
`## Feedback (how to work)`". The duty write scope (`2026-09-23-duty-write-scope-design.md`) made `brain/memory`
read-only to every duty (its D4), and its default scope (D5), which it says "covers every built-in duty", holds neither
path. Since then every reflect run that reaches a promotion is denied, journals the block and adds a line under
`## Flags` in `STATE.md`: three times in five days on one vault. The model also misreads the denial as the permission
mode refusing every write, so the flag it raises points at the wrong cause.

A `writes:` key in the template routine files would not reach an existing vault: `brain/routines/` is seeded once and
is the owner's afterwards (`migrateRoutines` in `cli/aos.js`, `interview.js`), and the reflect routines are guarded.

## Decisions

| # | Decision | Rejected | Why |
|---|---|---|---|
| D1 | **Per-duty built-in writes in the runtime.** `duty-guard.js` gets `DUTY_WRITES = { reflect, 'reflect-daily' } → ['brain/memory/feedback/', 'MEMORY.md']`, merged into the scope when `scope` is given `--duty <slug>`; `run-duty.sh` passes `$DUTY`. A routine's `writes:` still adds on top. | (a) Add both paths to `DEFAULT_WRITES`. (b) `writes:` in the template routine files. (c) An upgrade migration that edits routine files. | (a) grants memory writes to `tick`, `monitor` and `sitrep`, which never need them. (b) reaches new vaults only. (c) edits files that are the owner's, and guarded ones at that. The runtime is re-vendored by `aos upgrade`, so D1 reaches every vault. |
| D2 | **Only `brain/memory/feedback/`.** `_drafts/` sits inside it and is covered. | All of `brain/memory/`. | The contracts only promote feedback. `user/`, `projects/` and `reference/` stay read-only. |
| D3 | **Codex gets `MEMORY.md` through a runner-side backfill.** Codex write roots are folders, and the folder of `MEMORY.md` is the vault, which is always refused. So after a clean guard check for a duty whose built-in writes hold the feedback folder, the guard adds one `## Feedback` line to `MEMORY.md` for each top-level feedback memory changed during the run and not yet linked. It runs on both hosts; on Claude Code it is usually a no-op because the duty wrote the line itself. The built-in `MEMORY.md` entry is dropped from the Codex folders without a "refused" log line. | (a) `--add-dir` the vault root. (b) Leave the memory unindexed on Codex. (c) A `reflect.js` verb. | (a) opens the whole vault. (b) is a parity gap: the memory exists but recall and `BRAIN.md` never see it. (c) `reflect.js` is on the duty's own allowlist, so the duty could call it; `duty-guard.js` is not. |
| D4 | **The backfill runs inside `check`.** `check` owns the snapshot: its `manifest.at` is the run's start, and `check` deletes it. A restore (exit 4) skips the backfill. Result: `indexed: [<rel>…]` in the JSON line `run-duty.sh` already logs. | A new `index` verb called by `run-duty.sh`. | The snapshot is gone after `check`, and it saves a runner step. |
| D5 | **Contract wording.** The template contracts keep "one line in `MEMORY.md`" and add "if that write is refused, leave it: the runner adds the line after the run". | Drop the `MEMORY.md` line from the contract. | Existing vaults keep their contract (duties are seeded once). Keeping the instruction lets the duty write its own description on Claude Code. |
| D6 | **Amend D5 of the 2026-09-23 spec** with a pointer here: "covers every built-in duty" was wrong for the reflect duties. | Leave the old spec as it is. | A spec that says otherwise misleads the next change. |

## What already exists (verified at `e8e0b3d`)

- `brain/scripts/persona/duty-guard.js`: `DEFAULT_WRITES`, `writeScope` (a routine's `writes:` via `--writes`),
  `claudeTools` (one `Edit(//<abs>)` rule per entry, for the configured vault path and its realpath), `codexDirs` (a
  file entry grants its folder; the vault itself is refused), `snapshot` (`manifest.at`), `check` (restores guarded
  files, deletes the snapshot).
- `brain/scripts/persona/run-duty.sh`: calls `scope` with `--tools`/`--writes`, and `check "$DUTY"` after the model.
- `brain/scripts/lib/memory-writer.js`: `insertIndexLine` (section-aware; `## Feedback` prefix-matches
  `## Feedback (how to work)`), `deriveDescription`; `lib/fsx.js` `updateSync` is the locked read-change-write.

## Design

- **`lib/memory-index.js`** (new, pure): `insertIndexLine` and `deriveDescription` move here from `memory-writer.js`,
  which requires them and keeps its exports. It has to be pure because `memory-writer.js` resolves the vault when it
  loads, which the guard (called with an explicit vault) and its tests cannot rely on.
- **`duty-guard.js`**:
  - `DUTY_WRITES`, and `writeScope({ …, duty })` puts that duty's entries after the defaults and marks them built-in.
  - `codexDirs` leaves out a built-in file entry whose folder is refused, without logging a refusal.
  - `scope --duty <slug>` (checked against `SLUG_RE`).
  - `check`, when nothing was restored and the slug's built-in writes hold `brain/memory/feedback/`, calls
    `indexFeedback({ vault, since: manifest.at })`.
  - `indexFeedback` covers regular `*.md` files directly in `brain/memory/feedback/` (lstat: no symlinks, no
    `_drafts/`, no dot-files, no `README.md`) with `mtime >= since`, and skips any file whose
    `](brain/memory/feedback/<name>)` link `MEMORY.md` already has. Each line is `- [<H1 or slug>](<rel>) — <description>`,
    where the description is the frontmatter `description:` or else the first body line, clipped by `deriveDescription`.
    Lines go in under `## Feedback` inside `fsx.updateSync`. An error is returned as `indexError` and never fails the
    check.
- **`run-duty.sh`**: `scope … --duty "$DUTY"`.
- **Templates**: the D5 wording in `vault-template/persona/duties/reflect-daily.md` and `reflect.md`. The write-scope
  sentence in `vault-template/brain/routines/README.md` and `docs/chief-of-staff.md` names the reflect duties' extra
  scope.
- **Tests** (`brain/scripts/test/duty-guard.test.js`):
  - Scope per duty on both hosts: `reflect` and `reflect-daily` get the feedback rules, `tick` does not.
  - Codex leaves out `MEMORY.md` without a refusal.
  - The backfill indexes a new memory once (idempotent) and skips old, already-linked, `_drafts` and symlinked files.
  - No backfill after a restore.
  - The existing `memory-writer` tests stay green.
- **CHANGELOG** `[Unreleased]` → Fixed.

## Host parity

1. **Entry point**: none new. The reflect routines run on schedule, or with `aos routines run reflect-daily`, on
   either host.
2. **Hooks**: none changed.
3. **Model calls**: none new. The duty runner is still chosen by `lib/headless.js` (`persona.runner`).
4. **Session data**: none read.
5. **MCP**: no new tool. No `plugin/` change, so `codex-plugin/` is unchanged.
6. **Degradation**: if the backfill fails, the memory file stays and `indexError` is in the duty log.
7. **Docs**: `docs/chief-of-staff.md` and the routines README; no command tables change.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | the scheduled reflect / reflect-daily, or `aos routines run <slug>` | `claude -p` (dontAsk) with `Edit(//<vault>/brain/memory/feedback/**)` and `Edit(//<vault>/MEMORY.md)`; `check` adds any missing index line | `indexError` in the duty log; the memory file is kept |
| Codex only (plugin · direct) | same | `codex exec` with `--add-dir <vault>/brain/memory/feedback`; `check` writes the `MEMORY.md` line | same |
| Both | same | the runner `persona.runner` resolves | same |

The one host difference (who writes the `MEMORY.md` line) is D3; the outcome is the same on both hosts.

## Out of scope

- Telling a duty its write scope in its system prompt, so a denial is not misread as the permission mode.
- Narrowing `DEFAULT_WRITES` per duty.
- Removing a promoted draft from `_drafts/` (the duty has no delete tool; `feedback-review` owns drafts).
