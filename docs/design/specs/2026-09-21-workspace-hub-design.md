# Workspace hub — design

Date: 2026-09-21 · Branch: `feat/workspace-hub` · Verified against `d88d42a`

## 1. Problem

`<vault>/workspaces/` is meant to be the single home for project working directories
(the owner's migration plan: kebab-case folders, a `CLAUDE.md` per workspace, `_archive/`
and `research/` beside them). Since v0.5.0 a vault has two hosts, and the product only
half-honours that rule:

- `collectors/workspaces.js:13` recognises a project by `README.md`, `CLAUDE.md`,
  `STATUS.md`, `PLAN.md` or `.git`. A Codex-shaped project whose only instruction file is
  `AGENTS.md` is invisible, and `AGENTS.md` is never read for a summary, objectives or a
  next step (`:221`, `:229`, `:263`). `collectors/projects.js:226` records `hasClaudeMd`
  and nothing for Codex.
- Sessions are never attributed to the workspace they ran in. `collectProjects()` indexes
  Claude's `projects/<slug>/` transcript folders by decoded cwd (`:55-70`, `:133-165`) but
  stops there; Codex rollouts (`session_meta.cwd`) are not read at all. The Spaces tab
  therefore cannot show which workspace either CLI has been working in, and nothing tells
  the owner when work is happening *outside* `workspaces/`.
- There is no command that creates or adopts a workspace the way the plan prescribes, so
  every host (and the Codex desktop app in particular) keeps scattering project folders:
  on the owner's machine, ten under `~/Documents/Codex/<date>/` and two under
  `~/Documents/ChatGPT/`.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | `AGENTS.md` becomes a **project marker** and a **source** for summary, objectives and next step, ranked right after `CLAUDE.md` everywhere `CLAUDE.md` is consulted. `projects.js` user-named entries gain `hasAgentsMd` beside `hasClaudeMd`. | Treat only `CLAUDE.md` as the instruction file and ask Codex users to add one. | Codex reads `AGENTS.md`; a Codex-only project legitimately has no `CLAUDE.md`. Both hosts' instruction files describe the project equally well. |
| D2 | A new collector, `collectors/hostSessions.js`, counts sessions **per cwd for both hosts**: Claude from the decoded `projects/<slug>/` folders (one `*.jsonl` = one session), Codex from the first line of each rollout under `<codex home>/sessions/**` (`session_meta.cwd`, `timestamp`). `collectWorkspaces()` attaches `sessions: { claude, codex, total, lastAt }` to each workspace by longest absolute-path prefix; `snapshot.hostSessions` carries `byCwd` and `outsideWorkspaces` (cwds under no workspace, with counts). | Parse whole transcripts through `lib/transcript.js`; or keep a cache file. | Only the cwd and the timestamp are needed; the first line of a rollout and a directory listing are cheap enough to do on every scan, and a cache is one more thing to invalidate. |
| D3 | `aos workspace list \| new <name> \| adopt <path> [--name <slug>]` in `cli/workspace.js`. `new` creates `workspaces/<slug>/` with `README.md`, `CLAUDE.md` and `AGENTS.md` stubs (`CLAUDE.md` is the source; `AGENTS.md` carries the same text, since Codex cannot include it). `adopt` moves an existing directory into `workspaces/` (rename, copy-then-remove across devices), refuses the vault itself, a config dir, a home or root directory, and a target that exists, then adds any missing stub. `list` prints every workspace with its per-host session counts and the cwds seen outside `workspaces/`. Slugs are lowercase kebab-case, the owner's plan §2. | A `/workspace` slash command (a 16th command); or moving folders automatically at init/upgrade. | The CLI is reachable from either host through `aos`; the command lock stays at 15 and the smoke and README counts do not move. Moving a user's folders is never the installer's call. |
| D4 | The home rule is stated **in the vault's conventions**, so both hosts read it: `AGENTICOS.md` gains "Projects live in `workspaces/`; create new project directories there (`aos workspace new <name>`)". Health adds one *info* issue when sessions ran outside `workspaces/`. | Write Codex `[projects."…"] trust_level` entries or an `AGENTS.md` under `workspaces/` at init. | The installer never edits a user's instruction or trust files (D5 of the Codex spec); Codex prompts for trust per project root anyway. Info, not warn: work outside the vault is legitimate, the owner just wants to see it. |
| D5 | The HUD **Spaces tab** shows a sessions chip per workspace (`claude 12 · codex 3 · 2d ago`) and an "Outside workspaces" footer listing stray cwds with counts. Logic in `src/data/hostSessions.ts` (tested); the view stays thin. | A new tab. | Spaces is the workspace view; the attribution belongs on the card it describes. |
| D6 | The **machine-side move** is a separate, owner-confirmed step done with `aos workspace adopt`, not part of the product change. The design recommends adopting the six non-empty Codex/ChatGPT folders and deleting the five empty ones; Codex's `[projects.*]` trust entries for the old paths are left alone. | Script the move into `aos upgrade`. | Personal files; reversible only by hand. |
| D7 | `collectProjects()` and `scanner-config.json`'s `extraProjectRoots` are unchanged apart from `hasAgentsMd`. | Fold the workspace scan into `collectProjects()`. | Two collectors with two shapes already feed two HUD surfaces; this change adds a third small collector rather than merging two. |

