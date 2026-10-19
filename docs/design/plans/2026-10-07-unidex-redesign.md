# UniDeX redesign — plan

Spec: `docs/design/specs/2026-10-07-unidex-redesign-design.md`. Three stacked PRs, merged to `main` in order
(D12). Then release 1.1.0. Each PR passes the app checks: `typecheck`, `test:unit`, `check:compat`, `test:e2e`. It
also passes the root `npm test`, `lint` and `typecheck`, and `npm run gate`.

## PR 1 — theme (`feat/unidex-theme`)

The current layout, recolored in the UniDeX tokens, follows macOS light and dark.

- [x] **T1 Tokens.**
  - Rewrite the `.aos-root` block in `hud/styles.css` as `--udx-*`, with a value for `.theme-light` and one for `.theme-dark` (spec §4.2).
  - Alias `--aos-*` to the new names. In `app/obsidian-compat/src/base.css`, alias `--compat-*` and the two Obsidian vars.
  - Point `host.css` and the status bar at the tokens.
  - Have `gen:tokens` emit both themes, then run `npm run gen:tokens`.
- [x] **T2 Remove raw colors.**
  - `styles.css`: the 42 hex and about 66 `rgba()` outside the block.
  - `base.css` (15), `host.css` (5), and `noteEditor.ts` and `jobTerminal.ts` (5 each).
  - Remove the scanline overlay.
- [x] **T3 Theme engine.**
  - A System/Light/Dark setting in `appSettingTab.ts`, saved in the app settings store.
  - New channels `theme:state` and `theme:set`, with an event, wired through `shared/ipc.ts`, `preload/index.ts`, `main/ipc/trust.ts`, `schemas.ts` and `main/policy/`.
  - Main sets `nativeTheme.themeSource`. Window and popover `backgroundColor` follow `nativeTheme`.
  - The page swaps the `<body>` class and `color-scheme`. The rail foot gets a toggle.
- [x] **T4 Fonts.**
  - Inter and JetBrains Mono woff2, plus `OFL.txt`, under `app/src/renderer/fonts/`; `@font-face` in `base.css`.
  - `build.mjs` copies them. Turn on tabular figures. Add a `SECURITY.md` line.
