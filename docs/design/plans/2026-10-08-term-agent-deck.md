# Plan: UniDeX Term agent deck, release 1 (1.4.0)

Spec: `docs/design/specs/2026-10-08-term-agent-deck-design.md` (T1–T15). Three PRs from `feat/term-agent-deck`,
each green on its own, then the 1.4.0 release. Each PR runs §5 of the AgenticOS-New-Feature flow (gate, npm test, lint,
typecheck, changelog, the app checks) before it opens.

## File structure

| File | PR | New / changed | What |
|---|---|---|---|
| `hud/src/data/terminalLaunch.ts` (+ `.test.ts`) | 4a | new | `slugify`, `isReserved`, `workspaceStubs`, `missingStubs`; `gitInitWanted`; `resolvePlace`, `placeOf`; `hostReadiness`; `launchLine`; `parseRepoLink` (workspace.md `repo:`) |
| `hud/src/data/termStream.ts` (+ `.test.ts`) | 4a | new | chunk-safe scanner: OSC 0/2 title (spinner stripped), OSC 9, BEL, `?2004h/l` |
| `hud/src/data/terminalSession.ts` | 4a | changed | metadata (`host`, `place`, `origin`, `model`, `access`, `claudeSessionId`, `startedAt`, `exitCode`, `title`), stream scanner, `onUpdate` |
| `hud/src/data/terminalPool.ts` | 4a | changed | `create(opts)` takes metadata; `session-update` event; `selected` id |
| `hud/src/data/terminalLauncher.ts` | 4a | new | the impure glue: Scratch/workspace creation through HostFs, `launch({host, place, …})`, remembered choice |
| `hud/src/settingsDefaults.ts` (+ test) | 4a | changed | `TerminalChoice`, `sanitizeTerminalChoice`, `rememberTerminalChoice`; `DEFAULT_SETTINGS.terminalChoice` |
| `hud/src/ui/NewTerminalMenu.ts` | 4a | new | split button, ▾ menu (Start now / Start in / Create), command preview, New workspace sheet |
| `hud/src/ui/TerminalPanel.ts` | 4a, 4b, 4c | changed | 4a: New button, titles, dots, Started chip, no double shell, keep selection; 4b: deck mode; 4c: composer, card, search, links |
| `hud/src/ui/TermList.ts` | 4b | new | the grouped list (T1) |
| `hud/src/ui/TermHeader.ts` | 4b | new | place chip menu, model and access chips |
| `hud/src/ui/TermComposer.ts` | 4c | new | composer, @files, snippets, SlashMenu |
| `hud/src/views/TermTab.ts` | 4a, 4b | changed | Term keys, context for ⌘T |
| `hud/src/views/WorkbenchView.ts` | 4a | changed | `runInTerm(command, {host, origin})`, `launchTerminal()`, context getter |
| Skills, Agents, Proposals, Notifications, AgentTeams, Settings tabs | 4a | changed | pass `{host, origin}` |
| `hud/src/views/SpacesTab.ts` | 4a | changed | "Terminal here ▾", activation, `absPath` |
| `hud/main.ts` | 4a | changed | the six commands with hotkeys; settings read for `terminalCwd` live |
| `hud/styles.css` | 4a–4c | changed | menu, sheet, dots, list, header, composer (tokens only) |
| `brain/scripts/collectors/workspaces.js`, `collectors/hostSessions.js` (+ tests) | 4a | changed | `repo` in the manifest; attribution by repo |
| `vault-template/AGENTICOS.md` | 4a | changed | one line: Scratch and `repo:` |
| `app/src/main/services/pty.ts`, `app/src/main/index.ts` (+ unit test) | 4a | changed | PTY base env with the login PATH, `CLAUDECODE` dropped (T14) |
| `app/tests/e2e/term-launch.spec.ts` | 4a | new | launches, New workspace, Codex-only |
| `app/tests/e2e/term-deck.spec.ts` | 4b | new | groups, selection, close, restart |
| `app/tests/e2e/term-composer.spec.ts` | 4c | new | one paste, snippets, `/` |
| existing Term e2e specs, `COVERAGE.md`, `docs/app-smoke.md`, `app/README.md`, `SECURITY.md`, `README.md`, `CHANGELOG.md` | all | changed | as each PR lands |

## PR 4a: start anything

1. [ ] `terminalLaunch.ts` + tests:
   - slug, reserved names and stubs pinned against `cli/workspace.js` (the test requires it).
   - `gitInitWanted` cases: no vault `.git`; `.gitignore` has `/workspaces/*`; a negation; no rule.
   - `launchLine` per host × access × bin, including shq of `[1m]` ids and the not-found guard.
   - `resolvePlace` order (explicit, then context, then default; Vault and Other never count as context).
   - `placeOf` longest prefix with repo links.
   - `parseRepoLink` (`~` expansion; rejects relative paths and the vault itself).
