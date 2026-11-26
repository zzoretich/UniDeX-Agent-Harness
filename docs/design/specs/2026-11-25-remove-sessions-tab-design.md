# UniDeX: retire the Sessions tab (the old Chat tab); History moves to Code — design

**Date:** 2026-11-25
**Status:** approved 2026-11-26 (builder check done 2026-11-25), on `feat/remove-sessions-tab`. *(user)* rows are the user's answers in the brainstorm; the rest are
technical calls, and *(builder's call)* marks the ones settled after the builder check. Code comments cite
`remove-sessions D<n>`.
**Base:** `main` at `431d7ada` (2.7.0 + Agent Workspace #215–#217); branch fast-forwarded to `8e03c69b` (2.8.0, #218–#219: no cited file but `surfaces.ts`, where `sessions` moved one line to :657). The HUD, the app (main, IPC, surfaces), the runtime,
tests and docs. No plugin text names Sessions, so `codex-plugin/` does not change.
**Scope:** the **Sessions** rail tab (id `chat`) goes, with everything only it uses: the turn-by-turn session runner,
Vault chat, its spend line and its per-thread browser. **History** moves into the Code tab. Code itself is unchanged.

---

## 1. Problem

1. **Two places to work with an agent.** Sessions runs a host one headless turn at a time (`lib/sessions.js args`,
   `main/services/sessions.ts:512-643`); Code runs the host's real CLI in a terminal with a chat view over it
   (code-chat), a Diff pane, images and its own browser. Code does everything Sessions does but commit (D16), with the
   host's own commands and permissions, so Sessions is a weaker copy users must learn twice.
2. **Its upkeep is large for its use.** ~2,100 lines in `SessionsTab.ts` and `ChatTab.ts`, a main service, IPC calls, a
   surface, a spend cap, `chat:<thread>` browsers, 4 e2e specs and 37 computer e2e tests that drive a Sessions turn.
3. **Vault chat** (read-only questions about notes, `ChatTab.ts`) is barely used; asking in a Code terminal
   (`/ask-brain`, or any question, with the brain context injected) covers it.
4. **History lives in the tab that is going.** Code's sidebar already lists past conversations and its "All history"
   link (`TermList.ts:25-26`) jumps to Sessions ▸ History.

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | *(user)* **Remove the whole tab:** the session runner, Vault chat, the day's session spend line and each thread's browser. | Keeping Vault chat as a Brain hub "Ask" mode, or as a pinned Vault row in Code's sidebar. |
| D2 | *(user)* **Two PRs, one release** (§4): PR 1 what users see, PR 2 the code nothing uses any more. | One PR. Off by default for a release, removed in the next. |
| D3 | *(user)* **History moves into Code** as a view in Code's stage, opened by the sidebar's "All history" and by `open({ tab, pane: "history" })`: the same rows by day, filter, paging and **Resume**, fed by the `HistoryCache` Code already holds (`codeSidebarModel.ts`). Resume is today's call, `wb.launchTerminal(host, { picked, resume: { id }, origin })`, with origin "History". | History in Spaces. Dropping it (with no host signed in it is the only past-session view). |
| D4 | **`chat` becomes an alias of `term`** in `TAB_ALIASES` (`WorkbenchView.ts:84`, as agent-workspace D3 did for `agents`): `agenticos://workbench?tab=chat`, statusline links from older vendored runtimes and any `open({ tab: "chat" })` land on Code; `pane: "history"` opens Code's History; `thread` is ignored. The palette command `open-workbench-chat` goes (there is no Sessions to open). | Refusing the id: old links would do nothing. |
| D5 | **Spaces:** "Open in Sessions", "Threads in Sessions →" and "All n in Sessions" go; Resume always opens a Code terminal (`ResumeTarget` loses `kind: "sessions"`). *(builder's call)* Rows the collector marks `via: "app"` (old Sessions threads) show as the headless host sessions they are, with Resume in Code where the host allows it (`collectors/hostSessions.js:654-656`); after PR 2 drops the attribution they are plain headless rows anyway. New session and Terminal already launch Code and stay. | Hiding them: PR 2 would have to keep reading the thread folder to filter them. Thread rows that open nowhere. |
| D6 | **Pulse:** the live rows read from `sessions.list` (`pulse/model.ts:256-270`) go; "Show →" (`PulsePopup.ts:174`) always opens Code. Past spend rows keep their "Sessions" family label. | — |
| D7 | **Old thread files stay on disk, unread.** `brain/_index/sessions/<workspace>/*.jsonl` is never deleted, and after PR 2 nothing reads it; each thread was a real host session, which shows wherever any headless session does (D5), so the CHANGELOG's **Upgrading** names the folder and `claude --resume <id>` / `codex resume <id>`. After PR 2, `aos workspace` archive/rename no longer moves those folders. | Deleting them (user data). A read-only viewer in Code: cheap (`pastChat.ts` reads the same event shape) but a surface for data almost no one has. |
| D8 | **Computer:** the HUD's `chat` page goes (`computerStore.ts` `ComputerPage` is `"code"`; `sanitizeComputerPane` drops `computerPane.chat`). PR 2 retires the `chat:<thread>` session key in main; boot purges those browser records (`threadExists` answers false first). A Code terminal's browser is unchanged. | — |
| D9 | **HUD settings:** `vaultChoice` joins `DEAD_SETTINGS_KEYS` (`settingsDefaults.ts:110`); `rememberVaultChoice` and `VAULT_EFFORTS` go. **`sessionChoice` stays**: the Code launcher (`terminalLauncher.ts:142,184`) and `HostModelMenu` read it, and D15 writes it. | — |
| D10 | **Shared code stays.** `aliasCatalog` (+ `EFFORTS`, `ALIAS_REASON`, its test) moves from `claudeAsk.ts` into `agentSessions.ts` before `claudeAsk.ts` goes (TermComposer, RoutinesTab use it). `ThreadView`, `HostModelMenu`, `SlashMenu`, `agentSessions`, `sessionHistory`, `historyCache`, `hostSessions`, `pastChat` stay. The ~31 `.aos-ss-*` classes ThreadView, CodeChat and CodePanes draw, and `@keyframes aos-ss-spin`/`aos-ss-blink`, keep their names. | Renaming them now. |
| D11 | **PR 2 moves main's shared parts before deleting:** `resolveBin` (every Code launch, `index.ts:183`), `postComputerNotice` (`index.ts:283`), `catalog` (Code composer and Routines model lists via `sessionsHost()`) and `WORKSPACE_RE` (`code-git.ts:15`) go to a new main service with no Sessions gate (*builder's call*: `services/hosts.ts`); the catalog channel, its argv rules and the `host-catalog.json` write re-home on the `code` surface. `GitService` keeps `statusAt`/`diffAt` (Code's Diff). `lib/sessions.js` keeps `catalog`, `mirror`, `bin`; `args`, `events`, `record`, `plan`, `caps` go. | Deleting `sessions.ts` whole: Code launches and model lists break. |
| D12 | **Config:** `sessions.*` and `ai.chat` leave `config.default.json`, `settings-schema.js` (their Settings rows go), `VAULT_CONFIG_DEFAULTS` and migrations' `AI_KEYS`; `ask.js --chat` goes. **`aos upgrade` removes both from the vault's `brain/config.json`** through a small retired-keys list and `config-write` `unsetPath`. The ledger's `session:*` rows stay excluded from hook caps (`spend-ledger.js` `HOOK_EXCLUDE`, `cli/aos.js` `isHookFeature`, `statusline-model.js`). | Leaving the keys: `aos upgrade` writes every default into `config.json` (`cli/aos.js:1427`), so each upgraded vault would get a doctor warn for unknown keys (`config-cmd.js:266-274`). |
| D13 | **Tour:** the core step `sessions`, the chapters `sessions` and `sessions-history` and `chatAvailable`/`sessionsShown` go; `TOUR_TABS` drops `chat`; a `code.history` step (`since` the next version; `pane` allowed on `term`); `code.foot`, `spaces.resume` and the action `first-session` reworded or retargeted; past `whatsnew.json` refs to `sessions.*` retargeted (the validator needs live refs); the release's What's new entry says Sessions is gone and Show me opens `code.history`. | — |
| D14 | **Copy:** the wizard's "Sessions and the Chief of Staff wait…" (`wizard.ts:419,442,713`), the collector's "open it in Sessions" reasons (`collectors/hostSessions.js:75,78`), `reasoner.model`'s help naming the Chat tab, README, `docs/*`, `SECURITY.md`, `app/README.md`, `vault-template/AGENTICOS.md:52`. | — |
| D15 | *(user)* **Code's model chip remembers.** A model picked in a Code terminal's chip (`TermComposer.pickModel`) also becomes that host's default for new terminals, written to `sessionChoice.models[host]` through `rememberSessionChoice` (kept), as the Sessions composer's pick did; it still restarts only its own terminal. `modelLabel`'s "remembered from Sessions" (`terminalLauncher.ts:139`) and the New menu's line say "your last pick". *(builder's call)* An effort picked there is remembered the same way when the chip sets one. | Resetting the remembered models on upgrade (no remembered pick at all). Leaving the old Sessions pick as a hidden default nothing can change. |
| D16 | *(user)* **In-app commit goes.** Sessions' Review changes card (`SessionsTab.ts:728`, `git.commit`) is the app's only Commit; Code's Diff pane stays read-only. The CHANGELOG's **Removed** says to commit from the terminal (ask the agent, or run git). | Adding Commit to Code's Diff pane (HUD, main, IPC and a surface rule, and a live check). |

## 3. What already exists (verified at 431d7ada)

- **Rail and routing:** `RAIL_SECTIONS` has `chat` "Sessions" in the first section (`WorkbenchView.ts:54`), drawn only while
  `plugin.sessionsShown()` (`railChat`, :140, :260-289); `TAB_ALIASES` (:84) feeds `WORKBENCH_TAB_IDS` (:87) and `open()`
  (:596). `hud/main.ts`: `chatAvailable` :324, `historyOnDisk` :331, `sessionsShown` :347, `claudeBin` :352 (Vault only).
- **Sessions tab:** `SessionsTab.ts` (1,378 lines): History at :38, :151-158, :302-331, :978-1060; `resumeHistory` calls
  `launchTerminal` (`WorkbenchView.ts:557`). `ChatTab.ts` (720): Vault chat, log `brain/_index/agentic-os-chat.jsonl`.
- **Main:** `SessionService` (`services/sessions.ts`, 644 lines) is enabled by the `sessions` surface (`surfaces.ts:656`,
  `verified: true`, `index.ts:210`); its `resolveBin` :394, `catalog` :371, `postComputerNotice` :429 serve Code and the
  Computer. `GitService.statusAt`/`diffAt` serve Code's Diff (`code-git.ts:117`).
- **Runtime:** `lib/sessions.js` verbs `args` :88, `events` :97, `catalog` :108, `mirror` :123 (Code chat), `bin` :155,
  `record` :162. `ai.chat` reaches only `provider.js` for `reason:chat` (`ask.js --chat`).
- **Code:** `TermList` past rows and `allHistory` (:25-26, :148-151); `TermTab.openHistory` opens `{ tab: "chat",
  pane: "history" }` (:26); `hasChat` covers every agent host, Claude and Codex (`terminalSession.ts:43`).
- **Tests:** e2e `sessions.spec.ts` (1,206), `chat-writes.spec.ts` (469), `signin-first-launch.spec.ts`, Vault cases in
  `local.spec.ts`, `history-mcp.spec.ts`; `computer.spec.ts` drives a Sessions turn in 37 of 53 tests (`chatAgent`,
  `newSession`). Rail order pinned by `harness.ts`, `shell.spec.ts`, `tab-layout.spec.ts`, `smoke-packaged.mjs:41`.
  COVERAGE CH1-CH6, SE1-SE17.

## 4. Design

### 4.1 PR 1: what users see (`feat/remove-sessions-tab`)
- **History in Code (D3):** a History view in `CodeStage`, opened from `TermList`'s "All history" (no tab change) and
  from `TermTab.reveal({ pane: "history" })`; the rows, filter, paging and Resume ported from `SessionsTab` onto
  `HistoryCache`; its CSS moved from `.aos-ss` (`styles.css` History block) to a Code class.
- **Out:** the rail entry, `railChat` and its provider-state watch, `SessionsTab.ts`, `ChatTab.ts`, `claudeAsk.ts` (after
  D10's move), `askSpawner.ts`, `AccessMenu.ts`, the Sessions-only CSS (~430 lines), `chatAvailable`, `sessionsShown`,
  `historyOnDisk`, `claudeBin`, the palette command. **Redirects:** D4, D5, D6. **Settings:** D8, D9. **Tour and copy:**
  D13, D14. **Code's chip (D15):** `pickModel` saves its pick; a unit test that a pick in one terminal sets the next
  launch's model for that host and leaves the other host's alone.
- **Tests:** delete `sessions.spec.ts`, `chat-writes.spec.ts`, `signin-first-launch.spec.ts` and `local.spec.ts`'s Vault
  cases; rewrite `history-mcp.spec.ts`'s History cases against Code; port `computer.spec.ts`'s Sessions-turn tests to
  `codeAgent` and drop the Chat-only ones (thread delete, thread switching); update variants, tour, shell, tab-layout,
  sidebar-omni-notes, spaces-writes, spaces-runs, code-chat specs, `harness.ts`, `smoke-packaged.mjs`; COVERAGE drops
  CH and SE rows (SE14-16 become Code History rows); `docs/app-smoke.md` likewise. CHANGELOG: **Removed**, **Changed**
  (History in Code, `<!-- tour: code.history -->`; Code's chip remembers its model, D15), **Upgrading** (D7). Removed
  names Vault chat and in-app commit (D16).
- **Invariant:** main is untouched. The `sessions` surface stays on because the Code composer's catalog still goes
  through it.

### 4.2 PR 2: the code nothing uses (`chore/remove-sessions-backend`, after PR 1 merges)
- D11's move, then delete the rest of `SessionService`, `ipc/sessions.ts`, the `sessions`/`git` workspace parts of
  `AosBridge`, preload, `bridgeHost.ts`, schemas, the `chat` and `sessions` surfaces (Vault's ask/recall/`claude -p`
  rules), `sandbox.spec.ts`'s pinned lines, `HostSessions`/`HostGit` in `hud/src/host.ts` (catalog kept).
- Runtime: `lib/sessions.js` (D11), `headless.js` `sessionArgs`/`sessionAllowedTools` (`SESSION_EFFORTS` kept),
  `telemetry.js` `appendRunSummary`, `ask.js --chat`, the collector's app-thread attribution, `cli/workspace.js` thread
  moves and running-turn refusals, D12's config work.
- Tests: `app/tests/unit/sessions.test.ts` trimmed to resolveBin, catalog, notices and the `statusAt` guards;
  `write-policy`, `host`, `bridge-host-agent`; `brain/scripts/test/sessions.test.js` keeps catalog; `cli/migrations` and
  `workspace` tests; `launch.spec.ts:103`.
- **Both PRs land before the next release:** between them the Settings tab still shows the Sessions caps and
  "Vault chat runs on".

**Size:** PR 1 ~6,000 lines out, ~500 in; PR 2 ~2,500-3,200 out.

## 5. Host parity

1. **Entry:** nothing new to invoke. History is Code's "All history", a rail click away on both hosts; links naming
   `tab=chat` land on Code. No in-session command or skill names Sessions (`plugin/`, `codex-plugin/` unchanged).
2. **Hooks:** none change. 3. **Model calls:** one fewer (Vault chat's `claude -p` / `ask.js --chat`); nothing added.
4. **Session data:** History reads the scan's session index and digests as today (`sessionHistory.ts`), both hosts'
   sessions; never a transcript.
5. **MCP:** none. 6. **Degradation:** History lists past sessions with no host signed in; Resume is disabled with its
   reason when the session's host is off or signed out (today's `resumeFor`).
7. **Docs:** README, `docs/install.md` Hosts, `docs/app-smoke.md` History item per host, COVERAGE rows.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Code tab; "All history"; old `tab=chat` links | a Code terminal running `claude`; History Resume `claude --resume <id>` | Codex rows in History with Resume disabled and its reason |
| Codex only (plugin · direct) | the same | a Code terminal running `codex`; Resume `codex resume -C <folder> <id>` (`variants.spec.ts`) | Claude rows with Resume disabled |
| Both | the same | each row resumes on its own host | — |

## 6. Out of scope

A replacement for Vault chat; a viewer for old Sessions thread files; commit in Code (D16); renaming `.aos-ss-*`; any
Code change beyond hosting History and D15; why History's index misses Codex `exec` rollouts (separate fix); the version
number (chosen at release).

## 7. Open questions

- **B1** (D15), answered 2026-11-25: Code's model chip remembers its pick as the host's default for new terminals.
- **B2** (D16), answered 2026-11-25: losing in-app commit is accepted; commit from the terminal.

None open. D5 and D7 are technical calls the user can overturn.
