# Chief of Staff learning loop — design

Date: 2026-10-24 · Branch: `feat/persona-learning-loop` · Verified against `ae83df3` (v2.2.0), Claude Code 2.1.310,
codex-cli 0.162.1 · Supersedes the earned-autonomy ladder (`2026-09-22-persona-earned-autonomy-design.md`) and the
tick → queue → reflect-daily path (`2026-09-22-persona-tick-design.md`, `2026-09-22-persona-reflect-daily-design.md`)

## Problem

The Chief of Staff improves only itself, and barely. It may write its own state, journal, playbook and feedback
memories; skills, the named agents and the user's working habits are out of its reach. On one live vault over 33 days:

- **It re-reports instead of learning.** The tick queues each new feedback memory as a `correction`; the nightly reflect
  finds it already saved by auto-wrap. 38 drains, "improved: nothing" in nearly all; two proposals filed, both about its
  own plumbing, neither decided. `feedback-metrics.js` (corrections that recur despite a rule) exists and no duty reads
  it. The tick is ~63% of duty spend and ~89% of its runs queue nothing.
- **It cannot see its own failures.** A routine's `tools:` `{{NODE}}` expands to `process.execPath` (the versioned
  Homebrew Cellar path) while the duty prompts name the stable `opt` path, so `dontAsk` denies every helper call. The
  duty read it as a permission-mode quirk and proposed a fix with the same mismatch.
- **The test suite unschedules it.** `cli/migrations.test.js:328` calls `M.decline(ctx, …)` without the faked seams;
  `rerender()` reaches the real `schedule.installSchedules`, which rewrites the real tick plist to a temp vault and,
  through `LEGACY_DUTIES`, unloads and deletes the real `monitor`, `sitrep` and `reflect` plists.
- **Self-change is gated by prose in interactive sessions,** where the persona is injected too: neither host runs a hook
  before a tool call. And the earned-autonomy ladder exists to let the agent apply classes of its own changes unasked.

Goal: an agent that learns who the user is and how they work, turns lessons into **skills** and into **changes to named
agents**, and never changes any agent's instructions — its own included — without the user's approval.

## Borrowed from Hermes Agent

Hermes Agent (Nous Research, MIT; read at v0.22.5, 2026-10-24) is the reference for an agent that learns from use.
Its docs and code: a background review runs after a reply on counters (`memory.nudge_interval`,
`skills.creation_nudge_interval`) with read-only tools plus `skill_manage` (create, `patch` by exact old/new strings,
write_file, delete) and `memory`; its prompt prefers patching a loaded skill over creating one. Two tiers of knowledge:
capped `MEMORY.md` (2,200 chars) and `USER.md` (1,375 chars), injected as a frozen snapshot per session, plus skills
listed by name and description and loaded on demand. A curator moves unused skills active → stale → archived, keeps a
`.curator_ledger.jsonl`, and rolls back. Session search is SQLite FTS5.

