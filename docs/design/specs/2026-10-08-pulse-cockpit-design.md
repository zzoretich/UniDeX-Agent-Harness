# UniDeX Pulse: a one-screen cockpit, written up by the Chief of Staff

**Date:** 2026-10-08
**Status:** approved 2026-10-08 (as written; the briefing cadence of P6 confirmed); on `feat/pulse-cockpit`. The mockups (four directions, the chosen
cockpit with the briefing band, the popup, and the 960×600 window) are on a private design canvas, not in the repo.
**Scope:** the Pulse tab (rail id `pulse`) becomes Home and a no-scroll overview of the whole app: what is broken, what
waits on you, what is moving and what runs next, across agents, workspaces, proposals, to-dos and notifications. The
Chief of Staff (the persona, named by `persona/IDENTITY.md`) writes the paragraph at the top with one model call.

---

## 1. Problem

- **Pulse sees only the plumbing.** It reads pipelines, the snapshot, the cost ledger and the promote trail (`PulseTab.ts:126-179`). Proposals, team gates, flags, to-dos, notifications, routines, live sessions and spend are invisible there.
- **It is a scrolling stack:** chip strip, command deck, a two-line briefing, Δ, cost and health rows, the Fix Queue and the trail (`PulseTab.ts:181-312`), with no way to see more except the SYSTEM drawer.
- **"What needs fixing" is half the story.** The Fix Queue covers stale pipelines and cost (`fixQueue.ts`); a 16-day-old proposal, a Chief-of-Staff flag or 20 feedback drafts never appear.
- **The briefing is two rule-picked lines** (`briefing.ts` `composeBriefing`, top 2 of 14 snapshot heuristics), and nothing writes `brain/_index/brief.md`, which `brief_read` and session start already look for.

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| P1 | **Layout "Cockpit + briefing"** (user's pick): a briefing band replaces the 56 px header, then ten tiles in a 4×3 grid. Needs you and Workspaces are double-width. | B Triage (one ranked queue): less of a map. C Map (workspaces × signals): sparse until to-dos link to workspaces. D Briefing with a 24 h timeline. All four are on the canvas. |
| P2 | **No page scroll.** The grid fills the pane. Each tile gets a row budget from its measured height (ResizeObserver): rows drop first, the headline number never does, and overflow reads "+N more". At 960×600 every tile keeps its number and loses its list. Only the popup's list scrolls. | A scrolling page, as today. Smaller type to fit. |
| P3 | **One centred popup** (user's pick), built on the compat `Modal`: the ten areas in a left list (switch without closing; ↑↓ moves), filter chips, rows with actions, and "Open the <tab> tab ↗". Esc closes. Size `min(880px, 100% − 48px)` × `min(600px, 100% − 48px)`. | The right drawer: narrow, and SYSTEM ▸ keeps it. One popup per tile: closing to switch. |
| P4 | **Safe actions act here; decisions jump** (user's pick). Act: Fix-Queue spawns, run a routine now, mark read/archive, tick a to-do, keep/edit/revert a memory, open a file. Jump (labelled "→"): a proposal or flag → the flag-closer review in Term, feedback drafts → `feedback-review` in Term, a team gate → the Agent Teams item (its ConfirmModal). No new approve path. A health issue without a scripted fix offers Details (`health.md`) and "Fix in a session →". | Approve and reject in Pulse: a second approve path beside the flag-closer's ledger. Show only: a click to do anything. |
| P5 | **Pulse is Home** (user's pick, reverses UniDeX D5): `homeTab()` returns `pulse`, Pulse heads the rail, then Sessions. Pulse's rail badge is the Needs-you count, in gate violet, or rose when it holds an error. | Sessions as Home (D5). Pulse as an overlay from any tab. |
| P6 | **The Chief of Staff writes the paragraph** (user's pick): `brain/scripts/persona/briefing.js`, run by a `kind: command` routine `briefing` every 30 minutes from 7:00 to 22:00, and on demand. It hashes its facts and skips unchanged input, then makes one `provider.js` chat call with a JSON schema `{text, mentions[{phrase, area}]}`. It writes `brain/_index/briefing.json` `{status, text, mentions, provider, model, generatedAt, factsHash, seenFacts}`. Spend is ledgered as `duty:briefing`, so it counts against `persona.perDayUsd`. Command routines are not gated, so the script runs `record-spend.js --check` itself. | Template only. A stage inside scan-vault: it runs at every SessionEnd and detaches under Codex's 3 s cap, the wrong cadence for a paragraph. Friday's `tick` duty: a headless agent job costs far more than a one-shot. Writing `brief.md`: it is injected into every session start (`inject-context.js:52`). |
| P7 | **Template fallback, always shown.** If `briefing.json` is missing, failed, older than `persona.briefing.staleHours` (3), or the provider is `none` or at its daily cap, the HUD composes the paragraph from the same facts (`buildBriefing` widened to the new sources) and labels it "template". With no persona the band says BRIEFING, as today. | A blank band. The stale model text with only a timestamp. |
| P8 | **One definition of the facts**, in two languages: `brain/scripts/lib/pulse-facts.js` for the writer and `hud/src/data/pulseFacts.ts` for the tiles. Both compute the Needs-you items and their order. A shared fixture (`brain/scripts/test/fixtures/pulse-facts/`) pins both to the same output, following the slug-parity test (term spec T6). | The HUD writes a facts file: it exists only while the app runs, and it widens the page's writes. Facts only in the snapshot: up to 45 minutes stale, and the tiles want vault events. |
| P9 | **Needs-you order:** decisions waiting on you (proposals, team gates, flags, drafts) and errors first, then stale or failing work (pipelines, routines with a fail streak, error runs), then unread notifications (breaking first), then memories to review. Ties go to the oldest. | Severity only: a 16-day decision sinks under warnings. |
| P10 | **"Since you last looked"**: `pulseSeenAt` in the HUD settings, stamped when you leave Pulse. The line counts new notifications, memories written, failed runs and new decisions since then. It replaces "Δ since <snapshot>". | The snapshot delta: it measures scans, not you. |
| P11 | **Commands row** (user's pick): `COMMAND_REGISTRY` as one compact row under the paragraph, with the same `.aos-deck-btn` buttons and `executeCommand`. | ⌘K only. Inside the Health popup. |
| P12 | **Ten tiles** (user's pick): Needs you, System health, Agents, Workspaces, To-Do, Decisions, Notifications, Routines, Spend, Memory. Old Pulse maps across: the pipeline chips become Health's dots and its popup list (`.aos-pulse-chip` kept, since other tabs share it); the Fix Queue becomes Needs you plus the Health popup; the trail becomes Memory; the cost row becomes Spend (shown only with cost on, as today). | Fewer tiles: the user wants every area visible. |
| P13 | **↻ on the band** spawns `persona/briefing.js --force`, a new pulse-surface rule (precedent: Spaces' `regen-workspace-insight.js`) and a SECURITY.md line. | No refresh: up to 30 minutes old. |
| P14 | **Seeding.** New vaults get `brain/routines/briefing.md` from `vault-template`. On an existing vault the band shows "Turn on <name>'s briefing", which writes the routine through the Routines surface (`brain/routines/*.md`) and runs `aos routines sync`. The installer does not change. | An `aos upgrade` migration: installer churn on both hosts for one file. |
| P15 | **Two PRs, then 1.5.0:** PR 1 is the runtime (facts, writer, routine, config keys, template seed); PR 2 is the HUD (tiles, popup, Home, band, settings, e2e). | One PR: too large to review. |

## 3. What already exists (verified at `9831438`)

- **Loaders for every tile:**
  - Proposals: `proposals.ts`, `proposalBadge`.
  - To-dos: `todos.ts` `groupTodos`, `todoBadge`.
  - Notifications: `notifications.ts` `unreadBadge`, writes via `notificationWriter.ts`.
  - Teams: `teams.ts` `pendingGates`, `gateBadge`.
  - Routines: `routines.ts` `health`, `failStreak`.
  - Runs: `runs.ts`. Agents: `agents.ts`. Workspaces: `snapshot.ts` `WorkspaceEntry`.
  - Live: `staff.ts`, `personaHeartbeat.ts`, the Sessions host list and the Term pool.
  - Spend: `provider-spend.jsonl`, as `SessionsTab` already reads it.
- **New HUD reads:** `persona/STATE.md` `## Flags` and `brain/memory/feedback/_drafts/*.md`.
- **The shell:** `RAIL` and `homeTab()` (`WorkbenchView.ts:36-51, :150`), `refreshBadges` (`:201-211`), and the compat `Modal` with Esc and focus kept inside (`app/obsidian-compat/src/modal.ts:9-35`). The smallest window is 960×600 (`app/src/main/index.ts:356-357`).
- **Writes are path-based across enabled surfaces** (`write-policy.ts`), so Pulse's actions are already admitted:
  - To-Do: `TODO.md`.
  - Notifications: `state.json`.
  - Routines: `run-routine.js <slug> --manual` and `brain/routines/*.md`.
  - Pulse: Fix-Queue scripts and trail writes (`surfaces.ts:107-180`).
- **Runtime:**
  - `provider.js` resolves ollama → claude → codex → none (`:233-274`, exports `:345`).
  - `duty:` rows escape the hook cap (`sdk/lib/spend-ledger.js:61`), and `record-spend.js --check` gates duty spend.
  - `kind: command` routines are the heartbeat precedent (`vault-template/persona/routines/heartbeat.md`, `run-routine.js:16`).
  - Input hashing to skip model calls: `tick.js:147` `signature()` and `collectors/workspaceInsights.js:46-75`. The latter is also the precedent for falling back under `none`.
  - Config precedent: `persona.model` / `persona.codexModel` (`settings-schema.js:130-135`).
- **Tests that pin today's Pulse and Home:**
  - `pulse.spec.ts` (12 tests) and `pulse-writes.spec.ts`.
  - `variants.spec.ts:124`, which says Sessions is Home, and `shell.spec.ts:21`.
  - `app-smoke.md:16, :56-67`, and COVERAGE I1 and P1–P10.

## 4. Design

**Runtime (PR 1):**
- `lib/pulse-facts.js`: `collectFacts(vault)` returns counts and top items per area, plus `needsYou[]` in P9 order. Reads only files and caches, never transcripts.
- `persona/briefing.js [--force]`:
  1. Exits 0 when `persona.enabled` is false, `persona/DISABLED` exists, or `persona.briefing.enabled` is false.
  2. Computes the facts hash; an unchanged hash without `--force` exits 0.
  3. Runs the cap check, then `getProvider('duty:briefing').chat({ system, prompt: facts, schema })`.
  4. The system prompt carries the persona's name and voice from `IDENTITY.md`, at most 3 sentences, facts only.
  5. Validation: each `mention.phrase` must occur in `text`, and `area` must be one of the ten.
  6. Writes atomically with `fsx`. `PROVIDER_NONE` or `PROVIDER_CAP` writes `{status: "skipped", reason}`; any other failure writes `{status: "failed"}`, keeping the last good text.
- **Config** under `persona.briefing`: `enabled` (true) and `staleHours` (3). Each key also goes into `settings-schema.js` and `aosConfig.ts` `VAULT_CONFIG_DEFAULTS`.
- **Amendment A1 (build, 2026-10-08):** there is no briefing model key. `getProvider()` already carries the background-call models, `claude.model` (default `haiku`, `claude.perCallUsd` 0.05) and `codex.model` (null = the user's Codex default, `codex.effort` low). Those are this spec's defaults, and `provider.js` has no per-feature model. The facts reuse `lib/statusline-model.js`'s readers (`readTeams`/`gatesOf`, `countFlags`, `ledgerToday`), which already define gates, flags and today's spend for the status line.
- **Amendment A2 (build, 2026-10-08):** errors get their own first tier, ahead of decisions. An error has no date, so inside a shared tier it sorted after every dated decision, and the one thing actually broken fell out of the briefing's top three. The order is now: health errors; decisions (gates, proposals, flags, drafts); stale or failing work; breaking unread; other unread and to-dos due today; memories to review.
- **Amendment A3 (build, 2026-10-08):** the model writes only `{text}`. For each item the writer supplies the words to use (`say`: the title, "the <title> proposal", a flag cut at 70 characters) and a "what is fine" list. The mentions are those words found again in the text, ignoring case and allowing a spelled-out count, plus "N more" → the Needs-you list. A local model tried on the fixture invented dates and turned the list of areas into links; supplied words leave it nothing to invent.
- **Amendment A4 (review, 2026-10-08):** a proposal's title is quoted: "the “<title>” proposal". Unquoted, a title that starts with an article or a verb read badly ("the An idea with loose ends proposal"). The model is told to keep the quotation marks; the writer's `mentionsFor` treats every double-quote style alike and also accepts the words with no quotes, and the HUD's `mentionParts` folds quote styles the same way.
- **Amendment A5 (user decision, 2026-10-08):** the upgrade turns the briefing on. `aos upgrade` (which the app's runtime upgrade runs too) adds `brain/routines/briefing.md` when the vault lacks it and the version it last recorded in `agenticos.json` is before 1.5.0, then re-renders the installed schedules, which now include it. It is listed in `NEW_ROUTINES` (`cli/aos.js`) with the release that added it, so a later routine can follow the same path. Once a vault is on 1.5.0, a routine its owner deleted stays deleted. Rejected: re-adding any missing template routine on every upgrade (it would undo deletions, which spec D10 protects); a marker file recording what was seeded (the recorded version already says it); leaving it to Pulse's **Turn on** (the user asked for it to be on after the update). It is added whether or not the persona is on, as on a new vault; `briefing.js` exits without a model call while the persona is off.
- **Routine** `vault-template/brain/routines/briefing.md`: `kind: command`, `*/30 7-22 * * *`, `argv: [{{NODE}}, {{VAULT}}/brain/scripts/persona/briefing.js]`, `timeoutSec: 90`, tags `[persona]`.

**HUD (PR 2):**
- `data/pulseFacts.ts`: P8's twin. Tiles refresh on vault events for their files: proposals, `TODO.md`, notifications, routines, runs, `briefing.json`, snapshot and pipelines.
- `views/PulseTab.ts`, rebuilt:
  - The band: avatar initial, name, "briefing · time", the paragraph with each mention as a chip that opens its area, the since line, the commands row, ↻, and two primary actions taken from the top two Needs-you items.
  - Then the grid of `ui/pulse/Tile*.ts`.
- `ui/PulsePopup.ts` (Modal) with one `ui/pulse/area<Name>.ts` renderer per area, each reusing its tab's loader and writer.
- `WorkbenchView`: Pulse first in `RAIL`, `homeTab()` returns `pulse`, and a pulse badge in `refreshBadges`.
- `settings`: `pulseSeenAt`.
- Styles: `.aos-pulse-*` with tokens only (`check:hex`), in both themes. Tones follow UniDeX §4.3.

**Accessibility:** tiles are buttons, and Needs you is a card whose header and rows have their own buttons (no nested buttons). The popup is `role=dialog` with a label. Every tone carries a text label.

## 5. Host parity

1. **Entry point.** The app opens on Pulse on both hosts. No plugin command, skill or MCP tool. `aos routines run briefing` is host-neutral.
2. **Hooks.** None.
3. **Model calls.** One `provider.js` chat per changed fact set:
   - Claude only: `claude.model` (A1), capped per call by `claude.perCallUsd`.
   - Codex only: `codex.model` (A1) at `codex.effort` (low); the daily cap gates the start, and the cost is estimated after.
   - Ollama: free and first in `auto`.
   - `none` or capped: the template.
4. **Session data.** None. The live-session count comes from the app's Sessions host and the Term pool, not transcripts.
5. **MCP.** None. `brief_read` and `brief.md` are untouched.
6. **Degradation:**
   - No persona: a BRIEFING template.
   - Briefing off, or provider `none`: the template, labelled.
   - Routine missing: "Turn on".
   - Codex-only vault: everything renders (`variants.spec.ts`), and the jumps that start a session name Codex.
7. **Docs:**
   - README (Pulse, Home) and `app/README.md`.
   - CHANGELOG, with an **Upgrading** note: "Turn on" in Pulse, or copy the routine.
   - SECURITY.md (the ↻ spawn) and the routines README.
   - `docs/app-smoke.md` Pulse items per host, with their COVERAGE rows.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Open UniDeX (Home), ↻, or the routine | `briefing.js` → Claude one-shot (`haiku` default) | the template paragraph, labelled, with the reason |
| Codex only (plugin · direct) | Same | `briefing.js` → Codex one-shot (user default model, low effort) | Same |
| Both | Same | `auto`: Ollama → Claude → Codex | Same |

No cell differs from the other host's beyond the known cap mechanics, so there is no new gap.

## 6. Testing

- **Runtime unit:**
  - `pulse-facts` ordering on fixtures.
  - The briefing writer per provider, with a fake provider: an unchanged hash skips; `none` and cap skip; a bad mention is dropped; a failure keeps the last text.
  - The cap check, and the settings-schema drift test.
- **Parity:** `pulseFacts.ts` and `pulse-facts.js` match on the shared fixture.
- **HUD unit:** the row budget by height, the band composer and its template, the badge tone, and `pulseSeenAt`.
- **e2e:**
  - Rewrite `pulse.spec.ts`: tiles, the popup's area switch with Esc, safe actions (tick a to-do, mark read, run a routine), and jumps landing on Term or Agent Teams.
  - 960×600 has no scrollbar (`scrollHeight === clientHeight`).
  - Home is Pulse.
  - `variants.spec.ts`: Codex-only, with no persona and with no provider.
  - Keep the P5–P8 deck tests.
- **By hand (asks first; it spends):** one briefing per host, and the ledger rows show `duty:briefing` with each host's provider.

## 7. Out of scope

- Linking to-dos and notifications to workspaces (the Map view, C).
- The 24 h timeline (D).
- Writing `brief.md` for sessions.
- A model-written weekly recap.
- Pulse as an overlay from other tabs.
- Approving proposals inside the app.
