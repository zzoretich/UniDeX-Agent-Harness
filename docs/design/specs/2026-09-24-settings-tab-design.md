# Workbench Settings tab — design

Date: 2026-09-24 · Branch: `feat/settings-tab` · Verified against `d410946` (v0.17.0), Claude Code 2.1.281, codex-cli 0.156.1

Phase 2 of the Settings tab. Phase 1 (`aos config`, spec `2026-09-24-aos-config`, #43) made every setting readable and
safely writable from the CLI; this puts it on screen. Phase 3 (change log and undo, presets, search) is out of scope.

## 1. Problem

- The Workbench rail (`WorkbenchView.ts` `RAIL` `:22-34`) has eleven tabs and no way to reach a setting. The plugin's
  own settings sit in Obsidian's modal (Settings → Community plugins → AgenticOS, `src/settings.ts`), and every system
  setting is CLI or JSON only.
- The rail has no footer and no overflow handling (`styles.css:1231-1235`): on a short pane its eleven buttons already
  spill out.
- The HUD's Cost and Telemetry toggles (`settingsDefaults.ts:20-22`) override the config **for the HUD alone**: turning
  Telemetry off hides nothing from the hooks, which keep recording. The owner chose (proposal `workbench-settings-tab`)
  to make them the real switches.
- Tabs spawn the runtime with `runBrainScript` (`main.ts:460-474`): detached, `stdio: "ignore"`, exit code unread. A
  settings UI must show "must be more than 0" beside the field, not a Notice that the spawn started.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **⚙ Settings is pinned to the rail's foot** (bottom-left). The eleven tab buttons move into a scrolling list above it; the footer never scrolls away. It opens a normal tab in the content pane (`setTab("settings")`), with a badge counting pending follow-ups. | A drawer; Obsidian's modal (owner's choice in the proposal). | Room for ~100 settings; the scroll fix is needed anyway. |
| D2 | **The tab renders what `aos config list --json` returns.** Sections, labels, help, types, bounds, sources and "applies" all come from the runtime schema; the HUD holds no copy of the keys. | A HUD-side mirror (`VAULT_CONFIG_DEFAULTS` style). | A key added to the schema appears in the tab with no HUD change; the mirror in `aosConfig.ts` already drifts. |
| D3 | **Every write is `aos config set|unset … --json`**, spawned through a new `runAos()` that waits and captures stdout/stderr (`src/data/aosRun.ts`). Exit 0 → the result JSON (Notice with the change and its effects); exit 2 → the message inline under the field; exit 1 → a Notice. | `runBrainScript`; writing JSON from the HUD. | Phase 1 owns validation, the target file, atomicity and side effects; the HUD only has to show the outcome. |
| D4 | **Rows use Obsidian's `Setting` component**, with the key, a source pill (`this machine` / `this vault` / `default`) and an "applies" note in the description, and ↺ to reset (unset) when the value is not the default. Types: bool → toggle; enum → dropdown (plus "host default" when nullable); number/string/model → text committed on blur or Enter; list/object → JSON text; read-only → the value plus the command that changes it. | Custom aos-styled rows. | The native pane already uses `Setting`; one look, keyboard and screen-reader support for free. |
| D5 | **Master switches** head the tab: Background AI (`provider` none ↔ auto), Chief of Staff, Routines, Knowledge graph, Cross-review, Session costing, Telemetry, Update checks, Skill sharing, Agent sharing. Each is a shortcut to the same `set` as its row. | Switches only in their sections. | "Control the entire system" in one glance; the rows below stay the full detail. |
| D6 | **Risky changes ask first** (`ConfirmModal`), decided by a pure `confirmFor(row, next)`: raising a `spend` number (it names the old and new cap), a `spend` switch or provider moving toward paid calls, an `autonomy` switch turning on or `persona.autoapply.minVerified` going down, `routines.tools` changing, `telemetry.redact` turning off. Lowering a cap or turning a thing off never asks. | Confirm every change; confirm none. | The schema's risk class already marks these; asking on every edit trains the user to click through. |
| D7 | **Spend rows show today's spend against the cap.** `aos config list --json` adds `spentToday` to each `perDayUsd` row, computed by the helpers `aos status` already uses (`cli/aos.js:476-502`; the two hook caps share the hook total). The schema gains `spend: hooks \| duties \| reasoner \| routines \| graph \| crossReview` on those rows. | The HUD reads the ledger. | One owner for the ledger families; the HUD stays a renderer. |
| D8 | **Host-specific rows are dimmed on a vault where that host is off**, still editable, with the command that enables it. The schema gains `host: claude \| codex` on those keys (`claude.*`, `codex.*`, `reasoner.model` / `.codexModel`, `persona.codexModel`, `routines.codexModel`, `crossReview.claudeModel` / `.codexModel`). | Hide them. | A Codex-only user can pre-set Claude values before enabling it (phase 1 D6 parity note). |
| D9 | **Follow-ups become buttons:** each `next:` from a set (`aos routines sync`, `aos skills sync`, `aos agents sync`) is kept until run, listed in a bar at the top of the tab, run through `runAos()` on click, and counted in the ⚙ badge. | Run them automatically. | Phase 1 D7: reloading launchd is the user's click. |
| D10 | **Cost and Telemetry become the real switches.** `costEnabled` and `telemetryEnabled` leave the plugin's settings; the HUD reads `cost.enabled` / `telemetry.enabled` from the merged config (`readVaultConfig`) through `plugin.costOn()` / `plugin.telemetryOn()`. Both toggles (tab and native pane) run `aos config set`. Stored values are pruned from `data.json` like the other dead keys. | Keep HUD-only overrides (owner rejected in the proposal). | One switch, one meaning. |
| D11 | **One renderer for the plugin's own settings**, `renderPluginSettings()` in `src/ui/pluginSettingRows.ts`, used by the native pane and by the tab's "Workbench" section. The native pane gains an "Open Workbench settings" button. | Two copies; replacing the native pane (owner rejected). | No drift between the two; Obsidian users still find settings where they expect them. |
| D12 | **Hosts & install is read-only** with two buttons, "Run doctor" and "Upgrade", that open `aos doctor` / `aos upgrade` in the Term tab (`view.runInTerm`). | Editable. | Phase 1 D6: these change only through the installer. |
| D13 | **Unavailable state:** when the vendored CLI has no `config` verb (a vault on 0.16 or older) or the call fails, the tab shows the error and "run `aos upgrade`", and still renders the Workbench section. | A blank tab. | The plugin bundle can be newer than the vendored runtime between upgrades. |

## 3. What already exists (at `d410946`)

- `cli/config-cmd.js` `row()` (the `list --json` row), `main(argv, opts)` with injectable `opts`; `cli/aos.js` `config()`
  `:1150`, spend helpers `spendRowsToday`/`sumUsd`/`is*Feature` `:476-502`.
- `brain/scripts/lib/settings-schema.js` `SETTINGS`, `SECTIONS`.
- HUD: `WorkbenchView.ts` rail `:85-98`, `setBadge` `:109`, `runInTerm` `:138`, `makeTab` `:159`; `main.ts` commands `:88`,
  `loadSettings` `:157` (dead-key prune), `rebindLiveSources` `:327`, `runBrainScript` `:460`; `src/settings.ts` (native
  pane, `decideVaultRoot` commit-on-blur, node Probe); `src/ui/ConfirmModal.ts`; `aosConfig.ts` `readVaultConfig`,
  `sessionHosts`; the Cost/Telemetry readers `main.ts:124,334`, `PulseTab.ts:159`, `SystemDrawer.ts:35`.

## 4. Design

**Runtime.** `settings-schema.js`: `host` and `spend` fields (D7, D8). `config-cmd.js`: `row()` carries `host` and
`spentToday` (from `opts.spend`, `null` otherwise). `cli/aos.js` `config()` passes `spend` computed once from today's
ledger rows.

**`src/data/aosRun.ts`.** `runAos(args, { node, vault, configDir, timeoutMs }, spawnFn)` → `{ code, stdout, stderr }`;
spawns `<vault>/brain/scripts/cli/aos.js` with `AOS_VAULT` / `AOS_CONFIG` pinned (as `RoutinesTab.spawnEnv`), never
detached, killed after the timeout. `runAosJson<T>()` adds a parsed body or a parse error.

**`src/data/settingsModel.ts`** (pure, tested): the `ConfigList` / `ConfigRow` types and `parseConfigList`;
`MASTER_SWITCHES` with `isOn(row)` / `valueFor(on)`; `parseInput(row, text)` (client-side bounds so a typo is caught
before a spawn; the CLI still decides); `valueArg(value)`; `confirmFor(row, next)` (D6); `appliesLabel`, `sourceLabel`,
`spendLine`, `hostNote(row, hosts)`; `FollowUps` (add from a result, remove on run, count).

**`src/views/SettingsTab.ts`.** Head (`SETTINGS`, "N changed from the defaults", refresh), follow-up bar, master
switches, one block per section, "Workbench (this Obsidian plugin)" through `renderPluginSettings`, Hosts & install.
After a successful set it refreshes, and after `telemetry.enabled` it calls `plugin.rebindLiveSources()`.

**Rail.** `.aos-wb-railtabs` (the eleven buttons, `overflow-y: auto; min-height: 0; flex: 1`) and `.aos-wb-railfoot`
(⚙ Settings with its badge). **Command** "Open Workbench: Settings". **Native pane**: the button, the two system toggles
via `runAos`, then `renderPluginSettings`.

## 5. Host parity

1. **Entry:** the ⚙ button, "Open Workbench: Settings", and the native pane's button; the same writes are `aos config`
   in a terminal, `/aos config` in Claude Code, `$agenticos:aos config` / `$aos config` in Codex (phase 1).
2. **Hooks:** none. 3. **Model calls:** none. 4. **Session data:** none. 5. **MCP:** none.
6. **Degradation:** a host that is off dims its rows (D8); a vault not yet upgraded shows D13.
7. **Docs:** README feature row, `docs/plugin-smoke.md` Settings section (a check per host mode), CHANGELOG.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | ⚙ Settings · command palette · native pane button | `aos config list/set` via `runAos` | Codex rows dimmed: "Codex is off — `aos init --host both`" |
| Codex only (plugin · direct) | the same | the same | Claude rows dimmed: "Claude Code is off — `aos init --host both`" |
| Both | the same | the same | — |

## 6. Testing

- `brain/scripts/test/settings-schema.test.js`: every `perDayUsd` has `spend`; `host` only on host-specific keys.
- `cli/config-cmd.test.js`: `host` and `spentToday` in `list --json`; `aos.js` spend families (hooks shared by both caps).
- `hud/src/data/aosRun.test.ts` (a fixture CLI): exit codes, stdout/stderr, JSON parse, timeout, env pinning.
- `hud/src/data/settingsModel.test.ts`: parse, master switches, `parseInput` bounds, `confirmFor` each case
  (raise vs lower, on vs off, provider paid vs not), labels, `hostNote`, follow-ups.
- `settingsDefaults.test.ts` loses the seed tests (D10). Manual: `docs/plugin-smoke.md` Settings, per host mode.

## 7. Out of scope

- Change log and undo, presets ("Pause all background AI"), filter and ⌘K jump (phase 3).
- `persona/autoapply.json`, `persona/repos.json`, `scanner-config.json`; per-item routine/skill/agent switches (their tabs).
- Re-rendering the rail's Chat button when the provider changes (it follows provider-state, rewritten by the next hook).
