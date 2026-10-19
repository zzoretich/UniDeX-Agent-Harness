# Status line — implementation plan

Spec: `docs/design/specs/2026-09-28-statusline-design.md` (D1 to D12). Branch `feat/statusline` from `6cd3fbe`.

## Goal

Add `aos statusline install|uninstall|status|render|subagents|refresh|preview`: an opt-in three-line Claude Code
status line that runs the previous one inside it, a Codex footer preset with a session-start needs-you line, and an
Obsidian status bar and `obsidian://agenticos` links that read the same `brain/_index/statusline.json`. One PR,
committed per logical unit.

## Review decisions (2026-09-28)

| Topic | Decision |
|---|---|
| Design | Approved as written (D1 to D12) and the parity matrix. |
| Scope | Everything in v1: the three-line cockpit, all four AgenticOS segments, links, subagent rows, the Obsidian bar. |
| Split | One PR, per-unit commits, cross-reviewed by the other provider before it opens. |

## File structure

| Path | New/Changed | What |
|---|---|---|
| `brain/scripts/lib/statusline-model.js` | new | Pure producer over (vault, clock, cfg): gates, live markers (this host, `kill(pid,0)`), unread alert levels, flags (D5), spend family nearest cap (D6), health; `read`/`write`/`isStale` for `statusline.json` |
| `brain/scripts/lib/statusline-render.js` | new | Pure renderer: payload + model + columns → ≤3 lines; segment priorities; OSC 8 (D10); subagent JSONL rows; git cache |
| `brain/scripts/lib/statusline-install.js` | new | Claude `settings.json` and Codex `config.toml` install/uninstall/status, backups, the machine-local `agenticos-statusline.json` state, chain bookkeeping (D2, D7, D8, D9) |
| `brain/scripts/statusline.js` | new | The verb parser; `render` reads stdin, fires the chain, renders, and triggers a stale refresh under a lock (D3) |
| `brain/scripts/test/statusline-{model,render,install}.test.js` + `test/fixtures/statusline/` | new | Fixture vault, payloads, a fake Claude config dir and Codex home |
| `brain/scripts/config.default.json`, `lib/settings-schema.js` + its test | changed | The `statusline` section and its five keys |
| `plugin/bin/aos` | changed | `statusline) SCRIPT=statusline.js ;;` |
| `plugin/commands/aos.md` | changed | `statusline` in the argument hint, plus a relay bullet |
| `codex-plugin/**` | generated | `npm run build:codex-plugin` |
| `cli/aos.js` | changed | doctor rows per host (installed · owns slot · chain), an `upgrade` step (rewrites the command only while it is ours), `uninstall` restores, `USAGE` |
| `cli/update-check.js` + test | changed | `update-notice`: the Codex needs-you line and the Claude slot-lost line (runtime resolved through `resolveModule`) |
| `cli/aos-wrapper.test.js`, `cli/plugin-manifests.test.js` | changed | The launcher arm |
| `hud/src/data/statusline.ts` + test | new | Parser and loader (`schema === 1`) with the fixture shared with the runtime |
| `hud/main.ts`, `styles.css` | changed | Status bar from the model with per-segment clicks, stale refresh via `runBrainScript`, `registerObsidianProtocolHandler('agenticos')`, `openWorkbenchTab` awaits `revealLeaf`, `aos-dim` in the bar |
| `cli/rehearsal/first-run.sh`, `cli/rehearsal/codex-host.sh` | changed | `install` → `preview`/footer assertions → `uninstall` against fake host config |
| `README.md`, `docs/install.md`, `docs/plugin-smoke.md`, `CHANGELOG.md` | changed | The policy sentence, a "Status line" section, the command row, Hosts, smoke items per host, Unreleased + Upgrading |

## Tasks

- [ ] **0. Spike (manual, ~10 min, no spend).** On Claude Code 2.1.28x, confirm:
  - a `statusLine` whose command is `sh "<vault>/brain/scripts/bin/aos" …` renders three lines, with `COLUMNS` set;
  - `subagentStatusLine` receives `tasks[]`;
  - OSC 8 is clickable in the user's terminal;
  - Codex 0.156 accepts the `codexItems` preset without an "Ignored invalid" warning.

  Record anything that differs in the spec before building.
