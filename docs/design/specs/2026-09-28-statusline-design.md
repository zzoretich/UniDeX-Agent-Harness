# Status line — design

**Date:** 2026-09-28
**Status:** approved design (2026-09-28), implementing on `feat/statusline`
**Scope:** an opt-in AgenticOS status line. `aos statusline install` puts a three-line cockpit in Claude Code's status
line and a curated footer in Codex's. Both show what needs you (team gates, alerts, flags), live team runs, spend near
a cap and health. The Obsidian status bar and clickable links share the same model.

---

## 1. Problem

The vault knows when you are needed: a gate waiting on the Dev team, a breaking notification, a duty flag, a daily
cap nearly spent. None of it reaches the terminal you work in. Today the only terminal signal is a pasteable update
fragment (`aos update-status --statusline`), because the update-notification design (D1) ruled that AgenticOS never
takes the status line slot. Three things have changed since:

- Claude Code's payload now carries rate limits, prompt cache, effort, PR and worktree, so a good line is cheap.
- Installers do take the slot. GSD's migration replaced a user's own line without asking, and GSD's context monitor
  silently depends on a bridge file that only GSD's line writes.
- Codex has a footer (`[tui] status_line`), but only with built-in items and no command hook (upstream #17827).

The Obsidian status bar shows inventory counts (`12a · 21c · 80m · 40s`) rather than what needs attention.

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | **The slot is taken only by an explicit `aos statusline install`.** `init` and `upgrade` never take it. This supersedes update-notification D1 for users who opt in. `uninstall` restores what was there, byte for byte when nothing else in the file changed. | Fragment only (users wire it themselves, and most never do). Taking the slot at `init` (the alternative that design rejected). |
| D2 | **Chain instead of replacing.** The previous `statusLine` is recorded and run on every render with the same stdin, fire-and-forget, so its side effects keep working (GSD's `claude-ctx-<session>.json`). `--chain-output` shows its first line above ours, or below with `statusline.chainPosition: "bottom"`. | Writing GSD's bridge file ourselves (ties the product to GSD internals). Dropping it (GSD's context warnings go silent). |
| D3 | **One producer, one on-disk contract:** `brain/_index/statusline.json` (`schema: 1`), written by `aos statusline refresh`. The terminal and the HUD only read it. Refreshes are stale-while-revalidate: a render or a HUD tick that finds it older than 15 s spawns one detached refresh under an `fsx` lock. | Computing on every render (frontmatter reads and a board parse at 1 Hz). Pushing from each writer (six writers, and hand edits are missed). A TypeScript copy in the HUD (it drifts; notifications D7). |
| D4 | **The producer is strictly read-only.** It never calls `team status`/`reapKilledRuns`, which kill processes and write rows. A live run is a marker from this host whose dispatcher answers `kill(pid, 0)`. Other markers are hidden, not reaped. | Reusing `aos team list --json`, which has side effects. |
| D5 | **Flags count `- [ ]` and bare `- ` bullets under `## Flags`; `- [x]` is excluded.** Scripts write the first form and the persona writes the second. | `sitrep-state.parseFlags` as it is, which reads 0 on a vault whose persona wrote a bare bullet. |
| D6 | **Spend shows one family: the one with the highest spent/cap ratio, once it reaches 50 %.** Caps come from `settings-schema.js` `spend:` entries and `dayCap`. Teams have no daily cap and are left out. | Every family (too wide). Always showing it (line 3 would never collapse). |
| D7 | **Codex gets a built-in preset plus a session-start line.** `install` writes `[tui] status_line` from `statusline.codexItems`. It never overwrites an existing value without `--force`, and it keeps a backup. The needs-you summary is printed by the existing SessionStart `update-notice`, as plain stdout. | Binary patches or sidecars (cxstatusline, codex-hud): unsupported. `systemMessage` JSON: breaks codex-compat D6. A new hook: every Codex user would have to re-trust it under `/hooks`. |
| D8 | **Subagent rows are installed into `settings.json` `subagentStatusLine` by the same install.** | Shipping it in the plugin's `settings.json`: it would change rows for every plugin user who never opted in, and `${CLAUDE_PLUGIN_ROOT}` expansion there is undocumented. |
| D9 | **When the slot is lost, say so instead of fighting for it.** A doctor `warn` row, plus one session-start line when the recorded install no longer owns the slot. Re-running `install` takes it back and chains whatever took it. `upgrade` rewrites our command only while we still own the slot. | Reclaiming automatically at SessionStart or upgrade (a tug of war with GSD's installer on every update). |
| D10 | **Links are OSC 8 and built from an allow-list**, on by default (`statusline.links`). Targets are `obsidian://agenticos?vault=<name>&tab=<rail id>`, `obsidian://open` for `persona/STATE.md`, and the payload's PR URL only when it is `https://`. The HUD handler accepts only rail tab ids. | A dependency on another Obsidian plugin (advanced-uri). Echoing arbitrary URLs. |
| D11 | **The whole feature lives in the runtime behind one launcher arm (`statusline) SCRIPT=statusline.js`).** Settings point at `sh "<vault>/brain/scripts/bin/aos" statusline render`, the vendored launcher. That path survives plugin updates and exports `AOS_VAULT`. | `${CLAUDE_PLUGIN_ROOT}`, which user settings can't use. Routing through `cli/aos.js`, which would parse ~1.5k lines on every render. |
| D12 | **The work segment is the `in_progress` task's `activeForm`,** from `<claudeConfigDir>/tasks/<session_id>/*.json`, else the GSD phase line of `<project>/.planning/STATE.md`. | GSD's reader, which still looks in the removed `todos/` directory (it shows nothing on 2.1.28x). |

## 3. What already exists (verified at `6cd3fbe`, v0.20.2)

- `cli/update-check.js`: `renderStatusline`, `writeFragment` → `brain/_index/update-line.txt`, and `cmdUpdateNotice`
  (SessionStart, plain stdout, silent on failure). `README.md:381` states the "never claims the status line" policy.
- `lib/teams.js`: `listTeams`, `readTeam`, `boardItems`, `pendingGates` (read-only), and `liveMarkers` (raw).
  `lib/notifications.js`: `itemFiles`, `readState` (vault-injectable). `persona/sitrep-state.js` `parseFlags`.
- `lib/settings-schema.js`: `SPEND_FAMILIES`, the `perDay(..., {spend})` entries, `dayCap`, and the `list` type.
  `sdk/lib/spend-ledger.js` reads `provider-spend.jsonl`. `provider-state.json` has `name: 'none'` and a reason.
  `auto-wrap.js` writes `## Wrap Status` into `SESSION.md`. `feedback/_drafts/*.md`.
- `lib/host.js` `claudeConfigDir`/`codexHome`, `lib/fsx.js` `writeAtomic`/`withLockSync`,
  `lib/config-write.js` `readStrict`. Nothing writes `settings.json` or `config.toml` today; readers of `config.toml`
  are line regexes (`codexMcpServers`, `trustedPluginHooks`).
- `cli/aos.js`: `doctor()` `add(name, ok, detail, level)`, the `upgrade()` `act(...)` steps, `uninstall()`, and
  `lib/host.js` `enabledHosts()`, which reads a missing `hosts` block as no hosts (so install state must not create one).
- HUD: `main.ts` `rebuildStatusBar`/`refreshStatusBar` (30 s), `openWorkbenchTab(tab)`, `RAIL` ids
  (`agent-teams`, `notifications`, …), `runBrainScript`, and the `personaHeartbeat.ts` parse/load pattern. There is no
  protocol handler. `activate()` does not await `revealLeaf`, and `aos-dim` is unstyled inside the status bar.

## 4. Design

### 4.1 Commands (`brain/scripts/statusline.js`)

```
aos statusline install [--host claude|codex] [--force] [--chain-output]   # both enabled hosts by default
aos statusline uninstall [--host claude|codex]
aos statusline status [--json]            # per host: installed, owns slot, chained command, model age
aos statusline render                     # Claude Code statusLine command (stdin payload → ≤3 lines)
aos statusline subagents                  # Claude Code subagentStatusLine command (stdin → JSONL rows)
aos statusline refresh                    # rebuild brain/_index/statusline.json
aos statusline preview [--width N]        # render against a sample payload
```

**Claude install** (`lib/statusline-install.js`):
1. `readStrict` the user-scope `settings.json` and refuse invalid JSON.
2. Copy it once to `settings.json.aos-statusline.bak`.
3. Record the previous `statusLine` and `subagentStatusLine` in `agenticos-statusline.json` beside `agenticos.json`
   (machine-local; never under `hosts`, which would change `enabledHosts()`): `claude = {command, previous, previousSubagent, installedAt}`. A re-install keeps the first
   `previous` unless someone else has taken the slot since, in which case that newcomer becomes `previous` and is chained.
4. Write `statusLine = {type:'command', command, refreshInterval: statusline.refreshSeconds, hideVimModeIndicator: true}`
   and, when `statusline.subagents` is on, `subagentStatusLine`.

**Codex install:** a line-based edit of `<codexHome>/config.toml` with a backup.
- `[tui]` exists without `status_line`: insert the key.
- No `[tui]`: append the table.
- `status_line` already set (as a key or dotted): refuse unless `--force`, which records the old line for uninstall.
- The same state file's `codex` entry records what was written. Uninstall removes our line only if it is unchanged.

### 4.2 Model (`lib/statusline-model.js`, pure over an injected vault and clock)

```json
{ "schema": 1, "at": "…", "vault": "AgenticOS",
  "needs": { "gates": [{"team":"dev","item":"devbar-01","stage":"ship"}], "alerts": 1, "breaking": 0, "flags": 1 },
  "runs": [{"team":"dev","member":"woz","stage":"execute","item":"devbar-01","since":"…"}],
  "spend": {"family":"duties","usd":4.8,"cap":6}, "health": {"update":"0.21.0","provider":null,"unwrapped":false,"drafts":11} }
```

The sources are those in §3. Notifications follow the HUD badge pattern: `state.json` plus a year-dir listing, then up
to 200 unread files read for their level.

### 4.3 Render (`lib/statusline-render.js`, pure: payload + model + `COLUMNS` → lines)

```
L1  Opus 5.5 ·high ·think │ Writing the spec │ AgenticOS-Workbench ⎇ feat/statusline* │ #63 review
L2  ████░░░░░░ 46% ⚡91% │ $3.42 │ +156/-23 │ 5h 24% · 7d 41% │ cache 42m
L3  ◆ 2 gates · 1 alert · 1 flag │ ▶ woz execute devbar-01 │ duties $4.80/$6 │ ⬆ 0.21.0 · 11 drafts
```

- The context bar uses the auto-compact-normalized usable %.
- Rate-limit reset times appear at ≥ 80 %.
- `cache` counts down the warm TTL and reads `cold` once it expires.
- L3 is omitted when every one of its segments is empty.
- When a line is too wide for `COLUMNS`, segments drop in priority order instead of wrapping.
- Git branch/dirty is the only subprocess, cached for 5 s in `os.tmpdir()`.
- Every segment has its own try/catch, and any failure prints nothing and exits 0.
- Budget: render ≤ 30 ms after node starts. The chain adds no wait.

**Subagent rows:** `name · description… · model ·effort · ctx 34% · 4m`, as one `{"id","content"}` line per task. With
`statusline.subagents` off, or when the install isn't ours, nothing is printed and Claude Code's default rows stay.

### 4.4 HUD

- **Status bar:** `⚡ live │ ◆ 2 gates · 1 alert │ ▶ woz │ duties $4.80/$6 │ ⬆ 0.21.0`, read from `statusline.json`
  (new `src/data/statusline.ts`). Clicking a segment opens `agent-teams`, `notifications` or the Workbench. A stale or
  missing model triggers a refresh via `runBrainScript`. Without a model it falls back to the current counts.
- **Protocol handler:** `registerObsidianProtocolHandler('agenticos', …)` accepts only `RAIL` ids.
- **Fixes on this path:** `openWorkbenchTab` awaits `revealLeaf` (so deferred leaves switch tabs), and `aos-dim` gets a
  status-bar style.

### 4.5 Config (`config.default.json` + `settings-schema.js`, new section `statusline`)

| Key | Default |
|---|---|
| `statusline.segments` | `["needs-you","runs","spend","health"]` |
| `statusline.links` | `true` |
| `statusline.chainPosition` | `"top"` (`"bottom"` puts the `--chain-output` line below ours) |
| `statusline.subagents` | `true` |
| `statusline.refreshSeconds` | `5` (used at install) |
| `statusline.codexItems` | `["model-with-reasoning","task-progress","project-name","git-branch","context-used","five-hour-limit","weekly-limit"]` |

## 5. Host parity

1. **Entry point:** `aos statusline …` is host-neutral. In a session, `/aos statusline install` on Claude Code,
   `$agenticos:aos` with the Codex plugin, `$aos` with direct wiring.
2. **Hooks:** none are added. `update-notice` gains two lines: the Codex needs-you summary, and a slot-lost notice on
   Claude. Nobody re-trusts `/hooks`.
3. **Model calls:** none.
4. **Session data:** the Claude payload's `session_id`, used to find `<claudeConfigDir>/tasks/<id>/`, through
   `host.js`. No transcripts.
5. **MCP:** no new tool.
6. **Degradation:**
   - Codex shows built-in items only. `status` and doctor say "Codex footer: built-in items (no command status line)".
   - There are no subagent rows on Codex.
   - Terminals without OSC 8 show plain text.
   - Any read failure drops a segment, never the line.
7. **Docs:**
   - README: replace the policy sentence and add a "Status line" section and a row in Everyday commands.
   - `docs/install.md` Hosts.
   - `docs/plugin-smoke.md`: Claude line, Codex footer, the Obsidian bar, and the URI.
   - CHANGELOG, with an **Upgrading** note: nothing changes until you run `install`.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | `aos statusline install` · `/aos statusline install` | `render` + `subagents` from `settings.json`; the chain; slot-lost notice at session start | Terminal.app: no links; slot lost → doctor warn + session line |
| Codex only (plugin · direct) | `aos statusline install` · `$agenticos:aos` · `$aos` | `[tui] status_line` preset; the needs-you line at session start via `update-notice` | no AgenticOS segments in the footer (D7); no subagent rows (D8); a status/doctor row says so |
| Both | one `install` does both | both of the above | as above, per host |

## 6. Testing

- `brain/scripts/test/statusline-model.test.js`: a fixture vault covering a pending gate, a live and a dead marker
  from this host and another host, unread levels, both flag forms, spend around 50 %, provider `none`, wrap status,
  drafts and the update line.
- `statusline-render.test.js`: payload fixtures to exact lines (ANSI stripped), width dropping, L3 collapse, null
  fields, OSC 8 on/off, subagent JSONL.
- `statusline-install.test.js`: temporary Claude config dir and Codex home. Covers install, re-install, a slot taken by
  another command, the chain being recorded, refusing invalid JSON, the backup, the four TOML shapes, `--force`, and
  a clean uninstall per host (`AOS_HOST`/`hosts`).
- Other test files:
  - `update-check.test.js` gets the per-host notice lines.
  - `cli/aos*.test.js` get the doctor rows.
  - `aos-wrapper.test.js` and `plugin-manifests.test.js` get the launcher arm.
  - HUD `statusline.test.ts` parses the fixture shared with the runtime (the `createRequire` cross-check).
  - The two rehearsals each run `install` against a fake host config.

## 7. Out of scope

Project-scope `.claude/settings.json` overrides, which are reported by `status` but not edited. Themes and nerd-font
glyphs. Moving `cli/aos.js` `spendByFamily` onto the new helper. Aligning the HUD's default for a gate with no state
(`pending`) with the runtime's. The flag-writing form the persona uses.
