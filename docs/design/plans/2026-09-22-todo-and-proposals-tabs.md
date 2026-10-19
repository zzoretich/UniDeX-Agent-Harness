# To-Do and Proposals tabs — implementation plan

Spec: `docs/design/specs/2026-09-22-todo-and-proposals-tabs-design.md` · Branches: `feat/proposals-tab` (PR 1), then `feat/todo-tab` (PR 2)

## Global constraints

- TypeScript in `hud/`, tests beside the source as `*.test.ts` (`node --import tsx --test`).
  Logic lives in `src/data/` (tested); `src/views/` stays thin.
- No raw hex colours outside `src/ui/tokens.ts` (`npm run check:hex`); styles use the existing tokens.
- The HUD writes only `TODO.md`. It never writes under `persona/`, never appends to the ledger, never commits.
- The plugin command count becomes 16 (`/todo`) in PR 2; `cli/plugin-commands.test.js`, `cli/codex-host.test.js`
  and the README layout line change together.
- No absolute home paths; `npm run gate` clean; one commit per task; no session trailers.

## File structure

| File | PR | Change |
|---|---|---|
| `hud/src/views/WorkbenchView.ts` *(modify)* | 1 | Two `RAIL` entries after Pulse, `makeTab` arms, `setBadge(id, n)`, a vault-event badge refresher (250 ms debounce). |
| `hud/src/data/badges.ts` + `.test.ts` *(new)* | 1 | `proposalBadge(names)`; `todoBadge(text, today)` lands in PR 2. |
| `hud/src/views/TermTab.ts`, `src/ui/TerminalPanel.ts` *(modify)* | 1 | `showSession(id)` → public `TerminalPanel.activate(id)`; `WorkbenchView.runInTerm(command)` creates the session first. |
| `hud/src/data/proposals.ts` + `.test.ts` *(new)* | 1 | `parseProposal`, `parseBacklog`, `parseLedger`, `ledgerRates`, `historyRows`, `parseConfirmations` (spec §4.2). |
| `hud/src/data/fixtures/proposals-vault/persona/*` *(new)* | 1 | Four proposals (clean, product, every lint path), a ledger with a corrupt line, confirmations; the backlog is written by `backlog.js` in the test. |
| `hud/src/views/ProposalsTab.ts` *(new)* | 1 | Pending / Backlog / History groups; Review in Claude; Open file; no-persona hint. |
| `hud/main.ts` *(modify)* | 1, 2 | `proposals` then `todo` in the `open-workbench-<t>` loop (display name "To-Do" for `todo`). |
| `hud/styles.css` *(modify)* | 1, 2 | `.aos-wb-railbadge`, proposal rows and chips; todo rows, groups, filter row. |
| `hud/src/data/todos.ts` + `.test.ts` *(new)* | 2 | Parse / group / add / toggle / edit / remove (spec §4.3). |
| `hud/src/data/todoWriter.ts` + `.test.ts` *(new)* | 2 | Adapter-based read-modify-write with stale-line refusal; create from template. |
| `hud/src/views/TodoTab.ts` *(new)* | 2 | Quick-add, pickers, tick, edit, tag filter, Done-this-week (spec §4.4). |
| `plugin/commands/todo.md` *(new)* | 2 | `/todo <text>` (spec §4.5). |
| `vault-template/TODO.md` *(new)*, `vault-template/AGENTICOS.md` *(modify)* | 2 | Seed file; `/todo` in "Capture vocabulary". |
| `cli/vault-template.test.js`, `cli/plugin-commands.test.js`, `cli/codex-host.test.js`, `cli/aos.test.js`, `cli/rehearsal/first-run.sh` *(modify)* | 2 | Seed assertion; 16 commands and the embedded-seed check; 20 generated Codex skills (19 beside a foreign one); rehearsal checks `TODO.md`. |
| `README.md`, `docs/plugin-smoke.md`, `docs/chief-of-staff.md` *(modify)* | 1, 2 | Tab lines, `/todo` row, "16 commands", smoke sections, a pointer to the Proposals tab. |

## Tasks — PR 1 `feat/proposals-tab`

### Task 1 — Proposals data layer
- [ ] `proposals.ts` mirroring `collect.js` kinds, surfaces and lint; `parseLedger` rates match `ledger.js summary` on the fixture.
- [ ] `parseConfirmations()` reads `{ schema: 1, slugs }` and the legacy flat shape.
- [ ] Commit: `feat(hud): proposals data layer`.

### Task 2 — Rail badges and runInTerm
- [ ] `setBadge`, `badges.ts` (`proposalBadge`), the vault-event refresher; styles.
- [ ] `WorkbenchView.runInTerm(command)`, `TermTab.showSession`, `TerminalPanel.activate`.
- [ ] Commit: `feat(hud): rail count badges and runInTerm`.

### Task 3 — Proposals tab
- [ ] `ProposalsTab.ts`, rail entry, `makeTab`, palette command; Markdown-rendered sections; empty and no-persona states.
- [ ] `docs/plugin-smoke.md` `## Proposals`; README tab line; `docs/chief-of-staff.md` pointer.
- [ ] Commit: `feat(hud): proposals tab`.

### Task 4 — Verify and publish PR 1
- [ ] `npm run gate` · `npm test` · `npm run build -w hud`.
- [ ] `publish-check.js` clean; push; PR; CI green; **merge decision**.

## Tasks — PR 2 `feat/todo-tab` (branched from `main` after PR 1 merges)

### Task 5 — Todo data layer and writer
- [ ] `todos.ts`: Tasks tokens (`📅 ⏫ 🔼 🔽 ✅ #tag`), unknown tokens preserved, indented children travel, grouping by local date.
- [ ] `todoWriter.ts`: re-read before every write; stale line → no write + Notice; create from template.
- [ ] `todoBadge` in `badges.ts`.
- [ ] Commit: `feat(hud): todo parser and writer`.

### Task 6 — To-Do tab
- [ ] `TodoTab.ts`, rail entry, `makeTab`, palette command, styles; live refresh on `TODO.md`.
- [ ] `docs/plugin-smoke.md` `## To-Do`.
- [ ] Commit: `feat(hud): to-do tab`.

### Task 7 — `/todo` command and seed
- [ ] `plugin/commands/todo.md`; `vault-template/TODO.md`; `AGENTICOS.md` vocabulary.
- [ ] Count tests (16 commands; Codex 20, or 19 beside a foreign skill), `cli/vault-template.test.js`, rehearsal, README row and layout line, `docs/install.md`.
- [ ] Commit: `feat: /todo command and TODO.md seed`.

### Task 8 — Verify and publish PR 2
- [ ] `npm run gate` · `npm test` · `npm run build -w hud` · `sh cli/rehearsal/first-run.sh`.
- [ ] `publish-check.js` clean; push; PR; CI green; **merge decision**.

## Task 9 — Bring it home (machine side, after each merge)
- [ ] `aos upgrade --from-local ~/AgenticOS-Workbench && aos doctor`; reload the Obsidian plugin.
- [ ] Proposals: tab shows "Nothing pending" today; Review in Claude opens Term running the review.
- [ ] To-Do: `/todo` from a session lands in `<vault>/TODO.md`; the tab updates without a reload; ticking moves it to Done.
