# Changelog

All notable changes to UniDeX (AgenticOS Workbench before 1.1). Versions follow the tags. From the next release on, each version's section is also its GitHub release notes, and an **Upgrading** subsection lists anything you need to do after `aos upgrade`.

## [Unreleased]

### Added
- **Files is a Finder window onto your vault.** A sidebar of favorites (the vault, Brain, Memory, Workspaces, the daily notes, Persona), a toolbar with back and forward, and three views: **Icons** (the default: graphite folders with item counts and a coloured tab for brain, workspaces, persona and the daily notes, pages drawn from each note's first lines), **List** (Name · Date Modified · Size · Kind, sortable, folders opening in place) and **Columns** (one column per folder, the file previewed at the end). Switch with the toolbar or ⌃⌘1 ⌃⌘2 ⌃⌘3; Files remembers the view and the sort. The path bar at the foot goes anywhere along the path, and a workspace folder offers **Open in Spaces**. <!-- tour: files.places, files.views, files.count -->
- **Preview and Quick Look in Files.** The preview (Columns' last column, or ⇧⌘P in Icons and List) renders the start of a note and shows its kind, size, dates, tags and how many notes it links to and from. **Space** opens Quick Look over the tab: a note rendered, a text file in mono, an image shown, anything else with **Open with default app**; ← → walk the folder. Files that are not text now open in their own app instead of doing nothing. <!-- tour: files.tree, files.views -->
- **A right-click menu in Files**: Open, Quick Look, Rename, Move to…, Duplicate, New note here…, New folder, Copy path, Copy as [[link]], Reveal in Finder, Open with default app and Move to Trash, for one file or a selection. In the runtime's own folders, which now show a lock, the write items are off and say why. <!-- tour: files.tree -->
- **Drag to move in Files.** Drag a file, or the whole selection, onto a folder in any view, a favorite or a folder in the path bar. Every item is checked before the first one moves, a hint says what the drop will do, and the runtime's own folders refuse the drop and say why. <!-- tour: files.drag -->
- **Links follow a rename or move.** When other notes link to a file you rename or move, Files rewrites those links (`[[name]]`, `[[path]]`, aliases, headings, embeds and relative Markdown links) so they keep working. The rename field shows **Update N links**, on until you turn it off; notes in the runtime's folders are left alone and named. <!-- tour: files.tree, files.drag -->
- **⌘Z in Files** undoes the last move or rename, links included, up to 20 back; the toast after each one has **Undo** too. <!-- tour: files.drag -->
- **New folder and Duplicate in Files.** ⌥⌘N (also under **+** and in the menu) makes an untitled folder and lets you name it; ⌘D makes a copy of a file, or of a folder with everything in it, beside the original. <!-- tour: files.new-note, files.tree -->
- **Thumbnails in Files.** In Icons a PNG, JPEG, GIF, WebP or SVG up to 4 MB shows the picture itself instead of a page, read only once its tile scrolls into view, one at a time, and kept for the 200 last seen; a larger or unreadable image keeps its page. <!-- tour: files.views -->
- **Smart folders and tags in Files' sidebar.** **Recents** lists the last 50 files you opened from Files, ⌘O or Quick Look; **Changed today** what changed since midnight; **Images** every image in the vault (the last two leave out the runtime's own folders). **Tags** lists the 12 tags your notes' frontmatter uses most, and a tag lists its notes. Each shows in Icons, List or Columns, whichever you are in. <!-- tour: files.favorites -->
- **Favorites are yours to change.** Drag a folder onto **Favorites** to add it, or use **Add to Favorites** in its right-click menu; right-click a favorite to remove it or restore the defaults. A favorite you rename or move in Files, and Recents, follow it. <!-- tour: files.favorites -->
- **Search by name, and in this folder.** While you type, a bar under Files' toolbar picks the **Vault** or the folder you are in (or the smart folder or tag), and **Names** (the files and folders whose name holds the text, shown in the view you are in, where they can be selected, previewed and dragged) or **Contents** (each matching line, as before). <!-- tour: files.scope -->

### Changed
- **Files uses Finder's keys.** A click selects (⌘-click and ⇧-click select several, ⌘A all, typing jumps to a name); a double-click or ⌘↓ opens; Return renames; ⌘⌫ moves the selection to the Trash after one confirm; ⌘↑ goes up; ⌘N makes a note here; ⌘F searches. **+ note** and **open…** moved into the toolbar's **+** and **⋯** menus, and the hover ✎ → ✕ became the right-click menu. <!-- tour: files.tree, files.new-note, files.open, files.search -->
- **Rename works in place in Files.** The name becomes a field with the part before the extension selected, checked as you type; Return renames and Escape keeps the name. The rename drawer is gone; Move to… keeps its folder picker and is undone with ⌘Z like a drag. <!-- tour: files.tree -->
- **Files' search opens a hit at its line.** A click or Return on a matching line opens the note scrolled to that line, marked for a moment (a text file at the line itself), and Space shows it in Quick Look there; ↑ ↓ walk the files and lines, and **all text files** moved into the new scope bar. <!-- tour: files.search, files.scope -->
- **Files says where trashed files went.** After Move to Trash the toast says to put them back from the Trash in Finder; the Trash itself cannot hand them back, so there is no Undo for it. <!-- no-tour: a toast's wording, no control of its own -->

### Fixed
- **The Skills and Agents filters keep the cursor when the list redraws under them** (a sync finishing just as you start typing): before, the redraw took the focus away and the letters typed next went nowhere.

## [2.0.0] — 2026-10-16

### Upgrading
- **The update asks you once whether to run background work on your Mac; nothing moves until you say so.** After the runtime update, the app's **Go local** card shows what moves to this Mac and what stays on Claude Code or Codex, what background work spent in the last 7 days, the model download if it is missing, and a ticked **Move the Chief of Staff to Opus 5.5 / gpt-6-sol** (worded for your hosts). **Go local** first backs up every setting it changes (`brain/_index/migrations/`), then sets `provider: local` and the AI switches (`ai.*`) to local in `agenticos.json` and `brain/config.json`, moves the Chief of Staff when ticked, updates the hourly `tick.md` only if it is still the one a release shipped (an edited one is kept, and a notification says why), and re-renders your schedules; no routine of yours is touched. **Keep my settings** changes nothing (`auto` stays `auto`). Settings ▸ Local engine can go local later, or **Undo** it (a setting you changed since is kept). From a terminal, `aos upgrade` asks the same question once (without a terminal it prints the commands), `aos migrate local-first --apply [--chief] | --decline | --undo` does it, and `aos import` brings your history in. Nothing to re-trust: no hook command changed on either host. <!-- tour: settings.go-local -->
- **Your Chief of Staff keeps its model, its effort, its host and its tick until you move it.** Before anything else, `aos upgrade` from 1.x writes into `brain/config.json` what the install runs on for each setting 2.0's defaults would change, where the file does not set it: `persona.model` and `persona.codexModel` stay `null` (the model it ran on: the interview's answer, then `claude.model`; `codex.model`, then your Codex default), `persona.failover` is `false` (a duty stays on its host: under `auto` Claude Code when it is installed, else Codex, as before; a signed-out one is skipped and flagged instead of moving to the other host), and `provider` stays `auto`. Duties keep the interview's effort, and the one daily cap over both hosts is the one 1.x had. Its hourly `tick.md` stays a duty — now skipped properly on a quiet hour. **Move the Chief of Staff** on the Go-local card (`aos migrate local-first --apply --chief`) moves the models to `claude-opus-5-5` / `gpt-6-sol` and turns the failover on; **Undo** puts back what the upgrade kept. <!-- tour: settings.go-local -->
- **A new routine, `import-digest`, arrives with the upgrade.** It does nothing until you import: its first run finds nothing queued, turns itself off and takes its own schedule out. Nothing from your Claude Code or Codex history is imported without you asking.
- **The update offers once to bring in your Claude Code and Codex history.** After Go local, the app's **Import** sheet shows what each host left on this Mac (rules, memories, MCP servers, sessions in the last 90 days) and the project folders it would make workspaces, all ticked; **Import** brings them in on the local model and queues the sessions for the digest, **Not now** imports nothing. With nothing on this Mac to bring, it says so. Settings ▸ Import, `aos import` or `aos migrate import --apply` do it any time. <!-- tour: settings.import -->

