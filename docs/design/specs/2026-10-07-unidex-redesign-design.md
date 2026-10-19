# UniDeX — design and brand overhaul

**Date:** 2026-10-07
**Status:** proposed design, awaiting approval; on `feat/unidex-redesign`
**Scope:** the macOS app and the Workbench HUD get a new name (UniDeX), a new mark (the Line "UDX"), a monochrome
theme that follows macOS light and dark, and the "Rail" layout (icon rail, list pane, workspace). Every Workbench
feature stays. Phase 2, real Claude Code and Codex sessions in the centre, gets its own spec.

---

## 1. Problem

- **Dark only.** `<body class="theme-dark">` and `color-scheme: dark` are hard-coded, and the window background is
  `#0a0e14` in two places. On a light Mac the app is a black window.
- **A terminal HUD, not a product.** All-mono 12.5 px type, cyan/amber/rose accents, Unicode glyph icons, a scanline
  overlay, `⌜ ⌝` and all-caps headings.
- **Three layers of navigation.** The app's ribbon (3 actions), the HUD's 14-tab rail and pane tabs. List content
  (notifications, proposals, runs) expands inline, so long lists jump.
- **Two token sets.** `--aos-*` and `--compat-*` duplicate each other across three CSS files. `styles.css` also has
  42 hex and about 66 `rgba()` outside its token block.
- **The name.** The owner is renaming the app to UniDeX.

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | **Visible rename only.** UniDeX appears in every user-facing string: titles, menus, About, the tray, the wizard, settings, toasts, the error prefix and the docs. These identifiers stay as they are: the appId `com.zzoretich.agenticos-workbench`, the userData folder `AgenticOS Workbench`, `agenticos://`, the plugin id `agentic-os`, the `agenticos` plugins and MCP names, `aos` and `AOS_*`, `~/AgenticOS`, `AGENTICOS.md`, the launchd labels, the repo and the update feed. | A new bundle id: it breaks auto-update and needs a bridge release. A full rename including the CLI and plugins: every user reinstalls and re-trusts hooks. |
| D2 | **`productName` becomes `UniDeX`.** That covers the Dock, the menu bar, About and the `.app` of new installs. `artifactName` and the userData literal stay. Squirrel.Mac updates in place, so an updated install keeps the Finder name `AgenticOS Workbench.app`. Acceptance §8 proves the update and relaunch before the tag. **Measured at 1.1.0 (§8, 2026-10-07):** Squirrel.Mac moves the bundle to the new name, `UniDeX.app`, and that one update does not relaunch (the relauncher is looked up in the old bundle). Data, bundle id and later updates are unaffected, so the decision stands; the release notes tell users to open UniDeX themselves. | Keeping `productName`: the Dock and menu bar keep the old name, which is half a rebrand. Renaming `artifactName` now: churns the feed and release checks with nothing gained for users. |
| D3 | **Layout B, "Rail".** One 60 px rail: the mark at the top, the 14 tabs, theme and settings at the foot. Then a 300 px list pane and a workspace with a 56 px header. The app ribbon is hidden: Workbench becomes the mark and Quick Capture becomes a rail button. App settings stay at ⌘, and the rail foot. | A, "Paper": one sidebar mixing tabs and chats, so less fits on screen. C, "Ink": a black sidebar fights the light theme. |
| D4 | **A list pane only where the content is a list with a detail.** That is Notifications (inbox and reading pane, replacing inline expand), Proposals, Runs, Spaces (already split), Memory, Files and Pulse sections. Chat gets threads in phase 2. To-do, Routines, Skills, Agents, Agent Teams, Term and Settings use the full width. | A pane on every tab: half of them would be empty. No pane: inline expansion stays. |
| D5 | **Home is Chat.** The default tab changes from `pulse` to `chat`, restyled as a composer-first view with the status line under the composer. Terminal is one rail click away. Real repo sessions are phase 2. | A terminal-first centre: per-host CLI differences land in the main view. Building sessions now: it doubles the work. |
| D6 | **Theme setting: System, Light or Dark (default System).** Main sets `nativeTheme.themeSource`, so the frame, menus, scrollbars and the tray popover follow. The page swaps `theme-light`/`theme-dark` and `color-scheme`. This needs one new pair of channels, `theme:state` and `theme:set` (a zod enum), plus a change event. The window `backgroundColor` follows `shouldUseDarkColors`. | A CSS-only toggle: the native frame and scrollbars disagree with the page. Dark only: the brief asks for both. |
| D7 | **One semantic token set**, `--udx-*`, with a light and a dark value each (§4.2). `--aos-*` and `--compat-*` become aliases until every rule is migrated. `gen:tokens` emits both themes into `tokens.ts` for xterm and the charts. | A CSS-in-TS rewrite of 2,200 lines and every view. |
| D8 | **Six status tones**: success, warning, danger, info, gate (violet: waiting on you) and neutral. Color appears only where it carries state, always with a label, and the tones also differ in lightness. A unit test checks 4.5:1 for each text tone in both themes. | One cyan accent: loses state at a glance. Red and green only: fails for color-blind users. |
| D9 | **Inter for the UI and JetBrains Mono for numbers, code and the terminal**, both OFL, bundled as woff2 (the CSP is `font-src 'self'`), with tabular figures. | A hosted font service: blocked by the CSP and a network call. SF Pro: cannot be bundled. |
| D10 | **The Line mark**: U, D and X drawn in one stroke weight with round ends. The app icon is the white mark on a black squircle. The tray uses a template image, which macOS flips. In the app it sits on a black tile in light and a white tile in dark. | Solid Inter Extra Bold; mono with a block cursor. |
| D11 | **`.aos-*` class names stay.** The e2e suite selects on 365 of them. Brand text assertions read from one constant. | Renaming classes: churn for no user value. |
| D12 | **Three stacked PRs (theme, then shell, then brand), merged in order, then release 1.1.0.** No release is cut from `main` in between; a hotfix branches from `v1.0.1`. | One PR: thousands of lines, unreviewable. 2.0.0: nothing breaks for users. |

