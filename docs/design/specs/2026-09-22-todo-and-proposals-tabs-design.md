# To-Do and Proposals tabs — design

Date: 2026-09-22 · Branches: `feat/proposals-tab`, then `feat/todo-tab` · Verified against `2f3f6a9`

## 1. Problem

The Workbench rail has seven tabs, but two things the owner acts on every day have no surface:

- **Todos.** There is no todo list. Open `- [ ]` lines are scattered across daily notes, workspace
  `PLAN.md` files and `persona/STATE.md ## Flags`, and nothing collects, dates or ranks them.
- **Proposals.** The Chief of Staff files guarded changes as `persona/proposals/YYYY-MM-DD-<slug>.md`,
  records outcomes in `persona/ledger.jsonl`, and appends accepted ideas to `persona/backlog.md`. The
  HUD shows none of it. The only way to see what is pending is a Claude session ("review persona flags")
  or reading the files by hand.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | Todos live in one vault file, `<vault>/TODO.md`, with `## Open` and `## Done` sections of `- [ ]` lines. | Aggregate every open checkbox in the vault; file plus aggregation; Apple Reminders. | One file is git-tracked, Obsidian-editable, readable by Claude and works on Linux. Aggregation doubles the build and makes "tick" ambiguous across files; Reminders is macOS-only. |
| D2 | Writers: the To-Do tab, and a new `/todo <text>` plugin command (prompt-only, like `/remember`). Agents read `TODO.md` through the existing tools; no MCP write tool. | Tab only; add `todo_add`/`todo_done` MCP tools. | Capturing from any session is the common case. A second MCP write tool is a trust step the owner did not take. |
| D3 | Each todo carries optional due date, #tags and priority in Obsidian Tasks-plugin syntax: `📅 YYYY-MM-DD`, `⏫` high, `🔼` medium, `🔽` low. The tab groups Overdue / Today / Upcoming / Someday and sorts by priority within a group; a tag filter row narrows the list. | Text only; due + tag without priority; a full model with recurrence and notes. | Tasks syntax keeps the file compatible with that plugin. Priority was the owner's explicit add. Recurrence overlaps tools that do it better. |
| D4 | Ticking moves the line under `## Done` with `✅ YYYY-MM-DD`. The tab shows only the last 7 days of Done, collapsed. Nothing is deleted. | Tick in place; monthly archive file; delete. | History stays citable by `/standup` and `/reflect-week` later; the list grows slowly enough that no archive is needed. |
| D5 | The Proposals tab lists three groups: **Pending** (the files in `persona/proposals/`), **Backlog** (sections of `persona/backlog.md`), **History** (`persona/ledger.jsonl` outcomes, newest first, with the 28-day approval and accept rates). | Pending only; an inbox of every draft awaiting sign-off (feedback drafts, consolidation drafts). | Pending alone is empty most days. The other drafts have their own review flows and would blur this one. |
| D6 | The Proposals tab is read-only. A pending row expands to What / Why / Risk / Premises, kind, surface, target, age, lint and the recheck streak. One header button, **Review in Claude**, opens the Term tab running `claude "review persona flags"`; each row has **Open file**. | Accept/Dismiss/Close-stale buttons in the HUD; every verb in the HUD via a headless run; no action at all. | `persona-flag-closer` owns the ledger append, backlog append and the per-decision commit. A second implementation in TypeScript would drift, and the plugin never calls a model. |
| D7 | Rail order becomes Pulse, **To-Do**, **Proposals**, Spaces, Memory, Runs, Routines, Chat, Term. Each new button carries a count badge (open todos overdue or due today; pending proposals) that refreshes on vault events, whether or not the tab is mounted. Pulse is unchanged. | Badges plus a Pulse row; end of rail without badges. | The badge is the glance; Pulse already carries enough rows. |
| D8 | One spec, two PRs: `feat/proposals-tab` first (read-only, adds the badge support and `runInTerm`), then `feat/todo-tab`. | One PR for both; spec only. | Each PR stays reviewable in one sitting; the second reuses the first's rail work. |

## 3. What already exists (at `2f3f6a9`)

- `hud/src/views/WorkbenchView.ts:15` — `RAIL` array and `makeTab()`; a tab is any object with
  `mount / refresh / unmount`. Rail buttons have an icon and a label, no badge.
- `hud/src/views/RunsTab.ts:38` — the live-refresh pattern: `view.registerEvent(vault.on("modify"))`
  filtered by path, coalesced by a 250 ms `schedule()` debounce.
- `hud/src/data/routineWriter.ts:10` — the HUD's vault-write pattern: pure compose + a small
  `RoutineAdapter` (exists / read / write / mkdir / remove) so tests stub IO without `obsidian`.
- `hud/src/data/frontmatter.ts` — the HUD's frontmatter parser.
- `hud/src/data/terminalSession.ts:5` — `TerminalSessionOptions` has no command; a session starts
  the shell. `write(data)` at `:111` sends input. `SpacesTab.ts:403` already calls `terminalPool.create({ cwd })`.
- `plugin/skills/persona-flag-closer/scripts/collect.js:59` — `collectProposals()`: frontmatter, premise
  table, kinds `self | vault | workflow | product`, surfaces, lint rules. The HUD mirrors these rules.
- `brain/scripts/persona/ledger.js:29` — events and terminal set; records are
  `{ schema, ts, event, slug, kind, target, by, class?, recheck?, commit?, note? }`; `summary()` uses a 28-day window.
- `brain/scripts/persona/backlog.js:62` — a backlog section is `## <filed> · <kind> · <slug>` then `- target:` lines.
- `brain/scripts/persona/recheck.js:16` — `persona/flag-closer/confirmations.json`
  `{ schema: 1, recordedDay, slugs: { <slug>: n } }`; auto-apply needs `n >= 2`.
