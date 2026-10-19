# Pulse cockpit: build plan

Spec: `docs/design/specs/2026-10-08-pulse-cockpit-design.md` (approved 2026-10-08; amendment A1). Two PRs, then
release 1.5.0 (P15). Each PR runs the skill's verify and publish checks before it opens.

## File structure

| File | PR | New / changed | What |
|---|---|---|---|
| `brain/scripts/lib/pulse-facts.js` | 1 | new | `read(vault, {now})` gathers the raw inputs; `facts(inputs, now)` is pure (P8, P9) |
| `brain/scripts/lib/statusline-model.js` | 1 | changed | exports `readTeams` and `countFlags` beside `gatesOf` / `ledgerToday` (no behaviour change) |
| `brain/scripts/persona/briefing.js` | 1 | new | the writer (P6): guards, hash, cap check, one provider call, validation, atomic write |
| `brain/scripts/test/pulse-facts.test.js` | 1 | new | ordering, tiers, titles, summary, the fixture vault |
| `brain/scripts/test/briefing.test.js` | 1 | new | fake provider: write, unchanged skip, `none`/cap skip, bad mention dropped, failure keeps text, guards |
| `brain/scripts/test/fixtures/pulse-facts/` | 1 | new | a small vault: proposals, STATE.md flags, drafts, a team gate, snapshot, pipelines, routines, TODO.md, notifications, trail |
| `brain/scripts/config.default.json` | 1 | changed | `persona.briefing: { enabled: true, staleHours: 3 }` |
| `brain/scripts/lib/settings-schema.js` | 1 | changed | two SETTINGS rows in the persona section |
| `hud/src/data/aosConfig.ts` | 1 | changed | the copy in `VAULT_CONFIG_DEFAULTS` and the `VaultConfig` type (the drift test needs both sides in one PR) |
| `vault-template/brain/routines/briefing.md` | 1 | new | `kind: command`, `*/30 7-22 * * *` (P6, P14) |
| `vault-template/brain/routines/README.md` | 1 | changed | lists the routine |
| `CHANGELOG.md` | 1, 2 | changed | Added lines; Upgrading (Turn on) in PR 2 |
| `hud/src/data/pulseFacts.ts` (+ test) | 2 | new | the TS twin; the parity test loads `pulse-facts.js` with `createRequire` (precedent `teams.test.ts`) |
| `hud/src/data/briefingBand.ts` (+ test) | 2 | new | model text vs template (P7), mentions → chips, the since line (P10) |
| `hud/src/views/PulseTab.ts` | 2 | rebuilt | band, commands row, the ten tiles, row budgets (P1, P2, P11, P12) |
| `hud/src/ui/pulse/*.ts` | 2 | new | one tile renderer and one popup-area renderer per area |
| `hud/src/ui/PulsePopup.ts` | 2 | new | compat `Modal` with the area list (P3) and the actions (P4) |
| `hud/src/views/WorkbenchView.ts` | 2 | changed | Pulse first, `homeTab()` → pulse, Pulse badge (P5) |
| `hud/src/settingsDefaults.ts` | 2 | changed | `pulseSeenAt` |
| `hud/styles.css` | 2 | changed | `.aos-pulse-*` cockpit rules, tokens only |
| `app/src/shared/surfaces.ts` + `SECURITY.md` | 2 | changed | the pulse surface's `persona/briefing.js --force` spawn (P13) |
| `app/tests/e2e/pulse.spec.ts`, `pulse-writes.spec.ts`, `variants.spec.ts`, `shell.spec.ts` | 2 | changed | the cockpit, Home, 960×600, Codex-only |
| `docs/app-smoke.md`, `app/tests/e2e/COVERAGE.md`, `README.md`, `app/README.md` | 2 | changed | Pulse items per host, Home |

## PR 1: runtime (`feat: the Chief of Staff's Pulse briefing writer`)

- [ ] `statusline-model.js`: export `readTeams` and `countFlags`; its tests stay green.
- [ ] `pulse-facts.js`:
  - `read()`: proposals (the `isProposalFile` rule), STATE.md, the drafts count, gates (`gatesOf`), a trimmed snapshot (`health.issues`, `workspaces[].status`), pipelines, routines state, TODO.md, unread or archived-aware notifications (newest 200), today's trail rows with pending review (`reviewed: false`), and today's spend (`ledgerToday`).
  - `facts()`: the P9 tiers, titles, summary and `hash` (sha1 of the needs-you keys + summary).
