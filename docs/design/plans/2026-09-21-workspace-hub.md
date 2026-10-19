# Workspace hub — implementation plan

Spec: `docs/design/specs/2026-09-21-workspace-hub-design.md` · Branch: `feat/workspace-hub`

One PR, three commits (runtime, CLI, HUD + docs). Every task ends with `npm run gate && npm test`.

## Tasks

- [ ] 1.1 `brain/scripts/collectors/hostSessions.js` + `test/host-sessions.test.js` + fixtures.
- [ ] 1.2 `collectors/workspaces.js`: `AGENTS.md` marker and source; `collectors/projects.js` `hasAgentsMd`;
      `scan-vault.js` attaches sessions and stores `snapshot.hostSessions`; `health.js` info issue.
- [ ] 2.1 `cli/workspace.js` (`list | new | adopt`) + `cli/workspace.test.js`; dispatch in `cli/aos.js`,
      USAGE, `plugin/bin/aos` route, `cli/plugin-manifests.test.js` route check.
- [ ] 3.1 HUD: `snapshot.ts` types, `src/data/hostSessions.ts` + test, `SpacesTab.ts` chip and footer;
      `npm run build -w hud`.
- [ ] 3.2 Docs: README (commands table, How it works bullet), `docs/install.md` (After install table),
      `docs/plugin-smoke.md` (Spaces rows), `vault-template/AGENTICOS.md` home rule.
- [ ] 4 Machine side (owner-confirmed, not in the repo): `aos workspace adopt` for the six non-empty folders,
      delete the five empty ones.

## File structure

| Path | Change |
|---|---|
| `brain/scripts/collectors/hostSessions.js` | new |
| `brain/scripts/collectors/{workspaces,projects,health}.js`, `brain/scripts/scan-vault.js` | edit |
| `brain/scripts/test/host-sessions.test.js`, `test/fixtures/host-sessions/**` | new |
| `cli/workspace.js`, `cli/workspace.test.js` | new |
| `cli/aos.js`, `plugin/bin/aos`, `cli/plugin-manifests.test.js` | edit |
| `hud/src/data/hostSessions.ts` (+ test), `src/data/snapshot.ts`, `src/views/SpacesTab.ts` | new / edit |
| `README.md`, `docs/install.md`, `docs/plugin-smoke.md`, `vault-template/AGENTICOS.md` | edit |
