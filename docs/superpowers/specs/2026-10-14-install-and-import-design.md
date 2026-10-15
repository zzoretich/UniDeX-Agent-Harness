# UniDeX 2.0, track B: install with nothing pre-installed, arrive with your history — design

**Date:** 2026-10-14
**Status:** approved 2026-10-14 as written. *(user)* rows are the owner's answers from the decision interview; the rest are proposed technical decisions.
**Base:** `main` at `b63e14c` (1.9.0 plus the §8 record). The app's wizard and policies, `cli/aos.js` init and upgrade, the runtime (a new importer), the HUD (Sessions, Spaces, Skills/Agents, Pulse).
**Plan:** `docs/superpowers/plans/2026-10-14-unidex-2-0.md` (PRs 5–7, 9). Sibling specs: `2026-10-14-local-first-design.md` (A), `2026-10-14-guided-tour-design.md` (C). Code comments cite `install-import B<n>`.

---

## 1. Problem (verified at b63e14c)

1. **Five prerequisites and a host before anything installs.** Hard gates: Node ≥ 20, Ollama, python3 ≥ 3.9, uv, and at least one installed, signed-in host (`app/src/main/setup/preflight.ts:119-139`, `cli/aos.js:938-988`). Every Fix is a Homebrew or npm command in a pty (`app/src/main/policy/setup.ts:45-60`), so Homebrew is a de-facto prerequisite. The app's own Electron cannot run the runtime: the `runAsNode` fuse is off (`app/electron-builder.yml:74-75`).
2. **A new vault is empty though the user has months of history.** Nothing reads CLAUDE.md's content, Claude Code's auto-memory (`<claude>/projects/*/memory/*.md`), `~/.codex/AGENTS.md`, or either host's MCP servers. `collectors/hostSessions.js:322-430` indexes every transcript's *metadata* into `session-index.json`, but Sessions lists only app-run threads (`obsidian-plugin/src/services/sessions.ts`), Brain ▸ Review is empty, and Spaces shows past folders as "Outside workspaces" without creating any.
3. **Existing users never got an import either**, and 2.0 must reach them.
4. **Manual steps remain:** the Codex `/hooks` trust, `~/.local/bin` on PATH for `aos`, `aos persona` after a skipped step.

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| B1 | *(user)* **No Homebrew, no terminal.** The wizard installs what is missing itself: a private Node LTS (the official darwin tarball, its SHA-256 checked against `SHASUMS256.txt`) under `~/.local/share/unidex/node/<version>` with a `current` symlink that `agenticos.json` `node` points at; uv from Astral's standalone release (checksum) into `~/.local/bin`, which fetches graphify's Python itself; the Ollama app from ollama.com, verified (`codesign --verify --deep --strict`, the expected Team ID, `spctl -a`), into `/Applications` (else `~/Applications`), opened hidden; Claude Code by its native installer; Codex by its standalone release. A present tool that meets the version floor is reused. Homebrew is no longer checked. | Bundling Node in the app (+45 MB, re-signing). Keeping brew fixes. |
| B2 | *(user)* **A host is optional.** `aos init --host none` and the wizard's "No agent CLI yet" install the vault, the runtime and local background work. Settings ▸ Hosts "Add Claude Code / Codex" installs, signs in and runs `aos hosts add <host>`: plugin or Codex wiring, that host's import, the CoS schedule. | Requiring one host. |
| B3 | *(user)* **Import everything:** instructions and memories, session history, projects → Spaces, skills/agents/MCP. | Subsets. |
| B4 | *(user)* **90 days digested now, older on request** (`aos import --since all`, a button in Settings ▸ Import). | Everything. 30 days. |
| B5 | *(user)* **The digest writes:** a back-filled `## Sessions` section in each day's daily note (title, host, workspace, one-line summary, link to resume); a timeline per workspace (`workspaces/<ws>/history.md`, newest first); at most 3 memory candidates per session, deduplicated against existing memories, landing in Brain ▸ Review as one "Imported from Claude Code" / "Imported from Codex" batch. | Memories only. Notes only. |
| B6 | *(user)* **Writes into host config are per item, on click,** for MCP servers and Claude commands ↔ Codex prompts: the item shows the exact file or command, backs the target up first, and goes through the host's own CLI (`claude mcp add-json --scope user`, `codex mcp add`). Skills and agents keep the shipped automatic mirror (`skills-sync.js`, universal-skills D5, universal-agents D5). | Mirroring everything. Read-only. |
| B7 | **The importer is runtime code** (`brain/scripts/lib/import/*`, verb `aos import [--from claude\|codex\|all] [--since 90d\|all] [--only …] [--dry-run] [--json]`). The renderer may only list the hosts' folders (`app/src/main/policy/read-scope.ts:1-6`); the app spawns the verb through a new surface `import` (`app/src/shared/surfaces.ts`). | An importer in main or the renderer. |
| B8 | **Instructions and memories.** Claude auto-memory files keep their type (`lib/memory-fix.js` maps the frontmatter). Global `CLAUDE.md` and `AGENTS.md` split by heading and bullet into rules, which the local model classifies as user, feedback or reference (no engine: the whole file becomes one `reference` memory). Each is written by `memory-writer.writeMemory` with `source: import:<host>`, `origin: ~/…`, `reviewed: false`; a content hash in `brain/_index/import-state.json` makes re-runs idempotent. The `@<vault>/AGENTICOS.md` line, the vault's own files and a project's `CLAUDE.md`/`AGENTS.md` (linked from its workspace, never copied) are skipped. | Copying files verbatim. |
| B9 | **Projects.** From `session-index.json`'s outside rows in the window, grouped by git root: propose a workspace for each root with ≥ 3 sessions or any session in the last 14 days, named after the repo, with `repo:` set; the rest stay outside rows. The wizard shows the list preselected; existing installs confirm the same list in the Import sheet. | Creating one per folder. Asking per row. |
| B10 | **The digest is a shipped command routine,** `import-digest`, every 30 min while work remains (it disables itself when done): ≤ 10 minutes a run, defers on battery (local-first A18), resumable from a cursor in `import-state.json`; it records `wrap-offsets` so a later auto-wrap of the same session extracts nothing twice. Fast parts (instructions, memories, projects, MCP listing) run at import time with progress. | One long blocking pass. |
| B11 | **Sessions gains History:** past host sessions from `session-index.json` plus the digest's summaries (`brain/_index/session-digests.json`), grouped by day, with Resume in the Code tab (`claude --resume <id>` / `codex resume <id>`) only for an enabled host. The HUD reads caches, never transcripts. | Rendering transcripts in the HUD. |
| B12 | **Existing users** get the import through the migration mechanism (local-first A9): an upgrade from < 2.0.0 records `import` pending; the launch sequence (guided-tour C11) shows the Import sheet once; the CLI prints `aos import`. | A silent import on upgrade. |
| B13 | **Wizard steps:** Check → Choose → Your agent → Install → **Bring in your history** → Finish. The new step shows counts per host and kind (`aos import --dry-run --json`), all preselected; Import runs the fast phase with progress and queues the digest. Finish lists what is left, each with click-by-click instructions (Codex `/hooks`) and the tour's first step. | Importing after Finish only. |
| B14 | **PATH:** Finish offers "Add `aos` to my PATH", which appends one shown line to `~/.zprofile`; unchecked, the app still runs `aos` by its full path. | Editing shell files silently. |
| B15 | **Nothing leaves the Mac.** The importer reads local files and runs on the local engine; with no engine the fast phase runs heuristically and the digest waits. | — |

