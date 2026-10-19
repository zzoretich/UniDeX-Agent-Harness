# Release acceptance (manual, per release)

Two runs per release, after `release:app` has attached the app (`docs/app-smoke.md`, release procedure):

- §0–§7 on a Mac with Apple silicon, in a **macOS user account that has never had AgenticOS**: a fresh account on the
  maintainer's Mac (System Settings → Users & Groups → Add User; log in as that user) or an account on another Mac.
  Nothing in them may rely on the developer's own account.
- §8 on the maintainer's Mac, whose installed app is the previous release.

Tick every box. Quote paths only in their `$HOME`-relative form, never the absolute home path the installer prints,
and record each run in the table at the end. Criteria are spec §1, the app's design (2026-10-05-workbench-app) and 2.0's
(2026-10-14-local-first, -install-and-import, -guided-tour); each block names the one it proves.

## 0. Before you start
- [ ] `ls ~/.claude 2>/dev/null` shows no `agenticos.json`, and `~/AgenticOS` does not exist.
- [ ] Note what this account already finds: `ls /opt/homebrew/bin /usr/local/bin ~/.local/bin 2>/dev/null | grep -E '^(node|uv|ollama|claude|codex)$'`
  and `ls -d /Applications/Ollama.app 2>/dev/null`. The 2.0 criterion (install-import B1) is an install with **no
  Homebrew and no Node** beforehand: run §1 where that prints nothing (a Mac without Homebrew, or an account on another
  Mac). The wizard also looks in `/opt/homebrew/bin` and `/usr/local/bin`, so on a Mac where another account installed
  Homebrew it finds and uses that account's tools, and their downloads are not exercised; say so under Notes.

## 1. Download → wizard → Workbench, with no terminal (criterion 1; install-import B1, B2, B13, B14)
Start a timer. Do not open Terminal until the box says so.
- [ ] From `https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v<version>`, download
  `AgenticOS-Workbench-<version>-arm64.dmg`; open it, drag the app to Applications, and open it from there. macOS asks
  once whether to open an app downloaded from the internet, and shows no "cannot be checked for malicious software"
  dialog (the app and the DMG are notarized).
- [ ] The setup wizard opens on **Check** with eight rows: Node.js 20 or newer and uv (required, ✗), Ollama and Ollama's
  models (warnings, `!`), Claude Code, Claude Code login, Codex CLI and Codex login (optional, ○). No Homebrew row, no
  Python row. **Continue** is off until Node and uv are green.
