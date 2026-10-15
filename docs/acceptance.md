# Release acceptance (manual, per release)

Two runs per release, after `release:app` has attached the app (`docs/app-smoke.md`, release procedure):

- §0–§7 on a Mac with Apple silicon, in a **macOS user account that has never had AgenticOS**: a fresh account on the
  maintainer's Mac (System Settings → Users & Groups → Add User; log in as that user) or an account on another Mac.
  Nothing in them may rely on the developer's own account.
- §8 on the maintainer's Mac, whose installed app is the previous release.

Tick every box. Quote paths only in their `$HOME`-relative form, never the absolute home path the installer prints,
and record each run in the table at the end. Criteria are spec §1 and the app's design (2026-10-05-workbench-app);
each block names the one it proves.

## 0. Before you start
- [ ] `ls ~/.claude 2>/dev/null` shows no `agenticos.json`, and `~/AgenticOS` does not exist.
- [ ] Note what this account already finds. Homebrew belongs to the account that installed it (`/opt/homebrew`): this
  account can run what it holds (node, python3, uv, ollama, a global `claude` or `codex`) and the wizard finds them, but
  `brew install` from here fails on its permissions. On such a Mac the wizard's Homebrew fix-its are not exercised;
  its login fix-its are. A Mac with no Homebrew exercises them all.

## 1. Download → wizard → Workbench, with no terminal (criterion 1)
Start a timer. Do not open Terminal until the box says so.
- [ ] From `https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v<version>`, download
  `AgenticOS-Workbench-<version>-arm64.dmg`; open it, drag the app to Applications, and open it from there. macOS asks
  once whether to open an app downloaded from the internet, and shows no "cannot be checked for malicious software"
  dialog (the app and the DMG are notarized).
- [ ] The setup wizard opens on **Check**: Homebrew (optional; the fix-its use it), Node, Claude Code, Codex and their
  logins, Ollama, Ollama's models, Python and uv. Run the fix-it of each missing row (a login opens the browser; the row
  turns green when its terminal exits). Record which ran: ______. **Continue** enables once every required row is green
  and at least one host is logged in; the **Ollama's models** row never holds it up.
- [ ] Ollama ends with its two models downloaded, about 7.2 GB together (`qwen3.5:9b` 6.6 GB, `qwen3-embedding:0.6b`
  639 MB): **Install Ollama and its models** starts its service, waits for it to answer and pulls both. With no Ollama,
  that fix runs the download too, so Continue waits for it; **Stop** after the brew install ends the job and leaves the
  models to the **Download the models** row. With Ollama already installed, the **Ollama's models** row warns (`!`)
  while one is missing, and **Download the models** pulls only that one. The row is green before you continue.
- [ ] **Choose**: the ready hosts (both, when both are); the vault folder `~/AgenticOS`.
- [ ] **Your agent**: name `Atlas`, address `boss`, voice `dry`, priorities `tests`, model and effort default, schedule
  `yes`.
