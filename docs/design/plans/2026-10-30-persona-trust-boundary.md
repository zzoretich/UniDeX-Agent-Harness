# Chief of Staff instruction guard — implementation plan

Date: 2026-10-30 · Status: implemented and validated in an isolated worktree; PR review pending
Base: `f4978736` on `feat/persona-trust-boundary` · Related design: `2026-10-24-persona-learning-loop-design.md` D1–D4

## Goal and existing baseline

Any agent-generated change to an agent's instructions, a user-owned skill, or a feedback rule requires a real user decision tied to the exact bytes being changed. An automatic duty cannot approve its own change. The existing auto-apply lane was removed in PR #176; this plan adds code enforcement and a deterministic apply/undo path.

The earlier design already decided that observation files may be written by duties, every instruction change requires approval, both Claude and Codex are supported, and proposal changes carry file hashes. This plan does not reopen those decisions.

## Confirmed decisions

| ID | Decision | Implementation consequence |
|---|---|---|
| G1 | Inline instruction edits during an active session use the host's usual permission prompt. | Do not force these edits into the proposal queue; make the host prompt or refusal visible. |
| G2 | If Codex's deny hook is bypassable, automatic duties keep running with restore-after-write protection. | Extend snapshots to every protected instruction path and prove restoration in live tests; surface a warning until denial itself is reliable. |
| G3 | Convert older prose-only proposals to an exact diff before they can be approved. | Legacy proposals remain readable, but cannot apply directly. |
| G4 | Self-improvement proposals are decided in the Proposals UI; inline work is decided inline. | UI decisions bind the reviewed diff and hashes. Do not let a model mint the UI approval record. |
| G5 | Revert automatically when an approved change fails verification. | Apply is transactional and records the failed attempt. |

## Security contract

- Classify the Chief of Staff's own instructions, other agents' definitions and persona instructions, team `TEAM.md`, user-owned skills, and feedback rules. Keep observation notes and team board state writable as currently intended.
- Resolve paths before checking them. Treat case folding, Unicode normalization, symlinks, parent directory writes, moves, and deletes as ways to reach a protected target. Refuse an ambiguous target rather than guessing.
- Headless sessions deny direct instruction writes. Only the deterministic applier may use an approval record, exact change set, and single-use authority to write; it must not accept a mere `--approved` flag from an agent.
- An interactive direct user edit through a first-party editor remains possible. Agent-initiated inline edits follow the host permission flow (G1); self-improvement proposals use the Proposals UI (G4). Existing explicit team management controls need a documented allow path; an agent cannot impersonate a click.
- A hook denial is not treated as proven enforcement until live tests show that the target file stayed unchanged. A duty snapshot/restore covers protected vault and host-owned instruction files. If the installed host bypasses a deny, restore protected files after automatic duties (G2) and report the remaining interactive enforcement limit.

## Implementation waves

1. **Inventory and path policy.** Add a single instruction-path classifier in `brain/scripts/lib/write-areas.js` with separate categories for the Chief of Staff, named agents, skills, feedback rules, and team roster files. Extend duty snapshots to protected host-owned files as well as vault paths, with symlink-safe restore. Add tests for positive, negative, parent, symlink, and case-folded paths. Keep generated Codex plugin files untouched until the build step.
2. **Host hooks.** Build `brain/scripts/instruction-guard.js` for Claude Write/Edit/NotebookEdit/Bash and Codex Bash/apply_patch/MCP write calls. Wire `plugin/hooks/hooks.json`, `plugin/bin/aos`, and `cli/codex-host.js`; regenerate `codex-plugin/`. The hook emits the documented host decision format, exits quietly for safe calls, and fails closed for ambiguous instruction writes. Test the same policy under Claude-only, Codex plugin, Codex direct, and both-host configurations.
3. **Exact proposal format.** Add `changes` validation to `brain/scripts/persona/proposal.js`: path ownership, operation (`create`, `patch`, `replace`, `delete`), base SHA-256, exact old/new content, size bounds, and recheck. Reject stale bases, duplicate paths, links, or targets outside the owner's allowed roots. Preserve read access to legacy proposals and require an exact reviewed diff before approval (G3).
4. **Human approval and transaction.** Add read-only `aos proposals list|preview` and an app-owned decision path for Approve/Reject/Undo. The decision record binds the proposal digest, target file hashes, human channel, timestamp, and one-use nonce. Apply under a lock, stage backups outside vault Git, write atomically, verify, then append ledger and make a path-limited vault commit. On any failed precondition or verification, restore and record the failure (G5). Undo is an explicit Proposals UI action, checks the current hashes, restores the backup, and records the reversal; never overwrite intervening edits.
5. **Review surfaces.** Update the flag-closer skill to present the exact diff and send self-improvement decisions to the Proposals UI, removing prose-driven edits. Add Approve/Reject and an undo affordance to the Workbench Proposals tab through typed IPC that calls the app-owned applier, plus a clear stale/error state. Keep the existing Review flow for flags and ideas. Update proposal template, help text, upgrade notes, security docs, and app smoke instructions.
6. **Live proof and release readiness.** In disposable vaults and host config homes, test direct writes by each supported tool, dynamic shell writes, symlink routes, attempts from `claude -p` and `codex exec`, native hook trust and bypass modes, exact approval/apply, stale refusal, crash rollback, and undo. A deny passes only if the file is unchanged. Run unit, lint, typecheck, privacy, parity, app e2e, packaged smoke, and both-host install rehearsals. Publish as one PR only after these are green and the approved decisions are encoded in the spec.

## Required gates

- **Design gate:** G1–G5 were confirmed by the owner. Record them in the design spec and host-parity matrix before implementation (per the AgenticOS feature workflow).
- **Security gate:** if a host cannot reliably deny a direct protected write, prove restore-after-write for automatic duties and disclose the interactive limit (G2); do not advertise hook denial as complete.
- **Ship gate:** verify privacy and host parity; review the diff and PR. Merge, a direct push to `main`, and a release tag each require the owner's approval under the feature workflow.

## Validation record

- The full repository suite, both host install rehearsals, private-term gate, app typecheck and unit checks, 551 Electron e2e tests, and 46 packaged smoke checks passed.
- In a disposable vault, a live headless Claude Code session attempted a `Write` to `persona/IDENTITY.md`; `PreToolUse` denied it and the file remained unchanged.
- A live headless Codex session attempted a Python shell write to the same protected file; `PreToolUse` blocked the command, the file remained unchanged, and the duty snapshot had nothing to restore. This proves that shell route for the tested CLI build; it does not establish that every Codex tool route honors denial.
- A separate forced-write test changed the protected identity and a host-owned skill. The duty check restored both and left an observation note in place. Its restoration exit code was the expected nonzero signal.

## Acceptance criteria

- No automatic duty can persist an instruction change without a bound human decision.
- There is no model-facing approval CLI flag; a self-improvement proposal decision comes from the Workbench UI action.
- The user sees the exact changed paths and diff before approval; an approved change applies those bytes only.
- Stale, invalid, or partially failed changes leave protected files as they were, with a visible reason.
- Claude-only, Codex-only (plugin and direct), and both-host setups have an equivalent usable route to review, approve, reject, and undo.
- Existing proposals remain readable; their approval follows G3.