### Added
- **The Import sheet** asks an existing install once, per vault, after Go local: counts per host and kind from `aos import --dry-run`, the proposed workspaces to confirm, then **Import** with its progress or **Not now**, through `aos migrate import --apply [--accept …]` / `--decline`, which import and settle the choice in one call. What's new in 2.0 also lists routines that run where you choose. <!-- tour: settings.import, routines.engine -->
- **The 2.0 launch: one dialog at a time, each once.** The first launch after an update opens, in order, the runtime update, the **Go local** card, the **Import** sheet, **What's new in 2.0** (each change with **Show me**, and **Take the full tour** for an install that has not seen the tour), then Getting started; a new install starts with the welcome tour, then Getting started. The note about moving off Obsidian is gone, and Help ▸ What's new keeps the list. <!-- tour: help.menu -->
- **`aos migrate`** applies, declines or undoes what an upgrade asks once: `local-first` (with `--chief` for the Chief of Staff's models; `--undo` restores the backup it took) and `import` (runs `aos import`); `aos migrate --status` lists them. <!-- tour: settings.go-local -->
- **Pulse says when your Chief of Staff waits for a host.** With no host added, the briefing band reads "Add Claude Code or Codex to start your Chief of Staff." with **Add a host**; when today's last duty was skipped because a host is signed out or its CLI is missing, it says which (with ❯_ `aos doctor`), until you sign in or a duty runs. <!-- tour: pulse.waiting-host -->
- **Background work on the model on your Mac: provider `local`.** A new install runs its summaries, memory extraction, workspace insights and file maps, embeddings and the Pulse briefing on a local model and never spends: when the local model can't answer, the work waits or uses heuristics instead of falling back to Claude or Codex (turn on `local.hostedFallback` to allow that, under the same hook caps). "Ready" means the model is pulled, not just that Ollama answers. The local engine is Ollama, or any OpenAI-compatible server such as LM Studio or llama.cpp (`local.engine: openai`, `local.url`). <!-- tour: settings.local -->
- **The model fits the Mac.** Under provider `local`, a Mac with less than 12 GB of memory runs `qwen3.5:4b` (3.3 GB) and others `qwen3.5:9b` (6.6 GB); the model stays loaded between calls from 24 GB, and unloads after five minutes below that. A tier model gives way to another one you already pulled (an 8 GB Mac that has the 9b keeps using it); a model you name with `local.model` never does. `local.embedder` and `local.keepAlive` are settings too. <!-- tour: settings.local -->
- **`aos local`** shows the local engine: whether it answers, the models pulled, this Mac's tier, what background work runs on now (or why nothing does) and today's local calls; `aos local pull` downloads this Mac's model and the embedder through Ollama, and `aos local use <model>` picks another. Under provider `local`, `aos doctor` checks the engine and the model, and `aos status` counts today's local calls. <!-- no-tour: CLI verb (aos local) -->
- **A guided tour, Getting started and Help in the Workbench.** A spotlight dims the app around one real control at a time, says what it does and why it matters, and where a step says click, waits for your click; → and ← move, Esc leaves, and it steps aside while a dialog is open. A new install starts the ten-stop welcome tour (rail, Pulse, Sessions, Code, Brain, Spaces, Routines, the Chief of Staff, ⌘K, Help) instead of the note about moving off Obsidian, and it ends on **Getting started n/m** at the rail's foot: a tour for every tab, Brain mode, the status bar, capture and search, and Help, plus first steps ticked from the runtime's caches (a session, a memory reviewed, a routine of your own, a Chief of Staff). Each tab's first visit offers its tour once as a small chip. **Help** (the rail's ? and the app's Help menu; the same commands are in ⌘P) has Take the tour, Tour this tab, What's new, Getting started and Documentation. Steps name your host (Claude Code, Codex or both) and skip what your Mac does not have. <!-- tour: help -->
- **The AI features run on the local model too.** Under provider `local`, Vault chat, Ask brain, the weekly reflection and Consolidate memory each run on the model on your Mac by default, with a switch of their own in Settings (`ai.chat`, `ai.ask`, `ai.reflectWeek`, `ai.consolidate`: `local` or `host`); Vault chat's chip reads **This Mac**, and a host you pick still answers that question. The Brain hub's consolidation sweep and Merge with AI run there free: the sweep sends brain hub's duplicates and clusters in chunks the model can hold. <!-- tour: sessions.vault-host, settings.local -->
- **The graph's semantic pass on the local model.** Under provider `local` (or `ollama`) the daily pass that adds concepts and links runs on graphify's own local backend at your engine's address: no spend, one chunk at a time, waiting while the Mac is on battery (`local.onBattery`). `aos graph` and `aos doctor` name the engine that reads the notes. <!-- no-tour: background pass; nothing new on screen -->
- **Settings ▸ Local engine** shows the engine and its address, whether it answers, the model and whether it is downloaded, the embedder, today's local calls and any session wraps waiting, with **Pull the model** (or ❯_ `aos local pull` in the Code tab). <!-- tour: settings.local -->
- **When the local model is down, nothing spends unasked.** Session wraps wait in the queue and run when it is back; summaries, insights and file maps use their heuristics; the Pulse briefing shows the facts alone; recall uses keyword search. A button you press offers **Run once on Claude Code / Codex**, naming the cap it counts against. Pulse and `aos doctor` say "local model down: N wraps queued", and `aos status` shows the reason and the queue. <!-- tour: pulse.health, settings.local -->
- **`aos import` brings your Claude Code and Codex history into the vault**, from whatever each host left on disk (its CLI need not be installed), on the local model only. Your global `CLAUDE.md` and Codex's `AGENTS.md` become memories rule by rule, typed user, feedback or reference by the local model (one note per file when it is not ready; an `@` include line, such as the vault's own `AGENTICOS.md` line, is never copied); Claude Code's auto-memory keeps its types; both hosts' MCP servers are listed in `brain/_index/mcp-servers.json` (never their arguments, environment or tokens; no host config is written); folders your sessions ran in, grouped by git repository, are proposed as workspaces (a new one with `repo:` set, or a link to the workspace of the same name) when they had 3 or more sessions or any in the last 14 days, and created only for the ones you pass with `--accept`. Every memory is written `reviewed: false` with `source: import:<host>` and the file it came from, after a duplicate check against your memories, and Brain ▸ Review shows them as one "Imported from Claude Code" and one "Imported from Codex" batch. `--dry-run` writes nothing and prints what it would bring per host and kind (`--json` for the app); `--from`, `--since 90d|all` and `--only` narrow it; a second run writes nothing twice (`brain/_index/import-state.json`). <!-- tour: brain-review.sessions -->
- **The import-digest routine works through your past sessions** (the last 90 days, or `--since all`): every 30 minutes while any wait, up to 10 minutes a run, it asks the local model for a one-line summary, the workspace and at most three memories per session, and writes a `## Sessions` line into that day's daily note (with the resume command), a newest-first `history.md` in the session's workspace, the memories, and `brain/_index/session-digests.json`. It never calls a hosted model: on battery (`local.onBattery: defer`) or with the local model down it waits and spends nothing. A session it digested is marked for auto-wrap, so resuming it later extracts only what is new. When nothing is left it turns itself off. <!-- no-tour: background routine -->
- **`aos hosts add claude|codex` wires a second host into an existing install**: it checks that host's CLI is installed and signed in, turns the host on without touching the other, installs the Claude Code plugin or the Codex plugin (the direct wiring on an older Codex CLI), imports that host's instructions, memories and MCP servers, proposes its project folders, and re-renders the installed schedules. <!-- no-tour: CLI verb (aos hosts add) -->
- **The setup wizard brings in your history.** After the install, **Your history** shows what Claude Code and Codex left on this Mac — per host, the rules in your global instructions, Claude Code's memories, the MCP servers and the sessions of the last 90 days — and the project folders it would make into workspaces, all ticked; **Import** brings in what stays ticked, with its progress, and queues the sessions for the digest, and Finish says what comes next. With nothing on this Mac the step is skipped. <!-- no-tour: the setup wizard runs before the Workbench, where the tour lives -->
- **Settings ▸ Hosts** shows Claude Code and Codex: on or off for this vault, installed, signed in, and the next step — sign in (in a Code terminal), the installer's steps for a CLI that is missing, or **Add Claude Code** / **Add Codex**, which runs `aos hosts add` after asking (off until enabled under the app's write surfaces; the button then points at the Code tab). `aos hosts status [--json]` gives the same from a terminal. <!-- tour: settings.host-list -->
- **Settings ▸ Import** shows each host's last import and what it brought, **Import** (again) per host and **Import older history** (`--since all`), with its progress (or `aos import` in the Code tab). While the digest works through your sessions, Pulse and the panel say how far it is: "Digesting history: 140 of 412 sessions". <!-- tour: settings.import -->
- **The app installs what UniDeX needs, with nothing installed first: no Homebrew, no Node, no terminal.** The setup wizard's checks are Node, uv, Ollama and its models, Claude Code, Codex and their logins, and each missing tool's button downloads a version pinned in the app from its maker, with a progress bar: Node (into `~/.local/share/unidex/node/v<version>` with a `current` link, which `agenticos.json` records), uv (into `~/.local/share/unidex/uv`, linked from `~/.local/bin`), the Ollama app (into Applications, opened in the background), Claude Code (through its own installer) and Codex (laid out as its own installer lays it out). Before anything is installed, the download's SHA-256 is checked against the pin and every program in it against its maker's code signature (and Gatekeeper, for Ollama); anything already where a tool goes that is not the installer's own is moved aside, never replaced, and a copy already in the installer's own folder, or an Ollama app already installed, is reused only when it passes the same signature check; a download that does not match is deleted and the button offers **Retry**. **Install what's missing** runs Node, uv, Ollama and its models one after another, and a tool you already have elsewhere (on your PATH, or in `~/.local/bin`) is used as it is when it is new enough. Ollama's models follow your Mac's memory: under 12 GB `qwen3.5:4b`, otherwise `qwen3.5:9b`, plus `qwen3-embedding:0.6b`, pulled through Ollama's own API with its progress. <!-- no-tour: setup wizard, before the Workbench opens -->
- **Install without an agent CLI.** The wizard's **No agent CLI yet**, always offered and chosen for you when neither Claude Code nor Codex is installed and logged in, sets up your vault, its memory and the background work on your Mac; Sessions and the Chief of Staff wait until you add Claude Code or Codex. From a terminal it is `aos init --host none`; `aos hosts add claude` (or `codex`) adds the host later and keeps your files. A `--host` that would turn off a host the install has wired is refused, naming `aos uninstall --host <host>`. <!-- no-tour: setup wizard and aos init -->
- **The wizard's Finish lists what is left, step by step**: the `CLAUDE.md` line for Claude Code, the `/hooks` trust for Codex, how to add a host when there is none, and **Add aos to my PATH**, ticked to begin with, which shows the one line it appends to `~/.zprofile` when you open the Workbench; untick it and nothing is written. <!-- no-tour: setup wizard -->
- **Your Chief of Staff runs on Claude Opus 5.5 or gpt-6-sol, with failover.** A new install's duties run on Claude Code · `claude-opus-5-5` (`persona.model`) or Codex · `gpt-6-sol` (`persona.codexModel`), and the setup wizard and `aos persona` preselect them. With both hosts, a duty that cannot start on its host — the CLI missing or signed out — runs on the other host's model instead while `persona.failover` is on (the default for a new install): under `persona.runner: auto` (the default) it goes to whichever host can start it, and under a pinned runner to the other host; with failover off it waits for its own host (under `auto`, the first one installed). With no host able to start it, it is skipped and journaled `SKIPPED waiting-for-host`, flagged once a day, never failed. `persona.perDayUsd` stays one cap over both hosts: a capped day is skipped on both, never moved. `aos doctor`'s `persona runner` row names the host, its model and the failover host. <!-- no-tour: duty models; the wizard, aos persona and aos doctor show them -->
- **The hourly tick triages on your Mac first.** A new install's `tick` routine runs `tick.js --triage` locally: when nothing that matters changed — a routine failing or going missing, new commits in a tracked repo, a correction, a proposal, a flag, an inbox alert — the hour ends with no model call at all. A real change goes to the local model, which decides whether it merits a Chief of Staff run and writes the reason in the journal; when the local model is not running, any real change wakes it. The woken run may spend up to 0.50 USD on Claude Code (the routine's `budgetUsd`); Codex has no per-run budget flag, so there only `persona.perDayUsd` bounds it. <!-- no-tour: background routine -->
- **A routine can name its engine: the model on your Mac, Claude Code or Codex.** A prompt routine's `engine: local|claude|codex` and its `model` say where it runs; a routine without `engine` runs exactly as before (`routines.runner` decides), and no upgrade touches it. `engine: claude` or `engine: codex` runs on that host's CLI under the same caps, with the routine's model for that host; a host this machine does not have is a failed run that names it and what to do, never the other host. <!-- tour: routines.engine -->
- **A built-in local agent runs routines on your Mac, free.** `engine: local` hands the routine's prompt to the local model (Ollama, or an OpenAI-compatible server) with five tools: read, list and search (plain text) the vault's files; write only where the routine's `writes:` lists (folders, files or globs), never the Chief of Staff's guarded files, the runtime, the routine files, your workspaces (`workspaces/`) or a dot-folder (the rule duties already live by) and never what feeds your sessions (`persona/`, `brain/memory/`, `brain/_index/`, `MEMORY.md`, `AGENTICOS.md`, any `CLAUDE.md` or `AGENTS.md`), whatever the case or a symlink says; and post a notification. It stops after `maxTurns` turns (24 by default) or the routine's `timeoutSec`, writes every tool call and refusal to the routine's log, sends its final message where `output:` says (the log, `notify`, or a `.md` file it appends to), and counts as local calls, with one $0 row per run in the spend ledger. One timer bounds the whole run, so a stuck model call ends it as a timeout. With the local model down or not pulled the run is skipped (`local-down`), spends nothing, and the next fire tries again. <!-- tour: routines.engine -->
- **The Routines editor picks the engine and the model.** A prompt routine's engine (Local · Claude Code · Codex, only what this Mac has set up, or the default, `routines.runner`) and its model, from the models your local engine has downloaded, Claude Code's models or the Codex catalog, with a note that small local models can lose the thread on long, many-step routines; a local routine also sets its turn limit, what it may write (the editor says what it never may and refuses what feeds your sessions; any other off-limits entry is refused when the routine runs, and its log says so) and where its final message goes. Each prompt routine's row names its engine, and a run skipped since the last one says why. <!-- tour: routines.engine, routines.new -->
- **Sessions ▸ History lists every past Claude Code and Codex session on your Mac**, from the scan's session index (never a transcript), by day and newest first: each with its host, time and workspace (or the folder it ran in), and the one-line summary once the history import has digested it. Type to filter; a long history shows 100 at a time. **Resume** reopens one in a Code terminal, `claude --resume <id>` or `codex resume -C <folder> <id>` in its workspace (its code folder when it has one) or where it started, only on a host that is on and signed in; a host that is off keeps its rows, without Resume. <!-- tour: sessions-history -->
- **Skills ▸ MCP servers** lists both hosts' MCP servers with a pill per host, and **Make available on Claude Code / Codex** copies one to the other host: it first shows the command, with environment and header values, URL credentials and queries and arguments named or shaped like secrets hidden, and the file it writes, and changes nothing until you confirm; then it runs exactly what it showed (refused if the server changed meanwhile), backs that file up outside the vault, in `~/.local/share/unidex/backups/mcp/`, which the Workbench never reads, and adds the server through the host's own CLI (`claude mcp add-json --scope user`, `codex mcp add`). Offered only for an enabled host, one copy per host at a time; a remote (http, sse) server goes to Claude Code only, and a server turned off on its host is not copied. `aos mcp copy` does the same from the Code tab. <!-- tour: skills.mcp -->
- **`aos mcp copy <name> --to claude|codex [--dry-run] [--expect <hash>] [--json]`** does the same from a terminal, on either host: the server's full config is read from the host that has it when you run it, `--dry-run` prints the command with the secrets it recognises hidden and a hash, writes nothing, and `--expect <hash>` makes the real run refuse anything else; a real run backs the target's config file up first. <!-- no-tour: CLI verb (aos mcp copy) -->

