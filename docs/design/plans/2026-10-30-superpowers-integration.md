# Superpowers integration implementation plan

Date: 2026-10-30  
Depends on approval of `2026-10-30-superpowers-integration-design.md`.

## File structure

| Area | Files | Responsibility |
|---|---|---|
| Installer | `cli/superpowers.js`, `cli/superpowers.test.js`, `cli/aos.js`, `cli/aos.test.js`, `cli/hosts.js`, `cli/hosts.test.js` | Official plugin install, version/status detection, first-run preference, later host addition, upgrade retry |
| Configuration | `brain/scripts/config.default.json`, `brain/scripts/lib/settings-schema.js`, `hud/src/data/aosConfig.ts`, related tests | Explicit preference and app Settings control |
| Chief | `vault-template/persona/identity.template.md`, `brain/scripts/persona/build-playbook.js`, `brain/scripts/test/*`, `cli/vault-template.test.js` | New Chief route, existing Chief exact-diff proposal |
| Wizard | `app/src/renderer/setup/wizard.ts`, `app/src/main/policy/setup.ts`, `app/tests/unit/setup.test.ts`, `app/tests/e2e/setup*.spec.ts` | Visible default-on choice and install result |
| Product docs | `README.md`, `docs/install.md`, `docs/how-it-works.md`, `docs/app-smoke.md`, `app/tests/e2e/COVERAGE.md`, `SECURITY.md`, `CHANGELOG.md`, `hud/src/tour/steps.json`, `hud/src/tour/whatsnew.json` | Explain dependency, compatibility, privacy, validation and upgrade |

## Tasks

- [x] 1. Add installer regression tests with injected Claude and Codex runners for official plugin IDs, missing/installed/disabled states, failure warnings, and Codex direct mode.
- [x] 2. Implement the bounded `cli/superpowers.js` adapter. Keep plugin selectors fixed, parse CLI JSON defensively, and never enable or overwrite a disabled pre-existing plugin.
- [x] 3. Add first-install preference and `--no-superpowers`; wire `aos init`, `aos hosts add`, `aos upgrade`, and doctor. Preserve opt-out and old-install migration. Add tests per host and both-host behavior.
- [x] 4. Add the Chief's interactive coding route to the identity template and initial playbook. Test that old identities remain untouched and upgrade files an exact-diff proposal.
- [x] 5. Add wizard checkbox and Finish/status copy, plus Settings enable/retry path. Extend app setup tests, including Codex-only and no-host variants.
- [x] 6. Update docs, changelog, tour/What's new, and app smoke coverage. Explain official marketplace version drift, old Codex compatibility, user-owned plugin preservation, and upstream's optional visual companion network behavior.
- [x] 7. Run root gate, build/parity checks, unit tests, lint, typecheck, rehearsals; then app typecheck/unit/compat/e2e and packaged smoke if the setup payload changes.
- [ ] 8. Inspect the diff for host parity and privacy, commit logical slices, run the publish check, push the branch and open one PR. Wait for user approval before merging. Release only on a separate request.

## Acceptance checks

- Fresh Claude-only, Codex-only plugin-mode, and both-host installs have Superpowers available on the selected hosts and visible in doctor.
- A no-host install records the choice and installs Superpowers when a host is added later.
- Opt-out and pre-existing disabled Superpowers stay disabled; a failed external marketplace leaves UniDeX itself usable and reports the exact recovery command.
- A pre-feature vault is not silently changed on upgrade. The Chief's existing protected identity changes only through the Proposals UI.
- Codex direct mode reports the approved compatibility gap rather than claiming success; no new host hook trust is required.

The tour and What’s New entry are staged for the next minor release (2.4.0); no release has been cut from this branch.
