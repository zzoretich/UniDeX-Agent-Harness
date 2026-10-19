# Universal skills — plan

Date: 2026-09-23 · Spec: `docs/design/specs/2026-09-23-universal-skills-design.md`

## Goal

A Skills tab in the Workbench lists every Claude Code and Codex skill, runs one in a terminal on either host, and a sync
keeps each host's user skills mirrored into the other host's user folder, translated, so every personal skill works on
both.

## Interview decisions (2026-09-23)

| Topic | Decision |
|---|---|
| Mechanism | Translated mirror: generated SKILL.md, supporting files symlinked, `.aos-mirror.json` sidecar (D1). |
| Scope | User + claude.ai-synced skills are mirrored; plugin skills and built-ins are listed, not mirrored (D2). |
| Trigger | Automatic: SessionEnd hook on both hosts, the tab (open when stale, Sync), and `aos upgrade` (D5). |
| Default | On when both hosts are enabled; per-skill `exclude` (D6). |

## File structure

| Path | New/Changed | What |
|---|---|---|
| `brain/scripts/lib/skill-translate.js` | new | Frontmatter parse/emit, Claude → Codex and Codex → Claude body transforms, markers (D4) |
| `brain/scripts/lib/skills.js` | new | `roots`, `discover`, `plan`, `apply`, `readCache`/`writeCache`, `sync` (D1–D3, D6, D7) |
| `brain/scripts/skills-sync.js` | new | SessionEnd hook entry: `hookEntry`, `respawnDetached`, quiet sync, exit 0 |
| `brain/scripts/test/skill-translate.test.js`, `skills.test.js`, `skills-sync.test.js` | new | Tmp-root unit tests |
| `brain/scripts/persona/scan-arsenal.js`, `collectors/capabilities.js` (+ tests) | changed | Skip mirror folders (D8) |
| `brain/scripts/config.default.json` | changed | `skills: { sync: true, exclude: [] }` |
| `cli/skills.js` + `.test.js` | new | `aos skills list\|sync\|exclude\|include\|reset` |
| `cli/aos.js` | changed | Dispatch, `USAGE`, flags, doctor `skills` row, sync at the end of `upgrade` |
| `plugin/bin/aos` | changed | `skills` → `cli/aos.js`; `skills-sync` → `skills-sync.js` |
| `plugin/hooks/hooks.json`, `cli/codex-host.js` `HOOKS` | changed | SessionEnd `skills-sync` on both hosts |
| `plugin/commands/skills.md` | new | `/skills` → `$agenticos:skills` |
| `codex-plugin/` | regenerated | `npm run build:codex-plugin` |
| Count pins: `cli/plugin-commands.test.js`, `tools/build-codex-plugin.{js,test.js}`, `cli/codex-host.test.js`, `cli/aos.js` comment, `cli/plugin-manifests.test.js` | changed | 18 commands, 25 Codex skills, the new hook |
| `hud/src/data/skills.ts` + `.test.ts` | new | Cache loader, grouping, counts, invocations |
| `hud/src/views/SkillsTab.ts`, `WorkbenchView.ts`, `main.ts`, `styles.css` | new/changed | The tab |
| `README.md`, `docs/install.md`, `docs/plugin-smoke.md`, `vault-template/AGENTICOS.md` | changed | Commands, counts, smoke items per host, vocabulary |

## Tasks

- [x] 1. `skill-translate.js` + tests
- [x] 2. `skills.js` + tests; `skills-sync.js` + test
- [x] 3. Readers skip mirrors (scan-arsenal, capabilities) + tests
- [x] 4. `cli/skills.js`, `cli/aos.js` wiring, config default, `plugin/bin/aos` + tests
- [x] 5. `/skills` command, SessionEnd hook on both hosts, rebuild `codex-plugin/`, count pins
- [x] 6. HUD Skills tab + loader tests; `npm run build -w hud`
- [x] 7. Docs; gate, `npm test`, parity `--wip --rehearse`, publish-check; PR