### Changed
- **Sessions follows your hosts.** The Sessions tab is on the rail whenever Claude Code or Codex is enabled and signed in, whatever the background provider, so a local model that is down never hides it. <!-- tour: core.sessions -->
- **Sessions is on the rail with no host signed in when there is history to show.** It opens on History then, and New session and Vault wait for a host as before. <!-- tour: sessions-history -->
- **graphify is installed with its local backend** (`graphifyy[ollama]`, the same pinned 0.9.66); `aos upgrade` adds it to an install that lacks it. <!-- no-tour: install dependency -->
- **Claude Code's daily sign-in check is free.** It asks `claude auth status` instead of making a one-word Haiku call that was billed to the hook ledger. <!-- no-tour: background check -->
- **`aos init` no longer refuses without Ollama or python3**: a missing Ollama is a warning (background work waits for it), and python3 is checked only with `--cost`, the one thing that runs it (graphify gets its Python through uv). `aos doctor`'s Ollama row is a warning, its python3 row shows only while cost is on, and an install with no host gets an info row instead of failing. <!-- no-tour: CLI (aos init, aos doctor) -->
- **An earlier install's host no longer stops the setup wizard.** When `agenticos.json` from an install whose vault is gone has a host on that your choice would drop, Choose names it and offers to keep it (when it is ready) or to take its wiring out first (`aos uninstall --host <host>`), instead of an install that `aos init` refuses. <!-- no-tour: the setup wizard runs before the Workbench, where the tour lives -->
- **A routine that turns itself off takes its schedule out.** When a run leaves its routine off (the import-digest routine once every session is digested), the runner takes out that routine's schedule and nothing else (`aos routines unschedule <slug>`, new), so the Routines tab no longer asks you to apply schedules and no other routine is touched. <!-- no-tour: runtime behaviour with nothing to click -->
- **`aos routines sync` no longer stops a routine that is running.** On macOS it leaves a schedule that has not changed, and is loaded, as it is: unloading a job stops it if it is running. <!-- no-tour: runtime behaviour with nothing to click -->
- **Every "host is off" line says `aos hosts add`.** A dimmed Codex or Claude Code row in Settings points at **Add Codex** / **Add Claude Code** under Hosts, and the Sessions host menu, Spaces' Resume and Start, the Code tab, the duty journal's waiting-for-host line and a team seat's refusal name `aos hosts add <host>`, which keeps the other host, instead of `aos init --host both`; `aos doctor` sends a Codex direct-wiring repair to `aos upgrade`. <!-- tour: settings.codex-off,settings.claude-off -->

### Fixed
- **Editing a to-do no longer loses what you type when `TODO.md` changes.** Any change to the file (a `/todo` capture, `aos todo`, an agent, a sync) redrew the To-Do tab and replaced the inline editor, so a keystroke or a selection could be lost; the redraw now goes on around the open editor, which keeps its text, selection and focus. When the line you are editing is the one that changed, the editor closes with a notice that your edit was not saved, and the other change stays. <!-- tour: todo -->
- **Sessions is on the rail from a fresh install's first launch.** Under provider `local` nothing had asked Claude Code or Codex yet whether they are signed in, so the first launch drew the rail without Sessions, which came only with the next launch. The Workbench now runs the free sign-in check when it opens (telemetry off too, while a host's sign-in is unknown), and Sessions joins the rail as soon as it answers. <!-- tour: core.sessions -->
- **The guided tour keeps the focus on the Sessions tab.** Vault chat took the focus each time Sessions redrew, so the tour's popover lost it, and with it the keys; a redraw now never takes the focus from outside the Workbench (the tour, a dialog, a menu). <!-- tour: sessions -->
- **The Routines editor refuses up front every place a routine could never write.** A `writes` entry or a final-message file in the runtime (`brain/scripts/`), the routine files (`brain/routines/`), `workspaces/`, a dot-folder, the vault itself or the Chief of Staff's guarded files was accepted, and only refused when the routine ran; **create** now refuses it, with the reason the run would have logged, and so does a duty's `writes`. The editor, the routine files' own check and the runners share one rule (`brain/scripts/lib/write-areas.js`). <!-- tour: routines.engine -->
- **Adding your first host sets up your Chief of Staff.** On an install made without a host, `aos hosts add claude|codex` (and **Add** under Settings ▸ Hosts) now runs the Chief of Staff step that waited for one: the interview in a terminal, otherwise the default answers (named Atlas, its duties on `claude-opus-5-5` or `gpt-6-sol`, or the model you already set, and scheduled), which `aos persona` changes. Before, Pulse kept saying "Add Claude Code or Codex to start your Chief of Staff" until you ran `aos persona` yourself. An existing Chief of Staff is never touched, and a second host leaves the choice you made at install alone. <!-- tour: settings.host-list -->
- **The tick skips quiet hours again.** Its change signature counted every routine's last run time, and the heartbeat and the briefing run every half hour and the tick itself every hour, so it never skipped; it now counts routine status changes and failures only, and a tracked repo by its HEAD (the vault's own repo by its memory files, not its backup commits).
- **Duties no longer take their model from the first `model` key in `agenticos.json`.** The duty runner asks the Chief of Staff's resolver for the host and the model, so a Claude model never reaches Codex.
- **The Brain Map lays out the same way every time, with every memory in view.** Two memories that landed on top of each other were parted in a random direction and could be flung far off the fitted view; they now part along a fixed direction, and the push at close range is softened.
- **The Chief of Staff's models are priced as themselves.** Codex spend on `gpt-6-sol` is estimated at its published $2 / $10 per million tokens (it was estimated at the gpt-5 default, and that guess counted against `persona.perDayUsd`), and the cost module and the Brain hub's estimates price `claude-opus-5-5` at $4 / $20 instead of falling back to another model's rate. <!-- no-tour: price table; nothing new on screen -->
- **Opus 5, 4.8 and 4.7 cost a third of what the cost module said.** Session costs and the Brain hub's estimates priced them at $15 / $75 per million tokens, the retired Opus 4.1's rate; they use Anthropic's published $5 / $25 now (`pricing.json`, checked 2026-10-15). <!-- no-tour: price table; nothing new on screen -->
- **A duplicate pair you kept apart shows again once `memory-notdup.json` no longer lists it.** After **Keep both** or **Not duplicates**, the Brain page hid the pair until it read a rebuilt `brain-hub.json` without it; when the file was put back first (a sync, a revert), the pair stayed hidden, and Health's badge one short, until the app restarted. The page now goes by `memory-notdup.json` itself, so a pair recorded with `aos memory notdup` in a terminal also hides at once, before the next scan. <!-- tour: brain-health.duplicates -->

### Security
- **The Workbench page can no longer write into the runtime's protected folders by spelling a path with other capital letters or Unicode forms, or through a link.** Main compares each path the way macOS's disk compares names and checks where the disk would put it as well as how it is written, under any name for the vault's folder (and the folders it never reads, under any name for them); a file the page copies never becomes executable, a file with other names on disk (a hard link) is never changed or removed by the page, and a move to the Trash is checked and done as one step. <!-- no-tour: security fix -->

## [1.9.0] — 2026-10-12

### Upgrading
- **Map, Health's fixes, Merge with AI and the sweep need this release's runtime** (`brain-map.json`, `aos memory fix`, `merge-draft`, `merge`, `unmerge`, `sweep`): accept the runtime upgrade the app offers, or run `aos upgrade`. Map shows its communities from the next scan on. Nothing to re-trust: no hook command changed on either host.