## 3. What already exists

`lib/host.js` (`hostDirs`, `sessionFiles`, `findTranscript`), `lib/transcript.js` (both formats, `sessionHead`), `collectors/hostSessions.js` (index + workspace attribution: cwd, `repo:`, `aliases:`, worktree, files touched), `memory-writer.writeMemory`, `memory-fix` types, brain-hub duplicate detection and Review batches, `auto-wrap.wrapCycle` with `wrap-queue` and `wrap-offsets`, `cli/workspace.js` (`new`, `adopt`), `lib/skills.js`/`lib/agents.js` mirroring, `host-catalog.js` (Codex MCP names), the wizard's JobRunner and pty, `migrateRoutines`' version gating.

## 4. Design

**Toolchain (PR 5).** `app/src/main/setup/toolchain.ts` owns downloads: a pinned manifest of URLs and checksums per tool in the app, a fetch through Electron's `net` (proxy-aware), verification before anything is moved into place, progress events to the wizard. A failed verification deletes the download and shows a Retry. `policy/setup.ts`'s Fixes become toolchain jobs; `preflight.ts` drops Homebrew and makes hosts optional; `aos init` accepts `--host none` and warns, rather than refusing, without Ollama (CLI users install it themselves).

**Import (PR 6).** Phases: `scan` (counts, no writes; what `--dry-run` prints), `instructions`, `memories`, `projects`, `mcp` (list only), then `digest` (queued). Each phase is idempotent and records itself in `import-state.json` `{phase, host, done, cursor, counts}`. Dedup: content hash, then brain-hub's title Jaccard and BM25 (and embeddings when present) against the existing memories. The digest prompt asks the local model for `{summary, workspace?, memories[≤3]}` as JSON (`ollama.js` `format`).

**HUD (PR 7).** Sessions ▸ History; Spaces' proposed workspaces in the Import sheet; Skills/Agents gain an MCP section listing both hosts' servers with "Make available on …"; Pulse shows import progress ("Digesting history: 140 of 412 sessions") until done; Brain ▸ Review labels the imported batches.

## 5. Host parity

1. **Entry point:** `aos import` (host-neutral), the wizard step, Settings ▸ Import. No in-session command.
2. **Hooks:** none added or changed.
3. **Model calls:** the digest and the rule classifier through `provider.js` (`local`); heuristics when it resolves to none. No hosted call (local-first A1).
4. **Session data:** through `host.js`/`transcript.js`, both formats, Claude subagent transcripts skipped; tests per host with fixture transcripts.
5. **MCP:** reads Claude's user-scope servers and Codex's `config.toml` `[mcp_servers]`; writes only on click through the host CLIs.
6. **Degradation:** data is imported for whichever host left files on disk, even if its CLI is gone; Resume and "Make available on …" appear only for enabled hosts.
7. **Docs:** `docs/install.md` rewritten (no Homebrew, host optional, import), a `docs/migrating-to-2.0.md`, README, app-smoke items per host with `COVERAGE.md` rows.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | wizard step, Settings ▸ Import, `aos import` | reads `<claude>/projects`, auto-memory, `CLAUDE.md`, user MCP servers | — |
| Codex only (plugin · direct) | same | reads `sessions/`, `archived_sessions/`, `AGENTS.md`, `config.toml` MCP | Claude rows absent |
| Both | same (`--from all`) | both, deduplicated across hosts | — |
| No host | same | whatever host data is on disk | "Nothing to import yet"; the step is skipped |

## 6. Out of scope

Importing Claude Code cloud routines or Codex automations (already listed by `lib/host-routines.js`); project-scoped MCP servers; other tools' histories (Cursor, Copilot); Windows and Linux installers; writing `runs.jsonl` rows for past sessions; trusting Codex hooks for the user (only Codex's own UI can).