- [ ] The pipeline manifest port (names, `staleMs`, died 10 min) and the to-do item parse (`ITEM_RE`, 📅, ✅), each with a comment naming its TS source.
- [ ] `briefing.js`:
  - CLI `[--force] [--root <vault>]`; exits 0 on every path.
  - Guards: persona off, briefing off.
  - Hash skip: the state lives in `briefing.json` `factsHash`.
  - `record-spend.js` caps: `dutySpendFrom` against `persona.perDayUsd`.
  - `getProvider('duty:briefing')`, then `chat({system, prompt, schema, feature: 'duty:briefing', timeoutMs: 60000})`.
  - Parse and validate, then `fsx.writeAtomic`.
- [ ] The system prompt: the persona's name from IDENTITY.md H1; three sentences at most; facts only; every phrase in `mentions` copied verbatim from `text`; areas from the fixed list.
- [ ] Config keys, the schema rows, `VAULT_CONFIG_DEFAULTS`; the drift tests pass.
- [ ] The template routine and README; `cli/vault-template.test.js` passes.
- [ ] Tests: `node --test brain/scripts/test/pulse-facts.test.js brain/scripts/test/briefing.test.js`, then the whole `npm test`.
- [ ] CHANGELOG `[Unreleased]` → Added.
- [ ] Verify (§5), publish-check (§6), commit, push, PR, CI, then ask to merge.

## PR 2: HUD (`feat: Pulse becomes Home: a no-scroll cockpit with the Chief of Staff's briefing`)

- [ ] `pulseFacts.ts`: build the inputs from the HUD loaders, then the pure twin. Parity test over the fixture vault with `createRequire(pulse-facts.js)`.
- [ ] `briefingBand.ts`:
  - `chooseParagraph(briefingJson, templateFacts, now, staleHours)` returns `{text, mentions, source: model|template, reason}`.
  - `mentionSpans(text, mentions)` returns the text split into plain and chip parts.
  - `sinceLine(facts, seenAt)`.
- [ ] Tiles (ten) with `rowBudget(heightPx, rowPx, fixedPx)`. Needs you is a card (header button + row buttons); the rest are button tiles.
- [ ] `PulsePopup` (Modal):
  - The area list (↑↓), filter chips, rows, actions, "Open the <tab> tab ↗", and Esc.
  - Sized `min(880px, 100% − 48px)`.
  - Area renderers reuse `notificationWriter.setFlags`, `todoWriter.applyTodoEdit` + `toggleTodo`, `run-routine.js --manual`, the Fix-Queue `execute`, and trail keep/edit/revert.
  - Jumps go through `runInTerm(reviewCommand…)`, `feedback-review`, `setTab("agent-teams")`.
- [ ] Band: chips open their area; ↻ spawns `persona/briefing.js --force`; "Turn on" writes `brain/routines/briefing.md` and runs `aos routines sync`; the commands row (`COMMAND_REGISTRY`, same buttons); the two top actions.
- [ ] `WorkbenchView`:
  - `RAIL` order (Pulse first), `homeTab()` returns `pulse`.
  - Pulse badge: the Needs-you count; rose when it holds an error.
  - `touchesBadges` covers the new paths.
- [ ] `pulseSeenAt` is stamped when Pulse unmounts; the since line counts after it.
- [ ] Styles: tokens only (`check:hex`), both themes, no scroll at 960×600.
- [ ] Surface rule + SECURITY.md line + `write-policy.test.ts` case.
- [ ] e2e:
  - The tiles, popup area switch and Esc.
  - Tick a to-do, mark read, run a routine.
  - The proposal jump lands on Term.
  - At 960×600: `scrollHeight === clientHeight`.
  - Home is Pulse; Codex-only; no persona; no provider.
  - Keep P5–P8.
- [ ] Docs: README (Pulse, Home), `app/README.md`, app-smoke Pulse items per host + COVERAGE rows, CHANGELOG (Changed: Home; Upgrading: Turn on).
- [ ] App checks: `typecheck`, `test:unit`, `check:compat`, `test:e2e`; then publish-check, PR, CI, ask to merge.

## Release (when asked)

- [ ] The release steps from the skill.
- [ ] §8 update check.
- [ ] `aos upgrade --from-local`.
- [ ] Turn on the briefing in Pulse.
- [ ] One briefing per host (asks first: it spends).
