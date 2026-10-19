# Locked writers for the runtime's shared files — design

Date: 2026-09-24 · Branch: `feat/locked-writers` · Verified against `55b4510` (v0.19.2 + #53–#57)

Review finding R2, second of two PRs (the first, `2026-09-24-append-only-runs`, made runs.jsonl append-only and added
`lib/fsx.js`). This one moves the other shared files onto it.

## 1. Problem

Files several processes change by read → change → write, with no lock, often from the same SessionEnd (the last
Stop's detached summary, auto-wrap, scan-vault's BRAIN.md compile, a reconcile's wrap):

- `brain/_index/routines.json`: `patchState` (each routine run) and `aos routines sync`'s `record()`, which wrote back
  a state read before the launchd/cron work and erased any run recorded meanwhile.
- `MEMORY.md` (memory-writer, `/wrap`), `SESSION.md` (auto-wrap ×4, the Stop summary, `/wrap`), BRAIN.md's Last
  Session (the Stop summary) against `build-brain-md`, which read the block early and rewrote the whole file later.
- The daily note: rewritten for the last-active marker every reply, while the summary, `/wrap` and `/standup` append.
- Ten more writers used a fixed `<file>.tmp` (pipelines ledger, recall and embed indexes, snapshot/health, file maps,
  graph marker, provider state, wrap queue, workspace insight, update-check state).

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | Every fixed-`<file>.tmp` writer uses `fsx.writeAtomic`; `cli/update-check.js` (which may run vendored, beside no `lib/`) inlines the same unique temp name. | — | Two writers never share a temp file. |
| D2 | `routines-store.updateState(mutate)`: one locked read-change-write; `patchState` goes through it; `schedule`'s `record()` and its reset merge only `synced` / `syncedAt` into a fresh read. A store without `updateState` (a test fake) writes as before. | Lock only patchState. | The sync is the writer that erased runs. |
| D3 | `MEMORY.md`, `SESSION.md`, memory files and the daily note are changed with `fsx.updateSync` (the change applied to the file as it is inside the lock), everywhere the runtime writes them. auto-wrap's section budget is measured inside the lock. The Stop hook's last-active marker waits at most 500 ms and otherwise skips one marker. | — | The same rule for every writer of a file is what makes the lock mean anything. |
| D4 | `build-brain-md` composes and writes BRAIN.md under its lock, re-reading the Last Session there; the headroom was priced without the block, so a newer one still fits. | Lock the whole compile. | The MOCs and the budget pass need no lock; the write does. |
| D5 | `config-write.writeAtomic` delegates to `fsx.writeAtomic`. | — | One implementation. |
| D6 | The vault template's `.gitignore` ignores `*.lock` and `*.tmp` (a lock exists only for the moment of a write; `brain/_index/*` was already ignored, `MEMORY.md.lock` at the root was not). | — | An auto-backup at that moment must not commit one. Existing vaults get the two lines by hand (upgrades do not re-seed the template). |

## 3. Host parity

Hooks and scripts on both hosts, unchanged commands; nothing host-specific. The HUD's own writes (Quick Capture's
MEMORY.md line, the deck's /remember and /pattern) go through Obsidian's `vault.process` and do not take the runtime's
lock: user-driven, rare, and out of scope.

## 4. Tests

`test/locked-writers.test.js`: three processes × 25 `patchState` keep every entry; three × 10 concurrent memories give
30 MEMORY.md lines and leave no lock or temp file. The existing writer tests pass unchanged.
