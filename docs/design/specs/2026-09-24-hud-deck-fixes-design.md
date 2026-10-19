# HUD command deck and terminal fixes — design

Date: 2026-09-24 · Branch: `feat/hud-deck-fixes` · Verified against `a877be4` (v0.19.2), Claude Code 2.1.281, codex-cli 0.156.1

Three HUD bugs from the 0.8.0 review (H2, H5 and the terminal half of H1), all still present at `a877be4`.

## 1. Problem

- **Listener leak (H2).** `TerminalPanel.mount()` registers three pool listeners (`session-add`, `session-remove`,
  `session-exit`) through `plugin.registerEvent`, which keeps them until the plugin unloads. `unmount()` never removes
  them. Pulse and Term mount a panel on every visit, so each visit leaves three more listeners behind, and a dead panel
  still re-renders its tabs and can build an xterm into detached DOM on `session-remove`.
- **Command deck (H5).** `/reflect` runs `reflect-week.js` with no flag; its default `--context` mode prints a prompt
  meant for a session and exits, so nothing is written. `/remember` and `/pattern` open the memory capture modal preset
  to feedback, so a note meant for `SESSION.md` or `brain/patterns/` becomes a feedback memory. The in-session commands
  (`plugin/commands/remember.md`, `pattern.md`) write elsewhere.
- **Terminal on by default (H1).** `terminalEmbedded: true`, so opening Pulse starts a login shell through node-pty in
  any vault, before the user has asked for a terminal. Kept as is (D8).
- **Found along the way.** A deck `exec` command that succeeds shows the last line of stdout. `reflect-week.js` reports
  `wrote brain/reflections/<week>.md` on stderr, so the notice would read `✓ …: ok` and hide the path.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **The panel owns its pool listeners.** A pure `listen(emitter, handlers)` returns a dispose function; `mount()` keeps it, `unmount()` calls it. Handlers also return early once the panel is unmounted. | A child `Component` per panel; keeping `registerEvent` and also calling `offref`. | Smallest change that ends the leak; the helper is testable without xterm or a DOM. `registerEvent` would still pin every dead panel in the plugin's list until unload. |
