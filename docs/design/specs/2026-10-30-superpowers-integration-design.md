# Superpowers integration design

Date: 2026-10-30  
Base: UniDeX `f6ce8cd` (`v2.3.0`)  
Upstream: [obra/superpowers](https://github.com/obra/superpowers), MIT; official install guidance checked 2026-10-30.

## Problem

UniDeX installs its own Claude Code and Codex plugins and gives the Chief of Staff a shared memory and routing playbook. New users do not receive Superpowers during setup. Installing it by hand on one host does not install it on the other, and the Chief has no explicit route for its software-development workflow. The goal is to make Superpowers available during first-run installation for every selected host and have the Chief use it for interactive coding work while preserving UniDeX's permission and self-improvement rules.

## What already exists

- `cli/aos.js:911-964,1158-1162,1380-1384` installs UniDeX's own plugins during `aos init` and refreshes Codex on upgrade; it has no Superpowers step.
- `cli/codex-host.js:413-454` selects Codex plugin mode when supported and falls back to direct hooks/MCP/skills for older CLIs.
- `brain/scripts/lib/skills.js:145-194` lists enabled plugin skills but mirrors only user skills. Installing Superpowers on both hosts does not create duplicate mirrors.
- `vault-template/persona/identity.template.md` routes through `PLAYBOOK.md` but names no coding methodology. `brain/scripts/persona/prompt-updates.js:123-174` offers changed identity templates to existing users as exact-diff proposals on upgrade.
- `app/src/renderer/setup/wizard.ts:404-513` chooses hosts and interviews the Chief; `app/src/main/policy/setup.ts:78-82` builds the `aos init` command.
- [Superpowers' README](https://github.com/obra/superpowers#installation) documents `superpowers@claude-plugins-official` for Claude Code and an official Codex plugin catalog. This machine's Codex catalog lists `superpowers@openai-curated-remote` v7.0.1; Claude Code has no Superpowers installed. Upstream's Codex package has 15 skills and no hook manifest.
- An isolated `CODEX_HOME` probe of `codex plugin add superpowers@openai-curated-remote --json` returned `chatgpt authentication required for remote plugin catalog`; the wizard already requires a signed-in Codex host, but a fresh authenticated-profile install still needs a live smoke before release.

## Decisions for approval

| ID | Proposed decision | Rejected alternative and reason |
|---|---|---|
| D1 | New installations offer **Include Superpowers** checked by default for each selected host. `aos init --yes` uses that default; `--no-superpowers` opts out. The wizard names it as a third-party plugin and links upstream. | Silent installation with no mention would make an external dependency invisible; opt-in only would not meet “pre-install for users.” |
| D2 | Use each host's **official marketplace plugin** rather than copy or fork Superpowers into UniDeX. Claude: `superpowers@claude-plugins-official`; Codex plugin mode: `superpowers@openai-curated-remote`. These need network and host sign-in. Record the installed version and report failures without breaking UniDeX setup. | Vendoring 99+ files into the runtime would create a second release and security maintenance stream. A loose `git clone main` has no version control. |
| D3 | Respect any already installed or disabled Superpowers plugin: do not overwrite, update, or re-enable it. On upgrade, only retry installation when UniDeX's own preference says `enabled` and the plugin is missing. Existing UniDeX installs start with the preference off until the user enables it in Settings or CLI. | Auto-installing on a prior user's upgrade changes their host environment without a setup choice. |
| D4 | For an older Codex CLI in **direct mode**, show a specific “Superpowers needs Codex plugin support” doctor warning and upgrade guidance. UniDeX itself remains fully wired. This is an approved host gap if accepted here. | Repackaging upstream skills into `~/.agents/skills` would not have the same plugin identity or update path; it requires a separate compatibility project. |
| D5 | Add one Chief of Staff identity route: for **interactive software-development work**, consult the installed Superpowers skills for discovery, design, planning, TDD, debugging, review, and finish. User instructions, host permissions, and UniDeX's guarded instruction proposals remain authoritative. Background duties do not acquire new tools or workflows. | Making Superpowers mandatory for every personal/vault task would overreach; editing existing `IDENTITY.md` directly violates the instruction guard. |
| D6 | On a new install, generate the route in `identity.template.md` and initial `PLAYBOOK.md`. On upgrade, the current exact-diff proposal mechanism offers the change to existing Chiefs; it applies only on approval. | A direct rewrite on upgrade would bypass the Proposals UI and replace user-customized identity text. |
| D7 | `aos doctor` and the wizard's Finish step show Superpowers status per enabled host, including a failure and manual install command. `aos uninstall` leaves third-party Superpowers installed and says so. | Removing a user-owned plugin when UniDeX is uninstalled could discard a plugin the user now relies on. |
| D8 | UniDeX does not activate Superpowers' optional visual companion. The wizard and docs disclose that upstream says its visual companion can load a remote logo if a user later chooses it. UniDeX itself makes no telemetry call for this feature. | Claiming a third-party plugin can never contact its maintainer would be inaccurate. |

## Design

1. Add a small `cli/superpowers.js` adapter with test-injected command runner, host detection, installed/enabled status, and idempotent install. Keep host IDs and marketplace selectors in one place. A failed install yields a clear warning, not a failed `aos init` or a false success.
2. Add one user config preference, `integrations.superpowers.enabled`, with an explicit migration distinction: true for new installs unless `--no-superpowers`; false when the key is absent on pre-feature installs. `aos upgrade` respects it. Expose enable/disable via `aos config` and Settings, with an install/retry action rather than a toggle that merely changes a flag.
3. Invoke the adapter after each selected host's UniDeX plugin step and from `aos hosts add` when a host is added later; do not install on hosts the user did not select. A hostless first install records the preference for later. The app wizard sends the same CLI flag as terminal setup. Add preflight/Finish copy and a per-host result.
4. Add the Chief route to the identity template and to the initial playbook builder. Existing Chiefs get an exact-diff proposal generated by `prompt-updates`; their approved text can name host-specific skill invocation (`/superpowers:...` or `$superpowers:...`) only conditionally, since one host may be unavailable.
5. Add doctor rows, README/install docs, app smoke steps, changelog/tour/What's new, and host tests. No new hooks, MCP tools, model calls, transcript reads, vault write surface, or background agent spawn.

## Host parity

1. **Entry point:** setup or `aos init`; the Chief uses Superpowers during a normal coding session after installation. CLI enable/retry available on either host.
2. **Hooks:** none added by UniDeX. Codex does not need new agenticos hook trust for this feature.
3. **Model calls:** none from the integration. Superpowers uses the model of the interactive host; provider `none` does not affect this.
4. **Session data:** none read by the integration. The Chief's existing injection still uses UniDeX's host-neutral path.
5. **MCP:** none added.
6. **Degradation:** install failure is a doctor/Finish warning with a manual command; older Codex direct mode has the explicit D4 warning and no Superpowers.
7. **Docs:** README everyday workflow, `docs/install.md` Hosts and setup, `docs/app-smoke.md` per host, app e2e coverage row.

| Mode | How the user invokes it | What runs | What they see if it cannot |
|---|---|---|---|
| Claude Code only | Ask the Chief to build/debug; `/superpowers:<skill>` when explicit | Official Claude plugin installed at first setup | Doctor and Finish show missing/disabled state and `claude plugin install superpowers@claude-plugins-official` |
| Codex only (plugin) | Ask the Chief to build/debug; `$superpowers:<skill>` when explicit | Official Codex plugin installed at first setup | Doctor and Finish show missing/disabled state and `codex plugin add superpowers@openai-curated-remote` |
| Codex only (direct) | Normal UniDeX skills remain | UniDeX direct wiring; no Superpowers | Doctor shows D4 compatibility gap and Codex upgrade guidance |
| Both | Ask the Chief in either host | Each official plugin installed separately; same Chief route | Per-host status; the working host remains usable |

## Out of scope

- Shipping or modifying upstream Superpowers source, upgrading existing user installs, or invoking Superpowers in headless duties.
- Changing UniDeX's user-approval gates, protected instruction rules, worktree/PR workflow, or host permissions.
- A new autonomous task runner or a new Chief of Staff persona.

## Verification target

Fake-host tests cover first install, opt-out, already installed, disabled, failure, upgrade, old Codex direct mode, and both-host setup. Rehearsals exercise Claude-only and Codex-only plugin mode. App e2e checks the default-on checkbox, opt-out flag, and Finish state. Before shipping, an authenticated fresh-profile smoke must prove noninteractive marketplace installation; the isolated unauthenticated probe could not establish that. A live check uses `aos doctor` after upgrade; no paid model probe is needed to verify plugin installation.