- `plugin/commands/remember.md` — prompt-only command pattern (`allowed-tools: Read, Edit`).
- `cli/plugin-commands.test.js:8` — the 15 contract commands; `cli/codex-host.test.js:111` — 18 generated Codex skills.

## 4. Design

### 4.1 Shared rail work (PR 1)

- `WorkbenchView`: two `RAIL` entries (`todo` `☐` "To-Do", `proposals` `⚖` "Proposals") and `makeTab` arms;
  `setBadge(id, n)` renders a small count on the rail button (hidden at 0).
- `src/data/badges.ts` (pure): `todoBadge(text, today)` and `proposalBadge(fileNames)`. WorkbenchView computes
  both on open and on vault `create | modify | delete | rename` of `TODO.md` or `persona/proposals/*`
  (250 ms debounce), independent of the active tab.
- `WorkbenchView.runInTerm(command)`: creates a pool session with `cwd` = `vaultRoot()` and writes
  `command + "\r"` *before* switching to the Term tab (so the panel's "ensure one session" does not add a
  blank shell), then `TermTab.showSession(id)` → a new public `TerminalPanel.activate(id)`, which the
  panel's own tab click now uses too. The pool and pty stay unchanged.

### 4.2 Proposals tab (PR 1)

- `src/data/proposals.ts` (pure, tested): `parseProposal(name, text)` → `{ slug, filed, kind, surface, target,
  recheck, autoapplyClass, what, why, risk, premises[], lint[], decision }` with `collect.js`'s rules;
  `parseBacklog(text)` → sections; `parseLedger(text)` → records, `ledgerRates(records, now)` →
  `{ approvalRate, acceptRate }` by `ledger.js summary`'s formula, `historyRows(records)` → outcomes newest
  first; `parseConfirmations(json)` → slug → n. The tests run the runtime scripts on the same fixture vault.
- `src/views/ProposalsTab.ts` (thin): three collapsible groups. Pending rows show slug, kind chip, surface,
  age, `confirmed n d`, and lint in amber; expanding renders the sections as Markdown via
  `MarkdownRenderer`. Header: counts plus **Review in Claude** (`runInTerm('claude "review persona flags"')`).
- No `persona/` folder → a one-line hint ("The Chief of Staff isn't set up — run `aos persona`"), tab still shown.
  An empty Pending group reads "Nothing pending — the Chief of Staff files proposals from its reflect duties."

### 4.3 To-Do file (PR 2)

```
# To-Do

## Open
- [ ] Renew passport ⏫ 📅 2026-10-01 #personal

## Done
- [x] Fix upgrade re-exec ✅ 2026-09-21
```

- `src/data/todos.ts` (pure, tested): `parseTodos(text)` → items with `{ line, text, done, due, doneOn,
  priority, tags, section }`; unknown Tasks tokens and non-todo lines are preserved verbatim;
  indented lines under an item travel with it. `group(items, today)` → Overdue / Today / Upcoming / Someday,
  priority-sorted. `add`, `toggle`, `edit`, `remove` return the new file text.
- `src/data/todoWriter.ts`: the `routineWriter` adapter shape. Every write re-reads the file and locates the
  item by its exact raw line; if the line is gone (edited elsewhere, e.g. by `/todo`), it writes nothing,
  shows a Notice and re-renders. A missing `TODO.md` is created from the template on first add.

### 4.4 To-Do tab (PR 2)

`src/views/TodoTab.ts`: quick-add input (Enter adds to `## Open`; inline `📅`/`⏫`/`#tag` text is parsed as
typed), priority and date pickers on the row, click-to-tick, double-click to edit, a tag filter row built
from the tags in use, and a collapsed "Done this week (n)" group. Live refresh on `TODO.md` modify.

### 4.5 `/todo` command and seed (PR 2)

- `plugin/commands/todo.md` (`allowed-tools: Read, Edit, Write`): turn `$ARGUMENTS` into one Tasks-syntax
  line (natural dates such as "by Oct 1" become `📅 YYYY-MM-DD`; "urgent" or "!" becomes `⏫`), append it
  under `## Open` in `<vault>/TODO.md` (creating the file from the seed shape if missing), confirm in one line.
- `vault-template/TODO.md` seed; `vault-template/AGENTICOS.md` capture vocabulary gains `/todo`.
- Counts: `cli/plugin-commands.test.js` → 16 commands (plus a test that the command's embedded seed equals
  `vault-template/TODO.md`); generated Codex skills 19 → 20 (18 → 19 with a foreign skill) in
  `cli/codex-host.test.js` and `cli/aos.test.js`; `cli/rehearsal/first-run.sh` checks the seeded `TODO.md`; README
  "Everyday commands" row and the "16 commands, 6 skills" layout line; `cli/vault-template.test.js` asserts the seed.

## 5. Testing

- `node:test` via `tsx` beside each data module: `proposals.test.ts` (fixtures for each kind, missing
  recheck, missing premises, unknown surface, product without surface, ledger rates, confirmations
  legacy flat shape), `badges.test.ts`, `todos.test.ts` (round-trip preserves unknown lines and tokens;
  grouping around midnight; tick moves the item and its indented children; stale-line refusal).
- `npm run gate`, `npm test`, `npm run build -w hud`; PR 2 also `sh cli/rehearsal/first-run.sh`.
- `docs/plugin-smoke.md`: new checks for both tabs, both badges and Review in Claude.

## 6. Out of scope

- Approving, rejecting, accepting or dismissing from the HUD (D6). Codex as the Review target.
- Reading `TODO.md` in `/standup`, `/reflect-week` or the sitrep — a follow-up once the file has history.
- Recurrence, notes, sub-task progress, Reminders sync, aggregation of checkboxes elsewhere in the vault.
