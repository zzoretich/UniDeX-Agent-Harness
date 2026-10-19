# UniDeX Spaces: pick up where you left off — design

**Date:** 2026-10-09
**Status:** approved 2026-10-09 in this condensed form (§2.1), on `feat/spaces-data`. *(user)* rows are the user's final answers; the rest are approved technical decisions. Mockups are private. Mechanics, edge cases, tests and docs in full: the plan's "Mechanics (moved from the spec)".
**Base:** `main` at `7fda846` (1.6.0 plus the §8 record). Runtime (`brain/scripts`, `cli`), HUD, the app's surface rules and `git.ts`; PR 3 also `app/src/main/services/sessions.ts`, compat's guard, `plugin/` and the generated `codex-plugin/`.
**Scope:** the Spaces tab (rail id `spaces`, `hud/src/views/SpacesTab.ts`) becomes where you pick a project back up: status board, dossier, launch pad. Code comments cite `spaces-redesign D<n>`.

---

## 1. Problem

At 7fda846, on a real vault:

1. **The counts are wrong:** every workspace shows `claude 0`. Vault-root sessions are skipped (`collectors/hostSessions.js:146`); cwds come from slugs that turn every `-` into `/` (`collectors/projects.js:55-71`), so names with `-`, `_` or `.` never match; `_worktrees` is collected as a workspace (`collectors/workspaces.js:318`), though its first level is a team or an item (`lib/team-run.js:132-133`; the older layout `:11`); the ignore list matches exact paths, so temp and scratch folders fill Outside (`hostSessions.js:145, :153-157`).
2. **The list is thin:** no search or filter, emoji dots (`SpacesTab.ts:14-16`), `_` folders listed, and the outside hint *moves* the folder (`SpacesTab.ts:110`, `cli/workspace.js:109-142`).
3. **The overview is empty:** five derived boxes (`SpacesTab.ts:157-200`); the README stub passes as a summary (`cli/workspace.js:64`); `next` falls back to the last commit subject (`workspaces.js:287`), in a vault-tracked folder a `vault backup:` timestamp; dated `HANDOFF-<slug>.md` files are never read (`workspaces.js:15` ranks only `HANDOFF.md`).
4. **No actions:** no new, adopt, archive, rename or resume; the header buttons spread out (`styles.css:1791-1793`).
5. **Disconnected:** git is `log -1` with its hash dropped (`collectors/util.js:105-118`, `workspaces.js:219-220`); no sessions, no links, and nothing opens Spaces on a workspace (`ui/PulsePopup.ts:179`, `main.ts:161-164`).

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | *(user)* **Scope:** a redesign plus actions; Spaces keeps its rail slot and id. | A new tab. Folding into Pulse. |
| D2 | *(user)* **Three PRs, each shippable:** the data layer; the read-only redesign (Resume, deep links, today's writes); the actions. | One or two PRs. |
| D3 | *(user)* **Layout A:** list · dossier · right pane; the right pane folds under 1100 px, the list stacks under 760 px. | B timeline. C board first. |
| D4 | *(user)* **List:** search, + New, groups PINNED / ACTIVE / STALLED / IDLE, a hidden toggle, an Outside footer; rows show status, git, hosts, a live dot, next, counts. | Today's flat list. A sort menu. |
| D5 | *(user)* **Dossier header:** status pill with override, pin, a meta line (path, code folder, git); **Resume in Code** split button, Terminal, Finder, More ⋯. | Spread "<host> here" buttons. |
| D6 | *(user)* **Pick-up card:** rows *last*, *now* (handoff), *next*, *read* (insight, ↻), each naming its source. | An insight box. Prose. |
| D7 | *(user)* **Resume** opens a Code terminal in `ws:<name>` at the workspace's place (its code folder when linked), typing `claude --resume <id>` or `codex resume <id>`. A1: for Claude only, if a check run first in PR 2 shows `claude --resume` can't find a thread from another folder, it starts in the thread's start folder and the hint names it. Codex always uses the workspace's place (rollouts are global). Amended 2026-10-10 *(user)*: a thread credited through a git worktree resumes in that worktree while it exists, so the agent stays on its branch; once it is gone, the workspace's place. | `claude --continue`, `codex resume --last`: not this thread. Always the start folder. |
| D8 | *(user)* **Overview · Files tabs.** Overview: Summary, Objectives with progress, Documents; typographic. | Five boxes. |
| D9 | *(user)* **Files and Map merged:** one tree with descriptions, NEW / CHANGED badges, filters, Describe N new, ↻ per file; the right pane previews. | A Map tab. |
| D10 | *(user)* **Right pane:** HISTORY (sessions, commits) over LINKED (to-dos, proposals, memory). | Live-now, insight stacks. |
| D11 | *(user)* **Status automatic + override** (§4); `workspace.md` may set active, paused or done; done offers Archive. A2: activity is attributed sessions and commits; in a vault-tracked folder a backup commit counts only if it changes a file the `aos workspace` verbs don't write (`workspace.md`, the stubs), so Pin or Draft never makes it active; document mtimes never count. | 14/60-day aging. A STATUS.md regex. Non-backup commits only. |
| D12 | *(user)* **Deep links both ways** via `WorkbenchView.open(target)` and `agenticos://workbench?tab=spaces&workspace=<name>`; a link only selects. | `setTab` alone. Code's text filter. |
| D13 | *(user)* **Draft workspace.md** in a review dialog; nothing is written until Save; later drafts touch only frontmatter. | A temp draft file. Write, then Undo. |
| D14 | **The draft's call:** one `provider.js` call (`workspace-draft`, strict schema) per explicit click, under the hook caps; else a labelled heuristic. | The reasoner. A config opt-in. |
| D15 | *(user)* **New space:** `workspaces/<kebab>` from Blank, Code repo or Clone from GitHub, with stubs; opened in Code; pinned. | A runtime `git clone`. |
| D16 | *(user)* **Adopt by alias:** `aliases:` records the folder, nothing moves; vanished folders can be hidden. | Moving from the page. |
| D17 | *(user)* **Archive, Restore, Rename:** Archive moves into `workspaces/_archive/`, restorable; Rename keeps history; app threads follow (renamed; read-only while archived). | The Trash. Threads on the old name. |
| D18 | **Pin and override live in `workspace.md`**, so they travel and either host can `set` them. | HUD settings. `brain/config.json`. |
| D19 | *(user)* **Feel:** typographic, `--udx-*` tokens, both themes, colour only for state; `.aos-spc-*`; DOM popovers. | Restyling shared classes. |
| D20 | **Attribution in the runtime,** first match wins, tagged `via` (§4). | Slug decoding. Start cwd only. |
| D21 | **The outside list** drops home, host config, temp folders and the vault outside `workspaces/`; rows gain `exists`, `match`, `git`. | Exact-path ignores. |
| D22 | **Hidden, not dropped:** `_` and `_archive/` entries carry `hidden: true`; `_worktrees` gets no entry; consumers filter on it. | Dropping them. |
| D23 | **`next` names its source** or stays empty; template text never counts; the insight's next stays on the insight. | The commit subject. |
| D24 | **Git state in the runtime,** own repo or `repo:` folder, never the vault's. | The app's `git.ts`. |
| D25 | **Session rows** (`sessions.recent`, ≤ 12) from an incremental cache, `brain/_index/session-index.json`. | The HUD reading transcripts. |
| D26 | **Live dot:** Code terminals and running Sessions threads in the workspace. | Claude's pid registry. |
| D27 | **Linked explicitly,** in the HUD: `#ws/<slug>` to-dos; proposals by `workspace:`, `target` or `recheck`; memory by `workspace:`, slug or path mention; each row says how. | Free-text names. |
| D28 | **CLI verbs** for every page action (§4), with `--json`, for either host's sessions. | HUD writes via Files. |
| D29 | **`spaces` gains argv rules only** (`writes: []`) and stays `verified: true`: a live check per host precedes PR 3's merge. | A new surface. |
| D30 | **Config `workspaces.*`:** `activeDays` 7, `idleDays` 30, `commits` 10, `recentSessions` 12, `ignoreCommitSubjects`, `attributeByFiles`; hidden paths per machine in `brain/_index/workspaces-hidden.json`. | Hard-coded. `brain/config.json`. |
| D31 | **Host off or not ready:** Resume is disabled with the reason ("… run aos init --host <h>", or not logged in); the split menu lists enabled hosts, a not-logged-in one disabled with its reason; New's picker offers ready hosts. | Throwing. The other host. |
| D32 | **Sessions lists app threads only;** its links are off, with the reason, for CLI threads or a hidden Sessions tab. | Listing CLI sessions. |
| D33 | **Map per provider:** `--file` is feature `file-map`; ↻ is off under `none`; Describe keeps the scan budgets. | Feature `unknown`. |
| D34 | **Host differences are recorded** (§5). | Weighting by host. |
| D35 | *(user)* A3: **Link to-dos…** (PR 3) suggests untagged to-dos naming the workspace; one click adds `#ws/<slug>` through the To-Do writer. | Hand tagging only. |

### 2.1 Decided 2026-10-09

The user answered A1 (D7) and A2 (D11) as recommended (A1 c, A2 a) and A3 (D35) yes. On 2026-10-10 the A1 check found `claude --resume <id>` loads a vault-root thread from a workspace folder (Claude Code 2.1.296), so both hosts use the workspace's place, and the user amended D7 for worktree threads (they resume in their worktree while it exists). Approved with the spec: D14, D18, D20–D34, and these refinements: the Draft's Status starting on "auto (not written)", never model-proposed (D13); the insight's next in *read* (D23); thread rewrite on Rename, read-only archived threads (D17); "Link as code folder" beside Adopt (D16, D24); one 30-day count window (D34); Clone opening a shell, an agent only on "Start <host> here", New's host picker (D15); select-only links (D12); the PR 2 stand-ins.

## 3. What already exists (verified at `7fda846`)

- **Collector:** `scan()` attaches sessions (`scan-vault.js:64-71`) at SessionEnd on both hosts (`plugin/hooks/hooks.json:45`, `codex-plugin/hooks/hooks.json:103`); the insight's guess becomes `ws.next` (`scan-vault.js:412-414`).
- **Entries and verbs:** `workspaces.js:291-306`, status chain `:224-231`, manifest keys `:62-69`; `list`, `new`, `adopt` (`cli/workspace.js:16`); stubs write through links (`:71-87`).
- **Sessions:** slugs decoded (`hostSessions.js:38-55`) instead of `hostDirs` (`lib/host.js:46-60`); `lib/transcript.js` reads file tools (`:24`, `:123-125`); the team ledger lacks Codex ids (`team-run.js:368-383`). App threads name their workspace on line one (`sessions.ts:57`), resolved each turn (`:202`).
- **HUD:** `launchTerminal` takes `resume:{id}` (`WorkbenchView.ts:330-344`) and `launchArgs` builds both resume lines (`terminalLaunch.ts:343-353`), but only a new Claude conversation gets an id (`terminalLauncher.ts:226`) and the end bar resumes by id only for Claude (`TerminalPanel.ts:404`); Code groups by `ws:<name>` (`termGroups.ts:23-27`); compat has no `Menu` (`app/obsidian-compat/src/index.ts:8-25`).
- **Page limits:** host session folders are list-only, outside code folders unreadable (`read-scope.ts:66-71, :79-86`); git runs unguarded (`git.ts:103-104`, `util.js:105-118`); the spaces surface has `writes: []` and three spawns, and `NAME` admits `..` (`surfaces.ts:183-194, :65`).
- **Models and links:** `provider.js` resolves ollama → claude → codex → none (`:233-274`); click precedent `briefing.js --force` (SECURITY.md:74). `todos.ts:64-73` parses tags; `Proposal` and `MemoryMeta` lack `workspace` (`proposals.ts:27-42`, `memories.ts:8-37`).

## 4. Design

**PR 1: data layer.** *After it ships:* real counts on both hosts, no `_` folders, a clean outside list, next steps from handoffs, the new status words, full `list --json` entries, hidden entries out of Pulse; insights regenerate once.
- **Seams,** the only host-data readers, per format: `host.js` `sessionFiles`; `transcript.js` `sessionHead`, `sessionTail`, `fileTouches`.
- **Attribution** (D20): (1) `app`, a Sessions thread; (2) `team`, a team-ledger session → its board item's `path`; (3) `cwd`, the start cwd inside a root (folder, `repo:`, `aliases:`), longest wins; (4) `worktree`, the main repo's root, or for a vanished seat the board, then name rules; (5) `files`, a vault-root session → the workspace its file touches hit most (≥ 3, no tie). `_worktrees` is never a target.
- **Resume:** `resumable: true` also needs a lowercase UUID equal to the file name's id; each `false` has a reason.

| Host | Row | `kind` | `resumable` |
|---|---|---|---|
| Claude | `entrypoint: cli` | interactive | true |
| Claude | `sdk-*` | headless | false: "Headless run: open it in Sessions or start a new session" |
| Codex | `source` `cli`, `vscode` | interactive | true |
| Codex | `source` `exec` (and `mcp`) | headless | true (PR 1 check: `codex resume <id>` takes any recorded session; `--include-non-interactive` filters only the picker and `--last`, codex-cli 0.162.0) |
| Codex | `archived_sessions/` | its source's | false: "Archived in Codex" |
| either | team seat | team | false |
| either | Sessions thread | app | opens it in Sessions |

- **Status:** **active**, activity (D11) within `activeDays`; **stalled**, a plan (a next step, handoff Now/Next or open objective) but nothing for 7+ days; **idle**, nothing for `idleDays` or no plan; the override wins. Sort: pinned; active, stalled, idle, paused, done; activity. Counts cover `idleDays` on both hosts.
- **`next`:** manifest → handoff Next → a Next heading → empty, with `next.from`; the model's next is `insight.next`. **Git:** a vault-tracked folder gets `{kind: 'vault'}` and path-scoped commits minus `ignoreCommitSubjects`. New fields: the plan, Mechanics › PR 1.

**PR 2: read-only redesign.** *After it ships:* three panes, pick-up card, Overview, merged Files, History, Linked, Resume, deep links. Stand-ins until PR 3: + New opens Code's sheet; static pill and pin; a read-only outside list; More ⋯ has Copy path, Reveal, Link code folder.
- **`resumeTarget`** → `{host, id, cwd, hint}` or `{disabled, reason}`: a UUID in this workspace's `recent`, `resumable`, host ready (D31), cwd per D7. *last* is the newest interactive or app row.
- **Deep links** select only after checks: `workspace` a snapshot name, `pane` from a fixed set, `thread` a ThreadId or dropped.
- **Terminals:** a host-neutral `sessionId`, so Codex terminals resume by id; `launchArgs` refuses a value starting with `-`.

**Accessibility:** list rows are buttons with `aria-selected`; groups are disclosure buttons; the split button has `aria-haspopup`; the progress bar is a `progressbar`; every coloured dot has a text label.

**PR 3: actions.** *After it ships:* New, Adopt or Link as code folder, Hide, Archive, Restore, Rename, Pin, Set status, Draft, + to-do and Link to-dos…, and the same verbs in any session on either host; `/todo`, `/propose`, `/project` link the workspace.
- **Page verbs** (rules on `cli/aos.js`, flags in fixed order): `workspace new KEBAB [--git] [--pin] [--empty] --json`; `draft WS --json` (fields and a `baseHash`; no workspace file written); `set WS --set JSON_OBJ --expect HASH [--dry-run] --json` (named keys only, refuses a changed file); `archive|restore WS --json`; `rename WS KEBAB --json`; `adopt PATH --into WS --json`; `hide|unhide PATH --json`. Terminals and sessions only: `list`, `which`, `stubs`, adopt's move form. No argument starts with `-` (`WS` an existing name, `KEBAB` a new one; regexes: the plan, Mechanics › PR 3 › Security).
- **Archive** moves the folder and map under `_archive/`, sets `archived:`, flips `status/active` → `status/archived` in project notes linked by `workspace:` or exact slug; threads stay, refusing turns until Restore. **Rename** moves folder, map and threads, rewrites thread meta, adds `aliases:`. **Clone** types `git clone -- '<url>' . && aos workspace stubs <slug> --pin` in a visible shell for a GitHub URL.

## 5. Host parity

1. **Entry point:** the Spaces tab; `aos workspace <verb>`; `/todo`, `/propose`, `/project` find their workspace with `which --json` on both hosts. No new command, skill or MCP tool.
2. **Hooks:** none change; SessionEnd already scans both hosts.
3. **Model calls:** the draft and ↻ per file, through `provider.js` per host (matrix).
4. **Session data:** runtime only, through the §4 seams; the HUD reads `snapshot.json`.
5. **MCP:** none.
6. **Degradation:** D31–D34 and the matrix: one 30-day window (Claude prunes at about 30 days, unverified); PR 1 adds Codex ids to the team ledger; a Codex resume keeps its own sandbox; the files credit sees a Codex thread_spawn subagent's edits (folded into its thread) but not a Claude subagent's (`<id>/subagents/` is never read); a host that is off still has its local sessions counted (Resume off).
7. **Docs:** README, `docs/install.md` (Hosts paragraph, D34), `vault-template/AGENTICOS.md`, app-smoke per host and `## Codex host`, COVERAGE.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | The Spaces tab; `aos workspace …` in a session or terminal; `/todo`, `/propose`, `/project` inside a workspace | Claude transcripts; Resume types `claude --resume <id>`; Draft: Ollama, else Claude (`claude.model`, capped) | Codex rows: Resume off, "Codex is off on this machine: run aos init --host codex"; no New Codex session; headless rows: no Resume, with the reason; `none` or cap: a labelled heuristic |
| Codex only (plugin · direct) | The Spaces tab; `aos workspace …`; `$agenticos:todo`, `$agenticos:propose`, `$agenticos:project` (`$todo`… direct) | Codex rollouts and `session_index.jsonl`; Resume types `codex resume <id>`, as does the end bar; Draft: Ollama, a logged-in `claude`, else Codex (low effort, daily cap), labelled by who answered | Claude rows: Resume off, "Claude Code is off on this machine: run aos init --host claude"; no New Claude Code session; archived rows: no Resume, with the reason; vault-root credit by edits only; writes outside the cwd may ask for sandbox approval (D34); `none`: the heuristic |
| Both | Both forms | Both formats; Resume uses the thread's host; the same 30-day window; Draft `auto` | A host not logged in: its Resume off with the reason; the other host's New offered |

Every differing cell is D31, D32 or D34; no parity gap widens.

## 6. Security

- **PR 1:** the map and regen rules (Spaces, Pulse) take `WS`/`REL` instead of `NAME`, checked again in the runtime (today `map-workspace.js ..` maps the vault root). Every git call runs `git -c core.fsmonitor=false -c log.showSignature=false -c core.untrackedCache=false --no-optional-locks` with `GIT_TERMINAL_PROMPT=0`; a read also turns off every filter driver defined below global and system scope (`--config-env`), passes `--no-ext-diff --no-textconv` to any diff, and sets `GIT_NO_LAZY_FETCH=1` and an empty `GIT_ALLOW_PROTOCOL`, so no read runs a program the repository's own config names (fsmonitor, gpg, filters, external diff, textconv, a lazy fetch's ssh). The Commit button's `add` and `commit` run the repository's hooks, filters and signing, as in a terminal (SECURITY.md).
- **PR 3, the new power:** the §4 verbs (one model call for a draft) write only `workspaces/**` and `brain/_index/**`, plus one exception: the `status/` tag line of a project note D27 links by `workspace:` or exact slug, in `brain/memory/projects/`, if it exists and is no symlink. Folders move only between `workspaces/` and `workspaces/_archive/`; nothing is deleted. Resume and Clone are typed into a visible terminal (SECURITY.md:72).
- **Validation in the runtime:** names resolve to direct children of `workspaces/` (`_archive/` for restore); new names are free, not reserved and not `scratch`; paths are absolute or `~/`, outside the vault, not `/` or home itself, neither inside nor containing a host config folder, and (adopt, hide) equal a current outside row's cwd or (unhide) a stored hidden entry; `set` checks types, lengths and control characters; `--expect` refuses a changed file; writes are atomic and follow no symlink.
- **Refusals:** reserved names and `scratch`; a running team item or app turn; linked git worktrees; restore onto an existing name; moves under `AOS_HEADLESS=1`. Archive, Restore, Rename and Adopt ask in a `ConfirmModal`; Cancel spawns nothing.
- **No new IPC** (channel, preload, schema): verbs go `runAosJson` → `proc:spawn` → `WritePolicy.canSpawn`. **SECURITY.md:** a row for the verbs, a row for the draft, and the *Writes* and *Terminals* bullets (text in the plan).

## 7. Tests and docs

In full in the plan. **PR 1:** seam, attribution, status (A2's commit rule included), next, git-guard and name tests; new fixture workspaces and Codex rows; rehearsals assert claude ≥ 1 and codex ≥ 1. **PR 2:** `spacesModel` (D7's folder rule included), terminal and deep-link tests; the Spaces e2e rewritten; Codex-only variants; screens. **PR 3:** every verb and refusal, a containment test, fake providers per host, e2e per action, the live check per host.

## 8. Out of scope

CLI sessions in the Sessions tab, or a live CLI registry; `workspace:` on memories at `/wrap`; maps and the Files tree for code folders outside the vault; routines and team items in Linked, a workspace item in Needs you; insight changes beyond hash inputs and where their next lives (the daily age bucket stays); deleting a workspace; a release.
