# UniDeX Code: a chat view over the live terminal

**Date:** 2026-11-09
**Status:** approved 2026-11-09. The mockups (today; options A, B and C; B's terminal view in dark; two B + A
hybrids that were set aside) are on a private design canvas, not in the repo. The user picked **B**.
**Scope:** the Code tab (rail id `term`). An agent terminal shows a chat laid out like the Claude Code app, while the
real `claude` or `codex` process keeps running in its PTY one keystroke away. The same release adds past conversations
in the sidebar, approval cards, the status line under the composer, Diff and Files panes, and images in the composer.

---

## 1. Problem

- **Long agent runs are hard to read in Code.** The middle of the tab is a raw TUI in a card: a wall of monospace with
  no tool summaries, no diff view and no task list. The Claude Code app presents the same work as a readable chat.
- **The terminal must survive.** The user wants that look without losing anything the TUI does: slash commands,
  pickers, `/model`, Esc to interrupt, resume, and the AgenticOS status line (three rows, with clickable alerts and flags).
- **History is elsewhere.** Code lists only open terminals. Past conversations live in Sessions ▸ History.
- **No images.** The composer cannot send a screenshot (term-agent-deck T12 deferred images to a binary-write channel).

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| C1 | **Layout B.** Agent terminals open in a chat view. ⌘J, or the Chat · Terminal switch in the top bar, flips the middle to the same PTY. Nothing restarts, so every TUI feature keeps working. Each terminal remembers its last view. | A, terminal in the middle with new chrome around it: barely looks like the app. C, chat and terminal side by side: a cramped TUI, and the conversation shown twice. B + A, with a pane open by default: the user chose B alone. |
| C2 | **The chat comes from the host's own transcript.** A runtime follower reads it through `lib/transcript.js` and writes the runtime's session-event shape (`lib/session-events.js`) to a vault cache. The HUD tails that cache and draws it with Sessions' `threadRows` and a renderer extracted from `SessionsTab`. | Reading the TUI screen: lossy. Driving the agent headless with stream-json, as Sessions does: the TUI would be gone. The HUD or main reading transcripts directly: breaks host-parity Q4. |
| C2a | **The chat follows the conversation when its id changes** in the terminal: `/clear`, `/resume`, `/new`, and Resume latest (`--continue` / `resume --last`). Each agent PTY gets `AOS_TERMINAL=<terminal id>`. **Claude Code:** the status-line tee (C5) is keyed by that id and records `session_id` and `transcript_path`, so the follower re-targets when they change. **Codex:** the follower stays in folder mode for the terminal's whole life and follows the most recently appended rollout with that cwd since the terminal started. When two Codex terminals in one folder can't be told apart, the chat shows "Can't tell which conversation · Terminal ⌘J". *(Builder's call, made by me.)* | Pinning one id at launch: the chat silently goes stale after `/clear`. Hooks: ruled out by §5.2. |
| C3 | **Shells have no chat.** zsh always opens in the terminal view, with the Chat · Terminal switch hidden. | A chat of shell commands: the shell already is the prompt. |
| C4 | **Approval cards mirror the TUI's own prompt.** The card shows the question, the command or file, and the numbered choices, read from the session's terminal screen. A click sends that choice's key. When the screen can't be parsed, or the TUI shows something the chat can't draw (`/model`, `/config`, a menu), a card reads "Waiting on you in the terminal" with a ⌘J button. The view never flips by itself. | Choices taken from the transcript: a pending prompt is not in it. Auto-flipping: the user's call (approved playback). |
| C5 | **The status line looks exactly as the terminal draws it** (user's pick): the same rows, colours and OSC 8 links, under the composer. **Claude Code:** when `AOS_TERMINAL` is set, `aos statusline render` also writes `brain/_index/statusline/<terminal id>.json` holding `{at, session_id, transcript_path, ansi}`, where `ansi` is its exact output. **Codex:** the footer rows are mirrored from the session's terminal screen. When neither is available (another status-line command, or a screen that can't be read), the composer shows the hint "Status line in the terminal ⌘J". | One compact row (the user chose exact). Rebuilding the line from `statusline.json`: it has no per-session model, context or cost. |
| C6 | **Past conversations in the sidebar** (user's pick). Each workspace group lists its open terminals, then its 10 most recent past conversations from `sessionHistory.ts`, plus Show more. A past conversation opens read-only in the chat with **Resume**, which uses sessionHistory's resume line (spaces-redesign D7, D31) in a new terminal. *Groups (builder's call, made by me):* ordered by last activity. A group is shown when it has an open terminal or a conversation from the last 14 days. The vault root, home and other folders share one "Other folders" group. A terminal closed in this app stays listed, from the pool's own record, until the index has it. "All history" opens Sessions ▸ History. | Open terminals only: past work stays a tab away. Every workspace ever used: dozens of groups. |
| C7 | **Images in this release** (user's pick). The composer accepts PNG, JPEG, GIF and WebP up to 10 MB by paste, drop or the + button. Main checks the magic bytes and saves the image to the app's data folder, `code-images/<yyyy-mm>/<uuid>.<ext>`, through a new `code:saveImage` channel. The composer shows a chip, and Send pastes the absolute path in the bracketed paste; both TUIs turn a pasted image path into an attachment. If a host shows it as plain text, the agent reads the file with its own image tool. | A vault folder: the vault syncs and backs up screenshots, and HostFs refuses dot-folders. The temp directory: the image is gone when the session is resumed. |
| C8 | **Panes behind top-bar buttons, closed by default.** **Diff** shows read-only git status and diff for vault workspaces *and* a workspace's linked code folder (`repo:` in `workspace.md`, term-agent-deck T8) (user's pick). It runs through a new `code:git` channel that takes a terminal id, never a path: main resolves the folder from the pool's place, and the channel has no Sessions-surface dependency. **Files** shows the Files view scoped to a vault workspace (2.6.0: Files opens the Files tab at the workspace; an embedded pane would need FilesTab refactored). **Computer** is today's pane. For the vault root, home and other folders, the Diff and Files buttons, the branch and the diff count are hidden. | Open by default (B + A): set aside. Vault workspaces only: the user's own linked checkouts would get no Diff. Any folder: a read surface for arbitrary paths. |
| C9 | **UniDeX's own look:** Inter, monochrome tokens (`ui/tokens.ts`), light and dark. The Claude app's layout, not its colours or brand. | Claude's palette: another product's brand. |
| C10 | **Row status from the transcript and the screen,** for every agent terminal, not only the one in view. Working: the turn is not done and the PTY is printing. Needs you: a C4 prompt is on its screen. Idle: the turn is done. Exited n: the PTY ended. The rail badge counts Needs you. Each agent terminal feeds its raw stream to a headless screen (`@xterm/headless` 5.5.x, the visible xterm's sibling package, scrollback 0), which `termScreen` reads. *(Builder's call, made by me.)* | Needs you for the selected terminal only: the badge would only work when it isn't needed. Titles, bell and OSC 9 alone: too weak for Claude. Hooks: no live PTY state. |
| C12 | **The composer's access and model chips are controls.** A change restarts the agent on the same conversation: `claude --resume <id> --model …` or `codex resume <id> -m …`, plus the access flags (term-agent-deck T11). The chips are disabled while the agent is Working. A model changed inside the TUI shows in the chip, read from the transcript. *(Builder's call, made by me.)* | Driving the TUI's own `/model` and mode dialogs with keystrokes: fragile for every CLI version. Labels only: the mockup shows working pickers. |
| C13 | **A new `code` write surface** owns the `mirror` spawn rule and `code:saveImage`. In 2.6.0 it is on by default only after its live check (`verified: true`), as Computer was. When it is off, agent terminals open in the terminal view, and the switch says "Chat view is off · Settings". *(Builder's call, made by me.)* | Putting it under Sessions: turning Sessions off would also remove Code's chat. |
| C11 | **Four PRs, then 2.6.0.** P1: follower, cache, status-line tee. P2: chat view, top bar, sidebar with history, ⌘J, status line. P3: approval cards, row status, Diff and Files panes. P4: images. | One PR: too large to review. |

## 3. What already exists (verified at `81445fd`)

- **Code tab:** `TermTab.ts` → `TerminalPanel` in deck mode, with `TermList`, `TermComposer` (one bracketed paste, then
  ⏎), `NewTerminalMenu` and `ComputerPane`. An xterm exists only for a viewed terminal (term-agent-deck §3).
- **Chat rows and renderer:** `agentSessions.ts:68,220` (`threadRows`: prompt, text, tool with `verb`/`target`, patch,
  plan, done, error). `SessionsTab.ts:1147–1258` draws them (`renderRow`, `renderTool`, `renderPatch`, `renderDiff`), and
  `renderRepo` (`:1276`) draws git counts and diffs through HostGit.
- **Event shape:** `lib/session-events.js` `createParser(host)`. Main's `services/sessions.ts` spawns `sessions.js events`
  and never parses host output itself (`:1–14`). Spawn rules: `surfaces.ts:642–643`.
- **Transcripts:** `lib/transcript.js` (`parseClaude`, `parseCodex`, `sessionHead`, `sessionTail`, `:94–423`).
  `collectors/hostSessions.js` indexes both hosts into `brain/_index/session-index.json`.
- **History:** `hud/src/data/sessionHistory.ts` reads the index and digests and builds the resume lines.
- **Ids:** Claude launches pass `--session-id` (`terminalLaunch.ts:476`), and `terminalSession.ts:31` keeps it. A new
  Codex session has no id at launch.
- **Status line:** `brain/scripts/statusline.js render` reads Claude's payload on stdin (`session_id`, `:103`) and prints
  up to three lines. Codex's line is built-in items, configured by `statusline-install.js`.
- **Files:** `fs:*` goes only through the vault FsService (`app/src/main/ipc/fs.ts:10–31`). There is no binary write.
  The vault watcher (`watcher.ts`) reports changed paths to the page.
- **Keys:** ⌘J is unbound in `main.ts` and the HUD.

## 4. Design

**Runtime (P1).**
- `lib/transcript-events.js` maps Claude and Codex transcript entries to session events. It has fixture tests per host
  and reuses the `session-events.js` helpers (`summary`, plans).
- `lib/sessions.js mirror --host <h> (--id <id> | --cwd <dir> --since <ms>) [--follow]` writes
  `brain/_index/code/<host>-<id>.jsonl`: the whole transcript first, then each appended entry. Without an id, it picks
  the newest Codex rollout whose `session_meta` cwd matches and that started after `--since`, and writes the id it
  found to the cache's first line.
- `--follow` polls the file size every 250 ms and exits on SIGTERM or when the transcript is gone. `scan-vault` prunes
  caches older than 14 days.
- When `AOS_TERMINAL` is set, `statusline.js render` also writes `brain/_index/statusline/<terminal id>.json` (C5,
  C2a): the id is checked with `workOf`'s rule, written with an atomic rename, best effort. It never changes stdout or
  the exit code. Caches older than 24 h are pruned.

**Main (P1, P4).**
- Agent PTYs get `AOS_TERMINAL=<terminal id>` in their environment (`programs.ts`).
- A spawn rule for `mirror` under the `code` surface (C13). One follower runs per open agent terminal, plus one `--once`
  run for a viewed past conversation. When a Claude terminal's tee names a new `session_id`, the follower is restarted on
  it. Followers are killed when their terminal closes and when the app quits.
- `code:git` (P3): `{ terminal, op: "status" | "diff", file? }`. The folder is resolved in main from the pool's place
  (the workspace, or its linked `repo:`), and the command is `git status --porcelain=v2 -b` / `git diff`, never
  anything that writes. The channel gets a `sandbox.spec.ts` line and one line in `SECURITY.md`.
- `code:saveImage` (P4): zod-checked `{ mime, bytes }` (base64, at most 10 MB), checked against the magic bytes, and
  written under `userData/code-images`. It returns the absolute path. The channel gets a `sandbox.spec.ts` line and
  one line in `SECURITY.md`.

**Layout of record (board B; the canvas sources are kept privately with the vault's design notes).**
- **Rail:** unchanged.
- **Sidebar, 264 px:**
  - the New session split button: "+ New session ⌘T" over "host · place", with ▾ for the New menu;
  - Search sessions;
  - workspace groups, each row a status glyph, a title, and "Host · status · age" (Needs you in the gate colour);
  - a footer: "n open · n need you".
- **Top bar, 48 px:** title · folder chip with ⎇ branch · host-dot chip "Host · Model" · spacer · Chat | Terminal ⌘J
  segmented switch · `+n −n` · Diff, Files and Computer icon buttons · ⋯.
- **Chat, a 760 px centred column:**
  - your prompt as a right-aligned raised bubble;
  - agent text at 14.5 px;
  - tool rows as an icon, a verb, a bold target and a dim result;
  - an Edited row opens an inline diff card;
  - the task card;
  - the approval card last, in the gate colour, with numbered buttons and "Answer in the terminal ⌘J".
- **Composer, the same 760 px column:**
  - a rounded 14 px box with chips for + attach, @ file, / commands and Snippets on the left, access and model on the
    right, and a round send button;
  - the status line in mono under it.

**HUD (P2–P4).**
- `ui/ThreadView.ts` is extracted from `SessionsTab`. Sessions keeps its behaviour, and its specs pin that.
- `data/codeChat.ts` (pure): cache lines → `threadRows` plus the C10 status.
- `data/termScreen.ts` (pure, over a snapshot of a terminal's headless screen, C10): the approval prompt per host,
  Codex's footer rows, and "a TUI dialog is open". It has fixtures per host and CLI version.
- The selected terminal's xterm stays alive while the chat is shown: hidden, at its last size, so the flip is instant
  and `termScreen` has a buffer.
- The top bar shows the title, folder ⎇ branch, host · model, Chat · Terminal ⌘J, the diff count, and the three pane
  buttons.
- `TermList` becomes the sessions sidebar: the New session button, search, groups with open terminals, then history.
- `TermComposer` gains access and model chips, the image chip, and the status line under it, rendered by an ANSI/OSC 8
  span renderer.
- A Stop button in the chat sends Esc to the PTY.

**Tests and docs.**
- Unit tests for every pure module above.
- e2e: a fixture transcript renders as a chat; ⌘J keeps the PTY's pid; an approval click writes the key; a history row
  resumes; an image is saved and its path pasted; Codex-only works (`variants.spec.ts`).
- `docs/app-smoke.md` items per host, with their `COVERAGE.md` rows.
- A tour step for Chat · Terminal (`since` 2.6.0), a `whatsnew.json` entry for 2.6.0, and CHANGELOG lines.

## 5. Host parity

1. **Entry point:** the app's Code tab only. No command, skill or `aos` verb; `mirror` is an internal runtime command.
2. **Hooks:** none added or changed, so Codex users re-trust nothing.
3. **Model calls:** none.
4. **Session data:** read only by the runtime, through `host.js` / `transcript.js`, for both formats. The HUD reads the
   `brain/_index/code` and `brain/_index/statusline` caches. No transcript is read by main or the HUD.
5. **MCP:** no new tool.
6. **Degradation:**
   - A host that is off has no rows and no New button entry.
   - A transcript that can't be mirrored shows "No chat for this session yet · Terminal ⌘J", and the terminal works.
   - A screen that can't be parsed gets the generic C4 card.
   - A status line that can't be shown gets the C5 hint.
7. **Docs:** README (Workbench app section), `docs/app-smoke.md` per host, `COVERAGE.md`, the tour, CHANGELOG.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | New session ⌘T, or a sidebar row | `claude` in a PTY. The `mirror` follower reads its transcript by `--session-id`. The status line comes from the `.ansi` tee. | The C4 generic card, and the C5 hint when another status-line command is installed. |
| Codex only (plugin · direct) | The same | `codex` in a PTY. `mirror` finds the rollout by cwd and start time. The footer is mirrored from the screen. | The same; the status line is not shown when the footer can't be read. |
| Both | The same; the New menu picks the host | Each terminal by its own host | As above, per terminal |

The only mechanism that differs by host is C5's status-line source: a tee for Claude Code, the screen for Codex. What
the user sees is the same.

## 6. Out of scope

- The Sessions tab's headless chats; they stay as they are.
- The Pulse strip's terminals.
- Committing or editing from the Diff pane.
- A chat for shells.
- Image thumbnails for past transcripts' inline images: they show an "image" chip.
- Hook-based status.
- Claude's palette or brand.
