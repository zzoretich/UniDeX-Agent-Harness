# Universal agents — plan

Date: 2026-09-23 · Spec: `docs/design/specs/2026-09-23-universal-agents-design.md`

## Goal

An Agents tab in the Workbench lists every Claude Code and Codex agent and starts one in a terminal on either host. The
sync that already shares skills also mirrors each host's user agents into the other host's agents folder, translated
between Markdown and TOML, so every personal agent works on both.

## Interview decisions (2026-09-23)

| Topic | Decision |
|---|---|
| Design | Approved as written (D1–D9). |
| Default | On when both hosts are enabled, every user agent shared; per-agent `exclude` (D6). |
| Trigger | The existing `skills-sync` SessionEnd hook, `aos upgrade`, the tab (D5). No hook change. |

## Tasks

- [ ] `lib/agent-translate.js`: TOML subset (read, write), frontmatter read, Claude → Codex and Codex → Claude, marker
      line and its hash (D1, D4); export the skill wording transforms it reuses.
- [ ] `lib/agents.js`: `roots`, `discover`, `plan` (D3 incl. reserved names), `apply`, `sync`, `reset`, cache (D7).
- [ ] `config.default.json`: `agents: { sync: true, exclude: [] }`.
- [ ] `skills-sync.js` runs the agent sync after the skill sync, each guarded on its own.
- [ ] `persona/scan-arsenal.js`: skip mirror agents, list Codex user agents (D8).
- [ ] `cli/agents.js` + dispatch, `USAGE`, doctor row, upgrade step label; `plugin/bin/aos` routes `agents`.
- [ ] `plugin/commands/agents.md` → rebuild `codex-plugin/`; count pins to 19 commands / 26 Codex skills.
- [ ] HUD: `src/data/agents.ts` (+ test), `src/views/AgentsTab.ts`, rail entry, styles.
- [ ] Docs: README, `docs/install.md`, `docs/plugin-smoke.md`, `vault-template/AGENTICOS.md`.
- [ ] Verify: gate, tests, parity `--rehearse`, HUD build, publish-check.

## File structure

| Path | New/Changed | What |
|---|---|---|
| `brain/scripts/lib/agent-translate.js` | new | TOML subset, frontmatter read, both translations, marker (D1, D4) |
| `brain/scripts/lib/skill-translate.js` | changed | Export `claudeWording`, `codexWording`, `claudeBodyToCodex` for reuse |
| `brain/scripts/lib/agents.js` | new | `roots`, `discover`, `plan`, `apply`, `sync`, `reset`, `readCache`/`writeCache`, `isMirrorFile` (D1–D3, D6, D7) |
| `brain/scripts/skills-sync.js` | changed | Also runs `agents.sync` (D5) |
| `brain/scripts/persona/scan-arsenal.js` | changed | Mirror agents skipped, Codex user agents listed (D8) |
| `brain/scripts/config.default.json` | changed | `agents` key (D6) |
| `brain/scripts/test/agent-translate.test.js`, `agents.test.js` | new | Tmp-root unit tests |
| `brain/scripts/test/skills-sync.test.js`, `persona-playbook.test.js` | changed | The agent sync runs; arsenal rows |
| `cli/agents.js` + `.test.js` | new | `aos agents list\|sync\|exclude\|include\|reset` |
| `cli/skills.js` | changed | Export `ago`, `table`, `resolveCtx` for `cli/agents.js` |
| `cli/aos.js` (+ tests) | changed | Dispatch, `USAGE`, flags, doctor `agents` row, upgrade step label |
| `plugin/bin/aos` | changed | `agents` → `cli/aos.js` |
| `plugin/commands/agents.md` | new | `/agenticos:agents` → `$agenticos:agents` (D9) |
| `codex-plugin/` | regenerated | `npm run build:codex-plugin` |
| Count pins: `cli/plugin-commands.test.js`, `tools/build-codex-plugin.{js,test.js}`, `cli/codex-host.test.js`, `cli/aos.js` comment | changed | 19 commands, 26 Codex skills |
| `hud/src/data/agents.ts` + `.test.ts` | new | Cache loader, grouping, counts, run commands |
| `hud/src/views/AgentsTab.ts`, `WorkbenchView.ts`, `styles.css` | new/changed | The tab |
| `README.md`, `docs/install.md`, `docs/plugin-smoke.md`, `vault-template/AGENTICOS.md` | changed | Commands, counts, smoke items per host, vocabulary |