- [ ] **1. Model.** `statusline-model.js` and its fixture vault:
  - gates via `listTeams` → `readTeam` → `pendingGates`;
  - markers via `liveMarkers`, filtered by host and pid;
  - notifications via `readState` + `itemFiles` + ≤200 unread reads;
  - flags (D5), spend (a pure `familyOf` + caps from the schema `spend:` entries + `dayCap`), provider state, wrap status, drafts, `update-line.txt`.

  Tests first.
- [ ] **2. Render.** `statusline-render.js`:
  - L1/L2/L3 layout, with L3 collapsing when empty;
  - priority dropping by `COLUMNS`;
  - null-safe payload handling;
  - OSC 8 on/off;
  - subagent rows;
  - the work segment (D12).

  Exact-string tests with ANSI stripped, plus one ANSI snapshot.
- [ ] **3. Entry + refresh.** `statusline.js`:
  - `render` reads stdin (3 s guard), fires the chain detached with the same stdin (D2, or `--chain-output`: wait ≤1 s and prepend), reads the model, and spawns `refresh` when it is older than 15 s (`fsx` lock, no dogpile);
  - `refresh`, `preview`, `status`, `subagents`.

  Any failure exits 0 with empty stdout.
- [ ] **4. Install.** `statusline-install.js`:
  - Claude: `readStrict`, a one-time `.aos-statusline.bak`, record `previous`, write both keys; re-install and taken-slot rules (D9); uninstall restores.
  - Codex: a line-based `[tui]` edit covering four shapes (no table, table without key, key present, dotted key), `--force`, a backup, and an uninstall that removes only an unchanged line.

  Tests with a temporary `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, per host.
- [ ] **5. Config.** Add the keys to `config.default.json` and `settings-schema.js` (new section `statusline`), and update the schema test.
- [ ] **6. Launcher + plugin.**
  - The `plugin/bin/aos` arm.
  - The `plugin/commands/aos.md` hint and bullet.
  - `npm run build:codex-plugin`, committed with its source.
  - The wrapper and manifest tests.
- [ ] **7. CLI.**
  - `doctor` rows:
    - `status line (claude)`: ok / warn "taken by …" / info "not installed";
    - `status line (codex)`: ok / info "built-in items only".
  - The `upgrade` `act` step.
  - The `uninstall` restore, including `--host`.
  - `USAGE`.
  - The `update-notice` lines and their tests.
- [ ] **8. HUD.**
  - `statusline.ts` + a test on the shared fixture (`createRequire` cross-check).
  - The status bar rewrite with its fallback.
  - The protocol handler with a rail-id allow-list, plus a pure `parseUri` test.
  - The `openWorkbenchTab` await fix.
  - The `aos-dim` style.
  - `npm run build -w hud`.
- [ ] **9. Rehearsals.** `first-run.sh`: install, `preview` shows three lines, uninstall restores the fake `settings.json` byte for byte. `codex-host.sh`: install writes `[tui] status_line` into the fake home and uninstall removes it.
- [ ] **10. Docs + CHANGELOG** (Added; **Upgrading**: opt-in, nothing changes until `aos statusline install`; Codex shows built-in items).
- [ ] **11. Verify.**
  - `npm run gate`;
  - `npm run build:codex-plugin` leaves nothing uncommitted;
  - `npm test`;
  - `npm run lint && npm run lint:sh && npm run typecheck`;
  - `parity-check.js --wip --rehearse`;
  - the obsidian build.
- [ ] **12. Cross-review** by the other provider before the PR opens (`/cross-review`, as Agent Teams was).
- [ ] **13. Publish check → commit → PR → CI → merge** (ask first).
- [ ] **14. Bring it home.**
  - `aos upgrade --from-local ~/AgenticOS-Workbench`.
  - `aos statusline install` on this machine, **asked first**: it edits the user's `settings.json` and `config.toml` and chains the current GSD line.
  - `aos doctor`, with both blocks green.
  - Exercise it once per host.

## Risks

- A concurrent `settings.json` write by Claude Code (`/config`) between our read and our rename. Mitigation: the
  read-modify-write window is milliseconds, and `status` re-reads and reports a mismatch.
- A chained command that hangs: it runs detached with its stdout ignored, so it never blocks our render.
- A project-scope `statusLine` that overrides ours: `status` reports the override and leaves it alone.
