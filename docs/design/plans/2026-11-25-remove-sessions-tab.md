# Retire the Sessions tab; History moves to Code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Sessions rail tab (id `chat`), Vault chat and their backend in two PRs before one release, with History living in the Code tab.

**Architecture:** PR 1 (`feat/remove-sessions-tab`) changes only the HUD, the runtime's collector wording, tests and docs: History becomes an overlay in Code's stage next to the read-only past chat, `chat` becomes an alias of `term`, and every Sessions-only HUD module goes. Main is untouched and the `sessions` surface stays on (the Code composer's model catalog still goes through it). PR 2 (`chore/remove-sessions-backend`, branched from `main` after PR 1 merges) moves main's shared parts into `services/hosts.ts`, then deletes the rest of the backend, the runtime verbs and the config keys, and strips the keys from vaults on `aos upgrade`.

**Tech Stack:** TypeScript (HUD in `hud/src`, app in `app/src`), Electron, Playwright e2e, `node:test` + tsx, Node ≥ 20 CommonJS runtime (`brain/scripts`, `cli`).

**Spec:** `docs/design/specs/2026-11-25-remove-sessions-tab-design.md` (D1–D16). Read it first. Line numbers below are at `8e03c69b`.

## Global Constraints

- Code comments that explain a removal or a redirect cite `remove-sessions D<n>`.
- Zero new runtime dependencies. Runtime and `cli`: Node ≥ 20, CommonJS, `node:test` + `node:assert/strict`. Every hook exits 0 with empty stdout on failure.
- Tests run through `npm test`, `npm test -w hud`, `cd hud && node --require ../tools/test-env.js --import tsx --test <file>`, or `node --require ./tools/test-env.js --test <file>`. Never a bare `node --test` (it writes into the real vault).
- No absolute home paths, real names or email addresses in code, tests, docs or commit messages; `npm run gate -- --require-private` stays clean.
- Commits: author `zzoretich` with the noreply address (the checkout's local config). The message ends with only `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No session-trailer line, no session URL, no `--no-verify`.
- `plugin/` and `codex-plugin/` do not change; `npm run build:codex-plugin && git status --short codex-plugin` prints nothing.
- Kept on purpose (D9, D10, D12): `settings.sessionChoice` and `rememberSessionChoice`; `ThreadView`, `HostModelMenu`, `SlashMenu`, `agentSessions`, `sessionHistory`, `historyCache`, `hostSessions`, `pastChat`, `LiveRunsWatcher`; the ~31 `.aos-ss-*` classes ThreadView, CodeChat and CodePanes draw and `@keyframes aos-ss-spin` / `aos-ss-blink`; `HOOK_EXCLUDE` (`spend-ledger.js`), `isHookFeature` (`cli/aos.js`) and `statusline-model.js` excluding `session:*` rows.
- Old thread files under `brain/_index/sessions/` are never deleted or moved by anything new (D7).
- PR 1 invariant: no file under `app/src/main/`, `app/src/preload/` or `app/src/shared/` changes, except `app/src/renderer/setup/wizard.ts` copy (D14).
- Every CHANGELOG Added/Changed bullet ends with `<!-- tour: <id> -->` or `<!-- no-tour: <reason> -->`; `node tools/changelog.js check current` passes.
- Ask the user before each merge (`gh pr merge --admin` needs their OK), before any push to `main`, and before any release tag.

## Review Focus

1. **Old links.** `agenticos://workbench?tab=chat&thread=<uuid>` (statuslines from older runtimes) and `?tab=chat&pane=history` must land on Code, and on Code ▸ History for the pane, never a refusal or a blank area. → Task 8 Step 1 (shell.spec).
2. **Codex-only vault** (`hosts.claude.enabled: false`). A Codex History row's Resume types `codex resume -C <folder> <id>`. A Claude row shows no Resume, as `resumeFor` gives `state: "none"` for an off host. → Task 10 Step 4 (variants.spec).
3. **Old Spaces rows.** A snapshot written before the collector change still holds `kind: "app"` rows. Resume must never route to the removed tab; it shows the row's reason until the next scan rewrites the row. → Task 5 Step 1.
4. **Stale settings.** A `data.json` that still holds `computerPane.chat` or `vaultChoice` is sanitized: the Computer pane opens on Code, and the key is dropped on save. → Task 8 Step 1 (settingsDefaults.test).
5. **Upgraded vault with user values.** A `brain/config.json` holding `sessions: { perDayUsd: 25 }` and `ai.chat: "claude"` loses both on `aos upgrade` and keeps every other user value, and `aos doctor`'s config row reports no unknown key. → Task 14 Step 1.

## File Structure

| Path | PR | Responsibility after the change |
|---|---|---|
| `hud/src/ui/CodeHistory.ts` (new) | 1 | Code ▸ History: head (title, count, Close), filter, no-host note, days, rows, Show more, Resume. No data reads of its own. |
| `hud/src/data/historyCache.ts` | 1 | Adds `loaded()` and `error()` to the cache Code already holds. |
| `hud/src/data/codeSidebarModel.ts` | 1 | Adds `history()`: rows plus load state, for the view. |
| `hud/src/ui/CodeStage.ts` | 1 | Hosts the History overlay beside the past chat; `covered()` says a terminal is not shown. |
| `hud/src/ui/TerminalPanel.ts`, `ui/TermList.ts`, `views/TermTab.ts` | 1 | All history opens Code ▸ History; `reveal({ pane: "history" })` does too. |
| `hud/src/data/agentSessions.ts` | 1 | Gains `aliasCatalog`, `EFFORTS`, `ALIAS_REASON` from `claudeAsk.ts`. |
| `hud/src/data/terminalLauncher.ts`, `ui/TermComposer.ts` | 1 | `rememberModel` (D15). |
| `hud/src/views/{SessionsTab,ChatTab}.ts`, `data/{claudeAsk,askSpawner}.ts` (+tests), `ui/AccessMenu.ts` | 1 | Deleted. |
| `app/src/main/services/hosts.ts` (new) | 2 | `HostService`: `resolveBin`, `catalog`, `postComputerNotice`, the runtime spawn they share, `WORKSPACE_RE`. No surface gate. |
| `app/src/main/services/sessions.ts`, `ipc/sessions.ts` | 2 | Deleted (after the move). |
| `app/src/main/ipc/hosts.ts` (new) | 2 | The one `hosts:catalog` channel. |
| `brain/scripts/lib/config-write.js` | 2 | Adds `RETIRED_KEYS` and `dropRetired(obj)`. |

---

# PR 1 — what users see (`feat/remove-sessions-tab`)

Setup, once: `cd ~/AgenticOS-Workbench.worktrees/remove-sessions-tab && npm ci --ignore-scripts && (cd app && npm ci && node node_modules/electron/install.js)`.

### Task 1: Move `aliasCatalog` out of `claudeAsk.ts`

**Files:** Modify `hud/src/data/agentSessions.ts`, `hud/src/data/agentSessions.test.ts`, `hud/src/ui/TermComposer.ts:5`, `hud/src/views/RoutinesTab.ts:16`, `hud/src/data/claudeAsk.ts` (288–311, 55, 289), `hud/src/data/claudeAsk.test.ts` (235–248).

**Interfaces:** Produces `aliasCatalog`, `EFFORTS`, `ALIAS_REASON` exported from `data/agentSessions.ts`, with the same signatures they have in `claudeAsk.ts` today.

- [ ] **Step 1:** Move the `aliasCatalog` test block (`claudeAsk.test.ts:235–248`) into `agentSessions.test.ts`, importing from `./agentSessions`.
- [ ] **Step 2:** Run `cd hud && node --require ../tools/test-env.js --import tsx --test src/data/agentSessions.test.ts`. Expected: FAIL, `aliasCatalog` is not exported.
- [ ] **Step 3:** Move `aliasCatalog`, `EFFORTS` and `ALIAS_REASON` into `agentSessions.ts`. `claudeAsk.ts` imports them from there until Task 8 deletes it. Repoint `TermComposer.ts` and `RoutinesTab.ts`.
- [ ] **Step 4:** Run `npm test -w hud && npm run typecheck -w hud`. Expected: PASS.
- [ ] **Step 5:** Commit: `refactor: aliasCatalog moves to agentSessions (remove-sessions D10)`.

### Task 2: History load state in the cache Code holds

**Files:** Modify `hud/src/data/historyCache.ts`, `hud/src/data/codeSidebarModel.ts`. Test: `hud/src/data/historyCache.test.ts` (extend it; inject `HistorySources` as its existing tests do).

**Interfaces:** Produces:
- `HistoryCache.loaded(): boolean`: false until the first read was parsed, then true.
- `HistoryCache.error(): string | null`: the last failed read's message, or null after a good read.
- `CodeSidebarModel.history(): { rows: HistoryRow[]; loaded: boolean; error: string | null }`. It gives `{ rows: [], loaded: false, error: null }` before `start()`.

- [ ] **Step 1: Write the failing tests**
  - `test("loaded() is false before the first read and true after it, with an empty index too")`. A vault with no index files: after `refresh(true)` and its promise settles, `loaded()` is true and `rows()` is `[]`.
  - `test("error() names a failed read, and clears on the next good read")`. Stub `fs.promises.readFile` (through the host's `fs`) to throw `new Error("EACCES")` once: `error()` contains `"EACCES"` and `loaded()` is true. After a good read, `error()` is null.
- [ ] **Step 2:** Run the file. Expected: FAIL (no `loaded`).
- [ ] **Step 3:** Implement. Keep the error message from the `read` catch, set `loaded` when `data` is first assigned, and expose both. `CodeSidebarModel.history()` reads `this.hist`.
- [ ] **Step 4:** Run `npm test -w hud`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: history cache reports its load state (remove-sessions D3)`.

### Task 3: Code ▸ History

**Files:**
- Create `hud/src/ui/CodeHistory.ts`.
- Modify `hud/src/ui/CodeStage.ts`, `hud/src/ui/TerminalPanel.ts` (76, 145, 188–191, 354, 365, 374, 379–385, 427, 434, 466, 667), `hud/src/ui/TermList.ts` (25–26, 194–197), `hud/src/views/TermTab.ts` (24–27, 33) and `hud/styles.css`: the History block at 2803–2819, with the hostdot rules at 2783–2785 copied, not moved, since Sessions still draws them until Task 8.

**Interfaces:**
- Consumes `CodeSidebarModel.history()` (Task 2). From `data/sessionHistory`: `filterHistory`, `groupByDay`, `dayLabel`, `historyCount`, `HISTORY_PAGE`, `HistoryRow`. Also `WorkbenchView.launchTerminal(host, { picked, resume: { id }, origin })`.
- Produces:
  - `export interface CodeHistoryHost { history(): { rows: HistoryRow[]; loaded: boolean; error: string | null }; hostReady(): boolean; resume(r: HistoryRow): void; close(): void }`
  - `export class CodeHistory { constructor(host: CodeHistoryHost); mount(stage: HTMLElement): void; show(): void; hide(): void; readonly shown: boolean; update(): void; destroy(): void }`. `update()` redraws only when the rows, load state, error or `hostReady()` changed, and gives focus back to the filter or Show more by `data-focus`, as `SessionsTab.keepFocus` does.
  - On `CodeStage`: `history: CodeHistory | null`, `showHistory(): void`, `closeHistory(): void`, `historyShown(): boolean`, `covered(): boolean` (`!!this.past || this.historyShown()`).
  - `TerminalPanelOptions.openHistory` stays, with its meaning narrowed to "show History". New `TerminalPanelOptions.resumeHistory?: (r: HistoryRow) => Promise<void>`. `TerminalPanel.showHistory(): void`.
  - `TermTab.reveal(target: { workspace?: string | null; pane?: string | null })`.
  - The DOM the tour and e2e use:
    - the overlay is `.aos-ch` with `data-tour="code-history"`, and the stage has class `is-history` while it shows;
    - inside it: `.aos-ch-count`, `input.aos-ch-filter`, `.aos-ch-nohost`, `.aos-ch-day[data-day]`, `.aos-ch-dayname`, `.aos-ch-row[data-key][data-host]` (holding `.aos-ch-title`, `.aos-ch-meta`, `.aos-ch-summary`, `.aos-ch-why`), `button.aos-ch-resume`, `button.aos-ch-more` and `button.aos-ch-close`;
    - in the sidebar foot, `button.aos-tl-allhistory` gets `is-active` and `aria-pressed="true"` while History shows.

- [ ] **Step 1: Write the failing e2e test.** In `app/tests/e2e/history-mcp.spec.ts`, rewrite the History cases (36–82, 113–131, 148–160, 200–210) against Code; keep the MCP cases. The new cases:
  - `"All history opens Code ▸ History: rows by day, newest first, filter and Show more"`. Seed the fixture index with `HISTORY_PAGE + 5` sessions. Click `.aos-tl-allhistory`. Expect `.aos-ch` visible and the rail's `term` button active. `.aos-ch-row` count is 100 and `.aos-ch-more` reads `Show 5 more (5 left)`. A filter on one title gives 1 row.
  - `"Resume in History types the host's resume line in a new Code terminal and closes History"`. Click a Claude row's `.aos-ch-resume`. A terminal row appears whose typed line contains `--resume <id>`, and `.aos-ch` is hidden.
  - `"A terminal or a past conversation picked in the sidebar closes History; Close does too"`.
  - `"With no host signed in History still lists the Mac's sessions, with the no-host note and Resume off with its reason"`. Use the existing signed-out fixture. `.aos-ch-nohost` is visible and every `.aos-ch-resume` is disabled or absent, with `.aos-ch-why` text.
- [ ] **Step 2:** Run `cd app && npx playwright test tests/e2e/history-mcp.spec.ts` (after `node scripts/build.mjs`). Expected: FAIL (no `.aos-ch`).
- [ ] **Step 3: Implement `CodeHistory`.** Port `SessionsTab.renderHistory`, `renderHistoryList` and `renderHistoryRow` (978–1049) onto the new classes, with the same copy, except for these strings:
  - the title is "History", with a Close button whose aria-label is "Close History";
  - the no-host note reads "No host is signed in: History lists the past sessions on this Mac. Sign in to Claude Code or Codex to resume one.";
  - the loading line is "Reading the session index…";
  - the error line is ``Could not read the session index: ${error}``, shown above any rows;
  - Resume's aria-label is ``Resume ${r.title}``.
  - `routeWebLinks(col, () => null)` stays.
- [ ] **Step 4: Host the view.**
  - **`CodeStage`.** Mount `CodeHistory` in `stageEl` after the past chat. In `showHistory()`, clear the past conversation, then `history.show()` and `host.renderTabs()`; `showPast()` calls `closeHistory()` first; `clearPast()` also closes History. `applyView()` treats History as it treats `past`: stage class `is-history`, chat and past chat hidden, no composer.
  - **`TerminalPanel`.** Replace the checks that mean "a terminal is shown" (145, 365, 374, 427, 434, 667) with `this.stage.covered()`. `showHistory()` calls `model.refreshHistory(true)`, `stage.showHistory()`, `stage.applyView()` and `renderTabs()`. `renderTabs()` calls `stage.history?.update()` while it is shown. The host's `resume` awaits `opts.resumeHistory(r)` and then closes History. On a throw it shows ``new Notice(`Resume unavailable: ${message}`)``. `hostReady` is `plugin.termLauncher.choices().some((c) => c.host !== "shell" && !c.hidden && c.ready)`.
  - **`TermList`.** The foot button's title becomes "Every past Claude Code and Codex session on this Mac". It is active while History shows: pass `"history"` as `activePast`, and `pastEl` never matches that key.
  - **`TermTab`.** `openHistory: () => this.panel?.showHistory()` and `resumeHistory: (r) => this.view.launchTerminal(r.host, { picked: r.resume.state === "on" ? r.resume.place : null, resume: { id: r.id }, origin: "History" })`. `reveal` calls `showHistory()` when `pane === "history"`, else the scope reveal as today.
  - **`styles.css`.** Copy the History block as `.aos-ch-*`, dropping the `.aos-ss button.` qualifiers in favour of `.aos-ch button.`. Add `.aos-ch { position: absolute; inset: 0; overflow: auto; display: none }` and `.aos-term-stage.is-history .aos-ch { display: block }`, following how `.is-past` lays out the past chat. Leave the old `.aos-ss-h*` rules for Task 8.
- [ ] **Step 5:** Run `npm run typecheck -w hud && npm test -w hud && (cd app && npm run typecheck && npx playwright test tests/e2e/history-mcp.spec.ts tests/e2e/code-chat.spec.ts)`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat: History opens in the Code tab (remove-sessions D3)`.

### Task 4: Code's model chip remembers (D15)

**Files:** Modify `hud/src/data/terminalLauncher.ts` (138–143), `hud/src/ui/TermComposer.ts` (356–364), the New menu line that shows `modelLabel` (find with `grep -rn modelLabel hud/src/ui`). Test: `hud/src/data/terminalLauncher.test.ts`.

**Interfaces:** Produces `TerminalLauncher.rememberModel(host: "claude" | "codex", model: string | null): void`. It writes `settings.sessionChoice = rememberSessionChoice(settings.sessionChoice, { host, model })` and calls `saveSettings()`. `null` means the host's default.

- [ ] **Step 1: Write the failing tests** in `terminalLauncher.test.ts`, using the file's plugin stub:
  - `test("D15: a model remembered for Claude is the next Claude launch's --model, and Codex keeps its own")`. Call `rememberModel("claude", "opus")`. `launcher.spec("claude").model === "opus"` and `launcher.spec("codex").model === null`; `modelLabel("claude")` names opus.
  - `test("D15: remembering null goes back to the host's default")`. `rememberModel("claude", null)` → `modelLabel("claude") === "Default model"`.
- [ ] **Step 2:** Run the file. Expected: FAIL (no `rememberModel`).
- [ ] **Step 3:** Implement `rememberModel`. In `TermComposer.pickModel`, call `this.plugin.termLauncher.rememberModel(host, model)` first, before the `sameModel` check, so a pick of the running model also becomes the default. The `modelLabel` doc and any UI text saying "remembered from Sessions" now say "your last pick". The chip shows no effort (`value.effort` is always null), so there is no effort to remember.
- [ ] **Step 4:** Run `npm test -w hud && npm run typecheck -w hud`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: Code's model chip remembers its pick for new terminals (remove-sessions D15)`.

### Task 5: Spaces stops pointing at Sessions (D5)

**Files:**
- `hud/src/data/spacesModel.ts`: 179–203, 307–325, 353–358, 406–414, 464, 989, 1033–1040.
- `hud/src/views/SpacesTab.ts`: 17, 26, 47, 84, 213–214, 261–262, 306–312, 416–423, 482, 616–619, 673–682, 837/870/896.
- `hud/src/views/spaces/ui.ts`: 75, 146–152, 182, 195–198, 210, 262–266, 314–325, 339–350, 446–456.
- `spaces/HistoryPane.ts` (31–34, 51–54), `spaces/LinkedPane.ts` (6, 63–70), `spaces/PickupCard.ts` (34) and `spaces/DossierPane.ts` (115–116).
- `hud/src/data/hostSessions.ts`: 82, 107–108, 115.
- `brain/scripts/collectors/hostSessions.js`: 74–80, 647–649.
- Tests: `spacesModel.test.ts`, `spaces/ui.test.ts`, `hostSessions.test.ts`, `brain/scripts/test/host-sessions.test.js`.

**Interfaces:**
- `ResumeTarget` loses `{ kind: "sessions" }`.
- `ResumeContext` loses `sessionsAvailable`.
- `sessionsLink`, `SESSIONS_OFF_TEXT` and `CLI_THREAD_TEXT` are deleted.
- Spaces stops calling `sessionHost().list()` and stops watching `brain/_index/sessions`.

- [ ] **Step 1: Write the failing tests.**
  - `spacesModel.test.ts`, `test("D5: an app row from an older snapshot resumes nowhere new: disabled with the row's reason")`. A `kind: "app"` row with `resumable: false, reason: "A Sessions thread: open it in Sessions"` gives `resumeTarget(...).kind === "disabled"` with that reason, never `"sessions"`.
  - `host-sessions.test.js`, `test("D5: a session the app ran is a plain headless row: Claude's reason is the headless one, Codex's resumes by id")`. The existing app-thread fixture now gives `kind` `"headless"` for Claude, with `REASONS.headless`, and `resumable: true` for a Codex exec with a matching UUID head. `row.via` is still `"app"` and `row.thread` is still set; PR 2 drops both.
- [ ] **Step 2:** Run `npm test -w hud` and `node --require ./tools/test-env.js --test brain/scripts/test/host-sessions.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Collector.** `kind` is `s.team || seat ? 'team' : s.kind`, with no `'app'` kind. `REASONS.app` goes. `REASONS.headless` becomes `'Headless run: start a new session in Code'`.
  - **`resumeTarget`.** It loses the `row.kind === "app"` branch.
  - **Spaces.** It drops the live thread list, the thread rows and counts, "Open in Sessions", "Threads in Sessions →", "All n in Sessions", the split menu's Sessions item, and the move plan's thread counts.
  - **`hostSessions.ts`.** `VIA_TEXT.app` and `KIND_NOTE` say "Ran headless".
  - **Spaces' Resume.** It only ever opens a Code terminal.
- [ ] **Step 4:** Run `npm test && npm run typecheck -w hud && (cd app && npx playwright test tests/e2e/spaces-writes.spec.ts tests/e2e/spaces-runs.spec.ts)`. Update those specs' Sessions cases (spaces-writes 1010–1174, spaces-runs 389–398, 690, 756–760): remove the thread cases, and Resume expects a Code terminal. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: Spaces resumes only in Code (remove-sessions D5)`.

### Task 6: Pulse stops reading Sessions (D6)

**Files:** Modify `hud/src/views/pulse/model.ts` (26, 256–270) and `hud/src/ui/PulsePopup.ts:174`, plus their tests.

- [ ] **Step 1:** Write the failing test in the Pulse model test: `test("D6: the live rows read no Sessions threads, and Show → always opens Code")`. The model built with no `sessions` host gives the same rows as before minus the Sessions ones, and the row's target tab is `"term"`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Delete `liveRows`' `sessions.list` source. "Show →" opens `{ tab: "term" }`. Keep the `FAMILIES` "Sessions" label (185) for past spend rows.
- [ ] **Step 4:** Run `npm test -w hud && npm run typecheck -w hud`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: Pulse's live rows and Show → point at Code (remove-sessions D6)`.

### Task 7: Tour and What's new (D13)

**Files:**
- `hud/src/tour/steps.json`: core 5–12, code `foot` 44, chapters `sessions` 54–66 and `sessions-history` 68–70, spaces `resume` 86, action `first-session` 249.
- `hud/src/tour/steps.ts`: 17–19, 67, 70–71, 113–115.
- `hud/src/tour/predicates.ts`: 2–16, 30, 44–45.
- `hud/src/tour/controller.ts`: 71–79.
- `hud/src/tour/whatsnew.json`: 22, 44, 137–142, plus a new entry for the next release.
- Tests: `steps.test.ts` (48–49, 73–86, 103–108), `checklist.test.ts` (17–19, 35–36), `predicates.test.ts` (5, 15–18, 33), `whatsnew.test.ts` (41) and `app/tests/e2e/tour.spec.ts` (75, 252, 285–335).

**Interfaces:**
- `TOUR_TABS` without `"chat"`.
- `CODE_PANES = ["history"]` replaces `SESSIONS_PANES`. A step's `pane` is valid on `tab: "term"` when it is in `CODE_PANES`, and the validator's message names "tab term and history".
- `PREDICATES` without `chatAvailable` and `sessionsShown`; `TourCtx` without `chat` and `sessions`.

- [ ] **Step 1: Write the failing tests.**
  - `steps.test.ts`: `test("D13: the core tour has nine stops and none on Sessions")` (no step `sessions`; the core summary starts "Nine stops").
  - `test("D13: code.history routes to Code with pane history")`.
  - `test("D13: a pane on chat is refused")`.
  - `whatsnew.test.ts`: every ref resolves (existing), plus `test("D13: the next release's entry names Sessions' removal and shows code.history")`.
- [ ] **Step 2:** Run `npm test -w hud`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Core step `sessions`.** Delete it. The core summary becomes "Nine stops around the Workbench, ending at this checklist".
  - **Code chapter.** Add, after `foot`: `{"id":"history","tab":"term","pane":"history","anchor":"[data-tour=\"code-history\"]","title":"Every past session","body":"Every Claude Code and Codex session this Mac has a record of, by day, newest first, whichever host ran it. Type to filter. **Resume** reopens one in a new terminal; a host that is signed out says why.","advance":"next","since":"<next version>"}`. Use the version the release will carry; ask the user if it is not decided by then, and use `2.9.0` as the placeholder until they answer.
  - **`code.foot` body.** "**All history** opens every past session here".
  - **Chapters.** Delete `sessions` and `sessions-history`.
  - **`spaces.resume` and the `first-session` action.** Drop "or Sessions"; the action becomes "Start {host} in a workspace from Code…".
  - **`whatsnew.json`.** Refs `sessions.computer` are removed (`code.computer` already sits beside them). The 2.0.0 entry `sessions-history` gets `"steps": ["code.history"]`. Add a release object for the next version with entry `{ "id": "sessions-retired", "title": "Sessions is now part of Code", "body": "The Sessions tab is gone: Code runs Claude Code and Codex in real terminals with a chat view, and History moved into Code, behind All history at the foot of its list. Vault chat is gone too; ask about your notes in any Code session. Old links to Sessions open Code.", "steps": ["code.history"] }`.
- [ ] **Step 4:** Run `npm test -w hud && npm run typecheck -w hud && (cd app && npx playwright test tests/e2e/tour.spec.ts)`. The tour spec drops its Sessions chapter cases and checks the `code.history` anchor. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: the tour shows History in Code (remove-sessions D13)`.

### Task 8: Retire the tab (D1, D4, D8, D9)

**Files:**
- Delete `hud/src/views/SessionsTab.ts`, `hud/src/views/ChatTab.ts`, `hud/src/data/claudeAsk.ts` (+ `.test.ts`), `hud/src/data/askSpawner.ts` (+ `.test.ts`) and `hud/src/ui/AccessMenu.ts`.
- `hud/src/views/WorkbenchView.ts`: 11, 29, 47–55, 84, 90–102, 124, 140–141, 236, 260–289, 359–368, 382, 388–396, 585–597, 630.
- `hud/main.ts`: 29, 42, 116–120, 198–200, 281, 324–361. Keep the reconcile run at 202, and reword its comment to say it refreshes sign-in for Code and Spaces.
- `hud/src/settingsDefaults.ts`: 21–27, 67–68, 86–88, 110, 127, 151–155, 194–198, 214–224, 369, 396.
- `hud/src/data/computerStore.ts` (10–55, 112), `hud/src/ui/ComputerPane.ts` (1, 12, 44–47, 228), `pluginSettingRows.ts:102`, `CodeChat.ts:291` and `ThreadView.ts:171`.
- `hud/styles.css`, about 430 lines: 1013–1141, 1785–1786, 2520–2573, 2677–2717, 2746–2802 (keeping 2750–2754 and 2783–2785 only while something outside the old tab draws them; check with `grep -rn` first), the old History block 2803–2820, 2821–3059 (keeping 2868–2869, 2876–2885 and 2887–2950), 5518, `.aos-ss-cdot` in 5588–5592, and 5593–5598.
- Tests: `settingsDefaults.test.ts`, `computerStore.test.ts`, `ComputerPane.test.ts`, `HostModelMenu.test.ts` if it imports Vault modes, and `app/tests/e2e/shell.spec.ts`.

**Interfaces:**
- `TAB_ALIASES = { agents: "agent-teams", chat: "term" }`.
- `ComputerPage = "code"`.
- `DEAD_SETTINGS_KEYS` includes `"vaultChoice"`.
- `ComputerPaneId` has no `"chat"`, and `sanitizeComputerPane` drops a stored `chat` entry.
- Removed from the plugin: `chatAvailable`, `historyOnDisk`, `sessionsShown` and `claudeBin`.
- `WorkbenchView.open` no longer refuses any tab id it knows.

- [ ] **Step 1: Write the failing tests.**
  - `settingsDefaults.test.ts`:
    - `test("D9: vaultChoice is a dead key, dropped from loaded settings")`;
    - `test("D8: a stored computerPane.chat is dropped and code kept")`;
    - `test("D9: sessionChoice survives a load")`.
  - `computerStore.test.ts`: `test("D8: every page is code")`. Replace the chat-page cases.
  - `shell.spec.ts`:
    - `"D4: agenticos://workbench?tab=chat opens Code"`;
    - `"D4: ?tab=chat&thread=<uuid> opens Code and ignores the thread"`;
    - `"D4: ?tab=chat&pane=history opens Code ▸ History"`;
    - `"D1: the rail has no Sessions button and the palette no Open Workbench: Sessions"`;
    - update the rail order (48–56, 69, 210, 220–221, 275).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement in this order**, so the build is green at each save:
  1. alias and routing, including the doc comments on `WorkbenchTarget` and `open()`;
  2. the rail entry, `railChat`, the provider-state watch, `refreshRailHosts`, the badge, `revealAsk`, and `openComputerPane` on Code only;
  3. `hud/main.ts`: `"chat"` leaves the command list, and the four plugin methods and their imports go;
  4. delete the five modules;
  5. settings and computer;
  6. CSS;
  7. the three wording lines.
  - **Check after the deletions:** `grep -rn "SessionsTab\|ChatTab\|claudeAsk\|askSpawner\|AccessMenu\|vaultChoice\|rememberVaultChoice" hud/src hud/main.ts` prints only the dead-key entry and test names.
- [ ] **Step 4:** Run `npm test -w hud && npm run typecheck -w hud && (cd app && npm run typecheck && npm run check:compat && npx playwright test tests/e2e/shell.spec.ts tests/e2e/tab-layout.spec.ts tests/e2e/history-mcp.spec.ts)`. `check:compat` must pass with fewer Obsidian APIs, never more. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: retire the Sessions tab and Vault chat (remove-sessions D1, D4, D8, D9)`.

### Task 9: Copy (D14)

**Files:**
- `app/src/renderer/setup/wizard.ts` (419, 442, 713) and `app/tests/e2e/setup-nohost.spec.ts:83`.
- `brain/scripts/lib/settings-schema.js`: only `reasoner.model`'s help at 92. The keys themselves wait for PR 2.
- `README.md:112` and `app/README.md:60–73`.
- `SECURITY.md` (72, 150, 320, 328, 372): reword only the sentences describing the tab. Its surfaces stay until PR 2.
- `docs/install.md` (8, 75, 83–88, 109, 113–115, 175, 197, 201–205), `docs/how-it-works.md` (22–24), `docs/commands.md` (24, 27), `docs/cost.md` (41), `docs/chief-of-staff.md` (94), `docs/migrating-to-2.0.md` (40, 45, 89) and `extras/ollama/README.md` (22).
- `vault-template/AGENTICOS.md:52`.

- [ ] **Step 1:** `grep -rn "Sessions tab\|Vault chat\|in Sessions\|Chat tab" README.md app/README.md SECURITY.md docs/*.md extras vault-template app/src/renderer brain/scripts/lib/settings-schema.js`. This is the list to clear; `docs/design/**` is history and stays.
- [ ] **Step 2: Reword.**
  - The wizard says "Code and the Chief of Staff wait…".
  - `reasoner.model`'s help drops the Chat tab.
  - Wherever docs show starting a session, they name both hosts' forms ("start Claude Code or Codex from Code").
  - The `AGENTICOS.md` change stays host-neutral and within 9,000 characters (`parity-check` prints what is left).
- [ ] **Step 3:** Run `node --require ./tools/test-env.js --test cli/vault-template.test.js && (cd app && npx playwright test tests/e2e/setup-nohost.spec.ts)` and the grep again. Expected: PASS, and the grep matches only lines that describe the removal.
- [ ] **Step 4:** Commit: `docs: Code replaces Sessions in the copy (remove-sessions D14)`.

### Task 10: The e2e suite and the smoke docs

**Files:**
- Delete `app/tests/e2e/sessions.spec.ts`, `chat-writes.spec.ts` and `signin-first-launch.spec.ts`.
- `app/tests/e2e/local.spec.ts`: 1–3, 29, 41–83; keep the Local engine test.
- `app/tests/e2e/computer.spec.ts`.
- `variants.spec.ts` (156–229, 364–388, 408, 715, 771), `tab-layout.spec.ts` (20–21), `sidebar-omni-notes.spec.ts` (1, 166–177), `code-chat.spec.ts` (1521–1527) and `harness.ts` (69, 1023–1027).
- `app/scripts/smoke-packaged.mjs:41`.
- `app/tests/e2e/COVERAGE.md` and `docs/app-smoke.md`.

**Interfaces:** Consumes `codeAgent(h, host, { surfaceOff? })` (`computer.spec.ts:208`). Produces `codeAgentWith(h, { host?: Host; access?: Access; surfaceOff?: boolean }): Promise<Agent>`. It launches through `p.termLauncher.launch({ host, access, chosen: { access: true } })`, as `computer.spec.ts:371` does, waits for `agentRun((r) => r.mode === "code" && r.host === host, after)`, and calls `browserOn` unless `surfaceOff`.

- [ ] **Step 1:** Delete the three specs and `local.spec.ts`'s Vault cases. In `harness.ts`, remove `"chat"` from `RAIL_SECTIONS`; in `smoke-packaged.mjs`, remove `"chat"` from `TABS`.
- [ ] **Step 2: Port `computer.spec.ts`.**
  - **Calls.** Every `chatAgent(h, { text, host?, access?, surfaceOff? })` becomes `codeAgentWith(h, { host, access, surfaceOff })`.
  - **Locators.** `pane(win, "chat")` becomes `pane(win, "code")`, and `reader(win)` / `doneLines` checks move to Code's chat (`.aos-cc-*` rows) or go where they asserted only Sessions UI.
  - **Tests to delete.** Delete the Chat-only tests at 1122, 1153, 1713, 1765, 1859 and 1944, and the Delete-thread half of 1388; also delete `newSession` and `chatAgent`.
  - **Tests to keep.** 819 ("read only") keeps its meaning through `access: "read"`. 842–843 (two drivers) launch claude then codex.
  - **Env.** Keep the env `computer,sessions` until PR 2, since the catalog needs the surface.
- [ ] **Step 3:** In the remaining specs, remove the Sessions cases and rail positions, as listed in **Files**.
- [ ] **Step 4:** Write the host-parity case in `variants.spec.ts`: `"Codex only: History lists both hosts' sessions; a Codex row resumes with codex resume -C, a Claude row has no Resume"`. Replace its old Sessions cases.
- [ ] **Step 5: Update the docs.**
  - **COVERAGE.md.** Drop CH1–CH6 and SE1–SE13 and SE17. SE14–SE16 become Code History rows under Code, pointing at `history-mcp.spec.ts`. Also update SMR10/12/20, TM16, CP9/CP13, GT2 and the totals (21–28).
  - **`docs/app-smoke.md`.** Remove 32, 38–40, 158, 192, 196–208, 329–359, 382, 408–416 and 433–438, then add a "Code ▸ History" item per host in place of 360–362. The Agent Workspace spec's PR is the precedent for the item shape.
- [ ] **Step 6:** Run `cd app && npm run typecheck && npm run test:unit && npm run check:compat && npm run test:e2e`. Run nothing heavy beside it. Expected: all green. A local `firstWindow` stall is the temp-folder issue (`ls "$TMPDIR" | wc -l`), not the branch.
- [ ] **Step 7:** Commit: `test: e2e and smoke docs follow Sessions' removal (remove-sessions D1, D3)`.

### Task 11: CHANGELOG, verify, publish, PR 1

**Files:** Modify `CHANGELOG.md` `## [Unreleased]`.

- [ ] **Step 1: Write the CHANGELOG entries.**
  - **Removed.** The Sessions tab: its session runner, Vault chat, the day's spend line, each thread's browser and in-app commit (commit from the terminal: ask the agent, or run git).
  - **Changed.** History moved into Code (`<!-- tour: code.history -->`); Code's model chip remembers its pick for new terminals (`<!-- no-tour: a chip that already had its step -->`); Spaces and Pulse open Code (`<!-- no-tour: same controls, new target -->`).
  - **Upgrading.** Old Sessions threads stay in `brain/_index/sessions/<workspace>/`. Each was a real host session: resume one with `claude --resume <id>` or `codex resume <id>`. Old links to Sessions open Code.
- [ ] **Step 2:** Verify, and report the real output:
  - `npm run gate -- --require-private && npm run build:codex-plugin && git status --short codex-plugin`;
  - `npm test && npm run lint && npm run lint:sh && npm run typecheck && node tools/changelog.js check current`;
  - `node ~/.claude/skills/AgenticOS-New-Feature/scripts/parity-check.js --wip`.
- [ ] **Step 3:** `node ~/.claude/skills/AgenticOS-New-Feature/scripts/publish-check.js`. Fix every FAIL and judge each WARN in one line.
- [ ] **Step 4:** Commit the CHANGELOG. `git fetch origin`; if `main` moved, merge it (no rebase), keeping entries under `[Unreleased]`. Push and open the PR with the skill's body (Summary, Hosts table, Test plan, the attribution line only). `gh pr checks <n> --watch`, then ask the user: merge now?

---

# PR 2 — the code nothing uses (`chore/remove-sessions-backend`)

Setup: after PR 1 merges, `git -C ~/AgenticOS-Workbench pull --ff-only`, then a worktree `~/AgenticOS-Workbench.worktrees/remove-sessions-backend` on `chore/remove-sessions-backend` from `origin/main`, with the privacy-terms symlink and both `npm ci`s.

### Task 12: `HostService` takes main's shared parts (D11)

**Files:**
- Create `app/src/main/services/hosts.ts` and `app/src/main/ipc/hosts.ts`.
- `app/src/main/index.ts`: 183, 208–245, 283, 318–325, 344–346, 772, 886.
- `app/src/main/services/code-git.ts:15`, `app/src/main/pty.ts:27`.
- `app/src/shared/ipc.ts` (110, 776), `app/src/preload/index.ts:126`, `app/src/main/ipc/schemas.ts` (the catalog args) and `app/src/renderer/bridgeHost.ts:271`.
- `hud/src/host.ts` (298–311, 427–430), `hud/src/ui/TermComposer.ts:394–396` and `hud/src/views/RoutinesTab.ts:256`.
- `app/src/shared/surfaces.ts`: add the two `catalog` spawn rules and the `brain/_index/host-catalog.json` write to the `code` surface.
- Tests: create `app/tests/unit/hosts.test.ts` from `sessions.test.ts` 270–318, 649–661 and 736–787; `app/tests/e2e/sandbox.spec.ts`.

**Interfaces:**
- `export class HostService { constructor(o: HostServiceOptions); resolveBin(host: SessionHost): Promise<BinResolution>; catalog(refresh?: boolean): Promise<Result<HostCatalog>>; postComputerNotice(title: string, body: string): Promise<void> }`.
- `HostServiceOptions` is `SessionService`'s options minus `enabled`, `sessionsDir`, `emit` and the turn fields.
- `BinResolution`, `BIN_TIMEOUT_MS` and `WORKSPACE_RE` are exported from `hosts.ts`.
- New channel `CH.hostsCatalog = "hosts:catalog"`, replacing `session:catalog`.
- `AosBridge.hosts: { catalog(refresh?: boolean): Promise<Result<HostCatalog>> }`.
- `HudHost.hosts?: { catalog(refresh?: boolean): Promise<HostResult<HostCatalog>> }`, read through `hostsHost()`, which replaces the `sessionsHost()` calls in TermComposer and RoutinesTab.
- `catalog` and `resolveBin` run whatever surfaces are on; `postComputerNotice` keeps its Computer-surface check.

- [ ] **Step 1:** Move the three test blocks into `hosts.test.ts` against `HostService`. Add `test("D11: the catalog answers with the sessions surface off")`. Run `cd app && npm run test:unit`. Expected: FAIL (no `hosts.ts`).
- [ ] **Step 2:** Implement `hosts.ts` by moving the code: `resolveBin` 389–406 (with 86–90), `catalog` 368–387, `postComputerNotice` 423–455 (with 127–133), `runtime` / `runtimeSpawn` 468–510, `WORKSPACE_RE` 37. Wire it in `index.ts` with no `sessionsOn` gate, and repoint pty, code-git, the notifier and the catalog channel. In `sandbox.spec.ts`, the pinned `window.aos` shape gains `hosts.catalog` and loses `sessions.catalog`.
- [ ] **Step 3:** Run `cd app && npm run typecheck && npm run test:unit && npx playwright test tests/e2e/sandbox.spec.ts tests/e2e/code-chat.spec.ts`, then `npm test -w hud && npm run typecheck -w hud`. Expected: PASS.
- [ ] **Step 4:** Commit: `refactor: HostService serves Code's binaries, catalog and notices (remove-sessions D11)`.

### Task 13: Delete the Sessions backend

**Files:**
- Delete `app/src/main/services/sessions.ts` and `app/src/main/ipc/sessions.ts`.
- `app/src/main/services/git.ts`: delete 1–7, 74–80, 192–201, 239–243, 269–288; keep `statusAt` and `diffAt`.
- `app/src/shared/ipc.ts`: 103–111, 121–130, 320, 452–515, 763–778, 804–808. Keep `SessionHost`, `HostCatalog`, `GitStatus` and `GitDiff`.
- `app/src/preload/index.ts` (119–128, 143–147), `app/src/renderer/bridgeHost.ts` (6, 236–237, 264–273, 286–290, 303–306) and `app/src/main/ipc/schemas.ts` (213–250).
- `app/src/shared/surfaces.ts`: delete the `chat` surface (625–644), the `sessions` surface (655–672), `QUESTION` (86), `ASK_*` (99–101) and the claudeAsk rule (162–168); fix the comments at 45–49, 102 and 677.
- `app/src/main/computer/*`: `threadExists` answers false first, so boot purges `chat:` records, then the `chat:` key handling goes (`policy/computer.ts` 2, 11–18; `ipc/computer.ts` 32–33; `computer/registry.ts` 10–11; `computer/service.ts` 55–57, 1717, 2075–2080, 2255, 2434–2441, 2559; `records.ts:6`; `refusals.ts:115`).
- `app/src/main/policy/programs.ts:66` and `read-scope.ts:38` (comments).
- `hud/src/host.ts`: delete `HostSessions` except catalog, `HostGit` (325–329), `sessionsHost` and HudHost 352/357.
- `hud/src/data/hostSessions.ts`: prune the `thread` / `lastThread` types.
- Tests: `app/tests/unit/sessions.test.ts` (delete the rest), `write-policy.test.ts` (217–244, 704–711), `host.test.ts` (121–127), `bridge-host-agent.test.ts` (76–77), `computer-ipc.test.ts` (84–205), `sandbox.spec.ts` (49, 52, 62, 64, 120–133), `hud/src/host.test.ts` (61–74), and the e2e env `computer,sessions`, which becomes `computer`.

- [ ] **Step 1:** Write `test("D8: a chat: browser record left from Sessions is purged at boot")` in `app/tests/unit/computer-service.test.ts`. A record keyed `chat:<uuid>` is gone after boot. Run it. Expected: FAIL.
- [ ] **Step 2:** Delete and trim as listed. Then `grep -rn "SessionService\|sessionsOn\|CH.session\|session:\(start\|send\|list\|read\|stop\|remove\)\|chatAgent\|\"chat:\"" app/src app/tests hud/src` prints nothing.
- [ ] **Step 3:** Run `cd app && npm run typecheck && npm run test:unit && npm run check:compat && npm run test:e2e`, then `npm test -w hud && npm run typecheck -w hud`. Expected: PASS.
- [ ] **Step 4:** Commit: `chore: delete the Sessions backend in main and the page bridge (remove-sessions D8, D11)`.

### Task 14: Runtime and config (D11, D12)

**Files:**
- `brain/scripts/lib/sessions.js`: delete 7–13, 27–82, 88–107, 162–184 and their usage/exports; keep `catalog`, `mirror` and `bin`.
- `brain/scripts/lib/headless.js`: delete `sessionArgs` and `sessionAllowedTools` (42–56, 91, 403–435, 459); keep `SESSION_EFFORTS`.
- `brain/scripts/telemetry.js` (263–295, `appendRunSummary`), `brain/scripts/sdk/ask.js` (13–14, 31–38, 142–143, `--chat`), `brain/scripts/sdk/lib/provider.js:330` and `brain/scripts/spend-ledger.js` (10, 115–118; keep `HOOK_EXCLUDE`).
- The collector's app attribution: `collectors/hostSessions.js` 27–34, 264–290, 359, 617–619, 646–662, and `lib/import/digest.js` 7, 153.
- `cli/workspace.js`: 20–22, 38, 62, 652–670, 718–728, 880–925, 992–999, 1045–1046, 1078–1103, 1268.
- `brain/scripts/config.default.json` (18, 28), `brain/scripts/lib/settings-schema.js` (78, 92, 114–115, 357, 359, 401), `hud/src/data/aosConfig.ts` (32, 61, 74–75, 124, 135) and `cli/migrations.js:63`.
- `cli/aos.js`: 639, 646, 672, 697, 731, and the upgrade step at 1422–1427.
- `brain/scripts/statusline-render.js:25`.
- `brain/scripts/lib/config-write.js`.
- Comments: `host-catalog.js:4`, `brain-hub.js:207`, `session-events.js` 3–5, `cli/codex-host.js` 209–211 (keep the approvals) and `app/scripts/make-fixture-vault.mjs:329`.
- Tests:
  - `brain/scripts/test/sessions.test.js`: keep the catalog test, 111–125;
  - `headless.test.js` (190–250), `provider.test.js` (701, 724–750) and `interactive.test.js` (183–210);
  - `host-sessions.test.js` (373+, 508+);
  - `cli/migrations.test.js` (119–134, 370–374), `cli/workspace.test.js` (476+, 1001+, 1234+), `cli/aos.test.js` (1573–1575) and `cli/config-cmd.test.js`;
  - `hud/src/data/aosConfig.test.ts`;
  - `app/tests/e2e/launch.spec.ts:103`.

**Interfaces:** Produces `RETIRED_KEYS = ['sessions', 'ai.chat']` and `dropRetired(obj: object): string[]`, which removes each key present with `unsetPath` and returns the keys it removed, from `lib/config-write.js`.

- [ ] **Step 1: Write the failing tests.**
  - `brain/scripts/test/config-write.test.js`: `test("D12: dropRetired removes sessions and ai.chat, keeps ai's other keys, and says what it removed")`. Given `{ sessions: { perDayUsd: 25 }, ai: { chat: "claude", recall: "local" }, x: 1 }`, it gives `['sessions', 'ai.chat']` and leaves `{ ai: { recall: "local" }, x: 1 }`.
  - `cli/aos.test.js`: `test("D12: aos upgrade strips retired keys from brain/config.json and keeps user values")`. Use the upgrade test harness the file already has. Afterwards, `config.json` has no `sessions` or `ai.chat`, keeps a user `ai.recall`, and `config-cmd` `doctorRow` reports ok.
- [ ] **Step 2:** Run `node --require ./tools/test-env.js --test cli/aos.test.js brain/scripts/test/config-write.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`dropRetired`.** Call it in the upgrade act right after `deepMerge`, loading `config-write.js` from `path.join(repo, 'brain', 'scripts', 'lib')`. Log the removed keys as `  removed retired keys: sessions, ai.chat` when there are any.
  - **The listed deletions and comment fixes.** `aos status` drops its Sessions caps lines, and `settings-schema` drops the `ai.chat`, `sessions.perTurnUsd` and `sessions.perDayUsd` rows.
  - **Two defaults files.** `config.default.json` and `VAULT_CONFIG_DEFAULTS` change together (`aosConfig.test.ts` pins the match).
  - **Migrations.** `AI_KEYS` loses `chat`; `launch.spec.ts:103` stops asserting it.
- [ ] **Step 4:** Run `npm test && npm run typecheck && (cd app && npm run test:unit && npx playwright test tests/e2e/launch.spec.ts)`. Expected: PASS.
- [ ] **Step 5:** Commit: `chore: runtime and config drop Sessions and Vault chat (remove-sessions D11, D12)`.

### Task 15: Docs, CHANGELOG, verify, PR 2

**Files:** `SECURITY.md` (the `chat` and `sessions` surfaces' paragraphs), `app/README.md`, `docs/install.md` Hosts, `CHANGELOG.md`.

- [ ] **Step 1:** Update `SECURITY.md` for the two removed surfaces and the narrower bridge (`window.aos` loses `sessions` and the workspace `git` calls, and gains `hosts.catalog`).
- [ ] **Step 2:** CHANGELOG, under the same `[Unreleased]`:
  - **Removed:** the Sessions caps in Settings and `aos status`, and `ai.chat`;
  - **Upgrading:** `aos upgrade` removes `sessions` and `ai.chat` from `brain/config.json`.
- [ ] **Step 3:** Run every check from Task 11 Steps 2–3. Add `--rehearse` to `parity-check.js` if its notes say rehearsals are due, since `lib/headless.js` and `cli/aos.js` upgrade changed. Also run `node --require ./tools/test-env.js --test cli/codex-host.test.js`.
- [ ] **Step 4:** Commit, fetch and merge `main` if it moved, push, open the PR, watch CI, then ask the user: merge now? Both PRs must merge before the next release.