- [ ] **Install** runs `aos init` with its output live; when it exits 0 the wizard moves on to **Finish** ("Almost
  there") by itself. If it stops with an error instead, the step reads `aos init stopped (exit N)` and the box fails.
- [ ] **Finish**: with Claude Code, the `CLAUDE.md` diff; **Add the line** → `~/.claude/CLAUDE.md` ends with an
  `@…/AgenticOS/AGENTICOS.md` line carrying the **absolute** vault path (do not paste it anywhere). With Codex, the
  `/hooks` step is shown.
- [ ] **Open the Workbench**: it opens on Home (Chat once a provider is set up, else Pulse), Pulse has no LED red, and
  the welcome tour starts on the rail (a new install never sees the note **UniDeX is an app now**); Esc leaves it. Gray "disabled" for auto-cost and embeddings is correct, and amber `stale` is expected for any
  stage whose last run has aged out — `scan-vault`, `build-brain-md` and the heartbeat go stale 45 minutes after they
  ran. Only red is a failure.
- [ ] Timer under 10:00 → record the time: ______
- [ ] Now open Terminal: `export PATH="$HOME/.local/bin:$PATH"` (append the same line to `~/.zprofile`); `which aos`
  prints the `.local/bin/aos` symlink under your home; `aos doctor` exits 0, and its `workbench app` row reads
  `UniDeX <version>`.
- [ ] `ls ~/AgenticOS` shows no `.obsidian`.
- [ ] `ls ~/AgenticOS/persona` shows `IDENTITY.md STATE.md PLAYBOOK.md duties proposals journal answers.json autoapply.json` — and no `identity.template.md` or `STATE.template.md`; `grep -c Atlas ~/AgenticOS/persona/IDENTITY.md` ≥ 1.
- [ ] `ls ~/Library/LaunchAgents | grep agenticos` lists the three plists; `launchctl list | grep com.agenticos` shows them loaded.
- [ ] `cd ~ && claude`, first prompt `what do you know about me?` → the reply shows it received `<persona>` (mentions Atlas) and `<brain-context>`.
- [ ] `/wrap` in that session → `~/AgenticOS/brain/memory/` gains at least one file and `MEMORY.md` one line.
- [ ] In a new session: `use the agenticos recall tool to search for "Atlas"` → the `recall` tool of the `agenticos` MCP server — exposed to Claude Code as `mcp__plugin_agenticos_agenticos__recall` (contract §0) — answers (hits or an empty result, no error).
- [ ] ⌘Q the app and open it again: it goes straight to the Workbench (no wizard, no welcome tour, no "UniDeX is an app now" note).

## 2. Ollama auto-switch (criterion 2)
`aos status` only reads the cached `brain/_index/provider-state.json` and never probes; `aos scan-vault --quiet` resolves the provider and rewrites that file, so run it before every status check below.
- [ ] Ollama is installed with its two default tags, which the wizard downloaded in section 1. On a machine set up from a terminal, install Ollama (ollama.com) and pull them by hand — `ollama pull qwen3.5:9b && ollama pull qwen3-embedding:0.6b` (workhorse, embedder, about 7.2 GB together; `brain/scripts/sdk/lib/models.js` is the source of truth if they change) — and keep `ollama serve` running. The reasoner is a Claude model and needs only the Claude login.
- [ ] Without editing any file: `aos scan-vault --quiet && aos status` shows provider `ollama`.
- [ ] End a Claude Code session; within a minute `~/AgenticOS/brain/_index/pipelines.json` shows `auto-wrap` with `"provider": "ollama"` and status `ok`.
- [ ] Stop Ollama; after 60 s, `aos scan-vault --quiet && aos status` shows `claude` (or `none` if not logged in).

## 3. Privacy gate (criterion 3)
The rest of the run needs a clone: `git clone https://github.com/zzoretich/UniDeX-Agent-Harness ~/AgenticOS-Workbench && cd ~/AgenticOS-Workbench && npm ci --ignore-scripts` (the command `docs/install.md` and CI use) finishes without error.
- [ ] `cd ~/AgenticOS-Workbench && npm run gate` → `privacy-gate: 0 violation(s)`, and `node tools/privacy-gate.js --json` prints `[]`. This is the pass condition: the gate scans every tracked and untracked-not-ignored file for every term `tools/privacy-terms.js` loads (the public `tools/privacy-terms.json` plus the maintainer's private list; `npm run gate -- --require-private` fails when the private list is missing).
- [ ] Cross-check the exception table: `cat tools/privacy-exceptions.json` shows exactly eight rows: the gate's two data files, `tools/privacy-terms.json` and `tools/privacy-exceptions.json` (term `*`); the example agent name, in `cli/aos.js` and `docs/chief-of-staff.md`; and the maintainer's credit, in `README.md`, `tools/brand-assets.js`, `tools/brand-assets.test.js` and `docs/assets/banner.svg`. Any other row blocks the release. (The launcher and the CLI probe `$HOME`-relative node paths, and the GitHub source `zzoretich/UniDeX-Agent-Harness` is not a term, so neither needs a row.)
- [ ] GitHub Actions: for the release commit, the `privacy` run (the gate with the maintainer's private terms, on every push to `main` and every pull request) is green, and so is the `ci` run (tests on Ubuntu and macOS, the install rehearsals and the app); the `release` run for the `v*` tag (Ubuntu only) shows its own gate step green in the `build` job, and the `publish` job created the release with the version's `CHANGELOG.md` section as its notes. The release's assets are what `release:app` uploaded: `AgenticOS-Workbench-<version>-arm64.dmg`, `AgenticOS-Workbench-<version>-arm64.zip` and its `.zip.blockmap`, and `latest-mac.yml`, and nothing else.

## 4. Test suites offline (criterion 4)
- [ ] Turn Wi-Fi off. `npm test` → three aggregates, each `ℹ fail 0`: tools+cli, brain (`brain/scripts`), plugin (`obsidian-plugin`).
- [ ] Note: `cli/plugin-manifests.test.js` skips its `claude plugin validate` case whenever `claude` is not on PATH (this is what every hosted CI runner does, so the same case shows as skipped in Actions). §0 installed Claude Code here, so on this account the case runs instead of skipping; a `skipped` line for it means PATH, not a failure.
- [ ] `(cd extras/cost && python3 -m unittest 2>&1 | /usr/bin/grep -E "^(Ran|OK|FAILED)")` → `Ran <n> tests` with **n ≥ 1** and `OK` (the exact `<n>` drifts between releases; `Ran 0 tests` also prints `OK` on macOS system python, so a zero count means discovery broke and is a failure; `FAILED` is the other failure).
- [ ] Turn Wi-Fi on.

## 5. Uninstall (criterion 5)
- [ ] `node ~/AgenticOS-Workbench/cli/aos.js uninstall --keep-vault` (no prompt — `--keep-vault` never asks; it prints `kept vault …`).
- [ ] `ls ~/.claude` shows no `agenticos.json`; `plugins/` survives (Claude Code's own plugin cache — the plugin install created it, and uninstall removes the plugin through `claude` but never that directory); `claude plugin list` no longer lists `agenticos`; `ls ~/Library/LaunchAgents | grep agenticos` prints nothing; `launchctl list | grep com.agenticos` prints nothing. (Claude Code's own per-session folders — `session-env/`, `file-history/`, `projects/` — are not AgenticOS's and stay.)
- [ ] `~/AgenticOS` is intact (memory, persona, notes present).
- [ ] Open the app: with no `agenticos.json` it shows the setup wizard again. Quit it (⌘Q).
- [ ] `cd ~/AgenticOS-Workbench && npm run setup -- --yes` (no prompts: with `--yes` the interview reuses the kept vault's `persona/answers.json`, so the persona — and its schedules — come back without questions), then `aos uninstall` **without** `--keep-vault`. The prompt reads `Type the vault path to DELETE it, anything else keeps it (<vault>): ` and shows the **absolute** path — type that back exactly as printed (typed at the prompt only — never pasted into the release PR), not the `~/AgenticOS` form used elsewhere in this runbook; anything else keeps the vault. Afterwards `~/AgenticOS` is gone.

## 6. Cost module and persona commands (spec §10–11)
§5 removed the vault, so re-install first, this time from the terminal: `cd ~/AgenticOS-Workbench && npm run setup`, answering the interview exactly as in §1 (schedule `yes`), and add the `@…/AGENTICOS.md` line it prints to `~/.claude/CLAUDE.md` if it is not there; `aos doctor` exits 0. Open the app: it goes straight to the Workbench.
- [ ] `aos cost enable --budget 100` → prints `cost: enabled (python3 <version>); analyzer installed at <vault>/brain/scripts/cost; monthly budget $100`; `ls ~/AgenticOS/brain/scripts/cost` shows exactly the three files `analyze_transcript.py pricing.json report-template.html`; `grep monthlyBudget ~/AgenticOS/brain/config.json` shows 100.
- [ ] End a Claude Code session; `pipelines.json` shows `auto-cost` status `ok`; `node ~/AgenticOS/brain/scripts/cost-budget.js` prints a MONTH-TO-DATE line with `/ $100.00`.
- [ ] `aos cost disable` → next session end shows `auto-cost` status `disabled`.
- [ ] `sh ~/AgenticOS/brain/scripts/persona/run-duty.sh monitor --dry-run` prints the invocation one argv element per line, including `--model`, `--effort` followed by `medium` on the next line, and `--max-budget-usd`.
- [ ] `sh ~/AgenticOS/brain/scripts/persona/run-duty.sh monitor` (real run, costs a few cents — the repo's `cli/fixtures/fake-claude.sh` prints nothing for `-p`, so this live run is the only end-to-end proof of a duty): the journal `~/AgenticOS/persona/journal/<today>.md` gains a `duty: monitor` entry; `~/AgenticOS/brain/_index/provider-spend.jsonl` gains a row with `"feature":"duty:monitor"`; `STATE.md` `## Last Duty Runs` shows `monitor: <today>`; `node ~/AgenticOS/brain/scripts/persona/record-spend.js --check` prints `"allowed":true` with `"perDayUsd":6`.
- [ ] `aos persona rename Beacon` → `head -8 ~/AgenticOS/persona/IDENTITY.md` shows `# Beacon`; `grep -c Beacon ~/Library/LaunchAgents/com.agenticos.monitor.plist` = 1.
- [ ] `aos persona off` → a new Claude session shows no `<persona>` block; `aos persona on` restores it.
- [ ] In Claude Code: say `sitrep` (the `persona-sitrep` skill — also reachable as `/agenticos:persona-sitrep`; there is no `/sitrep` command) → it renders the Output shape with one recommended action; `review persona flags` (the `persona-flag-closer` skill) either reports `Nothing pending — no proposals, no flags, no new failures.` or lists whatever the monitor duty flagged. Both pass: the live run in the box above rewrote `STATE.md`, so its `## Flags` may legitimately hold open items (a duty that failed leaves a FAILED flag there).

## 7. The Workbench under each provider
- [ ] With Ollama running: Pulse, Files, Spaces, Memory, Runs, Chat (answers) and Code (a live shell) all render.
- [ ] With Claude logged in (Ollama running or not): Chat's header names the reasoner — `claude (claude-opus-5, capped)` — each answer shows a per-message cost, and `aos status` counts it on the `(reasoner)` line.
- [ ] `aos provider none`: Chat tab hidden with the hint; nothing red.


## 8. The update from the previous release (the maintainer's Mac)
The installed app is the previous release's (or a signed local build of it with the zip target, so it carries
`app-update.yml`), signed by the same team: the updater installs only an update signed like the running app.
- [ ] The app menu ▸ About shows the previous version (the menu carries the running app's name: AgenticOS Workbench
  before 1.1, UniDeX from 1.1). Check for Updates… in that menu (or 30 s after launch) finds `<version>` and downloads it; the status bar shows `⬆ Restart to update to <version>`.
- [ ] **Restart to update**: the app quits, comes back, and About shows `<version>`. Leave it closed until it comes back
  (about 15 s): ShipIt checks the update first, and if UniDeX is opened again meanwhile (from the Dock, say) it cancels
  the install (`App Still Running Error` in `ShipIt_stderr.log`) and the previous version opens.
- [ ] From 1.0.x to 1.1 or later (UniDeX D2): Squirrel moves the bundle to `/Applications/UniDeX.app` and, this once,
  does not reopen it (its relauncher lived in the old bundle; `~/Library/Caches/com.zzoretich.agenticos-workbench.ShipIt/ShipIt_stderr.log`
  shows `posix_spawn: No such file or directory`). Open UniDeX from Applications: the Dock, the app menu, About and the
  menubar tooltip read UniDeX, the menubar item is the UDX mark, and App settings, the vault, its notes and the
  Workbench's tab are as they were before the update.
- [ ] **Update the runtime in your vault** follows on its own (the vault's runtime is the previous version): **Update
  now** runs `aos upgrade` with its output and ends `Updated to <version>.`
- [ ] `aos routines sync` when the release's **Upgrading** notes ask for it; `aos doctor` exits 0, its `workbench app` row
  reads `UniDeX <version>`, and every enabled host's block is green (Codex: re-trust under `/hooks` if
  `codex hooks trusted` counts fewer than all).

Result: ______ (pass / fail with the failing box numbers). Tester: ______ Date: ______

## Recorded runs

| Release | Date | §0–§7 fresh account | §8 update | Notes |
|---|---|---|---|---|
| 1.0.0 | 2026-10-06 | pass, §0–§7 in full, on another Mac | pass: 0.21.0 → 1.0.0 (Restart to update, then **Update now** took the runtime to 1.0.0); the 12 Obsidian-era settings were copied; `aos routines sync` and `aos doctor` green | §1: every wizard row was green on **Check**, so no fix-it ran there. `release:app` threw at its feed step (electron-builder 26 lists only the zip); the four assets were uploaded by hand, and #73 fixed it |
| 1.6.0 | 2026-10-09 | not run | pass: **Check for Updates…** found 1.6.0 and staged it (the staged zip's sha512 matched `latest-mac.yml`); **Restart to Update** installed it, and the runtime upgrade the app offered took the vault to 1.6.0. `aos doctor`: `workbench app  UniDeX 1.6.0`, both plugins 1.6.0, codex hooks 16 of 16; its one warning (the `reflect-daily` routine had failed) is not about the update. | Tag `v1.6.0` at `61f20cf`: the rail in three sections, Term renamed Code, the Code page that fits (#114). `release:app` ran end to end (`verify-dist` 39/39); both install rehearsals passed before the tag. |
| 1.7.0 | 2026-10-11 | not run | pass: the installed 1.6.0 updated to 1.7.0 through **Check for Updates…** and **Restart to Update**; the staged zip's sha512 matched `latest-mac.yml` (and the file on disk hashed to it), and the runtime upgrade the app offered took the vault to 1.7.0. `aos doctor`: `workbench app  UniDeX 1.7.0`, all checks passed. | Tag `v1.7.0` at `6de334b`: the Spaces redesign (#116 data layer, #117 three panes, #118 actions). `release:app` ran end to end (`verify-dist` 39/39; the app and the DMG notarized and stapled); both install rehearsals passed before the tag, and the workspace verbs' live check on both hosts was recorded before #118 merged. |
| 1.8.0 | 2026-10-11 | not run | pass: the installed 1.7.0 updated to 1.8.0 through **Check for Updates…** and **Restart to Update**; the staged zip's sha512 matched `latest-mac.yml` (and the file on disk hashed to it). The vault's runtime was already 1.8.0 (`aos upgrade --from-local` before the update), so the app offered no runtime upgrade and **Update now** was not exercised. `aos doctor`: `workbench app  UniDeX 1.8.0`, both plugins 1.8.0, all checks passed. | Tag `v1.8.0` at `09d7419`: the Brain hub (#120 runtime and `aos memory`, #121 Review, Library, the brain surface and Pulse's Brain tile, #122 retired rules leave sessions). `release:app` ran end to end (`verify-dist` 39/39; the app and the DMG notarized and stapled); both install rehearsals passed before the tag, and the brain surface's live check on both hosts was recorded before #121 merged. |
| 1.9.0 | 2026-10-12 | not run | pass: the installed 1.8.0 found 1.9.0 and staged it (the staged zip's sha512 matched `latest-mac.yml`); **Restart to Update** installed it (Gatekeeper: accepted, Notarized Developer ID), and one runtime upgrade took the vault and both plugins to 1.9.0. `aos doctor`: `workbench app  UniDeX 1.9.0`, both plugins 1.9.0, codex hooks 16 of 16, all checks passed. | Tag `v1.9.0` at `a35dfa8`: the Brain hub's Bootstrap, Map and Health with `aos memory fix` (#124), the first-prompt injection fix (#125, confirmed live on both hosts: a Claude Code session after `/clear` and a Codex session each logged `injected` usage rows), and Merge with AI, Undo merge and the consolidation sweep (#127). ci on `a35dfa8` and `release.yml` passed; Merge and the sweep had their live check per host with real calls before #127 merged. |
| 1.2.0 | 2026-10-07 | not run | pass on the third **Restart to update**: **Check for Updates…** found 1.2.0 and staged it. The first two restarts were cancelled: UniDeX was opened again from the Dock 1–1.5 s after it quit, while ShipIt was still checking the update, and ShipIt stopped with `App Still Running Error` (`SQRLInstallerErrorDomain` -9), leaving 1.1.0 in place. The third time it was left closed: ShipIt installed 1.2.0 and reopened it itself (`Successfully launched application`). **Update now** took the runtime to 1.2.0. `aos doctor`: all checks passed, `workbench app  UniDeX 1.2.0`, both plugins 1.2.0, codex hooks 16 of 16. | Tag `v1.2.0` at `9bcff82`, after #94 fixed main's red todo-writes e2e. `release:app` ran end to end (`verify-dist` 39/39). The Restart to update box now says to leave the app closed until it comes back. |
| 1.1.0 | 2026-10-07 | not run | pass, with two findings: **Check for Updates…** found 1.1.0 and Squirrel installed it, moving `AgenticOS Workbench.app` to `UniDeX.app`. Its relaunch failed (`posix_spawn: No such file or directory` on the old bundle's ShipIt), so UniDeX was opened by hand. LaunchServices names it UniDeX, Gatekeeper accepts it (Notarized Developer ID), and it kept the same data folder (`attach.json` and the HUD settings unchanged). **Update now** took the runtime to 1.1.0. `aos doctor` exit 0: `workbench app  UniDeX 1.1.0`, both plugins 1.1.0, codex hooks 16 of 16. | D2 expected the old file name to stay; the notes and this checklist are corrected. Later updates keep `UniDeX.app` and relaunch as before. |
| 1.0.1 | 2026-10-06 | not run | pass: **Check for Updates…** found 1.0.1 and downloaded it in about 150 s (the staged zip's sha512 matched `latest-mac.yml`), Restart to update, the runtime upgrade; `aos doctor` all green (both plugins 1.0.1, Codex hooks 16 of 16) | `release:app` ran end to end (`verify-dist` 39/39). The wizard's Ollama models step (#77) is new in 1.0.1 and has had no fresh-account run yet |