- [ ] **Install what's missing** runs Node, uv, Ollama and its models one after another, each with a progress bar, and the
  terminal says `Checked: …` for each download before it installs. Then **Install Claude Code** (and/or **Install
  Codex**) and **Log in** (its command runs in the wizard's terminal; a login opens the browser, and the row turns green
  when the terminal exits). Record which ran: ______. Afterwards `~/.local/share/unidex/node/current/bin/node`,
  `~/.local/bin/uv`, `/Applications/Ollama.app` (or `~/Applications`) and `~/.local/bin/claude` / `~/.local/bin/codex`
  exist (checked in §1's Terminal box), and Ollama has this Mac's models: `qwen3.5:4b` under 12 GB of memory, else
  `qwen3.5:9b`, plus `qwen3-embedding:0.6b`. Neither Ollama nor its models ever holds Continue up.
- [ ] **Choose**: the ready hosts (both, when both are), with **No agent CLI yet** offered too; the vault folder
  `~/AgenticOS`.
- [ ] **Your agent**: name `Atlas`, address `boss`, voice `dry`, priorities `tests`, the duty model preselected per host
  (Claude Code · `claude-opus-5-5`, Codex · `gpt-6-sol`), effort default, schedule `yes`.
- [ ] **Install** runs `aos init` with its output live; when it exits 0 the wizard moves on by itself. If it stops with
  an error instead, the step reads `aos init stopped (exit N)` and the box fails.
- [ ] **Your history**: on a fresh account the hosts have left nothing, so the step is skipped and **Finish** says
  "Nothing to import yet". (On a Mac with history, the table lists it per host, all ticked; **Import** shows its
  progress.)
- [ ] **Finish** ("Almost there"): with Claude Code, the `CLAUDE.md` diff; **Add the line** → `~/.claude/CLAUDE.md`
  ends with an `@…/AgenticOS/AGENTICOS.md` line carrying the **absolute** vault path (do not paste it anywhere). With
  Codex, the `/hooks` steps. **Add aos to my PATH** is ticked and shows the line for `~/.zprofile`; leave it ticked.
- [ ] **Open the Workbench**: it opens on Home (Pulse) with no LED red, and the welcome tour starts on the rail (a new
  install never sees the note **UniDeX is an app now**); → walks its ten stops, and it ends on **Getting started** at
  the rail's foot (Esc leaves it early). Gray "disabled" for auto-cost is correct, and amber `stale` is expected for any
  stage whose last run has aged out — `scan-vault`, `build-brain-md` and the heartbeat go stale 45 minutes after they
  ran. Only red is a failure.
- [ ] Timer under 10:00 (the model download excepted, if your connection is slow) → record the time: ______
- [ ] Now open Terminal (a new window, so it reads `~/.zprofile`): `tail -1 ~/.zprofile` is
  `export PATH="$HOME/.local/bin:$PATH"`; `which aos` prints the `.local/bin/aos` symlink under your home; `aos doctor`
  exits 0, its `workbench app` row reads `UniDeX <version>`, its `local engine` and `local model` rows are ok, and its
  `persona runner` row names `claude-opus-5-5` (or `gpt-6-sol` on a Codex-only account).
- [ ] `ls ~/AgenticOS` shows no `.obsidian`.
- [ ] `ls ~/AgenticOS/persona` shows `IDENTITY.md STATE.md PLAYBOOK.md duties proposals journal answers.json autoapply.json` — and no `identity.template.md` or `STATE.template.md`; `grep -c Atlas ~/AgenticOS/persona/IDENTITY.md` ≥ 1.
- [ ] `ls ~/Library/LaunchAgents | grep agenticos` lists `com.agenticos.<slug>` for briefing, heartbeat, import-digest,
  monitor, reflect, reflect-daily, sitrep and tick (import-digest's goes once its first run finds nothing to digest);
  `launchctl list | grep com.agenticos` shows them loaded.
- [ ] `cd ~ && claude`, first prompt `what do you know about me?` → the reply shows it received `<persona>` (mentions Atlas) and `<brain-context>`.
- [ ] `/wrap` in that session → `~/AgenticOS/brain/memory/` gains at least one file and `MEMORY.md` one line.
- [ ] In a new session: `use the agenticos recall tool to search for "Atlas"` → the `recall` tool of the `agenticos` MCP server — exposed to Claude Code as `mcp__plugin_agenticos_agenticos__recall` (contract §0) — answers (hits or an empty result, no error).
- [ ] ⌘Q the app and open it again: it goes straight to the Workbench (no wizard, no welcome tour, no "UniDeX is an app now" note).

## 2. Background work on this Mac (criterion 2; local-first A1, A3, A18)
`aos status` only reads the cached `brain/_index/provider-state.json` and never probes; `aos scan-vault --quiet` resolves the provider and rewrites that file, so run it before every status check below.
- [ ] `aos scan-vault --quiet && aos status` shows `provider   mode=local resolved=ollama (local-ready, …)` and a
  `local` line naming this Mac's model; `aos local` shows the engine answering, the models pulled and this Mac's tier.
  On a machine set up from a terminal, install Ollama (ollama.com) and run `aos local pull` first.
- [ ] End a Claude Code session; within a minute `~/AgenticOS/brain/_index/pipelines.json` shows `auto-wrap` with
  `"provider": "ollama"` and status `ok`, `aos status`'s `local` line counts more calls today, and
  `brain/_index/provider-spend.jsonl` has no new row (a local call is never ledgered).
- [ ] Quit Ollama (its menu ▸ Quit); after 60 s, `aos scan-vault --quiet && aos status` shows `resolved=none (local-down,
  …)`. End a Claude Code session: `aos doctor` shows `wraps queued` (`local model down: 1 wrap queued …`) and nothing
  spent. Open Ollama again: the next session start (or the Workbench reloading) runs the queued wrap, and the row goes.


## 3. Privacy gate (criterion 3)
The rest of the run needs a clone. On an account with no Node of its own (§0), the wizard's Node is not on PATH (only
`aos` and the hosts are, in `~/.local/bin`): first run `export PATH="$HOME/.local/share/unidex/node/current/bin:$PATH"`
(it carries `npm`) in that terminal, and in the terminals of §4–§6. The first `git` may ask to install the Command Line
Tools; accept. Then `git clone https://github.com/zzoretich/UniDeX-Agent-Harness ~/AgenticOS-Workbench && cd ~/AgenticOS-Workbench && npm ci --ignore-scripts` (the command `docs/install.md` and CI use) finishes without error.
- [ ] `cd ~/AgenticOS-Workbench && npm run gate` → `privacy-gate: 0 violation(s)`, and `node tools/privacy-gate.js --json` prints `[]`. This is the pass condition: the gate scans every tracked and untracked-not-ignored file for every term `tools/privacy-terms.js` loads (the public `tools/privacy-terms.json` plus the maintainer's private list; `npm run gate -- --require-private` fails when the private list is missing).
- [ ] Cross-check the exception table: `cat tools/privacy-exceptions.json` shows exactly eight rows: the gate's two data files, `tools/privacy-terms.json` and `tools/privacy-exceptions.json` (term `*`); the example agent name, in `cli/aos.js` and `docs/chief-of-staff.md`; and the maintainer's credit, in `README.md`, `tools/brand-assets.js`, `tools/brand-assets.test.js` and `docs/assets/banner.svg`. Any other row blocks the release. (The launcher and the CLI probe `$HOME`-relative node paths, and the GitHub source `zzoretich/UniDeX-Agent-Harness` is not a term, so neither needs a row.)
- [ ] GitHub Actions: for the release commit, the `privacy` run (the gate with the maintainer's private terms, on every push to `main` and every pull request) is green, and so is the `ci` run (tests on Ubuntu and macOS, the install rehearsals and the app); the `release` run for the `v*` tag (Ubuntu only) shows its own gate step green in the `build` job, and the `publish` job created the release with the version's `CHANGELOG.md` section as its notes. The release's assets are what `release:app` uploaded: `AgenticOS-Workbench-<version>-arm64.dmg`, `AgenticOS-Workbench-<version>-arm64.zip` and its `.zip.blockmap`, and `latest-mac.yml`, and nothing else.

## 4. Test suites offline (criterion 4)
- [ ] Turn Wi-Fi off. `npm test` → three aggregates, each `ℹ fail 0`: tools+cli, brain (`brain/scripts`), the HUD (`hud`).
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
- [ ] `sh ~/AgenticOS/brain/scripts/persona/run-duty.sh monitor` (real run on the Chief of Staff's model, capped at `persona.perDutyUsd`, 2.00 USD — the repo's `cli/fixtures/fake-claude.sh` prints nothing for `-p`, so this live run is the only end-to-end proof of a duty): the journal `~/AgenticOS/persona/journal/<today>.md` gains a `duty: monitor` entry; `~/AgenticOS/brain/_index/provider-spend.jsonl` gains a row with `"feature":"duty:monitor"`; `STATE.md` `## Last Duty Runs` shows `monitor: <today>`; `node ~/AgenticOS/brain/scripts/persona/record-spend.js --check` prints `"allowed":true` with `"perDayUsd":6`.
- [ ] `aos persona rename Beacon` → `head -8 ~/AgenticOS/persona/IDENTITY.md` shows `# Beacon`; `grep -c Beacon ~/Library/LaunchAgents/com.agenticos.monitor.plist` = 1.
- [ ] `aos persona off` → a new Claude session shows no `<persona>` block; `aos persona on` restores it.
- [ ] In Claude Code: say `sitrep` (the `persona-sitrep` skill — also reachable as `/agenticos:persona-sitrep`; there is no `/sitrep` command) → it renders the Output shape with one recommended action; `review persona flags` (the `persona-flag-closer` skill) either reports `Nothing pending — no proposals, no flags, no new failures.` or lists whatever the monitor duty flagged. Both pass: the live run in the box above rewrote `STATE.md`, so its `## Flags` may legitimately hold open items (a duty that failed leaves a FAILED flag there).

## 7. The Workbench under each provider
- [ ] Provider `local` with Ollama running: Pulse, Files, Spaces, Brain, Runs, Sessions and Code (a live shell) all
  render; in Sessions, Vault answers on this Mac (its line reads `This Mac (<model>, no spend)`), and Settings ▸ Local
  engine shows the engine answering, the model downloaded and today's local calls.
- [ ] `aos config set ai.chat host` with Claude logged in: Vault's line reads `claude (claude-opus-5, capped)`, each
  answer shows a per-message cost, and `aos status` counts them on the `(reasoner)` line. `aos config unset ai.chat` puts it back.
- [ ] `aos provider auto`, then `aos provider none`: nothing red; Sessions stays on the rail (it follows the signed-in
  hosts, not the provider). `aos provider local` puts it back.


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

**From 1.x to 2.0** (local-first A9, install-import B12, tour C11; [migrating-to-2.0.md](migrating-to-2.0.md)). Note
`aos config get provider` and `aos config get persona.model` before the update (`auto` and `null` on a 1.x install).
- [ ] **Update now**'s output says `pending: local-first, import` and prints the `aos migrate local-first …` and
  `aos import` lines (the app runs it without a terminal, so it asks nothing). `codex hooks trusted` still counts all
  of them afterwards: no hook command changed, so nothing asks under `/hooks`.
- [ ] The launch sequence opens one dialog at a time, in order. First **Run background work on this Mac** (the Go-local
  card): what moves to this Mac and what stays on the hosts, the background spend of the last 7 days, **Download the
  model** when this Mac's model is missing, and a ticked **Move the Chief of Staff to …** worded for the enabled hosts.
  While the app's `migrate` surface is off, the card shows `aos migrate local-first --apply --chief` and `--decline`
  with **❯_ Run in Code** instead of buttons; run the apply one.
- [ ] After going local: `aos migrate --status` lists `local-first` applied (and `import` pending);
  `brain/_index/migrations/local-first-<time>.json` holds the old values; `aos config get provider` is `local` and
  `aos config get persona.model` is `claude-opus-5-5`; `brain/routines/tick.md` is `kind: command` running
  `tick.js --triage` (or, if you had edited it, it is kept and a notification says why); `aos doctor`'s `local engine`
  and `local model` rows are ok and its `persona runner` row names `claude-opus-5-5`.
- [ ] Next, the **Import** sheet ("Bring in your Claude Code and Codex history"): what this Mac's hosts left, per host
  and kind, and the proposed workspaces, all ticked (or, with the `migrate` surface off, `aos migrate import --apply`
  and `--decline` with **❯_ Run in Code**). Import (or run the apply command): `aos migrate --status` lists `import`
  applied, Brain ▸ Review shows an "Imported from Claude Code" (and "Imported from Codex") batch, and Pulse says
  "Digesting history: n of m sessions" while the digest runs.
- [ ] Next, **What's new in 2.0**: five entries, each with **Show me** (one of them runs its steps), and **Got it**; then
  Getting started. ⌘Q and open the app again: none of the four opens again, and Help ▸ What's new still lists them.
- [ ] Undo, then redo: Settings ▸ Local engine ▸ **Undo** (or `aos migrate local-first --undo`) puts `provider` and
  `persona.model` back to what you noted; `aos migrate local-first --apply --chief` goes local again.

Result: ______ (pass / fail with the failing box numbers). Tester: ______ Date: ______

## Recorded runs

| Release | Date | §0–§7 fresh account | §8 update | Notes |
|---|---|---|---|---|
| 1.0.0 | 2026-10-06 | pass, §0–§7 in full, on another Mac | pass: 0.21.0 → 1.0.0 (Restart to update, then **Update now** took the runtime to 1.0.0); the 12 Obsidian-era settings were copied; `aos routines sync` and `aos doctor` green | §1: every wizard row was green on **Check**, so no fix-it ran there. `release:app` threw at its feed step (electron-builder 26 lists only the zip); the four assets were uploaded by hand, and #73 fixed it |
| 1.6.0 | 2026-10-09 | not run | pass: **Check for Updates…** found 1.6.0 and staged it (the staged zip's sha512 matched `latest-mac.yml`); **Restart to Update** installed it, and the runtime upgrade the app offered took the vault to 1.6.0. `aos doctor`: `workbench app  UniDeX 1.6.0`, both plugins 1.6.0, codex hooks 16 of 16; its one warning (the `reflect-daily` routine had failed) is not about the update. | Tag `v1.6.0` at `61f20cf`: the rail in three sections, Term renamed Code, the Code page that fits (#114). `release:app` ran end to end (`verify-dist` 39/39); both install rehearsals passed before the tag. |
| 1.7.0 | 2026-10-11 | not run | pass: the installed 1.6.0 updated to 1.7.0 through **Check for Updates…** and **Restart to Update**; the staged zip's sha512 matched `latest-mac.yml` (and the file on disk hashed to it), and the runtime upgrade the app offered took the vault to 1.7.0. `aos doctor`: `workbench app  UniDeX 1.7.0`, all checks passed. | Tag `v1.7.0` at `6de334b`: the Spaces redesign (#116 data layer, #117 three panes, #118 actions). `release:app` ran end to end (`verify-dist` 39/39; the app and the DMG notarized and stapled); both install rehearsals passed before the tag, and the workspace verbs' live check on both hosts was recorded before #118 merged. |
| 1.8.0 | 2026-10-11 | not run | pass: the installed 1.7.0 updated to 1.8.0 through **Check for Updates…** and **Restart to Update**; the staged zip's sha512 matched `latest-mac.yml` (and the file on disk hashed to it). The vault's runtime was already 1.8.0 (`aos upgrade --from-local` before the update), so the app offered no runtime upgrade and **Update now** was not exercised. `aos doctor`: `workbench app  UniDeX 1.8.0`, both plugins 1.8.0, all checks passed. | Tag `v1.8.0` at `09d7419`: the Brain hub (#120 runtime and `aos memory`, #121 Review, Library, the brain surface and Pulse's Brain tile, #122 retired rules leave sessions). `release:app` ran end to end (`verify-dist` 39/39; the app and the DMG notarized and stapled); both install rehearsals passed before the tag, and the brain surface's live check on both hosts was recorded before #121 merged. |
| 1.9.0 | 2026-10-12 | not run | pass: the installed 1.8.0 found 1.9.0 and staged it (the staged zip's sha512 matched `latest-mac.yml`); **Restart to Update** installed it (Gatekeeper: accepted, Notarized Developer ID), and one runtime upgrade took the vault and both plugins to 1.9.0. `aos doctor`: `workbench app  UniDeX 1.9.0`, both plugins 1.9.0, codex hooks 16 of 16, all checks passed. | Tag `v1.9.0` at `a35dfa8`: the Brain hub's Bootstrap, Map and Health with `aos memory fix` (#124), the first-prompt injection fix (#125, confirmed live on both hosts: a Claude Code session after `/clear` and a Codex session each logged `injected` usage rows), and Merge with AI, Undo merge and the consolidation sweep (#127). ci on `a35dfa8` and `release.yml` passed; Merge and the sweep had their live check per host with real calls before #127 merged. |
| 2.1.0 | 2026-10-17 | not run | pass: the installed app, on the previous release (2.0.0), found 2.1.0 and staged it (the staged zip's sha512 matched `latest-mac.yml`); **Restart to Update** installed it, and the runtime upgrade the app offered took the vault and both plugins to 2.1.0. `aos doctor`: `workbench app  UniDeX 2.1.0`, both plugins 2.1.0, codex hooks 16 of 16; its two warnings (the graph's semantic pass timed out, two routines missed a run) are not about the update. | Tag `v2.1.0` at `6269177`: Files as a Finder window onto the vault (#159 the views, preview, Quick Look and menu; #160 rename in place, drag to move, ⌘Z and links that follow; #161 thumbnails, smart folders, tags and the search scope; #162 a search hit opens at its line). ci on `6269177` and `release.yml` passed; both install rehearsals passed before the tag; `release:app` ran end to end (`verify-dist` 39/39; the app and the DMG notarized and stapled). The manual Files items of `app-smoke.md` on the installed app are still to run. |
| 1.2.0 | 2026-10-07 | not run | pass on the third **Restart to update**: **Check for Updates…** found 1.2.0 and staged it. The first two restarts were cancelled: UniDeX was opened again from the Dock 1–1.5 s after it quit, while ShipIt was still checking the update, and ShipIt stopped with `App Still Running Error` (`SQRLInstallerErrorDomain` -9), leaving 1.1.0 in place. The third time it was left closed: ShipIt installed 1.2.0 and reopened it itself (`Successfully launched application`). **Update now** took the runtime to 1.2.0. `aos doctor`: all checks passed, `workbench app  UniDeX 1.2.0`, both plugins 1.2.0, codex hooks 16 of 16. | Tag `v1.2.0` at `9bcff82`, after #94 fixed main's red todo-writes e2e. `release:app` ran end to end (`verify-dist` 39/39). The Restart to update box now says to leave the app closed until it comes back. |
| 1.1.0 | 2026-10-07 | not run | pass, with two findings: **Check for Updates…** found 1.1.0 and Squirrel installed it, moving `AgenticOS Workbench.app` to `UniDeX.app`. Its relaunch failed (`posix_spawn: No such file or directory` on the old bundle's ShipIt), so UniDeX was opened by hand. LaunchServices names it UniDeX, Gatekeeper accepts it (Notarized Developer ID), and it kept the same data folder (`attach.json` and the HUD settings unchanged). **Update now** took the runtime to 1.1.0. `aos doctor` exit 0: `workbench app  UniDeX 1.1.0`, both plugins 1.1.0, codex hooks 16 of 16. | D2 expected the old file name to stay; the notes and this checklist are corrected. Later updates keep `UniDeX.app` and relaunch as before. |
| 1.0.1 | 2026-10-06 | not run | pass: **Check for Updates…** found 1.0.1 and downloaded it in about 150 s (the staged zip's sha512 matched `latest-mac.yml`), Restart to update, the runtime upgrade; `aos doctor` all green (both plugins 1.0.1, Codex hooks 16 of 16) | `release:app` ran end to end (`verify-dist` 39/39). The wizard's Ollama models step (#77) is new in 1.0.1 and has had no fresh-account run yet |