### Added
- **Bootstrap shows what every new session starts with, and lets you steer it.** Budget bars for `BRAIN.md` against its budget, `SESSION.md` against its 400 tokens and `recall-wake.md` against its three snippets; `BRAIN.md` section by section with each one's tokens (Who you are, Critical rules, Active context, Quick links, Last Session), where Unpin and Mark complete act in place and `BRAIN.md` is rebuilt ("+ Pin a memory…" opens Library to pin one), and the active projects left out wait behind "Show them". Active projects that look shipped are flagged, with about how many tokens marking them complete would free; "Mark the N complete…" asks first and rebuilds `BRAIN.md` once at the end, and nothing is completed on its own. A row stays in place, its button busy, until its change is made, so a double-click never acts on the row below. Below them, `SESSION.md`'s `#promote` and Things to Remember lines (with "Not wrapped yet" until `/wrap` (`$agenticos:wrap`) runs) and `MEMORY.md`'s size and line count, with a link to Health when lines sit under the wrong heading.
- **The recall preview**, in Bootstrap, shows what `recall` would hand an agent for the text you type: the same search either host's sessions run (hybrid with an Ollama embed index, otherwise BM25), each hit with its score, title and age, "stale" when it is old, and a click opens it in Library. It logs no usage and writes nothing, except a missing recall index, which it rebuilds as `aos recall --warm` would; with an embed index it asks the local Ollama to embed the query and nothing else, so it never runs a provider check or a headless login probe (`aos recall` does the same).
- **Map shows your memories' communities from the knowledge graph.** **Communities** are graphify's own, holding at least `memory.mapMin` memories once the index pages (`MEMORY.md`, the MOCs, `BRAIN.md`) are left out, each named by its most-linked memory, sized by its memories and ringed by the share still unreviewed; a community's card counts its memories, the unreviewed ones and those used this week, and lists its members and the communities it links to. **Around a memory** shows up to twelve memories closest to one you pick. With the graph off, Map says so and names `aos graph on`; before a scan has written the map, it says that.
- **Health shows the brain's state and fixes what needs no judgement.** Six tiles: duplicate pairs and clusters, memories waiting for review (and their share of all), memories never used in `memory.neverUsedDays`, `BRAIN.md` against its budget, `MEMORY.md`'s tokens and lines, and broken index links with the unindexed and misfiled ones. **Duplicates and clusters** opens that pair in Review to compare, marks it "not duplicates", or rescans. **Hygiene** fixes each kind in one click, with no model and a dry run first: every change is listed before you confirm (a removed `MEMORY.md` line with its reason), the fix then makes exactly those changes or, when another session changed the files meanwhile, makes none and says so, and each changed memory or draft gets a trail row with its before and after. **Dead weight** splits the memories into used, quiet and never used in `memory.neverUsedDays`: "Review the N" opens the unused ones in Library, and "Archive the N shipped…" archives the never-used projects that are complete or look shipped, after asking. Until the usage log is that old it says since when it has been collecting, and with telemetry off it says why it has no counts. Health's tab badge counts what it can act on, except memories whose description is only in `MEMORY.md` (every new memory starts that way, so Hygiene lists them without badging them).
- **`aos memory fix <kind> [--dry-run]`** repairs what Health's hygiene check finds, from any Claude Code or Codex session (with `--json` too): `sources` relabels memories written in-session under the old labels (`session`, `in-session`, `wrap`) as `manual-wrap`, what `/wrap` (`$agenticos:wrap`) writes today; `types` gives a host's auto-memory frontmatter `type: memory` and its type tag (a status it lacks stays unset, so no old project lands in `BRAIN.md`'s Active context); `descriptions` copies a memory's `MEMORY.md` description into its own frontmatter, quoted when YAML needs it (so is a description `aos memory set` writes, and the one archive keeps); `index` adds missing `MEMORY.md` lines, moves lines filed under another type's heading, and removes lines to missing files, lines of archived or superseded memories and second copies of a memory's line (each removal names its reason); `drafts` removes a feedback draft left behind after its rule was approved (the same name and title as a live feedback memory; a new rule whose name only matches is kept). Archived and superseded memories' files are left alone, and every other line stays as it was; a `MEMORY.md` with CRLF line ends keeps them. `--dry-run` prints the changes and their hash and writes nothing, and `--expect <hash>` makes a real run refuse, writing nothing, unless it would make exactly those changes; a real run logs a `fixed` trail row per changed memory or draft, and one per memory whose `MEMORY.md` lines it removes (Library's history shows "fixed (<kind>)"), a `types` or `index` fix rebuilds `BRAIN.md`, and a second run finds nothing to do.
- **Each scan writes `brain/_index/brain-map.json`** for the Map, from the vault graph and with no model call: the communities, the links between them and up to 12 neighbours per memory, with the graph's own counts and the index pages it left out. Every Brain action and Health's Rescan rebuild it with `brain-hub.json`.
- **Merge with AI folds 2–6 memories into one.** Review's M ("Merge into one…", beside Keep the older one and Keep both), Health's duplicate rows ("Merge with AI…") and a sweep's Merge card open one dialog: the memories side by side, and a draft with an editable title, description and body, named for the memory that will carry it (the oldest, which keeps its path, links, pins and use). **Draft with AI** shows what the call would cost before it runs and, after it, who drafted it and what it cost against today's cap ("estimated" under Codex); it drafts through the `auto` provider chain (Ollama, else Claude Code, else Codex). With no provider, signed out or at a cap, the dialog says why and starts from a draft combined without a model: the oldest's title and description, then each other memory's body under "From <title>". Nothing is written until **Save merged**: the oldest takes the merged text (marked reviewed, and pinned when any of them was), the others are superseded by it, their `MEMORY.md` lines become one, and `BRAIN.md` is rebuilt; when another session changed one of the files meanwhile, nothing is written and the dialog says to open it again. Cancel drops a draft that is still coming (the call may still be billed).
- **Undo merge.** Library's history reads "merged N into this" and, for 30 days and while the merged memory is unchanged, offers Undo merge: it asks first, then puts the old text back and restores the others with their `MEMORY.md` lines, byte for byte where nothing changed since (a memory edited since gets its status and line back with the edit kept, and an edit made since elsewhere in `MEMORY.md` stays). What each memory and `MEMORY.md` held before is kept in `brain/_index/memory-merges/`, and records older than 30 days are removed when the hub is next built.
- **The consolidation sweep.** Health's **Consolidation sweep** card asks Claude Code or Codex to look over every memory (one line each: title, description, the start of its body and its use, with the duplicates and clusters the hub found) and suggest merges, archives and retitles, each saying why. It shows the estimate before you run it, uses the background model (`claude.model`, or `codex.model` at `codex.effort`) under the reasoner's daily cap, and keeps its suggestions in `brain/_index/memory-sweep.json`. A card changes nothing until you act on it: Review on a Merge card opens the merge dialog, Archive and Retitle ask first (Retitle changes the heading and the `MEMORY.md` line, never the file name), and Dismiss hides it for good, so a later sweep never suggests it again; a card whose memories changed or left since reads stale or done. **Consolidate with AI…** on a Health cluster or a Map community sweeps just those memories, and that scope's cards show there (running it again replaces its open ones, even after some of its memories were merged or archived). With only Ollama the sweep is off and says why, and Merge with AI drafts on Ollama; with the reasoner's daily cap reached it is off and Merge with AI still drafts; with no provider it is off too, and Merge with AI works by hand.
- **`aos memory merge-draft`, `merge`, `unmerge` and `sweep`** do the same from any Claude Code or Codex session (each takes `--json`): `merge-draft <path>…` prints a draft and writes nothing (`--estimate` prices the call without making it; with `--json` it prints the cost, the cap left, the memory that will carry the merge, each memory's hash and the no-model draft); `merge <path>… --into <json> --expect <hash>,…` saves one, refusing when any memory changed since its hash; `unmerge <path> --expect <hash>` undoes it; `sweep [<path>…]` runs the sweep over the brain or up to 50 memories (`--estimate` prices it first); `sweep dismiss <id>` hides a suggestion for good. An estimate makes no model call, not even Claude Code's daily sign-in check, and writes nothing. `aos memory set` takes a `title` too.

### Changed
- **"Looks shipped" is narrower.** An active project is suggested for completion when its title or `MEMORY.md` description names a full version (`1.5.0`, not `1.5`, and never an address such as `127.0.0.1`), "shipped", "released" or "superseded"; "release" and "merged" no longer count, so a project whose pull request merged while the work goes on is left alone.
- **The MCP tools `memory_list` and `memory_search` leave archived and superseded memories out** on both hosts, as `feedback_rules` already did; so does `/ask-brain` (`$agenticos:ask-brain`) when it falls back from recall, and a memory whose `tags:` is a list on lines of its own is read correctly.
- **An approved feedback draft records when it was approved** in the promote trail, so Review and Library's history place its memory at that time.
- **auto-wrap and `/wrap` (`$agenticos:wrap`) keep Review's batches current**: after writing memories they rebuild `brain-hub.json` and the map, so a session's memories appear in Review without waiting for the next scan. A failure there never fails the wrap.
- **`memory.neverUsedDays` and `memory.mapMin` take effect**: Health's dead weight, Library's "unused" (the Use facet and each row's label) and Map's communities follow them, so "Review the N" opens exactly those N. With telemetry off, Library hides its use labels and Use facet, as Health and Map do.
- **Map's Every node shows memories only** (no longer patterns, daily notes and agents), and fits itself to the view once the layout settles so nodes and labels stay readable.
- **Type tags in Review and Library are no longer coloured**: in Brain, colour marks a state only.
- **A question the app asks before it acts takes the keyboard.** Cancel has the focus when it opens, so keys typed into the page behind it never land there and a stray Enter changes nothing, and a screen reader announces it as an alert dialog with its question.
- **`/consolidate-memory` (`$agenticos:consolidate-memory`) points at Health's sweep** and `aos memory sweep --json`, and carries out a merge section with `aos memory merge` (undone by `aos memory unmerge`). It still writes its proposal.

### Removed
- **Bootstrap's and Health's stand-ins**, the read-only summaries 1.8.0 showed until these modes could act.

### Fixed
- **A session started after `/clear` gets `BRAIN.md` and `SESSION.md` on its first prompt.** The first-prompt hook skipped any session whose transcript already held a user-role entry, and such a session opens with Claude Code's local-command caveat and the `/clear` command, so it was never given the brain context, the persona or recall-wake, and no memory use was logged for Health's dead weight. The hook now counts only prompts typed before this one, on both hosts (a transcript that already holds the prompt being submitted counts it as this one).

### Security
- **The `brain` surface runs the merge, undo and sweep verbs**, each with an argument rule (2 to 6 memories with one hash each for a merge, at most 50 memories for a sweep, a suggestion's 12-character id to dismiss it), and `set` admits a one-line title (no `[` or `]`); `set` and `merge` refuse a title with a bracket or a description with `](`, so a memory's `MEMORY.md` line never links another path. `SECURITY.md` lists what the two model calls send (the chosen memories' text, each capped, for a merge; one line per memory for the sweep), to which provider and under which caps.

## [1.8.0] — 2026-10-11

### Upgrading
- **The Brain tab acts through this release's runtime** (`aos memory`): accept the runtime upgrade the app offers, or run `aos upgrade`. Until then its actions say so and change nothing.
- **Nothing to re-trust.** No hook changed on either host, so Codex keeps the trust you gave its hooks; the upgrade adds the new `memory.*` settings to `brain/config.json` and keeps your values.
- **Memories already tagged `status/archived` or `status/superseded`** (by hand, or project notes `aos workspace archive` flipped) leave recall and the embed index at the scan the upgrade runs; Library lists them under Status, and Restore brings one back.

### Changed
- **The Memory tab is now Brain**, on the rail and in the palette ("Open Workbench: Brain"; links and shortcuts to the tab keep working), with five modes across the top. **Review** shows what your sessions wrote, grouped by the session that wrote it (title and host): keep a session's new memories at once (⇧K) or one at a time (K keep, E edit, A archive, P pin); M sets a memory that looks like one you already have beside it, to keep the older one or both (merging two into one comes with the next update); feedback drafts, likely duplicates and anything older than 30 days have queues of their own, and "Mark everything before …" clears an old backlog. **Library** finds and reads every memory, feedback draft, pattern and reflection, with its use, what links to it, its look-alikes and its history, and pins, archives, restores it or changes its status. Bootstrap and Health show what they can until the next update, and Map keeps the knowledge graph.
- **Pulse summarises the brain and the Brain tab acts on it.** The Brain tile counts today's memories (and those since you last opened Review), what waits for review, the feedback drafts and `BRAIN.md` against its budget, each a link into Brain; the needs-you and Decisions items for memories and drafts open Review (drafts no longer start `feedback-review` in a terminal), and the popup's Brain area lists today's memories as they are now, each opening in Library.
- **Archived and superseded memories leave recall, the embed index, the MOCs, `BRAIN.md` and the `feedback_rules` tool**, a pinned rule included until it is restored; a correction that repeats a retired rule is drafted again, and `/consolidate-memory` no longer offers retired memories. Project notes archived with `aos workspace archive` leave recall too.
- **`/consolidate-memory` carries out a section without deleting anything**: it retires a duplicate with `aos memory supersede` and a dead memory with `aos memory archive`, both undone by `aos memory restore`.

### Added
- **Brain's rail button has a badge**: the memories written since you last opened Review in this app, never the backlog, so it starts at zero after the update and goes back to zero each time you open Review.
- **`aos memory`** lists the memories and keeps, pins, archives, restores or supersedes one, changes its status or description, decides a feedback draft, and marks two memories as not duplicates, from any Claude Code or Codex session (each verb takes `--json`). No memory is deleted (deciding a feedback draft removes the draft, as `feedback-review` always has), and pin and status changes rebuild `BRAIN.md`. These are the verbs the Brain tab runs.
- **A memory usage log**: which memories reach a session (injected at its start, returned by `recall`, read with `memory_read`) is kept by path and host in `brain/_index/memory-usage.jsonl`. It is on by default, as telemetry is; `telemetry.enabled: false` turns it off with the rest of telemetry. No prompt or query is kept, and rows older than `memory.usageDays` fold into totals.
- **Each scan writes `brain/_index/brain-hub.json`**: memories by state, the unreviewed ones grouped by the session that wrote them, likely duplicates and clusters (by title, text and, with Ollama, meaning, scored against the vault's own pairs), hygiene findings and active projects that look shipped. `brain-sources.json` records which memories `BRAIN.md` was built from. New settings, in ⚙ Settings ▸ Memory & scanning: `memory.usageDays` (90), `memory.dupScore` (0.8) and `memory.clusterMin` (3); `memory.neverUsedDays` and `memory.mapMin` are for Health's unused memories and Map's communities, which come with the next update, and change nothing yet.

### Fixed
- **The promote trail is appended under a lock**, so two writers can no longer interleave a line.

### Removed
- **Pulse's keep, edit and revert on auto-promoted memories.** Revert deleted the memory file; the Brain tab archives instead (Restore undoes it), and the app deletes no memory: only a feedback draft you approve (it becomes a memory) or reject is removed.

### Security
- **A `brain` write surface** runs only the `aos memory` verbs the Brain tab needs, each with an argument rule (memory paths only, at most 50 per call, compare-and-set for pin and status); the runtime checks every path again and deletes nothing but a feedback draft that is approved (it moves into the store) or rejected. It is on by default, after a live check on each host's memories. Pulse's surface no longer writes memory files, `MEMORY.md` or the trail.

## [1.7.0] — 2026-10-10

### Upgrading
- **Adopting from Spaces records the folder as an alias** of a workspace and moves nothing; `aos workspace adopt <path>` without `--into` still moves the folder.
- **The `aos workspace` verbs refuse linked folders**: a `workspaces/` or `workspaces/_archive` that is a symlink, or a linked map, thread or project-note folder under `brain/`, is refused with the reason (scanning is unchanged). A name must match its folder's case exactly. Restore flips back only the project notes Archive flipped, and returns a dated archive to its original name.

### Changed
- **Spaces is a three-pane dossier.** A searchable list grouped by status, a pick-up card (last thread, the handoff's Now line, next step, the insight), Overview and a Files tree with map descriptions inline, and a History and Linked pane.
- **`_` folders are hidden from Spaces and Pulse counts**, and the outside list drops temp, scratch and job folders.
- **Workspace status is active, stalled or idle**, worked out from sessions and commits, unless `workspace.md` sets `active`, `paused` or `done`; session counts cover the last 30 days on both hosts.

### Added
- **Resume in Code** reopens a workspace's last Claude Code or Codex thread in a Code terminal; a Codex terminal started by Resume (from Spaces or the end bar) resumes that same thread by its id when it ends; Spaces, Sessions, Code and Pulse link to each other by workspace.
- **Spaces can create, adopt, archive, restore, rename and pin workspaces and set their status**, through new `aos workspace` verbs that any Claude Code or Codex session can run too; `/todo`, `/propose` and `/project` link what they write to the workspace you are in, and **Link to-dos…** tags existing to-dos with their workspace in one click.
- **Draft workspace.md** writes a summary, objectives and next step for review; nothing is saved until you press Save.

### Security
- **The Spaces surface runs named `aos workspace` verbs**, with the names and paths checked by the runtime, writes kept to `workspaces/` and `brain/_index/` plus a project note's status tag, and a confirmation before any folder moves.

### Fixed
- **Spaces counts Claude Code sessions.** Sessions are read from each transcript's own folder, worktrees and team seats are credited to their workspace, and sessions started at the vault root count for the workspace whose files they touched.
- **A workspace's next step comes from its handoff or plan, not the last commit.** Automatic backup commits no longer show as the next step, and a model's suggestion is no longer stored as one.
- **`aos workspace` works when run from the vault folder itself**, where it used to say no vault was configured.
- **Reading a workspace's repository runs nothing that repository's own config names.** The scan and the Sessions tab's changes and diffs no longer run its filter drivers, external diff or textconv programs, or fetch missing objects of a partial clone.

## [1.6.0] — 2026-10-09

### Changed
- **The rail reads in three sections, with a light line between them.** Notifications, Pulse, Code and Sessions come first; then To-Do, Spaces, Files, Routines and Proposals; then Memory, Agent Teams, Agents, Skills and Runs. Light and dark, App settings and ⚙ Settings stay at the foot. Pulse is still Home.
  - Pulse's icon is neon blue in the dark theme and navy in the light one, and stays readable on its selected chip.
- **The Term tab is now called Code.** Its tooltip, its list, the palette's "Open Workbench: Code" and the buttons that open a terminal say Code. A single session is still a terminal, and links and shortcuts to the tab keep working.
- **Code's composer is twice as tall, with larger text** (15px), so a longer prompt fits before it scrolls.

### Fixed
- **The Code page no longer scrolls.** It overflowed the window by 50px at every size, so the composer's send row and the list's foot sat under the window's edge. It now fills the window: only the terminal, the list and the composer's text scroll.

## [1.5.0] — 2026-10-08

### Changed
- **Pulse is Home, and it is now a no-scroll cockpit.** Your Chief of Staff's briefing sits on top. Each underlined phrase opens what it names. "Since you last looked" says what arrived while you were away, and the Commands row sits underneath. Below are ten tiles: what needs you, system health, agents, workspaces, to-dos, decisions, notifications, routines, spend and memory.
  - A tile shows its count and as many rows as fit, and the rest read "+N more". Nothing scrolls, even at the smallest window.
  - A tile opens one popup with every area in a list on its left. Safe actions act right there: run a fix or a routine, mark read, tick a to-do, keep a memory. Decisions jump to their review (a proposal or flag to the flag-closer, a team gate to Agent Teams).
  - The pipeline LEDs, the Fix Queue, the cost and health rows and the auto-promote trail moved into the popup's Health and Memory areas.
  - The rail starts with Pulse, and its badge counts what needs you (rose when one is an error). Sessions is one click below.

### Added
- **The Chief of Staff writes a short briefing for Pulse.** A new `briefing` routine (every 30 minutes from 7:00 to 22:00) reads what Pulse knows: errors, decisions waiting on you, stale or failing work, unread notifications, to-dos, memories to review, routines and spend. When something changed, it asks the background model for two or three sentences in your Chief of Staff's name and saves them to `brain/_index/briefing.json`. It writes nothing when nothing changed. The call is a `duty:briefing` row paid from the daily duty cap (`persona.perDayUsd`), with `claude.model` (Haiku by default) or `codex.model`. Ollama is used first and free when it answers. Nothing runs while the Chief of Staff is off; `persona.briefing.enabled: false` turns just the briefing off. New vaults get the routine, and the upgrade turns it on for existing ones.

### Upgrading
- `aos upgrade` (and the runtime upgrade the app offers after it updates) adds the briefing routine, `brain/routines/briefing.md`, to a vault from before 1.5.0 and schedules it with your other routines. It spends only while the Chief of Staff is on. To keep it off, run `aos routines disable briefing`, or delete the file: a later upgrade does not add it back. If your routines were never scheduled, `aos routines sync` schedules them all.
- Whenever the routine is missing or the Chief of Staff is off, Pulse composes the paragraph itself, and **Turn on <name>'s briefing** in Pulse adds the routine back.

## [1.4.1] — 2026-10-08

### Changed
- **The composer (⌘L) sits under every running terminal,** a plain shell too: ⏎ runs what you wrote, ⇧⏎ adds a line, @ inserts a file and Snippets work; the / list stays with Claude Code and Codex.

### Fixed
- **Every tab keeps its own layout after a visit to the Term tab.** In 1.4.0 the Term tab left its layout on the Workbench's shared content area, so every tab opened after it was drawn in a row (lists beside their toolbars, Notifications and Proposals without their side list, To-Do in columns, Files' search and tree out of place) until the app restarted. Each tab now starts on a bare content area.

### Removed
- **The terminal on the Pulse tab.** Terminals live in the Term tab; the Pulse tab's ❯_ buttons and Commands still open it. The Embedded terminal panel setting is gone with it.

## [1.4.0] — 2026-10-08

### Added
- **Start Claude Code, Codex or a shell from anywhere, without picking a workspace.** ⌘T starts the host you used last, ⌥⌘1 Claude Code, ⌥⌘2 Codex and ⌥⌘3 a shell, from any tab. The Term tab's New button says what it will start and where ("New Claude Code · in Vault"); its ▾ menu lists every host, every place (what you have selected, the vault, Scratch, your workspaces, recent ones) and shows the exact command it will type. Terminals start next to what you are looking at (a selected workspace terminal, or the workspace open in Spaces), else in **your vault**. **Scratch**, a shared workspace at `workspaces/scratch`, is made the first time you pick it.
- **New workspace in one step.** ⇧⌘N, or a new name typed in the ▾ menu, makes `workspaces/<name>` with its README, CLAUDE.md and AGENTS.md (and its own git repo, unless your vault's git tracks `workspaces/`) and starts the agent there. An existing name opens only when typed exactly.
- **Linked code folders.** A workspace's `workspace.md` can name the folder its code lives in (`repo: ~/Code/app`, or Spaces ▸ link code folder…): terminals started in that workspace start there, and sessions run there count for it.
- **The Term tab is a deck:** a list beside the terminal, one group per place (each workspace and Scratch, the newest launch first; then the vault, home and other folders), each row with the host's dot, the agent's title, where it came from and how it ended (✓ Done, Exited n). A group's + starts another terminal there; a filter narrows the list; Clear ended tidies it. The selected terminal's header shows its place (with Start here, Open a shell here, Make this a workspace…, Link a code folder…, Copy path), its host, model and access, and once it has ended Restart, Resume and Open a shell here. ⇧⌘[ / ⇧⌘] walk the list and ⇧⌘W closes a terminal (asking first while an agent runs). The Pulse strip keeps its tabs.
- **A composer under an agent's terminal** (⌘L): write a longer message, ⇧⏎ for a new line, @ for a file of the place (inside the vault), / for the host's commands (Claude Code `/name`, Codex `$skill`), and Snippets for prompts you reuse; ⏎ sends it as one paste. In Claude Code's own prompt, ⇧⏎ is now a new line too. Links in a terminal open: https in the browser, the agents' status-line links in the Workbench (a tab, or a note such as the flags in `persona/STATE.md`). The terminal sits in a padded card.
- **Find in a terminal** (⌘F on the Term tab): every match in the selected terminal, scrollback included, is highlighted and counted ("2 of 7"); ⏎ and ⇧⏎ step through them and Esc closes the bar. Switching terminals with it open finds the same words there.
- **Terminals show what runs in them:** each tab has the host's dot, the agent's own title (the conversation, as Claude Code and Codex name it), where it runs or which tab started it, and the agent's exit code when it ends. Spaces' workspace detail adds Claude Code here and Codex here.

### Changed
- Agents started from the Term tab, Spaces and the ❯_ buttons run with `exec` and a check that the CLI is there, so a missing `claude` or `codex` says "run aos doctor" instead of failing quietly. Access defaults to **Host default**: no flags, exactly as if you typed `claude` or `codex` yourself.
- Terminals start with your login shell's `PATH`, so an app opened from Finder finds `claude`, `codex` and the `node` an npm-installed CLI runs on.
- Terminals set `FORCE_HYPERLINK=1`, so Claude Code keeps the links in its status line (other tools that honour it print clickable links too).
- The Term tab and the Pulse strip keep the terminal you were on when you come back to them; the Shell and Working directory settings apply without a restart.

### Fixed
- "New terminal session" no longer opens two shells on an empty Term tab, and Spaces' terminal no longer hides behind the first session.
- The Files tab's New note, Rename and Move forms put the cursor in their field at once, so typing straight after opening one can no longer land in the other field.
- Editing a to-do no longer saves it halfway when TODO.md changes underneath (another HUD, `/todo` in a session, a sync): what you typed, the caret and the focus stay, and Enter saves onto the new file.

## [1.3.1] — 2026-10-07

### Upgrading
- **Updating from 1.3.0 or earlier:** the fix below works from the version that has it, so this one update still needs a hand: after **Restart to Update**, quit UniDeX with ⌘Q (or the tray's Quit) if it has not closed, and leave it closed for about 20 seconds while it installs and reopens.

### Fixed
- **Restart to Update quits the app.** Electron closes an update's windows before it emits `before-quit`, so the main window, which hides instead of closing until the app quits, cancelled the quit: the app stayed running in the tray and the installer waited for it. The app now marks itself as quitting first (and on Squirrel's own `before-quit-for-update`), so the update installs and the app reopens by itself.

## [1.3.0] — 2026-10-07

### Upgrading
- Accept the runtime update the app offers (or run `aos upgrade`): the model lists, access levels and Vault's host choice come from the runtime's `lib/host-catalog.js`, `lib/sessions.js catalog` and `sdk/ask.js`.

### Added
- **Each host lists its own models and commands.** The runtime asks Claude Code (one `initialize` request, no model call) and Codex (`codex debug models` and `codex debug prompt-input`) what they can run, and keeps the answer in `brain/_index/host-catalog.json` for a day. A host that does not answer keeps its aliases. The account details Claude Code sends with its list are never stored.
- **Access levels for a session turn:** read only (Claude plan mode, Codex's read-only sandbox), edit files (the default), or edit and run commands (Claude adds Bash; Codex always runs commands inside its sandbox).
- A session turn can change its model, effort and access from one turn to the next; each prompt in the thread records them. Codex turns take the `max` and `ultra` efforts.
- Plans: Claude's to-do list and Codex's `todo_list` become one `plan` event in the thread.
- The changes card's files carry lines added and removed (`git diff --numstat`, and an untracked file's lines).
- `ask.js --local --host=claude|codex --model=<id> --effort=<level>` answers a vault question on that host only, with no fallback to another provider.
- **A `/` menu in the Sessions composer** lists the host's commands (Claude Code's, inserted as `/name`) or skills (Codex's, inserted as `$name`); ↑↓ and Enter pick one, and the host runs it as typed.
- **A status line under the composer:** the next turn's model, effort and access, the turn's and today's session spend against the cap, and the workspace's branch and files changed.
- **Review changes +a −b** in the thread's top bar counts the lines added and removed and opens the changes card in a drawer; each file shows its own counts, and an edit line in the timeline its file's.

### Changed
- **The Sessions tab is laid out like Claude Code.** The list starts with **New session** and **Vault**, then each workspace with its threads (a host dot, a running mark, the age) and today's session spend. A thread reads as one column: your prompt, the agent's text, each tool call as a mono `Update(file)` / `Bash(command)` line with its result under it (click to open the input, the result and the file's diff), the plan as a card that ticks off, and `Working… (12s · esc to stop)`. **Stop** sits in the top bar, and Esc stops a running turn too.
- **One menu picks the host and the model.** `Claude Code · Opus 5.5 · High ▾` opens a host switch (a host that is off is greyed with why), search, the host's current models with older ones folded (Codex's configured model tagged "your default"), the model's effort levels, **Custom model id…**, and where the list came from with ↻. In a thread the host is locked, the model and effort apply from the next message (the list tags the model it ran on "used so far", and the timeline marks the change), and **New session on <other host>** starts one there. The app remembers the last host, access and each host's model and effort.
- **An access menu replaces Allow commands:** Read only, Edit files or Edit and run commands, with what each runs as on each host; on Codex the menu says commands always run inside its sandbox.
- **Vault chat has the same menu, always read only:** each question can go to any ready host and model (Claude Code through `claude -p`, Codex through `ask.js`; until you pick Codex there, a question takes today's route with its fallback, as the header says), and the footer shows today's reasoner spend against its cap.

## [1.2.1] — 2026-10-07

### Upgrading
- The repository is now **zzoretich/UniDeX-Agent-Harness**. Links, clones and the plugin marketplaces still reach it through GitHub's redirect, and the app keeps updating itself. A runtime from 1.2.0 or earlier, though, stopped seeing new releases when the repository was renamed: its update check met GitHub's redirect and gave up. If you use the app, accept the runtime update it offers after it updates to this release. Without the app, run `aos upgrade` once.

### Changed
- The repository is **zzoretich/UniDeX-Agent-Harness** (it was zzoretich/AgenticOS-Workbench). The app's update feed, its **UniDeX on GitHub** menu item, the update notice's release link and every install command in the docs use the new name.

### Fixed
- The runtime's update check follows a redirect (https only, at most three), so a moved repository no longer leaves it unaware of new releases.

## [1.2.0] — 2026-10-07

### Upgrading
- After the app updates itself, accept the runtime update it offers (or run `aos upgrade`): the Sessions tab runs each turn through the runtime's `lib/sessions.js`, and until the vault has it a session says "this vault's runtime has no sessions yet: run aos upgrade".

### Added
- **Session caps.** Settings ▸ Spend limits has a **Session turn cap** (`sessions.perTurnUsd`, $1.00) and a **Sessions daily cap** (`sessions.perDayUsd`, $10.00), and `aos status` shows today's session spend against it. The runtime can now plan, gate and read one turn of a Claude Code or Codex session (`brain/scripts/lib/sessions.js`); the Sessions tab that uses it comes with the next steps of UniDeX phase 2.
- The app can run a turn of an agent session in a workspace, read the workspace repository's changes and commit them (main's session and git services; the turn's spend and a row in Runs are recorded). Only a workspace's own repository counts: a workspace folder inside a vault kept in git has none, so Commit can never add the whole vault. They are on by default, after a live turn and a resume on each host.
- **The Sessions tab, in the Chat tab's place on the rail.** Its list starts with **Vault**, the chat about your notes as it was, then your agent sessions grouped by workspace, newest first, with a dot while a turn runs. **New session** picks a workspace under `workspaces/`, Claude Code or Codex (a host that is off is greyed out with why), an optional model and, for Claude, **Allow commands** (Codex runs commands in its sandbox). A thread shows your prompts, the agent's replies, each tool as one line that opens to its input and result, the files a turn changed, and each turn's cost (Codex's estimated); **Stop** ends a running turn. After a turn, a card lists what changed in the workspace's repository: **Review** shows a file's diff and **Commit** commits everything with a message you can edit. Nothing is pushed.

## [1.1.0] — 2026-10-07

### Upgrading
- The app is now called UniDeX, and this update renames it in Applications to **UniDeX.app**. After this one update it does not reopen by itself: open **UniDeX** from Applications or Spotlight. Your settings, vault and runtime carry over, and later updates reopen it as before. *(Corrected after the release: these notes first said the file kept its old name.)*

### Added
- **Light and dark.** The Workbench app now has a light theme as well as the dark one, and follows macOS's appearance as it changes. The sun and moon button at the foot of the ribbon, **Toggle light and dark** in the command palette and View ▸ **Appearance** switch it; App settings ▸ **Appearance** goes back to **Match macOS**. The choice is kept in the app's data and outlives a restart.
- **`statusline.chainPosition`** puts the status line you had below AgenticOS's lines instead of above them. It applies to `aos statusline install --chain-output`, which shows that line's first line: `aos config set statusline.chainPosition bottom` (or Settings → Status line). `top` is the default, and the change shows on the next refresh, with no reinstall.

### Changed
- **A new look, the first of three steps toward UniDeX.** The Workbench is monochrome (white on black or black on white) with colour kept for state: green ok, amber a warning, red breaking or failed, blue live or running, violet waiting on you, grey off. Agent Teams' gates are violet now, not amber. The scanline and glows are gone. Text is set in Inter and numbers and code in JetBrains Mono, both bundled with the app. The terminal, the memory graph and the disk chart follow the theme.
- **The Workbench's second UniDeX step: one rail.** The app's ribbon and the Workbench's top bar are gone. A single icon rail runs down the left: the UDX mark (Home), Search (⌘K) and Quick Capture at its head, every tab as an icon with its name on hover, and light and dark, App settings and Settings at its foot. Home is Chat when a provider is set up, else Pulse. Headings are sentence case without the `[ … ]` and `⌜ … ⌝` decorations; pills, cards and buttons are rounded; the fix queue marks each item with a dot in its colour; Agent Teams' gates have their own violet tone; Chat puts your messages in bubbles above a rounded composer. The clock went with the top bar.
- **Notifications is an inbox with a reading pane.** The list sits on the left and the item you open reads on the right, with its title, level, sender, sections and buttons; it stays open after it turns read, even in the Unread view it has just left. Clicking it again closes it.
- **Proposals reads the same way.** Pending, Backlog and History stay on the left; the proposal or backlog idea you open reads on the right, with its title and target above what it needs, What / Why / Risk and its premises. Runs and Memory keep their right-hand drawer, which does the same job.
- **The app is now UniDeX, the third UniDeX step.** The Dock, the menu bar, About, the window titles, the setup wizard, settings and the app's messages say UniDeX, and the icon is the UDX mark, white on black. The menubar item shows the mark too, as an image macOS tints for a light or dark menu bar, with its status beside it. The settings window's tabs are **App** and **Runtime**. The status line's update note reads `⬆ UniDeX <version>`, and `aos doctor` and `aos init` name the app UniDeX. The `aos` CLI, the `agenticos` plugins and MCP tools, `~/AgenticOS`, the app's data folder and the update feed keep their names, so nothing is reinstalled or re-trusted.
- The Claude Code and Codex plugins say UniDeX too: their descriptions, Codex's plugin and marketplace name, `/aos`'s description and a new vault's `AGENTICOS.md`. Only text changed, so the hooks you trusted stay trusted.

### Fixed
- Proposals' list fits its pane: each row puts the name on its own line and its kind, age and confirmations below it, so names no longer break mid-word and the history no longer scrolls sideways.
- A link in a note or a notification to a web page, PDF or image in the vault opens it with its default app, through the same rules as the Proposals tab's pages: an HTML page opens in the browser when it is under `brain/_index/` and is shown in Finder anywhere else. Before, the link opened the file as source text in a note, so a routine could not link a notification to the page it wrote.

## [1.0.1] — 2026-10-06

### Fixed
- A new vault's `AGENTICOS.md` fits the 9,000 characters the conventions hook injects into a Codex session again; it had grown past the limit, so Codex saw it cut off near the end. A vault you already have keeps its own copy.
- Agent Teams → Manage keeps the agent you picked in **Add a member** when the tab redraws before you click Add (its clock, a file change, the runtime's sweep). The pick came back empty, with Add disabled.
- **Settings** shows a change you make there once it is written. When the tab was still reading the settings as you changed one, it could go on showing the old value (and its "this vault" or "this machine" source) until you pressed ⟳ reload.

### Changed
- The app's setup wizard now leaves Ollama with its two models downloaded (`qwen3.5:9b` and `qwen3-embedding:0.6b`, about 7.2 GB): its Ollama fix, now **Install Ollama and its models**, also starts it and pulls them, and with Ollama already installed a missing model is a warning with its own fix, **Download the models**, that does not hold up the install. Background work runs on Ollama as soon as it answers, so before this a wizard install could leave it with no model to run. By hand: `ollama pull qwen3.5:9b && ollama pull qwen3-embedding:0.6b`.
- The Workbench's settings no longer mention Obsidian: the plugin section is "WORKBENCH — THIS APP", and the status bar, sidebar, vault root and terminal settings speak of the app.

### Removed
- The Term tab's **Install terminal support** and **Rebuild for this Electron** buttons, left from the Obsidian plugin. In the app they could only appear when a terminal failed to start, and led nowhere: the app carries its terminal.
- Two runtime scripts nothing ran: `graph-snapshot.js` (`aos graph status` prints the same) and `feedback-conflict-check.js` (the feedback-review skill checks for conflicts itself). A vault upgraded from an earlier release keeps its old copies, unused.

## [1.0.0] — 2026-10-06

**AgenticOS no longer uses Obsidian: the Workbench is a macOS app, AgenticOS Workbench, attached to this release.** Coming from 0.x with the Workbench in Obsidian? The [migration guide](https://github.com/zzoretich/UniDeX-Agent-Harness/blob/main/docs/migrating-to-1.0.md) walks through it.

### Upgrading
- Install the app: download `AgenticOS-Workbench-<version>-arm64.dmg` from this release (Macs with Apple silicon), drag it to Applications and open it. It finds your install through `agenticos.json`.
- Update the runtime: accept the app's **Update the runtime in your vault** (**Update now**), or run `aos upgrade` in a terminal. Then run `aos routines sync`: the upgrade records Homebrew's stable Node path in `agenticos.json`, and the sync re-renders your routine schedules with it.
- Quit Obsidian and remove the old plugin folder `.obsidian/plugins/agentic-os/` from your vault, after the app has opened it once (it copies your Workbench settings from there). `aos upgrade` mentions the folder while it is there and never deletes it.

### Added
- **The Workbench is a macOS app, AgenticOS Workbench**, attached to every release as a signed, notarized DMG for Apple silicon. The same HUD runs in its own window instead of inside Obsidian, with a note editor and a menubar popover; it is built from `app/` in this repository, with its full test suite in CI.
- **A Files tab** in the Workbench: the vault as a tree, search across notes (or every text file), Open file… and Search vault…, and a new note, rename, move and delete to the Trash: where you work with notes now.
- **The app installs AgenticOS.** Opened with no install, it shows a setup wizard: it checks Node, Claude Code and Codex (and their logins), Ollama, Python and uv, offers a fix for each missing one (Homebrew's installer, `brew install …`, `npm install -g …`, the logins), which runs in a terminal inside the wizard, then asks which hosts and which folder, asks the Chief of Staff questions in a form, runs `aos init` from the runtime the app carries, shows the `CLAUDE.md` line as a diff and adds it only if you say so, and opens the Workbench. No terminal needed.
- **The app opens an existing install as before**, says once what changed, and when it carries a newer runtime than your vault has, offers to run `aos upgrade` from it (never on its own: an upgrade re-renders your schedules).
- **The app updates itself** from GitHub Releases: it downloads a new version in the background and installs it when you quit, or at once from "Restart to update" (status bar, and AgenticOS Workbench ▸ Check for Updates…). `updates.check: false` turns it off, as it does the update check.
- `aos init` and `aos upgrade` run from a release tree that carries the runtime's dependencies (the app's bundled runtime) without npm: the dependencies are copied, then swapped in whole.

### Changed
- Your Workbench settings carry over to the app: the first time it opens a vault whose Workbench ran in Obsidian, it copies the settings from `.obsidian/plugins/agentic-os/data.json` into its own data folder (it never writes the vault's copy), so removing that folder loses nothing.
- The install checklist and `aos upgrade`'s line to an Obsidian-era vault name where to download the app.
- The Files tab and the note editor no longer create or change dot-files and dot-folders (`.claude/`, `.codex/`, `.mcp.json`, `.git/`, `.obsidian/`), which they never showed. Edit those in a terminal or another editor.
- Links into the Workbench are `agenticos://` links, which the AgenticOS Workbench app registers: `agenticos://workbench?tab=<tab>` from the status line, and `agenticos://note?file=<vault path>` for a note (the status line's flags link, and "Open in AgenticOS" on a proposal's page, which replaces "Open in Obsidian"). The Workbench still accepts the old `obsidian://agenticos?tab=<tab>` links.
- `aos doctor` shows the Workbench app and its version (`workbench app`, from `brain/_index/hud-host.json`, which the app writes each time it starts) in place of the `obsidian app` and `obsidian plugin` rows, and warns until the app has run once.
- Update notices count the app: the Workbench's version is the app's, read from that same file, no longer the Obsidian plugin's `manifest.json` in the vault. When the app is the part behind, the notice says to update the app (AgenticOS Workbench ▸ Check for Updates…) instead of `aos upgrade`.

### Removed
- Obsidian is no longer required or installed. `aos init` no longer checks for it, no longer installs the HUD into `.obsidian/plugins/agentic-os/` and no longer writes `.obsidian/daily-notes.json`; `aos upgrade` no longer replaces the HUD there; `aos config set dailyNote.layout` no longer rewrites Obsidian's Daily Notes setting. `--no-obsidian`, `--terminal` and `aos terminal install` are still accepted and do nothing (the app brings its own terminal).
- Releases no longer attach the Obsidian plugin (`main.js`, `manifest.json`, `styles.css`); they attach the app (the DMG, and the zip and `latest-mac.yml` its updates use). The Workbench's source stays in `obsidian-plugin/`, which the app compiles; its Obsidian manifest, `versions.json` and bundle build are gone.
- New vaults get no `.obsidian/` folder; an existing one is left alone.

### Security
- **The app's page runs sandboxed** (Chromium's sandbox, context isolation, no Node). The Workbench reads and writes files, starts the runtime and its terminals, and opens links only through a narrow bridge to the app's main process, which checks every call: files only in the vault, LaunchAgents, the app's own data and what the Workbench shows of the Claude Code and Codex folders (skills, agents, `agenticos.json`; never a credential file such as Codex's `auth.json`, never a session transcript); writes only where a Workbench surface writes; only the runtime's own commands, the user's installed `node`, `claude` and shells, with no environment of the page's choosing; links over https only. A file that would run when opened (a script, a `.terminal` or `.command` file, an app, a web page the runtime did not write) is shown in Finder instead, and a folder only ever goes to the Trash. Packaged builds refuse to start with a debugging switch. The review is in `SECURITY.md`.

### Fixed
- A Homebrew Node no longer breaks AgenticOS after `brew upgrade`. `aos init` and `aos upgrade` record Homebrew's stable link (`<prefix>/opt/<formula>/bin/node`) instead of the versioned `Cellar/` path, which `brew upgrade` deletes, and the schedules use it too. `aos doctor` warns about a `Cellar/` path still recorded.
- A Workbench drawer's ✕ no longer sits under the scrollbar macOS shows after the drawer scrolls, where a click hit the scrollbar instead.
- On a machine without Codex, the Routines tab no longer asks the runtime for Codex's automations every minute while it is open (each ask raised a notice). It asks only where Codex is a session host.
- The nightly and weekly reflect duties can promote a repeated correction into a feedback memory again. Since the duty write scope (0.14.0) they were refused `brain/memory/feedback/` and `MEMORY.md`, journaled the block and raised a flag in `persona/STATE.md` on every run that tried. Both duties now get those two paths, and nothing else in `brain/memory/`. Codex cannot grant a single file at the vault root, so after a clean reflect run the runner adds the `MEMORY.md` line of each new feedback memory the duty did not index, on both hosts.

## [0.21.0] — 2026-09-28

### Added
- **The status line** (`aos statusline install`, opt-in). Claude Code gets three lines: model and effort, the task in progress (else the GSD phase), branch and PR; context, rate limits, cost, prompt cache and lines changed; and, only when something needs you, the gates waiting on you, unread breaking news and alerts, open flags, a live agent-team run, the spend nearest its daily cap, an update, a provider that fell to none or an unwrapped session, each a link to the Workbench tab that handles it. The status line you had is recorded and chained (it still runs, with the same input) and `aos statusline uninstall` puts it back, byte for byte when nothing else in the file changed. Subagents get their own rows. Codex runs no status line command, so install writes a preset of its built-in items into `config.toml`, never over one you set without `--force`, and what needs you is printed at session start. `aos doctor` and the next session start say when another installer took the slot; `aos upgrade` keeps an installed line pointed at the current runtime and never takes a lost slot back. Settings: `statusline.segments`, `statusline.links`, `statusline.subagents`, `statusline.refreshSeconds`, `statusline.codexItems`.
- `obsidian://agenticos?tab=<tab>` opens the Workbench on a tab.

### Changed
- The Obsidian status bar shows what needs you (gates, alerts, flags, a live run, spend near its cap, health), each opening where it is handled, instead of inventory counts; a vault whose runtime predates the status line keeps the counts.

### Fixed
- Opening a Workbench tab from a command or link right after Obsidian starts (a deferred leaf) now lands on that tab.
- `idle` in the Obsidian status bar is dimmed.

## [0.20.3] — 2026-09-28

### Changed
- The Agent Teams tab hands the next step to the team's lead. After you approve a gate, or raise the budget of a paused item, the tab opens the lead in the terminal with a prompt saying what you decided, that it is already recorded, and how to run `aos team` for this vault: its agent on the lead's own provider when that host is enabled and has it, else another enabled host. The Approve dialog says where it opens; where no enabled host has the lead's agent, a plain session opens, told which lead to act as and where the team's rules are. If no terminal can start, the command is copied to the clipboard and shown in a notice that stays until you dismiss it. The lead still picks the next seat; the tab never dispatches one. Before, the item waited with the lead as its owner until someone started the lead.

## [0.20.2] — 2026-09-28

### Changed
- Update notices count the Workbench. The installed version was the lower of the Claude Code or Codex plugin and the vault's runtime, so a Workbench an upgrade could not replace looked current. It now also counts the Obsidian plugin's own `manifest.json` in the vault, read at every check and session start: the notice names it ("plugin 0.20.1, vault 0.20.1, Workbench 0.20.0"), and the statusline and the Workbench's update badge stay on until it is replaced. A Workbench whose `manifest.json` is missing or invalid counts as an incomplete install ("Workbench incomplete"), and `aos upgrade` refreshes the update check before rescanning, so the badge is right as soon as it finishes. A vault without the Workbench (`aos init --no-obsidian`) is judged as before.

## [0.20.1] — 2026-09-28

### Fixed
- `aos upgrade --from-local` no longer installs an old Workbench. The Obsidian bundle's `main.js` is a build output kept out of git, and the upgrade built it only when it was missing, so a checkout holding one from an earlier build installed that old code beside the new `manifest.json` and `styles.css` (0.20.0 showed no Agent Teams tab). A checkout with its dependencies installed now always rebuilds; a `main.js` older than the plugin's sources is never installed, and the upgrade says why and tries the release bundle instead.

## [0.20.0] — 2026-09-28

### Upgrading
- Add `persona/teams/*/running/` to your vault's `.gitignore` (new vaults get it): a live agent-team run's marker exists only while the run is going.
- Add `*.lock` and `*.tmp` to your vault's `.gitignore` (new vaults get them): a writer's lock and temp files exist only for the moment of a write, but an auto-backup at that moment would commit them.

### Added
- **Agent teams** (`aos team`, `/team` · `$agenticos:team`): named teams in `persona/teams/<team>/` with a roster (`TEAM.md`), a work board, a team thread and a run log. A lead moves items through stages and gates and dispatches headless seats, each in its own git worktree, on the provider its `TEAM.md` row names; a reviewer marked `opposite` runs on the provider that did not build the work. Gates, budgets, pausing and roster changes are the user's decisions and are refused under `AOS_HEADLESS=1`, and every board write can be a compare-and-set with `--expect`. A killed run still leaves a trace (a live-run marker, signal traps, a sweep), `dispatch --detach` hands a run to launchd or a systemd user unit, and `aos team wait` tells a lead's caller when a run ended. Spend is recorded as `team:<team>:<member>` (Codex priced from tokens), shown by `aos status` and kept out of the hook cap; each item's phase budget caps its Claude spend. A team's lead joins the Runs tab's orchestrator roster, so its seats roll up under it. `aos team init` seeds an example team. Only a clean, successful seat run merges into the item's trunk; the lead takes held work with `aos team merge`, and parallel seats split an item's budget with `--max-usd`.
- **The Agent Teams tab** in the Workbench (⁂, after Agents): the gates waiting on you across every team come first, each with the lead's case, the spend, budget presets and − / +, **Approve** and **Redirect** (which opens the lead in the terminal to take your note). Then one team at a time: its work board by stage, with each item's detail, posts, runs and budget; its roster, with what each member is doing and a button to talk to it on each host; its channel, with a message box to the lead; and Manage, where provider, model and effort are pickers, pausing is a switch, and members are added from your agents. The tab reads `persona/teams/` itself and writes only through `aos team`, sending the state it showed so a stale card is refused, and the rail badge counts pending gates.
- `summary.everyPrompts` (default 10) and `summary.minMinutes` (default 15): how often the working-memory summary refreshes BRAIN.md's Last Session, as pickers in ⚙ Settings → Memory & scanning.

### Changed
- `aos team list` lists a team whose `TEAM.md` cannot be read as a row with its error instead of failing, and `aos team list --json` names the presets `aos team set` accepts.
- The `feedback_rules` MCP tool returns an index of the active rules (path, title, one-line description, updated), newest first; `full: true` adds each rule's text and `limit` keeps the newest. On a vault with 70 rules one call went from about 20k tokens to about 5k. `feedback-review` asks for the text; `cross-review` reads the index and then only the rules it needs.
- `memory_list` returns the same kind of index grouped by type, with `type` and `limit` filters, instead of every memory's frontmatter; `session_recall` cuts a daily note at `maxChars` (default 24,000) and says how to read the rest. Every MCP tool's JSON is compact.

### Fixed
- A row appended to a log whose last line has no newline (a crash mid-append, a hand edit) is no longer joined to that fragment and lost with it: every JSONL writer now starts the row on a line of its own. On a team board this was a gate approval that reported success while the gate stayed pending.
- Files the runtime changes from several processes at once no longer lose a write. `routines.json` (a routine's run against `aos routines sync`, which wrote back a state it read before installing the schedules), `MEMORY.md`, `SESSION.md`, BRAIN.md's Last Session (against the BRAIN.md compile) and the daily note are now changed under a lock, as they are at that moment; every writer that used a shared `<file>.tmp` has a temp name of its own.
- A session's cost is counted once. The cost sync used to rewrite `runs.jsonl` to patch the whole session's cost into every row of the session, so a session with two runs counted twice ($213 on one vault), and a run that ended while it rewrote the file could be lost. Costs now go to their own log, `brain/_index/agent-runs/costs.jsonl`, and `runs.jsonl` is only ever appended to (retention prunes both under a lock the writers wait on). The Workbench's Runs tab, Cost panel, Fix Queue and the monthly budget read the two together: the session's cost on its latest run, its earlier runs at $0 pointing to it. Rows costed before this release are read the same way; nothing is rewritten.
- One session no longer turns into several runs, each wrapped as if it were the whole session. The Workbench's load-time sweep read the telemetry hook's own process id, which is always gone, so it marked every session idle for 5 minutes "crashed", and the session's next tool call started a new run. The plugin now runs the runtime's own reconcile instead (idle past `telemetry.staleAfterMinutes`, or a Codex process that exited). A session that goes on after its run was closed is recorded as a second segment with its own run id and timeline instead of overwriting the first, and auto-wrap keeps a per-session offset, so a later wrap of the same session extracts only what is new and skips when nothing is.
- The working-memory summary ran every few minutes in a busy session and not at all in the next one. It counted every user-role entry, and Claude Code writes each tool result and slash command as one (43 for 2 prompts in one transcript), against a single marker per day shared by every session. It now counts only the prompts you type, keeps one marker per session on both hosts, and runs every 10 prompts at most every 15 minutes.
- `feedback_rules` and `memory_list` no longer return the correction detector's unreviewed drafts (`brain/memory/feedback/_drafts/`) as rules and memories.
- The terminal no longer leaks listeners. Every visit to Pulse or Term left three terminal-pool listeners behind for as long as Obsidian ran, and a closed panel kept redrawing its tabs; each panel now removes its own when it closes.
- The Pulse command deck's `/reflect` only printed a prompt meant for a session and wrote nothing. It is now `/reflect-week` and writes this week's reflection to `brain/reflections/` in one click through the model provider (the reasoner model, within `reasoner.perCallUsd` and `reasoner.perDayUsd`); the notice shows the saved path, or why no model was available.
- The deck's `/remember` and `/pattern` filed a feedback memory. `/remember` now adds the note to `SESSION.md` with `#promote`, under "Things to Remember" (or "Promote to Memory on Close" for a `feedback:`, `project:` or `pattern:` note), and `/pattern` adds a pattern to `brain/patterns/<area>.md`, listing a new area file in `MEMORY.md`, the same as the in-session `/remember` and `/pattern`.
- A deck command that reports on stderr (as the runtime scripts do) shows that line in its success notice instead of "ok".

## [0.19.2] — 2026-09-24

### Fixed
- BRAIN.md no longer stops updating when active projects outgrow its 850-token budget. Session-end extraction files every new project as active, and the compiler used to fail once they crowded out the "Last Session" block, so every session started with the old BRAIN.md. It now lists active projects newest first (by `updated`), keeps as many as fit, and ends the list with "…and N older active projects" pointing at `brain/_index/MOC-projects.md`. Only pinned rules that overflow on their own still fail the build. The pipeline ledger records the count as `activeProjectsOmitted`.
- ⚙ Settings' Codex model pickers now list the models your Codex offers (GPT-6 and GPT-5.6 included), read from Codex's own `models_cache.json`, which Codex keeps current; without a Codex cache they fall back to the pricing table's list.

## [0.19.1] — 2026-09-24

### Fixed
- ⚙ Settings said "no `aos config`, run `aos upgrade`" on 0.19.0: `aos` exited before a pipe had taken all its output, so the Workbench read `aos config list --json` cut off at 64 KB. Every `aos` command now exits only after its output is flushed, and the tab names the real reason when the output does not parse.

### Added
- Duty model and effort are settings: `aos config set persona.model <model>` and `aos config set persona.effort low|medium|high`, then `aos routines sync`. They win over the interview's answers, which stay the fallback; the Codex duty model stays `persona.codexModel`.
- One duty can run on its own model: `model:` and `effort:` in `brain/routines/<duty>.md` override the schedule's for that duty (for example the hourly tick on `haiku`, the weekly reflect on a bigger model). The Workbench Routines tab accepts them too.

### Upgrading
- Nothing to do. To move the duties to another model, set `persona.model` and run `aos routines sync`; raise a duty's `budgetUsd` in its routine file if the new model costs more per run (the hourly tick's is 0.10 USD).

## [0.19.0] — 2026-09-24

### Added
- ⚙ Settings has no text boxes: every setting is a toggle, a preset picker, chips or a button. Numbers also step with − / + to the next preset; model pickers list each host's models (Codex's from its pricing table); lists are chips; `quickLinks`, the roster and external labels open `brain/config.json`, and skill and agent exclusions open their tabs. A value set outside the presets is shown as "(custom)" and never changed by opening the tab; set any value with `aos config set`. Obsidian's own settings pane gets the same pickers.
- `aos config list --json` rows carry `choices`, `unit`, `pick` and `editIn`.
- **Notifications.** Agents, routines and duties on either host post with `aos notify post`. Each post is a Markdown note under `brain/notifications/`, with a level (`breaking`, `alert`, `edition`, `info`), optional tags and allow-listed actions.
  - A new Workbench **Notifications** tab lists the items with an unread badge (rose while a breaking item is unread), filters by view, level and sender, and read, archive and open-note controls.
  - Actions: **ask** runs a named skill in a new Claude Code or Codex session, and **react** records a +1/−1 the sender can read back.
  - `breaking` and `alert` items raise a desktop notification.
  - `/notifications` (Claude Code) and `$agenticos:notifications` (Codex) do the same from a session.
  - New settings: `notifications.osAlert`, `notifications.retentionDays` and `notifications.maxPerSenderPerHour`.
  - `recallRoots` now includes `brain/notifications`, so past items are searchable.

## [0.18.0] — 2026-09-24

### Added
- ⚙ Settings, pinned to the bottom-left of the Workbench rail: every setting of the whole system in one tab, built from `aos config`. Master switches head it; each row shows where its value comes from (this machine, this vault or the default), when a change applies, and a ↺ to go back to the default; spend limits show today's spend against the cap. A change runs `aos config set`, so a refused value is explained under its field; raising spend or widening an agent's autonomy asks first; a step a change leaves (`aos routines sync`) waits as a button, counted on the ⚙ badge. Also "Open Workbench: Settings" in the command palette and a button in Obsidian's settings pane.
- `aos config list --json` rows carry `host` (a Claude- or Codex-only setting) and `spentToday` (on each daily cap).

### Changed
- The HUD's Cost and Telemetry toggles are now the system's own switches, `cost.enabled` and `telemetry.enabled`: turning Telemetry off stops the hooks recording, not just the HUD's view. The old HUD-only values are dropped from the plugin's `data.json`.
- The Workbench rail scrolls its tab buttons when the pane is short, so none is cut off.

### Upgrading
- If you turned the HUD's Cost or Telemetry toggle off without changing the system setting, check ⚙ Settings once after upgrading: the HUD now shows what the system does.

## [0.17.0] — 2026-09-24

### Added
- `aos config list | get | set | unset`: every setting in one place, with the file each value comes from. `set` validates the value, writes it atomically to the file that actually wins the merge, and runs the side effects the change needs. It works from a terminal, from `/aos config` in Claude Code and from `$agenticos:aos config` in Codex. First step toward the Workbench Settings tab.
- `aos doctor` has a `config` row that flags unknown keys (typos) and invalid values in `agenticos.json` and `brain/config.json`.

### Changed
- `persona.enabled` set through `aos config` is the whole Chief of Staff switch: `false` also pauses scheduled duties (`persona/DISABLED`). `aos persona on|off` still pauses duties alone.
- `scan.autoSweepOrphans` in the vault config now turns the orphan sweep on; a boolean in `brain/_index/scanner-config.json` still wins.
- Every writer of `agenticos.json` and `brain/config.json` (`aos provider`, `aos cost`, `aos graph`, `aos persona`, init and upgrade) writes atomically, so a hook never reads a half-written file.

### Fixed
- A daily cap of `0` now means no spend for `codex.perDayUsd`, `reasoner.perDayUsd`, `graph.semantic.perDayUsd` and `crossReview.perDayUsd`, as it already did for the Claude, persona and routine caps; it used to fall back to the default.

### Upgrading
- Run `aos upgrade`; until then the launcher answers `aos config` with `unknown script config`.

## [0.16.0] — 2026-09-23

### Changed
- Release notes come from this CHANGELOG; a release builds in a read-only job and publishes from a separate one, and every GitHub Action is pinned to a commit (#41).
- CI type-checks the HUD, lints the JavaScript (eslint) and the shell scripts (shellcheck), and runs every suite in two extreme time zones with host variables exported (#41).

### Fixed
- Codex sessions now close in telemetry as soon as the Codex process exits, instead of waiting out the stale-session timeout (#40).
- The MCP server reports the release version instead of 0.1.0: the runtime's own `package.json` is now bumped with every release (#41).
- An accepted proposal's own sub-headings now nest under its What and Why in `persona/backlog.md` (#41).

## [0.15.0] — 2026-09-23

### Added
- Universal agents: an Agents tab and one agent set for both hosts (#39).

## [0.14.0] — 2026-09-23

### Added
- Universal skills: a Skills tab and one skill set shared between Claude Code and Codex, synced automatically each session (#38).

### Security
- Private terms used by the privacy gate (names, paths, and other sensitive identifiers) now load from a local, gitignored file instead of shipping in the repository (#35).
- Chief of Staff duties can now write only inside their own scope — journal, state, proposals, and similar files — on both hosts, closing a path for a prompt-injected duty to edit scripts or trust files (#36).

### Upgrading
- The privacy fix above required rewriting and force-pushing this repository's history to purge terms that had already been committed. If you cloned before this release, discard that clone and clone again — a pull will conflict.

## [0.13.0] — 2026-09-23

### Added
- Cross-review and handoff: Claude Code and Codex can review each other's plans, or hand off a task to the other model, on both hosts (#34).

## [0.12.0] — 2026-09-23

### Added
- The vault graph's daily semantic pass now also runs under Codex (#32).

### Fixed
- Skills, `aos upgrade`, `aos status`, and on-screen text now name the host you're actually using under Codex instead of assuming Claude (#30).
- The reasoner role and structured tool-call requests now work correctly under Codex (#31).
- Cost tracking and the file/session inventory now follow whichever host you're on (#33).

## [0.11.3] — 2026-09-23

### Fixed
- `aos upgrade` now follows a marketplace that was added from a local checkout (#29).

## [0.11.2] — 2026-09-23

### Fixed
- The vault graph's semantic-pass timestamp now survives a structural-pass rebuild (#28).

## [0.11.1] — 2026-09-23

### Fixed
- The vault graph's lock is no longer broken while its owner process is still alive (#27).

## [0.11.0] — 2026-09-23

### Added
- `aos init` installs a pinned graphify and builds a structural vault graph on every scan (#24).
- `graph_*` MCP tools and a graph skill for querying the vault's structure (#25).
- A daily semantic pass enriches the vault graph, metered on its own spend budget (#26).

### Upgrading
- Install [uv](https://docs.astral.sh/uv) if you don't already have it. `aos init` now requires it, and `aos upgrade` will warn — without failing — that graphify can't install until it's present.

## [0.10.0] — 2026-09-23

### Added
- AgenticOS ships as a Codex plugin as well as a Claude Code plugin (#23).

### Upgrading
- An existing Codex install that used the old direct hook wiring moves over to the Codex plugin automatically on your next `aos upgrade`. Review and trust the new hook entries once under `/hooks` in Codex; that trust then survives future upgrades.

## [0.9.2] — 2026-09-23

### Security
- Recipe guard: proposal recipes now run only inside a read-only grammar, limiting what an auto-applied proposal can do (#22).

## [0.9.1] — 2026-09-23

### Added
- Every proposal now gets its own page in the Proposals tab, in one format, with an HTML page (#21).

### Fixed
- Duty date placeholders now fill with the local day (#20).

## [0.9.0] — 2026-09-22

### Added
- Proposals tab in the HUD, with rail count badges (#18).
- To-do tab and `/todo` command (#19).

## [0.8.0] — 2026-09-22

### Changed
- Obsidian, Ollama, and python3 (3.9+) are now mandatory prerequisites of `aos init`; `--provider none` no longer waives them (#15).

### Upgrading
- Obsidian, Ollama, and python3 (3.9+) are now required. `aos upgrade` itself won't fail if they're missing, but `aos doctor` will start reporting them as failures, and running `aos init` fresh will refuse to proceed without them.

## [0.7.0] — 2026-09-22

### Added
- Host routines: Codex Automations and Claude Code cloud routines now appear in the Routines tab (#7).
- Persona heartbeat watchdog and a proposal outcome ledger (#8).
- Hourly "tick" duty with a heartbeat pill in the HUD (#9).
- Nightly reflection, an idea backlog, and an early-reflect trigger (#11).
- Earned autonomy for the persona: recheck confirmations, class stats, and auto-applied proposals once trust is earned (#13).
- Codex parity: one vault now works from either host, auto-detected, with session reconciliation for Codex's late `SessionEnd` (#14).

### Fixed
- Raised the tick duty's daily budget to $0.10 (#10).
- Reflect and ledger scripts now also accept vault-relative paths (#12).

## [0.6.0] — 2026-09-21

### Added
- `workspaces/` becomes the tracked home for Claude Code and Codex projects, with an `aos workspace` command to create or adopt one and per-workspace session counts in the HUD (#6).

## [0.5.0] — 2026-09-21

### Added
- Codex CLI can now be used as a session host, alongside or instead of Claude Code (`aos init --host codex|both|auto`) (#5).

## [0.4.0] — 2026-09-21

### Added
- Routines tab: recurring actions defined as files, run by one scheduler, surfaced in the Workbench (#3).

### Fixed
- `aos upgrade` now runs the checkout's own CLI instead of a stale copy already in the vault (#4).

## [0.3.0] — 2026-09-21

### Changed
- The workhorse model moves to qwen3.5:9b, and the reasoner role now uses Claude Opus 5 by default instead of a local Ollama model; gpt-oss is retired (#2).

### Upgrading
- `ask`, `reflect-week`, `consolidate-memory`, and the HUD Chat tab now reason through hosted Claude Opus 5 by default, falling back to the local workhorse only if Claude is unavailable. Spend is capped by a new `reasoner` config block and shown as its own line in `aos status`.

## [0.2.0] — 2026-09-15

### Added
- Sidebar HUD shows an update-available pill, next to the update notice already printed at session start.

## [0.1.0] — 2026-09-15

The first public release: an `aos` CLI, the AgenticOS runtime, a Claude Code plugin, and the Obsidian HUD.

### Added
- `aos` CLI: `init`, `doctor`, `status`, `provider`, `upgrade`, `uninstall`, `terminal`, `persona`, and `cost` subcommands, plus a vault template (seed tree, AGENTICOS.md, Obsidian seeds).
- Claude Code plugin: marketplace manifest, 14 slash commands, hooks, and the `agenticos` MCP server.
- Provider system that auto-resolves between a local Ollama model, headless Claude, or none, with a spend ledger and daily/per-call caps.
- Memory pipeline: the `wrap_session` tool, auto-wrap, and heuristic (or model-backed) summarization of working memory, file maps, and workspace insights.
- Persona ("Chief of Staff"): an identity interview, scheduled duties with launchd/cron templates, persona-flag-closer and persona-sitrep skills, and a cost analyzer.
- Obsidian HUD plugin: a dashboard reading vault and config state, a pipelines view, budget and cost tabs, and a provider-aware Chat tab.
- Opt-in in-HUD terminal, built from source on install.
- Update notifications: a GitHub release check surfaced as a session-start notice.
- Docs: README, install guide, and a release acceptance runbook.

[Unreleased]: https://github.com/zzoretich/UniDeX-Agent-Harness/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v2.0.0
[1.9.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.9.0
[1.8.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.8.0
[1.7.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.7.0
[1.6.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.6.0
[1.5.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.5.0
[1.4.1]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.4.1
[1.4.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.4.0
[1.3.1]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.3.1
[1.3.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.3.0
[1.2.1]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.2.1
[1.2.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.2.0
[1.1.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.1.0
[1.0.1]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.0.1
[1.0.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v1.0.0
[0.21.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.21.0
[0.20.3]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.20.3
[0.20.2]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.20.2
[0.20.1]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.20.1
[0.20.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.20.0
[0.19.2]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.19.2
[0.19.1]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.19.1
[0.19.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.19.0
[0.18.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.18.0
[0.17.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.17.0
[0.16.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.16.0
[0.15.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.15.0
[0.14.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.14.0
[0.13.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.13.0
[0.12.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.12.0
[0.11.3]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.11.3
[0.11.2]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.11.2
[0.11.1]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.11.1
[0.11.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.11.0
[0.10.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.10.0
[0.9.2]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.9.2
[0.9.1]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.9.1
[0.9.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.9.0
[0.8.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.8.0
[0.7.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.7.0
[0.6.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.6.0
[0.5.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.5.0
[0.4.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.4.0
[0.3.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.3.0
[0.2.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.2.0
[0.1.0]: https://github.com/zzoretich/UniDeX-Agent-Harness/releases/tag/v0.1.0