## 3. What already exists (verified at `9655401`, v1.0.1)

- **The shell, `app/src/renderer/boot.ts`.** `.aos-host-ribbon` holds Workbench and Quick Capture (`hud/main.ts:86-87`) and ⚙ App settings (`boot.ts:90`). Next to it are the pane tabs and `.aos-host-status` (READ-ONLY/WRITES, ⬆ Runtime, Restart to update).
- **`index.html`.** `<body class="theme-dark">` and the CSP `font-src 'self' data:`.
- **`main/index.ts`.** `backgroundColor: "#0a0e14"` at `:154` and `:297`; the userData literal at `:69`.
- **`electron-builder.yml`.** `appId`, `productName`, `artifactName` and `darkModeSupport: true`.
- **The HUD view, `WorkbenchView.ts`.** The 14 tabs and Settings, `activeTab = "pulse"` (`:60`), the brand span `AGENTIC OS` (`:95`), the rail (`.aos-wb-rail`, `-railtabs`, `-railfoot`), the content area and a right drawer.
- **`ChatTab.ts`.** One thread, `runAsk`/`runClaudeAsk`, logged to `brain/_index/agentic-os-chat.jsonl`, routed claude/local/codex/none. `TermTab.ts` is xterm.
- **Styles.** `base.css` (`--compat-*`, 15 hex), `styles.css` (2,202 lines, `--aos-*` in `.aos-root`) and `host.css` (5 hex).
  - `gen:tokens` writes `src/ui/tokens.ts`, which includes 21 `--aos-term-*` and 7 `--aos-chart-*`.
  - `check:hex` bans raw hex in the HUD's TypeScript, and `tokens.test.ts` locks bg, cyan and rose.
  - No fonts are bundled.
- **Icons.** `app/build/icon.svg` is a gradient tile, rendered by `scripts/make-icon.cjs`. The tray has no image ("◉ …", tooltip "AgenticOS"). The compat `setIcon` uses lucide.
- **Tests that pin the brand.** `shell.spec.ts` (brand text, `productName`, rail glyphs), `setup.spec.ts:38`, `settings-window.spec.ts`, the "AgenticOS app: … refused" assertions, and `verify-dist.mjs`/`smoke-packaged.mjs`. There are no screenshot diffs.

## 4. Design

### 4.1 Shell

```
+------+-----------------+--------------------------------------------------+
| UDX  | Threads      +  | harbor-map > Fix the tide parser tests   (Codex) |
| chat | [ Search  cmdK ]|--------------------------------------------------|
| pulse| harbor-map      |  You . 07:31   [prompt]                          |
| bell2| * Fix the tide  |  Codex . 6 steps  (timeline of tool rows)        |
| ...  |   Offline tiles |  [ 1 file changed  +12 -4   Review  Commit ]     |
| ...  | field-notes     |  [ composer: + Codex v  Local v  repo v     ^ ]  |
| sun ⚙|   ...           |  live . 2 gates . 1 breaking . 1 alert . $21.40  |
+------+-----------------+--------------------------------------------------+
```

- **Rail.** Lucide icons replace the Unicode glyphs, with tooltips and tone-colored count badges. The active tab is an inverted tile.
- **List pane.** A header with an action, search (⌘K opens the existing Omni modal) and the list. The selected row uses `--udx-sel`.
- **Workspace.**
  - A 56 px header holds the title, context pills and one primary button (inverted).
  - Reading views cap at 800 px; tables use the full width.
- **Status bar.** It becomes the status line under the composer. Other tabs get a 24 px footer with the same items.
- **Unchanged.** The right drawer (SYSTEM, inspectors) and the pane tabs, restyled.
- **Removed.** The top bar (its clock and brand), the scanline, the brackets and the all-caps headings.

### 4.2 Tokens