2. [ ] `termStream.ts` + tests: titles split across chunks, ST and BEL terminators, Codex spinner glyphs, OSC 9, bracketed-paste mode.
3. [ ] `settingsDefaults.ts`: `TerminalChoice {host, access, agentPlace, recent}` + sanitizer + remember, with tests; add to `DEFAULT_SETTINGS`.
4. [ ] `terminalSession.ts` / `terminalPool.ts`: metadata, scanner wired to `onData`, title from OSC (else host label), `exitCode` kept, `session-update`; the pool keeps `selectedId`.
5. [ ] `terminalLauncher.ts`:
   - `ensureScratch()` and `createWorkspace(name)` through HostFs. Write the stubs, then `scan-vault.js --quiet` through `runBrainScript`.
   - `launch({host, place, model, access, origin})`: pool.create with cwd and env (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` when recorded), then write the launch line, select it, show Term, show the Started chip.
   - Remember the host on deck launches only.
6. [ ] `WorkbenchView`:
   - `runInTerm(command, {host, origin})`; update all six callers.
   - `launchTerminal(opts)`; `termContext()` (selected row's place, or Spaces' open workspace).
7. [ ] `NewTerminalMenu.ts`:
   - The split button and its label line.
   - Menu sections, filter (create row first on no exact match; arrow keys; Enter, ⇧Enter continue, ⌥Enter shell), command preview.
   - Create sheet (name, host incl. Nothing, git checkbox per T7, exists → Open it).
   - Downward popover.
8. [ ] `TerminalPanel` (4a scope):
   - The New button replaces "+ new"; tabs show dot, title, place.
   - Keep the selected session across mounts.
   - Fix the double shell; drop the stale tooltip.
   - Started chip.
9. [ ] `main.ts` commands: `new-terminal` ⌘T (replaces "New terminal session"), `-claude` ⌥⌘1, `-codex` ⌥⌘2 (enabled hosts only), `-shell` ⌥⌘3, `-menu` ⇧⌘T, `new-workspace` ⇧⌘N. `terminalCwd` read at launch.
10. [ ] `SpacesTab`: "Terminal here ▾" (Shell / Claude Code / Codex), `absPath`, activation.
11. [ ] Place menu (4a minimal, in the menu's footer for the selected place): "Link a code folder…" writes `repo:` into `workspace.md` frontmatter (create the file when missing); "Make this a workspace…" for Scratch (T9).
12. [ ] Runtime: `parseManifest` `repo`; `attachSessions` matches the repo; tests in `brain/scripts/test`; `AGENTICOS.md` line (≤ 9,000 characters).
13. [ ] App: PtyService base env (login PATH cached with `sessionNode`'s, `CLAUDECODE` dropped); unit test; SECURITY.md line.
14. [ ] e2e: `term-launch.spec.ts`; migrate `sidebar-omni-notes`, `proposals`, `pulse`, `shell` (command list) specs; Codex-only in `variants`.
15. [ ] Docs: CHANGELOG `[Unreleased]`, README Term section, `app/README.md`, app-smoke items per host + COVERAGE rows.
16. [ ] Verify (§5), publish check, commit, PR, CI, ask to merge.

## PR 4b: the deck

1. [ ] `TermList.ts`: groups by place (Sessions' order rule), Vault and Other last, origin subtitles, end states, filter, group "+", "Clear ended".
2. [ ] `TermHeader.ts`: place chip menu (Move to…, Make this a workspace…, Link a code folder…, Open a shell here, Reveal in Files, Copy path); model and access chips (restart with resume).
3. [ ] `TerminalPanel` deck mode on the Term tab; Pulse keeps the strip.
4. [ ] Term keys: ⇧⌘[ ⇧⌘] ⇧⌘W (ask first for an agent row).
5. [ ] e2e `term-deck.spec.ts`; docs; verify; PR.

## PR 4c: composer and card

1. [ ] `TermComposer.ts`:
   - ⌘L; Enter sends one bracketed paste and ⏎ (chunked under the 1 MiB pty write cap); ⇧⏎ adds a line.
   - @files (a vault-place list through HostFs; outside, a typed path).
   - Snippets in `terminalChoice.snippets`.
   - `SlashMenu` with the catalog (or `aliasCatalog`).
   - Hidden on shell rows.
2. [ ] Shift+Enter in agent xterms → Ctrl+J (Claude on; Codex after a hand check).
3. [ ] `@xterm/addon-search` (app/package.json + lockfile, SECURITY.md audit row): ⌘F bar.
4. [ ] Links: https → `openExternal`; `agenticos://` → the app route; vault `path:line` → Files.
5. [ ] Card look (padding, radius) and focus rules (no rAF focus steal from composer or menus).
6. [ ] e2e `term-composer.spec.ts`; docs; verify; PR.

## Release 1.4.0

After 4a–4c merge and `main` is green: `npm run version:bump 1.4.0`, lockfiles, commit, publish-check `--release`,
rehearsals, push, CI, **ask before the tag**, tag, release.yml, `release:app`, the §8 update test.