## 3. What already exists (at `d88d42a`)

- `collectors/workspaces.js`: `isProjectLike()` (`:72`), `detectChildren()`, `scanOneWorkspace()`
  (`:190-280`, output shape incl. `absPath`), `collectWorkspaces()` (`:284-315`). Tests in
  `test/workspaces.test.js` with fixtures under `test/fixtures/`.
- `collectors/projects.js`: `decodeRuntimeCwd()` (`:55-70`) turns `-home-alice-proj` into
  `/home/alice/proj` and handles Windows slugs; `hasClaudeMd` at `:226`.
- `lib/host.js` (v0.5.0): `hostDirs('codex').sessions` is the rollout root; `hostDirs('claude').sessions`
  is `projects/`. `lib/transcript.js` reads a rollout's `session_meta`; only its first line is needed here.
- `cli/routines.js`: the verb-module pattern (`VERBS`, `resolveCtx`, `main(argv, { io })`,
  `UsageError`), dispatched from `cli/aos.js:1017`; `plugin/bin/aos` routes CLI verbs by name.
- `collectors/health.js:77` adds an `info` issue from `snapshot.projects.summary`; the same
  shape serves D4.
- HUD: `src/data/snapshot.ts:176-215` `WorkspaceEntry`; `src/views/SpacesTab.ts` renders the
  cards; `src/data/*.test.ts` run under `node --test` with `tsx`.

## 4. Design

### 4.1 Collector (`brain/scripts/collectors/hostSessions.js`)

`collectHostSessions({ claudeProjectsDir, codexSessionsDir, now })` → `{ byCwd: { [cwd]:
{ claude, codex, lastAt } }, scannedAt }`. Claude: for each `projects/<slug>/` matching the
runtime-cwd pattern, `decodeRuntimeCwd(slug)`, count `*.jsonl`, `lastAt` = newest mtime.
Codex: walk `sessions/YYYY/MM/DD/rollout-*.jsonl` (depth 3) and `archived_sessions/`, read the
first line, take `payload.cwd` and `timestamp`. Unreadable or cwd-less files are skipped.
`attachSessions(workspaces, byCwd)` gives each workspace `sessions` (longest `absPath`
prefix wins, path-segment aware) and returns `outsideWorkspaces` sorted by `lastAt` desc.

### 4.2 Workspaces and projects

`PROJECT_MARKERS` gains `AGENTS.md`; the summary, objectives and next-step file lists gain
`AGENTS.md` after `CLAUDE.md`; `detectChildren` subproject summaries fall back to `AGENTS.md`.
`projects.js` adds `hasAgentsMd`. `scan-vault.js` calls the new collector once, attaches, and
stores `snapshot.hostSessions = { byCwd, outsideWorkspaces, scannedAt }`.

### 4.3 CLI (`cli/workspace.js`, dispatched from `cli/aos.js`; `plugin/bin/aos` routes `workspace`)

`slugify(name)`; `STUBS` (README, CLAUDE, AGENTS); `newWorkspace({ vault, name, io })`;
`adoptWorkspace({ vault, source, name, io, configDirs })` with the refusals of D3 and a
cross-device fallback; `listWorkspaces({ vault, io, json })` reads `snapshot.json` when
present (else scans) and prints name, status, sessions, then the outside list. All effects
injectable; `UsageError` for bad verbs.

### 4.4 Health, conventions, HUD

`health.js`: `info · projects · "N session cwd(s) outside workspaces/ (run aos workspace
list)"`. `vault-template/AGENTICOS.md` Conventions gains the home rule (H2 set unchanged).
HUD: `WorkspaceEntry.sessions?`, `Snapshot.hostSessions?`; `src/data/hostSessions.ts`
formats the chip and the footer rows; `SpacesTab.ts` renders them.

## 5. Testing

- `test/workspaces.test.js`: an `AGENTS.md`-only fixture is project-like; summary and
  objectives come from `AGENTS.md` when `CLAUDE.md` is absent.
- `test/host-sessions.test.js`: fixtures for a Claude slug dir and Codex rollouts (including
  a Windows cwd and a cwd-less first line) → `byCwd`; attachment picks the longest prefix and
  never matches a sibling with a shared name prefix; outside list sorted.
- `cli/workspace.test.js`: `new` writes three stubs and rejects a bad name; `adopt` moves,
  refuses the vault, a config dir and an existing target, adds missing stubs; `list --json`.
- `test/collectors-health.test.js` (or the existing health test): the info issue.
- `hud/src/data/hostSessions.test.ts`: chip and footer formatting.
- README, `docs/install.md`, `docs/plugin-smoke.md` (Spaces rows).

## 6. Out of scope

- Moving the owner's folders (D6 is a documented command, run on request).
- Editing Codex `config.toml` trust entries or a workspaces-level `AGENTS.md`.
- Per-session drill-down from a workspace card (the Runs tab owns sessions).
- Windows.
