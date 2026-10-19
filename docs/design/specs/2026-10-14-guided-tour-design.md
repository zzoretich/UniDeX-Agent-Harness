# UniDeX 2.0, track C: a click-by-click walkthrough and a what's-new for every update — design

**Date:** 2026-10-14
**Status:** approved 2026-10-14 as written. *(user)* rows are the owner's answers from the decision interview; the rest are proposed technical decisions.
**Base:** `main` at `b63e14c` (1.9.0 plus the §8 record). The HUD (`hud/src`), the app's renderer boot and menu, `tools/changelog.js`, the e2e harness.
**Plan:** `docs/design/plans/2026-10-14-unidex-2-0.md` (PRs 8–10). Sibling specs: `2026-10-14-local-first-design.md` (A), `2026-10-14-install-and-import-design.md` (B). Code comments cite `tour C<n>`.

---

## 1. Problem (verified at b63e14c)

1. **No onboarding.** Grepping for tour, onboard, welcome, what's new, first run and coach finds only the setup wizard. Sixteen rail tabs, five Brain modes, the Code deck, the palette and the capture modal are learned by trial.
2. **The one-time note is wrong for new users.** `WhatChangedModal`'s four bullets explain the move off Obsidian (`app/src/renderer/setup/attach.ts:11-20`), and brand-new installs see it right after the wizard (`app/tests/e2e/setup.spec.ts:141-156`).
3. **Nothing records the last version run.** The updater keeps only the incoming version (`app/src/main/updater.ts:134`); `hud-host.json` is overwritten at every start; nothing reads the CHANGELOG at runtime, and the CSP forbids fetching it.
4. **Explanations drift from the product.** Nothing ties a shipped change to its explanation; a 1.9.0 sweep found 21 places where the docs and the code disagree.

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| C1 | *(user)* **A spotlight tour plus a Getting Started checklist.** The tour dims the app, highlights the real control, explains it, and (where it says "click") waits for the user's click; the checklist persists in the rail foot until done; both replay from Help. | Tour only. Checklist only. |
| C2 | *(user)* **What's new: a card with "Show me".** On the first launch after an update, a "What's new in x.y" card lists each change since the last version this machine ran; an entry with steps has "Show me", which runs them. Help ▸ What's New keeps the history. | Auto-running the tour. Notes only. |
| C3 | *(user)* **CI-enforced upkeep.** Every Added/Changed bullet under `[Unreleased]` names a tour step or chapter, or says why it has none; unknown ids fail; every anchor resolves in e2e. | A skill reminder. A release-time pass. |
| C4 | **The engine lives in the HUD** (`hud/src/tour/`): it navigates with `WorkbenchView.open()` (`WorkbenchView.ts:462-476`), anchors on the e2e-stable `data-tab`, `data-area`, `data-mode`, `data-action` attributes, and keeps its state in the HUD's settings (the `pulseSeenAt` precedent, `settingsDefaults.ts:63-67`): no IPC, no write surface, `sandbox.spec.ts` untouched. | A renderer-side engine. A new bridge call. |
| C5 | **Content is data:** `tour/steps.json` (chapters → steps `{id, tab, mode?, pane?, anchor, title, body, advance: click\|next, when?, since}`) and `tour/whatsnew.json` (`{version, entries: [{id, title, body, steps[]}]}`), so `tools/` (CommonJS) can check them. `when` names a predicate the HUD defines (`hasHost:claude`, `chatAvailable`, `codexOnly`…); `{host}` in text becomes the user's host. | Steps in TypeScript. |
| C6 | **A chapter for every surface** (each rail tab, each Brain mode, the Code deck, Settings, the status bar, capture and search, Help) covering every main control. First launch runs the **core tour**, about ten steps (rail, Pulse, Sessions, Code, Brain, Spaces, Routines, Chief of Staff, ⌘K, Help), then opens the checklist. A tab's first visit offers its chapter once, as a chip, not a modal. | One sixty-step tour. |
| C7 | **Behaviour:** the overlay passes pointer events only through the cutout; Esc skips the chapter; ← → move; focus moves to the popover, which is a live region; `prefers-reduced-motion` drops the transitions; a step whose anchor is missing after the route settles (2 s) is skipped and logged. The popover is not a compat `Modal`, so a step never opens while a modal holds focus (`app/obsidian-compat/src/modal.ts:39-50`). | Blocking the step. |
| C8 | **Variant-aware:** a step whose `when` fails is skipped, so Codex-only, no-host and Sessions-hidden installs see only what they have; e2e proves every step resolves or is gated in the default and Codex-only variants. | One tour for everyone. |
| C9 | **The checklist** ("Getting started n/m", rail foot, `data-action="checklist"`) opens a drawer of tasks: the chapters, plus actions detected from runtime caches (imported memories reviewed, a session resumed, a routine created, the CoS's first sitrep read). Dismissable; Help reopens it. | Manual ticking. |
| C10 | **Version tracking in the HUD:** `tour.lastSeenVersion` vs `manifest.version` (kept equal to the app by `bump-version`). First run (attach `firstTime`) → core tour. Newer version → What's new for every version since, combined. An existing install reaching 2.0 has no `lastSeenVersion` but is not a first run → What's new in 2.0 plus "Take the full tour". | Reading `hud-host.json`. Release notes from the feed. |
| C11 | **One launch sequence** (`src/ui/launchSequence.ts`) owns every first-launch dialog, one at a time, each remembered: the runtime upgrade (existing) → Go local (local-first A9) → Import (install-import B12) → What's new or the core tour → the checklist. `WhatChangedModal` goes. The e2e harness pre-marks the sequence the way it pre-marks `noted` today, so other specs never meet it. | Each feature opening its own dialog. |
| C12 | **Help everywhere:** a rail action `data-action="help"` (Take the tour · Tour this tab · What's new · Getting started · Docs), the same as commands (the palette, and the native Help menu, which is built from the plugin's commands; `app/src/main/menu.ts:113`). Native menus and the tray cannot be spotlit; their step points at the in-app equivalent. | — |
| C13 | **The CI rule:** a bullet carries `<!-- tour: <id> -->` or `<!-- no-tour: <reason> -->`; rendered notes hide the comment and `changelog.js notes` strips it. `changelog.js check` fails a bullet with neither or with an id absent from `steps.json`; `bump-version` fails when `whatsnew.json` has no entry for the new version. | Markers visible in the release notes. |

## 3. What already exists

`WorkbenchView.open()` and `setTab()`; rail anchors `.aos-wb-railbtn[data-tab]` and `.aos-wb-railact[data-action]`; per-tab anchors used by e2e (`aos-pulse-tile[data-area]`, `aos-brain-mode[data-mode]`, `aos-spc-row`, `aos-ss-*`, `aos-tl-*`); `sessionHosts()` and `chatAvailable()`; the compat `Modal`, `Notice` and drawer; `--udx-*` tokens with light and dark themes; `tools/changelog.js` (`section`, `check`, `notes`, `roll`); the e2e harness (`launchApp`, `openTab`, `noted`) and the visit-every-tab spec (`shell.spec.ts:256-285`).

## 4. Design

**Engine.** `tour/engine.ts` runs a queue of steps: route (`open()`), wait for the anchor (MutationObserver, 2 s), measure, draw. `tour/overlay.ts` draws four dimming rectangles around the anchor (so the cutout stays clickable) and a popover placed by available space, re-measured on resize and scroll. `tour/state.ts` reads and writes the HUD settings keys `tour.{lastSeenVersion, completed[], dismissed[], checklist{}, offered[]}`. Step text is plain text with `**bold**` and `⌘` glyphs, no HTML.

**What's new.** `tour/whatsnew.ts` selects entries newer than `lastSeenVersion` up to `manifest.version`. 2.0's entries: background work on your Mac, the Chief of Staff's models, your imported history, Sessions ▸ History, routine engines, and the tour itself.

**Tests.** Unit: selection logic, predicates, the JSON schema. e2e `tour.spec.ts`: the core tour by clicks, every chapter's anchors in the default and Codex-only variants, the launch sequence order, What's new across a simulated update (the `attach.spec.ts:60-79` pattern). `tools/changelog.test.js` covers the markers. app-smoke items with `COVERAGE.md` rows; `npm run screens` adds one shot of a tour step.

## 5. Host parity

1. **Entry point:** first launch, the Help rail action, commands (palette, native Help menu). No runtime or plugin side.
2. **Hooks:** none.
3. **Model calls:** none.
4. **Session data:** none; checklist detection reads caches only.
5. **MCP:** none.
6. **Degradation:** host-specific steps are gated by `when`; text names the user's host.
7. **Docs:** README "Getting started", `docs/app-smoke.md` items and `COVERAGE.md` rows, a CONTRIBUTING note on the marker rule.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | first launch; Help | the tour with Claude wording | — |
| Codex only (plugin · direct) | same | the tour with Codex wording; Claude-only steps skipped | — |
| Both | same | both hosts named where both apply | — |
| No host | same | host steps replaced by "Add Claude Code or Codex" | — |

## 6. Out of scope

Video or GIF walkthroughs; translations; in-app docs beyond step text (Docs opens the README on GitHub); tours for the native menu and tray themselves; analytics of tour completion (nothing leaves the Mac).