| D2 | **`/reflect` becomes `/reflect-week` and runs with `--local`**: one click writes this week's reflection through the provider (reasoner role: `reasoner.model`, ≤ `reasoner.perCallUsd` $0.50 a call, `reasoner.perDayUsd` $5 a day). With provider `none` the notice shows the script's reason. | Copy `/reflect-week` to the clipboard for a session, like `/wrap`. | One click is what the deck is for, and the spend is capped and visible in ⚙ Settings. *Owner's choice, see §6.* |
| D3 | **A successful `exec` shows the last line of stdout, or of stderr when stdout is empty.** | Make `reflect-week.js` print the path on stdout. | Runtime scripts log progress on stderr by convention; the deck should not need every script changed. `/scan` (stdout) is unchanged. |
| D4 | **`/remember` gets its own modal and writer**: one text field; the note is appended to `brain/_index/SESSION.md` as `- <note> #promote` under `## Things to Remember`, or under `## Promote to Memory on Close` when it starts with `feedback:`, `project:` or `pattern:`; `updated:` becomes today. Exactly the rules of `plugin/commands/remember.md`. A note already tagged `#promote` is not tagged twice; newlines become spaces (one bullet). | Copy `/remember` to the clipboard; a new `aos remember` verb. | The deck button is for capture without a session. A CLI verb would add a surface to both plugins for something the in-session command already covers. |
| D5 | **`/pattern` gets its own modal and writer**: area (debugging · architecture · code-quality · testing · other, a picker), title, pattern. It appends `### <title>` + the pattern to `brain/patterns/<area>.md` and bumps `updated:`, or creates the file with the frontmatter from `pattern.md` and adds `- [<Area> Patterns](brain/patterns/<area>.md) — <Area> decision heuristics` under `## Patterns` in `MEMORY.md`. | A fifth `MemoryType`. | Patterns are not memories: they live outside `brain/memory/` and have their own shape. |
| D6 | **One section helper.** `appendUnderHeading(text, heading, entry)`: first heading that starts with `heading` wins, the entry goes at the end of that section before trailing blanks, a missing section is added at the end. `memoryWriter`'s MEMORY.md index insert moves onto it with no behaviour change. | A copy per writer. | Three writers share the rule, and the existing one had no tests. |
| D7 | **Writes go through `app.vault.process`** for existing files (atomic against Obsidian's own editor) and `app.vault.create` for new ones. | `adapter.write`, as `memoryWriter` does. | Review H8. External writers (the Stop hook) are not locked either way; the in-session `/remember` has the same exposure. |
| D8 | **`terminalEmbedded` stays `true` by default** (owner's choice, 2026-09-24): the embedded terminal is part of what Pulse is for. It stays one toggle away in ⚙ Settings and Obsidian's settings pane. | Default `false` for new installs only; a one-time migration turning it off everywhere. | The owner wants it on. The review's concern (a shell starting on Pulse load in any vault) is left to the "ask before running in an unregistered vault" half of H1, which covers every spawn, not only the terminal. |

## 3. What already exists (at `a877be4`)

- `hud/src/ui/TerminalPanel.ts` `mount()` / `unmount()`; `src/data/terminalPool.ts` (`extends Events`, so
  `on()` returns an `EventRef` and `offref()` removes it). Mounted by `PulseTab.renderTerminalSlot()` and `TermTab`.
- `src/data/commandRegistry.ts`: `COMMAND_REGISTRY`, `executeCommand()`, kinds `clipboard | openFile | exec | capture |
  openView`; the clipboard kind already copies the host's form through `invocation()`.
- `src/ui/CaptureModal.ts`, `src/data/memoryWriter.ts` (`appendToMemoryIndex`, `deriveTitle`, untested).
- `brain/scripts/sdk/reflect-week.js`: `--local` → `localProvider('reason:reflect-week', { role: 'reasoner' })`, logs
  on stderr, exits 1 with `PROVIDER_NONE`'s message when there is no provider.
- HUD tests: `node:test` + tsx over `src/**/*.test.ts`, Obsidian types only (`import type`), fakes for the rest.

## 4. Design

- `src/data/listen.ts` (new, tested): `listen(emitter, handlers) → dispose`, structural `{ on, offref }`, idempotent.
- `src/data/mdSections.ts` (new, tested): `appendUnderHeading`, `setFrontmatterDate(text, key, date)`.
- `src/data/sessionNotes.ts` (new, tested): `rememberTarget(note)` and `appendRemember(text, note, today)`.
- `src/data/patternNotes.ts` (new, tested): `PATTERN_AREAS`, `areaTitle`, `newPatternFile`, `appendPattern`,
  `patternIndexEntry`.
- `src/ui/RememberModal.ts`, `src/ui/PatternModal.ts` (new): thin Obsidian modals over the writers, with the same
  classes as `CaptureModal`.
- `commandRegistry.ts`: kinds `remember` and `pattern`; `/reflect` → `/reflect-week` with `--local`; the stderr
  fallback of D3.
- `TerminalPanel.ts`: D1.
- `CHANGELOG.md` (Fixed, Changed), `docs/plugin-smoke.md` (a check per deck button, and the listener count after tab
  switches).

## 5. Host parity

1. **Entry point.** HUD only: the Pulse command deck and ⌘K, the same on every host. No `plugin/` source changes, so
   `codex-plugin/` is unchanged.
2. **Hooks.** None added or changed; Codex users re-trust nothing.
3. **Model calls.** Only `/reflect-week`, through `reflect-week.js --local` → `sdk/lib/provider.js`. Claude:
   `reasoner.model`; Codex only: the provider resolves ollama → codex with `reasoner.codexModel` (null = the user's
   Codex default); provider `none`: the notice shows `no model provider (…)`.
4. **Session data.** None read. `SESSION.md` is written, and `/wrap` promotes its `#promote` lines on either host.
5. **MCP.** No new tool.
6. **Degradation.** The notice carries the reason; nothing fails silently.
7. **Docs.** `docs/plugin-smoke.md` items (HUD, host-neutral). The README's commands table is unaffected.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Pulse deck or ⌘K | writers in the HUD; `/reflect-week` → provider → Claude reasoner | `✗ /reflect-week: no model provider (…)` |
| Codex only (plugin · direct) | same | same; the provider picks Ollama or Codex | same |
| Both | same | same; the reasoner resolves to Claude | same |

## 6. Owner's choices

Confirmed with the owner on 2026-09-24 through the options picker: D2, one click with `--local` (rejected: copy for a
session); D8, the terminal stays on by default (rejected: off for new installs only, off everywhere).

## 7. Out of scope

The rest of P6: asking before running in an unregistered vault (the other half of H1), Obsidian theme variables and a
light theme, keyboard access, fewer timers, and a graph that scales. A hint in Pulse when the terminal is off.