- [x] **T5 xterm and charts.**
  - Light and dark ANSI sets from the tokens, swapped live (`TermTab`, `ui/TerminalPanel.ts`, the wizard's `jobTerminal.ts`).
  - The chart palette for the SYSTEM drawer.
- [ ] **Tests.**
  - `tokens.test.ts`: new locks, plus a 4.5:1 contrast check for each text tone in both themes.
  - Unit tests for the theme setting and its policy.
  - `e2e/theme.spec.ts`: follows the system, the override survives a restart, the Codex-only vault renders.
  - `sandbox.spec.ts`: the new `window.aos` line and a refusal case.
  - `docs/app-smoke.md` items with their `COVERAGE.md` rows. `CHANGELOG` gets an Added entry.

## PR 2 — shell, in two parts

PR 1 merged first (#82), so PR 2 builds on `main`. It is split for review:

- **2a (`feat/unidex-shell`):** S1, S5 and S7, with the type and shape pass of S6 and the bracket headings gone.
- **2b:** S2–S4, the list panes. It changes how Notifications and Proposals behave, so its specs are rewritten.


- [x] **S1 One rail.**
  - Lucide icons replace the Unicode glyphs (they must exist in compat `setIcon`). The mark at the top opens Home.
  - Add Quick Capture. Theme and settings go at the foot. The active tab is an inverted tile, and badges use tone colors.
  - Hide `.aos-host-ribbon` and remove `.aos-wb-topbar`.
- [ ] **S2 Primitives.** (2b ships the split layout `.aos-split`; the shared `ListPane` comes with S4.) In `hud/src/ui/`:
  - `ListPane.ts`: header, action, search, list, selection.
  - `PageHeader.ts`.
  - `Pill.ts`: tone and label, used everywhere.
  - Button roles: primary (inverted), secondary and quiet.
- [x] **S3 Notifications.** An inbox in the pane and the reading pane in the workspace, replacing inline expand. Arrow keys move through the list. Mark read/unread, archive, ▲▼ and Deep dive stay.
- [x] **S4 Panes for the other list tabs.** (Proposals moves to `.aos-split`. Runs and Memory already open details in the right drawer, Files opens notes in tabs, and Spaces was already split: they keep that.) Proposals, Runs (inspector in the workspace), Memory, Files (tree), Spaces (already split) and the Pulse sections.
- [x] **S5 Chat as Home.**
  - The default tab becomes `chat`. The composer is at the bottom with host and workspace chips.
  - Timeline rows become steps, and the status line sits under the composer. The provider `none` hint stays.
  - Terminal is one rail click away.
- [ ] **S6 Restyle everything else.**
  - **Pulse:** a KPI strip, Needs you, a System grid, a "Triggers today" timeline and table, Fix queue and the auto-promoted trail.
  - **Agent Teams:** gate cards with budget chips, plus the board, roster, manage and interact panes.
  - **Tables and editors:** Routines (with its editor), To-do, Skills and Agents.
  - **Modals:** Capture, Remember, Pattern, Anchor, Confirm, Omni and QuickOpen.
  - **Elsewhere:** toasts, the settings window, the wizard, the tray popover (`SidebarHUD`) and both inspectors.
- [x] **S7 Chrome.** A 24 px status footer, pane tabs as a slim strip, and the right drawer restyled.
- [ ] **Tests.**
  - `shell.spec.ts`: rail glyphs become aria-labels. Update the notifications, proposals and runs specs.
  - `variants.spec.ts`: Codex-only Home.
  - Run `check:compat` and `npm run screens`. `CHANGELOG` gets a Changed entry.

## PR 3 — brand (`feat/unidex-brand`, stacked on PR 2)

- [ ] **B1 Display strings.**
  - `app/src/shared/brand.ts` and `hud/src/brand.ts`, with an equality test.
  - Every user-facing string: titles, About and the menus (from `productName`), the tray tooltip, the wizard, the settings tabs ("App", "Runtime"), toasts, the "UniDeX: … refused" prefix and the doctor row label.
- [ ] **B2 `productName` becomes `UniDeX`.**
  - Change it in `app/package.json` and `electron-builder.yml`.
  - Update the expectations in `verify-dist.mjs`, `smoke-packaged.mjs` and the release scripts.
  - Keep `artifactName`, the userData literal and `appId` (D1, D2).
- [ ] **B3 The mark.**
  - The Line UDX in `app/build/icon.svg`, rendered with `make-icon.cjs`.
  - Tray `trayTemplate.png` and `@2x`, set as a template image.
  - An in-app `Mark` component.
- [ ] **B4 Docs.**
  - The README name and `banner.svg`, screenshots (light, plus one dark), `app/README.md`, `docs/install.md` and `docs/app-smoke.md`.
  - `CHANGELOG` **Upgrading**: "The app is now called UniDeX. (Measured at release: the update renames the file to UniDeX.app and does not reopen it once; the 1.1.0 notes say so.) An updated install keeps its file name, AgenticOS Workbench.app. Rename it in Finder if you like; nothing depends on it."
- [ ] **B5 Packaging.**
  - `dist:test` and `smoke:packaged`.
  - A real update from 1.0.1 to a 1.1.0 test build: it relaunches, the menu reads UniDeX and the data is intact (acceptance §8).

## Release

Release 1.1.0 by the skill's step 9, after PR 3 merges and §8 passes. If §8 shows Squirrel renaming or breaking the
bundle, fall back to keeping `productName` and setting `CFBundleDisplayName` to UniDeX through `extendInfo`. That also
shows UniDeX in the Dock and menu bar.

## File structure

| Path | Change | PR |
|---|---|---|
| `hud/styles.css` | Token block in two themes; raw colors out; every view restyled | 1, 2 |
| `hud/scripts/gen-tokens.mjs`, `src/ui/tokens.ts`, `tokens.test.ts` | Both themes; contrast test | 1 |
| `app/obsidian-compat/src/base.css`, `app/src/renderer/host.css`, `index.html` | Aliases, fonts, body theme class | 1 |
| `app/src/renderer/fonts/*` | Inter, JetBrains Mono, `OFL.txt` | 1 |
| `app/src/{shared/ipc.ts,preload/index.ts,main/ipc/*,main/policy/*}` | `app:theme:set` and its event | 1 |
| `app/src/main/index.ts`, `appSettingTab.ts` | `nativeTheme`, background color, theme setting | 1 |
| `hud/src/views/*.ts`, `src/ui/{ListPane,PageHeader,Pill}.ts` | Rail, panes, headers, pills | 2 |
| `hud/src/views/WorkbenchView.ts`, `main.ts`, `app/src/renderer/boot.ts` | One rail, Home = chat, ribbon hidden | 2 |
| `app/src/shared/brand.ts`, `hud/src/brand.ts` | Brand constants | 3 |
| `app/package.json`, `electron-builder.yml`, `scripts/{verify-dist,smoke-packaged}.mjs` | `productName` | 3 |
| `app/build/icon.svg`, tray template PNGs, `docs/assets/banner.svg`, `docs/assets/screens/*` | Mark and art | 3 |
| `app/tests/e2e/*.spec.ts`, `COVERAGE.md`, `docs/app-smoke.md`, `SECURITY.md`, `CHANGELOG.md`, READMEs | Checks and docs | 1–3 |

## Risks

- **Squirrel and `productName` (D2).** Proven by §8 before the tag; the fallback is above.
- **Text assertions.** The e2e suite has about 675. Notifications and proposals change behaviour (inline expand becomes a reading pane), so their specs are rewritten, not patched.
- **Compat gaps.** Lucide icon names and any new DOM helper must pass `check:compat`. Add them to `app/obsidian-compat/src` rather than work around them.
- **Contrast.** The test fails the build if a tone or a text token drops under 4.5:1 in either theme.
