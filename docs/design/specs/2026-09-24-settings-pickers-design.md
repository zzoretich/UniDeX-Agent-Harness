# Settings with no text boxes — design

Date: 2026-09-24 · Branch: `feat/settings-pickers` · Verified against `798fe2e` (v0.18.0 + #46), Claude Code 2.1.281, codex-cli 0.156.1

The owner's ask after v0.18.0: every setting in the Workbench is a toggle, a button or an options picker — no text
boxes. Today the Settings tab (spec `2026-09-24-settings-tab`) renders numbers, strings, models, lists and objects as
text fields, and the plugin's own rows (shared with Obsidian's settings pane) are text fields for paths, numbers and
the shell.

## 1. Problem

- 55 of the 78 settable system rows are free text (every cap and budget, every model, `dailyNote.layout`, the lists,
  the roster object), and so are 8 of the plugin's 11 rows. Typing invites typos the CLI then refuses, and a model or
  path must be known by heart.
- Read-only install rows render as disabled text boxes (`SettingsTab.renderRow`).

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **No text input anywhere** in the Settings tab or the shared plugin rows (so Obsidian's pane too). Controls: toggle (bool), options picker (enum, and every number, string and model with `choices`), toggle chips (a list or a comma string with `pick: "many"`), button (everything else). | Keep text for "advanced" rows. | The owner's rule, applied without exceptions. |
| D2 | **Choices live in the runtime schema** (`choices` on the entry; `aos config list --json` passes them). Numbers get presets per key; models get one list per host — Claude: the `haiku`/`sonnet`/`opus` aliases and pinned ids; Codex: the keys of `sdk/lib/codex-pricing.js` `MODELS`, plus "host default" (`null`) where nullable. A `unit` (usd, min, h, days, s, ms, files, notes, tokens, lines, px) labels them ("$0.50", "45 min", "24 h"). | Presets in the HUD. | One owner, as for every other field (settings-tab D2); `aos config` users see the same presets in `--json`. |
| D3 | **The current value is always in its picker**, marked "(custom)" when it is not a preset, so a value set by hand, by `aos config set` or by a session is shown truly and never overwritten by opening the tab. A value outside the presets is set with `aos config set` (the row's tooltip says so) or by asking a session. | Snap to the nearest preset. | Silent rewrites of a user's value are the trap phase 1 removed. |
| D4 | **Lists are chips; the rest are buttons.** `recallRoots` → chips over known vault folders (+ current values). `routines.tools` → chips over read tools and writing tools, stored as the comma string it is. `quickLinks`, `roster.orchestrators`, `routines.externalLabels` → "Edit brain/config.json" (opens the file in the default app). `skills.exclude` / `agents.exclude` → "Manage in Skills" / "Manage in Agents" (their tabs' share/unshare). Schema field `editIn: file \| skills \| agents`. | A JSON editor modal. | A modal with a text area is still a text box; these lists are rarely edited and already have a home. |
| D5 | **Read-only install rows show their value as text** (a label, with the path on hover), not a disabled input. | — | A disabled text box is still a text box. |
| D6 | **Drift test:** every settable entry that is not bool/enum has `choices` or `editIn`; every default is one of its choices; every choice passes its entry's validation. | — | A new key cannot ship as a text field by accident. |
| D7 | **The plugin's own rows become pickers**: poll interval (100–5000 ms presets); vault root (this vault · the agenticos.json vault · current); Claude config dir (auto · `$CLAUDE_CONFIG_DIR` · agenticos.json value · `~/.claude` · current); node binary (auto · the resolver's candidates that exist · current) + Probe; shell (system default · `/etc/shells`); working directory (vault root · home · current); font size 10–20; scrollback presets. | Native file dialogs. | Obsidian has no public folder-picker API; the candidates cover real setups, and a custom value is still settable. |
| D8 | **Confirmations are unchanged** (settings-tab D6): picking a higher cap preset asks, as typing did. | — | Same guard, new control. |
| D9 | **Numbers get both a picker and − / + buttons** (owner's choice, 2026-09-24): − and + step to the next lower or higher preset (from a custom value, to the nearest preset on that side) and are disabled at the ends. The plugin's number rows get them too. | Picker only; steppers only. | The owner picked both: one click to jump, one click to nudge. |

## 3. What already exists (at `798fe2e`)

- `brain/scripts/lib/settings-schema.js` (+ `notifications.*` from #46), `cli/config-cmd.js` `row()`;
  `brain/scripts/sdk/lib/codex-pricing.js` `MODELS` (pure, no requires).
- HUD: `src/data/settingsModel.ts` (`parseInput`, `inputText`, `valueArg`), `src/views/SettingsTab.ts` `renderRow`,
  `src/ui/pluginSettingRows.ts` `renderPluginSettings`, `src/data/nodeResolver.ts` `nodeCandidates`.

## 4. Design

**Runtime.** Entries gain `choices`, `unit`, `pick: "many"` and `editIn`; `row()` passes them. Model lists
`CLAUDE_MODELS` and `CODEX_MODELS` (from `codex-pricing.js`) are defined once in the schema.

**HUD model** (`settingsModel.ts`, pure, tested): `pickerOptions(row)` → `[{ value, label }]` with the current value
added as "(custom)" when missing and "host default" for null; `choiceLabel(value, unit)`; `toggleMany(row, value, on)`
→ the new list or comma string (in the choices' order, customs kept); `stepValue(row, ±1)` (D9); `controlFor(row)` → `toggle | picker | chips |
button | text-readonly`. `parseInput` goes (no text entry left).

**HUD views.** `SettingsTab.renderRow` switches on `controlFor`; chips reuse `.aos-st-switch`; the button opens the
file (Electron `shell.openPath`, as `SkillsTab.open`) or switches tabs. `renderPluginSettings` builds its pickers
from pure `pluginChoices()` (tested) and the same `pickerOptions`.

## 5. Host parity

1. **Entry:** unchanged (⚙ Settings, the command, Obsidian's pane; `aos config` everywhere). 2–5. No hooks, model
   calls, session reads or MCP. 6. **Degradation:** a 0.18 runtime sends no `choices`; the tab then shows those rows'
   values as read-only text with "run `aos upgrade` to change it here" (still no text box). Claude-model rows list
   Claude models and Codex rows Codex models; host dimming is unchanged. 7. **Docs:** CHANGELOG, `docs/plugin-smoke.md`.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | ⚙ Settings · Obsidian's pane | `aos config set` from a picker, chip or button | Codex rows dimmed (settings-tab D8) |
| Codex only (plugin · direct) | the same | the same | Claude rows dimmed |
| Both | the same | the same | — |

## 6. Testing

- `settings-schema.test.js`: D6 (choices or editIn on every non-bool/enum settable; defaults among choices; choices
  validate; units known); Codex choices equal `codex-pricing` `MODELS` keys.
- `config-cmd.test.js`: `list --json` carries `choices`, `unit`, `pick`, `editIn`.
- `settingsModel.test.ts`: `pickerOptions` (custom current, null default, labels per unit), `toggleMany` (list and comma
  string, order, customs kept), `controlFor` for every type, the 0.18 fallback.
- `pluginChoices.test.ts`: candidates, current added, blanks mean auto.

## 7. Out of scope

- Typing a custom value in the UI (the CLI and sessions cover it); native file dialogs; editing `quickLinks` or the roster in the HUD.