We take: patch-first skills as the unit of a procedural fix; a small capped user model frozen per session; a staged
queue with diff, approve and reject; a ledger of who changed what with hashes, and rollback. We do not take: writing
freely by default (`skills.write_approval` and `memory.write_approval` default to `false`), review writes to skills it
does not own (open issue #142933: review patches landed in a hand-kept `~/.claude/skills` library), or a model fork every
few turns (its docs: the review "can burn a meaningful share of total tokens").

## Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **No self-application.** Every change to an agent's instructions, the Chief of Staff's own included, is a proposal the user approves. The ladder is retired: `autoapply.json` is no longer read, `recheck.js record` leaves the tick, `reflect.js inputs` drops `autoapply`, flag-closer step 7 goes. | Keep the ladder dormant; Hermes's write-freely default with an opt-in gate. | The owner's rule. The ladder is the one path built to apply unasked, and it never started. |
| D2 | **Instructions vs observations.** Instructions: identity, duties, routines, playbook routes, a named agent's definition and persona files, every skill, feedback rules. Observations: the user model, per-agent notes, evidence. Observations are written by the duty (capped, sourced, `reviewed: false`, shown in the Brain hub Review); instructions only through an approved proposal. *Approved by the owner 2026-10-24.* | Gate both; gate neither. | Gating observations would starve the user model (24 feedback drafts wait unread); not gating instructions is the Hermes failure. |
| D3 | **Enforced in code, both hosts.** A new `PreToolUse` hook, `instruction-guard`, matches writes (Claude: `Write\|Edit\|NotebookEdit\|Bash`; Codex: `Bash`, `apply_patch`, MCP). Headless (`AOS_HEADLESS=1`): deny any instruction path. Interactive: the Chief of Staff's own instruction files → Claude `ask` (a native prompt auto mode cannot approve), Codex `deny` with the approval paths (`ask` is "parsed but not supported yet"). Other agents' files and skills in an interactive session follow the host's permissions: the user is driving. `GUARDED` (`lib/write-areas.js:25`) gains every instruction path, so `duty-guard` restores them if a hook did not fire. | Prose-only (today); `ask` on every skill write (friction for ordinary skill authoring). | Plugin hooks in `claude -p` and Codex hook trust in `codex exec` are unverified, so the runner's snapshot/restore stays the backstop. |
| D4 | **One deterministic applier, human-only approval.** A proposal's What becomes a change set: `changes: [{ path, op: create\|patch\|replace\|delete, base: <sha256>, old?, new?, content? }]`. `aos proposals apply <slug>` refuses a stale base, writes to the owner location, backs up every path outside the vault's git under `brain/_index/proposal-undo/<slug>/`, ledgers, commits vault-tracked paths; `aos proposals undo <slug>` restores. It needs an approval record from a human channel: the Workbench Proposals tab (Approve / Reject, an app spawn rule like the Brain hub's `aos memory` verbs), `aos proposals approve <slug>` on a TTY, or the review skill, whose apply call the guard turns into a native prompt on Claude. | The model applies "the What exactly as written" (today). | Verifiable, undoable outside git, and the approval cannot come from a model. `ledger.js:91` already refuses approvals headless. |
| D5 | **Proposals name their target.** `kind: self \| agent \| skill \| rule \| idea`, plus `agent: <team>/<member>` (a TEAM.md member: its host agent file via `lib/agents.js`, its persona folder, its TEAM.md entry) or `skill: <name>` with `op: create \| patch` (owner via `lib/skills.js`; `skills-sync` mirrors it). Plugin and built-in skills are never patched: the AgenticOS plugin's become an `idea` with `surface: plugin`, others are refused. `vault`/`workflow`/`product` keep reading as today. | Keep `self\|vault\|workflow\|product`. | The review must show whose behaviour changes; ownership is what Hermes gets wrong. |
| D6 | **The user model.** `brain/memory/user/work-style.md`: how the user works — cadence and hours, how they decide and review, what they approve and reject, hosts and models, writing preferences, current focus — each line with a source link, ≤ 1,500 characters so it must consolidate. Injected by `inject-context` as a `<user-model>` block, frozen per session. No credentials, no third parties' data. | An external user-modeling service; a growing profile. | Hermes's `USER.md` shape, local and capped; `profile.md` stays the user's own text. |
| D7 | **Skills are the unit of a procedural fix.** A lesson about *how to do a task* becomes a `skill` patch (else a new skill), not another feedback memory; preferences stay rules. Evidence: telemetry records each Skill call's name in its own field, as `subagent_type` is (`telemetry-hook.js:62`) — a name, never input (*approved by the owner 2026-10-24*); auto-wrap's extraction gains `skill_lessons` at no extra model call. Two lessons on one skill, or one procedure in two sessions, file a proposal with the exact patch or a full `SKILL.md` (agentskills.io `name`, `description`), linted and scanned for exfiltration and injection before filing, failing closed. | Hermes's write-on-every-review. | Procedures belong in skills; 141 feedback memories are the bloat that comes from filing everything as a rule. |
| D8 | **Named agents are supervised.** The roster is every TEAM.md member. Per member, a deterministic pack: its journal and state, churn in its own learning files, team runs (failed, blocked, killed, re-runs, cost per item), corrections in sessions that invoked it (`subagent_type`). The duty files `agent` proposals: a prompt patch, its skills list, model or effort. An agent's own data loops (an assistant's interactive rule learning, a reaction-driven taste file) stay its own. | Each agent improves itself. | One reviewer, one queue; agents keep their data, not authority over their instructions. |
| D9 | **Cadence and cost.** The tick becomes model-free (deterministic signals into the evidence store; the watchdog stays); `reflect-daily` becomes `learn` (nightly, one run: the user model and ≤ 3 proposals); the weekly reflect keeps the reflection and reads outcomes. The in-session moment is auto-wrap's existing SessionEnd extraction. *Approved by the owner 2026-10-24.* | A Hermes-style fork every N turns. | The tick's model mostly decides "nothing". |
| D10 | **Outcome, not persistence.** Each proposal names an `outcome:` metric (`corrections:<topic>`, `skill-corrections:<name>`, `agent-failures:<member>`); the watchdog measures it over 14 days → `improved \| unchanged \| regressed`. The recheck only detects staleness. | Recheck-only verify (today). | A recheck proves the change stayed, not that it helped. |
| D11 | **Repair first** (PR 0): the schedule test leak, plus a `tools/test-env.js` refusal of the real LaunchAgents folder; `{{NODE}}` → the stable node path; a duty's `permission_denials` → a `duty-denied` signal naming the rule. | Fix inside the redesign. | Nothing else runs while the duties are unscheduled and denied. |
| D12 | **Privacy.** What is learned lives in the vault; the repo carries templates and code; telemetry adds names only. | — | The privacy gate and the telemetry policy. |
| D13 | **New prompts arrive as proposals** (added while building PR 1a, 2026-10-24). `aos upgrade` files an `update-identity` / `update-duty-<name>` `self` proposal for each guarded prompt that differs from the new render with the vault's answers: the whole new text as the What, the diff as the Why, `! cmp -s` against the render kept in `brain/_index/persona-prompts/` as the recheck; a rejected render is not filed again. | Re-render untouched files only; tell the user to run `aos persona`. | Live vaults hold hand-edited prompts from older templates (one vault: all five duties), so "untouched" never matches; a re-render overwrites edits. A proposal keeps the user's approval in front of every prompt change. |

## What already exists (at `ae83df3`)

- **Human-only approval:** `persona/ledger.js:91` refuses `approved` / `auto-applied` under `AOS_HEADLESS=1`;
  `lib/write-areas.js:25` `GUARDED`, `:28` `EXECUTABLE`; `duty-guard.js` snapshots and restores around every duty.
- **Proposals:** README shape with `recheck`; `proposal-html.js`; the read-only HUD Proposals tab
  (`hud/src/views/ProposalsTab.ts`); decisions only in `plugin/skills/persona-flag-closer`, whose Approve has the model
  apply the What. Auto-apply: `persona/autoapply.json` (`[]`), `recheck.js record` from `tick.js precheck`, step 7.
- **Skills and agents on both hosts:** `lib/skills.js`, `lib/agents.js` (ownership sidecar/marker, hand-edit refusal,
  SessionEnd sync in `skills-sync.js`), `aos skills|agents`, HUD Skills and Agents tabs.
- **Named agents:** `persona/teams/<team>/TEAM.md` members (`agent`, `provider`, `model`, `skills`) via `lib/teams.js`.
- **Learning inputs:** `lib/correction-detector.js` → feedback drafts → `feedback-review`; auto-wrap's
  `user|feedback|projects|reference` candidates (`auto-wrap.js:112`); the Brain hub Review batches unreviewed memories
  (`brain-hub.js:250`); `profile.md`'s first paragraph is BRAIN.md `## Who` (`build-brain-md.js:136`).
- **Evidence:** `brain/_index/agent-runs/` (tool names, `subagent_type`; inputs redacted), team `runs.jsonl`, BM25 recall.
- **App:** spawn rules for runtime verbs in `app/src/shared/surfaces.ts` (the Brain hub's `aos memory` precedent).

## Design

PR 0 (fix) is D11. Then, one PR each, in order:

1. **Trust boundary** (D1, D3, D4): retire the ladder; instruction paths in `write-areas.js`; `instruction-guard` in
   `plugin/hooks/hooks.json` and `HOOKS` (`cli/codex-host.js`); `cli/proposals.js` (`list|approve|reject|apply|undo`);
   change-set parsing in `brain/scripts/persona/proposal.js`; flag-closer calls the applier; the Proposals tab gains
   Approve / Reject (`ipc.ts`, preload, schema, a surface rule, `sandbox.spec.ts`).
2. **Targets** (D5): `agent`/`skill`/`rule` kinds, owner resolution, the digest and the tab show the diff per target.
3. **User model and `learn`** (D2, D6, D9): `persona/learn.js` evidence pack (feedback metrics, ledger decisions,
   telemetry hours/hosts/models), `duties/learn.md`, the `<user-model>` block, the model-free tick.
4. **Skill lessons** (D7, D10): the telemetry field, auto-wrap's `skill_lessons`, the lint and scan, outcome metrics.
5. **Agent supervision** (D8): per-member packs and `agent` proposals.

## Host parity

1. **Entry:** `aos proposals …` (host-neutral); review `/agenticos:persona-flag-closer` · `$agenticos:persona-flag-closer`
   (direct: `$persona-flag-closer`); the Workbench Proposals tab. 2. **Hooks:** one new `PreToolUse` on both; Codex users
   re-trust under `/hooks`. 3. **Models:** `learn` through `headless.js`; extraction stays in `provider.js`; provider `none`
   → no `skill_lessons`, the duty still runs. 4. **Session data:** caches only, never transcripts in the duty.
   5. **MCP:** none new. 6. **Degradation:** below. 7. **Docs:** `docs/chief-of-staff.md`, README, app-smoke per host.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | scheduled `learn`; review in a session or the Proposals tab | `claude -p` under the write scope + guard deny; owner paths `~/.claude/skills`, `<claude config>/agents`; interactive self-writes → native `ask` | guard not loaded → `duty-guard` restore + a doctor row |
| Codex only (plugin · direct) | same; `$agenticos:persona-flag-closer` | `codex exec`; `~/.agents/skills`, `<codex home>/agents/*.toml`; guard `deny` | no `ask`: an in-session apply is refused → Approve in the Proposals tab or `aos proposals approve` on a TTY |
| Both | either | the owner host per skill/agent; `skills-sync` mirrors the change | — |

The Codex `ask` gap is D3 with its fallback.

## Out of scope

A skill lifecycle (stale/archive, as Hermes's curator); external user-model services; changing auto-wrap's own memory
writes; patching plugin skills; full-text search over transcripts; Windows.