| Token | Light | Dark | | Tone (fg · bg · dot) | Light | Dark |
|---|---|---|---|---|---|---|
| bg | `#FFFFFF` | `#0B0B0B` | | ok | `#15803D · #EAF7EE · #16A34A` | `#5BD98A · #12301D · #34C759` |
| hover / sel | `#F5F5F5 / #F0F0F0` | `#161616 / #1C1C1C` | | warn | `#B45309 · #FDF3E2 · #D97706` | `#F5B74A · #33260F · #F59E0B` |
| line / line-2 | `#EBEBEB / #D9D9D9` | `#222222 / #333333` | | danger | `#C81E1E · #FDECEC · #DC2626` | `#FF7A7A · #3A1414 · #EF4444` |
| text / text-2 / text-3 | `#0D0D0D / #5C5C5C / #6E6E6E` | `#F2F2F2 / #A6A6A6 / #8C8C8C` | | info | `#1D5FD1 · #EAF1FD · #2563EB` | `#78A9FF · #14233D · #3B82F6` |
| inv / inv-text | text / bg | text / bg | | gate | `#6D28D9 · #F2ECFD · #7C3AED` | `#B79CFF · #261B3D · #8B5CF6` |
| radius | 8 control · 12 card · 14 composer · 999 pill | same | | off | `#5C5C5C · #F1F1F1 · #A3A3A3` | `#A6A6A6 · #1E1E1E · #6B6B6B` |

- **Borders and shadows.** Lines are 1 px hairlines. Only popovers and modals cast a shadow.
- **Type sizes.** Body is 14 px, chat 15 px, UI 13 px, captions 12 px.
- **xterm.** A light and a dark ANSI-16 set, each at 4.5:1 on its background.
- **Charts** (disk donut, burndown, sparkline). They use the neutral ramp, plus a tone only for state.

### 4.3 Where the tones go

| Surface | ok | warn | danger | info | gate | off |
|---|---|---|---|---|---|---|
| Notifications | — | alert | breaking | edition | — | info |
| Health LEDs, fix queue | ok | warn, stale | error | — | — | off |
| Routines (triggers) | ran, exit 0 | late, near cap | failed | running | — | scheduled, never, off |
| Agent Teams | shipped | budget near cap | blocked | working | discuss/plan/ship gate | paused |
| Proposals, flags | approved | — | — | — | pending | rejected, deferred |
| Status line | — | alert, warn | breaking | live | gates, flags | spend |

### 4.4 Brand

- **One constant per tree.** `app/src/shared/brand.ts` holds `{ name: "UniDeX", mark: "UDX" }`, with a copy in `hud/src/brand.ts`. A test keeps the two equal.
- **Wizard.** "Set up UniDeX".
- **Settings window.** The tabs become "App" and "Runtime" (was "Agentic OS"). The error prefix becomes "UniDeX: … refused".
- **Copy rule.** "UniDeX" names the app and product. "AgenticOS" appears only inside identifiers set in code: the `agenticos` plugin, `aos`, `~/AgenticOS`.
- **Assets.**
  - `icon.svg` becomes the Line mark.
  - The tray gets `trayTemplate.png` at @1x/@2x.
  - New `docs/assets/banner.svg`.
  - README screenshots regenerated with `npm run screens`: light, plus one dark.

## 5. Host parity

1. **Entry point.** No new command, skill or verb: both hosts open the same app. Host chips list only ready, enabled hosts.
2. **Hooks.** None.
3. **Model calls.** No new calls. Chat keeps today's routing: headless Claude (capped) when logged in, else the `ask.js` reasoner (falls back to Codex). With provider `none`, the setup hint takes the composer's place.
4. **Session data.** None. The HUD reads the same caches.
5. **MCP.** None.
6. **Degradation.** On a Codex-only vault, everything renders (`variants.spec.ts`), and Claude-only buttons keep today's disabled state.
7. **Docs.** README, `app/README.md`, `docs/install.md` (the app name), and `docs/app-smoke.md` items for theme follow/override and each tab in both themes, with their `COVERAGE.md` rows. `SECURITY.md` gets the theme channel (no new write or spawn).

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Open UniDeX; Chat is Home | Chat → headless Claude (capped) | provider `none` → the setup hint |
| Codex only (plugin · direct) | Open UniDeX; Chat is Home | Chat → `ask.js` reasoner on Codex | Claude-only buttons disabled, as today |
| Both | Same | Claude when logged in, else Codex | — |

No cell differs from today's behaviour, so there is no gap.

## 6. Out of scope

- **Phase 2:** agent sessions in the centre (threads per workspace, tool rows, diffs, commit) through `lib/headless.js` on both hosts. It gets its own spec.
- **Renames D1 keeps:** the bundle id, CLI, plugins, MCP names, repo and vault.
- **Polish:** macOS 26 icon appearances (`.icon`), a DMG background, the proposal HTML pages and the cost report.
- **Later features:** resizable panes, accent colors and a density setting.
