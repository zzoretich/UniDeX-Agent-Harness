# UniDeX Term: an agent deck you can start from anywhere

**Date:** 2026-10-08
**Status:** approved 2026-10-08 (T1 amended: the list pane is in release 1). The mockups (today, layouts A–C, the chosen
B "Agent deck", the New menu, New workspace, states, the composer and look-and-feel) are on a private design canvas, not
in the repo.
**Scope:** release 1 of the Term tab redesign (rail id `term`): start Claude Code, Codex or a shell in one step without
picking a workspace, create a workspace on the way, the deck's list pane, a composer for agent prompts, and real titles.
Agent status (Working / Waiting on you, the Needs-you group, the rail badge) is release 2; exact status from hooks, the
approval bar and notifications are release 3 (§7).

---

## 1. Problem

- **Nothing is agent-aware.** Term tabs read `t1 t2 t3` (`TerminalSession.setTitle` is never called, `terminalSession.ts:62`), "+ new" only opens zsh, and the agents' own titles (OSC 0/2) are dropped.
- **Starting an agent takes a detour.** Only Skills, Agents, Proposals, Notifications, Agent Teams and Settings type commands into a new vault-root shell (`runInTerm`, `WorkbenchView.ts:254-264`). There is no "new Claude Code / Codex here".
- **No workspace on the way.** Only `aos workspace new` creates one (`cli/workspace.js:89-101`); Sessions refuses to start without one (`SessionsTab.ts:1092`); Spaces has no create action.
- **Agents may not be found.** A Finder-launched app gives the Term zsh launchd's PATH, and the zsh is not a login shell, so `~/.zprofile`'s `brew shellenv` never runs (`setup/env.ts:1-4`). npm-installed CLIs (`#!/usr/bin/env node`) fail even by absolute path.
- **Small bugs:** "New terminal session" opens two shells on an empty pool (`main.ts:100-106` + `TerminalPanel.ts:91-98`); Spaces' "terminal here" hides its new shell behind `pool.list()[0]` (`SpacesTab.ts:397-405`, `TerminalPanel.ts:101`); the "Cmd-Shift-N" tooltip is bound to nothing (`TerminalPanel.ts:68`); links clicked inside the xterm open nothing (`window.open()` with no URL).

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| T1 | **Layout B, "Agent deck"**, built in three releases. **Release 1 has the list pane** (user's pick): the New button on top, a filter, then one group per place (each workspace, Scratch, Vault, Other), with rows showing a host dot, the title, an origin ("from Skills") and an end state (Done, Exited n, Not found). A group's + starts the last-used host there. Live status, the Needs-you group and the badge are release 2. The Pulse strip keeps a tab strip. | A (polished console): no room for many agents. C (grid): too small for a TUI; it may return as a view of B. |
| T2 | **Zero-pick launch.** ⌥⌘1 Claude Code, ⌥⌘2 Codex, ⌥⌘3 Shell, from any tab; ⌘T starts the **last-used** host (user's pick). Launches from the deck (button, menu, ⌥⌘ keys, New workspace) set it; `runInTerm` callers do not. If the last-used host is not ready, ⌘T opens the menu with the reason and never falls through to the other paid host. | ⌘T as a fixed setting (my pick; the user chose last-used). Falling through to another host: silent spend. |
| T3 | **The New button names what it will do:** host dot, "New Claude Code ⌘T", and a second line "in Scratch · Opus · Host default". ▾ opens the menu: **Start now** (one row per ready host), **Start in…** (host switch, filter, Scratch, Vault, Home for shells, Recent, Workspaces), **＋ New workspace ⇧⌘N**, and a command preview of exactly what will be typed. ⇧⌘T opens it. | A modal palette on ⌘T: one more key on every launch. |
| T4 | **Where it lands:** an explicit pick, else what you are looking at (the selected terminal's workspace or Scratch on Term; the workspace open in Spaces), else **Scratch** for agents (user's pick) and the vault for shells (`terminalCwd`, now applied live). A "Started in Scratch · Change" chip follows every launch for 6 s. Vault and Other terminals never count as context. **Amended 2026-10-08 (1.4.0 smoke, user's pick):** the default is the **vault** for agents and shells; only a workspace counts as what you are looking at, and Scratch is used only when picked. | Vault root: breaks "projects live only under workspaces/", `hostSessions` drops vault-root sessions (`collectors/hostSessions.js:142`), and edit access reaches `brain/`. Ask every time. |
| T5 | **Scratch is a real workspace,** `workspaces/scratch`, made on first use with the `aos workspace new` stubs (README.md, CLAUDE.md, AGENTS.md; the README explains it). One shared folder means each host's trust prompt appears once. | A new `_scratch/<stamp>` per launch: a trust prompt every time, hidden from Sessions but listed in Spaces. |
| T6 | **New workspace in one step:** ⇧⌘N or a typed name in the menu, then Enter, makes `workspaces/<slug>` and starts the host there. The HUD writes the folder and stubs through HostFs (the Files surface already allows both: `surfaces.ts:100, :213-221`), with `slugify`, `isReserved` and the stubs ported from `cli/workspace.js` and pinned by a parity test. An existing name never opens silently: only an exact match or an arrow-key pick starts there; otherwise "kite already exists: Open it ⌘⏎". | A spawn rule for `aos workspace new`: a policy change, and the CLI has no `--json`. Typing `aos workspace new` into a shell: depends on `aos` being on PATH. |
| T7 | **Git repo on by default** (user's pick) for New workspace and Scratch, typed as ` git init -q;` before the agent (the HUD cannot write `.git`; `git.ts` has no init). Turned off, with a note, when the vault is itself a repo and its `.gitignore` has no exact `/workspaces/*` line, or has a `!/workspaces/<slug>` line; hidden when the folder exists. | Always on: an embedded repo inside a vault that backs up `workspaces/`. Off: Review changes (release 2) would never work. |
| T8 | **Linked code folders** (user's pick): `repo: <path>` in a workspace's `workspace.md` frontmatter. Terminals "in agenticos-workbench" then start in `~/AgenticOS-Workbench` and keep the workspace's name. "Link a code folder…" in the place menu writes the key. The runtime's `parseManifest` reads it (Spaces shows it) and `attachSessions` credits sessions run there to the workspace. | Cloning the repo into `workspaces/` (sessions spec S4): duplicates the checkout. |
| T9 | **"Make this a workspace…"** on Scratch: name it (prefilled from the conversation title), create it, and start the same host there with the composer prefilled with "Continue the work from ../scratch: bring over what we need" (not sent). Nothing is moved. | Moving Scratch's files: HostFs refuses dot-files and `node_modules` (`surfaces.ts:100`), so a project would arrive half moved. |
| T10 | **Launch line:** ` command -v <bin> >/dev/null 2>&1 && exec <bin> <flags> \|\| echo '<Host> was not found: run aos doctor'`. `<bin>` is `hosts.<h>.bin` from agenticos.json, quoted with `shq`, or else the bare name. `exec` makes the row end with the agent's own exit code; the guard keeps the shell open with a message instead of a dead row. | Bare `claude` without exec: the row never ends, and a missing binary looks like a crash. |
| T11 | **Access defaults to Host default** (user's pick): no flags, exactly like typing `claude` or `codex` yourself. Read only, Edit files and Edit and run map to Claude `--permission-mode plan` / `acceptEdits` (+ `--allowedTools Bash`) and Codex `-s read-only` / `-s workspace-write`, with `-a on-request`. No headless flags (`-p`, `--permission-prompts none`, `approval_policy=never`), so the agents keep asking. | Sessions' `edit` default: it means "never asks" there, and the opposite here. |
| T12 | **Composer in release 1** (user's pick). It sits under the terminal card on agent rows (⌘L, Esc back), sends one bracketed paste (`ESC[200~…ESC[201~`, then ⏎), and supports ⇧⏎ for a new line, @file chips (a file list inside the vault; a typed path elsewhere), Snippets (saved prompts, optionally per host), and the host's commands through `SlashMenu` (`/name` for Claude, `$name` for Codex). Images wait for a binary-write channel (release 2). | A composer for shells: the shell already is a prompt. |
| T13 | **The empty Term tab still opens a shell** (user's pick), and so does the Pulse strip. The New menu and the shortcuts are the ways to start agents. | A launcher empty state (my pick). |
| T14 | **Terminals get the login-shell PATH.** Main computes `loginPath()` once (`setup/env.ts:48-56`) and makes `{...process.env, PATH}` the PTY base environment; `CLAUDECODE` is dropped. Main still decides everything, so there is no new IPC; SECURITY.md:42 gets one line. | Telling users to move `brew shellenv` into `.zshrc`. |
| T15 | **Three PRs, then 1.4.0:** 4a "start anything" (T2–T11, T14, titles, metadata, the bug fixes); 4b "the deck" (T1's list pane, the header and its chips, the Term keys); 4c "composer and card" (T12, ⌘F, links, ⇧⏎, card look). | One PR: too large to review. |

## 3. What already exists (verified at `d6ca407`)

- **PTY:** any existing absolute folder can be a terminal's cwd (`pty.ts:60-61`). Only a listed shell with no arguments may start (`programs.ts:109-114`), with at most 32 terminals. The environment is main's plus `TERM`, `COLORTERM`, `AGENTIC_OS` and the SPAWN_VARS (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` only to recorded folders; `programs.ts:59-76`).
- **xterm 5.5.0** with addon-fit and addon-web-links only. It already exposes `onTitleChange`, `onBell`, `parser.registerOscHandler` and `paste` with `allowProposedApi`. An xterm exists only for viewed sessions (`TerminalPanel.ts:205-252`), so titles have to be read from the raw stream in `TerminalSession.onData`.
- **Hosts:** `sessionHosts` / `hostChoices` (`aosConfig.ts:121-126`, `agentSessions.ts:403-417`); `defaultChoice` and `modelArg` (`:531-556`); `HostModelMenu`, `AccessMenu`, `SlashMenu`; `SessionChoice` remembered in settings (`settingsDefaults.ts:11-26, 88-144`); `aliasCatalog` when no catalog is available.
- **Keys:** ⌘T, ⇧⌘T, ⇧⌘N, ⌥⌘1-3, ⇧⌘[ ⇧⌘], ⇧⌘W, ⌘F and ⌘L are free (`menu.ts:8-25`). A command's default `hotkeys` gives it the File menu, ⌘P and the page keymap (`boot.ts:118-143`). ⌥ chords reach the app through the menu accelerator, because ⌥ changes `e.key`.
- **Writes:** HostFs `mkdirSync` / `writeFileSync` → `fs:mkdir` / `fs:writeText` under the Files surface, dot-paths excepted. `scan-vault.js --quiet` is an allowed background job (`surfaces.ts:85`).
- **Tests pinning today's Term:** `sidebar-omni-notes.spec.ts:168-187`, `proposals.spec.ts:159-169`, `pulse.spec.ts:162-185`, `harness.ts:410-422`; COVERAGE TM1; app-smoke `:95, :241-243`.

## 4. Design

**Data (pure modules, each with unit tests):**
- `data/terminalLaunch.ts`:
  - `resolvePlace(ctx)`: T4.
  - `placeOf(cwd)`: longest prefix, as in `attachSessions`, including linked repos.
  - `hostReadiness`: `hostChoices` + `provider-state` bin + catalog.
  - `launchLine(host, model, access, bin, sessionId)`: T10/T11.
  - `slugify`, `isReserved`, `stubs` and `completeStubs` ports, plus `gitInitWanted(vault)`: T7.
- `data/termStream.ts`: a chunk-safe scanner for OSC 0/2 titles. It strips Codex's spinner glyph and also records OSC 9, BEL and `?2004h/l` for release 2.

**Session metadata** on `TerminalSession`: `{host, place, origin, model, access, claudeSessionId, startedAt, exitCode, title}`, plus a pool `session-update` event.
- `runInTerm(command, {host, origin})`: every caller passes its host, so rows get the right dot and a "from Skills" subtitle.
- Spaces' "Terminal here ▾" adds "Claude Code here" and "Codex here", and activates its session.
- The panel remembers the selected terminal across visits.

**UI:**
- `ui/NewTerminalMenu.ts`: T3, plus the New workspace sheet (T6/T7) and its downward popover modifier.
- 4b, the deck: on the Term tab `TerminalPanel` gets a deck mode with `ui/TermList.ts`, T1's grouped list.
  - Groups are ordered by the last launch there (Sessions' `groupThreads` rule), with Vault and Other last.
  - Rows are picked by click or ⇧⌘[ ⇧⌘]; × or ⇧⌘W closes one.
  - Ended rows offer Restart, Resume and Open a shell here; the list's ⋯ has "Clear ended".
- Header: place chip ▾ (Move to…, Make this a workspace…, Link a code folder…, Open a shell here, Reveal in Files, Copy path), the title, then host, model and access chips. Changing model or access restarts with `--resume <id>` (Claude) or `resume --last` (Codex).
- The Pulse strip keeps a tab strip: host dot, title (else "Claude Code", "Codex" or "zsh") and place.
- 4c adds the composer (T12) and a padded, rounded card.

**Commands** (`main.ts`, with default hotkeys):
- `new-terminal` ⌘T
- `new-terminal-claude` ⌥⌘1 and `new-terminal-codex` ⌥⌘2, each only when that host is enabled
- `new-terminal-shell` ⌥⌘3
- `new-terminal-menu` ⇧⌘T
- `new-workspace` ⇧⌘N

On the Term tab only: ⇧⌘[ / ⇧⌘] switch terminals and ⇧⌘W closes one, asking first when it is an agent (4b). ⌘F finds (4c, `@xterm/addon-search`) and ⌘L opens the composer (4c).

**Settings:** `terminalChoice {host: claude|codex|shell, access, agentPlace: scratch|last|vault, recent[], snippets[]}`, with `sanitizeTerminalChoice`. Models are shared with Sessions through `sessionChoice.models`.

**Runtime:** `collectors/workspaces.js` `parseManifest` reads `repo` (absolute or `~`). `hostSessions.attachSessions` matches the workspace path or its repo. `vault-template/AGENTICOS.md` gets one line on Scratch and `repo:`.

**App:**
- PtyService base env (T14) and its unit test.
- Links in the xterm: https through `openExternal`, `agenticos://` through the app's own route, and vault `path:line` through Files.

## 5. Host parity

1. **Entry point.** The Term tab, ⌘P and the File menu: commands of the app's plugin, the same on both hosts. No plugin command, skill or `aos` verb is added.
2. **Hooks.** None in release 1.
3. **Model calls.** None by the app. The user's own interactive agent runs on their account. Like today's `runInTerm` agents, it is outside Sessions' caps and the spend ledger.
4. **Session data.** No transcripts are read. Claude gets a HUD-made `--session-id` so it can be resumed exactly; Codex resumes with `--last`.
5. **MCP.** None.
6. **Degradation.**
   - A host that is off is hidden: no ⌥⌘ chord, no row.
   - A host that is logged out is dimmed in the menu, with its reason.
   - A missing binary prints T10's message in the shell.
   - A Codex-only vault makes ⌘T start Codex from the first launch.
   - With the Files surface off, Scratch and New workspace fall back to typing `aos workspace new` in a vault shell.
7. **Docs.** README (Term), `app/README.md`, SECURITY.md (PTY PATH), CHANGELOG, `vault-template/AGENTICOS.md`, and `docs/app-smoke.md` items per host with their COVERAGE rows.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | ⌥⌘1, ⌘T, New ▾, ⇧⌘N | ` exec claude [--model m] [--permission-mode p] --session-id <uuid>` typed into a zsh in the place | Codex rows absent; "Claude Code was not found: run aos doctor" in the shell |
| Codex only (plugin · direct) | ⌥⌘2, ⌘T, New ▾, ⇧⌘N | ` exec codex [-m m] [-s s -a on-request]` | Claude rows and ⌥⌘1 absent |
| Both | all of the above | the chosen host | — |

**Gaps, shown in the UI:**
- Codex resume is "latest Codex conversation", since its folder scope is unverified.
- Codex's title is spinner + project, so its tab reads "Codex · <first composer message>".
- ⇧⏎ sends Ctrl+J. Claude's docs say Ctrl+J works everywhere; for Codex it is checked by hand before it is turned on.
- The composer's `/` lists Claude commands and Codex `$skills`.

## 6. Testing

- **HUD unit:**
  - `launchLine` per host × access × bin.
  - `resolvePlace`, including Vault rows that never count as context.
  - `placeOf` with linked repos.
  - Slug, reserved names and stubs pinned against `cli/workspace.js`.
  - `gitInitWanted` against `.gitignore` cases.
  - `termStream` titles split across chunks.
  - `sanitizeTerminalChoice`.
- **Runtime:** `parseManifest` `repo`; `attachSessions` credits a repo cwd.
- **App:** PtyService base env (PATH set, `CLAUDECODE` gone).
- **e2e:**
  - A new `term-launch.spec.ts`, using the fixture's claude and codex stubs: ⌘T in Scratch, then ⌥⌘2 Codex, then New workspace creates the stubs and starts.
  - Codex-only in `variants.spec.ts`.
  - The 4b list: Scratch, workspace and Vault groups (with "from Skills"); selection survives a tab switch; ⇧⌘W closes; an ended row's Restart.
  - The 4c composer sends one paste to the stub.
  - Existing Term specs migrated (no double shell).
- **By hand (asks first; it spends):**
  - Both hosts: launch, title, resume, ⇧⏎ and the composer.
  - A Finder-launched app with an npm-installed CLI.

## 7. Out of scope (later releases)

- **Release 2:**
  - Live status in the list (Working, Waiting on you) from titles, bell and OSC 9, plus the "Needs you" group, the rail badge and ⌘J.
  - Review changes for terminals (path-keyed git).
  - Split view.
  - Tray and Dock items.
  - Finder drop and image paste.
  - Reopen after restart.
  - `agenticos://term` links.
  - Sessions using Scratch and linked repos.
- **Release 3:**
  - Hooks with an `AOS_TERM_ID` PTY var, giving exact Approve / Your turn.
  - The approval bar.
  - macOS notifications and the Dock badge.
  - Worktrees.
  - Sessions ↔ Terminal hand-off.
  - Moving Scratch files.
