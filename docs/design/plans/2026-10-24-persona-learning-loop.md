# Chief of Staff learning loop — plan

Date: 2026-10-24 · Spec: `docs/design/specs/2026-10-24-persona-learning-loop-design.md` (D1–D12, approved by the owner
on 2026-10-24, the four owner's calls as recommended: observations are written without asking, the interactive guard
covers the Chief of Staff's own files, telemetry records skill names, the tick is model-free)

## Goal

An agent that learns who the user is and how they work, turns lessons into skills and into changes to named agents,
and never changes any agent's instructions, its own included, without the user's approval.

## PRs

### PR 0 — repair (fix, D11)
- [x] `cli/migrations.test.js`: every `M.decline` passes the faked opts; the half-way decline asserts its re-render
      went through `opts.installSchedules`
- [x] `lib/test-guard.js` `guardRealScheduler`; `cli/schedule.js` refuses the real LaunchAgents folder
      (`os.userInfo().homedir`) and the real `launchctl`/`crontab` under the test runner, with or without test-env
- [x] `routines/run-routine.js` `expandTools`: a `{{NODE}}` rule once per spelling (AOS_NODE, `cfg.node`, execPath)
- [x] `persona/record-spend.js` `deniedCalls` + `nearRule` → `brain/_index/duty-denials.jsonl`; `run-duty.sh` passes
      `--allowed`; `tick.js` `duty-denied` signal; the tick and reflect-daily prompts name it
- [x] CHANGELOG (Added, Fixed, Upgrading: `aos routines sync`), `docs/chief-of-staff.md`, the routines README
- [x] verified and merged as PR #175; local runtime upgraded after the merge

### PR 1a — no self-application (D1, D2, D13) — split from PR 1 so neither half regresses
- [x] retire the ladder (tick, recheck, reflect, ledger, review skill, HUD streak and class, config key, fixtures)
- [x] the playbook guarded and proposed; no built-in feedback writes for the reflect duties (proposals instead)
- [x] `persona/prompt-updates.js` + the `aos upgrade` step (D13)
- [x] verified and merged as PR #176; local runtime upgraded after the merge

### PR 1b — trust boundary (D3, D4)
- [x] ladder retirement moved to PR 1a (#176); keep the old `persona/autoapply.json` ignored
- [ ] `lib/write-areas.js`: `INSTRUCTIONS` (the Chief of Staff's own: identity, duties, routines, the playbook) and
      `AGENT_INSTRUCTIONS` (other personas' folders, `persona/teams/*/TEAM.md`); both in `GUARDED`
- [ ] `brain/scripts/instruction-guard.js` (PreToolUse): headless → deny every instruction path; interactive → the
      Chief of Staff's own → `ask` (Claude) / `deny` (Codex); exit 0 and no output on every other path
- [ ] `plugin/hooks/hooks.json` + `HOOKS` in `cli/codex-host.js` + `plugin/bin/aos`; `npm run build:codex-plugin`;
      `cli/plugin-manifests.test.js`; Codex users re-trust under `/hooks`
- [ ] `persona/proposal.js`: the change set (`changes:` with `base` hashes) parse, validate, apply, undo
- [ ] `cli/proposals.js` (`list|approve|reject|apply|undo`, `--json`); `aos` dispatch; README commands
- [ ] flag-closer: Approve / Reject call the applier; no model-applied What
- [ ] app: Approve / Reject in the Proposals tab (`ipc.ts`, preload, `schemas.ts`, policy, a surface spawn rule,
      `sandbox.spec.ts`, `SECURITY.md`); `docs/app-smoke.md` item per host
- [ ] live probes before `verified: true`: plugin hooks in `claude -p`; Claude `ask` under auto and bypass; Codex
      `deny` on `apply_patch`; `codex exec` hook trust
- [ ] Codex `PreToolUse` deny must be proved on the installed Mac build before it counts as enforcement. Open
      upstream issue #27833 reports `apply_patch` writes proceeding after a deny; keep `duty-guard` snapshot/restore as
      the headless backstop and add a post-write recovery path if the live probe reproduces it.

### PR 2 — proposal targets (D5)
- [ ] `kind: self | agent | skill | rule | idea`; `agent:` resolved through `lib/teams.js` + `lib/agents.js`; `skill:`
      through `lib/skills.js` (owner host, refuse plugin and built-in); legacy kinds read as before
- [ ] the digest and the Proposals tab show the target and the diff

### PR 3 — user model and `learn` (D2, D6, D9)
- [ ] `persona/learn.js inputs`: feedback metrics, ledger decisions, telemetry hours/hosts/models/durations, unreviewed
      user memories, per-member evidence stubs
- [ ] `brain/memory/user/work-style.md` (≤ 1,500 characters, source links, `reviewed: false` on change); `inject-context`
      `<user-model>` block, frozen per session
- [ ] `duties/learn.md` + routine (replaces `reflect-daily`; `aos upgrade` migrates the schedule); the tick model-free
- [ ] the Brain hub Review shows work-style changes

### PR 4 — skill lessons (D7, D10)
- [ ] `telemetry-hook.js` and `sdk/lib/telemetry.js`: the Skill call's name in its own field
- [ ] auto-wrap extraction: `skill_lessons`; drafts under `persona/drafts/skills/`
- [ ] `learn` files `skill` proposals (patch first); lint (size, "lessons, not logs") and scan (exfiltration, injection)
      before filing, failing closed
- [ ] `outcome:` metrics and the watchdog's 14-day measure

### PR 5 — agent supervision (D8)
- [ ] per-member packs (journal and state, own learning files' churn, team runs, corrections by `subagent_type`)
- [ ] `agent` proposals: prompt patch, skills list, model or effort

## File structure

| File | PR | Change |
|---|---|---|
| `brain/scripts/lib/test-guard.js` | 0 | `guardRealScheduler` |
| `cli/schedule.js` | 0 | refuse the real LaunchAgents folder and binaries under tests |
| `cli/migrations.test.js` | 0 | faked opts on every decline |
| `brain/scripts/routines/run-routine.js` | 0 | `expandTools`, `splitRules` |
| `brain/scripts/persona/record-spend.js` · `run-duty.sh` | 0 | denials with their nearest rule |
| `brain/scripts/persona/tick.js` | 0, 1, 3 | `duty-denied`; no `recheck record`; model-free |
| `brain/scripts/lib/write-areas.js` | 1 | instruction paths |
| `brain/scripts/instruction-guard.js` | 1 | new PreToolUse hook |
| `plugin/hooks/hooks.json` · `cli/codex-host.js` · `codex-plugin/` | 1 | the hook on both hosts |
| `brain/scripts/persona/proposal.js` · `cli/proposals.js` | 1, 2 | change sets, applier, targets |
| `plugin/skills/persona-flag-closer/` | 1, 2 | review through the applier |
| `app/src/{shared,preload,main}/…` · `hud/src/views/ProposalsTab.ts` | 1, 2 | Approve / Reject, diffs |
| `brain/scripts/persona/learn.js` · `vault-template/persona/duties/learn.md` | 3 | the nightly duty |
| `brain/scripts/inject-context.js` | 3 | `<user-model>` |
| `brain/scripts/telemetry-hook.js` · `sdk/lib/telemetry.js` · `auto-wrap.js` | 4 | skill names, skill lessons |
