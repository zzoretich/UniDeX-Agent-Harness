# Rail sections, the Code tab, and a Code page that fits — design

**Status:** approved 2026-10-09 (the user answered Q1–Q4, each as recommended, and approved the build).
**Base:** `main` at 06a7327 (1.5.0). HUD only (`hud/`), its e2e tests and docs; no runtime, plugin or app-main change.

## Problem

1. **The rail is one flat list** of 14 icons in the order they were added. The user wants three sections, divided by a
   light line, in a set order, with the foot (theme, App settings, Settings) unchanged at the bottom.
2. **Pulse should stand out:** its icon neon blue in the dark theme and navy in the light one.
3. **Term should be called Code.**
4. **The Code page scrolls**, by 50px at every window size. Measured in the e2e harness at 06a7327: Term's panel mounts
   on the content host itself, so one element is `.aos-wb-content.aos-term.aos-term-fullpane.aos-term-deck`:
   content-box, `height: 100% !important` (544px in a 960×600 window), plus the content area's 20/28/28px padding and
   1px borders = 594px. `.aos-wb-body` and `.view-content` both scroll 594 > 544; the composer's foot (596) and the
   list's "n open" foot sit under the window's edge. The same 50px at 1480×920 and 1280×800, both themes.
5. **The composer is small:** its box is 96px tall, the text area 45px at 13.5px.

## Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | **Three sections.** ① Notifications · Pulse · Code · Chat. ② To-Do · Spaces · Files · Routines · Proposals. ③ Memory · Agent Teams · Agents · Skills · Runs. Foot unchanged: ☾/☀ · App settings · ⚙ Settings. Mapping of the user's names: Chat = `chat` (💬, tooltip "Sessions"), WorkSpacex = `spaces`, Brain = `memory` (brain icon), Sessions = `runs` (list icon) (Q1). Without a provider the `chat` button is still left out, so ① has three. | — |
| D2 | **Files** (not in the user's list) goes in ② right after Spaces (Q2). | Dropping it from the rail: ⌘O and ⌘K still reach files, but a tab nobody asked to lose disappears. |
| D3 | **Tooltips keep their names** except Term → Code ("the same design, reordered"; Q3). | Renaming Sessions/Runs/Memory/Spaces to the user's words without asking. |
| D4 | **Home stays Pulse:** the mark and app launch open Pulse, though Notifications now heads the rail. | Home = the first button: launch would open Notifications. |
| D5 | **The divider** is `div.aos-wb-railsep` (`role="separator"`) between sections inside the scrolling list, 36px wide like the head and foot rules. New token `--udx-rail-line`: dark `rgba(255,255,255,0.24)` (a light white line, ≈2:1 on `#0b0b0b`), light `#d4d4d4` (white would vanish on white). The head and foot rules take the same token, so the rail has one line. | `--udx-line`: `#242424` is 1.3:1 on the dark rail, which is why the user asks for a *light* line. Leaving the head/foot rules on the old token: two different lines in one rail. |
| D6 | **Pulse's colour.** New tokens `--udx-pulse` (dark `#00B3FF` neon, 8.3:1 on the rail; light `#1E3A8A` navy, 10.4:1) at rest and on hover, and `--udx-pulse-on-inv` for the selected chip, which is inverted (near-white in dark, near-black in light), where the same blue drops to ~2:1. On the chip the colours swap: navy on dark's light chip (9.3:1), neon on light's dark chip (8.2:1). The badge keeps its tones. | `#1F51FF` (the textbook neon blue): 3.4:1 on the dark rail. Grey when selected: Pulse is Home, so the user would rarely see the colour. A glow: UniDeX is flat. |
| D7 | **Term → Code** wherever the page is named: the rail tooltip and screen-reader label, the list pane's title, Pulse's live-row subtitle ("· Code"), the Proposals and Settings tooltips, Scratch's README and agent note. The tab id stays `term`, so `agenticos://workbench?tab=term`, the palette ids (`term-next`, …) and every test selector keep working. A single session is still "a terminal" (⌘T New terminal, ⇧⌘W Close terminal). The `terminal` icon stays. | Renaming the id: breaks saved links for no visible gain. A `code` icon: the user asked for the same design. |
| D8 | **Code fills the pane** edge to edge, like Sessions (`.aos-ss`) and the Pulse cockpit: `.aos-wb-content.aos-term-deck { box-sizing: border-box; padding: 0; border: 0; border-radius: 0; overflow: hidden }`. Then only the terminal (xterm's scrollback), the list's groups and the composer's text (past its max height) scroll; the page never does. | Keeping the 20/28px gutter with `border-box`: it fits, but draws the deck as a framed box inset in the pane, a leftover of the generic content padding that Sessions and Pulse already drop. |
| D9 | **The composer doubles:** box 96 → ~192px. The text area's min-height goes 44 → 141px (`rows` 2 → 6: six lines, then its text scrolls), the drag limit (max-height) 200 → 320px, font 13.5 → 15px (line-height 1.5). The bar (Snippets, hint, send) is unchanged. At 960×600 the terminal keeps ~285px (~15 rows) (Q4). | Doubling only the text area (box 96 → ~145px, 1.5×). |

**The user's answers** (2026-10-09): Q1 "Sessions" is Runs, and "Chat" is the 💬 tab. Q2 Files goes in ② after
Spaces. Q3 tooltips keep today's names; only Term becomes Code. Q4 the whole composer box doubles.

## What already exists (06a7327)

- `hud/src/views/WorkbenchView.ts:38` `RAIL` (14 tabs) rendered into `.aos-wb-railtabs` (scrolls);
  `.aos-wb-railfoot` holds theme, App settings, Settings; labels are visually hidden (`styles.css:1345`), tooltips show.
  `WORKBENCH_TAB_IDS` (deep links) is derived from `RAIL`.
- Tokens: `--udx-*` in `body.theme-light` / `body.theme-dark` (`styles.css:8`, `:82`); `npm run gen:tokens` writes
  `src/ui/tokens.ts`, and the themes must define the same keys.
- No-scroll precedents: `.aos-wb-content:has(> .aos-ss)` (`styles.css:2582`), `:has(> .aos-pulse-cockpit)` (`:3033`).
- Composer: `src/ui/TermComposer.ts:41` (`rows: "2"`), `styles.css:2997–3016`.
- e2e pins on the order: `RAIL_ORDER` (`app/tests/e2e/harness.ts:339`), `shell.spec` "rail: the tabs in order…",
  `pulse.spec` "Pulse heads the rail…", `variants.spec` "Pulse heads the rail… Sessions comes next", `files.spec`
  "Files sits second…". Everything else selects by `data-tab` id.

## Design

| File | Change |
|---|---|
| `hud/src/views/WorkbenchView.ts` | `RAIL` → `RAIL_SECTIONS: RailTab[][]`; a separator between sections; `WORKBENCH_TAB_IDS` flattens it; label "Code" |
| `hud/styles.css` | the three tokens in both themes; `.aos-wb-railsep`; head/foot rules on `--udx-rail-line`; Pulse rules (rest, hover, `.is-active`); D8's rule; D9's sizes |
| `hud/src/ui/tokens.ts` | regenerated (`npm run gen:tokens`) |
| `src/ui/TerminalPanel.ts`, `src/ui/TermComposer.ts` | list title "Code"; `rows: "6"` |
| `src/views/pulse/model.ts`, `ProposalsTab.ts`, `SettingsTab.ts`, `src/data/terminalLaunch.ts` | "Term" → "Code" in text the user reads |
| `app/tests/e2e/{harness,shell,pulse,variants,files}.spec.ts` | the new order; two separators at the section boundaries; Pulse's colour per theme, at rest and selected |
| `app/tests/e2e/term-deck.spec.ts` | **new:** no page scroll at 1480×920 and 960×600, composer fully inside the window (fails on `main` by 50px); a wheel over the terminal scrolls xterm, not the page; composer box ≥ 2× 96px with 15px text |
| `docs/app-smoke.md`, `app/tests/e2e/COVERAGE.md` | rail items by section ("Files second", "fourteen tabs", …); Term → Code; a Code-fits item and its row |
| `app/README.md`, `SECURITY.md` | "Term tab" → "Code tab" |
| `CHANGELOG.md` `[Unreleased]` | Changed: rail sections and order, Term is Code, Pulse colour, bigger composer. Fixed: the Code page scrolled by 50px |
| `docs/assets/screens/*.png` | `cd app && npm run screens` (every shot shows the rail) |

Historical specs, plans and released CHANGELOG sections keep "Term".

## Host parity

1. **Entry point:** the app's rail; no command, skill or `aos` verb. 2. **Hooks:** none. 3. **Model calls:** none.
4. **Session data:** none read. 5. **MCP:** none. 6. **Degradation:** none; the rail and the Code page draw the same on
a Codex-only vault (`variants.spec` already covers the rail there; the `chat` button follows the provider as today).
7. **Docs:** app-smoke + COVERAGE as above; nothing in `plugin/`, so `codex-plugin/` is untouched.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | the Workbench rail | HUD render only | n/a |
| Codex only (plugin · direct) | the Workbench rail | HUD render only | n/a |
| Both | the Workbench rail | HUD render only | n/a |

## Verification

`npm run gate -- --require-private`, `npm test`, `npm run lint && npm run lint:sh && npm run typecheck`,
`node tools/changelog.js check current`; `cd app && npm run typecheck && npm run test:unit && npm run check:compat &&
npm run test:e2e`; `npm run screens`. Packaging and the payload don't change, so no `dist:test`.

## Out of scope

Renaming the `term` id; other tooltip renames (Q3: they keep their names); the composer's behaviour; a release (1.5.1 or 1.6.0
when asked).
